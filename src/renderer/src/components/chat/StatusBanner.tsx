import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Container, Terminal, TriangleAlert, X } from 'lucide-react'
import { useChatStore } from '../../stores/chatStore'

interface StatusBannerProps {
  sessionId: string
}

/** Docker/SSH 实时状态横幅 — 紧贴 titlebar 下方 */
export function StatusBanner({ sessionId }: StatusBannerProps): React.JSX.Element | null {
  const { t } = useTranslation()
  const resources = useChatStore((s) => s.sessionResources[sessionId])
  const docker = resources?.docker
  const ssh = resources?.ssh

  // 读取 session settings 中的 sshAutoApprove
  const sessionSettings = useChatStore(
    (s) => s.sessions.find((sess) => sess.id === sessionId)?.settings
  )
  const sshAutoApprove = useMemo(() => {
    try {
      return JSON.parse(sessionSettings || '{}').sshAutoApprove === true
    } catch {
      return false
    }
  }, [sessionSettings])

  if (!docker && !ssh && !sshAutoApprove) return null

  const handleDestroyDocker = async (): Promise<void> => {
    await window.api.docker.destroySession(sessionId)
  }

  const handleDisconnectSsh = async (): Promise<void> => {
    await window.api.ssh.disconnectSession(sessionId)
  }

  /** 点击关闭 SSH 免审批 */
  const handleDisableSshAutoApprove = async (): Promise<void> => {
    const current = JSON.parse(sessionSettings || '{}')
    const updated = { ...current, sshAutoApprove: false }
    const json = JSON.stringify(updated)
    await window.api.session.updateSettings({ id: sessionId, settings: json })
    useChatStore.getState().updateSessionSettings(sessionId, json)
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
    </div>
  )
}
