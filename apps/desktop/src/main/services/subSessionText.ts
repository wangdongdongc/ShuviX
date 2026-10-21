/**
 * 被驱动的会话（子会话或别的会话）的询问在调用方眼里怎么写（docs/sub-session-design.md §19.4）—— `session` 工具的
 * 结果与运行器发给调用方的通知共用这一份。单独成一个没有依赖的小模块：工具层与运行器都 import 它，测试 mock 掉运行器也不连累排版。
 *
 * 文案是模型面向的英文（进上下文的字符串不随界面语言变）。问题与选项是子会话的模型写的，原样放进块里（围栏之内）。
 */
import type { InputRequest } from '@shuvix/chat-protocol/types/inputRequest'

/** 一条挂着的询问在父会话眼里的样子（§19.4） */
export type PendingAskInfo =
  | {
      /** 询问 id（= 那条会话里那次 ask 调用的 toolCallId），`answer-session` 的 `ask_id` */
      id: string
      kind: 'question'
      question: string
      options: Array<{ label: string; description: string }>
      /** 调用方能代答：这一轮是它发起的、绑定任务还活着（§19.2）。false = 只有用户能答 */
      answerable: boolean
    }
  | {
      id: string
      kind: 'approval'
      /** 人读摘要（工具名: 命令 / 路径），与 `blockedOn` 同一种写法 */
      summary: string
    }

/** 权限卡的人读摘要（工具名: 命令 / 路径）—— 与运行时 `pendingInputSummaries` 同一种写法 */
export function approvalSummary(request: InputRequest): string {
  const r = request as { kind: string; toolName: string; command?: string }
  return [r.toolName, r.command ?? r.kind].filter(Boolean).join(': ')
}

/** 属性值转义（标题、问题都是 LLM 写的：引号会撕破标签、换行会把一行变两行） */
export function attrValue(value: string): string {
  return value
    .replace(/[\r\n]+/g, ' ')
    .replace(/"/g, "'")
    .trim()
}

/**
 * 挂着的询问在父会话眼里的样子（§19.4）—— 工具结果与通知共用一份（工具层 import 它）。
 *
 * 选择题各一块 `<question>`：能代答的给出「怎么答、什么时候该答」，这一轮是用户自己发起的则写明只有用户能答。
 * 权限卡合成一块 `<blocked-on-user-approval>`（§17.3 的三件事：是什么、谁能解、该做什么）。问题与选项是子会话
 * 的模型写的，原样放在块里（围栏之内），不改写。
 */
export function renderPendingAsks(asks: readonly PendingAskInfo[] | undefined): string[] {
  const blocks: string[] = []
  const approvals: string[] = []
  for (const ask of asks ?? []) {
    if (ask.kind === 'approval') {
      approvals.push(ask.summary)
      continue
    }
    const options = ask.options.map((o, i) =>
      o.description ? `${i + 1}. ${o.label} — ${o.description}` : `${i + 1}. ${o.label}`
    )
    blocks.push(
      [
        ask.answerable
          ? `<question ask_id="${attrValue(ask.id)}">`
          : `<question ask_id="${attrValue(ask.id)}" for="user">`,
        ask.question,
        ...options,
        ask.answerable
          ? 'You may answer it for the user with action "answer-session": `selections` with the exact option labels (one or several), or `message` in your own words. Answer only when the answer follows from what the user already told you or from the task itself; when it is the user\'s own preference or goes beyond what you were asked to do, relay it to the user instead.'
          : 'It was asked in a turn the user started in that session, so only the user answers it — tell them, or leave it.',
        '</question>'
      ].join('\n')
    )
  }
  if (approvals.length > 0) blocks.push(blockedOnApproval(approvals))
  return blocks
}

/**
 * 卡在等批准的那一块。三件事缺一不可 —— 实测里少了它们，模型把这个状态读成
 * 「子代理自己爱提问」，反复改提示词说「不要提问、直接执行」，换了四条子会话都一样：
 *   1. **问的是什么**（否则父级连转告都做不到）；
 *   2. **只有用户能解**，父级答不了（否则它会一直想自己修）；
 *   3. **父级唯一有用的动作是转告用户**（否则它只剩重试和放弃两条路）。
 */
export function blockedOnApproval(asked?: readonly string[]): string {
  return [
    '<blocked-on-user-approval>',
    asked?.length ? asked.map((a) => `- ${a}`).join('\n') : '- (question text unavailable)',
    'This is an approval prompt shown to the USER inside that session. It stays there until',
    'the user answers it — you cannot answer it, and rewording the task will not clear it.',
    'Tell the user what is waiting for them, or stop that turn with "stop-session".',
    '</blocked-on-user-approval>'
  ].join('\n')
}
