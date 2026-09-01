/**
 * BotSessionDialog —— Bot 会话的成员多选，两个场合共用（UI 形态裁决①的对话框半边）：
 *
 *  - **create**：新建会话。成员必须在创建那一刻选定（会话形态由 settings.bots 定死，
 *    建好后不能转），所以这里是唯一的选择时机；项目归属跟随发起的分组，不在框内再选。
 *  - **manage**（A4）：既有会话的成员增删。名单不得清空（≥1）；名单里 md 已被删的
 *    「幽灵成员」以灰行呈现且可取消勾选 —— updateBots 刻意不校验名字，这个对话框
 *    正是名单写坏之后的逃生口。
 *
 * 成员列表由宿主注入的 bots 能力提供（桌面 window.api.bot.list；扩展 v1 无 bot，
 * 不注入即整条入口不渲染）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
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
  /** create = 新建会话（默认）；manage = 既有会话的成员增删 */
  mode?: 'create' | 'manage'
  /** manage：当前名单（预勾选；不在注册表里的名字以幽灵行呈现） */
  initialSelected?: string[]
  /** 发起分组的项目（临时组为 null —— 此时提示成员文件操作落在主目录）。manage 模式不展示 */
  projectId: string | null
  /** 项目显示名（projectId 非空时由宿主查好传入） */
  projectName?: string
  bots: SidebarBotsAdapter
  /**
   * 确认提交（成员按列表序，幽灵成员保持原名单相对位置在尾部）。
   * 返回 null = 成功（对话框自关）；返回错误文案 = 显示并停留。
   */
  onSubmit: (botNames: string[]) => Promise<string | null>
  onClose: () => void
}

export function BotSessionDialog({
  mode = 'create',
  initialSelected,
  projectId,
  projectName,
  bots,
  onSubmit,
  onClose
}: BotSessionDialogProps): React.JSX.Element {
  const { t } = useTranslation()
  const { closing, handleClose } = useDialogClose(onClose)
  // null = 加载中；加载失败按空列表呈现（空态本身就带出路）
  const [items, setItems] = useState<BotPickItem[] | null>(null)
  const [selected, setSelected] = useState<Set<string>>(() => new Set(initialSelected ?? []))
  const [error, setError] = useState<string | null>(null)
  // 视觉禁用态。防重入不靠它：state 在微任务里才 flush，同一同步任务里的第二次点击
  // 既看不到 disabled、闭包里的值也还是 false —— 真守卫是下面的同步 ref
  const [creating, setCreating] = useState(false)
  const creatingRef = useRef(false)

  // 幽灵成员（manage）：名单里有、注册表里没有 —— md 被删了。行仍可取消勾选（移除的逃生口）
  const ghosts = useMemo(() => {
    if (!items || !initialSelected) return []
    const known = new Set(items.map((b) => b.name))
    return initialSelected.filter((n) => !known.has(n))
  }, [items, initialSelected])

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

  const handleSubmit = async (): Promise<void> => {
    if (creatingRef.current || selected.size === 0 || !items) return
    creatingRef.current = true
    setCreating(true)
    setError(null)
    try {
      // 按列表序而非点击序：开场白与后续成员展示都以名单顺序为准，可预期；
      // 仍被勾着的幽灵成员按原名单相对序缀在尾部
      const names = [
        ...items.filter((b) => selected.has(b.name)).map((b) => b.name),
        ...ghosts.filter((n) => selected.has(n))
      ]
      const err = await onSubmit(names)
      if (err !== null) {
        setError(err)
        return
      }
      onClose()
    } catch (e) {
      // onSubmit 抛异常（IPC 拒绝等）与返回错误文案同待遇 —— 没有这条 catch 时
      // 错误框不显示、对话框裸停留、还留一个 unhandled rejection（A4 评审揪出）
      setError(e instanceof Error ? e.message : String(e))
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
            <h3 className="text-sm font-semibold text-text-primary">
              {t(mode === 'manage' ? 'bot.manageTitle' : 'bot.dialogTitle')}
            </h3>
            <p className="text-xs text-text-tertiary mt-0.5">
              {t(mode === 'manage' ? 'bot.manageSubtitle' : 'bot.dialogSubtitle')}
            </p>
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
          ) : items.length === 0 && ghosts.length === 0 ? (
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
          {/* 幽灵成员（manage）：md 已删,仍在名单里。灰行 + 可取消勾选（移除的逃生口） */}
          {items !== null &&
            ghosts.map((name) => {
              const on = selected.has(name)
              return (
                <div
                  key={`ghost:${name}`}
                  role="checkbox"
                  aria-checked={on}
                  data-bot-pick-ghost={name}
                  onClick={() => toggle(name)}
                  className="flex items-center gap-2.5 px-4 py-2 cursor-pointer hover:bg-bg-hover/60 border-b border-border-secondary/30 last:border-b-0 opacity-70"
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
                  <span className="flex-shrink-0 w-5 h-5 rounded-[5px] bg-bg-tertiary flex items-center justify-center text-[10px] font-bold text-text-tertiary select-none">
                    ?
                  </span>
                  <span className="text-[13px] text-text-tertiary line-through flex-shrink-0">
                    {name}
                  </span>
                  <span className="ml-auto text-[11px] text-warning">{t('bot.memberMissing')}</span>
                </div>
              )
            })}
        </div>

        {/* 项目归属 + 无项目提示（仅新建：manage 场合会话归属早已定死） */}
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
          <button
            onClick={() => void handleSubmit()}
            disabled={selected.size === 0 || creating || items === null}
            className="px-4 py-1.5 rounded-lg text-xs font-medium bg-accent text-white hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            data-bot-dialog-create
          >
            {t(mode === 'manage' ? 'bot.manageSave' : 'bot.dialogCreate', { count: selected.size })}
          </button>
        </div>
      </div>
    </div>
  )
}
