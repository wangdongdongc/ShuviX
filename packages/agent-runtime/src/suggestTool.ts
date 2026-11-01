/**
 * suggest 工具（宿主无关）—— pi-durable 原生注册项（2026-10-25，设计稿 docs/suggest-tool-design.md）。
 *
 * agent 给用户留至多三条提议，**立刻返回**、不等回答：卡片由 chat-ui 按这次调用的参数画出来，用户点「采纳」时宿主把
 * 那条的 `message` 作为用户的回复发进这条会话（会话在跑就是 steer）。这一版只有「回复」一种动作，状态不另存
 * （开着 / 采纳 / 关闭都从会话本身读出，见 chat-protocol `suggestions.ts`）。
 *
 * 这里只做两件事：校验参数（条数、长度 —— 超了抛错，模型看到的就是错误，改短了再调；不留半截卡片），
 * 交回一段告诉模型「已经摆出来了、别等、别在正文里再列一遍」的结果。`replay: 'safe'`：摆一次卡片不改任何东西。
 *
 * 每条提议可以带一张图（2026-11-01，docs/show-image-design.md §6）：宿主注入 `presentImages` 时参数里才有 `image`
 * （提示词不指向用不了的东西）。图由宿主快照进会话目录，快照记在结果的 `details`（`SuggestToolDetails`，下标同参数）；
 * 图有问题就整次失败，与「不留半截卡片」一致。快照不过权限判断，所以照样立刻返回。
 */
import { Type } from 'typebox'
import type { ToolRegistration } from '@earendil-works/pi-durable'
import { SUGGEST_LIMITS, SUGGEST_TOOL_NAME } from '@shuvix/chat-protocol/suggestions'
import { SHOWN_IMAGE_FORMAT_NAMES } from '@shuvix/chat-protocol/shownImages'
import type { ShownImage, SuggestToolDetails } from '@shuvix/chat-protocol/types/chatMessage'
import { catchToolErrors, toExecutionResult } from './tools/toolResult'
import { backstopOutputLimits } from './tools/outputLimits'

const SUGGESTION_FIELDS = {
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
}

const LIST_OPTIONS = {
  description: `The suggestions, most useful first (1 to ${SUGGEST_LIMITS.maxItems})`,
  minItems: 1,
  maxItems: SUGGEST_LIMITS.maxItems
}

export const SuggestParamsSchema = Type.Object({
  suggestions: Type.Array(Type.Object(SUGGESTION_FIELDS), LIST_OPTIONS)
})

/** 宿主能摆图时的参数：每条多一个可选的 `image` */
export const SuggestParamsWithImagesSchema = Type.Object({
  suggestions: Type.Array(
    Type.Object({
      ...SUGGESTION_FIELDS,
      image: Type.Optional(
        Type.String({
          description: `A picture of what this suggestion leads to, when one helps the user choose (for example a mockup of each layout option): the path of a ${SHOWN_IMAGE_FORMAT_NAMES} file on this machine. Shown on the card; it is not sent to you when the user accepts`
        })
      )
    }),
    LIST_OPTIONS
  )
})

export const SUGGEST_DESCRIPTION =
  `Leave the user up to ${SUGGEST_LIMITS.maxItems} suggestions they can accept with one click, or ignore. It does not wait: it returns at once and you carry on. ` +
  "Accepting one sends its `message` to you as the user's reply in this conversation; if you are still working at that moment, it reaches you as a steer. " +
  "Use it for a next step that is the user's call: something you could do but should not do unasked. " +
  'Do not use it for a decision you need before you can go on (use ask), and do not suggest what the request already covers — just do that. ' +
  'Write `message` as what the user would say to accept it (for example "Yes, also add tests for the parser"). ' +
  'The suggestions stop working once the user sends anything else. Do not list them again in your reply.'

/** 宿主能摆图时的描述：多一句什么时候带图 */
export const SUGGEST_DESCRIPTION_WITH_IMAGES =
  SUGGEST_DESCRIPTION +
  ' A suggestion can carry an `image` when a picture helps the user choose between them, such as a mockup of each option.'

/** 宿主的摆图入口：路径 + 出错时给模型看的位置 → 与请求同序的快照；任何一张有问题就抛（消息给模型读） */
export type SuggestImagePresenter = (
  requests: ReadonlyArray<{ path: string; label: string }>
) => Promise<ShownImage[]>

export interface CreateSuggestToolOptions {
  label?: string
  /** 给了 → 每条提议可以带图（参数与描述随之多出 `image`）；不给 → 与从前一样 */
  presentImages?: SuggestImagePresenter
}

/** suggest 工具：durable 注册项 + 界面显示名 */
export type SuggestTool = ToolRegistration<
  typeof SuggestParamsSchema | typeof SuggestParamsWithImagesSchema
> & {
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

export function createSuggestTool({
  label = 'Suggest',
  presentImages
}: CreateSuggestToolOptions = {}): SuggestTool {
  return {
    name: SUGGEST_TOOL_NAME,
    label,
    description: presentImages ? SUGGEST_DESCRIPTION_WITH_IMAGES : SUGGEST_DESCRIPTION,
    parameters: presentImages ? SuggestParamsWithImagesSchema : SuggestParamsSchema,
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
        const imageRequests: Array<{ index: number; path: string; label: string }> = []
        const titles = list.map((item: unknown, i) => {
          const o = (typeof item === 'object' && item !== null ? item : {}) as Record<
            string,
            unknown
          >
          check(o.message, 'message', i, SUGGEST_LIMITS.message)
          if (o.detail !== undefined) check(o.detail, 'detail', i, SUGGEST_LIMITS.detail)
          // 宿主不能摆图时参数里没有 image：模型硬塞的就当没有
          if (presentImages && o.image !== undefined) {
            if (typeof o.image !== 'string' || o.image.trim() === '') {
              throw new Error(`suggestions[${i}].image must be a non-empty string (a file path)`)
            }
            imageRequests.push({ index: i, path: o.image.trim(), label: `suggestions[${i}].image` })
          }
          return check(o.title, 'title', i, SUGGEST_LIMITS.title)
        })
        let details: SuggestToolDetails | undefined
        if (presentImages && imageRequests.length > 0) {
          const shownImages = await presentImages(
            imageRequests.map(({ path, label }) => ({ path, label }))
          )
          const images: Array<ShownImage | null> = titles.map(() => null)
          imageRequests.forEach((request, k) => {
            images[request.index] = shownImages[k] ?? null
          })
          details = { type: 'suggest', images }
        }
        const shown = titles
          .map((title, i) => `${i + 1}. ${title}${details?.images[i] ? ' (with image)' : ''}`)
          .join('\n')
        const text =
          `Shown ${titles.length} suggestion${titles.length === 1 ? '' : 's'} to the user:\n${shown}\n` +
          'If the user accepts one, its message reaches you as their reply. They may also write something else or ignore them. ' +
          'Do not wait for an answer, and do not list them again in your reply.'
        return toExecutionResult({ content: [{ type: 'text', text }], details }, SUGGEST_TOOL_NAME)
      })
  }
}
