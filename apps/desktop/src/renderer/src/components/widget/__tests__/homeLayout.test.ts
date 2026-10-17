/**
 * Widget 主屏的纯计算（homeLayout.ts）：网格、分页、拖动后的新顺序、拖动落点、没有图标时的底色槽位与字。
 *
 *   HL-1  homeGrid：(360,600) → 4 列 6 行 24 格；列数夹在 3…8，行数夹在 1…8；
 *   HL-2  paginate：空列表也有一页；按每页格数切；perPage 0 当 1；整除时末尾没有空页；
 *   HL-3  moveItem：前移 / 后移；to 越界夹到两端；from 越界返回内容相同的新数组；从不改入参；
 *   HL-4  slotAt：坐标 → 格子序号，负数夹到 0，越过右 / 下边夹到最后一格，再被该页已有格数封顶；
 *   HL-5  iconSlot：同一 id 永远同一槽位；随机 id 全落在 1…8 且八个都会出现；
 *   HL-6  monogram：名字第一个字（大写），名字空白就用 id；CJK / emoji 取一个完整码点；'ß' 大写后只取一个字。
 */
import { describe, expect, it } from 'vitest'
import { homeGrid, iconSlot, monogram, moveItem, paginate, slotAt } from '../homeLayout'

describe('homeGrid（HL-1）', () => {
  it('HL-1 360×600 → 4 列 6 行，每页 24 格', () => {
    expect(homeGrid(360, 600)).toEqual({ cols: 4, rows: 6, perPage: 24 })
  })

  it('HL-1 列数夹在 3…8', () => {
    expect(homeGrid(0, 600).cols).toBe(3)
    expect(homeGrid(2000, 600).cols).toBe(8)
  })

  it('HL-1 行数夹在 1…8', () => {
    expect(homeGrid(360, 0).rows).toBe(1)
    expect(homeGrid(360, 5000).rows).toBe(8)
  })

  it('HL-1 perPage = cols × rows', () => {
    const g = homeGrid(2000, 5000)
    expect(g.perPage).toBe(g.cols * g.rows)
    expect(g.perPage).toBe(64)
  })
})

describe('paginate（HL-2）', () => {
  it('HL-2 空列表 → 一页空页', () => {
    expect(paginate([], 4)).toEqual([[]])
  })

  it('HL-2 5 项每页 2 → [[a,b],[c,d],[e]]', () => {
    expect(paginate(['a', 'b', 'c', 'd', 'e'], 2)).toEqual([['a', 'b'], ['c', 'd'], ['e']])
  })

  it('HL-2 perPage 0 当 1', () => {
    expect(paginate(['a', 'b'], 0)).toEqual([['a'], ['b']])
  })

  it('HL-2 整除时末尾没有空页', () => {
    expect(paginate(['a', 'b', 'c', 'd'], 2)).toEqual([
      ['a', 'b'],
      ['c', 'd']
    ])
  })
})

describe('moveItem（HL-3）', () => {
  const items = ['a', 'b', 'c', 'd'] as const

  it('HL-3 往后挪', () => {
    expect(moveItem(items, 0, 2)).toEqual(['b', 'c', 'a', 'd'])
  })

  it('HL-3 往前挪', () => {
    expect(moveItem(items, 3, 1)).toEqual(['a', 'd', 'b', 'c'])
  })

  it('HL-3 to 为负 → 挪到最前', () => {
    expect(moveItem(items, 2, -5)).toEqual(['c', 'a', 'b', 'd'])
  })

  it('HL-3 to 越过末尾 → 挪到最后', () => {
    expect(moveItem(items, 0, 99)).toEqual(['b', 'c', 'd', 'a'])
  })

  it('HL-3 from 越界 → 内容不变，但是新数组', () => {
    for (const from of [-1, 4, 10]) {
      const out = moveItem(items, from, 1)
      expect(out).toEqual([...items])
      expect(out).not.toBe(items)
    }
  })

  it('HL-3 从不改入参', () => {
    const input = ['a', 'b', 'c']
    const out = moveItem(input, 0, 2)
    expect(input).toEqual(['a', 'b', 'c'])
    expect(out).not.toBe(input)
  })
})

describe('slotAt（HL-4）', () => {
  const grid = { cols: 4, rows: 2, perPage: 8 }

  it('HL-4 左上角 → 0', () => {
    expect(slotAt(0, 0, grid, 80, 8)).toBe(0)
  })

  it('HL-4 第二列 → 1', () => {
    expect(slotAt(85, 0, grid, 80, 8)).toBe(1)
  })

  it('HL-4 第二行第一列 → 4（行高 CELL_HEIGHT=92）', () => {
    expect(slotAt(0, 92, grid, 80, 8)).toBe(4)
  })

  it('HL-4 负坐标夹到 0', () => {
    expect(slotAt(-50, -50, grid, 80, 8)).toBe(0)
  })

  it('HL-4 越过右 / 下边 → 最后一格', () => {
    expect(slotAt(10_000, 10_000, grid, 80, 8)).toBe(7)
  })

  it('HL-4 被该页已有格数封顶', () => {
    expect(slotAt(10_000, 10_000, grid, 80, 3)).toBe(3)
    expect(slotAt(0, 92, grid, 80, 3)).toBe(3)
    expect(slotAt(85, 0, grid, 80, 3)).toBe(1)
  })
})

describe('iconSlot（HL-5）', () => {
  it('HL-5 同一 id 永远同一槽位', () => {
    expect(iconSlot('demo-widget')).toBe(iconSlot('demo-widget'))
  })

  it('HL-5 500 个 id 全落在 1…8，且八个槽位都出现', () => {
    const seen = new Set<number>()
    for (let i = 0; i < 500; i++) {
      const slot = iconSlot(`widget-${i.toString(36)}-${(i * 7919).toString(16)}`)
      expect(Number.isInteger(slot)).toBe(true)
      expect(slot).toBeGreaterThanOrEqual(1)
      expect(slot).toBeLessThanOrEqual(8)
      seen.add(slot)
    }
    expect([...seen].sort()).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })
})

describe('monogram（HL-6）', () => {
  it('HL-6 名字第一个字母大写', () => {
    expect(monogram('demo', 'x')).toBe('D')
  })

  it('HL-6 去掉前导空白', () => {
    expect(monogram('  hello', 'x')).toBe('H')
  })

  it('HL-6 名字空 / 全空白 → id 的第一个字（大写）', () => {
    expect(monogram('', 'abc-def')).toBe('A')
    expect(monogram('   ', 'zed-1')).toBe('Z')
  })

  it('HL-6 CJK 取第一个字', () => {
    expect(monogram('小组件', 'x')).toBe('小')
  })

  it('HL-6 emoji 取完整码点（不切代理对）', () => {
    expect(monogram('😀x', 'x')).toBe('😀')
  })

  it("HL-6 'ß' 大写成 'SS' 后只取一个字", () => {
    expect(monogram('ßx', 'x')).toBe('S')
  })
})
