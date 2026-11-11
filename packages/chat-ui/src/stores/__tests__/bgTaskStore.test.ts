/**
 * 后台任务 store 的「会话在跑」口径（侧栏）：
 *
 *   BG-1 countsAsSessionBusy：没结束的 bash / 派发的 agent / 子会话轮次算；结束了都不算；hook 起的 agent（没有
 *        parentToolCallId）永远不算，JSON 走一趟（网络客户端拿到的快照）也一样
 *   BG-2 selectBgRunKinds 按会话：还有一条在跑就留着，最后一条结束才走；只有已结束 / hook agent 的会话不是键
 *   BG-3 引用稳定：别的会话落定一条、已算数的任务改状态、replaceAll 内容没变 → 同一个对象；会话进出才换
 *   BG-4 replaceAll 是替换不是合并：快照里没有的走、有的覆盖；空快照清空；之后的 upsert 照常落下
 *   BG-5 taskRunKind：没结束的 bash（远端的也算）→ resident；派发的 agent、子会话轮次（含别的会话）→ agent；
 *        hook agent、结束了的 → null
 *   BG-6 同一会话里几种任务混着：有 agent 类的就是 agent（不论先后）；bash 加上不算数的 agent 类 → resident
 *   BG-7 键不变、种类变了也换引用；种类不变的新任务不换
 *
 * selectBgRunKinds 带模块级记忆（入参 tasks 的引用 + 上次的结果）：每个用例都经 store 写，拿到的是新 tasks 对象。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { TaskInfo, TaskStatus, TaskSubject } from '@shuvix/chat-protocol/types/task'
import {
  countsAsSessionBusy,
  selectBgRunKinds,
  taskRunKind,
  useBgTaskStore,
  type SessionRunKind
} from '../bgTaskStore'

const BASH: TaskSubject = {
  kind: 'bash',
  command: 'sleep 9',
  cwd: '/tmp',
  pid: 1,
  logPath: '/tmp/x.log',
  exitCode: null,
  signal: null,
  logCapped: false
}
const DISPATCHED: TaskSubject = {
  kind: 'agent',
  profileName: 'explore',
  depth: 1,
  parentToolCallId: 'call_1'
}
const HOOK_AGENT: TaskSubject = { kind: 'agent', profileName: 'titler', depth: 1 }
const SUB_SESSION: TaskSubject = { kind: 'sub-session', childSessionId: 'child' }
const OTHER_SESSION: TaskSubject = { kind: 'sub-session', childSessionId: 'other', other: true }

function task(
  taskId: string,
  sessionId: string,
  subject: TaskSubject = BASH,
  over: Partial<TaskInfo> = {}
): TaskInfo {
  return {
    taskId,
    kind: subject.kind,
    sessionId,
    title: taskId,
    status: 'running',
    detached: true,
    startedAt: 1,
    endedAt: null,
    subject,
    ...over
  }
}
const ended = (t: TaskInfo, status: TaskStatus = 'done'): TaskInfo => ({
  ...t,
  status,
  endedAt: 2
})

const state = (): ReturnType<typeof useBgTaskStore.getState> => useBgTaskStore.getState()
const busy = (): Record<string, SessionRunKind> => selectBgRunKinds(state())

beforeEach(() => {
  useBgTaskStore.setState({ tasks: {} })
})

describe('BG-1 countsAsSessionBusy', () => {
  it.each<[string, TaskSubject, TaskStatus]>([
    ['bash running', BASH, 'running'],
    ['bash waiting-input', BASH, 'waiting-input'],
    ['dispatched agent running', DISPATCHED, 'running'],
    ['dispatched agent waiting-input', DISPATCHED, 'waiting-input'],
    ['sub-session running', SUB_SESSION, 'running'],
    ['sub-session waiting-input', SUB_SESSION, 'waiting-input'],
    ['another session (other: true) running', OTHER_SESSION, 'running'],
    ['another session (other: true) waiting-input', OTHER_SESSION, 'waiting-input']
  ])('BG-1 counts: %s', (_label, subject, status) => {
    expect(countsAsSessionBusy(task('t', 's', subject, { status }))).toBe(true)
  })

  it.each<[string, TaskSubject]>([
    ['bash', BASH],
    ['dispatched agent', DISPATCHED],
    ['hook agent', HOOK_AGENT],
    ['sub-session', SUB_SESSION],
    ['another session', OTHER_SESSION]
  ])('BG-1 a finished %s does not count, whichever way it ended', (_label, subject) => {
    for (const status of ['done', 'error', 'killed'] as const) {
      expect(countsAsSessionBusy(ended(task('t', 's', subject), status)), status).toBe(false)
    }
  })

  it.each<TaskStatus>(['running', 'waiting-input'])(
    'BG-1 a hook agent (no parentToolCallId) %s does not count',
    (status) => {
      expect(countsAsSessionBusy(task('t', 's', HOOK_AGENT, { status }))).toBe(false)
    }
  )

  it('BG-1 the hook agent still does not count after a JSON round trip', () => {
    const wire = JSON.parse(JSON.stringify(task('t', 's', HOOK_AGENT))) as TaskInfo
    expect(wire.endedAt).toBeNull()
    expect(wire.subject).toEqual(HOOK_AGENT)
    expect(countsAsSessionBusy(wire)).toBe(false)
    // 对照：派发的那个走一趟还算
    const dispatched = JSON.parse(JSON.stringify(task('d', 's', DISPATCHED))) as TaskInfo
    expect(countsAsSessionBusy(dispatched)).toBe(true)
  })
})

describe('BG-2 selectBgRunKinds per session', () => {
  it('BG-2 A stays until its last task ends; B (finished only) and C (hook agent only) are never keys', () => {
    const a1 = task('a1', 'A')
    const a2 = task('a2', 'A', SUB_SESSION)
    const { upsert } = state()
    upsert(a1)
    upsert(a2)
    upsert(ended(task('b1', 'B')))
    upsert(task('c1', 'C', HOOK_AGENT))
    expect(busy()).toEqual({ A: 'agent' })

    upsert(ended(a1))
    expect(busy()).toEqual({ A: 'agent' })

    upsert(ended(a2, 'killed'))
    expect(busy()).toEqual({})
  })

  it('BG-2 several sessions are tracked independently', () => {
    const a = task('a', 'A')
    const b = task('b', 'B', DISPATCHED)
    state().upsert(a)
    state().upsert(b)
    expect(busy()).toEqual({ A: 'resident', B: 'agent' })
    state().upsert(ended(a, 'error'))
    expect(busy()).toEqual({ B: 'agent' })
  })
})

describe('BG-3 reference stability', () => {
  it('BG-3 a finished task elsewhere, a status change on a busy task and an equal replaceAll keep the reference', () => {
    const a = task('a', 'A')
    state().upsert(a)
    const flags = busy()
    expect(flags).toEqual({ A: 'resident' })

    const before = state().tasks
    state().upsert(ended(task('other', 'B')))
    expect(state().tasks).not.toBe(before)
    expect(busy()).toBe(flags)

    state().upsert({ ...a, status: 'waiting-input' })
    expect(busy()).toBe(flags)

    const beforeReplace = state().tasks
    state().replaceAll(Object.values(state().tasks))
    expect(state().tasks).not.toBe(beforeReplace)
    expect(busy()).toBe(flags)
  })

  it('BG-3 a second busy task of the same kind in the same session keeps it; a session entering or leaving changes it', () => {
    const a = task('a', 'A')
    state().upsert(a)
    const one = busy()

    state().upsert(task('a2', 'A'))
    expect(busy()).toBe(one)

    const b = task('b', 'B')
    state().upsert(b)
    const two = busy()
    expect(two).not.toBe(one)
    expect(two).toEqual({ A: 'resident', B: 'resident' })

    state().upsert(ended(b))
    const three = busy()
    expect(three).not.toBe(two)
    expect(three).toEqual({ A: 'resident' })
  })

  it('BG-3 swapping one session for another of the same count is a change, not a same-size match', () => {
    const a = task('a', 'A')
    state().upsert(a)
    const onlyA = busy()
    state().replaceAll([task('b', 'B')])
    const onlyB = busy()
    expect(onlyB).not.toBe(onlyA)
    expect(onlyB).toEqual({ B: 'resident' })
  })
})

describe('BG-4 replaceAll', () => {
  it('BG-4 replaces rather than merges; an empty snapshot empties it; a later upsert lands', () => {
    const a = task('a', 'A')
    const b = task('b', 'B')
    state().upsert(a)
    state().upsert(b)
    expect(busy()).toEqual({ A: 'resident', B: 'resident' })

    const finishedA = ended(a)
    state().replaceAll([finishedA])
    expect(state().tasks).toEqual({ a: finishedA })
    expect(state().tasks.b).toBeUndefined()
    expect(busy()).toEqual({})

    state().replaceAll([])
    expect(state().tasks).toEqual({})
    expect(busy()).toEqual({})

    const c = task('c', 'C')
    state().upsert(c)
    expect(state().tasks).toEqual({ c })
    expect(busy()).toEqual({ C: 'resident' })
  })
})

describe('BG-5 taskRunKind', () => {
  const REMOTE_BASH: TaskSubject = { ...BASH, host: 'devbox', pid: -1 }
  it.each<[string, TaskSubject, TaskStatus, SessionRunKind | null]>([
    ['bash running', BASH, 'running', 'resident'],
    ['bash waiting-input', BASH, 'waiting-input', 'resident'],
    ['remote bash (host devbox, pid -1)', REMOTE_BASH, 'running', 'resident'],
    ['dispatched agent running', DISPATCHED, 'running', 'agent'],
    ['dispatched agent waiting-input', DISPATCHED, 'waiting-input', 'agent'],
    ['sub-session running', SUB_SESSION, 'running', 'agent'],
    ['sub-session waiting-input', SUB_SESSION, 'waiting-input', 'agent'],
    ['another session (other: true) running', OTHER_SESSION, 'running', 'agent'],
    ['another session (other: true) waiting-input', OTHER_SESSION, 'waiting-input', 'agent'],
    ['hook agent running', HOOK_AGENT, 'running', null],
    ['hook agent waiting-input', HOOK_AGENT, 'waiting-input', null]
  ])('BG-5 %s → %s', (_label, subject, status, expected) => {
    expect(taskRunKind(task('t', 's', subject, { status }))).toBe(expected)
  })

  it.each<[string, TaskSubject]>([
    ['bash', BASH],
    ['remote bash', REMOTE_BASH],
    ['dispatched agent', DISPATCHED],
    ['hook agent', HOOK_AGENT],
    ['sub-session', SUB_SESSION],
    ['another session', OTHER_SESSION]
  ])('BG-5 a finished %s → null, whichever way it ended', (_label, subject) => {
    for (const status of ['done', 'error', 'killed'] as const) {
      expect(taskRunKind(ended(task('t', 's', subject), status)), status).toBeNull()
    }
  })
})

describe('BG-6 one session, mixed kinds', () => {
  it.each<[string, TaskInfo[], Record<string, SessionRunKind>]>([
    ['bash then dispatched agent', [task('b', 'A'), task('d', 'A', DISPATCHED)], { A: 'agent' }],
    ['dispatched agent then bash', [task('d', 'A', DISPATCHED), task('b', 'A')], { A: 'agent' }],
    ['bash and sub-session', [task('b', 'A'), task('s', 'A', SUB_SESSION)], { A: 'agent' }],
    ['bash and hook agent', [task('b', 'A'), task('h', 'A', HOOK_AGENT)], { A: 'resident' }],
    [
      'bash and an ended dispatched agent',
      [task('b', 'A'), ended(task('d', 'A', DISPATCHED))],
      { A: 'resident' }
    ],
    ['two bashes', [task('b1', 'A'), task('b2', 'A')], { A: 'resident' }]
  ])('BG-6 %s', (_label, tasks, expected) => {
    state().replaceAll(tasks)
    expect(busy()).toEqual(expected)
  })
})

describe('BG-7 a kind change under the same key set changes the reference', () => {
  it('BG-7 resident → agent → resident → gone, with same-kind arrivals keeping the reference', () => {
    const b1 = task('b1', 'A')
    state().upsert(b1)
    const r1 = busy()
    expect(r1).toEqual({ A: 'resident' })

    const d1 = task('d1', 'A', DISPATCHED)
    state().upsert(d1)
    const r2 = busy()
    expect(r2).toEqual({ A: 'agent' })
    expect(r2).not.toBe(r1)

    const b2 = task('b2', 'A')
    state().upsert(b2)
    expect(busy()).toBe(r2)

    const s1 = task('s1', 'A', SUB_SESSION)
    state().upsert(s1)
    expect(busy()).toBe(r2)

    state().upsert(ended(d1))
    state().upsert(ended(s1))
    const r3 = busy()
    expect(r3).toEqual({ A: 'resident' })
    expect(r3).not.toBe(r2)

    state().upsert(ended(b1))
    state().upsert(ended(b2))
    expect(busy()).toEqual({})
  })
})
