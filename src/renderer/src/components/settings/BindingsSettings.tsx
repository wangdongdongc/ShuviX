import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Globe, Copy, X, Radio, Bot, Plug, Plus, Play, Square } from 'lucide-react'
import { copyToClipboard } from '../../utils/clipboard'
import type { Session } from '../../stores/chatStore'

/** 前端类型定义 */
interface FrontendType {
  id: string
  icon: React.ReactNode
  labelKey: string
  available: boolean
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
  const [telegramSharedIds, setTelegramSharedIds] = useState<Set<string>>(new Set())
  const [sessions, setSessions] = useState<Session[]>([])

  const reload = useCallback(async () => {
    const [shared, tgShared, allSessions] = await Promise.all([
      window.api.webui.listShared(),
      window.api.telegram.listShared(),
      window.api.session.list()
    ])
    setSharedIds(new Set(shared.map((s) => s.sessionId)))
    setTelegramSharedIds(new Set(tgShared))
    setSessions(allSessions)
  }, [])

  useEffect(() => {
    let cancelled = false
    Promise.all([
      window.api.webui.listShared(),
      window.api.telegram.listShared(),
      window.api.session.list()
    ]).then(([shared, tgShared, allSessions]) => {
      if (!cancelled) {
        setSharedIds(new Set(shared.map((s) => s.sessionId)))
        setTelegramSharedIds(new Set(tgShared))
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
    if (id === 'telegram') return telegramSharedIds.size
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
          <TelegramDetail
            sessions={sessions}
            sharedIds={telegramSharedIds}
            onBack={() => setActiveType(null)}
            onReload={reload}
          />
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

/** Telegram Bot 详情面板 */
function TelegramDetail({
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
  const [token, setToken] = useState('')
  const [validating, setValidating] = useState(false)
  const [validationResult, setValidationResult] = useState<{
    valid: boolean
    username?: string
    error?: string
  } | null>(null)
  const [botStatus, setBotStatus] = useState<{ running: boolean }>({ running: false })
  const [allowedUsers, setAllowedUsers] = useState<number[]>([])
  const [newUserId, setNewUserId] = useState('')

  useEffect(() => {
    Promise.all([
      window.api.telegram.getBotToken(),
      window.api.telegram.botStatus(),
      window.api.telegram.getAllowedUsers()
    ]).then(([savedToken, status, users]) => {
      setToken(savedToken)
      setBotStatus(status)
      setAllowedUsers(users)
    })
  }, [])

  const handleValidate = async (): Promise<void> => {
    if (!token.trim()) return
    setValidating(true)
    setValidationResult(null)
    const result = await window.api.telegram.validateToken(token.trim())
    setValidationResult(result)
    setValidating(false)
  }

  const handleSaveToken = async (): Promise<void> => {
    await window.api.telegram.setBotToken(token.trim())
    const status = await window.api.telegram.botStatus()
    setBotStatus(status)
  }

  const handleStartBot = async (): Promise<void> => {
    await window.api.telegram.startBot()
    const status = await window.api.telegram.botStatus()
    setBotStatus(status)
  }

  const handleStopBot = async (): Promise<void> => {
    await window.api.telegram.stopBot()
    const status = await window.api.telegram.botStatus()
    setBotStatus(status)
  }

  const handleAddUser = async (): Promise<void> => {
    const id = parseInt(newUserId.trim())
    if (isNaN(id) || allowedUsers.includes(id)) return
    const updated = [...allowedUsers, id]
    await window.api.telegram.setAllowedUsers(updated)
    setAllowedUsers(updated)
    setNewUserId('')
  }

  const handleRemoveUser = async (userId: number): Promise<void> => {
    const updated = allowedUsers.filter((id) => id !== userId)
    await window.api.telegram.setAllowedUsers(updated)
    setAllowedUsers(updated)
  }

  const handleRemoveShare = async (sessionId: string): Promise<void> => {
    await window.api.telegram.setShared({ sessionId, shared: false })
    onReload()
  }

  const sharedSessions = sessions.filter((s) => sharedIds.has(s.id))

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
        <Bot size={16} className="text-text-secondary" />
        <h3 className="text-sm font-semibold text-text-primary">{t('bindings.telegram')}</h3>
      </div>

      {/* Bot Token */}
      <div className="px-4 py-3 rounded-xl border border-border-primary bg-bg-secondary mb-4">
        <div className="text-xs text-text-secondary mb-2">{t('bindings.telegramBotToken')}</div>
        <div className="flex gap-2 mb-1">
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={t('bindings.telegramBotTokenHint')}
            className="flex-1 px-2.5 py-1.5 text-xs rounded-lg border border-border-primary bg-bg-primary text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent"
          />
          <button
            onClick={() => void handleValidate()}
            disabled={validating || !token.trim()}
            className="px-3 py-1.5 text-xs rounded-lg bg-accent/10 text-accent hover:bg-accent/20 disabled:opacity-50 transition-colors"
          >
            {validating ? t('bindings.telegramValidating') : t('bindings.telegramValidate')}
          </button>
        </div>
        {validationResult && (
          <div
            className={`text-[10px] mb-1 ${validationResult.valid ? 'text-green-500' : 'text-red-400'}`}
          >
            {validationResult.valid
              ? t('bindings.telegramTokenValid', { username: validationResult.username })
              : `${t('bindings.telegramTokenInvalid')}: ${validationResult.error || ''}`}
          </div>
        )}
        <button
          onClick={() => void handleSaveToken()}
          disabled={!token.trim()}
          className="text-[10px] text-accent hover:underline disabled:opacity-50"
        >
          {t('common.save')}
        </button>
      </div>

      {/* Bot 状态 */}
      <div className="px-4 py-3 rounded-xl border border-border-primary bg-bg-secondary mb-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs text-text-secondary">{t('bindings.telegramBotStatus')}</div>
            <div
              className={`text-[10px] mt-0.5 ${botStatus.running ? 'text-green-500' : 'text-text-tertiary'}`}
            >
              {botStatus.running ? t('bindings.running') : t('bindings.stopped')}
            </div>
          </div>
          {botStatus.running ? (
            <button
              onClick={() => void handleStopBot()}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors"
            >
              <Square size={10} />
              {t('bindings.telegramStopBot')}
            </button>
          ) : (
            <button
              onClick={() => void handleStartBot()}
              disabled={!token.trim()}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-green-500/10 text-green-500 hover:bg-green-500/20 disabled:opacity-50 transition-colors"
            >
              <Play size={10} />
              {t('bindings.telegramStartBot')}
            </button>
          )}
        </div>
      </div>

      {/* 允许的用户 */}
      <div className="px-4 py-3 rounded-xl border border-border-primary bg-bg-secondary mb-4">
        <div className="text-xs text-text-secondary mb-1">{t('bindings.telegramAllowedUsers')}</div>
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
            className="flex-1 px-2.5 py-1.5 text-xs rounded-lg border border-border-primary bg-bg-primary text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent"
          />
          <button
            onClick={() => void handleAddUser()}
            disabled={!newUserId.trim()}
            className="p-1.5 rounded-lg bg-accent/10 text-accent hover:bg-accent/20 disabled:opacity-50 transition-colors"
          >
            <Plus size={12} />
          </button>
        </div>
        {allowedUsers.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {allowedUsers.map((id) => (
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

      {/* 已绑定会话列表 */}
      <div>
        <h4 className="text-xs font-medium text-text-secondary mb-2">
          {t('bindings.telegramBoundSessions')} ({sharedSessions.length})
        </h4>
        {sharedSessions.length === 0 ? (
          <div className="text-center py-6 text-text-tertiary text-xs">
            {t('bindings.telegramNoSessionsHint')}
          </div>
        ) : (
          <div className="space-y-2">
            {sharedSessions.map((s) => (
              <div
                key={s.id}
                className="px-3 py-2.5 rounded-lg border border-border-primary bg-bg-secondary"
              >
                <div className="flex items-center justify-between">
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
                <div className="text-[10px] text-text-tertiary mt-0.5 font-mono">
                  {s.id.slice(0, 8)}...
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
