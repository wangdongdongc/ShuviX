/**
 * session 工具 —— 让 agent 读改**自己所属会话**的会话级能力。
 *
 * 目标会话恒取 ToolContext.sessionId（root=自身；spawned/hook=归属会话）——
 * 刻意不收 sessionId 参数：一是 LLM 抄 uuid 会抄错，二是「只能动自己所属的会话」
 * 是比参数校验更硬的边界。hook 派发的 agent（如内置 titler）因此天然
 * 落在触发它的那个会话上。
 *
 * 单一 action 枚举而非「每能力一个工具」：会话相关的处理能力会持续增加，工具面越少
 * 模型越不容易挑错，扩展只需在 ACTIONS 里加一项 + 一个 case（未知 action 的错误文案
 * 列出合法值 —— 5250adc 的纠正性引导纪律）。
 *
 * 两组能力：
 *   - `set-title`：自动标题业务。经 sessionService.updateTitle(origin='auto') ——
 *     落库 + 记 titleOrigin + 广播 titleChanged，各端会话列表即时刷新。
 *   - **子会话**（create / prompt / list / read / stop）：agent 自己开一条普通会话、
 *     代替用户往里发消息并等结果，支持 bash 那样的后台形态。语义与准入全在
 *     services/subSessionRunner.ts，本文件只做参数面与文案 —— 工具层是翻译层，
 *     业务规则不该有第二份。设计见 docs/sub-session-design.md。
 *
 * 无专属安全客体 —— 要设门用 L1 全工具门（tool.name == 'session'）。
 *
 * **replay `safe`**（P2-10，Q-P2-01）：进程中途退出之后恢复时这次调用会**重跑**，所以每个动作都幂等 ——
 *   - create：新会话的 id 先记进这次调用的 memo（再插入），重跑拿到同一个 id，`sessionService.create`
 *     对已有的那一行原样交回；
 *   - prompt：发送的幂等键是 `subsession:<本会话>:<工具任务 id>`，子会话认得它就重新挂上（已落定直接读
 *     答复，没落定就续上那一条），从不再发一条；
 *   - wait：要等的那几条在挂住之前记进 memo；重跑带着它回来，先续上被中断的再等；
 *   - stop / set-title 本来就幂等；list / read 只读。
 * 父会话的「继续」因此在同一轮里把它等着的子会话一起带起来（Q-P2-02）。
 */
import { Type } from 'typebox'
import { v7 as uuidv7 } from 'uuid'
import type { ToolCallScope, ToolResult } from '@shuvix/agent-runtime'
import { BaseTool, OUTLINE_LIMITS } from '@shuvix/agent-runtime'
import { BUILTIN_TOOL_PRESENTATIONS } from '@shuvix/chat-protocol/builtinToolPresentations'
import type { SessionToolDetails } from '@shuvix/chat-protocol/types/chatMessage'
import { registerBuiltinTool } from '../services/toolRegistry'
import type { ToolContext } from '../services/toolContext'
import { sessionRecords } from '../services/sessionRecords'
import { sessionService } from '../services/sessionService'
import { blockedOnApproval, renderPendingAsks } from '../services/subSessionText'
import {
  subSessionRunner,
  DEFAULT_WAIT_TIMEOUT_SEC,
  type AnswerFields,
  type PromptOutcome,
  type SubSessionInfo
} from '../services/subSessionRunner'
import { t } from '../i18n'

export const SESSION_TOOL_NAME = 'session'

/** 标题长度上限（会话列表一行可辨；超长直接拒绝让模型改短，而不是静默截断） */
const TITLE_MAX_CHARS = 60

const ACTIONS = [
  'set-title',
  'create-sub-session',
  'prompt-sub-session',
  'wait-for-sub-sessions',
  'list-sub-sessions',
  'read-sub-session',
  'stop-sub-session',
  'answer-sub-session',
  'steer-sub-session',
  'inspect-sub-session'
] as const

export const SessionParamsSchema = Type.Object({
  action: Type.Unsafe<(typeof ACTIONS)[number]>({
    type: 'string',
    enum: [...ACTIONS],
    description: 'What to do. See the tool description for what each action does.'
  }),
  title: Type.Optional(
    Type.String({
      description: `For "set-title": the new title (at most ${TITLE_MAX_CHARS} characters, in the conversation's language). For "create-sub-session": an optional title.`
    })
  ),
  agent_profile: Type.Optional(
    Type.String({
      description:
        'For "create-sub-session": the agent profile it runs as (e.g. "coding"); omit for this session\'s own base profile.'
    })
  ),
  sub_session_id: Type.Optional(
    Type.String({
      description:
        'The sub-session to address; may be omitted when there is exactly one. "wait-for-sub-sessions" without it waits for every running one.'
    })
  ),
  message: Type.Optional(
    Type.String({
      description:
        'For "prompt-sub-session": the message, self-contained and written as the user would write it. For "steer-sub-session": what to tell the running turn. For "answer-sub-session": your answer in your own words, instead of `selections`.'
    })
  ),
  ask_id: Type.Optional(
    Type.String({
      description:
        'For "answer-sub-session": the question to answer (its `ask_id`); may be omitted when exactly one question is waiting.'
    })
  ),
  selections: Type.Optional(
    Type.Array(Type.String(), {
      description:
        'For "answer-sub-session": the options you pick, each exactly as its label reads (one or several).'
    })
  ),
  turns: Type.Optional(
    Type.Number({
      description: `For "inspect-sub-session": how many recent turns to outline (default ${OUTLINE_LIMITS.defaultTurns}, at most ${OUTLINE_LIMITS.maxTurns}).`
    })
  ),
  item: Type.Optional(
    Type.String({
      description:
        'For "inspect-sub-session": expand one line of the outline by its ref (e.g. "#12.3") — full text, or a tool call\'s arguments and result.'
    })
  ),
  match: Type.Optional(
    Type.String({
      description:
        'For "inspect-sub-session": find the lines of the whole conversation that contain this text (case-insensitive).'
    })
  ),
  before: Type.Optional(
    Type.String({
      description:
        'For "inspect-sub-session": continue an outline that was cut at the size limit — pass the ref it gave you.'
    })
  ),
  timeout_seconds: Type.Optional(
    Type.Number({
      description: `For "wait-for-sub-sessions": how long to wait (default ${DEFAULT_WAIT_TIMEOUT_SEC}s). On timeout the sub-sessions keep running.`
    })
  )
})

export const SESSION_DESCRIPTION = `Read or change the session this task belongs to, and manage its sub-sessions.

A sub-session is an ordinary session you own — its own conversation, model, tools and history; the user sees it nested under this one and can read or continue it. Use one for a task that deserves its own conversation; unlike the \`agent\` tool's sub-agent, it outlives a single answer. Sub-sessions cannot create sub-sessions.

Actions:
- "set-title": rename THIS session (\`title\`, at most ${TITLE_MAX_CHARS} characters).
- "create-sub-session": start an empty sub-session and return its id (optional \`title\` and \`agent_profile\`). It inherits this session's project, model, thinking level, MCP servers and skills.
- "prompt-sub-session": send \`message\` into \`sub_session_id\` as if the user typed it. It returns a receipt at once and the turn runs in the background. This is also how a new sub-session gets its first task.
- "wait-for-sub-sessions": block until your sub-sessions finish (or one stops to ask something) and return all their answers — the only action that waits.
- "list-sub-sessions": your sub-sessions and their status (idle / running / waiting-input / interrupted).
- "read-sub-session": the latest answer of \`sub_session_id\`.
- "stop-sub-session": stop what \`sub_session_id\` is doing.
- "answer-sub-session": answer a question it asked in a turn you started (\`ask_id\`, then \`selections\` with exact option labels or \`message\` in your own words); like "prompt-sub-session" it returns at once and the turn carries on in the background.
- "steer-sub-session": tell a turn you started something while it is running (\`message\`); it reads it at its next step.
- "inspect-sub-session": look at what happened inside \`sub_session_id\` — an outline of its latest turn, one line per step with a ref (\`turns\` for more, \`before\` to page back), \`item\` to expand one ref, \`match\` to search the whole conversation. Collect answers with "read-sub-session" / "wait-for-sub-sessions"; inspect only when the answer does not explain what happened (a failure, a stall, something unexpected, \`user-intervened="true"\` — the user spoke in it since your last message), and expand only the line you need.

Everything you send runs in the background: when a turn ends, or stops to ask you something, you are brought back with a notice — get on with other work meanwhile, or end your turn. When you cannot continue without the answer, call "wait-for-sub-sessions": it costs nothing while it waits, comes back early when one stops to ask, and on timeout leaves everything running. Stopping this session does not stop its sub-sessions. **Never sleep and then poll** with "list-sub-sessions" / "read-sub-session".

A sub-session runs one turn at a time: a second message while it is working is rejected — steer it, wait, or create another one. \`status="waiting-input"\` means it stopped to ask something. A \`<question>\` asked in a turn you started is yours to answer when the answer follows from what the user told you or from the task; when it is the user's own preference or beyond what you were asked, relay it. An approval prompt (\`<blocked-on-user-approval>\`) and a question marked \`for="user"\` only the user can answer, so relay them or stop the sub-session. \`status="interrupted"\` means its turn was cut off when the app stopped; it will not finish by itself, and a new message starts over.

Its replies come back inside a \`<sub-session>\` fence, in \`<reply>\` or \`<error>\`; text outside the fence is this tool talking. Write each message as the user of that session would: it does not see this conversation.`

interface SessionToolParams {
  action: (typeof ACTIONS)[number]
  title?: string
  agent_profile?: string
  sub_session_id?: string
  message?: string
  ask_id?: string
  selections?: string[]
  turns?: number
  item?: string
  match?: string
  before?: string
  timeout_seconds?: number
}

/**
 * 后台/降级回执的收尾指引。**明说「跑完会把你叫回来」** —— 那是现在的事实：子会话跑完
 * 经 `AgentSession.notify` 回报，运行中 steer 进当前轮、空闲则自动续跑（d886985），
 * 父级说完话照样收得到。
 *
 * 这段文案原先刻意不作这个承诺，因为写它的那会儿（9ed4189）确实兑现不了 —— 自动续跑是
 * **下一个提交**落的。而「你不会被通知，要结果就去等」正是把模型逼回前台阻塞的那句话：
 * 它读完只剩一条路，就是原地把整轮等完。
 *
 * 兑现不了的只剩一种：用户刚显式停过这条会话（或关掉了自动续跑）—— 那时通知退回排队，
 * 搭下一条用户消息的便车，一条不少但会迟到，所以括号里如实写出来。
 *
 * 「不要 sleep 轮询」照旧写死：轮询是唯一真正白烧请求的收法，而两条兑现得了的路
 *（被叫回来、或一次 wait）这句话里都给全了。
 */
const COLLECT_HINT =
  'You do not have to wait here: when the turn ends, or stops to ask you something, you are brought back with a notice (at the latest, when the user next speaks). Get on with other work, or tell the user what you started. If you need the answer inside this same turn, collect it with action "wait-for-sub-sessions" — one call that blocks until it is done and hands back the answer. Do NOT sleep and poll.'

/** 结果排版：一段文本，行间空行 —— 与其他工具的多段结果同形 */
function text(...lines: string[]): ToolResult<SessionToolDetails | undefined> {
  return {
    content: [{ type: 'text' as const, text: lines.filter(Boolean).join('\n\n') }],
    details: undefined
  }
}

/**
 * 后台形态的结果：带上 `details.background`，UI 据此渲染与 bash 后台任务**同一枚**
 * 「后台」标签 —— 对用户而言两者是同一件事：这次调用没有等结果，活还在跑。
 */
function backgroundText(...lines: string[]): ToolResult<SessionToolDetails> {
  return {
    content: [{ type: 'text' as const, text: lines.filter(Boolean).join('\n\n') }],
    details: { type: 'session', background: true }
  }
}

/**
 * 属性值转义 —— 标题是 LLM 起的（auto-title / 父级自拟），不能假定它干净：
 * 引号会撕破标签、换行会把一行变两行。
 */
function attr(value: string): string {
  return value
    .replace(/[\r\n]+/g, ' ')
    .replace(/"/g, "'")
    .trim()
}

function openTag(info: SubSessionInfo, extra = ''): string {
  // 用户在里面说过话（父会话最近一次发的消息之后）：答复解释不了过程时最常见的原因，值得 inspect（§19.7）
  const intervened = info.userIntervened ? ' user-intervened="true"' : ''
  return `<sub-session id="${attr(info.id)}" title="${attr(info.title)}" status="${info.status}"${intervened}${extra}>`
}

/**
 * 一条子会话的结果块。**子会话说的话恒在 `<reply>` / `<error>` 之内**，围栏之外的每一个字
 * 都是本工具在说话 —— 与 `<background-task>`（bgTaskService）、`<project_…>`（上下文注入）
 * 同一套护栏语汇。
 *
 * 不做闭合标签的转义（同仓库既有围栏的口径）：子会话的答复里出现 `</reply>` 属于
 * 可以想象但没见过的情形，为它把正文改写掉的代价更大。标签各占一行，正文里偶然出现的
 * 同名文本至少不在行首独占一行。
 */
/**
 * 被中断的那一块（P2-10 PIN-06）：它**不在跑**、也不会自己跑完 —— 说成「还在跑」会让父级白等，说成
 * 「还没回话」会让它以为再等等就有。两条出路都要给全：发新消息（丢掉那一轮重来），或者让用户在那条
 * 会话里继续。
 */
const INTERRUPTED_NOTE =
  '<note>Interrupted when the app stopped — it is not running and will not finish on its own. A new message starts over (discarding that unfinished turn), or the user can continue it in that session.</note>'

function renderChild(info: SubSessionInfo & AnswerFields): string {
  // waiting-input 优先于「有没有答复」：它此刻停着这件事，比它上一轮说过什么更要紧。
  // 询问的那几块（选择题 / 批准卡）与通知同一份渲染（runner 的 renderPendingAsks，§19.4）
  if (info.status === 'waiting-input') {
    return [
      openTag(info),
      ...(info.pendingAsks?.length
        ? renderPendingAsks(info.pendingAsks)
        : [blockedOnApproval(info.blockedOn)]),
      ...(info.answer ? [`<earlier-reply>\n${info.answer}\n</earlier-reply>`] : []),
      '</sub-session>'
    ].join('\n')
  }
  // 被中断同理：它停在半路这件事最要紧（这一轮还没有回答 —— lastAnswer 停在这一轮的提问上）
  if (info.status === 'interrupted') return `${openTag(info)}\n${INTERRUPTED_NOTE}\n</sub-session>`
  const body = info.answer
    ? info.isError
      ? `<error>\n${info.answer}\n</error>`
      : `<reply>\n${info.answer}\n</reply>`
    : info.status === 'running'
      ? '<note>Still running. It was NOT cancelled.</note>'
      : '<note>No reply yet.</note>'
  return `${openTag(info)}\n${body}\n</sub-session>`
}

/**
 * `prompt` / `answer` 的回执排版（§20：派活一律是后台语义，两者都只回执）。
 *
 * 回执刻意不带内容：它会永久留在本会话上下文里并被每一步重发。收尾指引说的是**真实**机制：跑完 / 停下来问会把你
 * 叫回来，要在这一轮里拿到结果就 wait（挂住、不花钱），而不是先说完话再回来轮询。确认窗里就停下来问了的那一种
 * 把询问带回来（§19.3）。两种都带后台标签：这次调用甩下了一件还在跑的活。
 */
function renderTurn(
  res: PromptOutcome,
  startedLine: string
): ToolResult<SessionToolDetails | undefined> {
  if (res.kind === 'started') {
    return backgroundText(
      `<sub-session id="${attr(res.id)}" status="running"/>`,
      startedLine,
      COLLECT_HINT
    )
  }
  // 崩溃之后重跑、那一轮早就落定了：没再发，如实说结束了（它不在跑，没什么可等的）
  if (res.kind === 'finished') {
    return text(
      `<sub-session id="${attr(res.id)}" status="idle"/>`,
      'That turn already finished before the app restarted — nothing was sent again. Read its answer with "read-sub-session".'
    )
  }
  // 停下来问了、快照却缺（会话恰好被删 / 读不到）：不猜它问的是什么，指向 read
  if (!res.info) {
    return backgroundText(
      `<sub-session id="${attr(res.id)}" status="waiting-input"/>`,
      'It stopped to ask something in the turn you started. See the question with "read-sub-session".'
    )
  }
  return backgroundText(
    renderChild(res.info),
    'The turn is still open: once it is answered it carries on, and you are brought back when it ends.'
  )
}

/** memo 的键（这次调用的 durable memo，崩溃后重跑读回同一份） */
const MEMO_CREATE_ID = 'session.create-sub-session.id'
const MEMO_WAIT_TARGETS = 'session.wait-for-sub-sessions.targets'

export class SessionTool extends BaseTool<typeof SessionParamsSchema> {
  readonly name = SESSION_TOOL_NAME
  readonly label: string
  readonly description = SESSION_DESCRIPTION
  readonly parameters = SessionParamsSchema
  /** 每个动作都幂等，恢复时重跑（见文件头） */
  readonly replay = 'safe' as const

  constructor(private readonly ctx: ToolContext) {
    super()
    this.label = t(BUILTIN_TOOL_PRESENTATIONS[SESSION_TOOL_NAME].labelKey)
  }

  async preExecute(): Promise<void> {
    /* no-op */
  }

  protected async securityCheck(): Promise<void> {
    /* no-op —— 无专属客体；按需经 L1 全工具门设门 */
  }

  protected async executeInternal(
    _toolCallId: string,
    params: SessionToolParams,
    signal: AbortSignal | undefined,
    call: ToolCallScope
  ): Promise<ToolResult<SessionToolDetails | undefined>> {
    switch (params.action) {
      case 'set-title':
        return this.setTitle(params.title)
      case 'create-sub-session':
        return this.createSubSession(params, call)
      case 'prompt-sub-session':
        return this.promptSubSession(params, call)
      case 'wait-for-sub-sessions':
        return this.waitForSubSessions(params, call, signal)
      case 'list-sub-sessions':
        return this.listSubSessions()
      case 'read-sub-session':
        return this.readSubSession(params)
      case 'stop-sub-session':
        return this.stopSubSession(params)
      case 'answer-sub-session':
        return this.answerSubSession(params)
      case 'steer-sub-session':
        return this.steerSubSession(params, call)
      case 'inspect-sub-session':
        return this.inspectSubSession(params)
      default:
        throw new Error(
          `Unknown action "${String(params.action)}". Valid actions: ${ACTIONS.join(', ')}`
        )
    }
  }

  // ─── 子会话 ──────────────────────────────────
  //
  // 五个 case 都是同一形状：调 runner → 拿到 { error } 就抛（错误文案是 runner 写的，
  // 它握着准入规则）→ 否则把结果排版成一段文本。工具层不作任何判断。

  private async createSubSession(
    params: SessionToolParams,
    call: ToolCallScope
  ): Promise<ToolResult<SessionToolDetails | undefined>> {
    // id 先记进 memo、再建会话：崩在两者之间的重跑拿到同一个 id，绝不另起第二条（PIN-04 / PIN-05）
    const id = await call.api.memo<string>(MEMO_CREATE_ID, uuidv7(), call.context)
    const res = await subSessionRunner.create(this.ctx.sessionId, {
      title: params.title,
      agentProfile: params.agent_profile,
      id
    })
    if ('error' in res) throw new Error(res.error)

    // create **只建会话**。曾经它带 message 就顺手转 prompt（少一次往返），代价是
    // 「开一条子会话去干 X」这个最常见的写法恒为前台形态：派活那一刻就把父会话按住，
    // 最长 300s 才降级 —— 而派活的人多半根本不需要当场拿到答复。派发的形态选择属于
    // `prompt-sub-session`，不该由「顺手」替它定死。（2026-10-17 起派活一律是后台语义，§20 —— 选择只剩
    // 「要不要 wait」，那也是派活之后的事。）
    //
    // 收到 message 不静默丢掉：那才是真的坑 —— 模型会以为活已经派下去了，转头去
    // wait 一个根本没开始的东西。回执明说没发，并把下一步给全。
    return text(
      `<sub-session id="${attr(res.id)}" title="${attr(res.title)}" status="created"/>`,
      params.message?.trim()
        ? 'Nothing was sent to it: "create-sub-session" does not take `message`.'
        : '',
      'Send it its task with action "prompt-sub-session" — it runs in the background, and you are brought back when it is done.'
    )
  }

  private async promptSubSession(
    params: SessionToolParams,
    call: ToolCallScope
  ): Promise<ToolResult<SessionToolDetails | undefined>> {
    const res = await subSessionRunner.prompt({
      parentId: this.ctx.sessionId,
      childId: (params.sub_session_id ?? '').trim(),
      message: params.message ?? '',
      // 发送的身份是这次调用的 durable 工具任务（会话内唯一，崩溃后重跑不变），不是 provider 的
      // tool_call id —— 有的中转每轮从 call_0 数起，会撞（fact 20）。派生 agent 调它时 ctx.sessionId 同样是
      // 根会话（工具上下文恒按根会话建）：子会话挂在根会话下，任务 id 在同一个存储里唯一，不会撞（P2-12 PIN-10）
      requestId: `subsession:${this.ctx.sessionId}:${call.taskId}`
    })
    if ('error' in res) throw new Error(res.error)
    return renderTurn(res, 'Started in the background.')
  }

  /** 代答子会话的提问（§19.4）：应答之后与 prompt 同一种回执（§20） */
  private async answerSubSession(
    params: SessionToolParams
  ): Promise<ToolResult<SessionToolDetails | undefined>> {
    const res = await subSessionRunner.answer({
      parentId: this.ctx.sessionId,
      childId: (params.sub_session_id ?? '').trim(),
      ...(params.ask_id ? { askId: params.ask_id } : {}),
      ...(params.selections ? { selections: params.selections } : {}),
      ...(params.message !== undefined ? { message: params.message } : {})
    })
    if ('error' in res) throw new Error(res.error)
    return renderTurn(res, 'Answered; it carries on in the background.')
  }

  /**
   * 查看子会话的现场（§19.7）：大纲 / 展开 / 搜索，三选一（item 优先，其次 match）。子会话说的每一个字都在
   * `<transcript>` 围栏里；围栏外是工具在说话（往前看、展开、搜索的用法）。
   */
  private async inspectSubSession(
    params: SessionToolParams
  ): Promise<ToolResult<SessionToolDetails | undefined>> {
    const res = await subSessionRunner.inspect({
      parentId: this.ctx.sessionId,
      childId: (params.sub_session_id ?? '').trim(),
      query: {
        ...(params.turns !== undefined ? { turns: params.turns } : {}),
        ...(params.item !== undefined ? { item: params.item } : {}),
        ...(params.match !== undefined ? { match: params.match } : {}),
        ...(params.before !== undefined ? { before: params.before } : {})
      }
    })
    if ('error' in res) throw new Error(res.error)
    const { info, result } = res
    const open = openTag(info)
    if (result.kind === 'item') {
      return text(
        `${open}\n<transcript item="${attr(result.ref)}">\n${result.lines.join('\n')}\n</transcript>\n</sub-session>`
      )
    }
    if (result.kind === 'match') {
      if (result.hits === 0) {
        return text(`${open}\n<transcript match="${attr(result.query)}" hits="0"/>\n</sub-session>`)
      }
      return text(
        `${open}\n<transcript match="${attr(result.query)}" hits="${result.hits}" shown="${result.shown}">\n${result.lines.join('\n')}\n</transcript>\n</sub-session>`,
        result.shown < result.hits
          ? `Showing the latest ${result.shown} of ${result.hits} matches; narrow \`match\` to see others.`
          : '',
        'Expand a line with `item`.'
      )
    }
    if (result.kind === 'outline' && result.shown === 0) {
      return text(
        `${open}\n<transcript turns="0"/>\n</sub-session>`,
        params.before?.trim()
          ? 'Nothing comes before that line.'
          : 'Nothing has happened in it yet.'
      )
    }
    if (result.kind !== 'outline') throw new Error('Unexpected inspect result')
    const turns =
      result.turnFrom === result.turnTo
        ? `${result.turnTo} of ${result.turnCount}`
        : `${result.turnFrom}-${result.turnTo} of ${result.turnCount}`
    return text(
      `${open}\n<transcript turns="${turns}" shown="${result.shown}/${result.total}">\n${result.lines.join('\n')}\n</transcript>\n</sub-session>`,
      result.before
        ? `Cut at the size limit — pass \`before: "${result.before}"\` to see the earlier lines.`
        : '',
      result.earlierTurns ? 'Earlier turns: pass `turns`.' : '',
      'Expand one line with `item: "<ref>"`; search the whole conversation with `match`.'
    )
  }

  /** 往自己发起、正在跑的那一轮里插话（§19.6）：立刻回执，结果仍由原来那次 prompt 的那条路交回 */
  private async steerSubSession(
    params: SessionToolParams,
    call: ToolCallScope
  ): Promise<ToolResult<SessionToolDetails | undefined>> {
    const res = await subSessionRunner.steer({
      parentId: this.ctx.sessionId,
      childId: (params.sub_session_id ?? '').trim(),
      message: params.message ?? '',
      // 与 prompt 同一个口径：这次调用的 durable 工具任务（崩溃后重跑不变），子会话认得它就不再发
      requestId: `subsession-steer:${this.ctx.sessionId}:${call.taskId}`
    })
    if ('error' in res) throw new Error(res.error)
    return text(
      `<sub-session id="${attr(res.id)}" title="${attr(res.title)}" status="running"/>`,
      res.earlier
        ? 'This steer was already delivered earlier — nothing was sent again.'
        : 'Steer delivered — it reads it at its next step.',
      'Its reply comes back the way every turn does: as a notice when the turn ends, or to "wait-for-sub-sessions" if you are waiting.'
    )
  }

  private async waitForSubSessions(
    params: SessionToolParams,
    call: ToolCallScope,
    signal?: AbortSignal
  ): Promise<ToolResult<SessionToolDetails | undefined>> {
    const id = params.sub_session_id?.trim()
    // memo 里已有要等的那几条 = 这是崩溃之后的重跑：先续上被中断的再等（PIN-04）
    const rerunTargets = await call.api.memo<string[]>(MEMO_WAIT_TARGETS, call.context)
    const res = await subSessionRunner.wait({
      parentId: this.ctx.sessionId,
      ...(id ? { childId: id } : {}),
      timeoutSeconds: params.timeout_seconds ?? DEFAULT_WAIT_TIMEOUT_SEC,
      signal,
      ...(rerunTargets !== undefined
        ? { rerunTargets }
        : {
            onTargets: async (targets: string[]) => {
              await call.api.memo(MEMO_WAIT_TARGETS, targets, call.context)
            }
          })
    })
    if ('error' in res) throw new Error(res.error)

    if (res.results.length === 0) {
      return text('No sub-sessions yet. Create one with action "create-sub-session".')
    }
    // 一次交齐：等待的意义就是省掉「再 read 一遍」的那一轮请求。
    // 每条答复各自在围栏内，外层再套一个 —— 谁说的话一眼可辨
    const body = res.results.map(renderChild).join('\n')
    const trailer =
      res.kind === 'timeout'
        ? 'Timed out waiting. Nothing was cancelled — wait again, or carry on and collect later.'
        : res.kind === 'aborted'
          ? 'The wait was interrupted; the sub-sessions above keep running.'
          : res.kind === 'asking'
            ? 'Not finished: a sub-session stopped to ask a question in the turn you started. Waiting again will not help — answer it with "answer-sub-session", or relay it to the user.'
            : res.kind === 'blocked'
              ? 'Nothing finished: a sub-session is waiting for something only the user can answer. Waiting again will not help — relay it to the user.'
              : ''
    // **不带后台标签**：那枚标签的含义是「这次调用甩下了一件还在跑的活」（bash 的
    // run_in_background、prompt / answer 的回执都是）。wait 什么也没起 —— 它是一次
    // 读取；即便超时，还在跑的那件活是**上一次 prompt** 甩下的，标签早就打在那张卡上了。
    // blocked 更不是：那时根本没有东西在跑，是有人在等用户点批准。
    return text(`<sub-sessions status="${res.kind}">\n${body}\n</sub-sessions>`, trailer)
  }

  private listSubSessions(): ToolResult<SessionToolDetails | undefined> {
    const res = subSessionRunner.list(this.ctx.sessionId)
    if ('error' in res) throw new Error(res.error)
    if (res.subSessions.length === 0) {
      return text('No sub-sessions yet. Create one with action "create-sub-session".')
    }
    const rows = res.subSessions.map((s) => openTag(s, '/')).join('\n')
    return text(`<sub-sessions>\n${rows}\n</sub-sessions>`)
  }

  private async readSubSession(
    params: SessionToolParams
  ): Promise<ToolResult<SessionToolDetails | undefined>> {
    const res = await subSessionRunner.read(
      this.ctx.sessionId,
      (params.sub_session_id ?? '').trim()
    )
    if ('error' in res) throw new Error(res.error)
    return text(renderChild({ ...res.info, answer: res.answer, isError: res.isError }))
  }

  private async stopSubSession(
    params: SessionToolParams
  ): Promise<ToolResult<SessionToolDetails | undefined>> {
    const res = await subSessionRunner.stop(
      this.ctx.sessionId,
      (params.sub_session_id ?? '').trim()
    )
    if ('error' in res) throw new Error(res.error)
    return text(
      res.stopped ? `Stopped sub-session ${res.id}.` : `Sub-session ${res.id} was not running.`
    )
  }

  /** 重命名本任务所属会话；笔记本会话的标题绑在文件名上，拒绝而不是悄悄改别的 */
  private setTitle(rawTitle: string | undefined): ToolResult<SessionToolDetails | undefined> {
    const sessionId = this.ctx.sessionId
    const session = sessionRecords.pick(sessionId, ['title', 'settings'])
    if (!session) {
      // 无会话上下文的派发（rootSessionId 不是会话）等场景：没有可操作的会话
      throw new Error('This task is not attached to a session — there is nothing to rename.')
    }
    if (session.settings?.notebookPath) {
      throw new Error(
        'This is a notebook session: its title is bound to the notebook file and cannot be set here.'
      )
    }

    const title = (rawTitle ?? '').trim()
    if (!title) {
      throw new Error('Pass the new title in `title` (a non-empty string).')
    }
    if (title.length > TITLE_MAX_CHARS) {
      throw new Error(
        `Title is ${title.length} characters — keep it at most ${TITLE_MAX_CHARS}. Shorten it and call again.`
      )
    }

    sessionService.updateTitle(sessionId, title, 'auto')
    return {
      content: [{ type: 'text' as const, text: `Session title set to "${title}".` }],
      details: undefined
    }
  }
}

registerBuiltinTool({
  name: SESSION_TOOL_NAME,
  group: 'system',
  getLabel: () => t(BUILTIN_TOOL_PRESENTATIONS[SESSION_TOOL_NAME].labelKey),
  getHint: () => t('tool.sessionHint'),
  factory: (ctx: ToolContext) => new SessionTool(ctx),
  presentation: BUILTIN_TOOL_PRESENTATIONS[SESSION_TOOL_NAME].presentation,
  describe: () => ({
    description: SESSION_DESCRIPTION,
    parameters: SessionParamsSchema
  })
})
