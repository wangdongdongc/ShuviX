/**
 * ask 工具（宿主无关，桌面/扩展完全复用一份）—— pi-durable 原生注册项。
 *
 * 纯 UI 工具：经注入的 requestUserInput 挂起，等用户在共享 chat-ui 选择面板里响应后返回。
 * 唯一随宿主而异的是 requestUserInput 的接线（桌面 IPC InputRequest / 扩展 RuntimeSession）、
 * abort 文案、以及本地化 label——都经参数注入。
 *
 * durable 的三处约定：
 *  - **询问 id = `api.callId`**（provider 给的工具调用 id）—— 应答按它路由，与旧版一致。
 *  - **`replay: 'safe'`**：问一句不改任何东西。进程在卡片挂着时中断，恢复后重跑就是把同一个问题
 *    （同一个 id）再问一遍 —— 正是想要的，而不是把这次调用记成「中断，可能已部分执行」。
 *  - **取消跟着 `context.abortSignal`**：等待随它立刻结束（不必等谁去撤卡片），之后原样抛出 ——
 *    durable 的中止语义靠这一抛。其余失败（用户取消卡片、没有询问通道……）按裁定 Q12 收成
 *    `isError` 结果，模型看到的文字与旧版相同。
 */
import { Type } from 'typebox'
import { awaitWithContext } from '@earendil-works/chord/context'
import type { ToolRegistration } from '@earendil-works/pi-durable'
import type { AskToolDetails } from '@shuvix/chat-protocol/types/chatMessage'
import type { InputRequest, InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import { catchToolErrors, toExecutionResult, type ToolResult } from './tools/toolResult'
import { backstopOutputLimits } from './tools/outputLimits'

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

/** ask 工具：durable 注册项 + 界面显示名 */
export type AskTool = ToolRegistration<typeof AskParamsSchema> & {
  readonly label: string
  readonly replay: 'safe'
}

export function createAskTool({
  requestUserInput,
  abortError = 'Aborted',
  label = 'Ask'
}: CreateAskToolOptions): AskTool {
  return {
    name: 'ask',
    label,
    description: ASK_DESCRIPTION,
    parameters: AskParamsSchema,
    replay: 'safe',
    outputLimits: backstopOutputLimits({}),
    execute: (params, api, context) =>
      catchToolErrors(context, async () => {
        if (context.abortSignal?.aborted) throw new Error(abortError)

        const response = await awaitWithContext(
          requestUserInput({
            id: api.callId,
            kind: 'choice',
            toolName: 'ask',
            question: params.question,
            options: params.options,
            allowMultiple: params.allowMultiple ?? false,
            createdAt: Date.now()
          }),
          context
        )

        if (context.abortSignal?.aborted) throw new Error(abortError)

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

        const result: ToolResult<AskToolDetails> = {
          content: [{ type: 'text', text }],
          details: { type: 'ask', question: params.question, selections }
        }
        return toExecutionResult(result, 'ask')
      })
  }
}
