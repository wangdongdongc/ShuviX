/**
 * session-config 工具 —— 让 agent 读改**自己所属会话**的会话级配置。
 *
 * 目标会话恒取 ToolContext.sessionId（root=自身；spawned/workflow=归属会话）——
 * 刻意不收 sessionId 参数：一是 LLM 抄 uuid 会抄错，二是「只能动自己所属的会话」
 * 是比参数校验更硬的边界。会话域 workflow run 的 agent（如内置 titler）因此天然
 * 落在触发它的那个会话上。
 *
 * v1 仅 `set-title`（自动标题业务）；action 枚举为后续扩展留位（未知 action 的错误
 * 文案列出合法值 —— 5250adc 的纠正性引导纪律）。写入经 sessionService.updateTitle
 * (origin='auto')：落库 + 记 titleOrigin + 广播 titleChanged，各端会话列表即时刷新。
 * 无专属安全客体 —— 要设门用 L1 全工具门（tool.name == 'session-config'）。
 */
import { Type } from 'typebox'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import { BaseTool } from '@shuvix/agent-runtime'
import { BUILTIN_TOOL_PRESENTATIONS } from '@shuvix/chat-protocol/builtinToolPresentations'
import { registerBuiltinTool } from '../services/toolRegistry'
import type { ToolContext } from '../services/toolContext'
import { sessionDao } from '../dao/sessionDao'
import { sessionService } from '../services/sessionService'
import { t } from '../i18n'

export const SESSION_CONFIG_TOOL_NAME = 'session-config'

/** 标题长度上限（会话列表一行可辨；超长直接拒绝让模型改短，而不是静默截断） */
const TITLE_MAX_CHARS = 60

const ACTIONS = ['set-title'] as const

export const SessionConfigParamsSchema = Type.Object({
  action: Type.Unsafe<(typeof ACTIONS)[number]>({
    type: 'string',
    enum: [...ACTIONS],
    description: 'What to change. "set-title" renames the session this task belongs to.'
  }),
  title: Type.Optional(
    Type.String({
      description: `For "set-title": the new session title (concise, at most ${TITLE_MAX_CHARS} characters, same language as the conversation).`
    })
  )
})

export const SESSION_CONFIG_DESCRIPTION = `Read or change configuration of the session this task belongs to. Actions:
- "set-title": rename the session. Pass the new title in \`title\` (concise, at most ${TITLE_MAX_CHARS} characters). The rename is applied immediately and shows up in the session list.`

export class SessionConfigTool extends BaseTool<typeof SessionConfigParamsSchema> {
  readonly name = SESSION_CONFIG_TOOL_NAME
  readonly label: string
  readonly description = SESSION_CONFIG_DESCRIPTION
  readonly parameters = SessionConfigParamsSchema

  constructor(private readonly ctx: ToolContext) {
    super()
    this.label = t(BUILTIN_TOOL_PRESENTATIONS[SESSION_CONFIG_TOOL_NAME].labelKey)
  }

  async preExecute(): Promise<void> {
    /* no-op */
  }

  protected async securityCheck(): Promise<void> {
    /* no-op —— 无专属客体；按需经 L1 全工具门设门 */
  }

  protected async executeInternal(
    _toolCallId: string,
    params: { action: (typeof ACTIONS)[number]; title?: string }
  ): Promise<AgentToolResult<undefined>> {
    if (params.action !== 'set-title') {
      throw new Error(
        `Unknown action "${String(params.action)}". Valid actions: ${ACTIONS.join(', ')}`
      )
    }

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

    const title = (params.title ?? '').trim()
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
  name: SESSION_CONFIG_TOOL_NAME,
  group: 'system',
  getLabel: () => t(BUILTIN_TOOL_PRESENTATIONS[SESSION_CONFIG_TOOL_NAME].labelKey),
  getHint: () => t('tool.sessionConfigHint'),
  factory: (ctx: ToolContext) => new SessionConfigTool(ctx),
  presentation: BUILTIN_TOOL_PRESENTATIONS[SESSION_CONFIG_TOOL_NAME].presentation,
  describe: () => ({
    description: SESSION_CONFIG_DESCRIPTION,
    parameters: SessionConfigParamsSchema
  })
})
