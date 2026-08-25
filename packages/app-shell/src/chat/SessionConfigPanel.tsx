import { getChatApi } from '@shuvix/chat-ui'
import { useTranslation } from 'react-i18next'
import { TriangleAlert, X } from 'lucide-react'
import { useChatStore } from '@shuvix/chat-ui'
import { SettingsSection, SettingsRow, Toggle } from '../settings/SettingsPrimitives'

export interface SessionConfigPanelProps {
  sessionId: string
}

/**
 * 会话配置面板（除会话标题外的所有配置）。
 *
 * 只剩命令询问一节 —— 项目指令文件的「读哪些」已整体搬进 agent md 的
 * `shuvix-instruction-files` 清单（那是 agent 的人格设定，不是每个会话的临时选择），
 * 这里不再有对应开关。
 * 既可嵌入到 SessionConfigDialog 弹窗中，也可在空会话时直接居中展示。
 *
 * 视觉：分节标题 + 圆角卡片 + 行式条目（左标题/描述，右控件）。
 *
 * 状态来源：
 * - autoAllow / allowList 从 chatStore 派生，
 *   后端通过 `session.configChanged` 事件触发 store 刷新后自动重渲染。
 *   并在收到配置变更事件时重新拉取。
 */
export function SessionConfigPanel({ sessionId }: SessionConfigPanelProps): React.JSX.Element {
  const { t } = useTranslation()
  const session = useChatStore((s) => s.sessions.find((sess) => sess.id === sessionId))
  const autoAllow = session?.settings.autoAllow === true
  const allowList = session?.settings.allowList ?? []

  const handleToggleAutoAllow = async (): Promise<void> => {
    const next = !autoAllow
    await getChatApi().session.updateAutoAllow({ id: sessionId, autoAllow: next })
    useChatStore.getState().updateSessionSettings(sessionId, { autoAllow: next })
  }

  /** 允许列表仅含路径条目（`Read(...)`/`Write(...)`）：命令类工具逐条询问，无模式记忆 */
  const handleRemoveAllowEntry = async (entry: string): Promise<void> => {
    await getChatApi().session.removeAllowListEntry({ id: sessionId, entry })
    const next = allowList.filter((e) => e !== entry)
    useChatStore.getState().updateSessionSettings(sessionId, { allowList: next })
  }

  return (
    <div className="space-y-5">
      {/* 命令询问 */}
      <SettingsSection title={t('sessionConfig.commandGroup')}>
        <SettingsRow
          title={t('sessionConfig.autoAllow')}
          description={t('sessionConfig.autoAllowDesc')}
          control={
            <Toggle on={autoAllow} color="amber" onClick={() => void handleToggleAutoAllow()} />
          }
        />
        {autoAllow && (
          <div className="flex items-start gap-2 px-4 py-2.5 bg-amber-500/[0.06]">
            <TriangleAlert size={12} className="text-amber-500 shrink-0 mt-0.5" />
            <p className="text-[11px] leading-relaxed text-amber-600 dark:text-amber-400">
              {t('chat.autoAllowWarning')}
            </p>
          </div>
        )}
        {!autoAllow && allowList.length > 0 && (
          <div className="px-4 py-3">
            <div className="text-[11px] text-text-tertiary mb-1.5">
              {t('sessionConfig.allowListTitle')}
            </div>
            <div className="flex flex-col gap-1">
              {allowList.map((entry) => (
                <div
                  key={entry}
                  title={entry}
                  className="group flex items-center gap-1.5 px-2 py-1 rounded bg-bg-tertiary/60"
                >
                  <span className="flex-1 truncate text-[11px] font-mono text-text-secondary">
                    {entry}
                  </span>
                  <button
                    onClick={() => void handleRemoveAllowEntry(entry)}
                    className="text-text-tertiary hover:text-red-500 transition-colors shrink-0 opacity-0 group-hover:opacity-100"
                  >
                    <X size={10} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </SettingsSection>
    </div>
  )
}
