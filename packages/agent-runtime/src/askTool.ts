/**
 * ask 工具（宿主无关，桌面/扩展完全复用一份）。
 *
 * 纯 UI 工具：经注入的 requestUserInput 挂起，等用户在共享 chat-ui 选择面板里响应后返回。
 * 唯一随宿主而异的是 requestUserInput 的接线（桌面 IPC InputRequest / 扩展 RuntimeSession）、
 * abort 文案、以及本地化 label——都经参数注入。
 */
import { Type } from 'typebox'
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import type { AskToolDetails } from '@shuvix/chat-protocol/types/chatMessage'
import type { InputRequest, InputResponse } from '@shuvix/chat-protocol/types/inputRequest'

export const AskParamsSchema = Type.Object({
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

export const ASK_DESCRIPTION =
  'Present a question with clickable options to the user. When the user needs to choose between approaches, styles, configurations, or any decision point, use this tool so the options are clickable rather than written out as plain text.'

export interface CreateAskToolOptions {
  /** 挂起并等待用户响应（桌面经 IPC，扩展经 RuntimeSession；均落到共享 chat-ui 面板） */
  requestUserInput: (req: InputRequest) => Promise<InputResponse>
  /** abort 时抛出的错误文案（桌面 'Aborted'，扩展 'TOOL_ABORTED'）；默认 'Aborted' */
  abortError?: string
  /** 工具显示名（宿主可传本地化值）；默认 'Ask' */
  label?: string
}

export function createAskTool({
  requestUserInput,
  abortError = 'Aborted',
  label = 'Ask'
}: CreateAskToolOptions): AgentTool<typeof AskParamsSchema, AskToolDetails> {
  return {
    name: 'ask',
    label,
    description: ASK_DESCRIPTION,
    parameters: AskParamsSchema,
    async execute(
      toolCallId: string,
      params: {
        question: string
        options: Array<{ label: string; description: string }>
        allowMultiple?: boolean
      },
      signal?: AbortSignal
    ): Promise<AgentToolResult<AskToolDetails>> {
      if (signal?.aborted) throw new Error(abortError)

      const response = await requestUserInput({
        id: toolCallId,
        kind: 'choice',
        toolName: 'ask',
        question: params.question,
        options: params.options,
        allowMultiple: params.allowMultiple ?? false,
        createdAt: Date.now()
      })

      if (signal?.aborted) throw new Error(abortError)

      let text: string
      let selections: string[] = []
      if (response.kind === 'cancel') {
        throw new Error(abortError)
      } else if (response.kind === 'other') {
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
        details: { type: 'ask', question: params.question, selections }
      }
    }
  }
}
