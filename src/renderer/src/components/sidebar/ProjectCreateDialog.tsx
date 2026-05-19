import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { X, Database, Terminal, ChevronRight, Plus, Trash2, Eye, EyeOff } from 'lucide-react'
import { type ToolItem } from '../common/ToolSelectList'
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
}

/** Skills 分组标识 */
const SKILLS_GROUP = '__skills__'

/**
 * 新建项目弹窗 — 3 步向导
 * Step 0: 扩展能力（MCP / Skills 勾选）
 * Step 1: 项目配置（名称 + 提示词 + 路径 + 参考目录）
 * Step 2: 高级配置（pglite / 环境变量）
 */
export function ProjectCreateDialog({
  onClose,
  onCreated
}: ProjectCreateDialogProps): React.JSX.Element {
  const { t } = useTranslation()
  const { closing, handleClose } = useDialogClose(onClose)

  const [step, setStep] = useState(0)
  const panelRef = usePanelTransition()

  const [name, setName] = useState('')
  const [path, setPath] = useState('')
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

  // 加载工具列表，默认勾选所有已连接的 MCP 和已启用的 Skills
  useEffect(() => {
    window.api.tools.list().then((tools) => {
      setAllTools(tools)
      const connectedMcp = tools
        .filter((t) => t.group?.startsWith('mcp:') && t.serverStatus === 'connected')
        .map((t) => t.name)
      const enabledSkills = tools.filter((t) => t.group === SKILLS_GROUP).map((t) => t.name)
      setEnabledTools([...new Set([...connectedMcp, ...enabledSkills])])
    })
  }, [])

  const mcpTools = allTools.filter((t) => t.group?.startsWith('mcp:'))
  const skillTools = allTools.filter((t) => t.group === SKILLS_GROUP)

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

  const handleOpenSettings = (): void => {
    window.api.app.openSettings()
  }

  const toggleExtTool = (toolName: string): void => {
    setEnabledTools((prev) =>
      prev.includes(toolName) ? prev.filter((n) => n !== toolName) : [...prev, toolName]
    )
  }

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

  const steps = [
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

        {/* ========== Step 0: 扩展能力（MCP / Skills） ========== */}
        {step === 0 && (
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
                onClick={handleClose}
                className="px-3 py-1.5 rounded-lg text-xs text-text-secondary hover:bg-bg-hover transition-colors"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={() => setStep(1)}
                className="px-4 py-1.5 rounded-lg text-xs bg-accent text-white hover:bg-accent/90 transition-colors"
              >
                {t('projectForm.wizardNext')}
              </button>
            </div>
          </>
        )}

        {/* ========== Step 1: 项目配置 ========== */}
        {step === 1 && (
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

        {/* ========== Step 2: 高级配置 ========== */}
        {step === 2 && (
          <>
            <div className="px-5 py-4 space-y-3 overflow-y-auto flex-1 min-h-0">
              <div className="zen-card">
                <div className="zen-card-header">
                  <Database size={12} />
                  {t('projectForm.pglitePersistSection')}
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
                onClick={() => setStep(1)}
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
