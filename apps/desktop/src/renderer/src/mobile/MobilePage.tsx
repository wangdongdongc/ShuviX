/**
 * 手机布局里一张推入页的骨架：顶上一行是返回键（写着上一层的名字）与右边的动作，下面是大标题、可选的一行小字，
 * 然后是内容；底部可以有一条工具栏（数量之类）。盖满它所在的那一层（对话页 / 整个外壳），那一层已经让出了刘海
 * 与底部的安全区。文件、后台任务、产物、项目设置四处用同一份（会话详情那一页早于它，自己画的同一个样子）。
 */
import type { ReactNode } from 'react'
import { ChevronLeft } from 'lucide-react'

/** 分组卡片与卡片里的一行（与会话详情同一套） */
export const pageCard =
  'overflow-hidden rounded-xl bg-bg-secondary divide-y divide-border-secondary/50'
export const pageRowBase = 'flex min-h-[44px] w-full items-center gap-3 px-4 text-left text-[16px]'
export const pageRow = `${pageRowBase} text-text-primary`
/** 卡片上面那行小标题 */
export const pageSectionLabel = 'px-4 pb-1.5 text-[13px] text-text-tertiary'

export interface MobilePageProps {
  /** 哪一页（e2e 与样式认它）：`data-mobile-panel` 的值 */
  kind: string
  /** 返回键上写的字：上一层的名字 */
  backLabel: string
  onBack: () => void
  title: ReactNode
  /** 大标题下面的一行小字（路径、文件名 · 版本之类） */
  subtitle?: ReactNode
  /** 顶栏右边（「⋯」、停止） */
  actions?: ReactNode
  /** 大标题与内容之间不滚动的一块（搜索框） */
  header?: ReactNode
  /** 底部工具栏（一行小字） */
  toolbar?: ReactNode
  /** 内容区的类名（缺省：可滚动、两边留白） */
  bodyClassName?: string
  children: ReactNode
}

export function MobilePage({
  kind,
  backLabel,
  onBack,
  title,
  subtitle,
  actions,
  header,
  toolbar,
  bodyClassName,
  children
}: MobilePageProps): React.JSX.Element {
  return (
    <div data-mobile-panel={kind} className="absolute inset-0 z-30 flex flex-col bg-bg-primary">
      <div className="flex flex-shrink-0 items-center px-2 pt-2">
        <button
          type="button"
          data-mobile-panel-back=""
          onClick={onBack}
          className="flex h-9 max-w-[70%] items-center gap-0.5 rounded-full pl-1 pr-3 text-[16px] text-accent active:bg-bg-hover"
        >
          <ChevronLeft size={22} className="flex-shrink-0" aria-hidden="true" />
          <span className="truncate">{backLabel}</span>
        </button>
        <div className="ml-auto flex items-center">{actions}</div>
      </div>
      <h1
        data-mobile-panel-title=""
        className="flex-shrink-0 truncate px-5 pt-3 text-[28px] font-bold leading-9 tracking-tight text-text-primary"
      >
        {title}
      </h1>
      {subtitle ? (
        <div
          data-mobile-panel-subtitle=""
          className="flex-shrink-0 truncate px-5 pb-2 pt-0.5 text-[13px] text-text-tertiary"
        >
          {subtitle}
        </div>
      ) : (
        <div className="h-2 flex-shrink-0" />
      )}
      {header}
      <div
        data-mobile-panel-body=""
        className={bodyClassName ?? 'min-h-0 flex-1 overflow-y-auto px-3 pb-6 pt-1'}
      >
        {children}
      </div>
      {toolbar && (
        <div
          data-mobile-panel-toolbar=""
          className="flex min-h-[44px] flex-shrink-0 items-center justify-center border-t border-border-secondary/60 bg-bg-secondary/80 px-4 text-[13px] text-text-tertiary"
        >
          {toolbar}
        </div>
      )}
    </div>
  )
}
