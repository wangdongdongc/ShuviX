import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Trash2, Puzzle, BookOpen, WifiOff, Eye, EyeOff } from 'lucide-react'
import type { ToolItem } from '../common/ToolSelectList'
import { SettingsSection } from '../settings/SettingsPrimitives'

// ─── 项目提示词（纯文本；经 shuvix-project-awareness 开关注入会话上下文） ───

interface ProjectSystemPromptGroupProps {
  value: string
  onChange: (value: string) => void
}

export function ProjectSystemPromptGroup({
  value,
  onChange
}: ProjectSystemPromptGroupProps): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <SettingsSection title={t('projectForm.systemPrompt')}>
      {/* 外框由 SettingsSection 卡片承担 —— textarea 自身透明无边框,只留内边距 */}
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t('projectForm.systemPromptPlaceholder')}
        rows={4}
        spellCheck={false}
        className="block w-full px-3.5 py-3 text-xs bg-transparent text-text-primary placeholder:text-text-tertiary focus:outline-none leading-relaxed resize-none [field-sizing:content] min-h-[88px]"
      />
    </SettingsSection>
  )
}

// ─── 扩展能力：MCP / Skills 各一张卡 ───────────────────────

interface ExtItem {
  /** 勾选用的工具名（mcp:xxx / skill:xxx） */
  key: string
  /** 行内展示名（已去掉前缀） */
  display: string
  /** 右侧灰色描述 */
  desc?: string
  builtin?: boolean
  offline?: boolean
}

interface ExtCardProps {
  title: string
  icon: React.ReactNode
  /** 卡片标题色（MCP 紫 / Skills 绿） */
  colorClass: string
  items: ExtItem[]
  enabledTools: string[]
  onToggle: (toolName: string) => void
}

function ExtCard({
  title,
  icon,
  colorClass,
  items,
  enabledTools,
  onToggle
}: ExtCardProps): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <SettingsSection
      title={
        <span className={`inline-flex items-center gap-1.5 ${colorClass}`}>
          {icon}
          {title}
        </span>
      }
    >
      {items.length === 0 ? (
        <div className="px-4 py-4 text-center text-[11px] text-text-tertiary">—</div>
      ) : (
        items.map((it) => (
          <label
            key={it.key}
            className="flex items-center gap-2 px-4 py-2.5 cursor-pointer hover:bg-bg-hover/40 transition-colors"
          >
            <input
              type="checkbox"
              checked={enabledTools.includes(it.key)}
              onChange={() => onToggle(it.key)}
              className="rounded border-border-primary accent-accent w-3.5 h-3.5 shrink-0"
            />
            {it.builtin && (
              <span className="px-1.5 py-0.5 rounded-md text-[9px] font-normal text-amber-500 bg-amber-500/10 whitespace-nowrap shrink-0">
                {t('input.skillBuiltinBadge')}
              </span>
            )}
            <span
              className={`text-[12px] font-mono whitespace-nowrap shrink-0 ${
                it.offline ? 'text-error' : 'text-text-primary'
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
            {it.desc && (
              <span className="text-[11px] text-text-tertiary truncate flex-1 min-w-0">
                {it.desc}
              </span>
            )}
          </label>
        ))
      )}
    </SettingsSection>
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
  const mcpItems: ExtItem[] = mcpTools.map((tool) => ({
    key: tool.name,
    display: tool.name.startsWith('mcp:') ? tool.name.slice(4) : tool.name,
    desc: tool.label,
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
    <>
      <ExtCard
        title="MCP"
        icon={<Puzzle size={12} />}
        colorClass="text-purple-400"
        items={mcpItems}
        enabledTools={enabledTools}
        onToggle={onToggle}
      />
      <ExtCard
        title="Skills"
        icon={<BookOpen size={12} />}
        colorClass="text-emerald-400"
        items={skillItems}
        enabledTools={enabledTools}
        onToggle={onToggle}
      />
    </>
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
