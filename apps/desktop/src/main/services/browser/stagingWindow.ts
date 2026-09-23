/**
 * 停放窗口 —— 浏览器 tab 在「不在卡片墙上显示」时的宿主。
 *
 * 一个**从不显示**的普通 BrowserWindow（`show: false`，不可聚焦、不进任务栏）：没有叠放顺序、
 * 拿不到键盘焦点、不进 Mission Control —— 它对用户完全不存在。浏览器窗口的布局表里没有落位的
 * tab（窗口从没开过、卡片滚出了视口、有对话框遮着……）都停在这里，按桌面尺寸铺开、**保持可见**。
 *
 * 为什么不直接 `setVisible(false)` 藏在浏览器窗口里（2026-09-23 实测，Electron 39，macOS）：
 * - 一个 view 若从建出来就是隐藏的，截图报 "Current display surface not available"、agent 的
 *   鼠标点击不落地 —— 无论宿主窗口处于什么状态；
 * - 出过帧之后再隐藏的 view，一次**跨站导航**（新渲染进程）之后截图就只剩空图；
 * - 放到窗口内容区之外（负坐标）不行：view 会被裁到 0 宽，页面按 innerWidth=0 排版。
 * 可见、有真实尺寸的 view 在从不显示的窗口里一切正常 —— 前提是进程带着
 * `disable-backgrounding-occluded-windows` 开关（main/index.ts 启动时加）：没有它，被遮挡 / 隐藏 /
 * 从不显示的窗口里新出生的 view 都拿不到第一帧。
 *
 * 生命周期：第一个 tab 建出时懒创建；app 退出时销毁。主窗口关闭时，非 macOS 平台也销毁它
 * （隐藏窗口仍算「开着」，会挡住 window-all-closed → app.quit）；macOS 上留着，好让主窗口关着时
 * 仍在后台跑的 agent 继续用浏览器。
 */

import { BrowserWindow } from 'electron'
import { guardAppWindow } from '../externalOpen'

/** 停放窗口的内容区尺寸 = 停放中的 tab 的视口：按常见桌面宽度排版，截图与坐标都按这个来 */
export const STAGING_SIZE = { width: 1280, height: 800 } as const

let staging: BrowserWindow | null = null

/** 取停放窗口（没有就建一个；从不显示） */
export function getStagingWindow(): BrowserWindow {
  if (staging && !staging.isDestroyed()) return staging
  const win = new BrowserWindow({
    width: STAGING_SIZE.width,
    height: STAGING_SIZE.height,
    useContentSize: true,
    show: false,
    focusable: false,
    skipTaskbar: true,
    title: 'ShuviX browser staging'
  })
  // 它自己不加载任何页面；守卫是全体自有窗口的不变量（见 guardedWindows.test.ts），装上无副作用
  guardAppWindow(win)
  win.on('closed', () => {
    if (staging === win) staging = null
  })
  staging = win
  return win
}

/** 停放窗口是否就是这个窗口（布局判断用；不会顺手创建） */
export function isStagingWindow(win: BrowserWindow | null | undefined): boolean {
  return !!win && win === staging
}

/** 销毁停放窗口（其中的 view 由调用方先摘走或随后关掉） */
export function destroyStagingWindow(): void {
  if (staging && !staging.isDestroyed()) staging.destroy()
  staging = null
}
