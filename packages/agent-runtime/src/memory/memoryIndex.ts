/**
 * 项目记忆索引渲染 —— `<project_memory>` 围栏的正文（围栏本身由 createAgent 加）。
 *
 * 两层结构，对应两种成本：**常驻区**是 `pinned` 记忆的正文（每会话全额付，用于那些
 * 「必须照办、不能指望模型自己想起来展开」的条目）；**索引区**每条只有一行召回条件
 * （O(N) 常付，正文按需 read）。索引里刻意不写完整路径 —— 根路径在表头给一次，
 * 条目只给 slug，否则每条要多付一个绝对路径。
 *
 * 索引是**注入时现扫现渲染**的，不落地成文件：物理索引文件会与正文漂移（改了正文忘改
 * 索引是常态），现扫就没有第二份真相、没有第二次写入、没有索引维护。
 *
 * 写入段落放在围栏内而不是 agent md 正文里：它必须跟着 `shuvix-project-memory` 开关
 * 一起来一起走，否则关掉开关后写入指令还在，会指向一个不注入的目录。**零条记忆时也要
 * 输出这一段** —— 否则记忆库永远无法从空启动。
 *
 * 文案刻意压到最短：它每个会话必付。写入格式用一行键名列举而非缩进模板 —— 解析器只硬性
 * 要求 frontmatter 存在，键写漏了只会得到空字段而非整份判废，不值得为它铺八行样例。
 * 英文：模型面文本，与内置策略的 en 基准同源；用户可见的中日文案不走这里。
 */
import type { ParsedMemoryFile } from './memoryFile'

const WRITING = `## Writing

Worth carrying into later sessions? Write <root>/<slug>.md — YAML frontmatter with
\`shuvix: memory v1\`, \`name\`, \`description\`, and \`shuvix-memory-recall\` (one line: when
this is worth opening), then the memory itself and why it holds.

Edit an existing memory rather than adding a near-duplicate; delete one that turns out
to be wrong. Do not record what the repository already states (code structure, bugs you
fixed, git history, the instruction file), or what only matters to this conversation —
when asked to remember those, record only the part that was not obvious. Every write
asks the user first.`

/** 日期戳；无 updated 时不带括号 */
function stamp(m: ParsedMemoryFile): string {
  return m.updated ? ` (${m.updated})` : ''
}

/**
 * 渲染围栏正文。`memoryDir` 为该项目的记忆目录绝对路径（表头引用一次）。
 * 恒返回非空字符串 —— 零条记忆时只有一句说明与写入段。
 */
export function renderMemoryIndex(
  memories: readonly ParsedMemoryFile[],
  memoryDir: string
): string {
  const root = memoryDir.replace(/[/\\]+$/, '')
  const pinned = memories.filter((m) => m.pinned)
  const indexed = memories.filter((m) => !m.pinned)

  const sections: string[] = []

  sections.push(
    memories.length > 0
      ? `Things learned earlier on this project. Each records what was true when written —\nverify any code detail against the current code before relying on it. The index gives\nonly when a memory is worth opening; read one with \`read\` at ${root}/<slug>.md.`
      : `No memories recorded for this project yet. Root: ${root}`
  )

  if (pinned.length > 0) {
    const blocks = pinned.map((m) => `### ${m.name}${stamp(m)}\n${m.body}`)
    sections.push(`## Always applies\n\n${blocks.join('\n\n')}`)
  }

  if (indexed.length > 0) {
    const lines = indexed.map(
      (m) =>
        `- ${m.name}${stamp(m)} — ${m.recall.trim() || m.description.trim() || '(no recall condition recorded)'}`
    )
    sections.push(`## Index\n\n${lines.join('\n')}`)
  }

  sections.push(WRITING.replace('<root>/<slug>.md', `${root}/<slug>.md`))

  return sections.join('\n\n')
}
