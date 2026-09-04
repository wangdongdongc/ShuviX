/**
 * 属性卡字段槽位里的选择器 —— **直接复用仓库既有的成熟组件**，不另造轮子：
 *   - `shuvix-tools`（csv）→ ToolSelectList（分组勾选、MCP 连接态、skill 启停）
 *   - `shuvix-model`（select）→ ModelSelect（提供商图标、能力标记、搜索、清除）
 *   - wiki 的 status / entry-type、workflow 的重入策略（select）→ EnumField（契约封闭
 *     枚举的原生下拉；wiki 状态带生命周期圆点）。候选项直接引契约常量 —— 它们是静态
 *     契约，不像工具/模型那样依赖运行时目录。
 *   - bot 的管线绑定块 `shuvix-bot-pipeline`（botPipeline）→ BotPipelineField：工作流下拉，
 *     选中后按它声明的槽位列出一排 agent 下拉（候选项经 ChatApi `shuvixMd.botPipelineOptions`
 *     由宿主提供；没有的宿主退化为只读）。每一次改动经 onPatch 落成一次文档变更。
 *   - 其余 csv 键（如 `shuvix-instruction-files` 的指令文件清单）→ 纯文本逗号串输入。
 *     刻意不给它挂文件选择器：清单里可以写工作目录下任意相对路径，而属性卡编辑档案时
 *     根本不知道这份档案将来跑在哪个工作目录 —— 一个只能列出「此刻某个目录」的选择器
 *     会把它伪装成受限枚举。分派按**键**而非 kind：kind 只说"是个列表"，
 *     该配哪个控件是键的事。
 *
 * 卡片本身是纯 DOM 的 CM6 widget，故这里由 LivePreviewEditor 用独立 React root
 * 挂进槽位（widget.destroy → unmount）。独立 root 不继承应用的 Provider，但两个
 * 组件依赖的都是全局单例（i18next 默认实例、zustand store、getChatApi），无需 Provider。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { ChevronDown } from 'lucide-react'
import { ModelSelect, useModelCatalogStore, getChatApi } from '@shuvix/chat-ui'
import { formatModelRef, resolveModelRef } from '@shuvix/chat-protocol/agentModelRef'
import {
  WIKI_ENTRY_STATUSES,
  WIKI_ENTRY_TYPES,
  WIKI_ENTRY_TYPE_KEY,
  WIKI_STATUS_KEY
} from '@shuvix/chat-protocol/wikiFileContract'
import {
  AGENT_MODEL_KEY,
  BOT_PIPELINE_AGENTS_KEY,
  BOT_PIPELINE_INPUT_KEY,
  BOT_PIPELINE_WORKFLOW_KEY,
  WORKFLOW_CONCURRENCY_KEY,
  WORKFLOW_CONCURRENCY_MODES
} from '@shuvix/chat-protocol/shuvixMdDescriptors'
import type { BotPipelineOptions } from '@shuvix/chat-protocol/botPipeline'
import type { FrontmatterPathEdit } from '@shuvix/chat-protocol/utils/frontmatterPatch'
import { ToolSelectList, type ToolItem } from '../common/ToolSelectList'

export interface FrontmatterFieldPickerProps {
  /** frontmatter 键名 —— csv 的控件按它分派（见文件头注释） */
  fieldKey: string
  kind: 'csv' | 'select' | 'botPipeline'
  /** 当前行的原始值（csv 逗号串 / 模型 ref）；botPipeline 恒为空串 */
  value: string
  /** botPipeline：该键解析出的映射值（缺键 / 标量 → null） */
  mapping?: Record<string, unknown> | null
  /** 写回（null = 删除该键） */
  onChange: (next: string | null) => void
  /** botPipeline：按相对路径改嵌套映射（一批改写 = 一次文档变更） */
  onPatch?: (edits: FrontmatterPathEdit[]) => void
  /** 只读（内置档案 / 只读预览）：控件照常渲染但不可交互 */
  readOnly?: boolean
}

/** 单个控件的入参（分派由外层做完，控件本身不看 key / kind） */
type FieldControlProps = Omit<FrontmatterFieldPickerProps, 'kind' | 'fieldKey'>

/**
 * 工具白名单编辑：紧凑触发器 + ToolSelectList 弹层。
 *
 * 弹层经 portal 渲染到 body（fixed 定位 + 空间不足时上翻）—— 属性卡的圆角盒子带
 * `overflow-hidden`（分隔线与圆角要它），absolute 定位的弹层会被裁掉；ModelSelect
 * 早就是这么逃逸的，这里同策。
 */
function ToolsField({ value, onChange, readOnly = false }: FieldControlProps): React.JSX.Element {
  const { t } = useTranslation()
  const [tools, setTools] = useState<ToolItem[]>([])
  const [open, setOpen] = useState(false)
  /** 弹层打开期间的草稿（null = 未打开）—— 见下方 closePanel 的一次性写回 */
  const [draft, setDraft] = useState<string[] | null>(null)
  const [panelStyle, setPanelStyle] = useState<React.CSSProperties | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const enabled = useMemo(
    () =>
      value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    [value]
  )

  useEffect(() => {
    if (!open || tools.length > 0) return
    let alive = true
    void getChatApi()
      .tools.list()
      .then((list) => {
        if (!alive) return
        // 派发工具 agent 不在 tools.list 里（那份清单服务于聊天工具选择器，它是 hidden），
        // 但它是 shuvix-tools 的合法条目 —— 合成注入，同 SubAgentEditor
        setTools([
          ...list,
          { name: 'agent', label: t('tool.subAgentDispatchLabel'), group: 'agent' }
        ])
      })
    return () => {
      alive = false
    }
  }, [open, tools.length, t])

  /**
   * 关闭即写回（一次）。**不逐项写回**：每次写回都会让 YAML 变化 → widget 重建 →
   * React root 卸载 → 弹层消失，多选就得反复打开；一次性写回同时把一整轮选择
   * 收敛成一步 undo。
   */
  const closePanel = useCallback(() => {
    setOpen(false)
    setPanelStyle(null)
    setDraft((current) => {
      if (current && current.join(', ') !== enabled.join(', ')) {
        onChange(current.length > 0 ? current.join(', ') : null)
      }
      return null
    })
  }, [enabled, onChange])

  /** 定位：贴触发器下方右对齐；下方空间不足则上翻。在开合的那一刻算（rect 此刻已知） */
  const toggleOpen = useCallback(() => {
    if (open) {
      closePanel()
      return
    }
    setOpen((prev) => {
      if (prev) return prev
      const el = triggerRef.current
      if (!el) return false
      setDraft(enabled)
      const r = el.getBoundingClientRect()
      const width = 300
      const below = window.innerHeight - r.bottom - 8
      const flip = below < 200 && r.top > below
      setPanelStyle({
        position: 'fixed',
        width,
        maxHeight: Math.min(320, flip ? r.top - 8 : below),
        left: Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8)),
        ...(flip ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 })
      })
      return true
    })
  }, [open, closePanel, enabled])

  // 点外部关闭：触发器与弹层都算「内部」（弹层已 portal 到 body，不在触发器子树里）
  useEffect(() => {
    if (!open) return undefined
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return
      closePanel()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closePanel()
    }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open, closePanel])

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={readOnly}
        onMouseDown={(e) => {
          e.preventDefault()
          e.stopPropagation()
          if (!readOnly) toggleOpen()
        }}
        className="flex items-center gap-1.5 max-w-full px-2 py-1 rounded-md border border-border-secondary/50 bg-bg-primary text-[11px] text-text-primary transition-colors enabled:hover:border-border-secondary disabled:cursor-default disabled:text-text-secondary"
      >
        <span className="truncate font-mono">
          {enabled.length > 0 ? enabled.join(', ') : t('notebook.frontmatter.unset')}
        </span>
        <ChevronDown size={12} className="shrink-0 text-text-tertiary" />
      </button>
      {open &&
        panelStyle &&
        createPortal(
          <div
            ref={panelRef}
            style={panelStyle}
            className="cm-shuvix-fmcard-tools-panel z-50 overflow-y-auto rounded-xl border border-border-secondary bg-bg-secondary shadow-lg p-1.5"
          >
            <ToolSelectList
              tools={tools}
              enabledTools={draft ?? enabled}
              onChange={setDraft}
              compact
            />
          </div>,
          document.body
        )}
    </>
  )
}

/** 模型选择：ModelSelect 自带 portal 下拉与清除，直接受控接进来 */
function ModelField({ value, onChange, readOnly = false }: FieldControlProps): React.JSX.Element {
  const availableModels = useModelCatalogStore((s) => s.availableModels)
  const allProviders = useModelCatalogStore((s) => s.providers)
  // 只列**已启用**的提供商 —— 传全量会把没开启的也渲染成分组（同 ModelPicker 的过滤）
  const providers = useMemo(() => allProviders.filter((p) => p.isEnabled), [allProviders])
  // `<provider>/<model>` 与裸 `<model>` 都能读（解析规则与 agent 档案一致）
  const resolved = useMemo(() => resolveModelRef(value, availableModels), [value, availableModels])

  // 有值但解析不出（提供商停用 / 模型已删）：占位文案退回原始 ref，
  // 否则显示「选择模型」会让人以为没设置，一选就把档案里的值静默改掉
  const unresolved = value.trim() !== '' && !resolved

  return (
    <ModelSelect
      availableModels={availableModels}
      providers={providers}
      provider={resolved?.providerId ?? ''}
      model={resolved?.modelId ?? ''}
      placeholder={unresolved ? value.trim() : undefined}
      readonly={readOnly}
      width={230}
      allowClear
      onChange={(provider, model) =>
        onChange(provider && model ? formatModelRef(provider, model) : null)
      }
    />
  )
}

/**
 * 通用列表输入：逗号串原样编辑（回车/失焦提交，Esc 还原，清空即删键）。
 * 视觉与属性卡的文本行同源（同一套 bg/圆角/焦点描边），只是收窄成槽位宽度。
 *
 * 非受控（defaultValue + ref）：写回会改 YAML → CM6 重建 widget → 本 React root
 * 整个卸载重挂，外部值变化天然由重挂承接，不需要 state 去追 prop。
 */
function TextListField({
  value,
  onChange,
  readOnly = false
}: FieldControlProps): React.JSX.Element {
  const { t } = useTranslation()

  const commit = (next: string): void => {
    const cleaned = next.replace(/\s*\n+\s*/g, ' ').trim()
    if (cleaned === value.trim()) return
    onChange(cleaned === '' ? null : cleaned)
  }

  return (
    <input
      defaultValue={value}
      disabled={readOnly}
      placeholder={t('notebook.frontmatter.unset')}
      className="cm-shuvix-fmcard-input w-[230px] max-w-full appearance-none bg-bg-primary rounded-md px-2.5 py-1 text-[11.5px] font-mono leading-relaxed text-text-primary border border-transparent transition-colors hover:border-border-secondary/60 focus:outline-none focus:border-accent/60 placeholder:text-text-tertiary disabled:opacity-60"
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => {
        // 卡内按键不外泄给编辑器（同 ToolsField / 属性卡文本行）
        e.stopPropagation()
        if (e.key === 'Enter') {
          e.preventDefault()
          e.currentTarget.blur()
        } else if (e.key === 'Escape') {
          e.currentTarget.value = value
          e.currentTarget.blur()
        }
      }}
    />
  )
}

/** wiki 状态的生命周期圆点（draft 灰 / reviewed 琥珀 / stable 绿）—— 一眼可辨，色彩不承载唯一信息 */
const STATUS_DOT: Record<string, string> = {
  draft: 'bg-text-tertiary/50',
  reviewed: 'bg-amber-400',
  stable: 'bg-green-500'
}

/**
 * 契约封闭枚举的下拉（原生 select + 自绘箭头，样式对齐卡片输入框）。
 * 空值 = 删除该键（同其它控件的 onChange(null) 约定，wiki 读者对缺失自有缺省）；
 * 枚举外的手改值如实并入候选（不静默吞掉 —— 保存前它仍是文件里的事实）。
 */
function EnumField({
  options,
  dotByValue,
  value,
  onChange,
  readOnly = false
}: FieldControlProps & {
  options: readonly string[]
  dotByValue?: Record<string, string>
}): React.JSX.Element {
  const { t } = useTranslation()
  const current = value.trim()
  const opts = current && !options.includes(current) ? [current, ...options] : [...options]
  return (
    <span className="cm-shuvix-fmcard-enum flex items-center gap-1.5">
      {dotByValue && current !== '' && (
        <span
          className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotByValue[current] ?? 'bg-text-tertiary/50'}`}
        />
      )}
      <span className="relative">
        <select
          value={current}
          disabled={readOnly}
          className="cm-shuvix-fmcard-input appearance-none bg-bg-primary rounded-md pl-2.5 pr-6 py-1 text-[11.5px] font-mono leading-relaxed text-text-primary border border-transparent transition-colors hover:border-border-secondary/60 focus:outline-none focus:border-accent/60 disabled:opacity-60 cursor-pointer"
          onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <option value="">{t('notebook.frontmatter.unset')}</option>
          {opts.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
        <ChevronDown
          size={11}
          className="absolute right-1.5 top-1/2 -translate-y-1/2 pointer-events-none text-text-tertiary"
        />
      </span>
    </span>
  )
}

const SELECT_CLASS =
  'cm-shuvix-fmcard-input appearance-none rounded-md pl-2.5 pr-6 py-1 text-[11.5px] font-mono leading-relaxed border transition-colors focus:outline-none focus:border-accent/60 disabled:opacity-60 cursor-pointer disabled:cursor-default'

/** 属性卡下拉的一致外观：正常态透明描边、警示态琥珀描边 + 琥珀文字 */
function selectClass(warn: boolean): string {
  return `${SELECT_CLASS} ${
    warn
      ? 'bg-bg-primary border-warning/60 text-warning'
      : 'bg-bg-primary border-transparent text-text-primary hover:border-border-secondary/60'
  }`
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * bot 管线绑定块的联动控件：工作流下拉 → 它声明的槽位各一个 agent 下拉 → 入参只读摘要。
 *
 * 换工作流时旧工作流的槽位条目一并删除（一次 onPatch）：槽位是**这份管线**的从属项，
 * 留着只会变成一堆「未声明」的孤儿。槽位未填不落 YAML（下拉选「未设置」= 删那一行），
 * 必填未填 / 指向不存在的 agent / 未声明的额外槽位用琥珀提示 —— 与主进程校验横幅同一
 * 套判据，这里只是把它落到具体那一行上。候选项拿不到（宿主没有 bot 面 / 请求失败）时
 * 整块退化为只读：现有值照常显示，下拉禁用。
 */
function BotPipelineField({
  mapping,
  onPatch,
  readOnly = false
}: {
  mapping: Record<string, unknown> | null
  onPatch?: (edits: FrontmatterPathEdit[]) => void
  readOnly?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  // undefined = 加载中；null = 拿不到（宿主没有 bot 面 / 请求失败）→ 只读
  const [options, setOptions] = useState<BotPipelineOptions | null | undefined>(undefined)

  useEffect(() => {
    const fetchOptions = getChatApi().shuvixMd.botPipelineOptions
    if (!fetchOptions) {
      setOptions(null) // eslint-disable-line react-hooks/set-state-in-effect
      return undefined
    }
    let alive = true
    fetchOptions()
      .then((o) => {
        if (alive) setOptions(o)
      })
      .catch(() => {
        if (alive) setOptions(null)
      })
    return () => {
      alive = false
    }
  }, [])

  const workflowRaw = mapping?.[BOT_PIPELINE_WORKFLOW_KEY]
  const workflow = typeof workflowRaw === 'string' ? workflowRaw.trim() : ''
  const agentsRaw = mapping?.[BOT_PIPELINE_AGENTS_KEY]
  const agents = useMemo(() => {
    const out: Record<string, string> = {}
    if (isPlainObject(agentsRaw)) {
      for (const [role, ref] of Object.entries(agentsRaw)) {
        if (typeof ref === 'string' && ref.trim()) out[role] = ref.trim()
      }
    }
    return out
  }, [agentsRaw])
  const inputRaw = mapping?.[BOT_PIPELINE_INPUT_KEY]
  const input = isPlainObject(inputRaw) ? inputRaw : null

  const wf = options?.workflows.find((w) => w.name === workflow)
  const declared = wf?.slots ?? []
  const extraRoles = Object.keys(agents).filter((r) => !declared.some((s) => s.role === r))
  const editable = !readOnly && !!onPatch && !!options
  const agentNames = options?.agents ?? []

  const pickWorkflow = (name: string): void => {
    if (!onPatch || !options || !name) return
    const keep = new Set(options.workflows.find((w) => w.name === name)?.slots.map((s) => s.role))
    const edits: FrontmatterPathEdit[] = [{ path: [BOT_PIPELINE_WORKFLOW_KEY], value: name }]
    // 旧工作流的槽位条目随之移除 —— 槽位表是这份管线的从属项
    for (const role of Object.keys(agents)) {
      if (!keep.has(role)) edits.push({ path: [BOT_PIPELINE_AGENTS_KEY, role], value: null })
    }
    onPatch(edits)
  }
  const pickSlot = (role: string, ref: string): void => {
    onPatch?.([{ path: [BOT_PIPELINE_AGENTS_KEY, role], value: ref || null }])
  }

  const sourceLabel = (source: 'builtin' | 'user'): string =>
    t(
      source === 'builtin'
        ? 'notebook.frontmatter.botSourceBuiltin'
        : 'notebook.frontmatter.botSourceUser'
    )
  const slotsLabel = (n: number): string =>
    n === 0
      ? t('notebook.frontmatter.botNoSlots')
      : t('notebook.frontmatter.botSlotsCount', { count: n })

  const workflowMissing = workflow !== '' && !!options && !wf
  const rowLabel = 'w-14 shrink-0 text-[12px] text-text-secondary pt-1'

  const slotRow = (
    role: string,
    required: boolean,
    extra: boolean,
    description?: string
  ): React.JSX.Element => {
    const ref = agents[role] ?? ''
    const missing = ref !== '' && !!options && !agentNames.includes(ref)
    const warn = (required && ref === '') || missing || extra
    const opts = ref && !agentNames.includes(ref) ? [ref, ...agentNames] : agentNames
    return (
      <div
        key={role}
        className="flex items-center gap-2"
        title={description ?? ''}
        data-bot-slot={role}
        data-bot-slot-extra={extra ? '' : undefined}
      >
        <span className="w-[74px] shrink-0 font-mono text-[11.5px] text-text-secondary truncate">
          {role}
          {required && <span className="text-text-tertiary"> *</span>}
        </span>
        <span className="relative">
          <select
            value={ref}
            disabled={!editable}
            className={selectClass(warn)}
            onChange={(e) => pickSlot(role, e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            data-bot-slot-select={role}
          >
            <option value="">{t('notebook.frontmatter.unset')}</option>
            {opts.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
          <ChevronDown
            size={11}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 pointer-events-none text-text-tertiary"
          />
        </span>
        {extra && (
          <span className="text-[10px] text-warning">{t('notebook.frontmatter.botSlotExtra')}</span>
        )}
      </div>
    )
  }

  return (
    <div className="cm-shuvix-fmcard-botpipe space-y-1.5 pl-3 pt-0.5" data-bot-pipeline>
      <div className="flex items-start gap-3">
        <span className={rowLabel}>{t('notebook.frontmatter.botWorkflow')}</span>
        <div className="min-w-0 flex-1 flex items-center gap-2 flex-wrap">
          <span className="relative">
            <select
              value={workflow}
              disabled={!editable}
              className={selectClass(workflowMissing || workflow === '')}
              onChange={(e) => pickWorkflow(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              data-bot-workflow-select
            >
              {workflow === '' && <option value="">{t('notebook.frontmatter.unset')}</option>}
              {workflowMissing && <option value={workflow}>{workflow}</option>}
              {(options?.workflows ?? []).map((w) => (
                <option key={w.name} value={w.name}>
                  {`${w.name}  (${sourceLabel(w.source)} · ${w.concurrency} · ${slotsLabel(w.slots.length)})`}
                </option>
              ))}
            </select>
            <ChevronDown
              size={11}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 pointer-events-none text-text-tertiary"
            />
          </span>
          {/* 来源与并发已在选中项的文案里；这里只在有问题时补一句琥珀提示 */}
          {(workflowMissing || (wf && wf.concurrency !== 'parallel')) && (
            <span className="font-mono text-[11px] text-warning" data-bot-workflow-meta>
              {workflowMissing
                ? t('notebook.frontmatter.botWorkflowMissing')
                : `${wf!.concurrency} ≠ parallel`}
            </span>
          )}
        </div>
      </div>
      <div className="flex items-start gap-3">
        <span className={rowLabel} title={t('settings.botSlotHint')}>
          {t('notebook.frontmatter.botSlots')}
        </span>
        <div className="min-w-0 flex-1 flex flex-col gap-1.5" data-bot-slots={declared.length}>
          {declared.map((s) => slotRow(s.role, s.required, false, s.description))}
          {extraRoles.map((role) => slotRow(role, false, true))}
          {declared.length === 0 && extraRoles.length === 0 && (
            <span className="text-[12px] text-text-tertiary pt-1">
              {options && wf
                ? t('notebook.frontmatter.botNoSlots')
                : t('notebook.frontmatter.unset')}
            </span>
          )}
        </div>
      </div>
      <div className="flex items-start gap-3">
        <span className={rowLabel}>{t('notebook.frontmatter.botInput')}</span>
        <div className="min-w-0 flex-1 pt-1" data-bot-input={input ? Object.keys(input).length : 0}>
          {input && Object.keys(input).length > 0 ? (
            <div className="flex flex-col gap-0.5 font-mono text-[11.5px]">
              {Object.entries(input).map(([k, v]) => (
                <div key={k} className="break-all">
                  <span className="text-text-secondary">{k}</span>
                  <span className="ml-2.5 text-text-primary">
                    {typeof v === 'string' ? v : JSON.stringify(v)}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <span className="text-[12px] text-text-tertiary">
              {t('notebook.frontmatter.botInputNone')}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

export function FrontmatterFieldPicker({
  fieldKey,
  kind,
  value,
  mapping,
  onChange,
  onPatch,
  readOnly
}: FrontmatterFieldPickerProps): React.JSX.Element {
  if (kind === 'botPipeline') {
    return <BotPipelineField mapping={mapping ?? null} onPatch={onPatch} readOnly={readOnly} />
  }
  if (kind === 'select') {
    // **按键显式分派**：模型选择器只认模型键。曾经它是 select 的兜底，于是任何新加的
    // select 字段（如工作流的重入策略）都会静默变成一个写着「选择模型」的模型下拉 ——
    // 属性卡不认识某个键时，退回自由文本下拉才是诚实的降级。
    if (fieldKey === AGENT_MODEL_KEY) {
      return <ModelField value={value} onChange={onChange} readOnly={readOnly} />
    }
    const options =
      fieldKey === WIKI_STATUS_KEY
        ? WIKI_ENTRY_STATUSES
        : fieldKey === WIKI_ENTRY_TYPE_KEY
          ? WIKI_ENTRY_TYPES
          : fieldKey === WORKFLOW_CONCURRENCY_KEY
            ? WORKFLOW_CONCURRENCY_MODES
            : []
    return (
      <EnumField
        options={options}
        dotByValue={fieldKey === WIKI_STATUS_KEY ? STATUS_DOT : undefined}
        value={value}
        onChange={onChange}
        readOnly={readOnly}
      />
    )
  }
  return fieldKey === 'shuvix-tools' ? (
    <ToolsField value={value} onChange={onChange} readOnly={readOnly} />
  ) : (
    <TextListField value={value} onChange={onChange} readOnly={readOnly} />
  )
}
