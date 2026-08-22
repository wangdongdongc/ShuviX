import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Copy, Lock, Save, Trash2 } from 'lucide-react'
import { LivePreviewEditor, type LivePreviewEditorHandle } from '@shuvix/app-shell'
import { ConfirmDialog } from '../common/ConfirmDialog'

/**
 * Sub-Agent 编辑器（设置页「智能体」tab 右侧详情；父组件按 agent 用 key 重挂载）。
 *
 * 编辑对象是**整份 agent md 原文**：frontmatter 由属性卡渲染成结构化字段（工具走
 * ToolSelectList、模型走 ModelSelect —— 与本页此前的表单是同一批组件），正文即系统
 * 提示词的 live-preview。与安全策略 tab 同形，理由也相同：md 才是事实源，逐字段表单
 * 会把注释、键序、未知键（如 `shuvix-builtin`）在一次保存里悄悄抹掉。
 *
 * 内置档案只读（随包发布，无文件）；「创建覆盖副本」取其等价 md 作新建初值。
 * 保存前由解析器校验，非法拒绝写盘并把人读原因原样显示。
 */
export interface SubAgentEditorProps {
  /** 列表项元信息（头部徽标 / 覆盖提示用） */
  agent: SubAgentInfo
  /** md 原文（内置为 serializeAgentDefinitionFile 的等价输出） */
  initialText: string
  /** create 模式用于新建对话框：保存走 createSource，头部不显示来源徽标 */
  mode?: 'edit' | 'create'
  readOnly?: boolean
  /** 保存成功；参数为落盘后的 name（改名后父组件据此重新选中） */
  onSaved?: (name: string) => Promise<void> | void
  /** 内置档案的「创建覆盖副本」入口 */
  onCreateOverride?: () => void
  /** 删除自定义档案；返回错误字符串表示失败 */
  onDelete?: () => Promise<string | null>
}

export function SubAgentEditor({
  agent,
  initialText,
  mode = 'edit',
  readOnly = false,
  onSaved,
  onCreateOverride,
  onDelete
}: SubAgentEditorProps): React.JSX.Element {
  const { t } = useTranslation()
  const isCreate = mode === 'create'
  const editorRef = useRef<LivePreviewEditorHandle | null>(null)
  const mirror = useRef(initialText)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const handleSave = async (): Promise<void> => {
    const text = editorRef.current?.getMarkdown() ?? mirror.current
    setSaving(true)
    setError(null)
    try {
      const res = isCreate
        ? await window.api.subAgent.createSource({ text })
        : await window.api.subAgent.saveSource({ originalName: agent.name, text })
      if (!res.success) {
        setError(res.error || 'Save failed')
        return
      }
      setSaved(true)
      const name = 'name' in res && typeof res.name === 'string' ? res.name : agent.name
      await onSaved?.(name)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (): Promise<void> => {
    setConfirmingDelete(false)
    setDeleting(true)
    try {
      const err = await onDelete?.()
      if (err) setError(err)
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="flex flex-col min-h-0 flex-1 overflow-y-auto">
      {/* 头部：名称 + 来源 + 操作 */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border-secondary shrink-0">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-text-primary truncate">
              {isCreate ? t('tool.subAgentAdd') : agent.displayName || agent.name}
            </span>
            {!isCreate && (
              <span
                className={`shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[9px] ${
                  readOnly ? 'bg-bg-secondary text-text-tertiary' : 'bg-accent/10 text-accent'
                }`}
              >
                {readOnly && <Lock size={9} />}
                {agent.source === 'builtin' ? t('tool.subAgentBuiltin') : t('tool.subAgentCustom')}
              </span>
            )}
            {agent.overridden && (
              <span className="px-1.5 py-0.5 rounded-md text-[9px] shrink-0 bg-amber-500/10 text-amber-500">
                {t('tool.subAgentOverridden')}
              </span>
            )}
          </div>
          {agent.basePath ? (
            <div className="font-mono text-[10px] text-text-tertiary truncate mt-0.5">
              {agent.basePath}
            </div>
          ) : (
            readOnly && (
              <p className="text-[10px] text-text-tertiary mt-0.5">
                {agent.overridden ? t('tool.subAgentOverriddenHint') : t('tool.subAgentReadOnly')}
              </p>
            )
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {readOnly && !agent.overridden && onCreateOverride && (
            <button
              onClick={onCreateOverride}
              className="flex items-center gap-1 px-2 py-1 rounded text-[10px] border border-dashed border-border-secondary text-text-secondary hover:text-text-primary hover:border-accent/40 hover:bg-accent/5 transition-colors"
            >
              <Copy size={10} />
              {t('tool.subAgentCreateOverride')}
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
          {!readOnly && !isCreate && onDelete && (
            <button
              onClick={() => setConfirmingDelete(true)}
              disabled={deleting}
              title={t('tool.subAgentDeleteConfirmTitle')}
              className="p-1.5 rounded-lg text-text-tertiary hover:text-red-500 hover:bg-red-500/10 transition-colors disabled:opacity-50"
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>

      {!readOnly && (
        <div className="px-4 pt-2 text-[10px] text-text-tertiary">{t('tool.subAgentEditHint')}</div>
      )}
      {error && (
        <div className="mx-4 mt-2 px-3 py-2 rounded-lg bg-red-500/10 text-red-500 text-[11px] whitespace-pre-wrap break-words">
          {error}
        </div>
      )}

      {/* 不限高：CM6 随文档自然增长、无内部滚动，整页统一滚动 */}
      <div className="min-h-[320px] p-2">
        <LivePreviewEditor
          layout="fill"
          documentId={`${agent.source}:${agent.name || 'new-agent'}.md`}
          initialContent={initialText}
          readOnly={readOnly}
          onSave={(md) => {
            mirror.current = md
            setSaved(false)
          }}
          handleRef={editorRef}
        />
      </div>

      {confirmingDelete && (
        <ConfirmDialog
          title={t('tool.subAgentDeleteConfirmTitle')}
          description={t('tool.subAgentDeleteConfirmDesc', { name: agent.displayName })}
          confirmText={t('common.delete')}
          cancelText={t('common.cancel')}
          onConfirm={() => void handleDelete()}
          onCancel={() => setConfirmingDelete(false)}
        />
      )}
    </div>
  )
}
