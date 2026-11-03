/**
 * 外壳上报的矩形 → 贴着窗口边缘的矩形。
 *
 * 外壳是个网页，它量出来的页面区总比窗口晚：窗口变了 → 主进程告诉外壳 → 外壳排版、量好 → IPC 回主进程，真实
 * 拖动窗口边框时这一圈要 15~140ms（2026-11-03 实测，Electron 39）。Chromium 在 Core Animation 提交时同步等
 * 新尺寸的帧，页面的新尺寸晚到还会多等一轮，把窗口自己的帧率也拖下来。所以窗口一变，主进程在 `resize` 事件里
 * 当场重摆，用不着等外壳。
 *
 * 能这么做是因为页面区贴着窗口边缘：矩形到窗口四边的距离不随窗口大小变。外壳上报矩形时带上它量的那一刻的窗口尺寸，
 * 这里只从中取「到边缘的距离」，再按窗口**现在**的尺寸算 —— 所以外壳晚到的上报也不会把页面拉回旧尺寸。
 */

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** 外壳量矩形那一刻的窗口内容区尺寸（CSS px，即 window.innerWidth / innerHeight） */
export interface Viewport {
  width: number
  height: number
}

/**
 * 矩形到窗口边的距离。外壳的矩形四舍五入过，innerWidth 也是取整的，缩放不是 1 时两者能差出 1px：
 * 1 以内都算贴着边，不然窗口边上会露一条缝
 */
function edgeDistance(distance: number): number {
  return distance <= 1 ? 0 : distance
}

/**
 * 算一块贴边矩形（DIP，可以直接给 view.setBounds）。左边、上边、右边总是跟着窗口；上下方向：
 * - `stretch`（页面区）：上沿到窗口顶的距离不变，高度跟着窗口变；
 * - `pin-bottom`（停靠区里的 DevTools）：高度不变，整块跟着窗口底边走。
 *
 * @param bounds 外壳上报的矩形（CSS px）
 * @param viewport 外壳量的时候的窗口尺寸（CSS px）
 * @param content 窗口内容区现在的尺寸（DIP）
 * @param zoom 外壳的缩放（CSS px → DIP）
 */
export function anchoredRect(
  bounds: Rect,
  viewport: Viewport,
  content: Viewport,
  zoom: number,
  vertical: 'stretch' | 'pin-bottom'
): Rect {
  const right = edgeDistance(viewport.width - bounds.x - bounds.width)
  const bottom = edgeDistance(viewport.height - bounds.y - bounds.height)
  const x = Math.round(bounds.x * zoom)
  const width = Math.max(1, Math.round(content.width - right * zoom) - x)
  const bottomEdge = Math.round(content.height - bottom * zoom)
  if (vertical === 'pin-bottom') {
    const height = Math.round(bounds.height * zoom)
    return { x, y: bottomEdge - height, width, height }
  }
  const y = Math.round(bounds.y * zoom)
  return { x, y, width, height: Math.max(1, bottomEdge - y) }
}

/** 窗口缩放 + 矩形（平铺墙的卡片：列数跟窗口宽度走，贴不了边，照外壳量的摆） */
export function scaledRect(bounds: Rect, zoom: number): Rect {
  return {
    x: Math.round(bounds.x * zoom),
    y: Math.round(bounds.y * zoom),
    width: Math.round(bounds.width * zoom),
    height: Math.round(bounds.height * zoom)
  }
}
