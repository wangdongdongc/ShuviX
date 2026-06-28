import { getHostApi, getChannelBindingApi } from '@shuvix/chat-ui'
import { useTranslation } from 'react-i18next'
import { Globe, MessageCircle, TriangleAlert, X, icons } from 'lucide-react'
import { useChatStore } from '@shuvix/chat-ui'

interface StatusBannerProps {
  sessionId: string
}

/** 运行时资源 / 分享 / 审批状态横幅 — 紧贴 titlebar 下方 */
export function StatusBanner({ sessionId }: StatusBannerProps): React.JSX.Element | null {
  const { t } = useTranslation()
  const runtimes = useChatStore((s) => s.sessionResources[sessionId]?.runtimes)

  const sessionSettings = useChatStore(
    (s) => s.sessions.find((sess) => sess.id === sessionId)?.settings
  )
  const autoApprove = sessionSettings?.autoApprove === true

  // 分享状态
  const lanShareMode = useChatStore((s) => s.sharedSessionIds.get(sessionId) ?? null)
  const telegramBinding = useChatStore((s) => s.telegramBindings.get(sessionId) ?? null)

  const runtimeEntries = runtimes ? Object.entries(runtimes) : []

  if (runtimeEntries.length === 0 && !autoApprove && !lanShareMode && !telegramBinding) return null

  /** 点击关闭命令免审批（宿主能力；渠道端无此操作） */
  const handleDisableAutoApprove = async (): Promise<void> => {
    const host = getHostApi()
    if (!host) return
    await host.session.updateAutoApprove({ id: sessionId, autoApprove: false })
    useChatStore.getState().updateSessionSettings(sessionId, { autoApprove: false })
  }

  /** 点击关闭局域网分享 */
  const handleDisableLanShare = async (): Promise<void> => {
    const webui = getChannelBindingApi()?.webui
    if (!webui) return
    await webui.setShared({ sessionId, shared: false })
    const shared = await webui.listShared()
    useChatStore.getState().setSharedSessionIds(new Map(shared.map((s) => [s.sessionId, s.mode])))
  }

  /** 点击取消 Telegram 绑定 */
  const handleDisableTelegram = async (): Promise<void> => {
    await getChannelBindingApi()?.telegram?.unbindSession({ sessionId })
    useChatStore.getState().updateSessionSettings(sessionId, { telegramBotId: undefined })
    const bindings = new Map(useChatStore.getState().telegramBindings)
    bindings.delete(sessionId)
    useChatStore.getState().setTelegramBindings(bindings)
  }

  return (
    <div className="flex-shrink-0 flex items-center gap-2 px-4 py-1 bg-bg-secondary/60 border-b border-border-secondary/30">
      {runtimeEntries.map(([runtimeId, info]) => {
        const IconComponent = info.icon ? icons[info.icon as keyof typeof icons] : null
        return (
          <span
            key={runtimeId}
            className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs"
            style={
              info.color
                ? {
                    color: info.color,
                    backgroundColor: `color-mix(in srgb, ${info.color} 10%, transparent)`
                  }
                : {
                    color: 'var(--color-accent)',
                    backgroundColor: 'color-mix(in srgb, var(--color-accent) 10%, transparent)'
                  }
            }
          >
            {IconComponent && <IconComponent size={12} />}
            <span className="truncate max-w-[160px]">{info.label}</span>
            {info.description && <span className="opacity-60">({info.description})</span>}
            <button
              onClick={() => getHostApi()?.runtime.destroy({ sessionId, runtimeId })}
              className="ml-0.5 rounded hover:bg-current/20 transition-colors p-0.5"
            >
              <X size={10} />
            </button>
          </span>
        )
      })}
      {autoApprove && (
        <button
          onClick={handleDisableAutoApprove}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-amber-500/10 text-amber-500 hover:bg-amber-500/20 transition-colors"
          title={t('chat.autoApproveWarning')}
        >
          <TriangleAlert size={11} />
          {t('chat.autoApproveLabel')}
          <X size={10} className="ml-0.5 opacity-60" />
        </button>
      )}
      {lanShareMode && (
        <button
          onClick={handleDisableLanShare}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-accent/10 text-accent hover:bg-accent/20 transition-colors"
          title={t('sessionConfig.lanShareDesc')}
        >
          <Globe size={11} />
          {t('chat.lanShareLabel')}
          <span className="opacity-60">
            (
            {t(
              `sessionConfig.shareMode${lanShareMode.charAt(0).toUpperCase() + lanShareMode.slice(1)}`
            )}
            )
          </span>
          <X size={10} className="ml-0.5 opacity-60" />
        </button>
      )}
      {telegramBinding && (
        <button
          onClick={handleDisableTelegram}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-blue-500/10 text-blue-500 hover:bg-blue-500/20 transition-colors"
          title={t('sessionConfig.telegramShareDesc')}
        >
          <MessageCircle size={11} />
          {telegramBinding.username ? `@${telegramBinding.username}` : t('chat.telegramLabel')}
          <X size={10} className="ml-0.5 opacity-60" />
        </button>
      )}
    </div>
  )
}
