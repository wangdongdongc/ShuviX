import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { BookOpen, ClipboardPaste, FileText, Terminal, X, type LucideIcon } from 'lucide-react'
import type { InlineToken } from '@shuvix/chat-protocol/types/chatMessage'
import {
  payloadPreview,
  splitTokenTitle,
  tokenKind,
  tokenSourcePath,
  tokenTitle,
  type TokenKind
} from '../../utils/tokenDisplay'
import { useDialogClose } from '../../hooks/useDialogClose'

/** 悬停预览卡浮出延迟 / 移出关闭延迟 */
const HOVER_OPEN_MS = 300
const HOVER_CLOSE_MS = 150

/**
 * 类型 → 展示元数据：类型色（CSS 变量，跨 11 套主题成立）+ lucide 图标 + 本地化源标签键。
 * 颜色只穿在图标与淡底色上（部分 viz 色对底色对比度 <3:1），文字一律穿 theme 文字色。
 */
const KIND_META: Record<
  Exclude<TokenKind, 'other'>,
  { color: string; Icon: LucideIcon; labelKey: string }
> = {
  cmd: { color: 'var(--viz-7)', Icon: Terminal, labelKey: 'input.atSourceCmd' },
  file: { color: 'var(--viz-1)', Icon: FileText, labelKey: 'input.atSourceFile' },
  knowledge: { color: 'var(--viz-4)', Icon: BookOpen, labelKey: 'input.atSourceKnowledge' },
  paste: {
    color: 'var(--theme-text-tertiary)',
    Icon: ClipboardPaste,
    labelKey: 'input.atSourcePaste'
  }
}

/** 类型色淡底（color-mix 直接吃 CSS 变量；hover 加深一档） */
function chipBg(color: string, hovered: boolean, inline: boolean): string {
  const alpha = hovered ? (inline ? 20 : 24) : inline ? 10 : 13
  return `color-mix(in srgb, ${color} ${alpha}%, transparent)`
}

/**
 * TokenChip —— 可复用的内联 Token 胶囊。按类型分色 + 图标 + 本地化源标签（cmd 紫 / at 文件 蓝 /
 * at 知识 琥珀 / paste 灰）；悬停 ~300ms 浮出预览卡（标题 + 源标签 + 来源路径 + payload 前三行），
 * 点击仍弹完整 TokenPayloadDialog。三处共用：用户气泡/子代理消息里的 token 段、输入框斜杠命令芯片、
 * 输入框 `@` 引用 / 粘贴镜像层。
 *
 * `inline` 变体供覆于 textarea 之上的镜像层使用，须「零布局影响」（硬约束）：
 * - 不加图标/内边距、不改字体 → 字符步进与下方 textarea 完全一致，胶囊字形逐字压在原字形之上，
 *   光标对齐；只动颜色（类型色文字 + 类型色淡底）。at 知识拆两个 span（`@knowledge:` 前缀弱化 +
 *   标题着色），拼接后与底层原始子串逐字一致，不插入任何额外字符。
 * - `pointer-events-auto` 让胶囊在 pointer-events-none 的镜像根之上可交互。
 */
export function TokenChip({
  token,
  inline = false,
  className = ''
}: {
  token: InlineToken
  /** 内联镜像变体（布局中性、可点击穿透镜像根） */
  inline?: boolean
  className?: string
}): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [cardPos, setCardPos] = useState<React.CSSProperties | null>(null)
  const chipRef = useRef<HTMLSpanElement>(null)
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const kind = tokenKind(token)
  const meta = kind === 'other' ? null : KIND_META[kind]
  const color = meta?.color ?? 'var(--theme-accent)'
  const label = meta ? t(meta.labelKey) : null

  const clearOpenTimer = (): void => {
    if (openTimer.current) clearTimeout(openTimer.current)
    openTimer.current = null
  }
  const clearCloseTimer = (): void => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = null
  }

  useEffect(
    () => (): void => {
      clearOpenTimer()
      clearCloseTimer()
    },
    []
  )

  const handleMouseEnter = (): void => {
    setHovered(true)
    clearCloseTimer()
    if (cardPos || openTimer.current) return
    openTimer.current = setTimeout(() => {
      openTimer.current = null
      const rect = chipRef.current?.getBoundingClientRect()
      if (!rect) return
      const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - 296))
      // 上方空间够（估高 ~220px）就朝上展开（用 bottom 锚定，无需预知卡高），否则落到下方
      if (rect.top > 220) {
        setCardPos({ left, bottom: window.innerHeight - rect.top + 6 })
      } else {
        setCardPos({ left, top: rect.bottom + 6 })
      }
    }, HOVER_OPEN_MS)
  }

  const scheduleClose = (): void => {
    clearOpenTimer()
    clearCloseTimer()
    closeTimer.current = setTimeout(() => setCardPos(null), HOVER_CLOSE_MS)
  }

  const handleMouseLeave = (): void => {
    setHovered(false)
    scheduleClose()
  }

  const openDialog = (e: React.SyntheticEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    clearOpenTimer()
    clearCloseTimer()
    setCardPos(null)
    setOpen(true)
  }

  const title = tokenTitle(token)
  // 镜像层 at 知识：前缀段（`@knowledge:`，含冒号）弱化、标题段着色；两段拼接 = displayText 逐字一致
  const knowledgeSplit = inline && kind === 'knowledge' ? splitTokenTitle(token.displayText) : null

  return (
    <>
      <span
        ref={chipRef}
        role="button"
        tabIndex={0}
        onClick={openDialog}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') openDialog(e)
        }}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        // e2e 锚点：胶囊文字即 token.displayText（气泡新增图标/源标签后 textContent 不再等于它）
        data-token-display={token.displayText}
        className={`rounded cursor-pointer transition-colors ${
          inline ? 'box-decoration-clone pointer-events-auto' : 'px-1.5'
        } ${className}`}
        style={{
          color: inline ? color : undefined,
          backgroundColor: chipBg(color, hovered, inline)
        }}
      >
        {inline ? (
          knowledgeSplit ? (
            <>
              <span style={{ color: 'var(--theme-text-secondary)' }}>{knowledgeSplit.prefix}</span>
              <span>{knowledgeSplit.title}</span>
            </>
          ) : (
            token.displayText
          )
        ) : (
          <>
            {meta && (
              <meta.Icon
                size={12}
                className="inline-block align-[-0.125em] mr-1"
                style={{ color }}
              />
            )}
            {label && <span className="text-text-secondary">{label}</span>}
            {label && <span className="text-text-tertiary mx-0.5">·</span>}
            {/* 同一字号同一字体,只靠颜色分主次 —— 芯片内两种字号/字体混排不协调 */}
            <span className="text-text-primary">{title}</span>
          </>
        )}
      </span>
      {cardPos &&
        !open &&
        createPortal(
          <TokenHoverCard
            token={token}
            kind={kind}
            label={label}
            style={cardPos}
            onMouseEnter={clearCloseTimer}
            onMouseLeave={scheduleClose}
          />,
          document.body
        )}
      {open &&
        createPortal(
          <TokenPayloadDialog
            title={token.name && token.name !== token.id ? token.name : token.displayText}
            subtitle={token.name && token.name !== token.id ? token.displayText : undefined}
            payload={token.payload}
            onClose={() => setOpen(false)}
          />,
          document.body
        )}
    </>
  )
}

/** 悬停预览卡 —— 非 modal，内容全部来自 token 自带字段（零 IPC）；portal 到 body 避免被输入框 overflow 裁掉 */
function TokenHoverCard({
  token,
  kind,
  label,
  style,
  onMouseEnter,
  onMouseLeave
}: {
  token: InlineToken
  kind: TokenKind
  label: string | null
  style: React.CSSProperties
  onMouseEnter: () => void
  onMouseLeave: () => void
}): React.JSX.Element {
  const meta = kind === 'other' ? null : KIND_META[kind]
  const title = token.name && token.name !== token.id ? token.name : tokenTitle(token)
  const sourcePath = tokenSourcePath(token)

  return (
    <div
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className="fixed z-40 w-[280px] rounded-lg border border-border-primary bg-bg-primary shadow-xl p-3"
      style={style}
    >
      <div className="flex items-center gap-1.5 min-w-0">
        {meta && <meta.Icon size={12} className="flex-shrink-0" style={{ color: meta.color }} />}
        <span className="text-xs font-semibold text-text-primary truncate">{title}</span>
        {label && (
          <span className="ml-auto flex-shrink-0 text-[10px] text-text-tertiary">{label}</span>
        )}
      </div>
      {sourcePath && (
        <div className="mt-1 truncate font-mono text-[11px] text-text-tertiary">{sourcePath}</div>
      )}
      <pre className="mt-1.5 whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-text-secondary">
        {payloadPreview(token.payload)}
      </pre>
    </div>
  )
}

/** Modal —— 直接展示 token 的 payload 原文 */
export function TokenPayloadDialog({
  title,
  subtitle,
  payload,
  onClose
}: {
  title: string
  subtitle?: string
  payload: string
  onClose: () => void
}): React.JSX.Element {
  const overlayRef = useRef<HTMLDivElement>(null)
  const { closing, handleClose } = useDialogClose(onClose)

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') handleClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [handleClose])

  const handleOverlayClick = (e: React.MouseEvent): void => {
    if (e.target === overlayRef.current) handleClose()
  }

  return (
    <div
      ref={overlayRef}
      onClick={handleOverlayClick}
      className={`fixed inset-0 z-50 flex items-center justify-center bg-black/40 dialog-overlay${closing ? ' dialog-closing' : ''}`}
    >
      <div className="bg-bg-primary border border-border-primary rounded-xl shadow-xl w-[640px] max-w-[92vw] max-h-[82vh] flex flex-col dialog-panel">
        {/* Header */}
        <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-border-secondary">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-text-primary truncate">{title}</h3>
            {subtitle && (
              <div className="text-[11px] font-mono text-text-tertiary mt-0.5 truncate">
                {subtitle}
              </div>
            )}
          </div>
          <button
            onClick={handleClose}
            className="flex-shrink-0 p-1 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors"
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </div>

        {/* Body —— 原文 */}
        <div className="flex-1 overflow-y-auto px-4 py-3 min-w-0">
          <pre className="text-xs whitespace-pre-wrap break-words leading-relaxed font-mono text-text-secondary">
            {payload}
          </pre>
        </div>
      </div>
    </div>
  )
}
