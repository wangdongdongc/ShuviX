import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Lock,
  Shield,
  Loader2,
  RefreshCw,
  FolderOpen,
  FileText,
  Terminal,
  GitBranch,
  Database,
  Wrench,
  Pencil,
  Plus,
  Copy,
  Save,
  Check,
  Trash2,
  X,
  AlertTriangle,
  type LucideIcon
} from 'lucide-react'
import { LivePreviewEditor, type LivePreviewEditorHandle } from '@shuvix/app-shell'
import { ConfirmDialog } from '../common/ConfirmDialog'

/**
 * 设置页顶层「安全策略」tab —— 与智能体 tab 同形：左侧每个策略一个子项（内置与
 * 用户合并为同一列表、内置置顶），右侧为详情（描述 + 规则可读渲染 + Rationale）。
 *
 * 策略是纯 md 驱动（内置随包发布只读；用户策略放 ~/.shuvix/policies/<name>.md 即生效，
 * 同名覆盖内置）。编辑走 **md 原文**而非逐字段表单：rules/lets/scope 是嵌套结构，
 * 做成表单成本远高于收益，而解析器对非法文件本就给人读原因 —— 原文编辑 +
 * frontmatter 属性卡（结构化摘要 + 实时校验徽章）更贴合。保存前一律解析校验，
 * 非法拒绝写盘并回传原因：一份存在但非法的策略会被静默跳过，正是要消灭的失败模式。
 */

/** 新建策略的初值（YAML 注释原样保留 —— 原文编辑模型的直接体现） */
function newPolicyTemplate(t: (key: string) => string): string {
  return [
    '---',
    'shuvix: policy v1',
    'name: my-policy',
    `description: ${t('settings.policyTemplateDesc')}`,
    `# ${t('settings.policyTemplateHint')}`,
    'shuvix-policy-rules:',
    '  - effect: ask',
    '    subject.kind: [agent]',
    '    object.type: [command]',
    '---',
    '',
    t('settings.policyTemplateBody'),
    ''
  ].join('\n')
}

/**
 * object.type → 图标。object 是开放属性文档（`{type: string} & attrs`），新增
 * 类型无需改引擎，因此这里只覆盖内置 PEP 目前会产出的类型，未知类型退回 Shield。
 */
const OBJECT_TYPE_ICON: Record<string, LucideIcon> = {
  path: FileText,
  command: Terminal,
  gitTool: GitBranch,
  database: Database,
  invocation: Wrench
}

/**
 * 一个策略触达的 object.type 集合 = 策略级 scope ∪ 每条规则的结构化条件
 * （scope 是 AND 进每条规则的共同条件，两处都可能声明）。`'*'` 与未声明一样
 * 视为「不限」——不参与集合。
 */
function objectTypesOf(policy: PolicyInfo): string[] {
  const types = new Set<string>()
  const collect = (c?: PolicyConditionsInfo): void => {
    for (const v of c?.['object.type'] ?? []) if (v !== '*') types.add(v)
  }
  collect(policy.scope)
  for (const rule of policy.rules) collect(rule.conditions)
  return [...types]
}

/** 单一 object.type 才给专属图标；混合类型/不限/未知类型都退回通用 Shield */
function policyIcon(policy: PolicyInfo): { Icon: LucideIcon; objectType: string | null } {
  const types = objectTypesOf(policy)
  const only = types.length === 1 ? types[0] : null
  return { Icon: (only && OBJECT_TYPE_ICON[only]) || Shield, objectType: only }
}

function keyOf(p: PolicyInfo): string {
  return `${p.source}:${p.name}${p.overridden ? ':overridden' : ''}`
}

/** 无法解析的文件在列表里的选中键（与 keyOf 同名空间隔离） */
function invalidKeyOf(fileName: string): string {
  return `invalid:${fileName}`
}

/**
 * 编辑目标：新建（含内置的覆盖副本，都走 create）/ 覆写既有用户策略（按 name 定位）/
 * 修复无法解析的文件（按文件名定位 —— 它解析不出 name）。
 */
type EditTarget =
  | { kind: 'create'; text: string }
  | { kind: 'edit'; name: string; text: string }
  | { kind: 'fix'; fileName: string; text: string }

/** 展示顺序：内置置顶（含被遮蔽的），组内保持后端的字母序 */
function orderPolicies(list: PolicyInfo[]): PolicyInfo[] {
  return [...list.filter((p) => p.source === 'builtin'), ...list.filter((p) => p.source === 'user')]
}

export function PolicySettings(): React.JSX.Element {
  const { t } = useTranslation()

  const [policies, setPolicies] = useState<PolicyInfo[]>([])
  const [invalid, setInvalid] = useState<InvalidPolicyFile[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [editing, setEditing] = useState<EditTarget | null>(null)
  /** 读取原文失败（文件被外部删除/改坏）—— 不再静默吞掉，显示在详情区 */
  const [loadError, setLoadError] = useState<string | null>(null)
  /** 选中项的 md 原文（用户策略读文件；内置回写等价 md）—— 详情即编辑器，与智能体页同形 */
  const [source, setSource] = useState<{ key: string; text: string } | null>(null)
  /** 删除确认：策略名（用户策略）或 {fileName}（无法解析的文件） */
  const [confirmingDelete, setConfirmingDelete] = useState<string | { fileName: string } | null>(
    null
  )

  const load = useCallback(async (): Promise<PolicyInfo[]> => {
    const [list, bad] = await Promise.all([
      window.api.policy.list(),
      window.api.policy.listInvalid()
    ])
    setPolicies(list)
    setInvalid(bad)
    setLoading(false)
    return list
  }, [])

  useEffect(() => {
    load().then((list) => {
      const first = orderPolicies(list)[0]
      setSelectedKey((cur) => cur ?? (first ? keyOf(first) : null))
    })
  }, [load])

  const handleRefresh = async (): Promise<void> => {
    setRefreshing(true)
    try {
      const list = await load()
      setSelectedKey((cur) => {
        if (list.some((p) => keyOf(p) === cur)) return cur
        const first = orderPolicies(list)[0]
        return first ? keyOf(first) : null
      })
    } finally {
      setRefreshing(false)
    }
  }

  const selected = policies.find((p) => keyOf(p) === selectedKey) ?? null
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
    void window.api.policy.getSource({ name: selected.name, source: selected.source }).then((r) => {
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
    const r = await window.api.policy.getSourceByFile({ fileName })
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
      ? list.find((p) => p.source === 'user' && p.basePath.endsWith(fileName))
      : list.find((p) => p.source === 'user' && p.name === name)
    if (hit) setSelectedKey(keyOf(hit))
  }

  const handleDelete = async (target: string | { fileName: string }): Promise<void> => {
    setConfirmingDelete(null)
    const r =
      typeof target === 'string'
        ? await window.api.policy.delete({ name: target })
        : await window.api.policy.deleteByFile({ fileName: target.fileName })
    if (!r.success) return
    const list = await load()
    if (typeof target !== 'string') {
      setSelectedKey(orderPolicies(list)[0] ? keyOf(orderPolicies(list)[0]) : null)
      return
    }
    // 删除覆盖副本后同名内置恢复生效 —— 优先选中它，否则退回首项
    const next = list.find((p) => p.name === target && !p.overridden) ?? orderPolicies(list)[0]
    setSelectedKey(next ? keyOf(next) : null)
  }

  return (
    <div className="flex flex-1 min-h-0 h-full">
      {/* 左侧：策略列表 */}
      <div className="w-[220px] flex-shrink-0 border-r border-border-secondary flex flex-col">
        <div className="flex-1 overflow-y-auto py-2 px-2 space-y-0.5">
          {loading ? (
            <div className="flex items-center gap-2 text-text-tertiary py-2 px-1">
              <Loader2 size={14} className="animate-spin" />
              <span className="text-[11px]">{t('common.loading') || 'Loading...'}</span>
            </div>
          ) : (
            <>
              {orderPolicies(policies).map((policy) => (
                <PolicyRow
                  key={keyOf(policy)}
                  policy={policy}
                  selected={selectedKey === keyOf(policy)}
                  onSelect={() => setSelectedKey(keyOf(policy))}
                />
              ))}
              {/* 无法解析的文件：不生效也不遮蔽内置，但必须可见 —— 否则用户无从发现更无从修复 */}
              {invalid.length > 0 && (
                <div className="pt-2">
                  <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-amber-500/80">
                    {t('settings.policyInvalidGroup', { count: invalid.length })}
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

        {/* 底部操作：新建 / 打开用户策略目录 / 重扫描 */}
        <div className="border-t border-border-secondary p-2 flex items-center gap-1.5">
          <button
            onClick={() => setEditing({ kind: 'create', text: newPolicyTemplate(t) })}
            title={t('settings.policyNew')}
            className="flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg border border-dashed border-border-secondary text-[11px] text-text-secondary hover:text-text-primary hover:border-accent/40 hover:bg-accent/5 transition-colors"
          >
            <Plus size={12} />
            {t('settings.policyNew')}
          </button>
          <button
            onClick={() => void window.api.policy.openFolder()}
            title={t('settings.policyFsHint')}
            className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg border border-dashed border-border-secondary text-[11px] text-text-secondary hover:text-text-primary hover:border-accent/40 hover:bg-accent/5 transition-colors"
          >
            <FolderOpen size={12} />
            {t('settings.policyOpenFolder')}
          </button>
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            title={t('settings.policyRefresh')}
            className="px-2 py-1.5 rounded-lg border border-dashed border-border-secondary text-text-secondary hover:text-text-primary hover:border-accent/40 hover:bg-accent/5 transition-colors disabled:opacity-50"
          >
            <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* 右侧：详情（含操作）或 md 原文编辑器 */}
      <div className="flex-1 min-w-0 flex flex-col min-h-0 overflow-y-auto">
        {editing ? (
          <PolicyEditor
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
          <InvalidPolicyDetail
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
                <PolicyEditor
                  key={source.key}
                  target={{ kind: 'edit', name: selected.name, text: source.text }}
                  policy={selected}
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
          title={t('settings.policyDeleteConfirmTitle')}
          description={
            typeof confirmingDelete === 'string'
              ? t('settings.policyDeleteConfirmDesc', { name: confirmingDelete })
              : t('settings.policyDeleteFileConfirmDesc', { name: confirmingDelete.fileName })
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
 * md 原文编辑器。frontmatter 由属性卡渲染（结构化摘要 + 解析器实时校验徽章），
 * 正文即 Rationale 的 live-preview。非受控编辑器，保存时经 handleRef 直取全文
 * （对齐 SubAgentEditor）。保存失败把解析器原因原样显示 —— 它就是文件为何不生效的答案。
 */
function PolicyEditor({
  target,
  policy,
  readOnly = false,
  onCancel,
  onSaved,
  onCreateOverride,
  onDelete
}: {
  target: EditTarget
  /** 选中项元信息（头部徽标 / 路径 / 覆盖提示）；create、fix 态没有 */
  policy?: PolicyInfo
  /** 内置策略随包发布不可改 */
  readOnly?: boolean
  /** 仅 create / fix 态给取消（选中即详情的常态没有「取消」可言，同智能体页） */
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
          ? await window.api.policy.save({ originalName: target.name, text })
          : target.kind === 'fix'
            ? await window.api.policy.saveByFile({ fileName: target.fileName, text })
            : await window.api.policy.create({ text })
      if (!r.success) {
        setError(r.error || t('settings.policySaveFailed'))
        return
      }
      setSaved(true)
      // 新建返回落盘后的 name（frontmatter 为准）；覆写沿用原名；修复态由重扫定位
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
                ? (policy?.displayName ?? target.name)
                : target.kind === 'fix'
                  ? target.fileName
                  : t('settings.policyNew')}
            </span>
            {policy && (
              <span
                className={`shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[9px] ${
                  readOnly ? 'bg-bg-secondary text-text-tertiary' : 'bg-accent/10 text-accent'
                }`}
              >
                {readOnly && <Lock size={9} />}
                {policy.source === 'builtin'
                  ? t('settings.policySourceBuiltin')
                  : t('settings.policySourceUser')}
              </span>
            )}
            {policy?.overridden && (
              <span className="px-1.5 py-0.5 rounded-md text-[9px] shrink-0 bg-orange-500/10 text-orange-500">
                {t('settings.policyOverridden')}
              </span>
            )}
          </div>
          {policy?.basePath ? (
            <div className="font-mono text-[10px] text-text-tertiary truncate mt-0.5">
              {policy.basePath}
            </div>
          ) : (
            <div className="text-[10px] text-text-tertiary mt-0.5">
              {readOnly
                ? policy?.overridden
                  ? t('settings.policyOverriddenHint')
                  : t('settings.policyFsHint')
                : t('settings.policyEditHint')}
            </div>
          )}
        </div>
        {readOnly && !policy?.overridden && onCreateOverride && (
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
            title={t('settings.policyDeleteConfirmTitle')}
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
              : `${target.kind === 'edit' ? target.name : 'new-policy'}.md`
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

function PolicyRow({
  policy,
  selected,
  onSelect
}: {
  policy: PolicyInfo
  selected: boolean
  onSelect: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { Icon, objectType } = policyIcon(policy)
  return (
    <button
      onClick={onSelect}
      title={objectType ? `object.type: ${objectType}` : undefined}
      className={`group w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left transition-colors ${
        selected
          ? 'bg-accent/10 text-accent'
          : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
      } ${policy.overridden ? 'opacity-60' : ''}`}
    >
      <Icon size={14} className="shrink-0" />
      <div className="min-w-0 flex-1">
        <div
          className={`text-xs font-medium truncate ${policy.overridden ? 'line-through text-text-tertiary' : ''}`}
        >
          {policy.displayName}
        </div>
      </div>
      {policy.overridden && (
        /* 被同名用户策略覆盖的内置：仅展示,不生效 */
        <span className="shrink-0 px-1.5 py-0.5 rounded text-[9px] bg-bg-secondary text-text-tertiary">
          {t('settings.policyOverridden')}
        </span>
      )}
      {policy.source === 'builtin' && (
        /* 内置随包发布、不可直接编辑 —— 锁即「这行只能建覆盖副本」 */
        <span title={t('settings.policySourceBuiltin')} className="shrink-0 text-text-tertiary">
          <Lock size={11} />
        </span>
      )}
    </button>
  )
}
/**
 * 无法解析的策略文件详情：解析器原因 + 去修 / 删掉两条出路。
 * 它不生效也不遮蔽内置（安全语义），但让用户看得见、改得动，才是「不再静默失效」的完整形态。
 */
function InvalidPolicyDetail({
  file,
  onFix,
  onDelete
}: {
  file: InvalidPolicyFile
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
          {t('settings.policyFix')}
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
      <div className="text-[11px] text-amber-500/90">{t('settings.policyInvalidHint')}</div>
      <div className="px-3 py-2 rounded-lg bg-red-500/10 text-red-500 text-[11px] whitespace-pre-wrap break-words leading-relaxed">
        {file.error}
      </div>
    </div>
  )
}
