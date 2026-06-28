import { useTranslation } from 'react-i18next'
import { Sliders } from 'lucide-react'
import { getHostApi } from '@shuvix/chat-ui'
import { SessionConfigPanel } from '@shuvix/app-shell'

// WelcomeView 与 SessionConfigPanel 均已移至 @shuvix/app-shell（桌面/扩展共用）。
// 此文件仅保留桌面专属的 EmptySessionHint 包装（注入桌面能力开关）。

/** 空会话引导 — 有活跃会话但无消息时显示，居中展示会话配置面板 */
export function EmptySessionHint({ sessionId }: { sessionId: string }): React.JSX.Element {
  const { t } = useTranslation()
  // 会话配置面板全是宿主管理能力（审批/指令文件/绑定）：渠道端（无 HostApi）不展示
  const hasHost = getHostApi() !== null
  return (
    <div className="flex-1 flex items-center justify-center overflow-y-auto">
      <div className="w-full max-w-lg px-8 py-12">
        <div className="text-center mb-6">
          <div className="w-12 h-12 rounded-xl bg-bg-tertiary flex items-center justify-center mx-auto mb-3">
            <Sliders size={22} className="text-text-tertiary" />
          </div>
          <p className="text-sm text-text-secondary">{t('chat.emptyHint')}</p>
        </div>
        {hasHost && <SessionConfigPanel sessionId={sessionId} />}
      </div>
    </div>
  )
}
