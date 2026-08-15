import { getHostApi } from '@shuvix/chat-ui'
import { useTranslation } from 'react-i18next'
import { TriangleAlert, X, icons } from 'lucide-react'
import { useChatStore } from '@shuvix/chat-ui'

export interface StatusBannerProps {
  sessionId: string
}

/**
 * 运行时资源 / 审批状态横幅（桌面/扩展共用）—— 紧贴顶栏下方，作为 ChatBody 的 banner 插槽。
 *
 * 各分项按宿主能力自动显隐，无需宿主传 caps：
 *   - 运行时资源：宿主未填充 chatStore.sessionResources 即不渲染（扩展当前无）；
 *   - 免审批：autoApprove 开时显示，点击经 getHostApi() 关闭（无 HostApi 时不可关）。
 * 两类全空时整条横幅返回 null。
 */
export function StatusBanner({ sessionId }: StatusBannerProps): React.JSX.Element | null {
  const { t } = useTranslation()
  const runtimes = useChatStore((s) => s.sessionResources[sessionId]?.runtimes)

  const sessionSettings = useChatStore(
    (s) => s.sessions.find((sess) => sess.id === sessionId)?.settings
  )
  const autoApprove = sessionSettings?.autoApprove === true

  const runtimeEntries = runtimes ? Object.entries(runtimes) : []

  if (runtimeEntries.length === 0 && !autoApprove) return null

  /** 点击关闭免审批（宿主能力；渠道端无此操作） */
  const handleDisableAutoApprove = async (): Promise<void> => {
    const host = getHostApi()
    if (!host) return
    await host.session.updateAutoApprove({ id: sessionId, autoApprove: false })
    useChatStore.getState().updateSessionSettings(sessionId, { autoApprove: false })
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
    </div>
  )
}
