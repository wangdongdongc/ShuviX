import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Bot, Copy, FileText, Globe, RefreshCw, Terminal, TriangleAlert, X } from 'lucide-react'
import { copyToClipboard } from '../../utils/clipboard'
import { useChatStore, type ShareMode } from '../../stores/chatStore'
import type { InstructionFileEntry } from '../../../../shared/types/instructionFile'

/**
 * 会话配置面板（除会话标题外的所有配置）。
 * 既可嵌入到 SessionConfigDialog 弹窗中，也可在空会话时直接居中展示。
 *
 * 状态来源：
 * - autoApprove / allowList / lanShareMode / boundBotId 全部从 chatStore 派生，
 *   后端通过 `session:configChanged` 事件触发 store 刷新后自动重渲染。
 * - shareUrls / telegramBots 是只读列表，组件挂载时拉一次，
 *   并在收到配置变更事件时重新拉取。
 */
export function SessionConfigPanel({ sessionId }: { sessionId: string }): React.JSX.Element {
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
      const files = await window.api.session.scanInstructionFiles(sessionId)
      setInstructionFiles(files)
    } finally {
      setInstructionScanning(false)
    }
  }

  // 打开面板时扫描一次
  useEffect(() => {
    void scanInstructionFiles()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  const handleToggleInstructionFile = async (filename: string): Promise<void> => {
    const next = enabledInstructionFiles.includes(filename)
      ? enabledInstructionFiles.filter((f) => f !== filename)
      : [...enabledInstructionFiles, filename]
    await window.api.session.updateInstructionFiles({ id: sessionId, filenames: next })
    useChatStore.getState().updateSessionSettings(sessionId, { enabledInstructionFiles: next })
  }

  const [shareUrls, setShareUrls] = useState<string[]>([])
  const [copied, setCopied] = useState(false)
  const [telegramBots, setTelegramBots] = useState<
    Array<{ id: string; name: string; username: string; boundSessionId: string | null }>
  >([])

  // 加载分享 URL 列表与 Telegram Bot 列表（挂载时 + 收到配置变更事件时）
  useEffect(() => {
    let cancelled = false

    const loadShareUrls = async (): Promise<void> => {
      const status = await window.api.webui.serverStatus()
      if (cancelled) return
      const urls =
        status.running && status.urls && status.urls.length > 0
          ? status.urls.map((u) => `${u}/shuvix/sessions/${sessionId}`)
          : []
      setShareUrls(urls)
    }

    const loadBots = async (): Promise<void> => {
      const bots = await window.api.telegram.listBots()
      if (cancelled) return
      setTelegramBots(
        bots.map((b) => ({
          id: b.id,
          name: b.name,
          username: b.username,
          boundSessionId: b.boundSessionId
        }))
      )
    }

    void loadShareUrls()
    void loadBots()

    const unsubscribe = window.api.session.onConfigChanged((payload) => {
      if (payload.sessionId === sessionId) {
        void loadShareUrls()
        void loadBots()
      }
    })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [sessionId])

  const handleSetShareMode = async (mode: ShareMode | null): Promise<void> => {
    await window.api.webui.setShared({ sessionId, shared: mode !== null, mode: mode ?? undefined })
    // store 由 session:configChanged 事件刷新
  }

  const handleCopyShareUrl = (url: string): void => {
    copyToClipboard(url)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleSelectTelegramBot = async (botId: string | null): Promise<void> => {
    if (boundBotId) {
      await window.api.telegram.unbindSession({ sessionId })
    }
    if (botId) {
      await window.api.telegram.bindSession({ botId, sessionId })
    }
    // 更新 session.settings 中的 telegramBotId（store 中 telegramBindings 由事件刷新）
    useChatStore.getState().updateSessionSettings(sessionId, { telegramBotId: botId ?? undefined })
  }

  const handleToggleAutoApprove = async (): Promise<void> => {
    const next = !autoApprove
    await window.api.session.updateAutoApprove({ id: sessionId, autoApprove: next })
    useChatStore.getState().updateSessionSettings(sessionId, { autoApprove: next })
  }

  const handleRemoveAllowEntry = async (entry: string): Promise<void> => {
    await window.api.session.removeAllowListEntry({ id: sessionId, entry })
    const next = allowList.filter((e) => e !== entry)
    useChatStore.getState().updateSessionSettings(sessionId, { allowList: next })
  }

  return (
    <div className="space-y-4">
      {/* 命令审批分组 */}
      <div className="zen-section space-y-2">
        <label className="flex items-center gap-1.5 text-xs font-medium text-text-secondary">
          <Terminal size={12} />
          {t('sessionConfig.commandGroup')}
        </label>
        <div className="flex items-center justify-between">
          <span className="text-xs text-text-secondary">{t('sessionConfig.autoApprove')}</span>
          <button
            onClick={handleToggleAutoApprove}
            className={`relative w-8 h-[18px] rounded-full transition-colors ${
              autoApprove ? 'bg-amber-500' : 'bg-bg-hover'
            }`}
          >
            <span
              className={`absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white shadow transition-transform ${
                autoApprove ? 'left-[16px]' : 'left-[2px]'
              }`}
            />
          </button>
        </div>
        {autoApprove && (
          <div className="flex items-start gap-1.5 px-2.5 py-1.5 rounded-lg border border-amber-500/30 bg-amber-500/5">
            <TriangleAlert size={11} className="text-amber-500 shrink-0 mt-0.5" />
            <p className="text-[10px] text-amber-600 dark:text-amber-400 leading-relaxed">
              {t('chat.autoApproveWarning')}
            </p>
          </div>
        )}
        {!autoApprove && allowList.length > 0 && (
          <div className="border-t border-border-secondary pt-2">
            <span className="text-[10px] text-text-tertiary">{t('sessionConfig.allowList')}</span>
            <div className="flex flex-col gap-1 mt-1">
              {allowList.map((entry) => (
                <div
                  key={entry}
                  title={entry}
                  className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-bg-tertiary text-[10px] font-mono text-text-secondary"
                >
                  <span className="flex-1 truncate">{entry}</span>
                  <button
                    onClick={() => void handleRemoveAllowEntry(entry)}
                    className="text-text-tertiary hover:text-red-500 transition-colors shrink-0"
                  >
                    <X size={9} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* LAN 分享分组 */}
      <div className="zen-section space-y-2">
        <label className="flex items-center gap-1.5 text-xs font-medium text-text-secondary">
          <Globe size={12} />
          {t('sessionConfig.lanShareGroup')}
        </label>
        <div className="flex items-center justify-between">
          <span className="text-xs text-text-secondary">{t('sessionConfig.lanShare')}</span>
          <button
            onClick={() => void handleSetShareMode(lanShareMode ? null : 'readonly')}
            className={`relative w-8 h-[18px] rounded-full transition-colors ${
              lanShareMode ? 'bg-accent' : 'bg-bg-hover'
            }`}
          >
            <span
              className={`absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white shadow transition-transform ${
                lanShareMode ? 'left-[16px]' : 'left-[2px]'
              }`}
            />
          </button>
        </div>
        <p className="text-[10px] text-text-tertiary">{t('sessionConfig.lanShareDesc')}</p>

        {lanShareMode && (
          <div className="border-t border-border-secondary pt-2 space-y-1.5">
            <span className="text-[10px] text-text-tertiary">{t('sessionConfig.shareMode')}</span>
            <div className="inline-flex w-full p-0.5 rounded-md bg-bg-tertiary">
              {(['readonly', 'chat', 'full'] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => void handleSetShareMode(mode)}
                  className={`flex-1 px-2 py-1 rounded text-[10px] font-medium transition-all ${
                    lanShareMode === mode
                      ? 'bg-bg-primary text-accent shadow-sm'
                      : 'text-text-tertiary hover:text-text-secondary'
                  }`}
                >
                  {t(`sessionConfig.shareMode${mode.charAt(0).toUpperCase() + mode.slice(1)}`)}
                </button>
              ))}
            </div>
            <p className="text-[9px] text-text-tertiary leading-relaxed">
              {lanShareMode === 'readonly'
                ? t('sessionConfig.shareModeReadonlyDesc')
                : lanShareMode === 'chat'
                  ? t('sessionConfig.shareModeChatDesc')
                  : t('sessionConfig.shareModeFullDesc')}
            </p>
          </div>
        )}

        {lanShareMode && shareUrls.length > 0 && (
          <div className="border-t border-border-secondary pt-2 flex flex-col">
            {shareUrls.map((url) => (
              <div
                key={url}
                className="group flex items-center gap-1.5 px-1 py-1 rounded hover:bg-bg-hover/60 transition-colors"
              >
                <Globe size={10} className="text-text-tertiary shrink-0" />
                <span className="text-[10px] font-mono text-text-secondary truncate flex-1">
                  {url}
                </span>
                <button
                  onClick={() => handleCopyShareUrl(url)}
                  className="p-0.5 rounded text-text-tertiary opacity-0 group-hover:opacity-100 hover:text-accent transition-all shrink-0"
                  title={copied ? t('common.copied') : t('common.copy')}
                >
                  <Copy size={10} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 项目指令文件分组 */}
      <div className="zen-section space-y-2">
        <div className="flex items-center justify-between">
          <label className="flex items-center gap-1.5 text-xs font-medium text-text-secondary">
            <FileText size={12} />
            {t('sessionConfig.instructionFilesGroup')}
          </label>
          <button
            onClick={() => void scanInstructionFiles()}
            disabled={instructionScanning}
            className="p-0.5 rounded text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors disabled:opacity-50"
            title={t('sessionConfig.instructionFilesRescan')}
          >
            <RefreshCw size={11} className={instructionScanning ? 'animate-spin' : ''} />
          </button>
        </div>
        {instructionFiles.length === 0 ? (
          <p className="text-[10px] text-text-tertiary">
            {t('sessionConfig.instructionFilesEmpty')}
          </p>
        ) : (
          <div className="flex flex-col gap-1">
            {instructionFiles.map((f) => {
              const enabled = enabledInstructionFiles.includes(f.filename)
              return (
                <div
                  key={f.filename}
                  className="flex items-center justify-between gap-2 px-2 py-1 rounded hover:bg-bg-hover/40 transition-colors"
                >
                  <div className="flex items-center gap-1.5 min-w-0">
                    <FileText size={11} className="text-text-tertiary shrink-0" />
                    <span className="text-xs font-mono text-text-secondary truncate">
                      {f.filename}
                    </span>
                    <span className="text-[10px] text-text-tertiary shrink-0">{f.size}B</span>
                  </div>
                  <button
                    onClick={() => void handleToggleInstructionFile(f.filename)}
                    className={`relative w-8 h-[18px] rounded-full transition-colors shrink-0 ${
                      enabled ? 'bg-accent' : 'bg-bg-hover'
                    }`}
                  >
                    <span
                      className={`absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white shadow transition-transform ${
                        enabled ? 'left-[16px]' : 'left-[2px]'
                      }`}
                    />
                  </button>
                </div>
              )
            })}
          </div>
        )}
        <p className="text-[10px] text-text-tertiary">{t('sessionConfig.instructionFilesHint')}</p>
      </div>

      {/* Telegram Bot 分组 */}
      <div className="zen-section space-y-2">
        <label className="flex items-center gap-1.5 text-xs font-medium text-text-secondary">
          <Bot size={12} />
          {t('sessionConfig.telegramGroup')}
        </label>
        <select
          value={boundBotId ?? ''}
          onChange={(e) => void handleSelectTelegramBot(e.target.value || null)}
          className="zen-select"
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
        </select>
        <p className="text-[10px] text-text-tertiary">{t('sessionConfig.telegramBotDesc')}</p>
      </div>
    </div>
  )
}
