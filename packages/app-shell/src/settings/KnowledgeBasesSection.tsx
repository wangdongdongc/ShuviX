/**
 * 知识库卡：这条会话（或这个项目的新会话）用哪几个知识库。
 *
 * 与扩展能力卡并排，但**语义刻意不同**：扩展能力在 Agent 建出来之后只读（工具表烤进了 pi，运行期
 * 换不了），知识库是 `knowledge` 工具每次调用时由宿主现查的 —— 运行时存在期间照样能改，改完下一次
 * 调用就作数。所以这张卡没有「已锁定」这回事。
 *
 * 两处共用：项目编辑页（这个项目的新会话缺省用哪几个）与会话设置（这条会话自己的）。本组件只管展示
 * 与回调，数据与持久化都在调用方。一个候选库都没有时整节不显示（扩展端落在这里：它没有知识库）。
 */
import { useTranslation } from 'react-i18next'
import { Library } from 'lucide-react'
import { KNOWLEDGE_BUILTIN_BASE, KNOWLEDGE_PROJECT_BASE } from '@shuvix/chat-protocol/knowledge'
import { SettingsSection } from './SettingsPrimitives'

export interface KnowledgeBaseChoice {
  /** 选择里存的名字：用户库的目录名，或保留名 `project` / `shuvix` */
  name: string
  /** 补充说明（项目库给项目当前的名字）；没有就只显示名字 */
  label?: string
}

export interface KnowledgeBasesSectionProps {
  /** 分组标题（项目编辑页与会话设置各用各的文案） */
  title: React.ReactNode
  /** 卡片下方的说明 */
  footer?: React.ReactNode
  options: KnowledgeBaseChoice[]
  selected: string[]
  onToggle: (name: string) => void
  readonly?: boolean
}

export function KnowledgeBasesSection({
  title,
  footer,
  options,
  selected,
  onToggle,
  readonly = false
}: KnowledgeBasesSectionProps): React.JSX.Element | null {
  const { t } = useTranslation()
  if (options.length === 0) return null

  return (
    <SettingsSection title={title} footer={footer}>
      <div className="flex items-start gap-3 px-3.5 py-2.5">
        <div className="flex items-center gap-1.5 min-w-16 h-6 shrink-0 whitespace-nowrap text-[12px] font-medium text-sky-400">
          <Library size={12} />
          {t('sessionConfig.knowledgeGroup')}
        </div>
        <div className="flex flex-wrap gap-1.5 flex-1 min-w-0">
          {options.map((option) => {
            const checked = selected.includes(option.name)
            const isProject = option.name === KNOWLEDGE_PROJECT_BASE
            const isBuiltin = option.name === KNOWLEDGE_BUILTIN_BASE
            const display = isProject
              ? t('sessionConfig.knowledgeProjectBase')
              : isBuiltin
                ? t('knowledge.builtinBaseName')
                : option.name
            // 只读时没有悬停底色，未勾选的再压暗一档 —— 一眼看出哪些是真在用的
            const stateCls = checked
              ? 'border-sky-400/40 bg-sky-400/10'
              : readonly
                ? 'border-border-secondary/60 opacity-60'
                : 'border-border-secondary/60 hover:bg-bg-hover/60'
            return (
              <label
                key={option.name}
                data-knowledge-base={option.name}
                title={option.label || undefined}
                className={`inline-flex items-center gap-1.5 h-6 max-w-full px-2 rounded-md border transition-colors ${
                  readonly ? 'cursor-default' : 'cursor-pointer'
                } ${stateCls}`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={readonly}
                  onChange={() => onToggle(option.name)}
                  className="rounded border-border-primary accent-accent w-3 h-3 shrink-0"
                />
                <span
                  className={`text-[11px] font-mono truncate ${
                    checked ? 'text-text-primary' : 'text-text-secondary'
                  }`}
                >
                  {display}
                  {isProject && option.label ? ` · ${option.label}` : ''}
                </span>
              </label>
            )
          })}
        </div>
      </div>
    </SettingsSection>
  )
}
