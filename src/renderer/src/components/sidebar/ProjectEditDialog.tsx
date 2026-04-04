import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { X, Wrench, Database, Terminal, Plus, Trash2, Eye, EyeOff } from 'lucide-react'
import { ToolSelectList, type ToolItem } from '../common/ToolSelectList'
import { useDialogClose } from '../../hooks/useDialogClose'
import { usePanelTransition } from '../../hooks/usePanelTransition'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { ProjectBasicInfo, ProjectFileSystem, ExtensionsPanel } from './ProjectFormSections'

import type { ReferenceDir } from '../../../../main/types/project'

interface ProjectEditDialogProps {
  projectId: string
  onClose: () => void
}

type EditTab = 'tools' | 'extensions' | 'project' | 'advanced'

/** Skills 分组标识 */
const SKILLS_GROUP = '__skills__'

/**
 * 项目编辑弹窗 — 多 Tab 分组（工具选择 / 扩展能力 / 项目配置）
 */
export function ProjectEditDialog({
  projectId,
  onClose
}: ProjectEditDialogProps): React.JSX.Element | null {
  const { t } = useTranslation()
  const { closing, handleClose } = useDialogClose(onClose)

  // Tab
  const [tab, setTab] = useState<EditTab>('project')
  const panelRef = usePanelTransition()

  // 项目字段
  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)
  const [allTools, setAllTools] = useState<ToolItem[]>([])
  const [enabledTools, setEnabledTools] = useState<string[]>([])
  const [referenceDirs, setReferenceDirs] = useState<ReferenceDir[]>([])
  const [showArchiveConfirm, setShowArchiveConfirm] = useState(false)
  const [pglitePersist, setPglitePersist] = useState(false)
  const [envVars, setEnvVars] = useState<Array<{ key: string; value: string; sensitive: boolean }>>(
    []
  )
  const [envVisibility, setEnvVisibility] = useState<Record<number, boolean>>({})
  // 加载项目数据 + 工具列表
  useEffect(() => {
    Promise.all([window.api.project.getById(projectId), window.api.tools.list()]).then(
      ([project, tools]) => {
        setAllTools(tools)
        if (project) {
          setName(project.name)
          setPath(project.path)
          setSystemPrompt(project.systemPrompt)
          // 从 settings 恢复 enabledTools 和 referenceDirs
          const settings = project.settings || {}
          if (Array.isArray(settings.enabledTools)) {
            setEnabledTools(settings.enabledTools)
          } else {
            setEnabledTools(tools.filter((t) => t.defaultEnabled).map((t) => t.name))
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
          setEnabledTools(tools.filter((t) => t.defaultEnabled).map((t) => t.name))
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

  /** 选择文件夹 */
  const handleSelectFolder = async (): Promise<void> => {
    const result = await window.electron.ipcRenderer.invoke('dialog:openDirectory')
    if (result) {
      setPath(result)
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

  // Tab 定义
  const tabs: Array<{ key: EditTab; label: string }> = [
    { key: 'tools', label: t('projectForm.wizardStepTools') },
    { key: 'extensions', label: t('projectForm.wizardStepExtensions') },
    { key: 'project', label: t('projectForm.wizardStepProject') },
    { key: 'advanced', label: t('projectForm.wizardStepAdvanced') }
  ]

  if (loading) return null

  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center bg-black/40 dialog-overlay${closing ? ' dialog-closing' : ''}`}
    >
      <div
        ref={panelRef}
        className="bg-bg-primary border border-border-primary rounded-xl shadow-xl w-[520px] max-w-[90vw] max-h-[85vh] flex flex-col dialog-panel"
      >
        {/* 标题栏 + Tab 切换 */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-secondary">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-semibold text-text-primary">
              {t('projectForm.editTitle')}
            </h2>
            <div className="flex items-center gap-1">
              {tabs.map(({ key, label }) => (
                <button
                  key={key}
                  onClick={() => setTab(key)}
                  className={`px-2 py-0.5 rounded text-[11px] transition-colors ${
                    tab === key
                      ? 'bg-accent/10 text-accent font-medium'
                      : 'text-text-tertiary hover:text-text-secondary'
                  }`}
                >
                  {label}
                </button>
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

        {/* ========== Tab: 工具选择 ========== */}
        {tab === 'tools' && (
          <div className="px-5 py-4 overflow-y-auto flex-1 min-h-0 space-y-3">
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
        )}

        {/* ========== Tab: 扩展能力（MCP / Skills） ========== */}
        {tab === 'extensions' && (
          <div className="px-5 py-4 overflow-y-auto flex-1 min-h-0">
            <ExtensionsPanel
              mcpTools={mcpTools}
              skillTools={skillTools}
              enabledTools={enabledTools}
              onToggle={toggleExtTool}
              onOpenSettings={handleOpenSettings}
            />
          </div>
        )}

        {/* ========== Tab: 项目配置 ========== */}
        {tab === 'project' && (
          <div className="px-5 py-4 space-y-3 overflow-y-auto flex-1 min-h-0">
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
            />
          </div>
        )}

        {/* ========== Tab: 高级配置 ========== */}
        {tab === 'advanced' && (
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
                  onClick={() => setEnvVars([...envVars, { key: '', value: '', sensitive: false }])}
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
        )}

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
