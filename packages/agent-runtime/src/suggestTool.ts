/**
 * suggest 工具（宿主无关）—— pi-durable 原生注册项（2026-10-25，设计稿 docs/suggest-tool-design.md）。
 *
 * agent 给用户留至多三条提议，**立刻返回**、不等回答：卡片由 chat-ui 按这次调用的参数画出来，用户点「采纳」时宿主把
 * 那条的 `message` 作为用户的回复发进这条会话（会话在跑就是 steer）。这一版只有「回复」一种动作，状态不另存
 * （开着 / 采纳 / 关闭都从会话本身读出，见 chat-protocol `suggestions.ts`）。
 *
 * 这里只做两件事：校验参数（条数、长度 —— 超了抛错，模型看到的就是错误，改短了再调；不留半截卡片），
 * 交回一段告诉模型「已经摆出来了、别等、别在正文里再列一遍」的结果。`replay: 'safe'`：摆一次卡片不改任何东西。
 */
import { Type } from 'typebox'
import type { ToolRegistration } from '@earendil-works/pi-durable'
import { SUGGEST_LIMITS, SUGGEST_TOOL_NAME } from '@shuvix/chat-protocol/suggestions'
import { catchToolErrors, toExecutionResult } from './tools/toolResult'
import { backstopOutputLimits } from './tools/outputLimits'

export const SuggestParamsSchema = Type.Object({
  suggestions: Type.Array(
    Type.Object({
      title: Type.String({
        description: `What the suggestion is, in a few words (the card's headline, at most ${SUGGEST_LIMITS.title} characters)`
      }),
      message: Type.String({
        description: `What the user sends you when they accept it, written in their voice, as they would say it (at most ${SUGGEST_LIMITS.message} characters). Shown on the card in full`
      }),
      detail: Type.Optional(
        Type.String({
          description: `Why, in a sentence or two (at most ${SUGGEST_LIMITS.detail} characters)`
        })
      )
    }),
    {
      description: `The suggestions, most useful first (1 to ${SUGGEST_LIMITS.maxItems})`,
      minItems: 1,
      maxItems: SUGGEST_LIMITS.maxItems
    }
  )
})

export const SUGGEST_DESCRIPTION =
  `Leave the user up to ${SUGGEST_LIMITS.maxItems} suggestions they can accept with one click, or ignore. It does not wait: it returns at once and you carry on. ` +
  "Accepting one sends its `message` to you as the user's reply in this conversation; if you are still working at that moment, it reaches you as a steer. " +
  "Use it for a next step that is the user's call: something you could do but should not do unasked. " +
  'Do not use it for a decision you need before you can go on (use ask), and do not suggest what the request already covers — just do that. ' +
  'Write `message` as what the user would say to accept it (for example "Yes, also add tests for the parser"). ' +
  'The suggestions stop working once the user sends anything else. Do not list them again in your reply.'

/** suggest 工具：durable 注册项 + 界面显示名 */
export type SuggestTool = ToolRegistration<typeof SuggestParamsSchema> & {
  readonly label: string
  readonly replay: 'safe'
}

/** 一条提议的字段过长 / 为空时的错误（抛给模型，它改了再调） */
function check(value: unknown, field: string, index: number, max: number): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`suggestions[${index}].${field} must be a non-empty string`)
  }
  if (value.length > max) {
    throw new Error(
      `suggestions[${index}].${field} is ${value.length} characters; keep it to at most ${max}`
    )
  }
  return value
}

export function createSuggestTool({ label = 'Suggest' }: { label?: string } = {}): SuggestTool {
  return {
    name: SUGGEST_TOOL_NAME,
    label,
    description: SUGGEST_DESCRIPTION,
    parameters: SuggestParamsSchema,
    replay: 'safe',
    outputLimits: backstopOutputLimits({}),
    execute: (params, _api, context) =>
      catchToolErrors(context, async () => {
        const list: unknown = params.suggestions
        if (!Array.isArray(list) || list.length === 0) {
          throw new Error('suggestions must list at least one suggestion')
        }
        if (list.length > SUGGEST_LIMITS.maxItems) {
          throw new Error(
            `${list.length} suggestions is too many; leave at most ${SUGGEST_LIMITS.maxItems}`
          )
        }
        const titles = list.map((item: unknown, i) => {
          const o = (typeof item === 'object' && item !== null ? item : {}) as Record<
            string,
            unknown
          >
          check(o.message, 'message', i, SUGGEST_LIMITS.message)
          if (o.detail !== undefined) check(o.detail, 'detail', i, SUGGEST_LIMITS.detail)
          return check(o.title, 'title', i, SUGGEST_LIMITS.title)
        })
        const shown = titles.map((title, i) => `${i + 1}. ${title}`).join('\n')
        const text =
          `Shown ${titles.length} suggestion${titles.length === 1 ? '' : 's'} to the user:\n${shown}\n` +
          'If the user accepts one, its message reaches you as their reply. They may also write something else or ignore them. ' +
          'Do not wait for an answer, and do not list them again in your reply.'
        return toExecutionResult(
          { content: [{ type: 'text', text }], details: undefined },
          SUGGEST_TOOL_NAME
        )
      })
  }
}
