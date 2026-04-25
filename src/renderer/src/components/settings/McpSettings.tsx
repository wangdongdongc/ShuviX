import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Plus,
  Trash2,
  X,
  RefreshCw,
  Power,
  PowerOff,
  ChevronDown,
  ChevronRight,
  Wrench,
  Server,
  PlugZap
} from 'lucide-react'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { McpServerPanel } from './McpServerPanel'

/** 子标签页类型 */
type McpSubTab = 'client' | 'server'

/** 子分类导航按钮（与 ToolSettings 保持一致） */
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
      className={`w-full flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs transition-colors text-left ${
        active
          ? 'bg-accent/10 text-accent font-medium'
          : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
      }`}
    >
      {icon}
      <span className="truncate">{label}</span>
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

/** 解析多行文本为数组 */
function linesToArray(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
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

/** 将 UI 的 { key, value } 行数组合并回 Record（忽略空 key） */
function pairsToEnvObject(pairs: Array<{ key: string; value: string }>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const { key, value } of pairs) {
    const k = key.trim()
    if (k) result[k] = value
  }
  return result
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
  const [showAdd, setShowAdd] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)

  // 添加/编辑表单状态
  const [formName, setFormName] = useState('')
  const [formType, setFormType] = useState<'stdio' | 'http'>('stdio')
  const [formCommand, setFormCommand] = useState('')
  const [formArgs, setFormArgs] = useState('')
  const [formEnvPairs, setFormEnvPairs] = useState<Array<{ key: string; value: string }>>([])
  const [formUrl, setFormUrl] = useState('')
  const [formHeaders, setFormHeaders] = useState('')
  const [editingIsBuiltin, setEditingIsBuiltin] = useState(false)
  /** 进入编辑时的 enabled 状态（用于内置服务首次填 Key 后自动启用） */
  const [editingWasEnabled, setEditingWasEnabled] = useState(false)
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
    setFormEnvPairs([])
    setFormUrl('')
    setFormHeaders('')
    setEditingIsBuiltin(false)
    setEditingWasEnabled(false)
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
    setFormEnvPairs(jsonEnvToPairs(s.env))
    setFormUrl(s.url)
    setFormHeaders(headersToLines(s.headers))
    setEditingIsBuiltin(s.isBuiltin === 1)
    setEditingWasEnabled(s.isEnabled === 1)
    setShowAdd(true)
  }

  /** env pair 行操作 */
  const updateEnvPair = (idx: number, field: 'key' | 'value', v: string): void => {
    setFormEnvPairs((prev) => prev.map((p, i) => (i === idx ? { ...p, [field]: v } : p)))
  }
  const addEnvPair = (): void => {
    setFormEnvPairs((prev) => [...prev, { key: '', value: '' }])
  }
  const removeEnvPair = (idx: number): void => {
    setFormEnvPairs((prev) => prev.filter((_, i) => i !== idx))
  }

  /** 保存 */
  const handleSave = async (): Promise<void> => {
    // 内置 server 跳过 name/command/url 必填校验（均为只读）
    if (!editingIsBuiltin) {
      if (!formName.trim()) return
      if (formType === 'stdio' && !formCommand.trim()) return
      if (formType === 'http' && !formUrl.trim()) return
    }
    setSaving(true)
    try {
      const envObj = pairsToEnvObject(formEnvPairs)
      if (editId) {
        await window.api.mcp.update({
          id: editId,
          name: formName.trim(),
          type: formType,
          command: formCommand.trim(),
          args: linesToArray(formArgs),
          env: envObj,
          url: formUrl.trim(),
          headers: linesToHeaders(formHeaders)
        })
        // 内置 server 首次填 Key 后自动启用：之前未启用 + 本次 env 全部有值
        if (editingIsBuiltin && !editingWasEnabled) {
          const allFilled =
            Object.keys(envObj).length > 0 &&
            Object.values(envObj).every((v) => v.trim().length > 0)
          if (allFilled) {
            await window.api.mcp.update({ id: editId, isEnabled: true })
          }
        }
      } else {
        await window.api.mcp.add({
          name: formName.trim(),
          type: formType,
          command: formCommand.trim(),
          args: linesToArray(formArgs),
          env: envObj,
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
          {editingIsBuiltin && (
            <div className="px-2 py-1.5 text-[10px] text-amber-500 bg-amber-500/5 rounded border border-amber-500/20">
              {t('settings.mcpBuiltinReadonlyNotice')}
            </div>
          )}

          {/* 名称 */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1">
              {t('settings.mcpName')}
            </label>
            <input
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              disabled={editingIsBuiltin}
              className={`zen-input font-mono ${editingIsBuiltin ? 'opacity-60 cursor-not-allowed' : ''}`}
              placeholder={t('settings.mcpNamePlaceholder')}
            />
          </div>

          {/* 类型 — 内置服务下只读 */}
          {!editingIsBuiltin && (
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
          )}

          {/* 内置服务：仅显示只读 URL + 可编辑 env（key 只读） */}
          {editingIsBuiltin && (
            <>
              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1">
                  {t('settings.mcpUrl')}
                </label>
                <input
                  value={formUrl}
                  disabled
                  className="zen-input font-mono opacity-60 cursor-not-allowed"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1">
                  {t('settings.mcpEnv')}
                </label>
                <div className="space-y-1.5">
                  {formEnvPairs.map((pair, idx) => (
                    <div key={idx} className="flex gap-2 items-center">
                      <input
                        value={pair.key}
                        disabled
                        className="zen-input font-mono flex-1 opacity-60 cursor-not-allowed"
                      />
                      <input
                        value={pair.value}
                        onChange={(e) => updateEnvPair(idx, 'value', e.target.value)}
                        className="zen-input font-mono flex-1"
                        placeholder={t('settings.mcpEnvValuePlaceholder')}
                      />
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}

          {/* stdio 配置 */}
          {!editingIsBuiltin && formType === 'stdio' && (
            <>
              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1">
                  {t('settings.mcpCommand')}
                </label>
                <input
                  value={formCommand}
                  onChange={(e) => setFormCommand(e.target.value)}
                  className="zen-input font-mono"
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
                  className="zen-textarea font-mono"
                  placeholder={t('settings.mcpArgsPlaceholder')}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1">
                  {t('settings.mcpEnv')}
                </label>
                <div className="space-y-1.5">
                  {formEnvPairs.map((pair, idx) => (
                    <div key={idx} className="flex gap-2 items-center">
                      <input
                        value={pair.key}
                        onChange={(e) => updateEnvPair(idx, 'key', e.target.value)}
                        className="zen-input font-mono flex-1"
                        placeholder={t('settings.mcpEnvKeyPlaceholder')}
                      />
                      <input
                        value={pair.value}
                        onChange={(e) => updateEnvPair(idx, 'value', e.target.value)}
                        className="zen-input font-mono flex-1"
                        placeholder={t('settings.mcpEnvValuePlaceholder')}
                      />
                      <button
                        onClick={() => removeEnvPair(idx)}
                        className="p-1 text-text-tertiary hover:text-red-400 transition-colors"
                        title={t('common.delete')}
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ))}
                  <button
                    onClick={addEnvPair}
                    className="flex items-center gap-1 text-[10px] text-accent hover:text-accent/80 transition-colors"
                  >
                    <Plus size={11} />
                    {t('settings.mcpEnvAdd')}
                  </button>
                </div>
              </div>
            </>
          )}

          {/* http 配置 */}
          {!editingIsBuiltin && formType === 'http' && (
            <>
              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1">
                  {t('settings.mcpUrl')}
                </label>
                <input
                  value={formUrl}
                  onChange={(e) => setFormUrl(e.target.value)}
                  className="zen-input font-mono"
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
                  className="zen-textarea font-mono"
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

                {/* 内置标签 */}
                {s.isBuiltin === 1 && (
                  <span className="text-[10px] text-amber-500 bg-amber-500/10 px-1.5 py-0.5 rounded">
                    {t('settings.mcpBuiltin')}
                  </span>
                )}

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
                    disabled={s.isBuiltin === 1}
                    className={`p-1 transition-colors ${
                      s.isBuiltin === 1
                        ? 'text-text-tertiary/40 cursor-not-allowed'
                        : 'text-text-tertiary hover:text-red-400'
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
              {s.status === 'error' && s.error && (
                <div className="px-3 py-1.5 text-[10px] text-red-400 bg-red-500/5 border-t border-border-secondary">
                  {s.error}
                </div>
              )}

              {/* 内置 server 未配置 API Key 提示 */}
              {s.isBuiltin === 1 && !envHasAllValues(s.env) && (
                <div className="px-3 py-1.5 text-[10px] text-amber-500 bg-amber-500/5 border-t border-border-secondary">
                  {t('settings.mcpBuiltinConfigureHint')}
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

/** MCP 设置页（含子标签页：客户端 + 服务） */
export function McpSettings(): React.JSX.Element {
  const { t } = useTranslation()
  const [subTab, setSubTab] = useState<McpSubTab>('client')

  return (
    <div className="flex flex-1 min-h-0 h-full">
      {/* 左侧子导航 */}
      <div className="w-[140px] flex-shrink-0 border-r border-border-secondary py-4 px-2.5 space-y-0.5">
        <SubTabButton
          icon={<PlugZap size={13} />}
          label={t('settings.mcpSubTabClient')}
          active={subTab === 'client'}
          onClick={() => setSubTab('client')}
        />
        <SubTabButton
          icon={<Server size={13} />}
          label={t('settings.mcpSubTabServer')}
          active={subTab === 'server'}
          onClick={() => setSubTab('server')}
        />
      </div>

      {/* 右侧内容区 */}
      <div className="flex-1 min-w-0 overflow-y-auto">
        {subTab === 'client' && <McpClientPanel />}
        {subTab === 'server' && <McpServerPanel />}
      </div>
    </div>
  )
}
