import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { X, Wrench, Database, Puzzle, BookOpen, Settings } from 'lucide-react'
import { ToolSelectList, type ToolItem } from '../common/ToolSelectList'
import { useDialogClose } from '../../hooks/useDialogClose'
import { usePanelTransition } from '../../hooks/usePanelTransition'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { ProjectBasicInfo, ProjectFileSystem } from './ProjectFormSections'

import type { ReferenceDir } from '../../../../main/types/project'

interface ProjectEditDialogProps {
  projectId: string
  onClose: () => void
}

type EditTab = 'tools' | 'extensions' | 'project'

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
        } else {
          setEnabledTools(tools.filter((t) => t.defaultEnabled).map((t) => t.name))
        }
        setLoading(false)
      }
    )
  }, [projectId])

  // MCP / Skills 工具
  const mcpTools = allTools.filter((t) => t.group && !t.group.startsWith('__'))
  const skillTools = allTools.filter((t) => t.group === SKILLS_GROUP)
  const hasMcpOrSkills = mcpTools.length > 0 || skillTools.length > 0

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
        tool: { pglitePersist }
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
    { key: 'project', label: t('projectForm.wizardStepProject') }
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
          <div className="px-5 py-4 overflow-y-auto flex-1 min-h-0 space-y-3">
            {!hasMcpOrSkills ? (
              /* 未配置任何 MCP/Skill → 引导卡片 */
              <div className="space-y-3">
                <p className="text-[11px] text-text-tertiary leading-relaxed">
                  {t('projectForm.extEmptyDesc')}
                </p>

                {/* MCP 引导 */}
                <div className="zen-card">
                  <div className="zen-card-header">
                    <Puzzle size={12} className="text-purple-400" />
                    MCP Server
                  </div>
                  <p className="text-[10px] text-text-tertiary leading-relaxed mb-3">
                    {t('projectForm.extMcpDesc')}
                  </p>
                  <button
                    onClick={handleOpenSettings}
                    className="flex items-center gap-1.5 text-[11px] text-accent hover:text-accent/80 transition-colors"
                  >
                    <Settings size={12} />
                    {t('projectForm.extGoSettings')}
                  </button>
                </div>

                {/* Skills 引导 */}
                <div className="zen-card">
                  <div className="zen-card-header">
                    <BookOpen size={12} className="text-emerald-400" />
                    Skills
                  </div>
                  <p className="text-[10px] text-text-tertiary leading-relaxed mb-3">
                    {t('projectForm.extSkillDesc')}
                  </p>
                  <button
                    onClick={handleOpenSettings}
                    className="flex items-center gap-1.5 text-[11px] text-accent hover:text-accent/80 transition-colors"
                  >
                    <Settings size={12} />
                    {t('projectForm.extGoSettings')}
                  </button>
                </div>
              </div>
            ) : (
              /* 已有 MCP/Skill → 选择列表 */
              <div className="space-y-3">
                <p className="text-[11px] text-text-tertiary leading-relaxed">
                  {t('projectForm.extAvailableDesc')}
                </p>

                {/* MCP 服务器 */}
                {mcpTools.map((tool) => {
                  const isOnline = tool.serverStatus === 'connected'
                  const serverName = tool.name.startsWith('mcp:') ? tool.name.slice(4) : tool.name
                  return (
                    <div key={tool.name} className="zen-card">
                      <div className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={enabledTools.includes(tool.name)}
                          onChange={() => toggleExtTool(tool.name)}
                          className="rounded border-border-primary accent-accent w-3.5 h-3.5 flex-shrink-0"
                        />
                        <Puzzle
                          size={12}
                          className={isOnline ? 'text-purple-400' : 'text-red-400'}
                        />
                        <span
                          className={`text-[11px] font-medium ${isOnline ? 'text-text-secondary' : 'text-red-400'}`}
                        >
                          {serverName}
                        </span>
                        <span
                          className={`text-[10px] rounded px-1 py-px ${
                            isOnline
                              ? 'bg-purple-500/10 text-purple-400 border border-purple-500/20'
                              : 'bg-red-500/10 text-red-400 border border-red-500/20'
                          }`}
                        >
                          MCP
                        </span>
                      </div>
                    </div>
                  )
                })}

                {/* Skills */}
                {skillTools.map((tool) => {
                  const shortName = tool.name.startsWith('skill:') ? tool.name.slice(6) : tool.name
                  return (
                    <div key={tool.name} className="zen-card">
                      <div className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={enabledTools.includes(tool.name)}
                          onChange={() => toggleExtTool(tool.name)}
                          className="rounded border-border-primary accent-accent w-3.5 h-3.5 flex-shrink-0"
                        />
                        <BookOpen size={12} className="text-emerald-400" />
                        <span className="text-[11px] font-medium text-text-secondary">
                          {shortName}
                        </span>
                        <span className="text-[10px] rounded px-1 py-px bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                          Skill
                        </span>
                      </div>
                    </div>
                  )
                })}

                {/* 补充引导：前往设置添加更多 */}
                <button
                  onClick={handleOpenSettings}
                  className="flex items-center gap-1.5 text-[11px] text-text-tertiary hover:text-accent transition-colors"
                >
                  <Settings size={12} />
                  {t('projectForm.extGoSettings')}
                </button>
              </div>
            )}
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

            {/* 工具配置 */}
            <div className="zen-card">
              <div className="zen-card-header">
                <Database size={12} />
                {t('projectForm.toolConfig')}
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
