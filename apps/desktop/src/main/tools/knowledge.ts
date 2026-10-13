/**
 * knowledge 工具（桌面注册）—— 复用 @shuvix/agent-runtime 的共享 createKnowledgeTool 内核。
 *
 * 检索、盘点，加条目的**提交检查**（`submit`）。条目正文不经它 —— 走普通 `write` / `edit`，由写钩子
 * 刷新 `generated`、由 fileToolDeps 的 onFileChange 接同一条变更管线。
 *
 * 桌面只注入端适配：Node fs port、base 的解析与列举（`project` = 根会话所属项目的库，其余名字 =
 * `~/.shuvix/knowledge/` 下的用户库）、bundle 的扫描与检索（services/knowledge）、桌面 SecurityContext
 * （与文件工具同一道门）、调用方 actor、写手的同步派发（与 `agent` 工具同一条派发路由，写手那条对话
 * 挂在这次工具调用下）、盖章后的变更管线（提交 + 事件）。
 */
import {
  buildKnowledgeReviewPrompt,
  createKnowledgeTool,
  KNOWLEDGE_DESCRIPTION,
  KNOWLEDGE_REVIEW_CONTRACT,
  KNOWLEDGE_TOOL_NAME,
  KNOWLEDGE_WRITER_PROFILE_NAME,
  KnowledgeParamsSchema,
  readKnowledgeReviewResult,
  toInProcessAgentType,
  type KnowledgeReviewOutcome,
  type KnowledgeReviewRequest,
  type ToolCallScope
} from '@shuvix/agent-runtime'
import { BUILTIN_TOOL_PRESENTATIONS } from '@shuvix/chat-protocol/builtinToolPresentations'
import {
  getDesktopSecurityContext,
  resolveProjectConfig,
  TOOL_ABORTED,
  type ToolContext
} from '../services/toolContext'
import { agentActorOf, withCallAgent, type ToolAgentIdentity } from '../services/toolAgent'
import { registerBuiltinTool } from '../services/toolRegistry'
import {
  listBases,
  locateBundle,
  recordKnowledgeChange,
  resolveBase,
  scanBundle,
  searchBundle
} from '../services/knowledge'
import { agentService } from '../services/agentService'
import { agentManager } from '../agents/AgentManager'
import { nodeFileSystemPort } from '../utils/toolUtils/nodeFileSystemPort'
import { t } from '../i18n'

/**
 * 工具只认 bundle 的绝对路径；宿主这边按它反查 bundle id（`projects/<id>` / `knowledge/<库名>`）。
 * locateBundle 收的是文件路径，拼上去的文件名只是个探针
 */
function bundleIdOf(dir: string): string | null {
  return locateBundle(`${dir.replace(/[/\\]+$/, '')}/probe.md`)?.bundle ?? null
}

/**
 * 章上的写手身份：按它那条对话现取（模型可能来自它的 md，与调用方不同）。认不出就记成「写手 / 模型未知」——
 * 不能经 withCallAgent 退回 ctx 原有的身份，那会把提交者自己记成确认者。
 */
function reviewerActor(ctx: ToolContext, conversationId: number | undefined): string {
  let identity: ToolAgentIdentity | undefined
  try {
    identity = conversationId === undefined ? undefined : ctx.agentOf?.(conversationId)
  } catch {
    identity = undefined
  }
  return agentActorOf({
    agent: identity ?? { profileName: KNOWLEDGE_WRITER_PROFILE_NAME, kind: 'spawned' }
  })
}

/**
 * 同步派写手检查一条：与 `agent` 工具同一条派发路由（子对话归这次工具调用、内联在它的卡片下），多一份
 * 结果契约（`next` 交回 `{passed, report}`）。写手的模型按通用规则来：它的 md 声明了 `shuvix-model`
 * （或在内置卡片上填了）就用那个，否则跟随调用方。
 */
async function runReview(
  ctx: ToolContext,
  req: KnowledgeReviewRequest,
  run: { call: ToolCallScope | undefined; toolCallId: string; signal?: AbortSignal }
): Promise<KnowledgeReviewOutcome> {
  if (!run.call) return { error: 'no tool call to run the writer under' }
  const profile = agentService.getProfile(KNOWLEDGE_WRITER_PROFILE_NAME)
  if (!profile) return { error: `the "${KNOWLEDGE_WRITER_PROFILE_NAME}" agent is not available` }
  const outcome = await agentManager.runTask({
    sessionId: ctx.sessionId,
    owner: { tool: run.call },
    parentToolCallId: run.toolCallId,
    agentType: toInProcessAgentType(profile),
    prompt: buildKnowledgeReviewPrompt({
      ...req,
      sessionId: ctx.sessionId,
      workingDirectory: resolveProjectConfig(ctx.sessionId).workingDirectory
    }),
    description: `Check ${req.rel}`,
    resultContract: KNOWLEDGE_REVIEW_CONTRACT
  })
  const result = readKnowledgeReviewResult(outcome.structured)
  if (!result) return { error: outcome.error ?? 'it finished without a verdict' }
  return { ...result, reviewer: reviewerActor(ctx, outcome.conversationId) }
}

export const makeKnowledgeTool = (ctx: ToolContext): ReturnType<typeof createKnowledgeTool> =>
  createKnowledgeTool({
    port: nodeFileSystemPort,
    security: getDesktopSecurityContext(ctx),
    // ctx.sessionId 恒为根会话 id（派生 agent 按根会话解析）
    resolveBase: (base) => resolveBase(ctx.sessionId, base),
    listBases: () => listBases(ctx.sessionId),
    scan: async (dir) => {
      const located = bundleIdOf(dir)
      if (!located) return { files: [], concepts: [], notes: [] }
      const { files, concepts, notes } = await scanBundle(located)
      return { files, concepts, notes }
    },
    search: (query, opts) => {
      const located = bundleIdOf(opts.bundleDir)
      return located ? searchBundle(located, query, { limit: opts.limit }) : Promise.resolve([])
    },
    // 提交者 = 发起这次调用的 agent（会话级装配的工具被同一会话的每个 agent 共用）
    actor: (call) => agentActorOf(withCallAgent(ctx, call)),
    now: () => new Date(),
    review: (req, run) => runReview(ctx, req, run),
    // 写手拿着 knowledge 只为检索：它自己的 submit 一律拒
    isReviewer: (call) =>
      withCallAgent(ctx, call).agent?.profileName === KNOWLEDGE_WRITER_PROFILE_NAME,
    // 盖章是工具自己落盘（不经文件工具），所以变更管线要自己记一笔；正文那条路由 onFileChange 接
    afterWrite: (e, call) => {
      const located = bundleIdOf(e.bundleDir)
      if (!located) return
      recordKnowledgeChange({
        bundle: located,
        path: e.path,
        op: 'Update',
        actor: agentActorOf(withCallAgent(ctx, call))
      })
    },
    abortError: TOOL_ABORTED,
    label: t(BUILTIN_TOOL_PRESENTATIONS[KNOWLEDGE_TOOL_NAME].labelKey)
  })

registerBuiltinTool({
  name: KNOWLEDGE_TOOL_NAME,
  group: 'general',
  getLabel: () => t(BUILTIN_TOOL_PRESENTATIONS[KNOWLEDGE_TOOL_NAME].labelKey),
  getHint: () => t('tool.knowledgeHint'),
  factory: (ctx) => makeKnowledgeTool(ctx),
  presentation: BUILTIN_TOOL_PRESENTATIONS[KNOWLEDGE_TOOL_NAME].presentation,
  describe: () => ({
    description: KNOWLEDGE_DESCRIPTION,
    parameters: KnowledgeParamsSchema
  })
})
