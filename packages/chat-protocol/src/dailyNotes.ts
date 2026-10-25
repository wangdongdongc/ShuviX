/**
 * 日报 —— 一天一份 md（`~/.shuvix/daily/YYYY-MM-DD.md`），挂在日历的那一天上。
 *
 * 与 bot / hook 的注册表笔记同一套做法：目录有一个隐藏载体项目（`__daily__`，path = 目录本身），
 * 一份文件至多一个笔记本会话，重复打开复用；编辑、自动保存、外部改动合并全归笔记本会话。
 * **身份是文件名**（日期），不是 frontmatter：新建时写 `shuvix: daily v1` 自述行，没有它的同名
 * 文件照样按位置认 —— 用户从别处拷进来、用别的编辑器新建的那一天都算数。
 *
 * 这里只放纯函数（文件名规则、摘录、会话链接），主进程与渲染层共用；
 * 读写盘在主进程 `services/dailyNotes.ts`。
 */

import { sessionResource } from './knowledge'

/** 日报目录的隐藏载体项目 id（同 `__bots__` 那几个的做法） */
export const DAILY_PROJECT_ID = '__daily__'

export const isDailyProjectId = (id: string | null | undefined): boolean => id === DAILY_PROJECT_ID

/** `shuvix: <type> v<n>` 的 type 段 */
export const DAILY_MARKER_TYPE = 'daily'
export const DAILY_MARKER_VERSION = '1'

/** 用户自己的模板：放在日报目录里就用它新建，没有用内置的三段 */
export const DAILY_TEMPLATE_FILE = '_template.md'

const DAY_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const DAILY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.md$/

/** 是不是一个真实存在的本地日（`2026-02-30` 不算） */
export function isDayKey(day: string): boolean {
  const m = DAY_KEY_RE.exec(day)
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const date = new Date(y, mo - 1, d)
  return date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d
}

/** 本地日（不是 UTC）—— 与日历索引 session_day_prompts 的 day 同一口径 */
export function localDayKey(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export const dailyFileName = (day: string): string => `${day}.md`

/** 日报文件名 → 它是哪一天；不是日报文件（模板、别的 md、不存在的日子）返回 null */
export function dayOfDailyFile(fileName: string): string | null {
  const m = DAILY_FILE_RE.exec(fileName)
  return m && isDayKey(m[1]) ? m[1] : null
}

/** 内置模板：完成 / 接下来 / 待跟进 三段，每段留一个空项（`edit` 有处可落） */
export function defaultDailyTemplate(headings: {
  done: string
  next: string
  followUp: string
}): string {
  return [
    '---',
    `shuvix: ${DAILY_MARKER_TYPE} v${DAILY_MARKER_VERSION}`,
    '---',
    '',
    `## ${headings.done}`,
    '',
    '- ',
    '',
    `## ${headings.next}`,
    '',
    '- [ ] ',
    '',
    `## ${headings.followUp}`,
    '',
    '- ',
    ''
  ].join('\n')
}

/** 文件开头的 frontmatter 块（含收尾换行）；没有返回 '' */
const FRONTMATTER_BLOCK_RE = /^\uFEFF?---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/

function frontmatterBody(source: string): string {
  const m = FRONTMATTER_BLOCK_RE.exec(source)
  return m ? source.slice(m[0].length) : source
}

const HEADING_RE = /^#{1,6}[ \t]/
/** 只有列表符号（可带一个空复选框）的空项 —— 模板留的占位 */
const EMPTY_ITEM_RE = /^[ \t]*(?:[-*+]|\d+[.)])(?:[ \t]+\[[ xX]?\])?[ \t]*$/
const LIST_MARKER_RE = /^(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/

/**
 * 日历里那一行的摘录：去掉 frontmatter、标题、空项、注释，列表符号与链接只留文字，逐条以 ` · ` 相连。
 * 什么都没写（只有模板）回 ''。
 */
export function dailyExcerpt(source: string, maxChars = 140): string {
  const parts: string[] = []
  let inComment = false
  for (const raw of frontmatterBody(source).split(/\r?\n/)) {
    let line = raw.trim()
    if (inComment) {
      if (line.includes('-->')) inComment = false
      continue
    }
    if (line.startsWith('<!--')) {
      if (!line.includes('-->')) inComment = true
      continue
    }
    if (!line || HEADING_RE.test(line) || EMPTY_ITEM_RE.test(line)) continue
    line = line
      .replace(LIST_MARKER_RE, '')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\*\*|__|~~|`/g, '')
      .trim()
    if (line) parts.push(line)
  }
  const text = parts.join(' · ')
  return text.length > maxChars ? `${text.slice(0, maxChars - 1).trimEnd()}…` : text
}

/** 指向一条会话的链接：`shuvix://session/<id>`，带 `#<entryId>` 时打开后跳到那条用户消息（日历行菜单的「复制链接」） */
export function sessionLink(sessionId: string, entryId?: string | null): string {
  return entryId ? `${sessionResource(sessionId)}#${entryId}` : sessionResource(sessionId)
}

const SESSION_LINK_RE = /^shuvix:\/\/session\/([A-Za-z0-9_-]+)\/?(?:#([A-Za-z0-9_:.-]+))?$/

/** `shuvix://session/<id>[#<entryId>]` → 会话与消息；别的链接返回 null */
export function parseSessionLink(url: string): { sessionId: string; entryId?: string } | null {
  const m = SESSION_LINK_RE.exec(url.trim())
  if (!m) return null
  return m[2] ? { sessionId: m[1], entryId: m[2] } : { sessionId: m[1] }
}

/** 会话标题放进链接文字：方括号转义，换行压成空格 */
export function linkText(title: string): string {
  return title
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[[\]\\]/g, '\\$&')
}
