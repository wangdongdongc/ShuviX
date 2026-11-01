// @vitest-environment jsdom
/**
 * 摆给用户看的图（`ShownImagesBlock` / `ShownImageView`，`show_image` 工具，docs/show-image-design.md §5；jsdom）。
 * 图的地址经注入的 mediaUrl seam 取（引用 `shown:<快照文件名>`），点图走 requestFilePreview（有原图开原图）。
 *
 *   SIB-1  单张：一个 `[data-shown-images]`、一个 `figure[data-shown-image=<file>]`；src 来自解析器
 *          （`(SID, 'shown:<file>', mimeType)`）；`loading="lazy"`；尺寸已知时 `aspect-ratio: W / H`；alt = 说明，
 *          没有说明取源路径的文件名，源路径为空取「Image」；只有带说明才有 figcaption；悬停提示含「点开看原图」与源路径
 *   SIB-2  多张：按序；compact 密度网格有 `@[36rem]:grid-cols-3`，touch 没有；网格里的格子不带 aspect-ratio
 *   SIB-3  `items: []` → 什么都不画
 *   SIB-4  点图：`filePreviewRequest.absPath === 'shown:' + (original ?? file)`、`openedBy 'user'`；再点 nonce 加一；
 *          不冒泡到父级的 onClick（提议卡片里点图不是采纳）
 *   SIB-5  快照没了：img 触发 error → 按钮换成 `[data-shown-image-missing]`「This image is no longer available」，
 *          说明照样在
 *   SIB-6  没有活动会话：没有 img、没有按钮、不崩
 *   SIB-8  宿主没注入 mediaUrl seam：没有 `figure[data-shown-image]`、没有 img（每个 ShownImageView 交回 null）、不崩
 *   SIB-9  放进 AssistantBubble：`[read✓, read✓, show_image✓]` + 终答 → 两次 read 并成一组、计数 2；图片块在过程区里、
 *          那一组之后、终答正文之前；永不进步骤组
 *   SIB-10 同一张卡里 show_image 还在执行 → 普通工具行（标签「Show image」），没有图片块；出错 → error 行
 *   SIB-11 两项同一个快照文件名（同一份内容摆两次）→ 两个 figure，React 不报重复 key
 *   SIB-12 气泡里没有 mediaUrl seam：show_image 照普通的已完成工具行显示，没有图片块；照样不并进 read 那一组
 *
 * i18n 走真 en 资源；store 用夹具复位；文件是 .tsx 但不写 JSX，一律 createElement。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import { BUILTIN_TOOL_PRESENTATIONS } from '@shuvix/chat-protocol/builtinToolPresentations'
import type { ShownImageItem } from '@shuvix/chat-protocol/shownImages'
import type { AssistantToolBlock, ShownImage } from '@shuvix/chat-protocol/types/chatMessage'

vi.mock('@shuvix/chat-ui', () => ({ getHostApi: () => null }))

import { ShownImagesBlock } from '../ShownImagesBlock'
import { AssistantBubble } from '../AssistantBubble'
import { MediaUrlProvider, type ResolveMediaUrl } from '../../../host/mediaUrl'
import { ChatHostContext, type ChatHostValue } from '../../../host/chatHostContext'
import { useChatStore } from '../../../stores/chatStore'
import { assistant, resetStore, text, toolBlock } from '../../../__tests__/support/views'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const SID = 's1'
const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const HASH_C = 'c'.repeat(64)

function image(file: string, extra: Partial<ShownImage> = {}): ShownImage {
  return {
    file,
    source: '/work/charts/chart.png',
    mimeType: 'image/png',
    width: 40,
    height: 24,
    bytes: 1234,
    ...extra
  }
}

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
  resetStore(SID)
  useChatStore.setState({ filePreviewRequest: null, toolPresentations: {} })
  resolver = vi.fn<ResolveMediaUrl>(({ sessionId, path }) => ({
    url: `test://${sessionId}/${path}`
  }))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

// ─── 挂载 ──────────────────────────────────────────────────

interface MountOptions {
  /** 不给 = 不包 MediaUrlProvider */
  media?: boolean
  density?: ChatHostValue['density']
}

/** 挂上去，并让 useMediaUrl 的 Promise 落定（地址是在 effect 里异步取的） */
async function mount(node: ReactNode, { media = true, density }: MountOptions = {}): Promise<void> {
  let tree = node
  if (media) tree = createElement(MediaUrlProvider, { value: resolver }, tree)
  if (density) {
    tree = createElement(ChatHostContext.Provider, { value: { density } as ChatHostValue }, tree)
  }
  await act(async () => {
    root.render(tree)
    await Promise.resolve()
  })
}

const block = (items: ShownImageItem[]): ReactNode => createElement(ShownImagesBlock, { items })

const figures = (): HTMLElement[] => [
  ...container.querySelectorAll<HTMLElement>('figure[data-shown-image]')
]
const imgs = (): HTMLImageElement[] => [...container.querySelectorAll<HTMLImageElement>('img')]

// ─── SIB-1 / SIB-2 / SIB-3 ─────────────────────────────────

describe('SIB-1 单张', () => {
  it('SIB-1 一个块、一个 figure；src 来自解析器；lazy；按比例占位；alt / figcaption / 悬停提示', async () => {
    await mount(block([{ image: image(HASH_A + '.png'), caption: 'Revenue by month' }]))
    expect(container.querySelectorAll('[data-shown-images]')).toHaveLength(1)
    expect(figures()).toHaveLength(1)
    expect(figures()[0]!.getAttribute('data-shown-image')).toBe(`${HASH_A}.png`)

    expect(resolver).toHaveBeenCalledWith({
      sessionId: SID,
      path: `shown:${HASH_A}.png`,
      mimeType: 'image/png'
    })
    const img = imgs()[0]!
    expect(img.getAttribute('src')).toBe(`test://${SID}/shown:${HASH_A}.png`)
    expect(img.getAttribute('loading')).toBe('lazy')
    expect(img.style.aspectRatio).toBe('40 / 24')
    expect(img.getAttribute('alt')).toBe('Revenue by month')
    expect(container.querySelector('figcaption')!.textContent).toBe('Revenue by month')

    const button = container.querySelector<HTMLButtonElement>('figure button')!
    expect(button.title).toContain(en.shownImage.openHint)
    expect(button.title).toContain('/work/charts/chart.png')
  })

  it('SIB-1 没有说明：alt 取源路径的文件名（Windows 分隔符也认），没有 figcaption', async () => {
    await mount(block([{ image: image(HASH_A + '.png', { source: 'C:\\shots\\before.png' }) }]))
    expect(imgs()[0]!.getAttribute('alt')).toBe('before.png')
    expect(container.querySelector('figcaption')).toBeNull()
  })

  it('SIB-1 源路径为空串：alt 是「Image」', async () => {
    await mount(block([{ image: image(HASH_A + '.png', { source: '' }) }]))
    expect(imgs()[0]!.getAttribute('alt')).toBe(en.shownImage.alt)
  })

  it('SIB-1 尺寸未知（SVG）：不写 aspect-ratio', async () => {
    await mount(
      block([
        {
          image: image(HASH_A + '.svg', {
            mimeType: 'image/svg+xml',
            width: undefined,
            height: undefined
          })
        }
      ])
    )
    expect(imgs()[0]!.style.aspectRatio).toBe('')
    expect(resolver).toHaveBeenCalledWith(expect.objectContaining({ mimeType: 'image/svg+xml' }))
  })
})

describe('SIB-2 多张', () => {
  const three: ShownImageItem[] = [
    { image: image(HASH_A + '.png'), caption: 'first' },
    { image: image(HASH_B + '.jpg', { mimeType: 'image/jpeg' }) },
    { image: image(HASH_C + '.png'), caption: 'third' }
  ]

  it('SIB-2 按序；compact 网格有 @[36rem]:grid-cols-3；格子不带 aspect-ratio', async () => {
    await mount(block(three))
    expect(figures().map((f) => f.getAttribute('data-shown-image'))).toStrictEqual([
      `${HASH_A}.png`,
      `${HASH_B}.jpg`,
      `${HASH_C}.png`
    ])
    const grid = figures()[0]!.parentElement!
    expect(grid.className.split(/\s+/)).toContain('@[36rem]:grid-cols-3')
    expect(grid.className.split(/\s+/)).toContain('grid-cols-2')
    expect(imgs()).toHaveLength(3)
    for (const img of imgs()) expect(img.style.aspectRatio).toBe('')
    // 说明按项对应
    expect([...container.querySelectorAll('figcaption')].map((c) => c.textContent)).toStrictEqual([
      'first',
      'third'
    ])
  })

  it('SIB-2 touch 密度：没有三列', async () => {
    await mount(block(three), { density: 'touch' })
    const grid = figures()[0]!.parentElement!
    expect(grid.className).not.toContain('@[36rem]:grid-cols-3')
    expect(grid.className.split(/\s+/)).toContain('grid-cols-2')
  })
})

describe('SIB-3 空', () => {
  it('SIB-3 items: [] → 什么都不画', async () => {
    await mount(block([]))
    expect(container.innerHTML).toBe('')
  })
})

// ─── SIB-4 / SIB-5 / SIB-6 / SIB-8 ─────────────────────────

describe('SIB-4 点图', () => {
  it('SIB-4 有原图开原图；再点 nonce 加一；父级 onClick 收不到', async () => {
    const parentClick = vi.fn()
    await mount(
      createElement(
        'div',
        { onClick: parentClick },
        block([
          { image: image(HASH_A + '.png', { original: HASH_B + '.png' }) },
          { image: image(HASH_C + '.png') }
        ])
      )
    )
    const buttons = [...container.querySelectorAll<HTMLButtonElement>('figure button')]
    await act(async () => buttons[0]!.click())
    expect(useChatStore.getState().filePreviewRequest).toStrictEqual({
      absPath: `shown:${HASH_B}.png`,
      nonce: 1,
      openedBy: 'user'
    })
    await act(async () => buttons[0]!.click())
    expect(useChatStore.getState().filePreviewRequest?.nonce).toBe(2)

    // 没有原图：开卡片显示的那份
    await act(async () => buttons[1]!.click())
    expect(useChatStore.getState().filePreviewRequest).toStrictEqual({
      absPath: `shown:${HASH_C}.png`,
      nonce: 3,
      openedBy: 'user'
    })
    expect(parentClick).not.toHaveBeenCalled()
  })
})

describe('SIB-5 快照没了', () => {
  it('SIB-5 img error → 换成「不在了」的一行，说明照样在', async () => {
    await mount(block([{ image: image(HASH_A + '.png'), caption: 'Revenue by month' }]))
    await act(async () => {
      imgs()[0]!.dispatchEvent(new Event('error'))
    })
    expect(imgs()).toHaveLength(0)
    expect(container.querySelector('figure button')).toBeNull()
    const missing = container.querySelector('[data-shown-image-missing]')!
    expect(missing.textContent).toBe(en.shownImage.missing)
    expect(container.querySelector('figcaption')!.textContent).toBe('Revenue by month')
    expect(figures()[0]!.getAttribute('data-shown-image')).toBe(`${HASH_A}.png`)
  })
})

describe('SIB-6 没有活动会话', () => {
  it('SIB-6 activeSessionId 为 null → 没有 img、没有按钮、不崩', async () => {
    resetStore(null)
    await mount(block([{ image: image(HASH_A + '.png'), caption: 'c' }]))
    expect(imgs()).toHaveLength(0)
    expect(container.querySelector('button')).toBeNull()
  })
})

describe('SIB-8 宿主没注入 mediaUrl seam', () => {
  it('SIB-8 没有 MediaUrlProvider → 没有 figure、没有 img、不崩', async () => {
    await mount(
      block([{ image: image(HASH_A + '.png'), caption: 'c' }, { image: image(HASH_B + '.png') }]),
      { media: false }
    )
    expect(figures()).toHaveLength(0)
    expect(imgs()).toHaveLength(0)
    expect(resolver).not.toHaveBeenCalled()
  })
})

// ─── SIB-11 ────────────────────────────────────────────────

describe('SIB-11 同一份内容摆两次', () => {
  it('SIB-11 两项同一个 file → 两个 figure，没有重复 key 的报错', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    await mount(block([{ image: image(HASH_A + '.png') }, { image: image(HASH_A + '.png') }]))
    expect(figures()).toHaveLength(2)
    expect(figures().map((f) => f.getAttribute('data-shown-image'))).toStrictEqual([
      `${HASH_A}.png`,
      `${HASH_A}.png`
    ])
    const keyErrors = errors.mock.calls.filter((args) =>
      args.some((a) => typeof a === 'string' && a.includes('same key'))
    )
    expect(keyErrors).toStrictEqual([])
    expect(errors).not.toHaveBeenCalled()
  })
})

// ─── SIB-9 / SIB-10 / SIB-12：在助手卡片里 ─────────────────

describe('在助手卡片里（SIB-9 / SIB-10 / SIB-12）', () => {
  const read = (id: string): AssistantToolBlock =>
    toolBlock(id, 'read', { path: `/w/${id}.txt` }, { result: 'ok' })

  function showImage(extra: Partial<AssistantToolBlock> = {}): AssistantToolBlock {
    return toolBlock(
      'img1',
      'show_image',
      { images: [{ path: 'chart.png', caption: 'Revenue by month' }] },
      {
        result: 'Shown 1 image to the user:\n1. chart.png (40×24)',
        details: { type: 'show_image', images: [image(HASH_A + '.png')] },
        ...extra
      }
    )
  }

  async function renderBubble(show: AssistantToolBlock, media = true): Promise<void> {
    await mount(
      createElement(AssistantBubble, {
        msgs: [
          assistant('a1', [read('r1'), read('r2'), show], SID),
          assistant('a2', [text('Final answer here')], SID)
        ]
      }),
      { media }
    )
  }

  const answer = (): Element =>
    [...container.querySelectorAll('.markdown-body')].find((el) =>
      (el.textContent ?? '').includes('Final answer here')
    )!

  const follows = (a: Node, b: Node): boolean =>
    (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0

  it('SIB-9 两次 read 并成一组（计数 2）；图片块在那一组之后、终答之前，不在任何步骤组里', async () => {
    await renderBubble(showImage())
    const groups = [...container.querySelectorAll('[data-step-group]')]
    expect(groups).toHaveLength(1)
    expect(container.querySelector('[data-group-count]')!.textContent).toBe('2')

    const blocks = [...container.querySelectorAll('[data-shown-images]')]
    expect(blocks).toHaveLength(1)
    const shown = blocks[0]!
    expect(shown.closest('[data-step-group]')).toBeNull()
    expect(shown.querySelector(`figure[data-shown-image="${HASH_A}.png"]`)).not.toBeNull()
    expect(shown.querySelector('figcaption')!.textContent).toBe('Revenue by month')
    // 没有退化成工具行
    expect(container.querySelector('[data-tool-name="show_image"]')).toBeNull()

    expect(follows(groups[0]!, shown)).toBe(true)
    expect(answer()).toBeDefined()
    expect(follows(shown, answer())).toBe(true)
    // 图片块不在终答正文里
    expect(answer().contains(shown)).toBe(false)
  })

  it('SIB-10 还在执行的 show_image → 普通工具行（标签 Show image），没有图片块', async () => {
    useChatStore.setState({
      toolPresentations: {
        show_image: {
          label: en.tool.showImageLabel,
          ...BUILTIN_TOOL_PRESENTATIONS.show_image.presentation
        }
      }
    })
    await renderBubble(showImage({ result: undefined, details: undefined }))
    expect(container.querySelector('[data-shown-images]')).toBeNull()
    const row = container.querySelector<HTMLElement>('[data-tool-name="show_image"]')!
    expect(row).not.toBeNull()
    expect(row.getAttribute('data-tool-status')).toBe('running')
    expect(row.textContent).toContain('Show image')
  })

  it('SIB-10 出错的 show_image → error 行，没有图片块', async () => {
    await renderBubble(
      showImage({ result: 'images[0].path: no such file: /w/chart.png', isError: true })
    )
    expect(container.querySelector('[data-shown-images]')).toBeNull()
    const row = container.querySelector<HTMLElement>('[data-tool-name="show_image"]')!
    expect(row.getAttribute('data-tool-status')).toBe('error')
  })

  it('SIB-12 没有 mediaUrl seam：show_image 照普通的已完成工具行显示，不并进 read 那一组', async () => {
    await renderBubble(showImage(), false)
    expect(container.querySelector('[data-shown-images]')).toBeNull()
    const row = container.querySelector<HTMLElement>('[data-tool-name="show_image"]')!
    expect(row).not.toBeNull()
    expect(row.getAttribute('data-tool-status')).toBe('done')
    expect(row.closest('[data-step-group]')).toBeNull()
    const groups = [...container.querySelectorAll('[data-step-group]')]
    expect(groups).toHaveLength(1)
    expect(container.querySelector('[data-group-count]')!.textContent).toBe('2')
  })
})
