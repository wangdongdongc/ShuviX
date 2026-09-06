import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Check, Loader2, MessageSquarePlus, Save, X } from 'lucide-react'
import { LivePreviewEditor, type LivePreviewEditorHandle } from '@shuvix/app-shell'
import { BotAvatar, getChatApi, useChatStore, type BotPageTarget } from '@shuvix/chat-ui'
import { useSettingsStore } from '../../stores/settingsStore'

/**
 * Bot 档案页 —— 主窗口正文里的 bot md 编辑页（原设置页「Bots」tab 的右半边，随列表一起
 * 搬进了侧栏「Bots」分组：点一行，主区就是这一页，同知识库条目 → 笔记本页）。
 *
 * 一页 = 头部（头像 + 显示名 + 文件路径 + 动作）+ 整份 md 的 live-preview 编辑器
 * （frontmatter 由属性卡的 bot 描述符渲染 —— 管线绑定块在卡上是工作流下拉 + 联动的槽位
 * 下拉，管线 / 槽位 / agent 的存在性提示走卡片的校验横幅；正文 = 这个 bot 的人设与记忆，
 * 由 bot 自己维护）。排版走笔记本的那套（layout=notebook：700px 限宽居中 + minimap），
 * 头部按同一列宽对齐。原来页面上那条运行时读数条（管线 / 槽位下拉 / 门控模型 / 正文字数）
 * 已并进卡片或删掉：门控模型是全局设置，去 Agents 设置页改 bot-intent 档案。
 *
 * 与笔记本页**刻意不同的一点：显式保存，不自动落盘**。这份文件有第二个写者 —— bot 在答话
 * 途中会改自己的正文；自动保存意味着编辑器缓冲静默后写胜。保存带 getSource 那一刻的
 * revision 指纹，冲突时把磁盘版本交回来让用户选（加载 / 覆盖），绝不静默后写胜（设计 §8.5）。
 *
 * 三个目标（chatStore.BotPageTarget）：edit（已注册的 bot）/ fix（解析不过的文件，按文件名
 * 认，头部挂解析器的拒绝理由）/ create（模板新建）。fix 修好、create 落盘后都切成 edit
 * 目标（page 按目标 key 重挂）；删除不在这一页 —— 它在侧栏行的菜单里，与会话一致。
 */

type LoadedTarget =
  | { kind: 'edit'; bot: BotInfo; text: string; revision: string }
  // 修复目标的解析器拒绝理由叫 reason 而非 error：加载结果按「有没有 error 键」分流，撞名会把它误判成加载失败
  | { kind: 'fix'; fileName: string; reason: string; text: string }
  | { kind: 'create'; text: string }

export function BotPage({ target }: { target: BotPageTarget }): React.JSX.Element {
  const { t } = useTranslation()
  const [loaded, setLoaded] = useState<LoadedTarget | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  // 重拉原文的递增标记（槽位下拉改了 md 之后编辑器要拿新文本重挂）
  const [reloadNonce, setReloadNonce] = useState(0)

  // 磁盘外删除 / 改名不广播 bot.changed（侧栏靠聚焦重扫兜底），这一页也在同一时机自查：
  // 目标已不在注册表里就挂一条横幅 —— 页面留着不吭声、等到保存才报「不存在」，比一句提示更糟。
  // 只查存在性、不重拉原文：外部改动时重挂编辑器会吞掉用户没保存的编辑
  useEffect(() => {
    if (target.kind === 'create') return undefined
    let alive = true
    const onFocus = (): void => {
      const exists =
        target.kind === 'edit'
          ? window.api.bot.list().then((l) => l.some((b) => b.name === target.name))
          : window.api.bot.listInvalid().then((l) => l.some((f) => f.fileName === target.fileName))
      void exists.then((ok) => {
        if (alive && !ok) setLoadError(t('settings.botPageGone'))
      })
    }
    window.addEventListener('focus', onFocus)
    return () => {
      alive = false
      window.removeEventListener('focus', onFocus)
    }
  }, [target, t])

  useEffect(() => {
    let alive = true
    const load = async (): Promise<LoadedTarget | { error: string }> => {
      if (target.kind === 'edit') {
        const [list, src] = await Promise.all([
          window.api.bot.list(),
          window.api.bot.getSource({ name: target.name })
        ])
        const bot = list.find((b) => b.name === target.name)
        if (!bot) return { error: `Bot "${target.name}" not found` }
        if ('error' in src) return { error: src.error }
        return { kind: 'edit', bot, text: src.text, revision: src.revision }
      }
      if (target.kind === 'fix') {
        const [invalid, src] = await Promise.all([
          window.api.bot.listInvalid(),
          window.api.bot.getSourceByFile({ fileName: target.fileName })
        ])
        if ('error' in src) return { error: src.error }
        const reason = invalid.find((f) => f.fileName === target.fileName)?.error ?? ''
        return { kind: 'fix', fileName: target.fileName, reason, text: src.text }
      }
      const { text } = await window.api.bot.template({ name: 'my-bot' })
      return { kind: 'create', text }
    }
    void load().then((r) => {
      if (!alive) return
      // 错误态随每次回包整体覆盖（重拉成功即清），不在 effect 体里同步清空
      if ('error' in r) {
        setLoaded(null)
        setLoadError(r.error)
      } else {
        setLoaded(r)
        setLoadError(null)
      }
    })
    return () => {
      alive = false
    }
  }, [target, reloadNonce])

  return (
    <div
      className="flex-1 min-h-0 flex flex-col"
      data-bot-page={target.kind}
      // 笔记本页的编辑区底部给悬浮输入卡片让位（--chat-input-h）；这一页没有输入卡片
      style={{ '--chat-input-h': '0px' } as React.CSSProperties}
    >
      {loadError && (
        <div className="px-7 pt-4">
          <div className="max-w-[700px] mx-auto px-3 py-2 rounded-lg bg-red-500/10 text-red-500 text-[11px] whitespace-pre-wrap break-words">
            {loadError}
          </div>
        </div>
      )}
      {!loaded && !loadError && (
        <div className="flex items-center gap-2 px-7 py-6 text-text-tertiary">
          <Loader2 size={14} className="animate-spin" />
          <span className="text-[11px]">{t('common.loading') || 'Loading...'}</span>
        </div>
      )}
      {loaded && (
        <BotEditor
          key={
            loaded.kind === 'edit'
              ? `${loaded.bot.name}:${loaded.revision}`
              : loaded.kind === 'fix'
                ? `fix:${loaded.fileName}`
                : 'create'
          }
          target={loaded}
          onReload={() => setReloadNonce((n) => n + 1)}
          // 常规保存不重挂编辑器，但头部读的是这份 BotInfo（显示名、路径）——
          // 只换它、不动 revision，key 不变
          onBotInfo={(bot) =>
            setLoaded((prev) => (prev?.kind === 'edit' ? { ...prev, bot } : prev))
          }
        />
      )}
    </div>
  )
}

/**
 * md 原文编辑器（frontmatter 属性卡 + live-preview 正文）+ 头部 + 保存守卫。
 * 非受控编辑器，保存时经 handleRef 直取全文（对齐 WorkflowEditor / SubAgentEditor）。
 */
function BotEditor({
  target,
  onReload,
  onBotInfo
}: {
  target: LoadedTarget
  /** 重拉原文并重挂编辑器（冲突后「加载磁盘版本」） */
  onReload: () => void
  /** 常规保存后的最新 BotInfo（名字没变时）—— 父级据此刷新头部，不重挂 */
  onBotInfo: (bot: BotInfo) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const notebookTheme = useSettingsStore((s) => s.notebookTheme)
  const editorRef = useRef<LivePreviewEditorHandle | null>(null)
  const mirror = useRef(target.text)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 丢更新冲突：磁盘上的当前内容（用户选加载 / 覆盖） */
  const [conflict, setConflict] = useState<string | null>(null)
  /** 常规保存成功后更新的指纹 —— 不重挂编辑器（缓冲就是刚落盘的那份），只换对账依据 */
  const [revision, setRevision] = useState(target.kind === 'edit' ? target.revision : '')

  const bot = target.kind === 'edit' ? target.bot : null

  /** 落盘后定位到那一份：改名 / 修好 / 新建之后名字都可能变，按文件路径反查再切目标 */
  const activate = async (fileNameOrPath: string): Promise<void> => {
    const list = await window.api.bot.list()
    const hit = list.find(
      (b) => b.basePath === fileNameOrPath || b.basePath.endsWith(fileNameOrPath)
    )
    if (hit) useChatStore.getState().setActiveBot({ kind: 'edit', name: hit.name })
    else onReload()
  }

  const doSave = async (withRevision: boolean): Promise<void> => {
    const text = editorRef.current?.getMarkdown() ?? mirror.current
    setSaving(true)
    setError(null)
    try {
      // 三条通道分开写：返回形状各不相同（save 带 conflict、create 带 name），
      // 并成联合再窄化只会跟类型系统打架
      if (target.kind === 'edit') {
        const r = await window.api.bot.save({
          originalName: target.bot.name,
          text,
          ...(withRevision ? { revision } : {})
        })
        if (!r.success) {
          if (r.conflict) {
            setConflict(r.conflict.current)
            return
          }
          setError(r.error || t('settings.botSaveFailed'))
          return
        }
        setSaved(true)
        if (r.revision) setRevision(r.revision)
        // 改了 name 的话文件名不变、身份变了：按路径反查新名字并切过去（page 重挂）；
        // 名字没变就只把最新的 BotInfo 交回去（显示名 / warnings 可能变了）
        const list = await window.api.bot.list()
        const hit = list.find((b) => b.basePath === target.bot.basePath)
        if (hit && hit.name !== target.bot.name) {
          useChatStore.getState().setActiveBot({ kind: 'edit', name: hit.name })
        } else if (hit) {
          onBotInfo(hit)
        }
      } else if (target.kind === 'fix') {
        const r = await window.api.bot.saveByFile({ fileName: target.fileName, text })
        if (!r.success) {
          setError(r.error || t('settings.botSaveFailed'))
          return
        }
        setSaved(true)
        // 修好即是一个合法 bot：切成 edit 目标（列表由 bot.changed 事件同步）
        await activate(target.fileName)
      } else {
        const r = await window.api.bot.create({ text })
        if (!r.success) {
          setError(r.error || t('settings.botSaveFailed'))
          return
        }
        setSaved(true)
        if (r.name) useChatStore.getState().setActiveBot({ kind: 'edit', name: r.name })
      }
    } finally {
      setSaving(false)
    }
  }

  /** 和这个 bot 开一个聊天会话，并切过去（离开档案页 —— 用户要的就是去聊） */
  const handleNewSession = async (): Promise<void> => {
    if (!bot) return
    const session = await getChatApi().session.create({ projectId: null, bot: bot.name })
    useChatStore.getState().setSessions(await getChatApi().session.list())
    useChatStore.getState().setActiveSessionId(session.id)
  }

  /** 新建 / 修复是临时态：取消即离开档案页（回到欢迎页，与关掉一个没保存的草稿同义） */
  const handleCancel = (): void => {
    useChatStore.getState().setActiveSessionId(null)
  }

  const transient = target.kind !== 'edit'

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* 头部：与编辑区正文同一列宽（scroller 28px 侧边距 + 700px 限宽居中） */}
      <div className="px-7 pt-4 pb-2">
        <div className="max-w-[700px] mx-auto flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              {bot && <BotAvatar name={bot.name} displayName={bot.displayName} size={20} />}
              <span className="text-sm font-semibold text-text-primary truncate">
                {bot
                  ? bot.displayName
                  : target.kind === 'fix'
                    ? target.fileName
                    : t('sidebar.newBot')}
              </span>
            </div>
            {bot?.basePath && (
              <div className="font-mono text-[10px] text-text-tertiary truncate mt-0.5">
                {bot.basePath}
              </div>
            )}
          </div>
          {bot && (
            <button
              onClick={() => void handleNewSession()}
              className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
              data-bot-new-session
            >
              <MessageSquarePlus size={13} />
              {t('settings.botNewSession')}
            </button>
          )}
          {transient && (
            <button
              onClick={handleCancel}
              className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
              data-bot-cancel
            >
              <X size={13} />
              {t('common.cancel')}
            </button>
          )}
          <button
            onClick={() => void doSave(true)}
            disabled={saving || saved}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-60 ${
              saved ? 'bg-success/20 text-success' : 'bg-accent text-white hover:bg-accent-hover'
            }`}
            data-bot-save
          >
            {saved ? <Check size={13} /> : <Save size={13} />}
            {saved ? t('settings.saved') : t('common.save')}
          </button>
        </div>
      </div>

      {(error || (target.kind === 'fix' && target.reason)) && (
        <div className="px-7 pb-2">
          <div className="max-w-[700px] mx-auto space-y-2">
            {error && (
              <div className="px-3 py-2 rounded-lg bg-red-500/10 text-red-500 text-[11px] whitespace-pre-wrap break-words">
                {error}
              </div>
            )}
            {target.kind === 'fix' && target.reason && (
              // 解析器的拒绝理由：修的就是它，挂在编辑器正上方
              <div
                className="flex items-start gap-1.5 px-3 py-2 rounded-lg bg-amber-500/10 text-amber-500 text-[11px] whitespace-pre-wrap break-words"
                data-bot-invalid-error
              >
                <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                <span>{target.reason}</span>
              </div>
            )}
          </div>
        </div>
      )}

      <LivePreviewEditor
        layout="notebook"
        documentId={
          target.kind === 'fix'
            ? target.fileName
            : `${target.kind === 'edit' ? target.bot.name : 'new-bot'}.md`
        }
        initialContent={target.text}
        onSave={(md) => {
          mirror.current = md
          setSaved(false)
        }}
        handleRef={editorRef}
        caps={{
          notebookTheme,
          openExternal: (url) => void window.api.app.openExternal(url),
          popupContextMenu: (request) => window.api.contextMenu.popup(request)
        }}
      />

      {conflict !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-[440px] max-w-[90vw] bg-bg-primary border border-border-secondary rounded-xl shadow-xl p-5 space-y-4">
            <h3 className="text-sm font-semibold text-text-primary">
              {t('settings.botConflictTitle')}
            </h3>
            <p className="text-xs text-text-secondary leading-relaxed">
              {t('settings.botConflictDesc')}
            </p>
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => setConflict(null)}
                className="px-3 py-1.5 rounded-lg text-xs text-text-secondary hover:bg-bg-hover transition-colors"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={() => {
                  setConflict(null)
                  onReload()
                }}
                className="px-3 py-1.5 rounded-lg text-xs font-medium bg-accent text-white hover:bg-accent-hover transition-colors"
                data-bot-conflict-reload
              >
                {t('settings.botConflictReload')}
              </button>
              <button
                onClick={() => {
                  setConflict(null)
                  void doSave(false)
                }}
                className="px-3 py-1.5 rounded-lg text-xs text-text-tertiary hover:text-red-500 hover:bg-red-500/10 transition-colors"
                data-bot-conflict-overwrite
              >
                {t('settings.botConflictOverwrite')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
