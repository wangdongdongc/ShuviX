/**
 * 聊天会话头部的 bot 绑定：一枚静态胶囊（头像 + 显示名），说的是「你在和谁说话」。
 *
 * md 已被删的 bot 灰显加删除线（历史消息靠行上的 displayName 永不裂，这里只是现势标注）。
 * 会话还没绑定 bot 时（群聊时代遗留的会话，没有做迁移）胶囊换成一个「选择 bot」按钮，
 * 走共享 BotSessionDialog 的 bind 模式 → `session.setBot`。绑定之后胶囊是静态的：
 * 一对一会话不换人，历史里躺着的是这个 bot 的话。
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BotAvatar, getChatApi, useChatStore } from '@shuvix/chat-ui'
import { BotSessionDialog } from '@shuvix/app-shell'
import { boundBotOf, isChatSessionSettings } from '@shuvix/chat-protocol/chatSession'

export function BotBindingChip({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const { t } = useTranslation()
  const settings = useChatStore((s) => s.sessions.find((x) => x.id === sessionId)?.settings)
  const isChat = isChatSessionSettings(settings)
  const bot = boundBotOf(settings)
  const [info, setInfo] = useState<{ displayName: string; missing: boolean } | null>(null)
  const [binding, setBinding] = useState(false)

  useEffect(() => {
    if (!bot) return
    let alive = true
    void window.api.bot.list().then((all) => {
      if (!alive) return
      const hit = all.find((b) => b.name === bot)
      setInfo({ displayName: hit?.displayName ?? bot, missing: !hit })
    })
    return () => {
      alive = false
    }
  }, [bot])

  if (!isChat) return null

  if (!bot) {
    return (
      <div className="flex items-center min-w-0" data-bot-binding="unbound">
        <button
          onClick={() => setBinding(true)}
          className="flex items-center gap-1 rounded-full border border-warning/50 bg-warning/10 px-2 py-0.5 text-[11px] text-warning hover:bg-warning/20 transition-colors"
          title={t('bot.bindSubtitle')}
          data-bot-bind
        >
          {t('bot.bindAction')}
        </button>
        {binding && (
          <BotSessionDialog
            mode="bind"
            projectId={null}
            bots={{
              list: () => window.api.bot.list(),
              openFolder: () => window.api.bot.openFolder()
            }}
            onPick={async (name) => {
              const r = await getChatApi().session.setBot({ id: sessionId, bot: name })
              if (!r.success) return r.error ?? 'failed'
              // 本地即时生效；配置变更广播随后到达
              useChatStore.getState().updateSessionSettings(sessionId, { bot: name })
              return null
            }}
            onClose={() => setBinding(false)}
          />
        )}
      </div>
    )
  }

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
