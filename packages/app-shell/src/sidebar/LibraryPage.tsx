/**
 * 资料库的两层导航（web 客户端的手机布局，2026-11-15 照 iOS Mail 那一套，与会话页同一副骨架）。
 *
 * 资料库各组（智能体 / 技能 / 知识库 / 安全策略 / Hooks）在桌面侧栏里是就地展开的树；手机上换成两层：
 *   - 顶层：每组一行导航行（数量 + 箭头），点它 `onOpen(组 key, 名字)`，组的正文不画；
 *   - 某一组的那一页：只画这一组 —— 一节一张分组卡片，每行两行字（名字 + 一句说明），底部工具栏是数量与新建，
 *     顶栏右边是这一组的菜单「⋯」。知识库多一层：先是各个库，点进一个库再是它里面的文件夹与条目。
 *
 * 各组自己认 `drill.scope` 是不是自己（顶层画导航行、是自己画这一页、是别的组什么都不画）；这一页的排版都在这里
 * （LibraryPage），各组只把自己的条目排成 `sections`，点一行 / 长按一行做什么仍是各组原来的那几个函数。
 * 工具栏与「⋯」同会话页：经 portal 画进宿主页面留的两个槽里；`toolbarSlot` 不给时工具栏画在这一页末尾。
 */
import React from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, ChevronRight, CircleEllipsis, Lock, Plus } from 'lucide-react'

/** 资料库各组的 key（`drill.scope` 用它认是哪一组；知识库某个库的那一页是 `knowledge:<库的路径>`） */
export type LibraryGroupKey = 'agents' | 'skills' | 'knowledge' | 'policies' | 'hooks'

/** 知识库某个库的那一页的 key 前缀 */
export const LIBRARY_KNOWLEDGE_BASE_PREFIX = 'knowledge:'

/** 两层导航的那一份（宿主传给资料库各组，同一个对象） */
export interface LibraryDrill {
  /** null = 顶层；否则是开着的那一页的 key */
  scope: string | null
  onOpen: (key: string, label: string) => void
  menuSlot?: HTMLElement | null
  toolbarSlot?: HTMLElement | null
}

/** 一行条目 */
export interface LibraryPageRow {
  key: string
  /** 行上的数据锚点（各组原来的 `data-agent-row` 之类，e2e 与长按菜单都认它） */
  attrs?: Record<string, string>
  title: string
  /** 标题后面并排的一小段等宽字（内置技能的标识名） */
  identifier?: string
  /** 标题下面那一行灰字；没有就只有一行 */
  description?: string
  /** 标题用等宽字（解析不过的文件：显示的是文件名） */
  mono?: boolean
  /** 行尾挂锁：随应用发布、只能看 */
  locked?: boolean
  /** 标题划线：同名的另一份压过了它，或它被停用（技能） */
  struck?: boolean
  /** 整行变淡：被停用 */
  dimmed?: boolean
  /** 行尾的一枚小标签（「已覆盖」「已停用」） */
  badge?: string
  /** 行尾的警告记号：这份文件解析不过 */
  warning?: boolean
  /** 悬停提示 */
  hint?: string
  onOpen: () => void
  onMenu?: (e: React.MouseEvent) => void
}

/** 一节（一张卡片）：可以带一个小标题；标题也能长按出菜单（技能的外部目录） */
export interface LibraryPageSection {
  key: string
  label?: string
  /** 小标题上的数据锚点（技能目录的 `data-skill-folder`） */
  attrs?: Record<string, string>
  /** 小标题变淡并划线：整个目录被停用 */
  off?: boolean
  onMenu?: (e: React.MouseEvent) => void
  rows: LibraryPageRow[]
  /** 这一节没有行时卡片里的一句话；不给就整节不画 */
  emptyHint?: string
}

export interface LibraryPageProps {
  /** 这一页的 key（`data-library-page`） */
  pageKey: string
  drill: LibraryDrill
  sections: LibraryPageSection[]
  /** 一行都没有时的那一句 */
  emptyHint?: string
  /** 底部工具栏中间那句话 */
  countText: string
  /** 工具栏右边的「新建」；不给就没有这一颗 */
  onNew?: (e: React.MouseEvent) => void
  newLabel?: string
  /** 顶栏右边的「⋯」（这一组的菜单）；不给就没有 */
  onMenu?: (e: React.MouseEvent) => void
  menuLabel?: string
  /** 排在各节之前的内容（知识库新建库时那一行输入框） */
  header?: React.ReactNode
  /** 代替各节的正文（知识库某个库里的那棵树） */
  children?: React.ReactNode
}

const toolbarButton =
  'flex h-11 w-11 shrink-0 items-center justify-center rounded-full active:bg-bg-hover'

export function LibraryPage({
  pageKey,
  drill,
  sections,
  emptyHint,
  countText,
  onNew,
  newLabel,
  onMenu,
  menuLabel,
  header,
  children
}: LibraryPageProps): React.JSX.Element {
  const shown = sections.filter((section) => section.rows.length > 0 || section.emptyHint)
  const toolbar = (
    <div data-library-toolbar="" className="flex h-12 items-center px-2 text-accent">
      <span className="h-11 w-11 shrink-0" />
      <span
        data-library-count=""
        className="min-w-0 flex-1 truncate text-center text-[12px] text-text-secondary"
      >
        {countText}
      </span>
      {onNew ? (
        <button
          type="button"
          data-library-new=""
          aria-label={newLabel}
          title={newLabel}
          onClick={onNew}
          className={toolbarButton}
        >
          <Plus size={22} aria-hidden="true" />
        </button>
      ) : (
        <span className="h-11 w-11 shrink-0" />
      )}
    </div>
  )
  const menuButton = onMenu && (
    <button
      type="button"
      data-library-menu=""
      aria-label={menuLabel}
      title={menuLabel}
      onClick={onMenu}
      className="flex h-9 w-9 items-center justify-center rounded-full text-accent active:bg-bg-hover"
    >
      <CircleEllipsis size={22} aria-hidden="true" />
    </button>
  )
  return (
    <div data-library-page={pageKey} className="space-y-5 pb-2 text-[16px] text-text-primary">
      {header}
      {children ??
        (shown.length === 0
          ? emptyHint && (
              <div data-library-empty="" className="px-4 text-[14px] text-text-tertiary">
                {emptyHint}
              </div>
            )
          : shown.map((section) => (
              <section key={section.key} data-library-section={section.key}>
                {section.label && (
                  <div
                    {...section.attrs}
                    data-library-section-label=""
                    onContextMenu={section.onMenu}
                    className={`truncate px-4 pb-1.5 text-[13px] text-text-secondary ${
                      section.off ? 'line-through opacity-60' : ''
                    }`}
                  >
                    {section.label}
                  </div>
                )}
                <div className="overflow-hidden rounded-xl bg-bg-secondary">
                  {section.rows.length === 0 ? (
                    <div className="px-4 py-3 text-[14px] text-text-tertiary">
                      {section.emptyHint}
                    </div>
                  ) : (
                    section.rows.map((row, index) => (
                      <div
                        key={row.key}
                        {...row.attrs}
                        data-library-row=""
                        onClick={row.onOpen}
                        onContextMenu={row.onMenu}
                        title={row.hint}
                        className={`flex cursor-pointer items-stretch pl-4 active:bg-bg-hover ${
                          row.dimmed ? 'opacity-50' : ''
                        }`}
                      >
                        <div
                          className={`flex min-h-[44px] min-w-0 flex-1 items-center gap-2 py-2 pr-3 ${
                            index > 0 ? 'border-t border-border-secondary/50' : ''
                          }`}
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex min-w-0 items-baseline gap-2">
                              <span
                                data-library-row-title=""
                                className={`truncate ${row.mono ? 'font-mono text-[0.9em]' : ''} ${
                                  row.struck ? 'line-through opacity-60' : ''
                                }`}
                              >
                                {row.title}
                              </span>
                              {row.identifier && (
                                <span
                                  data-library-row-identifier=""
                                  className="shrink-0 font-mono text-[0.75em] text-text-tertiary"
                                >
                                  {row.identifier}
                                </span>
                              )}
                            </div>
                            {row.description && (
                              <div
                                data-library-row-description=""
                                className="mt-0.5 truncate text-[0.82em] text-text-secondary"
                              >
                                {row.description}
                              </div>
                            )}
                          </div>
                          <span className="flex shrink-0 items-center gap-1.5 text-text-tertiary">
                            {row.badge && (
                              <span
                                data-library-row-badge=""
                                className="rounded bg-bg-tertiary px-1.5 py-0.5 text-[11px]"
                              >
                                {row.badge}
                              </span>
                            )}
                            {row.warning && (
                              <AlertTriangle
                                size={15}
                                className="text-amber-500"
                                aria-hidden="true"
                              />
                            )}
                            {row.locked && (
                              <Lock size={13} data-library-row-lock="" aria-hidden="true" />
                            )}
                            <ChevronRight size={16} aria-hidden="true" />
                          </span>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </section>
            )))}
      {drill.toolbarSlot === undefined
        ? toolbar
        : drill.toolbarSlot && createPortal(toolbar, drill.toolbarSlot)}
      {menuButton && drill.menuSlot && createPortal(menuButton, drill.menuSlot)}
    </div>
  )
}

/** 注册表三组（智能体 / 安全策略 / Hooks）的条目共有的那几个字段 */
export interface RegistryPageItem {
  name: string
  displayName: string
  description?: string
  source: 'builtin' | 'user'
  fileName: string
  overridden?: boolean
  disabled?: boolean
}

/**
 * 注册表三组的条目排成两节：「我的」（用户文件，连同解析不过的文件）在上，「内置」在下。同名里没胜出的那一份照旧
 * 划线、带「已覆盖」；被停用的变淡、带「已停用」。点一行 / 长按一行做什么由各组给。
 */
export function registrySections<T extends RegistryPageItem>(
  items: T[],
  invalid: Array<{ fileName: string; error: string }>,
  opts: {
    labels: { mine: string; builtin: string; overridden: string; disabled: string }
    attrsOf: (item: T) => Record<string, string>
    invalidAttrs: (fileName: string) => Record<string, string>
    hintOf: (item: T) => string | undefined
    onOpen: (item: T) => void
    onOpenInvalid: (fileName: string) => void
    menuOf: (item: T) => (e: React.MouseEvent) => void
    invalidMenu: (fileName: string) => (e: React.MouseEvent) => void
  }
): LibraryPageSection[] {
  const rowOf = (item: T): LibraryPageRow => ({
    key: item.source === 'builtin' ? `builtin:${item.name}` : `file:${item.fileName}`,
    attrs: opts.attrsOf(item),
    title: item.displayName,
    description: item.description,
    locked: item.source === 'builtin',
    struck: !!item.overridden,
    dimmed: !!item.disabled && !item.overridden,
    badge: item.overridden
      ? opts.labels.overridden
      : item.disabled
        ? opts.labels.disabled
        : undefined,
    hint: opts.hintOf(item),
    onOpen: () => opts.onOpen(item),
    onMenu: opts.menuOf(item)
  })
  return [
    {
      key: 'mine',
      label: opts.labels.mine,
      rows: [
        ...items.filter((item) => item.source === 'user').map(rowOf),
        ...invalid.map(
          (file): LibraryPageRow => ({
            key: `invalid:${file.fileName}`,
            attrs: opts.invalidAttrs(file.fileName),
            title: file.fileName,
            mono: true,
            warning: true,
            hint: file.error,
            onOpen: () => opts.onOpenInvalid(file.fileName),
            onMenu: opts.invalidMenu(file.fileName)
          })
        )
      ]
    },
    {
      key: 'builtin',
      label: opts.labels.builtin,
      rows: items.filter((item) => item.source === 'builtin').map(rowOf)
    }
  ]
}
