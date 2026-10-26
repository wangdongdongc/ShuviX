/**
 * 自动脱敏的占位符 → `<redaction-mark>` 元素（docs/auto-redaction-design.md §2.3），由 markdownComponents 渲染成
 * RedactedMark（显示会话对照表里的真值，带一个标记）。元素唯一的子节点就是占位符原文 —— 复制、`toText` 拿到的
 * 仍是占位符，由复制那一步换回真值。
 *
 * 排在插件表最后：
 *   - 净化之后 —— 闸会把不认识的标签拆成文字；这里产出的是可信标记（一个固定标签、一段文字）。反过来，正文里
 *     手写的 `<redaction-mark>` 早在闸那一步就被拆成了文字，进不到这里；
 *   - 高亮之后 —— rehype-highlight 会整个换掉 `code` 的子节点，先插进去的标记会丢。高亮可能把一个占位符切进
 *     几段 span（`{{` 被当成别的语法），所以在每个 `code` 元素里把相邻的文本节点连起来找：标记放进第一段，
 *     其余几段删掉对应的字符；
 *   - KaTeX 的产物不碰。
 */
import type { Element, ElementContent, Root, Text } from 'hast'
import {
  PLACEHOLDER_PATTERN,
  splitPlaceholders
} from '@shuvix/chat-protocol/utils/redactionPlaceholders'

export const REDACTION_MARK_TAG = 'redaction-mark'

function markOf(placeholder: string): Element {
  return {
    type: 'element',
    tagName: REDACTION_MARK_TAG,
    properties: {},
    children: [{ type: 'text', value: placeholder }]
  }
}

function isKatex(node: Element): boolean {
  const cls = node.properties?.className
  return Array.isArray(cls) && cls.some((c) => typeof c === 'string' && c.startsWith('katex'))
}

/** 一段文本切成文字与标记；没有占位符 → null */
function splitText(value: string): ElementContent[] | null {
  const segments = splitPlaceholders(value)
  if (segments.length === 1 && typeof segments[0] === 'string') return null
  return segments.map((s) =>
    typeof s === 'string' ? { type: 'text', value: s } : markOf(s.placeholder)
  )
}

function visit(node: Root | Element): void {
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i]!
    if (child.type === 'element') {
      if (child.tagName === REDACTION_MARK_TAG || isKatex(child)) continue
      if (child.tagName === 'code') markAcrossText(child)
      else visit(child)
    } else if (child.type === 'text' && child.value.includes('{{')) {
      const replaced = splitText(child.value)
      if (replaced) {
        node.children.splice(i, 1, ...replaced)
        i += replaced.length - 1
      }
    }
  }
}

/** code 元素里按文本顺序收集的文本节点，以及它们的父节点 */
function textNodes(node: Element, out: Array<{ parent: Element; node: Text }>): void {
  for (const child of node.children) {
    if (child.type === 'text') out.push({ parent: node, node: child })
    else if (child.type === 'element' && child.tagName !== REDACTION_MARK_TAG) textNodes(child, out)
  }
}

function markAcrossText(code: Element): void {
  const nodes: Array<{ parent: Element; node: Text }> = []
  textNodes(code, nodes)
  const full = nodes.map((n) => n.node.value).join('')
  if (!full.includes('{{')) return
  const matches = [...full.matchAll(new RegExp(PLACEHOLDER_PATTERN, 'g'))]
  if (matches.length === 0) return
  // 每个文本节点在全文里的起点
  const starts: number[] = []
  let offset = 0
  for (const n of nodes) {
    starts.push(offset)
    offset += n.node.value.length
  }
  // 从后往前改：前面那些匹配的位置不受影响
  for (const match of matches.reverse()) {
    const start = match.index
    const end = start + match[0].length
    let first = -1
    for (let k = 0; k < nodes.length; k++) {
      const s = starts[k]!
      const e = s + nodes[k]!.node.value.length
      if (e <= start || s >= end) continue
      if (first < 0) first = k
      const text = nodes[k]!.node
      const from = Math.max(start, s) - s
      const to = Math.min(end, e) - s
      if (k === first) {
        const after = text.value.slice(to)
        text.value = text.value.slice(0, from)
        const parent = nodes[k]!.parent
        const at = parent.children.indexOf(text)
        const inserted: ElementContent[] = [markOf(match[0])]
        if (after) inserted.push({ type: 'text', value: after })
        parent.children.splice(at + 1, 0, ...inserted)
      } else {
        text.value = text.value.slice(0, from) + text.value.slice(to)
      }
    }
  }
}

export function rehypeRedactionMarks(): (tree: Root) => void {
  return (tree) => visit(tree)
}
