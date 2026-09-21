// @vitest-environment jsdom
/**
 * MermaidBlock（```mermaid 代码块 → 图）DOM 测试（jsdom）。组件头注释里的四条就是这里的四组：
 *
 *   - **缺省显示图**（DF）：挂上就渲，出图后工具栏的切换按钮写「源码」；
 *   - **流式期间不渲染**（ST）：只显示「已写多少行」的占位，源码停 800ms 或整条消息写完才渲；
 *     流式中的失败只是还没写完 —— 错误卡只在写完之后出，而且不拿半截源码渲出的旧图顶替；
 *   - **配色跟主题**（TH）：根上的 data-theme 一变就按新主题重渲，旧图留到新图出来；
 *   - **限高 + 放大查看**（LY / EX）：布局规则本身在 mermaidFit.test.ts，这里只钉组件把它
 *     落成了什么（`data-mermaid-figure` / `--mermaid-w` / max-height / 渐隐遮罩 / 放大按钮与弹窗）。
 * 外加两条横切的：渲染**串行**且**去重**（SQ）、单张卡住的渲染 15s 后让出队列。
 *
 * 桩的形状（为什么这么搭）：
 *   - `mermaid` 整个顶掉：initialize / render 都记进同一条日志（看得出「init → render」的先后与
 *     串行）；render 返回测试手里的 deferred，何时成、何时败由用例决定。桩出的 SVG 带
 *     `data-tag`（认是哪一张）与 `data-primary` —— 后者取**紧挨着这次 render 的那次 initialize**
 *     传进来的 primaryColor，于是「这张图是按哪个主题渲的」在 DOM 上直接可读；
 *   - `getComputedStyle` 换成桩：jsdom 不做级联，`var(--x)` 永远解析不出颜色。桩把「当前 data-theme
 *     + 探针上写的 color」原样拼回去（`T1:var(--theme-bg-tertiary)`），主题与 token 两样都看得见；
 *   - jsdom 没有 ResizeObserver：栏宽恒为 0，走「还没量到」那一支（按限高整张缩）。只有 LY-4 装一个
 *     假的，报一个固定栏宽。
 *
 * ⚠️ 组件的缓存 / 视图状态 / 去重表 / 串行队列都是**模块级**的，跨用例共享（刻意不 resetModules ——
 * 那正是要测的东西）。所以：每条用例用自己独有的源码；每个 deferred 都在用例结束前收掉 —— 一个
 * 悬着的渲染会堵住队列，后面所有用例连带失败（afterEach 兜底收掉并报出来）。
 *
 * i18n 走真 en 资源；文件是 .tsx 但不写 JSX，一律 createElement（与同目录的 tokenChip 一致）。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

/** 一次 mermaid.render 调用：测试手里的 deferred */
interface PendingRender {
  id: string
  code: string
  /** 这次渲染所用主题的节点面色（紧挨着它的那次 initialize 传进来的 primaryColor） */
  primary: string
  settled: boolean
  resolve(svg: string): void
  reject(error: Error): void
}

/** 桩出的一张图：viewBox 宽高 + 认图用的 tag + 渲染时的主题色 */
const svgOf = (w: number, h: number, tag: string, primary: string): string =>
  `<svg viewBox="0 0 ${w} ${h}" data-tag="${tag}" data-primary="${primary}"><rect/></svg>`

const mm = vi.hoisted(() => {
  const state = {
    /** `init` / `render:<code>`，按调用先后 */
    log: [] as string[],
    inits: [] as Array<{ themeVariables?: Record<string, unknown> } & Record<string, unknown>>,
    pending: [] as PendingRender[],
    /** 源码 → 一调用就成功的那张图（缺省：挂起，等用例自己收） */
    instant: new Map<string, { w: number; h: number; tag: string }>()
  }
  const initialize = vi.fn((config: (typeof state.inits)[number]) => {
    state.inits.push(config)
    state.log.push('init')
  })
  const render = vi.fn(
    (id: string, code: string) =>
      new Promise<{ svg: string }>((resolve, reject) => {
        state.log.push(`render:${code}`)
        const primary = String(state.inits.at(-1)?.themeVariables?.primaryColor ?? '')
        const entry: PendingRender = {
          id,
          code,
          primary,
          settled: false,
          resolve: (svg) => {
            entry.settled = true
            resolve({ svg })
          },
          reject: (error) => {
            entry.settled = true
            reject(error)
          }
        }
        state.pending.push(entry)
        const instant = state.instant.get(code)
        if (instant) {
          entry.resolve(
            `<svg viewBox="0 0 ${instant.w} ${instant.h}" data-tag="${instant.tag}" data-primary="${primary}"><rect/></svg>`
          )
        }
      })
  )
  return { state, initialize, render }
})

vi.mock('mermaid', () => ({ default: { initialize: mm.initialize, render: mm.render } }))

import { MermaidBlock } from '../MermaidBlock'
import { MarkdownStreamingContext } from '../markdownStreaming'
import { CodeBlock } from '../CodeBlock'
import { mermaidThemeVariables } from '../mermaidFit'

let container: HTMLDivElement
let root: Root
/** 桩 getComputedStyle 此刻报给根元素的 color-scheme */
const ui = { colorScheme: 'light' }
const realGetComputedStyle = window.getComputedStyle

// ─── 挂载与推进 ─────────────────────────────────────────────

/** 一组 MermaidBlock；`streaming` 缺省 = 不包 Provider（组件读到的缺省值是「没在流式」） */
const tree = (codes: string[], streaming?: boolean): ReactNode => {
  const blocks = createElement(
    'div',
    null,
    ...codes.map((code, i) => createElement(MermaidBlock, { key: i, code }))
  )
  return streaming === undefined
    ? blocks
    : createElement(MarkdownStreamingContext.Provider, { value: streaming }, blocks)
}

const show = (codes: string | string[], streaming?: boolean): void => {
  act(() => {
    root.render(tree(Array.isArray(codes) ? codes : [codes], streaming))
  })
}

/** 卸掉所有块（根还在） */
const clear = (): void => {
  act(() => {
    root.render(createElement('div'))
  })
}

/** 推进假时钟并把期间冒出来的微任务 / React 更新都收干净 */
const advance = async (ms: number): Promise<void> => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

const setTheme = async (theme: string): Promise<void> => {
  await act(async () => {
    document.documentElement.setAttribute('data-theme', theme)
  })
}

// ─── 收 deferred ────────────────────────────────────────────

const unsettled = (code?: string): PendingRender[] =>
  mm.state.pending.filter((p) => !p.settled && (code === undefined || p.code === code))

const pendingFor = (code: string): PendingRender => {
  const hit = unsettled(code)[0]
  if (!hit) throw new Error(`没有挂起的 render：${JSON.stringify(code)}`)
  return hit
}

const resolveRender = async (code: string, w: number, h: number, tag: string): Promise<void> => {
  const p = pendingFor(code)
  await act(async () => {
    p.resolve(svgOf(w, h, tag, p.primary))
    await vi.advanceTimersByTimeAsync(0)
  })
}

/** 用一段原样的「渲染产物」收掉（净化用例用） */
const resolveRaw = async (code: string, svg: string): Promise<void> => {
  const p = pendingFor(code)
  await act(async () => {
    p.resolve(svg)
    await vi.advanceTimersByTimeAsync(0)
  })
}

/** 让这段源码所有挂起的 render 失败（mermaid 的解析错误） */
const rejectRenders = async (code: string): Promise<void> => {
  const list = unsettled(code)
  if (list.length === 0) throw new Error(`没有挂起的 render：${JSON.stringify(code)}`)
  await act(async () => {
    for (const p of list) p.reject(new Error('Parse error on line 2'))
    await vi.advanceTimersByTimeAsync(0)
  })
}

/** 按排队顺序一张张收：每收一张，队列里下一张才会真的调到 mermaid.render */
const resolveQueueInOrder = async (tagOf: (p: PendingRender) => string): Promise<void> => {
  for (let guard = 0; guard < 20; guard++) {
    const next = unsettled()[0]
    if (!next) return
    await act(async () => {
      next.resolve(svgOf(400, 300, tagOf(next), next.primary))
      await vi.advanceTimersByTimeAsync(0)
    })
  }
  throw new Error('队列收不完')
}

const renderedCodes = (): string[] => mm.render.mock.calls.map((call) => call[1])

// ─── DOM 读取 ───────────────────────────────────────────────

/** 第 i 个块的根节点（卡片，或整块换成的错误卡） */
const block = (i = 0): Element => {
  const el = container.firstElementChild?.children[i]
  if (!el) throw new Error(`没有第 ${i} 个块`)
  return el
}
const figureOf = (scope: Element = container): HTMLElement | null =>
  scope.querySelector<HTMLElement>('[data-mermaid-figure]')
const figureSvgOf = (scope: Element = container): SVGElement | null =>
  scope.querySelector<SVGElement>('[data-mermaid-figure] > svg')
const tagOf = (scope: Element = container): string | null =>
  figureSvgOf(scope)?.getAttribute('data-tag') ?? null
const primaryOf = (scope: Element = container): string =>
  figureSvgOf(scope)?.getAttribute('data-primary') ?? ''
const pendingOf = (scope: Element = container): HTMLElement | null =>
  scope.querySelector<HTMLElement>('[data-mermaid-pending]')
const errorOf = (scope: Element = container): HTMLElement | null =>
  scope.matches('[data-mermaid-error]')
    ? (scope as HTMLElement)
    : scope.querySelector<HTMLElement>('[data-mermaid-error]')
const expandOf = (scope: Element = container): HTMLButtonElement | null =>
  scope.querySelector<HTMLButtonElement>('[data-mermaid-expand]')
/** 图 / 源码切换按钮：工具栏里唯一带 title 的按钮 */
const toggleOf = (scope: Element = container): HTMLButtonElement => {
  const btn = scope.querySelector<HTMLButtonElement>('button[title]')
  if (!btn) throw new Error('没有切换按钮')
  return btn
}
const dialogPanel = (): HTMLElement | null =>
  document.body.querySelector<HTMLElement>('[data-mermaid-dialog]')

const click = (el: Element): void => {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } }
  })
})

beforeEach(() => {
  vi.useFakeTimers()
  mm.state.log.length = 0
  mm.state.inits.length = 0
  mm.state.pending.length = 0
  mm.state.instant.clear()
  mm.initialize.mockClear()
  mm.render.mockClear()
  ui.colorScheme = 'light'
  document.documentElement.setAttribute('data-theme', 'T1')
  // jsdom 不做级联：把「主题 id + 探针上写的 var(...)」原样拼回去当解析结果
  window.getComputedStyle = ((el: Element) => ({
    color: `${document.documentElement.getAttribute('data-theme')}:${(el as HTMLElement).style?.color ?? ''}`,
    colorScheme: ui.colorScheme,
    fontFamily: 'Test Sans'
  })) as unknown as typeof window.getComputedStyle
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  // 兜底：没收掉的渲染会堵住模块级串行队列 —— 先让它们失败以免连累后面的用例，再报出来。
  // 要循环收：排在后面的那张只有前一张落定之后才真的调到 mermaid.render，冒出新的 deferred
  const leftover = unsettled().map((p) => p.code)
  for (let guard = 0; guard < 20 && unsettled().length > 0; guard++) {
    await act(async () => {
      for (const p of unsettled()) p.reject(new Error('left over by the test'))
      await vi.advanceTimersByTimeAsync(0)
    })
  }
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  window.getComputedStyle = realGetComputedStyle
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver
  vi.useRealTimers()
  expect(leftover, '用例结束时还有没收掉的 mermaid.render').toEqual([])
})

describe('缺省显示图（DF）', () => {
  it('DF-1 不在流式：先是「渲染中」，推进 0ms 就出图；init 在 render 之前、取 base 主题 + 解析后的 token', async () => {
    const code = 'graph TD\n  df1a --> df1b'
    mm.state.instant.set(code, { w: 400, h: 300, tag: 'df1' })
    show(code) // 不包 Provider：缺省就是「没在流式」

    expect(pendingOf()?.textContent).toBe('Rendering…')
    expect(mm.render).not.toHaveBeenCalled()

    await advance(0)
    expect(tagOf()).toBe('df1')
    expect(pendingOf()).toBeNull()
    // 缺省是图，不是源码（从前缺省是源码，长流程图先以一大段代码摊在对话里）
    expect(container.querySelector('pre')).toBeNull()
    expect(toggleOf().textContent).toBe('Source')

    expect(mm.render).toHaveBeenCalledTimes(1)
    expect(mm.render).toHaveBeenCalledWith(expect.stringMatching(/^mermaid_\d+$/), code)
    expect(mm.state.log).toEqual(['init', `render:${code}`])
    expect(mm.state.inits[0]).toMatchObject({ startOnLoad: false, theme: 'base' })
    expect(mm.state.inits[0].themeVariables).toEqual(
      mermaidThemeVariables((token) => `T1:var(${token})`, false, 'Test Sans')
    )
    // 从前那块写死的白底：深色主题下是一块白板
    expect(document.querySelector('.bg-white')).toBeNull()
  })

  it('DF-1 变体：根元素的 color-scheme 是 dark → darkMode 为真', async () => {
    const code = 'graph TD\n  df1dark --> df1dark2'
    mm.state.instant.set(code, { w: 400, h: 300, tag: 'df1-dark' })
    ui.colorScheme = 'dark'
    show(code)
    await advance(0)
    expect(tagOf()).toBe('df1-dark')
    expect(mm.state.inits[0].themeVariables?.darkMode).toBe(true)
  })
})

describe('流式期间不渲染（ST）', () => {
  it('ST-1 流式中只显示行数占位；源码停满 800ms 才渲，出图时消息仍在流式', async () => {
    const code = 'graph LR\n  st1a --> st1b\n  st1b --> st1c'
    show(code, true)
    expect(pendingOf()?.textContent).toBe('Drawing the diagram… (3 lines)')

    await advance(799)
    expect(mm.render).not.toHaveBeenCalled()
    await advance(1)
    expect(renderedCodes()).toEqual([code])

    await resolveRender(code, 400, 300, 'st1')
    expect(tagOf()).toBe('st1')
    expect(pendingOf()).toBeNull()
  })

  it('ST-2 源码还在长：计时从最后一次变化重新算，只渲最新那一版', async () => {
    const v1 = 'graph LR\n  st2a --> st2b\n  st2b --> st2c'
    const v2 = `${v1}\n  st2c --> st2d`
    show(v1, true)
    await advance(500)
    show(v2, true)
    expect(pendingOf()?.textContent).toBe('Drawing the diagram… (4 lines)')

    await advance(500) // 距 v1 已 1000ms，距 v2 才 500ms
    expect(mm.render).not.toHaveBeenCalled()
    await advance(300) // 距 v2 满 800ms
    expect(renderedCodes()).toEqual([v2])

    await resolveRender(v2, 400, 300, 'st2')
    expect(tagOf()).toBe('st2')
    expect(renderedCodes()).toEqual([v2])
  })

  it('ST-3 流式中渲染失败不是错误：占位照旧；写完之后才出错误卡（带源码）', async () => {
    const code = 'graph LR\n  st3a -->'
    show(code, true)
    await advance(800)
    expect(renderedCodes()).toEqual([code])
    await rejectRenders(code)
    expect(pendingOf()?.textContent).toBe('Drawing the diagram… (2 lines)')
    expect(errorOf()).toBeNull()

    show(code, false)
    const card = errorOf()
    expect(card).not.toBeNull()
    expect(card!.querySelector('pre')?.textContent).toBe(code)
    expect(pendingOf()).toBeNull()

    // 写完那一刻会按同一段源码再试一次（streaming 变了）—— 收掉它，错误卡不变
    await advance(0)
    await rejectRenders(code)
    expect(errorOf()?.querySelector('pre')?.textContent).toBe(code)
  })

  it('ST-4 已有一张图时源码又变了：旧图一直留着，占位一次都不出，新图出来才换', async () => {
    const v1 = 'graph LR\n  st4a --> st4b'
    const v2 = `${v1}\n  st4b --> st4c`
    show(v1, true)
    await advance(800)
    await resolveRender(v1, 400, 300, 'A')
    expect(tagOf()).toBe('A')

    show(v2, true)
    expect(tagOf()).toBe('A')
    expect(pendingOf()).toBeNull()
    await advance(799)
    expect(tagOf()).toBe('A')
    expect(pendingOf()).toBeNull()
    await advance(1)
    expect(renderedCodes()).toEqual([v1, v2])
    expect(tagOf()).toBe('A') // v2 还在渲
    expect(pendingOf()).toBeNull()

    await resolveRender(v2, 400, 300, 'B')
    expect(tagOf()).toBe('B')
    expect(container.querySelectorAll('[data-mermaid-figure] > svg')).toHaveLength(1)
  })

  it('ST-5 流式中新一版失败：旧图照旧、不出错；写完后出错误卡（新源码），旧图撤下', async () => {
    const v1 = 'graph LR\n  st5a --> st5b'
    const v2 = `${v1}\n  st5b -->`
    show(v1, true)
    await advance(800)
    await resolveRender(v1, 400, 300, 'A')

    show(v2, true)
    await advance(800)
    await rejectRenders(v2)
    expect(tagOf()).toBe('A')
    expect(errorOf()).toBeNull()

    show(v2, false)
    // 真失败时不拿半截源码渲出来的旧图顶替 —— 那等于把错误藏在一张不完整的图后面
    expect(errorOf()?.querySelector('pre')?.textContent).toBe(v2)
    expect(figureSvgOf()).toBeNull()

    await advance(0)
    await rejectRenders(v2)
    expect(errorOf()?.querySelector('pre')?.textContent).toBe(v2)
  })

  it('ST-5 变体：新一版的 800ms 还没到消息就写完了 → 推进 0ms 就渲，失败即出错误卡', async () => {
    const v1 = 'graph LR\n  st5va --> st5vb'
    const v2 = `${v1}\n  st5vb -->`
    show(v1, true)
    await advance(800)
    await resolveRender(v1, 400, 300, 'A')

    show(v2, true)
    await advance(300)
    show(v2, false)
    expect(renderedCodes()).toEqual([v1]) // 流式那一版的计时已经作废
    await advance(0)
    expect(renderedCodes()).toEqual([v1, v2])
    await rejectRenders(v2)
    expect(errorOf()?.querySelector('pre')?.textContent).toBe(v2)
  })

  it('ST-6a 流式中已经渲成功：消息写完不再渲第二遍', async () => {
    const code = 'graph LR\n  st6a --> st6b'
    show(code, true)
    await advance(800)
    await resolveRender(code, 400, 300, 'st6a')
    show(code, false)
    await advance(1000)
    expect(mm.render).toHaveBeenCalledTimes(1)
    expect(tagOf()).toBe('st6a')
  })

  it('ST-6b 写完那一刻渲染还没回来：并进同一次（不再调 render），回来就出图', async () => {
    const code = 'graph LR\n  st6c --> st6d'
    show(code, true)
    await advance(800)
    expect(mm.render).toHaveBeenCalledTimes(1)
    show(code, false)
    await advance(0)
    expect(mm.render).toHaveBeenCalledTimes(1)
    await resolveRender(code, 400, 300, 'st6b')
    expect(tagOf()).toBe('st6b')
    expect(mm.render).toHaveBeenCalledTimes(1)
  })

  it('ST-7 最后一次改动 300ms 后消息就写完了：推进 0ms 就渲，不再等剩下的 500ms', async () => {
    const code = 'graph LR\n  st7a --> st7b'
    show(code, true)
    await advance(300)
    show(code, false)
    expect(mm.render).not.toHaveBeenCalled()
    await advance(0)
    expect(renderedCodes()).toEqual([code])
    await resolveRender(code, 400, 300, 'st7')
    expect(tagOf()).toBe('st7')
  })
})

describe('失败关闭（ER）', () => {
  it('ER-1 写完了还解析不了：错误卡（文案 + 源码），没有图，也没有任何按钮', async () => {
    const code = 'graph TD\n  er1a -->'
    show(code)
    await advance(0)
    await rejectRenders(code)
    const card = errorOf()
    expect(card).not.toBeNull()
    expect(card!.textContent).toContain('Mermaid render failed')
    expect(card!.querySelector('pre')?.textContent).toBe(code)
    expect(figureOf()).toBeNull()
    expect(container.querySelectorAll('button')).toHaveLength(0)
  })

  it('ER-2 渲染产物净化后什么都不剩：按失败处理，而不是一张空图卡', async () => {
    const code = 'graph TD\n  er2a --> er2b'
    show(code)
    await advance(0)
    await resolveRaw(code, '<p>no svg</p>')
    expect(errorOf()?.querySelector('pre')?.textContent).toBe(code)
    expect(figureOf()).toBeNull()
  })

  it('ER-3 渲染产物里的 javascript: 链接与事件属性被剥掉，图形本身留下', async () => {
    const code = 'graph TD\n  er3a --> er3b'
    show(code)
    await advance(0)
    await resolveRaw(
      code,
      '<svg viewBox="0 0 120 60" data-tag="er3"><a href="javascript:alert(1)">' +
        '<rect width="10" height="10" onclick="alert(2)"/></a></svg>'
    )
    expect(tagOf()).toBe('er3')
    expect(figureOf()!.querySelector('rect')).not.toBeNull()
    expect(document.querySelector('[onclick]')).toBeNull()
    expect(document.body.innerHTML).not.toMatch(/javascript:/i)
  })
})

describe('渲染串行且去重（SQ）', () => {
  it('SQ-1 两张图同时挂上：一张渲完才开始下一张（每张都先 init 再 render）', async () => {
    const a = 'graph TD\n  sq1a1 --> sq1a2'
    const b = 'graph TD\n  sq1b1 --> sq1b2'
    show([a, b])
    await advance(0)
    expect(mm.state.log).toEqual(['init', `render:${a}`])

    await resolveRender(a, 400, 300, 'sq1-a')
    expect(mm.state.log).toEqual(['init', `render:${a}`, 'init', `render:${b}`])
    await resolveRender(b, 400, 300, 'sq1-b')
    expect(tagOf(block(0))).toBe('sq1-a')
    expect(tagOf(block(1))).toBe('sq1-b')
  })

  it('SQ-1 变体：前一张失败不会卡住队列，后一张照样渲', async () => {
    const a = 'graph TD\n  sq1va -->'
    const b = 'graph TD\n  sq1vb1 --> sq1vb2'
    show([a, b])
    await advance(0)
    expect(mm.state.log).toEqual(['init', `render:${a}`])

    await rejectRenders(a)
    expect(mm.state.log).toEqual(['init', `render:${a}`, 'init', `render:${b}`])
    await resolveRender(b, 400, 300, 'sq1v-b')
    expect(errorOf(block(0))).not.toBeNull()
    expect(tagOf(block(1))).toBe('sq1v-b')
  })

  it('SQ-2 两块同一段源码：只渲一次，两块都出图', async () => {
    const code = 'graph TD\n  sq2a --> sq2b'
    show([code, code])
    await advance(0)
    expect(mm.render).toHaveBeenCalledTimes(1)
    await resolveRender(code, 400, 300, 'sq2')
    expect(tagOf(block(0))).toBe('sq2')
    expect(tagOf(block(1))).toBe('sq2')
    expect(mm.render).toHaveBeenCalledTimes(1)
  })

  it('SQ-3 卸下再挂同一段源码（同一主题）：第一帧就是图，不再渲', async () => {
    const code = 'graph TD\n  sq3a --> sq3b'
    show(code)
    await advance(0)
    await resolveRender(code, 400, 300, 'sq3')
    clear()
    expect(figureOf()).toBeNull()

    show(code)
    // 还没推进任何计时器：缓存命中就是第一帧
    expect(tagOf()).toBe('sq3')
    expect(pendingOf()).toBeNull()
    await advance(0)
    expect(mm.render).toHaveBeenCalledTimes(1)
  })

  it('SQ-4 一张卡死的渲染 15s 后按失败让出队列：它出错误卡，排在后面的那张接着渲', async () => {
    const a = 'graph TD\n  sq4a --> sq4b'
    const b = 'graph TD\n  sq4c --> sq4d'
    show([a, b])
    await advance(0)
    expect(mm.state.log).toEqual(['init', `render:${a}`])

    await advance(14_999)
    expect(errorOf(block(0))).toBeNull()
    expect(pendingOf(block(0))?.textContent).toBe('Rendering…')
    expect(mm.state.log).toEqual(['init', `render:${a}`])

    await advance(1)
    expect(errorOf(block(0))?.querySelector('pre')?.textContent).toBe(a)
    expect(mm.state.log).toEqual(['init', `render:${a}`, 'init', `render:${b}`])
    await resolveRender(b, 400, 300, 'sq4-b')
    expect(tagOf(block(1))).toBe('sq4-b')

    // 卡住的那次终于回来了 —— 已经判了失败，回来得太晚，什么都不改
    await resolveRender(a, 400, 300, 'too-late')
    expect(errorOf(block(0))).not.toBeNull()
    expect(tagOf(block(0))).toBeNull()
  })
})

describe('配色跟主题（TH）', () => {
  it('TH-1 切主题：旧图留着、不闪占位；按新主题重渲后换上；切回来直接用缓存', async () => {
    const code = 'graph TD\n  th1a --> th1b'
    show(code)
    await advance(0)
    await resolveRender(code, 400, 300, 'A')
    expect(tagOf()).toBe('A')
    expect(primaryOf()).toMatch(/^T1:/)

    await setTheme('T2')
    expect(tagOf()).toBe('A')
    expect(pendingOf()).toBeNull()
    expect(mm.render).toHaveBeenCalledTimes(1)

    await advance(0)
    expect(mm.render).toHaveBeenCalledTimes(2)
    await resolveRender(code, 400, 300, 'B')
    expect(tagOf()).toBe('B')
    expect(primaryOf()).toMatch(/^T2:/)

    await setTheme('T1')
    expect(tagOf()).toBe('A')
    await advance(0)
    expect(mm.render).toHaveBeenCalledTimes(2)
  })

  it('TH-4 排队期间切了主题：排着的那张仍按请求那一刻的主题渲（不把新主题的颜色存进旧主题的键）', async () => {
    const a = 'graph TD\n  th4a1 --> th4a2'
    const b = 'graph TD\n  th4b1 --> th4b2'
    show([a, b])
    await advance(0)
    expect(mm.state.log).toEqual(['init', `render:${a}`]) // B 在 T1 下排在 A 后面

    await setTheme('T2')
    await advance(0)
    await resolveQueueInOrder((p) => `${p.code === a ? 'a' : 'b'}@${p.primary.split(':')[0]}`)

    await setTheme('T1')
    expect(tagOf(block(1))).toBe('b@T1')
    expect(primaryOf(block(1))).toMatch(/^T1:/)
    expect(primaryOf(block(0))).toMatch(/^T1:/)
  })
})

describe('图 / 源码切换（SV）', () => {
  it('SV-1 切到源码：只剩源码、没有放大按钮、按钮写「图」；切回来不再渲', async () => {
    const code = 'graph TD\n  sv1a --> sv1b'
    show(code)
    await advance(0)
    await resolveRender(code, 400, 960, 'sv1')
    expect(expandOf()).not.toBeNull()

    click(toggleOf())
    expect(container.querySelector('pre')?.textContent).toBe(code)
    expect(figureOf()).toBeNull()
    expect(expandOf()).toBeNull()
    expect(toggleOf().textContent).toBe('Diagram')

    click(toggleOf())
    expect(tagOf()).toBe('sv1')
    await advance(0)
    expect(mm.render).toHaveBeenCalledTimes(1)
  })

  it('SV-2 视图状态按源码记住：同一段卸下再挂仍是源码；别的源码照旧缺省显示图', async () => {
    const x = 'graph TD\n  sv2x1 --> sv2x2'
    const y = 'graph TD\n  sv2y1 --> sv2y2'
    show(x)
    await advance(0)
    await resolveRender(x, 400, 300, 'x')
    click(toggleOf())
    clear()

    show(x)
    expect(container.querySelector('pre')?.textContent).toBe(x)
    expect(figureOf()).toBeNull()
    expect(toggleOf().textContent).toBe('Diagram')

    clear()
    show(y)
    await advance(0)
    await resolveRender(y, 400, 300, 'y')
    expect(tagOf()).toBe('y')
    expect(container.querySelector('pre')).toBeNull()
  })
})

describe('限高（LY）—— 布局规则见 mermaidFit.test.ts，这里只看组件把它落成了什么', () => {
  it('LY-1 小图：fit、原宽、不限高、不给放大', async () => {
    const code = 'graph TD\n  ly1a --> ly1b'
    show(code)
    await advance(0)
    await resolveRender(code, 400, 300, 'ly1')
    const fig = figureOf()!
    expect(fig.dataset.mermaidFigure).toBe('fit')
    expect(fig.style.getPropertyValue('--mermaid-w')).toBe('400px')
    expect(fig.style.maxHeight).toBe('')
    expect(expandOf()).toBeNull()
  })

  it('LY-2 高图（栏宽未知）：整张缩到限高、给放大，没有截断遮罩', async () => {
    const code = 'graph TD\n  ly2a --> ly2b'
    show(code)
    await advance(0)
    await resolveRender(code, 400, 960, 'ly2')
    const fig = figureOf()!
    expect(fig.dataset.mermaidFigure).toBe('fit')
    expect(fig.style.getPropertyValue('--mermaid-w')).toBe('200px')
    expect(expandOf()).not.toBeNull()
    expect(fig.className).not.toContain('mask-image')
  })

  it('LY-3 产物没有 viewBox：原样放（natural），不设宽度、不给放大', async () => {
    const code = 'graph TD\n  ly3a --> ly3b'
    show(code)
    await advance(0)
    await resolveRaw(code, '<svg data-tag="ly3"><rect/></svg>')
    const fig = figureOf()!
    expect(fig.dataset.mermaidFigure).toBe('natural')
    expect(fig.style.getPropertyValue('--mermaid-w')).toBe('')
    expect(expandOf()).toBeNull()
  })

  it('LY-4 量到栏宽 600：长竖图按栏宽截断（限高框 + 底部渐隐）；栏宽 599 就只能整张缩', async () => {
    let reported = 600
    class FakeResizeObserver {
      private readonly callback: (entries: Array<{ contentRect: { width: number } }>) => void
      constructor(callback: (entries: Array<{ contentRect: { width: number } }>) => void) {
        this.callback = callback
      }
      observe(): void {
        this.callback([{ contentRect: { width: reported } }])
      }
      disconnect(): void {
        // 假的观察器不持有任何东西，没有可断开的
      }
    }
    ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver

    const code = 'graph TD\n  ly4a --> ly4b'
    show(code)
    await advance(0)
    await resolveRender(code, 1000, 2000, 'ly4')
    let fig = figureOf()!
    expect(fig.dataset.mermaidFigure).toBe('clip')
    expect(fig.style.getPropertyValue('--mermaid-w')).toBe('600px')
    // 框高 = 图的可见高度 480 + 上下内边距（p-3）
    expect(fig.style.maxHeight).toBe('calc(480px + 1.5rem)')
    expect(fig.className).toContain('mask-image')
    expect(expandOf()).not.toBeNull()

    clear()
    reported = 599
    show(code) // 缓存命中，图立刻挂上，栏宽按 599 报
    fig = figureOf()!
    expect(fig.dataset.mermaidFigure).toBe('fit')
    expect(fig.style.getPropertyValue('--mermaid-w')).toBe('240px')
    expect(fig.style.maxHeight).toBe('')
    expect(mm.render).toHaveBeenCalledTimes(1)
  })
})

describe('放大查看（EX）', () => {
  /** 一张会给「放大查看」的高图（400×960），出图后返回 */
  const tallFigure = async (code: string, tag: string): Promise<void> => {
    show(code)
    await advance(0)
    await resolveRender(code, 400, 960, tag)
    expect(expandOf()).not.toBeNull()
  }

  it('EX-1 弹窗挂在 body 上（卡片之外），里面是同一张图，按原宽摆', async () => {
    await tallFigure('graph TD\n  ex1a --> ex1b', 'ex1')
    click(expandOf()!)
    const panel = dialogPanel()
    expect(panel).not.toBeNull()
    expect(document.body.contains(panel)).toBe(true)
    expect(container.contains(panel)).toBe(false)
    const svg = panel!.querySelector('svg[data-tag]')
    expect(svg?.getAttribute('data-tag')).toBe('ex1')
    // 原宽 + 左右内边距 + 竖滚动条的位置
    expect(panel!.style.width).toBe('456px')
    expect((svg!.parentElement as HTMLElement).style.width).toBe('400px')
  })

  it('EX-2 Esc：立刻进入关闭动效，120ms 后卸下；放大按钮还在，能再打开', async () => {
    await tallFigure('graph TD\n  ex2a --> ex2b', 'ex2')
    click(expandOf()!)
    const overlay = dialogPanel()!.parentElement!
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(overlay.classList.contains('dialog-closing')).toBe(true)
    await advance(119)
    expect(dialogPanel()).not.toBeNull()
    await advance(1)
    expect(dialogPanel()).toBeNull()

    expect(expandOf()).not.toBeNull()
    click(expandOf()!)
    expect(dialogPanel()).not.toBeNull()
    expect(dialogPanel()!.parentElement!.classList.contains('dialog-closing')).toBe(false)
  })

  it('EX-3 点弹窗里面不关；点外面的遮罩 120ms 后关', async () => {
    await tallFigure('graph TD\n  ex3a --> ex3b', 'ex3')
    click(expandOf()!)
    const panel = dialogPanel()!
    click(panel)
    await advance(120)
    expect(dialogPanel()).not.toBeNull()
    expect(panel.parentElement!.classList.contains('dialog-closing')).toBe(false)

    click(panel.parentElement!)
    await advance(120)
    expect(dialogPanel()).toBeNull()
  })

  it('EX-4 关闭按钮：120ms 后关', async () => {
    await tallFigure('graph TD\n  ex4a --> ex4b', 'ex4')
    click(expandOf()!)
    click(dialogPanel()!.querySelector('button[aria-label="Close"]')!)
    await advance(120)
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
    const node = hast(text)
    act(() => {
      root.render(
        createElement(
          CodeBlock,
          { node },
          createElement('code', { className: 'language-mermaid' }, text)
        )
      )
    })
  }

  it('CB-1 mermaid 围栏交给 MermaidBlock，源码去掉末尾那一个换行；空围栏落回普通代码块', async () => {
    showCodeBlock('graph TD\nA-->B\n')
    await advance(0)
    expect(renderedCodes()).toEqual(['graph TD\nA-->B'])
    await resolveRender('graph TD\nA-->B', 400, 300, 'cb1')
    expect(tagOf()).toBe('cb1')

    clear()
    showCodeBlock('')
    await advance(0)
    expect(container.querySelector('pre')).not.toBeNull()
    expect(pendingOf()).toBeNull()
    expect(figureOf()).toBeNull()
    expect(mm.render).toHaveBeenCalledTimes(1)
  })
})
