// @vitest-environment jsdom
/**
 * 会话产物清单的前端缓存（`sessionArtifacts.ts`：`useSessionArtifacts` / `useSessionArtifactCount`）。
 *
 *   SA-1 宿主没有 `artifact.list`（扩展；或只有 read）：rows 一直是 undefined、件数 0，一次都不问
 *   SA-2 同一会话两个 hook（工具栏 + 面板）：同时只有一个请求在途，回来后至多补拉一次，最终是最后那次的结果
 *   SA-3 在途期间来了几次事件：回来后恰好补拉一次（不重复，也不漏掉在途期间刚记下的那一版）
 *   SA-4 事件过滤：本会话 id / 清单里已有的子会话 / chatStore 里 parentId 是它的会话 / 不带 sessionIds → 重拉；
 *        孙会话、无关会话、空数组 → 不拉
 *   SA-5 请求失败：保留上一份；第一次就失败则仍是 undefined
 *   SA-6 切会话：去拉新会话的，旧会话的缓存留着（切回去立刻有，同时再拉一次）
 *
 * 缓存是模块级的（zustand store + 在途表），每条用例 `vi.resetModules()` 后重新 import —— chat-ui 也随之重载，
 * 于是宿主桩（`setChatApi`）要注入到新的那份上。文件是 `.ts`（app-shell 的单测只收 `*.test.ts`），一律 createElement。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type FunctionComponent } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { AppEvent } from '@shuvix/chat-protocol/appEvents'
import type { SessionArtifact } from '@shuvix/chat-protocol/artifacts'
import type { ChatApi } from '@shuvix/chat-protocol/chatApi'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

type ArtifactsModule = typeof import('./sessionArtifacts')
type ChatUiModule = typeof import('@shuvix/chat-ui')

let mod: ArtifactsModule
let chatUi: ChatUiModule
let container: HTMLDivElement
let root: Root

// ── 宿主桩：可控的 artifact.list + 事件流 ─────────────────────────────────

interface PendingCall {
  sessionId: string
  resolve: (rows: SessionArtifact[]) => void
  reject: (err: Error) => void
  settled: boolean
}

let calls: PendingCall[]
let inFlight: number
let maxInFlight: number
let listeners: Set<(e: AppEvent) => void>

const list = vi.fn(
  (p: { sessionId: string }) =>
    new Promise<SessionArtifact[]>((resolve, reject) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      const call: PendingCall = {
        sessionId: p.sessionId,
        settled: false,
        resolve: (rows) => {
          call.settled = true
          inFlight--
          resolve(rows)
        },
        reject: (err) => {
          call.settled = true
          inFlight--
          reject(err)
        }
      }
      calls.push(call)
    })
)

function hostApi(withList = true): ChatApi {
  return {
    events: {
      subscribe: (cb: (e: AppEvent) => void) => {
        listeners.add(cb)
        return () => listeners.delete(cb)
      }
    },
    artifact: withList ? { list, read: async () => null } : { read: async () => null }
  } as unknown as ChatApi
}

const row = (
  sessionId: string,
  name: string,
  extra: Partial<SessionArtifact> = {}
): SessionArtifact => ({
  sessionId,
  name,
  title: name,
  path: `/a/${sessionId}/${name}`,
  versions: 1,
  updatedAt: 1,
  ...extra
})

/** 让已解决的 promise 链（then → setState → finally → 补拉）走完 */
async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve()
  })
}

async function settle(i: number, rows: SessionArtifact[]): Promise<void> {
  calls[i].resolve(rows)
  await flush()
}

async function fail(i: number): Promise<void> {
  calls[i].reject(new Error('offline'))
  await flush()
}

async function emit(event: AppEvent): Promise<void> {
  act(() => {
    for (const cb of [...listeners]) cb(event)
  })
  await flush()
}

// ── 探针组件：把 hook 的返回值记下来 ───────────────────────────────────────

const seen: Record<string, SessionArtifact[] | undefined> = {}
const counts: Record<string, number> = {}

interface ProbeProps {
  id: string
  sessionId: string | null
}

/** 面板那一侧：清单本身（每次渲染读这条用例重新 import 的那份模块） */
function Probe({ id, sessionId }: ProbeProps): null {
  seen[id] = mod.useSessionArtifacts(sessionId)
  return null
}

/** 工具栏那一侧：只要件数 */
function CountProbe({ id, sessionId }: ProbeProps): null {
  counts[id] = mod.useSessionArtifactCount(sessionId)
  return null
}

function render(...probes: Array<[FunctionComponent<ProbeProps>, string, string | null]>): void {
  act(() => {
    root.render(
      createElement(
        'div',
        null,
        ...probes.map(([C, id, sessionId]) => createElement(C, { key: id, id, sessionId }))
      )
    )
  })
}

beforeEach(async () => {
  vi.resetModules()
  chatUi = await import('@shuvix/chat-ui')
  mod = await import('./sessionArtifacts')
  calls = []
  inFlight = 0
  maxInFlight = 0
  listeners = new Set()
  list.mockClear()
  for (const k of Object.keys(seen)) delete seen[k]
  for (const k of Object.keys(counts)) delete counts[k]
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('useSessionArtifacts', () => {
  it('SA-1 宿主没有 artifact.list：undefined、件数 0，一次都不问', async () => {
    for (const api of [{ events: hostApi().events } as unknown as ChatApi, hostApi(false)]) {
      chatUi.setChatApi(api)
      render([Probe, 'p', 's1'], [CountProbe, 'c', 's1'])
      await flush()
      expect(seen.p).toBeUndefined()
      expect(counts.c).toBe(0)
      await emit({ type: 'artifacts.changed', sessionIds: ['s1'] })
      expect(seen.p).toBeUndefined()
      expect(list).not.toHaveBeenCalled()
    }
  })

  it('SA-2 同一会话两个 hook：同时只有一个请求在途，至多补拉一次，最终是最后那次的结果', async () => {
    chatUi.setChatApi(hostApi())
    render([Probe, 'toolbar', 's1'], [Probe, 'panel', 's1'])
    await flush()
    expect(calls).toHaveLength(1)
    expect(seen.toolbar).toBeUndefined()

    await settle(0, [row('s1', 'old.svg')])
    // 在途期间第二个 hook 要过一次 → 回来后补拉恰好一次
    expect(calls).toHaveLength(2)
    expect(maxInFlight).toBe(1)
    await settle(1, [row('s1', 'new.svg')])
    expect(calls).toHaveLength(2)
    expect(seen.toolbar?.map((r) => r.name)).toEqual(['new.svg'])
    expect(seen.panel?.map((r) => r.name)).toEqual(['new.svg'])
    expect(calls.map((c) => c.sessionId)).toEqual(['s1', 's1'])
  })

  it('SA-3 在途期间来了三次事件：回来后恰好补拉一次', async () => {
    chatUi.setChatApi(hostApi())
    render([Probe, 'p', 's1'])
    await flush()
    expect(calls).toHaveLength(1)
    for (let i = 0; i < 3; i++) await emit({ type: 'artifacts.changed', sessionIds: ['s1'] })
    expect(calls).toHaveLength(1)

    await settle(0, [row('s1', 'a.svg')])
    expect(calls).toHaveLength(2)
    await settle(1, [row('s1', 'a.svg', { versions: 2 })])
    expect(calls).toHaveLength(2)
    expect(maxInFlight).toBe(1)
    expect(seen.p?.[0].versions).toBe(2)
  })

  it('SA-4 事件过滤：本会话 / 清单里的子会话 / parentId 是它的会话 / 不带 sessionIds 才重拉', async () => {
    chatUi.setChatApi(hostApi())
    act(() =>
      chatUi.useChatStore.setState({
        sessions: [
          { id: 'child-in-store', parentId: 'p' },
          { id: 'grandchild', parentId: 'child-in-store' },
          { id: 'unrelated', parentId: null }
        ] as unknown as ReturnType<typeof chatUi.useChatStore.getState>['sessions']
      })
    )
    render([Probe, 'p', 'p'])
    await flush()
    await settle(0, [
      row('p', 'own.svg'),
      row('child-in-rows', 'kid.svg', { subSessionTitle: 'Kid' })
    ])

    const refetches = async (event: AppEvent): Promise<boolean> => {
      const before = calls.length
      await emit(event)
      const fired = calls.length > before
      // 交回同一份清单：「清单里已有的子会话」那一行要一直在
      if (fired) await settle(calls.length - 1, seen.p ?? [])
      return fired
    }

    const matrix: Array<[string, AppEvent, boolean]> = [
      ['own id', { type: 'artifacts.changed', sessionIds: ['p'] }, true],
      ['child already in rows', { type: 'artifacts.changed', sessionIds: ['child-in-rows'] }, true],
      [
        'child via chatStore parentId',
        { type: 'artifacts.changed', sessionIds: ['child-in-store'] },
        true
      ],
      ['no sessionIds (reconnect)', { type: 'artifacts.changed' }, true],
      ['one of several ids', { type: 'artifacts.changed', sessionIds: ['unrelated', 'p'] }, true],
      ['grandchild', { type: 'artifacts.changed', sessionIds: ['grandchild'] }, false],
      ['unrelated', { type: 'artifacts.changed', sessionIds: ['unrelated'] }, false],
      ['empty array', { type: 'artifacts.changed', sessionIds: [] }, false],
      ['other event type', { type: 'tracking.changed' }, false]
    ]
    for (const [label, event, expected] of matrix) {
      expect(await refetches(event), label).toBe(expected)
    }
    expect(calls.every((c) => c.sessionId === 'p')).toBe(true)
  })

  it('SA-5 请求失败：第一次就失败仍是 undefined；之后失败保留上一份', async () => {
    chatUi.setChatApi(hostApi())
    render([Probe, 'p', 's1'])
    await flush()
    await fail(0)
    expect(seen.p).toBeUndefined()
    expect(calls).toHaveLength(1)

    await emit({ type: 'artifacts.changed', sessionIds: ['s1'] })
    await settle(1, [row('s1', 'a.svg'), row('s1', 'b.svg')])
    expect(seen.p?.map((r) => r.name)).toEqual(['a.svg', 'b.svg'])

    await emit({ type: 'artifacts.changed', sessionIds: ['s1'] })
    await fail(2)
    expect(seen.p?.map((r) => r.name)).toEqual(['a.svg', 'b.svg'])
    expect(calls).toHaveLength(3)
    expect(calls.every((c) => c.settled)).toBe(true)

    // 件数（工具栏判断按钮出不出现）读的是同一份缓存
    render([CountProbe, 'c', 's1'])
    expect(counts.c).toBe(2)
    await flush()
    await fail(3)
    expect(counts.c).toBe(2)
  })

  it('SA-6 切会话：去拉新会话的；旧会话的缓存留着，切回去立刻有（同时再拉一次）', async () => {
    chatUi.setChatApi(hostApi())
    render([Probe, 'p', 's1'])
    await flush()
    await settle(0, [row('s1', 'one.svg')])
    expect(seen.p?.map((r) => r.name)).toEqual(['one.svg'])

    render([Probe, 'p', 's2'])
    await flush()
    expect(calls.map((c) => c.sessionId)).toEqual(['s1', 's2'])
    // 新会话还没取到：不拿旧会话的冒充
    expect(seen.p).toBeUndefined()
    await settle(1, [row('s2', 'two.svg')])
    expect(seen.p?.map((r) => r.name)).toEqual(['two.svg'])

    render([Probe, 'p', 's1'])
    expect(seen.p?.map((r) => r.name)).toEqual(['one.svg'])
    await flush()
    expect(calls.map((c) => c.sessionId)).toEqual(['s1', 's2', 's1'])
    await settle(2, [row('s1', 'one.svg', { versions: 2 })])
    expect(seen.p?.[0].versions).toBe(2)
  })
})
