/**
 * Ask 工具 — AI 向用户提问并提供结构化选项
 * 用户在前端选择后，结果返回给 AI 继续推理
 */

import { Type } from '@sinclair/typebox'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import { TOOL_ABORTED, type ToolContext } from './types'
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

/** 创建 ask 工具实例 */
export function createAskTool(ctx: ToolContext): AgentTool<typeof AskParamsSchema> {
  return {
    name: 'ask',
    label: t('tool.askLabel'),
    description:
      'Present a question with clickable options to the user. You MUST use this tool instead of listing options in text whenever you need the user to choose between approaches, styles, configurations, or any decision point. Do NOT list numbered options in plain text — always call this tool so the user can click to select.',
    parameters: AskParamsSchema,
    execute: async (
      toolCallId: string,
      params: {
        question: string
        options: Array<{ label: string; description: string }>
        allowMultiple?: boolean
      },
      signal?: AbortSignal
    ) => {
      if (signal?.aborted) throw new Error(TOOL_ABORTED)

      if (!ctx.requestUserInput) {
        throw new Error('requestUserInput callback not available')
      }

      // 挂起 Promise，等待用户在前端选择
      const selections = await ctx.requestUserInput(toolCallId, {
        question: params.question,
        options: params.options,
        allowMultiple: params.allowMultiple ?? false
      })

      if (signal?.aborted) throw new Error(TOOL_ABORTED)

      // 格式化用户选择为文本
      let text: string
      if (selections.length === 0) {
        text = 'User made no selection'
      } else {
        text = `User selected: ${selections.join(', ')}`
      }

      return {
        content: [{ type: 'text' as const, text }],
        details: {
          question: params.question,
          selections
        }
      }
    }
  }
}
