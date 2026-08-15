import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Copy, Lock, Save, Trash2 } from 'lucide-react'
import { LivePreviewEditor, type LivePreviewEditorHandle } from '@shuvix/app-shell'
import { ModelSelect } from '@shuvix/chat-ui'
import { formatModelRef, resolveModelRef } from '@shuvix/chat-protocol/agentModelRef'
import type { AvailableModel } from '@shuvix/chat-protocol/types/provider'
import {
  InlineInput,
  SettingsBlock,
  SettingsRow,
  SettingsSection,
  Toggle
} from './SettingsPrimitives'
import { ToolSelectList, type ToolItem } from '../common/ToolSelectList'
import { ConfirmDialog } from '../common/ConfirmDialog'

/**
 * Sub-Agent 编辑器（设置页「智能体」tab 右侧详情面板；父组件按 agent 用 key 重挂载）。
 *
 * 布局与提供商详情（ProviderTab）同构：SettingsSection 卡片（基本信息 / 工具 /
 * 系统提示词）+ SettingsRow 右侧控件 + SettingsBlock 全宽块；编辑态操作在头部
 * （保存按钮带已保存态 + 删除图标按钮，对齐提供商头部的删除位）。
 *
 * 字段映射标准化定义文件（agentDefinitionFile.ts）：文本 key（name / description /
 * shuvix-displayName）用文本输入；tools 复用 ToolSelectList
 * （与会话工具选择同一名称语法：内置名 / mcp:<server> / skill:<name>），并注入
 * 合成的 `Agent` 条目（嵌套派发 opt-in）；系统提示词正文复用 notebook 的
 * LivePreviewEditor（非受控 + handleRef 保存时取值）。
 *
 * readOnly（内置 agent）：全字段禁用、编辑器只读渲染、无操作按钮。
 * mode='create'（新建对话框复用）：隐藏头部、保留底部保存栏（对话框形态），
 * name / description / systemPrompt 三字段必填 —— 未满足时保存禁用并展示必填提示。
 */

/** 编辑载荷 —— 与 IPC SubAgentSaveParams['agent'] 同构（该类型非全局，组件侧从 SubAgentInfo 投影） */
export type SubAgentEditData = Pick<
  SubAgentInfo,
  | 'name'
  | 'displayName'
  | 'description'
  | 'systemPrompt'
  | 'tools'
  | 'model'
  | 'instructionFiles'
  | 'projectPrompt'
  // GUI 无开关，但必须随表单原样往返 —— 漏掉它，保存一次就把 md 里的 shuvix-dispatch-only 抹掉了
  | 'dispatchOnly'
>

interface SubAgentEditorProps {
  agent: SubAgentInfo
  /** 只读模式（内置 agent）：展示同一表单但不可编辑、无保存栏 */
  readOnly?: boolean
  /** 'create'：新建对话框内嵌形态 —— 隐藏头部、三字段必填；缺省 'edit' */
  mode?: 'edit' | 'create'
  /** 保存；返回 null = 成功（就地闪现已保存），返回字符串 = 错误消息（就地展示） */
  onSave?: (data: SubAgentEditData) => Promise<string | null>
  /** 只读头部的「创建覆盖副本」入口（内置 agent 定制路径；缺省不显示） */
  onCreateOverride?: () => void
  /** 删除该用户档案（确认后调用）；返回 null = 成功（父组件负责切走选中），字符串 = 错误消息 */
  onDelete?: () => Promise<string | null>
}

export function SubAgentEditor({
  agent,
  readOnly,
  mode = 'edit',
  onSave,
  onCreateOverride,
  onDelete
}: SubAgentEditorProps): React.JSX.Element {
  const { t } = useTranslation()
  const isCreate = mode === 'create'

  const [name, setName] = useState(agent.name)
  const [displayName, setDisplayName] = useState(
    agent.displayName === agent.name ? '' : agent.displayName
  )
  const [description, setDescription] = useState(agent.description)
  const [tools, setTools] = useState<string[]>(agent.tools)
  // `shuvix-model` 原样字符串（'' = 未声明）。刻意不拆成 provider/model 两个 state：
  // 档案里的模型此刻可能不可用（提供商停用/模型删了），拆解会在保存时把解不出的值丢掉。
  const [modelRef, setModelRef] = useState(agent.model ?? '')
  const [availableModels, setAvailableModels] = useState<AvailableModel[]>([])
  const [instructionFiles, setInstructionFiles] = useState(agent.instructionFiles ?? false)
  const [projectPrompt, setProjectPrompt] = useState(agent.projectPrompt ?? false)
  const [allTools, setAllTools] = useState<ToolItem[]>([])
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const editorRef = useRef<LivePreviewEditorHandle | null>(null)
  // LivePreviewEditor 是非受控编辑器；保存时经 handleRef 直取，此镜像仅作 getMarkdown 兜底
  const promptMirror = useRef(agent.systemPrompt)
  // 提示词非空的响应式镜像（create 模式必填校验用；随编辑器防抖 onSave 更新）
  const [hasPrompt, setHasPrompt] = useState(!!agent.systemPrompt.trim())

  // 候选工具 = 全局 tools:list（内置 + MCP server + Skill，名称语法与白名单一致）
  // + 合成的 Agent 派发条目（不在注册表内，白名单显式声明才注入，见 AgentManager）
  useEffect(() => {
    let alive = true
    window.api.tools.list().then((list) => {
      if (!alive) return
      setAllTools([
        ...list,
        { name: 'Agent', label: t('tool.subAgentDispatchLabel'), group: 'agent' }
      ])
    })
    return () => {
      alive = false
    }
  }, [t])

  // 模型下拉的候选（已启用提供商的已启用模型）；与通用设置的「默认模型」同一数据源
  useEffect(() => {
    let alive = true
    window.api.provider.listAvailableModels().then((list) => {
      if (alive) setAvailableModels(list)
    })
    return () => {
      alive = false
    }
  }, [])

  // 档案里的模型此刻是否还在目录里；解不出 = 提供商停用/模型已删（保留原值，仅提示）
  const resolvedModel = useMemo(
    () => resolveModelRef(modelRef, availableModels),
    [modelRef, availableModels]
  )
  const modelUnavailable = !!modelRef.trim() && !resolvedModel

  // create 模式三字段必填；edit 模式仅要求 name（存量文件允许空描述/空提示词）
  const missingRequired = isCreate && (!description.trim() || !hasPrompt)

  const handleSave = async (): Promise<void> => {
    const trimmedName = name.trim()
    if (!trimmedName || saving || readOnly || !onSave || missingRequired) return
    setSaving(true)
    setError(null)
    const systemPrompt = (editorRef.current?.getMarkdown() ?? promptMirror.current).trim()
    if (isCreate && !systemPrompt) {
      // 防抖窗口内的空提示词兜底（hasPrompt 尚未回落）
      setSaving(false)
      return
    }
    const err = await onSave({
      name: trimmedName,
      displayName: displayName.trim() || trimmedName,
      description: description.trim(),
      systemPrompt,
      tools,
      model: modelRef.trim() || undefined,
      instructionFiles,
      projectPrompt,
      dispatchOnly: agent.dispatchOnly
    })
    setSaving(false)
    if (err) {
      setError(err)
    } else {
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    }
  }

  const handleDelete = async (): Promise<void> => {
    if (!onDelete || deleting) return
    setDeleting(true)
    setError(null)
    const err = await onDelete()
    setDeleting(false)
    setConfirmingDelete(false)
    if (err) setError(err)
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* 头部（提供商详情同构）：标题区 + 右侧操作（保存/删除）；create 模式由对话框标题栏替代 */}
      {!isCreate && (
        <div className="px-5 py-3 border-b border-border-secondary shrink-0 flex items-center justify-between gap-3">
          <div className="min-w-0 space-y-0.5">
            <div className="flex items-center gap-2 min-w-0">
              <h3 className="text-sm font-semibold text-text-primary truncate">
                {agent.displayName}
              </h3>
              <code className="text-[10px] text-text-tertiary font-mono shrink-0">
                {agent.name}
              </code>
              <span
                className={`flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[9px] shrink-0 ${
                  readOnly ? 'bg-bg-secondary text-text-tertiary' : 'bg-accent/10 text-accent'
                }`}
              >
                {readOnly && <Lock size={9} />}
                {agent.source === 'builtin' ? t('tool.subAgentBuiltin') : t('tool.subAgentCustom')}
              </span>
              {agent.overridden && (
                <span className="px-1.5 py-0.5 rounded-md text-[9px] shrink-0 bg-amber-500/10 text-amber-500">
                  {t('tool.subAgentOverridden')}
                </span>
              )}
            </div>
            {agent.basePath ? (
              <div className="font-mono text-[10px] text-text-tertiary truncate">
                {agent.basePath}
              </div>
            ) : (
              readOnly && (
                <p className="text-[10px] text-text-tertiary">
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
                onClick={handleSave}
                disabled={!name.trim() || saving || saved}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-60 ${
                  saved
                    ? 'bg-success/20 text-success'
                    : 'bg-accent text-white hover:bg-accent-hover'
                }`}
              >
                {saved ? <Check size={13} /> : <Save size={13} />}
                {saved ? t('settings.saved') : t('common.save')}
              </button>
            )}
            {!readOnly && onDelete && (
              <button
                onClick={() => setConfirmingDelete(true)}
                disabled={deleting}
                title={t('tool.subAgentDeleteConfirmTitle')}
                className="p-1.5 rounded-md text-error hover:bg-error/10 transition-colors disabled:opacity-50"
              >
                <Trash2 size={13} />
              </button>
            )}
          </div>
        </div>
      )}

      {/* 表单主体（提供商详情同构：SettingsSection 卡片体系，整页统一滚动） */}
      <div className="flex-1 min-h-0 overflow-y-auto px-5 py-5 space-y-5">
        {error && !isCreate && (
          <div className="px-3 py-2 rounded-lg border border-error/30 bg-error/5 text-[11px] text-error leading-relaxed">
            {error}
          </div>
        )}

        <SettingsSection title={t('tool.subAgentBasicGroup')}>
          <SettingsRow
            title={t('tool.subAgentName')}
            control={
              <InlineInput
                value={name}
                onChange={setName}
                width={260}
                monospace
                disabled={readOnly}
              />
            }
          />
          <SettingsRow
            title={t('tool.subAgentDisplayName')}
            control={
              <InlineInput
                value={displayName}
                onChange={setDisplayName}
                width={260}
                placeholder={name.trim() || agent.name}
                disabled={readOnly}
              />
            }
          />
          {/* 指定模型（`shuvix-model`）：与通用设置的「默认模型」同一个 ModelSelect；
              留空 = 不声明，会话/派发方给什么用什么。存的值恒为 providerId/modelId */}
          <SettingsRow
            title={t('tool.subAgentModel')}
            description={
              modelUnavailable ? (
                <span className="text-warning">
                  {t('tool.subAgentModelUnavailable', { ref: modelRef })}
                </span>
              ) : undefined
            }
            control={
              <ModelSelect
                availableModels={availableModels}
                provider={resolvedModel?.providerId ?? ''}
                model={resolvedModel?.modelId ?? ''}
                onChange={(p, m) => setModelRef(formatModelRef(p, m))}
                readonly={readOnly}
                allowClear
                placeholder={t('tool.subAgentModelNone')}
                clearLabel={t('tool.subAgentModelNone')}
              />
            }
          />
          <SettingsBlock label={t('tool.subAgentDescription')}>
            {/* field-sizing: content —— 随内容自动增高，不出内部滚动条（Chromium 123+） */}
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={readOnly}
              placeholder={readOnly ? undefined : t('tool.subAgentDescPlaceholder')}
              rows={2}
              className="zen-textarea leading-relaxed resize-none [field-sizing:content]"
            />
          </SettingsBlock>
          {/* 上下文注入开关（指令文件 / 项目提示词）——同一注入管线 */}
          <SettingsRow
            title={t('tool.subAgentInstructionFiles')}
            control={
              <Toggle
                on={instructionFiles}
                onClick={() => setInstructionFiles((v) => !v)}
                disabled={readOnly}
              />
            }
          />
          <SettingsRow
            title={t('tool.subAgentProjectPrompt')}
            control={
              <Toggle
                on={projectPrompt}
                onClick={() => setProjectPrompt((v) => !v)}
                disabled={readOnly}
              />
            }
          />
        </SettingsSection>

        <SettingsSection title={t('tool.subAgentTools')}>
          {/* 不限高：完整铺开所有分组（卡片承担外框），整页统一滚动 */}
          <div className={readOnly ? 'pointer-events-none opacity-80' : ''}>
            <ToolSelectList
              tools={allTools}
              enabledTools={tools}
              onChange={readOnly ? () => {} : setTools}
              compact
            />
          </div>
        </SettingsSection>

        <SettingsSection title={t('tool.subAgentSystemPrompt')}>
          {/* 不限高：普通块级容器（勿用 flex——flex-basis:0 会把不定高容器塌缩到 min-h
              并被编辑器根的 overflow-hidden 裁切）。高度链 height:100% 在不定高父级下
              逐层退化为内容高度，CM6 随文档自然增长、无内部滚动，整页统一滚动 */}
          <div className="min-h-[160px]">
            <LivePreviewEditor
              documentId={`subagent-editor:${agent.source}:${agent.name}`}
              initialContent={agent.systemPrompt}
              readOnly={readOnly}
              onSave={(md) => {
                promptMirror.current = md
                setHasPrompt(!!md.trim())
              }}
              handleRef={editorRef}
            />
          </div>
        </SettingsSection>
      </div>

      {/* 底栏：仅 create 模式（对话框形态；编辑态操作在头部） */}
      {isCreate && (
        <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-border-secondary shrink-0">
          <span className={`text-[10px] truncate ${error ? 'text-error' : 'text-text-tertiary'}`}>
            {error ?? (!name.trim() || missingRequired ? t('tool.subAgentCreateRequired') : '')}
          </span>
          <button
            onClick={handleSave}
            disabled={!name.trim() || saving || missingRequired}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-accent text-white hover:bg-accent-hover transition-colors disabled:opacity-50 shrink-0"
          >
            <Save size={13} />
            {t('common.save')}
          </button>
        </div>
      )}

      {/* 删除确认 */}
      {confirmingDelete && (
        <ConfirmDialog
          title={t('tool.subAgentDeleteConfirmTitle')}
          description={t('tool.subAgentDeleteConfirmDesc', { name: agent.name })}
          confirmText={t('common.delete')}
          cancelText={t('common.cancel')}
          onConfirm={() => void handleDelete()}
          onCancel={() => setConfirmingDelete(false)}
        />
      )}
    </div>
  )
}
