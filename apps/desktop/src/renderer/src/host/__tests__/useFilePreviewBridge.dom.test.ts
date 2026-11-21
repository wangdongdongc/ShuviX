// @vitest-environment jsdom
/**
 * useFilePreviewBridge —— chatStore 的 `filePreviewRequest` 信号 → `window.api.files.open`；主进程没开窗时把原因交给
 * fileOpenNotice 的轻提示。
 *
 *   B-1 调用带 {sessionId: 活跃会话, path: absPath, openedBy}；`{opened:true}` → 没有提示
 *   B-2 拒绝（too-large）→ 提示：文件名取自 absPath，原因字段原样
 *   B-3 hook 自己的 sessionId 参数压过活跃会话；两者都没有 → 不调 open
 *   B-4 open 被拒（IPC 失败）→ 没有提示、没有未处理的拒绝
 *   B-5 图片路径（扩展名大小写不敏感）→ 看图层（不调 open、没有提示）；openedBy 'agent' 也一样
 *   B-6 `library:<uuid>` 看请求带的文件名：图片名 → 看图层（path 是引用、名字是文件名）；非图片名 / 没有名字 → open
 *   B-7 没有活跃会话也没有 hook 参数：库里的图 → 看图层 sessionId 'library'；库里的非图 → open({sessionId:'library'})；
 *       普通相对路径 → 什么都不做；`library:` 后面不是 uuid → 什么都不做
 *   B-8 hook 的 sessionId 参数也用于看图层
 *   B-9 chatStore.requestFilePreview(abs, openedBy, name)：带名字时信号里有 name；不给 / 空串 → 没有 name 键；nonce 递增
 *
 * store 与 hook 是真的，只有 `window.api.files.open` 是假的。桌面 vitest 对渲染层只收 `*.test.ts`（本文件自己切 jsdom），
 * 不带 react 插件 —— 一律 createElement。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useChatStore, useImageViewerStore } from '@shuvix/chat-ui'
import type { FileOpenResult } from '@shuvix/chat-protocol/types/filePreview'
import { useFilePreviewBridge } from '../useFilePreviewBridge'
import { currentFileOpenNotice, dismissFileOpenNotice } from '../fileOpenNotice'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

interface OpenParams {
  sessionId: string
  path: string
  openedBy?: 'agent' | 'user'
}

let container: HTMLDivElement
let root: Root | undefined
let openFile: ReturnType<typeof vi.fn<(params: OpenParams) => Promise<FileOpenResult>>>
let unhandled: unknown[]
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason)
}

function Harness({ sessionId }: { sessionId?: string }): null {
  useFilePreviewBridge(sessionId)
  return null
}

const mount = (sessionId?: string): void => {
  root = createRoot(container)
  act(() => root!.render(createElement(Harness, { sessionId })))
}
const flush = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve()
  })
}
let nonce = 0
const request = (absPath: string, openedBy: 'agent' | 'user' = 'user', name?: string): void => {
  act(() =>
    useChatStore.setState({
      filePreviewRequest: { absPath, nonce: ++nonce, openedBy, ...(name ? { name } : {}) }
    })
  )
}
const viewer = (): ReturnType<typeof useImageViewerStore.getState> => useImageViewerStore.getState()
const LIB_ID = '0199d3a2-7b3e-7c4d-9a1f-2e5b8c7d6f10'

beforeEach(() => {
  unhandled = []
  process.on('unhandledRejection', onUnhandled)
  openFile = vi.fn(async () => ({ opened: true }) as FileOpenResult)
  ;(window as unknown as { api: unknown }).api = { files: { open: openFile } }
  useChatStore.setState({ filePreviewRequest: null, activeSessionId: 'sid-active' })
  useImageViewerStore.setState({ images: [], index: 0, nonce: 0 })
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  const current = currentFileOpenNotice()
  if (current) dismissFileOpenNotice(current.id)
  act(() => root?.unmount())
  root = undefined
  container.remove()
  useChatStore.setState({ filePreviewRequest: null, activeSessionId: null })
  process.off('unhandledRejection', onUnhandled)
  delete (window as unknown as { api?: unknown }).api
})

describe('useFilePreviewBridge', () => {
  it('B-1 调用带活跃会话、absPath 与 openedBy；opened → 没有提示', async () => {
    mount()
    request('/work/notes/a.txt', 'agent')
    await flush()
    expect(openFile.mock.calls).toEqual([
      [{ sessionId: 'sid-active', path: '/work/notes/a.txt', openedBy: 'agent' }]
    ])
    expect(currentFileOpenNotice()).toBeNull()
  })

  it('B-2 拒绝 → 提示（文件名取自 absPath，原因原样）', async () => {
    openFile.mockResolvedValue({
      opened: false,
      reason: 'too-large',
      size: 3_000_000,
      cap: 2_097_152
    })
    mount()
    request('/work/notes/huge.md')
    await flush()
    expect(currentFileOpenNotice()).toMatchObject({
      name: 'huge.md',
      refusal: { opened: false, reason: 'too-large', size: 3_000_000, cap: 2_097_152 }
    })
  })

  it('B-3 hook 的 sessionId 参数压过活跃会话', async () => {
    mount('sid-borrowed')
    request('/work/a.log')
    await flush()
    expect(openFile).toHaveBeenCalledTimes(1)
    expect(openFile.mock.calls[0][0].sessionId).toBe('sid-borrowed')
  })

  it('B-3 既没有参数也没有活跃会话 → 不调 open', async () => {
    act(() => useChatStore.setState({ activeSessionId: null }))
    mount()
    request('/work/a.log')
    await flush()
    expect(openFile).not.toHaveBeenCalled()
    expect(currentFileOpenNotice()).toBeNull()
  })

  it('B-4 open 被拒 → 没有提示、没有未处理的拒绝', async () => {
    openFile.mockRejectedValue(new Error('disconnected'))
    mount()
    request('/work/a.txt')
    await flush()
    // 让 Node 有机会报未处理的拒绝
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(openFile).toHaveBeenCalledTimes(1)
    expect(currentFileOpenNotice()).toBeNull()
    expect(unhandled).toEqual([])
  })

  it('B-5 图片路径 → 看图层，不调 open、没有提示', async () => {
    mount()
    request('/work/pics/Cat.PNG')
    await flush()
    expect(openFile).not.toHaveBeenCalled()
    expect(viewer().images).toEqual([
      {
        sessionId: 'sid-active',
        path: '/work/pics/Cat.PNG',
        name: 'Cat.PNG',
        openPath: '/work/pics/Cat.PNG'
      }
    ])
    expect(viewer().index).toBe(0)
    expect(currentFileOpenNotice()).toBeNull()
  })

  it('B-5 openedBy agent 也进看图层', async () => {
    mount()
    request('/work/pics/chart.png', 'agent')
    await flush()
    expect(openFile).not.toHaveBeenCalled()
    expect(viewer().images.map((i) => i.path)).toEqual(['/work/pics/chart.png'])
  })

  it('B-6 library 引用 + 图片名 → 看图层；名字是请求带的文件名', async () => {
    mount()
    request(`library:${LIB_ID}`, 'user', 'photo.jpg')
    await flush()
    expect(openFile).not.toHaveBeenCalled()
    expect(viewer().images).toEqual([
      {
        sessionId: 'sid-active',
        path: `library:${LIB_ID}`,
        name: 'photo.jpg',
        openPath: `library:${LIB_ID}`
      }
    ])
  })

  it('B-6 library 引用 + 非图片名 / 没有名字 → open', async () => {
    mount()
    request(`library:${LIB_ID}`, 'user', 'report.pdf')
    await flush()
    request(`library:${LIB_ID}`)
    await flush()
    expect(openFile.mock.calls).toEqual([
      [{ sessionId: 'sid-active', path: `library:${LIB_ID}`, openedBy: 'user' }],
      [{ sessionId: 'sid-active', path: `library:${LIB_ID}`, openedBy: 'user' }]
    ])
    expect(viewer().images).toEqual([])
  })

  it('B-7 没有会话：库里的图 → 看图层 library；库里的非图 → open library', async () => {
    act(() => useChatStore.setState({ activeSessionId: null }))
    mount()
    request(`library:${LIB_ID}`, 'user', 'photo.jpg')
    await flush()
    expect(viewer().images).toEqual([
      {
        sessionId: 'library',
        path: `library:${LIB_ID}`,
        name: 'photo.jpg',
        openPath: `library:${LIB_ID}`
      }
    ])
    expect(openFile).not.toHaveBeenCalled()

    request(`library:${LIB_ID}`, 'user', 'notes.txt')
    await flush()
    expect(openFile.mock.calls).toEqual([
      [{ sessionId: 'library', path: `library:${LIB_ID}`, openedBy: 'user' }]
    ])
  })

  it('B-7 没有会话：普通相对路径（图也好）/ 形状不对的 library 引用 → 什么都不做', async () => {
    act(() => useChatStore.setState({ activeSessionId: null }))
    mount()
    request('pics/cat.png')
    await flush()
    request('library:not-a-uuid', 'user', 'photo.jpg')
    await flush()
    request('notes/a.txt')
    await flush()
    expect(openFile).not.toHaveBeenCalled()
    expect(viewer().images).toEqual([])
    expect(viewer().nonce).toBe(0)
  })

  it('B-8 hook 的 sessionId 参数也用于看图层', async () => {
    mount('sid-borrowed')
    request('/work/pics/cat.png')
    await flush()
    expect(viewer().images.map((i) => i.sessionId)).toEqual(['sid-borrowed'])
    expect(openFile).not.toHaveBeenCalled()
  })

  it('B-9 requestFilePreview 带名字才有 name；nonce 递增', () => {
    const store = useChatStore.getState()
    act(() => store.requestFilePreview('/work/a.bin', 'user', 'x.png'))
    const first = useChatStore.getState().filePreviewRequest!
    expect(first).toMatchObject({ absPath: '/work/a.bin', openedBy: 'user', name: 'x.png' })

    act(() => store.requestFilePreview('/work/b.txt'))
    const second = useChatStore.getState().filePreviewRequest!
    expect(second).toMatchObject({ absPath: '/work/b.txt', openedBy: 'user' })
    expect('name' in second).toBe(false)
    expect(second.nonce).toBe(first.nonce + 1)

    act(() => store.requestFilePreview('/work/c.txt', 'agent', ''))
    const third = useChatStore.getState().filePreviewRequest!
    expect(third.openedBy).toBe('agent')
    expect('name' in third).toBe(false)
    expect(third.nonce).toBe(second.nonce + 1)
  })
})
