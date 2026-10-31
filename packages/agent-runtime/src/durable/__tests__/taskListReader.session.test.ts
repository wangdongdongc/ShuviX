/**
 * 任务列表的 server 侧读者（`taskListReader.ts` `readTaskList`，docs/task-list-design.md §3.2）跑在真会话上：
 * 一个名叫 `mcp__plan__update` 的测试工具在执行时调 `readTaskList(session, callId)`、记下读到的列表 —— 照
 * planServer 的做法。
 *
 *   TLR-S-1 条目在工具执行之前已提交：第一次调用读到 undefined，第二次恰好读到第一次的列表；跑完之后读到推进后的
 *   TLR-S-2 第一次调用扣住时插进来的话（带说明）不清空列表；之后一条空闲时的新请求让列表变回 undefined
 *   TLR-S-3 回退：读的是回退后的当前对话，交回那里当前请求的列表
 *   TLR-S-4 句柄已关 → SessionClosedError（带会话 id）；别的失败原样抛出
 *   TLR-S-5 只读：被中断的会话上读，不续跑、不开调度器、不建 agent、零发布
 */
import { Type } from '@earendil-works/pi-ai'
import { defineTool, type JsonObject, type ToolRegistration } from '@earendil-works/pi-durable'
import type { TaskListItem } from '@shuvix/chat-protocol/taskList'
import { describe, expect, it } from 'vitest'
import { backgroundContext as BG } from '../context'
import { SessionClosedError, type DurableSession } from '../durableSession'
import { readTaskList, type TaskListReaderSession } from '../taskListReader'
import { recordPublications } from './support/commits'
import { answer, callTool, stalled } from './support/faux'
import { makeHost, primeRoot, registerHostCleanup, type TestHost } from './support/host'
import { forkedId } from './support/rollback'
import { allEntries, midRunNoted, requestTexts } from './support/transcript'
import { deferred, sleep, withTimeout } from './support/wait'

registerHostCleanup()

const TIMEOUT = 15000
const PLAN = 'mcp__plan__update'

const ITEMS = [
  { content: 'Read the code', status: 'in_progress' },
  { content: 'Fix the bug', status: 'pending' },
  { content: 'Run the tests', status: 'pending' }
] as const
const OTHER = [
  { content: 'Write the docs', status: 'in_progress' },
  { content: 'Publish', status: 'pending' }
] as const
const ADVANCED: TaskListItem[] = [
  { content: 'Read the code', status: 'completed' },
  { content: 'Fix the bug', status: 'in_progress' },
  { content: 'Run the tests', status: 'pending' }
]

interface Seen {
  readonly callId: string
  readonly list: TaskListItem[] | undefined
}

/** 照 planServer：执行时读这次调用之前的列表并记下；`gate` 给了就在读完之后等它 */
function planTool(
  getSession: () => DurableSession,
  seen: Seen[],
  options: { gate?: Promise<unknown>; onRun?: () => void } = {}
): ToolRegistration {
  return defineTool({
    name: PLAN,
    description: 'test plan tool',
    parameters: Type.Object({
      items: Type.Optional(
        Type.Array(Type.Object({ content: Type.String(), status: Type.String() }))
      ),
      advance: Type.Optional(Type.Boolean()),
      done: Type.Optional(Type.Array(Type.Integer())),
      start: Type.Optional(Type.Integer())
    }),
    execute: async (_args, api) => {
      const list = await readTaskList(getSession(), api.callId)
      seen.push({ callId: api.callId, list })
      options.onRun?.()
      if (options.gate !== undefined) await options.gate
      return { output: [{ type: 'text', text: 'ok' }] }
    }
  })
}

async function planHost(
  options: { gate?: Promise<unknown>; onRun?: () => void } = {}
): Promise<{ t: TestHost; session: DurableSession; seen: Seen[] }> {
  const ref: { session?: DurableSession } = {}
  const seen: Seen[] = []
  const t = await makeHost({ tools: [planTool(() => ref.session!, seen, options)] })
  const session = (ref.session = await t.open())
  await primeRoot(session)
  return { t, session, seen }
}

const items = (list: readonly { content: string; status: string }[]): JsonObject => ({
  items: list.map((item) => ({ ...item }))
})

describe('readTaskList on a real session', () => {
  it(
    'TLR-S-1 entries are committed before the tool runs: the first call reads undefined, the second exactly the first list; after the run the advanced list',
    async () => {
      const { t, session, seen } = await planHost()
      t.kit.queue(
        callTool(PLAN, items(ITEMS), 'p1'),
        callTool(PLAN, { advance: true }, 'p2'),
        answer('done')
      )
      expect(await session.submitUser('go')).toEqual({})
      expect(seen).toStrictEqual([
        { callId: 'p1', list: undefined },
        { callId: 'p2', list: ITEMS.map((item) => ({ ...item })) }
      ])
      expect(await readTaskList(session)).toStrictEqual(ADVANCED)
    },
    TIMEOUT
  )

  it(
    'TLR-S-2 a busy steer while the first call is held keeps the list; a new idle request afterwards clears it',
    async () => {
      const gate = deferred()
      const running = deferred()
      const { t, session, seen } = await planHost({
        gate: gate.promise,
        onRun: () => running.resolve()
      })
      t.kit.queue(
        callTool(PLAN, items(ITEMS), 'p1'),
        callTool(PLAN, { advance: true }, 'p2'),
        answer('done')
      )
      const sending = session.submitUser('go')
      await running.promise
      expect((await session.steer('also check the logs')).submissionId).toBeDefined()
      gate.resolve()
      expect(await withTimeout(sending, 5000, 'round')).toEqual({})
      // 插话落在第一次调用的结果之后、第二次调用之前（带说明）
      expect(requestTexts(t.kit, 1).at(-1)).toBe(`user:${midRunNoted('also check the logs')}`)
      expect(seen.map((s) => s.callId)).toEqual(['p1', 'p2'])
      expect(seen[1]!.list).toStrictEqual(ITEMS.map((item) => ({ ...item })))
      expect(await readTaskList(session)).toStrictEqual(ADVANCED)

      t.kit.queue(answer('ok'))
      expect(await session.submitUser('next question')).toEqual({})
      expect(await readTaskList(session)).toBeUndefined()
    },
    TIMEOUT
  )

  it(
    'TLR-S-3 after a rollback it reads the new current conversation and returns the list of the request current there',
    async () => {
      const { t, session } = await planHost()
      t.kit.queue(callTool(PLAN, items(ITEMS), 'p1'), answer('A1'))
      expect(await session.submitUser('U1')).toEqual({})
      t.kit.queue(callTool(PLAN, items(OTHER), 'p2'), answer('A2'))
      expect(await session.submitUser('U2')).toEqual({})
      expect(await readTaskList(session)).toStrictEqual(OTHER.map((item) => ({ ...item })))

      const u2 = (await allEntries(await session.currentConversation())).filter(
        (entry) => entry.kind === 'pi.user'
      )[1]!
      const fork = forkedId(await session.rollbackTo(u2.id as number))
      expect((await session.currentConversation()).id).toBe(fork)
      expect(await readTaskList(session)).toStrictEqual(ITEMS.map((item) => ({ ...item })))
    },
    TIMEOUT
  )

  describe('TLR-S-4 errors', () => {
    it('a closed session → SessionClosedError carrying that session id', async () => {
      const { t, session } = await planHost()
      await t.host.close(session.sessionId)
      const error = await readTaskList(session).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(SessionClosedError)
      expect((error as SessionClosedError).sessionId).toBe(session.sessionId)
    })

    it('any other failure of currentConversation is rethrown as is', async () => {
      const boom = new Error('storage exploded')
      const failing: TaskListReaderSession = {
        sessionId: 'x',
        currentConversation: async () => {
          throw boom
        }
      }
      await expect(readTaskList(failing)).rejects.toBe(boom)
    })
  })

  it(
    'TLR-S-5 read-only: on an interrupted session it does not resume it, start the scheduler or create an agent, and publishes nothing',
    async () => {
      const ref: { session?: DurableSession } = {}
      const seen: Seen[] = []
      const first = await makeHost({ tools: [planTool(() => ref.session!, seen)] })
      const crashed = (ref.session = await first.open())
      await primeRoot(crashed)
      const stall = stalled()
      first.kit.queue(callTool(PLAN, items(ITEMS), 'p1'), stall.step)
      void crashed.submitUser('hello')
      await stall.reached
      const t = await first.restart()
      const session = (ref.session = await t.open())
      expect(session.isInterrupted()).toBe(true)
      expect((await session.harness.inspect(BG)).scheduling).toBe('paused')
      const configCalls = t.configCalls.length
      const lock = session.lock

      const recorder = recordPublications(session.harness)
      expect(await readTaskList(session)).toStrictEqual(ITEMS.map((item) => ({ ...item })))
      await sleep(100)
      recorder.stop()
      expect(recorder.publications).toEqual([])
      expect(session.isInterrupted()).toBe(true)
      expect(session.runState).toBe('interrupted')
      expect((await session.harness.inspect(BG)).scheduling).toBe('paused')
      expect(t.kit.callCount).toBe(0)
      expect(t.configCalls.length).toBe(configCalls)
      expect(session.lock).toBe(lock)
    },
    TIMEOUT
  )
})
