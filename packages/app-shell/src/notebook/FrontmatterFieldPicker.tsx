/**
 * 属性卡字段槽位里的选择器 —— **直接复用仓库既有的成熟组件**，不另造轮子：
 *   - `shuvix-tools`（csv）→ ToolSelectList（分组勾选、MCP 连接态、skill 启停）
 *   - `shuvix-model`（select）→ ModelSelect（提供商图标、能力标记、搜索、清除）
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
import { ToolSelectList, type ToolItem } from '../common/ToolSelectList'

export interface FrontmatterFieldPickerProps {
  kind: 'csv' | 'select'
  /** 当前行的原始值（csv 逗号串 / 模型 ref） */
  value: string
  /** 写回（null = 删除该键） */
  onChange: (next: string | null) => void
  /** 只读（内置档案 / 只读预览）：控件照常渲染但不可交互 */
  readOnly?: boolean
}

/**
 * 工具白名单编辑：紧凑触发器 + ToolSelectList 弹层。
 *
 * 弹层经 portal 渲染到 body（fixed 定位 + 空间不足时上翻）—— 属性卡的圆角盒子带
 * `overflow-hidden`（分隔线与圆角要它），absolute 定位的弹层会被裁掉；ModelSelect
 * 早就是这么逃逸的，这里同策。
 */
function ToolsField({
  value,
  onChange,
  readOnly = false
}: Omit<FrontmatterFieldPickerProps, 'kind'>): React.JSX.Element {
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
function ModelField({
  value,
  onChange,
  readOnly = false
}: Omit<FrontmatterFieldPickerProps, 'kind'>): React.JSX.Element {
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

export function FrontmatterFieldPicker({
  kind,
  value,
  onChange,
  readOnly
}: FrontmatterFieldPickerProps): React.JSX.Element {
  return kind === 'csv' ? (
    <ToolsField value={value} onChange={onChange} readOnly={readOnly} />
  ) : (
    <ModelField value={value} onChange={onChange} readOnly={readOnly} />
  )
}
