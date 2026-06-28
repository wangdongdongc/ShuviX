import { createContext, useCallback, useContext, useState } from 'react'
import type { ContextMenuItem } from '@shuvix/chat-protocol/types/contextMenu'
import { ContextMenuPopup } from './ContextMenuPopup'

export interface ContextMenuPosition {
  x: number
  y: number
}

/**
 * 渲染器：给定菜单项 + 光标位置，弹出菜单并返回被点击项 id（取消返回 null）。
 * 桌面注入原生实现（Electron Menu.popup，忽略 position）；扩展缺省用内置 DOM 渲染器。
 */
export type ContextMenuRenderer = (
  items: ContextMenuItem[],
  position: ContextMenuPosition
) => Promise<string | null>

const RendererContext = createContext<ContextMenuRenderer | null>(null)

/**
 * 右键菜单宿主 —— 提供统一的 useContextMenu() 弹出能力。
 * - 传 render：宿主自定义渲染器（桌面原生菜单）。
 * - 不传 render：使用内置 DOM 弹层（扩展端）。
 * 菜单「配置」（items + 动作）由各组件经 useContextMenu 复用，宿主差异仅在渲染器。
 */
export function ContextMenuProvider({
  render,
  children
}: {
  render?: ContextMenuRenderer
  children: React.ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useState<{
    items: ContextMenuItem[]
    position: ContextMenuPosition
    resolve: (actionId: string | null) => void
  } | null>(null)

  // 内置 DOM 渲染器：开弹层并在关闭时 resolve
  const domRenderer = useCallback<ContextMenuRenderer>((items, position) => {
    return new Promise<string | null>((resolve) => setOpen({ items, position, resolve }))
  }, [])

  const renderer = render ?? domRenderer

  return (
    <RendererContext.Provider value={renderer}>
      {children}
      {!render && open && (
        <ContextMenuPopup
          items={open.items}
          position={open.position}
          onClose={(actionId) => {
            open.resolve(actionId)
            setOpen(null)
          }}
        />
      )}
    </RendererContext.Provider>
  )
}

export type ShowContextMenu = (
  eventOrPosition: React.MouseEvent | ContextMenuPosition,
  items: ContextMenuItem[],
  onAction: (actionId: string) => void | Promise<void>
) => Promise<void>

/**
 * 弹出右键菜单并分发点击动作（桌面/扩展共用）。
 * 第一参数传 React 鼠标事件（自动 preventDefault/stopPropagation + 取光标位置）或显式 {x,y}。
 */
export function useContextMenu(): ShowContextMenu {
  const renderer = useContext(RendererContext)
  return useCallback<ShowContextMenu>(
    async (eventOrPosition, items, onAction) => {
      if (!renderer) return
      let position: ContextMenuPosition
      if ('clientX' in eventOrPosition) {
        eventOrPosition.preventDefault()
        eventOrPosition.stopPropagation()
        position = { x: eventOrPosition.clientX, y: eventOrPosition.clientY }
      } else {
        position = eventOrPosition
      }
      const actionId = await renderer(items, position)
      if (actionId) await onAction(actionId)
    },
    [renderer]
  )
}
