// @vitest-environment jsdom
/**
 * useMdMetaView（jsdom）—— 一份注册表笔记的 md 扩展元数据视图，补缺字段行与「ShuviX 设置」条共用。
 *
 *   MV-1 宿主没有 ChatApi.mdMeta → view 一直是 undefined，从不查；
 *   MV-2 get 回 null / 失败 → null；
 *   MV-3 按会话缓存：重挂的新实例第一帧就拿缓存画（不等自己的 get），stale 为 false；
 *   MV-4 换会话 → 新的 get 回来之前是 undefined，从不拿上一个会话的视图；
 *   MV-5 写入队列一变 → 自动重查；回来之前 stale，回来的是不早于新版本的结果才不 stale；
 *   MV-6 refresh() → 再查一次，拿到新的视图对象；
 *   MV-7 迟到的旧版本结果不覆盖缓存里更新的那份。
 *
 * 用一个探针组件把每次渲染的返回值记下来。队列每条用例 reset；视图缓存是模块级的、清不掉 ——
 * 每条用例用独占的会话 id。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { MdMetaNoteView } from '@shuvix/chat-protocol/mdMeta'

type GetFn = (p: { sessionId: string }) => Promise<MdMetaNoteView | null>

const host = vi.hoisted(() => ({ api: {} as { mdMeta?: unknown } }))

vi.mock('@shuvix/chat-ui', () => ({
  getChatApi: () => host.api
}))

import { useMdMetaView, type MdMetaViewState } from './useMdMetaView'
import { requestMetaWrite, resetMetaWritesForTests } from './metaWriteQueue'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
let get: ReturnType<typeof vi.fn<GetFn>>
let seen: MdMetaViewState[]
let S: string
let seq = 0
const nextSession = (): string => `mv-${++seq}`
let mountKey = 0

const viewOf = (tag: string): MdMetaNoteView => ({
  kind: 'hook',
  objectId: `hook:builtin:${tag}`,
  idStatus: 'ok',
  fillKeys: [],
  fill: {},
  declared: [],
  warnings: [],
  readOnly: true
})

const deferred = <T>(): { promise: Promise<T>; resolve: (v: T) => void } => {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function Probe({ sessionId }: { sessionId: string }): null {
  seen.push(useMdMetaView(sessionId))
  return null
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

/** 渲染（同一实例）；不 flush */
async function render(sessionId = S): Promise<void> {
  await act(async () => {
    root.render(createElement(Probe, { key: mountKey, sessionId }))
  })
}

/** 换一个新实例（卸载重挂）；不 flush —— 要看第一帧 */
async function remount(sessionId = S): Promise<void> {
  mountKey++
  await render(sessionId)
}

const last = (): MdMetaViewState => seen[seen.length - 1]

/** 往这个会话的写入队列里发一次变化（分配不了 id：只发一次通知，不跑任务、不查库） */
const bumpQueue = (sessionId = S): void => {
  requestMetaWrite({
    sessionId,
    bufferId: null,
    key: 'shuvix-thinking',
    value: 'low',
    setObjectId: () => false
  })
}

beforeEach(() => {
  resetMetaWritesForTests()
  S = nextSession()
  seen = []
  get = vi.fn<GetFn>(async () => viewOf('a'))
  host.api = { mdMeta: { get } }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('useMdMetaView', () => {
  it('MV-1 宿主没有 mdMeta → view 一直 undefined，从不查', async () => {
    host.api = {}
    await render()
    await flush()
    expect(get).not.toHaveBeenCalled()
    expect(seen.every((s) => s.view === undefined)).toBe(true)
  })

  it('MV-2 get 回 null / 失败 → null', async () => {
    get.mockResolvedValue(null)
    await render()
    await flush()
    expect(last().view).toBeNull()

    S = nextSession()
    get.mockRejectedValue(new Error('ipc down'))
    await remount()
    await flush()
    expect(last().view).toBeNull()
  })

  it('MV-3 重挂的新实例第一帧就拿缓存画出来（自己的 get 还挂着），stale 为 false', async () => {
    const first = viewOf('cached')
    get.mockResolvedValueOnce(first)
    await render()
    await flush()
    expect(last().view).toBe(first)

    get.mockReturnValue(new Promise(() => {}))
    seen = []
    await remount()
    expect(seen[0].view).toEqual(first)
    expect(seen[0].stale).toBe(false)
    expect(last().view).toEqual(first)
  })

  it('MV-4 换会话 → 新的 get 回来之前是 undefined，从不出现上一个会话的视图', async () => {
    const s1View = viewOf('s1')
    get.mockResolvedValueOnce(s1View)
    await render()
    await flush()
    expect(last().view).toBe(s1View)

    const pending = deferred<MdMetaNoteView | null>()
    get.mockReturnValueOnce(pending.promise)
    const s2 = nextSession()
    seen = []
    await render(s2)
    await flush()
    expect(get).toHaveBeenLastCalledWith({ sessionId: s2 })
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((s) => s.view === undefined)).toBe(true)

    const s2View = viewOf('s2')
    pending.resolve(s2View)
    await flush()
    expect(last().view).toBe(s2View)
    expect(seen.some((s) => s.view === s1View)).toBe(false)
  })

  it('MV-5 队列一变 → 自动重查；回来之前 stale，回来之后不 stale', async () => {
    await render()
    await flush()
    expect(get).toHaveBeenCalledTimes(1)
    expect(last().stale).toBe(false)

    const pending = deferred<MdMetaNoteView | null>()
    get.mockReturnValueOnce(pending.promise)
    await act(async () => {
      bumpQueue()
    })
    await flush()
    expect(get).toHaveBeenCalledTimes(2)
    expect(last().stale).toBe(true)
    expect(last().writes.version).toBeGreaterThan(0)

    const fresh = viewOf('fresh')
    pending.resolve(fresh)
    await flush()
    expect(last().view).toBe(fresh)
    expect(last().stale).toBe(false)
  })

  it('MV-6 refresh() → 再查一次、换成新的视图对象', async () => {
    await render()
    await flush()
    const before = last().view
    expect(get).toHaveBeenCalledTimes(1)
    await act(async () => {
      last().refresh()
    })
    await flush()
    expect(get).toHaveBeenCalledTimes(2)
    expect(last().view).not.toBe(before)
    expect(last().view).toEqual(before)
  })

  it('MV-7 旧版本的回包迟到 → 不覆盖缓存里更新版本的那份（重挂的第一帧画的是新的）', async () => {
    const older = deferred<MdMetaNoteView | null>()
    const newer = deferred<MdMetaNoteView | null>()
    get.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
    await render()
    await flush()
    await act(async () => {
      bumpQueue()
    })
    await flush()
    expect(get).toHaveBeenCalledTimes(2)

    const newView = viewOf('new')
    newer.resolve(newView)
    await flush()
    expect(last().view).toBe(newView)

    older.resolve(viewOf('old'))
    await flush()
    expect(last().view).toBe(newView)

    get.mockReturnValue(new Promise(() => {}))
    seen = []
    await remount()
    expect(seen[0].view).toBe(newView)
  })
})
