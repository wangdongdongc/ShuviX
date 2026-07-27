import { getHostApi, InputArea } from '@shuvix/chat-ui'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, Upload } from 'lucide-react'
import { ConfigExportDialog } from './ConfigExportDialog'
import { ConfigImportDialog } from './ConfigImportDialog'

export interface WelcomeViewProps {
  /**
   * 是否显示配置导入/导出入口。缺省按平台推断（非 web 宿主显示）。
   * 扩展（platform 'web'）须显式传 true；WebUI 共享查看端保持缺省（隐藏）。
   */
  enableConfigShare?: boolean
}

/** 欢迎页（桌面/扩展共用）— 无活跃会话时显示：标题 + 复用对话输入框 + 配置导入/导出 */
export function WelcomeView({ enableConfigShare }: WelcomeViewProps = {}): React.JSX.Element {
  const { t } = useTranslation()
  // 配置导入/导出依赖 HostApi.config（宿主能力）；渠道端（无 host）默认隐藏
  const showConfigShare = enableConfigShare ?? getHostApi() !== null
  const [exportOpen, setExportOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)

  return (
    <div className="flex-1 flex flex-col items-center justify-center overflow-y-auto px-4">
      <div className="w-full max-w-3xl flex flex-col items-center">
        <h1 className="text-2xl font-medium text-text-primary mb-6 text-center">
          {t('chat.welcomePrompt')}
        </h1>

        <div className="w-full">
          {/* 内嵌模式：欢迎页居中排版，输入卡片随文档流而非悬浮贴底 */}
          <InputArea inline />
        </div>

        {showConfigShare && (
          <div className="flex items-center justify-center gap-1 mt-4">
            <button
              onClick={() => setImportOpen(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors"
            >
              <Upload size={12} />
              {t('configShare.entryImport')}
            </button>
            <button
              onClick={() => setExportOpen(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors"
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
