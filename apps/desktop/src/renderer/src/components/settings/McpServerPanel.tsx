import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Copy, Database, Terminal, ChevronDown, ChevronRight, Loader2 } from 'lucide-react'
import {
  SettingsSection,
  SettingsRow,
  SettingsBlock,
  Toggle,
  InlineInput
} from './SettingsPrimitives'

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

/** MCP Server 对外服务配置面板 */
export function McpServerPanel(): React.JSX.Element {
  const { t } = useTranslation()

  const [status, setStatus] = useState<McpHostStatus | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [port, setPort] = useState('3399')
  const [dbFeature, setDbFeature] = useState(false)
  const [sshFeature, setSshFeature] = useState(false)
  const [tools, setTools] = useState<McpHostToolDesc[]>([])
  const [toolsExpanded, setToolsExpanded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(false)
  const [startError, setStartError] = useState('')

  const loadSettings = useCallback(async () => {
    const [portVal, dbVal, sshVal] = await Promise.all([
      window.api.settings.get('mcpServer.port'),
      window.api.settings.get('mcpServer.features.database'),
      window.api.settings.get('mcpServer.features.ssh')
    ])
    setPort(portVal || '3399')
    setDbFeature(dbVal === 'true')
    setSshFeature(sshVal === 'true')
  }, [])

  const loadStatus = useCallback(async () => {
    const s = await window.api.mcpServer.getStatus()
    setStatus(s)
    setEnabled(s.running)
    return s
  }, [])

  const loadTools = useCallback(async () => {
    const list = await window.api.mcpServer.getTools()
    setTools(list)
  }, [])

  useEffect(() => {
    void loadSettings()
    void loadStatus()
    void loadTools()
  }, [loadSettings, loadStatus, loadTools])

  // 主开关
  const handleToggleEnabled = async (): Promise<void> => {
    setLoading(true)
    setStartError('')
    try {
      const newEnabled = !enabled
      setEnabled(newEnabled)
      if (newEnabled) {
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
    } finally {
      setLoading(false)
    }
  }

  const handlePortBlur = async (): Promise<void> => {
    const num = Number(port)
    if (!num || num < 1 || num > 65535) {
      setPort('3399')
      return
    }
    await window.api.settings.set({ key: 'mcpServer.port', value: port })
  }

  const handleToggleDatabase = async (): Promise<void> => {
    const newVal = !dbFeature
    setDbFeature(newVal)
    await window.api.settings.set({
      key: 'mcpServer.features.database',
      value: String(newVal)
    })
    if (status?.running) {
      if (newVal) await window.api.mcpServer.enableFeature('database')
      else await window.api.mcpServer.disableFeature('database')
    }
    await loadTools()
    await loadStatus()
  }

  const handleToggleSsh = async (): Promise<void> => {
    const newVal = !sshFeature
    setSshFeature(newVal)
    await window.api.settings.set({
      key: 'mcpServer.features.ssh',
      value: String(newVal)
    })
    if (status?.running) {
      if (newVal) await window.api.mcpServer.enableFeature('ssh')
      else await window.api.mcpServer.disableFeature('ssh')
    }
    await loadTools()
    await loadStatus()
  }

  const handleCopy = async (text: string): Promise<void> => {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const serverUrl = `http://127.0.0.1:${port}/mcp`
  const isRunning = status?.running ?? false

  const claudeDesktopConfig = JSON.stringify(
    { mcpServers: { shuvix: { url: serverUrl } } },
    null,
    2
  )

  return (
    <div className="flex-1 px-5 py-5 space-y-5">
      {/* 服务状态 */}
      <SettingsSection
        title={t('settings.mcpServerStatusGroup')}
        description={t('settings.mcpServerDesc')}
      >
        <SettingsRow
          title={t('settings.mcpServerEnabled')}
          control={
            <div className="flex items-center gap-2">
              {loading && <Loader2 size={11} className="animate-spin text-text-tertiary" />}
              <span className="inline-flex items-center gap-1 text-[10px] text-text-tertiary">
                <span
                  className={`w-1.5 h-1.5 rounded-full ${isRunning ? 'bg-emerald-500' : 'bg-gray-400'}`}
                />
                {isRunning ? t('settings.mcpServerRunning') : t('settings.mcpServerStopped')}
              </span>
              <Toggle on={enabled} onClick={() => void handleToggleEnabled()} />
            </div>
          }
        />
        <SettingsRow
          title={t('settings.mcpServerPort')}
          control={
            <InlineInput
              type="number"
              value={port}
              onChange={setPort}
              onBlur={() => void handlePortBlur()}
              disabled={isRunning}
              placeholder={t('settings.mcpServerPortDefault')}
              width={120}
              min={1}
              max={65535}
            />
          }
        />
        {startError && (
          <div className="px-4 py-2 text-[11px] text-red-400 bg-red-500/5">
            {t('settings.mcpServerStartError', { error: startError })}
          </div>
        )}
        {/* 接入信息：运行时直接接续显示 */}
        {isRunning && (
          <>
            <SettingsRow
              title={t('settings.mcpServerUrl')}
              control={
                <div className="flex items-center gap-1.5">
                  <code className="text-[11px] font-mono text-accent bg-bg-tertiary/40 px-2 py-0.5 rounded">
                    {serverUrl}
                  </code>
                  <button
                    onClick={() => handleCopy(serverUrl)}
                    className="p-1 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors"
                    title={t('settings.mcpServerCopy')}
                  >
                    {copied ? <Check size={11} className="text-emerald-500" /> : <Copy size={11} />}
                  </button>
                </div>
              }
            />
            <SettingsBlock
              label={t('settings.mcpServerClaudeDesktop')}
              description={t('settings.mcpServerConnectionHint')}
            >
              <div className="relative">
                <pre className="text-[10px] font-mono text-text-secondary bg-bg-primary border border-border-secondary/50 rounded-md p-3 overflow-x-auto">
                  {claudeDesktopConfig}
                </pre>
                <button
                  onClick={() => handleCopy(claudeDesktopConfig)}
                  className="absolute top-2 right-2 p-1 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors"
                  title={t('settings.mcpServerCopy')}
                >
                  <Copy size={11} />
                </button>
              </div>
            </SettingsBlock>
          </>
        )}
      </SettingsSection>

      {/* 对外功能 */}
      <SettingsSection title={t('settings.mcpServerFeaturesGroup')}>
        <SettingsRow
          icon={<Database size={13} className="text-amber-500 shrink-0" />}
          title={t('settings.mcpServerFeatureDatabase')}
          description={t('settings.mcpServerFeatureDatabaseDesc')}
          control={<Toggle on={dbFeature} onClick={() => void handleToggleDatabase()} />}
        />
        <SettingsRow
          icon={<Terminal size={13} className="text-cyan-400 shrink-0" />}
          title={t('settings.mcpServerFeatureSsh')}
          description={t('settings.mcpServerFeatureSshDesc')}
          control={<Toggle on={sshFeature} onClick={() => void handleToggleSsh()} />}
        />
      </SettingsSection>

      {/* 已注册工具 */}
      {tools.length > 0 && (
        <SettingsSection
          title={`${t('settings.mcpServerToolsGroup')} (${tools.length})`}
          headerAction={
            <button
              onClick={() => setToolsExpanded(!toolsExpanded)}
              className="p-1 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors"
              title={toolsExpanded ? '收起' : '展开'}
            >
              {toolsExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </button>
          }
        >
          {toolsExpanded ? (
            tools.map((tool) => (
              <div key={tool.name} className="px-4 py-3">
                <div className="text-[12px] font-mono text-accent">{tool.name}</div>
                <div className="text-[11px] text-text-tertiary mt-0.5 leading-relaxed">
                  {tool.description}
                </div>
                {(tool.inputSchema as { properties?: Record<string, unknown> })?.properties && (
                  <div className="mt-2 space-y-0.5">
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
            ))
          ) : (
            <div className="px-4 py-3 text-[11px] text-text-tertiary leading-relaxed">
              {tools.map((tool) => tool.name).join(' · ')}
            </div>
          )}
        </SettingsSection>
      )}
    </div>
  )
}
