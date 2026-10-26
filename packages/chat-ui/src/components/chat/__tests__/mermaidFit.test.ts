/**
 * mermaid 图在对话里怎么摆（`mermaidFit.ts`）—— 纯函数，node 环境直接跑：
 *
 *  - `mermaidFitWidth` / `mermaidLayout`：收起时（限高 480）内联给多宽、整张缩还是按栏宽截，
 *    `expandable` 说的是「显示的不是原尺寸全貌」。逐格的数值用例（F5..F13）钉住每一个分支边界；
 *    F14 是一张网格上的不变式扫描 —— 边界之间的任何一点都得满足「不放大、不超栏、整张缩时不超
 *    限高、截断时字读得清」。
 *  - `mermaidUnfoldedLayout`：点了「展开」之后的摆法 —— 不限高、只受栏宽约束；它的 `expandable`
 *    = 展开了还被栏宽缩着，组件只在这时给「放大查看」弹窗（F19）。
 *  - `mermaidUnfoldable`：值不值得给「展开」—— 限高藏住了一部分（clip），或把整张缩得比只按栏宽摆
 *    更小（fit）；只被栏宽缩小的宽图不给（F20..F23）。F24 是两者与 mermaidLayout 之间的不变式网格。
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
  mermaidUnfoldable,
  mermaidUnfoldedLayout,
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

describe('mermaidLayout —— 收起时整张缩、按栏宽截，显示的是不是全貌', () => {
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
          // 截断：只在量到栏宽、截断后读得清、而整张缩读不清时才截；截了显示的就一定不是全貌
          // （expandable）—— 给不给「放大查看」弹窗另看展开后的摆法（F19），给「展开」见 F20
          if (out.mode === 'clip') {
            expect(box, what).toBeGreaterThan(0)
            expect(out.width / w, what).toBeGreaterThanOrEqual(MERMAID_MIN_READABLE_SCALE)
            expect(Math.min(box, fitWidth) / w, what).toBeLessThan(MERMAID_MIN_READABLE_SCALE)
            expect(out.expandable, what).toBe(true)
          }
          // 不是 expandable = 显示的就是原尺寸全貌
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

describe('mermaidUnfoldedLayout —— 展开后：不限高，只受栏宽约束', () => {
  it('F19 总是 fit、宽 = 原宽与栏宽取小；expandable = 展开了还被栏宽缩着', () => {
    // 长竖图：收起时截断，展开后按原宽整张摆 —— 全貌，不再给「放大查看」
    expect(mermaidUnfoldedLayout(size(400, 3000), 600)).toEqual(layout('fit', 400, false))
    // 比栏宽：展开后也只能按栏宽缩着
    expect(mermaidUnfoldedLayout(size(1000, 2000), 600)).toEqual(layout('fit', 600, true))
    expect(mermaidUnfoldedLayout(size(2000, 300), 600)).toEqual(layout('fit', 600, true))
    // 极高极窄：高度不再管，原宽照摆
    expect(mermaidUnfoldedLayout(size(100, 100000), 600)).toEqual(layout('fit', 100, false))
    // 半个像素的容差同 mermaidLayout（F7）
    expect(mermaidUnfoldedLayout(size(600, 3000), 599.6)).toEqual(layout('fit', 599.6, false))
    expect(mermaidUnfoldedLayout(size(600, 3000), 599.4)).toEqual(layout('fit', 599.4, true))
    // 栏宽还没量到：按原宽（CSS 的 min(100%, …) 兜住栏宽），从不说「被栏宽缩着」
    for (const box of [0, -1]) {
      expect(mermaidUnfoldedLayout(size(1000, 2000), box), `box ${box}`).toEqual(
        layout('fit', 1000, false)
      )
      expect(mermaidUnfoldedLayout(size(400, 3000), box), `box ${box}`).toEqual(
        layout('fit', 400, false)
      )
    }
    // 与高度无关：同宽的矮图与高图展开后一样宽
    expect(mermaidUnfoldedLayout(size(400, 300), 600).width).toBe(400)
    expect(mermaidUnfoldedLayout(size(400, 3000), 600).width).toBe(400)
  })
})

describe('mermaidUnfoldable —— 限高藏住或缩小了图，才给「展开」', () => {
  /** 一格：期望的 unfoldable，外加收起时的模式（说明落在 mermaidLayout 的哪一支） */
  const cases: Array<[string, MermaidSize, number, boolean, MermaidLayout['mode']]> = [
    ['截断（栏比图宽）', size(400, 3000), 600, true, 'clip'],
    ['截断（按栏宽）', size(1000, 2000), 600, true, 'clip'],
    ['按高度整张缩', size(600, 700), 800, true, 'fit'],
    ['按高度整张缩，比例恰好 0.6', size(400, 800), 1000, true, 'fit'],
    ['栏宽与高度都缩，高度说了算', size(1000, 750), 800, true, 'fit'],
    ['只被栏宽缩小', size(1200, 300), 800, false, 'fit'],
    ['只被栏宽缩小（F10）', size(1000, 400), 600, false, 'fit'],
    ['读不清的退路，栏宽说了算', size(1200, 700), 600, false, 'fit'],
    ['读不清的退路，矮宽图', size(3000, 1000), 600, false, 'fit'],
    ['读不清的退路，高度说了算（不截也给）', size(3000, 4000), 600, true, 'fit'],
    ['差一个像素截不了，只能整张缩（F9）', size(1000, 2000), 599, true, 'fit'],
    ['没缩小', size(300, 200), 600, false, 'fit'],
    ['恰好等于限高', size(400, 480), 800, false, 'fit'],
    ['栏窄到只剩 16：栏宽比限高更紧', size(95, 1808), 16, false, 'fit'],
    ['栏宽 40：限高比栏宽更紧', size(95, 1808), 40, true, 'fit']
  ]

  it('F20 按 mermaidLayout 的每一支：截断总给；整张缩只在比按栏宽摆更小时给', () => {
    for (const [what, s, box, want, mode] of cases) {
      const label = `${what}: ${s.width}×${s.height} in ${box}`
      expect(mermaidLayout(s, box).mode, label).toBe(mode)
      expect(mermaidUnfoldable(s, box), label).toBe(want)
    }
  })

  it('F21 半个像素的容差：480.5 见方不给、481 见方给（量没量到栏宽都一样）；改了 maxHeight 也一样；mermaidLayout 的 expandable 在同一处翻', () => {
    for (const box of [800, 0]) {
      expect(mermaidUnfoldable(size(480.5, 480.5), box), `480.5 in ${box}`).toBe(false)
      expect(mermaidLayout(size(480.5, 480.5), box).expandable, `480.5 in ${box}`).toBe(false)
      expect(mermaidUnfoldable(size(481, 481), box), `481 in ${box}`).toBe(true)
      expect(mermaidLayout(size(481, 481), box).expandable, `481 in ${box}`).toBe(true)
    }
    expect(mermaidUnfoldable(size(200, 200), 400, 199.5)).toBe(false)
    expect(mermaidLayout(size(200, 200), 400, 199.5).expandable).toBe(false)
    expect(mermaidUnfoldable(size(200, 200), 400, 199)).toBe(true)
    expect(mermaidLayout(size(200, 200), 400, 199).expandable).toBe(true)
  })

  it('F22 栏宽还没量到（0 或负）：只看高度 —— 高图给，矮图与宽矮图不给', () => {
    for (const box of [0, -1]) {
      expect(mermaidUnfoldable(size(400, 3000), box), `box ${box}`).toBe(true)
      expect(mermaidUnfoldable(size(400, 960), box), `box ${box}`).toBe(true)
      expect(mermaidUnfoldable(size(400, 300), box), `box ${box}`).toBe(false)
      expect(mermaidUnfoldable(size(2000, 300), box), `box ${box}`).toBe(false)
    }
  })

  it('F23 maxHeight：缺省就是 MERMAID_MAX_HEIGHT；更低的限高让矮图也值得展开；不限高就没有可展开的', () => {
    for (const [s, box] of [
      [size(400, 300), 600],
      [size(400, 3000), 600],
      [size(1000, 750), 800],
      [size(1200, 300), 800],
      [size(400, 960), 0]
    ] as const) {
      expect(mermaidUnfoldable(s, box), `${s.width}×${s.height} in ${box}`).toBe(
        mermaidUnfoldable(s, box, MERMAID_MAX_HEIGHT)
      )
    }
    expect(mermaidUnfoldable(size(400, 300), 1000, 200)).toBe(true)
    expect(mermaidUnfoldable(size(400, 300), 1000)).toBe(false)
    expect(mermaidUnfoldable(size(400, 3000), 600, Infinity)).toBe(false)
  })

  it('F24 网格扫描：展开后的摆法、给不给「展开」与收起时的摆法互相咬合', () => {
    const WIDTHS = [50, 300, 480.5, 481, 640, 1000, 2400]
    const HEIGHTS = [40, 300, 480, 480.5, 481, 482, 800, 2000, 6000]
    const BOXES = [-1, 0, 16, 120, 320, 599, 600, 700, 1200]
    let cells = 0
    for (const w of WIDTHS) {
      for (const h of HEIGHTS) {
        for (const box of BOXES) {
          const s = size(w, h)
          const u = mermaidUnfoldable(s, box)
          const un = mermaidUnfoldedLayout(s, box)
          const cap = mermaidLayout(s, box)
          const what = `${w}×${h} in ${box}: cap=${JSON.stringify(cap)} un=${JSON.stringify(un)} u=${u}`
          /** 展开后的显示高度 */
          const uh = (un.width * h) / w
          cells++
          // G1 展开后从不截断
          expect(un.mode, what).toBe('fit')
          // G2 不放大、不是空的；量到栏宽 = 原宽与栏宽取小，没量到 = 原宽
          expect(un.width, what).toBeGreaterThan(0)
          expect(un.width, what).toBeLessThanOrEqual(w)
          expect(un.width, what).toBe(box > 0 ? Math.min(box, w) : w)
          // G3 展开后的 expandable 就是「被栏宽缩着」；没量到栏宽就不可能被它缩着
          expect(un.expandable, what).toBe(un.width < w - 0.5)
          if (box <= 0) expect(un.expandable, what).toBe(false)
          // G4 展开不会让图变窄
          expect(un.width, what).toBeGreaterThanOrEqual(cap.width)
          // G5 截断了就一定给「展开」
          if (cap.mode === 'clip') expect(u, what).toBe(true)
          // G6 给「展开」时收起的那张一定不是全貌
          if (u) expect(cap.expandable, what).toBe(true)
          // G7 不给「展开」= 收起时整张缩着、宽度与展开后（差不出半个像素）一样
          if (!u) {
            expect(cap.mode, what).toBe('fit')
            expect(un.width - cap.width, what).toBeLessThanOrEqual(0.5)
          }
          // G8 给「展开」时，展开后确实比限高高
          if (u) expect(uh, what).toBeGreaterThan(MERMAID_MAX_HEIGHT)
          // G9 展开了还被栏宽缩着，收起时就更不是全貌
          if (un.expandable) expect(cap.expandable, what).toBe(true)
          // G10 展开后比限高高出容差以上，就一定给「展开」
          if (uh > MERMAID_MAX_HEIGHT + (0.5 * h) / w + 1e-6) expect(u, what).toBe(true)
          // G11 展开后的摆法 = 不限高的 mermaidLayout
          expect(un, what).toEqual(mermaidLayout(s, box, Infinity))
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
