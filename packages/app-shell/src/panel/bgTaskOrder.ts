import type { TaskInfo } from '@shuvix/chat-protocol/types/task'
import { isTaskFinished } from '@shuvix/chat-ui'

/**
 * 后台任务面板的排序与「多久前结束」—— 纯函数，从面板里拆出来好单测。
 *
 * 一条规则：**每组最新的在最上面**。面板要回答的是「此刻在干什么、刚刚发生了什么」，
 * 按启动时间正序排时最新的永远沉在底下，任务一多就得滚到底才看得见；而且一条跑得久的任务
 * 刚结束，会按它的启动时间落到「已完成」的中间，正是用户最想看的那条最难找。
 *
 *  - **运行中**：等你回答的排最前（它不会自己好起来，是这张表里唯一需要用户动手的状态），
 *    其余按启动时间倒序；
 *  - **已完成**：按**结束**时间倒序 —— 刚落定的那条总在顶上。
 *
 * 两组都是「新来的插在顶上」，已有的行彼此不换位，看着的时候列表不会乱跳 —— 唯一的例外是
 * 一条任务开始 / 不再等你回答，它本就该挪到 / 挪出最前面。
 */

/** 已完成组默认只露最近这么多条，更早的折在「显示更早的 N 条」后面 */
export const FINISHED_PREVIEW = 5

export function orderTasks(
  tasks: readonly TaskInfo[],
  isBlocked: (task: TaskInfo) => boolean
): { running: TaskInfo[]; finished: TaskInfo[] } {
  const running = tasks
    .filter((task) => !isTaskFinished(task))
    .map((task) => ({ task, blocked: isBlocked(task) }))
    .sort((a, b) => Number(b.blocked) - Number(a.blocked) || b.task.startedAt - a.task.startedAt)
    .map(({ task }) => task)
  const finished = tasks
    .filter(isTaskFinished)
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0) || b.startedAt - a.startedAt)
  return { running, finished }
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * 已完成行上的「多久前结束」—— 和启动时长一起，让人分得清刚刚那条与半小时前那条。
 * 精度到分钟就够（面板对它半分钟走一次字）；时钟早于结束时间（结束发生在两次走字之间）按「刚刚」算。
 */
export function endedAgo(
  endedAt: number,
  now: number,
  t: (key: string, opts?: Record<string, unknown>) => string
): string {
  const diff = now - endedAt
  if (diff < MINUTE) return t('panel.tasksEndedJustNow')
  if (diff < HOUR) return t('panel.tasksEndedMinutesAgo', { count: Math.floor(diff / MINUTE) })
  if (diff < DAY) return t('panel.tasksEndedHoursAgo', { count: Math.floor(diff / HOUR) })
  return t('panel.tasksEndedDaysAgo', { count: Math.floor(diff / DAY) })
}
