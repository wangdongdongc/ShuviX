import { useTranslation } from 'react-i18next'
import {
  Bot,
  Code,
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
  const python = resources?.python
  const sql = resources?.sql
  const acpAgents = resources?.acp

  const sessionSettings = useChatStore(
    (s) => s.sessions.find((sess) => sess.id === sessionId)?.settings
  )
  const bashAutoApprove = sessionSettings?.bashAutoApprove === true
  const sshAutoApprove = sessionSettings?.sshAutoApprove === true

  // 分享状态
  const lanShareMode = useChatStore((s) => s.sharedSessionIds.get(sessionId) ?? null)
  const telegramBinding = useChatStore((s) => s.telegramBindings.get(sessionId) ?? null)

  if (
    !docker &&
    !ssh &&
    !python &&
    !sql &&
    (!acpAgents || acpAgents.length === 0) &&
    !bashAutoApprove &&
    !sshAutoApprove &&
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

  const handleDestroyPython = async (): Promise<void> => {
    await window.api.python.destroySession(sessionId)
    useChatStore.getState().setSessionPython(sessionId, null)
  }

  const handleDestroySql = async (): Promise<void> => {
    await window.api.sql.destroySession(sessionId)
    useChatStore.getState().setSessionSql(sessionId, null)
  }

  const handleDestroyAcp = async (agentName: string): Promise<void> => {
    await window.api.acp.destroySession({ sessionId, agentName })
  }

  /** 点击关闭 Bash 免审批 */
  const handleDisableBashAutoApprove = async (): Promise<void> => {
    await window.api.session.updateBashAutoApprove({ id: sessionId, bashAutoApprove: false })
    useChatStore.getState().updateSessionSettings(sessionId, { bashAutoApprove: false })
  }

  /** 点击关闭 SSH 免审批 */
  const handleDisableSshAutoApprove = async (): Promise<void> => {
    await window.api.session.updateSshAutoApprove({ id: sessionId, sshAutoApprove: false })
    useChatStore.getState().updateSessionSettings(sessionId, { sshAutoApprove: false })
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
      {python && (
        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs bg-yellow-500/10 text-yellow-500">
          <Code size={12} />
          <span>{t('chat.pythonWasmRuntime')}</span>
          <button
            onClick={handleDestroyPython}
            className="ml-0.5 rounded hover:bg-yellow-500/20 transition-colors p-0.5"
            title={t('chat.destroyPython')}
          >
            <X size={10} />
          </button>
        </span>
      )}
      {sql && (
        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs bg-blue-500/10 text-blue-400">
          <Database size={12} />
          <span>{t('chat.sqlWasmRuntime')}</span>
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
      {bashAutoApprove && (
        <button
          onClick={handleDisableBashAutoApprove}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-amber-500/10 text-amber-500 hover:bg-amber-500/20 transition-colors"
          title={t('chat.bashAutoApproveWarning')}
        >
          <TriangleAlert size={11} />
          {t('chat.bashAutoApproveLabel')}
          <X size={10} className="ml-0.5 opacity-60" />
        </button>
      )}
      {sshAutoApprove && (
        <button
          onClick={handleDisableSshAutoApprove}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-amber-500/10 text-amber-500 hover:bg-amber-500/20 transition-colors"
          title={t('chat.sshAutoApproveWarning')}
        >
          <TriangleAlert size={11} />
          {t('chat.sshAutoApproveLabel')}
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
