/**
 * bot 会话头部的身份胶囊（头像 + 显示名），说的是「你在和谁说话」。
 *
 * 绑定在创建那一刻定死、不可换绑，所以胶囊是静态的。md 已被删的 bot 灰显加删除线 —— 会话
 * 照常可用（根 Agent 跑在基座 `bot` 上，只是没有人设可注入），这里只是现势标注。
 * 注册表一变（`bot.changed`：删除 / 改名 / 修好文件）就重查，开着的会话也跟得上。
 *
 * 旁边一枚工作位置胶囊（2026-10-31）：bot 会话只归属 bot，同一个 bot 的会话散在不同项目里 —— 头部说清楚「这一条
 * 在哪干活」：引用的项目名、「项目已删除」或「临时」。建会话时定下、之后不变，点它在访达里打开那个文件夹。
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FolderOpen } from 'lucide-react'
import { BotAvatar, getChatApi, getHostApi, useAppEvent, useChatStore } from '@shuvix/chat-ui'
import { boundBotOf, workProjectOf } from '@shuvix/chat-protocol/botSession'
import { useProjects } from '@shuvix/app-shell'

interface ChipInfo {
  /** 这份结果是替哪个 bot 查的 —— 从一条 bot 会话切到另一条时，上一个 bot 的结果不能拿来显示 */
  bot: string
  displayName: string
  missing: boolean
}

export function BotBindingChip({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const { t } = useTranslation()
  const settings = useChatStore((s) => s.sessions.find((x) => x.id === sessionId)?.settings)
  const bot = boundBotOf(settings)
  const workProject = workProjectOf(settings)
  const { projects, archivedProjects } = useProjects()
  const [info, setInfo] = useState<ChipInfo | null>(null)
  // 引用的项目已删除时会话在哪个文件夹里干活（路径快照）—— 胶囊上标它的名字
  const [fallbackDir, setFallbackDir] = useState<{ sessionId: string; dir: string } | null>(null)
  // 注册表版本：bot.changed 一来就 +1，让下面的查询重跑
  const [revision, setRevision] = useState(0)
  useAppEvent('bot.changed', () => setRevision((r) => r + 1))

  useEffect(() => {
    if (!bot) return
    let alive = true
    void window.api.bot.list().then(({ bots }) => {
      if (!alive) return
      const hit = bots.find((b) => b.name === bot)
      setInfo({ bot, displayName: hit?.displayName ?? bot, missing: !hit })
    })
    return () => {
      alive = false
    }
  }, [bot, revision])

  // 归档了的项目还在（只是不在侧栏里）：照样标它的名字
  const project = workProject
    ? [...projects, ...archivedProjects].find((p) => p.id === workProject)
    : undefined
  const projectGone = !!bot && !!workProject && !project
  // hook 要在下面那个「不是 bot 会话就不画」之前：同一个挂着的胶囊会在普通会话与 bot 会话之间切换
  useEffect(() => {
    if (!projectGone) return
    let alive = true
    void getChatApi()
      .session.getById(sessionId)
      .then((s) => {
        if (alive && s?.workingDirectory) setFallbackDir({ sessionId, dir: s.workingDirectory })
      })
    return () => {
      alive = false
    }
  }, [projectGone, sessionId])

  if (!bot) return null

  // 查询还没回来（或手上是上一个 bot 的结果）：先用身份键顶着，不标缺失
  const current = info?.bot === bot ? info : null
  const displayName = current?.displayName ?? bot
  const missing = current?.missing ?? false
  const goneDir = fallbackDir?.sessionId === sessionId ? fallbackDir.dir : undefined
  const location = workProject
    ? project
      ? project.name || t('sidebar.unnamedProject')
      : goneDir
        ? `${t('sidebar.botProjectGone')} · ${goneDir.split(/[\\/]/).filter(Boolean).pop() ?? goneDir}`
        : t('sidebar.botProjectGone')
    : t('sidebar.botTempLocation')
  const openLocation = async (): Promise<void> => {
    const dir = (await getChatApi().session.getById(sessionId))?.workingDirectory
    if (dir) await getHostApi()?.app.openFolder(dir)
  }
  return (
    <div className="flex items-center gap-1.5 min-w-0" data-bot-binding={bot}>
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
      <button
        type="button"
        onClick={() => void openLocation()}
        className={`flex items-center gap-1 rounded-full border border-border-secondary bg-bg-secondary/60 px-2 py-0.5 text-[11px] text-text-secondary hover:bg-bg-hover ${
          projectGone ? 'opacity-60' : ''
        }`}
        title={goneDir ? `${location}\n${goneDir}` : location}
        data-bot-location={workProject ? (project ? 'project' : 'gone') : 'temp'}
      >
        <FolderOpen size={11} className="shrink-0 text-text-tertiary" />
        <span className="truncate max-w-[140px]">{location}</span>
      </button>
    </div>
  )
}
