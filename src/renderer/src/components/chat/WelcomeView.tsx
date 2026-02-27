import { useTranslation } from 'react-i18next'
import { MessageSquarePlus, FolderPlus, Sparkles } from 'lucide-react'
import welcomeIcon from '../../assets/ngnl_xiubi_blank_mini.jpg'

interface WelcomeViewProps {
  onNewChat: () => void
  onCreateProject: () => void
}

/** 欢迎页 — 无活跃会话时显示 */
export function WelcomeView({ onNewChat, onCreateProject }: WelcomeViewProps): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="text-center max-w-md px-6">
        <div className="w-16 h-16 rounded-2xl overflow-hidden mx-auto mb-6">
          <img src={welcomeIcon} alt="ShuviX" className="w-full h-full object-cover" />
        </div>
        <h2 className="text-xl font-semibold text-text-primary mb-2">
          {t('chat.welcomeTitle')}
        </h2>
        <p className="text-sm text-text-secondary mb-6 leading-relaxed">
          {t('about.description')}
        </p>
        <div className="flex items-center justify-center gap-3">
          <button
            onClick={onNewChat}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-accent text-white text-sm font-medium hover:bg-accent-hover transition-colors"
          >
            <MessageSquarePlus size={16} />
            {t('chat.startNewChat')}
          </button>
          <button
            onClick={onCreateProject}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-amber-500 text-white text-sm font-medium hover:bg-amber-600 transition-colors"
          >
            <FolderPlus size={16} />
            {t('chat.createProject')}
          </button>
        </div>
      </div>
    </div>
  )
}

/** 空会话引导 — 有活跃会话但无消息时显示 */
export function EmptySessionHint(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="text-center px-6">
        <div className="w-12 h-12 rounded-xl bg-bg-tertiary flex items-center justify-center mx-auto mb-4">
          <Sparkles size={24} className="text-text-tertiary" />
        </div>
        <p className="text-sm text-text-secondary">
          {t('chat.emptyHint')}
        </p>
      </div>
    </div>
  )
}
