import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  X,
  Wrench,
  Database,
  Terminal,
  ChevronRight,
  Info,
  FileText,
  Plus,
  Trash2,
  Eye,
  EyeOff
} from 'lucide-react'
import { icons } from 'lucide-react'
import { ToolSelectList, type ToolItem } from '../common/ToolSelectList'
import { useDialogClose } from '../../hooks/useDialogClose'
import { usePanelTransition } from '../../hooks/usePanelTransition'
import {
  ProjectBasicInfo,
  ProjectFileSystem,
  ExtensionsPanel,
  ProjectPromptSectionsGroup
} from './ProjectFormSections'
import { getDefaultPromptSections } from '../../utils/promptSectionPresets'

import type { ReferenceDir } from '../../../../main/types/project'
import type { ProjectPromptSection } from '../../../../shared/types/promptSection'

interface ProjectCreateDialogProps {
  onClose: () => void
  /** 创建成功后回调，传入新项目 ID */
  onCreated?: (projectId: string) => void | Promise<void>
  /** 预选用途，跳过 step 0 直接进入工具选择 */
  initialPurpose?: string
}

/** 用途预设：工具名称列表 */
const PURPOSE_PRESETS: Record<string, string[]> = {
  bash: ['bash', 'read', 'ask'],
  office: ['read', 'ask', 'python'],
  dev: ['bash', 'read', 'write', 'edit', 'ask', 'ls', 'grep', 'glob', 'explore']
}

/** 插件 purpose 类型 */
interface PluginPurpose {
  key: string
  icon: string
  labelKey: string
  tipKey: string
  i18n: Record<string, Record<string, string>>
  enabledTools: string[]
}

/** Skills 分组标识 */
const SKILLS_GROUP = '__skills__'

/**
 * 新建项目弹窗 — 渐进式引导配置
 * Step 0: 选择用途（通用 Bash / 数据分析 / 编码 / UI 设计）→ 预选工具
 * Step 1: 工具选择（仅内置工具）
 * Step 2: 扩展能力（MCP / Skills 引导）
 * Step 3: 项目配置（名称 + 提示词 + 路径 + 参考目录 + 沙箱）
 */
export function ProjectCreateDialog({
  onClose,
  onCreated,
  initialPurpose
}: ProjectCreateDialogProps): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const { closing, handleClose } = useDialogClose(onClose)

  // 向导步骤
  const [step, setStep] = useState(initialPurpose ? 1 : 0)
  const panelRef = usePanelTransition()
  const [purpose, setPurpose] = useState<string | null>(initialPurpose ?? null)

  // 项目字段
  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  // 新建项目时预置 4 张卡片(身份 / 任务处理哲学 / 工具使用规则 / 安全指引),用户可自由删改
  const [promptSections, setPromptSections] = useState<ProjectPromptSection[]>(() =>
    getDefaultPromptSections(t)
  )
  const [saving, setSaving] = useState(false)
  const [allTools, setAllTools] = useState<ToolItem[]>([])
  const [enabledTools, setEnabledTools] = useState<string[]>([])
  const [referenceDirs, setReferenceDirs] = useState<ReferenceDir[]>([])
  const [pglitePersist, setPglitePersist] = useState(false)
  const [envVars, setEnvVars] = useState<Array<{ key: string; value: string; sensitive: boolean }>>(
    []
  )
  const [envVisibility, setEnvVisibility] = useState<Record<number, boolean>>({})
  const [pluginPurposes, setPluginPurposes] = useState<PluginPurpose[]>([])

  // 加载插件 purposes
  useEffect(() => {
    window.api.plugin.purposes().then((purposes) => {
      setPluginPurposes(purposes)
    })
  }, [])

  // 加载工具列表
  useEffect(() => {
    window.api.tools.list().then((tools) => {
      setAllTools(tools)
    })
  }, [])

  // MCP / Skills 工具
  const mcpTools = allTools.filter((t) => t.group?.startsWith('mcp:'))
  const skillTools = allTools.filter((t) => t.group === SKILLS_GROUP)

  // initialPurpose：工具列表加载后自动预选（仅首次）
  const purposeApplied = useRef(false)
  useEffect(() => {
    if (!initialPurpose || allTools.length === 0 || purposeApplied.current) return
    purposeApplied.current = true
    let preset = PURPOSE_PRESETS[initialPurpose]
    if (!preset) {
      const pp = pluginPurposes.find((p) => p.key === initialPurpose)
      preset = pp?.enabledTools || PURPOSE_PRESETS.bash
    }
    const connectedMcp = allTools
      .filter((t) => t.group?.startsWith('mcp:') && t.serverStatus === 'connected')
      .map((t) => t.name)
    const enabledSkills = allTools.filter((t) => t.group === SKILLS_GROUP).map((t) => t.name)
    setEnabledTools([...new Set([...preset, ...connectedMcp, ...enabledSkills])])
  }, [initialPurpose, allTools, pluginPurposes])

  // 按 Escape 关闭（step 0 直接关闭，其他步骤回退）
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        if (step === 0) handleClose()
        else setStep(step - 1)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [handleClose, step])

  /** 选择用途 → 预选工具 → 进入工具选择步骤 */
  const handlePurposeSelect = (key: string): void => {
    setPurpose(key)
    // 先检查内置预设，再查插件 purpose
    let preset = PURPOSE_PRESETS[key]
    if (!preset) {
      const pluginPurpose = pluginPurposes.find((p) => p.key === key)
      preset = pluginPurpose?.enabledTools || PURPOSE_PRESETS.bash
    }
    // 默认选中已连接的 MCP 工具和已启用的 Skills
    const connectedMcp = mcpTools.filter((t) => t.serverStatus === 'connected').map((t) => t.name)
    const enabledSkills = skillTools.map((t) => t.name)
    setEnabledTools([...new Set([...preset, ...connectedMcp, ...enabledSkills])])
    setStep(1)
  }

  /** 选择文件夹 */
  const handleSelectFolder = async (): Promise<void> => {
    const result = await window.electron.ipcRenderer.invoke('dialog:openDirectory')
    if (result) {
      setPath(result)
      if (!name) {
        const folderName = result.split('/').pop() || result.split('\\').pop() || ''
        setName(folderName)
      }
    }
  }

  /** 打开设置窗口 */
  const handleOpenSettings = (): void => {
    window.api.app.openSettings()
  }

  /** 切换单个扩展工具 */
  const toggleExtTool = (toolName: string): void => {
    setEnabledTools((prev) =>
      prev.includes(toolName) ? prev.filter((n) => n !== toolName) : [...prev, toolName]
    )
  }

  /** 创建项目 */
  const handleCreate = async (): Promise<void> => {
    if (!path.trim()) return
    setSaving(true)
    try {
      const project = await window.api.project.create({
        name: name.trim() || undefined,
        path: path.trim(),
        promptSections,
        enabledTools,
        referenceDirs: referenceDirs.length > 0 ? referenceDirs : undefined,
        tool:
          pglitePersist || envVars.some((v) => v.key.trim())
            ? {
                ...(pglitePersist ? { pglitePersist: true } : {}),
                envVars: envVars.filter((v) => v.key.trim()).length
                  ? envVars.filter((v) => v.key.trim())
                  : undefined
              }
            : undefined
      })
      await onCreated?.(project.id)
      onClose()
    } finally {
      setSaving(false)
    }
  }

  // 步骤标签
  const steps = [
    t('projectForm.wizardStepPurpose'),
    t('projectForm.wizardStepTools'),
    t('projectForm.wizardStepExtensions'),
    t('projectForm.wizardStepProject'),
    t('projectForm.wizardStepAdvanced')
  ]

  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center bg-black/40 dialog-overlay${closing ? ' dialog-closing' : ''}`}
    >
      <div
        ref={panelRef}
        className="bg-bg-primary border border-border-primary rounded-xl shadow-xl w-[520px] max-w-[90vw] max-h-[85vh] flex flex-col dialog-panel"
      >
        {/* 标题栏 + 步骤指示器 */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-secondary">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-semibold text-text-primary">
              {t('projectForm.createTitle')}
            </h2>
            <div className="flex items-center gap-1">
              {steps.map((label, i) => (
                <div key={i} className="flex items-center gap-1">
                  {i > 0 && <ChevronRight size={10} className="text-text-tertiary/40" />}
                  <span
                    className={`text-[10px] transition-colors ${
                      i === step
                        ? 'text-accent font-medium'
                        : i < step
                          ? 'text-text-secondary'
                          : 'text-text-tertiary/50'
                    }`}
                  >
                    {label}
                  </span>
                </div>
              ))}
            </div>
          </div>
          <button
            onClick={handleClose}
            className="p-1 rounded-lg hover:bg-bg-hover text-text-tertiary hover:text-text-primary transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* ========== Step 0: 选择用途 ========== */}
        {step === 0 && (
          <div className="px-5 py-6 flex-1 min-h-0">
            <div className="text-center mb-6">
              <h3 className="text-sm font-medium text-text-primary">
                {t('projectForm.purposeTitle')}
              </h3>
              <p className="text-[11px] text-text-tertiary mt-1">{t('projectForm.purposeDesc')}</p>
            </div>
            <div className="grid grid-cols-4 gap-3">
              <button
                onClick={() => handlePurposeSelect('bash')}
                className={`group flex flex-col items-center gap-3 p-5 rounded-xl border transition-all hover:border-accent/50 hover:bg-accent/5 ${
                  purpose === 'bash' ? 'border-accent bg-accent/5' : 'border-border-secondary'
                }`}
              >
                <div className="w-10 h-10 rounded-lg bg-bg-tertiary flex items-center justify-center group-hover:bg-accent/10 transition-colors">
                  <Terminal
                    size={20}
                    className="text-text-secondary group-hover:text-accent transition-colors"
                  />
                </div>
                <div className="text-xs font-medium text-text-primary">
                  {t('projectForm.purposeBash')}
                </div>
              </button>

              <button
                onClick={() => handlePurposeSelect('office')}
                className={`group flex flex-col items-center gap-3 p-5 rounded-xl border transition-all hover:border-accent/50 hover:bg-accent/5 ${
                  purpose === 'office' ? 'border-accent bg-accent/5' : 'border-border-secondary'
                }`}
              >
                <div className="w-10 h-10 rounded-lg bg-bg-tertiary flex items-center justify-center group-hover:bg-accent/10 transition-colors">
                  <FileText
                    size={20}
                    className="text-text-secondary group-hover:text-accent transition-colors"
                  />
                </div>
                <div className="text-xs font-medium text-text-primary">
                  {t('projectForm.purposeOffice')}
                </div>
              </button>

              {pluginPurposes.map((pp) => {
                const IconComponent = icons[pp.icon as keyof typeof icons]
                return (
                  <button
                    key={pp.key}
                    onClick={() => handlePurposeSelect(pp.key)}
                    className={`group flex flex-col items-center gap-3 p-5 rounded-xl border transition-all hover:border-accent/50 hover:bg-accent/5 ${
                      purpose === pp.key ? 'border-accent bg-accent/5' : 'border-border-secondary'
                    }`}
                  >
                    <div className="w-10 h-10 rounded-lg bg-bg-tertiary flex items-center justify-center group-hover:bg-accent/10 transition-colors">
                      {IconComponent ? (
                        <IconComponent
                          size={20}
                          className="text-text-secondary group-hover:text-accent transition-colors"
                        />
                      ) : (
                        <Wrench
                          size={20}
                          className="text-text-secondary group-hover:text-accent transition-colors"
                        />
                      )}
                    </div>
                    <div className="text-xs font-medium text-text-primary">
                      {pp.i18n[i18n.language]?.[pp.labelKey] ??
                        pp.i18n['en']?.[pp.labelKey] ??
                        pp.labelKey}
                    </div>
                  </button>
                )
              })}

              <button
                onClick={() => handlePurposeSelect('dev')}
                className={`group flex flex-col items-center gap-3 p-5 rounded-xl border transition-all hover:border-accent/50 hover:bg-accent/5 ${
                  purpose === 'dev' ? 'border-accent bg-accent/5' : 'border-border-secondary'
                }`}
              >
                <div className="w-10 h-10 rounded-lg bg-bg-tertiary flex items-center justify-center group-hover:bg-accent/10 transition-colors">
                  <Wrench
                    size={20}
                    className="text-text-secondary group-hover:text-accent transition-colors"
                  />
                </div>
                <div className="text-xs font-medium text-text-primary">
                  {t('projectForm.purposeDev')}
                </div>
              </button>
            </div>
          </div>
        )}

        {/* ========== Step 1: 工具选择（仅内置） ========== */}
        {step === 1 && (
          <>
            <div className="px-5 py-4 overflow-y-auto flex-1 min-h-0 space-y-3">
              {purpose &&
                (() => {
                  const pluginPurpose = pluginPurposes.find((p) => p.key === purpose)
                  const tipKey = pluginPurpose
                    ? pluginPurpose.tipKey
                    : `projectForm.purposeTip${purpose.charAt(0).toUpperCase() + purpose.slice(1)}`
                  const tipText = pluginPurpose
                    ? (pluginPurpose.i18n[i18n.language]?.[pluginPurpose.tipKey] ??
                      pluginPurpose.i18n['en']?.[pluginPurpose.tipKey] ??
                      t(tipKey))
                    : t(tipKey)
                  return (
                    <div className="flex gap-2 p-3 rounded-lg bg-accent/5 border border-accent/20">
                      <Info size={14} className="text-accent shrink-0 mt-0.5" />
                      <p className="text-[11px] text-text-secondary leading-relaxed">{tipText}</p>
                    </div>
                  )
                })()}
              <div className="zen-section">
                <label className="flex items-center gap-1.5 text-xs font-medium text-text-secondary mb-2">
                  <Wrench size={12} />
                  {t('projectForm.tools')}
                </label>
                <ToolSelectList
                  tools={allTools}
                  enabledTools={enabledTools}
                  onChange={setEnabledTools}
                  builtinOnly
                />
                <p className="text-[10px] text-text-tertiary mt-2">{t('projectForm.toolsHint')}</p>
              </div>
            </div>

            <div className="flex items-center justify-between px-5 py-3 border-t border-border-secondary">
              <button
                onClick={() => setStep(0)}
                className="px-3 py-1.5 rounded-lg text-xs text-text-secondary hover:bg-bg-hover transition-colors"
              >
                {t('projectForm.wizardPrev')}
              </button>
              <button
                onClick={() => setStep(2)}
                className="px-4 py-1.5 rounded-lg text-xs bg-accent text-white hover:bg-accent/90 transition-colors"
              >
                {t('projectForm.wizardNext')}
              </button>
            </div>
          </>
        )}

        {/* ========== Step 2: 扩展能力（MCP / Skills） ========== */}
        {step === 2 && (
          <>
            <div className="px-5 py-4 overflow-y-auto flex-1 min-h-0">
              <ExtensionsPanel
                mcpTools={mcpTools}
                skillTools={skillTools}
                enabledTools={enabledTools}
                onToggle={toggleExtTool}
                onOpenSettings={handleOpenSettings}
              />
            </div>

            <div className="flex items-center justify-between px-5 py-3 border-t border-border-secondary">
              <button
                onClick={() => setStep(1)}
                className="px-3 py-1.5 rounded-lg text-xs text-text-secondary hover:bg-bg-hover transition-colors"
              >
                {t('projectForm.wizardPrev')}
              </button>
              <button
                onClick={() => setStep(3)}
                className="px-4 py-1.5 rounded-lg text-xs bg-accent text-white hover:bg-accent/90 transition-colors"
              >
                {t('projectForm.wizardNext')}
              </button>
            </div>
          </>
        )}

        {/* ========== Step 3: 项目配置 ========== */}
        {step === 3 && (
          <>
            <div className="px-5 py-4 space-y-3 overflow-y-auto flex-1 min-h-0">
              <ProjectBasicInfo name={name} onNameChange={setName} />

              <ProjectFileSystem
                path={path}
                onSelectFolder={handleSelectFolder}
                referenceDirs={referenceDirs}
                onReferenceDirsChange={setReferenceDirs}
              />

              <ProjectPromptSectionsGroup sections={promptSections} onChange={setPromptSections} />
            </div>

            <div className="flex items-center justify-between px-5 py-3 border-t border-border-secondary">
              <button
                onClick={() => setStep(2)}
                className="px-3 py-1.5 rounded-lg text-xs text-text-secondary hover:bg-bg-hover transition-colors"
              >
                {t('projectForm.wizardPrev')}
              </button>
              <button
                onClick={() => setStep(4)}
                className="px-4 py-1.5 rounded-lg text-xs bg-accent text-white hover:bg-accent/90 transition-colors"
              >
                {t('projectForm.wizardNext')}
              </button>
            </div>
          </>
        )}

        {/* ========== Step 4: 高级配置 ========== */}
        {step === 4 && (
          <>
            <div className="px-5 py-4 space-y-3 overflow-y-auto flex-1 min-h-0">
              <div className="zen-card">
                <div className="zen-card-header">
                  <Database size={12} />
                  {t('tool.localDbLabel')}
                </div>
                <label className="flex items-center gap-2.5 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={pglitePersist}
                    onChange={(e) => setPglitePersist(e.target.checked)}
                    className="rounded border-border-primary accent-accent w-3.5 h-3.5 flex-shrink-0"
                  />
                  <div>
                    <span className="text-[11px] text-text-primary">
                      {t('projectForm.pglitePersistLabel')}
                    </span>
                    <p className="text-[10px] text-text-tertiary mt-0.5 leading-relaxed">
                      {t('projectForm.pglitePersistDesc')}
                    </p>
                  </div>
                </label>
              </div>

              {/* 环境变量 */}
              <div className="zen-card">
                <div className="zen-card-header">
                  <Terminal size={12} />
                  {t('tool.bashLabel')}
                </div>
                <div className="space-y-1.5">
                  {envVars.map((v, i) => (
                    <div key={i} className="flex items-center gap-1.5">
                      <input
                        value={v.key}
                        onChange={(e) => {
                          const next = [...envVars]
                          next[i] = { ...v, key: e.target.value }
                          setEnvVars(next)
                        }}
                        placeholder={t('projectForm.envVarKey')}
                        className="flex-[2] min-w-0 px-2 py-1 rounded-md text-[11px] bg-bg-primary/50 border border-border-secondary text-text-primary placeholder:text-text-tertiary/50 outline-none focus:border-accent/50"
                      />
                      {v.sensitive ? (
                        <div className="flex-[3] min-w-0 flex items-center gap-0">
                          <input
                            value={v.value}
                            type={envVisibility[i] ? 'text' : 'password'}
                            onChange={(e) => {
                              const next = [...envVars]
                              next[i] = { ...v, value: e.target.value }
                              setEnvVars(next)
                            }}
                            placeholder={t('projectForm.envVarValue')}
                            className="flex-1 min-w-0 px-2 py-1 rounded-l-md text-[11px] bg-bg-primary/50 border border-r-0 border-border-secondary text-text-primary placeholder:text-text-tertiary/50 outline-none focus:border-accent/50"
                          />
                          <button
                            type="button"
                            onClick={() => setEnvVisibility((prev) => ({ ...prev, [i]: !prev[i] }))}
                            className="px-1.5 self-stretch flex items-center border border-l-0 border-border-secondary rounded-r-md text-text-tertiary hover:text-text-secondary bg-bg-primary/50"
                            title={envVisibility[i] ? 'Hide' : 'Show'}
                          >
                            {envVisibility[i] ? <Eye size={11} /> : <EyeOff size={11} />}
                          </button>
                        </div>
                      ) : (
                        <input
                          value={v.value}
                          onChange={(e) => {
                            const next = [...envVars]
                            next[i] = { ...v, value: e.target.value }
                            setEnvVars(next)
                          }}
                          placeholder={t('projectForm.envVarValue')}
                          className="flex-[3] min-w-0 px-2 py-1 rounded-md text-[11px] bg-bg-primary/50 border border-border-secondary text-text-primary placeholder:text-text-tertiary/50 outline-none focus:border-accent/50"
                        />
                      )}
                      <label className="flex items-center gap-1 cursor-pointer select-none shrink-0">
                        <input
                          type="checkbox"
                          checked={v.sensitive}
                          onChange={(e) => {
                            const next = [...envVars]
                            next[i] = { ...v, sensitive: e.target.checked }
                            setEnvVars(next)
                          }}
                          className="rounded border-border-primary accent-accent w-3 h-3"
                        />
                        <span className="text-[10px] text-text-tertiary">
                          {t('projectForm.envVarSensitive')}
                        </span>
                      </label>
                      <button
                        onClick={() => setEnvVars(envVars.filter((_, j) => j !== i))}
                        className="p-0.5 rounded hover:bg-bg-hover text-text-tertiary hover:text-error shrink-0"
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>
                  ))}
                  <button
                    onClick={() =>
                      setEnvVars([...envVars, { key: '', value: '', sensitive: false }])
                    }
                    className="flex items-center gap-1 text-[11px] text-accent hover:text-accent/80 transition-colors"
                  >
                    <Plus size={11} />
                    {t('projectForm.envVarAdd')}
                  </button>
                </div>
                <p className="text-[10px] text-text-tertiary mt-1.5 leading-relaxed">
                  {t('projectForm.envVarsDesc')}
                </p>
              </div>
            </div>

            <div className="flex items-center justify-between px-5 py-3 border-t border-border-secondary">
              <button
                onClick={() => setStep(3)}
                className="px-3 py-1.5 rounded-lg text-xs text-text-secondary hover:bg-bg-hover transition-colors"
              >
                {t('projectForm.wizardPrev')}
              </button>
              <button
                onClick={handleCreate}
                disabled={saving || !path.trim()}
                className="px-4 py-1.5 rounded-lg text-xs bg-accent text-white hover:bg-accent/90 transition-colors disabled:opacity-50"
              >
                {saving ? t('common.creating') : t('common.create')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
