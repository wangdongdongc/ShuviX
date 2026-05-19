import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Sliders, Download, Upload } from 'lucide-react'
import { SessionConfigPanel } from './SessionConfigPanel'
import { InputArea } from './InputArea'
import { ConfigExportDialog } from '../welcome/ConfigExportDialog'
import { ConfigImportDialog } from '../welcome/ConfigImportDialog'

/** 欢迎页 — 无活跃会话时显示：标题 + 复用对话输入框 + 配置导入/导出 */
export function WelcomeView(): React.JSX.Element {
  const { t } = useTranslation()
  const isDesktop = window.api.app.platform !== 'web'
  const [exportOpen, setExportOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)

  return (
    <div className="flex-1 flex flex-col items-center justify-center overflow-y-auto px-4">
      <div className="w-full max-w-3xl flex flex-col items-center">
        <h1 className="text-2xl font-medium text-text-primary mb-6 text-center">
          {t('chat.welcomePrompt')}
        </h1>

        <div className="w-full">
          <InputArea />
        </div>

        {isDesktop && (
          <div className="flex items-center justify-center gap-2 mt-4">
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
