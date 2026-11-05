/**
 * 被驱动的会话（子会话或别的会话）的询问在调用方眼里怎么写（docs/sub-session-design.md §19.4）—— `session` 工具的
 * 结果与运行器发给调用方的通知共用这一份。单独成一个没有依赖的小模块：工具层与运行器都 import 它，测试 mock 掉运行器也不连累排版。
 *
 * 文案是模型面向的英文（进上下文的字符串不随界面语言变）。问题与选项是子会话的模型写的，原样放进块里（围栏之内）。
 */
import type { InputRequest } from '@shuvix/chat-protocol/types/inputRequest'
import type { TaskInfo } from '@shuvix/chat-protocol/types/task'

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

/**
 * 那条会话一轮结束之后还在跑的后台任务在调用方眼里的样子。
 *
 * 只有描述，**不带命令**：调用方要知道的是「那边还开着什么」，命令行又长、又是最常写着真实凭据的地方。描述同样
 * 是占位符还原之后的参数（已知的边角：模型把占位符写进描述才会碰上），之后还要过调用方这一侧的脱敏。
 * pid 留给调用方转告（停它的是那条会话自己，`shuvix task stop` 只认本会话的任务）。
 */
export interface BackgroundTaskInfo {
  kind: 'command' | 'agent' | 'session'
  /** 面板行标题（LLM 写的，单行、截断） */
  description: string
  /** 本机命令的 pid */
  pid?: number
  /** 远端命令没有本机 pid，停它走任务 id */
  taskId?: string
  /** 远端命令跑在哪台机器上（ssh host 别名） */
  host?: string
}

/** 描述的上限（码点）：一行够认出是哪件事，多了只是每一步重发的上下文 */
const BACKGROUND_TASK_DESCRIPTION_MAX = 120

/**
 * 描述写进通知要守住的形状：一行，且不含尖括号。描述是模型写的，而通知在 steer 路径上只靠正文形状被认出来
 * （`isSystemNoticeText`）：一个 `</session>` 就会让整条通知被画成用户说的话，`</running-background-tasks>`
 * 则会把后半截描述放到围栏之外。
 */
function taskDescription(title: string): string {
  const line = attrValue(title.replace(/[\s\u0085]+/g, ' '))
    .replace(/</g, '‹')
    .replace(/>/g, '›')
  return [...line].slice(0, BACKGROUND_TASK_DESCRIPTION_MAX).join('').trimEnd()
}

/** 列出的条数上限：其余的只报个数 */
const BACKGROUND_TASKS_SHOWN = 8

/**
 * 从任务枢纽的快照里挑出「那条会话的后台任务」：还没结束，且发起它的调用已不在等（`detached`）。前台命令属于
 * 正在跑的这一轮，不是后台任务；hook 起的 agent（没有 `parentToolCallId`：自动起标题、自动审查）不是会话的工作。
 */
export function backgroundTasksOf(tasks: readonly TaskInfo[]): BackgroundTaskInfo[] {
  const out: BackgroundTaskInfo[] = []
  for (const task of tasks) {
    if (task.endedAt !== null || !task.detached) continue
    const { subject } = task
    if (subject.kind === 'agent' && subject.parentToolCallId === undefined) continue
    const description = taskDescription(task.title)
    if (subject.kind === 'bash') {
      out.push({
        kind: 'command',
        description,
        ...(subject.pid > 0 ? { pid: subject.pid } : { taskId: task.taskId }),
        ...(subject.host ? { host: subject.host } : {})
      })
    } else {
      out.push({ kind: subject.kind === 'agent' ? 'agent' : 'session', description })
    }
  }
  return out
}

function backgroundTaskLine(task: BackgroundTaskInfo): string {
  const label = task.kind === 'session' ? 'turn in another session' : task.kind
  const where = task.host ? ` on host ${attrValue(task.host)}` : ''
  const id =
    task.pid !== undefined
      ? ` (pid ${task.pid})`
      : task.taskId !== undefined
        ? ` (task id ${attrValue(task.taskId)})`
        : ''
  return `- ${label}${where}${id}: ${task.description}`
}

/**
 * 那一块（完成通知与 `session` 工具的结果共用）。一条都没有 → 什么都不写。
 *
 * 要说清三件事：一轮结束不等于那边什么都停了；这些任务归那条会话，调用方自己停不了（`stop-session` 只停一轮）；
 * 该怎么办。否则子会话留着 dev 服务器给用户看，父会话只读到「跑完了」，既不会告诉用户，也不知道那边还占着端口。
 */
export function renderBackgroundTasks(tasks: readonly BackgroundTaskInfo[] | undefined): string[] {
  if (!tasks?.length) return []
  const hidden = tasks.length - BACKGROUND_TASKS_SHOWN
  return [
    [
      '<running-background-tasks>',
      'Still running in that session:',
      ...tasks.slice(0, BACKGROUND_TASKS_SHOWN).map(backgroundTaskLine),
      ...(hidden > 0 ? [`- and ${hidden} more`] : []),
      'They belong to that session and keep running after its turn ends. Mention them to the user if they matter to them. To stop one, ask that session with "prompt-session"; "stop-session" only stops a turn.',
      '</running-background-tasks>'
    ].join('\n')
  ]
}
