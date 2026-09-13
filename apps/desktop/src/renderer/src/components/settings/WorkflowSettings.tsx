import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Lock,
  Workflow as WorkflowIcon,
  Loader2,
  RefreshCw,
  FolderOpen,
  Plus,
  Copy,
  Trash2,
  AlertTriangle
} from 'lucide-react'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { BuiltinSourceView, RegistryNoteView } from './RegistryNoteView'
import { fileNameOf, uniqueName } from './registryFiles'

/**
 * 设置页顶层「工作流」tab —— 与智能体 / 安全策略 tab 同形：左侧每个工作流一个子项
 * （内置与用户合并为同一列表、内置置顶），右侧是详情：用户文件的详情**就是它的笔记本会话**
 * （RegistryNoteView：frontmatter 由属性卡渲染成结构化字段，正文含编排脚本块，自动保存），
 * 内置是随包原文的只读查看。
 *
 * 纯 md 驱动（同 agent md）：文件存在且校验通过即生效，没有启用开关也没有旁路配置 ——
 * 一个既在目录里、又「没启用」的工作流，是排查「为什么没触发」时最先骗到人的东西。
 *
 * 结构或脚本语法不合法的文件（包括笔记本里写到一半的那一版）被扫描跳过：不触发、不遮蔽内置，
 * 带着原因列进「无法解析」分组，点开照样接着改。
 */

/** 新建工作流的初值：一份最小可跑的骨架（埋点 + CEL + 脚本块三件套都在） */
function newWorkflowTemplate(t: (key: string) => string, name: string): string {
  return [
    '---',
    'shuvix: workflow v1',
    `name: ${name}`,
    `description: ${t('settings.workflowTemplateDesc')}`,
    'shuvix-workflow-on:',
    '  - trigger: session.turn-completed',
    '    when: event.turnCount == 1',
    '---',
    '',
    t('settings.workflowTemplateBody'),
    '',
    '```js workflow',
    "const out = await run('explore', `${event.recentText}`, {",
    "  schema: { type: 'object', required: ['summary'], properties: { summary: { type: 'string' } } }",
    '})',
    'log(out.summary)',
    'return out',
    '```',
    ''
  ].join('\n')
}

/** 用户文件的选中键（合法与解析不过的共用一个键空间，见 keyOf） */
function fileKey(fileName: string): string {
  return `file:${fileName}`
}

/**
 * 列表选中键。内置按名（它没有文件）；用户工作流按**文件名** —— 自动保存下名字随时在变、
 * 合法性随时在翻，文件名不变，选中项与开着的笔记本才不会跟着跳。
 */
function keyOf(w: WorkflowInfo): string {
  return w.source === 'builtin' ? `builtin:${w.name}` : fileKey(fileNameOf(w.basePath))
}

/** 展示顺序：内置置顶（含被遮蔽的），组内保持后端的字母序 */
function orderWorkflows(list: WorkflowInfo[]): WorkflowInfo[] {
  return [...list.filter((w) => w.source === 'builtin'), ...list.filter((w) => w.source === 'user')]
}

export function WorkflowSettings(): React.JSX.Element {
  const { t } = useTranslation()

  const [workflows, setWorkflows] = useState<WorkflowInfo[]>([])
  const [invalid, setInvalid] = useState<InvalidWorkflowFile[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  /** 新建 / 覆盖副本 / 删除 / 读原文失败的原因 —— 不静默吞掉，显示在详情区顶部 */
  const [error, setError] = useState<string | null>(null)
  /** 选中内置工作流的随包原文（只读查看 + 覆盖副本初值）；用户文件的详情是笔记本，自己读盘 */
  const [source, setSource] = useState<{ name: string; text: string } | null>(null)
  /**
   * 删除确认：生效的用户文件按名删；无法解析的、或同名里被遮蔽的按文件名删（按名删会删到生效的那份）。
   * 被遮蔽的顺带记下胜出的那份（then），删完停在它上面
   */
  const [confirmingDelete, setConfirmingDelete] = useState<
    { name: string } | { fileName: string; then?: string } | null
  >(null)

  const load = useCallback(async (): Promise<{
    list: WorkflowInfo[]
    bad: InvalidWorkflowFile[]
  }> => {
    const [list, bad] = await Promise.all([
      window.api.workflow.list(),
      window.api.workflow.listInvalid()
    ])
    setWorkflows(list)
    setInvalid(bad)
    setLoading(false)
    return { list, bad }
  }, [])

  useEffect(() => {
    load().then(({ list }) => {
      const first = orderWorkflows(list)[0]
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
      setSelectedKey((cur) => {
        if (list.some((w) => keyOf(w) === cur) || bad.some((f) => fileKey(f.fileName) === cur)) {
          return cur
        }
        const first = orderWorkflows(list)[0]
        return first ? keyOf(first) : null
      })
    } finally {
      setRefreshing(false)
    }
  }

  const selected = workflows.find((w) => keyOf(w) === selectedKey) ?? null
  // 用户文件的选中与它此刻合不合法无关：翻面的一瞬（或两次列表请求之间）两边都查不到，
  // 开着的笔记本也不该因此卸载
  const selectedFile = selectedKey?.startsWith('file:') ? selectedKey.slice('file:'.length) : null
  const selectedInvalid = selectedFile
    ? (invalid.find((f) => f.fileName === selectedFile) ?? null)
    : null

  // 选中内置 → 拉随包原文
  const builtinName = selected?.source === 'builtin' ? selected.name : null
  useEffect(() => {
    if (!builtinName) {
      setSource(null)
      return undefined
    }
    let alive = true
    void window.api.workflow.getSource({ name: builtinName, source: 'builtin' }).then((r) => {
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
    const r = await window.api.workflow.create({ text })
    if (!r.success) {
      setError(r.error || t('settings.workflowSaveFailed'))
      return
    }
    const { list } = await load()
    const hit = list.find((w) => w.source === 'user' && w.name === r.name)
    if (hit) setSelectedKey(keyOf(hit))
  }

  const handleDelete = async (
    target: { name: string } | { fileName: string; then?: string }
  ): Promise<void> => {
    setConfirmingDelete(null)
    const r =
      'name' in target
        ? await window.api.workflow.delete({ name: target.name })
        : await window.api.workflow.deleteByFile({ fileName: target.fileName })
    if (!r.success) {
      setError(r.error ?? 'Delete failed')
      return
    }
    const { list } = await load()
    // 按名删的是生效的那份：落到同名里接着生效的那份（另一份用户文件，或恢复生效的内置）；
    // 删掉被遮蔽的那份，胜出的那份还在、停在它上面；都没有就退回首项
    const restored =
      'name' in target
        ? list.find((w) => w.name === target.name && !w.overridden)
        : target.then
          ? list.find((w) => w.source === 'user' && fileNameOf(w.basePath) === target.then)
          : undefined
    const next = restored ?? orderWorkflows(list)[0]
    setSelectedKey(next ? keyOf(next) : null)
  }

  return (
    <div className="flex flex-1 min-h-0 h-full">
      {/* 左侧：工作流列表 */}
      <div className="w-[240px] flex-shrink-0 border-r border-border-secondary flex flex-col">
        <div className="flex-1 overflow-y-auto py-2 px-2 space-y-0.5">
          {loading ? (
            <div className="flex items-center gap-2 text-text-tertiary py-2 px-1">
              <Loader2 size={14} className="animate-spin" />
              <span className="text-[11px]">{t('common.loading') || 'Loading...'}</span>
            </div>
          ) : (
            <>
              {orderWorkflows(workflows).map((workflow) => (
                <WorkflowRow
                  key={keyOf(workflow)}
                  workflow={workflow}
                  selected={selectedKey === keyOf(workflow)}
                  onSelect={() => select(keyOf(workflow))}
                />
              ))}
              {/* 无法解析的文件：不触发也不遮蔽内置，但必须可见 —— 否则用户无从发现更无从修复 */}
              {invalid.length > 0 && (
                <div className="pt-2">
                  <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-amber-500/80">
                    {t('settings.workflowInvalidGroup', { count: invalid.length })}
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

        {/* 底部操作：新建 / 打开目录 / 重扫描 */}
        <div className="border-t border-border-secondary p-2 flex items-center gap-1.5">
          <button
            onClick={() =>
              void createAndSelect(
                newWorkflowTemplate(
                  t,
                  uniqueName(
                    'my-workflow',
                    workflows.map((w) => w.name)
                  )
                )
              )
            }
            title={t('settings.workflowNew')}
            className="flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg border border-dashed border-border-secondary text-[11px] text-text-secondary hover:text-text-primary hover:border-accent/40 hover:bg-accent/5 transition-colors"
          >
            <Plus size={12} />
            {t('settings.workflowNew')}
          </button>
          <button
            onClick={() => void window.api.workflow.openFolder()}
            title={t('settings.workflowFsHint')}
            className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg border border-dashed border-border-secondary text-[11px] text-text-secondary hover:text-text-primary hover:border-accent/40 hover:bg-accent/5 transition-colors"
          >
            <FolderOpen size={12} />
            {t('settings.workflowOpenFolder')}
          </button>
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            title={t('settings.workflowRefresh')}
            className="px-2 py-1.5 rounded-lg border border-dashed border-border-secondary text-text-secondary hover:text-text-primary hover:border-accent/40 hover:bg-accent/5 transition-colors disabled:opacity-50"
          >
            <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* 右侧：详情 —— 内置是随包原文的只读查看，用户文件是它的笔记本 */}
      <div className="flex-1 min-w-0 flex flex-col min-h-0 overflow-y-auto">
        {error && (
          <div className="mx-4 mt-4 px-3 py-2 rounded-lg bg-red-500/10 text-red-500 text-[11px] whitespace-pre-wrap break-words">
            {error}
          </div>
        )}
        {selected?.source === 'builtin' ? (
          <>
            <WorkflowHeader
              workflow={selected}
              onCreateOverride={
                !selected.overridden && source?.name === selected.name
                  ? () => void createAndSelect(source.text)
                  : undefined
              }
            />
            {source?.name === selected.name && (
              <BuiltinSourceView
                key={selected.name}
                documentId={`${selected.name}.md`}
                text={source.text}
              />
            )}
          </>
        ) : (
          selectedFile && (
            <>
              <WorkflowHeader
                workflow={selected}
                fileName={selectedFile}
                onDelete={() =>
                  setConfirmingDelete(
                    selected && !selected.overridden
                      ? { name: selected.name }
                      : { fileName: selectedFile, then: selected?.overriddenBy }
                  )
                }
              />
              {selectedInvalid && (
                // 拒绝原因（解析器，或脚本引擎的语法错）：改的就是它，挂在笔记本正上方
                <div className="mx-4 mt-3 px-3 py-2 rounded-lg bg-red-500/10 text-red-500 text-[11px] whitespace-pre-wrap break-words leading-relaxed">
                  {selectedInvalid.error}
                </div>
              )}
              <RegistryNoteView
                key={selectedFile}
                kind="workflow"
                fileName={selectedFile}
                onFileChanged={load}
              />
            </>
          )
        )}
      </div>

      {confirmingDelete && (
        <ConfirmDialog
          title={t('settings.workflowDeleteConfirmTitle')}
          description={
            'name' in confirmingDelete
              ? t('settings.workflowDeleteConfirmDesc', { name: confirmingDelete.name })
              : t('settings.workflowDeleteFileConfirmDesc', { name: confirmingDelete.fileName })
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
 * 详情头部：名称 + 来源徽标 + 路径 / 提示 + 动作。`workflow` 为 null 表示选中的用户文件此刻
 * 解析不过 —— 标题退回文件名，提示它被跳过的后果。
 */
function WorkflowHeader({
  workflow,
  fileName,
  onCreateOverride,
  onDelete
}: {
  workflow: WorkflowInfo | null
  fileName?: string
  onCreateOverride?: () => void
  onDelete?: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const builtin = workflow?.source === 'builtin'
  return (
    <div className="flex items-center gap-2 px-4 py-3 border-b border-border-secondary">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          {workflow ? (
            <>
              <span className="text-sm font-semibold text-text-primary truncate">
                {workflow.displayName}
              </span>
              <span
                className={`shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[9px] ${
                  builtin ? 'bg-bg-secondary text-text-tertiary' : 'bg-accent/10 text-accent'
                }`}
              >
                {builtin && <Lock size={9} />}
                {builtin ? t('settings.workflowSourceBuiltin') : t('settings.workflowSourceUser')}
              </span>
              {workflow.overridden && (
                <span className="px-1.5 py-0.5 rounded-md text-[9px] shrink-0 bg-orange-500/10 text-orange-500">
                  {t('settings.workflowOverridden')}
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
        {workflow?.basePath ? (
          <div className="font-mono text-[10px] text-text-tertiary truncate mt-0.5">
            {workflow.basePath}
          </div>
        ) : (
          <div
            className={`text-[10px] mt-0.5 ${workflow ? 'text-text-tertiary' : 'text-amber-500/90'}`}
          >
            {!workflow
              ? t('settings.workflowInvalidHint')
              : workflow.overridden
                ? t('settings.workflowOverriddenHint')
                : t('settings.workflowFsHint')}
          </div>
        )}
        {workflow?.source === 'user' && workflow.overridden && (
          // 同名的几份里没胜出：路径照常给，再说清是谁压过了它
          <div className="text-[10px] mt-0.5 text-orange-500/90">
            {t('settings.shadowedByFileHint', { file: workflow.overriddenBy })}
          </div>
        )}
      </div>
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
          title={t('settings.workflowDeleteConfirmTitle')}
          className="p-1.5 rounded-lg text-text-tertiary hover:text-red-500 hover:bg-red-500/10 transition-colors"
        >
          <Trash2 size={14} />
        </button>
      )}
    </div>
  )
}

function WorkflowRow({
  workflow,
  selected,
  onSelect
}: {
  workflow: WorkflowInfo
  selected: boolean
  onSelect: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  // 副标题给「什么时候会跑」—— 这份文件最要紧的一行，列表上直接可见
  const triggerHint = workflow.triggers.length
    ? workflow.triggers.join(', ')
    : t('settings.workflowNoTriggers')
  return (
    <button
      onClick={onSelect}
      title={triggerHint}
      className={`group w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left transition-colors ${
        selected
          ? 'bg-accent/10 text-accent'
          : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
      } ${workflow.overridden ? 'opacity-60' : ''}`}
    >
      <WorkflowIcon size={14} className="shrink-0" />
      <div className="min-w-0 flex-1">
        <div
          className={`text-xs font-medium truncate ${workflow.overridden ? 'line-through text-text-tertiary' : ''}`}
        >
          {workflow.displayName}
        </div>
        <div className="text-[10px] text-text-tertiary truncate font-mono">{triggerHint}</div>
      </div>
      {workflow.overridden && (
        /* 被同名用户工作流覆盖的内置：仅展示,不生效 */
        <span className="shrink-0 px-1.5 py-0.5 rounded text-[9px] bg-bg-secondary text-text-tertiary">
          {t('settings.workflowOverridden')}
        </span>
      )}
      {workflow.source === 'builtin' && (
        /* 内置随包发布、不可直接编辑 —— 锁即「这行只能建覆盖副本」 */
        <span title={t('settings.workflowSourceBuiltin')} className="shrink-0 text-text-tertiary">
          <Lock size={11} />
        </span>
      )}
    </button>
  )
}
