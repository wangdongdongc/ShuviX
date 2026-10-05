/**
 * P3-10a · 回退与锁（设计稿 P3-10a-10..12）：
 *
 *   10 先销毁（有锁、空闲）：恰好一对 agent_closing，都在回退那次发布之前；之后没锁、onLockChange(false)
 *      一次、`shuvix.agent.1` 卸掉；回退期间不读会话配置
 *   11 下一次发送按此刻的设置在 F 上重建锁：配置换成 faux-2 + `mcp:x` + 思考 high → 配置读一次、
 *      lock.conversationId = F、F 的 pi.agent 是 faux-2 / high、回退后的第一个请求用 faux-2 且带 X、
 *      agent_created 一次、人设冻结在 F 上
 *   12 没有发送就没有锁：后台通知写成通知（显式喊停）、不起 run；显式 createAgent() 锁在 F 上
 *
 * 12 的偏差（报给协调者）：设计稿写「`continue()` 返回 `{}` 且不建锁」，但 K3 的既有规矩是 `continue()`
 * 没锁先建 agent（`resumeWork` → `ensureAgent`，RC-07 等用例都依赖它）。这里照实断言：`continue()` 返回
 * `{}`、不发请求，它建的锁落在 F 上（锁永远在当前对话上这一条不变式照样成立）。
 */
import { AgentDoc } from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import { backgroundContext as BG } from '../context'
import { AgentStateDoc } from '../docs'
import { readTool } from '../projection/__tests__/projectorSupport'
import type { AgentConfig } from '../seams'
import { testProfile } from './support/agentConfig'
import { answer } from './support/faux'
import { makeHost, primeRoot, registerHostCleanup } from './support/host'
import { mcpDecl } from './support/mcpFake'
import {
  createsConversation,
  forkedId,
  noticeTexts,
  rawPublications,
  rollbackBase,
  threeTurns
} from './support/rollback'
import { wKit } from './support/scenario'
import { allEntries } from './support/transcript'
import { sleep } from './support/wait'

registerHostCleanup()

const TIMEOUT = 20000

function agentExtensions(names: readonly string[]): string[] {
  return names.filter((name) => name.startsWith('shuvix.agent.'))
}

describe('P3-10a · the agent lock', () => {
  it('P3-10a-10 destroy first (locked, idle): one agent_closing pair before the rollback publication; no lock, onLockChange(false) once, shuvix.agent.1 uninstalled, no config read', async () => {
    const { t, session, ids } = await rollbackBase()
    expect(session.lock?.conversationId).toBe(1)
    const installed = (): string[] =>
      agentExtensions(
        t
          .registryOf('s1')!
          .snapshot()
          .installed()
          .map((extension) => extension.name)
      )
    expect(installed()).toEqual(['shuvix.agent.1'])
    const configCalls = t.configCalls.length
    const mirror = t.mirror.length
    const closingBefore = t.broadcastsOf('agent_closing').length
    let closingAtFork: number | undefined
    const recorder = rawPublications(session)
    const stop = session.harness.subscribeCommits((publication) => {
      if (publication.changes.some((change) => change.type === 'conversation')) {
        closingAtFork ??= t.broadcastsOf('agent_closing').length - closingBefore
      }
    })
    const F = forkedId(await session.rollbackTo(ids.u2))
    stop()
    recorder.stop()
    expect(recorder.publications.filter((p) => createsConversation(p, F))).toHaveLength(1)
    expect(t.broadcastsOf('agent_closing').slice(closingBefore)).toEqual([
      { type: 'agent_closing', sessionId: 's1', closing: true },
      { type: 'agent_closing', sessionId: 's1', closing: false }
    ])
    expect(closingAtFork).toBe(2)
    expect(session.lock).toBeUndefined()
    expect(t.mirror.slice(mirror)).toEqual([['s1', false]])
    expect(installed()).toEqual([])
    expect(t.configCalls.length).toBe(configCalls)
  })

  it(
    'P3-10a-11 the lock is recreated on F with the current settings: faux-2, +mcp:x, thinking high, persona frozen on F',
    async () => {
      const config: AgentConfig = {
        profile: testProfile({ name: 'work', displayName: 'Work', systemPrompt: 'You are A' }),
        model: { provider: 'faux', modelId: 'faux-1' }
      }
      const t = await makeHost({
        makeKit: wKit,
        agentConfig: config,
        toolHost: { agentTools: [readTool()], mcp: { x: [mcpDecl('probe')] } }
      })
      const session = await t.open('s1')
      await primeRoot(session)
      const ids = await threeTurns(session, t)
      expect(t.kit.requests.at(-1)!.modelId).toBe('faux-1')
      expect(t.kit.requests.at(-1)!.tools.map((tool) => tool.name)).toEqual(['read'])

      config.model = { provider: 'faux', modelId: 'faux-2' }
      config.toolOverlay = ['mcp:x']
      config.thinkingLevel = 'high'
      config.profile = { ...config.profile, systemPrompt: 'You are B' }
      const configCalls = t.configCalls.length
      const created = t.broadcastsOf('agent_created').length

      const F = forkedId(await session.rollbackTo(ids.u2))
      expect(t.configCalls.length).toBe(configCalls)
      const requests = t.kit.requests.length
      t.kit.queue(answer('again-answer'))
      expect(await session.submitUser('again')).toEqual({})

      expect(t.configCalls.length).toBe(configCalls + 1)
      expect(session.lock?.conversationId).toBe(F)
      expect(session.lock?.model).toEqual({ provider: 'faux', modelId: 'faux-2' })
      expect(await session.harness.snapshot(AgentDoc, F, BG)).toMatchObject({
        model: { provider: 'faux', modelId: 'faux-2' },
        thinkingLevel: 'high'
      })
      const first = t.kit.requests[requests]!
      expect(first.modelId).toBe('faux-2')
      // K6 次序：MCP 在宿主其它工具之前
      expect(first.tools.map((tool) => tool.name)).toEqual(['mcp__x__probe', 'read'])
      expect(t.broadcastsOf('agent_created').length).toBe(created + 1)
      expect((await session.harness.snapshot(AgentStateDoc, F, BG))?.persona).toBe('You are B')
      expect(first.systemPrompt).toContain('You are B')
    },
    TIMEOUT
  )

  it('P3-10a-12 no lock without a send: a background notify is written (stopped by the user), no run; continue() makes no request (K3: its lock lands on F); an explicit createAgent() locks on F', async () => {
    const { t, session, ids } = await rollbackBase()
    const F = forkedId(await session.rollbackTo(ids.u2))
    expect(session.lock).toBeUndefined()
    const calls = t.kit.callCount

    await session.notify('bg done')
    await sleep(30)
    expect(t.kit.callCount).toBe(calls)
    expect(session.lock).toBeUndefined()
    expect(noticeTexts(await allEntries(await session.currentConversation()))).toEqual(['bg done'])
    expect(session.runState).toBe('idle')

    expect(await session.continue()).toEqual({})
    expect(t.kit.callCount).toBe(calls)
    // K3（见文件头）：continue 没锁先建 agent —— 建在 F 上
    expect(session.lock?.conversationId).toBe(F)

    await session.destroyAgent()
    expect(session.lock).toBeUndefined()
    const lock = await session.createAgent()
    expect(lock.conversationId).toBe(F)
    expect(session.lock?.conversationId).toBe(F)
    expect(t.kit.callCount).toBe(calls)
  })
})
