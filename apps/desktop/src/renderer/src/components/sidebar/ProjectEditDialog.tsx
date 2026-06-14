import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { type ToolItem } from '../common/ToolSelectList'
import { useDialogClose } from '@shuvix/chat-ui'
import { usePanelTransition } from '../../hooks/usePanelTransition'
import { ConfirmDialog } from '../common/ConfirmDialog'
import {
  ProjectBasicInfo,
  ProjectFileSystem,
  ExtensionsPanel,
  ProjectPromptSectionsGroup,
  ProjectPgLiteSection,
  ProjectEnvVarsSection,
  type EnvVar
} from './ProjectFormSections'

import type { ReferenceDir } from '../../../../main/types/project'
import type { ProjectPromptSection } from '@shuvix/chat-protocol/types/promptSection'

interface ProjectEditDialogProps {
  projectId: string
  onClose: () => void
}

type EditTab = 'extensions' | 'project' | 'advanced'

/** Skills 分组标识 */
const SKILLS_GROUP = '__skills__'

/** 项目编辑弹窗 — 多 Tab 分组（扩展能力 / 项目配置 / 高级） */
export function ProjectEditDialog({
  projectId,
  onClose
}: ProjectEditDialogProps): React.JSX.Element | null {
  const { t } = useTranslation()
  const { closing, handleClose } = useDialogClose(onClose)

  const [tab, setTab] = useState<EditTab>('project')
  const panelRef = usePanelTransition()

  // 项目字段
  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const [promptSections, setPromptSections] = useState<ProjectPromptSection[]>([])
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)
  const [allTools, setAllTools] = useState<ToolItem[]>([])
  const [enabledTools, setEnabledTools] = useState<string[]>([])
  const [referenceDirs, setReferenceDirs] = useState<ReferenceDir[]>([])
  const [showArchiveConfirm, setShowArchiveConfirm] = useState(false)
  const [pglitePersist, setPglitePersist] = useState(false)
  const [envVars, setEnvVars] = useState<EnvVar[]>([])

  // 加载项目数据 + 工具列表
  useEffect(() => {
    Promise.all([window.api.project.getById(projectId), window.api.tools.list()]).then(
      ([project, tools]) => {
        setAllTools(tools)
        const defaultExtensions = (): string[] => {
          const connectedMcp = tools
            .filter((t) => t.group?.startsWith('mcp:') && t.serverStatus === 'connected')
            .map((t) => t.name)
          const enabledSkills = tools.filter((t) => t.group === SKILLS_GROUP).map((t) => t.name)
          return [...new Set([...connectedMcp, ...enabledSkills])]
        }
        if (project) {
          setName(project.name)
          setPath(project.path)
          setPromptSections(project.promptSections ?? [])
          const settings = project.settings || {}
          if (Array.isArray(settings.enabledTools)) {
            setEnabledTools(settings.enabledTools)
          } else {
            setEnabledTools(defaultExtensions())
          }
          if (Array.isArray(settings.referenceDirs)) {
            setReferenceDirs(settings.referenceDirs)
          }
          if (settings.tool?.pglitePersist) {
            setPglitePersist(true)
          }
          if (Array.isArray(settings.tool?.envVars)) {
            setEnvVars(settings.tool.envVars)
          }
        } else {
          setEnabledTools(defaultExtensions())
        }
        setLoading(false)
      }
    )
  }, [projectId])

  // MCP / Skills 工具
  const mcpTools = allTools.filter((t) => t.group?.startsWith('mcp:'))
  const skillTools = allTools.filter((t) => t.group === SKILLS_GROUP)

  // 按 Escape 关闭
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') handleClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [handleClose])

  const handleSelectFolder = async (): Promise<void> => {
    const result = await window.electron.ipcRenderer.invoke('dialog:openDirectory')
    if (result) {
      setPath(result)
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

  const handleArchive = async (): Promise<void> => {
    setSaving(true)
    try {
      await window.api.project.update({ id: projectId, archived: true })
      onClose()
    } finally {
      setSaving(false)
      setShowArchiveConfirm(false)
    }
  }

  const handleSave = async (): Promise<void> => {
    setSaving(true)
    try {
      await window.api.project.update({
        id: projectId,
        name: name.trim() || undefined,
        path: path || undefined,
        promptSections,
        enabledTools,
        referenceDirs,
        tool: {
          pglitePersist,
          envVars: envVars.filter((v) => v.key.trim()).length
            ? envVars.filter((v) => v.key.trim())
            : undefined
        }
      })
      onClose()
    } finally {
      setSaving(false)
    }
  }

  const tabs: Array<{ key: EditTab; label: string }> = [
    { key: 'project', label: t('projectForm.wizardStepProject') },
    { key: 'extensions', label: t('projectForm.wizardStepExtensions') },
    { key: 'advanced', label: t('projectForm.wizardStepAdvanced') }
  ]

  if (loading) return null

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
        {/* 头部：标题 + Tab + X */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-border-secondary shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <h3 className="text-sm font-semibold text-text-primary shrink-0">
              {t('projectForm.editTitle')}
            </h3>
            <div className="flex items-center gap-1 min-w-0">
              {tabs.map(({ key, label }) => (
                <button
                  key={key}
                  onClick={() => setTab(key)}
                  className={`px-2 py-0.5 rounded text-[11px] transition-colors ${
                    tab === key
                      ? 'bg-accent/10 text-accent font-medium'
                      : 'text-text-tertiary hover:text-text-secondary hover:bg-bg-hover'
                  }`}
                >
                  {label}
                </button>
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

        {/* Tab：扩展能力 */}
        {tab === 'extensions' && (
          <div className="px-5 py-5 overflow-y-auto flex-1 min-h-0">
            <ExtensionsPanel
              mcpTools={mcpTools}
              skillTools={skillTools}
              enabledTools={enabledTools}
              onToggle={toggleExtTool}
              onOpenSettings={handleOpenSettings}
            />
          </div>
        )}

        {/* Tab：项目配置 */}
        {tab === 'project' && (
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
        )}

        {/* Tab：高级配置 */}
        {tab === 'advanced' && (
          <div className="px-5 py-5 space-y-5 overflow-y-auto flex-1 min-h-0">
            <ProjectPgLiteSection pglitePersist={pglitePersist} onChange={setPglitePersist} />
            <ProjectEnvVarsSection envVars={envVars} onChange={setEnvVars} />
          </div>
        )}

        {/* 底部按钮 */}
        <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-border-secondary shrink-0">
          <button
            onClick={() => setShowArchiveConfirm(true)}
            disabled={saving}
            className="px-3 py-1.5 rounded-lg text-xs text-error hover:bg-error/10 transition-colors disabled:opacity-50"
          >
            {t('projectForm.archiveProject')}
          </button>
          <div className="flex items-center gap-2">
            <button
              onClick={handleClose}
              className="px-4 py-1.5 rounded-lg text-xs text-text-secondary hover:bg-bg-hover transition-colors"
            >
              {t('common.cancel')}
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-1.5 rounded-lg text-xs font-medium bg-accent text-white hover:bg-accent-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? t('common.saving') : t('common.save')}
            </button>
          </div>
        </div>
      </div>

      {showArchiveConfirm && (
        <ConfirmDialog
          title={t('projectForm.archiveConfirmTitle')}
          description={t('projectForm.archiveConfirmDesc')}
          confirmText={t('projectForm.archiveConfirmAction')}
          cancelText={t('common.cancel')}
          onConfirm={() => void handleArchive()}
          onCancel={() => setShowArchiveConfirm(false)}
        />
      )}
    </div>
  )
}
