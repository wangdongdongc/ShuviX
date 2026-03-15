import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowLeft,
  Globe,
  Copy,
  X,
  Radio,
  Bot,
  Plug,
  Plus,
  Play,
  Square,
  ChevronDown,
  ChevronUp,
  Trash2
} from 'lucide-react'
import { copyToClipboard } from '../../utils/clipboard'
import type { Session } from '../../stores/chatStore'

/** 前端类型定义 */
interface FrontendType {
  id: string
  icon: React.ReactNode
  labelKey: string
  available: boolean
}

/** 前端返回的 Bot 信息 */
interface TelegramBotInfo {
  id: string
  name: string
  username: string
  allowedUsers: number[]
  isEnabled: boolean
  running: boolean
  boundSessionId: string | null
  boundSessionTitle: string | null
  createdAt: number
  updatedAt: number
}

/**
 * 会话绑定设置 — 2 层抽屉
 * Layer 1: 前端类型列表（WebUI / Telegram Bot / WebSocket API …）
 * Layer 2: 选中类型的详情（运行状态 + 已绑定会话列表）
 *
 * 注意：设置窗口是独立渲染进程，不共享主窗口的 chatStore，
 * 因此此组件自行通过 IPC 加载 sessions 和分享状态。
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

  const frontendTypes: FrontendType[] = [
    { id: 'webui', icon: <Globe size={16} />, labelKey: 'bindings.webui', available: true },
    { id: 'telegram', icon: <Bot size={16} />, labelKey: 'bindings.telegram', available: true },
    { id: 'websocket', icon: <Plug size={16} />, labelKey: 'bindings.websocket', available: false }
  ]

  const getSharedCount = (id: string): number => {
    if (id === 'webui') return sharedIds.size
    if (id === 'telegram') return telegramBotCount
    return 0
  }

  return (
    <div className="relative overflow-hidden h-full">
      {/* Layer 1: 前端类型列表 */}
      <div
        className={`absolute inset-0 transition-transform duration-200 ease-out ${
          activeType ? '-translate-x-full' : 'translate-x-0'
        }`}
      >
        <div className="p-6">
          <h3 className="text-sm font-semibold text-text-primary mb-1">{t('bindings.title')}</h3>
          <p className="text-xs text-text-tertiary mb-4">{t('bindings.description')}</p>
          <div className="space-y-2">
            {frontendTypes.map((ft) => (
              <FrontendTypeCard
                key={ft.id}
                type={ft}
                sharedCount={getSharedCount(ft.id)}
                onClick={() => ft.available && setActiveType(ft.id)}
              />
            ))}
          </div>
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

/** 前端类型卡片 */
function FrontendTypeCard({
  type,
  sharedCount,
  onClick
}: {
  type: FrontendType
  sharedCount: number
  onClick: () => void
}): React.JSX.Element {
  const { t } = useTranslation()

  return (
    <button
      onClick={onClick}
      disabled={!type.available}
      className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl border transition-colors text-left ${
        type.available
          ? 'border-border-primary bg-bg-secondary hover:bg-bg-hover cursor-pointer'
          : 'border-border-primary/50 bg-bg-secondary/50 opacity-50 cursor-not-allowed'
      }`}
    >
      <div className="text-text-secondary">{type.icon}</div>
      <div className="flex-1 min-w-0">
        <div className="text-xs font-medium text-text-primary">{t(type.labelKey)}</div>
        <div className="text-[10px] text-text-tertiary mt-0.5">
          {type.available
            ? sharedCount > 0
              ? t('bindings.sessionCount', { count: sharedCount })
              : t('bindings.noSessions')
            : t('bindings.comingSoon')}
        </div>
      </div>
      {type.available && sharedCount > 0 && (
        <div className="flex items-center gap-1">
          <Radio size={10} className="text-green-500" />
          <span className="text-[10px] text-green-500">{t('bindings.running')}</span>
        </div>
      )}
    </button>
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
    <div className="p-6">
      {/* 返回 + 标题 */}
      <div className="flex items-center gap-2 mb-4">
        <button
          onClick={onBack}
          className="p-1 rounded-lg hover:bg-bg-hover text-text-tertiary hover:text-text-primary transition-colors"
        >
          <ArrowLeft size={14} />
        </button>
        <Globe size={16} className="text-text-secondary" />
        <h3 className="text-sm font-semibold text-text-primary">{t('bindings.webui')}</h3>
      </div>

      {/* 服务器状态 */}
      <div className="px-4 py-3 rounded-xl border border-border-primary bg-bg-secondary mb-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-text-secondary">{t('bindings.serverStatus')}</span>
          <span
            className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${
              serverStatus.running
                ? 'bg-green-500/10 text-green-500'
                : 'bg-text-tertiary/10 text-text-tertiary'
            }`}
          >
            {serverStatus.running ? t('bindings.running') : t('bindings.stopped')}
          </span>
        </div>
        {serverStatus.running && serverStatus.port && (
          <div className="text-[10px] text-text-tertiary space-y-0.5">
            <div>
              {t('bindings.port')}: {serverStatus.port}
            </div>
            {serverStatus.urls?.map((url) => (
              <div key={url} className="flex items-center gap-1">
                <span className="truncate">{url}</span>
                <button
                  onClick={() => handleCopy(url)}
                  className="p-0.5 rounded hover:bg-bg-hover text-text-tertiary hover:text-text-secondary shrink-0"
                >
                  <Copy size={9} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 已绑定会话列表 */}
      <div>
        <h4 className="text-xs font-medium text-text-secondary mb-2">
          {t('bindings.boundSessions')} ({sharedSessions.length})
        </h4>
        {sharedSessions.length === 0 ? (
          <div className="text-center py-6 text-text-tertiary text-xs">
            {t('bindings.noSessionsHint')}
          </div>
        ) : (
          <div className="space-y-2">
            {sharedSessions.map((s) => {
              const url = `${baseUrl}/shuvix/sessions/${s.id}`
              return (
                <div
                  key={s.id}
                  className="px-3 py-2.5 rounded-lg border border-border-primary bg-bg-secondary"
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs text-text-primary font-medium truncate flex-1">
                      {s.title}
                    </span>
                    <button
                      onClick={() => void handleRemoveShare(s.id)}
                      className="p-0.5 rounded hover:bg-bg-hover text-text-tertiary hover:text-error transition-colors shrink-0 ml-2"
                      title={t('bindings.removeShare')}
                    >
                      <X size={12} />
                    </button>
                  </div>
                  {baseUrl && (
                    <div className="flex items-center gap-1">
                      <span className="text-[10px] text-text-tertiary truncate flex-1">{url}</span>
                      <button
                        onClick={() => handleCopy(url)}
                        className="p-0.5 rounded hover:bg-bg-hover text-text-tertiary hover:text-text-secondary shrink-0"
                        title={copiedUrl === url ? t('common.copied') : t('common.copy')}
                      >
                        <Copy size={10} />
                      </button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
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
  const [showAddForm, setShowAddForm] = useState(false)

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
    <div className="p-6">
      {/* 返回 + 标题 + 添加按钮 */}
      <div className="flex items-center gap-2 mb-4">
        <button
          onClick={onBack}
          className="p-1 rounded-lg hover:bg-bg-hover text-text-tertiary hover:text-text-primary transition-colors"
        >
          <ArrowLeft size={14} />
        </button>
        <Bot size={16} className="text-text-secondary" />
        <h3 className="text-sm font-semibold text-text-primary flex-1">{t('bindings.telegram')}</h3>
        <button
          onClick={() => setShowAddForm(true)}
          className="flex items-center gap-1 px-2.5 py-1 text-xs rounded-lg bg-accent/10 text-accent hover:bg-accent/20 transition-colors"
        >
          <Plus size={12} />
          {t('bindings.telegramAddBot')}
        </button>
      </div>

      {/* 添加 Bot 表单 */}
      {showAddForm && (
        <AddBotForm
          onAdded={async () => {
            setShowAddForm(false)
            await loadBots()
            onReload()
          }}
          onCancel={() => setShowAddForm(false)}
        />
      )}

      {/* Bot 列表 */}
      {bots.length === 0 && !showAddForm ? (
        <div className="text-center py-8 text-text-tertiary text-xs">
          {t('bindings.telegramNoBots')}
        </div>
      ) : (
        <div className="space-y-2">
          {bots.map((bot) => (
            <BotCard
              key={bot.id}
              bot={bot}
              expanded={expandedBotId === bot.id}
              onToggle={() => setExpandedBotId(expandedBotId === bot.id ? null : bot.id)}
              onStart={() => void handleStartBot(bot.id)}
              onStop={() => void handleStopBot(bot.id)}
              onDelete={() => void handleDeleteBot(bot.id)}
              onUpdated={loadBots}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/** 添加 Bot 表单 */
function AddBotForm({
  onAdded,
  onCancel
}: {
  onAdded: () => void
  onCancel: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [token, setToken] = useState('')
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState('')

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
    <div className="px-4 py-3 rounded-xl border border-accent/30 bg-accent/5 mb-4">
      <div className="space-y-2">
        <div>
          <div className="text-xs text-text-secondary mb-1">{t('bindings.telegramBotToken')}</div>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void handleSubmit()}
            placeholder={t('bindings.telegramBotTokenHint')}
            className="zen-input"
          />
        </div>
        {error && <div className="text-[10px] text-red-400">{error}</div>}
        <div className="flex justify-end gap-2 pt-1">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-xs rounded-lg text-text-secondary hover:bg-bg-hover transition-colors"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={() => void handleSubmit()}
            disabled={adding || !token.trim()}
            className="px-3 py-1.5 text-xs rounded-lg bg-accent text-white hover:bg-accent/90 disabled:opacity-50 transition-colors"
          >
            {adding ? t('bindings.telegramValidating') : t('common.add')}
          </button>
        </div>
      </div>
    </div>
  )
}

/** 单个 Bot 卡片 */
function BotCard({
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
    <div className="rounded-xl border border-border-primary bg-bg-secondary overflow-hidden">
      {/* 摘要行 */}
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-bg-hover transition-colors"
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-text-primary truncate">{bot.name}</span>
            {bot.username && (
              <span className="text-[10px] text-text-tertiary">@{bot.username}</span>
            )}
          </div>
          <div className="text-[10px] text-text-tertiary mt-0.5">
            {bot.boundSessionTitle
              ? t('bindings.telegramBoundTo', { title: bot.boundSessionTitle })
              : t('bindings.telegramUnbound')}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span
            className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${
              bot.running
                ? 'bg-green-500/10 text-green-500'
                : 'bg-text-tertiary/10 text-text-tertiary'
            }`}
          >
            {bot.running ? t('bindings.running') : t('bindings.stopped')}
          </span>
          {expanded ? (
            <ChevronUp size={12} className="text-text-tertiary" />
          ) : (
            <ChevronDown size={12} className="text-text-tertiary" />
          )}
        </div>
      </button>

      {/* 展开详情 */}
      {expanded && (
        <div className="px-4 pb-3 space-y-3 border-t border-border-primary/50 pt-3">
          {/* 启停按钮 */}
          <div className="flex items-center gap-2">
            {bot.running ? (
              <button
                onClick={onStop}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors"
              >
                <Square size={10} />
                {t('bindings.telegramStopBot')}
              </button>
            ) : (
              <button
                onClick={onStart}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-green-500/10 text-green-500 hover:bg-green-500/20 transition-colors"
              >
                <Play size={10} />
                {t('bindings.telegramStartBot')}
              </button>
            )}
          </div>

          {/* 允许的用户 */}
          <BotAllowedUsers bot={bot} onUpdated={onUpdated} />

          {/* 删除 */}
          <div className="pt-1 border-t border-border-primary/30">
            {confirmDelete ? (
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-red-400 flex-1">
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
                className="flex items-center gap-1 text-[10px] text-red-400 hover:text-red-300 transition-colors"
              >
                <Trash2 size={10} />
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
      <div className="text-xs text-text-secondary mb-1">
        {t('bindings.telegramEditAllowedUsers')}
      </div>
      <div className="text-[10px] text-text-tertiary mb-2">
        {t('bindings.telegramAllowedUsersHint')}
      </div>
      <div className="flex gap-2 mb-2">
        <input
          type="text"
          value={newUserId}
          onChange={(e) => setNewUserId(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void handleAddUser()}
          placeholder="User ID"
          className="zen-input flex-1"
        />
        <button
          onClick={() => void handleAddUser()}
          disabled={!newUserId.trim()}
          className="p-1.5 rounded-lg bg-accent/10 text-accent hover:bg-accent/20 disabled:opacity-50 transition-colors"
        >
          <Plus size={12} />
        </button>
      </div>
      {bot.allowedUsers.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {bot.allowedUsers.map((id) => (
            <span
              key={id}
              className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] rounded-full bg-bg-hover text-text-secondary"
            >
              {id}
              <button
                onClick={() => void handleRemoveUser(id)}
                className="text-text-tertiary hover:text-error"
              >
                <X size={8} />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
