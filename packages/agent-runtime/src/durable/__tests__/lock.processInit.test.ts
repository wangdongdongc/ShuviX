/**
 * 锁 · 跟着本进程的初始化走（option A，用户 2026-10-07）：锁 = 「agent 在本进程里初始化过」。宿主按会话记
 * 一份进程内记录（`SessionProcessRecord`）—— 同一进程里 LRU 关了再开锁照旧重建；换了进程（`restart()`）：
 *  - 有可续的工作（被中断）→ 保留锁、完整初始化（重建工具、当场连锁记着的 MCP，连不上照样起来）；
 *  - 空闲 → 一个提交清锁、什么都不建（连内置工具都不建），镜像对成 false；下一次发送按此刻的配置创建；
 *    残留的后台压缩打中止标记，之后开启调度器也从不调模型。
 * 内置工具因此是惰性的：派生子 agent 要用时才装。显式喊停记在进程内记录上（LRU 关了再开也记得）。
 */
import { fauxAssistantMessage, type FauxResponseStep } from '@earendil-works/pi-ai'
import { LiveDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import { backgroundContext as BG } from '../context'
import { NoticeEntry } from '../docs'
import type { DurableSession } from '../durableSession'
import { lockRecordJson, parseLockRecord } from '../lock'
import { scenarioToolHost, testProfile } from './support/agentConfig'
import { answer, fauxKit, requestTools, stalled } from './support/faux'
import { makeHost, registerHostCleanup, type TestHost, type TestHostOptions } from './support/host'
import {
  extensionTools,
  lockW,
  piAgent,
  scenarioW,
  storedLock,
  toolDescription,
  wKit
} from './support/scenario'
import { callAgent, configD, dispatch, TEST_SPAWN_EXTENSION } from './support/spawn'
import { allEntries, transcript } from './support/transcript'
import { aborted, deferred, sleep, waitFor, withTimeout } from './support/wait'

registerHostCleanup()

const TIMEOUT = 15000

/** 让会话停在一轮生成里再换进程：存储里留下被中断的工作 */
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

function hasExtension(t: TestHost, name: string, sessionId = 's1'): boolean {
  return t.registryOf(sessionId)?.snapshot().extension(name) !== undefined
}

describe('lock · follows in-process initialization (option A)', () => {
  it(
    'LA-01 an idle locked session reopened after a restart: the lock is cleared, no extension is installed, nothing is built (no builtin, no rebuild, no config read, no connect); pi.agent and the transcript stay; the mirror says false',
    async () => {
      const { t } = await scenarioW()
      const session = await t.open()
      t.kit.queue(answer('one'))
      expect(await session.submitUser('u1')).toEqual({})
      expect(session.lock).toBeDefined()
      const agentBefore = await piAgent(session)

      const t2 = await t.restart()
      const reopened = await t2.open()
      expect(reopened.lock).toBeUndefined()
      expect(await storedLock(reopened)).toBeUndefined()
      expect(reopened.agentIdentity(ROOT_CONVERSATION_ID)).toBeUndefined()
      expect(t2.mirror).toEqual([['s1', false]])
      expect(t2.toolHost.builtinCalls).toEqual([])
      expect(t2.toolHost.rebuildCalls).toEqual([])
      expect(t2.toolHost.resolveCalls).toEqual([])
      expect(t2.configCalls).toEqual([])
      expect(t2.toolHost.mcp('ctx').connects).toBe(0)
      expect(hasExtension(t2, 'shuvix.builtin')).toBe(false)
      expect(hasExtension(t2, 'shuvix.agent.1')).toBe(false)
      expect(t2.broadcastsOf('agent_created')).toEqual([])
      expect(t2.broadcastsOf('agent_closing')).toEqual([])
      expect(t2.warnings).toEqual([])
      expect(await piAgent(reopened)).toEqual(agentBefore)
      expect(await transcript(await reopened.currentConversation())).toEqual([
        'pi.user:u1',
        'pi.assistant:one'
      ])
      expect(reopened.runState).toBe('idle')
      expect((await reopened.harness.inspect(BG)).scheduling).toBe('paused')
      expect(await reopened.monitorSnapshot()).toEqual([])
      await sleep(50)
      expect(t2.kit.callCount).toBe(0)
    },
    TIMEOUT
  )

  it(
    'LA-02 after the clear, createAgent / the next send creates a fresh agent from the current config (model, selection, sandbox pin): one config read, one resolution, builtins built pinned, agent_created once',
    async () => {
      const { t, config } = await scenarioW()
      const session = await t.open()
      t.kit.queue(answer('one'))
      expect(await session.submitUser('u1')).toEqual({})
      expect(session.lock).toEqual(lockW())
      // 换进程之间改了会话配置与宿主的沙箱开关：锁住时它们不作数，清锁之后下一次创建按它们来
      config.model = { provider: 'faux', modelId: 'faux-2' }
      config.toolOverlay = ['skill:pdf']
      const t2 = await t.restart({ toolHost: scenarioToolHost({ sandbox: false }) })
      const reopened = await t2.open()
      expect(reopened.lock).toBeUndefined()

      const created = await reopened.createAgent()
      expect(created.model).toEqual({ provider: 'faux', modelId: 'faux-2' })
      expect(created.sandboxed).toBe(false)
      expect(created.mcp).toEqual({})
      expect(created.toolNames).not.toContain('mcp__ctx__resolve')
      expect(t2.configCalls).toEqual(['s1'])
      expect(t2.toolHost.resolveCalls).toHaveLength(1)
      expect(t2.toolHost.rebuildCalls).toEqual([])
      expect(t2.toolHost.builtinCalls).toEqual([{ sessionId: 's1', sandboxed: false }])
      expect(toolDescription(t2, 'shuvix.builtin', 'bash')).toContain('sandboxed=false')
      expect(t2.broadcastsOf('agent_created')).toHaveLength(1)
      expect(t2.mirror).toEqual([
        ['s1', false],
        ['s1', true]
      ])

      t2.kit.queue(answer('two'))
      expect(await reopened.submitUser('u2')).toEqual({})
      expect(t2.kit.requests[0]!.modelId).toBe('faux-2')
      expect(t2.toolHost.resolveCalls).toHaveLength(1)
    },
    TIMEOUT
  )

  it(
    'LA-03 an interrupted locked session reopened after a restart keeps its lock and is fully initialized: rebuild with connect, the MCP server connected, builtins pinned, no config read; continue runs with the locked config even though the settings changed',
    async () => {
      const { t, config } = await scenarioW()
      const session = await t.open()
      t.kit.queue(answer('one'))
      expect(await session.submitUser('u1')).toEqual({})
      const lock = session.lock!
      config.model = { provider: 'faux', modelId: 'faux-2' }
      const t2 = await stallThenRestart(t, session)

      const reopened = await t2.open()
      expect(reopened.isInterrupted()).toBe(true)
      expect(reopened.runState).toBe('interrupted')
      expect(reopened.lock).toEqual(lock)
      expect(await storedLock(reopened)).toBeDefined()
      expect(t2.toolHost.rebuildCalls).toEqual([lock])
      expect(t2.toolHost.rebuildContexts).toEqual([
        { sessionId: 's1', connect: { signal: expect.any(AbortSignal) } }
      ])
      expect(t2.toolHost.mcp('ctx').connects).toBe(1)
      expect(t2.toolHost.builtinCalls).toEqual([{ sessionId: 's1', sandboxed: true }])
      expect(extensionTools(t2, 'shuvix.agent.1')).toEqual([
        'agent',
        'skill',
        'mcp__ctx__resolve',
        'mcp__ctx__docs'
      ])
      expect(t2.configCalls).toEqual([])
      expect(t2.toolHost.resolveCalls).toEqual([])
      expect(t2.mirror).toEqual([['s1', true]])
      expect(t2.broadcastsOf('agent_created')).toEqual([])
      expect((await reopened.harness.inspect(BG)).scheduling).toBe('paused')
      expect((await reopened.monitorSnapshot()).map((row) => [row.kind, row.phase])).toEqual([
        ['root', 'interrupted']
      ])

      t2.kit.queue(answer('resumed'))
      expect(await withTimeout(reopened.continue(), 5000, 'continue')).toEqual({})
      expect(t2.kit.requests[0]!.modelId).toBe('faux-1')
      expect(requestTools(t2.kit, 0).map((tool) => tool.name)).toContain('mcp__ctx__docs')
      expect(t2.configCalls).toEqual([])
      expect(t2.toolHost.resolveCalls).toEqual([])
      expect(t2.toolHost.mcp('ctx').connects).toBe(1)
    },
    TIMEOUT
  )

  it(
    'LA-04 a server that fails to connect during that full initialization broadcasts the error and the agent still comes up with the locked tools',
    async () => {
      const { t } = await scenarioW()
      const session = await t.open()
      t.kit.queue(answer('one'))
      expect(await session.submitUser('u1')).toEqual({})
      const t2 = await stallThenRestart(t, session)
      t2.toolHost.mcp('ctx').failConnect('refused')

      const reopened = await withTimeout(t2.open(), 5000, 'open')
      expect(t2.toolHost.mcp('ctx').connects).toBe(1)
      expect(t2.broadcastsOf('error')).toEqual([
        {
          type: 'error',
          sessionId: 's1',
          error: 'MCP server ctx failed to connect: MCP server "ctx": refused'
        }
      ])
      expect(reopened.lock).toEqual(lockW())
      expect(extensionTools(t2, 'shuvix.agent.1')).toContain('mcp__ctx__docs')
      expect(t2.mirror).toEqual([['s1', true]])
      expect(t2.warnings).toEqual([])
    },
    TIMEOUT
  )

  it(
    'LA-05 an LRU close and reopen in the same process keeps the lock and restores it as before: rebuild without connecting, no config read',
    async () => {
      const { t } = await scenarioW()
      const session = await t.open()
      t.kit.queue(answer('one'), answer('two'))
      expect(await session.submitUser('u1')).toEqual({})
      const lock = session.lock!
      await t.host.close('s1')

      const reopened = await t.open()
      expect(reopened).not.toBe(session)
      expect(reopened.lock).toEqual(lock)
      expect(t.toolHost.rebuildCalls).toEqual([lock])
      expect(t.toolHost.rebuildContexts).toEqual([{ sessionId: 's1' }])
      expect(t.toolHost.mcp('ctx').connects).toBe(1)
      expect(t.toolHost.builtinCalls.at(-1)).toEqual({ sessionId: 's1', sandboxed: true })
      expect(t.configCalls).toEqual(['s1'])
      expect(t.mirror).toEqual([
        ['s1', false],
        ['s1', true],
        ['s1', true]
      ])
      expect(await reopened.submitUser('u2')).toEqual({})
      expect(t.toolHost.resolveCalls).toHaveLength(1)
    },
    TIMEOUT
  )

  it(
    'LA-06 what this process initialized is remembered: after the full initialization, and after a creation that follows a clear, an idle LRU close / reopen keeps the lock without connecting again',
    async () => {
      const { t } = await scenarioW()
      const first = await t.open()
      t.kit.queue(answer('one'))
      expect(await first.submitUser('u1')).toEqual({})
      const idle = await t.open('s2')
      await idle.createAgent()
      const t2 = await stallThenRestart(t, first)

      // s1：被中断 → 完整初始化；继续跑完之后空闲，关了再开照旧保留
      const s1 = await t2.open()
      t2.kit.queue(answer('resumed'))
      expect(await withTimeout(s1.continue(), 5000, 'continue')).toEqual({})
      await t2.host.close('s1')
      const s1Again = await t2.open()
      expect(s1Again.lock).toEqual(lockW())
      expect(t2.toolHost.rebuildContexts.map((context) => context.connect !== undefined)).toEqual([
        true,
        false
      ])
      expect(t2.toolHost.mcp('ctx').connects).toBe(1)

      // s2：空闲 → 清锁；这个进程里重新创建之后，关了再开照旧保留
      const s2 = await t2.open('s2')
      expect(s2.lock).toBeUndefined()
      await s2.createAgent()
      await t2.host.close('s2')
      const s2Again = await t2.open('s2')
      expect(s2Again.lock).toBeDefined()
      expect(t2.mirror.filter(([id]) => id === 's2')).toEqual([
        ['s2', false],
        ['s2', true],
        ['s2', true]
      ])
    },
    TIMEOUT
  )

  it(
    'LA-07 a background compaction pending at quit on an idle session is aborted at open and never calls the model, not even after a later write starts the scheduler',
    async () => {
      const summaryReached = deferred()
      // 3000 的窗口：两条长回答之后后台压缩（LW-07 的设置）；摘要请求一直扣着，直到关停
      const respond: FauxResponseStep = async (context, streamOptions) => {
        const first = context.messages[0]
        if (
          first?.role === 'system' &&
          typeof first.content === 'string' &&
          first.content.includes('summar')
        ) {
          summaryReached.resolve()
          return aborted(streamOptions!.signal!)
        }
        return fauxAssistantMessage(`answer ${'details '.repeat(800)}`)
      }
      const { t } = await scenarioW({
        config: { profile: testProfile(), model: { provider: 'faux', modelId: 'faux-1' } },
        makeKit: () => fauxKit({ models: [{ id: 'faux-1', contextWindow: 3000 }] }),
        settingsOverrides: { retry: { enabled: false }, compaction: { keepRecentTokens: 100 } }
      })
      for (let i = 0; i < 4; i++) t.kit.queue(respond)
      const session = await t.open()
      expect(await session.submitUser('first question')).toEqual({})
      expect(await session.submitUser('second question')).toEqual({})
      await withTimeout(summaryReached.promise, 5000, 'summary requested')
      const live = await session.harness.snapshot(LiveDoc, ROOT_CONVERSATION_ID, BG)
      const compaction = live!.compactions![0]!.taskId

      const t2 = await t.restart()
      const reopened = await t2.open()
      expect(reopened.lock).toBeUndefined()
      expect(reopened.runState).toBe('idle')
      expect(reopened.isInterrupted()).toBe(false)
      expect(await reopened.taskLiveness(compaction)).toEqual({ live: true, abortRequested: true })
      expect(t2.statesOf('s1')).toEqual(['idle'])
      await sleep(100)
      expect(t2.kit.callCount).toBe(0)

      // 写一条通知（开启调度器）：打了标记的压缩走中止分支收场，一次模型调用都没有
      expect(
        await reopened.writeNotice({ text: 'build finished', kind: 'background' })
      ).toMatchObject({ status: 'submitted' })
      await waitFor(
        async () => (await reopened.taskLiveness(compaction))?.live === false,
        3000,
        'compaction ended'
      )
      await waitFor(() => reopened.runState === 'idle', 3000, 'idle')
      await sleep(100)
      expect(t2.kit.callCount).toBe(0)
      expect(reopened.lock).toBeUndefined()
      const entries = await allEntries(await reopened.currentConversation())
      expect(entries.filter((entry) => NoticeEntry.is(entry))).toHaveLength(1)
      expect(entries.some((entry) => entry.kind === 'pi.compaction')).toBe(false)
    },
    TIMEOUT
  )

  it(
    'LA-08 the builtins are lazy: a spawned child continued from the panel on a cleared-lock session gets them installed first (placeholder pin), so its request still offers its builtin tools',
    async () => {
      const outcomes: unknown[] = []
      let current: DurableSession | undefined
      const reader = testProfile({ name: 'reader', displayName: 'Reader', tools: ['read'] })
      const dispatchTool = dispatch({
        getSession: () => current!,
        profiles: { reader },
        outcomes: outcomes as never
      })
      const t = await makeHost({
        makeKit: wKit,
        extensions: [TEST_SPAWN_EXTENSION],
        toolHost: { scenario: 'w', dispatchTool },
        agentConfig: configD({
          profile: testProfile({ name: 'work', displayName: 'Work', tools: ['agent', 'read'] })
        })
      })
      current = await t.open()
      t.kit.queue(callAgent('reader', 'look around'), answer('child done'), answer('root done'))
      expect(await current.submitUser('go')).toEqual({})
      const [record] = current.spawnedRecords()
      expect(record!.toolNames).toEqual(['read'])

      const t2 = await t.restart()
      current = await t2.open()
      expect(current.lock).toBeUndefined()
      expect(t2.toolHost.builtinCalls).toEqual([])
      expect(hasExtension(t2, 'shuvix.builtin')).toBe(false)

      t2.kit.queue(answer('more from the child'))
      const outcome = await withTimeout(
        current.agents.continue(record!.conversationId, 'more'),
        5000,
        'panel continue'
      )
      expect(outcome.error).toBeUndefined()
      expect(outcome.result).toBe('more from the child')
      expect(t2.toolHost.builtinCalls).toEqual([{ sessionId: 's1', sandboxed: undefined }])
      expect(requestTools(t2.kit, 0).map((tool) => tool.name)).toEqual(['read'])
      // 根 agent 照旧没有：面板追问不建锁
      expect(current.lock).toBeUndefined()
    },
    TIMEOUT
  )

  it(
    'LA-09 lockedThinkingLevel reads the live level of the locked root (K9): undefined without a lock, the creation level, then what setThinkingLevel set',
    async () => {
      const { t } = await scenarioW()
      const session = await t.open()
      expect(await session.lockedThinkingLevel()).toBeUndefined()
      await session.createAgent()
      expect(await session.lockedThinkingLevel()).toBe('low')
      await session.setThinkingLevel('high')
      expect(await session.lockedThinkingLevel()).toBe('high')
      expect(session.lock!.thinkingLevel).toBe('low')
      expect((await session.harness.inspect(BG)).scheduling).toBe('paused')
    },
    TIMEOUT
  )

  it(
    'LA-11 the lock records the selection it was created from (agent.init reports it while locked): a server that failed to connect stays in it, profile-declared tools do not; a malformed selection read back is dropped, not the whole lock',
    async () => {
      const { t, config } = await scenarioW()
      config.toolOverlay = ['mcp:ctx', 'skill:pdf', 'mcp:broken', 'mcp:ctx']
      t.toolHost.mcp('broken').failConnect()
      const session = await t.open()
      const lock = await session.createAgent()
      expect(lock.selection).toEqual(['mcp:ctx', 'skill:pdf', 'mcp:broken'])
      expect(Object.keys(lock.mcp)).toEqual(['ctx'])
      expect(lock.skills).toEqual(['builtin:drawing', 'pdf'])
      expect((await storedLock(session)) as { selection?: unknown }).toMatchObject({
        selection: ['mcp:ctx', 'skill:pdf', 'mcp:broken']
      })
      const { selection: _selection, ...rest } = lock
      expect(parseLockRecord({ ...lockRecordJson(lock), selection: 'mcp:ctx' })).toEqual(rest)
    },
    TIMEOUT
  )

  it(
    'LA-10 an explicit stop survives an LRU close / reopen in the same process: a notice after it is written, no turn; the next user send turns auto-resume back on',
    async () => {
      const { t } = await scenarioW({ noticeCoalesceMs: 10 })
      const session = await t.open()
      t.kit.queue(answer('one'))
      expect(await session.submitUser('u1')).toEqual({})
      await session.abort()
      await t.host.close('s1')

      const reopened = await t.open()
      expect(reopened.lock).toBeDefined()
      await reopened.notify('<bg>first</bg>', { requestId: 'n1' })
      await sleep(80)
      expect(t.kit.callCount).toBe(1)
      const notices = (await allEntries(await reopened.currentConversation())).filter((entry) =>
        NoticeEntry.is(entry)
      )
      expect(notices).toHaveLength(1)

      t.kit.queue(answer('two'), answer('three'))
      expect(await reopened.submitUser('u2')).toEqual({})
      await reopened.notify('<bg>second</bg>', { requestId: 'n2' })
      await waitFor(() => t.kit.callCount === 3, 3000, 'auto-resumed turn')
    },
    TIMEOUT
  )
})
