/**
 * BotSessionDialog —— 选一个 bot（单选，点行即选定），两个场合共用：
 *
 *  - **create**：新建聊天会话。bot 必须在创建那一刻选定（会话形态由 settings.bot 定死，
 *    建好后不能转），所以这里是唯一的选择时机；项目归属跟随发起的分组，不在框内再选。
 *  - **bind**：给一个还没绑定 bot 的聊天会话选 bot —— 群聊时代遗留的会话没有做迁移，
 *    靠这里重新选一个（`session.setBot`）。不展示项目区（会话归属早已定死）。
 *
 * 会话是一对一的，所以没有多选、没有成员管理、没有幽灵行：一个会话就一个 bot。
 * bot 列表由宿主注入的 bots 能力提供（桌面 window.api.bot.list；扩展 v1 无 bot，
 * 不注入即整条入口不渲染）。
 */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FolderOpen, X } from 'lucide-react'
import { BotAvatar, useDialogClose } from '@shuvix/chat-ui'

/** 候选行所需的最小字段（桌面 BotInfo 是它的超集，可直接透传） */
export interface BotPickItem {
  name: string
  displayName: string
  description: string
}

/** 宿主注入的 bots 能力（桌面 window.api.bot 的窄投影） */
export interface SidebarBotsAdapter {
  list: () => Promise<BotPickItem[]>
  /** 空态的「打开 Bots 文件夹」；缺省不渲染该按钮 */
  openFolder?: () => Promise<unknown>
}

export interface BotSessionDialogProps {
  /** create = 新建聊天会话（默认）；bind = 给既有会话绑定 bot */
  mode?: 'create' | 'bind'
  /** 发起分组的项目（临时组为 null —— 此时提示 bot 的文件操作落在主目录）。bind 模式不展示 */
  projectId: string | null
  /** 项目显示名（projectId 非空时由宿主查好传入） */
  projectName?: string
  bots: SidebarBotsAdapter
  /**
   * 选定一个 bot。返回 null = 成功（对话框自关）；返回错误文案 = 显示并停留。
   */
  onPick: (botName: string) => Promise<string | null>
  onClose: () => void
}

export function BotSessionDialog({
  mode = 'create',
  projectId,
  projectName,
  bots,
  onPick,
  onClose
}: BotSessionDialogProps): React.JSX.Element {
  const { t } = useTranslation()
  const { closing, handleClose } = useDialogClose(onClose)
  // null = 加载中；加载失败按空列表呈现（空态本身就带出路）
  const [items, setItems] = useState<BotPickItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  // 视觉禁用态。防重入不靠它：state 在微任务里才 flush，同一同步任务里的第二次点击
  // 既看不到 disabled、闭包里的值也还是 false —— 真守卫是下面的同步 ref
  const [picking, setPicking] = useState(false)
  const pickingRef = useRef(false)

  useEffect(() => {
    let alive = true
    bots
      .list()
      .then((list) => {
        if (alive) setItems(list)
      })
      .catch(() => {
        if (alive) setItems([])
      })
    return () => {
      alive = false
    }
  }, [bots])

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') handleClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [handleClose])

  const handlePick = async (name: string): Promise<void> => {
    if (pickingRef.current) return
    pickingRef.current = true
    setPicking(true)
    setError(null)
    try {
      const err = await onPick(name)
      if (err !== null) {
        setError(err)
        return
      }
      onClose()
    } catch (e) {
      // onPick 抛异常（IPC 拒绝等）与返回错误文案同待遇 —— 没有这条 catch 时
      // 错误框不显示、对话框裸停留、还留一个 unhandled rejection
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      pickingRef.current = false
      setPicking(false)
    }
  }

  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center bg-black/40 dialog-overlay${closing ? ' dialog-closing' : ''}`}
      onClick={handleClose}
    >
      <div
        className="w-[420px] max-w-[90vw] bg-bg-primary border border-border-secondary rounded-xl shadow-xl max-h-[80vh] flex flex-col dialog-panel"
        onClick={(e) => e.stopPropagation()}
        data-bot-dialog={mode}
      >
        <div className="flex items-start justify-between px-4 pt-3 pb-2">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-text-primary">
              {t(mode === 'bind' ? 'bot.bindTitle' : 'bot.dialogTitle')}
            </h3>
            <p className="text-xs text-text-tertiary mt-0.5">
              {t(mode === 'bind' ? 'bot.bindSubtitle' : 'bot.dialogSubtitle')}
            </p>
          </div>
          <button
            onClick={handleClose}
            className="p-1 rounded-lg hover:bg-bg-hover text-text-tertiary hover:text-text-primary transition-colors"
          >
            <X size={14} />
          </button>
        </div>

        {/* bot 列表：点行即选定 */}
        <div className="flex-1 min-h-0 overflow-y-auto border-t border-border-secondary/50">
          {items === null ? (
            <div className="px-4 py-6 text-center text-xs text-text-tertiary">…</div>
          ) : items.length === 0 ? (
            <div className="px-4 py-6 flex flex-col items-center gap-3">
              <p className="text-xs text-text-tertiary text-center">{t('bot.dialogEmpty')}</p>
              {bots.openFolder && (
                <button
                  onClick={() => void bots.openFolder?.()}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-bg-secondary border border-border-primary text-text-secondary hover:bg-bg-hover transition-colors"
                >
                  <FolderOpen size={12} />
                  {t('bot.dialogOpenFolder')}
                </button>
              )}
            </div>
          ) : (
            items.map((b) => (
              <button
                key={b.name}
                type="button"
                disabled={picking}
                data-bot-pick={b.name}
                onClick={() => void handlePick(b.name)}
                className="w-full flex items-center gap-2.5 px-4 py-2 text-left cursor-pointer hover:bg-bg-hover/60 border-b border-border-secondary/30 last:border-b-0 disabled:opacity-60 disabled:cursor-wait"
              >
                <BotAvatar name={b.name} displayName={b.displayName} size={20} />
                <span className="text-[13px] text-text-primary flex-shrink-0">{b.displayName}</span>
                {b.description && (
                  <span className="ml-auto text-xs text-text-tertiary truncate max-w-[45%]">
                    {b.description}
                  </span>
                )}
              </button>
            ))
          )}
        </div>

        {/* 项目归属 + 无项目提示（仅新建：bind 场合会话归属早已定死） */}
        {mode === 'create' && (
          <div className="px-4 py-2 border-t border-border-secondary/50 text-xs text-text-tertiary">
            {t('bot.dialogProject')}:{' '}
            <span className="text-text-secondary">{projectName ?? t('bot.dialogNoProject')}</span>
            {projectId === null && (
              <p className="mt-1.5 px-2.5 py-1.5 rounded-md bg-warning/10 text-warning text-[11px] leading-relaxed">
                {t('bot.dialogNoProjectHint')}
              </p>
            )}
          </div>
        )}

        {error && (
          <div className="mx-4 my-2 px-3 py-2 rounded-lg bg-red-500/10 text-red-500 text-[11px] whitespace-pre-wrap break-words">
            {error}
          </div>
        )}

        <div className="px-4 py-3 border-t border-border-secondary/50 bg-bg-secondary/30 flex items-center justify-end gap-2">
          <button
            onClick={handleClose}
            className="px-4 py-1.5 rounded-lg text-xs font-medium bg-bg-secondary border border-border-primary text-text-secondary hover:bg-bg-hover transition-colors"
          >
            {t('common.cancel')}
          </button>
        </div>
      </div>
    </div>
  )
}
