import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  FolderOpen,
  Plus,
  Trash2,
  Puzzle,
  BookOpen,
  Settings,
  WifiOff,
  Eye,
  EyeOff
} from 'lucide-react'
import type { ReferenceDir } from '../../../../main/types/project'
import type { ProjectPromptSection } from '@shuvix/chat-protocol/types/promptSection'
import type { ToolItem } from '../common/ToolSelectList'
import { PromptSectionsEditor } from '@shuvix/app-shell'
import { SettingsSection, SettingsRow, Toggle, InlineInput } from '../settings/SettingsPrimitives'

// ─── 基本信息：项目名称 ────────────────────────────────

interface ProjectBasicInfoProps {
  name: string
  onNameChange: (name: string) => void
}

export function ProjectBasicInfo({ name, onNameChange }: ProjectBasicInfoProps): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <SettingsSection title={t('projectForm.basicInfoTitle')}>
      <SettingsRow
        title={t('projectForm.name')}
        control={
          <InlineInput
            value={name}
            onChange={onNameChange}
            placeholder={t('projectForm.namePlaceholder')}
            width={260}
          />
        }
      />
    </SettingsSection>
  )
}

// ─── 项目提示词 ─────────────────────────────────────────

interface ProjectPromptSectionsGroupProps {
  sections: ProjectPromptSection[]
  onChange: (sections: ProjectPromptSection[]) => void
}

export function ProjectPromptSectionsGroup({
  sections,
  onChange
}: ProjectPromptSectionsGroupProps): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <SettingsSection title={t('projectForm.promptSectionsTitle')}>
      <PromptSectionsEditor sections={sections} onChange={onChange} />
    </SettingsSection>
  )
}

// ─── 文件系统：路径 + 参考目录 ──────────────────

interface ProjectFileSystemProps {
  path: string
  onSelectFolder: () => void
  referenceDirs: ReferenceDir[]
  onReferenceDirsChange: (dirs: ReferenceDir[]) => void
}

export function ProjectFileSystem({
  path,
  onSelectFolder,
  referenceDirs,
  onReferenceDirsChange
}: ProjectFileSystemProps): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <SettingsSection
      title={t('projectForm.folders')}
      headerAction={
        <button
          onClick={async () => {
            const result = await window.electron.ipcRenderer.invoke('dialog:openDirectory')
            if (result && !referenceDirs.some((d) => d.path === result)) {
              onReferenceDirsChange([...referenceDirs, { path: result }])
            }
          }}
          className="flex items-center gap-1 px-2 py-1 rounded text-[11px] text-accent hover:bg-accent/10 transition-colors"
        >
          <Plus size={11} />
          {t('projectForm.addRefDir')}
        </button>
      }
    >
      {/* 项目文件夹 */}
      {path ? (
        <div className="group/row flex items-center gap-2 px-4 py-2.5 hover:bg-bg-hover/40 transition-colors">
          <span className="shrink-0 w-7 text-center rounded text-[9px] font-medium border bg-amber-500/10 text-amber-500 border-amber-500/30 py-0.5">
            {t('projectForm.refDirAccessRW')}
          </span>
          <FolderOpen size={11} className="text-text-tertiary shrink-0" />
          <span className="text-[12px] font-mono text-text-primary truncate flex-1" title={path}>
            {path.split('/').pop() || path}
          </span>
          <button
            onClick={onSelectFolder}
            className="text-[11px] text-text-tertiary opacity-0 group-hover/row:opacity-100 hover:!text-accent transition-all shrink-0"
          >
            {t('projectForm.changeFolder')}
          </button>
        </div>
      ) : (
        <div className="px-4 py-3">
          <button
            onClick={onSelectFolder}
            className="flex items-center gap-1 text-[11px] text-accent hover:bg-accent/10 transition-colors px-2 py-1 rounded"
          >
            <Plus size={11} />
            {t('projectForm.selectFolder')}
          </button>
        </div>
      )}

      {/* 引用文件夹 */}
      {referenceDirs.map((dir, idx) => (
        <div
          key={idx}
          className="group/row flex items-center gap-2 px-4 py-2.5 hover:bg-bg-hover/40 transition-colors"
        >
          <button
            onClick={() => {
              const next = [...referenceDirs]
              const current = dir.access ?? 'readonly'
              next[idx] = { ...dir, access: current === 'readonly' ? 'readwrite' : 'readonly' }
              onReferenceDirsChange(next)
            }}
            className={`shrink-0 w-7 text-center rounded text-[9px] font-medium border transition-colors py-0.5 ${
              (dir.access ?? 'readonly') === 'readwrite'
                ? 'bg-amber-500/10 text-amber-500 border-amber-500/30 hover:bg-amber-500/20'
                : 'bg-bg-tertiary/40 text-text-tertiary border-border-secondary hover:bg-bg-hover'
            }`}
            title={
              (dir.access ?? 'readonly') === 'readwrite'
                ? t('projectForm.refDirAccessReadwrite')
                : t('projectForm.refDirAccessReadonly')
            }
          >
            {(dir.access ?? 'readonly') === 'readwrite'
              ? t('projectForm.refDirAccessRW')
              : t('projectForm.refDirAccessRO')}
          </button>
          <FolderOpen size={11} className="text-text-tertiary shrink-0" />
          <span
            className="text-[12px] font-mono text-text-primary truncate flex-1"
            title={dir.path}
          >
            {dir.path.split('/').pop() || dir.path}
          </span>
          <button
            onClick={() => onReferenceDirsChange(referenceDirs.filter((_, i) => i !== idx))}
            className="p-1 rounded text-text-tertiary opacity-0 group-hover/row:opacity-100 hover:!text-error transition-all shrink-0"
          >
            <Trash2 size={11} />
          </button>
        </div>
      ))}
    </SettingsSection>
  )
}

// ─── 扩展能力：MCP + Skills 选择面板 ────────────────────

interface ExtensionsPanelProps {
  mcpTools: ToolItem[]
  skillTools: ToolItem[]
  enabledTools: string[]
  onToggle: (toolName: string) => void
  onOpenSettings: () => void
}

export function ExtensionsPanel({
  mcpTools,
  skillTools,
  enabledTools,
  onToggle,
  onOpenSettings
}: ExtensionsPanelProps): React.JSX.Element {
  const { t } = useTranslation()
  const hasMcpOrSkills = mcpTools.length > 0 || skillTools.length > 0

  if (!hasMcpOrSkills) {
    return (
      <div className="space-y-5">
        <p className="text-[11px] text-text-tertiary leading-relaxed px-1">
          {t('projectForm.extEmptyDesc')}
        </p>
        <SettingsSection
          title={
            <span className="inline-flex items-center gap-1.5">
              <Puzzle size={12} className="text-purple-400" />
              MCP Server
            </span>
          }
        >
          <div className="px-4 py-3 space-y-2">
            <p className="text-[11px] text-text-tertiary leading-relaxed">
              {t('projectForm.extMcpDesc')}
            </p>
            <button
              onClick={onOpenSettings}
              className="inline-flex items-center gap-1.5 text-[11px] text-accent hover:bg-accent/10 px-2 py-1 rounded transition-colors"
            >
              <Settings size={11} />
              {t('projectForm.extGoSettings')}
            </button>
          </div>
        </SettingsSection>
        <SettingsSection
          title={
            <span className="inline-flex items-center gap-1.5">
              <BookOpen size={12} className="text-emerald-400" />
              Skills
            </span>
          }
        >
          <div className="px-4 py-3 space-y-2">
            <p className="text-[11px] text-text-tertiary leading-relaxed">
              {t('projectForm.extSkillDesc')}
            </p>
            <button
              onClick={onOpenSettings}
              className="inline-flex items-center gap-1.5 text-[11px] text-accent hover:bg-accent/10 px-2 py-1 rounded transition-colors"
            >
              <Settings size={11} />
              {t('projectForm.extGoSettings')}
            </button>
          </div>
        </SettingsSection>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <p className="text-[11px] text-text-tertiary leading-relaxed px-1">
        {t('projectForm.extAvailableDesc')}
      </p>

      {mcpTools.length > 0 && (
        <SettingsSection
          title={
            <span className="inline-flex items-center gap-1.5 text-purple-400">
              <Puzzle size={12} />
              MCP
            </span>
          }
        >
          {mcpTools.map((tool) => {
            const isOnline = tool.serverStatus === 'connected'
            const serverName = tool.name.startsWith('mcp:') ? tool.name.slice(4) : tool.name
            return (
              <label
                key={tool.name}
                className="flex items-center gap-2 px-4 py-2.5 cursor-pointer hover:bg-bg-hover/40 transition-colors"
              >
                <input
                  type="checkbox"
                  checked={enabledTools.includes(tool.name)}
                  onChange={() => onToggle(tool.name)}
                  className="rounded border-border-primary accent-accent w-3.5 h-3.5 shrink-0"
                />
                {tool.isBuiltin && (
                  <span className="px-1.5 py-0.5 rounded-md text-[9px] font-normal text-amber-500 bg-amber-500/10 whitespace-nowrap shrink-0">
                    {t('input.skillBuiltinBadge')}
                  </span>
                )}
                <span
                  className={`text-[12px] font-mono whitespace-nowrap shrink-0 ${
                    isOnline ? 'text-text-primary' : 'text-error'
                  }`}
                >
                  {serverName}
                </span>
                {!isOnline && (
                  <span
                    className="flex items-center gap-0.5 text-[10px] text-error shrink-0"
                    title={t('settings.mcpStatusDisconnected')}
                  >
                    <WifiOff size={10} />
                  </span>
                )}
                {tool.label && (
                  <span className="text-[11px] text-text-tertiary truncate flex-1 min-w-0">
                    {tool.label}
                  </span>
                )}
              </label>
            )
          })}
        </SettingsSection>
      )}

      {skillTools.length > 0 && (
        <SettingsSection
          title={
            <span className="inline-flex items-center gap-1.5 text-emerald-400">
              <BookOpen size={12} />
              Skills
            </span>
          }
        >
          {skillTools.map((tool) => {
            const short = tool.name.startsWith('skill:') ? tool.name.slice(6) : tool.name
            const builtin = short.startsWith('builtin:')
            const label = builtin ? short.slice('builtin:'.length) : short
            return (
              <label
                key={tool.name}
                className="flex items-center gap-2 px-4 py-2.5 cursor-pointer hover:bg-bg-hover/40 transition-colors"
              >
                <input
                  type="checkbox"
                  checked={enabledTools.includes(tool.name)}
                  onChange={() => onToggle(tool.name)}
                  className="rounded border-border-primary accent-accent w-3.5 h-3.5 shrink-0"
                />
                {builtin && (
                  <span className="px-1.5 py-0.5 rounded-md text-[9px] font-normal text-amber-500 bg-amber-500/10 whitespace-nowrap shrink-0">
                    {t('input.skillBuiltinBadge')}
                  </span>
                )}
                <span className="text-[12px] font-mono text-text-primary whitespace-nowrap shrink-0">
                  {label}
                </span>
                {tool.label && (
                  <span className="text-[11px] text-text-tertiary truncate flex-1 min-w-0">
                    {tool.label}
                  </span>
                )}
              </label>
            )
          })}
        </SettingsSection>
      )}

      <button
        onClick={onOpenSettings}
        className="inline-flex items-center gap-1.5 text-[11px] text-text-tertiary hover:text-accent transition-colors px-1"
      >
        <Settings size={12} />
        {t('projectForm.extGoSettings')}
      </button>
    </div>
  )
}

// ─── 高级：pglite 持久化开关 ────────────────────────────

interface ProjectPgLiteSectionProps {
  pglitePersist: boolean
  onChange: (v: boolean) => void
}

export function ProjectPgLiteSection({
  pglitePersist,
  onChange
}: ProjectPgLiteSectionProps): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <SettingsSection title={t('projectForm.pglitePersistSection')}>
      <SettingsRow
        title={t('projectForm.pglitePersistLabel')}
        description={t('projectForm.pglitePersistDesc')}
        control={<Toggle on={pglitePersist} onClick={() => onChange(!pglitePersist)} />}
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
