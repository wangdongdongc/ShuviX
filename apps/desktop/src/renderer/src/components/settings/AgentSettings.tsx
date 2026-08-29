import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Bot, Loader2, Lock, Plus, RefreshCw, X } from 'lucide-react'
import { useDialogClose } from '@shuvix/chat-ui'
import { SubAgentEditor } from './SubAgentEditor'

/**
 * 设置页顶层「智能体」tab —— 左侧每个 agent 一个子项（内置与自定义合并为同一列表、
 * 内置始终置顶），右侧为 SubAgentEditor：**整份 md 原文编辑**（frontmatter 由属性卡
 * 渲染成结构化字段，正文即系统提示词），与安全策略 tab 同形。纯 md 驱动：文件存在
 * 即可用，无启用开关。数据源自 subAgent IPC（每次 list 现扫文件系统），底部提供
 * 新建 / 重扫描。
 */

/** 新建智能体的初值（YAML 注释原样保留 —— 原文编辑模型的直接体现） */
function newAgentTemplate(t: (key: string) => string): string {
  return [
    '---',
    'shuvix: agent v1',
    'name: my-agent',
    `description: ${t('tool.subAgentTemplateDesc')}`,
    'shuvix-tools: read, bash',
    'shuvix-instruction-files: AGENTS.md, CLAUDE.md',
    'shuvix-project-awareness: true',
    '---',
    '',
    t('tool.subAgentTemplateBody'),
    ''
  ].join('\n')
}

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
  const [creating, setCreating] = useState<false | { text: string }>(false)
  /** 选中档案的 md 原文（用户档案读文件；内置回写等价 md） */
  const [source, setSource] = useState<{ key: string; text: string } | null>(null)
  const [sourceError, setSourceError] = useState<string | null>(null)

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

  const selectedAgent = agents.find((a) => keyOf(a) === selectedKey) ?? null

  useEffect(() => {
    if (!selectedAgent) {
      setSource(null)
      return
    }
    const key = keyOf(selectedAgent)
    let alive = true
    setSourceError(null)
    void window.api.subAgent
      .getSource({ name: selectedAgent.name, source: selectedAgent.source })
      .then((r) => {
        if (!alive) return
        if ('error' in r) {
          setSource(null)
          setSourceError(r.error)
          return
        }
        setSource({ key, text: r.text })
      })
    return () => {
      alive = false
    }
  }, [selectedAgent])

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

  /** 保存成功（编辑或新建）：重扫列表并选中落盘的那一份（改名/新建后仍定位得到） */
  const handleSaved = useCallback(
    async (name: string): Promise<void> => {
      const list = await load()
      const hit = list.find((a) => a.source === 'user' && a.name === name)
      if (hit) setSelectedKey(keyOf(hit))
    },
    [load]
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

  const selected = selectedAgent

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
            onClick={() => setCreating({ text: newAgentTemplate(t) })}
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
        {sourceError && (
          <div className="m-4 px-3 py-2 rounded-lg bg-red-500/10 text-red-500 text-[11px] whitespace-pre-wrap break-words">
            {sourceError}
          </div>
        )}
        {selected && source?.key === keyOf(selected) && (
          <SubAgentEditor
            key={source.key}
            agent={selected}
            initialText={source.text}
            readOnly={selected.source === 'builtin'}
            onSaved={handleSaved}
            onCreateOverride={
              selected.source === 'builtin' ? () => setCreating({ text: source.text }) : undefined
            }
            onDelete={selected.source === 'user' ? handleDelete : undefined}
          />
        )}
      </div>

      {/* 新建对话框（复用编辑组件的 create 模式） */}
      {creating && (
        <CreateAgentDialog
          initialText={creating.text}
          onSaved={handleSaved}
          onClose={() => setCreating(false)}
        />
      )}
    </div>
  )
}

function CreateAgentDialog({
  initialText,
  onSaved,
  onClose
}: {
  /** 预填 md 原文（「创建覆盖副本」传内置档案的等价 md；缺省新建模板） */
  initialText: string
  onSaved: (name: string) => Promise<void>
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
        {/* 必须是 flex 列：编辑器根节点靠 `flex-1 min-h-0 overflow-y-auto` 自滚，
            父级是普通 block 时那两个类全失效 → 高度撑成内容高、长档案直接溢出对话框 */}
        <div className="flex-1 min-h-0 flex flex-col">
          <SubAgentEditor
            agent={CREATE_PLACEHOLDER}
            initialText={initialText}
            mode="create"
            onSaved={async (name) => {
              await onSaved(name)
              handleClose()
            }}
          />
        </div>
      </div>
    </div>
  )
}

/** create 模式只用到 name/source 两个字段（头部徽标由 mode 决定不显示） */
const CREATE_PLACEHOLDER: SubAgentInfo = {
  name: '',
  displayName: '',
  description: '',
  systemPrompt: '',
  tools: [],
  instructionFiles: ['AGENTS.md', 'CLAUDE.md'],
  projectAwareness: true,
  dispatchOnly: false,
  source: 'user',
  basePath: ''
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
      {agent.source === 'builtin' && (
        /* 内置随包发布、不可直接编辑 —— 锁即「这行只能建覆盖副本」 */
        <span title={t('tool.subAgentBuiltin')} className="shrink-0 text-text-tertiary">
          <Lock size={11} />
        </span>
      )}
    </button>
  )
}
