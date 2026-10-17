/**
 * Widget 面板主屏（WidgetHome）的纯计算 —— 网格怎么排、分几页、拖动后的新顺序、没有图标时的字和底色。
 * 不碰 DOM，组件（WidgetHome / WidgetIcon）与单测共用。
 */

/** 图标边长（px） */
export const ICON_SIZE = 52

/** 一格的宽、高（图标 + 名字 + 行距） */
export const CELL_WIDTH = 76
export const CELL_HEIGHT = 92

/** 主屏左右、上下留白与底部页码点的高度 */
export const HOME_PAD_X = 10
export const HOME_PAD_TOP = 14
export const DOTS_HEIGHT = 26

/** 主屏网格 */
export interface HomeGrid {
  cols: number
  rows: number
  perPage: number
}

/**
 * 主屏区域尺寸 → 几列几行。列数 3–8（面板最窄 200px 时是 3 列），行数至少 1；
 * 网格不滚动，放不下的进下一页
 */
export function homeGrid(width: number, height: number): HomeGrid {
  const cols = Math.min(8, Math.max(3, Math.floor((width - HOME_PAD_X * 2) / CELL_WIDTH)))
  const rows = Math.min(
    8,
    Math.max(1, Math.floor((height - HOME_PAD_TOP - DOTS_HEIGHT) / CELL_HEIGHT))
  )
  return { cols, rows, perPage: cols * rows }
}

/** 按每页格数切页；没有东西也有一页（空主屏） */
export function paginate<T>(items: readonly T[], perPage: number): T[][] {
  const size = Math.max(1, perPage)
  const pages: T[][] = []
  for (let i = 0; i < items.length; i += size) pages.push(items.slice(i, i + size))
  return pages.length > 0 ? pages : [[]]
}

/** 把 `from` 处的一项挪到 `to`（`to` 越界则夹到两端）；返回新数组 */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  if (from < 0 || from >= items.length) return [...items]
  const next = [...items]
  const [item] = next.splice(from, 1)
  next.splice(Math.max(0, Math.min(to, next.length)), 0, item)
  return next
}

/**
 * 拖动中指针在某一页网格里的位置 → 该页里的格子序号（夹在 0…该页已有格数）。
 * `x` / `y` 相对网格左上角
 */
export function slotAt(
  x: number,
  y: number,
  grid: HomeGrid,
  cellWidth: number,
  slotsOnPage: number
): number {
  const col = Math.max(0, Math.min(grid.cols - 1, Math.floor(x / cellWidth)))
  const row = Math.max(0, Math.min(grid.rows - 1, Math.floor(y / CELL_HEIGHT)))
  return Math.min(row * grid.cols + col, slotsOnPage)
}

/** 没有 icon.svg 时的底色槽位（主题的 `--viz-N-tint` / `--viz-N-ink`，N = 1…8），按 id 定 —— 同一个 widget 永远同一个颜色 */
export function iconSlot(id: string): number {
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0
  return (Math.abs(hash) % 8) + 1
}

/** 没有 icon.svg 时图标上的那个字：名字的第一个字（拉丁字母大写）；名字是空的就用 id */
export function monogram(name: string, id: string): string {
  const source = name.trim() || id
  const first = Array.from(source)[0] ?? '?'
  // 大写之后取第一个码点：'ß'.toUpperCase() 是 'SS'，图标上只放一个字
  return Array.from(first.toUpperCase())[0] ?? first
}
