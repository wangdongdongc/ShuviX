import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronRight } from 'lucide-react'
import type { ContextMenuItem } from '@shuvix/chat-protocol/types/contextMenu'

export interface ContextMenuPopupProps {
  items: ContextMenuItem[]
  position: { x: number; y: number }
  /** 关闭：传被点击项 id；取消（外点 / Esc）传 null */
  onClose: (actionId: string | null) => void
}

interface Pos {
  x: number
  y: number
}

/**
 * 丢弃 DOM 弹层无法执行的项，并归一化分隔符：
 *  - 仅保留分隔符 / 带 id 的项 / 带子菜单的项。原生编辑 role 项（cut/copy/paste/selectAll）
 *    依赖系统菜单，DOM 弹层无法可靠对目标编辑器执行，故剔除（键盘快捷键仍可用）。
 *  - 折叠连续分隔符并去掉首尾分隔符，避免出现空白分隔。
 */
function sanitize(items: ContextMenuItem[]): ContextMenuItem[] {
  const kept = items.filter((it) => it.type === 'separator' || it.id || it.submenu)
  const out: ContextMenuItem[] = []
  for (const it of kept) {
    if (it.type === 'separator') {
      if (out.length === 0 || out[out.length - 1].type === 'separator') continue
    }
    out.push(it)
  }
  while (out.length && out[out.length - 1].type === 'separator') out.pop()
  return out
}

/**
 * DOM 右键菜单弹层（扩展端默认渲染器；桌面如不注入原生渲染器也可用）。
 * 经 portal 挂到 body，按光标定位并夹取视口边界；外点 / Esc 关闭。
 * 支持普通项 / 分隔符 / 禁用 / 子菜单（一层，向右展开，越界则向左）。
 */
export function ContextMenuPopup({
  items,
  position,
  onClose
}: ContextMenuPopupProps): React.ReactPortal {
  const containerRef = useRef<HTMLDivElement>(null)

  // 外点 / Esc / 失焦 → 取消。子菜单也渲染在 containerRef 内，故 contains 判定对整棵菜单生效。
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) onClose(null)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose(null)
    }
    const onBlur = (): void => onClose(null)
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [onClose])

  return createPortal(
    <div ref={containerRef} onContextMenu={(e) => e.preventDefault()}>
      <MenuPanel items={items} position={position} onPick={(id) => onClose(id)} />
    </div>,
    document.body
  )
}

/** 单层菜单面板；子菜单递归渲染同一组件。锚点在事件处理器内由父行 DOM 测得，不在 render 期读 ref。 */
function MenuPanel({
  items,
  position,
  onPick
}: {
  items: ContextMenuItem[]
  position: Pos
  onPick: (id: string) => void
}): React.JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<Pos>(position)
  const [openSub, setOpenSub] = useState<{ items: ContextMenuItem[]; pos: Pos } | null>(null)

  const visible = sanitize(items)

  // 测量自纠正定位 + 视口夹取。
  // `position` 是客户端坐标系（clientX/clientY 或父行 getBoundingClientRect）下的目标点。
  // 扩展端 <html> 设了 zoom（对齐桌面基础倍率），`position: fixed` 的实际落点会偏离所设 left/top
  // （fixed 相对缩放后的包含块解析），且偏移量无法靠简单公式预测。这里先按 position 渲染、量出实际
  // 落点 rect，再按「目标 - 落点」的差额回移，使面板左上角精确落在 position（客户端坐标）。
  // 平移型偏移一次到位；纯缩放残差 ~1%（可忽略）。无 zoom 时 rect.left===position.x → 不动。
  useLayoutEffect(() => {
    const el = panelRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    // 渲染时 left===position.x（pos 初值即 position）。delta = 设定的 fixed-left 与实际客户端落点之差
    // （= 缩放/包含块带来的偏移）。后续「客户端目标 → fixed-left」即减去该 delta。
    const deltaX = rect.left - position.x
    const deltaY = rect.top - position.y
    // 在客户端坐标系内夹取目标点（cx/cy、rect 尺寸、视口三者同系）
    const vw = document.documentElement.clientWidth
    const vh = document.documentElement.clientHeight
    let cx = position.x
    let cy = position.y
    if (cx + rect.width > vw) cx = Math.max(4, vw - rect.width - 4)
    if (cy + rect.height > vh) cy = Math.max(4, vh - rect.height - 4)
    setPos({ x: cx - deltaX, y: cy - deltaY })
  }, [position])

  // 子菜单锚点：父行右缘（客户端坐标，取自 getBoundingClientRect）。父面板已自纠正落在其客户端目标，
  // 故此 rect 为父行真实视觉位置；子面板同样走测量自纠正，落点一致对齐，无需关心 zoom。
  const openSubmenu = (row: HTMLElement, sub: ContextMenuItem[]): void => {
    const r = row.getBoundingClientRect()
    setOpenSub({ items: sub, pos: { x: r.right - 2, y: r.top - 4 } })
  }

  return (
    <>
      <div
        ref={panelRef}
        role="menu"
        style={{ position: 'fixed', left: pos.x, top: pos.y, zIndex: 1000 }}
        className="min-w-[140px] py-0.5 rounded-md border border-border-secondary bg-bg-primary shadow-lg text-[11px] text-text-primary"
      >
        {visible.map((item, idx) => {
          if (item.type === 'separator') {
            return <div key={`sep-${idx}`} className="my-0.5 h-px bg-border-secondary/60" />
          }
          const sub = item.submenu && item.submenu.length > 0 ? item.submenu : null
          const disabled = item.enabled === false || (!item.id && !sub)
          return (
            <button
              key={item.id ?? `item-${idx}`}
              role="menuitem"
              disabled={disabled}
              onMouseEnter={(e) => {
                if (sub) openSubmenu(e.currentTarget, sub)
                else setOpenSub(null)
              }}
              onClick={(e) => {
                if (sub) openSubmenu(e.currentTarget, sub)
                else if (item.id) onPick(item.id)
              }}
              className="flex w-full items-center justify-between gap-2 px-2.5 py-1 text-left hover:bg-bg-hover disabled:opacity-40 disabled:pointer-events-none transition-colors"
            >
              <span>{item.label}</span>
              {sub && <ChevronRight size={11} className="text-text-tertiary flex-shrink-0" />}
            </button>
          )
        })}
      </div>
      {openSub && (
        // key 含坐标：切换不同父行时强制重挂载，使测量自纠正在 pos===position 的初值下进行
        <MenuPanel
          key={`${openSub.pos.x},${openSub.pos.y}`}
          items={openSub.items}
          position={openSub.pos}
          onPick={onPick}
        />
      )}
    </>
  )
}
