/**
 * 设定目标的那条消息（docs/goal-mode-design.md §3）：用户在输入框写 `/goal <条件>`，宿主替他发出一条**人的**消息 ——
 * 正文就是条件原文，后面附一段系统写的说明。形状照触发事件（triggerEvent.ts）：模型文本 = 原文 + 这一段；显示侧车 =
 * 原文 + 一枚内联 Token，气泡上是一枚「目标」小胶囊。`displayText` 刻意是空串：复制、纯文本、回填输入框都只留原文。
 *
 * 原文是用户自己的话：转写摘要去掉系统写的 Token 之后，剩下的正是它 —— 自动审查据此把目标当成用户的意图，衡量续跑
 * 过程里的操作。说明是系统写的，不算用户说的（`isGoalSetToken` 进 `withoutSystemTokens`）。
 *
 * 只由宿主构造（goalService），前端从不构造它。本模块纯数据、不依赖 Node / Electron。
 */
import type { InlineToken } from './types/chatMessage'
import { makeTokenMarker } from './utils/inlineTokens'

/** Token 的 `type`；`id` 是目标 id */
export const GOAL_SET_TOKEN_TYPE = 'goal'

/** 显示侧车里这枚 Token 的 uid（一条消息只有一枚） */
export const GOAL_SET_UID = 'goal'

/**
 * 模型面向的说明（英文）：模型自己不知道的 ShuviX 事实 —— 之后每一轮由另一个检查员判断，自己说完成不算数。
 * 包在 `<goal-set>` 里（不是通知标签：整条消息以原文开头，不是通知形状，照旧是人的消息）。
 */
export const GOAL_SET_NOTE_TEXT =
  'The message above is a goal the user set for this session. Work until it is met. After each of your turns a separate checker reads what you did and decides whether the goal is met; your own statement that it is met is not evidence, so run the checks the goal calls for and show their results. If you need a decision only the user can make, ask.'

const SEPARATOR = '\n\n'

export interface GoalSetMessage {
  text: string
  display: { content: string; tokens: Record<string, InlineToken> }
}

function escapeAttr(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * `objective` 要是已经过脱敏的那份（调用方先换再拼）：显示侧车与模型文本同一份占位符。
 * payload 带开头的分隔：重新生成经 `resolveTokensForAgent` 把标记换回 payload，要与第一次发的全文逐字相同。
 */
export function goalSetMessage(input: { objective: string; goalId: string }): GoalSetMessage {
  const payload = `${SEPARATOR}<goal-set id="${escapeAttr(input.goalId)}">${GOAL_SET_NOTE_TEXT}</goal-set>`
  return {
    text: `${input.objective}${payload}`,
    display: {
      content: `${input.objective}${makeTokenMarker(GOAL_SET_UID)}`,
      tokens: {
        [GOAL_SET_UID]: {
          type: GOAL_SET_TOKEN_TYPE,
          id: input.goalId,
          displayText: '',
          payload,
          name: ''
        }
      }
    }
  }
}

/** 是不是设定目标的 Token（只看 type） */
export function isGoalSetToken(token: unknown): boolean {
  if (typeof token !== 'object' || token === null) return false
  return (token as { type?: unknown }).type === GOAL_SET_TOKEN_TYPE
}

const GOAL_SET_SUFFIX_RE = /\n\n<goal-set id="[^"]*">[\s\S]*?<\/goal-set>$/

/**
 * 模型文本末尾系统写的设定说明去掉（显示侧车没解析到时的兜底：压缩切点、别的分支）—— 剩下的才是用户写的原文。
 * 不带说明的原样交回。
 */
export function withoutGoalSetNote(text: string): string {
  return text.replace(GOAL_SET_SUFFIX_RE, '')
}
