/**
 * 图导出 —— 把对话 / 笔记本里画出来的一张图变成一个**离开 ShuviX 也成立**的文件。
 *
 * ## 为什么不能把源码原样存下来
 *
 * 手写图（```svg 围栏、svg 产物）的颜色一律是 `var(--viz-1)` / `var(--theme-text-primary)`
 * 这类主题 token —— 在 ShuviX 里由 themes.css 解析，换个查看器打开就一个都解析不到，整张图
 * 退成黑色。所以导出要先**烘焙**：把图挂进一个离屏容器，逐个元素读计算样式，把颜色、字体这些
 * 写成具体值，再序列化成独立的 SVG。
 *
 * ## 「浅色 / 深色」是怎么取色的
 *
 * 主题是靠 `[data-theme='…']` 属性选择器挂上的，不限根节点（见 themes.css），所以离屏容器挂上
 * 用户设定的浅色 / 深色主题，里面的图就按那套主题解析 —— 不必切整个界面。
 *
 * ## mermaid 不烘焙
 *
 * mermaid 的产物本身就是具体颜色（主题 token 在渲染时已经解析好喂给它），只需补上尺寸、底色
 * 再按 XML 序列化（它的 htmlLabels 里有 `<br>`，按 HTML 序列化出来的不是合法 XML）。
 *
 * 这一层只认标记字符串与 DOM，不认来源；四个入口（对话 svg / 产物 / mermaid、笔记本 svg /
 * mermaid）各自把自己的图包成一个 FigureExportSource 交给面板。
 */
import {
  effectiveScale,
  formatOpacity,
  fragmentUrlOf,
  parseCssColor,
  rasterSize,
  type FigureFormat,
  type FigureScheme,
  type ParsedColor
} from './figureExportPure'

const SVG_NS = 'http://www.w3.org/2000/svg'

/** 一张已经独立成立的 SVG：标记 + 用户单位下的宽高（= viewBox 的宽高） */
export interface StandaloneSvg {
  svg: string
  width: number
  height: number
}

/** 面板交给图源的选项 */
export interface FigureBuildOptions {
  scheme: FigureScheme
  /** 要挂的主题 id —— 面板按 scheme 解析好的（'' = 不挂，沿用根上的） */
  themeId: string
  /** 要不要底色 */
  background: boolean
}

/** 一张可导出的图：由各入口提供，面板只认这个形状 */
export interface FigureExportSource {
  /** 文件名主干（未清洗；空就用缺省名） */
  name: string | null
  build(opts: FigureBuildOptions): Promise<StandaloneSvg>
}

/** 图底下那一层的颜色：卡片（对话）或页面（笔记本） */
export type FigureSurface = 'card' | 'page'

/** 各底色对应的 CSS —— 卡片底与 CodeBlock 的图卡同一个配方（bg-tertiary 60% 叠 bg-primary） */
const SURFACE_CSS: Record<FigureSurface, string> = {
  card: 'color-mix(in srgb, var(--theme-bg-tertiary) 60%, var(--theme-bg-primary))',
  page: 'var(--theme-bg-primary)'
}

// ─── 离屏容器 ─────────────────────────────────────────

/**
 * 挂一个离屏容器跑一段同步逻辑，跑完就摘掉。
 *
 * 不用 `display:none` / `visibility:hidden`：前者让 getBBox 失效，后者会被子孙继承、读出来的
 * visibility 全是 hidden。挪到视口外、透明度 0（opacity 不继承）就够了。
 *
 * `inheritFrom` 是图在屏幕上的那一格：字体从它继承下来（对话卡片里是正文字体，笔记本里是
 * 编辑器字体），离屏容器照抄，图里没写字体的文字才会是同一个字。
 */
export function withOffscreen<T>(
  themeId: string,
  inheritFrom: Element | null | undefined,
  fn: (box: HTMLDivElement) => T
): T {
  const box = document.createElement('div')
  if (themeId) box.setAttribute('data-theme', themeId)
  box.setAttribute('aria-hidden', 'true')
  box.style.cssText =
    'position:fixed;left:-100000px;top:0;width:2000px;opacity:0;pointer-events:none;' +
    'color:var(--theme-text-primary)'
  if (inheritFrom) {
    const cs = getComputedStyle(inheritFrom)
    box.style.fontFamily = cs.fontFamily
    box.style.fontSize = cs.fontSize
    box.style.fontWeight = cs.fontWeight
    box.style.lineHeight = cs.lineHeight
  }
  document.body.appendChild(box)
  try {
    return fn(box)
  } finally {
    box.remove()
  }
}

/** 把一段 CSS 颜色在这个容器里解析成具体颜色（容器挂着哪套主题就按哪套） */
function resolveColorIn(box: HTMLElement, css: string): ParsedColor | null {
  const probe = document.createElement('span')
  probe.style.color = css
  box.appendChild(probe)
  try {
    return toParsedColor(getComputedStyle(probe).color)
  } finally {
    probe.remove()
  }
}

// ─── 颜色 ─────────────────────────────────────────────

const canvasColorCache = new Map<string, ParsedColor | null>()

/**
 * 计算值 → 十六进制 + alpha。先走纯解析；认不出的格式（oklch() 之类会原样留在计算值里的）
 * 在 1×1 画布上画一个像素再读回来 —— 画布认的颜色就一定读得出来。
 */
function toParsedColor(value: string): ParsedColor | null {
  const parsed = parseCssColor(value)
  if (parsed) return parsed
  if (canvasColorCache.has(value)) return canvasColorCache.get(value) ?? null
  let result: ParsedColor | null = null
  try {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (ctx) {
      ctx.clearRect(0, 0, 1, 1)
      ctx.fillStyle = '#000000'
      ctx.fillStyle = value
      ctx.fillRect(0, 0, 1, 1)
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data
      result = parseCssColor(`rgba(${r}, ${g}, ${b}, ${a / 255})`)
    }
  } catch {
    result = null
  }
  canvasColorCache.set(value, result)
  return result
}

// ─── 烘焙 ─────────────────────────────────────────────

/**
 * 会继承的属性：子元素的值与父元素相同就不写（继承下来自然一样），不同才写。
 * 只写有差异的，产物才不至于每个元素背一长串样式。
 */
const INHERITED_PROPS = [
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-opacity',
  'stroke-width',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-linecap',
  'stroke-linejoin',
  'font-family',
  'font-size',
  'font-style',
  'font-weight',
  'letter-spacing',
  'text-anchor',
  'dominant-baseline',
  'paint-order'
] as const

/** 不继承的属性 → 初值（等于初值就不写） */
const NON_INHERITED_INITIAL: Record<string, string> = {
  opacity: '1',
  'stop-color': '#000000',
  'stop-opacity': '1',
  'flood-color': '#000000',
  'flood-opacity': '1'
}

/**
 * 独立 SVG 里根元素的「父值」—— 根上的属性与它相同就不必写。字体两项给空串：
 * 查看器的缺省字体是什么谁也说不准，根上总是写明。
 */
const ROOT_INITIAL: Record<string, string> = {
  fill: '#000000',
  'fill-opacity': '1',
  'fill-rule': 'nonzero',
  stroke: 'none',
  'stroke-opacity': '1',
  'stroke-width': '1px',
  'stroke-dasharray': 'none',
  'stroke-dashoffset': '0px',
  'stroke-linecap': 'butt',
  'stroke-linejoin': 'miter',
  'font-family': '',
  'font-size': '',
  'font-style': 'normal',
  'font-weight': '400',
  'letter-spacing': 'normal',
  'text-anchor': 'start',
  'dominant-baseline': 'auto',
  'paint-order': 'normal'
}

/** 颜色属性 → 与它相乘的不透明度属性 */
const PAINT_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['fill', 'fill-opacity'],
  ['stroke', 'stroke-opacity'],
  ['stop-color', 'stop-opacity'],
  ['flood-color', 'flood-opacity']
]

const ALL_PROPS = [...INHERITED_PROPS, ...Object.keys(NON_INHERITED_INITIAL)]

/**
 * 一个元素的「烘焙后的值」：颜色拆成十六进制，颜色自带的 alpha 乘进对应的不透明度。
 *
 * 必须拿**乘过之后**的值去和父元素比：半透明的 tint 写在 `<g>` 上、子元素换了一个不透明的颜色
 * 时，按原始计算值比（子的 fill-opacity 也是 1，与父相同、不写）会让子元素继承父元素乘出来的
 * 0.14 —— 一个本该实心的色块变成了一层薄雾。
 */
function derivedStyle(cs: CSSStyleDeclaration): Record<string, string> {
  const out: Record<string, string> = {}
  for (const p of ALL_PROPS) out[p] = cs.getPropertyValue(p).trim()
  for (const [paint, opacityProp] of PAINT_PAIRS) {
    const raw = out[paint]
    const baseOpacity = Number(out[opacityProp] || '1')
    const safeOpacity = Number.isFinite(baseOpacity) ? baseOpacity : 1
    if (!raw || raw === 'none') {
      out[opacityProp] = formatOpacity(safeOpacity)
      continue
    }
    const url = fragmentUrlOf(raw)
    if (url) {
      out[paint] = url
      out[opacityProp] = formatOpacity(safeOpacity)
      continue
    }
    const color = toParsedColor(raw)
    if (color) {
      out[paint] = color.hex
      out[opacityProp] = formatOpacity(safeOpacity * color.alpha)
    } else {
      out[opacityProp] = formatOpacity(safeOpacity)
    }
  }
  return out
}

/** 还带着主题 token 的值 —— 独立文件里解析不到，不能留 */
const TOKEN_RE = /var\(|light-dark\(/i

/**
 * 表外属性的计算值：能解析成颜色就写十六进制（`color` / `lighting-color` 这类），否则照抄计算值；
 * 计算值本身还带 token（自定义属性的计算值就是未解析的 token 流）或为空 → null，调用方删掉它。
 */
function concreteValue(computed: string): string | null {
  const v = computed.trim()
  if (!v || TOKEN_RE.test(v)) return null
  return parseCssColor(v)?.hex ?? v
}

/** 一个元素要做的全部改动 —— 在**改动任何东西之前**读完（见 bakeComputedStyles） */
interface BakePlan {
  derived: Record<string, string>
  /** 表外带 token 的属性：换成具体值，null = 删掉 */
  attrFixes: Array<[string, string | null]>
  /** style 里的声明：换成具体值，null = 删掉 */
  styleFixes: Array<[string, string | null]>
}

function planElement(el: SVGElement): BakePlan {
  const cs = getComputedStyle(el)
  const attrFixes: Array<[string, string | null]> = []
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase()
    // style 属性本身不在这里处理：它的值是一串声明，下面按声明逐条处理（整条删掉会把
    // 里面不带 token 的声明一起带走）
    if (name === 'style') continue
    if ((ALL_PROPS as readonly string[]).includes(name) || !TOKEN_RE.test(attr.value)) continue
    // `color="var(--viz-2)"` 配 `fill="currentColor"`：fill 那边已经按计算值烘焙了，
    // color 本身写成具体色留着（图里也许还有别处读它）
    attrFixes.push([attr.name, concreteValue(cs.getPropertyValue(name))])
  }
  const styleFixes: Array<[string, string | null]> = []
  const style = (el as SVGElement & ElementCSSInlineStyle).style
  if (style) {
    for (const name of Array.from(style)) {
      if ((ALL_PROPS as readonly string[]).includes(name) || name.startsWith('--')) {
        // 表里的属性下面写成表现属性；自定义属性只是 var() 的中转，引用它的声明都已换成计算值
        styleFixes.push([name, null])
      } else if (TOKEN_RE.test(style.getPropertyValue(name))) {
        styleFixes.push([name, concreteValue(cs.getPropertyValue(name))])
      }
    }
  }
  return { derived: derivedStyle(cs), attrFixes, styleFixes }
}

/**
 * 原地烘焙一棵**已挂在离屏容器里**的 SVG：每个元素按上面两张表写成具体值，原来那些带 token 的
 * 属性 / style 声明一律清掉或换成计算值（不清的话，独立文件里一个解析不到的 var() 会让整条
 * 声明作废）。
 *
 * 先把整棵树的值全读完再写：边读边写会让后面元素读到的是改了一半的继承链。
 */
export function bakeComputedStyles(root: SVGSVGElement): void {
  const elements = [root, ...Array.from(root.querySelectorAll('*'))].filter(
    (el): el is SVGElement => el.namespaceURI === SVG_NS
  )
  const plans = new Map<Element, BakePlan>()
  for (const el of elements) plans.set(el, planElement(el))

  for (const el of elements) {
    const { derived: mine, attrFixes, styleFixes } = plans.get(el)!
    const parent = el === root ? null : plans.get(el.parentElement as Element)?.derived
    const bake: Array<[string, string]> = []
    for (const p of INHERITED_PROPS) {
      const v = mine[p]
      if (!v) continue
      const reference = parent ? parent[p] : ROOT_INITIAL[p]
      if (v !== reference) bake.push([p, v])
    }
    for (const [p, initial] of Object.entries(NON_INHERITED_INITIAL)) {
      const v = mine[p]
      if (v && v !== initial) bake.push([p, v])
    }

    const style = (el as SVGElement & ElementCSSInlineStyle).style
    for (const [name, value] of styleFixes) {
      if (value === null) style.removeProperty(name)
      else style.setProperty(name, value)
    }
    if (style && !style.length) el.removeAttribute('style')
    for (const [name, value] of attrFixes) {
      if (value === null) el.removeAttribute(name)
      else el.setAttribute(name, value)
    }
    for (const p of ALL_PROPS) el.removeAttribute(p)
    for (const [p, v] of bake) el.setAttribute(p, v)
  }
}

// ─── 尺寸、底色、序列化 ─────────────────────────────────

/** 图的用户坐标框：viewBox 优先，没有就用 width/height，再没有就量内容 */
function figureBox(svg: SVGSVGElement): { x: number; y: number; width: number; height: number } {
  const vb = svg.viewBox?.baseVal
  if (vb && vb.width > 0 && vb.height > 0) {
    return { x: vb.x, y: vb.y, width: vb.width, height: vb.height }
  }
  const w = parseFloat(svg.getAttribute('width') ?? '')
  const h = parseFloat(svg.getAttribute('height') ?? '')
  if (w > 0 && h > 0) return { x: 0, y: 0, width: w, height: h }
  try {
    const bb = svg.getBBox()
    if (bb.width > 0 && bb.height > 0)
      return { x: bb.x, y: bb.y, width: bb.width, height: bb.height }
  } catch {
    // 量不出来（没布局）就落到下面的缺省
  }
  return { x: 0, y: 0, width: 300, height: 150 }
}

/**
 * 补齐「独立文件」要的东西并序列化：固定宽高（= 坐标框，查看器按这个尺寸打开）、viewBox、
 * 可选的底色矩形；去掉页面里排版用的 `width="100%"` / `max-width`（mermaid 带的）。
 */
function finalize(svg: SVGSVGElement, background: ParsedColor | null): StandaloneSvg {
  const box = figureBox(svg)
  const round = (n: number): string => String(Math.round(n * 100) / 100)
  svg.setAttribute(
    'viewBox',
    `${round(box.x)} ${round(box.y)} ${round(box.width)} ${round(box.height)}`
  )
  svg.setAttribute('width', round(box.width))
  svg.setAttribute('height', round(box.height))
  const style = (svg as SVGSVGElement & ElementCSSInlineStyle).style
  if (style) {
    style.removeProperty('max-width')
    style.removeProperty('width')
    style.removeProperty('height')
    if (!style.length) svg.removeAttribute('style')
  }
  if (background) {
    const rect = document.createElementNS(SVG_NS, 'rect')
    rect.setAttribute('x', round(box.x))
    rect.setAttribute('y', round(box.y))
    rect.setAttribute('width', round(box.width))
    rect.setAttribute('height', round(box.height))
    rect.setAttribute('fill', background.hex)
    if (background.alpha < 1) rect.setAttribute('fill-opacity', formatOpacity(background.alpha))
    // 显式写死描边与不透明度：根上可能烘焙了 stroke，底色矩形不该继承一圈边框
    rect.setAttribute('stroke', 'none')
    svg.insertBefore(rect, svg.firstChild)
  }
  return {
    svg: new XMLSerializer().serializeToString(svg),
    width: box.width,
    height: box.height
  }
}

/** 把一段（已净化的）SVG 标记挂进容器，返回其中的根 <svg> */
function mountMarkup(box: HTMLElement, markup: string): SVGSVGElement {
  // 标记已经过 sanitizeAuthoredSvg / sanitizeRenderedSvg（与屏幕上那份同一份产物），
  // 这里只是再挂一次：离屏、透明、不可交互，挂完即摘
  box.innerHTML = markup
  const svg = box.querySelector('svg')
  if (!svg) throw new Error('No <svg> element in the figure')
  return svg
}

/**
 * 手写图（```svg 围栏 / svg 产物）→ 独立 SVG。
 *
 * `markup` 必须是屏幕上那份**净化过的**标记；`themeId` 决定按哪套主题取色；
 * `surface` 给出底色取自哪一层（null = 透明）。
 */
export function bakeAuthoredSvg(
  markup: string,
  opts: { themeId: string; surface: FigureSurface | null; inheritFrom?: Element | null }
): StandaloneSvg {
  return withOffscreen(opts.themeId, opts.inheritFrom, (box) => {
    const svg = mountMarkup(box, markup)
    const bg = opts.surface ? resolveColorIn(box, SURFACE_CSS[opts.surface]) : null
    bakeComputedStyles(svg)
    return finalize(svg, bg)
  })
}

/**
 * 已是具体颜色的 SVG（mermaid 的产物）→ 独立 SVG：不烘焙，只补尺寸 / 底色、按 XML 序列化。
 * 底色可以是一层 surface（按 themeId 解析），也可以是一个写死的颜色（笔记本里白底卡片上的 mermaid）。
 */
export function standaloneSvg(
  markup: string,
  opts: { themeId: string; background: FigureSurface | string | null }
): StandaloneSvg {
  return withOffscreen(opts.themeId, null, (box) => {
    const svg = mountMarkup(box, markup)
    const bg =
      opts.background === null
        ? null
        : opts.background === 'card' || opts.background === 'page'
          ? resolveColorIn(box, SURFACE_CSS[opts.background])
          : resolveColorIn(box, opts.background)
    return finalize(svg, bg)
  })
}

/**
 * 手写图的图源：对话的 ```svg / svg 产物（底色 = 图卡）与笔记本的 ```svg（底色 = 页面）共用。
 * `markup` 是屏幕上那份净化过的标记；`inheritFrom` 是放图的那一格（取它的字体，见 withOffscreen）。
 */
export function authoredFigureSource(
  markup: string,
  opts: { name?: string | null; surface: FigureSurface; inheritFrom?: () => Element | null }
): FigureExportSource {
  return {
    name: opts.name ?? figureLabelOf(markup),
    build: async ({ themeId, background }) =>
      bakeAuthoredSvg(markup, {
        themeId,
        surface: background ? opts.surface : null,
        inheritFrom: opts.inheritFrom?.() ?? null
      })
  }
}

/** 图自己写的名字：根上的 aria-label，或根的 <title> —— 作图契约要求写前者 */
export function figureLabelOf(markup: string): string | null {
  if (typeof DOMParser === 'undefined') return null
  const doc = new DOMParser().parseFromString(markup, 'text/html')
  const svg = doc.body?.querySelector('svg')
  if (!svg) return null
  const label = svg.getAttribute('aria-label')?.trim()
  if (label) return label
  // 只认根自己的 <title>（与产物存储的 titleOf 同一条）：图里某个柱子的悬停提示不是图的名字
  const title = svg.querySelector(':scope > title')?.textContent?.trim()
  return title || null
}

// ─── 文件 ─────────────────────────────────────────────

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>\n'

/** SVG 文件内容 */
export function svgFileBlob(fig: StandaloneSvg): Blob {
  return new Blob([XML_DECLARATION, fig.svg, '\n'], { type: 'image/svg+xml;charset=utf-8' })
}

/**
 * SVG → 位图。按目标像素尺寸画（SVG 图像在 drawImage 时按目标尺寸重新栅格化，所以 3x 是真清晰，
 * 不是放大模糊）。净化保证了图里没有外部资源，画布不会被污染、toBlob 一定读得出来。
 */
export async function rasterizeFigure(
  fig: StandaloneSvg,
  format: Exclude<FigureFormat, 'svg'>,
  scale: number
): Promise<Blob> {
  const s = effectiveScale(fig.width, fig.height, scale)
  if (!s) throw new Error('The figure has no size')
  const size = rasterSize(fig.width, fig.height, s)
  const img = new Image()
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(fig.svg)}`
  await img.decode()
  const canvas = document.createElement('canvas')
  canvas.width = size.width
  canvas.height = size.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas is not available')
  // JPG 没有透明：底色矩形本来就在图里（面板对 JPG 强制带底色），这一层白底只兜「图的底色本身
  // 半透明」那一种 —— 不垫的话透明处会编码成黑色
  if (format === 'jpg') {
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, size.width, size.height)
  }
  ctx.drawImage(img, 0, 0, size.width, size.height)
  return await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Image encoding failed'))),
      format === 'jpg' ? 'image/jpeg' : 'image/png',
      0.92
    )
  )
}

/**
 * 落盘：Blob + anchor download。桌面端（Electron 主会话没有 will-download 拦截）弹系统「另存为」，
 * Chrome 侧边栏走浏览器下载 —— 与会话导出（useSessionExport）同一条路，不新开 IPC。
 */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  // 立刻 revoke 在 Chromium 里也成立（click 时下载已经取到了 URL），留一拍只是更稳
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/**
 * 以 PNG 写进剪贴板。ClipboardItem 收的是 Promise：在点击的那一拍里同步构造，编码在后面完成 ——
 * 等编码完再构造的话，有的环境会因为「用户手势已过期」拒绝写入。
 */
export async function copyPngToClipboard(png: Promise<Blob>): Promise<void> {
  if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) {
    throw new Error('Clipboard images are not supported here')
  }
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
}
