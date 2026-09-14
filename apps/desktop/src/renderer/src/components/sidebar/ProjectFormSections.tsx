import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Trash2, Puzzle, BookOpen, WifiOff, Eye, EyeOff } from 'lucide-react'
import type { ToolItem } from '../common/ToolSelectList'
import { SettingsSection } from '../settings/SettingsPrimitives'

// ─── 扩展能力：MCP / Skills 合在一张卡里，每组一行，条目是会换行的勾选标签 ───

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
}

function ExtGroupRow({
  title,
  icon,
  tone,
  items,
  enabledTools,
  onToggle
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
      </div>
      {items.length > 0 && (
        <div className="flex flex-wrap gap-1.5 flex-1 min-w-0">
          {items.map((it) => {
            const checked = enabledTools.includes(it.key)
            return (
              <label
                key={it.key}
                title={it.offline ? t('settings.mcpStatusDisconnected') : it.desc}
                className={`inline-flex items-center gap-1.5 h-6 max-w-full px-2 rounded-md border cursor-pointer transition-colors ${
                  checked
                    ? EXT_TONES[tone].checked
                    : 'border-border-secondary/60 hover:bg-bg-hover/60'
                }`}
              >
                <input
                  type="checkbox"
                  checked={checked}
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

interface ProjectExtensionsSectionProps {
  mcpTools: ToolItem[]
  skillTools: ToolItem[]
  enabledTools: string[]
  onToggle: (toolName: string) => void
}

export function ProjectExtensionsSection({
  mcpTools,
  skillTools,
  enabledTools,
  onToggle
}: ProjectExtensionsSectionProps): React.JSX.Element {
  const { t } = useTranslation()
  // MCP 的 label 就是 server 名，和展示名重复，不当描述用
  const mcpItems: ExtItem[] = mcpTools.map((tool) => ({
    key: tool.name,
    display: tool.name.startsWith('mcp:') ? tool.name.slice(4) : tool.name,
    builtin: tool.isBuiltin,
    offline: tool.serverStatus !== 'connected'
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
    <SettingsSection title={t('projectForm.wizardStepExtensions')}>
      <ExtGroupRow
        title="MCP"
        icon={<Puzzle size={12} />}
        tone="purple"
        items={mcpItems}
        enabledTools={enabledTools}
        onToggle={onToggle}
      />
      <ExtGroupRow
        title={t('projectForm.skillsGroup')}
        icon={<BookOpen size={12} />}
        tone="emerald"
        items={skillItems}
        enabledTools={enabledTools}
        onToggle={onToggle}
      />
    </SettingsSection>
  )
}

// ─── 高级：环境变量 ────────────────────────────────────

export interface EnvVar {
  key: string
  value: string
  sensitive: boolean
}

interface ProjectEnvVarsSectionProps {
  envVars: EnvVar[]
  onChange: (envVars: EnvVar[]) => void
}

export function ProjectEnvVarsSection({
  envVars,
  onChange
}: ProjectEnvVarsSectionProps): React.JSX.Element {
  const { t } = useTranslation()
  const [visibility, setVisibility] = useState<Record<number, boolean>>({})
  const toggleVisibility = (i: number): void =>
    setVisibility((prev) => ({ ...prev, [i]: !prev[i] }))

  const update = (idx: number, patch: Partial<EnvVar>): void => {
    const next = [...envVars]
    next[idx] = { ...next[idx], ...patch }
    onChange(next)
  }

  const inputCls =
    'min-w-0 px-2 py-1 rounded-md text-[11px] bg-bg-primary border border-border-secondary/50 text-text-primary placeholder:text-text-tertiary outline-none transition-colors hover:border-border-secondary focus:border-accent/60'

  return (
    <SettingsSection
      title={t('projectForm.envVarsTitle')}
      footer={t('projectForm.envVarsDesc')}
      headerAction={
        <button
          onClick={() => onChange([...envVars, { key: '', value: '', sensitive: false }])}
          className="inline-flex items-center gap-1 text-[11px] text-accent hover:bg-accent/10 px-2 py-1 rounded transition-colors"
        >
          <Plus size={11} />
          {t('projectForm.envVarAdd')}
        </button>
      }
    >
      {envVars.length === 0 ? (
        <div className="px-4 py-4 text-center text-[11px] text-text-tertiary">—</div>
      ) : (
        envVars.map((v, i) => (
          <div key={i} className="flex items-center gap-1.5 px-4 py-2">
            <input
              value={v.key}
              onChange={(e) => update(i, { key: e.target.value })}
              placeholder={t('projectForm.envVarKey')}
              className={`${inputCls} font-mono flex-[2]`}
            />
            {v.sensitive ? (
              <div className="flex-[3] min-w-0 flex items-center gap-0">
                <input
                  value={v.value}
                  type={visibility[i] ? 'text' : 'password'}
                  onChange={(e) => update(i, { value: e.target.value })}
                  placeholder={t('projectForm.envVarValue')}
                  className={`${inputCls} font-mono flex-1 rounded-r-none border-r-0`}
                />
                <button
                  type="button"
                  onClick={() => toggleVisibility(i)}
                  className="px-1.5 self-stretch flex items-center border border-l-0 border-border-secondary/50 rounded-r-md text-text-tertiary hover:text-text-primary bg-bg-primary transition-colors"
                  title={visibility[i] ? 'Hide' : 'Show'}
                >
                  {visibility[i] ? <Eye size={11} /> : <EyeOff size={11} />}
                </button>
              </div>
            ) : (
              <input
                value={v.value}
                onChange={(e) => update(i, { value: e.target.value })}
                placeholder={t('projectForm.envVarValue')}
                className={`${inputCls} font-mono flex-[3]`}
              />
            )}
            <label className="flex items-center gap-1 cursor-pointer select-none shrink-0">
              <input
                type="checkbox"
                checked={v.sensitive}
                onChange={(e) => update(i, { sensitive: e.target.checked })}
                className="rounded border-border-primary accent-accent w-3 h-3"
              />
              <span className="text-[10px] text-text-tertiary">
                {t('projectForm.envVarSensitive')}
              </span>
            </label>
            <button
              onClick={() => onChange(envVars.filter((_, j) => j !== i))}
              className="p-1 rounded text-text-tertiary hover:text-error hover:bg-error/10 shrink-0 transition-colors"
            >
              <Trash2 size={11} />
            </button>
          </div>
        ))
      )}
    </SettingsSection>
  )
}
