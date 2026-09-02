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
        'The message to send, written exactly as a user would write it — the sub-session sees only this text, so make it self-contained. Required by "prompt-sub-session"; on "create-sub-session" it is optional and sends this as the new sub-session\'s first message right away.'
    })
  ),
  run_in_background: Type.Optional(
    Type.Boolean({
      description:
        'For "prompt-sub-session": return a receipt immediately instead of waiting for the answer. Use it ONLY when you have other work to do right now, or when starting several sub-sessions to collect together with "wait-for-sub-sessions". If you need the reply before you can continue, leave this off and let the call wait — waiting costs nothing, while a receipt you then wait around for costs a request every time you check.'
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
- "create-sub-session": start a sub-session and return its id. Optional \`title\` and \`agent_profile\`; pass \`message\` to send it its first task in the same call. It inherits this session's project and model.
- "prompt-sub-session": send \`message\` into \`sub_session_id\` as if the user had typed it, and wait for the reply. Add \`run_in_background: true\` to get a receipt immediately instead.
- "wait-for-sub-sessions": block until your sub-sessions finish and return all their answers at once. Omit \`sub_session_id\` to wait for every one that is running, or pass one to wait for that one.
- "list-sub-sessions": list your sub-sessions with their status (idle / running / waiting-input).
- "read-sub-session": the latest answer of \`sub_session_id\`.
- "stop-sub-session": stop whatever \`sub_session_id\` is currently doing.

Waiting is a single call that costs nothing while it waits. **Never sleep and then poll** with "list-sub-sessions" / "read-sub-session": every poll is a full request, and it buys you nothing that waiting would not have given you for free. If you need the answer to continue, use the foreground form — it cannot hang, because on timeout it leaves the sub-session running and tells you so. Start work in the background only when you genuinely have something else to do first, then collect it with "wait-for-sub-sessions".

**A sub-session runs one turn at a time.** It is a conversation, not a queue: sending a second message while it is still working is rejected, so either wait for the reply or create another sub-session to work in parallel. A sub-session can also stop and ask the user a question (\`status="waiting-input"\`) — it will not proceed until the user answers in that session, so relay the question instead of waiting.

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
 * 后台/降级回执的收尾指引。**不写「你会被通知」**：完成通知只在这一轮还没结束时
 * 插得进来（HarnessSession.notify 运行中 steer、空闲则排到下一轮），父级说完话就
 * 收不到了 —— 那句承诺正是模型改用 sleep 轮询的原因。
 */
const COLLECT_HINT =
  'When you need the result, collect it with action "wait-for-sub-sessions" — one call that blocks until it is done and hands back the answer. Do NOT sleep and poll.'

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
function renderChild(info: SubSessionInfo & { answer?: string; isError?: boolean }): string {
  const body = info.answer
    ? info.isError
      ? `<error>\n${info.answer}\n</error>`
      : `<reply>\n${info.answer}\n</reply>`
    : info.status === 'waiting-input'
      ? '<note>Waiting for the user to answer a question — it will not finish on its own.</note>'
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
        return this.createSubSession(params, signal)
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
    params: SessionToolParams,
    signal?: AbortSignal
  ): Promise<AgentToolResult<SessionToolDetails | undefined>> {
    const res = await subSessionRunner.create(this.ctx.sessionId, {
      title: params.title,
      agentProfile: params.agent_profile
    })
    if ('error' in res) throw new Error(res.error)

    // 带了 message 就顺手把活派下去 —— 「开一条子会话去干 X」本来就是一个动作，
    // 拆成两次往返只是工具面的偶然。**转交给同一个 prompt 路径**，忙碌/后台/超时
    // 语义只有一份；静默丢掉这个参数才是坑（模型会以为活已经派下去了）。
    if (params.message?.trim()) {
      return this.promptSubSession({ ...params, sub_session_id: res.id }, signal)
    }
    return text(
      `<sub-session id="${attr(res.id)}" title="${attr(res.title)}" status="created"/>`,
      `Send it work with action "prompt-sub-session".`
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
          : ''
    const out = [`<sub-sessions status="${res.kind}">\n${body}\n</sub-sessions>`, trailer]
    // 等待没等到底 = 活还在跑，与后台形态是同一件事，标签一致
    return res.kind === 'settled' ? text(...out) : backgroundText(...out)
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
