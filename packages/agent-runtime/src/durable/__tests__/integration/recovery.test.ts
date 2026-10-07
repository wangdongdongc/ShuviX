/**
 * P1-12 · 场景 5：崩溃、重开、继续（SQLite，模拟换进程）。
 *
 * 打开从不续跑；带着被中断的工作重启，锁与 MCP 声明熬过去（option A）：打开时按声明重建工具并当场连锁
 * 记着的服务器（完整初始化，与创建同口径）；空闲重启清锁，下一次发送重新创建；
 * 不安全的工具中断后记为「中断，可能已部分执行」、不重跑；推迟的通知在继续时送达；
 * 继续不发日期通知（PIN-7），下一次用户输入才发；打开时总报一次真实的运行状态（PIN-R）。
 */
import { describe, expect, it } from 'vitest'
import { backgroundContext as BG } from '../../context'
import { NoticeEntry, SessionStateDoc } from '../../docs'
import type { DurableSession } from '../../durableSession'
import { answer, callTool, stalled } from '../support/faux'
import { registerHostCleanup } from '../support/host'
import { allEntries, systemDeltas, toolDeltaCount, transcript } from '../support/transcript'
import { sleep, waitFor, withTimeout } from '../support/wait'
import { harnessErrorText, resultEntry, resultText } from './support/entries'
import { bg } from './support/notices'
import { lastToolResult, when } from './support/scriptedModel'
import { E_TOOLS, makeWorld, registerWorldCleanup, type World } from './support/world'

registerHostCleanup()
registerWorldCleanup()

const TIMEOUT = 20000

function extensionTools(world: World, name: string): string[] | undefined {
  const extension = world.t.registryOf('s1')?.snapshot().extension(name)
  return extension === undefined ? undefined : (extension.tools ?? []).map((tool) => tool.name)
}

/** 上锁并跑完一轮 */
async function locked(world: World): Promise<DurableSession> {
  const session = await world.open()
  world.chat(answer('ready'))
  expect(await session.submitUser('hello')).toEqual({})
  return session
}

/** 一轮请求停在半路，然后换进程 */
async function crashMidRequest(world: World, session: DurableSession, text = 'u'): Promise<void> {
  const stall = stalled()
  world.chat(stall.step)
  void session.submitUser(text)
  await withTimeout(stall.reached, 3000, 'request reached')
  await withTimeout(world.restart(), 10000, 'restart')
}

describe('P1-12 · recovery', () => {
  it(
    'I5-01 a crash mid-generation: the lock and the MCP declarations survive and the agent is fully initialized at open (its MCP server connects, option A), nothing runs; a deferred notice lands after the resumed answer',
    async () => {
      const world = await makeWorld()
      const session = await locked(world)
      const lock = structuredClone(session.lock)
      await crashMidRequest(world, session)

      const reopened = await world.open()
      expect(reopened.lock).toEqual(lock)
      expect(extensionTools(world, 'shuvix.builtin')).toEqual([
        'read',
        'write',
        'edit',
        'ask',
        'dump',
        'boom'
      ])
      expect(extensionTools(world, 'shuvix.agent.1')).toEqual([
        'mcp__docs__lookup',
        'mcp__docs__slow'
      ])
      expect(world.toolHost.rebuildCalls).toEqual([lock])
      expect(world.toolHost.resolveCalls).toEqual([])
      expect(world.mcp.connectsOf('docs')).toBe(1)
      expect(world.t.mirror).toEqual([['s1', true]])
      expect(world.t.broadcastsOf('agent_created')).toEqual([])
      expect(reopened.runState).toBe('interrupted')
      expect(world.t.statesOf('s1')).toEqual(['interrupted'])
      await sleep(150)
      expect(world.t.kit.callCount).toBe(0)

      const notice = bg('t1', 'build finished')
      expect(await reopened.writeNotice({ text: notice, kind: 'background' })).toMatchObject({
        status: 'deferred'
      })
      world.chat(answer('resumed'))
      expect(await withTimeout(reopened.continue(), 5000, 'continue')).toEqual({})

      expect(world.model.chats).toHaveLength(1)
      expect(world.model.chats[0]!.tools).toEqual(E_TOOLS)
      const tail = (await transcript(await reopened.currentConversation())).slice(-3)
      expect(tail).toEqual(['pi.user:u', 'pi.assistant:resumed', `shuvix.notice:${notice}`])
      expect((await reopened.harness.snapshot(SessionStateDoc, BG))?.deferredNotices).toEqual([])
      await waitFor(() => world.t.statesOf('s1').length >= 3, 1000, 'run states')
      expect(world.t.statesOf('s1')).toEqual(['interrupted', 'busy', 'idle'])
      expect(world.mcp.connectsOf('docs')).toBe(1)
    },
    TIMEOUT
  )

  it(
    'I5-02 a crash mid MCP call: continue records the call as interrupted without re-running it; the server was connected at open (option A), so the next MCP call reuses that connection',
    async () => {
      const world = await makeWorld()
      const session = await locked(world)
      world.chat(callTool('mcp__docs__slow', {}, 'c-slow'))
      void session.submitUser('slow please')
      await waitFor(() => world.mcpLog.callsOf('slow').length === 1, 3000, 'slow call reached')
      await withTimeout(world.restart(), 10000, 'restart')

      const reopened = await world.open()
      expect(world.mcp.connectsOf('docs')).toBe(1)
      world.chat(
        when((messages) =>
          lastToolResult(messages, 'mcp__docs__slow')?.includes('was interrupted')
            ? callTool('mcp__docs__lookup', { q: 'again' }, 'c-look')
            : answer('the slow call was not interrupted?')
        ),
        answer('done')
      )
      expect(await withTimeout(reopened.continue(), 5000, 'continue')).toEqual({})

      const conversation = await reopened.currentConversation()
      expect(resultText(await resultEntry(conversation, 'c-slow'))).toBe(
        harnessErrorText('Tool mcp__docs__slow was interrupted and may have partially run')
      )
      expect(world.mcpLog.callsOf('slow')).toHaveLength(1)
      expect(world.mcp.connectsOf('docs')).toBe(1)
      expect(world.mcpLog.callsOf('lookup')).toEqual([
        expect.objectContaining({ args: { q: 'again' } })
      ])
      expect(resultText(await resultEntry(conversation, 'c-look'))).toBe('docs.lookup:again')
      expect((await transcript(conversation)).at(-1)).toBe('pi.assistant:done')
    },
    TIMEOUT
  )

  it(
    'I5-02b the server dropped a tool between processes (interrupted work, so the lock survives): the locked tool list does not change, and calling the dropped tool answers isError',
    async () => {
      const world = await makeWorld()
      const session = await locked(world)
      const before = world.model.chats.at(-1)!.tools
      const stall = stalled()
      world.chat(stall.step)
      void session.submitUser('try slow')
      await withTimeout(stall.reached, 3000, 'request reached')
      await withTimeout(world.restart({ mcp: { docs: ['lookup'] } }), 10000, 'restart')

      const reopened = await world.open()
      world.chat(callTool('mcp__docs__slow', {}, 'c-slow'), answer('ok'))
      expect(await withTimeout(reopened.continue(), 5000, 'continue')).toEqual({})
      expect(world.model.chats[0]!.tools).toEqual(before)
      expect(world.model.chats[0]!.tools).toContain('mcp__docs__slow')
      expect(await toolDeltaCount(await reopened.currentConversation(), 1)).toBe(0)
      const result = await resultEntry(await reopened.currentConversation(), 'c-slow')
      expect(resultText(result)).toBe('[MCP Error] unknown tool slow')
      expect(reopened.lock!.mcp.docs!.map((decl) => decl.name)).toEqual(['lookup', 'slow'])
    },
    TIMEOUT
  )

  it(
    'I5-03 an idle restart, then a send (option A): open clears the lock from the earlier process and builds nothing; the send creates the agent again from the current config — the same tools, no extra tool delta',
    async () => {
      const world = await makeWorld()
      await locked(world)
      const before = world.model.chats.at(-1)!.tools
      await withTimeout(world.restart(), 10000, 'restart')

      const reopened = await world.open()
      expect(reopened.lock).toBeUndefined()
      expect(world.t.mirror).toEqual([['s1', false]])
      expect(world.toolHost.builtinCalls).toEqual([])
      expect(world.toolHost.rebuildCalls).toEqual([])
      expect(world.mcp.connectsOf('docs')).toBe(0)
      world.chat(answer('two'))
      expect(await reopened.submitUser('again')).toEqual({})
      expect(world.model.chats[0]!.tools).toEqual(before)
      const deltas = await systemDeltas(await reopened.currentConversation())
      expect(
        deltas.filter((delta) => delta.toolsAdded.length + delta.toolsRemoved.length > 0)
      ).toHaveLength(1)
      expect(world.t.configCalls).toEqual(['s1'])
      expect(world.toolHost.resolveCalls).toHaveLength(1)
      expect(world.t.broadcastsOf('agent_created')).toHaveLength(1)
      expect(world.mcp.connectsOf('docs')).toBe(1)
    },
    TIMEOUT
  )

  it(
    'I5-04 the date across a crash: continue adds no date notice (PIN-7); the next user input does, right before it',
    async () => {
      const world = await makeWorld()
      const session = await locked(world)
      await crashMidRequest(world, session)
      world.clock.setToday('2026-10-05')

      const reopened = await world.open()
      world.chat(answer('resumed'))
      expect(await withTimeout(reopened.continue(), 5000, 'continue')).toEqual({})
      const conversation = await reopened.currentConversation()
      expect((await allEntries(conversation)).filter((entry) => NoticeEntry.is(entry))).toEqual([])

      world.chat(answer('hi back'))
      expect(await reopened.submitUser('hi')).toEqual({})
      const tail = (await allEntries(conversation))
        .filter((entry) => entry.kind !== 'pi.system')
        .slice(-3)
      expect(tail.map((entry) => entry.kind)).toEqual([NoticeEntry.kind, 'pi.user', 'pi.assistant'])
      expect(tail[0]!.data).toMatchObject({ kind: 'date', date: '2026-10-05' })
      expect((await transcript(conversation)).slice(-2)).toEqual([
        'pi.user:hi',
        'pi.assistant:hi back'
      ])
    },
    TIMEOUT
  )

  it(
    'I5-05 run state at open (PIN-R): a crash while busy reopens as interrupted, an idle session reopens as idle — each reported exactly once',
    async () => {
      const world = await makeWorld()
      const session = await locked(world)
      await crashMidRequest(world, session)
      const interrupted = await world.open()
      expect(world.t.statesOf('s1')).toEqual(['interrupted'])
      expect(interrupted.runState).toBe('interrupted')
      await interrupted.abort()

      await withTimeout(world.restart(), 10000, 'restart')
      await world.open()
      await sleep(50)
      expect(world.t.statesOf('s1')).toEqual(['idle'])
    },
    TIMEOUT
  )
})
