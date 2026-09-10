/**
 * `<knowledge>` 围栏的正文（围栏本身由 createAgent 加）—— 设计 §7。
 *
 * 两层结构与旧记忆索引同源（memoryIndex.ts），措辞沿用那里实测过的两条：
 * 条目标识用**路径**而不是标题（模型拿不到路径就拼不出 read 参数），表头写明
 * 「动手前先对一遍索引」。预算规则：索引行按宿主给的顺序截到上限，截断时指向目录 index；
 * wiki 只给主题清单（渐进披露：读主题 index 再读条目）。deprecated 不进围栏 —— 宿主在挑选时
 * 就滤掉。**围栏只给索引，不注入任何条目正文**：常驻正文（原 `shuvix_pinned`）已撤销，
 * 知识库到底怎么进系统提示词是留待重新设计的问题。
 *
 * 英文：模型面文本，与内置策略 / 记忆索引的 en 基准同源；用户可见的文案不走这里。
 */
import { KNOWLEDGE_DIRS } from '@shuvix/chat-protocol/knowledge'
import { isStale, isVerificationCurrent, type KnowledgeConcept } from './conceptFile'
import { normalizeBundlePath } from './scopes'

export interface KnowledgeFenceScope {
  /** 人读标签，如 `global` / `project "acme"` / `bot "alice"` / `this session` */
  label: string
  /** 作用域目录（bundle 相对）；尚不存在的目录给 null（围栏据此说明「还没有条目」） */
  dir: string | null
}

export interface KnowledgeWikiTopic {
  topic: string
  count: number
}

export interface KnowledgeLegacyMemory {
  /** 绝对路径（旧记忆不在 bundle 里） */
  path: string
  recall: string
}

export interface KnowledgeFenceInput {
  /** 根目录绝对路径（表头引用一次；条目只给 bundle 路径） */
  root: string
  scopes: readonly KnowledgeFenceScope[]
  /** 索引条目（宿主已按作用域挑选、按重要性排序；本函数只截断） */
  index: readonly KnowledgeConcept[]
  wikiTopics?: readonly KnowledgeWikiTopic[]
  /** 旧记忆（只读列出，不再给写入指令）—— 设计 D3 */
  legacy?: readonly KnowledgeLegacyMemory[]
  /** 当日（stale 判定） */
  now: Date
  /** 写入段：agent 有 `knowledge` 工具 → 教它用工具；没有 → 教它直接写文件 */
  writing: 'tool' | 'file' | 'none'
  /** 索引行上限（缺省 60） */
  maxIndexLines?: number
}

const DEFAULT_MAX_INDEX_LINES = 60

function dateOf(iso: string | undefined): string {
  return iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : ''
}

/** 一条索引行的标注：状态 / 过期 / 验证是否仍当前 */
function markers(concept: KnowledgeConcept, now: Date): string {
  const parts: string[] = []
  if (concept.status === 'draft') parts.push('draft')
  if (concept.verified.length > 0) {
    parts.push(isVerificationCurrent(concept) ? 'verified' : 'edited after verification')
  }
  if (isStale(concept, now)) parts.push('stale')
  const date = dateOf(concept.generated?.at)
  if (date) parts.push(date)
  return parts.length ? ` (${parts.join(', ')})` : ''
}

function indexLine(concept: KnowledgeConcept, now: Date): string {
  const summary = concept.description.trim() || concept.title.trim() || '(no description)'
  return `- /${normalizeBundlePath(concept.path)}${markers(concept, now)} — ${summary}`
}

const WRITING_TOOL = `## Writing

Worth carrying into later sessions? Call the \`knowledge\` tool with action "write": scope
(global / project / session / bot / wiki), type, a title, a one-line description that says
WHEN this is worth opening, and the entry itself as body. Everything you write is a draft
the user reviews later; do not mark anything verified. Search the index first and update an
existing entry rather than adding a near-duplicate. Do not record what the repository
already states, or what only matters to this conversation.`

const WRITING_FILE = `## Writing

Worth carrying into later sessions? Write a markdown file under the scope directory
(<root>/global/, <root>/projects/<slug>/, …): YAML frontmatter with \`type\`, \`title\`,
a one-line \`description\` that says WHEN it is worth opening, \`status: draft\`, then the
entry itself as the body. Never write \`generated\` or \`verified\` — the host stamps them.
Update an existing entry rather than adding a near-duplicate. Do not record what the
repository already states, or what only matters to this conversation.`

/** 渲染围栏正文。恒返回非空字符串 —— 零条目时也要有表头与写入段，否则库无法从空启动。 */
export function renderKnowledgeFence(input: KnowledgeFenceInput): string {
  const root = input.root.replace(/[/\\]+$/, '')
  const sections: string[] = []

  const scopeList = input.scopes
    .map((s) =>
      s.dir ? `${s.label} (/${normalizeBundlePath(s.dir)})` : `${s.label} (no entries yet)`
    )
    .join(', ')
  sections.push(
    `Knowledge base root: ${root} — an OKF bundle: every entry is markdown with YAML
frontmatter, addressed by its bundle-absolute path. Scopes in this session: ${scopeList || 'global'}.

Before you start, check the index below for anything touching what you are about to do —
an entry you skipped is a mistake you are about to repeat. Read one with \`read\` at
${root}<path>. Entries record what was true when written; verify code details against the
current code. Entries marked (stale) are past their review date; (draft) ones have not been
reviewed by the user.`
  )

  const max = input.maxIndexLines ?? DEFAULT_MAX_INDEX_LINES
  const indexLines = input.index.slice(0, max).map((c) => indexLine(c, input.now))
  if (input.index.length > max) {
    indexLines.push(
      `- … ${input.index.length - max} more; read the scope's index.md (e.g. ${root}/${KNOWLEDGE_DIRS.global}/index.md)`
    )
  }
  if (input.wikiTopics?.length) {
    const topics = input.wikiTopics.map((t) => `${t.topic} (${t.count})`).join(', ')
    indexLines.push(
      `- /${KNOWLEDGE_DIRS.wiki}/ — topics: ${topics}; read /${KNOWLEDGE_DIRS.wiki}/<topic>/index.md for one`
    )
  }
  if (indexLines.length > 0) sections.push(`## Index\n\n${indexLines.join('\n')}`)
  else sections.push('## Index\n\nNo entries recorded yet.')

  if (input.legacy?.length) {
    const lines = input.legacy.map(
      (m) => `- ${m.path} — ${m.recall.trim() || '(no recall condition)'}`
    )
    sections.push(
      `## Legacy project memories (read-only)\n\nOlder memories kept outside the bundle. Read with \`read\`; do not write there.\n\n${lines.join('\n')}`
    )
  }

  if (input.writing === 'tool') sections.push(WRITING_TOOL)
  else if (input.writing === 'file') sections.push(WRITING_FILE.replaceAll('<root>', root))

  return sections.join('\n\n')
}
