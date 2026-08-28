import type { BrowserTabInfo } from '../../stores/browserStore'

/**
 * 浏览器面板的纯函数工具与布局常数。
 * 单独成文件（不放组件文件里）是因为组件文件只能导出组件，否则 fast refresh 失效。
 */

/** 卡片目标高度（px）：面板高度按它自动等分，同屏几张不用用户选 */
export const CARD_TARGET_H = 260
/** 卡片最小高度（px）：面板太矮时宁可放不下也不摊成纸片 */
export const CARD_MIN_H = 140
/**
 * 卡片的目标逻辑宽度：页面按这个宽度排版，再整体缩小到卡片实际宽度。
 * 不这么做的话，460px 宽的卡片会让站点走移动端断点，看到的是「很小的局部」而不是缩略全景。
 */
export const CARD_LOGICAL_W = 1100
/** 页面缩放下限 —— 再小就只剩色块了 */
export const MIN_CARD_ZOOM = 0.34

/** 由卡片实际宽度算页面缩放（主进程 setZoomFactor 用的就是它） */
export function cardZoomFor(cardWidth: number): number {
  return Math.min(1, Math.max(MIN_CARD_ZOOM, cardWidth / CARD_LOGICAL_W))
}

/** tab 标题：title → URL host → 空白页文案 */
export function tabLabel(tab: BrowserTabInfo, untitled: string): string {
  if (tab.title) return tab.title
  if (tab.url && tab.url !== 'about:blank') {
    try {
      return new URL(tab.url).host || tab.url
    } catch {
      return tab.url
    }
  }
  return untitled
}

/** 地址栏输入 → 可导航 URL；空串返回 null（不导航） */
export function normalizeTargetUrl(input: string): string | null {
  const target = input.trim()
  if (!target) return null
  if (!/^https?:\/\//i.test(target) && target !== 'about:blank') return 'https://' + target
  return target
}
