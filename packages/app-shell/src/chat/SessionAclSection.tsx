/**
 * 会话权限表卡（「文件访问」）—— 这条会话的智能体免询问读写哪些路径，一条一行（形状与规则见
 * chat-protocol 的 sessionAcl.ts）。桌面与手机共用同一个组件。会话种类的行（它免询问查看 / 对话的别的会话）
 * 另起一卡「会话访问」，有行才出现 —— 那些行只来自询问卡片上的「允许并记住」，可以在查看与对话之间切换、删掉。
 *
 * 行的排法：工作目录、笔记本文档、你授予的、widget 目录在前，总是摆出来；知识库、技能目录与会话自己的目录
 * （临时目录、产物、工具结果）来自会话设置、用户不用管，收在「显示另外 N 项」后面。
 *
 * 能做的事跟着行的来源走（canChangeAclAccess / canRemoveAclEntry）：工作目录、笔记本文档、授予的行能在
 * 只读 / 读写之间切换；授予的行能删；其余派生行只读地摆着，悬停说它跟着会话设置走。底部「添加路径」手动
 * 授予一条（来源 user），桌面上还能用文件夹选择框。
 *
 * 数据现取（`session.listAcl` —— 主进程先按此刻的设置对账再回），`session.configChanged` 时重取。
 */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  FileText,
  FolderOpen,
  HardDrive,
  KeyRound,
  LayoutGrid,
  Library,
  MessagesSquare,
  Plus,
  Sparkles,
  X
} from 'lucide-react'
import { getChatApi, getHostApi, useAppEvent } from '@shuvix/chat-ui'
import { KNOWLEDGE_BUILTIN_BASE } from '@shuvix/chat-protocol/knowledge'
import {
  canChangeAclAccess,
  canRemoveAclEntry,
  type AclEntry,
  type AclSource,
  type PathAccess
} from '@shuvix/chat-protocol/sessionAcl'
import { SegmentedControl, SettingsSection } from '../settings/SettingsPrimitives'

/** 摆在前面、总是可见的来源 */
const PROMINENT: readonly AclSource[] = ['workdir', 'document', 'user', 'widget']

/** 界面上的顺序 */
const SOURCE_ORDER: readonly AclSource[] = [
  'workdir',
  'document',
  'user',
  'widget',
  'knowledge',
  'skill',
  'system'
]

const SOURCE_ICONS: Record<AclSource, typeof FolderOpen> = {
  workdir: FolderOpen,
  document: FileText,
  user: KeyRound,
  widget: LayoutGrid,
  knowledge: Library,
  skill: Sparkles,
  system: HardDrive
}

/** 按来源排序（同一来源内保持主进程给的顺序 —— Array.prototype.sort 是稳定排序） */
export function sortAclEntries(entries: readonly AclEntry[]): AclEntry[] {
  return [...entries].sort(
    (a, b) => SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source)
  )
}

function AclRow({
  entry,
  onAccess,
  onRemove
}: {
  entry: AclEntry
  onAccess: (access: PathAccess) => void
  onRemove: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const Icon = SOURCE_ICONS[entry.source]
  const label = (() => {
    switch (entry.source) {
      case 'system':
        return t(`sessionAcl.source.${entry.sourceKey}`, { defaultValue: entry.sourceKey })
      case 'knowledge':
        return t('sessionAcl.source.knowledge', {
          name:
            entry.sourceKey === KNOWLEDGE_BUILTIN_BASE
              ? t('knowledge.builtinBaseName')
              : entry.sourceKey
        })
      case 'widget':
        return t('sessionAcl.source.widget', { name: entry.sourceKey })
      default:
        return t(`sessionAcl.source.${entry.source}`)
    }
  })()
  const changeable = canChangeAclAccess(entry)
  const removable = canRemoveAclEntry(entry)

  return (
    <div
      data-acl-entry={entry.id}
      data-acl-source={entry.source}
      data-acl-access={entry.access}
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2"
    >
      <div
        className="flex min-w-0 flex-1 basis-48 items-center gap-2.5"
        title={changeable || removable ? undefined : t('sessionAcl.managed')}
      >
        <Icon size={13} className="shrink-0 text-text-tertiary" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] text-text-primary">{label}</div>
          {/* 长路径从左边截：结尾（文件夹名）才是认得出的那一段 */}
          <div
            title={entry.target}
            className="truncate text-left font-mono text-[11px] text-text-tertiary [direction:rtl]"
          >
            <bdi>{entry.target}</bdi>
          </div>
        </div>
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        {changeable ? (
          <SegmentedControl<PathAccess>
            value={entry.access}
            onChange={(next) => next !== entry.access && onAccess(next)}
            options={[
              { value: 'read', label: t('sessionAcl.read') },
              { value: 'write', label: t('sessionAcl.write') }
            ]}
          />
        ) : (
          <span className="px-1 text-[11px] text-text-tertiary">
            {t(entry.access === 'write' ? 'sessionAcl.write' : 'sessionAcl.read')}
          </span>
        )}
        {removable && (
          <button
            type="button"
            onClick={onRemove}
            title={t('sessionAcl.remove')}
            aria-label={t('sessionAcl.remove')}
            data-acl-remove=""
            className="rounded p-1 text-text-tertiary transition-colors hover:bg-bg-hover hover:text-red-500"
          >
            <X size={12} />
          </button>
        )}
      </div>
    </div>
  )
}

/** 会话种类的一行：目标会话的标题与 id，查看 / 对话，删除 */
function SessionAclRow({
  entry,
  onAccess,
  onRemove
}: {
  entry: AclEntry
  onAccess: (access: PathAccess) => void
  onRemove: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div
      data-acl-entry={entry.id}
      data-acl-kind="session"
      data-acl-target={entry.target}
      data-acl-access={entry.access}
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2"
    >
      <div className="flex min-w-0 flex-1 basis-48 items-center gap-2.5">
        <MessagesSquare size={13} className="shrink-0 text-text-tertiary" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] text-text-primary">
            {entry.targetTitle || t('sessionAcl.sessionUntitled')}
          </div>
          <div className="truncate font-mono text-[11px] text-text-tertiary">{entry.target}</div>
        </div>
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <SegmentedControl<PathAccess>
          value={entry.access}
          onChange={(next) => next !== entry.access && onAccess(next)}
          options={[
            { value: 'read', label: t('sessionAcl.sessionRead') },
            { value: 'write', label: t('sessionAcl.sessionWrite') }
          ]}
        />
        <button
          type="button"
          onClick={onRemove}
          title={t('sessionAcl.remove')}
          aria-label={t('sessionAcl.remove')}
          data-acl-remove=""
          className="rounded p-1 text-text-tertiary transition-colors hover:bg-bg-hover hover:text-red-500"
        >
          <X size={12} />
        </button>
      </div>
    </div>
  )
}

/** 手动授予一条路径（来源 user）：路径输入 + 只读 / 读写 + 添加；宿主有文件夹选择框时多一个「选择文件夹」 */
function AclAddRow({
  sessionId,
  onAdded
}: {
  sessionId: string
  onAdded: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [path, setPath] = useState('')
  const [access, setAccess] = useState<PathAccess>('read')
  const [failed, setFailed] = useState(false)
  const pickFolder = getHostApi()?.app.openDirectoryDialog

  const reset = (): void => {
    setOpen(false)
    setPath('')
    setAccess('read')
    setFailed(false)
  }

  const submit = async (): Promise<void> => {
    const target = path.trim()
    if (!target) return
    const result = await getChatApi().session.grantAcl({ id: sessionId, target, access })
    if (!result.success) {
      setFailed(true)
      return
    }
    reset()
    onAdded()
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-acl-add=""
        className="flex w-full items-center gap-2 px-4 py-2 text-left text-[12px] text-text-secondary transition-colors hover:bg-bg-hover/60 hover:text-text-primary"
      >
        <Plus size={13} />
        {t('sessionAcl.add')}
      </button>
    )
  }

  return (
    <div className="space-y-2 px-4 py-3" data-acl-add-form="">
      <input
        autoFocus
        value={path}
        onChange={(e) => {
          setPath(e.target.value)
          setFailed(false)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) void submit()
          if (e.key === 'Escape') {
            e.stopPropagation()
            reset()
          }
        }}
        placeholder={t('sessionAcl.addPlaceholder')}
        spellCheck={false}
        className="w-full rounded-md border border-border-secondary bg-bg-primary px-2.5 py-1.5 font-mono text-[12px] text-text-primary outline-none focus:border-accent"
      />
      {failed && <div className="text-[11px] text-red-500">{t('sessionAcl.addFailed')}</div>}
      <div className="flex flex-wrap items-center gap-2">
        <SegmentedControl<PathAccess>
          value={access}
          onChange={setAccess}
          options={[
            { value: 'read', label: t('sessionAcl.read') },
            { value: 'write', label: t('sessionAcl.write') }
          ]}
        />
        {pickFolder && (
          <button
            type="button"
            onClick={() =>
              void pickFolder().then((dir) => {
                if (dir) {
                  setPath(dir)
                  setFailed(false)
                }
              })
            }
            className="rounded-md px-2 py-1 text-[11px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
          >
            {t('sessionAcl.browse')}
          </button>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={reset}
            className="rounded-md px-2.5 py-1 text-[11px] text-text-secondary transition-colors hover:bg-bg-hover"
          >
            {t('sessionAcl.cancel')}
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!path.trim()}
            data-acl-add-confirm=""
            className="rounded-md bg-accent px-2.5 py-1 text-[11px] font-medium text-white transition-opacity disabled:opacity-40"
          >
            {t('sessionAcl.addConfirm')}
          </button>
        </div>
      </div>
    </div>
  )
}

export interface SessionAclSectionProps {
  sessionId: string
  /** 一开始就把来自会话设置的那些行也摆出来（会话设置弹窗里是；空会话的欢迎页里收着） */
  defaultExpanded?: boolean
}

export function SessionAclSection({
  sessionId,
  defaultExpanded = false
}: SessionAclSectionProps): React.JSX.Element | null {
  const { t } = useTranslation()
  const [entries, setEntries] = useState<AclEntry[] | null>(null)
  const [expanded, setExpanded] = useState(defaultExpanded)

  const load = useCallback((): void => {
    void getChatApi()
      .session.listAcl(sessionId)
      .then((list) => setEntries(sortAclEntries(list)))
  }, [sessionId])

  useEffect(load, [load])
  useAppEvent('session.configChanged', (event) => {
    if (event.sessionId === sessionId) load()
  })

  if (!entries) return null

  const paths = entries.filter((e) => e.kind === 'path')
  const sessions = entries.filter((e) => e.kind === 'session')
  const prominent = paths.filter((e) => PROMINENT.includes(e.source))
  const rest = paths.filter((e) => !PROMINENT.includes(e.source))
  const shown = expanded ? paths : prominent

  const setAccess = (entry: AclEntry, access: PathAccess): void => {
    // 乐观更新；失败（行已不在、来源不许改）由下一次重取纠正
    setEntries((list) => list?.map((e) => (e.id === entry.id ? { ...e, access } : e)) ?? list)
    void getChatApi()
      .session.setAclAccess({ id: sessionId, entryId: entry.id, access })
      .then((r) => {
        if (!r.success) load()
      })
  }

  const remove = (entry: AclEntry): void => {
    setEntries((list) => list?.filter((e) => e.id !== entry.id) ?? list)
    void getChatApi()
      .session.removeAclEntry({ id: sessionId, entryId: entry.id })
      .then((r) => {
        if (!r.success) load()
      })
  }

  return (
    <>
      <SettingsSection title={t('sessionAcl.title')} description={t('sessionAcl.description')}>
        {shown.length > 0 && (
          <div data-session-acl={sessionId} className="divide-y divide-border-secondary/40">
            {shown.map((entry) => (
              <AclRow
                key={entry.id}
                entry={entry}
                onAccess={(access) => setAccess(entry, access)}
                onRemove={() => remove(entry)}
              />
            ))}
          </div>
        )}
        {rest.length > 0 && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            data-acl-toggle=""
            className="w-full px-4 py-1.5 text-left text-[11px] text-text-tertiary transition-colors hover:bg-bg-hover/60 hover:text-text-secondary"
          >
            {expanded ? t('sessionAcl.showLess') : t('sessionAcl.showAll', { count: rest.length })}
          </button>
        )}
        <AclAddRow sessionId={sessionId} onAdded={load} />
      </SettingsSection>
      {sessions.length > 0 && (
        <SettingsSection
          title={t('sessionAcl.sessionsTitle')}
          description={t('sessionAcl.sessionsDescription')}
        >
          <div
            data-session-acl-sessions={sessionId}
            className="divide-y divide-border-secondary/40"
          >
            {sessions.map((entry) => (
              <SessionAclRow
                key={entry.id}
                entry={entry}
                onAccess={(access) => setAccess(entry, access)}
                onRemove={() => remove(entry)}
              />
            ))}
          </div>
        </SettingsSection>
      )}
    </>
  )
}
