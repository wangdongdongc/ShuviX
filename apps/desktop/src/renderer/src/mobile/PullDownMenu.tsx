/**
 * 手机布局的下拉菜单（iOS 的 pull-down menu）—— 从顶栏右上角那颗按钮下面展开，右边缘与按钮对齐。
 *
 * 与长按出来的那份菜单（ContextMenuProvider 的 DOM 菜单）不是一回事：那一份是「对这一行能做什么」，只有文字；
 * 这一份是一颗按钮自己的菜单，每项行尾带图标、可以带一个数，分组之间隔一条粗线。挂到 body 上；点菜单以外的
 * 任何地方（一层透明的底）、按 Esc 或浏览器历史一动（返回手势）就收起，点一项先收起再做事。
 */
import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export interface PullDownItem {
  id: string
  label: string
  icon: ReactNode
  /** 行尾图标前的小数字（> 0 才画） */
  count?: number
  /** 此刻做不了：照画、置灰、点了没反应（这一轮在跑时的「分支会话」） */
  disabled?: boolean
}

export interface PullDownMenuProps {
  /** 按钮在视口里的位置：菜单贴着它的下边、右边对齐 */
  anchor: { right: number; bottom: number }
  /** 一组一组的项；组与组之间一条粗线，空组不画 */
  groups: PullDownItem[][]
  onPick: (id: string) => void
  onClose: () => void
}

export function PullDownMenu({
  anchor,
  groups,
  onPick,
  onClose
}: PullDownMenuProps): React.JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    // 返回手势：下面那一页要换了，菜单不留在上面
    window.addEventListener('keydown', onKey)
    window.addEventListener('popstate', onClose)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('popstate', onClose)
    }
  }, [onClose])
  const shown = groups.filter((group) => group.length > 0)
  return createPortal(
    <div data-mobile-pulldown-layer="" className="fixed inset-0 z-[70]" onClick={onClose}>
      <div
        role="menu"
        data-mobile-pulldown=""
        onClick={(e) => e.stopPropagation()}
        className="absolute w-[230px] overflow-hidden rounded-[14px] border border-border-secondary bg-bg-secondary text-[16px] text-text-primary shadow-[0_8px_30px_rgba(0,0,0,0.35)]"
        style={{
          top: anchor.bottom + 6,
          right: Math.max(8, window.innerWidth - anchor.right)
        }}
      >
        {shown.map((group, index) => (
          <div
            key={group[0].id}
            className={`divide-y divide-border-secondary/50 ${
              index > 0 ? 'border-t-[6px] border-bg-primary/60' : ''
            }`}
          >
            {group.map((item) => (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                data-mobile-menu-item={item.id}
                disabled={item.disabled}
                onClick={() => {
                  onClose()
                  onPick(item.id)
                }}
                className="flex min-h-[44px] w-full items-center gap-2 px-4 text-left active:bg-bg-hover disabled:opacity-40"
              >
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {item.count !== undefined && item.count > 0 && (
                  <span
                    data-mobile-menu-count=""
                    className="text-[15px] tabular-nums text-text-tertiary"
                  >
                    {item.count}
                  </span>
                )}
                <span className="flex shrink-0 text-text-secondary" aria-hidden="true">
                  {item.icon}
                </span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>,
    document.body
  )
}
