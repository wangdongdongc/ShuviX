import type { ReactNode } from 'react'
import { getHostApi } from '@shuvix/chat-ui'
import { useTranslation } from 'react-i18next'
import { TriangleAlert, X, icons } from 'lucide-react'
import { useChatStore } from '@shuvix/chat-ui'

export interface StatusBannerProps {
  sessionId: string
  /** 靠右的常驻内容（宿主注入会话工具栏）。非空时即使左侧无状态项，这条 bar 也照常渲染 */
  trailing?: ReactNode
}

/**
 * 运行时资源 / 询问状态横幅（桌面/扩展共用）—— 紧贴顶栏下方，作为 ChatBody 的 banner 插槽。
 *
 * 各分项按宿主能力自动显隐，无需宿主传 caps：
 *   - 运行时资源：宿主未填充 chatStore.sessionResources 即不渲染（扩展当前无）；
 *   - 免询问：autoAllow 开时显示，点击经 getHostApi() 关闭（无 HostApi 时不可关）。
 * 两类全空**且宿主没给 trailing** 时整条横幅返回 null。
 *
 * trailing 是会话工具栏的落点：它原先绝对定位悬浮在正文右上角，右对齐的用户消息气泡
 * 滚到顶部就会被它压住 —— 归到这条本就存在的 bar 里占实位，重叠从根上没有了。
 * 定高（min-h）是为此付的代价：工具栏在会话面板展开时会自隐，若由内容撑高，
 * 开合面板就会让整条 bar 忽高忽低、把正文顶来顶去。
 */
export function StatusBanner({ sessionId, trailing }: StatusBannerProps): React.JSX.Element | null {
  const { t } = useTranslation()
  const runtimes = useChatStore((s) => s.sessionResources[sessionId]?.runtimes)

  const sessionSettings = useChatStore(
    (s) => s.sessions.find((sess) => sess.id === sessionId)?.settings
  )
  const autoAllow = sessionSettings?.autoAllow === true

  const runtimeEntries = runtimes ? Object.entries(runtimes) : []

  if (runtimeEntries.length === 0 && !autoAllow && !trailing) return null

  /** 点击关闭免询问（宿主能力；渠道端无此操作） */
  const handleDisableAutoAllow = async (): Promise<void> => {
    const host = getHostApi()
    if (!host) return
    await host.session.updateAutoAllow({ id: sessionId, autoAllow: false })
    useChatStore.getState().updateSessionSettings(sessionId, { autoAllow: false })
  }

  return (
    <div className="flex-shrink-0 flex items-center gap-2 min-h-[1.875rem] px-4 py-1 bg-bg-secondary/60 border-b border-border-secondary/30">
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
      {autoAllow && (
        <button
          onClick={handleDisableAutoAllow}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-amber-500/10 text-amber-500 hover:bg-amber-500/20 transition-colors"
          title={t('chat.autoAllowWarning')}
        >
          <TriangleAlert size={11} />
          {t('chat.autoAllowLabel')}
          <X size={10} className="ml-0.5 opacity-60" />
        </button>
      )}
      {trailing && <div className="ml-auto flex items-center">{trailing}</div>}
    </div>
  )
}
