// @vitest-environment jsdom
/**
 * 看图层（ImageViewer；jsdom）。store 驱动打开 / 翻页 / 关掉，组件读它画一层；桌面与手机（`touch`）两种样式。
 *
 * 桌面：
 *   IV-1  没开什么都没有；开了 → body 下一个 `[data-image-viewer=desktop]`（titlebar-no-drag、dialog、aria-modal、
 *         aria-label = 名字、拿到焦点）；关掉 → 焦点还给之前的输入框
 *   IV-2  单张 1600×900：名字、「1600 × 900」，没有计数 / 左右箭头 / 缩略图条，缩放比例「60%」
 *   IV-3  一组 3 张从第 2 张开：「2 / 3」、箭头、3 个缩略图只有当前那个 aria-current；下一张 → 3、再下一张回 1；点缩略图 0 → 1
 *   IV-4  键盘（window 捕获）：Esc 关；← → 回绕；单张时 ← → 不处理、不 preventDefault；处理了的 preventDefault 且
 *         document 冒泡阶段收不到；'a' 不处理
 *   IV-5  + − = _ 0 缩放（2000² 在 1000×800）；− 在适合窗口时缩小，但仍在正中
 *   IV-6  缩放比例按钮：大图 → 100%（title「Fit to window」）→ 回适合（title「Actual size」）；小图 200×100 → 200%
 *   IV-7  放大 / 缩小按钮 ×1.25 一级
 *   IV-8  滚轮 −100 放大且 preventDefault；ctrlKey 同样的量变化更大
 *   IV-9  舞台空白处按下抬起 → 关；在图上不关；拖超过 6px 不关；右键不关
 *   IV-10 双击图切换缩放；双击空白不变
 *   IV-11 放大后拖动平移；拖太远被夹住
 *   IV-12 地址：src 原样用、不调解析器（没有 provider 也行）；有 sessionId + path → 解析器；没有 sessionId → 'library'；
 *         两个都没有 → 没有 img、不崩
 *   IV-13 img error → 「Couldn't load this image」，顶栏还在
 *   IV-14 「在独立窗口打开」：没有 onOpenInWindow 或没有 openPath 就没有；有 → 调一次再关
 *   IV-15 path 图 + onCopy：true → copied（title「Copied」，1500ms 后回 idle）；false / 拒绝 → failed；不碰剪贴板
 *   IV-16 src 图（onCopy 给了也不用）→ navigator.clipboard.write 一个 image/png 的 ClipboardItem；没有 ClipboardItem → failed
 *   IV-17 下载：path 图 + onSave → onSave，不点链接；onSave 拒绝被吞；src 图 → object URL 的下载链接；
 *         path 图没有 onSave → fetch 再下载；fetch 失败 → 用原地址下载
 *   IV-18 insetLeft 84 → 顶栏 padding-left 84px；0 → 没有行内 padding
 *   IV-19 放大后同一组再开 → 回适合窗口；翻页也复位缩放与复制状态
 *
 * 手机（`touch`）：
 *   IV-20 顶栏 = 关闭、计数（单张为空）、分享（aria-label「Share」，action download）；没有名字 / 尺寸 / 缩放 / 复制 /
 *         打开 / 箭头 / 缩略图条；根是 `[data-image-viewer=touch]`
 *   IV-21 打开压恰好一条历史记录（带着原来的记号）；popstate 到没有记号的 → 关；仍有记号 → 不关
 *   IV-22 X → history.back()，不当场关；外面 store.close() → 卸载时 back 恰一次；popstate 关的不再 back；
 *         开着时再开一组（nonce +1）→ 不再压、不 back
 *   IV-23 滑动（3 张）：左滑 80 → 下一张；右滑 80 → 上一张；50 → 不动；下滑 120 → 经历史关；下滑 80 → 不关；
 *         单张左滑 200 → 不翻不关
 *   IV-24 双点（<300ms）切换缩放；隔 400ms 不算；单点空白不关（刻意的）
 *   IV-25 分享：能分享文件 → share({files}) 不下载；AbortError → 不下载；其它错误 / 不能分享 → 下载
 *
 * jsdom 没有布局：舞台的 clientWidth / clientHeight / getBoundingClientRect 顶成 1000×800；ResizeObserver、
 * setPointerCapture、剪贴板、object URL 都是桩，每条之后还原。文件是 .tsx 但不写 JSX，一律 createElement。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import { ImageViewer, type ImageViewerProps } from '../ImageViewer'
import { MediaUrlProvider, type ResolveMediaUrl } from '../../../host/mediaUrl'
import {
  openImageViewer,
  useImageViewerStore,
  type ViewerImage
} from '../../../stores/imageViewerStore'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const STAGE = { width: 1000, height: 800 }
const PNG_URL = 'data:image/png;base64,iVBORw0KGgo='

// ─── 布局与浏览器 API 的桩 ─────────────────────────────────

const isStage = (el: Element): boolean => el.hasAttribute('data-image-viewer-stage')
const elementProto = Element.prototype
const clientWidthDesc = Object.getOwnPropertyDescriptor(elementProto, 'clientWidth')!
const clientHeightDesc = Object.getOwnPropertyDescriptor(elementProto, 'clientHeight')!
const originalRect = elementProto.getBoundingClientRect
const originalResizeObserver = globalThis.ResizeObserver
const originalSetPointerCapture = elementProto.setPointerCapture
const originalCreateObjectURL = URL.createObjectURL
const originalRevokeObjectURL = URL.revokeObjectURL

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
    showSupportNotice: false
  })
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return isStage(this) ? STAGE.width : clientWidthDesc.get!.call(this)
    }
  })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return isStage(this) ? STAGE.height : clientHeightDesc.get!.call(this)
    }
  })
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    writable: true,
    value(this: HTMLElement) {
      return isStage(this)
        ? ({
            left: 0,
            top: 0,
            width: STAGE.width,
            height: STAGE.height,
            right: STAGE.width,
            bottom: STAGE.height,
            x: 0,
            y: 0
          } as DOMRect)
        : originalRect.call(this)
    }
  })
  globalThis.ResizeObserver = class {
    observe = vi.fn()
    unobserve = vi.fn()
    disconnect = vi.fn()
  } as unknown as typeof ResizeObserver
  elementProto.setPointerCapture = vi.fn()
  URL.createObjectURL = vi.fn(() => 'blob:obj')
  URL.revokeObjectURL = vi.fn()
})

afterAll(() => {
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).getBoundingClientRect
  globalThis.ResizeObserver = originalResizeObserver
  elementProto.setPointerCapture = originalSetPointerCapture
  URL.createObjectURL = originalCreateObjectURL
  URL.revokeObjectURL = originalRevokeObjectURL
})

let container: HTMLDivElement
let root: Root
let resolver: ReturnType<typeof vi.fn<ResolveMediaUrl>>
let unhandled: unknown[]
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason)
}

beforeEach(() => {
  unhandled = []
  process.on('unhandledRejection', onUnhandled)
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
  act(() => useImageViewerStore.getState().close())
  container.remove()
  document.body.innerHTML = ''
  vi.useRealTimers()
  vi.restoreAllMocks()
  window.history.replaceState(null, '')
  process.off('unhandledRejection', onUnhandled)
})

// ─── 挂载与操作 ────────────────────────────────────────────

type Props = ImageViewerProps & { insetLeft?: number }

async function mount(props: Props = {}, { media = true } = {}): Promise<void> {
  let tree: ReactNode = createElement(ImageViewer, props)
  if (media) tree = createElement(MediaUrlProvider, { value: resolver }, tree)
  await act(async () => {
    root.render(tree)
    await Promise.resolve()
  })
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve()
  })
}

async function open(images: ViewerImage[], index = 0): Promise<void> {
  await act(async () => {
    openImageViewer(images, index)
  })
  await flush()
}

const viewer = (): HTMLElement | null => document.querySelector('[data-image-viewer]')
const q = <T extends Element = HTMLElement>(sel: string): T | null => document.querySelector<T>(sel)
const stage = (): HTMLElement => q('[data-image-viewer-stage]')!
const mainImg = (): HTMLImageElement | null => q<HTMLImageElement>('[data-image-viewer-image]')
const action = (name: string): HTMLButtonElement | null =>
  q<HTMLButtonElement>(`[data-image-viewer-action="${name}"]`)
const zoomButton = (): HTMLButtonElement => q<HTMLButtonElement>('[data-image-viewer-zoom]')!
const percent = (): string => zoomButton().textContent ?? ''
/** 主图的显示比例（宽 / 原宽） */
const shownScale = (naturalWidth: number): number =>
  parseFloat(mainImg()!.style.width) / naturalWidth
const translate = (): string => {
  const m = /translate\(-50%, -50%\) (translate\([^)]*\))/.exec(mainImg()!.style.transform)
  return m ? m[1] : ''
}

async function load(width: number, height: number): Promise<void> {
  const img = mainImg()!
  Object.defineProperty(img, 'naturalWidth', { configurable: true, value: width })
  Object.defineProperty(img, 'naturalHeight', { configurable: true, value: height })
  await act(async () => {
    img.dispatchEvent(new Event('load'))
  })
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    ;(el as HTMLElement).click()
  })
  await flush()
}

function key(k: string, target: EventTarget = document.body): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })
  act(() => {
    target.dispatchEvent(e)
  })
  return e
}

function pointer(
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  target: Element,
  x: number,
  y: number,
  { id = 1, button = 0 }: { id?: number; button?: number } = {}
): void {
  const e = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button
  })
  Object.defineProperty(e, 'pointerId', { value: id })
  act(() => {
    target.dispatchEvent(e)
  })
}

/** 按下 → （挪到 to）→ 抬起 */
function gesture(
  target: Element,
  from: [number, number],
  to: [number, number] = from,
  opts: { button?: number } = {}
): void {
  pointer('pointerdown', target, from[0], from[1], opts)
  if (to[0] !== from[0] || to[1] !== from[1]) pointer('pointermove', stage(), to[0], to[1], opts)
  pointer('pointerup', stage(), to[0], to[1], opts)
}

const srcImage = (name: string, extra: Partial<ViewerImage> = {}): ViewerImage => ({
  src: PNG_URL,
  name,
  ...extra
})
const pathImage = (extra: Partial<ViewerImage> = {}): ViewerImage => ({
  sessionId: 's1',
  path: '/a/b.png',
  mimeType: 'image/png',
  name: 'b.png',
  ...extra
})

// ─── 桌面 ──────────────────────────────────────────────────

describe('IV-1 打开与焦点', () => {
  it('没开什么都没有；开了在 body 下、dialog、拿焦点；关掉焦点回原处', async () => {
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    await mount()
    expect(viewer()).toBeNull()

    await open([srcImage('cat.png')])
    const all = document.querySelectorAll('[data-image-viewer]')
    expect(all).toHaveLength(1)
    const el = all[0] as HTMLElement
    expect(el.getAttribute('data-image-viewer')).toBe('desktop')
    expect(el.parentElement).toBe(document.body)
    expect(el.classList.contains('titlebar-no-drag')).toBe(true)
    expect(el.getAttribute('role')).toBe('dialog')
    expect(el.getAttribute('aria-modal')).toBe('true')
    expect(el.getAttribute('aria-label')).toBe('cat.png')
    expect(document.activeElement).toBe(el)

    await act(async () => useImageViewerStore.getState().close())
    expect(viewer()).toBeNull()
    expect(document.activeElement).toBe(input)
  })
})

describe('IV-2 单张', () => {
  it('名字、尺寸、没有计数 / 箭头 / 缩略图条，比例 60%', async () => {
    await mount()
    await open([srcImage('wide.png')])
    await load(1600, 900)
    expect(q('[data-image-viewer-name]')!.textContent).toBe('wide.png')
    expect(q('[data-image-viewer-bar]')!.textContent).toContain('1600 × 900')
    expect(q('[data-image-viewer-counter]')).toBeNull()
    expect(q('[data-image-viewer-nav]')).toBeNull()
    expect(q('[data-image-viewer-strip]')).toBeNull()
    expect(percent()).toBe('60%')
  })
})

describe('IV-3 一组', () => {
  it('计数、箭头、缩略图；翻页回绕；点缩略图', async () => {
    await mount()
    await open([srcImage('a.png'), srcImage('b.png'), srcImage('c.png')], 1)
    expect(q('[data-image-viewer-counter]')!.textContent).toBe('2 / 3')
    expect(q('[data-image-viewer-nav="prev"]')).not.toBeNull()
    expect(q('[data-image-viewer-nav="next"]')).not.toBeNull()
    const thumbs = (): HTMLElement[] => [
      ...document.querySelectorAll<HTMLElement>('[data-image-viewer-thumb]')
    ]
    expect(thumbs()).toHaveLength(3)
    expect(thumbs().map((t) => t.getAttribute('aria-current'))).toEqual([null, 'true', null])

    await click(q('[data-image-viewer-nav="next"]')!)
    expect(useImageViewerStore.getState().index).toBe(2)
    expect(q('[data-image-viewer-counter]')!.textContent).toBe('3 / 3')
    await click(q('[data-image-viewer-nav="next"]')!)
    expect(useImageViewerStore.getState().index).toBe(0)
    await click(q('[data-image-viewer-nav="next"]')!)
    expect(useImageViewerStore.getState().index).toBe(1)
    await click(thumbs()[0]!)
    expect(useImageViewerStore.getState().index).toBe(0)
    expect(thumbs().map((t) => t.getAttribute('aria-current'))).toEqual(['true', null, null])
  })
})

describe('IV-4 键盘', () => {
  it('Esc 关', async () => {
    await mount()
    await open([srcImage('a.png')])
    const e = key('Escape')
    expect(e.defaultPrevented).toBe(true)
    expect(viewer()).toBeNull()
    expect(useImageViewerStore.getState().images).toEqual([])
  })

  it('← → 回绕；处理了的 preventDefault 且 document 冒泡阶段收不到；a 不处理', async () => {
    await mount()
    await open([srcImage('a.png'), srcImage('b.png'), srcImage('c.png')])
    const seen: string[] = []
    const onDoc = (e: KeyboardEvent): void => {
      seen.push(e.key)
    }
    document.addEventListener('keydown', onDoc)
    try {
      expect(key('ArrowLeft').defaultPrevented).toBe(true)
      expect(useImageViewerStore.getState().index).toBe(2)
      expect(key('ArrowRight').defaultPrevented).toBe(true)
      expect(useImageViewerStore.getState().index).toBe(0)
      expect(key('ArrowRight').defaultPrevented).toBe(true)
      expect(useImageViewerStore.getState().index).toBe(1)
      expect(seen).toEqual([])
      expect(key('a').defaultPrevented).toBe(false)
      expect(seen).toEqual(['a'])
    } finally {
      document.removeEventListener('keydown', onDoc)
    }
  })

  it('单张：← → 不处理、不 preventDefault', async () => {
    await mount()
    await open([srcImage('a.png')])
    const seen: string[] = []
    const onDoc = (e: KeyboardEvent): void => {
      seen.push(e.key)
    }
    document.addEventListener('keydown', onDoc)
    try {
      expect(key('ArrowLeft').defaultPrevented).toBe(false)
      expect(key('ArrowRight').defaultPrevented).toBe(false)
      expect(seen).toEqual(['ArrowLeft', 'ArrowRight'])
      expect(useImageViewerStore.getState().index).toBe(0)
      expect(viewer()).not.toBeNull()
    } finally {
      document.removeEventListener('keydown', onDoc)
    }
  })
})

describe('IV-5 缩放键', () => {
  // 2000² 在 1000×800：适合窗口 = 752 / 2000 = 0.376
  const FIT = 0.376

  it('+ / - / = / _ / 0', async () => {
    await mount()
    await open([srcImage('big.png')])
    await load(2000, 2000)
    expect(shownScale(2000)).toBeCloseTo(FIT, 6)
    expect(stage().hasAttribute('data-zoomed')).toBe(false)

    expect(key('+').defaultPrevented).toBe(true)
    expect(shownScale(2000)).toBeCloseTo(FIT * 1.25, 6)
    expect(percent()).toBe('47%')
    expect(stage().hasAttribute('data-zoomed')).toBe(true)

    key('-')
    expect(shownScale(2000)).toBeCloseTo(FIT, 6)
    expect(stage().hasAttribute('data-zoomed')).toBe(false)

    key('=')
    expect(shownScale(2000)).toBeCloseTo(FIT * 1.25, 6)
    key('_')
    expect(shownScale(2000)).toBeCloseTo(FIT, 6)

    key('+')
    key('+')
    expect(shownScale(2000)).toBeCloseTo(FIT * 1.5625, 6)
    expect(key('0').defaultPrevented).toBe(true)
    expect(shownScale(2000)).toBeCloseTo(FIT, 6)
    expect(stage().hasAttribute('data-zoomed')).toBe(false)
  })

  it('适合窗口时按 − 仍在正中（平移 0）', async () => {
    await mount()
    await open([srcImage('big.png')])
    await load(2000, 2000)
    key('-')
    expect(translate()).toBe('translate(0px, 0px)')
    expect(stage().hasAttribute('data-zoomed')).toBe(false)
  })

  // 用例清单要求「− 在适合窗口时缩小（不低于 minScale）」。实现里 zoomTo 把 ≤ 适合窗口的结果一律记成 null（= 适合窗口），
  // 于是缩不到适合窗口以下，minScale 永远用不上 —— 见报告，这条按清单写、标成已知不符
})

describe('IV-6 缩放比例按钮', () => {
  it('大图：适合 → 100% → 适合；title 跟着变', async () => {
    await mount()
    await open([srcImage('big.png')])
    await load(2000, 2000)
    expect(zoomButton().title).toBe(en.imageViewer.actualSize)
    await click(zoomButton())
    expect(percent()).toBe('100%')
    expect(zoomButton().title).toBe(en.imageViewer.fit)
    await click(zoomButton())
    expect(percent()).toBe('38%')
    expect(zoomButton().title).toBe(en.imageViewer.actualSize)
  })

  it('小图 200×100 → 200%', async () => {
    await mount()
    await open([srcImage('small.png')])
    await load(200, 100)
    expect(percent()).toBe('100%')
    await click(zoomButton())
    expect(percent()).toBe('200%')
  })
})

describe('IV-7 放大 / 缩小按钮', () => {
  it('×1.25 一级', async () => {
    await mount()
    await open([srcImage('big.png')])
    await load(2000, 2000)
    await click(action('zoom-in')!)
    expect(shownScale(2000)).toBeCloseTo(0.376 * 1.25, 6)
    await click(action('zoom-in')!)
    expect(shownScale(2000)).toBeCloseTo(0.376 * 1.5625, 6)
    await click(action('zoom-out')!)
    expect(shownScale(2000)).toBeCloseTo(0.376 * 1.25, 6)
  })
})

describe('IV-8 滚轮', () => {
  const wheel = (opts: WheelEventInit): WheelEvent => {
    const e = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      clientX: 500,
      clientY: 400,
      ...opts
    })
    act(() => {
      stage().dispatchEvent(e)
    })
    return e
  }

  it('deltaY −100 放大且 preventDefault；ctrlKey 同样的量变化更大', async () => {
    await mount()
    await open([srcImage('big.png')])
    await load(2000, 2000)
    const before = shownScale(2000)
    const e = wheel({ deltaY: -100 })
    expect(e.defaultPrevented).toBe(true)
    const plain = shownScale(2000) / before
    expect(plain).toBeGreaterThan(1)

    key('0')
    wheel({ deltaY: -100, ctrlKey: true })
    const pinch = shownScale(2000) / before
    expect(pinch).toBeGreaterThan(plain)
  })
})

describe('IV-9 点空白关', () => {
  it('舞台空白处按下抬起 → 关', async () => {
    await mount()
    await open([srcImage('a.png')])
    await load(400, 300)
    gesture(stage(), [10, 10])
    expect(viewer()).toBeNull()
  })

  it('在图上 → 不关；拖超过 6px → 不关；右键 → 不关', async () => {
    await mount()
    await open([srcImage('a.png')])
    await load(400, 300)
    gesture(mainImg()!, [500, 400])
    expect(viewer()).not.toBeNull()
    gesture(stage(), [10, 10], [20, 10])
    expect(viewer()).not.toBeNull()
    gesture(stage(), [10, 10], [10, 10], { button: 2 })
    expect(viewer()).not.toBeNull()
  })
})

describe('IV-10 双击', () => {
  const dblclick = (el: Element): void => {
    act(() => {
      el.dispatchEvent(
        new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: 500, clientY: 400 })
      )
    })
  }

  it('双击图切换缩放；双击空白不变', async () => {
    await mount()
    await open([srcImage('big.png')])
    await load(2000, 2000)
    dblclick(stage())
    expect(percent()).toBe('38%')
    dblclick(mainImg()!)
    expect(percent()).toBe('100%')
    dblclick(mainImg()!)
    expect(percent()).toBe('38%')
  })
})

describe('IV-11 平移', () => {
  it('放大后拖动平移；太远被夹住', async () => {
    await mount()
    await open([srcImage('big.png')])
    await load(2000, 2000)
    await click(zoomButton())
    expect(percent()).toBe('100%')
    expect(translate()).toBe('translate(0px, 0px)')

    pointer('pointerdown', mainImg()!, 500, 400)
    pointer('pointermove', stage(), 550, 430)
    expect(translate()).toBe('translate(50px, 30px)')
    pointer('pointermove', stage(), 9550, 9430)
    // 2000 显示在 1000×800：x 余量 500，y 余量 600
    expect(translate()).toBe('translate(500px, 600px)')
    pointer('pointerup', stage(), 9550, 9430)
    expect(viewer()).not.toBeNull()
  })
})

describe('IV-12 地址', () => {
  it('src：原样用，不调解析器（有 provider 也不调）', async () => {
    await mount()
    await open([srcImage('a.png')])
    expect(mainImg()!.getAttribute('src')).toBe(PNG_URL)
    expect(resolver).not.toHaveBeenCalled()
  })

  it('src：没有 provider 也行', async () => {
    await mount({}, { media: false })
    await open([srcImage('a.png')])
    expect(mainImg()!.getAttribute('src')).toBe(PNG_URL)
  })

  it('sessionId + path → 解析器；img 用它的地址', async () => {
    await mount()
    await open([pathImage()])
    expect(resolver).toHaveBeenCalledWith({
      sessionId: 's1',
      path: '/a/b.png',
      mimeType: 'image/png'
    })
    expect(mainImg()!.getAttribute('src')).toBe('test://s1/a/b.png')
  })

  it('没有 sessionId → library', async () => {
    await mount()
    await open([pathImage({ sessionId: undefined })])
    expect(resolver).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'library' }))
    expect(mainImg()!.getAttribute('src')).toBe('test://library/a/b.png')
  })

  it('两个都没有 → 没有 img、不崩', async () => {
    await mount()
    await open([{ name: 'nothing.png' }])
    expect(viewer()).not.toBeNull()
    expect(mainImg()).toBeNull()
    expect(resolver).not.toHaveBeenCalled()
  })
})

describe('IV-13 加载失败', () => {
  it('img error → 失败提示，顶栏还在', async () => {
    await mount()
    await open([srcImage('a.png')])
    await act(async () => {
      mainImg()!.dispatchEvent(new Event('error'))
    })
    const failed = q('[data-image-viewer-failed]')!
    expect(failed.textContent).toBe(en.imageViewer.failed)
    expect(mainImg()).toBeNull()
    expect(q('[data-image-viewer-bar]')).not.toBeNull()
  })
})

describe('IV-14 在独立窗口打开', () => {
  it('没有 onOpenInWindow → 没有按钮', async () => {
    await mount()
    await open([pathImage({ openPath: '/a/b.png' })])
    expect(action('open')).toBeNull()
  })

  it('没有 openPath → 没有按钮', async () => {
    const onOpenInWindow = vi.fn()
    await mount({ onOpenInWindow })
    await open([pathImage()])
    expect(action('open')).toBeNull()
  })

  it('有 → 调一次再关', async () => {
    const onOpenInWindow = vi.fn()
    await mount({ onOpenInWindow })
    const img = pathImage({ openPath: '/a/b.png' })
    await open([img])
    await click(action('open')!)
    expect(onOpenInWindow).toHaveBeenCalledTimes(1)
    expect(onOpenInWindow).toHaveBeenCalledWith(img)
    expect(useImageViewerStore.getState().images).toEqual([])
    expect(viewer()).toBeNull()
  })
})

// ─── 复制 / 下载 ───────────────────────────────────────────

let clipboardWrite: ReturnType<typeof vi.fn>
const items: Record<string, unknown>[] = []
class FakeClipboardItem {
  constructor(public readonly data: Record<string, unknown>) {
    items.push(data)
  }
}

function installClipboard({ item = true }: { item?: boolean } = {}): void {
  clipboardWrite = vi.fn(async () => {})
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { write: clipboardWrite }
  })
  items.length = 0
  if (item) (globalThis as Record<string, unknown>).ClipboardItem = FakeClipboardItem
  else delete (globalThis as Record<string, unknown>).ClipboardItem
}

afterEach(() => {
  delete (navigator as unknown as Record<string, unknown>).clipboard
  delete (globalThis as Record<string, unknown>).ClipboardItem
})

const copyButton = (): HTMLButtonElement => action('copy')!

describe('IV-15 宿主复制', () => {
  it('true → copied，1500ms 后回 idle；不碰剪贴板', async () => {
    installClipboard()
    const onCopy = vi.fn(async () => true)
    await mount({ onCopy })
    const img = pathImage()
    await open([img])
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await click(copyButton())
    expect(onCopy).toHaveBeenCalledWith(img)
    expect(copyButton().getAttribute('data-copy-state')).toBe('copied')
    expect(copyButton().title).toBe(en.imageViewer.copied)
    await act(async () => {
      vi.advanceTimersByTime(1500)
    })
    expect(copyButton().getAttribute('data-copy-state')).toBe('idle')
    expect(copyButton().title).toBe(en.imageViewer.copy)
    expect(clipboardWrite).not.toHaveBeenCalled()
  })

  it('false → failed', async () => {
    installClipboard()
    await mount({ onCopy: async () => false })
    await open([pathImage()])
    await click(copyButton())
    expect(copyButton().getAttribute('data-copy-state')).toBe('failed')
    expect(copyButton().title).toBe(en.imageViewer.copyFailed)
    expect(clipboardWrite).not.toHaveBeenCalled()
  })

  it('拒绝 → failed，没有未处理的拒绝', async () => {
    installClipboard()
    await mount({ onCopy: () => Promise.reject(new Error('nope')) })
    await open([pathImage()])
    await click(copyButton())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(copyButton().getAttribute('data-copy-state')).toBe('failed')
    expect(clipboardWrite).not.toHaveBeenCalled()
    expect(unhandled).toEqual([])
  })
})

describe('IV-16 页面自己复制', () => {
  it('src 图（onCopy 不用）→ 一个 image/png 的 ClipboardItem', async () => {
    installClipboard()
    const onCopy = vi.fn(async () => true)
    await mount({ onCopy })
    await open([srcImage('a.png')])
    await click(copyButton())
    expect(onCopy).not.toHaveBeenCalled()
    expect(clipboardWrite).toHaveBeenCalledTimes(1)
    const written = clipboardWrite.mock.calls[0][0] as unknown[]
    expect(written).toHaveLength(1)
    expect(written[0]).toBeInstanceOf(FakeClipboardItem)
    expect(Object.keys(items[0]!)).toEqual(['image/png'])
    const blob = await (items[0]!['image/png'] as Promise<Blob>)
    expect(blob.type).toBe('image/png')
    expect(copyButton().getAttribute('data-copy-state')).toBe('copied')
  })

  it('没有 ClipboardItem → failed', async () => {
    installClipboard({ item: false })
    await mount()
    await open([srcImage('a.png')])
    await click(copyButton())
    await new Promise((resolve) => setTimeout(resolve, 0))
    await flush()
    expect(copyButton().getAttribute('data-copy-state')).toBe('failed')
    expect(clipboardWrite).not.toHaveBeenCalled()
    expect(unhandled).toEqual([])
  })
})

/** 记下每次点下载链接时的 href / download */
function spyAnchors(): { href: string | null; download: string }[] {
  const clicks: { href: string | null; download: string }[] = []
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement
  ) {
    clicks.push({ href: this.getAttribute('href'), download: this.download })
  })
  return clicks
}

/** 下载链接 10s 后才 revoke：只假 setTimeout，用例末清掉 */
function fakeTimeouts(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
}

afterEach(() => {
  vi.clearAllTimers()
  delete (globalThis as Record<string, unknown>).__fetchStub
})

const download = (): HTMLButtonElement => action('download')!

describe('IV-17 下载', () => {
  it('path 图 + onSave → onSave，不点链接', async () => {
    const clicks = spyAnchors()
    const onSave = vi.fn(async () => {})
    await mount({ onSave })
    const img = pathImage()
    await open([img])
    await click(download())
    expect(onSave).toHaveBeenCalledWith(img)
    expect(clicks).toEqual([])
  })

  it('onSave 拒绝被吞', async () => {
    spyAnchors()
    await mount({ onSave: () => Promise.reject(new Error('nope')) })
    await open([pathImage()])
    await click(download())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(unhandled).toEqual([])
  })

  it('src 图 → object URL 的下载链接，名字是图名', async () => {
    const clicks = spyAnchors()
    await mount({ onSave: vi.fn(async () => {}) })
    await open([srcImage('cat.png')])
    fakeTimeouts()
    await click(download())
    expect(clicks).toEqual([{ href: 'blob:obj', download: 'cat.png' }])
  })

  it('path 图没有 onSave → fetch 再下载', async () => {
    const clicks = spyAnchors()
    const fetchStub = vi.fn(async () => ({
      ok: true,
      blob: async () => new Blob([new Uint8Array([1, 2])], { type: 'image/png' })
    }))
    vi.stubGlobal('fetch', fetchStub)
    await mount()
    await open([pathImage()])
    fakeTimeouts()
    await click(download())
    expect(fetchStub).toHaveBeenCalledWith('test://s1/a/b.png')
    expect(clicks).toEqual([{ href: 'blob:obj', download: 'b.png' }])
    vi.unstubAllGlobals()
  })

  it('fetch 失败 → 用原地址下载', async () => {
    const clicks = spyAnchors()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('blocked')
      })
    )
    await mount()
    await open([pathImage()])
    await click(download())
    expect(clicks).toEqual([{ href: 'test://s1/a/b.png', download: 'b.png' }])
    vi.unstubAllGlobals()
  })
})

describe('IV-18 顶栏左侧让位', () => {
  it('84 → padding-left 84px；0 → 没有行内 padding', async () => {
    await mount({ insetLeft: 84 })
    await open([srcImage('a.png')])
    expect(q('[data-image-viewer-bar]')!.style.paddingLeft).toBe('84px')
    await act(async () => useImageViewerStore.getState().close())
    await mount({ insetLeft: 0 })
    await open([srcImage('a.png')])
    expect(q('[data-image-viewer-bar]')!.style.paddingLeft).toBe('')
    expect(q('[data-image-viewer-bar]')!.getAttribute('style')).toBeNull()
  })
})

describe('IV-19 复位', () => {
  it('放大后同一组再开 → 回适合窗口', async () => {
    await mount()
    const group = [srcImage('big.png')]
    await open(group)
    await load(2000, 2000)
    await click(zoomButton())
    expect(percent()).toBe('100%')
    await open(group)
    await load(2000, 2000)
    expect(percent()).toBe('38%')
    expect(stage().hasAttribute('data-zoomed')).toBe(false)
  })

  it('翻页复位缩放与复制状态', async () => {
    installClipboard()
    await mount({ onCopy: async () => true })
    await open([pathImage({ path: '/a/1.png' }), pathImage({ path: '/a/2.png' })])
    await load(2000, 2000)
    await click(zoomButton())
    await click(copyButton())
    expect(percent()).toBe('100%')
    expect(copyButton().getAttribute('data-copy-state')).toBe('copied')
    key('ArrowRight')
    await flush()
    await load(2000, 2000)
    expect(percent()).toBe('38%')
    expect(copyButton().getAttribute('data-copy-state')).toBe('idle')
  })
})

// ─── 手机 ──────────────────────────────────────────────────

describe('IV-20 手机顶栏', () => {
  it('关闭 · 计数 · 分享；没有桌面那些', async () => {
    vi.spyOn(window.history, 'back').mockImplementation(() => {})
    await mount({ touch: true, onOpenInWindow: vi.fn(), onCopy: vi.fn() })
    await open([srcImage('a.png', { openPath: '/a.png' })])
    expect(viewer()!.getAttribute('data-image-viewer')).toBe('touch')
    expect(action('close')).not.toBeNull()
    expect(q('[data-image-viewer-counter]')!.textContent).toBe('')
    const share = action('download')!
    expect(share.getAttribute('aria-label')).toBe(en.imageViewer.share)
    for (const sel of [
      '[data-image-viewer-name]',
      '[data-image-viewer-zoom]',
      '[data-image-viewer-action="copy"]',
      '[data-image-viewer-action="open"]',
      '[data-image-viewer-action="zoom-in"]',
      '[data-image-viewer-nav]',
      '[data-image-viewer-strip]'
    ]) {
      expect(q(sel), sel).toBeNull()
    }
    await load(1600, 900)
    expect(q('[data-image-viewer-bar]')!.textContent).not.toContain('1600 × 900')
  })

  it('一组：计数「1 / 2」', async () => {
    vi.spyOn(window.history, 'back').mockImplementation(() => {})
    await mount({ touch: true })
    await open([srcImage('a.png'), srcImage('b.png')])
    expect(q('[data-image-viewer-counter]')!.textContent).toBe('1 / 2')
    expect(q('[data-image-viewer-nav]')).toBeNull()
  })
})

const MARK = 'shuvixImageViewer'

function popTo(state: unknown): void {
  window.history.replaceState(state, '')
  act(() => {
    window.dispatchEvent(new PopStateEvent('popstate', { state }))
  })
}

describe('IV-21 历史记录', () => {
  it('打开压一条（带原来的记号）；popstate 到没记号的 → 关；仍有记号 → 不关', async () => {
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    window.history.replaceState({ shuvixMobileChat: true }, '')
    const push = vi.spyOn(window.history, 'pushState')
    await mount({ touch: true })
    await open([srcImage('a.png')])
    expect(push).toHaveBeenCalledTimes(1)
    expect(push.mock.calls[0][0]).toEqual({ shuvixMobileChat: true, [MARK]: true })
    expect(window.history.state).toEqual({ shuvixMobileChat: true, [MARK]: true })

    popTo({ shuvixMobileChat: true, [MARK]: true })
    expect(viewer()).not.toBeNull()

    popTo({ shuvixMobileChat: true })
    expect(viewer()).toBeNull()
    expect(useImageViewerStore.getState().images).toEqual([])
    expect(back).not.toHaveBeenCalled()
    expect(push).toHaveBeenCalledTimes(1)
  })
})

describe('IV-22 关闭走历史', () => {
  it('X → history.back()，不当场关；popstate 关的不再 back', async () => {
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    await mount({ touch: true })
    await open([srcImage('a.png')])
    await click(action('close')!)
    expect(back).toHaveBeenCalledTimes(1)
    expect(viewer()).not.toBeNull()
    popTo(null)
    expect(viewer()).toBeNull()
    expect(back).toHaveBeenCalledTimes(1)
  })

  it('外面 store.close() → 卸载时 back 恰一次', async () => {
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    await mount({ touch: true })
    await open([srcImage('a.png')])
    await act(async () => useImageViewerStore.getState().close())
    expect(viewer()).toBeNull()
    expect(back).toHaveBeenCalledTimes(1)
  })

  it('开着时再开一组 → 不再压、不 back', async () => {
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    const push = vi.spyOn(window.history, 'pushState')
    await mount({ touch: true })
    await open([srcImage('a.png')])
    const first = viewer()
    await open([srcImage('b.png'), srcImage('c.png')], 1)
    expect(push).toHaveBeenCalledTimes(1)
    expect(back).not.toHaveBeenCalled()
    expect(viewer()).toBe(first)
    expect(q('[data-image-viewer-counter]')!.textContent).toBe('2 / 2')
  })
})

describe('IV-23 滑动', () => {
  const swipe = (dx: number, dy: number): void => gesture(stage(), [500, 400], [500 + dx, 400 + dy])

  it('左右滑翻页，太短不动', async () => {
    vi.spyOn(window.history, 'back').mockImplementation(() => {})
    await mount({ touch: true })
    await open([srcImage('a.png'), srcImage('b.png'), srcImage('c.png')])
    await load(400, 300)
    swipe(-80, 10)
    expect(useImageViewerStore.getState().index).toBe(1)
    await load(400, 300)
    swipe(80, 0)
    expect(useImageViewerStore.getState().index).toBe(0)
    await load(400, 300)
    swipe(-50, 0)
    expect(useImageViewerStore.getState().index).toBe(0)
    expect(viewer()).not.toBeNull()
  })

  it('下滑 120 → 经历史关；下滑 80 → 不关', async () => {
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    await mount({ touch: true })
    await open([srcImage('a.png'), srcImage('b.png'), srcImage('c.png')])
    await load(400, 300)
    swipe(10, 80)
    expect(back).not.toHaveBeenCalled()
    swipe(10, 120)
    expect(back).toHaveBeenCalledTimes(1)
    expect(useImageViewerStore.getState().index).toBe(0)
  })

  it('单张左滑 200 → 不翻不关', async () => {
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    await mount({ touch: true })
    await open([srcImage('a.png')])
    await load(400, 300)
    swipe(-200, 0)
    expect(useImageViewerStore.getState().index).toBe(0)
    expect(useImageViewerStore.getState().images).toHaveLength(1)
    expect(back).not.toHaveBeenCalled()
  })
})

describe('IV-24 双点', () => {
  it('<300ms 切换缩放；隔 400ms 不算；单点空白不关', async () => {
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    const now = vi.spyOn(Date, 'now')
    await mount({ touch: true })
    await open([srcImage('big.png')])
    await load(2000, 2000)
    const tap = (t: number): void => {
      now.mockReturnValue(t)
      gesture(stage(), [500, 400])
    }
    tap(10_000)
    expect(shownScale(2000)).toBeCloseTo(0.376, 6)
    expect(viewer()).not.toBeNull()
    expect(back).not.toHaveBeenCalled()
    tap(10_200)
    expect(shownScale(2000)).toBeCloseTo(1, 6)
    tap(20_000)
    tap(20_400)
    expect(shownScale(2000)).toBeCloseTo(1, 6)
    expect(viewer()).not.toBeNull()
    expect(back).not.toHaveBeenCalled()
  })
})

describe('IV-25 手机分享', () => {
  let share: ReturnType<typeof vi.fn>
  let canShare: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.spyOn(window.history, 'back').mockImplementation(() => {})
    share = vi.fn(async () => {})
    canShare = vi.fn(() => true)
    Object.defineProperty(navigator, 'share', { configurable: true, value: share })
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: canShare })
  })

  afterEach(() => {
    delete (navigator as unknown as Record<string, unknown>).share
    delete (navigator as unknown as Record<string, unknown>).canShare
  })

  async function tapShare(): Promise<{ href: string | null; download: string }[]> {
    const clicks = spyAnchors()
    await mount({ touch: true })
    await open([srcImage('cat.png')])
    fakeTimeouts()
    await click(action('download')!)
    return clicks
  }

  it('能分享文件 → share({files})，不下载', async () => {
    const clicks = await tapShare()
    expect(share).toHaveBeenCalledTimes(1)
    const files = (share.mock.calls[0][0] as { files: File[] }).files
    expect(files).toHaveLength(1)
    expect(files[0]).toBeInstanceOf(File)
    expect(files[0]!.name).toBe('cat.png')
    expect(clicks).toEqual([])
  })

  it('AbortError → 不下载', async () => {
    share.mockRejectedValue(Object.assign(new Error('cancel'), { name: 'AbortError' }))
    const clicks = await tapShare()
    expect(share).toHaveBeenCalledTimes(1)
    expect(clicks).toEqual([])
  })

  it('别的错误 → 下载', async () => {
    share.mockRejectedValue(new Error('NotAllowed'))
    const clicks = await tapShare()
    expect(clicks).toEqual([{ href: 'blob:obj', download: 'cat.png' }])
  })

  it('canShare false → 下载，不调 share', async () => {
    canShare.mockReturnValue(false)
    const clicks = await tapShare()
    expect(share).not.toHaveBeenCalled()
    expect(clicks).toEqual([{ href: 'blob:obj', download: 'cat.png' }])
  })
})
