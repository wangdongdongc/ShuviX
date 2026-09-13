/**
 * 属性卡字段槽位里的选择器 —— **直接复用仓库既有的成熟组件**，不另造轮子：
 *   - `shuvix-tools`（csv）→ ToolSelectList（分组勾选、MCP 连接态、skill 启停）
 *   - `shuvix-model`（select）→ ModelSelect（提供商图标、能力标记、搜索、清除）
 *   - wiki 的 status / entry-type、workflow 的重入策略（select）→ EnumField（契约封闭
 *     枚举的原生下拉；wiki 状态带生命周期圆点）。候选项直接引契约常量 —— 它们是静态
 *     契约，不像工具/模型那样依赖运行时目录。
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
  WORKFLOW_CONCURRENCY_KEY,
  WORKFLOW_CONCURRENCY_MODES
} from '@shuvix/chat-protocol/shuvixMdDescriptors'
import {
  KNOWLEDGE_MARKER_TYPE,
  KNOWLEDGE_TYPES,
  OKF_STATUSES,
  OKF_STATUS_KEY,
  OKF_TYPE_KEY
} from '@shuvix/chat-protocol/knowledge'
import { ToolSelectList, type ToolItem } from '../common/ToolSelectList'

export interface FrontmatterFieldPickerProps {
  /** frontmatter 键名 —— csv 的控件按它分派（见文件头注释） */
  fieldKey: string
  /** 本文件的 `shuvix: <type>` 类型段 —— OKF 条目的键名是通用词（`type` / `status`），
   *  只按键分派会和将来别家契约的同名键撞上，故分派看「类型 + 键」 */
  markerType: string
  kind: 'csv' | 'select'
  /** 当前行的原始值（csv 逗号串 / 模型 ref） */
  value: string
  /** 写回（null = 删除该键） */
  onChange: (next: string | null) => void
  /** 只读（内置档案 / 只读预览）：控件照常渲染但不可交互 */
  readOnly?: boolean
}

/** 单个控件的入参（分派由外层做完，控件本身不看文件类型 / key / kind） */
type FieldControlProps = Omit<FrontmatterFieldPickerProps, 'kind' | 'fieldKey' | 'markerType'>

/**
 * 卡上控件的共同外观（与 frontmatterCard.ts 的 CONTROL 同一套话）：静止时不描边不填底，
 * 悬停淡底、聚焦才填底描边 —— 属性卡是一张清单，不到交互那一刻控件不该像控件。
 * 描边颜色由各控件自己补（正常态 border-transparent，管线下拉的警示态换琥珀）。
 * 尺寸同样照它的约定：leading-5 + py-px + 1px 描边 = 24px，一行 26px。
 */
const FLAT_CONTROL =
  'appearance-none rounded-md border bg-transparent transition-colors enabled:hover:bg-bg-tertiary/40 focus:outline-none focus:bg-bg-primary focus:border-accent/50'

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
        // 但它是 shuvix-tools 的合法条目 —— 合成注入
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
        className={`${FLAT_CONTROL} border-transparent flex items-center gap-1.5 max-w-full px-2 py-px text-[12px] leading-5 text-text-primary disabled:cursor-default disabled:text-text-secondary`}
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
      flat
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
      className={`cm-shuvix-fmcard-input ${FLAT_CONTROL} border-transparent w-full max-w-[320px] px-2 py-px text-[12px] font-mono leading-5 text-text-primary placeholder:text-text-tertiary/70 disabled:opacity-60`}
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
 * OKF 条目状态的圆点。与 wiki 的三色刻意不同：OKF 的 `draft` 是「还没人审」（琥珀，同侧栏
 * 那枚草稿徽标），`deprecated` 才是灰的退场态 —— 两套枚举同名不同义，共用一张表会把
 * 「等审阅」画成「已作废」。
 */
const OKF_STATUS_DOT: Record<string, string> = {
  draft: 'bg-amber-400',
  stable: 'bg-green-500',
  deprecated: 'bg-text-tertiary/50'
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
          className={`cm-shuvix-fmcard-input ${FLAT_CONTROL} border-transparent pl-2 pr-6 py-px text-[12px] font-mono leading-5 text-text-primary disabled:opacity-60 cursor-pointer disabled:cursor-default`}
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

export function FrontmatterFieldPicker({
  fieldKey,
  markerType,
  kind,
  value,
  onChange,
  readOnly
}: FrontmatterFieldPickerProps): React.JSX.Element {
  if (kind === 'select') {
    // **按键显式分派**：模型选择器只认模型键。曾经它是 select 的兜底，于是任何新加的
    // select 字段（如工作流的重入策略）都会静默变成一个写着「选择模型」的模型下拉 ——
    // 属性卡不认识某个键时，退回自由文本下拉才是诚实的降级。
    if (fieldKey === AGENT_MODEL_KEY) {
      return <ModelField value={value} onChange={onChange} readOnly={readOnly} />
    }
    // OKF 条目的键名是通用词，先按标记类型收窄再按键分派
    const okf = markerType === KNOWLEDGE_MARKER_TYPE
    const options = okf
      ? fieldKey === OKF_TYPE_KEY
        ? KNOWLEDGE_TYPES
        : fieldKey === OKF_STATUS_KEY
          ? OKF_STATUSES
          : []
      : fieldKey === WIKI_STATUS_KEY
        ? WIKI_ENTRY_STATUSES
        : fieldKey === WIKI_ENTRY_TYPE_KEY
          ? WIKI_ENTRY_TYPES
          : fieldKey === WORKFLOW_CONCURRENCY_KEY
            ? WORKFLOW_CONCURRENCY_MODES
            : []
    return (
      <EnumField
        options={options}
        dotByValue={
          okf
            ? fieldKey === OKF_STATUS_KEY
              ? OKF_STATUS_DOT
              : undefined
            : fieldKey === WIKI_STATUS_KEY
              ? STATUS_DOT
              : undefined
        }
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
