import { getHostApi, useChatStore } from '@shuvix/chat-ui'
import { X, icons } from 'lucide-react'

export interface StatusBannerProps {
  sessionId: string
}

/**
 * 运行时资源横幅（桌面/扩展共用）—— 紧贴顶栏下方，作为 ChatBody 的 banner 插槽。
 *
 * 只剩一件事：列出本会话持有的运行时连接（桌面为 SSH / 数据库，见 DefaultChatGateway
 * .getRuntimeStatuses），每项可点 X 断开。宿主没有生产者或本会话没有连接时整条横幅
 * 返回 null —— 于是绝大多数会话根本不会看到这条 bar。
 *
 * 曾经并列在这里的两项都已搬走：
 *   - 「免询问」提示胶囊删掉了（开关仍在会话设置里，见 SessionConfigPanel）；
 *   - 会话工具栏（SessionToolbar）进了顶栏右侧按钮簇 —— 它当初从正文右上角的浮层挪来
 *     这条 bar，是为了不压住右对齐的用户气泡；顶栏同样不压正文，还不必为它留一整行。
 * 也因此不再需要定高（min-h）：横幅里只剩等高的胶囊，不会随开合忽高忽低。
 */
export function StatusBanner({ sessionId }: StatusBannerProps): React.JSX.Element | null {
  const runtimes = useChatStore((s) => s.sessionResources[sessionId]?.runtimes)

  const runtimeEntries = runtimes ? Object.entries(runtimes) : []
  if (runtimeEntries.length === 0) return null

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
    </div>
  )
}
