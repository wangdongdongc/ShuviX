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
 * inline 在触屏密度（`density: 'touch'`，手机布局）下：触发器是 36px 高的胶囊，面板换成底部抽屉
 * （TouchSheet），每行 44px 左右；搜索框不自动聚焦（一打开就弹键盘会把抽屉顶走）、字号 16px（iOS 聚焦小于
 * 16px 的输入框会放大整页）。
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
import { TouchSheet } from '../common/TouchSheet'
import type { ChatDensity } from '../../host/chatHostContext'

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
  /**
   * boxed：去掉静止态的描边与底色（悬停淡底、聚焦才填底描边），文字随清单行用 12px ——
   * 给「清单里的一格」用（笔记本属性卡），设置页的下拉框保持默认的盒子。
   */
  flat?: boolean
  /** 触发器上模型名那段文字的样式（缺省是正文色）—— 属性卡用它标出「值不来自文件」 */
  valueClassName?: string
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
  /** inline 的控件密度（见文件头）；缺省 compact */
  density?: ChatDensity
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
  flat = false,
  valueClassName,
  placeholder,
  allowClear = false,
  clearLabel,
  thinking,
  onConfigureProviders,
  configureProvidersLabel,
  providers,
  density = 'compact'
}: ModelSelectProps): React.JSX.Element {
  const { t } = useTranslation()
  const ref = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(provider ? [provider] : []))
  const [panelStyle, setPanelStyle] = useState<React.CSSProperties | null>(null)
  // 只有输入栏那一格换抽屉：设置里的下拉框（boxed）在哪都是下拉框
  const touch = variant === 'inline' && density === 'touch'

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
    if (!open || touch) return
    window.addEventListener('scroll', reposition, true)
    window.addEventListener('resize', reposition)
    return () => {
      window.removeEventListener('scroll', reposition, true)
      window.removeEventListener('resize', reposition)
    }
  }, [open, touch, reposition])

  // 抽屉不走这条：点遮罩由遮罩自己关（在 mousedown 就卸掉抽屉，随后那一下 click 会落到抽屉底下的东西上）
  useEffect(() => {
    if (!open || touch) return
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node
      if (ref.current?.contains(target) || panelRef.current?.contains(target)) return
      setOpen(false)
      setQuery('')
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open, touch])

  const close = (): void => {
    setOpen(false)
    setQuery('')
  }

  const toggle = (): void => {
    if (readonly) return
    if (open) {
      close()
      return
    }
    setExpanded(new Set(provider ? [provider] : []))
    setQuery('')
    if (!touch) reposition()
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
  const brain =
    showThinking && thinking!.level !== 'off' ? (
      <Brain size={touch ? 14 : 10} className="flex-shrink-0" />
    ) : null
  // 触屏：36px 的描边胶囊，模型名占满剩下的宽度、放不下才截（工具行里它是先让的那一格）
  const inlineTriggerCls = touch
    ? 'min-w-0 max-w-full inline-flex items-center gap-1.5 h-9 px-3 rounded-full border border-border-secondary/60 text-[13px] transition-colors active:bg-bg-hover'
    : 'min-w-0 max-w-full inline-flex items-center gap-1 text-[11px] rounded px-1.5 py-0.5 transition-colors border border-transparent'
  const modelNameCls = touch ? 'min-w-0 truncate' : 'min-w-0 max-w-[120px] truncate'
  const trigger =
    variant === 'inline' ? (
      readonly ? (
        <span
          className={`${touch ? 'min-w-0 inline-flex items-center gap-1.5 h-9 px-1 text-[13px]' : 'min-w-0 inline-flex items-center gap-1 text-[11px]'} text-text-tertiary cursor-default`}
        >
          {hasSelection ? (
            <>
              <span className={modelNameCls}>{model}</span>
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
          data-model-trigger=""
          className={`${inlineTriggerCls} ${
            hasSelection
              ? touch
                ? 'text-text-secondary'
                : 'text-text-tertiary hover:text-text-secondary hover:border-border-secondary'
              : 'text-amber-500 hover:text-amber-400'
          }`}
        >
          {hasSelection ? (
            <>
              <span className={modelNameCls}>{model}</span>
              {brain}
            </>
          ) : (
            <span className="truncate">{t('input.selectModel')}</span>
          )}
          <ChevronDown size={touch ? 15 : 11} className="flex-shrink-0" />
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
          className={`min-w-0 flex-1 flex items-center gap-1.5 rounded-md pr-2 border transition-colors enabled:cursor-pointer disabled:cursor-default focus:outline-none focus:border-accent/60 ${
            flat
              ? 'pl-2 py-0.5 text-[12px] bg-transparent border-transparent enabled:hover:bg-bg-tertiary/40 focus:bg-bg-primary'
              : 'pl-2.5 py-1 text-[11px] bg-bg-primary border-border-secondary/50 enabled:hover:border-border-secondary'
          }`}
        >
          {hasSelection ? (
            <>
              <ProviderIcon name={current?.iconKey || ''} />
              <span className="text-text-tertiary shrink-0">{current?.label || provider}</span>
              <span className="text-text-tertiary/50 shrink-0">·</span>
              <span
                className={`${valueClassName ?? 'text-text-primary'} truncate flex-1 text-left`}
              >
                {model}
              </span>
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

  // ── 面板内容（下拉面板与触屏抽屉共用；触屏只是放大行高与字号） ──
  const panelBody = (
    <>
      {/* 搜索框 */}
      <div
        className={
          touch
            ? 'px-3 pb-2 border-b border-border-secondary'
            : 'px-2 py-1.5 border-b border-border-secondary'
        }
      >
        <div
          className={`flex items-center rounded bg-bg-primary border border-border-secondary ${
            touch ? 'gap-2 h-10 px-3 rounded-lg' : 'gap-1.5 px-2 py-1'
          }`}
        >
          <Search size={touch ? 16 : 11} className="text-text-tertiary" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('input.searchModel') || 'Search models...'}
            className={`flex-1 min-w-0 bg-transparent text-text-primary outline-none placeholder:text-text-tertiary ${
              touch ? 'text-[16px]' : 'text-[11px]'
            }`}
            autoFocus={!touch}
          />
        </div>
      </div>

      <div
        className={
          touch
            ? 'min-h-0 flex-1 overflow-y-auto overscroll-contain py-1'
            : 'max-h-64 overflow-y-auto py-1'
        }
      >
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
                className={`w-full flex items-center transition-colors hover:bg-bg-hover ${
                  touch ? 'gap-2.5 min-h-11 px-4 text-[15px]' : 'gap-1.5 px-2.5 py-1 text-[11px]'
                } ${isActive ? 'text-text-primary font-medium' : 'text-text-secondary'}`}
              >
                <ProviderIcon name={p.iconKey} />
                <span className="truncate flex-1 text-left">{p.label}</span>
                <span className="text-text-tertiary shrink-0">
                  {isExpanded ? (
                    <ChevronUp size={touch ? 16 : 11} />
                  ) : (
                    <ChevronDown size={touch ? 16 : 11} />
                  )}
                </span>
              </button>

              {isExpanded && (
                <div>
                  {models.length === 0 ? (
                    <div
                      className={`text-text-tertiary italic ${
                        touch ? 'pl-10 pr-4 py-2 text-[13px]' : 'pl-5 pr-2.5 py-1 text-[10px]'
                      }`}
                    >
                      {t('input.noModels') || 'No models available'}
                    </div>
                  ) : (
                    models.map((m) => {
                      const caps = parseCaps(m.capabilities)
                      const isSelected = p.id === provider && m.modelId === model
                      const capSize = touch ? 14 : 10
                      return (
                        <button
                          key={m.id}
                          type="button"
                          data-model-item={`${p.id}/${m.modelId}`}
                          onClick={() => pick(p.id, m.modelId)}
                          className={`w-full text-left transition-colors flex items-center hover:bg-bg-hover ${
                            touch ? 'gap-2.5 min-h-11 pl-10 pr-4' : 'gap-1.5 pl-5 pr-2.5 py-1'
                          } ${
                            isSelected
                              ? 'bg-bg-hover text-text-primary font-medium'
                              : 'text-text-secondary hover:text-text-primary'
                          }`}
                        >
                          <span
                            className={`truncate flex-1 ${touch ? 'text-[15px]' : 'text-[11px]'}`}
                          >
                            {m.modelId}
                          </span>
                          <div className="flex items-center gap-1 shrink-0 text-text-tertiary">
                            {!!caps.vision && <Eye size={capSize} />}
                            {!!caps.functionCalling && <Wrench size={capSize} />}
                            {!!caps.reasoning && <Brain size={capSize} />}
                            {!!caps.imageOutput && <ImageIcon size={capSize} />}
                            {!!caps.audioInput && <Mic size={capSize} />}
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
        <div
          className={`flex items-center border-t border-border-secondary ${
            touch ? 'gap-2 px-3 py-2' : 'gap-1 px-2 py-1.5'
          }`}
        >
          <Brain size={touch ? 16 : 11} className="text-text-tertiary flex-shrink-0" />
          <div className={`flex items-center flex-1 ${touch ? 'gap-1' : 'gap-0.5'}`}>
            {thinking!.levels.map((l) => (
              <button
                key={l.value}
                type="button"
                data-thinking-level={l.value}
                onClick={() => thinking!.onChange(l.value)}
                className={`flex-1 rounded transition-colors ${
                  touch ? 'h-9 text-[13px] rounded-lg' : 'text-[10px] px-1 py-0.5'
                } ${
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
    </>
  )

  const containerClass =
    variant === 'inline'
      ? 'relative min-w-0 inline-flex items-center group'
      : 'relative inline-flex items-center gap-1 text-left'

  return (
    <div ref={ref} className={containerClass} style={variant === 'boxed' ? { width } : undefined}>
      {trigger}

      {/* 悬浮 tooltip：inline 且已选、未展开时显示完整模型名 */}
      {variant === 'inline' && !touch && !open && hasSelection && (
        <div className="pointer-events-none absolute left-0 bottom-6 z-20 hidden rounded-md border border-border-primary bg-bg-secondary px-2 py-1 shadow-xl group-hover:block">
          <div className="text-[11px] text-text-primary whitespace-nowrap">{model}</div>
        </div>
      )}

      {open && touch && (
        <TouchSheet name="model" onClose={close} panelRef={panelRef}>
          <div data-model-panel className="flex min-h-0 flex-1 flex-col">
            {panelBody}
          </div>
        </TouchSheet>
      )}
      {open &&
        !touch &&
        panelStyle &&
        createPortal(
          <div
            ref={panelRef}
            data-model-panel
            style={panelStyle}
            className="picker-panel rounded-md border border-border-primary bg-bg-secondary shadow-lg overflow-hidden flex flex-col"
          >
            {panelBody}
          </div>,
          document.body
        )}
    </div>
  )
}
