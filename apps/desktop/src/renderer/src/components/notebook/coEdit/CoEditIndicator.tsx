import { useTranslation } from 'react-i18next'
import { ArrowDown, ArrowUp, Eye } from 'lucide-react'
import type { CoEditIndicator as IndicatorState } from './useCoEditing'

/**
 * 协作编辑的指路条 —— 浮在编辑器顶部正中。只在有事可说时出现：
 *  - agent 正在屏幕外写（虚影在上方 / 下方）；
 *  - 屏幕外有还没看过的改动（点一下滚过去，看见后痕迹才开始淡出）；
 *  - agent 正在读文档（一闪而过）。
 * 从不自己滚动视图：人在读什么由人决定。
 */
export function CoEditIndicator({
  state,
  onReveal
}: {
  state: IndicatorState
  onReveal: () => void
}): React.JSX.Element | null {
  const { t } = useTranslation()
  let text: string | null = null
  let direction: 'up' | 'down' | null = null
  if (state.workingSide) {
    text = t(
      state.workingSide === 'above'
        ? 'notebook.coEdit.workingAbove'
        : 'notebook.coEdit.workingBelow'
    )
    direction = state.workingSide === 'above' ? 'up' : 'down'
  } else if (state.changesAbove > 0 || state.changesBelow > 0) {
    const above = state.changesAbove >= state.changesBelow
    text = above
      ? t('notebook.coEdit.changesAbove', { count: state.changesAbove })
      : t('notebook.coEdit.changesBelow', { count: state.changesBelow })
    direction = above ? 'up' : 'down'
  }

  if (!text && !state.reading) return null
  return (
    <div className="pointer-events-none absolute top-3 left-0 right-0 z-30 flex justify-center">
      {text ? (
        <button
          type="button"
          data-coedit-indicator={direction}
          onClick={onReveal}
          className="pointer-events-auto flex items-center gap-1.5 rounded-full border border-violet-400/40 bg-bg-secondary/95 px-3 py-1 text-xs text-violet-500 shadow-sm backdrop-blur hover:bg-bg-tertiary"
        >
          {direction === 'up' ? <ArrowUp size={12} /> : <ArrowDown size={12} />}
          {text}
        </button>
      ) : (
        <div
          data-coedit-indicator="reading"
          className="flex items-center gap-1.5 rounded-full bg-bg-secondary/90 px-3 py-1 text-xs text-violet-500/80"
        >
          <Eye size={12} />
          {t('notebook.coEdit.reading')}
        </div>
      )}
    </div>
  )
}
