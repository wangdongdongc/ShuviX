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
import { arr, bool, obj, oneOf, opt, str } from '@earendil-works/pi-schema'
import { awaitWithContext } from '@earendil-works/chord/context'
import type { ToolRegistration } from '@earendil-works/pi-durable'
import type { AskFormFieldRecord, AskToolDetails } from '@shuvix/chat-protocol/types/chatMessage'
import type {
  FormField,
  InputRequest,
  InputResponse
} from '@shuvix/chat-protocol/types/inputRequest'
import { catchToolErrors, toExecutionResult, type ToolResult } from './tools/toolResult'
import { UNATTENDED_QUESTION_TEXT } from '@shuvix/chat-protocol/unattended'
import { backstopOutputLimits } from './tools/outputLimits'

export const AskFormFieldSchema = obj({
  key: str({
    description: 'Identifier returned in the result, e.g. username, password, token'
  }),
  label: str({ description: 'Human-readable label shown on the card' }),
  type: oneOf(['text', 'secret'], {
    description:
      "Input type. Use 'secret' for passwords, API keys, tokens, private keys, or any sensitive value so it is masked and stored encrypted in this session's redaction table; use 'text' for non-sensitive values like username or host."
  }),
  description: opt(
    str({ description: 'Optional hint explaining what to enter or where to find it' })
  ),
  multiline: opt(
    bool({ description: 'True for multi-line values such as PEM private keys or notes' })
  ),
  required: opt(bool({ description: 'Whether the user must fill this field (default: true)' })),
  placeholder: opt(str({ description: 'Optional input placeholder text' }))
})

export const AskParamsSchema = obj({
  question: str({ description: 'The question or prompt to ask the user' }),
  detail: opt(
    str({
      description: 'Optional extra context explaining why the input is needed or how it is used'
    })
  ),
  options: opt(
    arr(
      obj({
        label: str({ description: 'Short label for the option' }),
        description: str({ description: 'Longer description explaining the option' })
      }),
      {
        description:
          'Clickable options for the user to choose from (2-9 items). Mutually exclusive with `fields`.',
        minItems: 2,
        maxItems: 9
      }
    )
  ),
  fields: opt(
    arr(AskFormFieldSchema, {
      description:
        'Structured form fields for the user to fill in (e.g. credentials, secrets, or paired inputs like username + password). Mutually exclusive with `options`.',
      minItems: 1,
      maxItems: 8
    })
  )
})

export const ASK_DESCRIPTION =
  'Ask the user a question via an interactive card. Pass EITHER `options` (for clickable choices) OR `fields` (for a structured input form), never both.\n' +
  '- Use `options` whenever the user has to choose, instead of writing options out in your reply. The user may tick one option or several, add words of their own, or answer only in their own words — do not tell them how many to pick, and write each option so it stands on its own.\n' +
  '- Use `fields` when you need sensitive credentials (passwords, API keys, tokens, private keys) or a small group of structured values (such as username + password). Always mark sensitive fields with `type: "secret"` instead of asking the user to paste secrets in chat — ShuviX encrypts them for this session and returns placeholders that are automatically restored when passed to tools.'

/**
 * 父会话代答时结果的开头。子会话的模型要知道这不是用户本人选的（它可以据此判断要不要再向用户确认）；
 * 进模型上下文的字符串不随界面语言变。
 */
export const PARENT_ANSWERED =
  'The user did not answer this — the session that assigned you this task answered on their behalf.'

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
    callers: ['model'],
    replay: 'safe',
    outputLimits: backstopOutputLimits({}),
    execute: (params, api, context) =>
      catchToolErrors(context, async () => {
        if (context.abortSignal?.aborted) throw new Error(abortError)

        const hasOptions = Array.isArray(params.options) && params.options.length > 0
        const hasFields = Array.isArray(params.fields) && params.fields.length > 0
        if (hasOptions === hasFields) {
          throw new Error(
            'Provide either `options` (for clickable choices) or `fields` (for a structured form), not both.'
          )
        }

        if (hasFields) {
          const fields: FormField[] = params.fields!.map((f) => ({
            key: f.key.trim(),
            label: f.label,
            type: f.type,
            ...(f.description === undefined ? {} : { description: f.description }),
            ...(f.multiline === undefined ? {} : { multiline: f.multiline }),
            ...(f.required === undefined ? {} : { required: f.required }),
            ...(f.placeholder === undefined ? {} : { placeholder: f.placeholder })
          }))
          const seenKeys = new Set<string>()
          for (const field of fields) {
            if (!field.key) throw new Error('Each form field must have a non-empty `key`.')
            if (seenKeys.has(field.key)) {
              throw new Error(`Duplicate form field key: "${field.key}".`)
            }
            seenKeys.add(field.key)
          }

          const response = await awaitWithContext(
            requestUserInput({
              id: api.callId,
              kind: 'form',
              toolName: 'ask',
              ...(api.conversationId === undefined ? {} : { conversationId: api.conversationId }),
              question: params.question,
              ...(params.detail === undefined ? {} : { detail: params.detail }),
              fields,
              createdAt: Date.now()
            }),
            context
          )

          if (context.abortSignal?.aborted) throw new Error(abortError)

          if (response.kind === 'cancel' && response.reason === 'unattended') {
            const result: ToolResult<AskToolDetails> = {
              content: [{ type: 'text', text: UNATTENDED_QUESTION_TEXT }],
              details: { type: 'ask', question: params.question, selections: [] }
            }
            return toExecutionResult(result, 'ask')
          }
          if (response.kind === 'cancel') throw new Error(abortError)
          if (response.kind === 'other') {
            const result: ToolResult<AskToolDetails> = {
              content: [
                {
                  type: 'text',
                  text: `User did not fill the form and responded with feedback instead:\n${response.text}`
                }
              ],
              details: {
                type: 'ask',
                question: params.question,
                selections: [],
                other: response.text
              }
            }
            return toExecutionResult(result, 'ask')
          }
          if (response.kind !== 'form') {
            const result: ToolResult<AskToolDetails> = {
              content: [{ type: 'text', text: 'User input error: unexpected response kind' }],
              details: { type: 'ask', question: params.question, selections: [] }
            }
            return toExecutionResult(result, 'ask')
          }

          const fieldRecords: AskFormFieldRecord[] = fields.map((field) => {
            const raw = response.values[field.key]
            const value = typeof raw === 'string' && raw.length > 0 ? raw : undefined
            return {
              key: field.key,
              label: field.label,
              type: field.type,
              ...(value === undefined ? {} : { value })
            }
          })
          const hasProvidedSecret = fieldRecords.some(
            (record) => record.type === 'secret' && record.value !== undefined
          )
          const lines: string[] = ['User submitted the requested form.']
          if (hasProvidedSecret) {
            lines.push(
              'Sensitive values are stored encrypted for this session — pass their placeholders verbatim to tools (bash, write, edit, etc.) and ShuviX will restore them locally before execution.'
            )
          }
          lines.push('')
          for (const record of fieldRecords) {
            lines.push(`- ${record.key}: ${record.value ?? '(not provided)'}`)
          }
          const result: ToolResult<AskToolDetails> = {
            content: [{ type: 'text', text: lines.join('\n') }],
            details: {
              type: 'ask',
              question: params.question,
              selections: [],
              fields: fieldRecords
            }
          }
          return toExecutionResult(result, 'ask')
        }

        const response = await awaitWithContext(
          requestUserInput({
            id: api.callId,
            kind: 'choice',
            toolName: 'ask',
            ...(api.conversationId === undefined ? {} : { conversationId: api.conversationId }),
            question: params.question,
            ...(params.detail === undefined ? {} : { detail: params.detail }),
            options: params.options!,
            createdAt: Date.now()
          }),
          context
        )

        if (context.abortSignal?.aborted) throw new Error(abortError)

        let text: string
        let selections: string[] = []
        // 父会话代答（docs/sub-session-design.md §19.5）：结果按答题方写 —— 转写不得把父会话的话记成用户说的
        // 有答题方就不是用户本人（宿主只在父会话代答时写它，挂起的询问不信载荷里的那一项）
        const answeredBy = response.answeredBy
        const byParent = answeredBy !== undefined
        if (response.kind === 'cancel' && response.reason === 'unattended') {
          // 没人在场：不算出错（定时运行的会话不该满屏红行），模型自己决定或把问题留在回复里
          text = UNATTENDED_QUESTION_TEXT
        } else if (response.kind === 'cancel') {
          throw new Error(abortError)
        } else if (response.kind === 'other') {
          text = byParent
            ? `${PARENT_ANSWERED} Instead of picking an option, it wrote:\n${response.text}`
            : `User did not select any option and responded with feedback instead:\n${response.text}`
        } else if (response.kind === 'choice') {
          selections = response.selections
          text = byParent
            ? selections.length === 0
              ? `${PARENT_ANSWERED} It made no selection.`
              : `${PARENT_ANSWERED} Selected: ${selections.join(', ')}`
            : selections.length === 0
              ? 'User made no selection'
              : `User selected: ${selections.join(', ')}`
          if (response.note) text += `\n${byParent ? 'It' : 'User'} also wrote:\n${response.note}`
        } else {
          text = 'User input error: unexpected response kind'
        }

        const written =
          response.kind === 'other'
            ? response.text
            : response.kind === 'choice'
              ? response.note
              : undefined
        const result: ToolResult<AskToolDetails> = {
          content: [{ type: 'text', text }],
          details: {
            type: 'ask',
            question: params.question,
            selections,
            ...(written === undefined ? {} : { other: written }),
            ...(byParent ? { answeredBy: { ...answeredBy } } : {})
          }
        }
        return toExecutionResult(result, 'ask')
      })
  }
}
