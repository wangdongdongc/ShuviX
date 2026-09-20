import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { BookOpen, FileText } from 'lucide-react'
import { mentionRefId } from '@shuvix/chat-protocol/utils/inlineTokens'
import type { AtSuggestion } from '../../hooks/useAtMentions'

interface AtMentionPopoverProps {
  /** 补全候选（已排序；合并模式按源分区、每源 ≤5） */
  suggestions: AtSuggestion[]
  /** 选中回调 */
  onSelect: (suggestion: AtSuggestion) => void
  /** 当前键盘选中索引（跨段连续的扁平索引） */
  selectedIndex: number
}

/** 源图标（lucide 现有体系） */
const SOURCE_ICONS = { file: FileText, knowledge: BookOpen } as const

/** 段头 i18n 键（input 命名空间） */
const SECTION_TITLE_KEYS = {
  file: 'input.atSectionFiles',
  knowledge: 'input.atSectionKnowledge'
} as const

/**
 * `@` 自动补全浮层 —— 复用斜杠命令 / 内置技能选择框的视觉样式。
 * 多源分区渲染：裸 `@` 时「文件」「知识库」两段（段头小字标题，方向键跨段循环）；
 * `@源:query` 显式路由后只出该源（单段不出段头，与单源时代观感一致）。
 * 锚定在 textarea 上方（与斜杠命令一致，不做光标坐标测量，键位与整体观感统一）。
 */
export function AtMentionPopover({
  suggestions,
  onSelect,
  selectedIndex
}: AtMentionPopoverProps): React.JSX.Element | null {
  const { t } = useTranslation()
  const listRef = useRef<HTMLDivElement>(null)

  // 确保选中项可见（按扁平索引查行，段头不参与计数）
  useEffect(() => {
    const container = listRef.current
    if (!container) return
    const item = container.querySelector(`[data-at-index="${selectedIndex}"]`)
    ;(item as HTMLElement | null)?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  if (suggestions.length === 0) return null

  const sectionCount = new Set(suggestions.map((s) => s.source)).size

  const nodes: React.ReactNode[] = []
  let prevSource: string | null = null
  suggestions.forEach((s, idx) => {
    if (s.source !== prevSource && sectionCount > 1) {
      const titleKey = SECTION_TITLE_KEYS[s.source as keyof typeof SECTION_TITLE_KEYS]
      nodes.push(
        <div
          key={`section-${s.source}`}
          // 段头锚点（e2e harness 按此认分区；仅多源并出时渲染）
          data-at-section={s.source}
          className="px-2.5 pt-1.5 pb-0.5 text-[10px] font-medium text-text-tertiary select-none"
        >
          {titleKey ? t(titleKey) : s.source}
        </div>
      )
    }
    prevSource = s.source
    const Icon = SOURCE_ICONS[s.source as keyof typeof SOURCE_ICONS] ?? FileText
    nodes.push(
      <button
        // 同一源内 token 可能重复（同名裸名回退），叠加 idx 保唯一
        key={`${s.source}-${idx}`}
        data-at-index={idx}
        onMouseDown={(e) => {
          // mousedown 抢在 textarea blur 之前，避免点击丢失焦点/触发态
          e.preventDefault()
          onSelect(s)
        }}
        className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-xs transition-colors ${
          idx === selectedIndex
            ? 'bg-accent/15 text-text-primary'
            : 'text-text-secondary hover:bg-bg-tertiary'
        }`}
        // 行锚点：文件=工作区相对路径、知识条目=`knowledge:`+条目 id（e2e harness 按此认行）
        data-at-suggestion={mentionRefId(s.ref)}
      >
        <Icon
          size={12}
          className={`flex-shrink-0 ${s.source === 'knowledge' ? 'text-amber-500' : 'text-sky-500'}`}
        />
        <span className={`text-accent truncate ${s.source === 'file' ? 'font-mono' : ''}`}>
          {s.label}
        </span>
        {s.detail && (
          <span className="text-text-tertiary text-[11px] truncate ml-auto pl-2">{s.detail}</span>
        )}
      </button>
    )
  })

  return (
    <div
      ref={listRef}
      className="absolute bottom-full left-0 right-0 mb-1 mx-2 max-h-48 overflow-y-auto rounded-lg border border-border-primary bg-bg-secondary shadow-xl z-30"
    >
      {nodes}
    </div>
  )
}
