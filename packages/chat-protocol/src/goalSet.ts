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

/** 回复里点名验收规格文件的那一行的标签：`Acceptance spec: <路径>`（宿主据此认出文件，`lastAcceptanceSpecPath`） */
export const GOAL_SPEC_LINE_LABEL = 'Acceptance spec'

/**
 * 模型面向的说明（英文）：模型自己不知道的 ShuviX 事实 —— 之后每一轮由另一个检查员判断，按目标原文与验收规格文件判，
 * 自己说完成不算数；检查员看不到设定之前用户说过的话。另加实测管用的做法（S1，docs/goal-mode-design.md §14–§15）：
 * 第一轮先把目标整理成验收规格 —— 只问用户自己才能定的事（至多三个、推荐项排第一；改输出 / 格式、缺省、开关、旧行为
 * 留不留的都算用户的，不当假设定掉），仓库答得了的、可逆的缺省自己定；规格写成工作目录里的一个 md，回复里一行
 * `Acceptance spec: <路径>`（宿主据此记下路径）；目标本来就写明了终态和检查方式就不写。
 * 包在 `<goal-set>` 里（不是通知标签：整条消息以原文开头，不是通知形状，照旧是人的消息）。
 */
export const GOAL_SET_NOTE_TEXT = [
  'The message above is a goal the user set for this session. Work until it is met. After each of your turns a separate checker reads what you did and decides whether the goal is met. It holds the work to the goal sentence and to the acceptance spec file described below; your own statement that it is met is not evidence, so run the checks the goal calls for and show their results.',
  '',
  'In this first turn, before you do the work, shape the goal:',
  '1. Read what the goal touches: the relevant code, its tests, the README or AGENTS.md.',
  '2. If the goal sentence already states its end state and how to check it (a command and its expected result, a test that must pass, an output that must appear), write no spec and go straight to the work.',
  '3. Otherwise settle every open point. What the repository answers (current behaviour, formats, names, commands), look up. A reversible choice with a sensible default, decide yourself and note it as an assumption. What only the user can decide (a business rule or threshold, what a vague word in the goal means, and any choice that changes outputs or formats, defaults, flags, or whether old behaviour stays available), ask with `ask`: at most three questions, one call each, short options with your recommended one first. Do not settle these as assumptions: the user will not read the spec before the work starts.',
  '4. Write a short acceptance spec as one Markdown file in the working directory, where it fits the project and under a name of your choosing: what "done" means as items that are each met or not, each with how to check it; the user\'s answers; your assumptions; what must not change. Carry into it anything the user said earlier in this session that bears on the goal: the checker does not see it.',
  `5. State the file's path in your reply on a line of its own, exactly: ${GOAL_SPEC_LINE_LABEL}: <path>`,
  '',
  'Then do the work. Later, if you need a decision only the user can make, ask.'
].join('\n')

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

/**
 * 一行 `Acceptance spec: <路径>`：行首可有列表 / 引用记号，标签与路径可带 Markdown 强调或反引号（模型常这么写），
 * 冒号在强调里外都行。第 1 组是标签前的包裹（整行包起来时，它的另一半在行尾），第 2 组是标签之后的整段
 * （`specPathValue` 再剥包裹）。
 */
export const GOAL_SPEC_LINE_RE =
  /^\s*(?:(?:[-*+>]|\d+[.)])\s+)*([`*_]*)\s*Acceptance spec\s*[`*_]*\s*:\s*(?:[`*_]+(?=\s))?\s*(.+?)\s*$/i

/** 成对的包裹（剥掉之后才是路径） */
const SPEC_WRAPPERS: ReadonlyArray<readonly [string, string]> = [
  ['**', '**'],
  ['__', '__'],
  ['`', '`'],
  ['*', '*'],
  ['_', '_'],
  ['<', '>'],
  ['"', '"'],
  ["'", "'"]
]

/** Markdown 链接 `[文字](目标)`：取目标 */
const SPEC_LINK_RE = /^\[[^\]]*\]\(\s*<?([^)>]+?)>?\s*\)$/

/** 标签之后那一段 → 路径：剥掉句末标点、成对的包裹，Markdown 链接取目标（反复，直到不再变）；`file://` 去掉 */
function specPathValue(raw: string): string | undefined {
  let value = raw.trim()
  for (;;) {
    const before = value
    value = value.replace(/[.,;]+$/, '').trim()
    const link = SPEC_LINK_RE.exec(value)
    if (link !== null) {
      value = link[1]!.trim()
      continue
    }
    for (const [open, close] of SPEC_WRAPPERS) {
      if (
        value.length >= open.length + close.length &&
        value.startsWith(open) &&
        value.endsWith(close)
      ) {
        value = value.slice(open.length, value.length - close.length).trim()
        break
      }
    }
    if (value === before) break
  }
  if (/^file:\/\//i.test(value)) {
    try {
      value = decodeURI(value.slice('file://'.length))
    } catch {
      return undefined
    }
  }
  return value === '' ? undefined : value
}

/**
 * 一段助手正文里**最后**一行 `Acceptance spec: <路径>` 点名的路径（原样：绝对或相对，由调用方按工作目录解析、核对文件在不在）；
 * 没有这样的行 → undefined。宿主在目标的根运行结束时拿它认出验收规格文件（goalService）。
 */
export function lastAcceptanceSpecPath(text: string): string | undefined {
  const lines = text.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = GOAL_SPEC_LINE_RE.exec(lines[i]!)
    if (match === null) continue
    let path = specPathValue(match[2]!)
    // 整行包起来（`` `Acceptance spec: a.md` ``、`**Acceptance spec: a.md**`）：行尾落单的那一半剥掉
    const closing = [...match[1]!].reverse().join('')
    if (path !== undefined && closing !== '' && path.endsWith(closing)) {
      path = specPathValue(path.slice(0, path.length - closing.length))
    }
    if (path !== undefined) return path
  }
  return undefined
}
