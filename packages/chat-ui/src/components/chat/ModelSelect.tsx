/**
 * ModelSelect —— 通用受控的「提供商 + 模型」选择器（纯 UI，无会话副作用）。
 *
 * 单一组件覆盖两处用法：
 *  - variant='boxed'：设置里的下拉框（provider · model + 可选清除图标）
 *  - variant='inline'：输入栏紧凑触发器（模型名 + 可选思考图标 + 悬浮全名 tooltip）
 * 思考深度（thinking）、只读（readonly）、无提供商引导（onConfigureProviders）均为可选配置。
 * 组件只吃 props 并通过 onChange / thinking.onChange 回调；一切持久化/会话副作用由调用方处理
 * （输入栏用 ModelPicker 包装，设置用 ModelDefaultsSettings 包装）。
 *
 * 下拉面板经 portal 渲染到 body（fixed 定位 + 按空间自动翻转），以逃离容器 overflow 裁剪。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import {
  ChevronDown,
  ChevronUp,
  Search,
  Eye,
  Wrench,
  Brain,
  Image as ImageIcon,
  Mic,
  X,
  Settings
} from 'lucide-react'
import type { AvailableModel } from '@shuvix/chat-protocol/types/provider'
import { ProviderIcon } from '../settings/ProviderIcons'

export interface ModelSelectThinking {
  level: string
  levels: { value: string; label: string }[]
  onChange: (level: string) => void
}

export interface ModelSelectProps {
  availableModels: AvailableModel[]
  /** 当前选中的提供商 / 模型（空串表示未选） */
  provider: string
  model: string
  /** 选中一对 (provider, model)；清除时回调空串对 */
  onChange: (provider: string, model: string) => void
  /** 触发器样式：boxed=设置下拉框（默认）；inline=输入栏紧凑文本 */
  variant?: 'boxed' | 'inline'
  /** 只读：仅显示当前模型名，不可展开 */
  readonly?: boolean
  /** boxed 触发器固定宽度（默认 260px） */
  width?: number
  /** 未选中时的占位文案 */
  placeholder?: string
  /** boxed：显示清除图标以回到未选态 */
  allowClear?: boolean
  clearLabel?: string
  /** 可选思考深度：仅当前模型支持 reasoning 时在面板底部显示 */
  thinking?: ModelSelectThinking
  /** 无可用提供商时的引导回调（inline 用） */
  onConfigureProviders?: () => void
  configureProvidersLabel?: string
  /** 可选提供商元信息（用于图标 name / 显示名 displayName）；缺省回退 availableModels.providerName */
  providers?: { id: string; name: string; displayName?: string }[]
}

function parseCaps(json: string): Record<string, unknown> {
  try {
    return JSON.parse(json || '{}')
  } catch {
    return {}
  }
}

export function ModelSelect({
  availableModels,
  provider,
  model,
  onChange,
  variant = 'boxed',
  readonly = false,
  width = 260,
  placeholder,
  allowClear = false,
  clearLabel,
  thinking,
  onConfigureProviders,
  configureProvidersLabel,
  providers
}: ModelSelectProps): React.JSX.Element {
  const { t } = useTranslation()
  const ref = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(provider ? [provider] : []))
  const [panelStyle, setPanelStyle] = useState<React.CSSProperties | null>(null)

  // 提供商列表：优先用传入的 providers（保留内部 name 作图标键、displayName 作显示名），
  // 否则从 availableModels 派生（此时以 providerName 兼作二者）
  const providerList = useMemo(() => {
    if (providers) {
      return providers.map((p) => ({
        id: p.id,
        iconKey: (p.name || '').toLowerCase(),
        label: p.displayName || p.name
      }))
    }
    const seen = new Map<string, string>()
    availableModels.forEach((m) => {
      if (!seen.has(m.providerId)) seen.set(m.providerId, m.providerName || m.providerId)
    })
    return [...seen.entries()].map(([id, label]) => ({ id, iconKey: label.toLowerCase(), label }))
  }, [providers, availableModels])

  const providerModels = useMemo(() => {
    const map = new Map<string, AvailableModel[]>()
    providerList.forEach((p) => {
      map.set(
        p.id,
        availableModels.filter(
          (m) => m.providerId === p.id && m.modelId.toLowerCase().includes(query.toLowerCase())
        )
      )
    })
    return map
  }, [providerList, availableModels, query])

  // 思考深度与模型的 reasoning 能力点解绑：只要调用方传了 thinking 配置即显示
  // （很多模型实际支持思考，但能力点常未配置）
  const showThinking = !!thinking

  // fixed 定位（相对视口）：按上/下可用空间自动翻转，portal 后不受祖先 overflow 裁剪
  const reposition = useCallback(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const gap = 4
    const panelW = 300
    const estH = 340
    // inline（输入栏，靠左）向右展开，避免伸进侧边栏；boxed（设置，靠右）向左对齐
    const rawLeft = variant === 'inline' ? r.left : r.right - panelW
    const left = Math.min(Math.max(8, rawLeft), window.innerWidth - panelW - 8)
    const openUp = window.innerHeight - r.bottom < estH && r.top > window.innerHeight - r.bottom
    setPanelStyle({
      position: 'fixed',
      left,
      width: panelW,
      zIndex: 50,
      ...(openUp ? { bottom: window.innerHeight - r.top + gap } : { top: r.bottom + gap })
    })
  }, [variant])

  // 仅挂/卸监听（初始定位在 toggle 里同步测量，避免在 effect 里直接 setState）
  useLayoutEffect(() => {
    if (!open) return
    window.addEventListener('scroll', reposition, true)
    window.addEventListener('resize', reposition)
    return () => {
      window.removeEventListener('scroll', reposition, true)
      window.removeEventListener('resize', reposition)
    }
  }, [open, reposition])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node
      if (ref.current?.contains(target) || panelRef.current?.contains(target)) return
      setOpen(false)
      setQuery('')
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const toggle = (): void => {
    if (readonly) return
    if (open) {
      setOpen(false)
      setQuery('')
      return
    }
    setExpanded(new Set(provider ? [provider] : []))
    setQuery('')
    reposition()
    setOpen(true)
  }

  const toggleProvider = (id: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const pick = (p: string, m: string): void => {
    onChange(p, m)
    setOpen(false)
    setQuery('')
  }

  const current = providerList.find((p) => p.id === provider)
  const hasSelection = !!provider && !!model
  const noneText = placeholder || clearLabel || t('input.selectModel')

  // ── inline 空态：无可用提供商 → 引导去配置（仅非只读且提供了回调时） ──
  if (variant === 'inline' && providerList.length === 0 && !readonly && onConfigureProviders) {
    return (
      <button
        type="button"
        onClick={onConfigureProviders}
        className="inline-flex items-center gap-1 text-[11px] text-error bg-error/10 hover:bg-error/20 rounded px-1.5 py-0.5 transition-colors"
      >
        <Settings size={11} />
        <span>{configureProvidersLabel || t('settings.providerSectionTitle')}</span>
      </button>
    )
  }

  // ── 触发器 ──
  const brain = showThinking && thinking!.level !== 'off' ? <Brain size={10} /> : null
  const trigger =
    variant === 'inline' ? (
      readonly ? (
        <span className="inline-flex items-center gap-1 text-[11px] text-text-tertiary cursor-default">
          {hasSelection ? (
            <>
              <span className="max-w-[120px] truncate">{model}</span>
              {brain}
            </>
          ) : (
            <span className="text-amber-500">{t('input.selectModel')}</span>
          )}
        </span>
      ) : (
        <button
          type="button"
          onClick={toggle}
          className={`inline-flex items-center gap-1 text-[11px] rounded px-1.5 py-0.5 transition-colors border border-transparent ${
            hasSelection
              ? 'text-text-tertiary hover:text-text-secondary hover:border-border-secondary'
              : 'text-amber-500 hover:text-amber-400'
          }`}
        >
          {hasSelection ? (
            <>
              <span className="max-w-[120px] truncate">{model}</span>
              {brain}
            </>
          ) : (
            <span>{t('input.selectModel')}</span>
          )}
          <ChevronDown size={11} />
        </button>
      )
    ) : (
      <>
        <button
          type="button"
          onClick={toggle}
          // 只读：禁用而非「可点但无反应」—— 后者外观仍是可交互的，与同处一行的其他
          // 只读控件（禁用的输入框/开关）不一致
          disabled={readonly}
          className="min-w-0 flex-1 flex items-center gap-1.5 bg-bg-primary rounded-md pl-2.5 pr-2 py-1 text-[11px] border border-border-secondary/50 transition-colors enabled:hover:border-border-secondary enabled:cursor-pointer disabled:cursor-default focus:outline-none focus:border-accent/60"
        >
          {hasSelection ? (
            <>
              <ProviderIcon name={current?.iconKey || ''} />
              <span className="text-text-tertiary shrink-0">{current?.label || provider}</span>
              <span className="text-text-tertiary/50 shrink-0">·</span>
              <span className="text-text-primary truncate flex-1 text-left">{model}</span>
            </>
          ) : (
            <span className="text-text-tertiary truncate flex-1 text-left">{noneText}</span>
          )}
          <ChevronDown size={11} className="text-text-tertiary shrink-0" />
        </button>
        {allowClear && hasSelection && !readonly && (
          <button
            type="button"
            onClick={() => onChange('', '')}
            title={clearLabel || t('input.selectModel')}
            className="shrink-0 p-1 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors"
          >
            <X size={12} />
          </button>
        )}
      </>
    )

  const containerClass =
    variant === 'inline'
      ? 'relative inline-flex items-center group'
      : 'relative inline-flex items-center gap-1 text-left'

  return (
    <div ref={ref} className={containerClass} style={variant === 'boxed' ? { width } : undefined}>
      {trigger}

      {/* 悬浮 tooltip：inline 且已选、未展开时显示完整模型名 */}
      {variant === 'inline' && !open && hasSelection && (
        <div className="pointer-events-none absolute left-0 bottom-6 z-20 hidden rounded-md border border-border-primary bg-bg-secondary px-2 py-1 shadow-xl group-hover:block">
          <div className="text-[11px] text-text-primary whitespace-nowrap">{model}</div>
        </div>
      )}

      {open &&
        panelStyle &&
        createPortal(
          <div
            ref={panelRef}
            style={panelStyle}
            className="picker-panel rounded-md border border-border-primary bg-bg-secondary shadow-lg overflow-hidden flex flex-col"
          >
            {/* 搜索框 */}
            <div className="px-2 py-1.5 border-b border-border-secondary">
              <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-bg-primary border border-border-secondary">
                <Search size={11} className="text-text-tertiary" />
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t('input.searchModel') || 'Search models...'}
                  className="flex-1 bg-transparent text-[11px] text-text-primary outline-none placeholder:text-text-tertiary"
                  autoFocus
                />
              </div>
            </div>

            <div className="max-h-64 overflow-y-auto py-1">
              {providerList.map((p) => {
                const models = providerModels.get(p.id) || []
                if (query && models.length === 0) return null
                const isExpanded = expanded.has(p.id) || !!query
                const isActive = p.id === provider
                return (
                  <div key={p.id}>
                    <button
                      type="button"
                      onClick={() => toggleProvider(p.id)}
                      className={`w-full flex items-center gap-1.5 px-2.5 py-1 text-[11px] transition-colors hover:bg-bg-hover ${
                        isActive ? 'text-text-primary font-medium' : 'text-text-secondary'
                      }`}
                    >
                      <ProviderIcon name={p.iconKey} />
                      <span className="truncate flex-1 text-left">{p.label}</span>
                      <span className="text-text-tertiary shrink-0">
                        {isExpanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                      </span>
                    </button>

                    {isExpanded && (
                      <div>
                        {models.length === 0 ? (
                          <div className="pl-5 pr-2.5 py-1 text-[10px] text-text-tertiary italic">
                            {t('input.noModels') || 'No models available'}
                          </div>
                        ) : (
                          models.map((m) => {
                            const caps = parseCaps(m.capabilities)
                            const isSelected = p.id === provider && m.modelId === model
                            return (
                              <button
                                key={m.id}
                                type="button"
                                onClick={() => pick(p.id, m.modelId)}
                                className={`w-full text-left pl-5 pr-2.5 py-1 transition-colors flex items-center gap-1.5 hover:bg-bg-hover ${
                                  isSelected
                                    ? 'bg-bg-hover text-text-primary font-medium'
                                    : 'text-text-secondary hover:text-text-primary'
                                }`}
                              >
                                <span className="text-[11px] truncate flex-1">{m.modelId}</span>
                                <div className="flex items-center gap-1 shrink-0 text-text-tertiary">
                                  {!!caps.vision && <Eye size={10} />}
                                  {!!caps.functionCalling && <Wrench size={10} />}
                                  {!!caps.reasoning && <Brain size={10} />}
                                  {!!caps.imageOutput && <ImageIcon size={10} />}
                                  {!!caps.audioInput && <Mic size={10} />}
                                </div>
                              </button>
                            )
                          })
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

            {/* 思考深度（可选，仅当前模型支持 reasoning 时） */}
            {showThinking && (
              <div className="flex items-center gap-1 border-t border-border-secondary px-2 py-1.5">
                <Brain size={11} className="text-text-tertiary flex-shrink-0" />
                <div className="flex items-center gap-0.5 flex-1">
                  {thinking!.levels.map((l) => (
                    <button
                      key={l.value}
                      type="button"
                      onClick={() => thinking!.onChange(l.value)}
                      className={`flex-1 text-[10px] px-1 py-0.5 rounded transition-colors ${
                        thinking!.level === l.value
                          ? 'bg-bg-hover text-text-primary font-medium'
                          : 'text-text-tertiary hover:bg-bg-hover hover:text-text-secondary'
                      }`}
                    >
                      {l.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>,
          document.body
        )}
    </div>
  )
}
