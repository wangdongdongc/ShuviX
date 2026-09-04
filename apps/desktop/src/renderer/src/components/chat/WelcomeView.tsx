import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Sliders } from 'lucide-react'
import { BotAvatar, getHostApi, useChatStore } from '@shuvix/chat-ui'
import { SessionConfigPanel } from '@shuvix/app-shell'

// WelcomeView 与 SessionConfigPanel 均已移至 @shuvix/app-shell（桌面/扩展共用）。
// 此文件仅保留桌面专属的 EmptySessionHint 包装（注入桌面能力开关）。

/** 聊天会话（bots）的空态：成员介绍（名字 + 一句话描述） */
function BotEmptyState({ members }: { members: string[] }): React.JSX.Element {
  const { t } = useTranslation()
  const [registry, setRegistry] = useState<Map<string, BotInfo> | null>(null)

  useEffect(() => {
    let alive = true
    void window.api.bot.list().then((all) => {
      if (alive) setRegistry(new Map(all.map((b) => [b.name, b])))
    })
    return () => {
      alive = false
    }
  }, [])

  return (
    <div className="mb-6" data-bot-empty>
      <p className="text-sm text-text-secondary text-center mb-4">{t('bot.emptyHint')}</p>
      <div className="space-y-3">
        {members.map((name) => {
          const info = registry?.get(name)
          if (registry && !info) return null // md 已删的成员不在空态里介绍自己
          return (
            <div
              key={name}
              className="rounded-xl border border-border-secondary/60 bg-bg-secondary/30 px-4 py-3"
              data-bot-empty-member={name}
            >
              <div className="flex items-center gap-2">
                <BotAvatar name={name} displayName={info?.displayName ?? name} size={20} />
                <span className="text-[13px] font-medium text-text-primary">
                  {info?.displayName ?? name}
                </span>
                {info?.description && (
                  <span className="ml-auto text-xs text-text-tertiary truncate max-w-[55%]">
                    {info.description}
                  </span>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** 空会话引导 — 有活跃会话但无消息时显示，居中展示会话配置面板 */
export function EmptySessionHint({ sessionId }: { sessionId: string }): React.JSX.Element {
  const { t } = useTranslation()
  const members = useChatStore((st) => st.sessions.find((x) => x.id === sessionId)?.settings?.bots)
  // 会话配置面板全是宿主管理能力（询问/指令文件/绑定）：渠道端（无 HostApi）不展示
  const hasHost = getHostApi() !== null
  return (
    <div className="flex-1 flex items-center justify-center overflow-y-auto">
      <div className="w-full max-w-lg px-8 py-12">
        {members?.length ? (
          <BotEmptyState members={members} />
        ) : (
          <div className="text-center mb-6">
            <div className="w-12 h-12 rounded-xl bg-bg-tertiary flex items-center justify-center mx-auto mb-3">
              <Sliders size={22} className="text-text-tertiary" />
            </div>
            <p className="text-sm text-text-secondary">{t('chat.emptyHint')}</p>
          </div>
        )}
        {hasHost && <SessionConfigPanel sessionId={sessionId} />}
      </div>
    </div>
  )
}
