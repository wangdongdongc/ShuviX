// @vitest-environment jsdom
/**
 * 沙箱里的桥（interactiveFence.ts 的 BRIDGE_SCRIPT）—— 把 `buildSandboxDocument` 拼出来的整份
 * srcdoc 放进一个**新的** JSDOM 里真跑一遍（`runScripts: 'dangerously'`），看它在沙箱那一侧
 * 交出去的是什么。
 *
 * 为什么是新的 JSDOM 而不是 vitest 的那个 window：桥会在 window 上定义 `shuvix` 与一个 `Chart`
 * 的 setter 陷阱，一条用例一个干净的窗口才互不串扰。JSDOM 的构造函数取自 vitest jsdom 环境暴露的
 * `globalThis.jsdom`（当前那个实例）—— 仓里没有 @types/jsdom，直接 import 'jsdom' 过不了类型检查。
 *
 * 顶层窗口里 `parent === window`，所以桥 postMessage 给 parent 的消息就落在同一个窗口上；
 * jsdom 的 postMessage 是异步派发的，用例 await 一条消息再断言。
 *
 * 钉的几条（真实 Chromium 里的行为由 e2e 的 chat-interactive 钉）：
 *  - BR-1 桥的对外面只有 `color` 与 `sendPrompt`，且冻结（模型的代码改不了它）；
 *  - BR-2 / 3 桥发出的两种消息都过得了宿主那一侧的 parseSandboxMessage —— 两端对不上，
 *    高度永远 120px、按钮点了没反应，而且不报错；
 *  - BR-4 `shuvix.color()` 只认 `--x` 形状的名字（它会被拼进 `var(…)`）；
 *  - BR-5 / 6 页面加载 Chart.js 时的主题接管：注册一次取色插件、关掉 Chart.js 自带的调色，
 *    没指定颜色的数据集按槽位取 --viz-N，饼图类按扇区取；
 *  - BR-7…14 观感的缺省值（与作图技能 references/style.md 同一套）：值表、`put` 不动兄弟键、
 *    折线图的 interaction 只放在 overrides.line 上、减少动效、两个 try 互不连累、图例的「单系列不画」
 *    是一个每次渲染现算的函数、面积图的淡洗、宽栏里的宽高比；
 *  - BR-16 把**随包的真 Chart.js**（resources/sandbox-libs/chart.umd.min.js）加载进沙箱窗口：假 Chart
 *    只有桥碰得到的那几层，真库的 defaults 里有 getter/setter 路由、有别的键 —— 值写不写得进去、
 *    会不会冲掉库自己的键、桥里写的路径是不是真库里存在的那一层（错拼一个段，`put` 会就地造出一层
 *    谁也不读的空对象，而且不报错），只有真库答得出来。jsdom 没有 canvas，所以这里只看 defaults
 *    与插件注册表，不建图；真图里解析出来的选项由 e2e 的 chat-interactive E-8 钉。
 *
 * jsdom 不做级联，`var(--x)` 解析不出颜色：`getComputedStyle` 换成桩，把探针上写的 color 原样
 * 包一层 `C<…>` 交回去 —— 于是「取的是哪个 token」在结果里直接可读。
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildSandboxDocument,
  parseSandboxMessage,
  type SandboxMessage
} from '@shuvix/chat-protocol/utils/interactiveFence'

/** 新 JSDOM 里本文件用到的那一小块窗口面 */
interface SandboxWindow {
  document: Document
  shuvix: { color(name: unknown): string; sendPrompt(text: unknown): void }
  Chart: unknown
  getComputedStyle: (el: Element) => unknown
  matchMedia?: unknown
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void
  eval(code: string): unknown
  close(): void
}

interface JsdomInstance {
  window: SandboxWindow
}
type JsdomCtor = new (html: string, options: { runScripts: 'dangerously' }) => JsdomInstance

const JSDOM = (globalThis as unknown as { jsdom: { constructor: JsdomCtor } }).jsdom.constructor

const opened: SandboxWindow[] = []

/** 在新窗口里跑一份沙箱文档；返回窗口与收到的全部消息（按到达顺序） */
function boot(body = '<p>sandbox</p>'): { win: SandboxWindow; messages: unknown[] } {
  const doc = buildSandboxDocument({ body, tokens: { '--viz-1': 'red' }, colorScheme: 'light' })
  const messages: unknown[] = []
  const dom = new JSDOM(doc, { runScripts: 'dangerously' })
  dom.window.addEventListener('message', (event) => messages.push(event.data))
  opened.push(dom.window)
  return { win: dom.window, messages }
}

/** 等到收到满足条件的那条消息（jsdom 的 postMessage 走 setTimeout） */
async function waitFor(messages: unknown[], pick: (m: unknown) => boolean): Promise<unknown> {
  for (let i = 0; i < 100; i++) {
    const hit = messages.find(pick)
    if (hit !== undefined) return hit
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`等不到那条消息；已收到：${JSON.stringify(messages)}`)
}

const parsed = (m: unknown): SandboxMessage | null => parseSandboxMessage(m)

/** getComputedStyle 桩：探针上写的 color 原样包一层（看得出取的是哪个 token） */
function stubComputedStyle(win: SandboxWindow): void {
  win.getComputedStyle = (el: Element) => ({
    color: `C<${(el as HTMLElement).style?.color ?? ''}>`,
    fontFamily: 'Stub Sans'
  })
}

/** 一个假的 Chart.js：只有桥碰得到的 defaults 与 register */
function fakeChart(): {
  defaults: {
    color?: string
    borderColor?: string
    aspectRatio?: number
    font: { family?: string }
    plugins: { colors: { enabled: boolean } }
  }
  register: ReturnType<typeof vi.fn>
} {
  return {
    defaults: { font: {}, plugins: { colors: { enabled: true } } },
    register: vi.fn()
  }
}

interface PalettePlugin {
  id: string
  beforeLayout(chart: { config: unknown }): void
}

afterEach(() => {
  for (const win of opened.splice(0)) win.close()
})

describe('桥的对外面（BR-1…3）', () => {
  it('BR-1 window.shuvix 冻结，键恰是 color 与 sendPrompt', () => {
    const { win } = boot()
    expect(Object.isFrozen(win.shuvix)).toBe(true)
    expect(Object.keys(win.shuvix).sort()).toEqual(['color', 'sendPrompt'])
  })

  it('BR-2 sendPrompt 发出的消息过得了宿主的 parseSandboxMessage；非字符串先 String() 一下', async () => {
    const { win, messages } = boot()
    win.shuvix.sendPrompt('x')
    const first = await waitFor(messages, (m) => parsed(m)?.type === 'prompt')
    expect(parsed(first)).toEqual({ type: 'prompt', text: 'x' })

    messages.length = 0
    win.shuvix.sendPrompt(42)
    const second = await waitFor(messages, (m) => parsed(m)?.type === 'prompt')
    expect(parsed(second)).toEqual({ type: 'prompt', text: '42' })
  })

  it('BR-3 加载完就报一次高度，那条消息宿主收得下', async () => {
    const { messages } = boot()
    const resize = await waitFor(messages, (m) => parsed(m)?.type === 'resize')
    const msg = parsed(resize)
    expect(msg?.type).toBe('resize')
    expect(msg && msg.type === 'resize' && Number.isFinite(msg.height)).toBe(true)
  })
})

describe('shuvix.color（BR-4）', () => {
  it('BR-4 只认 `--x` 形状的名字；合法的交回 getComputedStyle 算出的颜色', () => {
    const { win } = boot()
    stubComputedStyle(win)
    for (const bad of ['viz-1', '--viz-1)', 'var(--x)', 123, '', '--a b']) {
      expect(win.shuvix.color(bad), String(bad)).toBe('')
    }
    expect(win.shuvix.color('--viz-1')).toBe('C<var(--viz-1)>')
    expect(win.shuvix.color('--theme-text-primary')).toBe('C<var(--theme-text-primary)>')
  })
})

describe('Chart.js 的主题接管（BR-5 / 6）', () => {
  /** 赋 window.Chart（UMD 加载时就是这么做的），返回注册进去的取色插件 */
  function install(win: SandboxWindow): {
    chart: ReturnType<typeof fakeChart>
    plugin: PalettePlugin
  } {
    stubComputedStyle(win)
    const chart = fakeChart()
    win.Chart = chart
    expect(chart.register).toHaveBeenCalledTimes(1)
    return { chart, plugin: chart.register.mock.calls[0][0] as PalettePlugin }
  }

  it('BR-5 赋值即接管：注册一次 shuvixPalette、关掉自带调色、默认字色网格色取 token；再赋同一个不重复注册', () => {
    const { win } = boot()
    const { chart, plugin } = install(win)
    expect(plugin.id).toBe('shuvixPalette')
    expect(chart.defaults.plugins.colors.enabled).toBe(false)
    expect(chart.defaults.color).toBe('C<var(--theme-text-secondary)>')
    expect(chart.defaults.borderColor).toBe('C<var(--viz-grid)>')
    expect(chart.defaults.font.family).toBe('Stub Sans')
    // getter 交回的就是赋进去的那个对象
    expect(win.Chart).toBe(chart)

    win.Chart = chart
    expect(chart.register).toHaveBeenCalledTimes(1)
    expect(win.Chart).toBe(chart)
  })

  it('BR-6 取色插件：没指定颜色的数据集按槽位取 --viz-N（下标决定槽位）；饼图按扇区循环八色、不描边（扇区间的缝由 spacing 缺省值给）；ds.type 优先于 cfg.type', () => {
    const { win } = boot()
    const { plugin } = install(win)

    const bar = {
      config: {
        type: 'bar',
        data: {
          datasets: [{ data: [1, 2] }, { data: [3, 4], borderColor: 'red' }, { data: [5, 6] }]
        }
      }
    }
    plugin.beforeLayout(bar)
    const [ds0, ds1, ds2] = bar.config.data.datasets as Array<Record<string, unknown>>
    expect(ds0.backgroundColor).toBe('C<var(--viz-1)>')
    expect(ds0.borderColor).toBe('C<var(--viz-1)>')
    // 自己给了颜色的数据集一个字都不动（backgroundColor 也不补）
    expect(ds1.borderColor).toBe('red')
    expect(ds1.backgroundColor).toBeUndefined()
    // 槽位跟下标走，不跟「第几个没颜色的」走
    expect(ds2.backgroundColor).toBe('C<var(--viz-3)>')

    const pie = {
      config: {
        type: 'pie',
        data: { datasets: [{ data: Array.from({ length: 10 }, (_, i) => i + 1) }] }
      }
    }
    plugin.beforeLayout(pie)
    const slice = pie.config.data.datasets[0] as Record<string, unknown>
    expect(slice.backgroundColor).toEqual(
      [1, 2, 3, 4, 5, 6, 7, 8, 1, 2].map((n) => `C<var(--viz-${n})>`)
    )
    expect(slice.borderColor).toBeUndefined()

    // 混合图：数据集自己的 type 说了算
    const mixed = {
      config: {
        type: 'bar',
        data: { datasets: [{ type: 'doughnut', data: [1, 2] }, { data: [3] }] }
      }
    }
    plugin.beforeLayout(mixed)
    const [doughnut, plain] = mixed.config.data.datasets as Array<Record<string, unknown>>
    expect(doughnut.backgroundColor).toEqual(['C<var(--viz-1)>', 'C<var(--viz-2)>'])
    expect(plain.backgroundColor).toBe('C<var(--viz-2)>')
  })
})

// ─── 观感的缺省值（BR-7…14）与真 Chart.js（BR-16） ───────────────────────────

/** 形状松散的假 Chart.js：defaults / overrides 按用例预填，register 记调用 */
interface LooseChart {
  defaults: Record<string, unknown>
  overrides?: Record<string, unknown>
  register: ReturnType<typeof vi.fn>
}

const looseChart = (
  defaults: Record<string, unknown> = { font: {}, plugins: { colors: { enabled: true } } },
  overrides?: Record<string, unknown>
): LooseChart => ({ defaults, ...(overrides ? { overrides } : {}), register: vi.fn() })

/** 沿点号路径取值（缺一层就是 undefined） */
const at = (root: unknown, path: string): unknown =>
  path
    .split('.')
    .reduce<unknown>(
      (o, k) =>
        o !== null && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined,
      root
    )

/** 赋 window.Chart（UMD 加载时就是这么做的）；stub=false 时调用方已自己换好 getComputedStyle */
function take<T extends object>(win: SandboxWindow, chart: T, stub = true): T {
  if (stub) stubComputedStyle(win)
  win.Chart = chart
  return chart
}

/** 只看类型的调参数（具体数值是调出来的，不是契约） */
const NUMBER = Symbol('number')

/**
 * 观感缺省值的契约表：路径 → 值（NUMBER = 只要求是个数）。颜色按 stubComputedStyle 的 `C<…>` 写，
 * 读得出取的是哪个 token。animation.duration 是「没要求减少动效」时的值（jsdom 没有 matchMedia）
 */
const LOOK: ReadonlyArray<readonly [string, unknown]> = [
  ['elements.bar.borderRadius', 4],
  ['datasets.bar.maxBarThickness', 24],
  ['datasets.bar.categoryPercentage', 0.6],
  ['elements.line.borderWidth', 2],
  ['elements.line.borderCapStyle', 'round'],
  ['elements.line.borderJoinStyle', 'round'],
  ['datasets.line.pointRadius', 0],
  ['datasets.line.pointHoverRadius', 4],
  ['datasets.line.pointHitRadius', NUMBER],
  ['elements.arc.borderWidth', 0],
  ['datasets.doughnut.spacing', 2],
  ['datasets.doughnut.cutout', '62%'],
  ['datasets.pie.spacing', 2],
  ['scales.category.grid.display', false],
  ['scale.border.color', 'C<var(--viz-axis)>'],
  ['scale.grid.drawTicks', false],
  ['scale.ticks.padding', NUMBER],
  ['plugins.legend.align', 'start'],
  ['plugins.legend.labels.boxWidth', 8],
  ['plugins.legend.labels.boxHeight', 8],
  ['plugins.legend.labels.useBorderRadius', true],
  ['plugins.legend.labels.borderRadius', 2],
  ['plugins.legend.labels.padding', NUMBER],
  ['plugins.tooltip.backgroundColor', 'C<var(--theme-bg-tertiary)>'],
  ['plugins.tooltip.borderColor', 'C<var(--theme-border-primary)>'],
  ['plugins.tooltip.titleColor', 'C<var(--theme-text-primary)>'],
  ['plugins.tooltip.bodyColor', 'C<var(--theme-text-secondary)>'],
  ['plugins.tooltip.borderWidth', 1],
  ['plugins.tooltip.padding', NUMBER],
  ['plugins.tooltip.cornerRadius', NUMBER],
  ['plugins.tooltip.boxWidth', 8],
  ['plugins.tooltip.boxHeight', 8],
  ['plugins.tooltip.boxPadding', NUMBER],
  ['plugins.tooltip.titleFont.weight', '500'],
  ['plugins.title.color', 'C<var(--theme-text-primary)>'],
  ['plugins.title.align', 'start'],
  ['plugins.title.font.weight', '500'],
  ['plugins.title.font.size', 13],
  ['animation.duration', 400]
]

/**
 * LOOK 表里唯一一条「读的路径 ≠ 写的路径」：tooltip 的 titleFont 在真库里是路由属性
 * （defaultRoutes: titleFont → font），getter 每次交回 Object.assign({}, font, 本地值) 的新对象，
 * 所以桥整体写 titleFont，读回来再看 .weight
 */
const TOOLTIP_TITLE_WEIGHT = 'plugins.tooltip.titleFont.weight'
const writtenAt = (path: string): string =>
  path === TOOLTIP_TITLE_WEIGHT ? 'plugins.tooltip.titleFont' : path

/** 逐条比对 LOOK 表，返回不符的条目（空 = 全对） */
const lookMismatches = (defaults: unknown): string[] =>
  LOOK.flatMap(([path, want]) => {
    const got = at(defaults, path)
    const ok = want === NUMBER ? typeof got === 'number' && Number.isFinite(got) : got === want
    return ok ? [] : [`${path}: ${String(got)}`]
  })

/** 图例缺省值（一个函数）的调用形状 */
type LegendDisplay = (ctx?: unknown) => boolean

describe('观感的缺省值（BR-7…11）', () => {
  it('BR-7 值表：柱 / 线 / 环 / 坐标 / 图例 / 提示框 / 标题 / 动画都落在契约值上；折线图 interaction 在 overrides.line；图例 display 是函数', () => {
    const { win } = boot()
    const chart = take(win, looseChart(undefined, {}))
    expect(lookMismatches(chart.defaults)).toEqual([])
    expect(at(chart.overrides, 'line.interaction')).toEqual({ mode: 'index', intersect: false })
    expect(typeof at(chart.defaults, 'plugins.legend.display')).toBe('function')
  })

  it('BR-8 put 沿路补层但不动兄弟键：图例 labels 的 generateLabels / color、animation 的 easing 原样保留', () => {
    const { win } = boot()
    const generateLabels = (): unknown[] => []
    const chart = take(
      win,
      looseChart({
        font: {},
        plugins: { colors: { enabled: true }, legend: { labels: { generateLabels, color: 'x' } } },
        animation: { duration: 1000, easing: 'e' }
      })
    )
    const labels = at(chart.defaults, 'plugins.legend.labels') as Record<string, unknown>
    expect(labels.generateLabels).toBe(generateLabels)
    expect(labels.color).toBe('x')
    expect(labels.boxWidth).toBe(8)
    expect(at(chart.defaults, 'animation')).toEqual({ duration: 400, easing: 'e' })
  })

  it('BR-9 interaction 只写进 overrides.line（scales 不动、别的图型不动、全局 interaction 不动）；没有 overrides 也不抛、后面的缺省值照写', () => {
    const { win } = boot()
    const scales = { x: { type: 'category' } }
    const bar = { indexAxis: 'x' }
    const globalInteraction = { mode: 'nearest', intersect: true }
    const chart = take(
      win,
      looseChart(
        { font: {}, plugins: { colors: { enabled: true } }, interaction: globalInteraction },
        { line: { scales }, bar }
      )
    )
    const line = at(chart.overrides, 'line') as Record<string, unknown>
    expect(line.interaction).toEqual({ mode: 'index', intersect: false })
    expect(line.scales).toBe(scales)
    expect(Object.keys(line).sort()).toEqual(['interaction', 'scales'])
    expect(at(chart.overrides, 'bar')).toBe(bar)
    expect(bar).toEqual({ indexAxis: 'x' })
    expect(chart.defaults.interaction).toBe(globalInteraction)
    expect(globalInteraction).toEqual({ mode: 'nearest', intersect: true })

    // 没有 overrides（老版本 / 别的形状）：跳过这一项，排在它后面的缺省值照样写上
    const { win: win2 } = boot()
    const bare = looseChart()
    expect(() => take(win2, bare)).not.toThrow()
    expect(bare.overrides).toBeUndefined()
    expect(at(bare.defaults, 'plugins.title.font.size')).toBe(13)
    expect(at(bare.defaults, 'animation.duration')).toBe(400)
  })

  it('BR-10 减少动效：系统要求时 animation 整个关掉（别的缺省值照写）；不要求时时长 400 且保留兄弟键；matchMedia 缺失或抛错按不要求', () => {
    const w = (win: SandboxWindow): Record<string, unknown> =>
      win as unknown as Record<string, unknown>

    // 要求减少动效
    const { win: reduce } = boot()
    const asked: string[] = []
    w(reduce).matchMedia = (q: string) => {
      asked.push(q)
      return { matches: q === '(prefers-reduced-motion: reduce)' }
    }
    const off = take(reduce, looseChart())
    expect(asked).toContain('(prefers-reduced-motion: reduce)')
    expect(off.defaults.animation).toBe(false)
    expect(at(off.defaults, 'elements.bar.borderRadius')).toBe(4)
    expect(at(off.defaults, 'plugins.legend.align')).toBe('start')
    expect(at(off.defaults, 'plugins.title.font.size')).toBe(13)

    // 不要求：时长 400，已有的兄弟键不动
    const { win: normal } = boot()
    w(normal).matchMedia = () => ({ matches: false })
    const on = take(
      normal,
      looseChart({
        font: {},
        plugins: { colors: { enabled: true } },
        animation: { duration: 1000, easing: 'e' }
      })
    )
    expect(on.defaults.animation).toEqual({ duration: 400, easing: 'e' })

    // matchMedia 不存在 / 调用就抛：当作不要求
    for (const matchMedia of [
      undefined,
      () => {
        throw new Error('no media queries here')
      }
    ]) {
      const { win } = boot()
      w(win).matchMedia = matchMedia
      const chart = take(win, looseChart())
      expect(at(chart.defaults, 'animation.duration'), String(matchMedia)).toBe(400)
    }
  })

  it('BR-11 两个 try 互不连累：观感那段炸了，取色插件照样注册；取色那段炸了，观感照样写上', () => {
    // (a) defaults.elements 一读就抛：观感段第一条 put 就炸，整段跳过 —— 取色段在它之前、不受影响
    const { win } = boot()
    const broken = looseChart()
    Object.defineProperty(broken.defaults, 'elements', {
      configurable: true,
      get() {
        throw new Error('elements exploded')
      }
    })
    expect(() => take(win, broken)).not.toThrow()
    expect(broken.register).toHaveBeenCalledTimes(1)
    expect((broken.register.mock.calls[0][0] as PalettePlugin).id).toBe('shuvixPalette')
    expect(at(broken.defaults, 'plugins.colors.enabled')).toBe(false)

    // (b) defaults.font 不存在：取色段在写 font.family 时就抛了 —— 那一段里排在它后面的
    //     C.register 因此**没有**执行（取色插件不在），这是两段分开的代价，记在这里；观感段照写
    const { win: win2 } = boot()
    const noFont = looseChart({ plugins: { colors: { enabled: true } } }, {})
    expect(() => take(win2, noFont)).not.toThrow()
    expect(noFont.register).not.toHaveBeenCalled()
    expect(lookMismatches(noFont.defaults)).toEqual([])
    expect(at(noFont.overrides, 'line.interaction')).toEqual({ mode: 'index', intersect: false })
  })
})

describe('图例、面积图、宽高比（BR-12…14）', () => {
  it('BR-12 图例缺省值是个函数：单系列不画、零系列不画、两个系列画；饼图类照画（列的是扇区）；拿不到 chart 时画', () => {
    const { win } = boot()
    const chart = take(win, looseChart())
    const display = at(chart.defaults, 'plugins.legend.display') as LegendDisplay
    expect(typeof display).toBe('function')

    const ctx = (type: string, n: number): unknown => ({
      chart: { config: { type }, data: { datasets: Array.from({ length: n }, () => ({})) } }
    })
    expect(display(ctx('bar', 1))).toBe(false)
    expect(display(ctx('line', 0))).toBe(false)
    expect(display(ctx('bar', 2))).toBe(true)
    for (const type of ['pie', 'doughnut', 'polarArea']) {
      expect(display(ctx(type, 1)), type).toBe(true)
    }
    expect(display(undefined)).toBe(true)
    expect(display({})).toBe(true)
    expect(display({ type: 'chart' })).toBe(true)
  })

  it('BR-13 面积图的底色是同色 0.1 的淡洗：数据集 fill → 全图 elements.line.fill → 雷达缺省填；fill: 0 也算；描边永远实色；非 rgb() 的颜色原样', () => {
    const { win } = boot()
    // 每个槽位解析成一个互不相同的 rgb(n0, n1, n2)；别的 token 仍按 C<…> 交回
    const rgbOf = (n: number): string => `rgb(${n}0, ${n}1, ${n}2)`
    let resolve = (n: number): string => rgbOf(n)
    win.getComputedStyle = (el: Element) => {
      const color = (el as HTMLElement).style?.color ?? ''
      const slot = /^var\(--viz-(\d)\)$/.exec(color)
      return { color: slot ? resolve(Number(slot[1])) : `C<${color}>`, fontFamily: 'Stub Sans' }
    }
    const chart = take(win, looseChart(), false)
    const plugin = chart.register.mock.calls[0][0] as PalettePlugin
    const wash = (n: number): RegExp =>
      new RegExp(`^rgba\\(\\s*${n}0,\\s*${n}1,\\s*${n}2,\\s*0\\.1\\)$`)
    /** 跑一遍取色插件，交回处理后的数据集 */
    const run = (
      type: string,
      datasets: Array<Record<string, unknown>>,
      options?: Record<string, unknown>
    ): Array<Record<string, unknown>> => {
      const cfg = { config: { type, data: { datasets }, ...(options ? { options } : {}) } }
      plugin.beforeLayout(cfg)
      return datasets
    }

    // 折线：fill true / 'origin' 填，没写 / false 不填；描边都是实色
    const line = run('line', [{ fill: true }, { fill: 'origin' }, {}, { fill: false }])
    expect(line[0].backgroundColor).toMatch(wash(1))
    expect(line[1].backgroundColor).toMatch(wash(2))
    expect(line[2].backgroundColor).toBe(rgbOf(3))
    expect(line[3].backgroundColor).toBe(rgbOf(4))
    line.forEach((ds, i) => expect(ds.borderColor, `#${i}`).toBe(rgbOf(i + 1)))

    // 雷达：没写 fill 就是填（Chart.js 雷达的缺省）；显式 false 不填
    const radar = run('radar', [{}, { fill: false }])
    expect(radar[0].backgroundColor).toMatch(wash(1))
    expect(radar[1].backgroundColor).toBe(rgbOf(2))

    // fill: 0（填到第 0 个数据集）是假值却是填充
    expect(run('line', [{ fill: 0 }])[0].backgroundColor).toMatch(wash(1))
    // 数据集没写，看全图的 elements.line.fill
    expect(run('line', [{}], { elements: { line: { fill: true } } })[0].backgroundColor).toMatch(
      wash(1)
    )
    // 柱不是线：fill 写了也是实色
    expect(run('bar', [{ fill: true }])[0].backgroundColor).toBe(rgbOf(1))
    // 柱图里的一条折线：看数据集自己的 type
    const mixed = run('bar', [{}, { type: 'line', fill: true }])
    expect(mixed[0].backgroundColor).toBe(rgbOf(1))
    expect(mixed[1].backgroundColor).toMatch(wash(2))
    expect(mixed[1].borderColor).toBe(rgbOf(2))

    // 解析出来不是 rgb(…)（比如 color(srgb …)）：套不上 alpha，就原样用
    resolve = () => 'color(srgb 0.1 0.2 0.3)'
    const odd = run('line', [{ fill: true }])
    expect(odd[0].backgroundColor).toBe('color(srgb 0.1 0.2 0.3)')
    expect(odd[0].borderColor).toBe('color(srgb 0.1 0.2 0.3)')
  })

  it('BR-14 宽高比按根元素宽度收：>900 → 3、>560 → 2.5，再窄不动（留给 Chart.js 自己的缺省）', () => {
    const cases: Array<[number, number | undefined]> = [
      [1000, 3],
      [901, 3],
      [900, 2.5],
      [561, 2.5],
      [560, undefined],
      [0, undefined]
    ]
    for (const [width, want] of cases) {
      const { win } = boot()
      Object.defineProperty(win.document.documentElement, 'clientWidth', {
        configurable: true,
        get: () => width
      })
      const chart = take(win, looseChart())
      expect(chart.defaults.aspectRatio, `clientWidth=${width}`).toBe(want)
    }
  })
})

describe('随包的真 Chart.js（BR-16）', () => {
  const HERE = dirname(fileURLToPath(import.meta.url))
  /** `packages/chat-ui/src/components/chat/__tests__` 往上六层 */
  const REPO_ROOT = resolve(HERE, '../../../../../..')
  const CHART_SOURCE = readFileSync(
    join(REPO_ROOT, 'apps/desktop/resources/sandbox-libs/chart.umd.min.js'),
    'utf8'
  )

  /** 真 Chart.js 暴露的那一小块 */
  interface RealChart {
    defaults: Record<string, unknown>
    overrides: Record<string, unknown>
    registry: { getPlugin(id: string): unknown }
  }

  /** 一个没有桥的干净窗口里加载真库：库自己的 defaults 长什么样 */
  const pristineChart = (): RealChart => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
      runScripts: 'dangerously'
    })
    opened.push(dom.window)
    dom.window.eval(CHART_SOURCE)
    return dom.window.Chart as RealChart
  }

  it('BR-16 真库赋值即接管：取色插件进了注册表、观感值写得进真 defaults（含 getter/setter 路由）、库自己的键还在；桥里每条路径的前一两层真库里本来就有', () => {
    const { win } = boot()
    stubComputedStyle(win)
    // UMD 自己执行 `globalThis.Chart = factory()` —— 正是桥的 setter 陷阱等的那一下
    win.eval(CHART_SOURCE)
    const C = win.Chart as RealChart
    expect(C, '真库没挂到 window.Chart 上').toBeTruthy()
    expect(typeof C.registry?.getPlugin).toBe('function')

    // (a) 取色插件进了真注册表，库自带的调色关掉
    expect(C.registry.getPlugin('shuvixPalette')).toBeDefined()
    expect(at(C.defaults, 'plugins.colors.enabled')).toBe(false)
    expect(C.defaults.color).toBe('C<var(--theme-text-secondary)>')

    // (b) 每一条观感值读得回来 —— scale.border.color 与 plugins.title.color 在真库里是
    //     defaults.route() 装的 getter/setter，写进去的是私有槽位，读回来要走 getter；tooltip 的
    //     titleFont 本身就是路由（见 TOOLTIP_TITLE_WEIGHT），它抓到过逐段写 weight 被静默丢掉的那一回
    expect(lookMismatches(C.defaults)).toEqual([])
    expect(typeof at(C.defaults, 'plugins.legend.display')).toBe('function')
    expect(at(C.overrides, 'line.interaction')).toEqual({ mode: 'index', intersect: false })

    // (c) 库自己的键没被冲掉
    expect(typeof at(C.defaults, 'plugins.legend.labels.generateLabels')).toBe('function')
    expect(at(C.defaults, 'animation.easing')).toBe('easeOutQuart')
    expect(at(C.overrides, 'line.scales')).toBeTypeOf('object')

    // (d) 错拼守卫：桥里写的每条 put 路径，前一两层在**没有桥**的真库里本来就是对象 ——
    //     不然 put 会就地造出一层谁也不读的空对象，值写进去了、图上什么都没变，而且不报错
    const bridge = (() => {
      const doc = buildSandboxDocument({ body: '', tokens: {}, colorScheme: 'light' })
      return doc.slice(doc.indexOf('<script>') + '<script>'.length, doc.indexOf('</script>'))
    })()
    const paths = [...bridge.matchAll(/put\(d2,\s*'([^']+)'/g)].map((m) => m[1])
    expect(paths.length, '桥里应当有一批 put(d2, …)').toBeGreaterThan(30)
    // 值表与桥是同一批路径（表漏了一条，那条就没人看着）
    expect(new Set(paths)).toEqual(
      new Set([...LOOK.map(([p]) => writtenAt(p)), 'plugins.legend.display'])
    )
    expect(bridge).toMatch(/put\(C\.overrides,\s*'line\.interaction'/)

    const clean = pristineChart()
    expect(at(clean.defaults, 'plugins.colors.enabled'), '干净窗口里混进了桥').toBe(true)
    const missing = paths.flatMap((path) => {
      const segments = path.split('.')
      const prefix = segments.slice(0, Math.min(2, segments.length - 1)).join('.')
      const node = at(clean.defaults, prefix)
      return node !== null && typeof node === 'object' ? [] : [`${path}（${prefix}）`]
    })
    expect(missing).toEqual([])
    expect(at(clean.overrides, 'line')).toBeTypeOf('object')
  })
})
