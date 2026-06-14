import { useCallback } from 'react'

interface ContextMenuItem {
  id: string
  label: string
  type?: 'normal' | 'separator'
  enabled?: boolean
}

type ActionHandler = (actionId: string) => void | Promise<void>

/**
 * 弹出原生 Electron 右键菜单并分发点击动作。
 *
 * @example
 * const showContextMenu = useContextMenu()
 * onContextMenu={(e) => {
 *   e.preventDefault()
 *   showContextMenu(
 *     [{ id: 'delete', label: t('sidebar.deleteSession') }],
 *     (id) => { if (id === 'delete') handleDelete() }
 *   )
 * }}
 */
export function useContextMenu(): (
  items: ContextMenuItem[],
  onAction: ActionHandler
) => Promise<void> {
  return useCallback(async (items: ContextMenuItem[], onAction: ActionHandler) => {
    const result = await window.api.contextMenu.popup({ items })
    if (result.actionId) {
      await onAction(result.actionId)
    }
  }, [])
}
