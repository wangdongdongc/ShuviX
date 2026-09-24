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
 *    没指定颜色的数据集按槽位取 --viz-N，饼图类按扇区取。
 *
 * jsdom 不做级联，`var(--x)` 解析不出颜色：`getComputedStyle` 换成桩，把探针上写的 color 原样
 * 包一层 `C<…>` 交回去 —— 于是「取的是哪个 token」在结果里直接可读。
 */
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
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void
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

  it('BR-6 取色插件：没指定颜色的数据集按槽位取 --viz-N（下标决定槽位）；饼图按扇区循环八色、描边取底色；ds.type 优先于 cfg.type', () => {
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
    expect(slice.borderColor).toBe('C<var(--theme-bg-primary)>')

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
