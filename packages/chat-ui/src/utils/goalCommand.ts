/**
 * 输入框的内置命令 `/goal`（目标，docs/goal-mode-design.md §16）—— 纯逻辑，InputArea 用。
 *
 * `/goal` 不是项目命令也不是技能：它不展开成 cmd Token、不当消息发，而是交给宿主（`agent.goalStart`）—— 宿主把这条
 * 会话 fork 一份作目标的管理员，替用户把那条带「目标」Token 的消息发进管理员会话。所以它只在输入框里合进命令表
 * （`kind: 'builtin'`），从不写进 `chatStore.slashCommands`，别的入口（子代理追问框）看不到它。
 *
 * 只在宿主有 `goalStart`、且这条会话的形态能设目标时出现（`goalEligibleSession`）；能不能设以主进程为准
 * （goalService.eligible），这里只是不把注定被拒的入口摆出来。
 */
import { chromeTabOf } from '@shuvix/chat-protocol/chromeTabSession'

/** 命令名（输入框里写 `/goal`） */
export const GOAL_COMMAND_ID = 'goal'

/**
 * 内置命令合进命令表：排第一；同名的项目命令 / 技能让位（内置命令优先 —— 否则同一个 `/goal` 在弹层里出现两行、
 * 回车选中的是哪一个取决于排序）
 */
export function withGoalCommand<C extends { commandId: string }>(
  commands: C[],
  goal: C | null
): C[] {
  if (!goal) return commands
  return [goal, ...commands.filter((c) => c.commandId !== goal.commandId)]
}

/**
 * 输入框里此刻是不是一条 `/goal`：芯片态（芯片是内置的 goal，`text` 是芯片后面的参数），或直输态（整段是 `/goal`
 * 或 `/goal 条件`，回退草稿、放回输入框时会是这样）。是 → 条件原文（去掉首尾空白，可能是空串 = 只写了 `/goal`）；
 * 不是 → null。`/goals`、`/goal-x` 不算。调用方先确认内置命令可用。
 */
export function goalCommandArgs(input: {
  chip: { commandId: string; kind?: string } | null
  text: string
}): string | null {
  if (input.chip) {
    return input.chip.kind === 'builtin' && input.chip.commandId === GOAL_COMMAND_ID
      ? input.text.trim()
      : null
  }
  const match = /^\/goal(?:\s+([\s\S]*))?$/.exec(input.text.trim())
  return match ? (match[1] ?? '').trim() : null
}

/** 判定所需的会话行字段（store 的 Session 与 chat-protocol 的 Session 都满足） */
export interface GoalSessionShape {
  parentId?: string | null
  settings?: {
    bot?: string
    notebookPath?: string
    chromeTab?: unknown
    goalManagerOf?: string
  } | null
}

/**
 * 这条会话的形态能不能设目标（裁决 D9：人发起的根会话；子会话、bot 会话、笔记本、Chrome 标签页都不行；目标的管理员
 * 自己也不行 —— 要改目标，直接跟它说）。找不到会话行（还没拉到列表）按能处理 —— 设不了时宿主会回一句说明
 */
export function goalEligibleSession(row: GoalSessionShape | undefined): boolean {
  if (!row) return true
  if (row.parentId) return false
  const settings = row.settings ?? {}
  return (
    !settings.bot && !settings.notebookPath && !chromeTabOf(settings) && !settings.goalManagerOf
  )
}
