/**
 * 知识库的**提交**（`knowledge` 工具的 `submit`）—— 宿主无关的那一半：交给知识库管理员的任务文本、
 * 结果契约、交回结果的读法，以及它收录之后宿主盖的章。
 *
 * **2026-11-08 改版：库目录只有管理员知道。** 别的 agent 只认库名与条目名（库内路径），条目一律经工具
 * 的 `read` 看；它们不再自己往库里写，而是把要记的内容交上来（`content`，可附一条它更正 / 补充的条目）。
 * 宿主同步派内置的 `knowledge-writer`（显示名「知识库管理员」）：它拿着库目录和文件工具、bash，自己决定
 * 新建、改写、合并、改名还是删掉条目，或者不收；经 `next` 交回 `{accepted, entries, report}`。
 *
 * **管理员只记账，不盖章**：它动过、且仍合规的条目由宿主盖章 —— `generated` 记**提交者**（内容出自谁），
 * `verified` 记管理员的机器确认（OKF 的 machine-confirmed 档）。模型手里从来没有「宣称自己核实过」这条路；
 * 人工审阅（`human:` actor）只来自 UI 动作。
 *
 * **迁移（2026-11-11，docs/project-split-design.md §5）**：`knowledge` 工具的 `migrate` 交上来的不是一段内容，而是另一个
 * 项目库里的现成条目（原路径 + 原文，宿主读的，不经发起迁移的 agent 重抄）。照旧派管理员，任务文本与结果契约各换
 * 一份：它多交一项 `taken` —— 它收下的那几条（按原路径）；宿主之后只把这几条从源库删掉。点名「收下的」而不是
 * 「没收的」：它漏写或写错一条时，那一条留在源库（两边各一份），而不是被删掉。盖章规则与提交相同。
 *
 * 管理员只能经这里调起（宿主专用档案，派发工具按名解析不到）。它的边界（只动库里的文件、不碰用户自己的笔记、
 * 不去库外核实事实）只写在它的提示词里 —— 不设硬卡点（2026-11-08 裁决）。
 */
import { parseOkfText } from './okfCodec'
import { upsertFrontmatterMappings } from '../shuvixMdWrite'
import type { ResultContract } from '../subagent/nextTool'

/** 知识库管理员（内置档案名；用户可按名覆盖它的 md）。名字沿用改版前的写手，覆盖文件照旧按它认 */
export const KNOWLEDGE_WRITER_PROFILE_NAME = 'knowledge-writer'

/** 管理员交回的一条改动 */
export const KNOWLEDGE_ENTRY_CHANGES = ['created', 'updated', 'deleted'] as const
export type KnowledgeEntryChange = (typeof KNOWLEDGE_ENTRY_CHANGES)[number]

/** 管理员的结果契约：收没收 + 动了哪几条 + 给提交者看的几行报告 */
export const KNOWLEDGE_ADMIN_CONTRACT: ResultContract = {
  schema: {
    type: 'object',
    properties: {
      accepted: {
        type: 'boolean',
        description: 'true when the base now records the submission; false when you turned it down'
      },
      entries: {
        type: 'array',
        description:
          'Every entry you created, changed or deleted, by its path inside the base ("/auth/session.md"). A rename is the old name deleted and the new one created.',
        items: {
          type: 'object',
          properties: {
            entry: { type: 'string' },
            change: { type: 'string', enum: [...KNOWLEDGE_ENTRY_CHANGES] }
          },
          required: ['entry', 'change'],
          additionalProperties: false
        }
      },
      report: {
        type: 'string',
        description:
          'A few lines for the submitter: where it went and why, or why you turned it down. Name entries by their path inside the base, never by the directory.'
      }
    },
    required: ['accepted', 'entries', 'report'],
    additionalProperties: false
  },
  sourceLabel: 'knowledge submit'
}

/**
 * 迁移的结果契约：同提交那一份，多一项必填的 `taken`（它收下的条目，按原路径）。单独一份而不是给提交的契约
 * 加一个可选项：那份契约的字段描述每次提交都进管理员的 `next` 工具，迁移才用得上的字段不该让每次提交都付。
 */
export const KNOWLEDGE_MIGRATION_CONTRACT: ResultContract = {
  schema: {
    type: 'object',
    properties: {
      accepted: {
        type: 'boolean',
        description:
          'true when the base now holds at least one of the migrated entries; false when you turned all of them down'
      },
      entries: {
        type: 'array',
        description:
          'Every entry of this base you created, changed or deleted, by its path inside the base ("/auth/session.md"). A rename is the old name deleted and the new one created.',
        items: {
          type: 'object',
          properties: {
            entry: { type: 'string' },
            change: { type: 'string', enum: [...KNOWLEDGE_ENTRY_CHANGES] }
          },
          required: ['entry', 'change'],
          additionalProperties: false
        }
      },
      taken: {
        type: 'array',
        description:
          'The original path of every migrated entry this base now holds — taken as it was, merged or renamed. Exactly these are removed from the base they came from; the ones you leave out stay there.',
        items: { type: 'string' }
      },
      report: {
        type: 'string',
        description:
          'A few lines for whoever asked for the migration: where each entry went, and why you turned any down. Name entries by their path inside the base, never by the directory.'
      }
    },
    required: ['accepted', 'entries', 'taken', 'report'],
    additionalProperties: false
  },
  sourceLabel: 'knowledge migrate'
}

/** 一次迁移里交给管理员的一条：它在原来那个库里的路径（不带前导 `/`）与原文 */
export interface KnowledgeMigratedEntry {
  entry: string
  text: string
}

/** 交给宿主的一次提交 */
export interface KnowledgeSubmission {
  /** 工具里点名的 base */
  base: string
  /** 库的人读标签（如 `knowledge base "notes"`） */
  label: string
  /** 库目录（绝对）—— 只给管理员 */
  bundleDir: string
  /** 提交的内容（markdown） */
  content: string
  /** 提交者点名的那一条（库内相对路径，不带前导 `/`）：这次是对它的更正或补充 */
  entry?: string
  /** 提交它的 agent（`shuvix-<profile>/<model>`） */
  submittedBy: string
  /**
   * 迁移（`migrate`）：这次交上来的是另一个库里的现成条目，`content` 为空串。`from` 是源库的人读标签
   * （`project "big"`）—— 源库的目录不给管理员，它只动自己那个库
   */
  migration?: { from: string; entries: KnowledgeMigratedEntry[] }
}

/** 管理员交回的一条改动（`entry` 已归一成库内相对路径，不带前导 `/`） */
export interface KnowledgeEntryChangeRecord {
  entry: string
  change: KnowledgeEntryChange
}

/** 宿主跑完管理员交回的结论；`error` = 管理员没跑成（与「不收」不同） */
export type KnowledgeAdminOutcome =
  | {
      accepted: boolean
      entries: KnowledgeEntryChangeRecord[]
      report: string
      /** 管理员的 actor（`shuvix-knowledge-writer/<model>`）—— 收录时记进 `verified.by` */
      admin: string
      /** 迁移：它收下的条目（原路径，不带前导 `/`）；提交没有这一项 */
      taken?: string[]
    }
  | { error: string }

/**
 * 派给管理员的任务文本。规则住在它的 md 里（用户可覆盖）；这里只给这一次的事实：哪个库、库目录、谁提交的、
 * 提交者点名的条目、提交它的会话的工作目录（相对路径据此拼成 `sources` 的绝对路径）、本会话的
 * `shuvix://session/<id>`（对话里确立的事以它为出处），最后是提交的内容本身。
 */
export function buildKnowledgeAdminPrompt(
  req: KnowledgeSubmission & { sessionId?: string; workingDirectory?: string }
): string {
  if (req.migration) return buildKnowledgeMigrationPrompt(req, req.migration)
  return [
    'Record this submission in the knowledge base.',
    '',
    `- Base: "${req.base}" (${req.label}) — directory ${req.bundleDir}`,
    `- Submitted by: ${req.submittedBy}`,
    ...(req.entry ? [`- It corrects or extends: /${req.entry}`] : []),
    // 提交的内容里写的多半是项目相对路径（`src/auth/refresh.ts`）；管理员的提示词里没有环境段，不给它工作目录，
    // 它就写不出 `sources` 要的绝对路径。只给它拼路径用：管理员不核实事实 —— 早先这一行写的是「据此解析相对
    // 路径」，用户反馈它真的跑去工作区翻源码确认技术细节
    ...(req.workingDirectory
      ? [
          `- Working directory of the submitting session (only for turning a relative path the submission names into an absolute one in sources; do not open anything there): ${req.workingDirectory}`
        ]
      : []),
    ...(req.sessionId
      ? [
          `- Source for what was established in the submitting conversation: shuvix://session/${req.sessionId}`
        ]
      : []),
    '',
    'Submission:',
    '',
    req.content.trim()
  ].join('\n')
}

/**
 * 迁移的任务文本：哪个库、库目录、条目从哪来、谁发起的，然后是每一条的原路径与原文。条目各套一层 `<entry>` 围栏
 * —— 原文自带 frontmatter 的 `---`，不围起来分不清一条到哪里结束。怎么收的规矩在管理员的 md 里。
 */
function buildKnowledgeMigrationPrompt(
  req: KnowledgeSubmission,
  migration: NonNullable<KnowledgeSubmission['migration']>
): string {
  return [
    'Take these entries into the knowledge base. They are being migrated from another base: each one you take in is removed from there afterwards.',
    '',
    `- Base: "${req.base}" (${req.label}) — directory ${req.bundleDir}`,
    `- They come from: the base of ${migration.from}`,
    `- Migrated by: ${req.submittedBy}`,
    '',
    `Entries (${migration.entries.length}), each with the path it had there:`,
    '',
    ...migration.entries.flatMap((e) => [
      `<entry path="/${entryName(e.entry)}">`,
      e.text.trimEnd(),
      '</entry>',
      ''
    ])
  ]
    .join('\n')
    .trimEnd()
}

/** 库内路径的归一：去空白、反斜杠转正、去前导 `/` */
function entryName(raw: string): string {
  return raw.trim().replace(/\\/g, '/').replace(/^\/+/, '')
}

/** 结果契约捕获的对象 → `{accepted, entries, report}`；形状不对返回 null（当作没交回结论） */
export function readKnowledgeAdminResult(structured: unknown): {
  accepted: boolean
  entries: KnowledgeEntryChangeRecord[]
  report: string
  /** 迁移的结论才有：收下的条目（归一成库内相对路径、去重） */
  taken?: string[]
} | null {
  if (typeof structured !== 'object' || structured === null) return null
  const { accepted, entries, report, taken } = structured as {
    accepted?: unknown
    entries?: unknown
    report?: unknown
    taken?: unknown
  }
  if (typeof accepted !== 'boolean') return null
  const changes: KnowledgeEntryChangeRecord[] = []
  for (const item of Array.isArray(entries) ? entries : []) {
    if (typeof item !== 'object' || item === null) continue
    const { entry, change } = item as { entry?: unknown; change?: unknown }
    if (typeof entry !== 'string' || !entryName(entry)) continue
    if (!KNOWLEDGE_ENTRY_CHANGES.includes(change as KnowledgeEntryChange)) continue
    changes.push({ entry: entryName(entry), change: change as KnowledgeEntryChange })
  }
  const tookIn = Array.isArray(taken)
    ? [
        ...new Set(
          taken
            .filter((d): d is string => typeof d === 'string')
            .map(entryName)
            .filter(Boolean)
        )
      ]
    : undefined
  return {
    accepted,
    entries: changes,
    report: typeof report === 'string' ? report.trim() : '',
    ...(tookIn ? { taken: tookIn } : {})
  }
}

function flowStamp(s: { by: string; at: string }): string {
  return `{ by: ${JSON.stringify(s.by)}, at: ${JSON.stringify(s.at)} }`
}

/**
 * 收录之后的章：`generated` 记**提交者**（内容出自它 —— 管理员落笔那几次会被写钩子盖成管理员，这里改回来），
 * `verified` 追加管理员的机器确认，两者同一时刻，核实因此恰好「仍当前」。
 *
 * 旧的机器确认被这一笔取代（只留最新一条，免得每次提交都往列表里堆一行）；人工核实是历史，**原样**
 * 保留（连同缺字段、多出来的键 —— 宿主不替人改写他的记录）。它们早于这次的 `generated`，视图按
 * currentTrustTierOf 不再拿它们为新内容背书。文件开头不是 frontmatter 返回 null。
 */
export function stampKnowledgeReview(
  text: string,
  stamp: { submittedBy: string; reviewer: string; at: string }
): string | null {
  const raw = parseOkfText(text)?.fields.verified
  const items: unknown[] = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw]
  // 认不出形状的项（不是映射、没有 by）不是谁的核实记录，也不是人工那一档：与旧的机器章一起让位
  const humans = items.filter(
    (v): v is Record<string, unknown> =>
      typeof v === 'object' &&
      v !== null &&
      !Array.isArray(v) &&
      typeof (v as { by?: unknown }).by === 'string' &&
      (v as { by: string }).by.startsWith('human:')
  )
  const flow = [
    ...humans.map((h) => JSON.stringify(h)),
    flowStamp({ by: stamp.reviewer, at: stamp.at })
  ]
  const verifiedValue = flow.length === 1 ? flow[0] : `[${flow.join(', ')}]`
  return upsertFrontmatterMappings(text, [
    ['generated', flowStamp({ by: stamp.submittedBy, at: stamp.at })],
    ['verified', verifiedValue]
  ])
}
