import { useTranslation } from 'react-i18next'
import { Sliders } from 'lucide-react'
import { SessionConfigPanel } from './SessionConfigPanel'

// WelcomeView 已移至 @shuvix/app-shell（桌面/扩展共用）。此文件仅保留桌面专属的 EmptySessionHint
// （依赖 SessionConfigPanel，宿主专属，不进共享包）。

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
