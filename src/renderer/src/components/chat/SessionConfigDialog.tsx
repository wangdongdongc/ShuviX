import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Bot, Copy, Globe, Terminal, Trash2, TriangleAlert, X } from 'lucide-react'
import { copyToClipboard } from '../../utils/clipboard'
import { useChatStore, type ShareMode } from '../../stores/chatStore'
import { useDialogClose } from '../../hooks/useDialogClose'
import { ConfirmDialog } from '../common/ConfirmDialog'

export function SessionConfigDialog({
  sessionId,
  onClose
}: {
  sessionId: string
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { closing, handleClose } = useDialogClose(onClose)
  const session = useChatStore((s) => s.sessions.find((sess) => sess.id === sessionId))
  const [title, setTitle] = useState(session?.title || '')

  const [autoApprove, setAutoApprove] = useState(session?.settings.autoApprove === true)
  const [allowList, setAllowList] = useState<string[]>(session?.settings.allowList || [])

  // LAN 分享状态（null = 未分享）
  const [lanShareMode, setLanShareMode] = useState<ShareMode | null>(null)
  const [shareUrls, setShareUrls] = useState<string[]>([])
  const [copied, setCopied] = useState(false)

  // Telegram Bot 绑定
  const [telegramBots, setTelegramBots] = useState<
    Array<{ id: string; name: string; username: string; boundSessionId: string | null }>
  >([])
  const [boundBotId, setBoundBotId] = useState<string | null>(null)

  useEffect(() => {
    window.api.webui.getShareMode(sessionId).then((mode) => {
      setLanShareMode(mode)
      if (mode) {
        window.api.webui.serverStatus().then((status) => {
          if (status.running && status.urls && status.urls.length > 0) {
            setShareUrls(status.urls.map((u) => `${u}/shuvix/sessions/${sessionId}`))
          }
        })
      } else {
        setShareUrls([])
      }
    })
    // 加载 Telegram Bot 列表 + 当前绑定
    Promise.all([
      window.api.telegram.listBots(),
      window.api.telegram.getSessionBotId(sessionId)
    ]).then(([bots, botId]) => {
      setTelegramBots(
        bots.map((b) => ({
          id: b.id,
          name: b.name,
          username: b.username,
          boundSessionId: b.boundSessionId
        }))
      )
      setBoundBotId(botId)
    })
  }, [sessionId])

  // Escape 关闭
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') handleClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [handleClose])

  /** 保存标题 */
  const handleSaveTitle = async (): Promise<void> => {
    const trimmed = title.trim()
    if (!trimmed || trimmed === session?.title) return
    await window.api.session.updateTitle({ id: sessionId, title: trimmed })
    useChatStore.getState().updateSessionTitle(sessionId, trimmed)
  }

  // 删除确认
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)

  /** 点击删除：有消息时先确认，无消息直接删除 */
  const handleRequestDelete = async (): Promise<void> => {
    const msgs = await window.api.message.list(sessionId)
    if (msgs.length > 0) {
      setShowDeleteConfirm(true)
    } else {
      await doDeleteSession()
    }
  }

  /** 执行删除 */
  const doDeleteSession = async (): Promise<void> => {
    await window.api.session.delete(sessionId)
    useChatStore.getState().removeSession(sessionId)
    onClose()
  }

  /** 切换 LAN 分享模式 */
  const handleSetShareMode = async (mode: ShareMode | null): Promise<void> => {
    setLanShareMode(mode)
    await window.api.webui.setShared({ sessionId, shared: mode !== null, mode: mode ?? undefined })
    if (mode) {
      const status = await window.api.webui.serverStatus()
      if (status.running && status.urls && status.urls.length > 0) {
        setShareUrls(status.urls.map((u) => `${u}/shuvix/sessions/${sessionId}`))
      }
    } else {
      setShareUrls([])
    }
    // 更新 chatStore 中的分享列表
    const shared = await window.api.webui.listShared()
    useChatStore.getState().setSharedSessionIds(new Map(shared.map((s) => [s.sessionId, s.mode])))
  }

  /** 复制分享链接 */
  const handleCopyShareUrl = (url: string): void => {
    copyToClipboard(url)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  /** 选择 Telegram Bot 绑定 */
  const handleSelectTelegramBot = async (botId: string | null): Promise<void> => {
    // 先解绑当前
    if (boundBotId) {
      await window.api.telegram.unbindSession({ sessionId })
    }
    // 再绑定新 Bot
    if (botId) {
      await window.api.telegram.bindSession({ botId, sessionId })
    }
    setBoundBotId(botId)
    // 更新 chatStore
    useChatStore.getState().updateSessionSettings(sessionId, { telegramBotId: botId ?? undefined })
    const bindings = new Map(useChatStore.getState().telegramBindings)
    if (botId) {
      const bot = telegramBots.find((b) => b.id === botId)
      bindings.set(sessionId, { botId, username: bot?.username ?? '' })
    } else {
      bindings.delete(sessionId)
    }
    useChatStore.getState().setTelegramBindings(bindings)
    // 刷新 bot 列表（绑定状态变化）
    const bots = await window.api.telegram.listBots()
    setTelegramBots(
      bots.map((b) => ({
        id: b.id,
        name: b.name,
        username: b.username,
        boundSessionId: b.boundSessionId
      }))
    )
  }

  /** 切换命令免审批 */
  const handleToggleAutoApprove = async (): Promise<void> => {
    const next = !autoApprove
    setAutoApprove(next)
    await window.api.session.updateAutoApprove({ id: sessionId, autoApprove: next })
    useChatStore.getState().updateSessionSettings(sessionId, { autoApprove: next })
  }

  /** 删除允许列表条目 */
  const handleRemoveAllowEntry = async (entry: string): Promise<void> => {
    await window.api.session.removeAllowListEntry({ id: sessionId, entry })
    const next = allowList.filter((e) => e !== entry)
    setAllowList(next)
    useChatStore.getState().updateSessionSettings(sessionId, { allowList: next })
  }

  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center bg-black/40 dialog-overlay${closing ? ' dialog-closing' : ''}`}
      onClick={handleClose}
    >
      <div
        className="w-[520px] max-w-[90vw] bg-bg-primary border border-border-secondary rounded-xl shadow-xl max-h-[85vh] flex flex-col dialog-panel"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-secondary/50 bg-bg-secondary/50">
          <h3 className="text-sm font-semibold text-text-primary">{t('sessionConfig.title')}</h3>
          <button
            onClick={handleClose}
            className="p-1 rounded-lg hover:bg-bg-hover text-text-tertiary hover:text-text-primary transition-colors"
          >
            <X size={14} />
          </button>
        </div>

        <div className="px-4 py-4 space-y-4 overflow-y-auto flex-1 min-h-0">
          {/* 会话标题 */}
          <div>
            <label className="block text-[10px] text-text-tertiary mb-1">
              {t('sessionConfig.sessionTitle')}
            </label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={() => void handleSaveTitle()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleSaveTitle()
              }}
              className="zen-input"
            />
          </div>

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
                <span className="text-[10px] text-text-tertiary">
                  {t('sessionConfig.allowedCommands')}
                </span>
                <div className="flex flex-col gap-1 mt-1">
                  {allowList.map((entry) => (
                    <div
                      key={entry}
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
                <span className="text-[10px] text-text-tertiary">
                  {t('sessionConfig.shareMode')}
                </span>
                <div className="flex gap-1">
                  {(['readonly', 'chat', 'full'] as const).map((mode) => (
                    <button
                      key={mode}
                      onClick={() => void handleSetShareMode(mode)}
                      className={`flex-1 px-2 py-1.5 rounded-md text-[10px] font-medium transition-colors border ${
                        lanShareMode === mode
                          ? 'bg-accent/15 text-accent border-accent/30'
                          : 'bg-bg-tertiary text-text-tertiary border-border-primary hover:bg-bg-hover hover:text-text-secondary'
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
              <div className="border-t border-border-secondary pt-2 flex flex-col gap-1">
                {shareUrls.map((url) => (
                  <div
                    key={url}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-bg-tertiary border border-border-primary"
                  >
                    <Globe size={11} className="text-accent shrink-0" />
                    <span className="text-[10px] text-text-secondary truncate flex-1">{url}</span>
                    <button
                      onClick={() => handleCopyShareUrl(url)}
                      className="p-0.5 rounded hover:bg-bg-hover text-text-tertiary hover:text-text-secondary transition-colors shrink-0"
                      title={copied ? t('common.copied') : t('common.copy')}
                    >
                      <Copy size={11} />
                    </button>
                  </div>
                ))}
              </div>
            )}
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

        {/* 底部按钮 */}
        <div className="px-4 py-3 border-t border-border-secondary/50 bg-bg-secondary/30 flex items-center justify-between">
          <button
            onClick={() => void handleRequestDelete()}
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs text-text-tertiary hover:text-red-400 hover:bg-red-500/10 transition-colors"
          >
            <Trash2 size={12} />
            {t('common.delete')}
          </button>
          <button
            onClick={handleClose}
            className="px-4 py-1.5 rounded-lg text-xs font-medium bg-bg-secondary border border-border-primary text-text-secondary hover:bg-bg-hover transition-colors"
          >
            {t('common.close')}
          </button>
        </div>
      </div>

      {/* 删除会话确认弹窗 */}
      {showDeleteConfirm && (
        <ConfirmDialog
          title={t('sidebar.confirmDelete')}
          description={
            <>
              {t('sidebar.deleteWarning')}
              <span className="text-error font-medium">{t('sidebar.deleteWarningBold')}</span>
              {t('sidebar.deleteWarningEnd')}
            </>
          }
          confirmText={t('common.delete')}
          cancelText={t('common.cancel')}
          onConfirm={() => void doDeleteSession()}
          onCancel={() => setShowDeleteConfirm(false)}
        />
      )}
    </div>
  )
}
