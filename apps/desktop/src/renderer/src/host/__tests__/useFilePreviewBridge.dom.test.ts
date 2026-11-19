// @vitest-environment jsdom
/**
 * useFilePreviewBridge —— chatStore 的 `filePreviewRequest` 信号 → `window.api.files.open`；主进程没开窗时把原因交给
 * fileOpenNotice 的轻提示。
 *
 *   B-1 调用带 {sessionId: 活跃会话, path: absPath, openedBy}；`{opened:true}` → 没有提示
 *   B-2 拒绝（too-large）→ 提示：文件名取自 absPath，原因字段原样
 *   B-3 hook 自己的 sessionId 参数压过活跃会话；两者都没有 → 不调 open
 *   B-4 open 被拒（IPC 失败）→ 没有提示、没有未处理的拒绝
 *
 * store 与 hook 是真的，只有 `window.api.files.open` 是假的。桌面 vitest 对渲染层只收 `*.test.ts`（本文件自己切 jsdom），
 * 不带 react 插件 —— 一律 createElement。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useChatStore } from '@shuvix/chat-ui'
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
const request = (absPath: string, openedBy: 'agent' | 'user' = 'user'): void => {
  act(() => useChatStore.setState({ filePreviewRequest: { absPath, nonce: ++nonce, openedBy } }))
}

beforeEach(() => {
  unhandled = []
  process.on('unhandledRejection', onUnhandled)
  openFile = vi.fn(async () => ({ opened: true }) as FileOpenResult)
  ;(window as unknown as { api: unknown }).api = { files: { open: openFile } }
  useChatStore.setState({ filePreviewRequest: null, activeSessionId: 'sid-active' })
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
    request('/work/a.png')
    await flush()
    expect(openFile).toHaveBeenCalledTimes(1)
    expect(openFile.mock.calls[0][0].sessionId).toBe('sid-borrowed')
  })

  it('B-3 既没有参数也没有活跃会话 → 不调 open', async () => {
    act(() => useChatStore.setState({ activeSessionId: null }))
    mount()
    request('/work/a.png')
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
})
