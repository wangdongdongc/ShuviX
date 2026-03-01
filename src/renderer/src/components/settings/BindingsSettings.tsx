import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Globe, Copy, X, Radio, Bot, Plug } from 'lucide-react'
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
  const [sessions, setSessions] = useState<Session[]>([])

  const reload = useCallback(async () => {
    const [shared, allSessions] = await Promise.all([
      window.api.webui.listShared(),
      window.api.session.list()
    ])
    setSharedIds(new Set(shared))
    setSessions(allSessions)
  }, [])

  useEffect(() => {
    let cancelled = false
    Promise.all([window.api.webui.listShared(), window.api.session.list()]).then(
      ([shared, allSessions]) => {
        if (!cancelled) {
          setSharedIds(new Set(shared))
          setSessions(allSessions)
        }
      }
    )
    return () => {
      cancelled = true
    }
  }, [])

  const frontendTypes: FrontendType[] = [
    { id: 'webui', icon: <Globe size={16} />, labelKey: 'bindings.webui', available: true },
    { id: 'telegram', icon: <Bot size={16} />, labelKey: 'bindings.telegram', available: false },
    { id: 'websocket', icon: <Plug size={16} />, labelKey: 'bindings.websocket', available: false }
  ]

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
                sharedCount={ft.id === 'webui' ? sharedIds.size : 0}
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
    navigator.clipboard.writeText(url)
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
