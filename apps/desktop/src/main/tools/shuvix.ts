/**
 * `shuvix` 工具 —— agent 改 ShuviX 自己的设置，走设置页、手机、网页调的同一套设置 API（docs/mcp-config-compat-design.md）。
 *
 * 为什么是一个通用工具而不是每样设置一个：用户不想每给 agent 补一种设置能力就加一个工具（2026-11-08）。
 * 能调哪些通道、卡上摆什么、结果给模型看什么，全在 services/agentChannels.ts 的注解里；这个文件不认识任何一条具体的通道。
 *
 * 一次 `call` 的顺序：
 *  1. 参数按注解的结构校验（说不通的直接回给模型，什么也不问）；
 *  2. 读的直接调；要改东西的过 `ask-on-settings`（scope / access 与网络客户端同一套词）—— 卡上逐行摆出改动，
 *     agent 留空的值让用户在卡上填（值直接进宿主，见 cardValues.ts）；
 *  3. 没出卡就放行了（用户写了 force-allow、或审查员答了）却还缺要填的值 → 单独出一张只填值的卡；
 *  4. 进程内调那条通道的处理函数（客户端 = agent，见 ipc/registry.ts invokeAsAgent）；
 *  5. 注解整理结果（秘密只说有没有值），需要时顺手验证一次（回执）。
 *
 * 描述固定不变：它变了就是一次工具重新声明，会打穿不支持中途改工具的模型的缓存。新开放的通道从 `describe` 看得到。
 *
 * 不重跑（BaseTool 缺省 `replay: 'unsafe'`）：中断之后模型拿到中断结果，要不要再来一次由它看了 `mcp:list` 再定。
 */
import { Type } from 'typebox'
import type { TObject } from 'typebox'
import { Check, Errors } from 'typebox/value'
import { BaseTool, callOwnerOf, type ToolCallScope, type ToolResult } from '@shuvix/agent-runtime'
import { BUILTIN_TOOL_PRESENTATIONS } from '@shuvix/chat-protocol/builtinToolPresentations'
import { SHUVIX_TOOL_NAME } from '@shuvix/chat-protocol/toolSelection'
import type { AskField, AskInputRequest } from '@shuvix/chat-protocol/types/inputRequest'
import { invokeAsAgent } from '../ipc/registry'
import {
  AGENT_CHANNELS,
  agentChannelFacts,
  agentChannelOf,
  type AnyAgentChannel
} from '../services/agentChannels'
import { takeCardValues } from '../services/cardValues'
import { withCallAgent } from '../services/toolAgent'
import { assertChannelAccess, type ToolContext } from '../services/toolContext'
import { registerBuiltinTool } from '../services/toolRegistry'
import { requestUserInputFor } from '../services/userInputBroker'
import { t } from '../i18n'

export const SHUVIX_TOOL_DESCRIPTION =
  "Change ShuviX's own settings for the user (for example add or fix an MCP server), through the same settings API the app's settings pages use.\n\n" +
  '- `describe` lists what you can read or change, grouped by area; with `scope` or `channel` it also gives the exact `args` each one takes.\n' +
  '- `call` runs one `channel` with `args`. Reading runs at once. A change is shown to the user on an approval card first; the result says what happened.\n\n' +
  'Secret values (API keys, tokens): pass the placeholder you hold, or leave the value as an empty string and the user types it on the approval card. Never ask the user to type a secret into the chat.'

export const ShuvixParamsSchema: TObject = Type.Object({
  action: Type.Union([Type.Literal('describe'), Type.Literal('call')]),
  scope: Type.Optional(
    Type.String({ description: 'describe: one area (as listed by describe), with full args.' })
  ),
  channel: Type.Optional(
    Type.String({ description: 'describe: one channel with full args. call: the channel to run.' })
  ),
  args: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description: 'call: the arguments, as describe shows them.'
    })
  )
})

interface ShuvixParams {
  action?: unknown
  scope?: unknown
  channel?: unknown
  args?: unknown
}

const textResult = (text: string): ToolResult => ({
  content: [{ type: 'text' as const, text }],
  details: undefined
})

const json = (value: unknown): string => JSON.stringify(value, null, 2)

/** describe 的一行：名字、读还是改、一句话 */
function channelLine(channel: AnyAgentChannel): string {
  const { access } = agentChannelFacts(channel)
  return `- ${channel.channel} (${access === 'read' ? 'read' : 'change, asks the user'}): ${channel.summary}`
}

/** 参数校验不过时给模型看的话：每条一行，路径 + 原因 */
function argsProblems(channel: AnyAgentChannel, args: unknown): string | undefined {
  if (Check(channel.params, args)) return undefined
  const lines = [...Errors(channel.params, args)]
    .slice(0, 8)
    .map((error) => `- ${error.instancePath || '(args)'}: ${error.message}`)
  return `The args for ${channel.channel} do not fit:\n${lines.join('\n')}\nCall describe with channel "${channel.channel}" for its exact args.`
}

export class ShuvixTool extends BaseTool<typeof ShuvixParamsSchema> {
  readonly name = SHUVIX_TOOL_NAME
  readonly label = t(BUILTIN_TOOL_PRESENTATIONS.shuvix.labelKey)
  readonly description = SHUVIX_TOOL_DESCRIPTION
  readonly parameters = ShuvixParamsSchema

  constructor(private readonly ctx: ToolContext) {
    super()
  }

  async preExecute(): Promise<void> {
    /* no-op */
  }

  /** 门在 executeInternal 里：认出是哪条通道、读还是改之前，不知道该问什么 */
  protected async securityCheck(): Promise<void> {
    /* no-op */
  }

  protected async executeInternal(
    toolCallId: string,
    params: ShuvixParams,
    signal: AbortSignal | undefined,
    call: ToolCallScope
  ): Promise<ToolResult> {
    if (params.action === 'describe') return textResult(this.describe(params))
    if (params.action !== 'call') throw new Error('action must be "describe" or "call"')

    const name = typeof params.channel === 'string' ? params.channel.trim() : ''
    const channel = agentChannelOf(name)
    if (!channel) {
      throw new Error(
        `${name ? `"${name}" is not a channel you can use` : 'channel is missing'}. Call describe to see the channels.`
      )
    }
    let args: Record<string, unknown> =
      typeof params.args === 'object' && params.args !== null && !Array.isArray(params.args)
        ? (params.args as Record<string, unknown>)
        : {}
    const problems = argsProblems(channel, args)
    if (problems) throw new Error(problems)

    const facts = agentChannelFacts(channel)
    const { sessionId } = this.ctx
    if (facts.access !== 'read') {
      const fields = channel.fieldsOf?.(args) ?? []
      const card = channel.card(args)
      // 卡上的内容先算：说不通的（名字不存在之类）在问用户之前就回给模型
      channel.toHandlerArgs(args)
      await assertChannelAccess(withCallAgent(this.ctx, call), facts, {
        toolCallId,
        toolName: SHUVIX_TOOL_NAME,
        description: card.title,
        preview: { kind: 'settings', channel: channel.channel, title: card.title, rows: card.rows },
        fields,
        owner: callOwnerOf(call),
        ...(signal ? { signal } : {})
      })
      if (fields.length > 0) {
        const values =
          takeCardValues(sessionId, toolCallId) ??
          (await this.askForValues(toolCallId, channel, card.title, fields, call))
        const missing = fields.filter((field) => field.required && !values[field.key]?.trim())
        if (missing.length > 0) {
          throw new Error(
            `Nothing was changed: the user did not fill in ${missing.map((field) => field.label).join(', ')}.`
          )
        }
        args = channel.withValues?.(args, values) ?? args
      }
    }

    if (signal?.aborted) throw signal.reason
    const result = await invokeAsAgent(channel.channel, sessionId, channel.toHandlerArgs(args))
    const presented = await channel.present(result, args, {
      sessionId,
      ...(signal ? { signal } : {})
    })
    return textResult(json(presented))
  }

  /**
   * 策略直接放行了（没出卡）却还缺要用户填的值：单独出一张只填值的卡。值照样不经过对话（cardValues.ts）。
   * 用户拒绝 / 写了别的 → 抛错，什么也没改。
   */
  private async askForValues(
    toolCallId: string,
    channel: AnyAgentChannel,
    title: string,
    fields: AskField[],
    call: ToolCallScope
  ): Promise<Record<string, string>> {
    const { sessionId } = this.ctx
    const owner = callOwnerOf(call)
    const request: AskInputRequest = {
      id: toolCallId,
      kind: 'ask',
      toolName: SHUVIX_TOOL_NAME,
      ...(owner?.conversationId === undefined ? {} : { conversationId: owner.conversationId }),
      command: channel.channel,
      description: t('agentApi.fillOnlyDescription'),
      preview: { kind: 'settings', channel: channel.channel, title, rows: [] },
      fields,
      createdAt: Date.now()
    }
    const response = await requestUserInputFor(sessionId, request)
    if (response.kind === 'ask' && response.allowed) {
      return takeCardValues(sessionId, toolCallId) ?? {}
    }
    if (response.kind === 'other') {
      throw new Error(`Nothing was changed. The user wrote instead: ${response.text}`)
    }
    if (response.kind === 'cancel') throw new Error('Aborted')
    throw new Error('Nothing was changed: the user declined to fill in the values.')
  }

  private describe(params: ShuvixParams): string {
    const scope = typeof params.scope === 'string' ? params.scope.trim() : ''
    const name = typeof params.channel === 'string' ? params.channel.trim() : ''
    if (name) {
      const channel = agentChannelOf(name)
      if (!channel) return `"${name}" is not a channel you can use.\n\n${this.overview()}`
      return this.detail([channel])
    }
    if (scope) {
      // 也认通道名的前缀（`mcp`）：live probe 里 14 次有 11 次先猜这个，每次白搭一轮（2026-11-08）
      const channels = AGENT_CHANNELS.filter((channel) => {
        const facts = agentChannelFacts(channel)
        return facts.scope === scope || facts.group === scope
      })
      if (channels.length === 0) return `Nothing in "${scope}".\n\n${this.overview()}`
      return this.detail(channels)
    }
    return this.overview()
  }

  /** 按 scope 分组的一览（不带参数结构） */
  private overview(): string {
    const groups = new Map<string, AnyAgentChannel[]>()
    for (const channel of AGENT_CHANNELS) {
      const { scope } = agentChannelFacts(channel)
      groups.set(scope, [...(groups.get(scope) ?? []), channel])
    }
    const sections = [...groups].map(
      ([scope, channels]) => `## ${scope}\n${channels.map(channelLine).join('\n')}`
    )
    return `${sections.join('\n\n')}\n\nCall describe with a scope or a channel for the exact args.`
  }

  /** 每条：一行说明 + 参数结构（JSON Schema） */
  private detail(channels: readonly AnyAgentChannel[]): string {
    return channels
      .map((channel) => `${channelLine(channel)}\nargs: ${JSON.stringify(channel.params)}`)
      .join('\n\n')
  }
}

registerBuiltinTool({
  name: SHUVIX_TOOL_NAME,
  group: 'general',
  getLabel: () => t(BUILTIN_TOOL_PRESENTATIONS.shuvix.labelKey),
  getHint: () => t('tool.shuvixHint'),
  factory: (ctx) => new ShuvixTool(ctx),
  presentation: BUILTIN_TOOL_PRESENTATIONS.shuvix.presentation,
  describe: () => ({ description: SHUVIX_TOOL_DESCRIPTION, parameters: ShuvixParamsSchema })
})
