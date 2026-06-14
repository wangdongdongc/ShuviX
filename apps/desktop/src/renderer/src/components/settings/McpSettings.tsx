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
  PlugZap,
  Pencil
} from 'lucide-react'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { McpServerPanel } from './McpServerPanel'
import { SettingsSection } from './SettingsPrimitives'
import {
  McpServerDialog,
  type McpServerDialogData,
  type McpServerDialogInitial
} from './McpServerDialog'

/** 子标签页类型 */
type McpSubTab = 'client' | 'server'

/** 子分类导航按钮（与 ProviderSettings / SkillSettings 保持视觉一致） */
function SubTabButton({
  icon,
  label,
  active,
  onClick
}: {
  icon: React.ReactNode
  label: string
  active: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`group w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left transition-colors ${
        active
          ? 'bg-accent/10 text-accent'
          : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
      }`}
    >
      {/* 18px 高度槽位 — 与 Provider/Skill 行末 Toggle 同高，保证内容行高一致（按钮总高 30px） */}
      <span className="shrink-0 inline-flex items-center h-[18px]">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium truncate">{label}</div>
      </div>
    </button>
  )
}

/** MCP Server 信息（从主进程返回） */
interface McpServerInfo {
  id: string
  name: string
  type: 'stdio' | 'http'
  command: string
  args: string
  env: string
  url: string
  headers: string
  isEnabled: number
  isBuiltin: number
  status: 'connected' | 'disconnected' | 'connecting' | 'error'
  error?: string
  toolCount: number
}

/** 判断 env JSON 字符串里是否所有 value 都非空（即所需 API Key 均已配置） */
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

/** MCP 工具信息 */
interface McpToolInfo {
  name: string
  label: string
  description: string
  group: string
}

/** 状态指示灯颜色 */
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

/** 单个工具描述项 — 默认截断两行，点击可展开全文 */
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

/** 状态文案 */
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

/** 将 env JSON 字符串解析为 { key, value } 行数组（UI 编辑态） */
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

/** JSON 数组转多行文本 */
function arrayToLines(json: string): string {
  try {
    return (JSON.parse(json) as string[]).join('\n')
  } catch {
    return ''
  }
}

/** JSON 对象转 Key: Value 多行文本 */
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

/** MCP 设置页 */
function McpClientPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const [servers, setServers] = useState<McpServerInfo[]>([])
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [tools, setTools] = useState<McpToolInfo[]>([])
  const [dialogInitial, setDialogInitial] = useState<McpServerDialogInitial | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [dialogEditId, setDialogEditId] = useState<string | null>(null)

  const loadServers = useCallback(async () => {
    const list = await window.api.mcp.list()
    setServers(list)
  }, [])

  useEffect(() => {
    loadServers() // eslint-disable-line react-hooks/set-state-in-effect
    // 定时刷新状态
    const timer = setInterval(loadServers, 3000)
    return () => clearInterval(timer)
  }, [loadServers])

  /** 展开/收起 server 工具列表 */
  const toggleExpand = async (id: string): Promise<void> => {
    if (expandedId === id) {
      setExpandedId(null)
      setTools([])
    } else {
      setExpandedId(id)
      const list = await window.api.mcp.getTools(id)
      setTools(list)
    }
  }

  /** 打开新增弹窗 */
  const openAddDialog = (): void => {
    setDialogInitial(null)
    setDialogEditId(null)
    setDialogOpen(true)
  }

  /** 打开编辑弹窗 */
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

  /** 弹窗保存回调 */
  const handleDialogSave = async (data: McpServerDialogData): Promise<void> => {
    if (dialogEditId) {
      await window.api.mcp.update({
        id: dialogEditId,
        name: data.name,
        type: data.type,
        command: data.command,
        args: data.argsLines,
        env: data.envObject,
        url: data.url,
        headers: data.headersObject
      })
      if (data.autoEnableBuiltin) {
        await window.api.mcp.update({ id: dialogEditId, isEnabled: true })
      }
    } else {
      await window.api.mcp.add({
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

  /** 待删除的 server（非 null 时渲染确认弹窗） */
  const [deletingServer, setDeletingServer] = useState<McpServerInfo | null>(null)

  /** 请求删除 */
  const handleDelete = (s: McpServerInfo): void => {
    setDeletingServer(s)
  }

  /** 确认删除 */
  const confirmDelete = async (): Promise<void> => {
    if (!deletingServer) return
    const id = deletingServer.id
    setDeletingServer(null)
    await window.api.mcp.delete(id)
    if (expandedId === id) {
      setExpandedId(null)
      setTools([])
    }
    await loadServers()
  }

  /** 启用/禁用切换 */
  const handleToggle = async (s: McpServerInfo): Promise<void> => {
    if (s.isEnabled) {
      await window.api.mcp.update({ id: s.id, isEnabled: false })
    } else {
      await window.api.mcp.update({ id: s.id, isEnabled: true })
    }
    await loadServers()
  }

  /** 重连 */
  const handleReconnect = async (id: string): Promise<void> => {
    await window.api.mcp.connect(id)
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
                {/* 主行 */}
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
                      onClick={() => handleDelete(s)}
                      disabled={s.isBuiltin === 1}
                      className={`p-1 transition-colors ${
                        s.isBuiltin === 1
                          ? 'text-text-tertiary/40 cursor-not-allowed'
                          : 'text-text-tertiary hover:text-danger'
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

                {/* 错误信息 */}
                {showError && (
                  <div className="px-4 py-2 text-[11px] text-red-400 bg-red-500/5">{s.error}</div>
                )}

                {/* 内置 server 未配置 API Key 提示 */}
                {showBuiltinHint && (
                  <div className="px-4 py-2 text-[11px] text-amber-500 bg-amber-500/5">
                    {t('settings.mcpBuiltinConfigureHint')}
                  </div>
                )}

                {/* 展开的工具列表 */}
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

      {/* 删除确认弹窗 */}
      {deletingServer && (
        <ConfirmDialog
          title={t('settings.mcpDeleteConfirm', { name: deletingServer.name })}
          confirmText={t('common.delete')}
          cancelText={t('common.cancel')}
          onConfirm={confirmDelete}
          onCancel={() => setDeletingServer(null)}
        />
      )}

      {/* 添加/编辑弹窗 */}
      {dialogOpen && (
        <McpServerDialog
          initial={dialogInitial}
          onSave={handleDialogSave}
          onClose={() => setDialogOpen(false)}
        />
      )}
    </div>
  )
}

/** MCP 设置页（含子标签页：客户端 + 服务） */
export function McpSettings(): React.JSX.Element {
  const { t } = useTranslation()
  const [subTab, setSubTab] = useState<McpSubTab>('client')

  return (
    <div className="flex flex-1 min-h-0 h-full">
      {/* 左侧子导航 */}
      <div className="w-[220px] flex-shrink-0 border-r border-border-secondary flex flex-col">
        <div className="flex-1 overflow-y-auto py-2 px-2 space-y-0.5">
          <SubTabButton
            icon={<PlugZap size={14} className="shrink-0 text-text-tertiary" />}
            label={t('settings.mcpSubTabClient')}
            active={subTab === 'client'}
            onClick={() => setSubTab('client')}
          />
          <SubTabButton
            icon={<Server size={14} className="shrink-0 text-text-tertiary" />}
            label={t('settings.mcpSubTabServer')}
            active={subTab === 'server'}
            onClick={() => setSubTab('server')}
          />
        </div>
      </div>

      {/* 右侧内容区 */}
      <div className="flex-1 min-w-0 overflow-y-auto">
        {subTab === 'client' && <McpClientPanel />}
        {subTab === 'server' && <McpServerPanel />}
      </div>
    </div>
  )
}
