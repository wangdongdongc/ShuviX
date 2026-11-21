// @vitest-environment jsdom
/**
 * 工具卡片里「模型收到的那张图」（ToolImageThumb；jsdom）：点它在看图层里看，不再走文件预览信号。
 *
 *   TIT-1 活动会话 's1' + 解析器：点 img → 看图层恰好 [{sessionId:'s1', path, name:文件名, openPath:path}]、index 0；
 *         chatStore.filePreviewRequest 仍是 null
 *   TIT-2 没有活动会话 → 什么都没有；没有解析器 → 什么都没有；img error → imageMissing 那一行
 *
 * 包入口 `@shuvix/chat-ui` 顶掉（getHostApi → null）；i18n 走真 en 资源。文件是 .tsx 但不写 JSX，一律 createElement。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'

vi.mock('@shuvix/chat-ui', () => ({ getHostApi: () => null }))

import { ToolImageThumb } from '../ToolImageThumb'
import { MediaUrlProvider, type ResolveMediaUrl } from '../../../host/mediaUrl'
import { useChatStore } from '../../../stores/chatStore'
import { useImageViewerStore } from '../../../stores/imageViewerStore'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
let resolver: ReturnType<typeof vi.fn<ResolveMediaUrl>>

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
    showSupportNotice: false
  })
})

beforeEach(() => {
  useChatStore.setState({ activeSessionId: 's1', filePreviewRequest: null })
  useImageViewerStore.setState({ images: [], index: 0, nonce: 0 })
  resolver = vi.fn<ResolveMediaUrl>(({ sessionId, path }) => ({
    url: `test://${sessionId}${path}`
  }))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  useChatStore.setState({ activeSessionId: null, filePreviewRequest: null })
  useImageViewerStore.setState({ images: [], index: 0, nonce: 0 })
})

const thumb = (): ReactNode =>
  createElement(ToolImageThumb, { image: { path: '/x/shot.png', width: 40, height: 24 } })

async function mount(media = true): Promise<void> {
  const tree = media ? createElement(MediaUrlProvider, { value: resolver }, thumb()) : thumb()
  await act(async () => {
    root.render(tree)
    await Promise.resolve()
  })
}

describe('TIT-1 点图进看图层', () => {
  it('恰好一张、index 0；不发文件预览信号', async () => {
    await mount()
    const img = container.querySelector('img')!
    expect(img.getAttribute('src')).toBe('test://s1/x/shot.png')
    act(() => img.click())
    const state = useImageViewerStore.getState()
    expect(state.images).toEqual([
      { sessionId: 's1', path: '/x/shot.png', name: 'shot.png', openPath: '/x/shot.png' }
    ])
    expect(state.index).toBe(0)
    expect(useChatStore.getState().filePreviewRequest).toBeNull()
  })
})

describe('TIT-2 没东西可点', () => {
  it('没有活动会话 → 什么都没有', async () => {
    useChatStore.setState({ activeSessionId: null })
    await mount()
    expect(container.querySelector('img')).toBeNull()
    expect(container.innerHTML).toBe('')
  })

  it('没有解析器 → 什么都没有', async () => {
    await mount(false)
    expect(container.querySelector('img')).toBeNull()
    expect(container.innerHTML).toBe('')
  })

  it('img error → imageMissing 那一行，没有 img', async () => {
    await mount()
    await act(async () => {
      container.querySelector('img')!.dispatchEvent(new Event('error'))
    })
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toBe(en.toolCall.imageMissing)
    expect(useImageViewerStore.getState().images).toEqual([])
  })
})
