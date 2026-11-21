/**
 * 看图的几何（viewerMath，纯函数）。
 *
 *   VM-1 fitScale 不放大小图
 *   VM-2 大图按舞台减边缩小；margin 0 时按整个舞台
 *   VM-3 原尺寸 ≤0 → 1；舞台 0×0 → 可用宽高按 1 算
 *   VM-4 minScale = min(fit, 1) / 2
 *   VM-5 clampOffset：比舞台小的方向强制 0；大的方向夹在 ±(显示尺寸 − 舞台)/2；范围内原样；scale 不变
 *   VM-6 zoomAt：到适合窗口或更小 → 回正中；低于最小比例抬上来；高于 8 压到 8
 *   VM-7 zoomAt 以给的点为不动点；越界时被夹住
 *   VM-8 isZoomedIn
 *   VM-9 stepScale ×1.25 / ÷1.25 来回一致
 */
import { describe, expect, it } from 'vitest'
import {
  MAX_SCALE,
  clampOffset,
  fitScale,
  isZoomedIn,
  minScale,
  stepScale,
  zoomAt
} from '../viewerMath'

const size = (width: number, height: number): { width: number; height: number } => ({
  width,
  height
})

describe('VM-1 / VM-2 / VM-3 fitScale', () => {
  it('VM-1 小图不放大', () => {
    expect(fitScale(size(100, 100), size(1000, 800))).toBe(1)
  })

  it('VM-2 2000×1000 在 1048×848（边 24）→ 0.5；margin 0 → 0.524', () => {
    expect(fitScale(size(2000, 1000), size(1048, 848))).toBeCloseTo(0.5, 10)
    expect(fitScale(size(2000, 1000), size(1048, 848), 0)).toBeCloseTo(0.524, 10)
  })

  it('VM-3 原尺寸 ≤0 → 1', () => {
    expect(fitScale(size(0, 100), size(1000, 800))).toBe(1)
    expect(fitScale(size(100, -1), size(1000, 800))).toBe(1)
  })

  it('VM-3 舞台 0×0 → 可用宽高按 1 算（1/原尺寸）', () => {
    expect(fitScale(size(200, 100), size(0, 0))).toBeCloseTo(1 / 200, 12)
  })
})

describe('VM-4 minScale', () => {
  it('fit 的一半，fit 超过 1 按 1 算', () => {
    expect(minScale(0.5)).toBe(0.25)
    expect(minScale(1)).toBe(0.5)
    expect(minScale(3)).toBe(0.5)
  })
})

describe('VM-5 clampOffset', () => {
  it('比舞台小 → 平移强制 0（±0 都算）', () => {
    const v = clampOffset({ scale: 1, x: 100, y: -50 }, size(200, 100), size(1000, 800))
    expect(v.scale).toBe(1)
    expect(v.x === 0).toBe(true)
    expect(v.y === 0).toBe(true)
  })

  it('1000×1000 放大 2 倍在 1000×800：x ±500，y ±600', () => {
    const nat = size(1000, 1000)
    const st = size(1000, 800)
    expect(clampOffset({ scale: 2, x: 9999, y: 9999 }, nat, st)).toEqual({
      scale: 2,
      x: 500,
      y: 600
    })
    expect(clampOffset({ scale: 2, x: -9999, y: -9999 }, nat, st)).toEqual({
      scale: 2,
      x: -500,
      y: -600
    })
    expect(clampOffset({ scale: 2, x: 120, y: -300 }, nat, st)).toEqual({
      scale: 2,
      x: 120,
      y: -300
    })
  })
})

describe('VM-6 zoomAt 的界', () => {
  const nat = size(2000, 2000)
  const st = size(1000, 1000)
  const fit = fitScale(nat, st)
  const from = { scale: 1, x: 100, y: 100 }

  it('到适合窗口或更小 → 回正中', () => {
    expect(zoomAt(from, fit, { x: 30, y: 30 }, nat, st)).toEqual({ scale: fit, x: 0, y: 0 })
    expect(zoomAt(from, fit * 0.8, { x: 30, y: 30 }, nat, st)).toEqual({
      scale: fit * 0.8,
      x: 0,
      y: 0
    })
  })

  it('低于最小比例 → 抬到最小比例', () => {
    expect(zoomAt(from, 0.001, { x: 0, y: 0 }, nat, st)).toEqual({
      scale: minScale(fit),
      x: 0,
      y: 0
    })
  })

  it('高于 8 → 压到 8', () => {
    expect(zoomAt(from, 100, { x: 0, y: 0 }, nat, st).scale).toBe(MAX_SCALE)
  })
})

describe('VM-7 zoomAt 的不动点', () => {
  it('2000² 在 1000²，从 1 到 2、以 (100, 50) 为中心 → (−100, −50)', () => {
    const v = zoomAt(
      { scale: 1, x: 0, y: 0 },
      2,
      { x: 100, y: 50 },
      size(2000, 2000),
      size(1000, 1000)
    )
    expect(v.scale).toBe(2)
    expect(v.x).toBeCloseTo(-100, 10)
    expect(v.y).toBeCloseTo(-50, 10)
  })

  it('越界时被夹住', () => {
    // 1200² 在 1000²，从 (100, −100) 以 (−2000, 2000) 为中心放到 1.2：未夹是 (520, −520)，余量 (1440−1000)/2 = 220
    const v = zoomAt(
      { scale: 1, x: 100, y: -100 },
      1.2,
      { x: -2000, y: 2000 },
      size(1200, 1200),
      size(1000, 1000)
    )
    expect(v.scale).toBe(1.2)
    expect(v.x).toBeCloseTo(220, 10)
    expect(v.y).toBeCloseTo(-220, 10)
  })
})

describe('VM-8 isZoomedIn', () => {
  const nat = size(2000, 2000)
  const st = size(1000, 1000)
  const fit = fitScale(nat, st)

  it('适合窗口时 false，多一点 true', () => {
    expect(isZoomedIn({ scale: fit, x: 0, y: 0 }, nat, st)).toBe(false)
    expect(isZoomedIn({ scale: fit + 0.01, x: 0, y: 0 }, nat, st)).toBe(true)
  })

  it('小图在 1 倍时 false', () => {
    expect(isZoomedIn({ scale: 1, x: 0, y: 0 }, size(100, 100), st)).toBe(false)
  })
})

describe('VM-9 stepScale', () => {
  it('×1.25 / ÷1.25，来回一致', () => {
    expect(stepScale(1, 1)).toBe(1.25)
    expect(stepScale(1, -1)).toBe(0.8)
    expect(stepScale(stepScale(0.37, 1), -1)).toBeCloseTo(0.37, 12)
  })
})
