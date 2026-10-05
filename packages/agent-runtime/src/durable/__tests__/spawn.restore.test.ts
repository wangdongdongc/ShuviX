/**
 * SpawnCoordinator · 打开时的重建（P2-03，K 段 63–66，SQLite）：锁重建之后、任何续跑之前，有活任务的
 * 非辅助派生对话按记录重建（附加工具按结果契约现造）；辅助的、闲着的不重建（按需）；重建失败 / 记录写坏
 * → 警告并给它的活任务打中止标记，绝不挡打开（PIN-05）。
 */
import type { ConversationId } from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import { backgroundContext as BG } from '../context'
import { spawnedAgentRecordOf } from '../agentRecord'
import { AgentStateDoc, SessionStateDoc } from '../docs'
import { answer, callTool, stalled } from './support/faux'
import { registerHostCleanup } from './support/host'
import { extensionTools } from './support/scenario'
import {
  callAgent,
  firstChild,
  hookRec,
  hostD,
  liveTasks,
  rec,
  seedAgent,
  TITLE_SCHEMA,
  type HostD,
  type HostDOptions
} from './support/spawn'
import { transcript } from './support/transcript'
import { withTimeout } from './support/wait'
import type { TestHost } from './support/host'

registerHostCleanup()

const RESTART_TIMEOUT = 15000

const lastUsers = (d: HostD): string[] =>
  d.t.kit.requests.map((request) => {
    const user = [...request.messages].reverse().find((message) => message.role === 'user')
    return typeof user?.content === 'string' ? user.content : ''
  })

/** 进程 1：派发、子 agent 卡住；`corrupt` 在崩溃之前改存储；交回进程 2 */
async function crash(
  options: HostDOptions,
  corrupt?: (first: HostD, child: ConversationId) => Promise<void>,
  before?: (t: TestHost) => void
): Promise<{ d: HostD; C: ConversationId }> {
  const first = await hostD(options)
  const stall = stalled()
  first.t.kit.queue(callAgent('explore', 'p'), stall.step)
  void first.session.submitUser('go')
  await stall.reached
  const C = await firstChild(first.session)
  await corrupt?.(first, C)
  const d = await first.reopen(before)
  return { d, C }
}

describe('SpawnCoordinator · restore at open', () => {
  it(
    'P2-03-63 rebuild order and context: root lock first, then the contract child with next',
    async () => {
      const { d, C } = await crash({
        dispatch: { contract: { schema: structuredClone(TITLE_SCHEMA) } }
      })
      expect((await d.session.harness.inspect(BG)).scheduling).toBe('paused')
      const record = (await spawnedAgentRecordOf(d.session.harness, C, BG))!
      expect(d.t.toolHost.rebuildCalls).toEqual([d.session.lock, record])
      const context = d.t.toolHost.rebuildContexts[1]!
      expect(context.sessionId).toBe('s1')
      expect(context.extraTools!.map((tool) => tool.name)).toEqual(['next'])
      expect(extensionTools(d.t, `shuvix.agent.${C}`)).toEqual(['probe', 'next'])
      expect(d.t.toolHost.resolveCalls).toEqual([])
      d.t.kit.queue(callTool('next', { title: 'A' }), answer('done'))
      expect(await withTimeout(d.session.continue(), 5000, 'continue')).toEqual({})
      expect(d.t.kit.requests[0]!.tools.map((tool) => tool.name)).toEqual(['probe', 'next'])
      expect(d.outcomes.at(-1)!.structured).toEqual({ title: 'A' })
    },
    RESTART_TIMEOUT
  )

  it(
    'P2-03-63 a malformed root lock is cleared, and the child is still rebuilt',
    async () => {
      const { d, C } = await crash({}, async (first) => {
        await first.session.harness.commit(async (tx) => {
          ;(await tx.doc(SessionStateDoc)).lock = { broken: true }
        }, BG)
      })
      expect(d.session.lock).toBeUndefined()
      const record = await spawnedAgentRecordOf(d.session.harness, C, BG)
      expect(d.t.toolHost.rebuildCalls).toEqual([record])
      expect(extensionTools(d.t, `shuvix.agent.${C}`)).toEqual(['probe'])
    },
    RESTART_TIMEOUT
  )

  it(
    'P2-03-64 skips: a hook child with live work and an idle tool child; continue installs on demand',
    async () => {
      const first = await hostD()
      // 锚任务拥有着扣住的工作：不让它先跑（跑了也只会以 completing 陪着）
      const hook = await seedAgent(first.session, { record: hookRec(), hold: 'p2-03-64' })
      const idle = await seedAgent(first.session, { record: rec(), settle: true })
      expect(await liveTasks(first.session, hook.conversationId)).toHaveLength(1)
      const d = await first.reopen()
      const rebuilt = d.t.toolHost.rebuildCalls.filter((record) => 'agentId' in record)
      expect(rebuilt).toEqual([])
      expect(extensionTools(d.t, `shuvix.agent.${hook.conversationId}`)).toBeUndefined()
      expect(extensionTools(d.t, `shuvix.agent.${idle.conversationId}`)).toBeUndefined()
      d.t.kit.queue(answer('x ok'))
      expect(
        await withTimeout(d.session.agents.continue(idle.conversationId, 'x'), 5000, 'continue')
      ).toMatchObject({ result: 'x ok' })
      expect(extensionTools(d.t, `shuvix.agent.${idle.conversationId}`)).toEqual(['probe'])
      expect(d.t.toolHost.rebuildCalls.at(-1)).toEqual(idle.record)
    },
    RESTART_TIMEOUT
  )

  it.each(['rebuild fails', 'record malformed'])(
    'P2-03-65 %s: open resolves, the child work is abort-marked, the rerun reports an error',
    async (row) => {
      let agentId = ''
      const { d, C } = await crash(
        {},
        async (first, child) => {
          agentId = (await spawnedAgentRecordOf(first.session.harness, child, BG))!.agentId
          if (row === 'record malformed') {
            await first.session.harness.commit(async (tx) => {
              delete (await tx.doc(AgentStateDoc, child)).model
            }, BG)
          }
        },
        (t) => {
          if (row === 'rebuild fails') t.toolHost.failRebuildFor.set(agentId, new Error('broke'))
        }
      )
      const named = d.t.warnings.filter(
        (warning) => warning.includes('cannot resume') && warning.includes(`conversation ${C}`)
      )
      expect(named).toHaveLength(1)
      const live = await liveTasks(d.session, C)
      expect(live.length).toBeGreaterThan(0)
      expect(live.every((task) => task.abortRequested)).toBe(true)
      expect((await d.session.harness.inspect(BG)).scheduling).toBe('paused')
      expect(d.session.lock).toBeDefined()
      expect(extensionTools(d.t, 'shuvix.agent.1')).toBeDefined()
      d.t.kit.queue(answer('done'))
      expect(await withTimeout(d.session.continue(), 5000, 'continue')).toEqual({})
      expect(d.outcomes.at(-1)!.error).toBeDefined()
      expect(lastUsers(d)).not.toContain('p')
      expect((await transcript(await d.session.currentConversation())).at(-1)).toBe(
        'pi.assistant:done'
      )
    },
    RESTART_TIMEOUT
  )

  it(
    'P2-03-66 restore happens before any resume: identity is ready; reads never call the model',
    async () => {
      const { d, C } = await crash({})
      const identity = d.session.agentIdentity(C)
      expect(identity).toMatchObject({ kind: 'spawned', profileName: 'explore' })
      expect(identity!.callerId).toMatch(/^sub-/)
      d.session.isBusy()
      void d.session.runState
      void d.session.effectiveSettings.compaction
      expect(d.t.kit.callCount).toBe(0)
    },
    RESTART_TIMEOUT
  )
})
