import { useTranslation } from 'react-i18next'
import {
  Bot,
  Container,
  Database,
  Globe,
  MessageCircle,
  Terminal,
  TriangleAlert,
  X
} from 'lucide-react'
import { useChatStore } from '../../stores/chatStore'

interface StatusBannerProps {
  sessionId: string
}

/** Docker/SSH/ACP/分享 实时状态横幅 — 紧贴 titlebar 下方 */
export function StatusBanner({ sessionId }: StatusBannerProps): React.JSX.Element | null {
  const { t } = useTranslation()
  const resources = useChatStore((s) => s.sessionResources[sessionId])
  const docker = resources?.docker
  const ssh = resources?.ssh
  const sql = resources?.sql
  const acpAgents = resources?.acp
  const pluginRuntimes = resources?.pluginRuntimes

  const sessionSettings = useChatStore(
    (s) => s.sessions.find((sess) => sess.id === sessionId)?.settings
  )
  const autoApprove = sessionSettings?.autoApprove === true

  // 分享状态
  const lanShareMode = useChatStore((s) => s.sharedSessionIds.get(sessionId) ?? null)
  const telegramBinding = useChatStore((s) => s.telegramBindings.get(sessionId) ?? null)

  if (
    !docker &&
    !ssh &&
    !sql &&
    (!acpAgents || acpAgents.length === 0) &&
    !pluginRuntimes &&
    !autoApprove &&
    !lanShareMode &&
    !telegramBinding
  )
    return null

  const handleDestroyDocker = async (): Promise<void> => {
    await window.api.docker.destroySession(sessionId)
  }

  const handleDisconnectSsh = async (): Promise<void> => {
    await window.api.ssh.disconnectSession(sessionId)
  }

  const handleDestroySql = async (): Promise<void> => {
    await window.api.sql.destroySession(sessionId)
    useChatStore.getState().setSessionSql(sessionId, null)
  }

  const handleDestroyAcp = async (agentName: string): Promise<void> => {
    await window.api.acp.destroySession({ sessionId, agentName })
  }

  /** 点击关闭命令免审批 */
  const handleDisableAutoApprove = async (): Promise<void> => {
    await window.api.session.updateAutoApprove({ id: sessionId, autoApprove: false })
    useChatStore.getState().updateSessionSettings(sessionId, { autoApprove: false })
  }

  /** 点击关闭局域网分享 */
  const handleDisableLanShare = async (): Promise<void> => {
    await window.api.webui.setShared({ sessionId, shared: false })
    const shared = await window.api.webui.listShared()
    useChatStore.getState().setSharedSessionIds(new Map(shared.map((s) => [s.sessionId, s.mode])))
  }

  /** 点击取消 Telegram 绑定 */
  const handleDisableTelegram = async (): Promise<void> => {
    await window.api.telegram.unbindSession({ sessionId })
    useChatStore.getState().updateSessionSettings(sessionId, { telegramBotId: undefined })
    const bindings = new Map(useChatStore.getState().telegramBindings)
    bindings.delete(sessionId)
    useChatStore.getState().setTelegramBindings(bindings)
  }

  return (
    <div className="flex-shrink-0 flex items-center gap-2 px-4 py-1 bg-bg-secondary/60 border-b border-border-secondary/30">
      {docker && (
        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs bg-emerald-500/10 text-emerald-500">
          <Container size={12} />
          <span
            className="truncate max-w-[180px]"
            title={`${docker.image} (${docker.containerId})`}
          >
            {docker.image}
            <span className="ml-1 opacity-60">{docker.containerId.slice(0, 12)}</span>
          </span>
          <button
            onClick={handleDestroyDocker}
            className="ml-0.5 rounded hover:bg-emerald-500/20 transition-colors p-0.5"
            title={t('chat.destroyContainer')}
          >
            <X size={10} />
          </button>
        </span>
      )}
      {ssh && (
        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs bg-sky-500/10 text-sky-500">
          <Terminal size={12} />
          <span
            className="truncate max-w-[160px]"
            title={`${ssh.username}@${ssh.host}:${ssh.port}`}
          >
            {ssh.username}@{ssh.host}
          </span>
          <button
            onClick={handleDisconnectSsh}
            className="ml-0.5 rounded hover:bg-sky-500/20 transition-colors p-0.5"
            title={t('chat.disconnectSsh')}
          >
            <X size={10} />
          </button>
        </span>
      )}
      {sql && (
        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs bg-blue-500/10 text-blue-400">
          <Database size={12} />
          <span>
            {t('chat.sqlWasmRuntime')}
            <span className="ml-1 opacity-60">
              (
              {sql.storageMode === 'persistent'
                ? t('chat.sqlPersistent')
                : t('chat.sqlTemporary')}
              )
            </span>
          </span>
          <button
            onClick={handleDestroySql}
            className="ml-0.5 rounded hover:bg-blue-500/20 transition-colors p-0.5"
            title={t('chat.destroySql')}
          >
            <X size={10} />
          </button>
        </span>
      )}
      {acpAgents?.map((agent) => (
        <span
          key={agent.agentName}
          className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs bg-violet-500/10 text-violet-500"
        >
          <Bot size={12} />
          <span className="truncate max-w-[160px]">{agent.displayName}</span>
          <button
            onClick={() => handleDestroyAcp(agent.agentName)}
            className="ml-0.5 rounded hover:bg-violet-500/20 transition-colors p-0.5"
            title={t('chat.destroyAcp')}
          >
            <X size={10} />
          </button>
        </span>
      ))}
      {pluginRuntimes &&
        Object.entries(pluginRuntimes).map(([runtimeId, info]) => (
          <span
            key={runtimeId}
            className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs"
            style={info.color
              ? { color: info.color, backgroundColor: `color-mix(in srgb, ${info.color} 10%, transparent)` }
              : { color: 'var(--color-accent)', backgroundColor: 'color-mix(in srgb, var(--color-accent) 10%, transparent)' }}
          >
            <span>{info.label}</span>
            {info.description && <span className="opacity-60">({info.description})</span>}
            <button
              onClick={() => {
                window.api.plugin.destroyRuntime({ sessionId, runtimeId })
              }}
              className="ml-0.5 rounded hover:bg-current/20 transition-colors p-0.5"
            >
              <X size={10} />
            </button>
          </span>
        ))}
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
