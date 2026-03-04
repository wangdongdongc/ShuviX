import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { X, Wrench } from 'lucide-react'
import { ToolSelectList, type ToolItem } from '../common/ToolSelectList'
import { useDialogClose } from '../../hooks/useDialogClose'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { ProjectBasicInfo, ProjectFileSystem } from './ProjectFormSections'
import { DEFAULT_TOOL_NAMES } from '../../../../main/types/tools'
import type { ReferenceDir } from '../../../../main/types/project'

interface ProjectEditDialogProps {
  projectId: string
  onClose: () => void
}

/**
 * 项目编辑弹窗 — 编辑项目名称、路径、system prompt、Docker 配置
 */
export function ProjectEditDialog({
  projectId,
  onClose
}: ProjectEditDialogProps): React.JSX.Element | null {
  const { t } = useTranslation()
  const { closing, handleClose } = useDialogClose(onClose)
  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [sandboxEnabled, setSandboxEnabled] = useState(true)
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)
  const [allTools, setAllTools] = useState<ToolItem[]>([])
  const [enabledTools, setEnabledTools] = useState<string[]>([])
  const [referenceDirs, setReferenceDirs] = useState<ReferenceDir[]>([])
  const [showArchiveConfirm, setShowArchiveConfirm] = useState(false)

  // 加载项目数据 + 工具列表
  useEffect(() => {
    Promise.all([window.api.project.getById(projectId), window.api.tools.list()]).then(
      ([project, tools]) => {
        setAllTools(tools)
        if (project) {
          setName(project.name)
          setPath(project.path)
          setSystemPrompt(project.systemPrompt)
          setSandboxEnabled(project.sandboxEnabled === 1)
          // 从 settings 恢复 enabledTools 和 referenceDirs
          const settings = project.settings || {}
          if (Array.isArray(settings.enabledTools)) {
            setEnabledTools(settings.enabledTools)
          } else {
            setEnabledTools([...DEFAULT_TOOL_NAMES])
          }
          if (Array.isArray(settings.referenceDirs)) {
            setReferenceDirs(settings.referenceDirs)
          }
        } else {
          setEnabledTools([...DEFAULT_TOOL_NAMES])
        }
        setLoading(false)
      }
    )
  }, [projectId])

  // 按 Escape 关闭
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') handleClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [handleClose])

  /** 选择文件夹 */
  const handleSelectFolder = async (): Promise<void> => {
    const result = await window.electron.ipcRenderer.invoke('dialog:openDirectory')
    if (result) {
      setPath(result)
    }
  }

  /** 归档项目 */
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

  /** 保存所有变更 */
  const handleSave = async (): Promise<void> => {
    setSaving(true)
    try {
      await window.api.project.update({
        id: projectId,
        name: name.trim() || undefined,
        path: path || undefined,
        systemPrompt,
        sandboxEnabled,
        enabledTools,
        referenceDirs
      })
      onClose()
    } finally {
      setSaving(false)
    }
  }

  if (loading) return null

  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center bg-black/40 dialog-overlay${closing ? ' dialog-closing' : ''}`}
    >
      <div className="bg-bg-primary border border-border-primary rounded-xl shadow-xl w-[520px] max-w-[90vw] max-h-[85vh] flex flex-col dialog-panel">
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-secondary">
          <h2 className="text-sm font-semibold text-text-primary">{t('projectForm.editTitle')}</h2>
          <button
            onClick={handleClose}
            className="p-1 rounded-lg hover:bg-bg-hover text-text-tertiary hover:text-text-primary transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* 表单内容 */}
        <div className="px-5 py-4 space-y-4 overflow-y-auto flex-1 min-h-0">
          <ProjectBasicInfo
            name={name}
            onNameChange={setName}
            systemPrompt={systemPrompt}
            onSystemPromptChange={setSystemPrompt}
          />

          <ProjectFileSystem
            path={path}
            onSelectFolder={handleSelectFolder}
            referenceDirs={referenceDirs}
            onReferenceDirsChange={setReferenceDirs}
            sandboxEnabled={sandboxEnabled}
            onSandboxEnabledChange={setSandboxEnabled}
          />

          {/* 工具配置 */}
          <div className="border border-border-secondary rounded-lg p-3">
            <label className="flex items-center gap-1.5 text-xs font-medium text-text-secondary mb-2">
              <Wrench size={12} />
              {t('projectForm.tools')}
            </label>
            <ToolSelectList
              tools={allTools}
              enabledTools={enabledTools}
              onChange={setEnabledTools}
            />
            <p className="text-[10px] text-text-tertiary mt-2">{t('projectForm.toolsHint')}</p>
          </div>
        </div>

        {/* 底部按钮 */}
        <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-border-secondary">
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
              className="px-4 py-1.5 rounded-lg text-xs bg-accent text-white hover:bg-accent/90 transition-colors disabled:opacity-50"
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
