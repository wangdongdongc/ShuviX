import { useContext } from 'react'
import { useTranslation } from 'react-i18next'
import type { InputOrigin } from '@shuvix/chat-protocol/types/inputOrigin'
import { ChatHostContext } from '../../host/chatHostContext'

/** 一种来源的配色：气泡与标签的浅底（tint）、标签的同色深字（ink） */
export interface OriginTone {
  readonly tint: string
  readonly ink: string
}

/**
 * 来源 → 配色，取分类色槽位的 tint / ink 对（app-shell `themes.css` 的 `--viz-N-tint` / `--viz-N-ink`：半透明浅底叠在
 * 哪套主题上都就地合成，深字对浅底逐套主题验过对比度）。本机窗口打的（与没有记录的）不换色 —— 照旧是强调色的气泡。
 * 槽位避开蓝（多数主题的强调色，和本机的气泡分不开）、绿与红（读成成功 / 错误）。
 */
const TONES: Record<Exclude<InputOrigin['kind'], 'local'>, OriginTone> = {
  remote: { tint: 'var(--viz-3-tint)', ink: 'var(--viz-3-ink)' },
  chrome: { tint: 'var(--viz-4-tint)', ink: 'var(--viz-4-ink)' },
  telegram: { tint: 'var(--viz-2-tint)', ink: 'var(--viz-2-ink)' },
  'parent-session': { tint: 'var(--viz-7-tint)', ink: 'var(--viz-7-ink)' },
  session: { tint: 'var(--viz-5-tint)', ink: 'var(--viz-5-ink)' }
}

/** 这条输入的配色；本机 / 没有记录 / 认不出的种类 → undefined（气泡用缺省的强调色） */
export function originTone(origin: InputOrigin | undefined): OriginTone | undefined {
  if (origin === undefined || origin.kind === 'local') return undefined
  return Object.hasOwn(TONES, origin.kind) ? TONES[origin.kind] : undefined
}

/**
 * 用户气泡下方的来源标签（`metadata.origin`，宿主按连接盖的章），与气泡同一种配色：本机窗口打的不标；远程连接标对端
 * 地址（悬停看连接与浏览器标识）；Chrome / Telegram 标渠道；别的会话发来的标「来自其他会话 / 来自父会话」，宿主能切会话时
 * 点它打开那条会话。
 */
export function OriginBadge({ origin }: { origin: InputOrigin }): React.JSX.Element | null {
  const { t } = useTranslation()
  const openSession = useContext(ChatHostContext)?.openSession
  const tone = originTone(origin)
  if (tone === undefined) return null
  const chip = 'mr-1 px-1.5 py-px rounded text-[10px] font-medium'
  const style = { backgroundColor: tone.tint, color: tone.ink }

  switch (origin.kind) {
    case 'remote': {
      const hint = t('message.originRemoteHint', {
        address: origin.address,
        clientId: origin.clientId
      })
      return (
        <span
          className={chip}
          style={style}
          data-origin="remote"
          title={origin.userAgent ? `${hint}\n${origin.userAgent}` : hint}
        >
          {origin.address
            ? t('message.originRemote', { address: origin.address })
            : t('message.originRemoteNoAddress')}
        </span>
      )
    }
    case 'chrome':
      return (
        <span
          className={chip}
          style={style}
          data-origin="chrome"
          title={t('message.originChromeHint')}
        >
          {t('message.originChrome')}
        </span>
      )
    case 'telegram':
      return (
        <span
          className={chip}
          style={style}
          data-origin="telegram"
          title={t('message.originTelegramHint', { userId: origin.userId })}
        >
          {t('message.originTelegram')}
        </span>
      )
    case 'session':
    case 'parent-session': {
      const parent = origin.kind === 'parent-session'
      const hint = origin.title
        ? t(parent ? 'message.originParentHint' : 'message.originSessionHint', {
            title: origin.title
          })
        : parent
          ? t('message.originParentHintNoTitle')
          : t('message.originSessionHintNoTitle', { sessionId: origin.sessionId })
      const label = t(parent ? 'message.originParent' : 'message.originSession')
      if (!openSession) {
        return (
          <span className={chip} style={style} data-origin={origin.kind} title={hint}>
            {label}
          </span>
        )
      }
      return (
        <button
          type="button"
          className={`${chip} hover:brightness-110 transition-[filter]`}
          style={style}
          data-origin={origin.kind}
          title={`${hint}\n${t('message.originOpenHint')}`}
          onClick={() => openSession(origin.sessionId)}
        >
          {label}
        </button>
      )
    }
    default:
      return null
  }
}
