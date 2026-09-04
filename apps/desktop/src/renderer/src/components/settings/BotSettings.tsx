import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertTriangle,
  Check,
  FolderOpen,
  Loader2,
  MessageSquarePlus,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  X
} from 'lucide-react'
import { LivePreviewEditor, type LivePreviewEditorHandle } from '@shuvix/app-shell'
import { BotAvatar, ModelSelect } from '@shuvix/chat-ui'
import { formatModelRef, resolveModelRef } from '@shuvix/chat-protocol/agentModelRef'
import { useSettingsStore } from '../../stores/settingsStore'
import { ConfirmDialog } from '../common/ConfirmDialog'
import {
  patchFrontmatterMappingEntry,
  patchFrontmatterScalar
} from '@shuvix/chat-protocol/utils/frontmatterPatch'
import { BOT_AGENTS_KEY } from '@shuvix/chat-protocol/shuvixMdDescriptors'

/**
 * 设置页顶层「Bots」tab —— 与工作流 / 安全策略 tab 同形：左侧每个 bot 一个子项（**没有
 * 内置 bot**，列表全部来自 ~/.shuvix/bots/），右侧是整份 md 原文编辑器（frontmatter 由
 * 属性卡的 bot 描述符渲染，正文 = 这个 bot 的人设与记忆，由 bot 自己维护）。
 *
 * 比其余 md tab 多三件事（设计 §8.5 / A1）：
 *  - **运行时读数条 + 槽位编辑器**（bot:inspect）：管线按当前注册表解析成什么、管线声明的
 *    每个槽位由哪份 agent 填（下拉直接改 md 的 `shuvix-bot-agents.<槽位>` 行）、门控是否
 *    已 sticky 降级、正文体量 —— 「引用缺失」这类事实埋在 journal 不算呈现;
 *  - **门控模型选择器**：全局设置，写 ~/.shuvix/agents/bot-intent.md 覆盖档案的
 *    shuvix-model 行（设计 §6.1 —— GUI 写覆盖文件，模型链零改动）;
 *  - **保存的丢更新守卫**：bot 会在答话途中改这份文件，save 带 getSource 时的 revision
 *    指纹，冲突时把磁盘版本交回来让用户选（加载 / 覆盖），绝不静默后写胜。
 */

function invalidKeyOf(fileName: string): string {
  return `invalid:${fileName}`
}

type EditTarget = { kind: 'create'; text: string } | { kind: 'fix'; fileName: string; text: string }

export function BotSettings(): React.JSX.Element {
  const { t } = useTranslation()

  const [bots, setBots] = useState<BotInfo[]>([])
  const [invalid, setInvalid] = useState<InvalidBotFile[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [editing, setEditing] = useState<EditTarget | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  /** 选中 bot 的 md 原文 + 版本指纹（save 的丢更新守卫用） */
  const [source, setSource] = useState<{ name: string; text: string; revision: string } | null>(
    null
  )
  const [confirmingDelete, setConfirmingDelete] = useState<string | { fileName: string } | null>(
    null
  )

  const load = useCallback(async (): Promise<BotInfo[]> => {
    const [list, bad] = await Promise.all([window.api.bot.list(), window.api.bot.listInvalid()])
    setBots(list)
    setInvalid(bad)
    setLoading(false)
    return list
  }, [])

  useEffect(() => {
    void load().then((list) => {
      setSelectedKey((cur) => cur ?? (list[0] ? list[0].name : null))
    })
  }, [load])

  const handleRefresh = async (): Promise<void> => {
    setRefreshing(true)
    try {
      const list = await load()
      setSelectedKey((cur) => {
        if (list.some((b) => b.name === cur)) return cur
        return list[0] ? list[0].name : null
      })
    } finally {
      setRefreshing(false)
    }
  }

  const selected = bots.find((b) => b.name === selectedKey) ?? null
  const selectedInvalid = invalid.find((f) => selectedKey === invalidKeyOf(f.fileName)) ?? null

  // 选中项变化 → 拉 md 原文与指纹
  useEffect(() => {
    if (!selected) {
      setSource(null)
      return undefined
    }
    const name = selected.name
    let alive = true
    setLoadError(null)
    void window.api.bot.getSource({ name }).then((r) => {
      if (!alive) return
      if ('error' in r) {
        setSource(null)
        setLoadError(r.error)
        return
      }
      setSource({ name, text: r.text, revision: r.revision })
    })
    return () => {
      alive = false
    }
  }, [selected])

  const openInvalidEditor = async (fileName: string): Promise<void> => {
    const r = await window.api.bot.getSourceByFile({ fileName })
    if ('error' in r) {
      setLoadError(r.error)
      return
    }
    setEditing({ kind: 'fix', fileName, text: r.text })
  }

  const handleCreate = async (): Promise<void> => {
    const { text } = await window.api.bot.template({ name: 'my-bot' })
    setEditing({ kind: 'create', text })
  }

  /** 保存成功后重扫并选中落盘的那一份（改名 / 新建 / 修好后仍定位得到） */
  const afterSaved = async (name: string, fileName?: string): Promise<void> => {
    setEditing(null)
    setSource(null)
    const list = await load()
    const hit = fileName
      ? list.find((b) => b.basePath.endsWith(fileName))
      : list.find((b) => b.name === name)
    setSelectedKey(hit ? hit.name : (list[0]?.name ?? null))
  }

  const handleDelete = async (target: string | { fileName: string }): Promise<void> => {
    setConfirmingDelete(null)
    const r =
      typeof target === 'string'
        ? await window.api.bot.delete({ name: target })
        : await window.api.bot.deleteByFile({ fileName: target.fileName })
    if (!r.success) return
    const list = await load()
    setSelectedKey(list[0] ? list[0].name : null)
  }

  return (
    <div className="flex flex-1 min-h-0 h-full">
      {/* 左侧：bot 列表（无内置） */}
      <div className="w-[240px] flex-shrink-0 border-r border-border-secondary flex flex-col">
        <div className="flex-1 overflow-y-auto py-2 px-2 space-y-0.5">
          {loading ? (
            <div className="flex items-center gap-2 text-text-tertiary py-2 px-1">
              <Loader2 size={14} className="animate-spin" />
              <span className="text-[11px]">{t('common.loading') || 'Loading...'}</span>
            </div>
          ) : (
            <>
              {bots.map((bot) => (
                <button
                  key={bot.name}
                  onClick={() => setSelectedKey(bot.name)}
                  className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left transition-colors ${
                    selectedKey === bot.name
                      ? 'bg-accent/10 text-accent'
                      : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
                  }`}
                  data-bot-row={bot.name}
                >
                  <BotAvatar name={bot.name} displayName={bot.displayName} size={18} />
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium truncate text-text-primary">
                      {bot.displayName}
                    </div>
                    <div className="text-[10px] text-text-tertiary truncate">{bot.description}</div>
                  </div>
                </button>
              ))}
              {invalid.length > 0 && (
                <div className="pt-2">
                  <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-amber-500/80">
                    {t('settings.botInvalidGroup', { count: invalid.length })}
                  </div>
                  {invalid.map((f) => (
                    <button
                      key={f.fileName}
                      onClick={() => setSelectedKey(invalidKeyOf(f.fileName))}
                      className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left transition-colors ${
                        selectedKey === invalidKeyOf(f.fileName)
                          ? 'bg-amber-500/10 text-amber-500'
                          : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
                      }`}
                    >
                      <AlertTriangle size={14} className="shrink-0 text-amber-500" />
                      <span className="min-w-0 flex-1 text-xs font-mono truncate">
                        {f.fileName}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        <div className="border-t border-border-secondary p-2 flex items-center gap-1.5">
          <button
            onClick={() => void handleCreate()}
            title={t('settings.botNew')}
            className="flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg border border-dashed border-border-secondary text-[11px] text-text-secondary hover:text-text-primary hover:border-accent/40 hover:bg-accent/5 transition-colors"
            data-bot-new
          >
            <Plus size={12} />
            {t('settings.botNew')}
          </button>
          <button
            onClick={() => void window.api.bot.openFolder()}
            title={t('settings.botFsHint')}
            className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg border border-dashed border-border-secondary text-[11px] text-text-secondary hover:text-text-primary hover:border-accent/40 hover:bg-accent/5 transition-colors"
          >
            <FolderOpen size={12} />
            {t('bot.dialogOpenFolder')}
          </button>
          <button
            onClick={() => void handleRefresh()}
            disabled={refreshing}
            title={t('common.refresh')}
            className="px-2 py-1.5 rounded-lg border border-dashed border-border-secondary text-text-secondary hover:text-text-primary hover:border-accent/40 hover:bg-accent/5 transition-colors disabled:opacity-50"
          >
            <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* 右侧：编辑器 / 非法文件详情 */}
      <div className="flex-1 min-w-0 flex flex-col min-h-0 overflow-y-auto">
        {editing ? (
          <BotEditor
            key={editing.kind === 'fix' ? editing.fileName : '__new__'}
            target={editing}
            onCancel={() => setEditing(null)}
            onSaved={afterSaved}
          />
        ) : selectedInvalid ? (
          <div className="p-4 space-y-3">
            <div className="flex items-center gap-2">
              <AlertTriangle size={16} className="text-amber-500" />
              <span className="text-sm font-semibold text-text-primary font-mono">
                {selectedInvalid.fileName}
              </span>
            </div>
            <div className="px-3 py-2 rounded-lg bg-amber-500/10 text-amber-500 text-[11px] whitespace-pre-wrap break-words">
              {selectedInvalid.error}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => void openInvalidEditor(selectedInvalid.fileName)}
                className="px-3 py-1.5 rounded-lg text-xs font-medium bg-accent text-white hover:bg-accent-hover transition-colors"
              >
                {t('common.clickToEdit')}
              </button>
              <button
                onClick={() => setConfirmingDelete({ fileName: selectedInvalid.fileName })}
                className="px-3 py-1.5 rounded-lg text-xs text-text-tertiary hover:text-red-500 hover:bg-red-500/10 transition-colors"
              >
                {t('common.delete')}
              </button>
            </div>
          </div>
        ) : (
          selected && (
            <>
              {loadError && (
                <div className="mx-4 mt-4 px-3 py-2 rounded-lg bg-red-500/10 text-red-500 text-[11px] whitespace-pre-wrap break-words">
                  {loadError}
                </div>
              )}
              {source?.name === selected.name && (
                <BotEditor
                  key={`${source.name}:${source.revision}`}
                  target={{
                    kind: 'edit',
                    bot: selected,
                    text: source.text,
                    revision: source.revision
                  }}
                  onSaved={afterSaved}
                  onReload={() => {
                    // 冲突后选「加载磁盘版本」：重拉原文与指纹（key 变化触发编辑器重挂）
                    setSource(null)
                    void window.api.bot.getSource({ name: selected.name }).then((r) => {
                      if ('error' in r) setLoadError(r.error)
                      else setSource({ name: selected.name, text: r.text, revision: r.revision })
                    })
                  }}
                  onDelete={() => setConfirmingDelete(selected.name)}
                />
              )}
            </>
          )
        )}
      </div>

      {confirmingDelete && (
        <ConfirmDialog
          title={t('settings.botDeleteConfirmTitle')}
          description={
            typeof confirmingDelete === 'string'
              ? t('settings.botDeleteConfirmDesc', { name: confirmingDelete })
              : t('settings.botDeleteFileConfirmDesc', { name: confirmingDelete.fileName })
          }
          confirmText={t('common.delete')}
          cancelText={t('common.cancel')}
          onConfirm={() => void handleDelete(confirmingDelete)}
          onCancel={() => setConfirmingDelete(null)}
        />
      )}
    </div>
  )
}

type EditorTarget = EditTarget | { kind: 'edit'; bot: BotInfo; text: string; revision: string }

/**
 * md 原文编辑器（frontmatter 属性卡 + live-preview 正文）+ 运行时读数条 + 保存守卫。
 * 非受控编辑器，保存时经 handleRef 直取全文（对齐 WorkflowEditor / SubAgentEditor）。
 */
function BotEditor({
  target,
  onCancel,
  onSaved,
  onReload,
  onDelete
}: {
  target: EditorTarget
  onCancel?: () => void
  onSaved: (name: string, fileName?: string) => Promise<void>
  /** 冲突后「加载磁盘版本」（仅 edit 态） */
  onReload?: () => void
  onDelete?: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const editorRef = useRef<LivePreviewEditorHandle | null>(null)
  const mirror = useRef(target.text)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 丢更新冲突：磁盘上的当前内容（用户选加载 / 覆盖） */
  const [conflict, setConflict] = useState<string | null>(null)
  const [sessionCreated, setSessionCreated] = useState(false)

  const doSave = async (withRevision: boolean): Promise<void> => {
    const text = editorRef.current?.getMarkdown() ?? mirror.current
    setSaving(true)
    setError(null)
    try {
      // 三条通道分开写：返回形状各不相同（save 带 conflict、create 带 name），
      // 并成联合再窄化只会跟类型系统打架
      let savedName = ''
      if (target.kind === 'edit') {
        const r = await window.api.bot.save({
          originalName: target.bot.name,
          text,
          ...(withRevision ? { revision: target.revision } : {})
        })
        if (!r.success) {
          if (r.conflict) {
            setConflict(r.conflict.current)
            return
          }
          setError(r.error || t('settings.botSaveFailed'))
          return
        }
        savedName = target.bot.name
      } else if (target.kind === 'fix') {
        const r = await window.api.bot.saveByFile({ fileName: target.fileName, text })
        if (!r.success) {
          setError(r.error || t('settings.botSaveFailed'))
          return
        }
      } else {
        const r = await window.api.bot.create({ text })
        if (!r.success) {
          setError(r.error || t('settings.botSaveFailed'))
          return
        }
        savedName = r.name ?? ''
      }
      setSaved(true)
      await onSaved(savedName, target.kind === 'fix' ? target.fileName : undefined)
    } finally {
      setSaving(false)
    }
  }

  const handleNewSession = async (): Promise<void> => {
    if (target.kind !== 'edit') return
    await window.api.session.create({ bots: [target.bot.name] })
    // 主窗口经 session.listChanged 自动刷新；设置窗给一个瞬时回执即可
    setSessionCreated(true)
    setTimeout(() => setSessionCreated(false), 2500)
  }

  const bot = target.kind === 'edit' ? target.bot : null

  return (
    <div className="flex flex-col min-h-0">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border-secondary">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            {bot && <BotAvatar name={bot.name} displayName={bot.displayName} size={20} />}
            <span className="text-sm font-semibold text-text-primary truncate">
              {bot
                ? bot.displayName
                : target.kind === 'fix'
                  ? target.fileName
                  : t('settings.botNew')}
            </span>
          </div>
          {bot?.basePath ? (
            <div className="font-mono text-[10px] text-text-tertiary truncate mt-0.5">
              {bot.basePath}
            </div>
          ) : (
            <div className="text-[10px] text-text-tertiary mt-0.5">{t('settings.botEditHint')}</div>
          )}
        </div>
        {bot && (
          <button
            onClick={() => void handleNewSession()}
            className={`flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs transition-colors ${
              sessionCreated
                ? 'text-success'
                : 'text-text-secondary hover:text-text-primary hover:bg-bg-hover'
            }`}
            data-bot-new-session
          >
            {sessionCreated ? <Check size={13} /> : <MessageSquarePlus size={13} />}
            {sessionCreated ? t('settings.botSessionCreated') : t('settings.botNewSession')}
          </button>
        )}
        {onCancel && (
          <button
            onClick={onCancel}
            className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
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
        {onDelete && (
          <button
            onClick={onDelete}
            title={t('settings.botDeleteConfirmTitle')}
            className="p-1.5 rounded-lg text-text-tertiary hover:text-red-500 hover:bg-red-500/10 transition-colors"
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>

      {error && (
        <div className="mx-4 mt-3 px-3 py-2 rounded-lg bg-red-500/10 text-red-500 text-[11px] whitespace-pre-wrap break-words">
          {error}
        </div>
      )}

      {bot && target.kind === 'edit' && (
        <InspectStrip
          name={bot.name}
          warnings={bot.warnings}
          revision={target.revision}
          getText={() => editorRef.current?.getMarkdown() ?? mirror.current}
          onSaved={() => onSaved(bot.name)}
          onConflict={(current) => setConflict(current)}
        />
      )}

      <div className="min-h-[320px] p-2">
        <LivePreviewEditor
          layout="fill"
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
        />
      </div>

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
                  onReload?.()
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

/**
 * 运行时读数条 + 槽位编辑器：管线的解析结果、每个槽位填的 agent（下拉可改）、门控降级、
 * 正文体量 + 门控模型选择器。数据来自 bot:inspect（按当前注册表现算）；frontmatter 的
 * 身份三项归下方属性卡，这里不重复。
 *
 * 槽位下拉**改的是 md 原文**（`shuvix-bot-agents.<槽位>` 那一行）：取编辑器里的当前全文
 * 打补丁再 `bot:save`，所以用户没保存的正文改动一并落盘、不会丢；带 revision 指纹，
 * 撞上 bot 自己的改动时走与保存按钮同一个冲突对话框。
 */
function InspectStrip({
  name,
  warnings,
  revision,
  getText,
  onSaved,
  onConflict
}: {
  name: string
  warnings: string[]
  revision: string
  /** 编辑器里的当前全文（非受控编辑器，保存时直取） */
  getText: () => string
  onSaved: () => Promise<void>
  onConflict: (current: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [data, setData] = useState<BotInspect | null>(null)
  const [agents, setAgents] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void Promise.all([window.api.bot.inspect({ name }), window.api.subAgent.list()]).then(
      ([r, list]) => {
        if (!alive) return
        if (!('error' in r)) setData(r)
        // list 是合并语义（用户覆盖生效）；被遮蔽的内置条目带 overridden，跳过
        setAgents(list.filter((a) => !a.overridden).map((a) => a.name))
      }
    )
    return () => {
      alive = false
    }
  }, [name])

  const setSlot = async (role: string, ref: string): Promise<void> => {
    setError(null)
    const text = patchFrontmatterMappingEntry(getText(), BOT_AGENTS_KEY, role, ref || null)
    const r = await window.api.bot.save({ originalName: name, text, revision })
    if (!r.success) {
      if (r.conflict) onConflict(r.conflict.current)
      else setError(r.error || t('settings.botSaveFailed'))
      return
    }
    await onSaved()
  }

  if (!data) return <></>

  const problems: string[] = []
  if (!data.pipeline.exists)
    problems.push(t('settings.botPipelineMissing', { name: data.pipeline.name }))
  if (data.pipeline.exists && data.pipeline.concurrency && data.pipeline.concurrency !== 'parallel')
    problems.push(t('settings.botReentryWarn', { mode: data.pipeline.concurrency }))
  for (const s of data.slots) {
    if (s.required && !s.ref) problems.push(t('settings.botSlotMissingRequired', { role: s.role }))
    else if (s.missing) problems.push(`${s.role}: ${t('settings.botStageMissing', { ref: s.ref })}`)
  }
  if (data.gateDegraded) problems.push(t('settings.botGateDegraded', { reason: data.gateDegraded }))
  // 解析器「接受但有话说」的提示一并进问题区 —— 它们同样是「跑起来会不一样」的事实
  problems.push(...warnings)

  return (
    <div
      className="mx-4 mt-3 rounded-lg border border-border-secondary/60 bg-bg-secondary/30 px-3.5 py-2.5 space-y-1.5"
      data-bot-inspect
    >
      <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[11px]">
        <span className="text-text-tertiary">{t('settings.botInspectPipeline')}</span>
        <span className="font-mono text-text-secondary">
          {data.pipeline.name}
          {data.pipeline.concurrency ? ` · ${data.pipeline.concurrency}` : ''}
        </span>
        <span className="text-text-tertiary" title={t('settings.botSlotHint')}>
          {t('settings.botInspectSlots')}
        </span>
        <div className="space-y-1" data-bot-slots={data.slots.length}>
          {data.slots.map((s) => (
            <label
              key={s.role}
              className="flex items-center gap-2"
              title={s.description ?? ''}
              data-bot-slot={s.role}
            >
              <span className="font-mono text-text-secondary w-16 shrink-0 truncate">
                {s.role}
                {s.required && <span className="text-text-tertiary"> *</span>}
              </span>
              <select
                value={s.ref ?? ''}
                onChange={(e) => void setSlot(s.role, e.target.value)}
                className={`min-w-0 flex-1 max-w-[260px] rounded border bg-bg-primary px-1.5 py-0.5 text-[11px] focus:border-accent/50 focus:outline-none ${
                  (s.required && !s.ref) || s.missing
                    ? 'border-warning/60 text-warning'
                    : 'border-border-secondary text-text-secondary'
                }`}
                data-bot-slot-select={s.role}
              >
                <option value="">{t('settings.botSlotUnset')}</option>
                {/* 填了一个已经不存在的名字：仍列出来，否则下拉会静默显示成别的值 */}
                {s.ref && !agents.includes(s.ref) && <option value={s.ref}>{s.ref}</option>}
                {agents.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
        <span className="text-text-tertiary">{t('settings.botInspectBody')}</span>
        <span className="text-text-secondary" data-bot-body-chars={data.body.chars}>
          {t('settings.botBodyChars', { chars: data.body.chars })}
        </span>
      </div>
      {/* 门控模型选择器：仅当 intent 槽位指向内置 bot-intent（换了自定义门控就改那个 agent 去） */}
      {data.slots.some((s) => s.role === 'intent' && s.ref === 'bot-intent') && <GateModelRow />}
      {error && <div className="text-[11px] text-error">{error}</div>}
      {problems.length > 0 && (
        <div className="space-y-0.5 pt-1" data-bot-inspect-warnings={problems.length}>
          {problems.map((p, i) => (
            <div key={i} className="flex items-start gap-1.5 text-[11px] text-warning">
              <AlertTriangle size={11} className="mt-0.5 shrink-0" />
              <span className="break-words">{p}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * 门控模型（全局）：读 bot-intent 档案（用户覆盖优先）的 shuvix-model，改动写回
 * ~/.shuvix/agents/bot-intent.md 覆盖文件（无覆盖文件则从内置原文创建一份再写）。
 */
function GateModelRow(): React.JSX.Element {
  const { t } = useTranslation()
  const availableModels = useSettingsStore((s) => s.availableModels)
  const [ref, setRef] = useState<string | null | undefined>(undefined) // undefined = 加载中
  const [error, setError] = useState<string | null>(null)

  const loadCurrent = useCallback(
    (): Promise<void> =>
      window.api.subAgent.list().then((list) => {
        // list 是合并语义（用户覆盖生效）；被遮蔽的内置条目带 overridden，跳过
        const item = list.find((a) => a.name === 'bot-intent' && !a.overridden)
        setRef(item?.model ?? null)
      }),
    []
  )

  useEffect(() => {
    void loadCurrent()
  }, [loadCurrent])

  const write = async (nextRef: string): Promise<void> => {
    setError(null)
    const list = await window.api.subAgent.list()
    const hasUser = list.some((a) => a.name === 'bot-intent' && a.source === 'user')
    const src = await window.api.subAgent.getSource({
      name: 'bot-intent',
      source: hasUser ? 'user' : 'builtin'
    })
    if ('error' in src) {
      setError(src.error)
      return
    }
    const text = patchFrontmatterScalar(src.text, 'shuvix-model', nextRef || null)
    const r = hasUser
      ? await window.api.subAgent.saveSource({ originalName: 'bot-intent', text })
      : await window.api.subAgent.createSource({ text })
    if (!r.success) {
      setError(r.error ?? t('settings.botSaveFailed'))
      return
    }
    await loadCurrent()
  }

  const resolved = ref ? resolveModelRef(ref, availableModels) : undefined

  return (
    <div className="flex items-center gap-3 pt-1" data-bot-gate-model>
      <div className="min-w-0">
        <div className="text-[11px] text-text-tertiary">{t('settings.botGateModel')}</div>
        <div className="text-[10px] text-text-tertiary/70">{t('settings.botGateModelHint')}</div>
      </div>
      <div className="ml-auto">
        {ref !== undefined && (
          <ModelSelect
            availableModels={availableModels}
            provider={resolved?.providerId ?? ''}
            model={resolved?.modelId ?? ref ?? ''}
            onChange={(p, m) => void write(formatModelRef(p, m))}
            width={220}
            placeholder={t('settings.botGateModelFollow')}
            allowClear
            clearLabel={t('settings.botGateModelFollow')}
          />
        )}
      </div>
      {error && <span className="text-[10px] text-error">{error}</span>}
    </div>
  )
}
