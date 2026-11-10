/**
 * 跟踪项（实验）—— 一件需要持续跟进、跨好几天才有结论的事，一项一个 md（`~/.shuvix/tracking/<名字>.md`），
 * 由用户让它建、改的会话照 `builtin:tracking` 技能维护（内置 bot 2026-10-31 起不再碰它）。格式只约定身份：新建时写 `shuvix: track v1` 与 `shuvix-id`，
 * 标题取正文第一个 `# ` 标题；其余（背景、进展、结论）都是正文。唯一的管理字段是 frontmatter 的 `status`
 * （2026-11-10，`docs/inbox-tracking-status-design.md`）：`active`（缺省，不写也是它）/ `waiting` / `archived`，
 * 归档就是把它改成 `archived` —— 状态是文件的一部分，不进数据库、不挪文件夹。
 *
 * 与日报同一套载体做法：目录有一个隐藏载体项目（`__tracking__`，path = 目录本身），一份文件至多一个笔记本会话，
 * 重复打开复用；桌面在收件箱页的「跟踪中」一节列出它们（手机仍在资料库里）。这里只放纯函数，读写盘在主进程
 * `services/trackingNotes.ts`。
 */

/** 跟踪项目录的隐藏载体项目 id（同 `__daily__` / `__bots__` 的做法） */
export const TRACKING_PROJECT_ID = '__tracking__'
export const isTrackingProjectId = (id: string | null | undefined): boolean =>
  id === TRACKING_PROJECT_ID

/** `shuvix: <type> v<n>` 的 type 段 */
export const TRACKING_MARKER_TYPE = 'track'
export const TRACKING_MARKER_VERSION = '1'

/** 侧栏的一行 */
export interface TrackingItem {
  /** 跟踪项目录下的文件名（笔记本会话按它认） */
  fileName: string
  /** 正文第一个 `# ` 标题；没有就是去掉 `.md` 的文件名 */
  title: string
  /** 文件最后修改时刻（毫秒）—— 列表按它倒序 */
  updatedAt: number
  /** 文件的绝对路径（行菜单的「在文件夹中显示」「复制路径」） */
  path: string
  /** frontmatter 的 `status`；没写或不认识按 `active` */
  status: TrackingStatus
  /** 列表上那一句：最新一条进展（正文最后一条列表项），没有就是结论的第一句 */
  latest?: string
  /** 结论：标题下第一段（已归档的行上显示） */
  conclusion?: string
}

/** 跟踪项的状态：在跟 / 等待中（在等别人或外部条件）/ 已归档（不再跟了） */
export type TrackingStatus = 'active' | 'waiting' | 'archived'
export const TRACKING_STATUSES: readonly TrackingStatus[] = ['active', 'waiting', 'archived']
export const isTrackingStatus = (v: unknown): v is TrackingStatus =>
  typeof v === 'string' && (TRACKING_STATUSES as readonly string[]).includes(v)

const FRONTMATTER = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

/** frontmatter 里顶层 `status:` 的原值（去引号、去行尾注释）；没有 frontmatter 或没写为 null */
export function trackingStatusRaw(source: string): string | null {
  const fm = FRONTMATTER.exec(source)?.[1]
  if (fm === undefined) return null
  const m = /^status[ \t]*:[ \t]*(.*)$/m.exec(fm)
  if (!m) return null
  const raw = m[1]
    .replace(/[ \t]+#.*$/, '')
    .trim()
    .replace(/^(['"])(.*)\1$/, '$2')
    .trim()
  return raw || null
}

/** 状态：没写、写了不认识的值都按 `active`（不认识的值由属性卡标黄，这里不拦） */
export function trackingStatusOf(source: string): TrackingStatus {
  const raw = trackingStatusRaw(source)?.toLowerCase()
  return isTrackingStatus(raw) ? raw : 'active'
}

/** 一行 markdown 化成一句纯文本：链接留文字，去掉强调 / 行内代码记号，压掉多余空白 */
function plainLine(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|`)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function bodyOf(source: string): string {
  return source.replace(FRONTMATTER, '')
}

/** 结论：`# 标题` 之后、下一个标题之前的第一段（整段被括号包着的是模板里的占位提示，不算） */
export function trackingConclusion(source: string): string | undefined {
  const lines = bodyOf(source).split(/\r?\n/)
  const titleAt = lines.findIndex((l) => /^#[ \t]+/.test(l))
  if (titleAt < 0) return undefined
  const para: string[] = []
  for (const line of lines.slice(titleAt + 1)) {
    if (/^#{1,6}[ \t]/.test(line)) break
    if (line.trim() === '') {
      if (para.length > 0) break
      continue
    }
    para.push(line.trim())
  }
  const text = plainLine(para.join(' '))
  if (!text || /^[（(][\s\S]*[）)]$/.test(text)) return undefined
  return text
}

/** 第一句（到第一个句号为止；没有句号就是整段） */
function firstSentence(text: string): string {
  // 中日文的句号后面不跟空格；英文的要跟空格或结尾，免得把 `v0.2.59` 里的点当句号
  const m = /^[\s\S]*?(?:[。！？]|[.!?](?=\s|$))/.exec(text)
  return (m ? m[0] : text).trim()
}

/** 列表上那一句：正文最后一条顶层列表项（进展按日期往下追加，最后一条就是最新的）；没有就是结论的第一句 */
export function trackingLatest(source: string): string | undefined {
  const lines = bodyOf(source).split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^[-*+][ \t]+(.+)$/.exec(lines[i])
    if (!m) continue
    // 续行（缩进的同一条）接在后面
    const rest: string[] = []
    for (let j = i + 1; j < lines.length && /^[ \t]+\S/.test(lines[j]); j++)
      rest.push(lines[j].trim())
    const text = plainLine([m[1], ...rest].join(' '))
    if (text) return text
  }
  const conclusion = trackingConclusion(source)
  return conclusion ? firstSentence(conclusion) : undefined
}

/** 是不是一份跟踪项文件：目录里的 `.md`，点开头的隐藏文件不算 */
export function isTrackingFileName(fileName: string): boolean {
  return /\.md$/i.test(fileName) && !fileName.startsWith('.') && !/[\\/]/.test(fileName)
}

/** 跳过 frontmatter，取正文第一个一级标题；没有就用文件名（去掉 `.md`） */
export function trackingTitle(source: string, fileName: string): string {
  const body = source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
  const m = /^#[ \t]+(.+?)[ \t#]*$/m.exec(body)
  const title = m?.[1]?.trim()
  return title || fileName.replace(/\.md$/i, '')
}
