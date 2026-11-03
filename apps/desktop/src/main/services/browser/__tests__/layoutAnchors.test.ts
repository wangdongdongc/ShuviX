/**
 * 外壳上报的矩形 → 贴着窗口边缘的矩形（layoutAnchors.ts，纯函数）。外壳量出来的页面区总比窗口晚，所以主进程只从上报里取
 * 「到边缘的距离」，再按窗口**现在**的尺寸算。
 *
 *   BLA-1   stretch：贴满整个窗口的页面区，窗口变大后铺满新尺寸，上沿不动；
 *   BLA-2   四边都有距离：窗口变大、变小，左、上、右、下四个距离都不变；
 *   BLA-3   晚到的上报：同样的距离，在旧窗口尺寸与新窗口尺寸下量的，算出来一模一样（不会把页面拉回旧尺寸）；
 *   BLA-4   缩放 1.25：CSS px 的距离按缩放换算成 DIP；
 *   BLA-5   各种缩放 + 贴边 + 奇数内容尺寸：四个值都是整数，右沿、下沿正好落在内容区边上（没有 1px 的缝）；
 *   BLA-6   取整的误差：距离 ±1 以内都算贴边，2 照留；
 *   BLA-7   窗口比距离还小：宽高至少 1，不出现 0 或负数；
 *   BLA-8   pin-bottom（停靠区里的 DevTools）：高度不变、整块跟着底边走，有底边距离时距离照留；
 *   BLA-9   scaledRect（平铺墙的卡片）：只按缩放取整，不看窗口尺寸；
 *   BLA-10  pin-bottom、内容区比停靠区还矮：y 为负、高度不变，不抛。
 */
import { describe, expect, it } from 'vitest'
import { anchoredRect, scaledRect } from '../layoutAnchors'

describe('stretch：页面区（BLA-1 … BLA-4）', () => {
  it('BLA-1 贴满窗口的页面区：窗口变大，铺满新尺寸，上沿不动', () => {
    expect(
      anchoredRect(
        { x: 0, y: 88, width: 800, height: 512 },
        { width: 800, height: 600 },
        { width: 1000, height: 700 },
        1,
        'stretch'
      )
    ).toEqual({ x: 0, y: 88, width: 1000, height: 612 })
  })

  it('BLA-2 四边都有距离（右 20、下 32）：窗口变大、变小，距离都不变', () => {
    const bounds = { x: 10, y: 88, width: 770, height: 480 }
    const viewport = { width: 800, height: 600 }
    expect(anchoredRect(bounds, viewport, { width: 1000, height: 700 }, 1, 'stretch')).toEqual({
      x: 10,
      y: 88,
      width: 970,
      height: 580
    })
    expect(anchoredRect(bounds, viewport, { width: 600, height: 400 }, 1, 'stretch')).toEqual({
      x: 10,
      y: 88,
      width: 570,
      height: 280
    })
  })

  it('BLA-3 晚到的上报：同样的距离，旧窗口尺寸下量的和新窗口尺寸下量的算出来一模一样', () => {
    const content = { width: 1000, height: 700 }
    const measuredOld = anchoredRect(
      { x: 10, y: 88, width: 770, height: 480 },
      { width: 800, height: 600 },
      content,
      1,
      'stretch'
    )
    const measuredNew = anchoredRect(
      { x: 10, y: 88, width: 970, height: 580 },
      { width: 1000, height: 700 },
      content,
      1,
      'stretch'
    )
    expect(measuredOld).toEqual(measuredNew)
    expect(measuredOld).toEqual({ x: 10, y: 88, width: 970, height: 580 })
  })

  it('BLA-4 缩放 1.25：内容区是 DIP；右边距离 8 CSS px = 10 DIP', () => {
    const content = { width: 1000, height: 750 }
    expect(
      anchoredRect(
        { x: 0, y: 88, width: 800, height: 512 },
        { width: 800, height: 600 },
        content,
        1.25,
        'stretch'
      )
    ).toEqual({ x: 0, y: 110, width: 1000, height: 640 })

    const rightEight = anchoredRect(
      { x: 0, y: 88, width: 792, height: 512 },
      { width: 800, height: 600 },
      content,
      1.25,
      'stretch'
    )
    expect(rightEight).toEqual({ x: 0, y: 110, width: 990, height: 640 })
    expect(rightEight.x + rightEight.width).toBe(990)
  })
})

describe('贴边与取整（BLA-5 / BLA-6）', () => {
  it.each([0.9, 1.1, 1.25, 1.5, 2])(
    'BLA-5 缩放 %f、贴边、奇数内容尺寸：都是整数，右沿下沿正好在内容区边上',
    (zoom) => {
      const content = { width: 1003, height: 757 }
      const r = anchoredRect(
        { x: 3, y: 77, width: 798, height: 523 },
        { width: 801, height: 600 },
        content,
        zoom,
        'stretch'
      )
      for (const v of [r.x, r.y, r.width, r.height]) expect(Number.isInteger(v)).toBe(true)
      expect(r.x + r.width).toBe(content.width)
      expect(r.y + r.height).toBe(content.height)
    }
  )

  it.each([
    ['右沿比窗口多 1', 801, 512],
    ['右沿比窗口少 1', 799, 512],
    ['下沿比窗口多 1', 800, 513],
    ['下沿比窗口少 1', 800, 511]
  ])('BLA-6 %s：算贴边，正好落在内容区边上', (_label, width, height) => {
    const r = anchoredRect(
      { x: 0, y: 88, width, height },
      { width: 800, height: 600 },
      { width: 1000, height: 700 },
      1,
      'stretch'
    )
    expect(r.x + r.width).toBe(1000)
    expect(r.y + r.height).toBe(700)
  })

  it('BLA-6 距离 2 照留（只有 1 以内才算贴边）', () => {
    const r = anchoredRect(
      { x: 0, y: 88, width: 798, height: 510 },
      { width: 800, height: 600 },
      { width: 1000, height: 700 },
      1,
      'stretch'
    )
    expect(r.x + r.width).toBe(998)
    expect(r.y + r.height).toBe(698)
  })
})

describe('极端尺寸（BLA-7）', () => {
  it('BLA-7 窗口比距离还小：宽高都是 1，不是 0 也不是负数', () => {
    expect(
      anchoredRect(
        { x: 100, y: 88, width: 600, height: 412 },
        { width: 800, height: 600 },
        { width: 150, height: 150 },
        1,
        'stretch'
      )
    ).toEqual({ x: 100, y: 88, width: 1, height: 1 })
  })
})

describe('pin-bottom：停靠区里的 DevTools（BLA-8 / BLA-10）', () => {
  const SLOT = { x: 0, y: 500, width: 1000, height: 260 }
  const VIEWPORT = { width: 1000, height: 760 }

  it('BLA-8 高度不变、整块跟着底边走；缩放 1.25 时高度按缩放换算', () => {
    expect(anchoredRect(SLOT, VIEWPORT, { width: 1200, height: 900 }, 1, 'pin-bottom')).toEqual({
      x: 0,
      y: 640,
      width: 1200,
      height: 260
    })
    expect(anchoredRect(SLOT, VIEWPORT, { width: 1250, height: 950 }, 1.25, 'pin-bottom')).toEqual({
      x: 0,
      y: 625,
      width: 1250,
      height: 325
    })
  })

  it('BLA-8 离底边有距离（20）：距离照留', () => {
    expect(
      anchoredRect(
        { x: 0, y: 480, width: 1000, height: 260 },
        VIEWPORT,
        { width: 1200, height: 900 },
        1,
        'pin-bottom'
      )
    ).toEqual({ x: 0, y: 620, width: 1200, height: 260 })
  })

  it('BLA-10 内容区比停靠区还矮：y 为负、高度不变，不抛', () => {
    expect(anchoredRect(SLOT, VIEWPORT, { width: 1000, height: 200 }, 1, 'pin-bottom')).toEqual({
      x: 0,
      y: -60,
      width: 1000,
      height: 260
    })
  })
})

describe('scaledRect：平铺墙的卡片（BLA-9）', () => {
  it('BLA-9 只按缩放取整；参数里没有窗口尺寸', () => {
    expect(scaledRect({ x: 3, y: 41, width: 577, height: 371 }, 1.25)).toEqual({
      x: 4,
      y: 51,
      width: 721,
      height: 464
    })
    expect(scaledRect.length).toBe(2)
  })
})
