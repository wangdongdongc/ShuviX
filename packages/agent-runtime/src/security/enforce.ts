/**
 * 决策执行（PEP 共享内脏）—— evaluate 之后的统一处置：
 *   allow → 放行
 *   deny  → throw（AI 收到 tool error 自行决定）
 *   ask   → 经 requestUserInput 挂起询问 → 四分支响应处理
 *
 * 这里收敛了迁移前分散在 assertPathAllowed / bash / ssh / git askOp 的
 * 四份重复响应处理，差异全部经 EnforceOpts 表达：
 *   - onOther：用户选「其它」（反馈文本）时 throw（路径/git）还是作为正常结果返回（bash/ssh）
 *   - missingChannel：ask 且无询问通道时 fail-closed（deny）还是放行
 *   - preview / description / abortError：询问卡片材料
 *
 * 命中规则的 prompt（策略 md 的人读提示语）按 effect 分投：deny 拼进抛出的错误
 * （agent 的 tool result 与用户的工具块是同一段），ask 只挂到询问卡片上 ——
 * 询问是给用户就地判断用的，不该把策略文本塞进模型上下文。
 *
 * 客体是开放属性文档 —— 摘要/展示/文案按属性推导（path/command 属性优先，
 * type 只做少数特判），新客体类型自动获得合理的兜底展示。
 * 拒绝文案与迁移前逐字一致（既有询问测试的等价护栏）；无通道文案随 ask 词汇统一改写过。
 */
import {
  isPermissionVerdict,
  type PermissionVerdict
} from '@shuvix/chat-protocol/types/permissionReview'
import type {
  EnforceOpts,
  EnforceOutcome,
  PermissionReviewAnswer,
  SecurityDecision,
  SecurityDecisionRecord,
  SecurityHostProvider,
  SecurityRequest
} from './types'
import { recordDecision } from './decisionLog'
import {
  noteHumanFeedback,
  noteReviewAllowed,
  noteReviewCleared,
  noteReviewDenied,
  reviewSuspended,
  takeReviewAllowed,
  trackReview
} from './reviewState'

/** 客体摘要（决策日志）：路径全量 / 命令与 SQL 截断 200 字符 / 其余回退 type */
function summarizeObject(request: SecurityRequest): string {
  const object = request.object
  if (typeof object.path === 'string') return object.path
  if (typeof object.command === 'string') return object.command.slice(0, 200)
  if (typeof object.sql === 'string') return object.sql.slice(0, 200)
  if (typeof object.url === 'string') return object.url.slice(0, 200)
  if (object.type === 'invocation') {
    const tool = request.tool
    if (!tool) return 'invocation'
    return tool.operation ? `${tool.name}: ${tool.operation}` : tool.name
  }
  return object.type
}

/**
 * 路径类：请求时的写法（门面解析真实去处之前的那条），与真实去处相同或非路径客体时 undefined。
 * 文案、卡片与日志据此把两条都交代清楚 —— 只说其中一条，要么看不出被链接带去了哪里，
 * 要么认不出是哪一次调用。
 */
function redirectedFrom(request: SecurityRequest): string | undefined {
  const { object } = request
  if (object.type !== 'path' || typeof object.requestedPath !== 'string') return undefined
  return object.requestedPath !== object.path ? object.requestedPath : undefined
}

/**
 * 拒绝类文案的补注：请求的路径落到了别处时，把真实去处说出来 ——
 * 否则 agent 看到的是「工作区里的一个文件被凭据门拒了」，只能瞎猜为什么
 */
function resolutionNote(request: SecurityRequest): string {
  const from = redirectedFrom(request)
  return from ? ` (${from} resolves to ${String(request.object.path)})` : ''
}

/** 展示名：路径类优先 displayPath（缺省用请求时的写法），带命令/SQL 属性的用其原文 */
function displayName(request: SecurityRequest, opts: EnforceOpts): string {
  const object = request.object
  if (object.type === 'path') {
    return opts.displayPath ?? String(object.requestedPath ?? object.path ?? '')
  }
  if (typeof object.command === 'string') return object.command
  if (typeof object.sql === 'string') return object.sql
  if (typeof object.url === 'string') return object.url
  return summarizeObject(request)
}

/** 拒绝（未允许）时的默认文案 —— 按客体 type 与迁移前逐字一致 */
function deniedMessage(request: SecurityRequest, display: string): string {
  switch (request.object.type) {
    case 'path':
      return `User denied access to ${display}`
    case 'command':
      return 'User denied execution of this command'
    case 'url':
      return `User denied opening ${display}`
    default:
      return `User denied ${display}`
  }
}

/** 用户选「其它」且 onOther='throw' 时的文案 */
function otherMessage(request: SecurityRequest, display: string, text: string): string {
  if (request.object.type === 'path') {
    return `User declined access to ${display} and provided feedback instead: ${text}`
  }
  return `User declined ${display} and provided feedback instead: ${text}`
}

/** ask 且无询问通道、fail-closed 时的文案 */
function missingChannelMessage(request: SecurityRequest, display: string): string {
  if (request.object.type === 'path') {
    return `Access denied: path outside workspace and no way to ask: ${display}`
  }
  return `Access denied: this needs your confirmation but there is no way to ask: ${display}`
}

/**
 * 审查员写给人看的两段话的上限 —— schema 刻意不设 maxLength（超长会被判不合格、逼模型重调），
 * 所以在这里截：它们要进询问卡片、落进工具结果（「已审查」标记），一段长文不该把卡片撑开。
 */
const REVIEW_SUMMARY_MAX_CHARS = 300
const REVIEW_REASON_MAX_CHARS = 1000

function clipReviewText(text: string, max: number): string {
  const trimmed = text.trim()
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`
}

/** 审查拒绝时抛给 agent 的文案：审查员的理由，加一句固定的「换一条路，别绕过」 */
function reviewerDeniedMessage(verdict: PermissionVerdict): string {
  return (
    `Blocked by the reviewer: ${clipReviewText(verdict.reason, REVIEW_REASON_MAX_CHARS)}\n\n` +
    'Find a safer way that stays within what the user asked. Do not rephrase, split or obfuscate ' +
    'the operation to get past the review. If the user needs to decide, ask them.'
  )
}

/** 一次审查的结果（进卡片与决策日志） */
interface ReviewResult {
  verdict: PermissionVerdict
  source: string
  ms: number
}

/** 审查期间工具调用被中止 */
const REVIEW_ABORTED = Symbol('review-aborted')

/**
 * 询问点的审查：只对 ask 档（force-ask 的意思就是「只问人」），宿主给了接缝、本会话没因为连续 /
 * 累计拒绝暂停审查时才问。接缝抛错、答不出、答得不成形，一律当没有意见 —— 结构不对的判决永远
 * 不会变成放行。
 *
 * **中止与询问卡片同一待遇**：工具调用的 signal 落下、或会话被停止（abortSessionReviews）时当场
 * 按中止收尾 —— 与接缝赛跑，不指望宿主及时交回；会话停止之后、下一轮之前也不再开始新的审查。
 * 交给接缝的 signal 是两者合一的那一个。
 */
async function askReviewer(
  provider: SecurityHostProvider,
  request: SecurityRequest,
  decision: SecurityDecision,
  opts: EnforceOpts,
  command: string
): Promise<ReviewResult | typeof REVIEW_ABORTED | null> {
  const review = provider.onPermissionRequest
  if (decision.tier !== 'ask' || !review) return null
  const sessionId = request.subject.sessionId
  if (reviewSuspended(sessionId)) return null
  if (opts.signal?.aborted) return REVIEW_ABORTED
  const controller = new AbortController()
  const release = trackReview(sessionId, controller)
  if (!release) return REVIEW_ABORTED
  const onAbort = (): void => controller.abort()
  opts.signal?.addEventListener('abort', onAbort, { once: true })
  const aborted = new Promise<null>((resolve) =>
    controller.signal.addEventListener('abort', () => resolve(null), { once: true })
  )
  const t0 = Date.now()
  let answer: PermissionReviewAnswer | null = null
  try {
    answer = await Promise.race([
      Promise.resolve().then(() =>
        review.call(
          provider,
          {
            request,
            decision,
            toolCallId: opts.toolCallId,
            command,
            preview: opts.preview,
            background: opts.background,
            unsandboxed: opts.unsandboxed
          },
          controller.signal
        )
      ),
      aborted
    ])
  } catch (err) {
    provider.logger?.warn(
      `permission review failed, asking the user instead: ${err instanceof Error ? err.message : String(err)}`
    )
    answer = null
  } finally {
    release()
    opts.signal?.removeEventListener('abort', onAbort)
  }
  if (controller.signal.aborted) return REVIEW_ABORTED
  if (!answer || !isPermissionVerdict(answer.verdict)) return null
  return { verdict: answer.verdict, source: answer.source, ms: Date.now() - t0 }
}

/**
 * 执行一条决策（含决策日志）。返回 allowed / feedback；deny、拒绝、取消 throw。
 */
export async function executeDecision(args: {
  provider: SecurityHostProvider
  request: SecurityRequest
  decision: SecurityDecision
  opts: EnforceOpts
  evaluateMs: number
}): Promise<EnforceOutcome> {
  const { provider, request, decision, opts } = args
  const startTs = Date.now()

  const record = (
    userResponse?: SecurityDecisionRecord['userResponse'],
    withTotal = false,
    review?: ReviewResult | null
  ): void => {
    recordDecision(
      {
        ts: startTs,
        sessionId: request.subject.sessionId,
        toolCallId: opts.toolCallId,
        toolName: opts.toolName,
        subject: {
          kind: request.subject.kind,
          profileName: request.subject.profileName,
          agentKind: request.subject.agentKind
        },
        tool: request.tool,
        action: request.action,
        objectKind: request.object.type,
        objectSummary: summarizeObject(request),
        requestedPath: redirectedFrom(request),
        effect: decision.effect,
        matched: decision.matched,
        winning: decision.winning,
        userResponse,
        review: review
          ? {
              decision: review.verdict.decision,
              risk: review.verdict.risk,
              source: review.source,
              ms: review.ms
            }
          : undefined,
        evaluateMs: args.evaluateMs,
        totalMs: withTotal ? Date.now() - startTs : undefined
      },
      provider.logger
    )
  }

  if (decision.effect === 'allow') {
    record()
    return { status: 'allowed' }
  }

  const display = displayName(request, opts)

  if (decision.effect === 'deny') {
    record()
    const denied = (decision.reason ?? `Access denied: ${display}`) + resolutionNote(request)
    // 策略提示语拼在归因之后：agent 从 tool error 读到「为什么被拦、该走什么路」，
    // 用户在工具块里看到同一段（deny 不弹卡片，这是它唯一的露出面）
    throw new Error(decision.prompt ? `${denied}\n\n${decision.prompt.text}` : denied)
  }

  // ask —— 先问审查（只对 ask 档），它答 ask 或答不出才轮到人
  const sessionId = request.subject.sessionId
  const askCommand = decision.ask?.command ?? display
  const reviewed = await askReviewer(provider, request, decision, opts, askCommand)
  if (reviewed === REVIEW_ABORTED) {
    record('cancel', true)
    throw new Error(opts.abortError ?? 'Aborted')
  }
  const review = reviewed
  if (review?.verdict.decision === 'allow') {
    noteReviewCleared(sessionId)
    // 工具卡上的「已审查」：宿主在这次调用执行完之后取走，写进工具结果
    noteReviewAllowed(sessionId, opts.toolCallId, {
      risk: review.verdict.risk,
      summary: clipReviewText(review.verdict.summary, REVIEW_SUMMARY_MAX_CHARS)
    })
    record(undefined, true, review)
    return { status: 'allowed' }
  }
  if (review?.verdict.decision === 'deny') {
    noteReviewDenied(sessionId)
    record(undefined, true, review)
    throw new Error(reviewerDeniedMessage(review.verdict))
  }

  if (!provider.requestUserInput) {
    if (opts.missingChannel === 'allow') {
      record(undefined, false, review)
      return { status: 'allowed' }
    }
    record(undefined, false, review)
    throw new Error(missingChannelMessage(request, display) + resolutionNote(request))
  }

  // 仅 read 路径询问关心目录（write 通常指向具体文件；目录授权在 UI 上天然持久）
  const pathIsDirectory =
    request.object.type === 'path' && request.action === 'read'
      ? await (provider.isDirectory?.(String(request.object.path ?? '')) ?? false)
      : false

  const response = await provider.requestUserInput({
    id: opts.toolCallId,
    kind: 'ask',
    toolName: opts.toolName,
    command: askCommand,
    requestedPath: decision.ask?.requestedPath,
    description: opts.description,
    // 询问场景只投递给用户：拒绝/反馈的回话文案保持原样，不把策略文本带进 agent 上下文
    policyPrompt: decision.prompt
      ? { text: decision.prompt.text, policies: decision.prompt.policies }
      : undefined,
    pathIsDirectory,
    preview: opts.preview,
    background: opts.background,
    unsandboxed: opts.unsandboxed,
    // 审查员看过、决定交给人时附上它的意见 —— summary 是卡片上最该先读的一句
    review: review
      ? {
          risk: review.verdict.risk,
          summary: clipReviewText(review.verdict.summary, REVIEW_SUMMARY_MAX_CHARS),
          reason: clipReviewText(review.verdict.reason, REVIEW_REASON_MAX_CHARS)
        }
      : undefined,
    createdAt: Date.now()
  })

  if (response.kind === 'cancel') {
    record('cancel', true, review)
    throw new Error(opts.abortError ?? 'Aborted')
  }
  // 人回答了：审查的连续拒绝计数清零（因连续拒绝而暂停的审查随之恢复）
  noteReviewCleared(sessionId)
  // 这次调用有人看过了：同一调用先前另一道门留下的「已审查」标记作废（那枚标记说的是「没人看过、
  // 审查员放行的」）
  takeReviewAllowed(sessionId, opts.toolCallId)
  if (response.kind === 'other') {
    // 人写的反馈记在安全模块这里 —— 审查员只认这份，不认会话树里那段谁都能打印的工具结果文字
    noteHumanFeedback(sessionId, askCommand, response.text)
    record('feedback', true, review)
    if (opts.onOther === 'return') return { status: 'feedback', text: response.text }
    throw new Error(otherMessage(request, display, response.text))
  }
  if (response.kind !== 'ask' || !response.allowed) {
    record('denied', true, review)
    throw new Error((response.kind === 'ask' && response.reason) || deniedMessage(request, display))
  }

  const remember = !!response.extra?.rememberPath && !!decision.ask?.rememberEntry
  if (remember && request.object.type === 'path' && typeof request.object.path === 'string') {
    provider.persistGrant?.(request.action === 'write' ? 'write' : 'read', request.object.path)
  }
  record(remember ? 'allowed_remember' : 'allowed', true, review)
  return { status: 'allowed' }
}
