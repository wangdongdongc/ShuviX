// @vitest-environment jsdom
/**
 * `renderMermaidFigure` —— 帧候选 → 渲染 → 手写档净化（DOM 半，jsdom）。帧候选本身在
 * `mermaidFence.test.ts`（node）。
 *
 * ⚠️ 环境指令必须留在文件最顶端：没有 DOMParser 时 `sanitizeAuthoredSvg` 一律返回 ''（失败关闭），
 * 于是「净化通过」的每条断言都会变成「净化失败」—— 放错环境不会空转变绿，但会整片红得莫名其妙。
 *
 * 两半：
 *  - **A. 假渲染器**（MR）：记下每次调用的 (source, options)，按用例脚本成功 / 抛错。钉的是
 *    「第一个画得出来的候选就是这一帧」、开着的围栏永不出 `{error}`、48 次上限、fitWidth 只在
 *    放不下时重排一次、净化失败关闭；
 *  - **B. 真 pele**（MP）：产物过手写档后**完好**（类名、`--pele-*` 变量、元素一个不少）、无障碍
 *    引用跟着 id 隔离一起改写、链接关掉、按栏宽重排、错误文案、开着的 subgraph 补 `end` 出帧。
 *
 * 真 pele 走 `pele/lazy`：类型注册是本文件的模块级状态。beforeAll 只加载 flowchart ——
 * MP-5 的「gantt 没加载」依赖本文件别处从不加载 gantt。
 * jsdom 的画布：`getContext` 桩成 null，pele 退回自己的字宽表，量出来的尺寸是确定的。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { load, render as peleRender } from 'pele/lazy'

import {
  MERMAID_FENCE_LANG,
  MERMAID_RENDER_OPTIONS,
  renderMermaidFigure,
  type MermaidEngine,
  type MermaidRenderOptions
} from './mermaidFence'
import { sanitizeAuthoredSvg, SVG_MAX_LENGTH } from './svgSanitize'

const realGetContext = HTMLCanvasElement.prototype.getContext

beforeAll(async () => {
  HTMLCanvasElement.prototype.getContext = (() =>
    null) as unknown as typeof HTMLCanvasElement.prototype.getContext
  await load('flowchart')
})

afterAll(() => {
  HTMLCanvasElement.prototype.getContext = realGetContext
})

// ───────────────────────── A. 假渲染器 ─────────────────────────

/** 渲染器一次调用的结果：一张图，或抛出的东西 */
type Outcome = { svg?: string; width?: number; height?: number } | { throw: unknown }

/** 一个记录调用的假渲染器；`script` 按 (source, options) 决定这一次的结果 */
function fakeEngine(
  script: (source: string, options: MermaidRenderOptions) => Outcome
): MermaidEngine & {
  calls: Array<{ source: string; options: MermaidRenderOptions }>
} {
  const calls: Array<{ source: string; options: MermaidRenderOptions }> = []
  return {
    calls,
    render(source, options) {
      calls.push({ source, options })
      const out = script(source, options)
      if ('throw' in out) throw out.throw
      const width = out.width ?? 100
      const height = out.height ?? 50
      return {
        svg: out.svg ?? `<svg viewBox="0 0 ${width} ${height}"><rect/></svg>`,
        width,
        height
      }
    }
  }
}

const FONT = { fontFamily: 'Test Sans', fontSize: 13 }

describe('A. renderMermaidFigure 对假渲染器（MR）', () => {
  it('MR-1 闭合、成功：figure = 净化后的产物 + 渲染器报的宽高；只调一次，选项 = 固定选项 + 字体，不带 maxWidth', () => {
    const raw = '<svg viewBox="0 0 120 40"><rect/></svg>'
    const engine = fakeEngine(() => ({ svg: raw, width: 120, height: 40 }))
    const r = renderMermaidFigure(engine, 'graph TD\n  a-->b', { closed: true, ...FONT })
    expect(r).toEqual({ figure: { svg: sanitizeAuthoredSvg(raw), width: 120, height: 40 } })
    expect(engine.calls).toHaveLength(1)
    expect(engine.calls[0].source).toBe('graph TD\n  a-->b')
    expect(engine.calls[0].options).toEqual({ ...MERMAID_RENDER_OPTIONS, ...FONT })
    expect('maxWidth' in engine.calls[0].options).toBe(false)
  })

  it('MR-2 闭合、抛错：{ error: message }；抛的是字符串就原样当文案', () => {
    const e1 = fakeEngine(() => ({ throw: new Error('boom') }))
    expect(renderMermaidFigure(e1, 'graph TD\n  a-->b', { closed: true, ...FONT })).toEqual({
      error: 'boom'
    })
    const e2 = fakeEngine(() => ({ throw: 'str' }))
    expect(renderMermaidFigure(e2, 'graph TD\n  a-->b', { closed: true, ...FONT })).toEqual({
      error: 'str'
    })
  })

  it('MR-3 失败关闭：净化剥空 → SVG sanitization failed，原始标记一个字都不进结果；剥掉 on* 的图照常出', () => {
    const evil = '<svg><script>x</script></svg>'
    const e1 = fakeEngine(() => ({ svg: evil }))
    const r1 = renderMermaidFigure(e1, 'graph TD\n  a-->b', { closed: true, ...FONT })
    expect(r1).toEqual({ error: 'SVG sanitization failed' })
    expect(JSON.stringify(r1)).not.toContain('<script')

    const e2 = fakeEngine(() => ({ svg: '<svg><rect onclick="x"/></svg>' }))
    const r2 = renderMermaidFigure(e2, 'graph TD\n  a-->b', { closed: true, ...FONT })
    expect(r2 && 'figure' in r2).toBe(true)
    const svg = (r2 as { figure: { svg: string } }).figure.svg
    expect(svg).toContain('<rect')
    expect(svg).not.toContain('onclick')
  })

  it('MR-4 开着、画不出来：null（永不出 {error}）；不足两行内容时渲染器一次都不调', () => {
    const e1 = fakeEngine(() => ({ throw: new Error('nope') }))
    expect(
      renderMermaidFigure(e1, 'graph TD\n  a-->b\n  b-->c\n  x', { closed: false, ...FONT })
    ).toBeNull()
    expect(e1.calls.length).toBeGreaterThan(0)

    const e2 = fakeEngine(() => ({}))
    expect(renderMermaidFigure(e2, 'graph TD\n  a-->', { closed: false, ...FONT })).toBeNull()
    expect(e2.calls).toHaveLength(0)
  })

  it('MR-5 开着：第一个画得出来的候选就是这一帧 —— 试到补 end 那一个就停', () => {
    const code = 'graph TD\n  subgraph S\n  a-->b\n  c'
    const base = 'graph TD\n  subgraph S\n  a-->b'
    const engine = fakeEngine((source) =>
      source.endsWith('\nend') ? { width: 80, height: 30 } : { throw: new Error('unclosed') }
    )
    const r = renderMermaidFigure(engine, code, { closed: false, ...FONT })
    expect(engine.calls.map((c) => c.source)).toEqual([base, `${base}\nend`])
    expect(r).toEqual({
      figure: {
        svg: sanitizeAuthoredSvg('<svg viewBox="0 0 80 30"><rect/></svg>'),
        width: 80,
        height: 30
      }
    })
  })

  it('MR-6 往回退：带坏行的那几截全失败，退到坏行之前那一截出帧', () => {
    const engine = fakeEngine(
      (source): Outcome =>
        source.split('\n').includes(' c -->') ? { throw: new Error('bad') } : {}
    )
    const r = renderMermaidFigure(engine, 'graph TD\n a-->b\n c -->\n d', {
      closed: false,
      ...FONT
    })
    expect(r && 'figure' in r).toBe(true)
    const winner = engine.calls.at(-1)!.source
    expect(winner.startsWith('graph TD\n a-->b')).toBe(true)
    expect(winner).not.toContain('c -->')
  })

  it('MR-7 上限：开着的病态源码最多试 48 次，然后 null；闭合的只试 1 次', () => {
    const code = [
      'graph TD',
      ...Array.from({ length: 19 }, (_, i) => `  n${i} --> n${i + 1}`)
    ].join('\n')
    const open = fakeEngine(() => ({ throw: new Error('never') }))
    expect(renderMermaidFigure(open, code, { closed: false, ...FONT })).toBeNull()
    expect(open.calls).toHaveLength(48)

    const closed = fakeEngine(() => ({ throw: new Error('never') }))
    expect(renderMermaidFigure(closed, code, { closed: true, ...FONT })).toEqual({ error: 'never' })
    expect(closed.calls).toHaveLength(1)
  })

  describe('MR-8 fitWidth', () => {
    /** 自然 800 宽；带 maxWidth 时按它重排成窄高的一张 */
    const wideEngine = (): ReturnType<typeof fakeEngine> =>
      fakeEngine((_s, o) =>
        o.maxWidth ? { width: o.maxWidth - 20, height: 900 } : { width: 800, height: 200 }
      )

    it('(a) 自然宽放不下：同一段源码带 maxWidth 再渲一次，结果取窄的那张', () => {
      const engine = wideEngine()
      const r = renderMermaidFigure(engine, 'graph LR\n  a-->b', {
        closed: true,
        ...FONT,
        fitWidth: 500
      })
      expect(engine.calls).toHaveLength(2)
      expect(engine.calls[1].source).toBe(engine.calls[0].source)
      expect(engine.calls[1].options).toEqual({ ...MERMAID_RENDER_OPTIONS, ...FONT, maxWidth: 500 })
      // 缩到 500/800 = 0.625 仍读得清：保持作者写的方向，不抬改竖排的断点
      expect('directionBreakpoint' in engine.calls[1].options).toBe(false)
      expect(r).toMatchObject({ figure: { width: 480, height: 900 } })
    })

    it('(e) 整张缩进来就读不清（600/2000 < 0.6）：重排时把改竖排的断点抬到栏宽之上（fitWidth + 1）', () => {
      const engine = fakeEngine((_s, o) =>
        o.maxWidth ? { width: 300, height: 1500 } : { width: 2000, height: 100 }
      )
      const r = renderMermaidFigure(engine, 'graph LR\n  a-->b', {
        closed: true,
        ...FONT,
        fitWidth: 600
      })
      expect(engine.calls).toHaveLength(2)
      expect('directionBreakpoint' in engine.calls[0].options).toBe(false)
      expect(engine.calls[1].options).toEqual({
        ...MERMAID_RENDER_OPTIONS,
        ...FONT,
        maxWidth: 600,
        directionBreakpoint: 601
      })
      expect(r).toMatchObject({ figure: { width: 300, height: 1500 } })
    })

    it('(b) 放得下（≤ fitWidth）：只渲一次', () => {
      const engine = fakeEngine(() => ({ width: 500, height: 100 }))
      renderMermaidFigure(engine, 'graph LR\n  a-->b', { closed: true, ...FONT, fitWidth: 500 })
      expect(engine.calls).toHaveLength(1)
    })

    it('(c) fitWidth 为 0 / 不给：只渲一次', () => {
      for (const fitWidth of [0, undefined]) {
        const engine = wideEngine()
        const r = renderMermaidFigure(engine, 'graph LR\n  a-->b', {
          closed: true,
          ...FONT,
          fitWidth
        })
        expect(engine.calls).toHaveLength(1)
        expect(r).toMatchObject({ figure: { width: 800, height: 200 } })
      }
    })

    it('(d) 按窄栏重排抛错：不算失败，返回自然尺寸那张', () => {
      const engine = fakeEngine((_s, o) =>
        o.maxWidth ? { throw: new Error('narrow failed') } : { width: 800, height: 200 }
      )
      const r = renderMermaidFigure(engine, 'graph LR\n  a-->b', {
        closed: true,
        ...FONT,
        fitWidth: 500
      })
      expect(engine.calls).toHaveLength(2)
      expect(r).toMatchObject({ figure: { width: 800, height: 200 } })
    })
  })

  it('MR-9 净化剥空：开着时接着试下一个候选；闭合时就是失败', () => {
    const code = 'graph TD\n  subgraph S\n  a-->b\n  c'
    const script = (source: string): Outcome =>
      source.endsWith('\nend')
        ? { width: 70, height: 20 }
        : { svg: '<svg><script>x</script></svg>' }
    const open = fakeEngine(script)
    const r1 = renderMermaidFigure(open, code, { closed: false, ...FONT })
    expect(open.calls).toHaveLength(2)
    expect(r1).toMatchObject({ figure: { width: 70, height: 20 } })

    const closed = fakeEngine(() => ({ svg: '<svg><script>x</script></svg>' }))
    expect(renderMermaidFigure(closed, code, { closed: true, ...FONT })).toEqual({
      error: 'SVG sanitization failed'
    })
  })

  it('MR-10 常量：固定渲染选项 / 长度上限 / 围栏语言名', () => {
    expect(MERMAID_RENDER_OPTIONS).toEqual({
      links: false,
      images: false,
      outputLimit: SVG_MAX_LENGTH,
      idPrefix: 'mermaid'
    })
    expect(SVG_MAX_LENGTH).toBe(256 * 1024)
    expect(MERMAID_FENCE_LANG).toBe('mermaid')
  })
})

// ───────────────────────── B. 真 pele ─────────────────────────

const pele: MermaidEngine = { render: peleRender }

/** 把一张图的 svg 挂进文档（a11y 引用要按文档解析），返回根 <svg> */
function mountFigure(svg: string): SVGSVGElement {
  const host = document.createElement('div')
  host.innerHTML = svg
  document.body.appendChild(host)
  return host.querySelector('svg')!
}

const figureOf = (
  r: ReturnType<typeof renderMermaidFigure>
): { svg: string; width: number; height: number } => {
  if (!r || !('figure' in r)) throw new Error(`没出图：${JSON.stringify(r)}`)
  return r.figure
}

describe('B. renderMermaidFigure 对真 pele（MP）', () => {
  it('MP-1 流程图过手写档后完好：类名、--pele-* 变量、元素一个不少、两个节点、无 <style> / <foreignObject> / url(', () => {
    const code = 'graph TD\n  a-->b'
    const raw = peleRender(code, { ...MERMAID_RENDER_OPTIONS, ...FONT })
    const fig = figureOf(renderMermaidFigure(pele, code, { closed: true, ...FONT }))
    expect(fig.svg).not.toBe('')
    expect(fig.width).toBe(raw.width)
    expect(fig.height).toBe(raw.height)

    const doc = new DOMParser().parseFromString(fig.svg, 'text/html')
    const root = doc.body.querySelector('svg')!
    expect(root.getAttribute('class')).toBe('pele pele-flowchart')
    expect(root.getAttribute('style')).toContain('--_bg:var(--pele-bg')
    const rawDoc = new DOMParser().parseFromString(raw.svg, 'text/html')
    expect(root.querySelectorAll('*').length).toBe(
      rawDoc.body.querySelector('svg')!.querySelectorAll('*').length
    )
    expect(root.querySelectorAll('.pele-node')).toHaveLength(2)
    expect(fig.svg).not.toMatch(/<style|<foreignObject|url\(/i)
  })

  it('MP-2 无障碍引用随 id 隔离改写：指得到自己的 <title> / <desc>；同页两张图各指各的', () => {
    const a = figureOf(
      renderMermaidFigure(pele, 'flowchart TD\n accTitle: My Flow\n accDescr: d\n A-->B', {
        closed: true,
        ...FONT
      })
    )
    const b = figureOf(
      renderMermaidFigure(pele, 'flowchart TD\n accTitle: Other\n accDescr: e\n X-->Y', {
        closed: true,
        ...FONT
      })
    )
    try {
      const ra = mountFigure(a.svg)
      const rb = mountFigure(b.svg)
      const refs = (root: SVGSVGElement): [string, string] => [
        root.getAttribute('aria-labelledby')!,
        root.getAttribute('aria-describedby')!
      ]
      const [ta, da] = refs(ra)
      const [tb, db] = refs(rb)
      expect(ta).not.toBe('mermaid-title')
      expect(da).not.toBe('mermaid-desc')
      expect(ta).not.toBe(tb)
      expect(da).not.toBe(db)

      const title = (ref: string): Element | null => document.querySelector(`#${ref}`)
      expect(title(ta)?.tagName.toLowerCase()).toBe('title')
      expect(title(ta)?.textContent).toBe('My Flow')
      expect(title(ta)?.parentElement).toBe(ra)
      expect(title(da)?.tagName.toLowerCase()).toBe('desc')
      expect(title(da)?.textContent).toBe('d')
      expect(title(tb)?.textContent).toBe('Other')
      expect(title(tb)?.parentElement).toBe(rb)
      expect(title(db)?.textContent).toBe('e')
    } finally {
      document.body.innerHTML = ''
    }
  })

  it('MP-3 链接关掉：click 指令的地址不进产物，也没有 <a>', () => {
    const fig = figureOf(
      renderMermaidFigure(pele, 'flowchart TD\n  A-->B\n  click A "https://evil.example"', {
        closed: true,
        ...FONT
      })
    )
    expect(fig.svg).not.toContain('evil.example')
    expect(fig.svg).not.toContain('<a')
  })

  it('MP-4 真 fitWidth：横向 6 节点链按 300 宽重排 → 宽 ≤ 300，比自然尺寸高', () => {
    const code = 'flowchart LR\n  A-->B-->C-->D-->E-->F'
    const natural = figureOf(renderMermaidFigure(pele, code, { closed: true, ...FONT }))
    expect(natural.width).toBeGreaterThan(300)
    const fit = figureOf(renderMermaidFigure(pele, code, { closed: true, ...FONT, fitWidth: 300 }))
    expect(fit.width).toBeLessThanOrEqual(300)
    expect(fit.height).toBeGreaterThan(natural.height)
  })

  it('MP-4b 真 pele：长标签的横向 10 节点链在 664 宽的栏里读不清 → 改成竖排（比 664 窄、比自然尺寸高）', () => {
    const labels = Array.from({ length: 10 }, (_, i) => `n${i}[Step ${i} with a fairly long label]`)
    const code = `flowchart LR\n  ${labels.join(' --> ')}`
    const natural = figureOf(renderMermaidFigure(pele, code, { closed: true, ...FONT }))
    // 前提：自然宽度确实让 664 / 自然宽 < 0.6（否则走的是「保持方向」那一支）
    expect(664 / natural.width).toBeLessThan(0.6)
    const fit = figureOf(renderMermaidFigure(pele, code, { closed: true, ...FONT, fitWidth: 664 }))
    expect(fit.width).toBeLessThan(664)
    expect(fit.height).toBeGreaterThan(natural.height)

    // 竖排：节点沿 y 铺开，x 几乎不动（读节点的 translate）
    const doc = new DOMParser().parseFromString(fit.svg, 'text/html')
    const pos = Array.from(doc.querySelectorAll('.pele-node')).map((n) => {
      const m = /translate\(([-\d.]+),\s*([-\d.]+)\)/.exec(n.getAttribute('transform') ?? '')
      return { x: Number(m?.[1]), y: Number(m?.[2]) }
    })
    expect(pos).toHaveLength(10)
    const spread = (vs: number[]): number => Math.max(...vs) - Math.min(...vs)
    expect(spread(pos.map((p) => p.y))).toBeGreaterThan(spread(pos.map((p) => p.x)))
  })

  it('MP-5 错误文案：解析错误带 Parse error；没加载的图类型带 not supported', () => {
    const r1 = renderMermaidFigure(pele, 'graph TD\n  a -->', { closed: true, ...FONT })
    expect(r1 && 'error' in r1 ? r1.error : '').toContain('Parse error')
    const r2 = renderMermaidFigure(
      pele,
      'gantt\n  title G\n  dateFormat YYYY-MM-DD\n  section S\n  t1 :a1, 2024-01-01, 3d',
      { closed: true, ...FONT }
    )
    expect(r2 && 'error' in r2 ? r2.error : '').toContain('not supported')
  })

  it('MP-6 开着的 subgraph：补 end 出帧 —— 已写完的节点都在，写到一半的那一行不在', () => {
    const fig = figureOf(
      renderMermaidFigure(pele, 'flowchart TD\n  a --> b\n  subgraph S\n  c --> d\n  e', {
        closed: false,
        ...FONT
      })
    )
    const doc = new DOMParser().parseFromString(fig.svg, 'text/html')
    const ids = Array.from(doc.querySelectorAll('.pele-node')).map((n) => n.getAttribute('data-id'))
    expect(ids).toEqual(expect.arrayContaining(['a', 'b', 'c', 'd']))
    expect(ids).not.toContain('e')
  })
})
