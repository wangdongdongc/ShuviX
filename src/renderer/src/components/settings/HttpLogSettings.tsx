import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Trash2, RefreshCw } from 'lucide-react'
import { PayloadViewer } from './PayloadViewer'
import { ConfirmDialog } from '../common/ConfirmDialog'

/** HTTP 日志设置 */
export function HttpLogSettings(): React.JSX.Element {
  const { t } = useTranslation()
  const [logs, setLogs] = useState<
    Array<{
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
    }>
  >([])
  const [selectedLogId, setSelectedLogId] = useState<string | null>(null)
  const [selectedLog, setSelectedLog] = useState<{
    id: string
    sessionId: string
    provider: string
    model: string
    payload: string
    response: string
    createdAt: number
  } | null>(null)
  const [loadingList, setLoadingList] = useState(false)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [showClearConfirm, setShowClearConfirm] = useState(false)
  const [sessions, setSessions] = useState<Array<{ id: string; title: string }>>([])
  const [providers, setProviders] = useState<Array<{ id: string; name: string }>>([])
  const [filterSessionId, setFilterSessionId] = useState<string>('')
  const [filterProvider, setFilterProvider] = useState<string>('')
  const [filterModel, setFilterModel] = useState<string>('')

  /** 加载会话列表（用于筛选下拉） */
  const loadSessions = async (): Promise<void> => {
    const list = await window.api.session.list()
    setSessions(list.map((s) => ({ id: s.id, title: s.title })))
  }

  /** 加载提供商列表（用于筛选下拉） */
  const loadProviders = async (): Promise<void> => {
    const list = await window.api.provider.listAll()
    setProviders(list.map((p) => ({ id: p.id, name: p.name })))
  }

  /** 加载日志列表 */
  const loadLogs = async (filters?: {
    sessionId?: string
    provider?: string
    model?: string
  }): Promise<void> => {
    setLoadingList(true)
    try {
      const rows = await window.api.httpLog.list({
        limit: 300,
        ...(filters?.sessionId ? { sessionId: filters.sessionId } : {}),
        ...(filters?.provider ? { provider: filters.provider } : {}),
        ...(filters?.model ? { model: filters.model } : {})
      })
      setLogs(rows)
      if (rows.length === 0) {
        setSelectedLogId(null)
        setSelectedLog(null)
      } else if (!selectedLogId || !rows.some((row) => row.id === selectedLogId)) {
        setSelectedLogId(rows[0].id)
      }
    } finally {
      setLoadingList(false)
    }
  }

  /** 加载日志详情 */
  const loadLogDetail = async (id: string): Promise<void> => {
    setLoadingDetail(true)
    try {
      const detail = await window.api.httpLog.get(id)
      setSelectedLog(detail || null)
    } finally {
      setLoadingDetail(false)
    }
  }

  /** 清空日志（需用户确认） */
  const handleClearRequest = (): void => setShowClearConfirm(true)
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

  /** 当前筛选参数 */
  const currentFilters = useMemo(
    () => ({
      sessionId: filterSessionId || undefined,
      provider: filterProvider || undefined,
      model: filterModel || undefined
    }),
    [filterSessionId, filterProvider, filterModel]
  )

  /** 从已加载日志中提取去重的模型列表（用于筛选下拉） */
  const modelOptions = useMemo(() => {
    const set = new Set<string>()
    logs.forEach((l) => set.add(l.model))
    return Array.from(set).sort()
  }, [logs])

  useEffect(() => {
    loadSessions()
    loadProviders()
    loadLogs()
  }, [])

  /** 切换筛选条件时重新加载日志 */
  useEffect(() => {
    loadLogs(currentFilters)
  }, [filterSessionId, filterProvider])

  /** 切换模型筛选时在前端过滤（模型列表从日志中提取，无需重新请求） */
  // 注意：model 筛选也走后端，保持一致性
  useEffect(() => {
    loadLogs(currentFilters)
  }, [filterModel])

  useEffect(() => {
    if (selectedLogId) {
      loadLogDetail(selectedLogId)
    }
  }, [selectedLogId])

  return (
    <div className="h-full flex flex-col">
      <div className="px-5 py-4 border-b border-border-secondary space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-text-primary">
              {t('settings.httpLogTitle')}
            </h3>
            <p className="text-[11px] text-text-tertiary mt-1">{t('settings.httpLogDesc')}</p>
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
        {/* 筛选条件 */}
        <div className="flex items-center gap-2">
          <select
            value={filterSessionId}
            onChange={(e) => setFilterSessionId(e.target.value)}
            className="bg-bg-tertiary border border-border-primary rounded-md px-2 py-1.5 text-[11px] text-text-primary outline-none focus:border-accent/50 transition-colors appearance-none cursor-pointer max-w-[160px]"
          >
            <option value="">{t('settings.allSessions')}</option>
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title || s.id.slice(0, 8)}
              </option>
            ))}
          </select>
          <select
            value={filterProvider}
            onChange={(e) => {
              setFilterProvider(e.target.value)
              setFilterModel('')
            }}
            className="bg-bg-tertiary border border-border-primary rounded-md px-2 py-1.5 text-[11px] text-text-primary outline-none focus:border-accent/50 transition-colors appearance-none cursor-pointer max-w-[140px]"
          >
            <option value="">{t('settings.allProviders')}</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <select
            value={filterModel}
            onChange={(e) => setFilterModel(e.target.value)}
            className="bg-bg-tertiary border border-border-primary rounded-md px-2 py-1.5 text-[11px] text-text-primary outline-none focus:border-accent/50 transition-colors appearance-none cursor-pointer max-w-[180px]"
          >
            <option value="">{t('settings.allModels')}</option>
            {modelOptions.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex-1 min-h-0 flex">
        <div className="w-[200px] border-r border-border-secondary overflow-y-auto">
          {logs.length === 0 ? (
            <div className="px-4 py-6 text-xs text-text-tertiary">{t('settings.noLogs')}</div>
          ) : (
            <div className="p-2 space-y-1">
              {logs.map((log) => {
                const active = selectedLogId === log.id
                return (
                  <button
                    key={log.id}
                    onClick={() => setSelectedLogId(log.id)}
                    className={`w-full text-left rounded-md px-2.5 py-2 border transition-colors ${
                      active
                        ? 'border-accent/40 bg-accent/10'
                        : 'border-transparent hover:border-border-primary hover:bg-bg-hover'
                    }`}
                  >
                    <div className="text-[11px] text-text-primary font-medium">
                      {new Date(log.createdAt).toLocaleString()}
                    </div>
                    <div className="mt-0.5 text-[10px] text-text-tertiary truncate">
                      {log.providerName || log.provider} / {log.model}
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </div>

        <div className="flex-1 min-w-0 p-4 overflow-y-auto">
          {!selectedLogId ? (
            <div className="text-xs text-text-tertiary">{t('settings.selectLogHint')}</div>
          ) : loadingDetail ? (
            <div className="text-xs text-text-tertiary">{t('settings.loadingLog')}</div>
          ) : !selectedLog ? (
            <div className="text-xs text-text-tertiary">{t('settings.logNotFound')}</div>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-3 gap-3 text-xs">
                <div className="bg-bg-tertiary rounded-md px-3 py-2">
                  <div className="text-text-tertiary">{t('settings.time')}</div>
                  <div className="text-text-primary mt-0.5 break-all">
                    {new Date(selectedLog.createdAt).toLocaleString()}
                  </div>
                </div>
                <div className="bg-bg-tertiary rounded-md px-3 py-2">
                  <div className="text-text-tertiary">{t('settings.session')}</div>
                  <div className="text-text-primary mt-0.5 truncate">
                    {logs.find((l) => l.id === selectedLogId)?.sessionTitle ||
                      t('settings.unknownSession')}
                  </div>
                </div>
                {(() => {
                  const cur = logs.find((l) => l.id === selectedLogId)
                  return cur && cur.totalTokens > 0 ? (
                    <div className="bg-bg-tertiary rounded-md px-3 py-2">
                      <div className="text-text-tertiary">Tokens</div>
                      <div className="text-text-primary mt-0.5">{cur.totalTokens}</div>
                      <div className="text-[10px] text-text-tertiary mt-0.5">
                        in: {cur.inputTokens} / out: {cur.outputTokens}
                      </div>
                    </div>
                  ) : null
                })()}
              </div>

              <div className="text-xs text-text-secondary">{t('settings.requestBody')}</div>
              <PayloadViewer payload={selectedLog.payload} response={selectedLog.response} />
            </div>
          )}
        </div>
      </div>
      {/* 清空日志确认弹窗 */}
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
