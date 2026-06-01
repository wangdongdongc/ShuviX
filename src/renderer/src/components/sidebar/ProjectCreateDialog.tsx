import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { X, ChevronRight } from 'lucide-react'
import { type ToolItem } from '../common/ToolSelectList'
import { useDialogClose } from '../../hooks/useDialogClose'
import { usePanelTransition } from '../../hooks/usePanelTransition'
import {
  ProjectBasicInfo,
  ProjectFileSystem,
  ExtensionsPanel,
  ProjectPromptSectionsGroup,
  ProjectPgLiteSection,
  ProjectEnvVarsSection,
  type EnvVar
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
  const [envVars, setEnvVars] = useState<EnvVar[]>([])

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
    t('projectForm.wizardStepProject'),
    t('projectForm.wizardStepExtensions'),
    t('projectForm.wizardStepAdvanced')
  ]

  return (
    <div
      onClick={handleClose}
      className={`fixed inset-0 z-50 flex items-center justify-center bg-black/40 titlebar-no-drag dialog-overlay${closing ? ' dialog-closing' : ''}`}
    >
      <div
        ref={panelRef}
        onClick={(e) => e.stopPropagation()}
        className="bg-bg-primary border border-border-primary rounded-xl shadow-xl w-[560px] max-w-[92vw] max-h-[88vh] flex flex-col dialog-panel"
      >
        {/* 头部：标题 + 步骤指示器 + X */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-border-secondary shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <h3 className="text-sm font-semibold text-text-primary shrink-0">
              {t('projectForm.createTitle')}
            </h3>
            <div className="flex items-center gap-1 min-w-0">
              {steps.map((label, i) => (
                <div key={i} className="flex items-center gap-1">
                  {i > 0 && <ChevronRight size={10} className="text-text-tertiary/40" />}
                  <span
                    className={`text-[11px] transition-colors ${
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
            className="p-1 rounded-lg hover:bg-bg-hover text-text-tertiary hover:text-text-primary transition-colors shrink-0"
          >
            <X size={14} />
          </button>
        </div>

        {/* Step 0：项目信息 */}
        {step === 0 && (
          <>
            <div className="px-5 py-5 space-y-5 overflow-y-auto flex-1 min-h-0">
              <ProjectBasicInfo name={name} onNameChange={setName} />
              <ProjectFileSystem
                path={path}
                onSelectFolder={handleSelectFolder}
                referenceDirs={referenceDirs}
                onReferenceDirsChange={setReferenceDirs}
              />
              <ProjectPromptSectionsGroup sections={promptSections} onChange={setPromptSections} />
            </div>
            <div className="flex items-center justify-between px-5 py-3 border-t border-border-secondary shrink-0">
              <button
                onClick={handleClose}
                className="px-4 py-1.5 rounded-lg text-xs text-text-secondary hover:bg-bg-hover transition-colors"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={() => setStep(1)}
                className="px-4 py-1.5 rounded-lg text-xs font-medium bg-accent text-white hover:bg-accent-hover transition-colors"
              >
                {t('projectForm.wizardNext')}
              </button>
            </div>
          </>
        )}

        {/* Step 1：扩展能力 */}
        {step === 1 && (
          <>
            <div className="px-5 py-5 overflow-y-auto flex-1 min-h-0">
              <ExtensionsPanel
                mcpTools={mcpTools}
                skillTools={skillTools}
                enabledTools={enabledTools}
                onToggle={toggleExtTool}
                onOpenSettings={handleOpenSettings}
              />
            </div>
            <div className="flex items-center justify-between px-5 py-3 border-t border-border-secondary shrink-0">
              <button
                onClick={() => setStep(0)}
                className="px-4 py-1.5 rounded-lg text-xs text-text-secondary hover:bg-bg-hover transition-colors"
              >
                {t('projectForm.wizardPrev')}
              </button>
              <button
                onClick={() => setStep(2)}
                className="px-4 py-1.5 rounded-lg text-xs font-medium bg-accent text-white hover:bg-accent-hover transition-colors"
              >
                {t('projectForm.wizardNext')}
              </button>
            </div>
          </>
        )}

        {/* Step 2：高级配置 */}
        {step === 2 && (
          <>
            <div className="px-5 py-5 space-y-5 overflow-y-auto flex-1 min-h-0">
              <ProjectPgLiteSection pglitePersist={pglitePersist} onChange={setPglitePersist} />
              <ProjectEnvVarsSection envVars={envVars} onChange={setEnvVars} />
            </div>
            <div className="flex items-center justify-between px-5 py-3 border-t border-border-secondary shrink-0">
              <button
                onClick={() => setStep(1)}
                className="px-4 py-1.5 rounded-lg text-xs text-text-secondary hover:bg-bg-hover transition-colors"
              >
                {t('projectForm.wizardPrev')}
              </button>
              <button
                onClick={handleCreate}
                disabled={saving || !path.trim()}
                className="px-4 py-1.5 rounded-lg text-xs font-medium bg-accent text-white hover:bg-accent-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
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
