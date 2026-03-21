import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import {
  X,
  Wrench,
  Database,
  Terminal,
  Palette,
  ChevronRight,
  ChevronDown,
  Puzzle,
  BookOpen,
  Settings,
  Info
} from 'lucide-react'
import { ToolSelectList, type ToolItem } from '../common/ToolSelectList'
import { useDialogClose } from '../../hooks/useDialogClose'
import { usePanelTransition } from '../../hooks/usePanelTransition'
import { ProjectBasicInfo, ProjectFileSystem } from './ProjectFormSections'

import type { ReferenceDir } from '../../../../main/types/project'

interface ProjectCreateDialogProps {
  onClose: () => void
  /** 创建成功后回调，传入新项目 ID */
  onCreated?: (projectId: string) => void | Promise<void>
}

/** 用途预设：工具名称列表 */
const PURPOSE_PRESETS: Record<string, string[]> = {
  bash: ['bash', 'read', 'ask'],
  sql: ['read', 'sql', 'ask'],
  dev: ['bash', 'read', 'write', 'edit', 'ask', 'ls', 'grep', 'glob', 'explore'],
  ui: ['bash', 'read', 'write', 'edit', 'ask', 'design']
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
  onCreated
}: ProjectCreateDialogProps): React.JSX.Element {
  const { t } = useTranslation()
  const { closing, handleClose } = useDialogClose(onClose)

  // 向导步骤
  const [step, setStep] = useState(0)
  const panelRef = usePanelTransition()
  const [purpose, setPurpose] = useState<string | null>(null)

  // 项目字段
  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [saving, setSaving] = useState(false)
  const [allTools, setAllTools] = useState<ToolItem[]>([])
  const [enabledTools, setEnabledTools] = useState<string[]>([])
  const [referenceDirs, setReferenceDirs] = useState<ReferenceDir[]>([])
  const [expandedExtGroups, setExpandedExtGroups] = useState<Set<string>>(new Set())
  const [pglitePersist, setPglitePersist] = useState(false)

  // 加载工具列表
  useEffect(() => {
    window.api.tools.list().then((tools) => {
      setAllTools(tools)
      // 默认展开所有扩展分组
      const groups = new Set(
        tools.filter((t) => t.group && !t.group.startsWith('__')).map((t) => t.group!)
      )
      if (tools.some((t) => t.group === SKILLS_GROUP)) groups.add(SKILLS_GROUP)
      setExpandedExtGroups(groups)
    })
  }, [])

  // MCP / Skills 工具
  const mcpTools = allTools.filter((t) => t.group && !t.group.startsWith('__'))
  const skillTools = allTools.filter((t) => t.group === SKILLS_GROUP)
  const hasMcpOrSkills = mcpTools.length > 0 || skillTools.length > 0

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
    const preset = PURPOSE_PRESETS[key] || PURPOSE_PRESETS.bash
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

  /** 切换扩展分组展开/收起 */
  const toggleExtExpand = (group: string): void => {
    setExpandedExtGroups((prev) => {
      const next = new Set(prev)
      if (next.has(group)) next.delete(group)
      else next.add(group)
      return next
    })
  }

  /** 切换整个扩展分组 */
  const toggleExtGroup = (groupToolNames: string[]): void => {
    const allChecked = groupToolNames.every((n) => enabledTools.includes(n))
    if (allChecked) {
      setEnabledTools((prev) => prev.filter((n) => !groupToolNames.includes(n)))
    } else {
      setEnabledTools((prev) => [...new Set([...prev, ...groupToolNames])])
    }
  }

  /** 创建项目 */
  const handleCreate = async (): Promise<void> => {
    if (!path.trim()) return
    setSaving(true)
    try {
      const project = await window.api.project.create({
        name: name.trim() || undefined,
        path: path.trim(),
        systemPrompt,
        enabledTools,
        referenceDirs: referenceDirs.length > 0 ? referenceDirs : undefined,
        tool: pglitePersist ? { pglitePersist: true } : undefined
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
    t('projectForm.wizardStepProject')
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
                onClick={() => handlePurposeSelect('sql')}
                className={`group flex flex-col items-center gap-3 p-5 rounded-xl border transition-all hover:border-accent/50 hover:bg-accent/5 ${
                  purpose === 'sql' ? 'border-accent bg-accent/5' : 'border-border-secondary'
                }`}
              >
                <div className="w-10 h-10 rounded-lg bg-bg-tertiary flex items-center justify-center group-hover:bg-accent/10 transition-colors">
                  <Database
                    size={20}
                    className="text-text-secondary group-hover:text-accent transition-colors"
                  />
                </div>
                <div className="text-xs font-medium text-text-primary">
                  {t('projectForm.purposeSQL')}
                </div>
              </button>

              <button
                onClick={() => handlePurposeSelect('ui')}
                className={`group flex flex-col items-center gap-3 p-5 rounded-xl border transition-all hover:border-accent/50 hover:bg-accent/5 ${
                  purpose === 'ui' ? 'border-accent bg-accent/5' : 'border-border-secondary'
                }`}
              >
                <div className="w-10 h-10 rounded-lg bg-bg-tertiary flex items-center justify-center group-hover:bg-accent/10 transition-colors">
                  <Palette
                    size={20}
                    className="text-text-secondary group-hover:text-accent transition-colors"
                  />
                </div>
                <div className="text-xs font-medium text-text-primary">
                  {t('projectForm.purposeUI')}
                </div>
              </button>

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
              {purpose && (
                <div className="flex gap-2 p-3 rounded-lg bg-accent/5 border border-accent/20">
                  <Info size={14} className="text-accent shrink-0 mt-0.5" />
                  <p className="text-[11px] text-text-secondary leading-relaxed">
                    {t(
                      `projectForm.purposeTip${purpose.charAt(0).toUpperCase() + purpose.slice(1)}`
                    )}
                  </p>
                </div>
              )}
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

                  {/* MCP 工具 */}
                  {(() => {
                    const mcpGroups = [...new Set(mcpTools.map((t) => t.group!))]
                    if (mcpGroups.length === 0) return null
                    return mcpGroups.map((group) => {
                      const groupTools = mcpTools.filter((t) => t.group === group)
                      const names = groupTools.map((t) => t.name)
                      const allChecked = names.every((n) => enabledTools.includes(n))
                      const someChecked = names.some((n) => enabledTools.includes(n))
                      const isOnline = groupTools.some((t) => t.serverStatus === 'connected')

                      const isExpanded = expandedExtGroups.has(group)

                      return (
                        <div key={group} className="zen-card">
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => toggleExtExpand(group)}
                              className="text-text-tertiary hover:text-text-secondary flex-shrink-0"
                            >
                              {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                            </button>
                            <input
                              type="checkbox"
                              checked={allChecked}
                              ref={(el) => {
                                if (el) el.indeterminate = someChecked && !allChecked
                              }}
                              onChange={() => toggleExtGroup(names)}
                              className="rounded border-border-primary accent-accent w-3.5 h-3.5 flex-shrink-0"
                            />
                            <Puzzle
                              size={12}
                              className={isOnline ? 'text-purple-400' : 'text-red-400'}
                            />
                            <span
                              className={`text-[11px] font-medium ${isOnline ? 'text-text-secondary' : 'text-red-400'}`}
                            >
                              {group}
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
                            <span className="text-[10px] text-text-tertiary ml-auto">
                              {names.length}
                            </span>
                          </div>
                          {isExpanded && (
                            <div className="space-y-0.5 mt-2 pl-7">
                              {groupTools.map((tool) => {
                                const shortName =
                                  tool.name.split('__').length >= 3
                                    ? tool.name.split('__').slice(2).join('__')
                                    : tool.name
                                return (
                                  <label
                                    key={tool.name}
                                    className={`flex items-center gap-1.5 cursor-pointer select-none rounded-md px-2 py-1 -mx-1 hover:bg-bg-hover/40 transition-colors ${!isOnline ? 'opacity-50' : ''}`}
                                  >
                                    <input
                                      type="checkbox"
                                      checked={enabledTools.includes(tool.name)}
                                      onChange={() => toggleExtTool(tool.name)}
                                      className="rounded border-border-primary accent-accent w-3.5 h-3.5 flex-shrink-0"
                                    />
                                    <span
                                      className={`text-[11px] font-mono flex-shrink-0 ${isOnline ? 'text-purple-300' : 'text-red-300/60'}`}
                                    >
                                      {shortName}
                                    </span>
                                    <span className="text-[10px] text-text-tertiary truncate">
                                      {tool.label}
                                    </span>
                                  </label>
                                )
                              })}
                            </div>
                          )}
                        </div>
                      )
                    })
                  })()}

                  {/* Skills */}
                  {skillTools.length > 0 &&
                    (() => {
                      const skillNames = skillTools.map((t) => t.name)
                      const allSkillChecked = skillNames.every((n) => enabledTools.includes(n))
                      const someSkillChecked = skillNames.some((n) => enabledTools.includes(n))
                      const isSkillExpanded = expandedExtGroups.has(SKILLS_GROUP)

                      return (
                        <div className="zen-card">
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => toggleExtExpand(SKILLS_GROUP)}
                              className="text-text-tertiary hover:text-text-secondary flex-shrink-0"
                            >
                              {isSkillExpanded ? (
                                <ChevronDown size={12} />
                              ) : (
                                <ChevronRight size={12} />
                              )}
                            </button>
                            <input
                              type="checkbox"
                              checked={allSkillChecked}
                              ref={(el) => {
                                if (el) el.indeterminate = someSkillChecked && !allSkillChecked
                              }}
                              onChange={() => toggleExtGroup(skillNames)}
                              className="rounded border-border-primary accent-accent w-3.5 h-3.5 flex-shrink-0"
                            />
                            <BookOpen size={12} className="text-emerald-400" />
                            <span className="text-[11px] font-medium text-text-secondary">
                              Skills
                            </span>
                            <span className="text-[10px] rounded px-1 py-px bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                              Skill
                            </span>
                            <span className="text-[10px] text-text-tertiary ml-auto">
                              {skillTools.length}
                            </span>
                          </div>
                          {isSkillExpanded && (
                            <div className="space-y-0.5 mt-2 pl-7">
                              {skillTools.map((tool) => {
                                const shortName = tool.name.startsWith('skill:')
                                  ? tool.name.slice(6)
                                  : tool.name
                                return (
                                  <label
                                    key={tool.name}
                                    className="flex items-center gap-1.5 cursor-pointer select-none rounded-md px-2 py-1 -mx-1 hover:bg-bg-hover/40 transition-colors"
                                  >
                                    <input
                                      type="checkbox"
                                      checked={enabledTools.includes(tool.name)}
                                      onChange={() => toggleExtTool(tool.name)}
                                      className="rounded border-border-primary accent-accent w-3.5 h-3.5 flex-shrink-0"
                                    />
                                    <span className="text-[11px] font-mono text-emerald-300 flex-shrink-0">
                                      {shortName}
                                    </span>
                                    <span className="text-[10px] text-text-tertiary truncate">
                                      {tool.label}
                                    </span>
                                  </label>
                                )
                              })}
                            </div>
                          )}
                        </div>
                      )
                    })()}

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

            <div className="flex items-center justify-between px-5 py-3 border-t border-border-secondary">
              <button
                onClick={() => setStep(2)}
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
