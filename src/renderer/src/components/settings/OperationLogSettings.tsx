import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Trash2, RefreshCw, ChevronDown, ChevronRight } from 'lucide-react'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { SessionPicker } from '../common/SessionPicker'

/** action → badge 颜色映射 */
const ACTION_COLORS: Record<string, string> = {
  prompt: 'bg-blue-500/20 text-blue-400',
  abort: 'bg-red-500/20 text-red-400',
  initAgent: 'bg-cyan-500/20 text-cyan-400',
  setModel: 'bg-purple-500/20 text-purple-400',
  setThinkingLevel: 'bg-amber-500/20 text-amber-400',
  setEnabledTools: 'bg-teal-500/20 text-teal-400',
  approveToolCall: 'bg-green-500/20 text-green-400',
  destroyDocker: 'bg-orange-500/20 text-orange-400',
  disconnectSsh: 'bg-orange-500/20 text-orange-400'
}

/** 解析 sourceDetail JSON 为可展示的键值对 */
function parseSourceDetail(
  sourceType: string,
  sourceDetail: string | null
): Array<{ label: string; value: string }> {
  if (!sourceDetail) return []
  try {
    const obj = JSON.parse(sourceDetail)
    if (sourceType === 'webui') {
      const pairs: Array<{ label: string; value: string }> = []
      if (obj.ip) pairs.push({ label: 'IP', value: obj.ip })
      if (obj.userAgent) pairs.push({ label: 'UA', value: obj.userAgent })
      return pairs
    }
    if (sourceType === 'telegram') {
      const pairs: Array<{ label: string; value: string }> = []
      if (obj.botId) pairs.push({ label: 'Bot', value: obj.botId })
      if (obj.userId) pairs.push({ label: 'User', value: obj.userId })
      if (obj.chatId) pairs.push({ label: 'Chat', value: obj.chatId })
      return pairs
    }
    return Object.entries(obj).map(([k, v]) => ({ label: k, value: String(v) }))
  } catch {
    return []
  }
}

type LogSummary = {
  id: string
  action: string
  sessionId: string | null
  sessionTitle: string
  sourceType: string
  sourceDetail: string | null
  summary: string
  createdAt: number
}

/** 格式化时间为紧凑格式 */
function formatTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** 使用日志设置 — 紧凑平铺布局 */
export function OperationLogSettings(): React.JSX.Element {
  const { t } = useTranslation()
  const [logs, setLogs] = useState<LogSummary[]>([])
  const [loadingList, setLoadingList] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [showClearConfirm, setShowClearConfirm] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [expandedDetail, setExpandedDetail] = useState<{
    detail: string | null
    requestId: string
  } | null>(null)
  const [filterSessionId, setFilterSessionId] = useState<string>('')
  const [filterSourceType, setFilterSourceType] = useState<string>('')
  const [filterAction, setFilterAction] = useState<string>('')

  const loadLogs = async (filters?: {
    sessionId?: string
    sourceType?: string
    action?: string
  }): Promise<void> => {
    setLoadingList(true)
    try {
      const rows = await window.api.operationLog.list({
        limit: 300,
        ...(filters?.sessionId ? { sessionId: filters.sessionId } : {}),
        ...(filters?.sourceType ? { sourceType: filters.sourceType } : {}),
        ...(filters?.action ? { action: filters.action } : {})
      })
      setLogs(rows)
    } finally {
      setLoadingList(false)
    }
  }

  const toggleExpand = async (id: string): Promise<void> => {
    if (expandedId === id) {
      setExpandedId(null)
      setExpandedDetail(null)
      return
    }
    setExpandedId(id)
    const detail = await window.api.operationLog.get(id)
    if (detail) {
      setExpandedDetail({ detail: detail.detail, requestId: detail.requestId })
    }
  }

  const handleClearRequest = (): void => setShowClearConfirm(true)
  const handleClearConfirm = async (): Promise<void> => {
    setShowClearConfirm(false)
    setClearing(true)
    try {
      await window.api.operationLog.clear()
      setLogs([])
      setExpandedId(null)
      setExpandedDetail(null)
    } finally {
      setClearing(false)
    }
  }

  const currentFilters = useMemo(
    () => ({
      sessionId: filterSessionId || undefined,
      sourceType: filterSourceType || undefined,
      action: filterAction || undefined
    }),
    [filterSessionId, filterSourceType, filterAction]
  )

  const actionOptions = useMemo(() => {
    const set = new Set<string>()
    logs.forEach((l) => set.add(l.action))
    return Array.from(set).sort()
  }, [logs])

  useEffect(() => {
    loadLogs()
  }, [])

  useEffect(() => {
    loadLogs(currentFilters)
  }, [filterSessionId, filterSourceType, filterAction])

  return (
    <div className="h-full flex flex-col">
      {/* 标题 + 筛选 + 操作按钮 */}
      <div className="px-5 py-4 border-b border-border-secondary space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-text-primary">
              {t('settings.operationLogTitle')}
            </h3>
            <p className="text-[11px] text-text-tertiary mt-1">
              {t('settings.operationLogDesc')}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => loadLogs(currentFilters)}
              disabled={loadingList}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-md border border-border-primary text-text-secondary hover:text-text-primary hover:bg-bg-hover disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
            >
              <RefreshCw size={12} className={loadingList ? 'animate-spin' : ''} />
              {t('common.refresh')}
            </button>
            <button
              onClick={handleClearRequest}
              disabled={clearing || logs.length === 0}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-md border border-danger/30 text-danger hover:bg-danger/10 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
            >
              <Trash2 size={12} />
              {t('common.clear')}
            </button>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <SessionPicker value={filterSessionId} onChange={setFilterSessionId} />
          <select
            value={filterSourceType}
            onChange={(e) => setFilterSourceType(e.target.value)}
            className="bg-bg-tertiary border border-border-primary rounded-md px-2 py-1.5 text-[11px] text-text-primary outline-none focus:border-accent/50 transition-colors appearance-none cursor-pointer max-w-[140px]"
          >
            <option value="">{t('settings.allSources')}</option>
            <option value="electron">Electron</option>
            <option value="webui">WebUI</option>
            <option value="telegram">Telegram</option>
          </select>
          <select
            value={filterAction}
            onChange={(e) => setFilterAction(e.target.value)}
            className="bg-bg-tertiary border border-border-primary rounded-md px-2 py-1.5 text-[11px] text-text-primary outline-none focus:border-accent/50 transition-colors appearance-none cursor-pointer max-w-[160px]"
          >
            <option value="">{t('settings.allActions')}</option>
            {actionOptions.map((a) => (
              <option key={a} value={a}>
                {t(`settings.opAction.${a}`, a)}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* 日志列表 — 紧凑平铺 */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {logs.length === 0 ? (
          <div className="px-5 py-8 text-xs text-text-tertiary text-center">
            {t('settings.noLogs')}
          </div>
        ) : (
          <div className="divide-y divide-border-secondary">
            {logs.map((log) => {
              const colorClass = ACTION_COLORS[log.action] || 'bg-gray-500/20 text-gray-400'
              const isExpanded = expandedId === log.id
              const sourceDetails = parseSourceDetail(log.sourceType, log.sourceDetail)
              const hasExpandable = sourceDetails.length > 0

              return (
                <div key={log.id} className="group">
                  {/* 主行 */}
                  <div
                    className={`flex items-center gap-3 px-5 py-2 text-xs hover:bg-bg-hover/50 transition-colors ${hasExpandable ? 'cursor-pointer' : ''}`}
                    onClick={() => hasExpandable && toggleExpand(log.id)}
                  >
                    {/* 展开箭头 — 仅有额外详情时显示 */}
                    <div className="w-3 flex-shrink-0">
                      {hasExpandable &&
                        (isExpanded ? (
                          <ChevronDown size={10} className="text-text-tertiary" />
                        ) : (
                          <ChevronRight size={10} className="text-text-tertiary" />
                        ))}
                    </div>

                    {/* 时间 */}
                    <span className="text-[11px] text-text-tertiary flex-shrink-0 tabular-nums w-[110px]">
                      {formatTime(log.createdAt)}
                    </span>

                    {/* Action badge */}
                    <span
                      className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium flex-shrink-0 min-w-[56px] text-center ${colorClass}`}
                    >
                      {t(`settings.opAction.${log.action}`, log.action)}
                    </span>

                    {/* 来源 */}
                    <span className="text-[11px] text-text-tertiary flex-shrink-0 w-[52px]">
                      {log.sourceType !== 'electron' ? log.sourceType : ''}
                    </span>

                    {/* 会话名 */}
                    <span className="text-[11px] text-text-secondary flex-shrink-0 max-w-[120px] truncate">
                      {log.sessionTitle || '—'}
                    </span>

                    {/* Summary */}
                    <span className="text-[11px] text-text-primary truncate min-w-0 flex-1">
                      {log.summary}
                    </span>
                  </div>

                  {/* 展开的详情行 */}
                  {isExpanded && (
                    <div className="px-5 pb-2 pl-[34px]">
                      <div className="bg-bg-tertiary rounded-md px-3 py-2 text-[11px] space-y-1">
                        {sourceDetails.map((item, i) => (
                          <div key={i} className="flex gap-2">
                            <span className="text-text-tertiary flex-shrink-0">
                              {item.label}:
                            </span>
                            <span className="text-text-secondary break-all">{item.value}</span>
                          </div>
                        ))}
                        {expandedDetail?.detail && (
                          <div className="flex gap-2">
                            <span className="text-text-tertiary flex-shrink-0">
                              {t('settings.opDetail')}:
                            </span>
                            <span className="text-text-secondary break-all">
                              {expandedDetail.detail}
                            </span>
                          </div>
                        )}
                        {expandedDetail?.requestId && (
                          <div className="flex gap-2">
                            <span className="text-text-tertiary flex-shrink-0">Request ID:</span>
                            <span className="text-text-secondary">{expandedDetail.requestId}</span>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {showClearConfirm && (
        <ConfirmDialog
          title={t('settings.clearLogsConfirm')}
          confirmText={t('common.clear')}
          cancelText={t('common.cancel')}
          onConfirm={handleClearConfirm}
          onCancel={() => setShowClearConfirm(false)}
        />
      )}
    </div>
  )
}
