// @vitest-environment jsdom
/**
 * 图导出的 DOM 半（figureExport.ts）—— jsdom。
 *
 * 主轴是**烘焙**：手写图的颜色是 `var(--viz-*)` / `var(--theme-*)`，出了 ShuviX 一个都解析不到，
 * 所以导出把图挂进离屏容器、逐元素读计算样式、写成具体值。这里钉的是「读到什么 → 写成什么」：
 *
 *   - 离屏容器（FX-1/2）：挂在 body 上、带主题、视口外透明但**不** display:none（getBBox 要布局）；
 *     跑完 / 抛错都摘掉；字体从放图那一格抄过来；
 *   - 颜色（FX-3…11）：`#rrggbb` + 颜色自带的 alpha 乘进对应的不透明度属性（SVG 1.1 的写法）；
 *     继承属性只在与父元素**乘过之后**的值不同时才写；`url()` 只留片段；表外带 token 的属性 /
 *     style 声明换成计算值或删掉 —— 产物里一个 `var(` 都不能留；
 *   - 尺寸 / 底色 / 序列化（FX-12…17）：固定 width/height = viewBox、底色矩形、合法 XML；
 *   - 名字、文件、剪贴板（FX-18…23）。
 *
 * 桩的形状（jsdom 不做级联，计算样式全靠桩）：
 *   - `getComputedStyle`：每个 SVG 元素按自己的 `data-k` 在一张表里查**它自己写的那几项**，没写的
 *     继承项从父元素（同样按表算）抄、非继承项取初值 —— 于是桩给出的是 Chromium 那样的**完整**
 *     计算记录（初值 fill 是 `rgb(0, 0, 0)`、stroke 是 `none` …），而不是只有被问到的那一项；
 *   - 探针 `<span>`（离屏容器里解析底色用的那个）：按 `closest('[data-theme]')` 的主题 + 探针上写的
 *     CSS 表达式查表 —— 测试看得见「底色是按哪套主题取的」；
 *   - `SVGSVGElement.viewBox`：jsdom 没有，按属性解析出 `baseVal`；画布 `getContext` 回 null
 *     （jsdom 没有画布，认不出的颜色于是原样留下 —— FX-10 钉的就是这一支）。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  authoredFigureSource,
  bakeAuthoredSvg,
  bakeComputedStyles,
  copyPngToClipboard,
  downloadBlob,
  figureLabelOf,
  rasterizeFigure,
  standaloneSvg,
  svgFileBlob,
  withOffscreen
} from '../figureExport'
import { parseCssColor } from '../figureExportPure'

// ─── 计算样式桩 ──────────────────────────────────────────────

type Rec = Record<string, string>

/** 初值（Chromium 的计算值形状） */
const INITIAL: Rec = {
  fill: 'rgb(0, 0, 0)',
  'fill-opacity': '1',
  'fill-rule': 'nonzero',
  stroke: 'none',
  'stroke-opacity': '1',
  'stroke-width': '1px',
  'stroke-dasharray': 'none',
  'stroke-dashoffset': '0px',
  'stroke-linecap': 'butt',
  'stroke-linejoin': 'miter',
  'font-family': 'Test Sans',
  'font-size': '16px',
  'font-style': 'normal',
  'font-weight': '400',
  'line-height': 'normal',
  'letter-spacing': 'normal',
  'text-anchor': 'start',
  'dominant-baseline': 'auto',
  'paint-order': 'normal',
  'font-variant-numeric': 'normal',
  color: 'rgb(0, 0, 0)',
  opacity: '1',
  'stop-color': 'rgb(0, 0, 0)',
  'stop-opacity': '1',
  'flood-color': 'rgb(0, 0, 0)',
  'flood-opacity': '1'
}
/** 会继承的那几项（其余取初值） */
const INHERITED = new Set([
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
  'line-height',
  'letter-spacing',
  'text-anchor',
  'dominant-baseline',
  'paint-order',
  'font-variant-numeric',
  'color'
])

/** data-k → 这个元素**自己**的计算值（用例各自拨） */
let table: Record<string, Rec> = {}

/** 主题 → 探针表达式 → 计算出的颜色；'' 键是「根上那套主题」 */
const SURFACES: Record<string, Rec> = {
  ROOT: { card: 'rgb(30, 31, 32)', page: 'rgb(10, 11, 12)' },
  L: { card: 'rgb(240, 241, 242)', page: 'rgb(255, 255, 255)' },
  D: { card: 'rgb(40, 41, 42)', page: 'rgb(13, 17, 23)' },
  TRANS: { card: 'rgba(1, 2, 3, 0.5)', page: 'rgba(1, 2, 3, 0.5)' }
}

/** 探针上写的表达式归到哪一层（figureExport 的 SURFACE_CSS 两个配方） */
const surfaceKind = (expr: string): 'card' | 'page' | null =>
  expr.includes('--theme-bg-tertiary')
    ? 'card'
    : expr.includes('--theme-bg-primary')
      ? 'page'
      : null

function computedOf(el: Element): Rec {
  const parent = el.parentElement
  const parentRec = parent && parent.hasAttribute('data-k') ? computedOf(parent) : INITIAL
  const own = table[el.getAttribute('data-k') ?? ''] ?? {}
  const out: Rec = {}
  for (const p of Object.keys(INITIAL)) {
    out[p] = own[p] ?? (INHERITED.has(p) ? parentRec[p] : INITIAL[p])
  }
  for (const [p, v] of Object.entries(own)) out[p] = v
  return out
}

/** 一份「像 CSSStyleDeclaration」的计算记录 */
const declOf = (rec: Rec): Record<string, unknown> => ({
  getPropertyValue: (p: string) => rec[p] ?? '',
  fontFamily: rec['font-family'],
  fontSize: rec['font-size'],
  fontWeight: rec['font-weight'],
  lineHeight: rec['line-height'],
  color: rec.color
})

const realGetComputedStyle = window.getComputedStyle
const realGetContext = HTMLCanvasElement.prototype.getContext

function installStubs(): void {
  window.getComputedStyle = ((el: Element) => {
    if (el.hasAttribute('data-k')) return declOf(computedOf(el))
    if (el.tagName === 'SPAN') {
      // 离屏容器里解析底色的探针
      const expr = (el as HTMLElement).style.color
      const theme = el.closest('[data-theme]')?.getAttribute('data-theme') ?? ''
      const kind = surfaceKind(expr)
      const color = kind ? (SURFACES[theme]?.[kind] ?? `unresolved:${theme}:${kind}`) : expr
      return declOf({ ...INITIAL, color })
    }
    return declOf(INITIAL)
  }) as unknown as typeof window.getComputedStyle
  // jsdom 没有画布：认不出的颜色走不了画布兜底（不让它往控制台喊 not implemented）
  HTMLCanvasElement.prototype.getContext = (() =>
    null) as unknown as typeof HTMLCanvasElement.prototype.getContext
}

beforeAll(() => {
  // jsdom 的 SVGSVGElement 没有 viewBox：按属性解析成 baseVal（没写时与浏览器一样是全 0）
  Object.defineProperty(SVGSVGElement.prototype, 'viewBox', {
    configurable: true,
    get(this: SVGSVGElement) {
      const nums = (this.getAttribute('viewBox') ?? '')
        .trim()
        .split(/[\s,]+/)
        .map(Number)
      const ok = nums.length === 4 && nums.every(Number.isFinite)
      const [x, y, width, height] = ok ? nums : [0, 0, 0, 0]
      return { baseVal: { x, y, width, height } }
    }
  })
})

afterAll(() => {
  delete (SVGSVGElement.prototype as { viewBox?: unknown }).viewBox
})

beforeEach(() => {
  table = {}
  document.documentElement.setAttribute('data-theme', 'ROOT')
  installStubs()
})

afterEach(() => {
  window.getComputedStyle = realGetComputedStyle
  HTMLCanvasElement.prototype.getContext = realGetContext
  document.body.innerHTML = ''
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// ─── 读产物 ──────────────────────────────────────────────────

/** 序列化出来的独立 SVG → 一棵可查询的树（同时就是「它是合法 XML」的检查） */
function parseOut(svg: string): SVGSVGElement {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
  expect(doc.getElementsByTagName('parsererror'), svg).toHaveLength(0)
  return doc.documentElement as unknown as SVGSVGElement
}
const byK = (root: Element, k: string): Element => {
  const el = root.querySelector(`[data-k="${k}"]`)
  if (!el) throw new Error(`产物里没有 data-k="${k}"`)
  return el
}
/** 把一个元素的属性收成对象（data-k 不算） */
const attrsOf = (el: Element): Record<string, string> =>
  Object.fromEntries(
    Array.from(el.attributes)
      .filter((a) => a.name !== 'data-k')
      .map((a) => [a.name, a.value])
  )

const bake = (markup: string, themeId = ''): { svg: string; root: SVGSVGElement } => {
  const out = bakeAuthoredSvg(markup, { themeId, surface: null })
  return { svg: out.svg, root: parseOut(out.svg) }
}

const offscreenBoxes = (): Element[] =>
  Array.from(document.body.querySelectorAll(':scope > div[aria-hidden="true"]'))

/** jsdom 的 Blob 读成文本 */
const blobText = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsText(blob)
  })

// ═══════════════════════════════════════════════════════════════

describe('离屏容器（FX-1/2）', () => {
  it('FX-1 跑的时候挂在 body 上：带主题、aria-hidden、fixed 在视口外、透明；不是 display:none / visibility:hidden', () => {
    let seen: HTMLDivElement | null = null
    const result = withOffscreen('T', null, (box) => {
      seen = box
      expect(box.parentElement).toBe(document.body)
      expect(box.getAttribute('data-theme')).toBe('T')
      expect(box.getAttribute('aria-hidden')).toBe('true')
      expect(box.style.position).toBe('fixed')
      expect(box.style.left).toBe('-100000px')
      expect(box.style.opacity).toBe('0')
      expect(box.style.display).not.toBe('none')
      expect(box.style.visibility).not.toBe('hidden')
      return 42
    })
    expect(result).toBe(42)
    expect(seen!.isConnected).toBe(false)
    expect(offscreenBoxes()).toHaveLength(0)
  })

  it('FX-1 主题给空串 → 不挂 data-theme（沿用根上的）', () => {
    withOffscreen('', null, (box) => {
      expect(box.hasAttribute('data-theme')).toBe(false)
    })
  })

  it('FX-1 fn 抛错：照样摘掉，错误原样抛出', () => {
    const boom = new Error('boom')
    expect(() =>
      withOffscreen('T', null, () => {
        throw boom
      })
    ).toThrow(boom)
    expect(offscreenBoxes()).toHaveLength(0)
  })

  it('FX-2 inheritFrom：字体四项照抄放图那一格的计算值', () => {
    table.cell = {
      'font-family': 'Cell Sans',
      'font-size': '13px',
      'font-weight': '600',
      'line-height': '20px'
    }
    const cell = document.createElement('div')
    cell.setAttribute('data-k', 'cell')
    document.body.appendChild(cell)
    withOffscreen('', cell, (box) => {
      expect(box.style.fontFamily).toBe('Cell Sans')
      expect(box.style.fontSize).toBe('13px')
      expect(box.style.fontWeight).toBe('600')
      expect(box.style.lineHeight).toBe('20px')
    })
  })
})

describe('颜色烘焙（FX-3…11）', () => {
  it('FX-3 token 属性 → 计算出的颜色写成 #rrggbb；产物里不留 var( / light-dark(', () => {
    table.a = { fill: 'rgb(42, 120, 214)' }
    const { svg, root } = bake(
      '<svg data-k="r" viewBox="0 0 10 10"><rect data-k="a" fill="var(--viz-1)" width="10" height="10"/></svg>'
    )
    expect(byK(root, 'a').getAttribute('fill')).toBe('#2a78d6')
    expect(svg).not.toMatch(/var\(|light-dark\(/)
  })

  it('FX-4 颜色自带的 alpha 乘进对应的不透明度（fill 与 stroke 各乘各的）', () => {
    const tint = 'color(srgb 0.165 0.471 0.839 / 0.14)'
    table.a = { fill: tint, stroke: tint }
    table.b = { fill: tint, 'fill-opacity': '0.5', stroke: tint, 'stroke-opacity': '0.5' }
    const { root } = bake(
      '<svg data-k="r" viewBox="0 0 10 10"><rect data-k="a"/><rect data-k="b"/></svg>'
    )
    const a = attrsOf(byK(root, 'a'))
    expect(a.fill).toBe('#2a78d6')
    expect(a['fill-opacity']).toBe('0.14')
    expect(a.stroke).toBe('#2a78d6')
    expect(a['stroke-opacity']).toBe('0.14')
    const b = attrsOf(byK(root, 'b'))
    expect(b['fill-opacity']).toBe('0.07')
    expect(b['stroke-opacity']).toBe('0.07')
  })

  it('FX-5 半透明 tint 写在 <g> 上：换了不透明色的子元素写明 fill-opacity="1"；照继承的子元素什么都不写', () => {
    table.g = { fill: 'color(srgb 0.165 0.471 0.839 / 0.14)' }
    table.c1 = { fill: 'rgb(1, 2, 3)' }
    const { root } = bake(
      '<svg data-k="r" viewBox="0 0 10 10"><g data-k="g" fill="var(--viz-1-tint)">' +
        '<rect data-k="c1" fill="var(--viz-3)"/><rect data-k="c2"/></g></svg>'
    )
    expect(attrsOf(byK(root, 'g'))).toMatchObject({ fill: '#2a78d6', 'fill-opacity': '0.14' })
    // 按原始计算值比的话 c1 的 fill-opacity 也是 1、与父「相同」不写 —— 实心块就成了一层薄雾
    expect(attrsOf(byK(root, 'c1'))).toMatchObject({ fill: '#010203', 'fill-opacity': '1' })
    const c2 = attrsOf(byK(root, 'c2'))
    expect(c2.fill).toBeUndefined()
    expect(c2['fill-opacity']).toBeUndefined()
  })

  it('FX-6 继承属性只写与父不同的；根上的黑填充 / 不透明 / 无描边不写，字体两项总写', () => {
    table.r = { 'font-size': '12px' }
    table.same = { 'font-size': '12px' }
    table.diff = { 'font-size': '14px', 'font-weight': '600' }
    const { root } = bake(
      '<svg data-k="r" viewBox="0 0 10 10"><text data-k="same">a</text><text data-k="diff">b</text></svg>'
    )
    const r = attrsOf(root)
    expect(r['font-family']).toBe('Test Sans')
    expect(r['font-size']).toBe('12px')
    expect(r.fill).toBeUndefined()
    expect(r['fill-opacity']).toBeUndefined()
    expect(r.stroke).toBeUndefined()
    expect(r['stroke-opacity']).toBeUndefined()
    expect(r['font-weight']).toBeUndefined()

    const same = attrsOf(byK(root, 'same'))
    expect(same['font-size']).toBeUndefined()
    expect(same['font-family']).toBeUndefined()
    expect(attrsOf(byK(root, 'diff'))).toMatchObject({ 'font-size': '14px', 'font-weight': '600' })
  })

  it('FX-6 变体：根上写了非初值（描边、填充）就写出来', () => {
    table.r = { fill: 'rgb(255, 0, 0)', stroke: 'rgb(0, 0, 255)', 'stroke-width': '2px' }
    const { root } = bake('<svg data-k="r" viewBox="0 0 10 10"><rect data-k="c"/></svg>')
    expect(attrsOf(root)).toMatchObject({
      fill: '#ff0000',
      stroke: '#0000ff',
      'stroke-width': '2px'
    })
    expect(attrsOf(byK(root, 'c')).fill).toBeUndefined()
  })

  /** FX-7 的图：一个元素的 style 里混着表内属性、表外 token、表外普通声明与自定义属性 */
  const FX7 =
    '<svg data-k="r" viewBox="0 0 10 10">' +
    '<rect data-k="s" style="fill: var(--viz-2); stroke: var(--viz-3); font-variant-numeric: tabular-nums; color: var(--viz-4); --c: var(--viz-1)"/>' +
    '<rect data-k="e" style="fill: var(--viz-1)"/>' +
    '</svg>'
  const fx7Table = (): void => {
    table.s = {
      fill: 'rgb(1, 2, 3)',
      stroke: 'rgb(4, 5, 6)',
      color: 'rgb(10, 20, 30)',
      'font-variant-numeric': 'tabular-nums'
    }
    table.e = { fill: 'rgb(7, 8, 9)' }
  }

  it('FX-7a style 里的表内属性变成表现属性离开 style；自定义属性不留；产物无 var(；只剩 token 的 style 整条删', () => {
    fx7Table()
    const { svg, root } = bake(FX7)
    const s = byK(root, 's') as SVGElement
    expect(s.getAttribute('fill')).toBe('#010203')
    expect(s.getAttribute('stroke')).toBe('#040506')
    const style = s.getAttribute('style') ?? ''
    expect(style).not.toMatch(/(^|;)\s*fill\s*:/)
    expect(style).not.toMatch(/(^|;)\s*stroke\s*:/)
    expect(style).not.toContain('--c')
    expect(svg).not.toMatch(/var\(|light-dark\(/)

    const e = byK(root, 'e')
    expect(e.hasAttribute('style')).toBe(false)
    expect(e.getAttribute('fill')).toBe('#070809')
  })

  it('FX-7 对照：不带 token 的 style 里的普通声明原样留下（表内属性照样搬走）', () => {
    table.p = { fill: 'rgb(1, 2, 3)', 'font-variant-numeric': 'tabular-nums' }
    const { root } = bake(
      '<svg data-k="r" viewBox="0 0 10 10">' +
        '<text data-k="p" style="font-variant-numeric: tabular-nums; fill: rgb(1, 2, 3)">1</text></svg>'
    )
    const p = byK(root, 'p')
    expect(p.getAttribute('fill')).toBe('#010203')
    expect(p.getAttribute('style') ?? '').toMatch(/^\s*font-variant-numeric:\s*tabular-nums;?\s*$/)
  })

  // 回归：planElement 的表外属性循环曾把 `style` 属性本身也当成「带 token 的属性」整条删掉 ——
  // 普通声明（tabular-nums）与换成计算值的 color 一起丢了
  it('FX-7b 带 token 的 style 里：普通声明留下，表外 token 声明（color）换成计算值', () => {
    fx7Table()
    const { root } = bake(FX7)
    const style = byK(root, 's').getAttribute('style') ?? ''
    expect(style).toMatch(/font-variant-numeric:\s*tabular-nums/)
    // 产品写的是 #0a141e；内联样式的序列化器（jsdom 与 Chromium 都是）会把十六进制规范成
    // rgb()，所以按「解析出来是同一个不透明色」比，而不是比字面
    const color = /(?:^|;)\s*color:\s*([^;]+)/.exec(style)?.[1]?.trim() ?? ''
    expect(parseCssColor(color)).toEqual({ hex: '#0a141e', alpha: 1 })
  })

  it('FX-8 url() 的计算值带着文档地址 → 只留片段；fill-opacity 只按自己的不透明度', () => {
    table.u = { fill: 'url("file:///app/index.html#p-g")', 'fill-opacity': '0.5' }
    const { root } = bake(
      '<svg data-k="r" viewBox="0 0 10 10"><rect data-k="u" fill="url(#p-g)"/></svg>'
    )
    expect(attrsOf(byK(root, 'u'))).toMatchObject({ fill: 'url(#p-g)', 'fill-opacity': '0.5' })
  })

  it('FX-9 opacity 非 1 才写；<stop> 的 stop-color / <feFlood> 的 flood-color 也拆成 hex + 不透明度', () => {
    table.half = { opacity: '0.5' }
    table.full = { opacity: '1' }
    table.s1 = { 'stop-color': 'rgba(42, 120, 214, 0.5)', 'stop-opacity': '0.8' }
    table.s2 = { 'stop-color': 'rgb(1, 2, 3)' }
    table.fl = { 'flood-color': 'color(srgb 1 0 0 / 0.25)' }
    const { root } = bake(
      '<svg data-k="r" viewBox="0 0 10 10">' +
        '<rect data-k="half"/><rect data-k="full"/>' +
        '<defs data-k="d"><linearGradient data-k="lg" id="g">' +
        '<stop data-k="s1" offset="0" stop-color="var(--viz-1)"/><stop data-k="s2" offset="1"/>' +
        '</linearGradient><filter data-k="f" id="f"><feFlood data-k="fl"/></filter></defs>' +
        '</svg>'
    )
    expect(byK(root, 'half').getAttribute('opacity')).toBe('0.5')
    expect(byK(root, 'full').hasAttribute('opacity')).toBe(false)
    expect(attrsOf(byK(root, 's1'))).toMatchObject({
      'stop-color': '#2a78d6',
      'stop-opacity': '0.4'
    })
    const s2 = attrsOf(byK(root, 's2'))
    expect(s2['stop-color']).toBe('#010203')
    expect(s2['stop-opacity']).toBeUndefined()
    expect(attrsOf(byK(root, 'fl'))).toMatchObject({
      'flood-color': '#ff0000',
      'flood-opacity': '0.25'
    })
  })

  it('FX-10 认不出、画布也读不了的颜色：原样写回（至少不丢）', () => {
    table.o = { fill: 'oklch(0.6 0.1 250)' }
    const { root } = bake('<svg data-k="r" viewBox="0 0 10 10"><rect data-k="o"/></svg>')
    expect(byK(root, 'o').getAttribute('fill')).toBe('oklch(0.6 0.1 250)')
  })

  it('FX-11 表外属性带 token：`<g color="var(--viz-2)">` + currentColor —— 产物无 var(，g 的 color 写成计算出的 hex', () => {
    table.g = { color: 'rgb(10, 20, 30)' }
    table.c = { fill: 'rgb(10, 20, 30)' }
    const { svg, root } = bake(
      '<svg data-k="r" viewBox="0 0 10 10"><g data-k="g" color="var(--viz-2)">' +
        '<rect data-k="c" fill="currentColor"/></g></svg>'
    )
    expect(svg).not.toMatch(/var\(|light-dark\(/)
    expect(byK(root, 'g').getAttribute('color')).toBe('#0a141e')
    expect(byK(root, 'c').getAttribute('fill')).toBe('#0a141e')
  })

  it('FX-11 变体：表外属性的计算值解析不出来（自定义属性那种）→ 删掉', () => {
    table.g = { 'lighting-color': 'var(--viz-2)' }
    const { svg, root } = bake(
      '<svg data-k="r" viewBox="0 0 10 10"><g data-k="g" lighting-color="var(--viz-2)"><rect data-k="c"/></g></svg>'
    )
    expect(byK(root, 'g').hasAttribute('lighting-color')).toBe(false)
    expect(svg).not.toMatch(/var\(/)
  })

  it('bakeComputedStyles 走遍整棵树：嵌套几层的元素也烘焙到', () => {
    table.deep = { fill: 'rgb(9, 9, 9)' }
    const box = document.createElement('div')
    document.body.appendChild(box)
    box.innerHTML =
      '<svg data-k="r" viewBox="0 0 10 10"><g data-k="g1"><g data-k="g2"><rect data-k="deep" fill="var(--x)"/></g></g></svg>'
    bakeComputedStyles(box.querySelector('svg')!)
    expect(box.querySelector('[data-k="deep"]')!.getAttribute('fill')).toBe('#090909')
  })
})

describe('尺寸、底色、序列化（FX-12…17）', () => {
  it('FX-12 viewBox 写两位小数，width/height = 坐标框；返回值是不取整的宽高', () => {
    const out = bakeAuthoredSvg(
      '<svg data-k="r" viewBox="0 0 320.456 200"><rect data-k="a"/></svg>',
      { themeId: '', surface: null }
    )
    const root = parseOut(out.svg)
    expect(root.getAttribute('viewBox')).toBe('0 0 320.46 200')
    expect(root.getAttribute('width')).toBe('320.46')
    expect(root.getAttribute('height')).toBe('200')
    expect(out.width).toBe(320.456)
    expect(out.height).toBe(200)
  })

  it('FX-12 变体：没有 viewBox 就用 width/height；都没有（量不出来）就 300×150', () => {
    const wh = bakeAuthoredSvg('<svg data-k="r" width="40" height="30"><rect/></svg>', {
      themeId: '',
      surface: null
    })
    expect([wh.width, wh.height]).toEqual([40, 30])
    expect(parseOut(wh.svg).getAttribute('viewBox')).toBe('0 0 40 30')
    const none = bakeAuthoredSvg('<svg data-k="r"><rect/></svg>', { themeId: '', surface: null })
    expect([none.width, none.height]).toEqual([300, 150])
  })

  it('FX-13 surface card：第一个子元素是盖住坐标框的底色矩形（负原点也对），颜色来自探针，stroke=none', () => {
    const out = bakeAuthoredSvg(
      '<svg data-k="r" viewBox="-10 -5 100 50"><rect data-k="a" width="1" height="1"/></svg>',
      { themeId: '', surface: 'card' }
    )
    const root = parseOut(out.svg)
    const bg = root.firstElementChild!
    expect(bg.tagName).toBe('rect')
    expect(bg.hasAttribute('data-k')).toBe(false)
    expect(attrsOf(bg)).toEqual({
      x: '-10',
      y: '-5',
      width: '100',
      height: '50',
      fill: '#1e1f20', // ROOT 的 card
      stroke: 'none'
    })
  })

  it('FX-13 变体：底色本身半透明 → fill-opacity；surface page 取页面那一层；null 没有底色矩形', () => {
    const trans = parseOut(
      bakeAuthoredSvg('<svg data-k="r" viewBox="0 0 10 10"><rect data-k="a"/></svg>', {
        themeId: 'TRANS',
        surface: 'card'
      }).svg
    )
    expect(attrsOf(trans.firstElementChild!)).toMatchObject({
      fill: '#010203',
      'fill-opacity': '0.5'
    })

    const page = parseOut(
      bakeAuthoredSvg('<svg data-k="r" viewBox="0 0 10 10"><rect data-k="a"/></svg>', {
        themeId: '',
        surface: 'page'
      }).svg
    )
    expect(page.firstElementChild!.getAttribute('fill')).toBe('#0a0b0c')

    const none = parseOut(
      bakeAuthoredSvg('<svg data-k="r" viewBox="0 0 10 10"><rect data-k="a"/></svg>', {
        themeId: '',
        surface: null
      }).svg
    )
    expect(none.firstElementChild!.getAttribute('data-k')).toBe('a')
  })

  it('FX-14 themeId 真的挂到了容器上：浅 / 深两套取出的底色不同', () => {
    const fillFor = (themeId: string): string | null =>
      parseOut(
        bakeAuthoredSvg('<svg data-k="r" viewBox="0 0 10 10"><rect data-k="a"/></svg>', {
          themeId,
          surface: 'card'
        }).svg
      ).firstElementChild!.getAttribute('fill')
    expect(fillFor('L')).toBe('#f0f1f2')
    expect(fillFor('D')).toBe('#28292a')
  })

  it('FX-15 standaloneSvg（mermaid 那种）：width="100%" / max-width 去掉，换成数值宽高；空 style 整条删', () => {
    const markup =
      '<svg width="100%" style="max-width: 400px;" viewBox="0 0 400 300"><rect width="10" height="10" fill="#ff0000"/></svg>'
    const out = standaloneSvg(markup, { themeId: '', background: '#333333' })
    const root = parseOut(out.svg)
    expect(root.getAttribute('width')).toBe('400')
    expect(root.getAttribute('height')).toBe('300')
    expect(root.hasAttribute('style')).toBe(false)
    expect(attrsOf(root.firstElementChild!)).toMatchObject({ fill: '#333333', stroke: 'none' })
    // 不烘焙：原来的具体颜色原样
    expect(root.querySelectorAll('rect')[1].getAttribute('fill')).toBe('#ff0000')
    expect([out.width, out.height]).toEqual([400, 300])
  })

  it('FX-15 变体：background card / page 按 themeId 的探针取；null 没有底色', () => {
    const markup = '<svg viewBox="0 0 10 10"><rect/></svg>'
    const card = parseOut(standaloneSvg(markup, { themeId: 'L', background: 'card' }).svg)
    expect(card.firstElementChild!.getAttribute('fill')).toBe('#f0f1f2')
    const page = parseOut(standaloneSvg(markup, { themeId: 'D', background: 'page' }).svg)
    expect(page.firstElementChild!.getAttribute('fill')).toBe('#0d1117')
    const none = parseOut(standaloneSvg(markup, { themeId: '', background: null }).svg)
    expect(none.querySelectorAll('rect')).toHaveLength(1)
  })

  it('FX-16 foreignObject 里的 HTML 按 XML 序列化：<br> 自闭合、根上有 svg 命名空间、能被 XML 解析', () => {
    const out = standaloneSvg(
      '<svg viewBox="0 0 100 40"><foreignObject width="100" height="40"><div>a<br>b</div></foreignObject></svg>',
      { themeId: '', background: null }
    )
    const root = parseOut(out.svg)
    expect(root.namespaceURI).toBe('http://www.w3.org/2000/svg')
    expect(out.svg).toMatch(/^<svg[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/)
    expect(out.svg).toMatch(/<br\s*\/>/)
  })

  it('FX-17 标记里没有 <svg>：抛「No <svg> element in the figure」，离屏容器不留', () => {
    expect(() => bakeAuthoredSvg('<p>not a figure</p>', { themeId: '', surface: null })).toThrow(
      'No <svg> element in the figure'
    )
    expect(() => standaloneSvg('', { themeId: '', background: null })).toThrow(
      'No <svg> element in the figure'
    )
    expect(offscreenBoxes()).toHaveLength(0)
  })
})

describe('名字、图源、文件、剪贴板（FX-18…23）', () => {
  it('FX-18 figureLabelOf：aria-label（trim）优先；空白的 aria-label 落到根自己的 <title>', () => {
    expect(figureLabelOf('<svg aria-label="  Revenue split  "><title>T</title></svg>')).toBe(
      'Revenue split'
    )
    expect(figureLabelOf('<svg aria-label="   "><title> Root title </title><rect/></svg>')).toBe(
      'Root title'
    )
  })

  it('FX-18 图里某个元素自己的 <title>（悬停提示）不是图的名字；什么都没有 / 不是 SVG → null', () => {
    expect(figureLabelOf('<svg viewBox="0 0 4 4"><rect><title>Bar A</title></rect></svg>')).toBe(
      null
    )
    expect(figureLabelOf('<svg viewBox="0 0 4 4"><rect/></svg>')).toBeNull()
    expect(figureLabelOf('<p>hi</p>')).toBeNull()
    expect(figureLabelOf('')).toBeNull()
  })

  it('FX-19 authoredFigureSource：名字给了用给的，没给用 figureLabelOf；inheritFrom 在 build 时才取', async () => {
    const markup = '<svg data-k="r" viewBox="0 0 10 10" aria-label="Probe"><rect data-k="a"/></svg>'
    const named = authoredFigureSource(markup, { name: 'Given', surface: 'card' })
    expect(named.name).toBe('Given')

    const getter = vi.fn(() => null)
    const src = authoredFigureSource(markup, { surface: 'card', inheritFrom: getter })
    expect(src.name).toBe('Probe')
    expect(getter).not.toHaveBeenCalled()

    const bare = await src.build({ scheme: 'current', themeId: '', background: false })
    expect(getter).toHaveBeenCalledTimes(1)
    expect(parseOut(bare.svg).firstElementChild!.getAttribute('data-k')).toBe('a')

    const filled = await src.build({ scheme: 'light', themeId: 'L', background: true })
    expect(getter).toHaveBeenCalledTimes(2)
    expect(parseOut(filled.svg).firstElementChild!.getAttribute('fill')).toBe('#f0f1f2')
  })

  it('FX-20 svgFileBlob：类型带 charset，内容 = XML 声明 + 标记 + 换行', async () => {
    const fig = { svg: '<svg xmlns="http://www.w3.org/2000/svg"/>', width: 1, height: 1 }
    const blob = svgFileBlob(fig)
    expect(blob.type).toBe('image/svg+xml;charset=utf-8')
    expect(await blobText(blob)).toBe(`<?xml version="1.0" encoding="UTF-8"?>\n${fig.svg}\n`)
  })

  it('FX-21 downloadBlob：一次 click、download 名对、href 是那个 blob URL；锚点摘掉；1000ms 后才 revoke 同一个 URL', () => {
    vi.useFakeTimers()
    const create = vi.fn(() => 'blob:stub-1')
    const revoke = vi.fn()
    const urlCtor = URL as unknown as Record<string, unknown>
    const prevCreate = urlCtor.createObjectURL
    const prevRevoke = urlCtor.revokeObjectURL
    urlCtor.createObjectURL = create
    urlCtor.revokeObjectURL = revoke
    const clicks: Array<{ download: string; href: string | null; connected: boolean }> = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement
    ) {
      clicks.push({
        download: this.download,
        href: this.getAttribute('href'),
        connected: this.isConnected
      })
    })
    try {
      const blob = new Blob(['x'], { type: 'image/png' })
      downloadBlob(blob, 'Probe.png')
      expect(create).toHaveBeenCalledWith(blob)
      expect(clicks).toEqual([{ download: 'Probe.png', href: 'blob:stub-1', connected: true }])
      expect(document.querySelectorAll('a')).toHaveLength(0)
      vi.advanceTimersByTime(999)
      expect(revoke).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(revoke).toHaveBeenCalledTimes(1)
      expect(revoke).toHaveBeenCalledWith('blob:stub-1')
    } finally {
      urlCtor.createObjectURL = prevCreate
      urlCtor.revokeObjectURL = prevRevoke
    }
  })

  describe('FX-22 copyPngToClipboard', () => {
    const g = globalThis as unknown as Record<string, unknown>
    let prevItem: unknown
    beforeEach(() => {
      prevItem = g.ClipboardItem
    })
    afterEach(() => {
      g.ClipboardItem = prevItem
      Reflect.deleteProperty(navigator, 'clipboard')
    })

    it('没有 ClipboardItem → 拒绝', async () => {
      delete g.ClipboardItem
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { write: vi.fn() }
      })
      await expect(copyPngToClipboard(Promise.resolve(new Blob()))).rejects.toThrow(
        'Clipboard images are not supported here'
      )
    })

    it('没有 clipboard.write → 拒绝', async () => {
      g.ClipboardItem = class {}
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {} })
      await expect(copyPngToClipboard(Promise.resolve(new Blob()))).rejects.toThrow(
        'Clipboard images are not supported here'
      )
    })

    it('ClipboardItem 拿到的就是传进来的那个 Promise，且在第一次 await 之前同步构造', async () => {
      const made: Array<Record<string, unknown>> = []
      g.ClipboardItem = class {
        constructor(readonly data: Record<string, unknown>) {
          made.push(data)
        }
      }
      const write = vi.fn(async () => undefined)
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write } })
      const png = new Promise<Blob>(() => {
        // 永不落定：剪贴板拿到的是承诺本身，不等编码
      })
      const done = copyPngToClipboard(png)
      // 还没 await 任何东西：构造与 write 都已经发生
      expect(made).toHaveLength(1)
      expect(made[0]['image/png']).toBe(png)
      expect(write).toHaveBeenCalledTimes(1)
      const items = (write.mock.calls[0] as unknown as [unknown[]])[0]
      expect(items).toHaveLength(1)
      expect((items[0] as { data: unknown }).data).toBe(made[0])
      await done
    })
  })

  it('FX-23 rasterizeFigure：没有尺寸 → 拒绝，一张 Image 都不建', async () => {
    const g = globalThis as unknown as Record<string, unknown>
    const prevImage = g.Image
    const ImageSpy = vi.fn()
    g.Image = ImageSpy
    try {
      await expect(
        rasterizeFigure({ svg: '<svg/>', width: 0, height: 100 }, 'png', 2)
      ).rejects.toThrow('The figure has no size')
      await expect(
        rasterizeFigure({ svg: '<svg/>', width: 100, height: Number.NaN }, 'jpg', 2)
      ).rejects.toThrow('The figure has no size')
      expect(ImageSpy).not.toHaveBeenCalled()
    } finally {
      g.Image = prevImage
    }
  })
})
