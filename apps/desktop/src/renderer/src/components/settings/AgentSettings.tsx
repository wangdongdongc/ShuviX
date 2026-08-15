import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Bot, Loader2, Plus, RefreshCw, X } from 'lucide-react'
import { useDialogClose } from '@shuvix/chat-ui'
import { SubAgentEditor, type SubAgentEditData } from './SubAgentEditor'

/**
 * 设置页顶层「智能体」tab —— 与提供商设置同形：左侧每个 agent 一个子项（内置与
 * 自定义合并为同一列表、内置始终置顶），右侧为 SubAgentEditor 详情（内置 agent
 * 只读；用户 agent 可编辑/删除）。纯 md 驱动：文件存在即可用，无启用开关。
 * 数据源自 subAgent IPC（每次 list 现扫文件系统），底部提供新建 / 重扫描。
 */

/** 列表项唯一键（default 被覆盖时 builtin/user 两行并存,name 不再唯一） */
function keyOf(a: SubAgentInfo): string {
  return `${a.source}:${a.name}`
}

/** 展示顺序：内置始终置顶，组内保持后端的字母序 */
function orderAgents(list: SubAgentInfo[]): SubAgentInfo[] {
  return [...list.filter((a) => a.source === 'builtin'), ...list.filter((a) => a.source === 'user')]
}
export function AgentSettings(): React.JSX.Element {
  const { t } = useTranslation()

  const [agents, setAgents] = useState<SubAgentInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [creating, setCreating] = useState<false | { initial?: SubAgentInfo }>(false)

  const load = useCallback(async (): Promise<SubAgentInfo[]> => {
    const list = await window.api.subAgent.list()
    setAgents(list)
    setLoading(false)
    return list
  }, [])

  useEffect(() => {
    load().then((list) => {
      setSelectedKey((cur) => cur ?? (orderAgents(list)[0] ? keyOf(orderAgents(list)[0]) : null))
    })
  }, [load])

  const handleRefresh = async (): Promise<void> => {
    setRefreshing(true)
    try {
      // list 即现扫文件系统,重扫描 = 重新拉取
      const list = await load()
      // 刷新后选中项可能已被删除/改名
      setSelectedKey((cur) =>
        list.some((a) => keyOf(a) === cur)
          ? cur
          : orderAgents(list)[0]
            ? keyOf(orderAgents(list)[0])
            : null
      )
    } finally {
      setRefreshing(false)
    }
  }

  /** 新建：null = 成功（对话框侧负责退场），选中新建项 */
  const handleCreate = useCallback(
    async (data: SubAgentEditData): Promise<string | null> => {
      const res = await window.api.subAgent.create({ agent: data })
      if (!res.success) return res.error ?? 'Create failed'
      await load()
      setSelectedKey(`user:${res.name ?? data.name}`)
      return null
    },
    [load]
  )

  /** 编辑保存：null = 成功；改名后选中项跟随新名 */
  const handleSave = useCallback(
    async (data: SubAgentEditData): Promise<string | null> => {
      const originalName = selectedKey?.split(':').slice(1).join(':')
      if (!originalName) return null
      const res = await window.api.subAgent.save({ originalName, agent: data })
      if (!res.success) return res.error ?? 'Save failed'
      await load()
      setSelectedKey(`user:${data.name}`)
      return null
    },
    [selectedKey, load]
  )

  /** 删除选中的用户档案:null = 成功(选中回落);字符串 = 错误就地展示 */
  const handleDelete = useCallback(async (): Promise<string | null> => {
    const name = selectedKey?.split(':').slice(1).join(':')
    if (!name) return null
    const res = await window.api.subAgent.delete({ name })
    if (!res.success) return res.error ?? 'Delete failed'
    const list = await load()
    // 优先落到同名内置(删除覆盖档案的场景),否则列表首位
    const fallback =
      list.find((a) => a.source === 'builtin' && a.name === name) ?? orderAgents(list)[0]
    setSelectedKey(fallback ? keyOf(fallback) : null)
    return null
  }, [selectedKey, load])

  const selected = agents.find((a) => keyOf(a) === selectedKey) ?? null

  return (
    <div className="flex flex-1 min-h-0 h-full">
      {/* 左侧：agent 列表（内置 / 自定义分组） */}
      <div className="w-[220px] flex-shrink-0 border-r border-border-secondary flex flex-col">
        <div className="flex-1 overflow-y-auto py-2 px-2 space-y-0.5">
          {loading ? (
            <div className="flex items-center gap-2 text-text-tertiary py-2 px-1">
              <Loader2 size={14} className="animate-spin" />
              <span className="text-[11px]">{t('common.loading') || 'Loading...'}</span>
            </div>
          ) : (
            orderAgents(agents).map((agent) => (
              <AgentRow
                key={`${agent.source}:${agent.name}`}
                agent={agent}
                selected={selectedKey === keyOf(agent)}
                onSelect={() => setSelectedKey(keyOf(agent))}
              />
            ))
          )}
        </div>

        {/* 底部操作：添加自定义智能体 / 重扫描 */}
        <div className="border-t border-border-secondary p-2 flex items-center gap-1.5">
          <button
            onClick={() => setCreating({})}
            title={t('tool.subAgentFsHint')}
            className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg border border-dashed border-border-secondary text-[11px] text-text-secondary hover:text-text-primary hover:border-accent/40 hover:bg-accent/5 transition-colors"
          >
            <Plus size={12} />
            {t('tool.subAgentAdd')}
          </button>
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            title={t('tool.subAgentRefresh')}
            className="px-2 py-1.5 rounded-lg border border-dashed border-border-secondary text-text-secondary hover:text-text-primary hover:border-accent/40 hover:bg-accent/5 transition-colors disabled:opacity-50"
          >
            <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* 右侧：编辑器详情（内置只读；按 agent 重挂载） */}
      <div className="flex-1 min-w-0 flex flex-col min-h-0">
        {selected && (
          <SubAgentEditor
            key={`${selected.source}:${selected.name}`}
            agent={selected}
            readOnly={selected.source === 'builtin'}
            onSave={handleSave}
            onCreateOverride={
              selected.source === 'builtin' ? () => setCreating({ initial: selected }) : undefined
            }
            onDelete={selected.source === 'user' ? handleDelete : undefined}
          />
        )}
      </div>

      {/* 新建对话框（复用编辑组件的 create 模式） */}
      {creating && (
        <CreateAgentDialog
          initial={creating.initial}
          onCreate={handleCreate}
          onClose={() => setCreating(false)}
        />
      )}
    </div>
  )
}

/** 空白模板（新建对话框的编辑器初始值） */
const BLANK_AGENT: SubAgentInfo = {
  name: '',
  displayName: '',
  description: '',
  systemPrompt: '',
  tools: [],
  // 新建默认注入开关全开（指令文件 / 项目提示词）
  instructionFiles: true,
  projectPrompt: true,
  // 新建的用户 agent 默认可切换（dispatch-only 目前只有内置执行型 agent 用，需手写 md 开启）
  dispatchOnly: false,
  source: 'user',
  basePath: ''
}

function CreateAgentDialog({
  initial,
  onCreate,
  onClose
}: {
  /** 预填内容(「创建覆盖副本」传入当前语言展开的内置档案;缺省空白模板) */
  initial?: SubAgentInfo
  onCreate: (data: SubAgentEditData) => Promise<string | null>
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { closing, handleClose } = useDialogClose(onClose)

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') handleClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [handleClose])

  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center bg-black/30 ${
        closing ? 'animate-fade-out' : 'animate-fade-in'
      }`}
      onClick={handleClose}
    >
      <div
        className={`bg-bg-primary border border-border-primary rounded-lg shadow-xl w-[720px] max-w-[92vw] h-[85vh] flex flex-col ${
          closing ? 'animate-scale-out' : 'animate-scale-in'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-secondary shrink-0">
          <span className="font-medium">{t('tool.subAgentAdd')}</span>
          <button onClick={handleClose} className="text-text-tertiary hover:text-text-primary">
            <X size={16} />
          </button>
        </div>
        <div className="flex-1 min-h-0">
          <SubAgentEditor
            agent={initial ? { ...initial, source: 'user', basePath: '' } : BLANK_AGENT}
            mode="create"
            onSave={async (data) => {
              const err = await onCreate(data)
              if (!err) handleClose()
              return err
            }}
          />
        </div>
      </div>
    </div>
  )
}

function AgentRow({
  agent,
  selected,
  onSelect
}: {
  agent: SubAgentInfo
  selected: boolean
  onSelect: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const overriddenLabel = t('tool.subAgentOverridden')
  return (
    <button
      onClick={onSelect}
      className={`group w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left transition-colors ${
        selected
          ? 'bg-accent/10 text-accent'
          : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
      } ${agent.overridden ? 'opacity-60' : ''}`}
    >
      <Bot size={14} className="shrink-0" />
      <div className="min-w-0 flex-1">
        <div
          className={`text-xs font-medium truncate ${agent.overridden ? 'line-through text-text-tertiary' : ''}`}
        >
          {agent.displayName}
        </div>
      </div>
      {agent.overridden && (
        /* 被同名自定义覆盖的内置：仅展示,不生效 */
        <span className="shrink-0 px-1.5 py-0.5 rounded text-[9px] bg-bg-secondary text-text-tertiary">
          {overriddenLabel}
        </span>
      )}
    </button>
  )
}
