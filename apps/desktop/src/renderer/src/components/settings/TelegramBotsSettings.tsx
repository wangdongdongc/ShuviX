import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { X, Plus, ChevronDown, ChevronRight, Trash2 } from 'lucide-react'
import { useDialogClose } from '@shuvix/chat-ui'
import type { TelegramBotInfo } from '@shuvix/chat-protocol/chatApi'
import { SettingsSection, InlineInput } from './SettingsPrimitives'

/**
 * Telegram Bot 登记 —— 一张普通的设置页，不是「渠道绑定」。
 *
 * 曾经这里是「会话绑定」的二层抽屉（第一层选渠道、第二层管该渠道），因为有 WebUI
 * 局域网分享和 Telegram 两条渠道。两者的会话流绑定都已下线，剩下的只是「注册过哪些
 * Bot」这份数据，于是抽屉压平成单层列表：登记本身不产生任何网络行为，没有启停、
 * 没有绑定会话、没有运行状态。
 */
export function TelegramBotsSettings(): React.JSX.Element {
  const { t } = useTranslation()
  const [bots, setBots] = useState<TelegramBotInfo[]>([])
  const [expandedBotId, setExpandedBotId] = useState<string | null>(null)
  const [showAddDialog, setShowAddDialog] = useState(false)

  const loadBots = useCallback(async () => {
    setBots(await window.api.telegram.listBots())
  }, [])

  useEffect(() => {
    loadBots() // eslint-disable-line react-hooks/set-state-in-effect
  }, [loadBots])

  const handleDeleteBot = async (botId: string): Promise<void> => {
    await window.api.telegram.deleteBot(botId)
    setExpandedBotId(null)
    await loadBots()
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="px-5 py-5 space-y-5">
        <SettingsSection
          title={t('telegramBots.title')}
          description={t('telegramBots.description')}
          headerAction={
            <button
              onClick={() => setShowAddDialog(true)}
              className="flex items-center gap-1 px-2 py-1 rounded text-[11px] text-accent hover:bg-accent/10 transition-colors"
            >
              <Plus size={11} />
              {t('telegramBots.addBot')}
            </button>
          }
        >
          {bots.length === 0 ? (
            <div className="px-4 py-6 text-center">
              <p className="text-[11px] text-text-tertiary">{t('telegramBots.noBots')}</p>
            </div>
          ) : (
            bots.map((bot) => (
              <BotItem
                key={bot.id}
                bot={bot}
                expanded={expandedBotId === bot.id}
                onToggle={() => setExpandedBotId(expandedBotId === bot.id ? null : bot.id)}
                onDelete={() => void handleDeleteBot(bot.id)}
                onUpdated={loadBots}
              />
            ))
          )}
        </SettingsSection>
      </div>

      {showAddDialog && (
        <AddBotDialog
          onAdded={async () => {
            setShowAddDialog(false)
            await loadBots()
          }}
          onClose={() => setShowAddDialog(false)}
        />
      )}
    </div>
  )
}

/** 单个 Bot 行 + 可展开管理面板 */
function BotItem({
  bot,
  expanded,
  onToggle,
  onDelete,
  onUpdated
}: {
  bot: TelegramBotInfo
  expanded: boolean
  onToggle: () => void
  onDelete: () => void
  onUpdated: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [confirmDelete, setConfirmDelete] = useState(false)

  return (
    <div className="flex flex-col">
      <div
        onClick={onToggle}
        className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-bg-hover/40 transition-colors"
      >
        <span className="text-text-tertiary shrink-0">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
        <div className="min-w-0 flex-1 flex items-center gap-2">
          <span className="text-[13px] text-text-primary truncate">{bot.name}</span>
          {bot.username && (
            <span className="text-[10px] font-mono text-text-tertiary shrink-0">
              @{bot.username}
            </span>
          )}
        </div>
      </div>

      {expanded && (
        <div className="px-4 py-3 space-y-3 bg-bg-tertiary/15">
          <BotAllowedUsers bot={bot} onUpdated={onUpdated} />

          <div className="pt-2 border-t border-border-secondary/30">
            {confirmDelete ? (
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-red-400 flex-1">
                  {t('telegramBots.deleteConfirm')}
                </span>
                <button
                  onClick={() => setConfirmDelete(false)}
                  className="px-2 py-1 text-[10px] rounded text-text-secondary hover:bg-bg-hover transition-colors"
                >
                  {t('common.cancel')}
                </button>
                <button
                  onClick={onDelete}
                  className="px-2 py-1 text-[10px] rounded bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors"
                >
                  {t('common.confirm')}
                </button>
              </div>
            ) : (
              <button
                onClick={() => setConfirmDelete(true)}
                className="flex items-center gap-1 text-[11px] text-red-400 hover:text-red-300 transition-colors"
              >
                <Trash2 size={11} />
                {t('telegramBots.deleteBot')}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/** Bot 允许用户管理 */
function BotAllowedUsers({
  bot,
  onUpdated
}: {
  bot: TelegramBotInfo
  onUpdated: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [newUserId, setNewUserId] = useState('')

  const handleAddUser = async (): Promise<void> => {
    const id = parseInt(newUserId.trim())
    if (isNaN(id) || bot.allowedUsers.includes(id)) return
    await window.api.telegram.updateBot({ id: bot.id, allowedUsers: [...bot.allowedUsers, id] })
    setNewUserId('')
    onUpdated()
  }

  const handleRemoveUser = async (userId: number): Promise<void> => {
    const updated = bot.allowedUsers.filter((id) => id !== userId)
    await window.api.telegram.updateBot({ id: bot.id, allowedUsers: updated })
    onUpdated()
  }

  return (
    <div>
      <div className="text-[12px] text-text-primary mb-1">{t('telegramBots.editAllowedUsers')}</div>
      <div className="text-[11px] text-text-tertiary mb-2 leading-relaxed">
        {t('telegramBots.allowedUsersHint')}
      </div>
      <div className="flex gap-2 mb-2">
        <InlineInput value={newUserId} onChange={setNewUserId} placeholder="User ID" width={200} />
        <button
          onClick={() => void handleAddUser()}
          disabled={!newUserId.trim()}
          className="p-1.5 rounded-md bg-accent/10 text-accent hover:bg-accent/20 disabled:opacity-50 transition-colors"
        >
          <Plus size={12} />
        </button>
      </div>
      {bot.allowedUsers.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {bot.allowedUsers.map((id) => (
            <span
              key={id}
              className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-mono rounded-full bg-bg-hover text-text-secondary"
            >
              {id}
              <button
                onClick={() => void handleRemoveUser(id)}
                className="text-text-tertiary hover:text-danger"
              >
                <X size={9} />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

/** 添加 Bot 弹窗 */
function AddBotDialog({
  onAdded,
  onClose
}: {
  onAdded: () => void
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { closing, handleClose } = useDialogClose(onClose)
  const [token, setToken] = useState('')
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') handleClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [handleClose])

  const handleSubmit = async (): Promise<void> => {
    if (!token.trim()) return
    setAdding(true)
    setError('')
    try {
      await window.api.telegram.addBot({ token: token.trim() })
      onAdded()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('telegramBots.tokenInvalid'))
    } finally {
      setAdding(false)
    }
  }

  return (
    <div
      onClick={handleClose}
      className={`fixed inset-0 z-50 flex items-center justify-center bg-black/40 titlebar-no-drag dialog-overlay${closing ? ' dialog-closing' : ''}`}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-bg-primary border border-border-primary rounded-xl shadow-xl w-[440px] max-w-[92vw] flex flex-col dialog-panel"
      >
        <div className="px-5 py-3 border-b border-border-secondary shrink-0 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-text-primary">{t('telegramBots.addBot')}</h3>
          <button
            onClick={handleClose}
            className="p-1 rounded-lg hover:bg-bg-hover text-text-tertiary hover:text-text-primary transition-colors"
          >
            <X size={14} />
          </button>
        </div>

        <div className="px-5 py-5 space-y-2">
          <label className="block text-[11px] text-text-tertiary">
            {t('telegramBots.botToken')}
          </label>
          <InlineInput
            type="password"
            value={token}
            onChange={setToken}
            placeholder={t('telegramBots.botTokenHint')}
            autoFocus
            width={400}
          />
          {error && <p className="text-[11px] text-danger">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-border-secondary shrink-0">
          <button
            onClick={handleClose}
            className="px-4 py-1.5 rounded-lg text-xs text-text-secondary hover:bg-bg-hover transition-colors"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={() => void handleSubmit()}
            disabled={adding || !token.trim()}
            className="px-4 py-1.5 rounded-lg text-xs font-medium bg-accent text-white hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {adding ? t('telegramBots.validating') : t('common.add')}
          </button>
        </div>
      </div>
    </div>
  )
}
