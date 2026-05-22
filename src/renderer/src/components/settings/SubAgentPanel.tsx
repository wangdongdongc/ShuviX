import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Trash2, Pencil, Eye, Loader2, X } from 'lucide-react'
import { ToolSelectList, type ToolItem } from '../common/ToolSelectList'
import { useDialogClose } from '../../hooks/useDialogClose'
import {
  SettingsSection,
  SettingsRow,
  SettingsBlock,
  Toggle,
  InlineInput
} from './SettingsPrimitives'

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
    <div className="flex-1 px-5 py-5 space-y-5">
      {loading ? (
        <div className="flex items-center gap-2 text-text-tertiary py-2 px-1">
          <Loader2 size={14} className="animate-spin" />
          <span className="text-[11px]">{t('common.loading') || 'Loading...'}</span>
        </div>
      ) : (
        <>
          {/* 内置子智能体 */}
          {builtinAgents.length > 0 && (
            <SettingsSection title={t('tool.subAgentBuiltin')} description={t('tool.subAgentDesc')}>
              {builtinAgents.map((agent) => (
                <SettingsRow
                  key={agent.id}
                  title={
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="truncate">{agent.displayName}</span>
                      <span className="px-1.5 py-0.5 rounded-md text-[9px] font-normal bg-accent/10 text-accent shrink-0">
                        {t('tool.subAgentBuiltin')}
                      </span>
                    </div>
                  }
                  description={agent.description.split('\n')[0]}
                  control={
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => handleView(agent)}
                        className="p-1 text-text-tertiary hover:text-text-primary transition-colors"
                        title={t('tool.subAgentViewTitle')}
                      >
                        <Eye size={12} />
                      </button>
                      <Toggle on={agent.isEnabled} onClick={() => handleToggle(agent)} />
                    </div>
                  }
                />
              ))}
            </SettingsSection>
          )}

          {/* 自定义子智能体 */}
          <SettingsSection
            title={t('tool.subAgentCustom')}
            description={builtinAgents.length === 0 ? t('tool.subAgentDesc') : undefined}
            headerAction={
              <button
                onClick={handleAdd}
                className="flex items-center gap-1 px-2 py-1 rounded text-[11px] text-accent hover:bg-accent/10 transition-colors"
              >
                <Plus size={12} />
                {t('tool.subAgentAddBtn')}
              </button>
            }
          >
            {customAgents.length === 0 ? (
              <div className="px-4 py-6 text-center">
                <p className="text-[11px] text-text-tertiary">{t('tool.subAgentCustomEmpty')}</p>
                <p className="text-[10px] text-text-tertiary mt-1">
                  {t('tool.subAgentCustomEmptyHint')}
                </p>
              </div>
            ) : (
              customAgents.map((agent) => (
                <SettingsRow
                  key={agent.id}
                  title={
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="truncate">{agent.displayName}</span>
                      <code className="text-[9px] text-text-tertiary font-mono shrink-0">
                        {agent.name}
                      </code>
                    </div>
                  }
                  description={agent.description || agent.systemPrompt.slice(0, 80)}
                  control={
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => handleEdit(agent)}
                        className="p-1 text-text-tertiary hover:text-text-primary transition-colors"
                        title="Edit"
                      >
                        <Pencil size={12} />
                      </button>
                      {deletingId === agent.id ? (
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => handleDelete(agent.id)}
                            className="px-1.5 py-0.5 text-[10px] text-danger hover:bg-danger/10 rounded transition-colors"
                          >
                            {t('common.confirm')}
                          </button>
                          <button
                            onClick={() => setDeletingId(null)}
                            className="px-1.5 py-0.5 text-[10px] text-text-tertiary hover:text-text-secondary rounded transition-colors"
                          >
                            {t('common.cancel')}
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setDeletingId(agent.id)}
                          className="p-1 text-text-tertiary hover:text-danger transition-colors"
                          title="Delete"
                        >
                          <Trash2 size={12} />
                        </button>
                      )}
                      <Toggle on={agent.isEnabled} onClick={() => handleToggle(agent)} />
                    </div>
                  }
                />
              ))
            )}
          </SettingsSection>
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
      onClick={handleClose}
      className={`fixed inset-0 z-50 flex items-center justify-center bg-black/40 titlebar-no-drag dialog-overlay${closing ? ' dialog-closing' : ''}`}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-bg-primary border border-border-primary rounded-xl shadow-xl w-[560px] max-w-[92vw] max-h-[88vh] flex flex-col dialog-panel"
      >
        {/* 头部 */}
        <div className="px-5 py-3 border-b border-border-secondary shrink-0 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
          <button
            onClick={handleClose}
            className="p-1 rounded-lg hover:bg-bg-hover text-text-tertiary hover:text-text-primary transition-colors"
          >
            <X size={14} />
          </button>
        </div>

        {/* 表单 */}
        <div className="px-5 py-5 overflow-y-auto flex-1 space-y-5">
          {/* 基本信息 */}
          <SettingsSection title={t('tool.subAgentBasicGroup')}>
            <SettingsRow
              title={t('tool.subAgentName')}
              description={!viewOnly && !isEdit ? t('tool.subAgentNameHint') : undefined}
              control={
                <InlineInput
                  value={name}
                  onChange={(v) => setName(v.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                  placeholder="code-reviewer"
                  monospace
                  disabled={isEdit || viewOnly}
                  autoFocus={!isEdit && !viewOnly}
                />
              }
            />
            <SettingsRow
              title={t('tool.subAgentDisplayName')}
              control={
                <InlineInput
                  value={displayName}
                  onChange={setDisplayName}
                  placeholder="Code Reviewer"
                  disabled={viewOnly}
                />
              }
            />
            <SettingsBlock label={t('tool.subAgentDescription')}>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                disabled={viewOnly}
                rows={3}
                className="zen-textarea text-[11px]"
                placeholder={viewOnly ? '' : t('tool.subAgentDescHint')}
              />
            </SettingsBlock>
          </SettingsSection>

          {/* 行为 */}
          <SettingsSection title={t('tool.subAgentBehaviorGroup')}>
            <SettingsBlock label={t('tool.subAgentPrompt')}>
              <textarea
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                disabled={viewOnly}
                rows={viewOnly ? 6 : 8}
                className="zen-textarea font-mono text-[11px]"
                placeholder={viewOnly ? '' : t('tool.subAgentPromptHint')}
              />
            </SettingsBlock>
            <SettingsRow
              title={t('tool.subAgentMaxTurns')}
              control={
                <InlineInput
                  type="number"
                  value={maxTurns}
                  onChange={(v) => setMaxTurns(Math.max(1, parseInt(v) || 1))}
                  width={90}
                  disabled={viewOnly}
                  min={1}
                  max={200}
                />
              }
            />
          </SettingsSection>

          {/* 可用工具 */}
          <SettingsSection title={t('tool.subAgentTools')}>
            <SettingsBlock>
              {viewOnly ? (
                <div className="text-[11px] text-text-secondary font-mono space-y-0.5">
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
            </SettingsBlock>
          </SettingsSection>

          {error && <p className="text-[11px] text-danger px-1">{error}</p>}
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
