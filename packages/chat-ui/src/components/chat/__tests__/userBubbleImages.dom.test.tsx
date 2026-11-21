// @vitest-environment jsdom
/**
 * 用户气泡里的附图（UserBubble；jsdom）：点一张 → 看图层打开这条消息的全部附图（一组），从点中的那张开始。
 *
 *   UB-1 两张附图（一张带 `preview` data URL，一张只有裸 base64 `data` + image/jpeg）；点 `[data-user-image=1]` →
 *        一组 2 张、index 1；src = imageSrc(各自)；名字「Image 1」「Image 2」；没有 path / openPath
 *
 * 包入口 `@shuvix/chat-ui` 顶掉（getHostApi → null）；i18n 走真 en 资源。文件是 .tsx 但不写 JSX，一律 createElement。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import { imageSrc } from '@shuvix/chat-protocol/utils/imageSrc'
import type { ImageMeta, UserTextMessage } from '@shuvix/chat-protocol/types/chatMessage'

vi.mock('@shuvix/chat-ui', () => ({ getHostApi: () => null }))

import { useChatStore } from '../../../stores/chatStore'
import { useImageViewerStore } from '../../../stores/imageViewerStore'
import { UserBubble } from '../UserBubble'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
    showSupportNotice: false
  })
})

beforeEach(() => {
  useChatStore.setState({ activeSessionId: null })
  useImageViewerStore.setState({ images: [], index: 0, nonce: 0 })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  useImageViewerStore.setState({ images: [], index: 0, nonce: 0 })
})

const withPreview: ImageMeta = {
  preview: 'data:image/png;base64,UFJFVklFVw==',
  data: 'UFJFVklFVw==',
  mimeType: 'image/png'
}
const bare: ImageMeta = { data: 'QkFSRQ==', mimeType: 'image/jpeg' }

function message(images: ImageMeta[]): UserTextMessage {
  return {
    id: 'u1',
    sessionId: 's1',
    content: 'look',
    model: '',
    createdAt: 1,
    role: 'user',
    type: 'text',
    metadata: { images }
  } as UserTextMessage
}

describe('UB-1 附图进看图层', () => {
  it('点第二张 → 一组两张、从第二张开始；src / 名字；没有路径', () => {
    act(() => {
      root.render(createElement(UserBubble, { msg: message([withPreview, bare]) }))
    })
    const second = container.querySelector<HTMLElement>('[data-user-image="1"]')!
    act(() => second.click())

    const state = useImageViewerStore.getState()
    expect(state.index).toBe(1)
    expect(state.nonce).toBe(1)
    expect(state.images).toHaveLength(2)
    expect(state.images.map((i) => i.src)).toEqual([imageSrc(withPreview), imageSrc(bare)])
    expect(state.images[1]!.src).toBe('data:image/jpeg;base64,QkFSRQ==')
    expect(state.images.map((i) => i.name)).toEqual(['Image 1', 'Image 2'])
    for (const img of state.images) {
      expect(img.path).toBeUndefined()
      expect(img.openPath).toBeUndefined()
    }
    expect(useChatStore.getState().filePreviewRequest ?? null).toBeNull()
  })
})
