/**
 * 浏览器窗口的弹层（站点信息气泡、地址栏下拉）住的那块透明 view 的约定：外壳用这个名字 `window.open`，
 * 主进程只认这个名字（见 main/services/browser/browserPopover.ts）。
 */
export const BROWSER_POPOVER_FRAME = 'shuvix-browser-popover'

/** 键盘焦点：`take` 弹层自己拿（气泡，Tab 能走到里面的按钮）；`keep-shell` 留在外壳（地址栏下拉，字还要接着打） */
export type BrowserPopoverFocus = 'take' | 'keep-shell'

export interface BrowserPopoverPlacement {
  /** 透明 view 的矩形（CSS px；含阴影的留白） */
  bounds: { x: number; y: number; width: number; height: number }
  focus: BrowserPopoverFocus
}
