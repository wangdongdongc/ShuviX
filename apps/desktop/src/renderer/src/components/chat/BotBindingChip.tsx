/**
 * bot 会话头部的身份胶囊（头像 + 显示名），说的是「你在和谁说话」。
 *
 * 绑定在创建那一刻定死、不可换绑，所以胶囊是静态的。md 已被删的 bot 灰显加删除线 —— 会话
 * 照常可用（根 Agent 跑在基座 `bot` 上，只是没有人设可注入），这里只是现势标注。
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BotAvatar, useChatStore } from '@shuvix/chat-ui'
import { boundBotOf } from '@shuvix/chat-protocol/botSession'

export function BotBindingChip({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const { t } = useTranslation()
  const settings = useChatStore((s) => s.sessions.find((x) => x.id === sessionId)?.settings)
  const bot = boundBotOf(settings)
  const [info, setInfo] = useState<{ displayName: string; missing: boolean } | null>(null)

  useEffect(() => {
    if (!bot) return
    let alive = true
    void window.api.bot.list().then(({ bots }) => {
      if (!alive) return
      const hit = bots.find((b) => b.name === bot)
      setInfo({ displayName: hit?.displayName ?? bot, missing: !hit })
    })
    return () => {
      alive = false
    }
  }, [bot])

  if (!bot) return null

  const displayName = info?.displayName ?? bot
  const missing = info?.missing ?? false
  return (
    <div className="flex items-center min-w-0" data-bot-binding={bot}>
      <span
        className={`flex items-center gap-1 rounded-full border border-border-secondary bg-bg-secondary/60 pl-0.5 pr-2 py-0.5 text-[11px] ${
          missing ? 'opacity-50' : ''
        }`}
        title={missing ? `${bot} · ${t('bot.botMissing')}` : displayName}
        data-bot-bound={bot}
        data-bot-bound-missing={missing || undefined}
      >
        <BotAvatar name={bot} displayName={displayName} size={15} />
        <span
          className={`truncate max-w-[120px] ${missing ? 'text-text-tertiary line-through' : 'text-text-secondary'}`}
        >
          {displayName}
        </span>
      </span>
    </div>
  )
}
