import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { FolderOpen, Eye, Loader2, RefreshCw, X } from 'lucide-react'
import { useDialogClose } from '@shuvix/chat-ui'
import { SettingsSection, SettingsRow, Toggle } from './SettingsPrimitives'

export function SubAgentPanel(): React.JSX.Element {
  const { t } = useTranslation()

  const [agents, setAgents] = useState<SubAgentInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [viewing, setViewing] = useState<SubAgentInfo | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async () => {
    const list = await window.api.subAgent.list()
    setAgents(list)
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const handleRefresh = async (): Promise<void> => {
    setRefreshing(true)
    try {
      await window.api.subAgent.refresh()
      await load()
    } finally {
      setRefreshing(false)
    }
  }

  const handleOpenFolder = async (): Promise<void> => {
    await window.api.subAgent.openFolder()
  }

  const handleToggle = async (agent: SubAgentInfo): Promise<void> => {
    if (agent.source === 'builtin') return
    await window.api.subAgent.setEnabled({ name: agent.name, enabled: !agent.isEnabled })
    await load()
  }

  const builtins = agents.filter((a) => a.source === 'builtin')
  const userAgents = agents.filter((a) => a.source === 'user')

  return (
    <div className="flex-1 px-5 py-5 space-y-5">
      {loading ? (
        <div className="flex items-center gap-2 text-text-tertiary py-2 px-1">
          <Loader2 size={14} className="animate-spin" />
          <span className="text-[11px]">{t('common.loading') || 'Loading...'}</span>
        </div>
      ) : (
        <>
          {/* 顶部操作栏 */}
          <div className="flex items-center gap-2">
            <button
              onClick={handleOpenFolder}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded text-[11px] text-accent hover:bg-accent/10 transition-colors"
            >
              <FolderOpen size={12} />
              {t('tool.subAgentOpenFolder')}
            </button>
            <button
              onClick={handleRefresh}
              disabled={refreshing}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded text-[11px] text-text-secondary hover:bg-bg-hover transition-colors disabled:opacity-50"
            >
              <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} />
              {t('tool.subAgentRefresh')}
            </button>
          </div>

          {/* 说明 */}
          <p className="text-[11px] text-text-tertiary leading-relaxed">
            {t('tool.subAgentFsHint')}
          </p>

          {/* 内置 */}
          {builtins.length > 0 && (
            <SettingsSection title={t('tool.subAgentBuiltin')}>
              {builtins.map((agent) => (
                <SettingsRow
                  key={`builtin:${agent.name}`}
                  title={
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="truncate">{agent.displayName}</span>
                      <code className="text-[9px] text-text-tertiary font-mono shrink-0">
                        {agent.name}
                      </code>
                      <span className="px-1.5 py-0.5 rounded-md text-[9px] font-normal bg-accent/10 text-accent shrink-0">
                        {t('tool.subAgentBuiltin')}
                      </span>
                    </div>
                  }
                  description={firstLine(agent.whenToUse)}
                  control={
                    <button
                      onClick={() => setViewing(agent)}
                      className="p-1 text-text-tertiary hover:text-text-primary transition-colors"
                      title={t('tool.subAgentViewTitle')}
                    >
                      <Eye size={12} />
                    </button>
                  }
                />
              ))}
            </SettingsSection>
          )}

          {/* 用户自定义 */}
          <SettingsSection title={t('tool.subAgentCustom')}>
            {userAgents.length === 0 ? (
              <div className="px-4 py-6 text-center">
                <p className="text-[11px] text-text-tertiary">{t('tool.subAgentCustomEmpty')}</p>
                <p className="text-[10px] text-text-tertiary mt-1">
                  {t('tool.subAgentCustomEmptyHint')}
                </p>
              </div>
            ) : (
              userAgents.map((agent) => (
                <SettingsRow
                  key={`user:${agent.name}`}
                  title={
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="truncate">{agent.displayName}</span>
                      <code className="text-[9px] text-text-tertiary font-mono shrink-0">
                        {agent.name}
                      </code>
                    </div>
                  }
                  description={firstLine(agent.whenToUse) || agent.systemPrompt.slice(0, 80)}
                  control={
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => setViewing(agent)}
                        className="p-1 text-text-tertiary hover:text-text-primary transition-colors"
                        title={t('tool.subAgentViewTitle')}
                      >
                        <Eye size={12} />
                      </button>
                      <Toggle on={agent.isEnabled} onClick={() => handleToggle(agent)} />
                    </div>
                  }
                />
              ))
            )}
          </SettingsSection>
        </>
      )}

      {/* View dialog */}
      {viewing && <ViewDialog agent={viewing} onClose={() => setViewing(null)} />}
    </div>
  )
}

function firstLine(s: string): string {
  return s.split('\n')[0]
}

// ─── View Dialog ─────────────────────────────────────────

function ViewDialog({
  agent,
  onClose
}: {
  agent: SubAgentInfo
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { closing, handleClose } = useDialogClose(onClose)

  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center bg-black/30 ${
        closing ? 'animate-fade-out' : 'animate-fade-in'
      }`}
      onClick={handleClose}
    >
      <div
        className={`bg-bg-primary border border-border-primary rounded-lg shadow-xl w-[640px] max-h-[80vh] flex flex-col ${
          closing ? 'animate-scale-out' : 'animate-scale-in'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-secondary">
          <div className="flex items-center gap-2 min-w-0">
            <span className="font-medium truncate">{agent.displayName}</span>
            <code className="text-[10px] text-text-tertiary font-mono">{agent.name}</code>
            <span className="px-1.5 py-0.5 rounded-md text-[9px] font-normal bg-bg-secondary text-text-tertiary shrink-0">
              {agent.source === 'builtin' ? t('tool.subAgentBuiltin') : t('tool.subAgentCustom')}
            </span>
          </div>
          <button onClick={handleClose} className="text-text-tertiary hover:text-text-primary">
            <X size={16} />
          </button>
        </div>

        <div className="overflow-auto px-4 py-3 space-y-3 text-[11px]">
          <Field label={t('tool.subAgentWhenToUse')} value={agent.whenToUse} />
          <Field label={t('tool.subAgentTools')} value={agent.tools.join(', ') || '—'} />
          {agent.requiredMcp && agent.requiredMcp.length > 0 && (
            <Field label={t('tool.subAgentRequiredMcp')} value={agent.requiredMcp.join(', ')} />
          )}
          <Field label={t('tool.subAgentBasePath')} value={agent.basePath} monospace />
          <div>
            <div className="font-medium text-text-secondary mb-1">
              {t('tool.subAgentSystemPrompt')}
            </div>
            <pre className="bg-bg-secondary/50 border border-border-secondary rounded p-2 text-[10px] whitespace-pre-wrap break-words leading-relaxed max-h-[40vh] overflow-auto">
              {agent.systemPrompt}
            </pre>
          </div>
        </div>
      </div>
    </div>
  )
}

function Field({
  label,
  value,
  monospace
}: {
  label: string
  value: string
  monospace?: boolean
}): React.JSX.Element {
  return (
    <div>
      <div className="font-medium text-text-secondary mb-1">{label}</div>
      <div
        className={`text-text-primary break-words ${
          monospace ? 'font-mono text-[10px] text-text-tertiary' : ''
        }`}
      >
        {value}
      </div>
    </div>
  )
}
