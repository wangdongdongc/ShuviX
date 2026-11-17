/**
 * 没人在看、也不是 tab 的页面（`read` 工具读网页用的隐藏页面）：它们跑在内置浏览器的分区上，带着用户的登录状态，
 * 但分区上那些「用户正看着浏览器窗口就照常」的规矩对它们不适用 —— 下载一律取消，不管浏览器窗口在不在前台。
 */
import type { WebContents } from 'electron'

const unattended = new WeakSet<WebContents>()

export function markUnattendedPage(wc: WebContents): void {
  unattended.add(wc)
}

export function isUnattendedPage(wc: WebContents | null | undefined): boolean {
  return !!wc && unattended.has(wc)
}
