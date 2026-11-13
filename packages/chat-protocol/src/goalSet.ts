/**
 * 设定目标的那条消息（docs/goal-mode-design.md §16）：用户在一条会话的输入框写 `/goal <条件>`，宿主把那条会话 fork
 * 一份，再替用户往 fork 里发出一条**人的**消息 —— 正文就是条件原文，后面附一段系统写的说明：从这条消息起，这条
 * 对话是目标的管理员，原会话接着干活。形状照触发事件（triggerEvent.ts）：模型文本 = 原文 + 这一段；显示侧车 =
 * 原文 + 一枚内联 Token，气泡上是一枚「目标」小胶囊。`displayText` 刻意是空串：复制、纯文本、回填输入框都只留原文。
 *
 * 原文是用户自己的话：转写摘要去掉系统写的 Token 之后，剩下的正是它。说明是系统写的，不算用户说的
 * （`isGoalSetToken` 进 `withoutSystemTokens`）。
 *
 * 只由宿主构造（goalService），前端从不构造它。本模块纯数据、不依赖 Node / Electron。
 */
import type { InlineToken } from './types/chatMessage'
import { makeTokenMarker } from './utils/inlineTokens'

/** Token 的 `type`；`id` 是目标 id */
export const GOAL_SET_TOKEN_TYPE = 'goal'

/** 显示侧车里这枚 Token 的 uid（一条消息只有一枚） */
export const GOAL_SET_UID = 'goal'

/** 干活的会话（管理员是从它 fork 出来的） */
export interface GoalWorkerRef {
  id: string
  title: string
}

/** 说明里写的会话标题：一行、不含引号与尖括号（标题是模型或用户写的，不能把说明的结构带歪）、封顶 */
function noteTitle(title: string): string {
  const flat = title
    .replace(/[\r\n"<>]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat
}

/**
 * 模型面向的说明（英文）：模型自己不知道的 ShuviX 事实 —— 这条对话是另一条会话的拷贝，那条会话（标题、id）接着干活，
 * 这里从此是管理员；怎么把任务交过去（`session` 工具的 `prompt-session`，发完就结束这一轮，对方跑完会被叫回来）；用户在
 * 这里说话。身份的切换要说透（fork 带着干活时的全部记忆，最容易顺手接着干）：管理员不碰具体工作 —— 不改文件、不跑命令、
 * 不自己去翻项目，验收只按原会话的汇报，汇报不够就向它要；唯一的例外是用户在这里新发的消息明确要它做的事
 * （2026-11-12 用户裁决）。验收条件写在回复里（用户看得见），只问用户自己才能定的事（至多三个、推荐项排第一）。
 * 包在 `<goal-set>` 里（不是通知标签：整条消息以原文开头，不是通知形状，照旧是人的消息）。
 */
export function goalManagerNote(worker: GoalWorkerRef): string {
  const title = noteTitle(worker.title)
  return [
    'The message above is a goal the user set. It gives you a new role for the rest of this conversation: you are the manager of this goal.',
    '',
    `This conversation is a copy of another session, made when the goal was set. Everything before the goal message happened in that session, not here. That session ("${title}", session id ${worker.id}) goes on and does all the work on the goal: it is the worker. You are no longer the agent that does the work, even though you remember doing it.`,
    '',
    'Your job:',
    '1. Find out what is open. Unless this conversation already shows how the part of the project the goal touches works today, first send the worker a look-only task: read what the goal touches and report how it behaves now and every choice the goal leaves open, without changing anything. Wait for that report.',
    '2. Decide what "done" means. Ask the user, with `ask`, what the user alone can decide (a business rule or threshold, what a vague word in the goal means, any choice that changes outputs or formats, defaults, flags, or whether old behaviour stays): at most three questions in all, one call each, your recommended option first. Do not settle such a point yourself; when the goal and the report leave no such point open, ask nothing. Then write the acceptance criteria in your reply: items that are each met or not, each with the evidence that shows it.',
    `3. Hand the work to the worker: \`session\` tool, action \`prompt-session\`, session_id ${worker.id}. Send the goal in the user's words, the acceptance criteria, the user's answers, and say what its report must show (the checks it ran and their output). Then end your turn: you are brought back when the worker's turn ends.`,
    '4. When the worker reports, hold the report to the criteria. An item is met only when the report shows its evidence; the worker saying it is done is not evidence. If something is missing or unproven, send the worker back and name exactly what is missing. If the worker asks a question, answer it when the goal, the criteria or this conversation settle it; otherwise ask the user and pass the answer on.',
    '5. When every item is met, tell the user so, item by item with its evidence. If the goal cannot be met, tell the user what blocks it.',
    '6. The user talks to you here. Report progress from what the worker has reported. When the user changes the goal, change the criteria and tell the worker.',
    '',
    "What you must not do: any of the work. Use no tool except `session` and `ask`: do not edit or create files, do not run commands, and do not read or search the project or its knowledge base, not even to check a result. You judge by the worker's reports, and when a report is not enough you ask the worker for more. The one exception is something the user asks you for in a new message here."
  ].join('\n')
}

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
export function goalSetMessage(input: {
  objective: string
  goalId: string
  worker: GoalWorkerRef
}): GoalSetMessage {
  const payload = `${SEPARATOR}<goal-set id="${escapeAttr(input.goalId)}">${goalManagerNote(input.worker)}</goal-set>`
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
