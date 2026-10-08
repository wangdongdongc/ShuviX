/**
 * 询问点的自动审查 —— 安全模块 `onPermissionRequest` 接缝的桌面实现（设计稿 docs/permission-review-design.md）。
 *
 * 策略判出 ask（不含 force-ask）、弹询问卡片之前，安全模块把那次请求交到这里。这里投影出判定型埋点
 * `permission.request` 的 payload —— 它就是审查 agent 的**全部输入** —— 交给命中的 hook（内置的
 * `auto-review` 派发 `permission-reviewer`），把最严的结论交回。以下情形交回 null，照旧问人：
 *   - 要权限的正是判定型 hook 派出的 agent（防递归：审查员自己要的东西只问人）；
 *   - 没有 hook 命中，或都没给出结论（超时 / 中止 / 失败 / 结论不合格）。
 *
 * **输入只收人写的意图与操作本身**（reasoning-blind）：人发的消息、人对 agent 提问的回答与在询问卡片上
 * 写的反馈；不收 agent 的正文、工具输出、命令的 description 参数 —— 那些正是注入进来、或能拿来说服
 * 审查者的地方。**「人写的」只认来源，不认文字**：ask 工具是内置工具，结果由宿主照人的回答写成；
 * 卡片反馈取自安全模块收到回答时记下的那份（humanFeedbackOf）—— 会话树里那段反馈文字谁都能用一条
 * echo 打印出来，按开头认就是给注入开门。代价：卡片反馈只活在内存里，重启之后不再出现（少一份输入 =
 * 多问，方向是保守的）。
 *
 * 子会话里的「用户消息」是父 agent 写的：人发的消息取顶层会话，子会话自己的那些单独列作
 * delegatedTasks（只是声明，不是授权）；子会话里人对 ask 的回答与卡片反馈照样算人写的。已知的粗糙处：
 * 人直接在子会话里打的字也被当成父 agent 的转述（会话树上没有来源标记）—— 方向是更保守（多问）。
 *
 * 由 main 启动时经 `setPermissionReviewer` 注入 toolContext（直接 import 会经 hookService →
 * AgentManager → agentHost 绕回 toolContext）。
 */
import {
  getSessionDecisions,
  humanFeedbackOf,
  type PermissionRequestEvent,
  type PermissionRequestPayload,
  type PermissionReviewAnswer,
  type SecurityDecisionRecord
} from '@shuvix/agent-runtime'
import { chatFrontendRegistry } from '../frontend/core'
import { hookService, hookTriggers } from './hookService'
import { sessionRecords } from './sessionRecords'
import { readSessionTranscript, type TranscriptItem } from './transcriptSource'
import { createLogger } from '../logger'

const log = createLogger('PermissionReview')

/** 每条人写输入的上限、保留最近几条（第一条恒保留：它通常就是这次任务本身） */
const USER_MESSAGE_MAX_CHARS = 1500
const USER_MESSAGES_TAIL = 8
/** 卡片反馈里引用的那张卡的主文本（命令 / 路径…）的上限 */
const FEEDBACK_TARGET_MAX_CHARS = 200
/** 命令 / 路径 / SQL 原文与 diff 预览的上限 —— 审查员要看的是全貌，但一段超长脚本不该撑爆输入 */
const TARGET_MAX_CHARS = 6000
const DIFF_MAX_CHARS = 3000
/** 近期操作条数 */
const RECENT_OPERATIONS = 10

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… [${text.length - max} more chars]`
}

/** 往上找到顶层会话（子会话只许一层；循环上限只是防御坏数据） */
function topLevelSessionOf(sessionId: string): string {
  let id = sessionId
  for (let i = 0; i < 4; i++) {
    const parent = sessionRecords.pick(id, ['parentId'])?.parentId
    if (!parent) return id
    id = parent
  }
  return id
}

/** 首条 + 最近若干条，中间注明省略了多少 */
function firstAndTail(items: string[]): string[] {
  if (items.length <= USER_MESSAGES_TAIL + 1) return items
  const omitted = items.length - USER_MESSAGES_TAIL - 1
  return [items[0], `(${omitted} earlier messages omitted)`, ...items.slice(-USER_MESSAGES_TAIL)]
}

/** 一条人写的输入与它的时间（几路来源合并时按时间排） */
interface HumanInput {
  ts: number
  text: string
}

/**
 * 会话转写里人写的东西（旧 → 新）：人发的消息（includeUserMessages 时；系统写的 —— 后台完成通知、指令注入 ——
 * 不算），人对 ask 工具的回答（连同问题）。读的是当前上下文 —— 压缩掉的早期消息不在其中（压缩摘要是模型写的，
 * 本来也不收）。ask 的回答按所在那条 assistant 消息的时间排（回答本身晚一点，但早于下一条消息）。
 */
function transcriptInputsOf(
  items: readonly TranscriptItem[],
  includeUserMessages: boolean
): HumanInput[] {
  const inputs: HumanInput[] = []
  for (const item of items) {
    if (item.kind === 'user') {
      if (!includeUserMessages || item.systemWritten) continue
      const text = item.text.trim()
      if (text) inputs.push({ ts: item.ts, text: clip(text, USER_MESSAGE_MAX_CHARS) })
    } else if (item.kind === 'ask') {
      inputs.push({
        ts: item.ts,
        text: clip(
          `(answering the agent's question "${item.question}") ${item.answer}`,
          USER_MESSAGE_MAX_CHARS
        )
      })
    }
  }
  return inputs
}

/** 人在这个会话的审批卡片上写的反馈（安全模块记下的那份） */
function feedbackInputsOf(sessionId: string): HumanInput[] {
  return humanFeedbackOf(sessionId).map((note) => ({
    ts: note.ts,
    text: clip(
      `(feedback on the approval card for "${clip(note.target, FEEDBACK_TARGET_MAX_CHARS)}") ${note.text}`,
      USER_MESSAGE_MAX_CHARS
    )
  }))
}

/**
 * 人写的输入（旧 → 新）：顶层会话里人发的消息与对 ask 的回答、卡片反馈；子会话再加上它自己的
 * ask 回答与卡片反馈（它的「用户消息」是父 agent 写的，不在其中）。
 */
function humanInputsOf(
  sessionId: string,
  top: string,
  topItems: readonly TranscriptItem[],
  ownItems: readonly TranscriptItem[]
): string[] {
  const inputs = [...transcriptInputsOf(topItems, true), ...feedbackInputsOf(top)]
  if (sessionId !== top) {
    inputs.push(...transcriptInputsOf(ownItems, false), ...feedbackInputsOf(sessionId))
  }
  // 稳定排序：同一时刻的先后保持来源内的次序
  inputs.sort((a, b) => a.ts - b.ts)
  return firstAndTail(inputs.map((input) => input.text))
}

/** 子会话自己的「用户消息」—— 父 agent 写的任务（旧 → 新） */
function delegatedTasksOf(items: readonly TranscriptItem[]): string[] {
  const tasks: string[] = []
  for (const item of items) {
    if (item.kind !== 'user' || item.systemWritten) continue
    const text = item.text.trim()
    if (text) tasks.push(clip(text, USER_MESSAGE_MAX_CHARS))
  }
  return firstAndTail(tasks)
}

/** 决策日志里一条记录的结果（给审查员看的一个词组） */
function outcomeOf(record: SecurityDecisionRecord): string {
  if (record.review) {
    return record.userResponse
      ? `reviewer ${record.review.decision}, then user ${record.userResponse}`
      : `reviewer ${record.review.decision}`
  }
  if (record.userResponse) return `user ${record.userResponse}`
  return record.effect === 'allow' ? 'allowed' : record.effect
}

/** 本会话最近判定过的操作（旧 → 新），不含这一次 */
function recentOperationsOf(
  sessionId: string,
  toolCallId: string
): PermissionRequestPayload['recentOperations'] {
  return getSessionDecisions(sessionId, RECENT_OPERATIONS + 1)
    .filter((record) => record.toolCallId !== toolCallId)
    .slice(0, RECENT_OPERATIONS)
    .reverse()
    .map((record) => ({
      target: `${record.toolName}: ${record.objectSummary}`,
      outcome: outcomeOf(record)
    }))
}

/** 客体的其余事实 —— 按类型只取标量；命令客体的解析属性（惰性 getter）不碰 */
function factsOf(event: PermissionRequestEvent): PermissionRequestPayload['operation']['facts'] {
  const { request } = event
  const object = request.object
  const facts: PermissionRequestPayload['operation']['facts'] = {}
  const put = (key: string, value: unknown): void => {
    if (typeof value === 'string' && value !== '') facts[key] = value
    else if (typeof value === 'number' || typeof value === 'boolean') facts[key] = value
  }
  switch (object.type) {
    case 'command':
      put('channel', object.channel)
      put('host', object.host)
      put('sandboxed', object.sandboxed)
      put('unconfinedReason', object.unconfinedReason)
      put('background', event.background === true)
      break
    case 'path':
      put('path', object.path)
      if (object.requestedPath !== object.path) put('requestedPath', object.requestedPath)
      if (event.preview?.kind === 'diff') {
        put('diff', clip(event.preview.diff, DIFF_MAX_CHARS))
        put('isNewFile', event.preview.isNewFile === true)
      }
      break
    case 'database':
      put('connection', object.credential)
      put('dbType', object.dbType)
      put('readonly', object.readonly)
      break
    case 'url':
      put('scheme', object.scheme)
      put('host', object.host)
      put('browser', object.browser)
      break
    case 'gitTool':
      put('gitAction', object.gitAction)
      put('force', object.force)
      put('delete', object.delete)
      break
    case 'invocation':
      put('mcpServer', object.mcpServer)
      put('mcpTool', object.mcpTool)
      put('mcpTrusted', object.mcpTrusted)
      put('readOnly', object.readOnly)
      put('destructive', object.destructive)
      put('openWorld', object.openWorld)
      break
  }
  put('workingDirectory', request.environment.workspaceDir)
  put('platform', request.environment.platform)
  return facts
}

/**
 * 要求判断的策略：带提示语的规则所属策略的显示名；都没写提示语时退回胜出规则所属的策略名
 * （规则 id 形如 `<policy>#<n>`）—— 审查员至少得知道是谁要它判断
 */
function policyNamesOf(decision: PermissionRequestEvent['decision']): string[] {
  const named = decision.prompt?.policies ?? []
  if (named.length > 0) return named
  const hash = decision.winning.lastIndexOf('#')
  const policy = hash > 0 ? decision.winning.slice(0, hash) : ''
  return policy ? [policy] : []
}

/** 投影 `permission.request` 的 payload —— 审查 agent 的全部输入 */
export async function buildPermissionRequestPayload(
  event: PermissionRequestEvent
): Promise<PermissionRequestPayload> {
  const { request, decision } = event
  const sessionId = request.subject.sessionId
  const top = topLevelSessionOf(sessionId)
  // 两种存储各走各的读者（旧格式：冻结投影；durable：当前对话的转写摘要，只 peek 从不创建）
  const topItems = await readSessionTranscript(top)
  const ownItems = top === sessionId ? topItems : await readSessionTranscript(sessionId)
  const tool = request.tool
    ? request.tool.operation
      ? `${request.tool.name}: ${request.tool.operation}`
      : request.tool.name
    : ''
  return {
    sessionId,
    agent: {
      profile: request.subject.profileName ?? '',
      kind: request.subject.agentKind ?? 'root'
    },
    operation: {
      tool,
      action: request.action,
      objectType: request.object.type,
      target: clip(event.command, TARGET_MAX_CHARS),
      facts: factsOf(event)
    },
    policy: {
      names: policyNamesOf(decision),
      prompt: decision.prompt?.text ?? ''
    },
    userMessages: humanInputsOf(sessionId, top, topItems, ownItems),
    delegatedTasks: top === sessionId ? [] : delegatedTasksOf(ownItems),
    recentOperations: recentOperationsOf(sessionId, event.toolCallId)
  }
}

/**
 * 工具卡上的「审查中」：开始与落定（不论结论）各发一次。前端按 toolCallId 找那张卡；带 durable taskId 时
 * 一并带上（PIN-09）—— provider 的 toolCallId 会话内可能重复（根与派生 agent 都可能是 `call_0`），taskId 不会。
 */
function notifyReviewing(
  sessionId: string,
  toolCallId: string,
  taskId: number | undefined,
  reviewing: boolean
): void {
  chatFrontendRegistry.broadcast({
    type: 'tool_review',
    sessionId,
    toolCallId,
    ...(taskId === undefined ? {} : { taskId }),
    reviewing
  })
}

/**
 * 接缝实现：交给判定型 hook，交回最严的结论；答不出交回 null（照旧问人）。绝不抛出。
 *
 * 审查员那条对话归**发起询问的那个工具任务**所有（Q16）：`event.taskId` 经 `ownerTaskId` 一路穿到路由，
 * 按 (sessionId, taskId) 认人 —— 它随那次工具调用的中止原生级联、拖住那次调用直到审查收场。durable 调用
 * 之外的询问点没有 taskId，审查员归一个后台锚任务。
 */
export async function reviewPermissionRequest(
  event: PermissionRequestEvent,
  signal?: AbortSignal
): Promise<PermissionReviewAnswer | null> {
  const subject = event.request.subject
  if (subject.kind !== 'agent') return null
  const reviewers = hookService.agentsBoundTo('permission.request')
  // 防递归：判定型 hook 派出的 agent 自己要权限，不再交给审查 —— 否则审查员的一次询问会再派一个
  // 审查员（它挂在根会话下，深度校验拦不住），一路派下去
  if (
    subject.agentKind === 'spawned' &&
    subject.profileName &&
    reviewers.has(subject.profileName)
  ) {
    return null
  }
  // 没有 hook 绑在这个埋点上就不会有审查：也就不报「审查中」，免得卡片闪一下
  const announce = reviewers.size > 0 && !!event.toolCallId
  if (announce) notifyReviewing(subject.sessionId, event.toolCallId, event.taskId, true)
  try {
    const payload = await buildPermissionRequestPayload(event)
    const decision = await hookTriggers.decide(
      'permission.request',
      payload,
      event.taskId === undefined ? { signal } : { signal, ownerTaskId: event.taskId }
    )
    return decision ? { verdict: decision.result, source: decision.hook } : null
  } catch (err) {
    log.warn(`permission review failed: ${err instanceof Error ? err.message : String(err)}`)
    return null
  } finally {
    if (announce) notifyReviewing(subject.sessionId, event.toolCallId, event.taskId, false)
  }
}
