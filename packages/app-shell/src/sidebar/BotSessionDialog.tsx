/**
 * BotSessionDialog —— 新建 Bot 会话的成员多选（UI 形态裁决①的对话框半边）。
 *
 * 成员必须在创建那一刻选定（会话形态由 settings.bots 定死，建好后不能转），所以这里
 * 是唯一的选择时机。成员列表由宿主注入的 bots 能力提供（桌面 window.api.bot.list；
 * 扩展 v1 无 bot，不注入即整条入口不渲染）；项目归属跟随发起的分组，不在框内再选。
 */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, FolderOpen, X } from 'lucide-react'
import { BotAvatar, useDialogClose } from '@shuvix/chat-ui'

/** 成员多选行所需的最小字段（桌面 BotInfo 是它的超集，可直接透传） */
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
  /** 发起分组的项目（临时组为 null —— 此时提示成员文件操作落在主目录） */
  projectId: string | null
  /** 项目显示名（projectId 非空时由宿主查好传入） */
  projectName?: string
  bots: SidebarBotsAdapter
  /** 确认创建（成员按列表序）；resolve 后对话框自关 */
  onCreate: (botNames: string[]) => Promise<void>
  onClose: () => void
}

export function BotSessionDialog({
  projectId,
  projectName,
  bots,
  onCreate,
  onClose
}: BotSessionDialogProps): React.JSX.Element {
  const { t } = useTranslation()
  const { closing, handleClose } = useDialogClose(onClose)
  // null = 加载中；加载失败按空列表呈现（空态本身就带出路）
  const [items, setItems] = useState<BotPickItem[] | null>(null)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  // 视觉禁用态。防重入不靠它：state 在微任务里才 flush，同一同步任务里的第二次点击
  // 既看不到 disabled、闭包里的值也还是 false —— 真守卫是下面的同步 ref
  const [creating, setCreating] = useState(false)
  const creatingRef = useRef(false)

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

  const toggle = (name: string): void =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })

  const handleCreate = async (): Promise<void> => {
    if (creatingRef.current || selected.size === 0 || !items) return
    creatingRef.current = true
    setCreating(true)
    try {
      // 按列表序而非点击序：开场白与后续成员展示都以名单顺序为准，可预期
      await onCreate(items.filter((b) => selected.has(b.name)).map((b) => b.name))
      onClose()
    } finally {
      creatingRef.current = false
      setCreating(false)
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
        data-bot-dialog
      >
        <div className="flex items-start justify-between px-4 pt-3 pb-2">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-text-primary">{t('bot.dialogTitle')}</h3>
            <p className="text-xs text-text-tertiary mt-0.5">{t('bot.dialogSubtitle')}</p>
          </div>
          <button
            onClick={handleClose}
            className="p-1 rounded-lg hover:bg-bg-hover text-text-tertiary hover:text-text-primary transition-colors"
          >
            <X size={14} />
          </button>
        </div>

        {/* 成员列表 */}
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
            items.map((b) => {
              const on = selected.has(b.name)
              return (
                <div
                  key={b.name}
                  role="checkbox"
                  aria-checked={on}
                  data-bot-pick={b.name}
                  onClick={() => toggle(b.name)}
                  className="flex items-center gap-2.5 px-4 py-2 cursor-pointer hover:bg-bg-hover/60 border-b border-border-secondary/30 last:border-b-0"
                >
                  <span
                    className={`flex-shrink-0 w-[15px] h-[15px] rounded flex items-center justify-center border transition-colors ${
                      on
                        ? 'bg-accent border-accent text-white'
                        : 'border-border-primary text-transparent'
                    }`}
                  >
                    <Check size={11} strokeWidth={3} />
                  </span>
                  <BotAvatar name={b.name} displayName={b.displayName} size={20} />
                  <span className="text-[13px] text-text-primary flex-shrink-0">
                    {b.displayName}
                  </span>
                  {b.description && (
                    <span className="ml-auto text-xs text-text-tertiary truncate max-w-[45%]">
                      {b.description}
                    </span>
                  )}
                </div>
              )
            })
          )}
        </div>

        {/* 项目归属 + 无项目提示 */}
        <div className="px-4 py-2 border-t border-border-secondary/50 text-xs text-text-tertiary">
          {t('bot.dialogProject')}:{' '}
          <span className="text-text-secondary">{projectName ?? t('bot.dialogNoProject')}</span>
          {projectId === null && (
            <p className="mt-1.5 px-2.5 py-1.5 rounded-md bg-warning/10 text-warning text-[11px] leading-relaxed">
              {t('bot.dialogNoProjectHint')}
            </p>
          )}
        </div>

        <div className="px-4 py-3 border-t border-border-secondary/50 bg-bg-secondary/30 flex items-center justify-end gap-2">
          <button
            onClick={handleClose}
            className="px-4 py-1.5 rounded-lg text-xs font-medium bg-bg-secondary border border-border-primary text-text-secondary hover:bg-bg-hover transition-colors"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={() => void handleCreate()}
            disabled={selected.size === 0 || creating || items === null}
            className="px-4 py-1.5 rounded-lg text-xs font-medium bg-accent text-white hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            data-bot-dialog-create
          >
            {t('bot.dialogCreate', { count: selected.size })}
          </button>
        </div>
      </div>
    </div>
  )
}
