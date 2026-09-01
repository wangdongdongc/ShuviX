/**
 * 聊天会话头部的成员条（A4）：成员胶囊列 + 「管理成员」入口。
 *
 * md 已被删的成员灰显（历史消息靠署名侧车里的 displayName 永不裂,这里只是现势标注）;
 * 管理走共享 BotSessionDialog 的 manage 模式 → `session.updateBots`(新成员入场即落
 * 开场白,名单不得清空由后端复核、对话框 ≥1 先挡)。
 */
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { UserCog } from 'lucide-react'
import { BotAvatar, getChatApi, useChatStore } from '@shuvix/chat-ui'
import { BotSessionDialog } from '@shuvix/app-shell'

export function BotMembersBar({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const { t } = useTranslation()
  const members = useChatStore((s) => s.sessions.find((x) => x.id === sessionId)?.settings?.bots)
  const memberKey = members?.join(',') ?? ''
  const [registry, setRegistry] = useState<Map<
    string,
    { displayName: string; description: string }
  > | null>(null)
  const [managing, setManaging] = useState(false)

  useEffect(() => {
    if (!memberKey) return
    let alive = true
    void window.api.bot.list().then((all) => {
      if (!alive) return
      setRegistry(new Map(all.map((b) => [b.name, b])))
    })
    return () => {
      alive = false
    }
  }, [memberKey, managing])

  const chips = useMemo(
    () =>
      (members ?? []).map((name) => {
        const info = registry?.get(name)
        return { name, displayName: info?.displayName ?? name, missing: registry ? !info : false }
      }),
    [members, registry]
  )

  if (!members?.length) return null

  const botsAdapter = {
    list: () => window.api.bot.list(),
    openFolder: () => window.api.bot.openFolder()
  }

  return (
    <div className="flex items-center gap-1 min-w-0" data-bot-members>
      {chips.map((c) => (
        <span
          key={c.name}
          className={`flex items-center gap-1 rounded-full border border-border-secondary bg-bg-secondary/60 pl-0.5 pr-2 py-0.5 text-[11px] ${
            c.missing ? 'opacity-50' : ''
          }`}
          title={c.missing ? `${c.name} · ${t('bot.memberMissing')}` : c.displayName}
          data-bot-member={c.name}
          data-bot-member-missing={c.missing || undefined}
        >
          <BotAvatar name={c.name} displayName={c.displayName} size={15} />
          <span
            className={`truncate max-w-[96px] ${c.missing ? 'text-text-tertiary line-through' : 'text-text-secondary'}`}
          >
            {c.displayName}
          </span>
        </span>
      ))}
      <button
        onClick={() => setManaging(true)}
        title={t('bot.manageMembers')}
        className="p-1 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/50 transition-colors"
        data-bot-manage-members
      >
        <UserCog size={14} />
      </button>
      {managing && (
        <BotSessionDialog
          mode="manage"
          initialSelected={members}
          projectId={null}
          bots={botsAdapter}
          onSubmit={async (names) => {
            const r = await getChatApi().session.updateBots({ id: sessionId, bots: names })
            if (!r.success) return r.error ?? 'failed'
            // 本地即时生效；开场白经 assistant_message 广播随后到达
            useChatStore.getState().updateSessionSettings(sessionId, { bots: r.bots })
            return null
          }}
          onClose={() => setManaging(false)}
        />
      )}
    </div>
  )
}
