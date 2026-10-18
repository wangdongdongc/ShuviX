// @vitest-environment jsdom
/**
 * MermaidBlock（```mermaid 代码块 → 图，渲染器是 pele）DOM 测试（jsdom）。组件头注释里的四条就是这里的
 * 几组：
 *
 *   - **缺省显示图**（DF）：同步出图；图类型第一次出现时先「渲染中」，分包加载完才画（DF-2 / LD-1）；
 *   - **流式期间逐帧画**（ST）：围栏开着时丢掉写到一半的最后一行、补尾巴、往回退 —— 帧只在多写完一行
 *     时重算（ST-5），一帧都画不出时是「正在生成」占位；错误卡只在消息写完后出（ST-6 / CB-2）；
 *   - **配色是 token**（TH）：切主题不重渲、连 DOM 都不换；图卡挂着 `data-figure-surface="card"`；
 *   - **限高 + 按栏宽重排 + 放大查看**（LY / FW / EX）：布局规则本身在 mermaidFit.test.ts、帧与重排
 *     规则在 chat-protocol 的 mermaidFence 测试，这里只钉组件把它们落成了什么；
 *   - 失败关闭（ER）、写完的图的缓存（CA）、图 / 源码切换（SV）、CodeBlock 分发（CB）、导出（EXP）。
 *
 * 桩的形状（为什么这么搭）：
 *   - `pele/lazy` **真跑**，只把 `render` / `load` 包成透传的 spy：数得出渲了几次、带了什么选项，
 *     也能让某一次返回 / 加载按用例脚本走（`mockReturnValueOnce` / `mockRejectedValueOnce`）。
 *     类型注册是**本文件的模块级状态**：beforeAll 只加载 flowchart；DF-2 依赖 pie 在本文件里第一次
 *     出现，LD-1 依赖 gantt **永远**加载失败（两次都用 mockRejectedValueOnce 挡在真加载之前）；
 *   - `getComputedStyle` 换成桩：jsdom 不做级联。组件只从 body 读字体；导出面板烘焙时读一份初值记录、
 *     探针颜色读一个固定的 rgb —— 够烘焙跑通（导出本身的烘焙规则在 figure/__tests__ 里测）；
 *   - jsdom 没有画布（pele 退回自己的字宽表，尺寸确定）、没有 ResizeObserver（栏宽恒为 0，走「还没量到」
 *     那一支）。LY-4 / FW 装一个假的，由用例手动报栏宽；
 *   - `SVGSVGElement.viewBox`：jsdom 没有，按属性解析（导出面板的烘焙要它）。
 *
 * ⚠️ 组件的结果缓存 / 视图状态都是**模块级**的，跨用例共享（刻意不 resetModules —— 那正是要测的
 * 东西）。所以每条用例用自己独有的源码（节点名带用例号）。
 *
 * i18n 走真 en 资源；文件是 .tsx 但不写 JSX，一律 createElement（与同目录的 tokenChip 一致）。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

// 透传 spy：真 pele，但数得出次数、看得到选项
vi.mock('pele/lazy', async (importOriginal) => {
  const m = await importOriginal<typeof import('pele/lazy')>()
  return { ...m, render: vi.fn(m.render), load: vi.fn(m.load) }
})
// 透传 spy：看 MermaidBlock 交给导出面板的是哪一份图（EXP-2）
vi.mock('../../figure/figureExport', async (importOriginal) => {
  const m = await importOriginal<typeof import('../../figure/figureExport')>()
  return { ...m, authoredFigureSource: vi.fn(m.authoredFigureSource) }
})

import { load, render as peleRender } from 'pele/lazy'
import { MermaidBlock } from '../MermaidBlock'
import { MarkdownSourceContext, MarkdownStreamingContext } from '../markdownStreaming'
import { MarkdownText } from '../markdownComponents'
import { CodeBlock } from '../CodeBlock'
import { MERMAID_MAX_HEIGHT, mermaidLayout } from '../mermaidFit'
import { authoredFigureSource } from '../../figure/figureExport'

const render = vi.mocked(peleRender)
const loadSpy = vi.mocked(load)
const authoredSpy = vi.mocked(authoredFigureSource)

let container: HTMLDivElement
let root: Root
const realGetComputedStyle = window.getComputedStyle
const realGetContext = HTMLCanvasElement.prototype.getContext

/** 烘焙要的那几项计算值（初值形状） */
const INITIAL: Record<string, string> = {
  fill: 'rgb(0, 0, 0)',
  'fill-opacity': '1',
  stroke: 'none',
  'stroke-opacity': '1',
  'font-family': 'Test Sans',
  'font-size': '13px',
  opacity: '1',
  'stop-color': 'rgb(0, 0, 0)',
  'stop-opacity': '1',
  'flood-color': 'rgb(0, 0, 0)',
  'flood-opacity': '1'
}

// ─── 假 ResizeObserver ─────────────────────────────────────

/** 当前活着的观察者：用例用 `resizeCards(w)` 给它们报一个栏宽 */
const observers = new Set<{ cb: ResizeObserverCallback; self: ResizeObserver }>()
class FakeResizeObserver {
  private entry: { cb: ResizeObserverCallback; self: ResizeObserver }
  constructor(cb: ResizeObserverCallback) {
    this.entry = { cb, self: this as unknown as ResizeObserver }
  }
  observe(): void {
    observers.add(this.entry)
  }
  unobserve(): void {
    // 组件只用 observe / disconnect
  }
  disconnect(): void {
    observers.delete(this.entry)
  }
}
const installResizeObserver = (): void => {
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver
}
const resizeCards = (width: number): void => {
  act(() => {
    for (const { cb, self } of observers) {
      cb([{ contentRect: { width } } as unknown as ResizeObserverEntry], self)
    }
  })
}

// ─── 挂载与推进 ─────────────────────────────────────────────

/** 一组 MermaidBlock；`streaming` 缺省 = 不包 Provider（组件读到的缺省值是「没在流式」） */
const tree = (codes: string[], closed: boolean, streaming?: boolean): ReactNode => {
  const blocks = createElement(
    'div',
    null,
    ...codes.map((code, i) => createElement(MermaidBlock, { key: i, code, closed }))
  )
  return streaming === undefined
    ? blocks
    : createElement(MarkdownStreamingContext.Provider, { value: streaming }, blocks)
}

/** 挂一个（或一组）写完了的块 */
const show = (codes: string | string[]): void => {
  act(() => {
    root.render(tree(Array.isArray(codes) ? codes : [codes], true))
  })
}

/** 挂一个块，指定围栏闭合没有、消息在不在流式 */
const showFrame = (code: string, opts: { closed: boolean; streaming: boolean }): void => {
  act(() => {
    root.render(tree([code], opts.closed, opts.streaming))
  })
}

/** 卸掉所有块（根还在） */
const clear = (): void => {
  act(() => {
    root.render(createElement('div'))
  })
}

/** 等所有已发起的图类型加载落定，再让 React 把状态更新收干净 */
const settleLoads = async (): Promise<void> => {
  await act(async () => {
    await Promise.allSettled(loadSpy.mock.results.map((r) => r.value))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

// ─── DOM 读取 ───────────────────────────────────────────────

const figureOf = (scope: Element = container): HTMLElement | null =>
  scope.querySelector<HTMLElement>('[data-mermaid-figure]')
const figureSvgOf = (scope: Element = container): SVGSVGElement | null =>
  scope.querySelector<SVGSVGElement>('[data-mermaid-figure] > svg')
const nodeIds = (scope: Element = container): string[] =>
  Array.from(scope.querySelectorAll('[data-mermaid-figure] .pele-node')).map(
    (n) => n.getAttribute('data-id') ?? ''
  )
const pendingOf = (scope: Element = container): HTMLElement | null =>
  scope.querySelector<HTMLElement>('[data-mermaid-pending]')
const errorOf = (scope: Element = container): HTMLElement | null =>
  scope.querySelector<HTMLElement>('[data-mermaid-error]')
const expandOf = (scope: Element = container): HTMLButtonElement | null =>
  scope.querySelector<HTMLButtonElement>('[data-mermaid-expand]')
const exportBtn = (scope: Element = container): HTMLButtonElement | null =>
  scope.querySelector<HTMLButtonElement>('[data-figure-export]')
/** 图 / 源码切换按钮：工具栏里除「导出」外唯一带 title 的按钮 */
const toggleOf = (scope: Element = container): HTMLButtonElement => {
  const btn = scope.querySelector<HTMLButtonElement>('button[title]:not([data-figure-export])')
  if (!btn) throw new Error('没有切换按钮')
  return btn
}
const dialogPanel = (): HTMLElement | null =>
  document.body.querySelector<HTMLElement>('[data-mermaid-dialog]')
/** 根 <svg> 上 pele 写的宽高（= 渲染结果的 width / height） */
const svgSize = (svg: Element): { w: number; h: number } => ({
  w: Number(svg.getAttribute('width')),
  h: Number(svg.getAttribute('height'))
})
/** 用例脚本里替 pele 返回的一次渲染结果（只有 svg / 宽高被组件读） */
const fakeResult = (svg: string, width: number, height: number): ReturnType<typeof peleRender> => ({
  svg,
  width,
  height,
  type: 'flowchart',
  links: []
})
/** 带 maxWidth 的渲染调用 */
const narrowCalls = (): Array<Parameters<typeof peleRender>> =>
  render.mock.calls.filter((c) => c[1]?.maxWidth !== undefined)

const click = (el: Element): void => {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

/** 一条竖向的 n 节点链 */
const tdChain = (prefix: string, n: number): string =>
  [
    'graph TD',
    ...Array.from({ length: n - 1 }, (_, i) => `  ${prefix}${i} --> ${prefix}${i + 1}`)
  ].join('\n')
/** 一条横向的 6 节点链（自然宽度远超 300） */
const lrChain = (prefix: string): string =>
  `flowchart LR\n  ${['A', 'B', 'C', 'D', 'E', 'F'].map((x) => `${prefix}${x}`).join('-->')}`

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } }
  })
  Object.defineProperty(SVGSVGElement.prototype, 'viewBox', {
    configurable: true,
    get(this: SVGSVGElement) {
      const n = (this.getAttribute('viewBox') ?? '')
        .trim()
        .split(/[\s,]+/)
        .map(Number)
      const ok = n.length === 4 && n.every(Number.isFinite)
      const [x, y, width, height] = ok ? n : [0, 0, 0, 0]
      return { baseVal: { x, y, width, height } }
    }
  })
  // jsdom 没有画布：pele 退回字宽表（必须在第一次渲染之前桩好，尺寸才确定）
  HTMLCanvasElement.prototype.getContext = (() =>
    null) as unknown as typeof HTMLCanvasElement.prototype.getContext
  await load('flowchart')
})

afterAll(() => {
  delete (SVGSVGElement.prototype as { viewBox?: unknown }).viewBox
  HTMLCanvasElement.prototype.getContext = realGetContext
})

beforeEach(() => {
  render.mockClear()
  loadSpy.mockClear()
  authoredSpy.mockClear()
  observers.clear()
  document.documentElement.setAttribute('data-theme', 'T1')
  localStorage.clear()
  window.getComputedStyle = ((el: Element) => {
    const probe = el.tagName === 'SPAN' ? (el as HTMLElement).style.color : ''
    return {
      getPropertyValue: (p: string) => INITIAL[p] ?? '',
      fontFamily: 'Test Sans',
      fontSize: '13px',
      fontWeight: '400',
      lineHeight: '20px',
      colorScheme: 'light',
      color: probe.includes('var(') ? 'rgb(30, 31, 32)' : 'rgb(0, 0, 0)'
    }
  }) as unknown as typeof window.getComputedStyle
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  window.getComputedStyle = realGetComputedStyle
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver
  vi.useRealTimers()
})

// ═══════════════════════════════════════════════════════════════

describe('缺省显示图（DF）', () => {
  it('MB-DF-1 写完的流程图：第一次提交就是图（svg.pele.pele-flowchart），没有占位 / 错误卡；切换按钮写「Source」；卡片挂 data-figure-surface="card"', () => {
    show('graph TD\n  df1a --> df1b')
    expect(
      container.querySelector('[data-mermaid-figure] > svg.pele.pele-flowchart')
    ).not.toBeNull()
    expect(pendingOf()).toBeNull()
    expect(errorOf()).toBeNull()
    expect(toggleOf().textContent).toBe('Source')
    const card = container.firstElementChild!.firstElementChild!
    expect(card.getAttribute('data-figure-surface')).toBe('card')
    expect(card.contains(figureOf())).toBe(true)
  })

  it('MB-DF-2 某种图第一次出现（pie）：先「Rendering…」，分包加载完出图；从头到尾没有错误卡', async () => {
    show('pie title Pets df2\n  "Dogs" : 386\n  "Cats" : 85')
    expect(pendingOf()?.textContent).toBe(i18n.t('message.rendering'))
    expect(figureOf()).toBeNull()
    expect(errorOf()).toBeNull()
    expect(loadSpy).toHaveBeenCalledWith('pie')

    await settleLoads()
    expect(container.querySelector('[data-mermaid-figure] > svg.pele')).not.toBeNull()
    expect(pendingOf()).toBeNull()
    expect(errorOf()).toBeNull()
  })

  it('MB-DF-3 根本不是 mermaid（认不出图类型）、写完了：第一次提交就是错误卡', () => {
    show('hello df3\nworld')
    expect(errorOf()).not.toBeNull()
    expect(pendingOf()).toBeNull()
    expect(figureOf()).toBeNull()
    expect(loadSpy).not.toHaveBeenCalled()
  })
})

describe('流式期间逐帧画（ST）', () => {
  const open = { closed: false, streaming: true }

  it('MB-ST-1 只写了图类型那一行：「正在生成」占位（带行数），没有错误卡', () => {
    showFrame('graph TD', open)
    expect(pendingOf()?.textContent).toBe(i18n.t('message.diagramGenerating', { lines: 1 }))
    expect(errorOf()).toBeNull()
    expect(figureOf()).toBeNull()
  })

  it('MB-ST-2 开着的围栏：写完的行都画出来，写到一半的最后一行不画；流式中没有导出按钮', () => {
    showFrame('graph TD\n  st2a-->st2b\n  st2b-->st2c\n  st2c-->st2dpart', open)
    expect(figureSvgOf()).not.toBeNull()
    const ids = nodeIds()
    expect(ids).toEqual(expect.arrayContaining(['st2a', 'st2b', 'st2c']))
    expect(ids).not.toContain('st2dpart')
    expect(exportBtn()).toBeNull()
  })

  it('MB-ST-3 多写完一行：节点数不减；出过图之后不再出占位', () => {
    const lines = ['graph TD', '  st3a-->st3b', '  st3b-->st3c', '  st3c-->st3d', '  st3d-->st3e']
    let last = 0
    let drawn = false
    for (let n = 2; n <= lines.length; n++) {
      // 末尾带一个写到一半的新行
      showFrame(`${lines.slice(0, n).join('\n')}\n  st3pa`, open)
      const count = nodeIds().length
      if (count > 0) drawn = true
      if (drawn) expect(pendingOf(), `第 ${n} 行`).toBeNull()
      expect(count, `第 ${n} 行`).toBeGreaterThanOrEqual(last)
      last = count
    }
    expect(drawn).toBe(true)
    expect(last).toBeGreaterThanOrEqual(5)
  })

  it('MB-ST-4 往回退：刚写完一行坏的，屏幕上仍是之前那一帧（不闪占位、不出错）', () => {
    const good = 'graph TD\n  st4a-->st4b\n  st4b-->st4c\n'
    showFrame(`${good}  st4p`, open)
    const before = nodeIds()
    expect(before).toEqual(expect.arrayContaining(['st4a', 'st4b', 'st4c']))

    showFrame(`${good}  st4x -->\n  st4y`, open)
    expect(nodeIds()).toEqual(expect.arrayContaining(before))
    expect(pendingOf()).toBeNull()
    expect(errorOf()).toBeNull()
  })

  it('MB-ST-5 只有写到一半的最后一行在变：不重渲', () => {
    const base = 'graph TD\n  st5a-->st5b\n  st5b-->st5c\n'
    showFrame(`${base}  st5`, open)
    const calls = render.mock.calls.length
    expect(calls).toBeGreaterThan(0)
    showFrame(`${base}  st5c-`, open)
    showFrame(`${base}  st5c-->st5`, open)
    expect(render.mock.calls.length).toBe(calls)
  })

  it('MB-ST-6 围栏闭合了、消息还在写，源码画不出来：留着能画的那一帧，不出错；消息写完才出错误卡', () => {
    const code = 'graph TD\n  st6a-->st6b\n  st6b -->'
    showFrame(code, { closed: true, streaming: true })
    expect(nodeIds()).toEqual(expect.arrayContaining(['st6a', 'st6b']))
    expect(errorOf()).toBeNull()

    showFrame(code, { closed: true, streaming: false })
    const card = errorOf()
    expect(card).not.toBeNull()
    expect(card!.textContent).toContain('Parse error')
    expect(card!.querySelector('pre')?.textContent).toBe(code)
    expect(figureOf()).toBeNull()
  })

  // 原用例要求「图还是同一个 <svg> 节点」。React 19 只按 `dangerouslySetInnerHTML` 对象的**身份**判断
  // 要不要重设 innerHTML（不再比 __html 字符串），而组件每次渲染都新建 `{ __html }` —— 于是任何一次
  // 重渲染都会换掉 <svg> 节点（内容逐字相同）。这里钉能成立的那半：不再调 pele、标记逐字不变。
  it('MB-ST-7 写得完好的闭合围栏、消息还在写：有图但没有导出；写完后出导出按钮，图不重渲、标记不变', () => {
    const code = 'graph TD\n  st7a-->st7b'
    showFrame(code, { closed: true, streaming: true })
    const markup = figureOf()?.innerHTML
    expect(figureSvgOf()).not.toBeNull()
    expect(exportBtn()).toBeNull()

    const calls = render.mock.calls.length
    showFrame(code, { closed: true, streaming: false })
    expect(exportBtn()).not.toBeNull()
    expect(figureOf()?.innerHTML).toBe(markup)
    // 写完那一刻走写完的缓存键：至多补渲一次自然尺寸（之前那一帧不进缓存），不会按帧再试
    expect(render.mock.calls.length - calls).toBeLessThanOrEqual(1)
  })
})

describe('失败关闭（ER）', () => {
  it('MB-ER-1 写完了还解析不了：错误卡（标签 + pele 的错误 + 源码），没有图，也没有任何按钮', () => {
    const code = 'graph TD\n  er1 -->'
    show(code)
    const card = errorOf()
    expect(card).not.toBeNull()
    const [label, message] = Array.from(card!.querySelectorAll('div'))
    expect(label.textContent).toBe(i18n.t('message.mermaidFailed'))
    expect(message.textContent!.length).toBeGreaterThan(0)
    expect(card!.querySelector('pre')?.textContent).toBe(code)
    expect(container.querySelector('svg')).toBeNull()
    expect(exportBtn()).toBeNull()
    expect(expandOf()).toBeNull()
  })

  it('MB-ER-2 渲染产物净化后什么都不剩：按失败处理（SVG sanitization failed），DOM 里没有 <script>', () => {
    render.mockReturnValueOnce(fakeResult('<svg><script>x</script></svg>', 10, 10))
    show('graph TD\n  er2a --> er2b')
    const card = errorOf()
    expect(card).not.toBeNull()
    expect(card!.textContent).toContain('SVG sanitization failed')
    expect(document.querySelector('script')).toBeNull()
    expect(figureOf()).toBeNull()
  })

  it('MB-ER-3 产物里的事件属性被剥掉，图形本身留下', () => {
    render.mockReturnValueOnce(
      fakeResult('<svg viewBox="0 0 10 10"><rect onclick="x"/></svg>', 10, 10)
    )
    show('graph TD\n  er3a --> er3b')
    const rect = container.querySelector('[data-mermaid-figure] svg rect')
    expect(rect).not.toBeNull()
    expect(rect!.hasAttribute('onclick')).toBe(false)
    expect(errorOf()).toBeNull()
  })
})

describe('配色是 token（TH）', () => {
  it('MB-TH-1 切主题：组件不订阅主题，<svg> 节点原样留着；之后同 props 重渲染也不再调 pele、标记不变', async () => {
    const code = 'graph TD\n  th1a --> th1b'
    show(code)
    const svg = figureSvgOf()
    const markup = figureOf()!.innerHTML
    const calls = render.mock.calls.length
    await act(async () => {
      document.documentElement.setAttribute('data-theme', 'T2')
    })
    expect(figureSvgOf()).toBe(svg)
    expect(render.mock.calls.length).toBe(calls)

    // 父层因为别的原因重渲染（同 props）：不重渲图。<svg> 节点会被换掉（React 19 按 { __html }
    // 对象身份重设 innerHTML，见 MB-ST-7 的注），但标记逐字相同
    show(code)
    expect(figureOf()!.innerHTML).toBe(markup)
    expect(render.mock.calls.length).toBe(calls)
  })
})

describe('写完的图的缓存（CA）', () => {
  it('MB-CA-1 卸下再挂同一段源码：第一次提交就是图，不再渲', () => {
    const code = 'graph TD\n  ca1a --> ca1b'
    show(code)
    const calls = render.mock.calls.length
    expect(calls).toBeGreaterThan(0)
    clear()
    show(code)
    expect(figureSvgOf()).not.toBeNull()
    expect(render.mock.calls.length).toBe(calls)
  })
})

describe('图 / 源码切换（SV）', () => {
  it('MB-SV-1 切到源码：只剩源码、没有放大按钮、按钮写「Diagram」；切回来不再渲', () => {
    const code = tdChain('sv1n', 20) // 高图：有放大按钮，看得出切到源码时它没了
    show(code)
    expect(expandOf()).not.toBeNull()
    const calls = render.mock.calls.length

    click(toggleOf())
    expect(figureOf()).toBeNull()
    expect(container.querySelector('pre')?.textContent).toBe(code)
    expect(expandOf()).toBeNull()
    expect(toggleOf().textContent).toBe('Diagram')

    click(toggleOf())
    expect(figureSvgOf()).not.toBeNull()
    expect(container.querySelector('pre')).toBeNull()
    expect(toggleOf().textContent).toBe('Source')
    expect(render.mock.calls.length).toBe(calls)
  })

  it('MB-SV-2 视图状态按源码记住：同一段卸下再挂仍是源码；别的源码照旧缺省显示图', () => {
    const x = 'graph TD\n  sv2x1 --> sv2x2'
    const y = 'graph TD\n  sv2y1 --> sv2y2'
    show(x)
    click(toggleOf())
    expect(figureOf()).toBeNull()
    clear()

    show(x)
    expect(figureOf()).toBeNull()
    expect(container.querySelector('pre')?.textContent).toBe(x)
    clear()

    show(y)
    expect(figureSvgOf()).not.toBeNull()
  })
})

describe('限高（LY）—— 布局规则见 mermaidFit.test.ts，这里只看组件把它落成了什么', () => {
  it('MB-LY-1 小图：fit、--mermaid-w = 图的原宽、不限高、不给放大', () => {
    show('graph TD\n  ly1a --> ly1b')
    const fig = figureOf()!
    expect(fig.getAttribute('data-mermaid-figure')).toBe('fit')
    const { w, h } = svgSize(figureSvgOf()!)
    expect(h).toBeLessThanOrEqual(MERMAID_MAX_HEIGHT)
    expect(fig.style.getPropertyValue('--mermaid-w')).toBe(`${w}px`)
    expect(fig.style.maxHeight).toBe('')
    expect(expandOf()).toBeNull()
  })

  it('MB-LY-2 高图（栏宽未知）：整张缩到限高、给放大，没有截断遮罩', () => {
    show(tdChain('ly2n', 20))
    const fig = figureOf()!
    const { w, h } = svgSize(figureSvgOf()!)
    expect(h).toBeGreaterThan(MERMAID_MAX_HEIGHT)
    expect(fig.getAttribute('data-mermaid-figure')).toBe('fit')
    expect(fig.style.getPropertyValue('--mermaid-w')).toBe(`${(MERMAID_MAX_HEIGHT * w) / h}px`)
    expect(expandOf()).not.toBeNull()
    expect(fig.className).not.toContain('mask-image')
    expect(fig.style.maxHeight).toBe('')
  })

  it('MB-LY-4 量到栏宽 600：模式 / 宽度 / 放大与 mermaidLayout(尺寸, 600 − 24) 一致；截断时限高框 + 底部渐隐', () => {
    installResizeObserver()
    show(tdChain('ly4n', 20))
    resizeCards(600)
    const fig = figureOf()!
    const { w, h } = svgSize(figureSvgOf()!)
    const expected = mermaidLayout({ width: w, height: h }, 600 - 24)
    expect(fig.getAttribute('data-mermaid-figure')).toBe(expected.mode)
    expect(fig.style.getPropertyValue('--mermaid-w')).toBe(`${expected.width}px`)
    expect(expandOf() !== null).toBe(expected.expandable)
    // 一长串竖向链：整张缩读不动，按栏宽截断
    expect(expected.mode).toBe('clip')
    expect(fig.style.maxHeight).toBe(`calc(${MERMAID_MAX_HEIGHT}px + 1.5rem)`)
    expect(fig.className).toContain('mask-image')
  })
})

describe('按栏宽重排（FW）—— 规则见 mermaidFence 的 fitWidth', () => {
  it('MB-FW-1 宽图放不下这一栏：按栏宽（卡片宽 − 24）再渲一次，显示的是窄的那张；栏够宽就从不带 maxWidth', () => {
    installResizeObserver()
    show(lrChain('fw1'))
    const natural = svgSize(figureSvgOf()!).w
    const W = 300
    expect(W - 24).toBeLessThan(natural)
    resizeCards(W)
    expect(narrowCalls().some((c) => c[1]?.maxWidth === W - 24)).toBe(true)
    expect(svgSize(figureSvgOf()!).w).toBeLessThanOrEqual(W - 24)
    clear()

    render.mockClear()
    show(lrChain('fw1w'))
    resizeCards(2000)
    expect(render.mock.calls.length).toBeGreaterThan(0)
    expect(narrowCalls()).toHaveLength(0)
  })

  it('MB-FW-2 栏先窄后宽：先是窄的那张，再回到自然尺寸 —— 自然尺寸那张命中缓存，不再渲', () => {
    installResizeObserver()
    const code = lrChain('fw2')
    show(code)
    const natural = svgSize(figureSvgOf()!).w
    resizeCards(300)
    expect(svgSize(figureSvgOf()!).w).toBeLessThanOrEqual(276)

    const plainCalls = (): number =>
      render.mock.calls.filter((c) => c[1]?.maxWidth === undefined).length
    const before = plainCalls()
    resizeCards(2000)
    expect(svgSize(figureSvgOf()!).w).toBe(natural)
    expect(plainCalls()).toBe(before)
  })
})

describe('放大查看（EX）', () => {
  /** 一张会给「放大查看」的高图，出图后返回它的原宽 */
  const tallFigure = (prefix: string): number => {
    show(tdChain(prefix, 20))
    expect(expandOf()).not.toBeNull()
    return svgSize(figureSvgOf()!).w
  }

  it('MB-EX-1 弹窗挂在 body 上（卡片之外），里面是同一张图，按原宽摆', () => {
    const w = tallFigure('ex1n')
    const markup = figureOf()!.innerHTML
    click(expandOf()!)
    const panel = dialogPanel()
    expect(panel).not.toBeNull()
    expect(document.body.contains(panel)).toBe(true)
    expect(container.contains(panel)).toBe(false)
    const svg = panel!.querySelector('svg.pele')!
    expect(svg).not.toBeNull()
    expect((svg.parentElement as HTMLElement).innerHTML).toBe(markup)
    // 原宽 + 左右内边距 + 竖滚动条的位置
    expect(panel!.style.width).toBe(`${w + 56}px`)
    expect((svg.parentElement as HTMLElement).style.width).toBe(`${w}px`)
  })

  it('MB-EX-2 Esc：立刻进入关闭动效，120ms 后卸下；放大按钮还在，能再打开', async () => {
    tallFigure('ex2n')
    vi.useFakeTimers()
    click(expandOf()!)
    const overlay = dialogPanel()!.parentElement!
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(overlay.classList.contains('dialog-closing')).toBe(true)
    act(() => {
      vi.advanceTimersByTime(119)
    })
    expect(dialogPanel()).not.toBeNull()
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(dialogPanel()).toBeNull()

    expect(expandOf()).not.toBeNull()
    click(expandOf()!)
    expect(dialogPanel()).not.toBeNull()
    expect(dialogPanel()!.parentElement!.classList.contains('dialog-closing')).toBe(false)
  })

  it('MB-EX-3 点弹窗里面不关；点外面的遮罩 120ms 后关', () => {
    tallFigure('ex3n')
    vi.useFakeTimers()
    click(expandOf()!)
    const panel = dialogPanel()!
    click(panel)
    act(() => {
      vi.advanceTimersByTime(120)
    })
    expect(dialogPanel()).not.toBeNull()
    expect(panel.parentElement!.classList.contains('dialog-closing')).toBe(false)

    click(panel.parentElement!)
    act(() => {
      vi.advanceTimersByTime(120)
    })
    expect(dialogPanel()).toBeNull()
  })

  it('MB-EX-4 关闭按钮：120ms 后关', () => {
    tallFigure('ex4n')
    vi.useFakeTimers()
    click(expandOf()!)
    click(dialogPanel()!.querySelector('button[aria-label="Close"]')!)
    act(() => {
      vi.advanceTimersByTime(120)
    })
    expect(dialogPanel()).toBeNull()
  })
})

describe('CodeBlock 的 mermaid 分发（CB）', () => {
  /** hast 节点里 CodeBlock 读得到的那几个字段 */
  interface HastNode {
    type: string
    tagName?: string
    value?: string
    properties?: Record<string, unknown>
    children?: HastNode[]
  }
  /** react-markdown 交给 CodeBlock 的 hast：pre > code.language-mermaid > text */
  const hast = (text: string): HastNode => ({
    type: 'element',
    tagName: 'pre',
    properties: {},
    children: [
      {
        type: 'element',
        tagName: 'code',
        properties: { className: ['language-mermaid'] },
        children: [{ type: 'text', value: text }]
      }
    ]
  })
  const showCodeBlock = (text: string): void => {
    act(() => {
      root.render(
        createElement(
          CodeBlock,
          { node: hast(text) },
          createElement('code', { className: 'language-mermaid' }, text)
        )
      )
    })
  }

  it('MB-CB-1 mermaid 围栏交给 MermaidBlock，源码去掉末尾那一个换行；空围栏落回普通代码块', () => {
    showCodeBlock('graph TD\ncb1A-->cb1B\n')
    expect(figureSvgOf()).not.toBeNull()
    click(toggleOf())
    expect(container.querySelector('pre')?.textContent).toBe('graph TD\ncb1A-->cb1B')

    clear()
    showCodeBlock('')
    expect(container.querySelector('pre')).not.toBeNull()
    expect(container.querySelector('[data-figure-surface]')).toBeNull()
    expect(pendingOf()).toBeNull()
    expect(figureOf()).toBeNull()
  })

  it('MB-CB-2 真的上下文（流式标志 + 源文本）包着 MarkdownText：开着的围栏写到一半不出错；闭合且写完才出错误卡', () => {
    const body = '```mermaid\ngraph TD\n  cb2a-->cb2b\n  cb2b -->'
    const showMd = (md: string, streaming: boolean): void => {
      act(() => {
        root.render(
          createElement(
            MarkdownStreamingContext.Provider,
            { value: streaming },
            createElement(
              MarkdownSourceContext.Provider,
              { value: streaming ? md : null },
              createElement(MarkdownText, { text: md })
            )
          )
        )
      })
    }

    const unclosed = `before cb2\n\n${body}`
    showMd(unclosed, true)
    expect(errorOf()).toBeNull()
    expect(nodeIds()).toEqual(expect.arrayContaining(['cb2a', 'cb2b']))

    const closed = `${unclosed}\n\`\`\``
    showMd(closed, true)
    expect(errorOf()).toBeNull()

    showMd(closed, false)
    expect(errorOf()).not.toBeNull()
    expect(errorOf()!.querySelector('pre')?.textContent).toBe('graph TD\n  cb2a-->cb2b\n  cb2b -->')
  })
})

describe('导出（EXP）—— 面板本身见 figure/__tests__/figureExportPanel.dom.test.tsx', () => {
  const exportPanel = (): HTMLElement | null =>
    document.body.querySelector<HTMLElement>('[data-figure-export-panel]')
  const panelPreview = (): string | null =>
    exportPanel()?.querySelector('[data-figure-preview]')?.getAttribute('data-figure-preview') ??
    null
  const panelFileName = (): string =>
    exportPanel()?.querySelector('[data-figure-filename]')?.textContent ?? ''
  const flush = async (): Promise<void> => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
  /** 点开导出面板并让「当前主题」那一次建图落定 */
  const openExport = async (): Promise<void> => {
    const btn = exportBtn()
    if (!btn) throw new Error('没有导出按钮')
    click(btn)
    await flush()
    expect(exportPanel()).not.toBeNull()
  }

  it('MB-EXP-1 写完、画出来了才有导出按钮（文字 Export）；流式中的帧没有；错误卡也没有', () => {
    show('graph TD\n  exp1a --> exp1b')
    expect(exportBtn()).not.toBeNull()
    expect(exportBtn()!.textContent).toBe('Export')
    clear()

    showFrame('graph TD\n  exp1c --> exp1d\n  exp1d --> exp1e\n  x', {
      closed: false,
      streaming: true
    })
    expect(figureSvgOf()).not.toBeNull()
    expect(exportBtn()).toBeNull()
    clear()

    show('graph TD\n  exp1f -->')
    expect(errorOf()).not.toBeNull()
    expect(exportBtn()).toBeNull()
  })

  it('MB-EXP-2 交给面板的是屏幕上那份标记：底色层 card，字体从放图那一格抄', async () => {
    show('graph TD\n  exp2a --> exp2b')
    await openExport()
    expect(authoredSpy).toHaveBeenCalledTimes(1)
    const [markup, opts] = authoredSpy.mock.calls[0]
    const fig = figureOf()!
    expect(markup).toBe(fig.innerHTML)
    expect(opts.surface).toBe('card')
    expect(opts.inheritFrom?.()).toBe(fig)
  })

  it('MB-EXP-3 文件名：frontmatter 标题 → accTitle → 「mermaid」', async () => {
    const cases: Array<[string, string]> = [
      ['---\ntitle: Flow chart\n---\ngraph TD\n  exp3a --> exp3b', 'Flow chart.png'],
      ['flowchart TD\n  accTitle: My Flow\n  exp3c --> exp3d', 'My Flow.png'],
      ['graph TD\n  exp3e --> exp3f', 'mermaid.png']
    ]
    for (const [code, name] of cases) {
      show(code)
      await openExport()
      expect(panelFileName(), code).toBe(name)
      click(exportBtn()!) // 收起
      await flush()
      clear()
    }
  })

  it('MB-EXP-4 在面板里选「浅色」：按那套主题烘焙同一份标记，不重渲；预览就绪', async () => {
    show('graph TD\n  exp4a --> exp4b')
    await openExport()
    const calls = render.mock.calls.length
    const opt = exportPanel()?.querySelector('[data-figure-option="scheme:light"]')
    expect(opt, '没有「浅色」选项').not.toBeNull()
    click(opt!)
    await flush()
    expect(panelPreview()).toBe('ready')
    expect(render.mock.calls.length).toBe(calls)
  })
})

describe('图类型分包加载失败（LD）', () => {
  it('MB-LD-1 加载失败不卡在「渲染中」：写完的出错误卡（not supported）；流式中开着的围栏仍是「正在生成」占位', async () => {
    const code =
      'gantt\n  title ld1\n  dateFormat YYYY-MM-DD\n  section S\n  t1 :a1, 2024-01-01, 3d'
    loadSpy.mockRejectedValueOnce(new Error('chunk failed'))
    show(code)
    expect(pendingOf()).not.toBeNull()
    await settleLoads()
    expect(errorOf()).not.toBeNull()
    expect(errorOf()!.textContent).toContain('not supported')
    expect(pendingOf()).toBeNull()
    clear()

    loadSpy.mockRejectedValueOnce(new Error('chunk failed again'))
    const streamingCode = `gantt\n  title ld1s\n  dateFormat YYYY-MM-DD\n  section S\n  t1 :a1, 2024-01-01, 3d\n  t2`
    showFrame(streamingCode, { closed: false, streaming: true })
    await settleLoads()
    expect(pendingOf()?.textContent).toBe(
      i18n.t('message.diagramGenerating', { lines: streamingCode.split('\n').length })
    )
    expect(errorOf()).toBeNull()
  })
})
