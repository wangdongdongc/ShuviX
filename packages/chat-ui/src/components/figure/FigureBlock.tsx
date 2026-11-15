import { useContext, type ReactNode, type Ref } from 'react'
import { ChatHostContext } from '../../host/chatHostContext'

/** 图块的种类（外壳上的 `data-figure-block`，e2e 与样式按它认块） */
export type FigureBlockKind = 'svg' | 'mermaid' | 'artifact' | 'interactive'

/**
 * 对话里一张图的外壳 —— ```svg / ```mermaid / ```artifact 引用 / ```interactive 共用。
 *
 * **图直接画在页面上**（2026-11-14，用户选定「方案 A 裸图」）：没有填充底色、没有描边、没有标题条，
 * 与笔记本里同一种图的画法一致。外壳只做两件事：
 *
 *   - 图底下一行说明：左边是名字（有才写 —— 产物的标题；围栏图没有名字就空着，不再挂「SVG」
 *     「Mermaid」这种类型标签），右边是这张图的操作；
 *   - 操作常态隐藏，指到图上（或键盘聚焦到其中一个、或导出面板开着 —— 最后这条是 base.css 里
 *     `[data-figure-actions]:has(…)` 那条规则，不是 Tailwind 的类）才显形；触屏密度没有悬浮，常驻。
 *     说明行的高度常态就占着：操作显形时图下面的内容不能跟着跳一下。
 *
 * `extras` 是说明行里**不隐藏**的东西（产物引用的「已有新版 / 当前版本」）：那是状态，不是操作。
 * `pinActions` 让操作常驻 —— 切到源码视图时得看得见回去的那个按钮。
 *
 * 外壳挂 `data-figure-surface="page"`：图坐在页面底上。themes.css 只给 `card` 那一层另设底色，
 * `page` 就是缺省（pele 的标签衬底取 bg-primary、节点取 bg-tertiary），这个属性留着是给导出与
 * e2e 一个明说的记号。
 */
export function FigureBlock({
  kind,
  shellRef,
  label,
  extras,
  actions,
  pinActions = false,
  attrs,
  children
}: {
  kind: FigureBlockKind
  shellRef?: Ref<HTMLDivElement>
  label?: ReactNode
  extras?: ReactNode
  actions?: ReactNode
  pinActions?: boolean
  /** 外壳上另挂的 data 属性（如交互图的 `data-interactive-figure`） */
  attrs?: Record<string, string | undefined>
  children: ReactNode
}): React.JSX.Element {
  // 可空地读：markdown 也在没有 ChatHostProvider 的地方渲染
  const touch = useContext(ChatHostContext)?.density === 'touch'
  const shown = touch || pinActions
  const hasCaption = !!label || !!extras || !!actions

  return (
    <div
      ref={shellRef}
      data-figure-block={kind}
      data-figure-surface="page"
      className="group/figure my-2"
      {...attrs}
    >
      {children}
      {hasCaption && (
        <div
          data-figure-caption=""
          className="flex items-center gap-3 min-h-5 px-1 text-[10px] text-text-tertiary"
        >
          <span data-figure-label="" className="min-w-0 truncate font-medium mr-auto">
            {label}
          </span>
          {extras}
          {actions && (
            <div
              data-figure-actions=""
              className={`flex items-center gap-3 flex-shrink-0 transition-opacity ${
                shown ? '' : 'opacity-0 group-hover/figure:opacity-100 focus-within:opacity-100'
              }`}
            >
              {actions}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** 源码视图 / 取到的非图内容：一块等宽文本，外观同对话里的代码块（`.code-surface`） */
export const FIGURE_SOURCE_CLASS =
  'code-surface text-[11px] text-text-secondary leading-relaxed font-mono'
