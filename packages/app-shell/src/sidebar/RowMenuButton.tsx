/**
 * RowMenuButton —— 侧栏条目的「⋮」操作入口（悬停浮现）。
 *
 * 侧栏每行原本把动作摊成一排小图标（会话行的齿轮/垃圾桶、分组头的新建对话/Bot/项目配置），
 * 于是「这行有几个动作」直接决定标题被挤掉多少字，每多一个动作就再挤一次；而同一批动作在
 * 右键菜单里本来就有一份。现在一行只留这一颗按钮，点开的**就是右键那份菜单**（同一份 items、
 * 同一个 onAction）—— 右键与 ⋮ 是同一入口的两种触发方式，不存在「按钮能做而菜单里没有」的动作。
 *
 * 定位与浮现交给调用方（各行的 group-hover 前缀不同：会话行 `group`、分组头 `group/header`），
 * 本组件只统一图标、尺寸与无障碍文案。
 */
import { EllipsisVertical } from 'lucide-react'
import { useTranslation } from 'react-i18next'

export interface RowMenuButtonProps {
  /** 打开菜单（调用方通常直接转给 useContextMenu 的 showContextMenu） */
  onOpen: (e: React.MouseEvent) => void
  /** 定位与浮现（absolute / opacity-0 group-hover:opacity-100 …） */
  className?: string
}

export function RowMenuButton({ onOpen, className = '' }: RowMenuButtonProps): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <button
      // 阻断冒泡：⋮ 长在会话行里，不拦这一下点它就顺手把会话切了
      // （showContextMenu 自己也会 stopPropagation，但宿主没注入渲染器时它先行返回）
      onClick={(e) => {
        e.stopPropagation()
        onOpen(e)
      }}
      title={t('sidebar.moreActions')}
      aria-label={t('sidebar.moreActions')}
      className={`p-0.5 rounded text-text-tertiary hover:text-text-secondary hover:bg-bg-active transition-opacity duration-100 ${className}`}
    >
      <EllipsisVertical size={12} />
    </button>
  )
}
