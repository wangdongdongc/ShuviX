// @vitest-environment jsdom
/**
 * 会话 fork 的界面一侧（`hooks/useSessionFork.ts`，jsdom）：`useSessionFork` 调宿主的 `session.fork`，
 * 成功就刷新会话列表、交给 `open`（缺省 `setActiveSessionId`）；被拒把原因留在 `forkError`。
 * `selectSessionForkable` 决定界面给不给入口。
 *
 *   H-1 成功：fork 的参数恰是 `{sessionId}`（不带 messageId 键）或 `{sessionId, messageId}`；列表结果先进
 *       store（setSessions），再 `open(newId)`；没有错误
 *   H-2 没给 open → `setActiveSessionId(newId)`
 *   H-3 被拒 → forkError = 原因；不刷列表、不 open；clearForkError 清回 null
 *   H-4 fork 抛错 → 'failed'
 *   H-5 在途时再调一次 → fork 只被调一次；落定之后再调照常发出
 *   H-6 宿主没有 session.fork → available false、forkSession 什么都不做
 *   H-7 fork 成功、刷新列表失败 → 不报错，照样打开 fork
 *   H-8 `selectSessionForkable` 真值表（id 为 null、不在 store、形态不给（含旧格式存储 / 缺省存储类型）、
 *       没有视图、capabilities.rollback false、在跑 / 被中断 → false；条件都满足 → true）
 *   H-9 `forkRefusalKey`：五种拒绝原因各对一个 en 资源里真有的 key，且两两不同
 *
 * 宿主经 `setChatApi` 注入一份只有 `session.fork` / `session.list` 的假 HostApi（每条用例一份新的）。
 * 数据走真的 chatStore。文件是 .tsx 但不写 JSX，一律 createElement。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import type { ChatApi } from '@shuvix/chat-protocol/chatApi'
import type {
  SessionForkParams,
  SessionForkRefusal,
  SessionForkResult
} from '@shuvix/chat-protocol/sessionFork'
import { DURABLE_SQLITE_1, HARNESS_V3_JSONL } from '@shuvix/chat-protocol/sessionStorageKind'
import { setChatApi } from '../../api/chatApi'
import { applySessionView, useChatStore, type Session } from '../../stores/chatStore'
import {
  forkRefusalKey,
  selectSessionForkable,
  useSessionFork,
  type UseSessionForkReturn
} from '../useSessionFork'
import { V, resetStore, store } from '../../__tests__/support/views'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const SID = 's1'
const NEW_ID = 'fork-1'
const PROJECT = 'p1'

let container: HTMLDivElement
let root: Root
/** 钩子最近一次渲染交回的值 */
let hook: UseSessionForkReturn

interface FakeHost {
  fork?: ReturnType<typeof vi.fn<(params: SessionForkParams) => Promise<SessionForkResult>>>
  list: ReturnType<typeof vi.fn<() => Promise<Session[]>>>
}
let host: FakeHost

/** 一条会话（缺省：项目会话、新格式存储 —— 形态给 fork） */
function session(id: string, over: Partial<Session> & { storageKind?: string } = {}): Session {
  return {
    id,
    title: id,
    projectId: PROJECT,
    parentId: null,
    settings: {},
    createdAt: 0,
    updatedAt: 0,
    lastActiveAt: 0,
    storageKind: DURABLE_SQLITE_1,
    ...over
  } as Session
}

function inject(h: FakeHost): void {
  host = h
  setChatApi({ session: h } as unknown as ChatApi)
}

function Probe({ open }: { open?: (id: string) => void }): null {
  const value = useSessionFork(open)
  useEffect(() => {
    hook = value
  })
  return null
}

function render(open?: (id: string) => void): void {
  act(() => root.render(createElement(Probe, { open })))
}

async function fork(sessionId: string, messageId?: string): Promise<void> {
  await act(async () => {
    await hook.forkSession(sessionId, messageId)
  })
}

/** 手动落定的 Promise */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

beforeEach(() => {
  resetStore(SID)
  inject({
    fork: vi.fn(async () => ({ success: true as const, sessionId: NEW_ID })),
    list: vi.fn(async () => [session(SID), session(NEW_ID)])
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('useSessionFork', () => {
  it('H-1 成功：参数恰是 {sessionId} / {sessionId, messageId}；列表先进 store，再 open(newId)；没有错误', async () => {
    const seenAtOpen: string[][] = []
    const open = vi.fn((id: string) => {
      // open 那一刻 store 里已经是刷新后的列表（新会话已在里面）
      seenAtOpen.push(store().sessions.map((s) => s.id))
      void id
    })
    render(open)
    expect(hook.available).toBe(true)

    await fork(SID)
    expect(host.fork!).toHaveBeenCalledTimes(1)
    const whole = host.fork!.mock.calls[0][0]
    expect(whole).toEqual({ sessionId: SID })
    // 整段 fork 不带 messageId 键（不是 messageId: undefined）
    expect(Object.keys(whole)).toEqual(['sessionId'])
    expect(host.list).toHaveBeenCalledTimes(1)
    expect(open.mock.calls).toEqual([[NEW_ID]])
    expect(seenAtOpen).toEqual([[SID, NEW_ID]])
    expect(hook.forkError).toBeNull()

    await fork(SID, 'a7')
    expect(host.fork!.mock.calls[1][0]).toEqual({ sessionId: SID, messageId: 'a7' })
    expect(open.mock.calls).toEqual([[NEW_ID], [NEW_ID]])
    expect(hook.forkError).toBeNull()
    // open 给了就不碰 store 的激活会话
    expect(store().activeSessionId).toBe(SID)
  })

  it('H-2 没给 open → setActiveSessionId(newId)', async () => {
    render()
    await fork(SID)
    expect(store().activeSessionId).toBe(NEW_ID)
    expect(store().sessions.map((s) => s.id)).toEqual([SID, NEW_ID])
    expect(hook.forkError).toBeNull()
  })

  it('H-3 被拒 → forkError = 原因；不刷列表、不 open；clearForkError 清回 null', async () => {
    host.fork!.mockResolvedValue({ success: false, reason: 'busy' })
    const open = vi.fn()
    render(open)
    await fork(SID, 'a1')
    expect(hook.forkError).toBe('busy')
    expect(host.list).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
    expect(store().activeSessionId).toBe(SID)

    act(() => hook.clearForkError())
    expect(hook.forkError).toBeNull()

    // 另一种原因照原样落下
    host.fork!.mockResolvedValue({ success: false, reason: 'invalid_target' })
    await fork(SID, 'a1')
    expect(hook.forkError).toBe('invalid_target')
  })

  it('H-4 fork 抛错 → forkError = failed；不刷列表、不 open', async () => {
    host.fork!.mockRejectedValue(new Error('ipc down'))
    const open = vi.fn()
    render(open)
    await fork(SID)
    expect(hook.forkError).toBe('failed')
    expect(host.list).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
  })

  it('H-5 在途时再调一次 → fork 只被调一次；落定之后再调照常发出', async () => {
    const pending = deferred<SessionForkResult>()
    host.fork!.mockReturnValueOnce(pending.promise)
    const open = vi.fn()
    render(open)

    let first!: Promise<void>
    await act(async () => {
      first = hook.forkSession(SID)
      await Promise.resolve()
    })
    await fork(SID, 'a2')
    expect(host.fork!).toHaveBeenCalledTimes(1)
    expect(open).not.toHaveBeenCalled()

    await act(async () => {
      pending.resolve({ success: true, sessionId: NEW_ID })
      await first
    })
    expect(open.mock.calls).toEqual([[NEW_ID]])

    await fork(SID, 'a2')
    expect(host.fork!).toHaveBeenCalledTimes(2)
    expect(host.fork!.mock.calls[1][0]).toEqual({ sessionId: SID, messageId: 'a2' })
    expect(open).toHaveBeenCalledTimes(2)
  })

  it('H-5 被拒 / 抛错之后在途标记同样放开', async () => {
    host.fork!.mockRejectedValueOnce(new Error('x'))
    render()
    await fork(SID)
    expect(hook.forkError).toBe('failed')
    await fork(SID)
    expect(host.fork!).toHaveBeenCalledTimes(2)
    expect(store().activeSessionId).toBe(NEW_ID)
  })

  it('H-6 宿主没有 session.fork → available false，forkSession 什么都不做', async () => {
    inject({ list: vi.fn(async () => [session(SID)]) })
    const open = vi.fn()
    render(open)
    expect(hook.available).toBe(false)
    await fork(SID, 'a1')
    expect(host.list).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
    expect(hook.forkError).toBeNull()
    expect(store().activeSessionId).toBe(SID)
  })

  it('H-7 fork 成功、刷新列表失败 → 不报错，照样打开 fork', async () => {
    host.list.mockRejectedValue(new Error('list failed'))
    const open = vi.fn()
    render(open)
    await fork(SID, 'a1')
    expect(hook.forkError).toBeNull()
    expect(open.mock.calls).toEqual([[NEW_ID]])

    // 没给 open 时同样切过去
    act(() => root.render(createElement(Probe, {})))
    await fork(SID)
    expect(hook.forkError).toBeNull()
    expect(store().activeSessionId).toBe(NEW_ID)
  })
})

describe('selectSessionForkable（H-8）', () => {
  /** 把会话放进 store、给它一份视图（缺省：durable、能回退、空闲） */
  function setup(
    s: Session | null,
    view: Parameters<typeof V>[1] | null = {}
  ): ReturnType<typeof useChatStore.getState> {
    resetStore(SID)
    if (s) useChatStore.setState({ sessions: [s] })
    if (view) act(() => applySessionView(s?.id ?? SID, V(s?.id ?? SID, view)))
    return store()
  }

  it('H-8 条件都满足 → true', () => {
    expect(selectSessionForkable(setup(session(SID)), SID)).toBe(true)
    // 子会话（挂在父会话下）也一样
    expect(selectSessionForkable(setup(session(SID, { parentId: 'parent' })), SID)).toBe(true)
  })

  it('H-8 id 为 null / 不在 store → false', () => {
    const state = setup(session(SID))
    expect(selectSessionForkable(state, null)).toBe(false)
    expect(selectSessionForkable(state, 'other')).toBe(false)
    // 有视图、但会话不在列表里
    expect(selectSessionForkable(setup(null), SID)).toBe(false)
  })

  it.each<[string, Partial<Session> & { storageKind?: string }]>([
    ['临时会话（不属于项目）', { projectId: null }],
    ['隐藏项目（知识库载体）', { projectId: '__knowledge__' }],
    ['隐藏项目（bot 注册表载体）', { projectId: '__bots__' }],
    ['笔记本会话', { settings: { notebookPath: 'notes/a.md' } }],
    [
      'Chrome 标签页会话',
      {
        settings: {
          chromeTab: { installId: 'i', runId: 'r', tabId: 3 }
        } as unknown as Session['settings']
      }
    ],
    ['旧格式存储', { storageKind: HARNESS_V3_JSONL }],
    ['缺省存储类型（按旧格式理解）', { storageKind: undefined }],
    ['不认识的存储类型', { storageKind: 'future-kind-9' }]
  ])('H-8 形态不给：%s → false', (_label, over) => {
    expect(selectSessionForkable(setup(session(SID, over)), SID)).toBe(false)
  })

  it('H-8 还没有视图 → false', () => {
    expect(selectSessionForkable(setup(session(SID), null), SID)).toBe(false)
  })

  it('H-8 视图说不能回退 → false', () => {
    const view = { capabilities: { send: true, rollback: false, continue: true } }
    expect(selectSessionForkable(setup(session(SID), view), SID)).toBe(false)
  })

  it.each<['busy' | 'interrupted']>([['busy'], ['interrupted']])(
    'H-8 运行状态 %s → false',
    (state) => {
      expect(selectSessionForkable(setup(session(SID), { run: { state } }), SID)).toBe(false)
    }
  )

  it('H-8 别的会话的视图不算数', () => {
    resetStore(SID)
    useChatStore.setState({ sessions: [session(SID), session('s2')] })
    act(() => applySessionView('s2', V('s2')))
    expect(selectSessionForkable(store(), SID)).toBe(false)
    expect(selectSessionForkable(store(), 's2')).toBe(true)
  })
})

describe('forkRefusalKey（H-9）', () => {
  it('H-9 五种原因各对一个 en 资源里真有的 chat.* key，两两不同', () => {
    const reasons: SessionForkRefusal[] = [
      'no_session',
      'not_forkable',
      'busy',
      'invalid_target',
      'failed'
    ]
    const keys = reasons.map(forkRefusalKey)
    expect(new Set(keys).size).toBe(reasons.length)
    const chat = en.chat as Record<string, string>
    for (const key of keys) {
      expect(key.startsWith('chat.'), key).toBe(true)
      const text = chat[key.slice('chat.'.length)]
      expect(typeof text, key).toBe('string')
      expect(text.length, key).toBeGreaterThan(0)
    }
    expect(typeof chat.forkFailedTitle).toBe('string')
  })
})
