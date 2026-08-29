import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Lock,
  Workflow as WorkflowIcon,
  Loader2,
  RefreshCw,
  FolderOpen,
  Pencil,
  Plus,
  Copy,
  Save,
  Check,
  Trash2,
  X,
  AlertTriangle
} from 'lucide-react'
import { LivePreviewEditor, type LivePreviewEditorHandle } from '@shuvix/app-shell'
import { ConfirmDialog } from '../common/ConfirmDialog'

/**
 * 设置页顶层「工作流」tab —— 与智能体 / 安全策略 tab 同形：左侧每个工作流一个子项
 * （内置与用户合并为同一列表、内置置顶），右侧是**整份 md 原文编辑器**（frontmatter
 * 由属性卡渲染成结构化字段，正文含编排脚本块）。
 *
 * 纯 md 驱动（同 agent md）：文件存在且校验通过即生效，没有启用开关也没有旁路配置 ——
 * 一个既在目录里、又「没启用」的工作流，是排查「为什么没触发」时最先骗到人的东西。
 *
 * 保存前经解析器 + 脚本引擎双重校验，非法拒绝写盘并回传人读原因 —— 一份存在但非法的
 * 工作流会被扫描静默跳过，正是要消灭的失败模式（同策略页）。
 */

/** 新建工作流的初值：一份最小可跑的骨架（埋点 + CEL + 脚本块三件套都在） */
function newWorkflowTemplate(t: (key: string) => string): string {
  return [
    '---',
    'shuvix: workflow v1',
    'name: my-workflow',
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

function keyOf(w: WorkflowInfo): string {
  return `${w.source}:${w.name}${w.overridden ? ':overridden' : ''}`
}

/** 无法解析的文件在列表里的选中键（与 keyOf 同名空间隔离） */
function invalidKeyOf(fileName: string): string {
  return `invalid:${fileName}`
}

/**
 * 编辑目标：新建（含内置的覆盖副本）/ 覆写既有用户工作流（按 name 定位）/
 * 修复无法解析的文件（按文件名定位 —— 它解析不出 name）。
 */
type EditTarget =
  | { kind: 'create'; text: string }
  | { kind: 'edit'; name: string; text: string }
  | { kind: 'fix'; fileName: string; text: string }

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
  const [editing, setEditing] = useState<EditTarget | null>(null)
  /** 读取原文失败（文件被外部删除/改坏）—— 不静默吞掉，显示在详情区 */
  const [loadError, setLoadError] = useState<string | null>(null)
  const [source, setSource] = useState<{ key: string; text: string } | null>(null)
  /** 删除确认：工作流名（用户文件）或 {fileName}（无法解析的文件） */
  const [confirmingDelete, setConfirmingDelete] = useState<string | { fileName: string } | null>(
    null
  )

  const load = useCallback(async (): Promise<WorkflowInfo[]> => {
    const [list, bad] = await Promise.all([
      window.api.workflow.list(),
      window.api.workflow.listInvalid()
    ])
    setWorkflows(list)
    setInvalid(bad)
    setLoading(false)
    return list
  }, [])

  useEffect(() => {
    load().then((list) => {
      const first = orderWorkflows(list)[0]
      setSelectedKey((cur) => cur ?? (first ? keyOf(first) : null))
    })
  }, [load])

  const handleRefresh = async (): Promise<void> => {
    setRefreshing(true)
    try {
      const list = await load()
      setSelectedKey((cur) => {
        if (list.some((w) => keyOf(w) === cur)) return cur
        const first = orderWorkflows(list)[0]
        return first ? keyOf(first) : null
      })
    } finally {
      setRefreshing(false)
    }
  }

  const selected = workflows.find((w) => keyOf(w) === selectedKey) ?? null
  const selectedInvalid = invalid.find((f) => selectedKey === invalidKeyOf(f.fileName)) ?? null

  // 选中项变化 → 拉 md 原文（详情就是它的只读/可编辑呈现）
  useEffect(() => {
    if (!selected) {
      setSource(null)
      return undefined
    }
    const key = keyOf(selected)
    let alive = true
    setLoadError(null)
    void window.api.workflow
      .getSource({ name: selected.name, source: selected.source })
      .then((r) => {
        if (!alive) return
        if ('error' in r) {
          setSource(null)
          setLoadError(r.error)
          return
        }
        setSource({ key, text: r.text })
      })
    return () => {
      alive = false
    }
  }, [selected])

  /** 打开无法解析的文件去修（身份是文件名 —— 它解析不出 name） */
  const openInvalidEditor = async (fileName: string): Promise<void> => {
    const r = await window.api.workflow.getSourceByFile({ fileName })
    if ('error' in r) {
      setLoadError(r.error)
      return
    }
    setEditing({ kind: 'fix', fileName, text: r.text })
  }

  /**
   * 保存成功：重扫列表并选中落盘的那一份（改名/新建/修好后仍定位得到）。
   * 修复态按文件路径定位 —— 它保存前没有 name，且选中键指向的 invalid 条目
   * 在文件变合法后就消失了，不改选会留下一个空白详情面板。
   */
  const afterSaved = async (name: string, fileName?: string): Promise<void> => {
    setEditing(null)
    const list = await load()
    const hit = fileName
      ? list.find((w) => w.source === 'user' && w.basePath.endsWith(fileName))
      : list.find((w) => w.source === 'user' && w.name === name)
    if (hit) setSelectedKey(keyOf(hit))
  }

  const handleDelete = async (target: string | { fileName: string }): Promise<void> => {
    setConfirmingDelete(null)
    const r =
      typeof target === 'string'
        ? await window.api.workflow.delete({ name: target })
        : await window.api.workflow.deleteByFile({ fileName: target.fileName })
    if (!r.success) return
    const list = await load()
    if (typeof target !== 'string') {
      setSelectedKey(orderWorkflows(list)[0] ? keyOf(orderWorkflows(list)[0]) : null)
      return
    }
    // 删除覆盖副本后同名内置恢复生效 —— 优先选中它，否则退回首项
    const next = list.find((w) => w.name === target && !w.overridden) ?? orderWorkflows(list)[0]
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
                  onSelect={() => setSelectedKey(keyOf(workflow))}
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
                      onClick={() => setSelectedKey(invalidKeyOf(f.fileName))}
                      className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left transition-colors ${
                        selectedKey === invalidKeyOf(f.fileName)
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
            onClick={() => setEditing({ kind: 'create', text: newWorkflowTemplate(t) })}
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

      {/* 右侧：md 原文编辑器 / 非法文件详情 */}
      <div className="flex-1 min-w-0 flex flex-col min-h-0 overflow-y-auto">
        {editing ? (
          <WorkflowEditor
            key={
              editing.kind === 'edit'
                ? editing.name
                : editing.kind === 'fix'
                  ? editing.fileName
                  : '__new__'
            }
            target={editing}
            onCancel={() => setEditing(null)}
            onSaved={afterSaved}
          />
        ) : selectedInvalid ? (
          <InvalidWorkflowDetail
            key={selectedInvalid.fileName}
            file={selectedInvalid}
            onFix={() => void openInvalidEditor(selectedInvalid.fileName)}
            onDelete={() => setConfirmingDelete({ fileName: selectedInvalid.fileName })}
          />
        ) : (
          selected && (
            <>
              {loadError && (
                <div className="mx-4 mt-4 px-3 py-2 rounded-lg bg-red-500/10 text-red-500 text-[11px] whitespace-pre-wrap break-words">
                  {loadError}
                </div>
              )}
              {source?.key === keyOf(selected) && (
                <WorkflowEditor
                  key={source.key}
                  target={{ kind: 'edit', name: selected.name, text: source.text }}
                  workflow={selected}
                  readOnly={selected.source === 'builtin'}
                  onSaved={afterSaved}
                  onCreateOverride={
                    selected.source === 'builtin' && !selected.overridden
                      ? () => setEditing({ kind: 'create', text: source.text })
                      : undefined
                  }
                  onDelete={
                    selected.source === 'user'
                      ? () => setConfirmingDelete(selected.name)
                      : undefined
                  }
                />
              )}
            </>
          )
        )}
      </div>

      {confirmingDelete && (
        <ConfirmDialog
          title={t('settings.workflowDeleteConfirmTitle')}
          description={
            typeof confirmingDelete === 'string'
              ? t('settings.workflowDeleteConfirmDesc', { name: confirmingDelete })
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
 * md 原文编辑器。frontmatter 由属性卡渲染（含触发绑定摘要 + 解析器实时校验徽章），
 * 正文（说明文字 + ```js workflow 脚本块 + ```json schema 块）走 live-preview。
 * 非受控编辑器，保存时经 handleRef 直取全文（对齐 SubAgentEditor / PolicyEditor）。
 */
function WorkflowEditor({
  target,
  workflow,
  readOnly = false,
  onCancel,
  onSaved,
  onCreateOverride,
  onDelete
}: {
  target: EditTarget
  /** 选中项元信息（头部徽标 / 路径 / 覆盖提示）；create、fix 态没有 */
  workflow?: WorkflowInfo
  /** 内置工作流随包发布不可改 */
  readOnly?: boolean
  /** 仅 create / fix 态给取消（选中即详情的常态没有「取消」可言） */
  onCancel?: () => void
  onSaved: (name: string, fileName?: string) => Promise<void>
  onCreateOverride?: () => void
  onDelete?: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const initialText = target.text
  const editorRef = useRef<LivePreviewEditorHandle | null>(null)
  const mirror = useRef(initialText)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSave = async (): Promise<void> => {
    const text = editorRef.current?.getMarkdown() ?? mirror.current
    setSaving(true)
    setError(null)
    try {
      const r =
        target.kind === 'edit'
          ? await window.api.workflow.save({ originalName: target.name, text })
          : target.kind === 'fix'
            ? await window.api.workflow.saveByFile({ fileName: target.fileName, text })
            : await window.api.workflow.create({ text })
      if (!r.success) {
        setError(r.error || t('settings.workflowSaveFailed'))
        return
      }
      setSaved(true)
      const savedName =
        'name' in r && typeof r.name === 'string'
          ? r.name
          : target.kind === 'edit'
            ? target.name
            : ''
      await onSaved(savedName, target.kind === 'fix' ? target.fileName : undefined)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col min-h-0">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border-secondary">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-text-primary truncate">
              {target.kind === 'edit'
                ? (workflow?.displayName ?? target.name)
                : target.kind === 'fix'
                  ? target.fileName
                  : t('settings.workflowNew')}
            </span>
            {workflow && (
              <span
                className={`shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[9px] ${
                  readOnly ? 'bg-bg-secondary text-text-tertiary' : 'bg-accent/10 text-accent'
                }`}
              >
                {readOnly && <Lock size={9} />}
                {workflow.source === 'builtin'
                  ? t('settings.workflowSourceBuiltin')
                  : t('settings.workflowSourceUser')}
              </span>
            )}
            {workflow?.overridden && (
              <span className="px-1.5 py-0.5 rounded-md text-[9px] shrink-0 bg-orange-500/10 text-orange-500">
                {t('settings.workflowOverridden')}
              </span>
            )}
          </div>
          {workflow?.basePath ? (
            <div className="font-mono text-[10px] text-text-tertiary truncate mt-0.5">
              {workflow.basePath}
            </div>
          ) : (
            <div className="text-[10px] text-text-tertiary mt-0.5">
              {readOnly
                ? workflow?.overridden
                  ? t('settings.workflowOverriddenHint')
                  : t('settings.workflowFsHint')
                : t('settings.workflowEditHint')}
            </div>
          )}
        </div>
        {readOnly && !workflow?.overridden && onCreateOverride && (
          <button
            onClick={onCreateOverride}
            className="flex items-center gap-1 px-2 py-1 rounded text-[10px] border border-dashed border-border-secondary text-text-secondary hover:text-text-primary hover:border-accent/40 hover:bg-accent/5 transition-colors"
          >
            <Copy size={10} />
            {t('tool.subAgentCreateOverride')}
          </button>
        )}
        {onCancel && (
          <button
            onClick={onCancel}
            className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
          >
            <X size={13} />
            {t('common.cancel')}
          </button>
        )}
        {!readOnly && (
          <button
            onClick={() => void handleSave()}
            disabled={saving || saved}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-60 ${
              saved ? 'bg-success/20 text-success' : 'bg-accent text-white hover:bg-accent-hover'
            }`}
          >
            {saved ? <Check size={13} /> : <Save size={13} />}
            {saved ? t('settings.saved') : t('common.save')}
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

      {error && (
        <div className="mx-4 mt-3 px-3 py-2 rounded-lg bg-red-500/10 text-red-500 text-[11px] whitespace-pre-wrap break-words">
          {error}
        </div>
      )}

      {/* 不限高：CM6 随文档自然增长、无内部滚动，整页统一滚动（同 SubAgentEditor） */}
      <div className="min-h-[320px] p-2">
        <LivePreviewEditor
          layout="fill"
          documentId={
            target.kind === 'fix'
              ? target.fileName
              : `${target.kind === 'edit' ? target.name : 'new-workflow'}.md`
          }
          initialContent={initialText}
          readOnly={readOnly}
          onSave={(md) => {
            mirror.current = md
            setSaved(false)
          }}
          handleRef={editorRef}
        />
      </div>
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

/**
 * 无法解析的工作流文件详情：原因 + 去修 / 删掉两条出路。
 * 它既不触发也不遮蔽内置，但让用户看得见、改得动，才是「不再静默失效」的完整形态。
 */
function InvalidWorkflowDetail({
  file,
  onFix,
  onDelete
}: {
  file: InvalidWorkflowFile
  onFix: () => void
  onDelete: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-end gap-2">
        <button
          onClick={onFix}
          className="flex items-center gap-1 px-2 py-1 rounded text-[10px] border border-dashed border-border-secondary text-text-secondary hover:text-text-primary hover:border-accent/40 hover:bg-accent/5 transition-colors"
        >
          <Pencil size={10} />
          {t('settings.workflowFix')}
        </button>
        <button
          onClick={onDelete}
          className="flex items-center gap-1 px-2 py-1 rounded text-[10px] border border-dashed border-border-secondary text-text-secondary hover:text-red-500 hover:border-red-500/40 hover:bg-red-500/5 transition-colors"
        >
          <Trash2 size={10} />
          {t('common.delete')}
        </button>
      </div>

      <div className="flex items-center gap-2">
        <AlertTriangle size={15} className="shrink-0 text-amber-500" />
        <span className="text-sm font-semibold text-text-primary font-mono">{file.fileName}</span>
      </div>
      <div className="text-[11px] text-amber-500/90">{t('settings.workflowInvalidHint')}</div>
      <div className="px-3 py-2 rounded-lg bg-red-500/10 text-red-500 text-[11px] whitespace-pre-wrap break-words leading-relaxed">
        {file.error}
      </div>
    </div>
  )
}
