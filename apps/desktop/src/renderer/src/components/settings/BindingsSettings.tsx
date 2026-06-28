import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowLeft,
  Globe,
  Copy,
  X,
  Bot,
  Plus,
  Play,
  Square,
  ChevronDown,
  ChevronRight,
  Trash2
} from 'lucide-react'
import { copyToClipboard } from '@shuvix/chat-ui'
import { useDialogClose } from '@shuvix/chat-ui'
import type { Session } from '@shuvix/chat-ui'
import { getChannelBindingCaps } from '@shuvix/app-shell'
import type { TelegramBotInfo } from '@shuvix/chat-protocol/chatApi'
import { SettingsSection, SettingsRow, InlineInput } from './SettingsPrimitives'

/** 前端类型定义 */
interface FrontendType {
  id: string
  icon: React.ReactNode
  labelKey: string
}

/**
 * 会话绑定设置 — 2 层抽屉
 * Layer 1: 前端类型列表（WebUI / Telegram Bot）
 * Layer 2: 选中类型的详情（运行状态 + 已绑定会话列表）
 */
export function BindingsSettings(): React.JSX.Element {
  const { t } = useTranslation()
  const [activeType, setActiveType] = useState<string | null>(null)
  const [sharedIds, setSharedIds] = useState<Set<string>>(new Set())
  const [telegramBotCount, setTelegramBotCount] = useState(0)
  const [sessions, setSessions] = useState<Session[]>([])

  const reload = useCallback(async () => {
    const [shared, bots, allSessions] = await Promise.all([
      window.api.webui.listShared(),
      window.api.telegram.listBots(),
      window.api.session.list()
    ])
    setSharedIds(new Set(shared.map((s) => s.sessionId)))
    setTelegramBotCount(bots.length)
    setSessions(allSessions)
  }, [])

  useEffect(() => {
    let cancelled = false
    Promise.all([
      window.api.webui.listShared(),
      window.api.telegram.listBots(),
      window.api.session.list()
    ]).then(([shared, bots, allSessions]) => {
      if (!cancelled) {
        setSharedIds(new Set(shared.map((s) => s.sessionId)))
        setTelegramBotCount(bots.length)
        setSessions(allSessions)
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  // 据当前宿主提供的渠道 API 自动显隐：缺省渠道不出现在列表里
  const caps = getChannelBindingCaps()
  const frontendTypes: FrontendType[] = [
    caps.webui && { id: 'webui', icon: <Globe size={13} />, labelKey: 'bindings.webui' },
    caps.telegram && { id: 'telegram', icon: <Bot size={13} />, labelKey: 'bindings.telegram' }
  ].filter(Boolean) as FrontendType[]

  const getSharedCount = (id: string): number => {
    if (id === 'webui') return sharedIds.size
    if (id === 'telegram') return telegramBotCount
    return 0
  }

  return (
    <div className="relative overflow-hidden h-full">
      {/* Layer 1: 前端类型列表 */}
      <div
        className={`absolute inset-0 overflow-y-auto transition-transform duration-200 ease-out ${
          activeType ? '-translate-x-full' : 'translate-x-0'
        }`}
      >
        <div className="flex-1 px-5 py-5 space-y-5">
          <SettingsSection title={t('bindings.title')} description={t('bindings.description')}>
            {frontendTypes.map((ft) => {
              const count = getSharedCount(ft.id)
              return (
                <SettingsRow
                  key={ft.id}
                  icon={<span className="text-text-secondary shrink-0">{ft.icon}</span>}
                  title={t(ft.labelKey)}
                  description={
                    count > 0 ? t('bindings.sessionCount', { count }) : t('bindings.noSessions')
                  }
                  control={
                    <div className="flex items-center gap-2">
                      {count > 0 && (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[9px] font-normal bg-emerald-500/10 text-emerald-500">
                          <span className="w-1 h-1 rounded-full bg-emerald-500" />
                          {t('bindings.running')}
                        </span>
                      )}
                      <button
                        onClick={() => setActiveType(ft.id)}
                        className="p-1 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors"
                      >
                        <ChevronRight size={12} />
                      </button>
                    </div>
                  }
                />
              )
            })}
          </SettingsSection>
        </div>
      </div>

      {/* Layer 2: 详情面板 */}
      <div
        className={`absolute inset-0 overflow-y-auto transition-transform duration-200 ease-out ${
          activeType ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        {activeType === 'webui' && (
          <WebUIDetail
            sessions={sessions}
            sharedIds={sharedIds}
            onBack={() => setActiveType(null)}
            onReload={reload}
          />
        )}
        {activeType === 'telegram' && (
          <TelegramDetail onBack={() => setActiveType(null)} onReload={reload} />
        )}
      </div>
    </div>
  )
}

/** Layer 2 头部（返回 + 标题 + 可选 action） */
function DetailHeader({
  icon,
  title,
  onBack,
  action
}: {
  icon: React.ReactNode
  title: string
  onBack: () => void
  action?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 px-5 py-3 border-b border-border-secondary sticky top-0 bg-bg-primary z-10">
      <button
        onClick={onBack}
        className="p-1 rounded-lg hover:bg-bg-hover text-text-tertiary hover:text-text-primary transition-colors"
      >
        <ArrowLeft size={14} />
      </button>
      <span className="text-text-secondary">{icon}</span>
      <h3 className="text-sm font-semibold text-text-primary flex-1">{title}</h3>
      {action}
    </div>
  )
}

/** WebUI 详情面板 */
function WebUIDetail({
  sessions,
  sharedIds,
  onBack,
  onReload
}: {
  sessions: Session[]
  sharedIds: Set<string>
  onBack: () => void
  onReload: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [serverStatus, setServerStatus] = useState<{
    running: boolean
    port?: number
    urls?: string[]
  }>({ running: false })
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null)

  useEffect(() => {
    window.api.webui.serverStatus().then(setServerStatus)
  }, [sharedIds.size])

  const sharedSessions = sessions.filter((s) => sharedIds.has(s.id))
  const baseUrl = serverStatus.urls?.[0] || ''

  const handleCopy = (url: string): void => {
    copyToClipboard(url)
    setCopiedUrl(url)
    setTimeout(() => setCopiedUrl(null), 2000)
  }

  const handleRemoveShare = async (sessionId: string): Promise<void> => {
    await window.api.webui.setShared({ sessionId, shared: false })
    onReload()
  }

  return (
    <div className="flex flex-col">
      <DetailHeader icon={<Globe size={14} />} title={t('bindings.webui')} onBack={onBack} />

      <div className="px-5 py-5 space-y-5">
        {/* 服务器状态 */}
        <SettingsSection title={t('bindings.serverStatus')}>
          <SettingsRow
            title={t('bindings.serverStatus')}
            control={
              <span
                className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${
                  serverStatus.running
                    ? 'bg-emerald-500/10 text-emerald-500'
                    : 'bg-text-tertiary/10 text-text-tertiary'
                }`}
              >
                {serverStatus.running ? t('bindings.running') : t('bindings.stopped')}
              </span>
            }
          />
          {serverStatus.running && serverStatus.port && (
            <>
              <SettingsRow
                title={t('bindings.port')}
                control={
                  <span className="text-[11px] font-mono text-text-secondary">
                    {serverStatus.port}
                  </span>
                }
              />
              {serverStatus.urls?.map((url) => (
                <div
                  key={url}
                  className="flex items-center gap-2 px-4 py-2.5 group hover:bg-bg-hover/40 transition-colors"
                >
                  <span className="text-[11px] font-mono text-text-secondary truncate flex-1">
                    {url}
                  </span>
                  <button
                    onClick={() => handleCopy(url)}
                    className="p-1 rounded text-text-tertiary hover:text-text-primary opacity-0 group-hover:opacity-100 transition-all shrink-0"
                    title={copiedUrl === url ? t('common.copied') : t('common.copy')}
                  >
                    <Copy size={11} />
                  </button>
                </div>
              ))}
            </>
          )}
        </SettingsSection>

        {/* 已绑定会话 */}
        <SettingsSection title={`${t('bindings.boundSessions')} (${sharedSessions.length})`}>
          {sharedSessions.length === 0 ? (
            <div className="px-4 py-6 text-center">
              <p className="text-[11px] text-text-tertiary">{t('bindings.noSessionsHint')}</p>
            </div>
          ) : (
            sharedSessions.map((s) => {
              const url = `${baseUrl}/shuvix/sessions/${s.id}`
              return (
                <div key={s.id} className="flex flex-col">
                  <div className="flex items-center gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] text-text-primary truncate">{s.title}</div>
                      {baseUrl && (
                        <div className="text-[11px] font-mono text-text-tertiary truncate mt-0.5">
                          {url}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {baseUrl && (
                        <button
                          onClick={() => handleCopy(url)}
                          className="p-1 text-text-tertiary hover:text-text-primary transition-colors"
                          title={copiedUrl === url ? t('common.copied') : t('common.copy')}
                        >
                          <Copy size={11} />
                        </button>
                      )}
                      <button
                        onClick={() => void handleRemoveShare(s.id)}
                        className="p-1 text-text-tertiary hover:text-danger transition-colors"
                        title={t('bindings.removeShare')}
                      >
                        <X size={12} />
                      </button>
                    </div>
                  </div>
                </div>
              )
            })
          )}
        </SettingsSection>
      </div>
    </div>
  )
}

/** Telegram Bot 详情面板（多 Bot 管理） */
function TelegramDetail({
  onBack,
  onReload
}: {
  onBack: () => void
  onReload: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [bots, setBots] = useState<TelegramBotInfo[]>([])
  const [expandedBotId, setExpandedBotId] = useState<string | null>(null)
  const [showAddDialog, setShowAddDialog] = useState(false)

  const loadBots = useCallback(async () => {
    const list = await window.api.telegram.listBots()
    setBots(list)
  }, [])

  useEffect(() => {
    loadBots() // eslint-disable-line react-hooks/set-state-in-effect
  }, [loadBots])

  const handleDeleteBot = async (botId: string): Promise<void> => {
    await window.api.telegram.deleteBot(botId)
    setExpandedBotId(null)
    await loadBots()
    onReload()
  }

  const handleStartBot = async (botId: string): Promise<void> => {
    await window.api.telegram.startBot(botId)
    await loadBots()
  }

  const handleStopBot = async (botId: string): Promise<void> => {
    await window.api.telegram.stopBot(botId)
    await loadBots()
  }

  return (
    <div className="flex flex-col">
      <DetailHeader
        icon={<Bot size={14} />}
        title={t('bindings.telegram')}
        onBack={onBack}
        action={
          <button
            onClick={() => setShowAddDialog(true)}
            className="flex items-center gap-1 px-2 py-1 rounded text-[11px] text-accent hover:bg-accent/10 transition-colors"
          >
            <Plus size={11} />
            {t('bindings.telegramAddBot')}
          </button>
        }
      />

      <div className="px-5 py-5 space-y-5">
        <SettingsSection title={t('bindings.telegram')} description={t('bindings.description')}>
          {bots.length === 0 ? (
            <div className="px-4 py-6 text-center">
              <p className="text-[11px] text-text-tertiary">{t('bindings.telegramNoBots')}</p>
            </div>
          ) : (
            bots.map((bot) => (
              <BotItem
                key={bot.id}
                bot={bot}
                expanded={expandedBotId === bot.id}
                onToggle={() => setExpandedBotId(expandedBotId === bot.id ? null : bot.id)}
                onStart={() => void handleStartBot(bot.id)}
                onStop={() => void handleStopBot(bot.id)}
                onDelete={() => void handleDeleteBot(bot.id)}
                onUpdated={loadBots}
              />
            ))
          )}
        </SettingsSection>
      </div>

      {showAddDialog && (
        <AddBotDialog
          onAdded={async () => {
            setShowAddDialog(false)
            await loadBots()
            onReload()
          }}
          onClose={() => setShowAddDialog(false)}
        />
      )}
    </div>
  )
}

/** 单个 Bot 行 + 可展开管理面板 */
function BotItem({
  bot,
  expanded,
  onToggle,
  onStart,
  onStop,
  onDelete,
  onUpdated
}: {
  bot: TelegramBotInfo
  expanded: boolean
  onToggle: () => void
  onStart: () => void
  onStop: () => void
  onDelete: () => void
  onUpdated: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [confirmDelete, setConfirmDelete] = useState(false)

  return (
    <div className="flex flex-col">
      <div
        onClick={onToggle}
        className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-bg-hover/40 transition-colors"
      >
        <span className="text-text-tertiary shrink-0">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-[13px] text-text-primary truncate">{bot.name}</span>
            {bot.username && (
              <span className="text-[10px] font-mono text-text-tertiary shrink-0">
                @{bot.username}
              </span>
            )}
          </div>
          <div className="text-[11px] text-text-tertiary mt-0.5">
            {bot.boundSessionTitle
              ? t('bindings.telegramBoundTo', { title: bot.boundSessionTitle })
              : t('bindings.telegramUnbound')}
          </div>
        </div>
        <span
          className={`text-[10px] font-medium px-2 py-0.5 rounded-full shrink-0 ${
            bot.running
              ? 'bg-emerald-500/10 text-emerald-500'
              : 'bg-text-tertiary/10 text-text-tertiary'
          }`}
        >
          {bot.running ? t('bindings.running') : t('bindings.stopped')}
        </span>
      </div>

      {expanded && (
        <div className="px-4 py-3 space-y-3 bg-bg-tertiary/15">
          {/* 启停按钮 */}
          <div className="flex items-center gap-2">
            {bot.running ? (
              <button
                onClick={onStop}
                className="flex items-center gap-1.5 px-3 py-1 text-[11px] rounded-md bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors"
              >
                <Square size={10} />
                {t('bindings.telegramStopBot')}
              </button>
            ) : (
              <button
                onClick={onStart}
                className="flex items-center gap-1.5 px-3 py-1 text-[11px] rounded-md bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500/20 transition-colors"
              >
                <Play size={10} />
                {t('bindings.telegramStartBot')}
              </button>
            )}
          </div>

          {/* 允许的用户 */}
          <BotAllowedUsers bot={bot} onUpdated={onUpdated} />

          {/* 删除 */}
          <div className="pt-2 border-t border-border-secondary/30">
            {confirmDelete ? (
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-red-400 flex-1">
                  {t('bindings.telegramDeleteConfirm')}
                </span>
                <button
                  onClick={() => setConfirmDelete(false)}
                  className="px-2 py-1 text-[10px] rounded text-text-secondary hover:bg-bg-hover transition-colors"
                >
                  {t('common.cancel')}
                </button>
                <button
                  onClick={onDelete}
                  className="px-2 py-1 text-[10px] rounded bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors"
                >
                  {t('common.confirm')}
                </button>
              </div>
            ) : (
              <button
                onClick={() => setConfirmDelete(true)}
                className="flex items-center gap-1 text-[11px] text-red-400 hover:text-red-300 transition-colors"
              >
                <Trash2 size={11} />
                {t('bindings.telegramDeleteBot')}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/** Bot 允许用户管理 */
function BotAllowedUsers({
  bot,
  onUpdated
}: {
  bot: TelegramBotInfo
  onUpdated: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [newUserId, setNewUserId] = useState('')

  const handleAddUser = async (): Promise<void> => {
    const id = parseInt(newUserId.trim())
    if (isNaN(id) || bot.allowedUsers.includes(id)) return
    const updated = [...bot.allowedUsers, id]
    await window.api.telegram.updateBot({ id: bot.id, allowedUsers: updated })
    setNewUserId('')
    onUpdated()
  }

  const handleRemoveUser = async (userId: number): Promise<void> => {
    const updated = bot.allowedUsers.filter((id) => id !== userId)
    await window.api.telegram.updateBot({ id: bot.id, allowedUsers: updated })
    onUpdated()
  }

  return (
    <div>
      <div className="text-[12px] text-text-primary mb-1">
        {t('bindings.telegramEditAllowedUsers')}
      </div>
      <div className="text-[11px] text-text-tertiary mb-2 leading-relaxed">
        {t('bindings.telegramAllowedUsersHint')}
      </div>
      <div className="flex gap-2 mb-2">
        <InlineInput value={newUserId} onChange={setNewUserId} placeholder="User ID" width={200} />
        <button
          onClick={() => void handleAddUser()}
          disabled={!newUserId.trim()}
          className="p-1.5 rounded-md bg-accent/10 text-accent hover:bg-accent/20 disabled:opacity-50 transition-colors"
        >
          <Plus size={12} />
        </button>
      </div>
      {bot.allowedUsers.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {bot.allowedUsers.map((id) => (
            <span
              key={id}
              className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-mono rounded-full bg-bg-hover text-text-secondary"
            >
              {id}
              <button
                onClick={() => void handleRemoveUser(id)}
                className="text-text-tertiary hover:text-danger"
              >
                <X size={9} />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

/** 添加 Bot 弹窗 */
function AddBotDialog({
  onAdded,
  onClose
}: {
  onAdded: () => void
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { closing, handleClose } = useDialogClose(onClose)
  const [token, setToken] = useState('')
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') handleClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [handleClose])

  const handleSubmit = async (): Promise<void> => {
    if (!token.trim()) return
    setAdding(true)
    setError('')
    try {
      await window.api.telegram.addBot({ token: token.trim() })
      onAdded()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('bindings.telegramTokenInvalid'))
    } finally {
      setAdding(false)
    }
  }

  return (
    <div
      onClick={handleClose}
      className={`fixed inset-0 z-50 flex items-center justify-center bg-black/40 titlebar-no-drag dialog-overlay${closing ? ' dialog-closing' : ''}`}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-bg-primary border border-border-primary rounded-xl shadow-xl w-[440px] max-w-[92vw] flex flex-col dialog-panel"
      >
        <div className="px-5 py-3 border-b border-border-secondary shrink-0 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-text-primary">
            {t('bindings.telegramAddBot')}
          </h3>
          <button
            onClick={handleClose}
            className="p-1 rounded-lg hover:bg-bg-hover text-text-tertiary hover:text-text-primary transition-colors"
          >
            <X size={14} />
          </button>
        </div>

        <div className="px-5 py-5 space-y-2">
          <label className="block text-[11px] text-text-tertiary">
            {t('bindings.telegramBotToken')}
          </label>
          <InlineInput
            type="password"
            value={token}
            onChange={setToken}
            placeholder={t('bindings.telegramBotTokenHint')}
            autoFocus
            width={400}
          />
          {error && <p className="text-[11px] text-danger">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-border-secondary shrink-0">
          <button
            onClick={handleClose}
            className="px-4 py-1.5 rounded-lg text-xs text-text-secondary hover:bg-bg-hover transition-colors"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={() => void handleSubmit()}
            disabled={adding || !token.trim()}
            className="px-4 py-1.5 rounded-lg text-xs font-medium bg-accent text-white hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {adding ? t('bindings.telegramValidating') : t('common.add')}
          </button>
        </div>
      </div>
    </div>
  )
}
