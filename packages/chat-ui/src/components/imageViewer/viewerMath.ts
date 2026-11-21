/**
 * 看图的几何（纯函数，单测钉住）。
 *
 * 图的中心 = 舞台中心 + 平移 `(x, y)`；显示尺寸 = 原尺寸 × `scale`。「适合窗口」是一个算出来的比例
 * （不放大小图：最多 1），缩放到它或更小时图回到正中、不能拖。看图层自己不缩到适合窗口以下（缩到那里就是
 * 「适合窗口」，常见看图器都这样，手机上也不会缩成一个小点）；`minScale` 只是 `zoomAt` 的下限。
 */

export interface Size {
  width: number
  height: number
}

export interface View {
  scale: number
  x: number
  y: number
}

/** 舞台四周留的边（图不贴边） */
export const VIEWER_MARGIN = 24
export const MAX_SCALE = 8

/** 适合窗口的比例：整张图放得下，不放大 */
export function fitScale(natural: Size, stage: Size, margin = VIEWER_MARGIN): number {
  if (natural.width <= 0 || natural.height <= 0) return 1
  const w = Math.max(1, stage.width - margin * 2)
  const h = Math.max(1, stage.height - margin * 2)
  return Math.min(1, w / natural.width, h / natural.height)
}

/** `zoomAt` 的下限：适合窗口的一半（看图层到适合窗口就停，见文件头） */
export function minScale(fit: number): number {
  return Math.min(fit, 1) / 2
}

/** 平移夹在「图边不离开舞台中线」以内：放大后拖不丢 */
export function clampOffset(view: View, natural: Size, stage: Size): View {
  const halfW = Math.max(0, (natural.width * view.scale - stage.width) / 2)
  const halfH = Math.max(0, (natural.height * view.scale - stage.height) / 2)
  return {
    scale: view.scale,
    x: Math.min(halfW, Math.max(-halfW, view.x)),
    y: Math.min(halfH, Math.max(-halfH, view.y))
  }
}

/**
 * 以舞台里的一点（相对舞台中心）为不动点缩放到 `next`。缩到适合窗口或更小 → 回正中。
 */
export function zoomAt(
  view: View,
  next: number,
  point: { x: number; y: number },
  natural: Size,
  stage: Size
): View {
  const fit = fitScale(natural, stage)
  const scale = Math.min(MAX_SCALE, Math.max(minScale(fit), next))
  if (scale <= fit) return { scale, x: 0, y: 0 }
  const k = scale / view.scale
  return clampOffset(
    { scale, x: point.x - (point.x - view.x) * k, y: point.y - (point.y - view.y) * k },
    natural,
    stage
  )
}

/** 比适合窗口大（可以拖） */
export function isZoomedIn(view: View, natural: Size, stage: Size): boolean {
  return view.scale > fitScale(natural, stage) + 1e-6
}

/** 下一级缩放（按钮 / 键盘）：×1.25 一级 */
export function stepScale(scale: number, direction: 1 | -1): number {
  return direction > 0 ? scale * 1.25 : scale / 1.25
}
