/**
 * 知识库条目的**提交检查**（`knowledge` 工具的 `submit`）—— 宿主无关的那一半：派给写手的任务文本、
 * 结果契约、交回结果的读法，以及通过之后宿主盖的章。
 *
 * 条目由主 agent 用文件工具直接写进库里（普通 md，不必带元数据），`submit` 同步派内置的
 * `knowledge-writer` 过一道门：它补齐 / 修正元数据与格式，判内容是否站得住（一件事、冷读得懂、
 * 每个说法有出处），经 `next` 交回 `{passed, report}`。**写手只判，不盖章**：通过之后由宿主在
 * `verified` 里记一笔机器确认（OKF 的 machine-confirmed 档）—— 与 `generated` 由写钩子盖同一个道理，
 * 模型手里从来没有「宣称自己核实过」这条路。人工审阅（`human:` actor）只来自 UI 动作。
 *
 * 写手只能经这里调起（宿主专用档案，派发工具按名解析不到）：被检查的 agent 若能直接派它，就能反复
 * 拿它试探「什么写法能过」。
 */
import { parseOkfText } from './okfCodec'
import { upsertFrontmatterMappings } from '../shuvixMdWrite'
import type { ResultContract } from '../subagent/nextTool'

/** 提交检查的执行方（内置档案名；用户可按名覆盖它的 md） */
export const KNOWLEDGE_WRITER_PROFILE_NAME = 'knowledge-writer'

/** 写手的结果契约：判没判过 + 给作者看的几行报告 */
export const KNOWLEDGE_REVIEW_CONTRACT: ResultContract = {
  schema: {
    type: 'object',
    properties: {
      passed: {
        type: 'boolean',
        description:
          'true when the entry is about one subject, reads cold, and every claim has a source'
      },
      report: {
        type: 'string',
        description:
          'A few lines for the author: what you added or changed, and when failing, exactly what to fix'
      }
    },
    required: ['passed', 'report'],
    additionalProperties: false
  },
  sourceLabel: 'knowledge submit'
}

/** 交给宿主的一次检查请求 */
export interface KnowledgeReviewRequest {
  /** 工具里点名的 base */
  base: string
  /** 库的人读标签（如 `knowledge base "notes"`） */
  label: string
  /** 库目录（绝对） */
  bundleDir: string
  /** 条目的绝对路径 */
  path: string
  /** 条目在库内的相对路径（不带前导 `/`） */
  rel: string
  /** 提交它的 agent（`shuvix-<profile>/<model>`） */
  submittedBy: string
}

/** 宿主跑完写手交回的结论；`error` = 写手没跑成（与「没通过」不同） */
export type KnowledgeReviewOutcome =
  | {
      passed: boolean
      report: string
      /** 写手的 actor（`shuvix-knowledge-writer/<model>`）—— 通过时记进 `verified.by` */
      reviewer: string
    }
  | { error: string }

/**
 * 派给写手的任务文本。规范本身住在写手的 md 里（用户可覆盖）；这里只给这一次的事实：哪个文件、
 * 哪个库、谁提交的、提交它的会话的工作目录（相对路径据此解析）、本会话的 `shuvix://session/<id>`
 *（对话里确立的事以它为出处）。
 */
export function buildKnowledgeReviewPrompt(
  req: KnowledgeReviewRequest & { sessionId?: string; workingDirectory?: string }
): string {
  return [
    'Check this knowledge-base entry and complete its metadata.',
    '',
    `- Entry: ${req.path}`,
    `- Base: "${req.base}" (${req.label}) — ${req.bundleDir}`,
    `- Submitted by: ${req.submittedBy}`,
    // 条目正文里写的多半是项目相对路径（`src/auth/refresh.ts`）；写手的提示词里没有环境段，不给它工作目录，
    // 它就既找不到那个文件、也写不出 `sources` 要的绝对路径（真模型探针里它因此退回到会话 URI）
    ...(req.workingDirectory
      ? [
          `- Working directory (resolve relative paths in the entry against it): ${req.workingDirectory}`
        ]
      : []),
    ...(req.sessionId
      ? [
          `- Source for what was established in the submitting conversation: shuvix://session/${req.sessionId}`
        ]
      : [])
  ].join('\n')
}

/** 结果契约捕获的对象 → `{passed, report}`；形状不对返回 null（当作没交回结论） */
export function readKnowledgeReviewResult(
  structured: unknown
): { passed: boolean; report: string } | null {
  if (typeof structured !== 'object' || structured === null) return null
  const { passed, report } = structured as { passed?: unknown; report?: unknown }
  if (typeof passed !== 'boolean') return null
  return { passed, report: typeof report === 'string' ? report.trim() : '' }
}

function flowStamp(s: { by: string; at: string }): string {
  return `{ by: ${JSON.stringify(s.by)}, at: ${JSON.stringify(s.at)} }`
}

/**
 * 通过之后的章：`generated` 记**提交者**（内容是它写的 —— 写手补元数据那几笔 edit 会被写钩子盖成写手，
 * 这里改回来），`verified` 追加写手的机器确认，两者同一时刻，核实因此恰好「仍当前」。
 *
 * 旧的机器确认被这一笔取代（只留最新一条，免得每次重新提交都往列表里堆一行）；人工核实是历史，**原样**
 * 保留（连同缺字段、多出来的键 —— 宿主不替人改写他的记录）。它们早于这次的 `generated`，视图按
 * currentTrustTierOf 不再拿它们为新内容背书。文件开头不是 frontmatter（写手没补上）返回 null。
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
