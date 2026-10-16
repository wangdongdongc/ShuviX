import { useEffect, useState } from 'react'

/**
 * 浏览器窗口里有没有打开的对话框覆盖层（`.dialog-overlay`）。
 *
 * 原生页面画在 DOM 之上：对话框一开，页面区的 view 必须整体让位（布局表报 setVisible(false)，view 回停放
 * 窗口），否则对话框被页面盖住。单页视图与平铺墙共用。
 */
export function useDialogOverlay(): boolean {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const check = (): void => setOpen(document.querySelector('.dialog-overlay') !== null)
    const mo = new MutationObserver(check)
    mo.observe(document.body, { childList: true, subtree: true })
    check()
    return () => mo.disconnect()
  }, [])
  return open
}
