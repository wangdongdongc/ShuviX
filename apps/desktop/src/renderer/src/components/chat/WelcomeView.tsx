import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Sliders } from 'lucide-react'
import { BotAvatar, getHostApi, useAppEvent, useChatStore } from '@shuvix/chat-ui'
import { SessionConfigPanel } from '@shuvix/app-shell'
import { boundBotOf } from '@shuvix/chat-protocol/botSession'

// WelcomeView 与 SessionConfigPanel 均已移至 @shuvix/app-shell（桌面/扩展共用）。
// 此文件仅保留桌面专属的 EmptySessionHint 包装（注入桌面能力开关）。

/** bot 会话的空态：绑定的 bot 自我介绍（名字 + 一句话描述）。注册表一变（bot.changed）就重查 */
function BotEmptyState({ bot }: { bot: string }): React.JSX.Element {
  const { t } = useTranslation()
  // 结果连同它是替哪个 bot 查的一起存：从一条 bot 会话切到另一条时，上一个 bot 的自我介绍不能串过来
  const [result, setResult] = useState<{ bot: string; info: BotInfo | null } | null>(null)
  const [revision, setRevision] = useState(0)
  useAppEvent('bot.changed', () => setRevision((r) => r + 1))

  useEffect(() => {
    let alive = true
    void window.api.bot.list().then(({ bots }) => {
      if (alive) setResult({ bot, info: bots.find((b) => b.name === bot) ?? null })
    })
    return () => {
      alive = false
    }
  }, [bot, revision])

  // undefined = 加载中；null = md 已删（不自我介绍，只留提示行）
  const info = result?.bot === bot ? result.info : undefined
  const displayName = info?.displayName ?? bot
  return (
    <div className="mb-6" data-bot-empty>
      <p className="text-sm text-text-secondary text-center mb-4">
        {t('bot.emptyHint', { name: displayName })}
      </p>
      {info && (
        <div
          className="rounded-xl border border-border-secondary/60 bg-bg-secondary/30 px-4 py-3"
          data-bot-empty-member={bot}
        >
          <div className="flex items-center gap-2">
            <BotAvatar name={bot} displayName={displayName} size={20} />
            <span className="text-[13px] font-medium text-text-primary">{displayName}</span>
            {info.description && (
              <span className="ml-auto text-xs text-text-tertiary truncate max-w-[55%]">
                {info.description}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/** 空会话引导 — 有活跃会话但无消息时显示，居中展示会话配置面板 */
export function EmptySessionHint({ sessionId }: { sessionId: string }): React.JSX.Element {
  const { t } = useTranslation()
  const settings = useChatStore((st) => st.sessions.find((x) => x.id === sessionId)?.settings)
  const bot = boundBotOf(settings)
  // 会话配置面板全是宿主管理能力（询问/指令文件/绑定）：渠道端（无 HostApi）不展示
  const hasHost = getHostApi() !== null
  return (
    <div className="flex-1 flex items-center justify-center overflow-y-auto">
      <div className="w-full max-w-lg px-8 py-12">
        {bot ? (
          <BotEmptyState bot={bot} />
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
