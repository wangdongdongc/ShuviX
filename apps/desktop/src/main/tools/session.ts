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
        'For "prompt-sub-session": the message to send, written exactly as a user would write it. The sub-session sees only this text, so make it self-contained.'
    })
  ),
  run_in_background: Type.Optional(
    Type.Boolean({
      description:
        'For "prompt-sub-session": return a receipt immediately instead of waiting for the answer. Use it to run several sub-sessions at once, or when the task is long and you have other work to do. You are notified when it finishes; read the answer with "read-sub-session".'
    })
  ),
  timeout_seconds: Type.Optional(
    Type.Number({
      description: `For "prompt-sub-session" in the foreground: how long to wait (default: ${DEFAULT_PROMPT_TIMEOUT_SEC}s). On timeout the sub-session keeps running — it is NOT cancelled — and the call returns as if it had been started in the background.`
    })
  )
})

export const SESSION_DESCRIPTION = `Read or change the session this task belongs to, and manage its sub-sessions.

A sub-session is an ordinary session that you own: it has its own conversation, model, tools and history, the user can see it in the session list (nested under this one) and can read or continue it at any time. Use one when a task deserves its own conversation that outlives a single answer — unlike the \`agent\` tool, whose sub-agent disappears once it replies. Sub-sessions cannot create sub-sessions of their own.

Actions:
- "set-title": rename THIS session. Pass the new title in \`title\` (concise, at most ${TITLE_MAX_CHARS} characters).
- "create-sub-session": start an empty sub-session and return its id. Optional \`title\` and \`agent_profile\`. It inherits this session's project and model.
- "prompt-sub-session": send \`message\` into \`sub_session_id\` as if the user had typed it, and wait for the reply. Add \`run_in_background: true\` to get a receipt immediately instead.
- "list-sub-sessions": list your sub-sessions with their status (idle / running / waiting-input).
- "read-sub-session": the latest answer of \`sub_session_id\` — how you collect the result of a background turn.
- "stop-sub-session": stop whatever \`sub_session_id\` is currently doing.

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

/** 结果排版：一段文本，行间空行 —— 与其他工具的多段结果同形 */
function text(...lines: string[]): AgentToolResult<undefined> {
  return {
    content: [{ type: 'text' as const, text: lines.filter(Boolean).join('\n\n') }],
    details: undefined
  }
}

function formatInfo(info: SubSessionInfo): string {
  return `${info.id}  [${info.status}]  ${info.title}`
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
  ): Promise<AgentToolResult<undefined>> {
    switch (params.action) {
      case 'set-title':
        return this.setTitle(params.title)
      case 'create-sub-session':
        return this.createSubSession(params)
      case 'prompt-sub-session':
        return this.promptSubSession(params, signal)
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

  private async createSubSession(params: SessionToolParams): Promise<AgentToolResult<undefined>> {
    const res = await subSessionRunner.create(this.ctx.sessionId, {
      title: params.title,
      agentProfile: params.agent_profile
    })
    if ('error' in res) throw new Error(res.error)
    return text(
      `Created sub-session "${res.title}".`,
      `id: ${res.id}`,
      `Send it work with action "prompt-sub-session".`
    )
  }

  private async promptSubSession(
    params: SessionToolParams,
    signal?: AbortSignal
  ): Promise<AgentToolResult<undefined>> {
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
    // 后台/降级的回执刻意不带内容：它会永久留在本会话上下文里并被每一步重发
    if (res.kind === 'started') {
      return text(
        `Started in the background. The sub-session is working on it.`,
        `You will be notified when it finishes; then read the answer with action "read-sub-session" (id: ${id}).`
      )
    }
    if (res.kind === 'timeout') {
      return text(
        `Still running after ${params.timeout_seconds ?? DEFAULT_PROMPT_TIMEOUT_SEC}s — it was NOT cancelled and keeps going in the background.`,
        `You will be notified when it finishes; read the answer with action "read-sub-session" (id: ${id}).`
      )
    }
    if (!res.answer) {
      return text(`The turn ended without a reply. Read the sub-session to see what happened.`)
    }
    return text(res.isError ? `The sub-session's turn failed:` : `Sub-session replied:`, res.answer)
  }

  private listSubSessions(): AgentToolResult<undefined> {
    const res = subSessionRunner.list(this.ctx.sessionId)
    if ('error' in res) throw new Error(res.error)
    if (res.subSessions.length === 0) {
      return text('No sub-sessions yet. Create one with action "create-sub-session".')
    }
    return text(...res.subSessions.map(formatInfo))
  }

  private async readSubSession(params: SessionToolParams): Promise<AgentToolResult<undefined>> {
    const res = await subSessionRunner.read(
      this.ctx.sessionId,
      (params.sub_session_id ?? '').trim()
    )
    if ('error' in res) throw new Error(res.error)
    const head = formatInfo(res.info)
    if (!res.answer) return text(head, 'It has not replied yet.')
    return text(head, res.isError ? 'Its last turn failed:' : 'Its latest answer:', res.answer)
  }

  private async stopSubSession(params: SessionToolParams): Promise<AgentToolResult<undefined>> {
    const id = (params.sub_session_id ?? '').trim()
    const res = await subSessionRunner.stop(this.ctx.sessionId, id)
    if ('error' in res) throw new Error(res.error)
    return text(res.stopped ? `Stopped sub-session ${id}.` : `Sub-session ${id} was not running.`)
  }

  /** 重命名本任务所属会话；笔记本会话的标题绑在文件名上，拒绝而不是悄悄改别的 */
  private setTitle(rawTitle: string | undefined): AgentToolResult<undefined> {
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
