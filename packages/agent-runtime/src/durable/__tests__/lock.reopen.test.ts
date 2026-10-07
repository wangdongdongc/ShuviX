/**
 * 锁 · 重开（SQLite，模拟的进程重启；裁决 K8、K11、K12 + option A）：锁 = 「agent 在本进程里初始化过」——
 * 带着被中断的工作重启，锁熬过去：打开时、在任何续跑 / 发送之前按锁记录完整初始化（重建工具、当场连锁
 * 记着的 MCP）—— 不读配置、不解析工具、不写 pi.agent；同一进程里关了再开照旧只重建（不连）；镜像对账；
 * 重建失败或锁写坏了会话照样能打开，锁被清掉。空闲重启清锁见 `lock.processInit.test.ts`。
 */
import { AgentDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import { backgroundContext as BG } from '../context'
import { SessionStateDoc } from '../docs'
import { DECL_DOCS, DECL_RESOLVE, scenarioToolHost } from './support/agentConfig'
import { answer, callTool, requestTools, stalled } from './support/faux'
import type { DurableSession } from '../durableSession'
import { registerHostCleanup } from './support/host'
import {
  extensionTools,
  lockW,
  piAgent,
  scenarioW,
  storedLock,
  toolDescription
} from './support/scenario'
import type { TestHost, TestHostOptions } from './support/host'
import { holdTool } from './support/tools'
import { requestTexts, toolDeltaCount, transcript } from './support/transcript'
import { deferred, sleep, withTimeout } from './support/wait'

registerHostCleanup()

const REOPEN_TIMEOUT = 15000
const names = (tools: readonly { name: string }[]): string[] => tools.map((tool) => tool.name)

/**
 * 让会话停在一轮生成里再「重启」：存储里留下被中断的工作 —— option A 下锁因此熬过重启（打开时完整
 * 初始化）。交回新进程。
 */
async function stallThenRestart(
  t: TestHost,
  session: DurableSession,
  overrides: Partial<TestHostOptions> = {}
): Promise<TestHost> {
  const stall = stalled()
  t.kit.queue(stall.step)
  void session.submitUser('stalled')
  await stall.reached
  return t.restart(overrides)
}

describe('lock · reopen', () => {
  it(
    'LR-01 the lock survives a restart with interrupted work; open fully initializes it before anything else — rebuilds the tools from it and connects its MCP servers, no config read, no resolution, no pi.agent write',
    async () => {
      const { t } = await scenarioW()
      const session = await t.open()
      t.kit.queue(answer('one'))
      expect(await session.submitUser('u1')).toEqual({})
      const lock = session.lock!
      const agentBefore = await piAgent(session)

      const t2 = await stallThenRestart(t, session)
      const reopened = await t2.open()
      expect(reopened.isInterrupted()).toBe(true)
      expect(reopened.lock).toEqual(lock)
      expect(reopened.lock).toEqual(lockW())
      expect(extensionTools(t2, 'shuvix.agent.1')).toEqual([
        'agent',
        'skill',
        'mcp__ctx__resolve',
        'mcp__ctx__docs'
      ])
      expect(toolDescription(t2, 'shuvix.builtin', 'bash')).toContain('sandboxed=true')
      expect(t2.toolHost.builtinCalls).toEqual([{ sessionId: 's1', sandboxed: true }])
      expect(t2.toolHost.rebuildCalls).toEqual([lock])
      expect(t2.toolHost.rebuildContexts[0]!.connect).toBeDefined()
      expect(t2.configCalls).toEqual([])
      expect(t2.toolHost.resolveCalls).toEqual([])
      // 完整初始化：锁记着的服务器当场连上（创建那一刻同样会连）
      expect(t2.toolHost.mcp('ctx').connects).toBe(1)
      expect(t2.mirror).toEqual([['s1', true]])
      expect(t2.broadcastsOf('agent_created')).toEqual([])
      expect(await piAgent(reopened)).toEqual(agentBefore)
    },
    REOPEN_TIMEOUT
  )

  it(
    'LR-02 the first request after a restart with interrupted work (continue) offers the same tools, with no tool delta; a live thinking level set before the restart survives (no re-configure)',
    async () => {
      const { t } = await scenarioW()
      const session = await t.open()
      t.kit.queue(answer('one'))
      expect(await session.submitUser('u1')).toEqual({})
      await session.setThinkingLevel('high')
      const before = requestTools(t.kit, 0)

      const t2 = await stallThenRestart(t, session)
      const reopened = await t2.open()
      t2.kit.queue(answer('two'))
      expect(await withTimeout(reopened.continue(), 5000, 'continue')).toEqual({})
      expect(requestTools(t2.kit, 0)).toEqual(before)
      expect(await toolDeltaCount(await reopened.currentConversation())).toBe(1)
      expect(t2.kit.requests[0]!.options?.reasoning).toBe('high')
      expect(reopened.lock!.thinkingLevel).toBe('low')
    },
    REOPEN_TIMEOUT
  )

  it(
    'LR-03 the server changed between processes: the locked tools stay offered, the server is connected at open (interrupted work), a vanished tool answers isError; an unreachable server does not stop the open',
    async () => {
      const { t } = await scenarioW()
      const session = await t.open()
      t.kit.queue(answer('one'))
      expect(await session.submitUser('u1')).toEqual({})

      const t2 = await stallThenRestart(t, session, {
        toolHost: scenarioToolHost({ mcp: { ctx: [DECL_RESOLVE] } })
      })
      const reopened = await t2.open()
      expect(t2.toolHost.mcp('ctx').connects).toBe(1)
      t2.kit.queue(
        callTool('mcp__ctx__resolve', { q: 'a' }, 'c1'),
        callTool('mcp__ctx__docs', { q: 'b' }, 'c2'),
        answer('done')
      )
      expect(await withTimeout(reopened.continue(), 5000, 'continue')).toEqual({})
      expect(names(requestTools(t2.kit, 0))).toContain('mcp__ctx__docs')
      // 打开时已经连上：调用不再重连
      expect(t2.toolHost.mcp('ctx').connects).toBe(1)
      const results = requestTexts(t2.kit, 2).filter((line) => line.startsWith('toolResult:'))
      expect(results[0]).toBe('toolResult:ctx.resolve:{"q":"a"}')
      expect(results[1]).toContain('unknown tool docs')
      expect(reopened.lock!.mcp.ctx).toEqual([DECL_RESOLVE, DECL_DOCS])

      // 服务器连不上：打开照样成功（试连一次、与创建同一条错误广播）；工具照样提供
      const t3 = await stallThenRestart(t2, reopened)
      t3.toolHost.mcp('ctx').failConnect()
      const third = await t3.open()
      expect(t3.toolHost.mcp('ctx').connects).toBe(1)
      expect(
        t3.broadcastsOf('error').some((event) => 'error' in event && /ctx/.test(event.error))
      ).toBe(true)
      expect(third.lock).toBeDefined()
      expect(extensionTools(t3, 'shuvix.agent.1')).toContain('mcp__ctx__docs')
      t3.kit.queue(callTool('mcp__ctx__resolve', { q: 'c' }), answer('ok'))
      expect(await withTimeout(third.continue(), 5000, 'continue')).toEqual({})
      expect(
        requestTexts(t3.kit, 1)
          .filter((line) => line.startsWith('toolResult:'))
          .at(-1)
      ).toContain('[MCP Error]')
      expect(names(requestTools(t3.kit, 0))).toContain('mcp__ctx__docs')
    },
    REOPEN_TIMEOUT
  )

  it.each([
    ['rebuilt', false],
    ['omitted from the rebuild', true]
  ] as const)(
    'LR-04 a safe tool interrupted by a crash: %s → %s',
    async (_name, omit) => {
      const running = deferred()
      const stuck = {
        ...holdTool('probe', new Promise(() => {}), { onRun: () => running.resolve() }),
        replay: 'safe' as const
      }
      const first = await scenarioW({ toolHost: scenarioToolHost({ agentTools: [stuck] }) })
      const session = await first.t.open()
      first.t.kit.queue(callTool('probe'))
      void session.submitUser('go')
      await running.promise

      let runs = 0
      const probe = {
        ...holdTool('probe', Promise.resolve(), {
          onRun: () => runs++,
          result: 'probe real result'
        }),
        replay: 'safe' as const
      }
      const t2 = await first.t.restart({ toolHost: scenarioToolHost({ agentTools: [probe] }) })
      if (omit) t2.toolHost.omitOnRebuild.add('probe')
      const reopened = await t2.open()
      expect(extensionTools(t2, 'shuvix.agent.1')?.includes('probe')).toBe(!omit)
      t2.kit.queue(answer('after'))
      expect(await withTimeout(reopened.continue(), 5000, 'continue')).toEqual({})
      const result = (await transcript(await reopened.currentConversation())).find((line) =>
        line.startsWith('pi.tool-result:')
      )
      if (omit) {
        expect(runs).toBe(0)
        expect(result).toContain('was interrupted and may have partially run')
      } else {
        expect(runs).toBe(1)
        expect(result).toBe('pi.tool-result:probe real result')
      }
    },
    REOPEN_TIMEOUT
  )

  it(
    'LR-05 an unsafe MCP tool interrupted mid-call is not called again; continue gives the model an interrupted result',
    async () => {
      const first = await scenarioW()
      const calling = deferred()
      first.t.toolHost.mcp('ctx').gateCalls(new Promise(() => {}), () => calling.resolve())
      const session = await first.t.open()
      first.t.kit.queue(callTool('mcp__ctx__resolve', { q: 'x' }))
      void session.submitUser('go')
      await calling.promise

      const t2 = await first.t.restart()
      const reopened = await t2.open()
      expect(reopened.isInterrupted()).toBe(true)
      t2.kit.queue(answer('next'))
      expect(await withTimeout(reopened.continue(), 5000, 'continue')).toEqual({})
      expect(t2.toolHost.mcp('ctx').calls).toEqual([])
      expect(requestTexts(t2.kit, 0).find((line) => line.startsWith('toolResult:'))).toContain(
        'interrupted'
      )
    },
    REOPEN_TIMEOUT
  )

  it(
    'LR-06 the sandbox pin survives a restart with interrupted work: the host setting flipped off before the restart does not change the builtins until the agent is recreated (K8)',
    async () => {
      const { t } = await scenarioW()
      const session = await t.open()
      t.kit.queue(answer('one'))
      expect(await session.submitUser('u1')).toEqual({})
      const t2 = await stallThenRestart(t, session, {
        toolHost: scenarioToolHost({ sandbox: false })
      })
      const reopened = await t2.open()
      expect(t2.toolHost.builtinCalls).toEqual([{ sessionId: 's1', sandboxed: true }])
      t2.kit.queue(answer('two'))
      expect(await withTimeout(reopened.continue(), 5000, 'continue')).toEqual({})
      expect(requestTools(t2.kit, 0).find((tool) => tool.name === 'bash')!.description).toContain(
        'sandboxed=true'
      )
      expect(await toolDeltaCount(await reopened.currentConversation())).toBe(1)

      await reopened.destroyAgent()
      t2.kit.queue(answer('three'))
      expect(await reopened.submitUser('u3')).toEqual({})
      expect(t2.toolHost.builtinCalls.at(-1)).toEqual({ sessionId: 's1', sandboxed: false })
      expect(reopened.lock!.sandboxed).toBe(false)
      expect(requestTools(t2.kit, 1).find((tool) => tool.name === 'bash')!.description).toContain(
        'sandboxed=false'
      )
      expect(await toolDeltaCount(await reopened.currentConversation())).toBe(2)
    },
    REOPEN_TIMEOUT
  )

  it(
    'LR-07 an interrupted locked session stays paused after the rebuild',
    async () => {
      const first = await scenarioW()
      const session = await first.t.open()
      const stall = stalled()
      first.t.kit.queue(stall.step)
      void session.submitUser('hello')
      await stall.reached
      const t2 = await first.t.restart()
      const reopened = await t2.open()
      expect((await reopened.harness.inspect(BG)).scheduling).toBe('paused')
      expect(reopened.isInterrupted()).toBe(true)
      expect(reopened.lock).toBeDefined()
      expect(t2.toolHost.rebuildCalls).toHaveLength(1)
      await sleep(100)
      expect(t2.kit.callCount).toBe(0)
      expect((await reopened.harness.inspect(BG)).scheduling).toBe('paused')
    },
    REOPEN_TIMEOUT
  )

  it(
    'LR-08 close and reopen within one process: each open builds a fresh registry and rebuilds from the lock; the tools stay identical',
    async () => {
      const { t } = await scenarioW()
      const session = await t.open()
      t.kit.queue(answer('one'), answer('two'), answer('three'))
      expect(await session.submitUser('u1')).toEqual({})
      await t.host.close('s1')
      const second = await t.open()
      expect(await second.submitUser('u2')).toEqual({})
      await t.host.close('s1')
      const third = await t.open()
      expect(await third.submitUser('u3')).toEqual({})
      expect(t.toolHost.rebuildCalls).toHaveLength(2)
      const registries = t.registriesOf('s1')
      expect(registries).toHaveLength(3)
      expect(new Set(registries).size).toBe(3)
      expect(requestTools(t.kit, 1)).toEqual(requestTools(t.kit, 0))
      expect(requestTools(t.kit, 2)).toEqual(requestTools(t.kit, 0))
      expect(t.toolHost.resolveCalls).toHaveLength(1)
    },
    REOPEN_TIMEOUT
  )

  it(
    'LR-09 a mirror hook that throws does not fail the creation (a warning); the next open (interrupted work, so the lock survives) reconciles the mirror to true',
    async () => {
      const { t } = await scenarioW({
        onLockChange: (_id, locked) => {
          if (locked) throw new Error('db is read-only')
        }
      })
      const session = await t.open()
      t.kit.queue(answer('ok'))
      expect(await session.submitUser('u1')).toEqual({})
      expect(session.lock).toBeDefined()
      expect(t.warnings.some((warning) => warning.includes('db is read-only'))).toBe(true)
      const t2 = await stallThenRestart(t, session, { onLockChange: undefined })
      await t2.open()
      expect(t2.mirror).toEqual([['s1', true]])
    },
    REOPEN_TIMEOUT
  )

  it(
    'LR-10 a provider disabled between processes does not stop the locked session after a reopen with interrupted work (Q9)',
    async () => {
      const { t } = await scenarioW()
      const session = await t.open()
      t.kit.queue(answer('one'))
      expect(await session.submitUser('u1')).toEqual({})
      t.port.rows[0]!.isEnabled = false
      const t2 = await stallThenRestart(t, session)
      const reopened = await t2.open()
      t2.kit.queue(answer('two'))
      expect(await reopened.submitUser('u2')).toEqual({})
      expect(t2.toolHost.resolveCalls).toEqual([])
    },
    REOPEN_TIMEOUT
  )

  it(
    'LR-11 destroying after a restart with interrupted work uninstalls the rebuilt extension and unlocks; the next send creates again',
    async () => {
      const { t } = await scenarioW()
      const session = await t.open()
      t.kit.queue(answer('one'))
      expect(await session.submitUser('u1')).toEqual({})
      const t2 = await stallThenRestart(t, session)
      const reopened = await t2.open()
      expect(extensionTools(t2, 'shuvix.agent.1')).toBeDefined()
      await reopened.destroyAgent()
      expect(extensionTools(t2, 'shuvix.agent.1')).toBeUndefined()
      expect(reopened.lock).toBeUndefined()
      expect(await storedLock(reopened)).toBeUndefined()
      expect(t2.mirror).toEqual([
        ['s1', true],
        ['s1', false]
      ])
      t2.kit.queue(answer('two'))
      expect(await reopened.submitUser('u2')).toEqual({})
      expect(t2.toolHost.resolveCalls).toHaveLength(1)
      expect(reopened.lock).toBeDefined()
    },
    REOPEN_TIMEOUT
  )

  it(
    'LR-12 a rebuild that throws at reopen (interrupted work): open still succeeds and the history is readable; the lock is cleared and reported; the next send recreates (K12)',
    async () => {
      const { t } = await scenarioW()
      const session = await t.open()
      t.kit.queue(answer('one'))
      expect(await session.submitUser('u1')).toEqual({})
      const t2 = await stallThenRestart(t, session)
      t2.toolHost.failRebuild = new Error('skill folder gone')
      const reopened = await withTimeout(t2.open(), 5000, 'open')
      expect(await transcript(await reopened.currentConversation())).toEqual([
        'pi.user:u1',
        'pi.assistant:one',
        'pi.user:stalled'
      ])
      expect(t2.warnings.some((warning) => warning.includes('skill folder gone'))).toBe(true)
      expect(reopened.lock).toBeUndefined()
      expect(await storedLock(reopened)).toBeUndefined()
      expect(t2.mirror).toEqual([['s1', false]])
      expect(extensionTools(t2, 'shuvix.agent.1')).toBeUndefined()
      expect((await reopened.harness.inspect(BG)).scheduling).toBe('paused')

      t2.toolHost.failRebuild = undefined
      t2.kit.queue(answer('two'))
      expect(await reopened.submitUser('u2')).toEqual({})
      expect(t2.toolHost.resolveCalls).toHaveLength(1)
      expect(reopened.lock).toBeDefined()
    },
    REOPEN_TIMEOUT
  )

  it(
    'LR-13 a malformed lock (written raw, without toolNames): open does not throw; the lock is cleared and reported (K12)',
    async () => {
      const { t } = await scenarioW()
      const session = await t.open()
      await session.harness.commit(async (tx) => {
        ;(await tx.doc(SessionStateDoc)).lock = {
          conversationId: ROOT_CONVERSATION_ID,
          profileName: 'work'
        }
      }, BG)
      expect(session.lock).toBeUndefined()
      const t2 = await t.restart()
      const reopened = await withTimeout(t2.open(), 5000, 'open')
      expect(reopened.lock).toBeUndefined()
      expect(await storedLock(reopened)).toBeUndefined()
      expect(t2.warnings.some((warning) => warning.includes('malformed'))).toBe(true)
      expect(t2.mirror).toEqual([['s1', false]])
      expect(t2.toolHost.rebuildCalls).toEqual([])
      expect(await reopened.harness.snapshot(AgentDoc, ROOT_CONVERSATION_ID, BG)).toEqual({})
    },
    REOPEN_TIMEOUT
  )
})
