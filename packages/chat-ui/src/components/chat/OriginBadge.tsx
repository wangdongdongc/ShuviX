import { useContext } from 'react'
import { useTranslation } from 'react-i18next'
import type { InputOrigin } from '@shuvix/chat-protocol/types/inputOrigin'
import { ChatHostContext } from '../../host/chatHostContext'

/**
 * 用户气泡下方的来源标签（`metadata.origin`，宿主按连接盖的章）：本机窗口打的不标；远程连接标对端地址（悬停看连接
 * 与浏览器标识）；Chrome / Telegram 标渠道；别的会话发来的标「其他会话 / 父会话发来」，宿主能切会话时点它打开那条会话。
 */
export function OriginBadge({ origin }: { origin: InputOrigin }): React.JSX.Element | null {
  const { t } = useTranslation()
  const openSession = useContext(ChatHostContext)?.openSession
  const base = 'mr-1 text-[10px]'

  switch (origin.kind) {
    case 'local':
      return null
    case 'remote': {
      const hint = t('message.originRemoteHint', {
        address: origin.address,
        clientId: origin.clientId
      })
      return (
        <span
          className={base}
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
        <span className={base} data-origin="chrome" title={t('message.originChromeHint')}>
          {t('message.originChrome')}
        </span>
      )
    case 'telegram':
      return (
        <span
          className={base}
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
      const chip = 'mr-1 px-1.5 py-px rounded text-[10px] font-medium bg-accent/15 text-accent'
      if (!openSession) {
        return (
          <span className={chip} data-origin={origin.kind} title={hint}>
            {label}
          </span>
        )
      }
      return (
        <button
          type="button"
          className={`${chip} hover:bg-accent/25 transition-colors`}
          data-origin={origin.kind}
          title={`${hint}\n${t('message.originOpenHint')}`}
          onClick={() => openSession(origin.sessionId)}
        >
          {label}
        </button>
      )
    }
  }
}
