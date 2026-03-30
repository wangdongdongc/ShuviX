import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Check,
  Copy,
  Database,
  ChevronDown,
  ChevronRight,
  Trash2,
  Loader2,
  ScrollText
} from 'lucide-react'
import { ConfirmDialog } from '../common/ConfirmDialog'

interface McpHostStatus {
  running: boolean
  transport: string
  port: number
  features: string[]
  error?: string
}

interface McpHostToolDesc {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

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

/** MCP Server 对外服务配置面板 */
export function McpServerPanel(): React.JSX.Element {
  const { t } = useTranslation()

  // 状态
  const [status, setStatus] = useState<McpHostStatus | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [port, setPort] = useState('3399')
  const [dbFeature, setDbFeature] = useState(false)
  const [tools, setTools] = useState<McpHostToolDesc[]>([])
  const [toolsExpanded, setToolsExpanded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(false)
  const [startError, setStartError] = useState('')

  // 日志
  const [logs, setLogs] = useState<McpHostLogSummary[]>([])
  const [selectedLogId, setSelectedLogId] = useState<string | null>(null)
  const [logDetail, setLogDetail] = useState<McpServerLogDetail | null>(null)
  const [showClearConfirm, setShowClearConfirm] = useState(false)

  // 加载设置
  const loadSettings = useCallback(async () => {
    const [enabledVal, portVal, dbVal] = await Promise.all([
      window.api.settings.get('mcpServer.enabled'),
      window.api.settings.get('mcpServer.port'),
      window.api.settings.get('mcpServer.features.database')
    ])
    setEnabled(enabledVal === 'true')
    setPort(portVal || '3399')
    setDbFeature(dbVal === 'true')
  }, [])

  const loadStatus = useCallback(async () => {
    const s = await window.api.mcpServer.getStatus()
    setStatus(s)
    return s
  }, [])

  const loadTools = useCallback(async () => {
    const t = await window.api.mcpServer.getTools()
    setTools(t)
  }, [])

  const loadLogs = useCallback(async () => {
    const rows = await window.api.mcpServer.listLogs({ limit: 100 })
    setLogs(rows)
  }, [])

  useEffect(() => {
    loadSettings()
    loadStatus()
    loadTools()
    loadLogs()
  }, [loadSettings, loadStatus, loadTools, loadLogs])

  // 主开关
  const handleToggleEnabled = async (): Promise<void> => {
    setLoading(true)
    setStartError('')
    try {
      const newEnabled = !enabled
      await window.api.settings.set({ key: 'mcpServer.enabled', value: String(newEnabled) })
      setEnabled(newEnabled)

      if (newEnabled) {
        // 先保存端口
        await window.api.settings.set({ key: 'mcpServer.port', value: port })
        const s = await window.api.mcpServer.start()
        setStatus(s)
        if (s.error) setStartError(s.error)
      } else {
        const s = await window.api.mcpServer.stop()
        setStatus(s)
      }
      await loadTools()
    } catch (err: unknown) {
      setStartError(err instanceof Error ? err.message : String(err))
      setEnabled(false)
      await window.api.settings.set({ key: 'mcpServer.enabled', value: 'false' })
    } finally {
      setLoading(false)
    }
  }

  // 端口变更
  const handlePortBlur = async (): Promise<void> => {
    const num = Number(port)
    if (!num || num < 1 || num > 65535) {
      setPort('3399')
      return
    }
    await window.api.settings.set({ key: 'mcpServer.port', value: port })
  }

  // Database 功能开关
  const handleToggleDatabase = async (): Promise<void> => {
    const newVal = !dbFeature
    setDbFeature(newVal)
    await window.api.settings.set({
      key: 'mcpServer.features.database',
      value: String(newVal)
    })
    if (status?.running) {
      if (newVal) {
        await window.api.mcpServer.enableFeature('database')
      } else {
        await window.api.mcpServer.disableFeature('database')
      }
    }
    await loadTools()
    await loadStatus()
  }

  // 复制
  const handleCopy = async (text: string): Promise<void> => {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  // 日志详情
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

  // 清空日志
  const handleClearLogs = async (): Promise<void> => {
    await window.api.mcpServer.clearLogs()
    setLogs([])
    setSelectedLogId(null)
    setLogDetail(null)
    setShowClearConfirm(false)
  }

  const serverUrl = `http://127.0.0.1:${port}/mcp`
  const isRunning = status?.running ?? false

  const claudeDesktopConfig = JSON.stringify(
    {
      mcpServers: {
        shuvix: { url: serverUrl }
      }
    },
    null,
    2
  )

  return (
    <div className="p-6 space-y-6">
      {/* 标题 */}
      <div>
        <h3 className="text-sm font-semibold text-text-primary">{t('settings.mcpServerTitle')}</h3>
        <p className="text-[11px] text-text-tertiary mt-1">{t('settings.mcpServerDesc')}</p>
      </div>

      {/* 主开关 + 状态 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={handleToggleEnabled}
            disabled={loading}
            className={`relative w-8 h-[18px] rounded-full transition-colors ${
              enabled ? 'bg-accent' : 'bg-bg-tertiary'
            } ${loading ? 'opacity-50' : ''}`}
          >
            <span
              className={`absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white shadow transition-all ${
                enabled ? 'left-[16px]' : 'left-[2px]'
              }`}
            />
          </button>
          <span className="text-xs text-text-primary">{t('settings.mcpServerEnabled')}</span>
          {loading && <Loader2 size={12} className="animate-spin text-text-tertiary" />}
        </div>

        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${isRunning ? 'bg-green-500' : 'bg-gray-400'}`} />
          <span className="text-[11px] text-text-secondary">
            {isRunning ? t('settings.mcpServerRunning') : t('settings.mcpServerStopped')}
          </span>
        </div>
      </div>

      {startError && (
        <div className="text-[11px] text-red-400 bg-red-500/10 rounded-md px-3 py-2">
          {t('settings.mcpServerStartError', { error: startError })}
        </div>
      )}

      {/* 端口配置 */}
      <div className="flex items-center gap-3">
        <label className="text-xs text-text-secondary w-16">{t('settings.mcpServerPort')}</label>
        <input
          type="number"
          value={port}
          onChange={(e) => setPort(e.target.value)}
          onBlur={handlePortBlur}
          disabled={isRunning}
          className="zen-input w-24 text-xs"
          min={1}
          max={65535}
          placeholder={t('settings.mcpServerPortDefault')}
        />
        {isRunning && (
          <span className="text-[10px] text-text-tertiary">
            {t('settings.mcpServerPortDefault')}
          </span>
        )}
      </div>

      {/* 功能列表 */}
      <div>
        <h4 className="text-xs font-medium text-text-primary mb-3">
          {t('settings.mcpServerFeatures')}
        </h4>

        {/* Database 功能 */}
        <div className="border border-border-secondary rounded-lg overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2.5 bg-bg-secondary">
            <div className="flex items-center gap-2">
              <Database size={13} className="text-amber-500" />
              <span className="text-xs font-medium text-text-primary">
                {t('settings.mcpServerFeatureDatabase')}
              </span>
            </div>
            <button
              onClick={handleToggleDatabase}
              className={`relative w-8 h-[18px] rounded-full transition-colors ${
                dbFeature ? 'bg-accent' : 'bg-bg-hover'
              }`}
            >
              <span
                className={`absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white shadow transition-all ${
                  dbFeature ? 'left-[16px]' : 'left-[2px]'
                }`}
              />
            </button>
          </div>

          <div className="px-3 py-2 border-t border-border-secondary">
            <p className="text-[11px] text-text-tertiary">
              {t('settings.mcpServerFeatureDatabaseDesc')}
            </p>
          </div>

          {/* 工具列表（可展开） */}
          {dbFeature && tools.length > 0 && (
            <div className="border-t border-border-secondary">
              <button
                onClick={() => setToolsExpanded(!toolsExpanded)}
                className="flex items-center gap-1.5 px-3 py-2 text-[11px] text-text-secondary hover:text-text-primary w-full"
              >
                {toolsExpanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                <span>
                  {t('settings.mcpServerTools')} ({tools.length})
                </span>
              </button>
              {toolsExpanded && (
                <div className="px-3 pb-2 space-y-2">
                  {tools.map((tool) => (
                    <div key={tool.name} className="bg-bg-primary/50 rounded-md px-2.5 py-2">
                      <div className="text-[11px] font-mono text-accent">{tool.name}</div>
                      <div className="text-[10px] text-text-tertiary mt-0.5 leading-relaxed">
                        {tool.description}
                      </div>
                      {(tool.inputSchema as { properties?: Record<string, unknown> })
                        ?.properties && (
                        <div className="mt-1.5 space-y-0.5">
                          {Object.entries(
                            (tool.inputSchema as { properties: Record<string, unknown> }).properties
                          ).map(([name, raw]) => {
                            const schema = raw as { type?: string; description?: string } | null
                            return (
                              <div key={name} className="text-[10px] text-text-tertiary">
                                <span className="font-mono text-text-secondary">{name}</span>
                                {schema?.type && (
                                  <span className="text-text-tertiary ml-1">({schema.type})</span>
                                )}
                                {schema?.description && (
                                  <span className="ml-1">— {schema.description}</span>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 连接指南（仅运行时显示） */}
      {isRunning && (
        <div>
          <h4 className="text-xs font-medium text-text-primary mb-2">
            {t('settings.mcpServerConnectionInfo')}
          </h4>
          <p className="text-[11px] text-text-tertiary mb-3">
            {t('settings.mcpServerConnectionHint')}
          </p>

          {/* 服务地址 */}
          <div className="flex items-center gap-2 mb-3">
            <span className="text-[11px] text-text-secondary">{t('settings.mcpServerUrl')}:</span>
            <code className="text-[11px] font-mono text-accent bg-bg-tertiary px-2 py-0.5 rounded">
              {serverUrl}
            </code>
            <button
              onClick={() => handleCopy(serverUrl)}
              className="text-text-tertiary hover:text-text-primary transition-colors"
              title={t('settings.mcpServerCopy')}
            >
              {copied ? <Check size={12} className="text-green-500" /> : <Copy size={12} />}
            </button>
          </div>

          {/* Claude Desktop 配置 */}
          <div>
            <div className="text-[11px] text-text-secondary mb-1.5">
              {t('settings.mcpServerClaudeDesktop')}
            </div>
            <div className="relative">
              <pre className="text-[10px] font-mono text-text-secondary bg-bg-tertiary rounded-lg p-3 overflow-x-auto">
                {claudeDesktopConfig}
              </pre>
              <button
                onClick={() => handleCopy(claudeDesktopConfig)}
                className="absolute top-2 right-2 text-text-tertiary hover:text-text-primary transition-colors"
                title={t('settings.mcpServerCopy')}
              >
                <Copy size={11} />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 调用日志 */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-xs font-medium text-text-primary flex items-center gap-1.5">
            <ScrollText size={13} />
            {t('settings.mcpServerLogs')}
          </h4>
          {logs.length > 0 && (
            <button
              onClick={() => setShowClearConfirm(true)}
              className="flex items-center gap-1 text-[10px] text-text-tertiary hover:text-red-400 transition-colors"
            >
              <Trash2 size={10} />
              {t('settings.mcpServerLogClear')}
            </button>
          )}
        </div>

        {logs.length === 0 ? (
          <div className="text-[11px] text-text-tertiary text-center py-6">
            {t('settings.mcpServerLogEmpty')}
          </div>
        ) : (
          <div className="border border-border-secondary rounded-lg overflow-hidden">
            {logs.map((log) => (
              <div key={log.id}>
                <button
                  onClick={() => handleLogClick(log.id)}
                  className={`w-full flex items-center gap-3 px-3 py-2 text-[11px] hover:bg-bg-hover transition-colors border-b border-border-secondary last:border-b-0 ${
                    selectedLogId === log.id ? 'bg-bg-hover' : ''
                  }`}
                >
                  {/* 状态 */}
                  <span
                    className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                      log.isError ? 'bg-red-500' : 'bg-green-500'
                    }`}
                  />
                  {/* 时间 */}
                  <span className="text-text-tertiary w-14 text-[10px] flex-shrink-0">
                    {new Date(log.createdAt).toLocaleTimeString()}
                  </span>
                  {/* 客户端 */}
                  <span className="text-text-secondary truncate w-24 flex-shrink-0">
                    {log.clientName}
                  </span>
                  {/* 工具 */}
                  <span className="font-mono text-accent truncate flex-1">{log.toolName}</span>
                  {/* 耗时 */}
                  <span className="text-text-tertiary text-[10px] w-12 text-right flex-shrink-0">
                    {log.durationMs}ms
                  </span>
                </button>

                {/* 展开详情 */}
                {selectedLogId === log.id && logDetail && (
                  <div className="px-3 py-2 bg-bg-tertiary/50 border-b border-border-secondary space-y-2">
                    <div>
                      <div className="text-[10px] text-text-tertiary mb-0.5">Arguments</div>
                      <pre className="text-[10px] font-mono text-text-secondary bg-bg-primary rounded p-2 overflow-x-auto max-h-32 overflow-y-auto">
                        {formatJson(logDetail.arguments)}
                      </pre>
                    </div>
                    <div>
                      <div className="text-[10px] text-text-tertiary mb-0.5">Result</div>
                      <pre className="text-[10px] font-mono text-text-secondary bg-bg-primary rounded p-2 overflow-x-auto max-h-48 overflow-y-auto">
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

      {/* 清空确认 */}
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

function formatJson(str: string): string {
  try {
    return JSON.stringify(JSON.parse(str), null, 2)
  } catch {
    return str
  }
}
