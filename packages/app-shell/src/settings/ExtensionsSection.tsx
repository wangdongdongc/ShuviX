/**
 * 扩展能力卡：MCP / Skills 合在一张卡里，每组一行，条目是会换行的勾选标签。
 *
 * 两处共用：项目编辑页（项目的扩展能力 —— 新建会话从这里继承）与会话设置（这条会话自己的
 * 勾选 —— Agent 创建之后只读）。本组件只管展示与回调，数据与持久化都在调用方。
 */
import { useTranslation } from 'react-i18next'
import { Puzzle, BookOpen, WifiOff, Lock } from 'lucide-react'
import type { ToolItem } from '../common/ToolSelectList'
import { SettingsSection } from './SettingsPrimitives'

interface ExtItem {
  /** 勾选用的工具名（mcp:xxx / skill:xxx） */
  key: string
  /** 标签上的展示名（已去掉前缀） */
  display: string
  /** 悬停提示（skill 的描述） */
  desc?: string
  builtin?: boolean
  offline?: boolean
}

/** 组配色（MCP 紫 / Skills 绿）—— 写成完整类名，Tailwind 才扫得到 */
const EXT_TONES = {
  purple: { title: 'text-purple-400', checked: 'border-purple-400/40 bg-purple-400/10' },
  emerald: { title: 'text-emerald-400', checked: 'border-emerald-400/40 bg-emerald-400/10' }
} as const

interface ExtGroupRowProps {
  title: string
  icon: React.ReactNode
  tone: keyof typeof EXT_TONES
  items: ExtItem[]
  enabledTools: string[]
  onToggle: (toolName: string) => void
  readonly: boolean
  readonlyHint?: string
}

function ExtGroupRow({
  title,
  icon,
  tone,
  items,
  enabledTools,
  onToggle,
  readonly,
  readonlyHint
}: ExtGroupRowProps): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex items-start gap-3 px-3.5 py-2.5">
      {/* 组名；最小宽度让两组标签的左缘对齐（最长的「スキル」也放得下），h-6 与标签同高 */}
      <div
        className={`flex items-center gap-1.5 min-w-16 h-6 shrink-0 whitespace-nowrap text-[12px] font-medium ${EXT_TONES[tone].title}`}
      >
        {icon}
        {title}
        {/* 只读态在组名旁挂把锁：整排压暗之外再给一个明确的「锁住了」信号 */}
        {readonly && <Lock size={10} data-ext-lock className="text-text-tertiary" />}
      </div>
      {items.length > 0 && (
        <div className="flex flex-wrap gap-1.5 flex-1 min-w-0">
          {items.map((it) => {
            const checked = enabledTools.includes(it.key)
            // 只读时整排按禁用态画（压暗 + 禁用光标）：勾选的还看得出是勾选的（描边留着），
            // 但一眼就知道改不了；原因放在悬停提示里，不另起一行文字
            const stateCls = checked
              ? EXT_TONES[tone].checked
              : `border-border-secondary/60${readonly ? '' : ' hover:bg-bg-hover/60'}`
            return (
              <label
                key={it.key}
                data-ext-item={it.key}
                data-offline={it.offline || undefined}
                aria-disabled={readonly || undefined}
                title={
                  readonly ? readonlyHint : it.offline ? t('settings.mcpStatusError') : it.desc
                }
                className={`inline-flex items-center gap-1.5 h-6 max-w-full px-2 rounded-md border transition-colors ${
                  readonly ? 'cursor-not-allowed opacity-40' : 'cursor-pointer'
                } ${stateCls}`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={readonly}
                  onChange={() => onToggle(it.key)}
                  className="rounded border-border-primary accent-accent w-3 h-3 shrink-0"
                />
                {it.builtin && (
                  <span className="px-1 rounded text-[9px] text-amber-500 bg-amber-500/10 whitespace-nowrap shrink-0">
                    {t('input.skillBuiltinBadge')}
                  </span>
                )}
                <span
                  className={`text-[11px] font-mono truncate ${
                    it.offline
                      ? 'text-error'
                      : checked
                        ? 'text-text-primary'
                        : 'text-text-secondary'
                  }`}
                >
                  {it.display}
                </span>
                {it.offline && (
                  <WifiOff
                    size={10}
                    className="text-error shrink-0"
                    aria-label={t('settings.mcpStatusDisconnected')}
                  />
                )}
              </label>
            )
          })}
        </div>
      )}
    </div>
  )
}

export interface ExtensionsSectionProps {
  /** 分组标题（项目编辑页与会话设置各用各的文案） */
  title: React.ReactNode
  /** 卡片下方的说明 */
  footer?: React.ReactNode
  mcpTools: ToolItem[]
  skillTools: ToolItem[]
  enabledTools: string[]
  onToggle: (toolName: string) => void
  /** 只读：整排按禁用态画、勾选框禁用、点击无效（会话已有 Agent 运行时） */
  readonly?: boolean
  /** 只读的原因，作为条目的悬停提示 —— 界面上不另起一行文字说 */
  readonlyHint?: string
}

export function ExtensionsSection({
  title,
  footer,
  mcpTools,
  skillTools,
  enabledTools,
  onToggle,
  readonly = false,
  readonlyHint
}: ExtensionsSectionProps): React.JSX.Element {
  const { t } = useTranslation()
  // MCP 的 label 就是 server 名，和展示名重复，不当描述用
  const mcpItems: ExtItem[] = mcpTools.map((tool) => ({
    key: tool.name,
    display: tool.name.startsWith('mcp:') ? tool.name.slice(4) : tool.name,
    builtin: tool.isBuiltin,
    // 惰性启动下「没连上」是常态（用到才连），只有连接失败才标成离线
    offline: tool.serverStatus === 'error'
  }))
  const skillItems: ExtItem[] = skillTools.map((tool) => {
    const short = tool.name.startsWith('skill:') ? tool.name.slice(6) : tool.name
    const builtin = short.startsWith('builtin:')
    return {
      key: tool.name,
      display: builtin ? short.slice('builtin:'.length) : short,
      desc: tool.label,
      builtin
    }
  })

  return (
    <SettingsSection title={title} footer={footer}>
      <ExtGroupRow
        title="MCP"
        icon={<Puzzle size={12} />}
        tone="purple"
        items={mcpItems}
        enabledTools={enabledTools}
        onToggle={onToggle}
        readonly={readonly}
        readonlyHint={readonlyHint}
      />
      <ExtGroupRow
        title={t('projectForm.skillsGroup')}
        icon={<BookOpen size={12} />}
        tone="emerald"
        items={skillItems}
        enabledTools={enabledTools}
        onToggle={onToggle}
        readonly={readonly}
        readonlyHint={readonlyHint}
      />
    </SettingsSection>
  )
}
