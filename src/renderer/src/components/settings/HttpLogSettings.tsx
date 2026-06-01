import { useState, useEffect, useMemo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Trash2, RefreshCw, FileText } from 'lucide-react'
import { PayloadViewer } from './PayloadViewer'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { SessionPicker } from '../common/SessionPicker'
import { ZenSelect } from '../common/ZenSelect'

/** 列表查询上限（与界面提示一致） */
const LOG_LIST_LIMIT = 100

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

/** LLM 日志设置（双列：左侧筛选+列表，右侧详情） */
export function HttpLogSettings(): React.JSX.Element {
  const { t } = useTranslation()
  const [logs, setLogs] = useState<LogSummary[]>([])
  const [selectedLogId, setSelectedLogId] = useState<string | null>(null)
  const [selectedLog, setSelectedLog] = useState<LogDetail | null>(null)
  const [loadingList, setLoadingList] = useState(false)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [showClearConfirm, setShowClearConfirm] = useState(false)
  const [providers, setProviders] = useState<Array<{ id: string; name: string }>>([])
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

  /** 加载日志列表 */
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
        setSelectedLogId((prev) => {
          if (rows.length === 0) return null
          if (prev && rows.some((row) => row.id === prev)) return prev
          return rows[0].id
        })
        if (rows.length === 0) setSelectedLog(null)
      } finally {
        setLoadingList(false)
      }
    },
    []
  )

  /** 加载日志详情 */
  const loadLogDetail = useCallback(async (id: string): Promise<void> => {
    setLoadingDetail(true)
    try {
      const detail = await window.api.httpLog.get(id)
      setSelectedLog(detail || null)
    } finally {
      setLoadingDetail(false)
    }
  }, [])

  /** 清空日志 */
  const handleClearConfirm = async (): Promise<void> => {
    setShowClearConfirm(false)
    setClearing(true)
    try {
      await window.api.httpLog.clear()
      setLogs([])
      setSelectedLogId(null)
      setSelectedLog(null)
    } finally {
      setClearing(false)
    }
  }

  /** 从已加载日志中提取去重的模型列表（用于筛选下拉） */
  const modelOptions = useMemo(() => {
    const set = new Set<string>()
    logs.forEach((l) => set.add(l.model))
    return Array.from(set).sort()
  }, [logs])

  useEffect(() => {
    void loadProviders()
  }, [loadProviders])

  /** 筛选条件改变时重新加载 */
  useEffect(() => {
    void loadLogs(currentFilters)
  }, [loadLogs, currentFilters])

  useEffect(() => {
    if (selectedLogId) {
      void loadLogDetail(selectedLogId)
    } else {
      setSelectedLog(null)
    }
  }, [selectedLogId, loadLogDetail])

  const selectedSummary = useMemo(
    () => logs.find((l) => l.id === selectedLogId) ?? null,
    [logs, selectedLogId]
  )

  return (
    <div className="flex flex-1 min-h-0 h-full">
      {/* 左列：筛选 + 列表 + 底栏 */}
      <div className="w-[260px] flex-shrink-0 border-r border-border-secondary flex flex-col">
        {/* 筛选器 */}
        <div className="px-3 py-3 border-b border-border-secondary space-y-1.5">
          <SessionPicker value={filterSessionId} onChange={setFilterSessionId} />
          <ZenSelect
            value={filterProvider}
            onChange={(v) => {
              setFilterProvider(v)
              setFilterModel('')
            }}
            placeholder={t('settings.allProviders')}
            options={providers.map((p) => ({ value: p.id, label: p.name }))}
          />
          <ZenSelect
            value={filterModel}
            onChange={setFilterModel}
            placeholder={t('settings.allModels')}
            options={modelOptions.map((m) => ({ value: m, label: m }))}
          />
        </div>

        {/* 日志列表 */}
        <div className="flex-1 overflow-y-auto py-2 px-2 space-y-0.5">
          {loadingList && logs.length === 0 ? (
            <div className="px-2 py-4 text-[11px] text-text-tertiary">
              {t('settings.loadingLog')}
            </div>
          ) : logs.length === 0 ? (
            <div className="px-2 py-4 text-[11px] text-text-tertiary">{t('settings.noLogs')}</div>
          ) : (
            logs.map((log) => {
              const active = selectedLogId === log.id
              return (
                <button
                  key={log.id}
                  onClick={() => setSelectedLogId(log.id)}
                  className={`group w-full flex flex-col gap-0.5 px-2 py-1.5 rounded-lg text-left transition-colors ${
                    active
                      ? 'bg-accent/10 text-accent'
                      : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
                  }`}
                >
                  <div className="text-[11px] font-medium tabular-nums">
                    {formatTime(log.createdAt)}
                  </div>
                  <div
                    className={`text-[10px] truncate ${
                      active ? 'text-accent/80' : 'text-text-tertiary'
                    }`}
                  >
                    {log.providerName || log.provider} · {log.model}
                  </div>
                </button>
              )
            })
          )}
        </div>

        {/* 底栏：数量 + 刷新 + 清空 */}
        <div className="border-t border-border-secondary px-3 py-2 flex items-center justify-between gap-2">
          <span className="text-[10px] text-text-tertiary tabular-nums truncate">
            {t('settings.httpLogLimitHint', { shown: logs.length, limit: LOG_LIST_LIMIT })}
          </span>
          <div className="flex items-center gap-1 shrink-0">
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
              disabled={clearing || logs.length === 0}
              title={t('common.clear')}
              className="inline-flex items-center justify-center w-6 h-6 rounded-md text-text-tertiary hover:text-danger hover:bg-danger/10 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <Trash2 size={12} />
            </button>
          </div>
        </div>
      </div>

      {/* 右列：详情 */}
      <div className="flex-1 min-w-0 overflow-y-auto">
        {!selectedLogId ? (
          <EmptyState text={t('settings.selectLogHint')} />
        ) : loadingDetail && !selectedLog ? (
          <EmptyState text={t('settings.loadingLog')} />
        ) : !selectedLog ? (
          <EmptyState text={t('settings.logNotFound')} />
        ) : (
          <LogDetailPanel summary={selectedSummary} detail={selectedLog} />
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
// 子组件
// ────────────────────────────────────────────────────────────────

function EmptyState({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-2 text-text-tertiary px-6">
      <FileText size={28} className="opacity-40" />
      <span className="text-[11px]">{text}</span>
    </div>
  )
}

function LogDetailPanel({
  summary,
  detail
}: {
  summary: LogSummary | null
  detail: LogDetail
}): React.JSX.Element {
  const { t } = useTranslation()
  const sessionTitle = summary?.sessionTitle?.trim() || t('settings.unknownSession')
  const providerName = summary?.providerName || summary?.provider || detail.provider

  const hasTokens = !!summary && summary.totalTokens > 0

  return (
    <div className="flex flex-col">
      {/* 头部：时间 / 会话 / provider·model / tokens */}
      <div className="px-5 py-3 border-b border-border-secondary">
        <h3 className="text-sm font-semibold text-text-primary tabular-nums truncate">
          {formatTime(detail.createdAt)}
        </h3>
        <div className="mt-1 flex items-center gap-3 flex-wrap text-[11px] text-text-tertiary">
          <span className="truncate max-w-[260px]">{sessionTitle}</span>
          <span className="opacity-40">·</span>
          <span className="font-mono text-text-secondary">
            {providerName}
            <span className="text-text-tertiary"> / </span>
            {detail.model}
          </span>
          {hasTokens && (
            <>
              <span className="opacity-40">·</span>
              <span className="tabular-nums">
                <span className="text-text-secondary">{summary!.totalTokens.toLocaleString()}</span>
                <span className="ml-1">tk</span>
                <span className="ml-2 opacity-70">
                  ↑ {summary!.inputTokens.toLocaleString()} · ↓{' '}
                  {summary!.outputTokens.toLocaleString()}
                </span>
              </span>
            </>
          )}
        </div>
      </div>

      {/* 主体：payload */}
      <div className="flex-1 px-5 py-5">
        <PayloadViewer payload={detail.payload} response={detail.response} />
      </div>
    </div>
  )
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString()
}
