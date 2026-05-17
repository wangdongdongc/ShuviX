/**
 * Ask 工具 — AI 向用户提问并提供结构化选项
 * 用户在前端选择后，结果返回给 AI 继续推理
 */

import { Type } from 'typebox'
import { BaseTool } from '../services/baseTool'
import { TOOL_ABORTED, type ToolContext } from '../services/toolContext'
import type { AgentToolResult } from '@mariozechner/pi-agent-core'
import type { AskToolDetails } from '../../shared/types/chatMessage'
import { t } from '../i18n'

const AskParamsSchema = Type.Object({
  question: Type.String({ description: 'The question to ask the user' }),
  options: Type.Array(
    Type.Object({
      label: Type.String({ description: 'Short label for the option' }),
      description: Type.String({ description: 'Longer description explaining the option' })
    }),
    { description: 'Options for the user to choose from', minItems: 2, maxItems: 9 }
  ),
  allowMultiple: Type.Optional(
    Type.Boolean({ description: 'Whether the user can select multiple options. Default false.' })
  )
})

/** ask 工具 */
export class AskTool extends BaseTool<typeof AskParamsSchema> {
  readonly name = 'ask'
  readonly label = t('tool.askLabel')
  readonly description =
    'Present a question with clickable options to the user. You MUST use this tool instead of listing options in text whenever you need the user to choose between approaches, styles, configurations, or any decision point. Do NOT list numbered options in plain text — always call this tool so the user can click to select.'
  readonly parameters = AskParamsSchema

  constructor(private ctx: ToolContext) {
    super()
  }

  async preExecute(): Promise<void> {
    /* no-op */
  }

  /** 安全检查 — 无确定性安全约束 */
  protected async securityCheck(): Promise<void> {
    /* no-op */
  }

  protected async executeInternal(
    toolCallId: string,
    params: {
      question: string
      options: Array<{ label: string; description: string }>
      allowMultiple?: boolean
    },
    signal?: AbortSignal
  ): Promise<AgentToolResult<AskToolDetails>> {
    if (signal?.aborted) throw new Error(TOOL_ABORTED)

    if (!this.ctx.requestUserInput) {
      throw new Error('requestUserInput callback not available')
    }

    // 挂起 Promise，等待用户在前端选择
    const response = await this.ctx.requestUserInput({
      id: toolCallId,
      kind: 'choice',
      toolName: 'ask',
      question: params.question,
      options: params.options,
      allowMultiple: params.allowMultiple ?? false,
      createdAt: Date.now()
    })

    if (signal?.aborted) throw new Error(TOOL_ABORTED)

    // 格式化用户选择为文本
    let text: string
    let selections: string[] = []
    if (response.kind === 'cancel') {
      // abort 路径,中断当前 turn
      throw new Error(TOOL_ABORTED)
    } else if (response.kind === 'other') {
      // 用户没选任何选项,转而提交了自由文本反馈
      text = `User did not select any option and responded with feedback instead:\n${response.text}`
    } else if (response.kind === 'choice') {
      selections = response.selections
      text =
        selections.length === 0
          ? 'User made no selection'
          : `User selected: ${selections.join(', ')}`
    } else {
      text = 'User input error: unexpected response kind'
    }

    return {
      content: [{ type: 'text' as const, text }],
      details: {
        type: 'ask',
        question: params.question,
        selections
      }
    }
  }
}

import { registerBuiltinTool } from '../services/toolRegistry'
registerBuiltinTool({
  name: 'ask',
  group: 'general',
  defaultEnabled: true,
  getLabel: () => t('tool.askLabel'),
  getHint: () => t('tool.askHint'),
  factory: (ctx) => new AskTool(ctx),
  presentation: {
    icon: 'MessageCircleQuestion',
    iconColor: '#60a5fa',
    summaryField: 'question'
  }
})
