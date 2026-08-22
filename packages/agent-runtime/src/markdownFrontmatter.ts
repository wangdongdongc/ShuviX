/**
 * Markdown 文件开头的 frontmatter 拆分 —— agent 定义文件（agentProfile/definitionFile.ts）
 * 与安全策略文件（security/policyFile.ts）共用。
 *
 * 与 chat-protocol 侧契约判别（shuvixMdContract.ts）的 FRONTMATTER_RE 同族但**不可合并**：
 * 空 frontmatter（`---` 紧跟 `---`）这里合法（全字段走缺省），契约侧拒绝 ——
 * 两侧语义各有测试钉住。
 */

/**
 * 文件开头的 frontmatter 块（容忍 CRLF、空 frontmatter、文件结尾无换行）。
 * 不带 m 标志：`^` 即字符串起始，正文中段的 `---` 块不会被误认，且命中恒在
 * index 0 —— 正文按 match[0].length 切割的前提。内容组带 `??`（先试空、再逐行
 * 扩张到下一个行首 `---`）：闭合定界线取最早者，空 frontmatter 因此仍被接受。
 */
const FRONTMATTER_RE = /^---\r?\n((?:[\s\S]*?\r?\n)??)---[ \t]*(?:\r?\n|$)/

export interface FrontmatterSplit {
  /** 两条定界线之间的 YAML 原文（空 frontmatter 为空串） */
  yaml: string
  /** 闭合定界线之后的正文（未 trim） */
  body: string
}

/** 剥 BOM 与前导空白后拆分文件开头的 frontmatter 块；无（或不在开头）返回 null */
export function splitFrontmatter(raw: string): FrontmatterSplit | null {
  const text = raw.replace(/^\uFEFF/, '').replace(/^\s+/, '')
  const match = FRONTMATTER_RE.exec(text)
  if (!match) return null
  return { yaml: match[1], body: text.slice(match[0].length) }
}
