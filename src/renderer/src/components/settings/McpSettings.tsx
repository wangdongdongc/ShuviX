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
  Server
} from 'lucide-react'
import { ConfirmDialog } from '../common/ConfirmDialog'

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
  status: 'connected' | 'disconnected' | 'connecting' | 'error'
  error?: string
  toolCount: number
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

/** 解析多行文本为数组 */
function linesToArray(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
}

/** 解析 KEY=VALUE 多行文本为对象 */
function linesToKV(text: string): Record<string, string> {
  const obj: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const idx = trimmed.indexOf('=')
    if (idx > 0) {
      obj[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim()
    }
  }
  return obj
}

/** 解析 Key: Value 多行文本为对象 */
function linesToHeaders(text: string): Record<string, string> {
  const obj: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const idx = trimmed.indexOf(':')
    if (idx > 0) {
      obj[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim()
    }
  }
  return obj
}

/** JSON 数组转多行文本 */
function arrayToLines(json: string): string {
  try {
    return (JSON.parse(json) as string[]).join('\n')
  } catch {
    return ''
  }
}

/** JSON 对象转 KEY=VALUE 多行文本 */
function kvToLines(json: string): string {
  try {
    const obj = JSON.parse(json)
    return Object.entries(obj)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n')
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
export function McpSettings(): React.JSX.Element {
  const { t } = useTranslation()
  const [servers, setServers] = useState<McpServerInfo[]>([])
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [tools, setTools] = useState<McpToolInfo[]>([])
  const [showAdd, setShowAdd] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)

  // 添加/编辑表单状态
  const [formName, setFormName] = useState('')
  const [formType, setFormType] = useState<'stdio' | 'http'>('stdio')
  const [formCommand, setFormCommand] = useState('')
  const [formArgs, setFormArgs] = useState('')
  const [formEnv, setFormEnv] = useState('')
  const [formUrl, setFormUrl] = useState('')
  const [formHeaders, setFormHeaders] = useState('')
  const [saving, setSaving] = useState(false)

  const loadServers = useCallback(async () => {
    const list = await window.api.mcp.list()
    setServers(list)
  }, [])

  useEffect(() => {
    loadServers()
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
      const t = await window.api.mcp.getTools(id)
      setTools(t)
    }
  }

  /** 重置表单 */
  const resetForm = (): void => {
    setFormName('')
    setFormType('stdio')
    setFormCommand('')
    setFormArgs('')
    setFormEnv('')
    setFormUrl('')
    setFormHeaders('')
    setEditId(null)
    setShowAdd(false)
  }

  /** 打开编辑模式 */
  const startEdit = (s: McpServerInfo): void => {
    setEditId(s.id)
    setFormName(s.name)
    setFormType(s.type)
    setFormCommand(s.command)
    setFormArgs(arrayToLines(s.args))
    setFormEnv(kvToLines(s.env))
    setFormUrl(s.url)
    setFormHeaders(headersToLines(s.headers))
    setShowAdd(true)
  }

  /** 保存 */
  const handleSave = async (): Promise<void> => {
    if (!formName.trim()) return
    if (formType === 'stdio' && !formCommand.trim()) return
    if (formType === 'http' && !formUrl.trim()) return
    setSaving(true)
    try {
      if (editId) {
        await window.api.mcp.update({
          id: editId,
          name: formName.trim(),
          type: formType,
          command: formCommand.trim(),
          args: linesToArray(formArgs),
          env: linesToKV(formEnv),
          url: formUrl.trim(),
          headers: linesToHeaders(formHeaders)
        })
      } else {
        await window.api.mcp.add({
          name: formName.trim(),
          type: formType,
          command: formCommand.trim(),
          args: linesToArray(formArgs),
          env: linesToKV(formEnv),
          url: formUrl.trim(),
          headers: linesToHeaders(formHeaders)
        })
      }
      resetForm()
      await loadServers()
    } finally {
      setSaving(false)
    }
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
    <div className="flex-1 px-5 py-5 space-y-4">
      {/* 标题 + 描述 */}
      <div>
        <h3 className="text-sm font-semibold text-text-primary">{t('settings.mcpTitle')}</h3>
        <p className="text-[11px] text-text-tertiary mt-1">{t('settings.mcpDesc')}</p>
      </div>

      {/* 添加按钮 */}
      {!showAdd && (
        <button
          onClick={() => {
            resetForm()
            setShowAdd(true)
          }}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-accent text-white hover:bg-accent/90 transition-colors"
        >
          <Plus size={12} />
          {t('settings.mcpAdd')}
        </button>
      )}

      {/* 添加/编辑表单 */}
      {showAdd && (
        <div className="border border-border-secondary rounded-lg p-4 space-y-3 bg-bg-secondary">
          {/* 名称 */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1">
              {t('settings.mcpName')}
            </label>
            <input
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              className="w-full bg-bg-tertiary border border-border-primary rounded-lg px-3 py-1.5 text-xs text-text-primary outline-none focus:border-accent transition-colors font-mono"
              placeholder={t('settings.mcpNamePlaceholder')}
            />
          </div>

          {/* 类型 */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1">
              {t('settings.mcpType')}
            </label>
            <div className="flex gap-2">
              {(['stdio', 'http'] as const).map((tp) => (
                <button
                  key={tp}
                  onClick={() => setFormType(tp)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                    formType === tp
                      ? 'bg-accent text-white'
                      : 'bg-bg-tertiary text-text-secondary hover:text-text-primary hover:bg-bg-hover'
                  }`}
                >
                  {tp === 'stdio' ? t('settings.mcpTypeStdio') : t('settings.mcpTypeHttp')}
                </button>
              ))}
            </div>
          </div>

          {/* stdio 配置 */}
          {formType === 'stdio' && (
            <>
              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1">
                  {t('settings.mcpCommand')}
                </label>
                <input
                  value={formCommand}
                  onChange={(e) => setFormCommand(e.target.value)}
                  className="w-full bg-bg-tertiary border border-border-primary rounded-lg px-3 py-1.5 text-xs text-text-primary outline-none focus:border-accent transition-colors font-mono"
                  placeholder={t('settings.mcpCommandPlaceholder')}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1">
                  {t('settings.mcpArgs')}
                </label>
                <textarea
                  value={formArgs}
                  onChange={(e) => setFormArgs(e.target.value)}
                  rows={3}
                  className="w-full bg-bg-tertiary border border-border-primary rounded-lg px-3 py-1.5 text-xs text-text-primary outline-none focus:border-accent transition-colors resize-none font-mono"
                  placeholder={t('settings.mcpArgsPlaceholder')}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1">
                  {t('settings.mcpEnv')}
                </label>
                <textarea
                  value={formEnv}
                  onChange={(e) => setFormEnv(e.target.value)}
                  rows={2}
                  className="w-full bg-bg-tertiary border border-border-primary rounded-lg px-3 py-1.5 text-xs text-text-primary outline-none focus:border-accent transition-colors resize-none font-mono"
                  placeholder={t('settings.mcpEnvPlaceholder')}
                />
              </div>
            </>
          )}

          {/* http 配置 */}
          {formType === 'http' && (
            <>
              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1">
                  {t('settings.mcpUrl')}
                </label>
                <input
                  value={formUrl}
                  onChange={(e) => setFormUrl(e.target.value)}
                  className="w-full bg-bg-tertiary border border-border-primary rounded-lg px-3 py-1.5 text-xs text-text-primary outline-none focus:border-accent transition-colors font-mono"
                  placeholder={t('settings.mcpUrlPlaceholder')}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1">
                  {t('settings.mcpHeaders')}
                </label>
                <textarea
                  value={formHeaders}
                  onChange={(e) => setFormHeaders(e.target.value)}
                  rows={2}
                  className="w-full bg-bg-tertiary border border-border-primary rounded-lg px-3 py-1.5 text-xs text-text-primary outline-none focus:border-accent transition-colors resize-none font-mono"
                  placeholder={t('settings.mcpHeadersPlaceholder')}
                />
              </div>
            </>
          )}

          {/* 操作按钮 */}
          <div className="flex justify-end gap-2 pt-1">
            <button
              onClick={resetForm}
              className="px-3 py-1.5 rounded-lg text-xs text-text-secondary hover:bg-bg-hover transition-colors"
            >
              {t('common.cancel')}
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-3 py-1.5 rounded-lg text-xs bg-accent text-white hover:bg-accent/90 transition-colors disabled:opacity-50"
            >
              {saving ? t('settings.mcpSaving') : t('common.save')}
            </button>
          </div>
        </div>
      )}

      {/* Server 列表 */}
      {servers.length === 0 && !showAdd ? (
        <div className="text-center py-8">
          <Server size={32} className="mx-auto text-text-tertiary mb-3 opacity-40" />
          <p className="text-xs text-text-tertiary">{t('settings.mcpEmpty')}</p>
          <p className="text-[10px] text-text-tertiary mt-1">{t('settings.mcpEmptyHint')}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {servers.map((s) => (
            <div key={s.id} className="border border-border-secondary rounded-lg overflow-hidden">
              {/* Server 头部 */}
              <div className="flex items-center gap-2 px-3 py-2.5 bg-bg-secondary">
                {/* 展开/收起 */}
                <button
                  onClick={() => toggleExpand(s.id)}
                  className="text-text-tertiary hover:text-text-secondary transition-colors"
                >
                  {expandedId === s.id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </button>

                {/* 状态灯 + 名称 */}
                <StatusDot status={s.status} />
                <span className="text-xs font-medium text-text-primary flex-1">{s.name}</span>

                {/* 类型标签 */}
                <span className="text-[10px] text-text-tertiary bg-bg-tertiary px-1.5 py-0.5 rounded">
                  {s.type}
                </span>

                {/* 状态文字 */}
                <span
                  className={`text-[10px] ${s.status === 'error' ? 'text-red-400' : 'text-text-tertiary'}`}
                >
                  {statusText(s.status, t)}
                  {s.status === 'connected' &&
                    ` · ${t('settings.mcpToolCount', { count: s.toolCount })}`}
                </span>

                {/* 操作按钮 */}
                <div className="flex items-center gap-1">
                  {s.status === 'error' || s.status === 'disconnected' ? (
                    <button
                      onClick={() => handleReconnect(s.id)}
                      className="p-1 text-text-tertiary hover:text-accent transition-colors"
                      title={t('settings.mcpReconnect')}
                    >
                      <RefreshCw size={12} />
                    </button>
                  ) : null}
                  <button
                    onClick={() => handleToggle(s)}
                    className={`p-1 transition-colors ${s.isEnabled ? 'text-accent hover:text-accent/70' : 'text-text-tertiary hover:text-text-secondary'}`}
                    title={s.isEnabled ? t('settings.mcpDisconnect') : t('settings.mcpConnect')}
                  >
                    {s.isEnabled ? <Power size={12} /> : <PowerOff size={12} />}
                  </button>
                  <button
                    onClick={() => startEdit(s)}
                    className="p-1 text-text-tertiary hover:text-text-secondary transition-colors"
                    title={t('common.edit') || 'Edit'}
                  >
                    <Wrench size={12} />
                  </button>
                  <button
                    onClick={() => handleDelete(s)}
                    className="p-1 text-text-tertiary hover:text-red-400 transition-colors"
                    title={t('settings.mcpDelete')}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>

              {/* 错误信息 */}
              {s.status === 'error' && s.error && (
                <div className="px-3 py-1.5 text-[10px] text-red-400 bg-red-500/5 border-t border-border-secondary">
                  {s.error}
                </div>
              )}

              {/* 展开的工具列表 */}
              {expandedId === s.id && (
                <div className="border-t border-border-secondary px-3 py-2">
                  {tools.length === 0 ? (
                    <p className="text-[10px] text-text-tertiary">
                      {s.status === 'connected' ? 'No tools discovered' : statusText(s.status, t)}
                    </p>
                  ) : (
                    <div className="space-y-1">
                      <p className="text-[10px] text-text-tertiary mb-1.5">
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
          ))}
        </div>
      )}
      {/* 删除 MCP Server 确认弹窗 */}
      {deletingServer && (
        <ConfirmDialog
          title={t('settings.mcpDeleteConfirm', { name: deletingServer.name })}
          confirmText={t('common.delete')}
          cancelText={t('common.cancel')}
          onConfirm={confirmDelete}
          onCancel={() => setDeletingServer(null)}
        />
      )}
    </div>
  )
}
