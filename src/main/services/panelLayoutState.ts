/**
 * 主进程按 BrowserWindow 跟踪右面板（browser/files/terminal）的"实际打开宽度"。
 *
 * 关闭窗口时据此正确反推 chatWidth 持久化到 panelLayout —
 * 不能信任 DB 里的 browserOpen：上次会话开过、本次未操作过时该值会过期。
 *
 * key 为 webContents.id（既是 sender 来源,也是 BrowserWindow 关联终端的标识）。
 */
const browserOffsetByWindow = new Map<number, number>()

export function setBrowserOffset(windowId: number, offset: number): void {
  browserOffsetByWindow.set(windowId, Number.isFinite(offset) ? offset : 0)
}

export function getBrowserOffset(windowId: number): number {
  return browserOffsetByWindow.get(windowId) ?? 0
}

export function clearBrowserOffset(windowId: number): void {
  browserOffsetByWindow.delete(windowId)
}
