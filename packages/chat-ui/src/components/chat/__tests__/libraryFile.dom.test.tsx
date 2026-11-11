// @vitest-environment jsdom
/**
 * 对话里的文件库链接 —— 图片直接显示，其余文件是一颗 chip（jsdom，测试设计 docs/file-library-l1-tests.md §11.3）。
 * 走生产的 MarkdownText；判定表在 utils/rehypeLibraryLinks.test.ts。
 *
 *   LF-1 图片直接显示：地址来自 mediaUrl seam（按 `library:<id>` 取），DOM 里没有 shuvix:// 地址，不走「点击加载」
 *   LF-2 点图片开预览
 *   LF-3 加载失败显示“文件已删除”；地址变了再试
 *   LF-4 没有 resolver：只有占位，不抛
 *   LF-5 文件 chip：按钮、图标、文字、悬停说明；点了开预览，不冒泡、不跳转，DOM 里没有 href
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'

vi.mock('@shuvix/chat-ui', () => ({ getHostApi: () => null }))

import { MediaUrlProvider, type ResolveMediaUrl } from '../../../host/mediaUrl'
import { useChatStore } from '../../../stores/chatStore'
import { MarkdownText } from '../markdownComponents'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const ID = '0199d3a2-7b3e-7c4d-9a1f-2e5b8c7d6f10'
const REF = `library:${ID}`

let container: HTMLDivElement
let root: Root
let resolver: ReturnType<typeof vi.fn<ResolveMediaUrl>>
let outerClick: ReturnType<typeof vi.fn<() => void>>

const makeResolver = (prefix: string): ReturnType<typeof vi.fn<ResolveMediaUrl>> =>
  vi.fn<ResolveMediaUrl>(({ path }) => ({ url: `${prefix}${path}` }))

function tree(text: string, resolve: ResolveMediaUrl | null): ReactElement {
  const body = createElement(
    'div',
    { 'data-testid': 'outer', onClick: () => outerClick() },
    createElement(MarkdownText, { text })
  )
  return resolve ? createElement(MediaUrlProvider, { value: resolve }, body) : body
}

/** 渲染并等 useMediaUrl 的 Promise 落地 */
async function show(text: string, resolve: ResolveMediaUrl | null = resolver): Promise<void> {
  await act(async () => {
    root.render(tree(text, resolve))
  })
}

function click(el: Element): MouseEvent {
  const ev = new MouseEvent('click', { bubbles: true, cancelable: true })
  act(() => {
    el.dispatchEvent(ev)
  })
  return ev
}

const imgs = (): HTMLImageElement[] => [...container.querySelectorAll('img')]
/** 全 DOM 所有属性的值 */
const allAttrs = (): string[] =>
  [...container.querySelectorAll('*')].flatMap((el) => [...el.attributes].map((a) => a.value))
const hasIcon = (el: Element): boolean => el.firstElementChild?.tagName.toLowerCase() === 'svg'

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    showSupportNotice: false
  })
})

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  resolver = makeResolver('blob:lib-')
  outerClick = vi.fn<() => void>()
  useChatStore.setState({ filePreviewRequest: null })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe('LF-1..4 · 库里的图片', () => {
  it('LF-1 直接显示：src 来自 resolver（按 library:<id>），alt 与 title 是模型写的；没有地址，不走点击加载', async () => {
    await show(`![Chart](shuvix://file/${ID}/c.png)`)
    const all = imgs()
    expect(all).toHaveLength(1)
    const [img] = all
    expect(img.getAttribute('src')).toBe(`blob:lib-${REF}`)
    expect(resolver).toHaveBeenCalled()
    for (const [params] of resolver.mock.calls) {
      expect(params).toMatchObject({ sessionId: 'library', path: REF })
    }
    expect(img.getAttribute('alt')).toBe('Chart')
    expect(img.getAttribute('title')).toBe('Chart')
    expect(img.getAttribute('data-library-image')).toBe(ID)
    expect(allAttrs().filter((v) => v.includes('shuvix://'))).toEqual([])
    expect(container.querySelector('[data-held-image]')).toBeNull()
    expect(allAttrs()).not.toContain(en.message.imageNotShown)
  })

  it('LF-1 空 alt：alt 为空串，没有 title', async () => {
    await show(`![](shuvix://file/${ID}/c.png)`)
    const [img] = imgs()
    expect(img.getAttribute('alt')).toBe('')
    expect(img.hasAttribute('title')).toBe(false)
  })

  it('LF-2 点图片：请求预览 library:<id>，openedBy 是 user', async () => {
    await show(`![Chart](shuvix://file/${ID}/c.png)`)
    click(imgs()[0])
    expect(useChatStore.getState().filePreviewRequest).toMatchObject({
      absPath: REF,
      openedBy: 'user'
    })
  })

  it('LF-3 加载失败：换成“文件已删除”的占位；resolver 给了新地址就重新显示图片', async () => {
    await show(`![Chart](shuvix://file/${ID}/c.png)`)
    const [img] = imgs()
    act(() => {
      img.dispatchEvent(new Event('error'))
    })
    expect(imgs()).toEqual([])
    const missing = container.querySelector<HTMLElement>('span[data-missing]')
    expect(missing).not.toBeNull()
    expect(missing!.textContent).toBe(en.message.libraryFileDeleted)
    expect(missing!.textContent).toBe('File deleted')
    expect(missing!.getAttribute('data-library-image')).toBe(ID)

    // 恢复之后宿主给出新地址（provider 换了 resolver）：再试一次
    const next = makeResolver('blob:lib2-')
    await show(`![Chart](shuvix://file/${ID}/c.png)`, next)
    const again = imgs()
    expect(again).toHaveLength(1)
    expect(again[0].getAttribute('src')).toBe(`blob:lib2-${REF}`)
    expect(container.querySelector('span[data-missing]')).toBeNull()
  })

  it('LF-4 context 里没有 resolver：只有占位 span，没有 img，不抛', async () => {
    await expect(show(`![Chart](shuvix://file/${ID}/c.png)`, null)).resolves.toBeUndefined()
    expect(imgs()).toEqual([])
    const placeholder = container.querySelector<HTMLElement>(`span[data-library-image="${ID}"]`)
    expect(placeholder).not.toBeNull()
    expect(placeholder!.hasAttribute('data-missing')).toBe(false)
    expect(allAttrs().filter((v) => v.includes('shuvix://'))).toEqual([])
  })
})

describe('LF-5 · 文件 chip', () => {
  it('LF-5 一颗按钮：带图标，文字是模型写的，悬停是“Click to open”；DOM 里没有 href', async () => {
    await show(`[Q3 report](shuvix://file/${ID}/r.pdf)`)
    const chips = [...container.querySelectorAll<HTMLElement>('[data-library-link]')]
    expect(chips).toHaveLength(1)
    const [chip] = chips
    expect(chip.tagName).toBe('BUTTON')
    expect(chip.getAttribute('data-library-link')).toBe(ID)
    expect(hasIcon(chip)).toBe(true)
    expect(chip.textContent).toBe('Q3 report')
    expect(chip.getAttribute('title')).toBe(en.message.libraryFileOpenHint)
    expect(chip.getAttribute('title')).toBe('Click to open')
    expect(container.querySelector('a')).toBeNull()
    expect(container.querySelector('[href]')).toBeNull()
    expect(allAttrs().filter((v) => v.includes('shuvix://'))).toEqual([])
  })

  it('LF-5 点击：请求预览 library:<id>；外层收不到，默认行为被阻止', async () => {
    await show(`[Q3 report](shuvix://file/${ID}/r.pdf)`)
    const ev = click(container.querySelector('[data-library-link]')!)
    expect(useChatStore.getState().filePreviewRequest).toMatchObject({
      absPath: REF,
      openedBy: 'user'
    })
    expect(outerClick).not.toHaveBeenCalled()
    expect(ev.defaultPrevented).toBe(true)
  })

  it('LF-5 对照：点图片会冒泡到外层（chip 的 stopPropagation 不是外层本来就收不到）', async () => {
    await show(`![Chart](shuvix://file/${ID}/c.png)`)
    click(imgs()[0])
    expect(outerClick).toHaveBeenCalledTimes(1)
  })
})
