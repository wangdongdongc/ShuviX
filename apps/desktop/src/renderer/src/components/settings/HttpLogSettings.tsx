/**
 * LLM 请求日志（监视器 tab 的子页）—— **单列流 + 就地展开**，没有第二个可滚动区。
 *
 * 早先是 260 列表列 + 右详情：监视器把一级 tab 列之外的宽度压到 ~640 后，正文只剩 380，
 * 而 payload 恰恰是整段系统提示词 + 全历史 + 工具定义。故列表列整个退役，宽度全给正文；
 * 选中态换成手风琴（同时只展开一条），展开的行头 sticky 在工具栏下沿。
 */
import { useState, useEffect, useMemo, useCallback } from 'react'
import { Trash2, RefreshCw, FileText, ChevronRight, ChevronDown, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { PayloadViewer } from './PayloadViewer'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { SessionPicker } from '../common/SessionPicker'
import { ZenSelect } from '../common/ZenSelect'
import { Toggle } from './SettingsPrimitives'

/** 列表查询上限（与界面提示一致） */
const LOG_LIST_LIMIT = 100

/** 记录开关的设置 key（与主进程 httpLogService 一致；缺省即关闭） */
const ENABLED_KEY = 'httpLog.enabled'

/** 体积标红阈值：占本页最大请求的一半以上，且绝对值够大（小库里没有「异常」可言） */
const LARGE_RATIO = 0.5
const LARGE_MIN_BYTES = 100 * 1024

interface LogSummary {
  id: string
  sessionId: string
  sessionTitle: string
  provider: string
  providerName: string
  model: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
  /** 请求体字节数（列表直出）—— token 是模型口径，体积是「库为什么胀」的口径 */
  payloadBytes: number
  createdAt: number
}

interface LogDetail {
  id: string
  sessionId: string
  provider: string
  model: string
  payload: string
  response: string
  createdAt: number
}

export function HttpLogSettings(): React.JSX.Element {
  const { t } = useTranslation()
  const [logs, setLogs] = useState<LogSummary[]>([])
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<LogDetail | null>(null)
  const [loadingList, setLoadingList] = useState(false)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [showClearConfirm, setShowClearConfirm] = useState(false)
  const [providers, setProviders] = useState<Array<{ id: string; name: string }>>([])
  // null = 尚未读到设置：此时不宣称任何一态，避免开着记录却先闪一帧「记录已关闭」
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [filterSessionId, setFilterSessionId] = useState<string>('')
  const [filterProvider, setFilterProvider] = useState<string>('')
  const [filterModel, setFilterModel] = useState<string>('')

  /** 当前筛选参数 */
  const currentFilters = useMemo(
    () => ({
      sessionId: filterSessionId || undefined,
      provider: filterProvider || undefined,
      model: filterModel || undefined
    }),
    [filterSessionId, filterProvider, filterModel]
  )

  /** 加载提供商列表（用于筛选下拉） */
  const loadProviders = useCallback(async (): Promise<void> => {
    const list = await window.api.provider.listAll()
    setProviders(list.map((p) => ({ id: p.id, name: p.name })))
  }, [])

  /** 加载记录开关（缺省即关闭） */
  const loadEnabled = useCallback(async (): Promise<void> => {
    const value = await window.api.settings.get(ENABLED_KEY)
    setEnabled(value === 'true')
  }, [])

  /** 切换记录开关（主进程每次请求实时读取，立即生效） */
  const handleToggleEnabled = (): void => {
    const next = enabled !== true
    setEnabled(next)
    void window.api.settings.set({ key: ENABLED_KEY, value: String(next) })
  }

  /** 加载日志列表；展开的那条若被筛掉则收起 */
  const loadLogs = useCallback(
    async (filters?: { sessionId?: string; provider?: string; model?: string }): Promise<void> => {
      setLoadingList(true)
      try {
        const rows = await window.api.httpLog.list({
          limit: LOG_LIST_LIMIT,
          ...(filters?.sessionId ? { sessionId: filters.sessionId } : {}),
          ...(filters?.provider ? { provider: filters.provider } : {}),
          ...(filters?.model ? { model: filters.model } : {})
        })
        setLogs(rows)
        setExpandedId((prev) => (prev && rows.some((row) => row.id === prev) ? prev : null))
      } finally {
        setLoadingList(false)
      }
    },
    []
  )

  /** 展开/收起一条（手风琴：同时只展开一条） */
  const toggleRow = async (id: string): Promise<void> => {
    if (expandedId === id) {
      setExpandedId(null)
      setDetail(null)
      return
    }
    setExpandedId(id)
    setDetail(null)
    setLoadingDetail(true)
    try {
      const row = await window.api.httpLog.get(id)
      setDetail(row || null)
    } finally {
      setLoadingDetail(false)
    }
  }

  /** 清空日志 */
  const handleClearConfirm = async (): Promise<void> => {
    setShowClearConfirm(false)
    await window.api.httpLog.clear()
    setLogs([])
    setExpandedId(null)
    setDetail(null)
  }

  /** 从已加载日志中提取去重的模型列表（用于筛选下拉） */
  const modelOptions = useMemo(() => {
    const set = new Set<string>()
    logs.forEach((l) => set.add(l.model))
    return Array.from(set).sort()
  }, [logs])

  /** 体积标红的绝对阈值（相对本页最大值） */
  const largeThreshold = useMemo(() => {
    const max = Math.max(0, ...logs.map((l) => l.payloadBytes ?? 0))
    return Math.max(LARGE_MIN_BYTES, max * LARGE_RATIO)
  }, [logs])

  useEffect(() => {
    void loadProviders()
    void loadEnabled()
  }, [loadProviders, loadEnabled])

  /** 筛选条件改变时重新加载 */
  useEffect(() => {
    void loadLogs(currentFilters)
  }, [loadLogs, currentFilters])

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* 工具栏：筛选 + 记录开关 + 刷新 + 清空 */}
      <div
        data-monitor-toolbar
        className="flex-shrink-0 flex items-center gap-2 px-3 py-2 border-b border-border-secondary"
      >
        <div className="flex-1 min-w-0 max-w-[140px]">
          <SessionPicker value={filterSessionId} onChange={setFilterSessionId} />
        </div>
        <div className="flex-1 min-w-0 max-w-[110px]">
          <ZenSelect
            value={filterProvider}
            onChange={(v) => {
              setFilterProvider(v)
              setFilterModel('')
            }}
            placeholder={t('settings.allProviders')}
            options={providers.map((p) => ({ value: p.id, label: p.name }))}
          />
        </div>
        <div className="flex-1 min-w-0 max-w-[110px]">
          <ZenSelect
            value={filterModel}
            onChange={setFilterModel}
            placeholder={t('settings.allModels')}
            options={modelOptions.map((m) => ({ value: m, label: m }))}
          />
        </div>

        <div className="ml-auto flex items-center gap-1.5 shrink-0">
          {/* 窄窗（minWidth 600）下让位给按钮，标签藏起来、语义交给 title */}
          <span className="hidden sm:inline text-[10px] text-text-tertiary">
            {t('settings.httpLogRecord')}
          </span>
          <span className="inline-flex" title={t('settings.httpLogEnabled')}>
            <Toggle on={enabled === true} onClick={handleToggleEnabled} />
          </span>
          <button
            onClick={() => loadLogs(currentFilters)}
            disabled={loadingList}
            title={t('common.refresh')}
            className="inline-flex items-center justify-center w-6 h-6 rounded-md text-text-tertiary hover:text-text-primary hover:bg-bg-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <RefreshCw size={12} className={loadingList ? 'animate-spin' : ''} />
          </button>
          <button
            onClick={() => setShowClearConfirm(true)}
            disabled={logs.length === 0}
            title={t('common.clear')}
            className="inline-flex items-center justify-center w-6 h-6 rounded-md text-text-tertiary hover:text-error hover:bg-error/10 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>

      {/* 记录状态：恒占一行 —— 关着要说明为什么没数据，开着要提醒库在涨 */}
      {enabled !== null && (
        <div
          data-monitor-status
          className={`flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 border-b border-border-secondary/50 text-[10px] leading-relaxed ${
            enabled ? 'text-amber-500/80' : 'text-text-tertiary'
          }`}
        >
          <span
            className={`w-1.5 h-1.5 rounded-full shrink-0 ${enabled ? 'bg-amber-500' : 'bg-text-tertiary/40'}`}
          />
          {enabled ? t('settings.httpLogRecordingHint') : t('settings.httpLogDisabledHint')}
        </div>
      )}

      {/* 单列流 */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {loadingList && logs.length === 0 ? (
          <EmptyState text={t('settings.loadingLog')} />
        ) : logs.length === 0 ? (
          <EmptyState text={t('settings.noLogs')} />
        ) : (
          <>
            {logs.map((log) => {
              const open = expandedId === log.id
              return (
                <div
                  key={log.id}
                  data-log-id={log.id}
                  className="border-b border-border-secondary/30"
                >
                  <button
                    onClick={() => void toggleRow(log.id)}
                    className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-[11px] text-left transition-colors ${
                      open
                        ? 'sticky top-0 z-10 bg-bg-secondary text-text-primary'
                        : 'hover:bg-bg-hover/40'
                    }`}
                  >
                    {open ? (
                      <ChevronDown size={12} className="shrink-0 text-text-secondary" />
                    ) : (
                      <ChevronRight size={12} className="shrink-0 text-text-tertiary" />
                    )}
                    <span className="shrink-0 tabular-nums text-text-primary">
                      {formatTime(log.createdAt)}
                    </span>
                    <span className="flex-1 min-w-0 truncate text-text-secondary">
                      {log.sessionTitle?.trim() || t('settings.unknownSession')}
                    </span>
                    <span className="shrink-0 max-w-[150px] truncate text-text-tertiary">
                      {log.model}
                    </span>
                    <span className="shrink-0 w-[62px] text-right tabular-nums text-text-secondary">
                      ↑ {formatCount(log.inputTokens)}
                    </span>
                    <span
                      className={`shrink-0 w-[56px] text-right tabular-nums ${
                        log.payloadBytes >= largeThreshold ? 'text-error' : 'text-text-tertiary'
                      }`}
                    >
                      {formatBytes(log.payloadBytes)}
                    </span>
                  </button>

                  {open && (
                    <div className="px-3 pb-5 pt-2 bg-bg-tertiary/10">
                      {loadingDetail && !detail ? (
                        <div className="flex items-center gap-2 py-6 justify-center text-text-tertiary">
                          <Loader2 size={14} className="animate-spin" />
                          <span className="text-[11px]">{t('settings.loadingLog')}</span>
                        </div>
                      ) : !detail ? (
                        <div className="py-6 text-center text-[11px] text-text-tertiary">
                          {t('settings.logNotFound')}
                        </div>
                      ) : (
                        <>
                          <div className="mb-2 flex items-center gap-2 flex-wrap text-[10px] text-text-tertiary">
                            <span className="font-mono text-text-secondary">
                              {log.providerName || log.provider}
                            </span>
                            {log.totalTokens > 0 && (
                              <span className="tabular-nums">
                                ↑ {log.inputTokens.toLocaleString()} · ↓{' '}
                                {log.outputTokens.toLocaleString()} ·{' '}
                                {log.totalTokens.toLocaleString()} tk
                              </span>
                            )}
                          </div>
                          <PayloadViewer payload={detail.payload} response={detail.response} />
                        </>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
            <div className="px-3 py-2 text-center text-[10px] text-text-tertiary tabular-nums">
              {t('settings.httpLogLimitHint', { shown: logs.length, limit: LOG_LIST_LIMIT })}
            </div>
          </>
        )}
      </div>

      {/* 清空确认 */}
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

// ────────────────────────────────────────────────────────────────
// 子组件 / 格式化
// ────────────────────────────────────────────────────────────────

function EmptyState({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-2 text-text-tertiary px-6">
      <FileText size={28} className="opacity-40" />
      <span className="text-[11px]">{text}</span>
    </div>
  )
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 1234 → 1.2k（token 数在行里只需量级） */
function formatCount(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

function formatBytes(bytes: number): string {
  if (!bytes) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
