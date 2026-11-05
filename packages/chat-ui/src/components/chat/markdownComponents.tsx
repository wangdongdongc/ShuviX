import { Children, isValidElement, memo, useContext, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { useTranslation } from 'react-i18next'
import {
  Github,
  Gitlab,
  Youtube,
  Twitter,
  Linkedin,
  Slack,
  Codepen,
  Codesandbox,
  Package,
  BookOpen,
  Archive,
  MessageCircleQuestion,
  Globe,
  Mail,
  MessageSquare,
  Folder,
  File,
  FileCode,
  FileJson,
  FileText,
  Image,
  Video,
  Music,
  Table,
  Database,
  type LucideIcon
} from 'lucide-react'
// KaTeX 的字体与排版样式 —— 谁渲染公式谁带样式：放在这里，两个宿主都不必在各自的
// 入口 CSS 里声明一遍，也就不会出现「只有一个宿主加了」的半边天。写法与
// app-shell/notebook/LivePreviewEditor.tsx 引入 atomic-editor 样式表的那行同源。
import 'katex/dist/katex.min.css'
import { CodeBlock } from './CodeBlock'
import { useChatStore } from '../../stores/chatStore'
import { ChatHostContext } from '../../host/chatHostContext'
import { copyToClipboard } from '../../utils/clipboard'
import { hasPlaceholder } from '@shuvix/chat-protocol/utils/redactionPlaceholders'
import { parseSessionLink, sessionLink } from '@shuvix/chat-protocol/dailyNotes'
import { RedactedMark } from './RedactedText'
import { HeldImage } from './HeldImage'

// ─── 超链接 ────────────────────────────────────────────

/** 域名 → 图标。命中不了的落到 Globe，不联网取 favicon（那会把「在读哪些链接」漏给外部站点） */
const DOMAIN_ICONS: Array<[RegExp, LucideIcon]> = [
  [/(^|\.)github\.(com|io)$/, Github],
  [/(^|\.)gitlab\.com$/, Gitlab],
  [/(^|\.)(youtube\.com|youtu\.be)$/, Youtube],
  [/(^|\.)(twitter\.com|x\.com)$/, Twitter],
  [/(^|\.)linkedin\.com$/, Linkedin],
  [/(^|\.)slack\.com$/, Slack],
  [/(^|\.)codepen\.io$/, Codepen],
  [/(^|\.)codesandbox\.io$/, Codesandbox],
  [/(^|\.)(npmjs\.com|npmjs\.org)$/, Package],
  [/(^|\.)(wikipedia\.org|mozilla\.org|readthedocs\.io)$/, BookOpen],
  [/(^|\.)archive\.org$/, Archive],
  [/(^|\.)(stackoverflow\.com|stackexchange\.com)$/, MessageCircleQuestion]
]

/** 前置小图标的统一样式 —— 链接与路径共用，两者视觉同形 */
const CHIP_ICON = 'inline align-[-1.5px] mr-1 flex-shrink-0'

/** 模块级普通函数：图标组件不在 render 内构造 */
function renderHostIcon(host: string): React.ReactNode {
  const hit = DOMAIN_ICONS.find(([re]) => re.test(host))
  const Icon: LucideIcon = hit ? hit[1] : Globe
  return <Icon size={12} className={CHIP_ICON} />
}

/** 中段省略 —— 域名和末段 slug 是信息量最大的两头，砍中间 */
function ellipsizeMiddle(s: string, max: number): string {
  if (s.length <= max) return s
  const head = Math.ceil((max - 1) * 0.62)
  const tail = max - 1 - head
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`
}

/** 裸链接的展示文本 —— 去掉协议头和 www.，尾斜杠也去掉，再按长度中段省略 */
function displayUrl(href: string): string {
  const stripped = href
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/$/, '')
  return ellipsizeMiddle(stripped, 52)
}

/**
 * URL 里不可能出现的中文/全角标点。
 * GFM 的 autolink literal 只回退 ASCII 标点，`（url）。后面的中文` 会被一路吞到下一个空格为止 ——
 * 结果是链接文本带上尾巴、href 还被百分号编码，点下去 404。按第一个此类标点切开即可还原。
 */
/* 含全角空格 U+3000：CommonMark 只按 ASCII 空白断词，它同样会被吞进 URL */
const CJK_PUNCT =
  /[\u2014\u2018\u2019\u201C\u201D\u2026\u3000\u3001\u3002\u3008-\u3011\u3014-\u301F\uFF01\uFF08\uFF09\uFF0C\uFF1A\uFF1B\uFF1F\uFF5B\uFF5D\uFF5E]/

/** hast 节点纯文本（判断链接文本是否就是 href 本身） */
function nodeText(node: unknown): string {
  const n = node as { type?: string; value?: string; children?: unknown[] } | undefined
  if (!n) return ''
  if (n.type === 'text') return n.value || ''
  if (Array.isArray(n.children)) return n.children.map(nodeText).join('')
  return ''
}

/**
 * 链接 —— 前置来源图标 + accent 文字，无下划线无底色。
 * 图标本身就在说「去哪」，完整 URL 留在 title 里，不靠隐藏目的地换取好看。
 */
function LinkChip({
  href,
  children,
  node,
  ...props
}: {
  href?: string
  children?: React.ReactNode
  node?: unknown
  [key: string]: unknown
}): React.JSX.Element {
  if ((href || '').startsWith('mailto:')) {
    return (
      <a href={href} title={href} {...props}>
        <Mail size={12} className={CHIP_ICON} />
        {children}
      </a>
    )
  }

  // 裸链接（GFM autolink）以原始文本为准：href 可能已被百分号编码，对不上也切不开
  const raw = nodeText(node).trim()
  const isBare = /^https?:\/\//i.test(raw)

  // 被 autolink 多吞进去的中文尾巴切出来，退回正文渲染
  let url = isBare ? raw : href || ''
  let overflow = ''
  if (isBare) {
    const cut = url.search(CJK_PUNCT)
    if (cut > 0) {
      overflow = url.slice(cut)
      url = url.slice(0, cut)
    }
  }

  let host = ''
  try {
    host = new URL(url, 'https://localhost').hostname.replace(/^www\./i, '')
  } catch {
    host = ''
  }

  // 站内锚点 / 相对链接：没有来源可标，按原样渲染
  if (!host || !/^https?:/i.test(url)) {
    return (
      <a href={url} {...props}>
        {children}
      </a>
    )
  }

  return (
    <>
      <a href={url} title={url} {...props}>
        {renderHostIcon(host)}
        {isBare ? displayUrl(url) : children}
      </a>
      {overflow}
    </>
  )
}

// ─── 会话链接 ──────────────────────────────────────────

/**
 * 指向一条会话的链接（rehypeSessionLinks 产出，文字已压成纯文本）—— 与普通链接同形：
 * 前置会话图标 + accent 文字，点了切到那条会话，带消息 id 就再跳到那条消息。
 * 模型写了标题就显示它写的（当前标题留在悬停里）；只写了地址就显示会话当前的标题。
 *
 * 这个宿主不能切会话（悬浮窗、md 窗口、Chrome 侧边栏，见 ChatHostValue.openSession）或会话已不在：
 * 只是一段带图标的文字，没有点了没反应的按钮。
 */
function SessionLinkChip({
  session,
  entry,
  children
}: {
  session: string
  entry?: string
  children?: React.ReactNode
}): React.JSX.Element {
  const { t } = useTranslation()
  const openSession = useContext(ChatHostContext)?.openSession
  const target = useChatStore((s) => s.sessions.find((x) => x.id === session))

  const written = typeof children === 'string' ? children.trim() : ''
  const label =
    !written || parseSessionLink(written)
      ? target?.title || written || sessionLink(session, entry)
      : written
  const icon = <MessageSquare size={12} className={CHIP_ICON} />

  if (!openSession || !target) {
    return (
      <span
        data-session-link={session}
        title={openSession ? t('message.sessionLinkGone') : target?.title}
        className="text-text-secondary"
      >
        {icon}
        {label}
      </span>
    )
  }
  return (
    <button
      type="button"
      data-session-link={session}
      title={`${target.title}\n${t('message.originOpenHint')}`}
      onClick={() => {
        openSession(session)
        if (entry) useChatStore.getState().requestScrollToMessage(session, entry)
      }}
      className="inline max-w-full break-words text-left text-accent hover:underline underline-offset-[3px] decoration-accent/45 decoration-1"
    >
      {icon}
      {label}
    </button>
  )
}

// ─── 文件路径 ──────────────────────────────────────────

/** 绝对路径根 —— 限定到真实文件系统前缀，避免把 `/api/v1/users` 这类路由误判成路径 */
const ABS_ROOT =
  /^(~[/\\]|\.\.?[/\\]|\/(Users|home|var|tmp|opt|etc|usr|private|mnt|media|Volumes|Applications|Library|System|srv|root)\/|[A-Za-z]:[\\/])/
/** 仓库相对路径 —— 无空格、多段、带扩展名 */
const REL_FILE = /^[\w.@-]+(?:\/[^\s/]+)+\.[A-Za-z0-9]{1,8}$/

/**
 * 模型在正文里自行简写过的路径（`/Users/x/.../ws/019f-…`）。
 * 真实路径不会出现省略号或三个以上连续的点（`..` 是合法上级目录，只排除 3+）。
 * 这类串不做成 chip：它点开必然是「无权预览」，一个点了就报错的按钮比纯文本更糟。
 */
const ELIDED = /…|\.{3}/

function isPathLike(s: string): boolean {
  if (!s || s.length > 400 || s.includes('\n') || s.includes('://')) return false
  if (ELIDED.test(s)) return false
  return ABS_ROOT.test(s) || REL_FILE.test(s)
}

const EXT_ICONS: Array<[RegExp, LucideIcon]> = [
  [
    /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|c|h|cpp|hpp|cs|rb|php|swift|kt|sh|zsh|lua|vue|svelte)$/i,
    FileCode
  ],
  [/\.(json|jsonc|json5)$/i, FileJson],
  [/\.(png|jpe?g|gif|svg|webp|bmp|ico|avif)$/i, Image],
  [/\.(mp4|mov|avi|mkv|webm|m4v)$/i, Video],
  [/\.(mp3|wav|flac|m4a|aac|ogg)$/i, Music],
  [/\.(csv|tsv|xlsx?|numbers)$/i, Table],
  [/\.(db|sqlite3?|sql)$/i, Database],
  [/\.(zip|tar|gz|tgz|bz2|xz|rar|7z)$/i, Archive],
  [/\.(epub|mobi|azw3|pdf)$/i, BookOpen],
  [/\.(md|markdown|txt|log|rst|adoc)$/i, FileText]
]

function iconForPath(p: string): LucideIcon {
  if (/[/\\]$/.test(p)) return Folder
  const hit = EXT_ICONS.find(([re]) => re.test(p))
  if (hit) return hit[1]
  // 末段无扩展名 —— 当目录看
  const last = p.split(/[/\\]/).filter(Boolean).pop() || ''
  return last.includes('.') ? File : Folder
}

/** 模块级普通函数：图标组件不在 render 内构造 */
function renderPathIcon(p: string): React.ReactNode {
  const Icon = iconForPath(p)
  return <Icon size={12} className={CHIP_ICON} />
}

/** 可见文本只留文件名；完整路径仍由 title、复制和预览使用 */
function pathBasename(path: string): string {
  return path.split(/[/\\]/).pop() || path
}

/** 目录（结尾是分隔符，或末段不含点）—— 预览面板只认文件，目录点击退回复制 */
function isDirPath(p: string): boolean {
  if (/[/\\]$/.test(p)) return true
  const last = p.split(/[/\\]/).filter(Boolean).pop() || ''
  return !last.includes('.')
}

/**
 * 可预览时解析出绝对路径：相对路径按当前 projectPath 拼接。
 * `~` 开头的没法在渲染进程可靠展开（拿不到 home），返回 null 让它退回复制。
 */
function resolveForPreview(p: string, projectPath: string | null): string | null {
  if (isDirPath(p)) return null
  if (p.startsWith('~')) return null
  if (/^([/\\]|[A-Za-z]:[\\/])/.test(p)) return p
  if (!projectPath) return null
  const sep = projectPath.includes('\\') && !projectPath.includes('/') ? '\\' : '/'
  return `${projectPath.replace(/[/\\]+$/, '')}${sep}${p.replace(/^[/\\]+/, '')}`
}

/**
 * 文件路径 —— 与普通链接同形：前置文件类型图标 + accent 文件名，无容器底色。
 * 点击在独立窗口打开该文件（走 requestFilePreview，与 Files 面板点文件同一条信号）；
 * 无法解析的路径退回复制，⌘（Ctrl）+ 点击始终复制。完整路径留在 title 里。
 */
function PathChip({ path }: { path: string }): React.JSX.Element {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const projectPath = useChatStore((s) => s.projectPath)
  const previewPath = resolveForPreview(path, projectPath)

  const copy = (): void => {
    copyToClipboard(path)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <button
      type="button"
      title={`${path}\n${previewPath ? t('message.pathClickToPreview') : t('message.pathClickToCopy')}`}
      onClick={(e) => {
        if (previewPath && !e.metaKey && !e.ctrlKey) {
          useChatStore.getState().requestFilePreview(previewPath)
          return
        }
        copy()
      }}
      className={`inline max-w-full break-all text-left hover:underline underline-offset-[3px] decoration-accent/45 decoration-1 ${
        copied ? 'text-success' : 'text-accent'
      }`}
    >
      {renderPathIcon(path)}
      {pathBasename(path)}
    </button>
  )
}

// ─── 统一的 markdown 渲染组件表 ────────────────────────

/** 行内代码：明确是文件的路径走 PathChip，目录与其它 token 保持模型源文本 */
function InlineCode({
  className,
  children,
  ...props
}: {
  className?: string
  children?: React.ReactNode
  [key: string]: unknown
}): React.JSX.Element {
  const isBlock = !!className && /language-|hljs/.test(className)
  // 带占位符的（模型看到的就是占位符）不当路径，照常显示
  const text = isBlock ? '' : plainTextOf(children)

  const path = text.trim()
  if (!isBlock && !hasPlaceholder(text) && isPathLike(path) && !isDirPath(path)) {
    return <PathChip path={path} />
  }
  return (
    <code className={className} {...props}>
      {children}
    </code>
  )
}

/** 自动脱敏的标记（rehypeRedactionMarks 产出，唯一的子节点是占位符原文） */
function RedactionMarkTag({ children }: { children?: React.ReactNode }): React.JSX.Element {
  return <RedactedMark placeholder={String(children)} />
}

/** 行内代码的纯文本：字符串原样，标记取回它的占位符（其余元素不算 —— 那就不是路径） */
function plainTextOf(children: React.ReactNode): string {
  let out = ''
  for (const child of Children.toArray(children)) {
    if (typeof child === 'string' || typeof child === 'number') out += String(child)
    else if (
      isValidElement<{ children?: React.ReactNode }>(child) &&
      child.type === RedactionMarkTag
    ) {
      out += String(child.props.children)
    } else return ''
  }
  return out
}

/**
 * 对话流 markdown 的共用组件表 —— 代码块容器 + 链接 chip + 路径 chip + 脱敏标记 + 扣下的图片。
 * 所有渲染 markdown 的地方都用这一份，避免各处样式漂移。
 */
export const markdownComponents = {
  pre: CodeBlock as never,
  a: LinkChip as never,
  code: InlineCode as never,
  'redaction-mark': RedactionMarkTag as never,
  'session-link': SessionLinkChip as never,
  'held-image': HeldImage as never
}

// ─── 共用插件表 ────────────────────────────────────────

/**
 * 插件数组本身在 utils/markdownPlugins.ts —— 那边不 import react / 图标 / 样式表，于是
 * `environment: 'node'` 的单测能直接吃**生产同一份数组**（插件顺序就是这条管线的安全
 * 边界，理由写在那个文件头）。这里原样转出，调用方的 import 路径不变。
 */
import { markdownRemarkPlugins, markdownRehypePlugins } from '../../utils/markdownPlugins'
export { markdownRemarkPlugins, markdownRehypePlugins }

// ─── 按文本缓存的渲染 ────────────────────────────────────

/**
 * 对话流里一段 markdown —— 文本不变就不重渲染。
 *
 * 一次渲染要把整段重新解析、重新高亮、重新排公式；运行中的会话每秒推来十来次更新，一张卡里只要有
 * 一处跟着变（流式正文、新落盘的一步），卡里每一段中间文本都会被连带重做一遍，卡越长越卡（滚回
 * 一轮长任务里时尤其明显）。文本相同就跳过：上下文（MarkdownStreamingContext / SourceContext）
 * 变化照样会传到读它们的代码块，不受 memo 影响。
 */
export const MarkdownText = memo(function MarkdownText({
  text
}: {
  text: string
}): React.JSX.Element {
  return (
    <ReactMarkdown
      remarkPlugins={markdownRemarkPlugins}
      rehypePlugins={markdownRehypePlugins}
      components={markdownComponents}
    >
      {text}
    </ReactMarkdown>
  )
})
