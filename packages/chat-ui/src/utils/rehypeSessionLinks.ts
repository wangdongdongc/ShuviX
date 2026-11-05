/**
 * 指向一条会话的链接（`shuvix://session/<id>[#<entryId>]`，日记助手的回复里最多）→ `<session-link>` 元素，
 * 由 markdownComponents 渲染成带图标、点了切到那条会话的 chip。`[标题](shuvix://…)`、正文里的裸地址、
 * 整段就是一个地址的行内代码都算。
 *
 * 为什么换元素而不是留一个 `<a href>`：react-markdown 的 urlTransform 在所有 rehype 插件**之后**才跑，
 * 会清掉它不认识的协议，留着 href 到不了组件；而且这条链接从来不该变成一次导航（导航会走到主进程的外链闸，
 * 问要不要交给系统）。元素上只有会话 id 与消息 id，DOM 里没有能被浏览器打开的地址。
 *
 * 排在闸**之后**：闸只为形状严格匹配的会话链接留下 `a` 的 href（rehypeSanitizeRawHtml 的 keepAnchorHref），
 * 别的 `shuvix://` 照旧丢；正文里手写的 `<session-link>` 早在闸那一步就被拆成了文字，进不到这里。
 *
 * 过了闸的 `a` 在哪都换掉（包括裸 HTML 写在 `<code>` / `<pre>` 里的），地址留不到 urlTransform 那一步。
 * 裸地址与行内代码只在正文里认：代码块、公式里的是引用地址，别的链接里的会变成链接套链接。
 * 链接文字压成纯文本：chip 是一个按钮，文字里的路径 chip、图片占位也是按钮，嵌套了点一下触发两边。
 */
import type { Element, ElementContent, Root } from 'hast'
import { parseSessionLink } from '@shuvix/chat-protocol/dailyNotes'

export const SESSION_LINK_TAG = 'session-link'

/**
 * 正文里的裸地址。形状与 parseSessionLink 一致；消息 id 不收句尾的 `.` `:`，地址后面紧跟着还像地址的
 * 部分（`?x=1`、`.def`、`/b`）就不算 —— 同样的串写成 `[t](…)` 也不是会话链接。
 */
const BARE_SESSION_LINK =
  /(?<![\w/])shuvix:\/\/session\/[A-Za-z0-9_-]+\/?(?:#(?:[A-Za-z0-9_:.-]*[A-Za-z0-9_-]))?(?![\w/-]|[?#.:]\w)/g

function textOf(node: ElementContent): string {
  if (node.type === 'text') return node.value
  return node.type === 'element' ? node.children.map(textOf).join('') : ''
}

function sessionLinkElement(url: string, label: string): Element | null {
  const target = parseSessionLink(url)
  if (!target) return null
  return {
    type: 'element',
    tagName: SESSION_LINK_TAG,
    properties: {
      session: target.sessionId,
      ...(target.entryId ? { entry: target.entryId } : {})
    },
    children: label ? [{ type: 'text', value: label }] : []
  }
}

/** 一段文字按裸地址切开；没有裸地址 → null（调用方原样留着，不新建节点） */
function splitBareLinks(value: string): ElementContent[] | null {
  const out: ElementContent[] = []
  let last = 0
  for (const m of value.matchAll(BARE_SESSION_LINK)) {
    const link = sessionLinkElement(m[0], m[0])
    if (!link) continue
    if (m.index > last) out.push({ type: 'text', value: value.slice(last, m.index) })
    out.push(link)
    last = m.index + m[0].length
  }
  if (out.length === 0) return null
  if (last < value.length) out.push({ type: 'text', value: value.slice(last) })
  return out
}

/** 这个元素里的文字不是正文（理由见文件头） */
function holdsNoProse(el: Element): boolean {
  if (el.tagName === 'a' || el.tagName === 'pre' || el.tagName === 'code') return true
  const cls = el.properties?.className
  return Array.isArray(cls) && cls.includes('katex')
}

function visit(node: Root | Element, inProse: boolean): void {
  const kids: Root['children'] = []
  for (const child of node.children) {
    if (child.type === 'text' && inProse) {
      kids.push(...(splitBareLinks(child.value) ?? [child]))
      continue
    }
    if (child.type !== 'element') {
      kids.push(child)
      continue
    }
    const href = child.tagName === 'a' ? child.properties?.href : undefined
    const link =
      (typeof href === 'string' && sessionLinkElement(href, textOf(child))) ||
      (inProse && child.tagName === 'code' && sessionLinkElement(textOf(child), ''))
    if (link) {
      kids.push(link)
      continue
    }
    visit(child, inProse && !holdsNoProse(child))
    kids.push(child)
  }
  node.children = kids as typeof node.children
}

/** rehype 插件形态 —— 在闸之后（理由见文件头） */
export function rehypeSessionLinks() {
  return (tree: Root): void => {
    visit(tree, true)
  }
}
