/**
 * 自动脱敏的标记插件（utils/rehypeRedactionMarks.ts），跑生产那两张插件表：
 *
 *   RM-1 正文、强调、表格、行内代码里的占位符都成了 `<redaction-mark>`，子节点是占位符原文；不是标准写法的不动
 *   RM-2 代码块（有语言、高亮过）：占位符被高亮切成几段时也认得出，标记只有一个，全文仍与源码一致
 *   RM-3 正文里手写的 `<redaction-mark>` 过不了净化（进不到插件，也就不会冒充）
 *   RM-4 公式不碰
 */
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import { toText } from 'hast-util-to-text'
import type { Element, Root, RootContent } from 'hast'
import { unified, type Processor } from 'unified'
import { describe, expect, it } from 'vitest'
import { markdownRehypePlugins, markdownRemarkPlugins } from './markdownPlugins'
import { REDACTION_MARK_TAG } from './rehypeRedactionMarks'

const KEY = '{{API_KEY_k3v7x2mq}}'
const MAIL = '{{EMAIL_b5puzbfv}}'

const proc = unified()
  .use(remarkParse)
  .use(markdownRemarkPlugins)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(markdownRehypePlugins) as unknown as Processor

function tree(md: string): Root {
  return proc.runSync(proc.parse(md)) as Root
}

function marks(node: Root | RootContent, out: Element[] = []): Element[] {
  if (node.type === 'element' && node.tagName === REDACTION_MARK_TAG) out.push(node)
  if ('children' in node) for (const child of node.children) marks(child as RootContent, out)
  return out
}

const markText = (root: Root): string[] => marks(root).map((m) => toText(m))

describe('脱敏标记插件', () => {
  it('RM-1 正文、强调、表格、行内代码', () => {
    const root = tree(
      `key ${KEY} and **${MAIL}**\n\n| a | b |\n|---|---|\n| ${KEY} | x |\n\n\`curl -H ${KEY}\`\n\n{{ API_KEY_k3v7x2mq }}`
    )
    expect(markText(root)).toEqual([KEY, MAIL, KEY, KEY])
    expect(toText(root)).toContain('{{ API_KEY_k3v7x2mq }}')
  })

  it('RM-2 代码块：高亮切开的占位符也认得出，全文不变', () => {
    for (const lang of ['bash', 'json', 'python', 'yaml', 'handlebars', '']) {
      const code = `export OPENAI_API_KEY="${KEY}"\nemail: ${MAIL}\nprint("{{x}}", ${KEY})`
      const root = tree('```' + lang + '\n' + code + '\n```')
      expect(markText(root), lang).toEqual([KEY, MAIL, KEY])
      expect(toText(root).trim(), lang).toBe(code)
    }
  })

  it('RM-3 手写的标签过不了净化', () => {
    const root = tree('before <redaction-mark>sk-forged</redaction-mark> after')
    expect(marks(root)).toEqual([])
  })

  it('RM-4 公式不碰', () => {
    const root = tree(`$$\n\\text{${KEY}}\n$$`)
    expect(marks(root)).toEqual([])
  })
})
