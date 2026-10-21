/** 停靠区（BrowserDevtoolsDock）的高度：CSS px，所有页共用一个（照 Chrome），记在设置里 */

/** 下限 */
export const DOCK_MIN_HEIGHT = 140
/** 上限要给页面区留出这么多 */
const PAGE_MIN_HEIGHT = 120
/** 没调过时的高度 */
export const DOCK_DEFAULT_HEIGHT = 320

/** 把高度夹进 [下限, 窗口能给的上限] */
export function clampDockHeight(height: number, available: number): number {
  const max = Math.max(DOCK_MIN_HEIGHT, available - PAGE_MIN_HEIGHT)
  return Math.round(Math.min(max, Math.max(DOCK_MIN_HEIGHT, height)))
}
