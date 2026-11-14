/**
 * DurableSession · 重建系统提示词（`rebuildSystemPrompt`，2026-11-06）：用户点了「重建」—— 删掉当前对话冻结的
 * 人设、摘要与段落（有 agent 就一并销毁，同一个提交里删锁），下一次上锁按此刻的来源重新渲染。主工作在跑 /
 * 被中断 → `busy`，什么都不动（D6：只算 `computeState() !== 'idle'`，辅助工作不算）。
 *
 *   RBD-1  空闲、有锁 → success；锁没了、镜像 false、一对 agent_closing；一个提交删锁并删掉 persona / personaKey /
 *          sections；身份字段与 lastAnnouncedDate 留着
 *   RBD-2  下一次发送：提示词块再渲染一次、段落按此刻的来源渲染（不是比对）、摘要 = 此刻的、请求带新文本；提醒 frozen []
 *   RBD-3  空闲、没锁 → success；一个提交，只碰当前对话的 agent-state；没有 closing 广播；不建锁
 *   RBD-4  从没冻结过 → success；没锁、frozen:false
 *   RBD-5  在跑 → busy；那一轮照常跑完；文档不变；不发布
 *   RBD-6  被中断（重启之后）→ busy
 *   RBD-7  只有辅助工作（hook agent）活着 → 不算忙（success）；一个后台的非辅助任务（派生 agent 的一轮）→ busy
 *   RBD-8  刚受理的一次发送先进完（drain），之后才判忙 → busy
 *   RBD-9  重建占着区段时来的一次发送：等它，之后按此刻的来源跑，从不在没锁的状态下发请求
 *   RBD-10 芯片上的 X 之后（空闲）重建：没锁、没有冻结的提示词；在 onLockChange(false) 里重建也一样
 *   RBD-14 重建之后回退到重建之前（D4）：F 带着重建前冻结的那份，提醒又报来源变了
 *   RBD-16 会话关了 → 拒绝
 */
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import { backgroundContext as BG } from '../context'
import { AgentStateDoc } from '../docs'
import { SessionClosedError, type DurableSession } from '../durableSession'
import { fenceProjectPrompt } from '../prompt/fences'
import { scenarioToolHost, testProfile } from './support/agentConfig'
import { recordPublications } from './support/commits'
import { crashWith } from './support/crash'
import { answer, callTool, stalled } from './support/faux'
import {
  changeAllSources,
  driftEnvironment,
  envScenario,
  keyOf,
  PERSONA_1,
  RENDER_CALLS_A,
  send,
  stateOf,
  userEntryIds
} from './support/frozen'
import { registerHostCleanup } from './support/host'
import { sourceHost } from './support/prompt'
import { forkedId } from './support/rollback'
import { storedLock } from './support/scenario'
import { hookRec, rec, seedAgent, startRun, TEST_SPAWN_EXTENSION } from './support/spawn'
import { holdTool } from './support/tools'
import { deferred, withTimeout } from './support/wait'

registerHostCleanup()

const TIMEOUT = 20000
const BUSY = { success: false, reason: 'busy' } as const

/** 身份字段（重建之后留着的那几项） */
const IDENTITY = {
  kind: 'root',
  profileName: 'work',
  rootSessionId: 's1',
  promptBlocks: ['environment', 'agents_md', 'project_prompt']
} as const

async function rebuild(session: DurableSession): Promise<unknown> {
  return withTimeout(session.rebuildSystemPrompt(), 5000, 'rebuildSystemPrompt')
}

describe('DurableSession · rebuildSystemPrompt', () => {
  it(
    'RBD-1 idle with a lock: success; the lock is gone, the mirror says false, one agent_closing pair; one commit removes the lock and the frozen prompt; identity and lastAnnouncedDate stay',
    async () => {
      const { t } = await envScenario()
      const session = await t.open()
      await send(t, session, 'u1')
      await session.harness.commit(async (tx) => {
        ;(await tx.doc(AgentStateDoc, ROOT_CONVERSATION_ID)).lastAnnouncedDate = '2026-11-05'
      }, BG)
      const closingBefore = t.broadcastsOf('agent_closing').length

      const recorder = recordPublications(session.harness)
      expect(await rebuild(session)).toEqual({ success: true })
      recorder.stop()
      expect(session.lock).toBeUndefined()
      expect(await storedLock(session)).toBeUndefined()
      expect(t.mirror.at(-1)).toEqual(['s1', false])
      expect(t.broadcastsOf('agent_closing').slice(closingBefore)).toEqual([
        { type: 'agent_closing', sessionId: 's1', closing: true },
        { type: 'agent_closing', sessionId: 's1', closing: false }
      ])
      expect(recorder.publications).toHaveLength(1)
      expect(recorder.publications[0]!.docs).toEqual(
        expect.arrayContaining(['shuvix.session-state', 'shuvix.agent-state#1'])
      )
      expect(await stateOf(session)).toEqual({ ...IDENTITY, lastAnnouncedDate: '2026-11-05' })
    },
    TIMEOUT
  )

  it(
    'RBD-2 the next send renders afresh: promptBlocks once more, the sections from the current sources (not a comparison), the current key, the request carries the new texts; then frozen with nothing stale',
    async () => {
      const { t, vars, config, sources } = await envScenario()
      const session = await t.open()
      await send(t, session, 'u1')
      driftEnvironment(vars, '2026-11-06')
      changeAllSources(sources)
      config.profile = { ...config.profile, systemPrompt: `${config.profile.systemPrompt} New.` }
      expect(await rebuild(session)).toEqual({ success: true })

      sources.calls.length = 0
      await send(t, session, 'u2')
      expect(vars.state.calls).toBe(2)
      expect(sources.calls).toEqual(RENDER_CALLS_A)
      expect(sources.notes).toEqual([])
      const after = await stateOf(session)
      expect(after?.personaKey).toBe(keyOf(config))
      expect(after?.persona).toContain('Current date: 2026-11-06')
      expect(after?.persona).toContain('New.')
      const prompt = t.kit.requests.at(-1)!.systemPrompt
      expect(prompt).toContain('Use npm.')
      expect(prompt).toContain(fenceProjectPrompt('Acme billing, v2.'))
      expect(prompt).toContain('Bases: recipes.')
      expect(prompt).not.toContain(PERSONA_1)
      expect(await session.systemPromptStatus()).toEqual({ frozen: true, stale: [] })
    },
    TIMEOUT
  )

  it(
    'RBD-3 idle without a lock: success; one commit touching only the current conversation’s agent-state; no closing broadcasts; no lock',
    async () => {
      const { t } = await envScenario()
      const session = await t.open()
      await send(t, session, 'u1')
      await session.destroyAgent()
      const closing = t.broadcastsOf('agent_closing').length
      const created = t.broadcastsOf('agent_created').length

      const recorder = recordPublications(session.harness)
      expect(await rebuild(session)).toEqual({ success: true })
      recorder.stop()
      expect(recorder.publications).toHaveLength(1)
      expect(recorder.publications[0]!.docs).toEqual(['shuvix.agent-state#1'])
      expect(t.broadcastsOf('agent_closing')).toHaveLength(closing)
      expect(t.broadcastsOf('agent_created')).toHaveLength(created)
      expect(session.lock).toBeUndefined()
      expect(await stateOf(session)).toEqual(IDENTITY)
    },
    TIMEOUT
  )

  it(
    'RBD-4 never frozen: success; no lock; still not frozen',
    async () => {
      const { t, vars } = await envScenario()
      const session = await t.open()
      expect(await rebuild(session)).toEqual({ success: true })
      expect(session.lock).toBeUndefined()
      expect(vars.state.calls).toBe(0)
      expect(await session.systemPromptStatus()).toEqual({ frozen: false, stale: [] })
    },
    TIMEOUT
  )

  it(
    'RBD-5 running: busy; the run is not touched and finishes; the document is unchanged; nothing published',
    async () => {
      const gate = deferred()
      const running = deferred()
      const hold = holdTool('hold', gate.promise, { onRun: () => running.resolve() })
      const { t } = await envScenario({
        host: { toolHost: scenarioToolHost({ agentTools: [hold] }) }
      })
      const session = await t.open()
      t.kit.queue(callTool('hold'), answer('done'))
      const sending = session.submitUser('go')
      await running.promise
      const before = await stateOf(session)
      const lock = session.lock

      const recorder = recordPublications(session.harness)
      expect(await rebuild(session)).toEqual(BUSY)
      recorder.stop()
      expect(recorder.publications).toEqual([])
      expect(session.lock).toBe(lock)
      expect(session.runState).toBe('busy')
      gate.resolve()
      expect(await withTimeout(sending, 5000, 'run')).toEqual({})
      expect(t.kit.callCount).toBe(2)
      expect(await stateOf(session)).toEqual(before)
    },
    TIMEOUT
  )

  it(
    'RBD-6 interrupted (after a restart): busy, nothing changes',
    async () => {
      const sources = sourceHost()
      const { t } = await crashWith({
        host: {
          promptHost: sources.host,
          agentConfig: {
            profile: testProfile({
              name: 'work',
              systemPrompt: 'P',
              promptBlocks: ['project_prompt']
            }),
            model: { provider: 'faux', modelId: 'faux-1' }
          }
        }
      })
      const session = await t.open()
      expect(session.isInterrupted()).toBe(true)
      const before = await stateOf(session)
      expect(before?.sections).toBeDefined()
      expect(await rebuild(session)).toEqual(BUSY)
      expect(await stateOf(session)).toEqual(before)
      expect(session.isInterrupted()).toBe(true)
    },
    TIMEOUT
  )

  it(
    'RBD-7 (D6) only auxiliary work alive (a hook agent mid-run): not busy, success; a non-auxiliary background task (a spawned agent mid-run): busy',
    async () => {
      const aux = await envScenario({ host: { extensions: [TEST_SPAWN_EXTENSION] } })
      const session = await aux.t.open()
      await send(aux.t, session, 'u1')
      const hook = await seedAgent(session, { record: hookRec() })
      const stall = stalled()
      aux.t.kit.queue(stall.step)
      await startRun(session, hook.conversationId, 'TITLE-ME')
      await withTimeout(stall.reached, 3000, 'hook request')
      expect(session.runState).toBe('idle')
      expect(await rebuild(session)).toEqual({ success: true })
      expect(await stateOf(session)).not.toHaveProperty('sections')

      const bg = await envScenario({ host: { extensions: [TEST_SPAWN_EXTENSION] } })
      const second = await bg.t.open()
      await send(bg.t, second, 'u1')
      const child = await seedAgent(second, { record: rec() })
      const childStall = stalled()
      bg.t.kit.queue(childStall.step)
      await startRun(second, child.conversationId, 'work in the background')
      await withTimeout(childStall.reached, 3000, 'child request')
      const before = await stateOf(second)
      expect(await rebuild(second)).toEqual(BUSY)
      expect(await stateOf(second)).toEqual(before)
      expect(second.lock).toBeDefined()
    },
    TIMEOUT
  )

  it(
    'RBD-8 a send admitted just before is drained first, and then the session is busy',
    async () => {
      const gate = deferred()
      const hold = holdTool('hold', gate.promise)
      const { t } = await envScenario({
        host: { toolHost: scenarioToolHost({ agentTools: [hold] }) }
      })
      const session = await t.open()
      await send(t, session, 'u1')
      const before = await stateOf(session)
      t.kit.queue(callTool('hold'), answer('done'))
      const sending = session.submitUser('go')
      const result = await rebuild(session)
      expect(result).toEqual(BUSY)
      expect(await stateOf(session)).toEqual(before)
      gate.resolve()
      expect(await withTimeout(sending, 5000, 'run')).toEqual({})
    },
    TIMEOUT
  )

  it(
    'RBD-9 a send that arrives while the rebuild holds the section waits for it, then runs with a fresh prompt — never without a lock',
    async () => {
      const ref: { session?: DurableSession; sending?: Promise<unknown> } = {}
      const { t, sources } = await envScenario({
        host: {
          onLockChange: (_sessionId, locked) => {
            // 删锁的提交已经落定、重建还占着区段：这时来一次发送
            if (!locked && ref.session !== undefined && ref.sending === undefined) {
              t.kit.queue(answer('re:during'))
              ref.sending = ref.session.submitUser('during')
            }
          }
        }
      })
      const session = await t.open()
      await send(t, session, 'u1')
      changeAllSources(sources)
      ref.session = session
      const requests = t.kit.requests.length
      expect(await rebuild(session)).toEqual({ success: true })
      expect(ref.sending).toBeDefined()
      expect(await withTimeout(ref.sending!, 5000, 'send during the rebuild')).toEqual({})
      expect(t.kit.requests).toHaveLength(requests + 1)
      expect(t.kit.requests.at(-1)!.systemPrompt).toContain(fenceProjectPrompt('Acme billing, v2.'))
      expect(session.lock).toBeDefined()
      expect((await stateOf(session))?.sections?.project_prompt).toBe(
        fenceProjectPrompt('Acme billing, v2.')
      )
    },
    TIMEOUT
  )

  it.each(['right after destroyAgent()', 'inside onLockChange(false) of a plain destroy'] as const)(
    'RBD-10 a rebuild %s at idle: no lock and no frozen prompt',
    async (when) => {
      const ref: { session?: DurableSession; rebuilt?: Promise<unknown> } = {}
      const { t } = await envScenario({
        host: {
          onLockChange: (_sessionId, locked) => {
            if (
              when === 'inside onLockChange(false) of a plain destroy' &&
              !locked &&
              ref.session !== undefined &&
              ref.rebuilt === undefined
            ) {
              ref.rebuilt = ref.session.rebuildSystemPrompt()
            }
          }
        }
      })
      const session = await t.open()
      await send(t, session, 'u1')
      ref.session = session
      await withTimeout(session.destroyAgent(), 5000, 'destroy')
      if (when === 'right after destroyAgent()') {
        expect(await rebuild(session)).toEqual({ success: true })
      } else {
        expect(ref.rebuilt).toBeDefined()
        expect(await withTimeout(ref.rebuilt!, 5000, 'rebuild')).toEqual({ success: true })
      }
      expect(session.lock).toBeUndefined()
      expect(await storedLock(session)).toBeUndefined()
      expect(await stateOf(session)).toEqual(IDENTITY)
      expect(await session.systemPromptStatus()).toEqual({ frozen: false, stale: [] })
    },
    TIMEOUT
  )

  it(
    'RBD-14 (D4) a rebuild, then a rollback to before it: F holds the prompt frozen before the rebuild, and the status reports the changed sources again',
    async () => {
      const { t, sources } = await envScenario()
      const session = await t.open()
      await send(t, session, 'u1')
      const first = t.kit.requests[0]!.systemPrompt
      const frozenBefore = await stateOf(session)
      sources.values.projectPrompt = 'Acme billing, v2.'
      expect(await rebuild(session)).toEqual({ success: true })
      await send(t, session, 'u2')
      expect(await session.systemPromptStatus()).toEqual({ frozen: true, stale: [] })

      const F = forkedId(await session.rollbackTo((await userEntryIds(session))[1]!))
      expect(await stateOf(session, F)).toEqual(frozenBefore)
      expect(await session.systemPromptStatus()).toEqual({
        frozen: true,
        stale: [{ key: 'project_prompt' }]
      })
      await send(t, session, 'again')
      expect(t.kit.requests.at(-1)!.systemPrompt).toBe(first)
    },
    TIMEOUT
  )

  it(
    'RBD-16 a closed session rejects',
    async () => {
      const { t } = await envScenario()
      const session = await t.open()
      await send(t, session, 'u1')
      await t.host.closeAll()
      await expect(session.rebuildSystemPrompt()).rejects.toBeInstanceOf(SessionClosedError)
    },
    TIMEOUT
  )
})
