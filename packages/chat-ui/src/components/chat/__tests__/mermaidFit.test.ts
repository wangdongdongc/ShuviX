/**
 * mermaid 图在对话里怎么摆（`mermaidFit.ts`）—— 纯函数，node 环境直接跑：
 *
 *  - `mermaidFitWidth` / `mermaidLayout`：内联给多宽、整张缩还是按栏宽截、值不值得给「放大查看」。
 *    逐格的数值用例（F5..F13）钉住每一个分支边界；F14 是一张网格上的不变式扫描 —— 边界之间的
 *    任何一点都得满足「不放大、不超栏、整张缩时不超限高、截断时字读得清」。
 *  - `MERMAID_FONT_SIZE`：传给 pele `render` 的字号（数字，px）—— pele 按它量字宽（F17）。
 *
 * 2026-10-17 mermaid.js 换成 pele 之后，这里不再管尺寸读取与配色：图的自然尺寸由 pele 的
 * `render` 直接给出（`mermaidNaturalSize` 删了），配色是 `var(--pele-*)`、由 themes.css 的 `.pele`
 * 接到主题 token 上（`mermaidThemeVariables` 删了，token 覆盖在 app-shell 的 themes.test.ts）。
 * F18 钉住这两个导出确实不在了 —— 它们回来就意味着又有人按 mermaid.js 的方式取尺寸 / 取色。
 */
import { describe, it, expect } from 'vitest'
import * as mermaidFit from '../mermaidFit'
import {
  MERMAID_FONT_SIZE,
  MERMAID_MAX_HEIGHT,
  MERMAID_MIN_READABLE_SCALE,
  mermaidFitWidth,
  mermaidLayout,
  type MermaidLayout,
  type MermaidSize
} from '../mermaidFit'

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

describe('MERMAID_FONT_SIZE 与已删的导出', () => {
  it("F17 字号是数字 13（px）—— pele 的 fontSize 选项要数字，不是 '13px'", () => {
    expect(MERMAID_FONT_SIZE).toBe(13)
    expect(typeof MERMAID_FONT_SIZE).toBe('number')
  })

  it('F18 mermaid.js 时代的 mermaidThemeVariables / mermaidNaturalSize 不在模块里', () => {
    expect('mermaidThemeVariables' in mermaidFit).toBe(false)
    expect('mermaidNaturalSize' in mermaidFit).toBe(false)
  })
})
