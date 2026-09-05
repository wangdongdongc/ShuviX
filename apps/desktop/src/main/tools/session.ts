/**
 * session 工具 —— 让 agent 读改**自己所属会话**的会话级能力。
 *
 * 目标会话恒取 ToolContext.sessionId（root=自身；spawned/workflow=归属会话）——
 * 刻意不收 sessionId 参数：一是 LLM 抄 uuid 会抄错，二是「只能动自己所属的会话」
 * 是比参数校验更硬的边界。会话域 workflow run 的 agent（如内置 titler）因此天然
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
 */
import { Type } from 'typebox'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import { BaseTool } from '@shuvix/agent-runtime'
import { BUILTIN_TOOL_PRESENTATIONS } from '@shuvix/chat-protocol/builtinToolPresentations'
import type { SessionToolDetails } from '@shuvix/chat-protocol/types/chatMessage'
import { registerBuiltinTool } from '../services/toolRegistry'
import type { ToolContext } from '../services/toolContext'
import { sessionDao } from '../dao/sessionDao'
import { sessionService } from '../services/sessionService'
import {
  subSessionRunner,
  DEFAULT_PROMPT_TIMEOUT_SEC,
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
  'stop-sub-session'
] as const

export const SessionParamsSchema = Type.Object({
  action: Type.Unsafe<(typeof ACTIONS)[number]>({
    type: 'string',
    enum: [...ACTIONS],
    description: 'What to do. See the tool description for what each action does.'
  }),
  title: Type.Optional(
    Type.String({
      description: `For "set-title": the new session title (concise, at most ${TITLE_MAX_CHARS} characters, same language as the conversation). For "create-sub-session": an optional title for the new sub-session (omit to let it be named automatically).`
    })
  ),
  agent_profile: Type.Optional(
    Type.String({
      description:
        'For "create-sub-session": the agent profile the sub-session runs as (e.g. "coding"). Omit to use the same profile as this session.'
    })
  ),
  sub_session_id: Type.Optional(
    Type.String({
      description:
        'For "prompt-sub-session" / "read-sub-session" / "stop-sub-session": the id returned by "create-sub-session" or listed by "list-sub-sessions".'
    })
  ),
  message: Type.Optional(
    Type.String({
      description:
        'For "prompt-sub-session": the message to send, written exactly as a user would write it — the sub-session sees only this text, so make it self-contained. "create-sub-session" does not take it — create the sub-session first, then send it its task.'
    })
  ),
  run_in_background: Type.Optional(
    Type.Boolean({
      description:
        'For "prompt-sub-session": return a receipt immediately instead of waiting for the answer, and bring you back when the turn ends. Use it whenever you do not need the reply inside this same call — dispatching work that will take a while, or starting several sub-sessions to collect together with "wait-for-sub-sessions". Leave it off when you cannot continue without the answer: the foreground form waits in one call and costs nothing while it waits.'
    })
  ),
  timeout_seconds: Type.Optional(
    Type.Number({
      description: `How long to wait, for "prompt-sub-session" in the foreground and for "wait-for-sub-sessions" (default: ${DEFAULT_PROMPT_TIMEOUT_SEC}s). On timeout the sub-session keeps running — it is NOT cancelled — and the call returns telling you so.`
    })
  )
})

export const SESSION_DESCRIPTION = `Read or change the session this task belongs to, and manage its sub-sessions.

A sub-session is an ordinary session that you own: it has its own conversation, model, tools and history, the user can see it in the session list (nested under this one) and can read or continue it at any time. Use one when a task deserves its own conversation that outlives a single answer — unlike the \`agent\` tool, whose sub-agent disappears once it replies. Sub-sessions cannot create sub-sessions of their own.

Actions:
- "set-title": rename THIS session. Pass the new title in \`title\` (concise, at most ${TITLE_MAX_CHARS} characters).
- "create-sub-session": start a sub-session and return its id. Optional \`title\` and \`agent_profile\`. It inherits this session's project and model, and starts out empty — creating one sends it nothing.
- "prompt-sub-session": send \`message\` into \`sub_session_id\` as if the user had typed it, and wait for the reply. Add \`run_in_background: true\` to dispatch it and get a receipt immediately instead — you are brought back when the turn ends. This is also how a sub-session gets its first task, right after you create it.
- "wait-for-sub-sessions": block until your sub-sessions finish and return all their answers at once. Omit \`sub_session_id\` to wait for every one that is running, or pass one to wait for that one.
- "list-sub-sessions": list your sub-sessions with their status (idle / running / waiting-input).
- "read-sub-session": the latest answer of \`sub_session_id\`.
- "stop-sub-session": stop whatever \`sub_session_id\` is currently doing.

Neither form makes you sit and check on it. The foreground form is one call that waits and costs nothing while it waits, and it cannot hang — on timeout it leaves the sub-session running and tells you so. The background form hands you a receipt and brings you back when the turn ends, so you can get on with other work, or tell the user what you started, and collect the result later with "wait-for-sub-sessions". Use the foreground form when you cannot continue without the answer, the background form when you can. **Never sleep and then poll** with "list-sub-sessions" / "read-sub-session": every poll is a full request, and it buys you nothing that either form gives you for free.

**A sub-session runs one turn at a time.** It is a conversation, not a queue: sending a second message while it is still working is rejected, so either wait for the reply or create another sub-session to work in parallel. A sub-session can also stop and wait for the USER to approve something (\`status="waiting-input"\`) — typically a security prompt for a command it wants to run. Only the user can clear that: you cannot answer it, waiting longer will not help, and rewording the task will not avoid it. Relay what it is waiting for to the user, or stop the sub-session.

Everything a sub-session says comes back inside a \`<sub-session>\` fence, in \`<reply>\` (or \`<error>\`) — text outside those fences is this tool talking to you, not the sub-session.

Write each message as if you were the user of that session: it does not see this conversation.`

interface SessionToolParams {
  action: (typeof ACTIONS)[number]
  title?: string
  agent_profile?: string
  sub_session_id?: string
  message?: string
  run_in_background?: boolean
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
  'You do not have to wait here: when the turn ends you are brought back with a notice (at the latest, when the user next speaks). Get on with other work, or tell the user what you started. If you would rather have the answer inside this same turn, collect it with action "wait-for-sub-sessions" — one call that blocks until it is done and hands back the answer. Do NOT sleep and poll.'

/** 结果排版：一段文本，行间空行 —— 与其他工具的多段结果同形 */
function text(...lines: string[]): AgentToolResult<SessionToolDetails | undefined> {
  return {
    content: [{ type: 'text' as const, text: lines.filter(Boolean).join('\n\n') }],
    details: undefined
  }
}

/**
 * 后台形态的结果：带上 `details.background`，UI 据此渲染与 bash 后台任务**同一枚**
 * 「后台」标签 —— 对用户而言两者是同一件事：这次调用没有等结果，活还在跑。
 */
function backgroundText(...lines: string[]): AgentToolResult<SessionToolDetails> {
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
  return `<sub-session id="${attr(info.id)}" title="${attr(info.title)}" status="${info.status}"${extra}>`
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
 * 卡在等批准的那一块。三件事缺一不可 —— 实测里少了它们，模型把这个状态读成
 * 「子代理自己爱提问」，反复改提示词说「不要提问、直接执行」，换了四条子会话都一样：
 *
 *   1. **问的是什么**（否则父级连转告都做不到）；
 *   2. **只有用户能解**，父级答不了（否则它会一直想自己修）；
 *   3. **父级唯一有用的动作是转告用户**（否则它只剩重试和放弃两条路）。
 */
function blockedBlock(asked?: string[]): string {
  return [
    '<blocked-on-user-approval>',
    asked?.length ? asked.map((a) => `- ${a}`).join('\n') : '- (question text unavailable)',
    'This is an approval prompt shown to the USER inside that sub-session. It stays there until',
    'the user answers it — you cannot answer it, and rewording the task will not clear it.',
    'Tell the user what is waiting for them, or stop the sub-session with "stop-sub-session".',
    '</blocked-on-user-approval>'
  ].join('\n')
}

function renderChild(info: SubSessionInfo & { answer?: string; isError?: boolean }): string {
  // waiting-input 优先于「有没有答复」：它此刻停着这件事，比它上一轮说过什么更要紧
  if (info.status === 'waiting-input') {
    return [
      openTag(info),
      blockedBlock(info.blockedOn),
      ...(info.answer ? [`<earlier-reply>\n${info.answer}\n</earlier-reply>`] : []),
      '</sub-session>'
    ].join('\n')
  }
  const body = info.answer
    ? info.isError
      ? `<error>\n${info.answer}\n</error>`
      : `<reply>\n${info.answer}\n</reply>`
    : info.status === 'running'
      ? '<note>Still running. It was NOT cancelled.</note>'
      : '<note>No reply yet.</note>'
  return `${openTag(info)}\n${body}\n</sub-session>`
}

export class SessionTool extends BaseTool<typeof SessionParamsSchema> {
  readonly name = SESSION_TOOL_NAME
  readonly label: string
  readonly description = SESSION_DESCRIPTION
  readonly parameters = SessionParamsSchema

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
    signal?: AbortSignal
  ): Promise<AgentToolResult<SessionToolDetails | undefined>> {
    switch (params.action) {
      case 'set-title':
        return this.setTitle(params.title)
      case 'create-sub-session':
        return this.createSubSession(params)
      case 'prompt-sub-session':
        return this.promptSubSession(params, signal)
      case 'wait-for-sub-sessions':
        return this.waitForSubSessions(params, signal)
      case 'list-sub-sessions':
        return this.listSubSessions()
      case 'read-sub-session':
        return this.readSubSession(params)
      case 'stop-sub-session':
        return this.stopSubSession(params)
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
    params: SessionToolParams
  ): Promise<AgentToolResult<SessionToolDetails | undefined>> {
    const res = await subSessionRunner.create(this.ctx.sessionId, {
      title: params.title,
      agentProfile: params.agent_profile
    })
    if ('error' in res) throw new Error(res.error)

    // create **只建会话**。曾经它带 message 就顺手转 prompt（少一次往返），代价是
    // 「开一条子会话去干 X」这个最常见的写法恒为前台形态：派活那一刻就把父会话按住，
    // 最长 300s 才降级 —— 而派活的人多半根本不需要当场拿到答复。派发的形态选择属于
    // `prompt-sub-session`（`run_in_background`），不该由「顺手」替它定死。
    //
    // 收到 message 不静默丢掉：那才是真的坑 —— 模型会以为活已经派下去了，转头去
    // wait 一个根本没开始的东西。回执明说没发，并把下一步给全。
    return text(
      `<sub-session id="${attr(res.id)}" title="${attr(res.title)}" status="created"/>`,
      params.message?.trim()
        ? 'Nothing was sent to it: "create-sub-session" does not take `message`.'
        : '',
      'Send it its task with action "prompt-sub-session" — add `run_in_background: true` to dispatch it without waiting for the reply.'
    )
  }

  private async promptSubSession(
    params: SessionToolParams,
    signal?: AbortSignal
  ): Promise<AgentToolResult<SessionToolDetails | undefined>> {
    const res = await subSessionRunner.prompt({
      parentId: this.ctx.sessionId,
      childId: (params.sub_session_id ?? '').trim(),
      message: params.message ?? '',
      background: params.run_in_background === true,
      timeoutSeconds: params.timeout_seconds ?? DEFAULT_PROMPT_TIMEOUT_SEC,
      signal
    })
    if ('error' in res) throw new Error(res.error)

    const id = (params.sub_session_id ?? '').trim()
    // 后台/降级的回执刻意不带内容：它会永久留在本会话上下文里并被每一步重发。
    // 收尾指引说的是**真实**机制：完成通知只在这一轮还没结束时插得进来，
    // 所以要结果就 wait（挂住、不花钱），而不是先说完话再回来轮询。
    if (res.kind === 'started') {
      return backgroundText(
        `<sub-session id="${attr(id)}" status="running"/>`,
        `Started in the background.`,
        COLLECT_HINT
      )
    }
    if (res.kind === 'timeout') {
      return backgroundText(
        `<sub-session id="${attr(id)}" status="running"/>`,
        `Still running after ${params.timeout_seconds ?? DEFAULT_PROMPT_TIMEOUT_SEC}s — it was NOT cancelled and keeps going.`,
        COLLECT_HINT
      )
    }
    // info 由 runner 顺带带回（省掉再 read 一次 = 再投影一遍整棵转写）；
    // 它理论上可能缺（会话恰好被删），那时退化成只有围栏骨架的一块
    const info: SubSessionInfo = res.info ?? {
      id,
      title: id,
      status: 'idle',
      driven: false,
      updatedAt: 0
    }
    return text(renderChild({ ...info, answer: res.answer, isError: res.isError }))
  }

  private async waitForSubSessions(
    params: SessionToolParams,
    signal?: AbortSignal
  ): Promise<AgentToolResult<SessionToolDetails | undefined>> {
    const id = params.sub_session_id?.trim()
    const res = await subSessionRunner.wait({
      parentId: this.ctx.sessionId,
      ...(id ? { childId: id } : {}),
      timeoutSeconds: params.timeout_seconds ?? DEFAULT_PROMPT_TIMEOUT_SEC,
      signal
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
          : res.kind === 'blocked'
            ? 'Nothing finished: a sub-session is waiting for the user to approve something. Waiting again will not help — relay it to the user.'
            : ''
    // **不带后台标签**：那枚标签的含义是「这次调用甩下了一件还在跑的活」（bash 的
    // run_in_background、prompt 的后台形态与超时降级都是）。wait 什么也没起 —— 它是一次
    // 读取；即便超时，还在跑的那件活是**上一次 prompt** 甩下的，标签早就打在那张卡上了。
    // blocked 更不是：那时根本没有东西在跑，是有人在等用户点批准。
    return text(`<sub-sessions status="${res.kind}">\n${body}\n</sub-sessions>`, trailer)
  }

  private listSubSessions(): AgentToolResult<SessionToolDetails | undefined> {
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
  ): Promise<AgentToolResult<SessionToolDetails | undefined>> {
    const res = await subSessionRunner.read(
      this.ctx.sessionId,
      (params.sub_session_id ?? '').trim()
    )
    if ('error' in res) throw new Error(res.error)
    return text(renderChild({ ...res.info, answer: res.answer, isError: res.isError }))
  }

  private async stopSubSession(
    params: SessionToolParams
  ): Promise<AgentToolResult<SessionToolDetails | undefined>> {
    const id = (params.sub_session_id ?? '').trim()
    const res = await subSessionRunner.stop(this.ctx.sessionId, id)
    if ('error' in res) throw new Error(res.error)
    return text(res.stopped ? `Stopped sub-session ${id}.` : `Sub-session ${id} was not running.`)
  }

  /** 重命名本任务所属会话；笔记本会话的标题绑在文件名上，拒绝而不是悄悄改别的 */
  private setTitle(rawTitle: string | undefined): AgentToolResult<SessionToolDetails | undefined> {
    const sessionId = this.ctx.sessionId
    const session = sessionDao.pick(sessionId, ['title', 'settings'])
    if (!session) {
      // workflow 的无会话上下文 run（rootSessionId=runId）等场景：没有可操作的会话
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
