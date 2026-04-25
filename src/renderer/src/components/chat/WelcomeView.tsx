import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  MessageSquarePlus,
  Terminal,
  FileText,
  Wrench,
  Database,
  Settings,
  Sliders,
  Download,
  Upload
} from 'lucide-react'
import { SessionConfigPanel } from './SessionConfigPanel'
import { ConfigExportDialog } from '../welcome/ConfigExportDialog'
import { ConfigImportDialog } from '../welcome/ConfigImportDialog'

interface WelcomeViewProps {
  onNewChat: () => void
  onCreateProject: (purpose: string) => void
}

function Kbd({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <kbd className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded text-[10px] font-medium bg-bg-tertiary text-text-tertiary border border-border-primary/80 shadow-[0_1px_0_0] shadow-border-primary/50">
      {children}
    </kbd>
  )
}

const isMac = navigator.userAgent.includes('Mac')
const modKey = isMac ? '⌘' : 'Ctrl'

/** 内置用途定义 */
const BUILTIN_PURPOSES = [
  { key: 'bash', icon: Terminal, labelKey: 'projectForm.purposeBash' },
  { key: 'office', icon: FileText, labelKey: 'projectForm.purposeOffice' },
  { key: 'sql', icon: Database, labelKey: 'projectForm.purposeSQL' },
  { key: 'dev', icon: Wrench, labelKey: 'projectForm.purposeDev' }
] as const

/** 欢迎页 — 无活跃会话时显示 */
export function WelcomeView({ onNewChat, onCreateProject }: WelcomeViewProps): React.JSX.Element {
  const { t } = useTranslation()
  const isDesktop = window.api.app.platform !== 'web'
  const [exportOpen, setExportOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)

  return (
    <div className="flex-1 flex items-center justify-center overflow-y-auto">
      <div className="w-full max-w-lg px-8 py-12">
        {/* New Chat */}
        {isDesktop && (
          <div className="flex justify-center mb-6">
            <button
              onClick={onNewChat}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-accent text-white text-sm font-medium hover:bg-accent-hover transition-colors shadow-sm"
            >
              <MessageSquarePlus size={16} />
              {t('chat.startNewChat')}
            </button>
          </div>
        )}

        {/* Divider + Purpose Cards */}
        {isDesktop && (
          <div className="mb-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="flex-1 h-px bg-border-primary/60" />
              <span className="text-xs text-text-tertiary shrink-0">
                {t('chat.welcomeCreateProject')}
              </span>
              <div className="flex-1 h-px bg-border-primary/60" />
            </div>
            <div className="grid grid-cols-4 gap-2">
              {BUILTIN_PURPOSES.map(({ key, icon: Icon, labelKey }) => (
                <button
                  key={key}
                  onClick={() => onCreateProject(key)}
                  className="group flex flex-col items-center gap-2.5 p-4 rounded-xl border border-border-primary/50 bg-bg-secondary/30 hover:border-accent/50 hover:bg-accent/5 transition-all"
                >
                  <div className="w-9 h-9 rounded-lg bg-bg-tertiary flex items-center justify-center group-hover:bg-accent/10 transition-colors">
                    <Icon
                      size={18}
                      className="text-text-secondary group-hover:text-accent transition-colors"
                    />
                  </div>
                  <span className="text-xs font-medium text-text-primary">{t(labelKey)}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Config Import / Export */}
        {isDesktop && (
          <div className="flex items-center justify-center gap-2 mb-6">
            <button
              onClick={() => setImportOpen(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border-primary/60 bg-bg-secondary/30 hover:border-accent/50 hover:bg-accent/5 text-xs text-text-secondary hover:text-text-primary transition-colors"
            >
              <Upload size={12} />
              {t('configShare.entryImport')}
            </button>
            <button
              onClick={() => setExportOpen(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border-primary/60 bg-bg-secondary/30 hover:border-accent/50 hover:bg-accent/5 text-xs text-text-secondary hover:text-text-primary transition-colors"
            >
              <Download size={12} />
              {t('configShare.entryExport')}
            </button>
          </div>
        )}

        {/* Footer hints */}
        <div className="flex items-center justify-center gap-4 text-xs text-text-tertiary">
          <button
            onClick={() => window.api.app.openSettings('providers')}
            className="inline-flex items-center gap-1.5 hover:text-text-secondary transition-colors"
          >
            <Settings size={12} />
            {t('chat.welcomeConfigureProviders')}
          </button>
          {isDesktop && (
            <>
              <span className="w-px h-3 bg-border-primary" />
              <span className="inline-flex items-center gap-1.5">
                <Kbd>{modKey}</Kbd>
                <span>+</span>
                <Kbd>N</Kbd>
                <span className="ml-1">{t('chat.welcomeShortcutNewChat')}</span>
              </span>
            </>
          )}
        </div>
      </div>
      {exportOpen && <ConfigExportDialog onClose={() => setExportOpen(false)} />}
      {importOpen && <ConfigImportDialog onClose={() => setImportOpen(false)} />}
    </div>
  )
}

/** 空会话引导 — 有活跃会话但无消息时显示，居中展示会话配置面板 */
export function EmptySessionHint({ sessionId }: { sessionId: string }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex-1 flex items-center justify-center overflow-y-auto">
      <div className="w-full max-w-lg px-8 py-12">
        <div className="text-center mb-6">
          <div className="w-12 h-12 rounded-xl bg-bg-tertiary flex items-center justify-center mx-auto mb-3">
            <Sliders size={22} className="text-text-tertiary" />
          </div>
          <p className="text-sm text-text-secondary">{t('chat.emptyHint')}</p>
        </div>
        <SessionConfigPanel sessionId={sessionId} />
      </div>
    </div>
  )
}
