import { useTranslation } from 'react-i18next'
import { Container, Terminal, X } from 'lucide-react'
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

  if (!docker && !ssh) return null

  const handleDestroyDocker = async (): Promise<void> => {
    await window.api.docker.destroySession(sessionId)
  }

  const handleDisconnectSsh = async (): Promise<void> => {
    await window.api.ssh.disconnectSession(sessionId)
  }

  return (
    <div className="flex-shrink-0 flex items-center gap-2 px-4 py-1 bg-bg-secondary/60 border-b border-border-secondary/30">
      {docker && (
        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs bg-emerald-500/10 text-emerald-500">
          <Container size={12} />
          <span className="truncate max-w-[180px]" title={`${docker.image} (${docker.containerId})`}>
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
          <span className="truncate max-w-[160px]" title={`${ssh.username}@${ssh.host}:${ssh.port}`}>
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
    </div>
  )
}
