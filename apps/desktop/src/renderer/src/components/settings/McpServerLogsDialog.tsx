import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { X, Trash2, Loader2 } from 'lucide-react'
import { useDialogClose } from '@shuvix/chat-ui'
import { ConfirmDialog } from '../common/ConfirmDialog'

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

interface McpServerLogsDialogProps {
  onClose: () => void
}

/** MCP 调用日志弹窗 */
export function McpServerLogsDialog({ onClose }: McpServerLogsDialogProps): React.JSX.Element {
  const { t } = useTranslation()
  const { closing, handleClose } = useDialogClose(onClose)
  const [logs, setLogs] = useState<McpHostLogSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedLogId, setSelectedLogId] = useState<string | null>(null)
  const [logDetail, setLogDetail] = useState<McpServerLogDetail | null>(null)
  const [showClearConfirm, setShowClearConfirm] = useState(false)

  const loadLogs = useCallback(async () => {
    setLoading(true)
    try {
      const rows = await window.api.mcpServer.listLogs({ limit: 100 })
      setLogs(rows)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadLogs()
  }, [loadLogs])

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') handleClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [handleClose])

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
    <div
      onClick={handleClose}
      className={`fixed inset-0 z-50 flex items-center justify-center bg-black/40 titlebar-no-drag dialog-overlay${closing ? ' dialog-closing' : ''}`}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-bg-primary border border-border-primary rounded-xl shadow-xl w-[640px] max-w-[92vw] max-h-[80vh] flex flex-col dialog-panel"
      >
        {/* 头部 */}
        <div className="px-5 py-3 border-b border-border-secondary shrink-0 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-text-primary">
            {t('settings.mcpServerLogsTitle')}
          </h3>
          <div className="flex items-center gap-2">
            {logs.length > 0 && (
              <button
                onClick={() => setShowClearConfirm(true)}
                className="flex items-center gap-1 px-2 py-1 rounded text-[11px] text-text-tertiary hover:text-danger hover:bg-danger/10 transition-colors"
              >
                <Trash2 size={11} />
                {t('settings.mcpServerLogClear')}
              </button>
            )}
            <button
              onClick={handleClose}
              className="p-1 rounded-lg hover:bg-bg-hover text-text-tertiary hover:text-text-primary transition-colors"
            >
              <X size={14} />
            </button>
          </div>
        </div>

        {/* 内容 */}
        <div className="overflow-y-auto flex-1">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-text-tertiary">
              <Loader2 size={14} className="animate-spin" />
              <span className="text-[11px]">{t('common.loading') || 'Loading...'}</span>
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
