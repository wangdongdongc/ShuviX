import { getChatApi, getChannelBindingApi } from '@shuvix/chat-ui'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, FileText, Globe, RefreshCw, TriangleAlert, X } from 'lucide-react'
import { copyToClipboard } from '@shuvix/chat-ui'
import { useChatStore, type ShareMode } from '@shuvix/chat-ui'
import type { InstructionFileEntry } from '@shuvix/chat-protocol/types/instructionFile'
import { SettingsSection, SettingsRow, Toggle, InlineSelect } from '../settings/SettingsPrimitives'
import { getChannelBindingCaps } from './channelBindings'

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
 * - autoApprove / allowList / lanShareMode / boundBotId 全部从 chatStore 派生，
 *   后端通过 `session.configChanged` 事件触发 store 刷新后自动重渲染。
 * - shareUrls / telegramBots 是只读列表，组件挂载时拉一次（且仅当对应渠道可用），
 *   并在收到配置变更事件时重新拉取。
 *
 * 绑定分节（局域网共享 / Telegram）据 getChannelBindingCaps() 自动显隐：
 * 当前宿主未提供对应渠道 API 即不渲染，无需宿主传 caps。
 */
export function SessionConfigPanel({ sessionId }: SessionConfigPanelProps): React.JSX.Element {
  const { webui: showLanShare, telegram: showTelegram } = getChannelBindingCaps()
  const { t } = useTranslation()
  const session = useChatStore((s) => s.sessions.find((sess) => sess.id === sessionId))
  const autoApprove = session?.settings.autoApprove === true
  const allowList = session?.settings.allowList ?? []
  const enabledInstructionFiles = session?.settings.enabledInstructionFiles ?? []
  const lanShareMode = useChatStore((s) => s.sharedSessionIds.get(sessionId) ?? null)
  const boundBotId = useChatStore((s) => s.telegramBindings.get(sessionId)?.botId ?? null)

  const [instructionFiles, setInstructionFiles] = useState<InstructionFileEntry[]>([])
  const [instructionScanning, setInstructionScanning] = useState(false)

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

  const handleToggleInstructionFile = async (filename: string): Promise<void> => {
    const next = enabledInstructionFiles.includes(filename)
      ? enabledInstructionFiles.filter((f) => f !== filename)
      : [...enabledInstructionFiles, filename]
    await getChatApi().session.updateInstructionFiles({ id: sessionId, filenames: next })
    useChatStore.getState().updateSessionSettings(sessionId, { enabledInstructionFiles: next })
  }

  const [shareUrls, setShareUrls] = useState<string[]>([])
  const [copied, setCopied] = useState(false)
  const [telegramBots, setTelegramBots] = useState<
    Array<{ id: string; name: string; username: string; boundSessionId: string | null }>
  >([])

  // WebUI 分享地址 / Telegram Bot 列表：仅在对应分节启用时拉取（扩展无这些后端，置 false 即跳过）
  useEffect(() => {
    if (!showLanShare && !showTelegram) return
    let cancelled = false

    const loadShareUrls = async (): Promise<void> => {
      const status = await getChannelBindingApi()?.webui?.serverStatus()
      if (cancelled || !status) return
      const urls =
        status.running && status.urls && status.urls.length > 0
          ? status.urls.map((u) => `${u}/shuvix/sessions/${sessionId}`)
          : []
      setShareUrls(urls)
    }

    const loadBots = async (): Promise<void> => {
      const bots = await getChannelBindingApi()?.telegram?.listBots()
      if (cancelled || !bots) return
      setTelegramBots(
        bots.map((b) => ({
          id: b.id,
          name: b.name,
          username: b.username,
          boundSessionId: b.boundSessionId
        }))
      )
    }

    if (showLanShare) void loadShareUrls()
    if (showTelegram) void loadBots()

    const unsubscribe = getChatApi().events.subscribe((event) => {
      if (event.type === 'session.configChanged' && event.sessionId === sessionId) {
        if (showLanShare) void loadShareUrls()
        if (showTelegram) void loadBots()
      }
    })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [sessionId, showLanShare, showTelegram])

  const handleSetShareMode = async (mode: ShareMode | null): Promise<void> => {
    await getChannelBindingApi()?.webui?.setShared({
      sessionId,
      shared: mode !== null,
      mode: mode ?? undefined
    })
  }

  const handleCopyShareUrl = (url: string): void => {
    copyToClipboard(url)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleSelectTelegramBot = async (botId: string | null): Promise<void> => {
    const telegram = getChannelBindingApi()?.telegram
    if (boundBotId) {
      await telegram?.unbindSession({ sessionId })
    }
    if (botId) {
      await telegram?.bindSession({ botId, sessionId })
    }
    useChatStore.getState().updateSessionSettings(sessionId, { telegramBotId: botId ?? undefined })
  }

  const handleToggleAutoApprove = async (): Promise<void> => {
    const next = !autoApprove
    await getChatApi().session.updateAutoApprove({ id: sessionId, autoApprove: next })
    useChatStore.getState().updateSessionSettings(sessionId, { autoApprove: next })
  }

  const handleRemoveAllowEntry = async (entry: string): Promise<void> => {
    await getChatApi().session.removeAllowListEntry({ id: sessionId, entry })
    const next = allowList.filter((e) => e !== entry)
    useChatStore.getState().updateSessionSettings(sessionId, { allowList: next })
  }

  const shareModeDescKey = lanShareMode
    ? `sessionConfig.shareMode${lanShareMode.charAt(0).toUpperCase() + lanShareMode.slice(1)}Desc`
    : ''

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

      {/* 会话绑定：WebUI / 局域网共享 + Telegram Bot（同属「会话绑定」，按宿主能力分别裁剪行） */}
      {(showLanShare || showTelegram) && (
        <SettingsSection title={t('sessionConfig.bindingsGroup')}>
          {/* WebUI / 局域网共享（宿主能力：showLanShare） */}
          {showLanShare && (
            <>
              <SettingsRow
                title={t('sessionConfig.lanShare')}
                description={t('sessionConfig.lanShareDesc')}
                control={
                  <Toggle
                    on={!!lanShareMode}
                    onClick={() => void handleSetShareMode(lanShareMode ? null : 'readonly')}
                  />
                }
              />
              {lanShareMode && (
                <SettingsRow
                  title={t('sessionConfig.shareMode')}
                  description={t(shareModeDescKey)}
                  control={
                    <InlineSelect
                      value={lanShareMode}
                      onChange={(v) => void handleSetShareMode(v as ShareMode)}
                    >
                      <option value="readonly">{t('sessionConfig.shareModeReadonly')}</option>
                      <option value="chat">{t('sessionConfig.shareModeChat')}</option>
                      <option value="full">{t('sessionConfig.shareModeFull')}</option>
                    </InlineSelect>
                  }
                />
              )}
              {lanShareMode && shareUrls.length > 0 && (
                <div className="px-4 py-3">
                  <div className="text-[11px] text-text-tertiary mb-1.5">
                    {t('sessionConfig.lanShareUrlsTitle')}
                  </div>
                  <div className="flex flex-col">
                    {shareUrls.map((url) => (
                      <div
                        key={url}
                        className="group flex items-center gap-1.5 px-2 py-1 rounded hover:bg-bg-hover/60 transition-colors"
                      >
                        <Globe size={11} className="text-text-tertiary shrink-0" />
                        <span className="flex-1 truncate text-[11px] font-mono text-text-secondary">
                          {url}
                        </span>
                        <button
                          onClick={() => handleCopyShareUrl(url)}
                          className="p-0.5 rounded text-text-tertiary opacity-0 group-hover:opacity-100 hover:text-accent transition-all shrink-0"
                          title={copied ? t('common.copied') : t('common.copy')}
                        >
                          <Copy size={11} />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {/* Telegram Bot（宿主能力：showTelegram） */}
          {showTelegram && (
            <SettingsRow
              title={t('sessionConfig.telegramTitle')}
              description={t('sessionConfig.telegramBotDesc')}
              control={
                <InlineSelect
                  value={boundBotId ?? ''}
                  onChange={(v) => void handleSelectTelegramBot(v || null)}
                >
                  <option value="">{t('sessionConfig.telegramNone')}</option>
                  {telegramBots
                    .filter((b) => !b.boundSessionId || b.boundSessionId === sessionId)
                    .map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                        {b.username ? ` (@${b.username})` : ''}
                      </option>
                    ))}
                </InlineSelect>
              }
            />
          )}
        </SettingsSection>
      )}

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
          instructionFiles.map((f) => {
            const enabled = enabledInstructionFiles.includes(f.filename)
            return (
              <SettingsRow
                key={f.filename}
                icon={<FileText size={12} className="text-text-tertiary shrink-0" />}
                title={
                  <>
                    <span className="font-mono">{f.filename}</span>
                    <span className="text-[11px] text-text-tertiary font-normal">{f.size} B</span>
                  </>
                }
                control={
                  <Toggle
                    on={enabled}
                    onClick={() => void handleToggleInstructionFile(f.filename)}
                  />
                }
              />
            )
          })
        )}
      </SettingsSection>
    </div>
  )
}
