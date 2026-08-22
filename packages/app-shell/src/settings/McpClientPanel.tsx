/**
 * McpClientPanel —— MCP 客户端设置面板（共享）。server 列表 + 增删改 + 启停 + 重连 + 工具展开。
 * 通过注入的 McpApi 操作（桌面 window.api.mcp / 扩展 getChatApi().mcp），caps.allowStdio 控制
 * 是否允许本地进程类型（扩展为 false，仅 http）。
 */
import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Plus,
  Trash2,
  RefreshCw,
  Power,
  PowerOff,
  ChevronDown,
  ChevronRight,
  Wrench,
  Server,
  Pencil
} from 'lucide-react'
import type {
  McpServerInfo,
  McpToolInfo,
  McpServerAddParams,
  McpServerUpdateParams
} from '@shuvix/chat-protocol/types/mcp'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { SettingsSection } from './SettingsPrimitives'
import {
  McpServerDialog,
  type McpServerDialogData,
  type McpServerDialogInitial
} from './McpServerDialog'

/** MCP 操作契约（宿主注入：桌面 window.api.mcp / 扩展 chatApiAdapter.mcp） */
export interface McpApi {
  list: () => Promise<McpServerInfo[]>
  add: (params: McpServerAddParams) => Promise<{ success: boolean }>
  update: (params: McpServerUpdateParams) => Promise<{ success: boolean }>
  delete: (id: string) => Promise<{ success: boolean }>
  connect: (id: string) => Promise<{ success: boolean }>
  disconnect: (id: string) => Promise<{ success: boolean }>
  getTools: (id: string) => Promise<McpToolInfo[]>
}

export interface McpClientPanelProps {
  api: McpApi
  caps?: { allowStdio?: boolean }
}

/** env JSON 是否所有 value 都非空（所需 API Key 均已配置） */
function envHasAllValues(envJson: string): boolean {
  try {
    const obj = JSON.parse(envJson || '{}') as Record<string, string>
    const entries = Object.entries(obj)
    if (entries.length === 0) return false
    return entries.every(([, v]) => typeof v === 'string' && v.trim().length > 0)
  } catch {
    return false
  }
}

function StatusDot({ status }: { status: string }): React.JSX.Element {
  const color =
    status === 'connected'
      ? 'bg-green-500'
      : status === 'connecting'
        ? 'bg-yellow-500 animate-pulse'
        : status === 'error'
          ? 'bg-red-500'
          : 'bg-gray-400'
  return <span className={`inline-block w-2 h-2 rounded-full ${color}`} />
}

function ToolDescItem({ tool }: { tool: McpToolInfo }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="flex items-start gap-2 py-0.5">
      <Wrench size={10} className="text-purple-400 mt-0.5 flex-shrink-0" />
      <div className="min-w-0">
        <span className="text-[11px] font-mono text-purple-300">{tool.name.split('__').pop()}</span>
        {tool.description && (
          <p
            className={`text-[10px] text-text-tertiary cursor-pointer hover:text-text-secondary transition-colors ${expanded ? '' : 'line-clamp-2'}`}
            onClick={() => setExpanded(!expanded)}
          >
            {tool.description}
          </p>
        )}
      </div>
    </div>
  )
}

function statusText(status: string, t: (key: string) => string): string {
  switch (status) {
    case 'connected':
      return t('settings.mcpStatusConnected')
    case 'disconnected':
      return t('settings.mcpStatusDisconnected')
    case 'connecting':
      return t('settings.mcpStatusConnecting')
    case 'error':
      return t('settings.mcpStatusError')
    default:
      return status
  }
}

function jsonEnvToPairs(json: string): Array<{ key: string; value: string }> {
  try {
    const obj = JSON.parse(json) as Record<string, unknown>
    return Object.entries(obj).map(([key, value]) => ({
      key: String(key),
      value: typeof value === 'string' ? value : String(value ?? '')
    }))
  } catch {
    return []
  }
}

function arrayToLines(json: string): string {
  try {
    return (JSON.parse(json) as string[]).join('\n')
  } catch {
    return ''
  }
}

function headersToLines(json: string): string {
  try {
    const obj = JSON.parse(json)
    return Object.entries(obj)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n')
  } catch {
    return ''
  }
}

export function McpClientPanel({ api, caps = {} }: McpClientPanelProps): React.JSX.Element {
  const { t } = useTranslation()
  const allowStdio = caps.allowStdio ?? true
  const [servers, setServers] = useState<McpServerInfo[]>([])
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [tools, setTools] = useState<McpToolInfo[]>([])
  const [dialogInitial, setDialogInitial] = useState<McpServerDialogInitial | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [dialogEditId, setDialogEditId] = useState<string | null>(null)
  const [deletingServer, setDeletingServer] = useState<McpServerInfo | null>(null)

  const loadServers = useCallback(async () => {
    setServers(await api.list())
  }, [api])

  useEffect(() => {
    void loadServers() // eslint-disable-line react-hooks/set-state-in-effect
    const timer = setInterval(() => void loadServers(), 3000)
    return () => clearInterval(timer)
  }, [loadServers])

  const toggleExpand = async (id: string): Promise<void> => {
    if (expandedId === id) {
      setExpandedId(null)
      setTools([])
    } else {
      setExpandedId(id)
      setTools(await api.getTools(id))
    }
  }

  const openAddDialog = (): void => {
    setDialogInitial(null)
    setDialogEditId(null)
    setDialogOpen(true)
  }

  const openEditDialog = (s: McpServerInfo): void => {
    setDialogInitial({
      id: s.id,
      name: s.name,
      type: s.type,
      command: s.command,
      argsText: arrayToLines(s.args),
      envPairs: jsonEnvToPairs(s.env),
      url: s.url,
      headersText: headersToLines(s.headers),
      isBuiltin: s.isBuiltin === 1,
      isEnabled: s.isEnabled === 1
    })
    setDialogEditId(s.id)
    setDialogOpen(true)
  }

  const handleDialogSave = async (data: McpServerDialogData): Promise<void> => {
    if (dialogEditId) {
      await api.update({
        id: dialogEditId,
        name: data.name,
        type: data.type,
        command: data.command,
        args: data.argsLines,
        env: data.envObject,
        url: data.url,
        headers: data.headersObject
      })
      if (data.autoEnableBuiltin) await api.update({ id: dialogEditId, isEnabled: true })
    } else {
      await api.add({
        name: data.name,
        type: data.type,
        command: data.command,
        args: data.argsLines,
        env: data.envObject,
        url: data.url,
        headers: data.headersObject
      })
    }
    await loadServers()
  }

  const confirmDelete = async (): Promise<void> => {
    if (!deletingServer) return
    const id = deletingServer.id
    setDeletingServer(null)
    await api.delete(id)
    if (expandedId === id) {
      setExpandedId(null)
      setTools([])
    }
    await loadServers()
  }

  const handleToggle = async (s: McpServerInfo): Promise<void> => {
    await api.update({ id: s.id, isEnabled: !s.isEnabled })
    await loadServers()
  }

  const handleReconnect = async (id: string): Promise<void> => {
    await api.connect(id)
    await loadServers()
  }

  return (
    <div className="flex-1 px-5 py-5 space-y-5">
      <SettingsSection
        title={t('settings.mcpTitle')}
        description={t('settings.mcpDesc')}
        headerAction={
          <button
            onClick={openAddDialog}
            className="flex items-center gap-1 px-2 py-1 rounded text-[11px] text-accent hover:bg-accent/10 transition-colors"
          >
            <Plus size={12} />
            {t('settings.mcpAdd')}
          </button>
        }
      >
        {servers.length === 0 ? (
          <div className="px-4 py-8 text-center">
            <Server size={28} className="mx-auto text-text-tertiary mb-2 opacity-40" />
            <p className="text-[11px] text-text-tertiary">{t('settings.mcpEmpty')}</p>
            <p className="text-[10px] text-text-tertiary mt-1">{t('settings.mcpEmptyHint')}</p>
          </div>
        ) : (
          servers.map((s) => {
            const expanded = expandedId === s.id
            const showError = s.status === 'error' && !!s.error
            const showBuiltinHint = s.isBuiltin === 1 && !envHasAllValues(s.env)
            return (
              <div key={s.id} className="flex flex-col">
                <div className="flex items-center gap-3 px-4 py-3">
                  <button
                    onClick={() => toggleExpand(s.id)}
                    className="text-text-tertiary hover:text-text-secondary transition-colors"
                  >
                    {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </button>
                  <StatusDot status={s.status} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-[13px] text-text-primary truncate">{s.name}</span>
                      {s.isBuiltin === 1 && (
                        <span className="text-[9px] font-normal text-amber-500 bg-amber-500/10 px-1.5 py-0.5 rounded-md shrink-0">
                          {t('settings.mcpBuiltin')}
                        </span>
                      )}
                      <span className="text-[9px] font-normal text-text-tertiary bg-bg-tertiary px-1.5 py-0.5 rounded-md shrink-0">
                        {s.type}
                      </span>
                    </div>
                    <div
                      className={`text-[11px] mt-0.5 ${
                        s.status === 'error' ? 'text-red-400' : 'text-text-tertiary'
                      }`}
                    >
                      {statusText(s.status, t)}
                      {s.status === 'connected' &&
                        ` · ${t('settings.mcpToolCount', { count: s.toolCount })}`}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {(s.status === 'error' || s.status === 'disconnected') && (
                      <button
                        onClick={() => handleReconnect(s.id)}
                        className="p-1 text-text-tertiary hover:text-accent transition-colors"
                        title={t('settings.mcpReconnect')}
                      >
                        <RefreshCw size={12} />
                      </button>
                    )}
                    <button
                      onClick={() => handleToggle(s)}
                      className={`p-1 transition-colors ${
                        s.isEnabled
                          ? 'text-accent hover:text-accent/70'
                          : 'text-text-tertiary hover:text-text-secondary'
                      }`}
                      title={s.isEnabled ? t('settings.mcpDisconnect') : t('settings.mcpConnect')}
                    >
                      {s.isEnabled ? <Power size={12} /> : <PowerOff size={12} />}
                    </button>
                    <button
                      onClick={() => openEditDialog(s)}
                      className="p-1 text-text-tertiary hover:text-text-primary transition-colors"
                      title={t('common.edit') || 'Edit'}
                    >
                      <Pencil size={12} />
                    </button>
                    <button
                      onClick={() => setDeletingServer(s)}
                      disabled={s.isBuiltin === 1}
                      className={`p-1 transition-colors ${
                        s.isBuiltin === 1
                          ? 'text-text-tertiary/40 cursor-not-allowed'
                          : 'text-text-tertiary hover:text-error'
                      }`}
                      title={
                        s.isBuiltin === 1
                          ? t('settings.mcpBuiltinCannotDelete')
                          : t('settings.mcpDelete')
                      }
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>

                {showError && (
                  <div className="px-4 py-2 text-[11px] text-red-400 bg-red-500/5">{s.error}</div>
                )}

                {showBuiltinHint && (
                  <div className="px-4 py-2 text-[11px] text-amber-500 bg-amber-500/5">
                    {t('settings.mcpBuiltinConfigureHint')}
                  </div>
                )}

                {expanded && (
                  <div className="px-4 py-3 bg-bg-tertiary/15">
                    {tools.length === 0 ? (
                      <p className="text-[11px] text-text-tertiary">
                        {s.status === 'connected' ? 'No tools discovered' : statusText(s.status, t)}
                      </p>
                    ) : (
                      <div className="space-y-1">
                        <p className="text-[11px] text-text-tertiary mb-1.5">
                          {t('settings.mcpTools')} ({tools.length})
                        </p>
                        {tools.map((tool) => (
                          <ToolDescItem key={tool.name} tool={tool} />
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })
        )}
      </SettingsSection>

      {deletingServer && (
        <ConfirmDialog
          title={t('settings.mcpDeleteConfirm', { name: deletingServer.name })}
          confirmText={t('common.delete')}
          cancelText={t('common.cancel')}
          onConfirm={confirmDelete}
          onCancel={() => setDeletingServer(null)}
        />
      )}

      {dialogOpen && (
        <McpServerDialog
          initial={dialogInitial}
          allowStdio={allowStdio}
          onSave={handleDialogSave}
          onClose={() => setDialogOpen(false)}
        />
      )}
    </div>
  )
}
