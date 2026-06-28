import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ContextMenuItem } from '@shuvix/chat-protocol/types/contextMenu'

export interface ContextMenuPopupProps {
  items: ContextMenuItem[]
  position: { x: number; y: number }
  /** 关闭：传被点击项 id；取消（外点 / Esc / 点 role 项）传 null */
  onClose: (actionId: string | null) => void
}

/**
 * DOM 右键菜单弹层（扩展端默认渲染器；桌面如不注入原生渲染器也可用）。
 * 经 portal 挂到 body，按光标定位并夹取视口边界；外点 / Esc 关闭。
 * 支持普通项 / 分隔符 / 禁用 / 子菜单（一层）；原生编辑 role 项当前按普通项呈现（侧栏菜单不使用）。
 */
export function ContextMenuPopup({
  items,
  position,
  onClose
}: ContextMenuPopupProps): React.ReactPortal {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState(position)

  // 夹取到视口内：超出右/下边界时回收
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    let { x, y } = position
    if (x + width > window.innerWidth) x = Math.max(4, window.innerWidth - width - 4)
    if (y + height > window.innerHeight) y = Math.max(4, window.innerHeight - height - 4)
    // 测量后一次性夹取定位（measure-then-position），随 position prop 变化重算
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPos({ x, y })
  }, [position])

  // 外点 / Esc / 右键空白 / 失焦 → 取消
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose(null)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose(null)
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', () => onClose(null))
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [onClose])

  return createPortal(
    <div
      ref={ref}
      role="menu"
      style={{ position: 'fixed', left: pos.x, top: pos.y, zIndex: 1000 }}
      className="min-w-[132px] py-0.5 rounded-md border border-border-secondary bg-bg-primary shadow-lg text-[11px] text-text-primary"
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, idx) => {
        if (item.type === 'separator') {
          return <div key={`sep-${idx}`} className="my-0.5 h-px bg-border-secondary/60" />
        }
        const disabled = item.enabled === false || (!item.id && !item.submenu)
        return (
          <button
            key={item.id ?? `item-${idx}`}
            role="menuitem"
            disabled={disabled}
            onClick={() => item.id && onClose(item.id)}
            className="flex w-full items-center gap-1.5 px-2.5 py-1 text-left hover:bg-bg-hover disabled:opacity-40 disabled:pointer-events-none transition-colors"
          >
            {item.label}
          </button>
        )
      })}
    </div>,
    document.body
  )
}
