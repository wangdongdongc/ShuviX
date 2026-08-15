import { getChatApi } from '@shuvix/chat-ui'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FileText, RefreshCw, TriangleAlert, X } from 'lucide-react'
import { useChatStore } from '@shuvix/chat-ui'
import {
  resolveInstructionFile,
  type InstructionFileEntry
} from '@shuvix/chat-protocol/types/instructionFile'
import { SettingsSection, SettingsRow, Toggle, InlineSelect } from '../settings/SettingsPrimitives'

export interface SessionConfigPanelProps {
  sessionId: string
}

/**
 * 会话配置面板（除会话标题外的所有配置）。
 * 既可嵌入到 SessionConfigDialog 弹窗中，也可在空会话时直接居中展示。
 *
 * 视觉：分节标题 + 圆角卡片 + 行式条目（左标题/描述，右控件）。
 *
 * 状态来源：
 * - autoApprove / allowList 从 chatStore 派生，
 *   后端通过 `session.configChanged` 事件触发 store 刷新后自动重渲染。
 *   并在收到配置变更事件时重新拉取。
 */
export function SessionConfigPanel({ sessionId }: SessionConfigPanelProps): React.JSX.Element {
  const { t } = useTranslation()
  const session = useChatStore((s) => s.sessions.find((sess) => sess.id === sessionId))
  const autoApprove = session?.settings.autoApprove === true
  const allowList = session?.settings.allowList ?? []

  const [instructionFiles, setInstructionFiles] = useState<InstructionFileEntry[]>([])
  const [instructionScanning, setInstructionScanning] = useState(false)
  // 单选：至多注入一个指令文件；null = 不注入（未显式配置时按 AGENTS.md → CLAUDE.md 优先级自动选）
  const selectedInstructionFile = resolveInstructionFile(
    session?.settings.instructionFile,
    instructionFiles.map((f) => f.filename)
  )

  const scanInstructionFiles = async (): Promise<void> => {
    setInstructionScanning(true)
    try {
      const files = await getChatApi().session.scanInstructionFiles(sessionId)
      setInstructionFiles(files)
    } finally {
      setInstructionScanning(false)
    }
  }

  useEffect(() => {
    void scanInstructionFiles()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  /** 选中注入的指令文件；null = 不注入 */
  const handleSelectInstructionFile = async (filename: string | null): Promise<void> => {
    await getChatApi().session.updateInstructionFile({ id: sessionId, filename })
    useChatStore.getState().updateSessionSettings(sessionId, { instructionFile: filename })
  }

  const handleToggleAutoApprove = async (): Promise<void> => {
    const next = !autoApprove
    await getChatApi().session.updateAutoApprove({ id: sessionId, autoApprove: next })
    useChatStore.getState().updateSessionSettings(sessionId, { autoApprove: next })
  }

  /** 允许列表仅含路径条目（`Read(...)`/`Write(...)`）：命令类工具逐条审批，无模式记忆 */
  const handleRemoveAllowEntry = async (entry: string): Promise<void> => {
    await getChatApi().session.removeAllowListEntry({ id: sessionId, entry })
    const next = allowList.filter((e) => e !== entry)
    useChatStore.getState().updateSessionSettings(sessionId, { allowList: next })
  }

  return (
    <div className="space-y-5">
      {/* 命令审批 */}
      <SettingsSection title={t('sessionConfig.commandGroup')}>
        <SettingsRow
          title={t('sessionConfig.autoApprove')}
          description={t('sessionConfig.autoApproveDesc')}
          control={
            <Toggle on={autoApprove} color="amber" onClick={() => void handleToggleAutoApprove()} />
          }
        />
        {autoApprove && (
          <div className="flex items-start gap-2 px-4 py-2.5 bg-amber-500/[0.06]">
            <TriangleAlert size={12} className="text-amber-500 shrink-0 mt-0.5" />
            <p className="text-[11px] leading-relaxed text-amber-600 dark:text-amber-400">
              {t('chat.autoApproveWarning')}
            </p>
          </div>
        )}
        {!autoApprove && allowList.length > 0 && (
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

      {/* 项目指令文件 */}
      <SettingsSection
        title={t('sessionConfig.instructionFilesGroup')}
        headerAction={
          <button
            onClick={() => void scanInstructionFiles()}
            disabled={instructionScanning}
            className="p-1 rounded text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors disabled:opacity-50"
            title={t('sessionConfig.instructionFilesRescan')}
          >
            <RefreshCw size={11} className={instructionScanning ? 'animate-spin' : ''} />
          </button>
        }
        footer={t('sessionConfig.instructionFilesHint')}
      >
        {instructionFiles.length === 0 ? (
          <div className="px-4 py-3 text-[11px] text-text-tertiary">
            {t('sessionConfig.instructionFilesEmpty')}
          </div>
        ) : (
          <SettingsRow
            icon={<FileText size={12} className="text-text-tertiary shrink-0" />}
            title={t('sessionConfig.instructionFileLabel')}
            control={
              <InlineSelect
                value={selectedInstructionFile ?? ''}
                onChange={(v) => void handleSelectInstructionFile(v || null)}
              >
                <option value="">{t('sessionConfig.instructionFileNone')}</option>
                {instructionFiles.map((f) => (
                  <option key={f.filename} value={f.filename}>
                    {f.filename}
                  </option>
                ))}
              </InlineSelect>
            }
          />
        )}
      </SettingsSection>
    </div>
  )
}
