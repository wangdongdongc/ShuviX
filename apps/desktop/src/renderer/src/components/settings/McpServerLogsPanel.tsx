/**
 * MCP 调用日志面板（监视器 tab 的子页）——ShuviX 作为 MCP server 被外部客户端调用的记录。
 *
 * 形态即目标形态：单列流 + 就地展开，没有第二个可滚动区。原先它是 MCP 设置页里的弹窗，
 * 「看日志」这件事和「配置 MCP 服务」不是一回事，故整体搬到监视器下。
 */
import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Trash2, RefreshCw, Loader2 } from 'lucide-react'
import { ConfirmDialog } from '../common/ConfirmDialog'

/** 列表查询上限（与界面提示一致） */
const LOG_LIST_LIMIT = 100

interface McpHostLogSummary {
  id: string
  sessionId: string
  clientName: string
  clientVersion: string
  toolName: string
  isError: number
  durationMs: number
  createdAt: number
}

interface McpServerLogDetail {
  id: string
  sessionId: string
  clientName: string
  clientVersion: string
  toolName: string
  arguments: string
  result: string
  isError: number
  durationMs: number
  createdAt: number
}

function formatJson(str: string): string {
  try {
    return JSON.stringify(JSON.parse(str), null, 2)
  } catch {
    return str
  }
}

export function McpServerLogsPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const [logs, setLogs] = useState<McpHostLogSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedLogId, setSelectedLogId] = useState<string | null>(null)
  const [logDetail, setLogDetail] = useState<McpServerLogDetail | null>(null)
  const [showClearConfirm, setShowClearConfirm] = useState(false)

  const loadLogs = useCallback(async () => {
    setLoading(true)
    try {
      const rows = await window.api.mcpServer.listLogs({ limit: LOG_LIST_LIMIT })
      setLogs(rows)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadLogs()
  }, [loadLogs])

  /** 点同一条 = 收起（手风琴：同时只展开一条） */
  const handleLogClick = async (id: string): Promise<void> => {
    if (selectedLogId === id) {
      setSelectedLogId(null)
      setLogDetail(null)
      return
    }
    setSelectedLogId(id)
    const detail = await window.api.mcpServer.getLog(id)
    setLogDetail(detail ?? null)
  }

  const handleClearLogs = async (): Promise<void> => {
    await window.api.mcpServer.clearLogs()
    setLogs([])
    setSelectedLogId(null)
    setLogDetail(null)
    setShowClearConfirm(false)
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* 工具栏：数量 + 刷新 + 清空 */}
      <div className="flex-shrink-0 flex items-center gap-2 px-3 py-2 border-b border-border-secondary">
        <span className="text-[10px] text-text-tertiary tabular-nums truncate">
          {t('settings.httpLogLimitHint', { shown: logs.length, limit: LOG_LIST_LIMIT })}
        </span>
        <div className="ml-auto flex items-center gap-1 shrink-0">
          <button
            onClick={() => void loadLogs()}
            disabled={loading}
            title={t('common.refresh')}
            className="inline-flex items-center justify-center w-6 h-6 rounded-md text-text-tertiary hover:text-text-primary hover:bg-bg-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          </button>
          <button
            onClick={() => setShowClearConfirm(true)}
            disabled={logs.length === 0}
            title={t('settings.mcpServerLogClear')}
            className="inline-flex items-center justify-center w-6 h-6 rounded-md text-text-tertiary hover:text-error hover:bg-error/10 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>

      {/* 单列流 */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {loading && logs.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-10 text-text-tertiary">
            <Loader2 size={14} className="animate-spin" />
            <span className="text-[11px]">{t('common.loading')}</span>
          </div>
        ) : logs.length === 0 ? (
          <div className="text-[11px] text-text-tertiary text-center py-10">
            {t('settings.mcpServerLogEmpty')}
          </div>
        ) : (
          <div className="divide-y divide-border-secondary/30">
            {logs.map((log) => (
              <div key={log.id}>
                <button
                  onClick={() => void handleLogClick(log.id)}
                  className={`w-full flex items-center gap-3 px-4 py-2 text-[11px] hover:bg-bg-hover/40 transition-colors ${
                    selectedLogId === log.id ? 'bg-bg-hover/40' : ''
                  }`}
                >
                  <span
                    className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                      log.isError ? 'bg-red-500' : 'bg-emerald-500'
                    }`}
                  />
                  <span className="text-text-tertiary w-16 text-[10px] shrink-0 tabular-nums">
                    {new Date(log.createdAt).toLocaleTimeString()}
                  </span>
                  <span className="text-text-secondary truncate w-28 shrink-0 text-left">
                    {log.clientName}
                  </span>
                  <span className="font-mono text-accent truncate flex-1 text-left">
                    {log.toolName}
                  </span>
                  <span className="text-text-tertiary text-[10px] w-14 text-right shrink-0 tabular-nums">
                    {log.durationMs}ms
                  </span>
                </button>

                {selectedLogId === log.id && logDetail && (
                  <div className="px-4 py-3 bg-bg-tertiary/15 space-y-2">
                    <div>
                      <div className="text-[10px] text-text-tertiary mb-1">Arguments</div>
                      <pre className="text-[11px] font-mono text-text-secondary bg-bg-primary border border-border-secondary/50 rounded-md p-2 overflow-x-auto max-h-40 overflow-y-auto">
                        {formatJson(logDetail.arguments)}
                      </pre>
                    </div>
                    <div>
                      <div className="text-[10px] text-text-tertiary mb-1">Result</div>
                      <pre className="text-[11px] font-mono text-text-secondary bg-bg-primary border border-border-secondary/50 rounded-md p-2 overflow-x-auto max-h-60 overflow-y-auto">
                        {logDetail.result}
                      </pre>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {showClearConfirm && (
        <ConfirmDialog
          title={t('settings.mcpServerLogClear')}
          description={t('settings.mcpServerLogClearConfirm')}
          confirmText={t('settings.mcpServerLogClear')}
          cancelText={t('common.cancel')}
          onConfirm={handleClearLogs}
          onCancel={() => setShowClearConfirm(false)}
        />
      )}
    </div>
  )
}
