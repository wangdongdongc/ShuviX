import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Trash2, Pencil, Eye, Loader2 } from 'lucide-react'
import { ToolSelectList, type ToolItem } from '../common/ToolSelectList'
import { useDialogClose } from '../../hooks/useDialogClose'

// ─── 类型 ──────────────────────────────────────────

interface SubAgentInfo {
  id: string
  name: string
  displayName: string
  description: string
  systemPrompt: string
  tools: string[]
  maxTurns: number
  isBuiltin: boolean
  isEnabled: boolean
  metadata: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

// ─── 名称校验 ──────────────────────────────────────────

const NAME_REGEX = /^[a-z][a-z0-9-]*$/

// ─── 主面板 ──────────────────────────────────────────

export function SubAgentPanel(): React.JSX.Element {
  const { t } = useTranslation()

  const [agents, setAgents] = useState<SubAgentInfo[]>([])
  const [loading, setLoading] = useState(true)

  // Dialog 状态
  const [dialogAgent, setDialogAgent] = useState<SubAgentInfo | undefined>(undefined)
  const [dialogMode, setDialogMode] = useState<'create' | 'edit' | 'view' | null>(null)

  // 删除确认
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const loadData = useCallback(() => {
    window.api.customSubAgent.list().then((list) => {
      setAgents(list as SubAgentInfo[])
      setLoading(false)
    })
  }, [])

  useEffect(() => {
    loadData()
  }, [loadData])

  const builtinAgents = agents.filter((a) => a.isBuiltin)
  const customAgents = agents.filter((a) => !a.isBuiltin)

  const handleAdd = (): void => {
    setDialogAgent(undefined)
    setDialogMode('create')
  }

  const handleEdit = (agent: SubAgentInfo): void => {
    setDialogAgent(agent)
    setDialogMode('edit')
  }

  const handleView = (agent: SubAgentInfo): void => {
    setDialogAgent(agent)
    setDialogMode('view')
  }

  const handleToggle = (agent: SubAgentInfo): void => {
    window.api.customSubAgent.toggle({ id: agent.id, enabled: !agent.isEnabled }).then(loadData)
  }

  const handleDelete = (id: string): void => {
    window.api.customSubAgent.delete(id).then(() => {
      setDeletingId(null)
      loadData()
    })
  }

  const handleDialogClose = (): void => {
    setDialogMode(null)
    setDialogAgent(undefined)
  }

  const handleDialogSave = (): void => {
    handleDialogClose()
    loadData()
  }

  return (
    <div className="px-5 py-5 space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-text-primary">{t('tool.subAgentTab')}</h3>
        <p className="text-[10px] text-text-tertiary mt-1">{t('tool.subAgentDesc')}</p>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-text-tertiary py-2">
          <Loader2 size={14} className="animate-spin" />
        </div>
      ) : (
        <>
          {/* 内置子智能体列表 */}
          {builtinAgents.length > 0 && (
            <div className="space-y-2">
              <p className="text-[10px] font-medium text-text-tertiary uppercase tracking-wide">
                {t('tool.subAgentBuiltin')}
              </p>
              {builtinAgents.map((agent) => (
                <div
                  key={agent.id}
                  className="flex items-center justify-between px-3 py-2.5 rounded-lg border border-border-primary bg-bg-secondary/30"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium text-text-primary">
                        {agent.displayName}
                      </span>
                      <span className="px-1.5 py-0.5 rounded text-[9px] bg-accent/10 text-accent font-medium">
                        {t('tool.subAgentBuiltin')}
                      </span>
                    </div>
                    <p className="text-[10px] text-text-tertiary mt-0.5 truncate">
                      {agent.description.split('\n')[0]}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 ml-2">
                    <button
                      onClick={() => handleView(agent)}
                      className="p-1.5 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-bg-hover"
                      title={t('tool.subAgentViewTitle')}
                    >
                      <Eye size={13} />
                    </button>
                    <button
                      onClick={() => handleToggle(agent)}
                      className={`w-9 h-5 rounded-full relative transition-colors shrink-0 ${
                        agent.isEnabled ? 'bg-accent' : 'bg-bg-tertiary'
                      }`}
                    >
                      <span
                        className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${
                          agent.isEnabled ? 'left-[18px]' : 'left-0.5'
                        }`}
                      />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* 自定义子智能体列表 */}
          <div className="space-y-2">
            {customAgents.length > 0 && (
              <p className="text-[10px] font-medium text-text-tertiary uppercase tracking-wide">
                {t('tool.subAgentCustom')}
              </p>
            )}
            {customAgents.map((agent) => (
              <div
                key={agent.id}
                className="flex items-center justify-between px-3 py-2.5 rounded-lg border border-border-primary"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-text-primary">
                      {agent.displayName}
                    </span>
                    <code className="text-[9px] text-text-tertiary font-mono">{agent.name}</code>
                  </div>
                  <p className="text-[10px] text-text-tertiary mt-0.5 truncate">
                    {agent.description || agent.systemPrompt.slice(0, 80)}
                  </p>
                </div>
                <div className="flex items-center gap-1 ml-2">
                  <button
                    onClick={() => handleEdit(agent)}
                    className="p-1.5 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-bg-hover"
                  >
                    <Pencil size={13} />
                  </button>
                  {deletingId === agent.id ? (
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => handleDelete(agent.id)}
                        className="px-2 py-1 rounded text-[10px] font-medium bg-red-500/10 text-red-400 hover:bg-red-500/20"
                      >
                        {t('common.confirm')}
                      </button>
                      <button
                        onClick={() => setDeletingId(null)}
                        className="px-2 py-1 rounded text-[10px] font-medium text-text-tertiary hover:text-text-secondary"
                      >
                        {t('common.cancel')}
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setDeletingId(agent.id)}
                      className="p-1.5 rounded-md text-text-tertiary hover:text-red-400 hover:bg-red-500/10"
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                  <button
                    onClick={() => handleToggle(agent)}
                    className={`w-9 h-5 rounded-full relative transition-colors shrink-0 ${
                      agent.isEnabled ? 'bg-accent' : 'bg-bg-tertiary'
                    }`}
                  >
                    <span
                      className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${
                        agent.isEnabled ? 'left-[18px]' : 'left-0.5'
                      }`}
                    />
                  </button>
                </div>
              </div>
            ))}
          </div>

          {/* 新建按钮 */}
          <button
            onClick={handleAdd}
            className="w-full flex items-center justify-center gap-1.5 py-2.5 rounded-lg border border-dashed border-border-primary text-text-tertiary text-xs hover:text-accent hover:border-accent/50 transition-colors"
          >
            <Plus size={13} />
            {t('tool.subAgentAddBtn')}
          </button>
        </>
      )}

      {/* Dialog */}
      {dialogMode && (
        <SubAgentDialog
          agent={dialogAgent}
          mode={dialogMode}
          onClose={handleDialogClose}
          onSave={handleDialogSave}
        />
      )}
    </div>
  )
}

// ─── Dialog ──────────────────────────────────────────

function SubAgentDialog({
  agent,
  mode,
  onClose,
  onSave
}: {
  agent?: SubAgentInfo
  mode: 'create' | 'edit' | 'view'
  onClose: () => void
  onSave: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const overlayRef = useRef<HTMLDivElement>(null)
  const { closing, handleClose } = useDialogClose(onClose)

  const viewOnly = mode === 'view'
  const isEdit = mode === 'edit'

  // 表单字段
  const [name, setName] = useState(agent?.name || '')
  const [displayName, setDisplayName] = useState(agent?.displayName || '')
  const [description, setDescription] = useState(agent?.description || '')
  const [systemPrompt, setSystemPrompt] = useState(agent?.systemPrompt || '')
  const [maxTurns, setMaxTurns] = useState(agent?.maxTurns || 40)
  const [selectedTools, setSelectedTools] = useState<string[]>(agent?.tools || [])

  // 可用工具列表（排除 subagent 组，防递归）
  const [allTools, setAllTools] = useState<ToolItem[]>([])

  // 错误
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') handleClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [handleClose])

  useEffect(() => {
    if (!viewOnly) {
      window.api.tools.list().then((toolList) => {
        const filtered = (toolList as ToolItem[]).filter(
          (tool) => tool.group !== 'subagent' && tool.group !== 'system'
        )
        setAllTools(filtered)
      })
    }
  }, [viewOnly])

  const handleOverlayClick = (e: React.MouseEvent): void => {
    if (e.target === overlayRef.current) handleClose()
  }

  const canSubmit = name.trim() && displayName.trim() && !saving

  const handleSubmit = async (): Promise<void> => {
    if (!canSubmit) return
    setError('')

    if (!NAME_REGEX.test(name)) {
      setError(t('tool.subAgentNameInvalid'))
      return
    }

    setSaving(true)
    try {
      if (isEdit && agent) {
        await window.api.customSubAgent.update({
          id: agent.id,
          displayName: displayName.trim(),
          description: description.trim(),
          systemPrompt: systemPrompt.trim(),
          tools: selectedTools,
          maxTurns
        })
      } else {
        await window.api.customSubAgent.add({
          name: name.trim(),
          displayName: displayName.trim(),
          description: description.trim(),
          systemPrompt: systemPrompt.trim(),
          tools: selectedTools,
          maxTurns
        })
      }
      onSave()
      handleClose()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const title = viewOnly
    ? t('tool.subAgentViewTitle')
    : isEdit
      ? t('tool.subAgentEditTitle')
      : t('tool.subAgentCreateTitle')

  return (
    <div
      ref={overlayRef}
      onClick={handleOverlayClick}
      className={`fixed inset-0 z-50 flex items-center justify-center bg-black/40 dialog-overlay${closing ? ' dialog-closing' : ''}`}
    >
      <div className="bg-bg-primary border border-border-primary rounded-xl shadow-xl w-[520px] max-w-[90vw] max-h-[85vh] flex flex-col dialog-panel">
        {/* 标题 */}
        <div className="px-5 py-4 border-b border-border-secondary shrink-0">
          <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
        </div>

        {/* 内容 */}
        <div className="px-5 py-4 space-y-3 overflow-y-auto flex-1 min-h-0">
          {/* Name */}
          <div>
            <label className="block text-[11px] text-text-tertiary mb-1">
              {t('tool.subAgentName')}
            </label>
            <input
              autoFocus={!isEdit && !viewOnly}
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
              disabled={isEdit || viewOnly}
              className="zen-input font-mono"
              placeholder="code-reviewer"
            />
            {!viewOnly && !isEdit && (
              <p className="text-[9px] text-text-tertiary mt-0.5">{t('tool.subAgentNameHint')}</p>
            )}
          </div>

          {/* Display Name */}
          <div>
            <label className="block text-[11px] text-text-tertiary mb-1">
              {t('tool.subAgentDisplayName')}
            </label>
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              disabled={viewOnly}
              className="zen-input"
              placeholder="Code Reviewer"
            />
          </div>

          {/* Description */}
          <div>
            <label className="block text-[11px] text-text-tertiary mb-1">
              {t('tool.subAgentDescription')}
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={viewOnly}
              rows={3}
              className="zen-textarea text-[11px]"
              placeholder={viewOnly ? '' : t('tool.subAgentDescHint')}
            />
          </div>

          {/* System Prompt */}
          <div>
            <label className="block text-[11px] text-text-tertiary mb-1">
              {t('tool.subAgentPrompt')}
            </label>
            <textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              disabled={viewOnly}
              rows={viewOnly ? 6 : 8}
              className="zen-textarea font-mono text-[11px]"
              placeholder={viewOnly ? '' : t('tool.subAgentPromptHint')}
            />
          </div>

          {/* Max Turns */}
          <div>
            <label className="block text-[11px] text-text-tertiary mb-1">
              {t('tool.subAgentMaxTurns')}
            </label>
            <input
              type="number"
              value={maxTurns}
              onChange={(e) => setMaxTurns(Math.max(1, parseInt(e.target.value) || 1))}
              disabled={viewOnly}
              className="zen-input w-24"
              min={1}
              max={200}
            />
          </div>

          {/* 工具选择 */}
          <div>
            <label className="block text-[11px] text-text-tertiary mb-2">
              {t('tool.subAgentTools')}
            </label>
            {viewOnly ? (
              <div className="text-[10px] text-text-secondary font-mono space-y-0.5">
                {selectedTools.map((tool) => (
                  <div key={tool}>{tool}</div>
                ))}
              </div>
            ) : (
              <ToolSelectList
                tools={allTools}
                enabledTools={selectedTools}
                onChange={setSelectedTools}
              />
            )}
          </div>

          {/* 错误提示 */}
          {error && <p className="text-[10px] text-red-400">{error}</p>}
        </div>

        {/* 按钮 */}
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-border-secondary shrink-0">
          <button
            onClick={handleClose}
            className="px-4 py-1.5 rounded-lg text-xs text-text-secondary hover:bg-bg-hover transition-colors"
          >
            {viewOnly ? t('common.close') : t('common.cancel')}
          </button>
          {!viewOnly && (
            <button
              onClick={handleSubmit}
              disabled={!canSubmit}
              className="px-4 py-1.5 rounded-lg text-xs font-medium bg-accent text-white hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {saving ? t('common.saving') : t('common.save')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
