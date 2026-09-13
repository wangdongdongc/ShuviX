import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Bot, Copy, Loader2, Lock, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { BuiltinSourceView, RegistryNoteView } from './RegistryNoteView'
import { fileNameOf, uniqueName } from './registryFiles'

/**
 * 设置页顶层「智能体」tab —— 左侧每个 agent 一个子项（内置与自定义合并为同一列表、
 * 内置始终置顶，解析不过的文件缀在末尾），右侧为详情，与安全策略 tab 同形：
 *
 *  - 自定义档案的详情**就是这份 md 的笔记本会话**（RegistryNoteView）：frontmatter 由属性卡
 *    渲染成结构化字段（工具走 ToolSelectList、模型走 ModelSelect），正文即系统提示词，自动保存。
 *    md 才是事实源 —— 逐字段表单会把注释、键序、未知键（如 `shuvix-builtin`）在一次保存里悄悄抹掉；
 *  - 内置档案随包发布、没有文件：等价 md 的只读查看，「创建覆盖副本」落一份同名用户文件再打开它。
 *
 * 纯 md 驱动：文件存在即可用，无启用开关。数据源自 subAgent IPC（每次 list 现扫文件系统），
 * 底部提供新建 / 重扫描。写到一半解析不过的档案不进注册表（同名内置照常生效），但留在列表里。
 */

/** 新建智能体的初值（YAML 注释原样保留 —— 原文编辑模型的直接体现） */
function newAgentTemplate(t: (key: string) => string, name: string): string {
  return [
    '---',
    'shuvix: agent v1',
    `name: ${name}`,
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

/** 用户文件的选中键（合法与解析不过的共用一个键空间，见 keyOf） */
function fileKey(fileName: string): string {
  return `file:${fileName}`
}

/**
 * 列表项唯一键。内置按名（覆盖时 builtin / user 两行并存，name 不再唯一）；自定义档案按
 * **文件名** —— 自动保存下名字随时在变、合法性随时在翻，文件名不变，选中项与开着的笔记本
 * 才不会跟着跳。
 */
function keyOf(a: SubAgentInfo): string {
  return a.source === 'builtin' ? `builtin:${a.name}` : fileKey(fileNameOf(a.basePath))
}

/** 展示顺序：内置始终置顶，组内保持后端的字母序 */
function orderAgents(list: SubAgentInfo[]): SubAgentInfo[] {
  return [...list.filter((a) => a.source === 'builtin'), ...list.filter((a) => a.source === 'user')]
}

export function AgentSettings(): React.JSX.Element {
  const { t } = useTranslation()

  const [agents, setAgents] = useState<SubAgentInfo[]>([])
  const [invalid, setInvalid] = useState<InvalidAgentFile[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  /** 新建 / 覆盖副本 / 删除 / 读原文失败的原因 —— 显示在详情区顶部 */
  const [error, setError] = useState<string | null>(null)
  /** 选中内置档案的等价 md（只读查看 + 覆盖副本初值）；自定义档案的详情是笔记本，自己读盘 */
  const [source, setSource] = useState<{ name: string; text: string } | null>(null)
  /** 删除确认：合法自定义档案（按名）或无法解析的文件（按文件名） */
  const [confirmingDelete, setConfirmingDelete] = useState<
    { name: string; displayName: string } | { fileName: string } | null
  >(null)

  const load = useCallback(async (): Promise<{
    list: SubAgentInfo[]
    bad: InvalidAgentFile[]
  }> => {
    // list 即现扫文件系统，重扫描 = 重新拉取
    const [list, bad] = await Promise.all([
      window.api.subAgent.list(),
      window.api.subAgent.listInvalid()
    ])
    setAgents(list)
    setInvalid(bad)
    setLoading(false)
    return { list, bad }
  }, [])

  useEffect(() => {
    load().then(({ list }) => {
      const first = orderAgents(list)[0]
      setSelectedKey((cur) => cur ?? (first ? keyOf(first) : null))
    })
  }, [load])

  const select = (key: string): void => {
    setError(null)
    setSelectedKey(key)
  }

  const handleRefresh = async (): Promise<void> => {
    setRefreshing(true)
    try {
      const { list, bad } = await load()
      // 刷新后选中项可能已被删除
      setSelectedKey((cur) => {
        if (list.some((a) => keyOf(a) === cur) || bad.some((f) => fileKey(f.fileName) === cur)) {
          return cur
        }
        const first = orderAgents(list)[0]
        return first ? keyOf(first) : null
      })
    } finally {
      setRefreshing(false)
    }
  }

  const selected = agents.find((a) => keyOf(a) === selectedKey) ?? null
  // 自定义文件的选中与它此刻合不合法无关：翻面的一瞬（或两次列表请求之间）两边都查不到，
  // 开着的笔记本也不该因此卸载
  const selectedFile = selectedKey?.startsWith('file:') ? selectedKey.slice('file:'.length) : null

  // 选中内置 → 拉等价 md
  const builtinName = selected?.source === 'builtin' ? selected.name : null
  useEffect(() => {
    if (!builtinName) {
      setSource(null)
      return undefined
    }
    let alive = true
    void window.api.subAgent.getSource({ name: builtinName, source: 'builtin' }).then((r) => {
      if (!alive) return
      if ('error' in r) {
        setSource(null)
        setError(r.error)
        return
      }
      setSource({ name: builtinName, text: r.text })
    })
    return () => {
      alive = false
    }
  }, [builtinName])

  /** 新建与覆盖副本共用：落一份新文件，重扫并选中它 —— 它的详情就是刚建好的笔记本 */
  const createAndSelect = async (text: string): Promise<void> => {
    setError(null)
    const r = await window.api.subAgent.createSource({ text })
    if (!r.success) {
      setError(r.error || 'Save failed')
      return
    }
    const { list } = await load()
    const hit = list.find((a) => a.source === 'user' && a.name === r.name)
    if (hit) setSelectedKey(keyOf(hit))
  }

  const handleDelete = async (target: { name: string } | { fileName: string }): Promise<void> => {
    setConfirmingDelete(null)
    const r =
      'name' in target
        ? await window.api.subAgent.delete({ name: target.name })
        : await window.api.subAgent.deleteByFile({ fileName: target.fileName })
    if (!r.success) {
      setError(r.error ?? 'Delete failed')
      return
    }
    const { list } = await load()
    // 优先落到同名内置（删除覆盖档案的场景），否则列表首位
    const restored =
      'name' in target
        ? list.find((a) => a.source === 'builtin' && a.name === target.name)
        : undefined
    const next = restored ?? orderAgents(list)[0]
    setSelectedKey(next ? keyOf(next) : null)
  }

  return (
    <div className="flex flex-1 min-h-0 h-full">
      {/* 左侧：agent 列表（内置置顶 / 自定义 / 无法解析） */}
      <div className="w-[220px] flex-shrink-0 border-r border-border-secondary flex flex-col">
        <div className="flex-1 overflow-y-auto py-2 px-2 space-y-0.5">
          {loading ? (
            <div className="flex items-center gap-2 text-text-tertiary py-2 px-1">
              <Loader2 size={14} className="animate-spin" />
              <span className="text-[11px]">{t('common.loading') || 'Loading...'}</span>
            </div>
          ) : (
            <>
              {orderAgents(agents).map((agent) => (
                <AgentRow
                  key={keyOf(agent)}
                  agent={agent}
                  selected={selectedKey === keyOf(agent)}
                  onSelect={() => select(keyOf(agent))}
                />
              ))}
              {/* 无法解析的文件：不可用也不遮蔽内置，但必须可见 —— 否则写坏的档案就这么消失了 */}
              {invalid.length > 0 && (
                <div className="pt-2">
                  <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-amber-500/80">
                    {t('tool.subAgentInvalidGroup', { count: invalid.length })}
                  </div>
                  {invalid.map((f) => (
                    <button
                      key={f.fileName}
                      onClick={() => select(fileKey(f.fileName))}
                      title={f.error}
                      className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left transition-colors ${
                        selectedKey === fileKey(f.fileName)
                          ? 'bg-amber-500/10 text-amber-500'
                          : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
                      }`}
                    >
                      <AlertTriangle size={14} className="shrink-0 text-amber-500" />
                      <span className="min-w-0 flex-1 text-xs font-mono truncate">
                        {f.fileName}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        {/* 底部操作：添加自定义智能体 / 重扫描 */}
        <div className="border-t border-border-secondary p-2 flex items-center gap-1.5">
          <button
            onClick={() =>
              void createAndSelect(
                newAgentTemplate(
                  t,
                  uniqueName(
                    'my-agent',
                    agents.map((a) => a.name)
                  )
                )
              )
            }
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

      {/* 右侧：详情 —— 内置是等价 md 的只读查看，自定义档案是它的笔记本 */}
      <div className="flex-1 min-w-0 flex flex-col min-h-0 overflow-y-auto">
        {error && (
          <div className="mx-4 mt-4 px-3 py-2 rounded-lg bg-red-500/10 text-red-500 text-[11px] whitespace-pre-wrap break-words">
            {error}
          </div>
        )}
        {selected?.source === 'builtin' ? (
          <>
            <AgentHeader
              agent={selected}
              onCreateOverride={
                !selected.overridden && source?.name === selected.name
                  ? () => void createAndSelect(source.text)
                  : undefined
              }
            />
            {source?.name === selected.name && (
              <BuiltinSourceView
                key={selected.name}
                documentId={`builtin:${selected.name}.md`}
                text={source.text}
              />
            )}
          </>
        ) : (
          selectedFile && (
            <>
              <AgentHeader
                agent={selected}
                fileName={selectedFile}
                onDelete={() =>
                  setConfirmingDelete(
                    selected
                      ? { name: selected.name, displayName: selected.displayName || selected.name }
                      : { fileName: selectedFile }
                  )
                }
              />
              <RegistryNoteView
                key={selectedFile}
                kind="agent"
                fileName={selectedFile}
                onFileChanged={load}
              />
            </>
          )
        )}
      </div>

      {confirmingDelete && (
        <ConfirmDialog
          title={t('tool.subAgentDeleteConfirmTitle')}
          description={
            'name' in confirmingDelete
              ? t('tool.subAgentDeleteConfirmDesc', { name: confirmingDelete.displayName })
              : t('tool.subAgentDeleteFileConfirmDesc', { name: confirmingDelete.fileName })
          }
          confirmText={t('common.delete')}
          cancelText={t('common.cancel')}
          onConfirm={() => void handleDelete(confirmingDelete)}
          onCancel={() => setConfirmingDelete(null)}
        />
      )}
    </div>
  )
}

/**
 * 详情头部：名称 + 来源徽标 + 路径 / 提示 + 动作。`agent` 为 null 表示选中的自定义文件此刻
 * 解析不过 —— 标题退回文件名，提示它被跳过的后果。
 */
function AgentHeader({
  agent,
  fileName,
  onCreateOverride,
  onDelete
}: {
  agent: SubAgentInfo | null
  fileName?: string
  onCreateOverride?: () => void
  onDelete?: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const builtin = agent?.source === 'builtin'
  return (
    <div className="flex items-center gap-2 px-4 py-3 border-b border-border-secondary shrink-0">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          {agent ? (
            <>
              <span className="text-sm font-semibold text-text-primary truncate">
                {agent.displayName || agent.name}
              </span>
              <span
                className={`shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[9px] ${
                  builtin ? 'bg-bg-secondary text-text-tertiary' : 'bg-accent/10 text-accent'
                }`}
              >
                {builtin && <Lock size={9} />}
                {builtin ? t('tool.subAgentBuiltin') : t('tool.subAgentCustom')}
              </span>
              {agent.overridden && (
                <span className="px-1.5 py-0.5 rounded-md text-[9px] shrink-0 bg-amber-500/10 text-amber-500">
                  {t('tool.subAgentOverridden')}
                </span>
              )}
            </>
          ) : (
            <>
              <AlertTriangle size={14} className="shrink-0 text-amber-500" />
              <span className="text-sm font-semibold text-text-primary font-mono truncate">
                {fileName}
              </span>
            </>
          )}
        </div>
        {agent?.basePath ? (
          <div className="font-mono text-[10px] text-text-tertiary truncate mt-0.5">
            {agent.basePath}
          </div>
        ) : (
          <p className={`text-[10px] mt-0.5 ${agent ? 'text-text-tertiary' : 'text-amber-500/90'}`}>
            {!agent
              ? t('tool.subAgentInvalidHint')
              : agent.overridden
                ? t('tool.subAgentOverriddenHint')
                : t('tool.subAgentReadOnly')}
          </p>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {onCreateOverride && (
          <button
            onClick={onCreateOverride}
            className="flex items-center gap-1 px-2 py-1 rounded text-[10px] border border-dashed border-border-secondary text-text-secondary hover:text-text-primary hover:border-accent/40 hover:bg-accent/5 transition-colors"
          >
            <Copy size={10} />
            {t('tool.subAgentCreateOverride')}
          </button>
        )}
        {onDelete && (
          <button
            onClick={onDelete}
            title={t('tool.subAgentDeleteConfirmTitle')}
            className="p-1.5 rounded-lg text-text-tertiary hover:text-red-500 hover:bg-red-500/10 transition-colors"
          >
            <Trash2 size={14} />
          </button>
        )}
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
      {agent.source === 'builtin' && (
        /* 内置随包发布、不可直接编辑 —— 锁即「这行只能建覆盖副本」 */
        <span title={t('tool.subAgentBuiltin')} className="shrink-0 text-text-tertiary">
          <Lock size={11} />
        </span>
      )}
    </button>
  )
}
