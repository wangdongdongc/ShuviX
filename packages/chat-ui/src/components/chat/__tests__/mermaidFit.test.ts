/**
 * mermaid 图在对话里怎么摆（`mermaidFit.ts`）—— 三个纯函数，node 环境直接跑：
 *
 *  - `mermaidNaturalSize`：从 mermaid 产物的根 `<svg>` 读 viewBox 宽高。读不到就 null ——
 *    调用方那时不做限高、按原样放，所以 **null 是一个安全的答案，猜错的数不是**：一个从嵌套
 *    `<svg>`、`data-viewBox` 或半截属性里读出来的比例，会把整张图压变形。F4 那一串都是这种输入。
 *  - `mermaidLayout`：内联给多宽、整张缩还是按栏宽截、值不值得给「放大查看」。逐格的数值用例
 *    （F5..F13）钉住每一个分支边界；F14 是一张网格上的不变式扫描 —— 边界之间的任何一点都得
 *    满足「不放大、不超栏、整张缩时不超限高、截断时字读得清」。
 *  - `mermaidThemeVariables`：ShuviX 主题 token → mermaid base 主题变量。只钉「哪个 token 对哪个
 *    变量」，以及每个 token 在 11 套主题里都真有定义（F16）—— 少一套，那套主题下 mermaid 拿到的
 *    是空串，图的颜色静默回落成它自己的缺省。
 *
 * 真实 mermaid 产物的根长什么样见 F1：`width="100%"` 与 `style="max-width: …px"` 都在，
 * 能信的只有 viewBox。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MERMAID_FONT_SIZE,
  MERMAID_MAX_HEIGHT,
  MERMAID_MIN_READABLE_SCALE,
  mermaidFitWidth,
  mermaidLayout,
  mermaidNaturalSize,
  mermaidThemeVariables,
  type MermaidLayout,
  type MermaidSize
} from '../mermaidFit'

const HERE = dirname(fileURLToPath(import.meta.url))
/** `packages/chat-ui/src/components/chat/__tests__` 往上五层是 `packages/` */
const THEMES_CSS = readFileSync(resolve(HERE, '../../../../../app-shell/src/themes.css'), 'utf8')

const size = (width: number, height: number): MermaidSize => ({ width, height })
const layout = (
  mode: MermaidLayout['mode'],
  width: number,
  expandable: boolean
): MermaidLayout => ({
  mode,
  width,
  expandable
})

describe('mermaidNaturalSize —— 只信根上的 viewBox', () => {
  it('F1 真实 mermaid 产物的根：width="100%" 与 max-width 都不算，取 viewBox 的宽高', () => {
    const root =
      '<svg id="mermaid_0" width="100%" xmlns="http://www.w3.org/2000/svg" class="flowchart" ' +
      'style="max-width: 307.513671875px;" viewBox="0 0 307.513671875 1657.5" ' +
      'role="graphics-document document" aria-roledescription="flowchart-v2"><g></g></svg>'
    expect(mermaidNaturalSize(root)).toEqual({ width: 307.513671875, height: 1657.5 })
  })

  it('F2 原点不在 0,0（mermaid 常留 8 的边）：宽高仍取后两个数', () => {
    expect(mermaidNaturalSize('<svg viewBox="-8 -8 416 316"></svg>')).toEqual({
      width: 416,
      height: 316
    })
  })

  it('F3 逗号分隔、单引号、首尾与逗号旁的空白、小写 viewbox 与等号两侧的空白都认', () => {
    expect(mermaidNaturalSize('<svg viewBox="0,0,400,300"></svg>')).toEqual(size(400, 300))
    expect(mermaidNaturalSize("<svg viewBox=' 0, 0 , 400 300 '></svg>")).toEqual(size(400, 300))
    expect(mermaidNaturalSize('<svg viewbox = "0 0 400.5 300.25"></svg>')).toEqual(
      size(400.5, 300.25)
    )
  })

  it.each([
    ['空串', ''],
    ['不是 svg', '<div>x</div>'],
    [
      '根上没有 viewBox，嵌套的 <svg> 有（不能拿嵌套那个的比例）',
      '<svg width="10"><svg viewBox="0 0 5 5"></svg></svg>'
    ],
    ['三个数', '<svg viewBox="0 0 400"></svg>'],
    ['五个数', '<svg viewBox="0 0 400 300 1"></svg>'],
    ['宽不是数', '<svg viewBox="0 0 auto 300"></svg>'],
    ['宽为 0', '<svg viewBox="0 0 0 300"></svg>'],
    ['高为负', '<svg viewBox="0 0 400 -1"></svg>'],
    ['viewBox 为空串', '<svg viewBox=""></svg>'],
    ['Infinity 不是有限数', '<svg viewBox="0 0 Infinity 300"></svg>'],
    ['<svgx> 不是 <svg>', '<svgx viewBox="0 0 1 1"></svgx>'],
    ['只有 data-viewBox（属性名里含 viewBox 的不算）', '<svg data-viewBox="0 0 10 10"></svg>']
  ])('F4 %s → null（不按一个猜出来的比例压图）', (_label, svg) => {
    expect(mermaidNaturalSize(svg)).toBeNull()
  })
})

describe('mermaidFitWidth —— 不放大，按比例缩到限高以内', () => {
  it('F5 宽高比决定能给多宽；maxHeight 可改', () => {
    expect(mermaidFitWidth(size(400, 300))).toBe(400) // 本来就矮：原宽，不放大
    expect(mermaidFitWidth(size(400, 960))).toBe(200) // 缩到 480 高
    expect(mermaidFitWidth(size(400, 480))).toBe(400) // 恰好等于限高
    expect(mermaidFitWidth(size(400, 800), 200)).toBe(100)
  })
})

describe('mermaidLayout —— 整张缩、按栏宽截，还是给「放大查看」', () => {
  it('F6 小图：原尺寸，没什么可放大的', () => {
    expect(mermaidLayout(size(300, 200), 600)).toEqual(layout('fit', 300, false))
  })

  it('F7 恰好等于栏宽不算「被缩小」；半个像素的容差两侧各一格', () => {
    expect(mermaidLayout(size(600, 300), 600)).toEqual(layout('fit', 600, false))
    expect(mermaidLayout(size(600, 300), 599.6)).toEqual(layout('fit', 599.6, false))
    expect(mermaidLayout(size(600, 300), 599.4)).toEqual(layout('fit', 599.4, true))
  })

  it('F8 缩放比恰好 0.6 仍整张缩；再高一点就改按原宽截断', () => {
    expect(mermaidLayout(size(400, 800), 1000)).toEqual(layout('fit', 240, true))
    expect(mermaidLayout(size(400, 801), 1000)).toEqual(layout('clip', 400, true))
  })

  it('F9 长竖图：栏宽 ≥ 原宽的 0.6 就按栏宽截；差一个像素就只能整张缩', () => {
    expect(mermaidLayout(size(1000, 2000), 600)).toEqual(layout('clip', 600, true))
    expect(mermaidLayout(size(1000, 2000), 599)).toEqual(layout('fit', 240, true))
  })

  it('F10 宽图不截断：按栏宽整张缩，连按栏宽都读不动时也只能如此', () => {
    expect(mermaidLayout(size(1000, 400), 600)).toEqual(layout('fit', 600, true))
    expect(mermaidLayout(size(1000, 400), 599)).toEqual(layout('fit', 599, true))
    expect(mermaidLayout(size(2000, 300), 600)).toEqual(layout('fit', 600, true))
  })

  it('F11 栏比图宽时截断宽度是原宽，不是栏宽（不放大）', () => {
    expect(mermaidLayout(size(400, 900), 800)).toEqual(layout('clip', 400, true))
  })

  it('F12 栏宽还没量到（0 或负）：按限高整张缩、不看栏宽', () => {
    for (const box of [0, -1]) {
      expect(mermaidLayout(size(400, 300), box), `box ${box}`).toEqual(layout('fit', 400, false))
      expect(mermaidLayout(size(400, 960), box), `box ${box}`).toEqual(layout('fit', 200, true))
      expect(mermaidLayout(size(400, 4000), box), `box ${box}`).toEqual(layout('fit', 48, true))
    }
  })

  it('F13 两个常量；缺省 maxHeight 就是 MERMAID_MAX_HEIGHT；maxHeight 可改', () => {
    expect(MERMAID_MAX_HEIGHT).toBe(480)
    expect(MERMAID_MIN_READABLE_SCALE).toBe(0.6)
    for (const [s, box] of [
      [size(400, 300), 600],
      [size(1000, 2000), 600],
      [size(400, 960), 0]
    ] as const) {
      expect(mermaidLayout(s, box)).toEqual(mermaidLayout(s, box, 480))
    }
    const small = mermaidLayout(size(400, 300), 1000, 200)
    expect(small.mode).toBe('fit')
    expect(small.width).toBeCloseTo(266.667, 3)
    expect(small.expandable).toBe(true)
  })

  it('F14 网格扫描：每一格都守住不放大、不超栏、整张缩不超限高、截断时字读得清', () => {
    const WIDTHS = [50, 300, 640, 1000, 2400]
    const HEIGHTS = [40, 300, 480, 481, 800, 2000, 6000]
    const BOXES = [-1, 0, 120, 320, 599, 600, 700, 1200]
    let cells = 0
    for (const w of WIDTHS) {
      for (const h of HEIGHTS) {
        const fitWidth = mermaidFitWidth(size(w, h))
        for (const box of BOXES) {
          const out = mermaidLayout(size(w, h), box)
          const what = `${w}×${h} in ${box}: ${JSON.stringify(out)}`
          cells++
          // 不放大，也不是空的
          expect(out.width, what).toBeGreaterThan(0)
          expect(out.width, what).toBeLessThanOrEqual(w)
          // 量到栏宽之后不超栏
          if (box > 0) expect(out.width, what).toBeLessThanOrEqual(box)
          // 整张缩：显示高度不超限高
          if (out.mode === 'fit') {
            expect((out.width * h) / w, what).toBeLessThanOrEqual(MERMAID_MAX_HEIGHT + 1e-6)
          }
          // 截断：只在量到栏宽、截断后读得清、而整张缩读不清时才截；截了就一定能放大
          if (out.mode === 'clip') {
            expect(box, what).toBeGreaterThan(0)
            expect(out.width / w, what).toBeGreaterThanOrEqual(MERMAID_MIN_READABLE_SCALE)
            expect(Math.min(box, fitWidth) / w, what).toBeLessThan(MERMAID_MIN_READABLE_SCALE)
            expect(out.expandable, what).toBe(true)
          }
          // 不给「放大查看」= 显示的就是原尺寸全貌
          if (!out.expandable) {
            expect(out.mode, what).toBe('fit')
            expect(out.width, what).toBeGreaterThanOrEqual(w - 0.5)
          }
          // 整张缩到读不清，只可能是因为连按栏宽都读不清（否则该截断）
          if (box > 0 && out.mode === 'fit' && out.width / w < MERMAID_MIN_READABLE_SCALE) {
            expect(Math.min(box, w) / w, what).toBeLessThan(MERMAID_MIN_READABLE_SCALE)
          }
        }
      }
    }
    expect(cells).toBe(WIDTHS.length * HEIGHTS.length * BOXES.length)
  })
})

describe('mermaidThemeVariables —— 主题 token → mermaid base 主题变量', () => {
  /** 桩：把 token 原样包起来，谁对谁一眼可见 */
  const tag = (token: string): string => `<${token}>`

  it('F15 每个 mermaid 变量取的是哪个 token', () => {
    const vars = mermaidThemeVariables(tag, false, 'Sans')
    const expected: Record<string, string[]> = {
      '--theme-bg-secondary': ['background', 'tertiaryColor', 'clusterBkg', 'edgeLabelBackground'],
      '--theme-bg-tertiary': ['primaryColor', 'mainBkg'],
      '--theme-bg-hover': ['secondaryColor', 'noteBkgColor'],
      '--theme-border-primary': [
        'primaryBorderColor',
        'nodeBorder',
        'clusterBorder',
        'noteBorderColor'
      ],
      '--theme-text-primary': ['primaryTextColor', 'textColor', 'titleColor', 'noteTextColor'],
      '--theme-text-tertiary': ['lineColor', 'defaultLinkColor']
    }
    for (const [token, keys] of Object.entries(expected)) {
      for (const key of keys) expect(vars[key], key).toBe(tag(token))
    }
  })

  it('F16 除三个非颜色项外每个值都来自 resolve()，且用到的 token 在 11 套主题里都有定义', () => {
    const asked: string[] = []
    const vars = mermaidThemeVariables(
      (token) => {
        asked.push(token)
        return tag(token)
      },
      false,
      'Sans'
    )
    const NON_COLOR = new Set(['darkMode', 'fontFamily', 'fontSize'])
    const colorEntries = Object.entries(vars).filter(([key]) => !NON_COLOR.has(key))
    expect(colorEntries.length).toBeGreaterThan(0)
    for (const [key, value] of colorEntries) {
      expect(asked.map(tag), key).toContain(value)
    }

    // 各 `[data-theme='…'] { … }` 块 —— 与 app-shell 的 themes.test.ts 同一条正则
    const blocks = [...THEMES_CSS.matchAll(/^\[data-theme='([^']+)'\]\s*\{([\s\S]*?)^\}/gm)].map(
      (m) => ({ theme: m[1], body: m[2] })
    )
    expect(blocks).toHaveLength(11)
    const tokens = [...new Set(asked)]
    expect(tokens.length).toBeGreaterThan(0)
    for (const token of tokens) {
      for (const { theme, body } of blocks) {
        expect(body, `${theme} 没有定义 ${token}`).toMatch(new RegExp(`^\\s*${token}\\s*:`, 'm'))
      }
    }
  })

  it('F17 darkMode / fontFamily 原样透传；字号固定为 MERMAID_FONT_SIZE', () => {
    expect(mermaidThemeVariables(tag, true, 'A').darkMode).toBe(true)
    expect(mermaidThemeVariables(tag, false, 'A').darkMode).toBe(false)
    expect(mermaidThemeVariables(tag, false, 'Inter, sans-serif').fontFamily).toBe(
      'Inter, sans-serif'
    )
    expect(MERMAID_FONT_SIZE).toBe('13px')
    expect(mermaidThemeVariables(tag, false, 'A').fontSize).toBe(MERMAID_FONT_SIZE)
  })
})
