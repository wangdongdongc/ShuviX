// @vitest-environment jsdom
/**
 * 图导出面板（FigureExportPanel / FigureExportButton）DOM 测试（jsdom）。
 *
 * 面板只认一个 FigureExportSource：这里给一个假的（`build` 是间谍，回一张固定的 320×200 图），
 * 于是「面板什么时候、按什么参数去建图」直接可读。钉的是面板自己的那几条承诺：
 *
 *   - **缺省**（P-1）：PNG / 当前主题 / 填充 / 2x —— 导出来的就是卡片里看到的那张；
 *   - **预览与按钮的状态**（P-2）：建图中两个按钮都不能按，失败了说清楚；
 *   - **配色 → 主题 id**（P-3）：浅 / 深取宿主外观里设的那两套，没有宿主用 GitHub 那一对；
 *   - **缓存**（P-4/5/19）：只有（配色 × 底色）变了才重建；失败的不缓存；换了图源不串；
 *   - **JPG 强制底色、SVG 不按倍率**（P-6/7）；落盘与剪贴板（P-8…11）——剪贴板的
 *     ClipboardItem 必须在点击那一拍里同步构造；
 *   - **记住选择**（P-12）：存 localStorage，读回来逐字段校验，存储抛错也不碍事；
 *   - **文件名、尺寸说明**（P-13/14）；**收起与焦点**（P-15/16/18）；**定位**（P-17）。
 *
 * 桩：`rasterizeFigure` / `downloadBlob` 换成间谍（jsdom 没有画布、没有下载）；`svgFileBlob`
 * 与 `copyPngToClipboard` 用真的 —— ClipboardItem 与 navigator.clipboard 按用例装。
 * i18n 走真 en / zh 资源；文件是 .tsx 但不写 JSX，一律 createElement（与 chat 目录的 dom 测试一致）。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'

vi.mock('../figureExport', async (importOriginal) => {
  const real = await importOriginal<typeof import('../figureExport')>()
  return {
    ...real,
    rasterizeFigure: vi.fn(),
    downloadBlob: vi.fn()
  }
})

import {
  downloadBlob,
  rasterizeFigure,
  type FigureBuildOptions,
  type FigureExportSource,
  type StandaloneSvg
} from '../figureExport'
import { FigureExportButton, FigureExportPanel } from '../FigureExportPanel'
import { ChatHostContext, type ChatHostValue } from '../../../host/chatHostContext'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const PREFS_KEY = 'shuvix.figureExport.prefs'
const rasterize = vi.mocked(rasterizeFigure)
const download = vi.mocked(downloadBlob)

// ─── 假图源 ──────────────────────────────────────────────────

const figOf = (tag: string, width = 320, height = 200): StandaloneSvg => ({
  svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" data-tag="${tag}"/>`,
  width,
  height
})

type BuildSpy = ReturnType<typeof vi.fn<(opts: FigureBuildOptions) => Promise<StandaloneSvg>>>

/** 一个假图源：每次 build 回一个**新对象**（身份可比 —— 「下载拿的是不是预览那一份」） */
function makeSource(
  name: string | null = 'Probe',
  fig: () => StandaloneSvg = () => figOf('probe')
): FigureExportSource & { build: BuildSpy } {
  const build: BuildSpy = vi.fn(async () => fig())
  return { name, build }
}

/** 一个手动收的 deferred */
function deferred<T>(): { promise: Promise<T>; resolve(v: T): void; reject(e: Error): void } {
  let resolve!: (v: T) => void
  let reject!: (e: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// ─── 挂载 ──────────────────────────────────────────────────

let container: HTMLDivElement
let root: Root
let anchor: HTMLButtonElement
let onClose: ReturnType<typeof vi.fn<() => void>>

const hostValue = (appearance: Partial<ChatHostValue['appearance']> = {}): ChatHostValue => ({
  appearance: {
    theme: 'dark',
    darkTheme: '',
    lightTheme: '',
    fontSize: 14,
    focusMode: false,
    ...appearance
  },
  models: {
    activeProvider: '',
    activeModel: '',
    setActiveProvider: () => {},
    setActiveModel: () => {}
  }
})

const HostProvider = ChatHostContext.Provider as unknown as (props: {
  value: ChatHostValue
  children?: ReactNode
}) => React.JSX.Element

function panelTree(
  source: FigureExportSource,
  opts: { host?: ChatHostValue; anchor?: HTMLElement } = {}
): ReactNode {
  const panel = createElement(FigureExportPanel, {
    source,
    anchor: opts.anchor ?? anchor,
    onClose
  })
  return opts.host ? createElement(HostProvider, { value: opts.host }, panel) : panel
}

function show(node: ReactNode): void {
  act(() => {
    root.render(node)
  })
}

/** 把挂起的微任务 / React 更新收干净（假时钟开着时推进 0ms） */
async function flush(): Promise<void> {
  await act(async () => {
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0)
    else await new Promise((r) => setTimeout(r, 0))
  })
}

/** 挂一张面板并等第一张图建好 */
async function openPanel(
  source: FigureExportSource,
  opts: { host?: ChatHostValue; anchor?: HTMLElement } = {}
): Promise<void> {
  show(panelTree(source, opts))
  await flush()
}

// ─── DOM 读取 ──────────────────────────────────────────────

const panel = (): HTMLElement | null =>
  document.body.querySelector<HTMLElement>('[data-figure-export-panel]')
const thePanel = (): HTMLElement => {
  const p = panel()
  if (!p) throw new Error('面板没开着')
  return p
}
const option = (group: string, value: string | number): HTMLButtonElement => {
  const el = thePanel().querySelector<HTMLButtonElement>(`[data-figure-option="${group}:${value}"]`)
  if (!el) throw new Error(`没有选项 ${group}:${value}`)
  return el
}
const checked = (group: string): string[] =>
  Array.from(thePanel().querySelectorAll<HTMLElement>(`[data-figure-option^="${group}:"]`))
    .filter((el) => el.getAttribute('aria-checked') === 'true')
    .map((el) => el.dataset.figureOption!.slice(group.length + 1))
const previewState = (): string | null =>
  thePanel().querySelector('[data-figure-preview]')?.getAttribute('data-figure-preview') ?? null
const previewEl = (): HTMLElement => thePanel().querySelector<HTMLElement>('[data-figure-preview]')!
/** 预览 <img> 的 data: URL 解回来的 SVG 标记；没有图 = null */
const previewSvg = (): string | null => {
  const src = thePanel().querySelector('img')?.getAttribute('src')
  const prefix = 'data:image/svg+xml;charset=utf-8,'
  if (!src) return null
  expect(src.startsWith(prefix), src).toBe(true)
  return decodeURIComponent(src.slice(prefix.length))
}
const fileName = (): string => thePanel().querySelector('[data-figure-filename]')?.textContent ?? ''
const dims = (): string => thePanel().querySelector('[data-figure-dims]')?.textContent ?? ''
const downloadBtn = (): HTMLButtonElement =>
  thePanel().querySelector<HTMLButtonElement>('[data-figure-download]')!
const copyBtn = (): HTMLButtonElement =>
  thePanel().querySelector<HTMLButtonElement>('[data-figure-copy]')!
const actionError = (): string | null =>
  thePanel().querySelector('[data-figure-action-error]')?.textContent ?? null
const panelText = (): string => thePanel().textContent ?? ''

const click = (el: Element): void => {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}
/** 点一个选项并让随之而来的建图落定 */
async function choose(group: string, value: string | number): Promise<void> {
  click(option(group, value))
  await flush()
}

const blobText = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsText(blob)
  })

// ─── 剪贴板桩 ──────────────────────────────────────────────

const g = globalThis as unknown as Record<string, unknown>
let prevClipboardItem: unknown

/** 记下每次 ClipboardItem 构造：参数 + 构造时是否还在点击的同步派发里 */
interface MadeItem {
  data: Record<string, unknown>
  inClick: boolean
}
let made: MadeItem[] = []
let dispatching = false

function installClipboard(write: (items: unknown[]) => Promise<void>): void {
  g.ClipboardItem = class {
    constructor(readonly data: Record<string, unknown>) {
      made.push({ data, inClick: dispatching })
    }
  }
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write } })
}

/** 点击，并把「这一拍是点击的同步派发」标出来 */
function clickTracked(el: Element): void {
  act(() => {
    dispatching = true
    try {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    } finally {
      dispatching = false
    }
  })
}

// ─── 生命周期 ──────────────────────────────────────────────

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en }, zh: { translation: zh } }
  })
})

beforeEach(() => {
  localStorage.clear()
  rasterize.mockReset()
  rasterize.mockImplementation(
    async (_fig, format) => new Blob(['x'], { type: format === 'jpg' ? 'image/jpeg' : 'image/png' })
  )
  download.mockReset()
  made = []
  prevClipboardItem = g.ClipboardItem
  document.documentElement.setAttribute('data-theme', 'ROOT')
  container = document.createElement('div')
  document.body.appendChild(container)
  anchor = document.createElement('button')
  anchor.textContent = 'anchor'
  document.body.appendChild(anchor)
  onClose = vi.fn()
  root = createRoot(container)
})

afterEach(async () => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  g.ClipboardItem = prevClipboardItem
  Reflect.deleteProperty(navigator, 'clipboard')
  vi.useRealTimers()
  vi.restoreAllMocks()
  if (i18n.language !== 'en') await i18n.changeLanguage('en')
})

// ═══════════════════════════════════════════════════════════════

describe('缺省与预览（P-1/2）', () => {
  it('P-1 缺省 PNG / 当前主题 / 填充 / 2x；尺寸 640 × 400 px；文件名 Probe.png；只建一次、参数对', async () => {
    const source = makeSource()
    await openPanel(source)
    expect(checked('format')).toEqual(['png'])
    expect(checked('scheme')).toEqual(['current'])
    expect(checked('background')).toEqual(['fill'])
    expect(checked('scale')).toEqual(['2'])
    expect(dims()).toBe('640 × 400 px')
    expect(fileName()).toBe('Probe.png')
    expect(source.build).toHaveBeenCalledTimes(1)
    expect(source.build).toHaveBeenCalledWith({
      scheme: 'current',
      themeId: 'ROOT',
      background: true
    })
    const p = thePanel()
    expect(p.getAttribute('role')).toBe('dialog')
    expect(p.getAttribute('aria-label')).toBe('Export')
    expect(p.parentElement).toBe(document.body)
  })

  it('P-2 建图中：预览 building、两个按钮都按不了；建好：ready、预览就是那张图', async () => {
    const d = deferred<StandaloneSvg>()
    const source: FigureExportSource & { build: BuildSpy } = {
      name: 'Probe',
      build: vi.fn(() => d.promise)
    }
    await openPanel(source)
    expect(previewState()).toBe('building')
    expect(panelText()).toContain('Preparing…')
    expect(downloadBtn().disabled).toBe(true)
    expect(copyBtn().disabled).toBe(true)

    const fig = figOf('p2')
    await act(async () => {
      d.resolve(fig)
    })
    await flush()
    expect(previewState()).toBe('ready')
    expect(previewSvg()).toBe(fig.svg)
    expect(downloadBtn().disabled).toBe(false)
    expect(copyBtn().disabled).toBe(false)
  })

  it('P-2 建图失败：error、写明原因、两个按钮都按不了', async () => {
    const source: FigureExportSource & { build: BuildSpy } = {
      name: 'Probe',
      build: vi.fn(async () => {
        throw new Error('boom')
      })
    }
    await openPanel(source)
    expect(previewState()).toBe('error')
    expect(previewEl().textContent).toBe("Couldn't export: boom")
    expect(previewSvg()).toBeNull()
    expect(downloadBtn().disabled).toBe(true)
    expect(copyBtn().disabled).toBe(true)
  })
})

describe('配色 → 主题 id（P-3）', () => {
  it('P-3 宿主给了浅 / 深两套：浅色 → solarized-light，深色 → nord', async () => {
    const source = makeSource()
    await openPanel(source, {
      host: hostValue({ lightTheme: 'solarized-light', darkTheme: 'nord' })
    })
    await choose('scheme', 'light')
    expect(source.build).toHaveBeenLastCalledWith({
      scheme: 'light',
      themeId: 'solarized-light',
      background: true
    })
    await choose('scheme', 'dark')
    expect(source.build).toHaveBeenLastCalledWith({
      scheme: 'dark',
      themeId: 'nord',
      background: true
    })
  })

  it('P-3 没有宿主：GitHub 那一对；当前主题且根上没有 data-theme → 空串', async () => {
    document.documentElement.removeAttribute('data-theme')
    const source = makeSource()
    await openPanel(source)
    expect(source.build).toHaveBeenLastCalledWith({
      scheme: 'current',
      themeId: '',
      background: true
    })
    await choose('scheme', 'light')
    expect(source.build).toHaveBeenLastCalledWith(
      expect.objectContaining({ themeId: 'github-light' })
    )
    await choose('scheme', 'dark')
    expect(source.build).toHaveBeenLastCalledWith(
      expect.objectContaining({ themeId: 'github-dark' })
    )
  })
})

describe('缓存（P-4/5/19）', () => {
  it('P-4 格式 / 倍率不重建；换配色重建，切回来命中；换底色重建；下载拿的就是预览那一份', async () => {
    const source = makeSource()
    await openPanel(source)
    expect(source.build).toHaveBeenCalledTimes(1)

    await choose('format', 'svg')
    await choose('format', 'png')
    await choose('scale', 3)
    await choose('scale', 1)
    expect(source.build).toHaveBeenCalledTimes(1)

    await choose('scheme', 'light')
    expect(source.build).toHaveBeenCalledTimes(2)
    await choose('scheme', 'current')
    expect(source.build).toHaveBeenCalledTimes(2)

    await choose('background', 'none')
    expect(source.build).toHaveBeenCalledTimes(3)
    expect(source.build).toHaveBeenLastCalledWith({
      scheme: 'current',
      themeId: 'ROOT',
      background: false
    })
    const latest = await source.build.mock.results[2].value

    click(downloadBtn())
    await flush()
    expect(rasterize).toHaveBeenCalledTimes(1)
    expect(rasterize.mock.calls[0][0]).toBe(latest)
    expect(source.build).toHaveBeenCalledTimes(3)
  })

  it('P-5 失败的那次不缓存：切走再切回来会重建，这次成了就 ready', async () => {
    const source = makeSource()
    source.build.mockRejectedValueOnce(new Error('first fails'))
    await openPanel(source)
    expect(previewState()).toBe('error')

    await choose('scheme', 'light')
    expect(previewState()).toBe('ready')
    await choose('scheme', 'current')
    expect(source.build).toHaveBeenCalledTimes(3)
    expect(source.build.mock.calls[2][0]).toMatchObject({ scheme: 'current' })
    expect(previewState()).toBe('ready')
  })

  it('P-19 同一个面板实例换了图源（和锚点）：按新图源建，预览与文件名都是新图的', async () => {
    const first = makeSource('First', () => figOf('first'))
    await openPanel(first)
    expect(previewSvg()).toContain('data-tag="first"')

    const second = makeSource('Second', () => figOf('second'))
    const anchor2 = document.createElement('button')
    document.body.appendChild(anchor2)
    show(panelTree(second, { anchor: anchor2 }))
    await flush()
    expect(second.build).toHaveBeenCalledTimes(1)
    expect(previewSvg()).toContain('data-tag="second"')
    expect(fileName()).toBe('Second.png')

    click(downloadBtn())
    await flush()
    expect(rasterize.mock.calls[0][0].svg).toContain('data-tag="second"')
    expect(download).toHaveBeenCalledWith(expect.any(Blob), 'Second.png')
  })
})

describe('格式（P-6/7/8/14）', () => {
  it('P-6 JPG：透明那一档不能选、填充选中、按带底色建；切回 PNG 透明回来，存的仍是透明', async () => {
    localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({ format: 'png', scheme: 'current', background: false, scale: 2 })
    )
    const source = makeSource()
    await openPanel(source)
    expect(checked('background')).toEqual(['none'])
    expect(source.build).toHaveBeenLastCalledWith(expect.objectContaining({ background: false }))

    await choose('format', 'jpg')
    expect(option('background', 'none').disabled).toBe(true)
    expect(checked('background')).toEqual(['fill'])
    expect(source.build).toHaveBeenLastCalledWith(expect.objectContaining({ background: true }))
    expect(panelText()).toContain('JPG has no transparency, so the background is always filled.')
    expect(fileName()).toBe('Probe.jpg')

    await choose('format', 'png')
    expect(option('background', 'none').disabled).toBe(false)
    expect(checked('background')).toEqual(['none'])
    expect(JSON.parse(localStorage.getItem(PREFS_KEY)!).background).toBe(false)
    expect(panelText()).not.toContain('JPG has no transparency')
  })

  it('P-7 SVG：倍率不能选、尺寸写「Vector · 宽 × 高」、带说明；下载走 svgFileBlob，不转位图', async () => {
    const source = makeSource()
    await openPanel(source)
    await choose('format', 'svg')
    for (const s of [1, 2, 3]) expect(option('scale', s).disabled).toBe(true)
    expect(dims()).toBe('Vector · 320 × 200')
    expect(panelText()).toContain(
      'Colors are written as real values, so the file looks right outside ShuviX too.'
    )
    expect(fileName()).toBe('Probe.svg')

    click(downloadBtn())
    await flush()
    expect(rasterize).not.toHaveBeenCalled()
    expect(download).toHaveBeenCalledTimes(1)
    const [blob, name] = download.mock.calls[0]
    expect(name).toBe('Probe.svg')
    expect(blob.type).toBe('image/svg+xml;charset=utf-8')
    const fig = await source.build.mock.results[0].value
    expect(await blobText(blob)).toBe(`<?xml version="1.0" encoding="UTF-8"?>\n${fig.svg}\n`)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('P-8 PNG 3x / JPG：按所选格式与倍率转位图、按扩展名落盘、收起', async () => {
    const source = makeSource()
    await openPanel(source)
    const fig = await source.build.mock.results[0].value
    await choose('scale', 3)
    click(downloadBtn())
    await flush()
    expect(rasterize).toHaveBeenLastCalledWith(fig, 'png', 3)
    const pngBlob = await rasterize.mock.results[0].value
    expect(download).toHaveBeenLastCalledWith(pngBlob, 'Probe.png')
    expect(onClose).toHaveBeenCalledTimes(1)

    await choose('format', 'jpg')
    click(downloadBtn())
    await flush()
    expect(rasterize).toHaveBeenLastCalledWith(fig, 'jpg', 3)
    expect(download).toHaveBeenLastCalledWith(expect.any(Blob), 'Probe.jpg')
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('P-9 转位图失败：面板里写明原因、不收起、下载按钮恢复；点个选项错误就清掉', async () => {
    rasterize.mockRejectedValueOnce(new Error('nope'))
    const source = makeSource()
    await openPanel(source)
    click(downloadBtn())
    await flush()
    expect(actionError()).toBe("Couldn't export: nope")
    expect(panel()).not.toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    expect(download).not.toHaveBeenCalled()
    expect(downloadBtn().disabled).toBe(false)

    await choose('scale', 1)
    expect(actionError()).toBeNull()
  })

  it('P-14 10000×10000 选 3x：尺寸说明按封顶后的实际像素', async () => {
    const source = makeSource('Huge', () => figOf('huge', 10000, 10000))
    await openPanel(source)
    await choose('scale', 3)
    expect(dims()).toBe('6324 × 6324 px')
  })
})

describe('复制（P-10/11）', () => {
  it('P-10 ClipboardItem 在点击那一拍里同步构造；PNG 承诺落定为当前倍率的 PNG（格式选 SVG 也一样）；Copied 1500ms 后复原', async () => {
    vi.useFakeTimers()
    const write = vi.fn(async () => undefined)
    installClipboard(write)
    const source = makeSource()
    await openPanel(source)
    const fig = await source.build.mock.results[0].value
    await choose('format', 'svg')

    clickTracked(copyBtn())
    expect(made).toHaveLength(1)
    expect(made[0].inClick).toBe(true)
    expect(Object.keys(made[0].data)).toEqual(['image/png'])
    const png = made[0].data['image/png']
    expect(png).toBeInstanceOf(Promise)
    expect(write).toHaveBeenCalledTimes(1)

    await flush()
    const blob = await (png as Promise<Blob>)
    expect(rasterize).toHaveBeenCalledWith(fig, 'png', 2)
    expect(blob).toBe(await rasterize.mock.results[0].value)
    expect(copyBtn().textContent).toBe('Copied')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1499)
    })
    expect(copyBtn().textContent).toBe('Copied')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(copyBtn().textContent).toBe('Copy image')
  })

  it('P-10 变体：JPG 3x 时复制的仍是 PNG，按 3x', async () => {
    installClipboard(vi.fn(async () => undefined))
    const source = makeSource()
    await openPanel(source)
    await choose('format', 'jpg')
    await choose('scale', 3)
    clickTracked(copyBtn())
    await flush()
    expect(rasterize).toHaveBeenLastCalledWith(expect.anything(), 'png', 3)
  })

  it('P-11 没有 ClipboardItem：写明失败、建议下载，从不显示 Copied', async () => {
    delete g.ClipboardItem
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { write: vi.fn() }
    })
    await openPanel(makeSource())
    click(copyBtn())
    await flush()
    expect(actionError()).toBe("Couldn't copy the image. Try downloading it instead.")
    expect(copyBtn().textContent).toBe('Copy image')
  })

  it('P-11 write 拒绝：同样写明失败，从不显示 Copied', async () => {
    installClipboard(async () => {
      throw new Error('denied')
    })
    await openPanel(makeSource())
    clickTracked(copyBtn())
    await flush()
    expect(actionError()).toBe("Couldn't copy the image. Try downloading it instead.")
    expect(copyBtn().textContent).toBe('Copy image')
    expect(panel()).not.toBeNull()
  })
})

describe('记住选择（P-12）', () => {
  it('P-12 选过的四项都存下来；重挂载后原样', async () => {
    await openPanel(makeSource())
    await choose('format', 'svg')
    await choose('scheme', 'dark')
    await choose('background', 'none')
    expect(JSON.parse(localStorage.getItem(PREFS_KEY)!)).toEqual({
      format: 'svg',
      scheme: 'dark',
      background: false,
      scale: 2
    })

    act(() => root.unmount())
    root = createRoot(container)
    await openPanel(makeSource())
    expect(checked('format')).toEqual(['svg'])
    expect(checked('scheme')).toEqual(['dark'])
    expect(checked('background')).toEqual(['none'])
    expect(checked('scale')).toEqual(['2'])
  })

  it('P-12 存的东西坏了：不是 JSON → 整份缺省；坏字段各自落回缺省', async () => {
    localStorage.setItem(PREFS_KEY, '{')
    await openPanel(makeSource())
    expect([checked('format'), checked('scheme'), checked('background'), checked('scale')]).toEqual(
      [['png'], ['current'], ['fill'], ['2']]
    )

    act(() => root.unmount())
    root = createRoot(container)
    localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({ format: 'gif', scheme: 'dark', scale: 5, background: 'no' })
    )
    await openPanel(makeSource())
    expect([checked('format'), checked('scheme'), checked('background'), checked('scale')]).toEqual(
      [['png'], ['dark'], ['fill'], ['2']]
    )
  })

  it('P-12 存储读写都抛：按缺省显示，点选项照样生效', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    await openPanel(makeSource())
    expect(checked('format')).toEqual(['png'])
    await choose('format', 'jpg')
    await choose('scale', 1)
    expect(checked('format')).toEqual(['jpg'])
    expect(checked('scale')).toEqual(['1'])
    expect(fileName()).toBe('Probe.jpg')
  })
})

describe('文件名（P-13）', () => {
  it('P-13 图没有名字：en 用 figure、zh 用「图」', async () => {
    await openPanel(makeSource(null))
    expect(fileName()).toBe('figure.png')

    act(() => root.unmount())
    root = createRoot(container)
    await act(async () => {
      await i18n.changeLanguage('zh')
    })
    await openPanel(makeSource(null))
    expect(fileName()).toBe('图.png')
  })

  it('P-13 名字先清洗；扩展名跟着格式走', async () => {
    await openPanel(makeSource('a/b: c?'))
    expect(fileName()).toBe('a b c.png')
    await choose('format', 'jpg')
    expect(fileName()).toBe('a b c.jpg')
    await choose('format', 'svg')
    expect(fileName()).toBe('a b c.svg')
  })
})

describe('收起与焦点（P-15/16/18）', () => {
  it('P-15 Esc：收起一次、焦点回到按钮、不再冒泡到 document 上别的监听', async () => {
    await openPanel(makeSource())
    const bubbled = vi.fn()
    document.addEventListener('keydown', bubbled)
    try {
      const target = document.activeElement ?? document.body
      act(() => {
        target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      })
      expect(onClose).not.toHaveBeenCalled()
      expect(bubbled).toHaveBeenCalledTimes(1)

      act(() => {
        target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      })
      expect(onClose).toHaveBeenCalledTimes(1)
      expect(document.activeElement).toBe(anchor)
      expect(bubbled).toHaveBeenCalledTimes(1)
    } finally {
      document.removeEventListener('keydown', bubbled)
    }
  })

  it('P-15 在外面按下收起；在面板里、在按钮上按下不收', async () => {
    await openPanel(makeSource())
    const down = (el: Element): void => {
      act(() => {
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      })
    }
    down(previewEl())
    down(option('format', 'svg'))
    down(anchor)
    expect(onClose).not.toHaveBeenCalled()
    down(container)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('P-16 按钮被摘掉（没有 MutationObserver 时）：下一次缩放 / 滚动就收起', async () => {
    const prevMO = g.MutationObserver
    delete g.MutationObserver
    try {
      await openPanel(makeSource())
      anchor.remove()
      await flush()
      expect(onClose).not.toHaveBeenCalled()
      act(() => {
        window.dispatchEvent(new Event('resize'))
      })
      expect(onClose).toHaveBeenCalled()

      onClose.mockClear()
      act(() => {
        document.dispatchEvent(new Event('scroll'))
      })
      expect(onClose).toHaveBeenCalled()
    } finally {
      g.MutationObserver = prevMO
    }
  })

  it('P-16 按钮被摘掉、没有任何滚动 / 缩放：照样收起（观察 body 的增删）', async () => {
    await openPanel(makeSource())
    expect(onClose).not.toHaveBeenCalled()
    anchor.remove()
    await flush()
    expect(onClose).toHaveBeenCalled()
  })

  it('P-16 对照：body 里别的增删不会让面板收起', async () => {
    await openPanel(makeSource())
    const other = document.createElement('div')
    document.body.appendChild(other)
    other.remove()
    await flush()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('P-18 图建好时焦点交给「下载」', async () => {
    await openPanel(makeSource())
    expect(document.activeElement).toBe(downloadBtn())
  })

  it('P-18 建好之前用户已经在面板里聚焦了别的控件：不抢', async () => {
    const d = deferred<StandaloneSvg>()
    await openPanel({ name: 'Probe', build: vi.fn(() => d.promise) })
    const opt = option('scheme', 'dark')
    act(() => opt.focus())
    expect(document.activeElement).toBe(opt)
    await act(async () => {
      d.resolve(figOf('p18'))
    })
    await flush()
    expect(previewState()).toBe('ready')
    expect(document.activeElement).toBe(opt)
  })
})

describe('定位（P-17）', () => {
  const rect = (r: { top: number; bottom: number; right: number }): DOMRect =>
    ({
      top: r.top,
      bottom: r.bottom,
      right: r.right,
      left: r.right - 40,
      width: 40,
      height: r.bottom - r.top,
      x: r.right - 40,
      y: r.top,
      toJSON: () => ({})
    }) as DOMRect

  beforeEach(() => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1000)
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(800)
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(300)
  })

  it.each([
    ['下方放得下：右对齐、在按钮下 6px', { top: 100, bottom: 120, right: 600 }, '300px', '126px'],
    ['下方放不下、上方放得下：翻到上方', { top: 700, bottom: 720, right: 600 }, '300px', '394px'],
    ['太靠左：夹到 8px', { top: 100, bottom: 120, right: 100 }, '8px', '126px'],
    ['太靠右：不超出右边 8px', { top: 100, bottom: 120, right: 1000 }, '692px', '126px'],
    ['翻到上方后离顶不足 8px：夹到 8px', { top: 310, bottom: 600, right: 600 }, '300px', '8px']
  ])('P-17 %s', async (_label, r, left, top) => {
    anchor.getBoundingClientRect = () => rect(r)
    await openPanel(makeSource())
    expect(thePanel().style.left).toBe(left)
    expect(thePanel().style.top).toBe(top)
  })
})

describe('工具栏按钮（P-20）', () => {
  it('P-20 getSource 点开那一刻才调；面板挂在 body 上；aria-expanded 跟着开合；再点收起', async () => {
    const source = makeSource()
    const getSource = vi.fn(() => source)
    show(createElement(FigureExportButton, { getSource }))
    await flush()
    expect(getSource).not.toHaveBeenCalled()
    const btn = container.querySelector<HTMLButtonElement>('[data-figure-export]')!
    expect(btn.textContent).toBe('Export')
    expect(btn.getAttribute('aria-expanded')).toBe('false')
    expect(panel()).toBeNull()

    click(btn)
    await flush()
    expect(getSource).toHaveBeenCalledTimes(1)
    expect(panel()?.parentElement).toBe(document.body)
    expect(panel()?.getAttribute('role')).toBe('dialog')
    expect(panel()?.getAttribute('aria-label')).toBe('Export')
    expect(btn.getAttribute('aria-expanded')).toBe('true')

    click(btn)
    await flush()
    expect(panel()).toBeNull()
    expect(btn.getAttribute('aria-expanded')).toBe('false')
    expect(getSource).toHaveBeenCalledTimes(1)
  })

  it('P-20 getSource 回 null：不开面板', async () => {
    const getSource = vi.fn(() => null)
    show(createElement(FigureExportButton, { getSource }))
    const btn = container.querySelector<HTMLButtonElement>('[data-figure-export]')!
    click(btn)
    await flush()
    expect(getSource).toHaveBeenCalledTimes(1)
    expect(panel()).toBeNull()
    expect(btn.getAttribute('aria-expanded')).toBe('false')
  })
})

describe('杂项（P-21/22）', () => {
  it('P-21 透明底的预览是棋盘格；填充底没有', async () => {
    await openPanel(makeSource())
    expect(previewEl().getAttribute('style') ?? '').not.toContain('repeating-conic-gradient')
    await choose('background', 'none')
    expect(previewEl().getAttribute('style') ?? '').toContain('repeating-conic-gradient')
  })

  it('P-22 每组单选恰好一个选中（几种状态下都是）', async () => {
    await openPanel(makeSource())
    const groups = (): string[] =>
      Array.from(thePanel().querySelectorAll('[role="radiogroup"]')).map(
        (rg) => rg.getAttribute('aria-label') ?? ''
      )
    const assertOneEach = (): void => {
      const rgs = Array.from(thePanel().querySelectorAll('[role="radiogroup"]'))
      expect(rgs).toHaveLength(4)
      for (const rg of rgs) {
        const on = rg.querySelectorAll('[role="radio"][aria-checked="true"]')
        expect(on, rg.getAttribute('aria-label') ?? '').toHaveLength(1)
      }
    }
    expect(groups()).toEqual(['Format', 'Colors', 'Background', 'Scale'])
    assertOneEach()
    await choose('format', 'jpg')
    assertOneEach()
    await choose('format', 'svg')
    await choose('scheme', 'light')
    assertOneEach()
  })
})
