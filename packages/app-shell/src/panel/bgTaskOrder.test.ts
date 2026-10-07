// @vitest-environment jsdom
/**
 * 后台任务面板的排序与「多久前结束」—— `bgTaskOrder.ts` 的纯函数。
 *
 *   O-*  orderTasks：按 endedAt 分组（不看 status）；运行中 = 等你回答的在前、其余启动时间倒序；
 *        已完成 = 结束时间倒序、平手看启动时间倒序、全平手保持输入顺序；isBlocked 只问运行中的；不改输入
 *   E-*  endedAgo：分钟 / 小时 / 天的边界，时钟早于结束时间按「刚刚」；真 en 文案
 *
 * jsdom + mermaid 桩：`bgTaskOrder.ts` 从 `@shuvix/chat-ui` 的桶里拿 `isTaskFinished`，桶在 node 环境里装不起来。
 */
import { beforeAll, describe, expect, it, vi } from 'vitest'
import i18n from 'i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import type { TaskInfo, TaskStatus } from '@shuvix/chat-protocol/types/task'

vi.mock('mermaid', () => ({ default: { initialize: () => {}, render: () => {} } }))

import { FINISHED_PREVIEW, endedAgo, orderTasks } from './bgTaskOrder'

function task(
  taskId: string,
  startedAt: number,
  endedAt: number | null,
  status: TaskStatus = endedAt === null ? 'running' : 'done'
): TaskInfo {
  return {
    taskId,
    kind: 'bash',
    sessionId: 's1',
    title: taskId,
    status,
    detached: true,
    startedAt,
    endedAt,
    subject: {
      kind: 'bash',
      command: 'true',
      cwd: '/',
      pid: 1,
      logPath: '/log',
      exitCode: null,
      signal: null,
      logCapped: false
    }
  }
}

const idsOf = (list: TaskInfo[]): string[] => list.map((x) => x.taskId)
const never = (): boolean => false

describe('orderTasks', () => {
  it('O-1 empty input → two empty groups', () => {
    expect(orderTasks([], never)).toEqual({ running: [], finished: [] })
  })

  it('O-2 groups by endedAt, not by status', () => {
    const { running, finished } = orderTasks(
      [
        task('a', 1, null, 'running'),
        task('b', 2, 5, 'done'),
        task('c', 3, null, 'waiting-input'),
        task('d', 4, 7, 'running')
      ],
      never
    )
    expect(idsOf(running).sort()).toEqual(['a', 'c'])
    expect(idsOf(finished).sort()).toEqual(['b', 'd'])
  })

  it('O-3 running: newest start first', () => {
    const { running } = orderTasks(
      [task('t10', 10, null), task('t30', 30, null), task('t20', 20, null)],
      never
    )
    expect(idsOf(running)).toEqual(['t30', 't20', 't10'])
  })

  it('O-4 blocked first, newest first among them', () => {
    const blocked = new Set(['a', 'c'])
    const { running } = orderTasks(
      [task('a', 10, null), task('b', 30, null), task('c', 20, null)],
      (x) => blocked.has(x.taskId)
    )
    expect(idsOf(running)).toEqual(['c', 'a', 'b'])
  })

  it('O-5 finished: most recently ended first, whatever the start time', () => {
    const { finished } = orderTasks(
      [task('L', 1, 100), task('S1', 50, 60), task('S2', 70, 80)],
      never
    )
    expect(idsOf(finished)).toEqual(['L', 'S2', 'S1'])
  })

  it('O-6 equal endedAt → newest start first', () => {
    const { finished } = orderTasks([task('x', 10, 100), task('y', 40, 100)], never)
    expect(idsOf(finished)).toEqual(['y', 'x'])
  })

  it('O-7 a full tie keeps the input order, in both groups', () => {
    const { running, finished } = orderTasks(
      [
        task('r1', 5, null),
        task('f1', 1, 9),
        task('r2', 5, null),
        task('f2', 1, 9),
        task('r3', 5, null),
        task('f3', 1, 9)
      ],
      never
    )
    expect(idsOf(running)).toEqual(['r1', 'r2', 'r3'])
    expect(idsOf(finished)).toEqual(['f1', 'f2', 'f3'])

    const reversed = orderTasks(
      [task('f3', 1, 9), task('r3', 5, null), task('f2', 1, 9), task('r2', 5, null)],
      never
    )
    expect(idsOf(reversed.running)).toEqual(['r3', 'r2'])
    expect(idsOf(reversed.finished)).toEqual(['f3', 'f2'])
  })

  it('O-8 isBlocked has no say over finished tasks and is never asked about them', () => {
    const spy = vi.fn((_task: TaskInfo) => true)
    const input = [task('old', 1, 50), task('r', 2, null), task('new', 3, 90), task('mid', 4, 70)]
    const { finished } = orderTasks(input, spy)
    expect(idsOf(finished)).toEqual(['new', 'mid', 'old'])
    expect(spy).toHaveBeenCalled()
    for (const [arg] of spy.mock.calls) expect(arg.endedAt).toBeNull()
    expect(spy.mock.calls.map(([arg]) => arg.taskId)).toEqual(['r'])
  })

  it('O-9 does not mutate its input and returns fresh arrays', () => {
    const input = [task('a', 10, null), task('b', 30, 40), task('c', 20, null), task('d', 5, 90)]
    const snapshot = [...input]
    const frozen = JSON.stringify(input)
    const { running, finished } = orderTasks(input, never)
    expect(input).toEqual(snapshot)
    input.forEach((x, i) => expect(x).toBe(snapshot[i]))
    expect(JSON.stringify(input)).toBe(frozen)
    expect(running).not.toBe(input)
    expect(finished).not.toBe(input)
  })

  it('O-10 the finished preview is 5 rows', () => {
    expect(FINISHED_PREVIEW).toBe(5)
  })
})

describe('endedAgo', () => {
  const t = (key: string, opts?: Record<string, unknown>): string =>
    opts ? `${key}:${String(opts.count)}` : key
  const NOW = 1_000_000_000_000
  const ago = (diff: number): string => endedAgo(NOW - diff, NOW, t)

  it('E-1 zero → just now, without options', () => {
    const spy = vi.fn(t)
    expect(endedAgo(NOW, NOW, spy)).toBe('panel.tasksEndedJustNow')
    expect(spy).toHaveBeenCalledWith('panel.tasksEndedJustNow')
    expect(spy.mock.calls[0]).toHaveLength(1)
  })

  it('E-2 a clock behind the end time → just now', () => {
    expect(ago(-1)).toBe('panel.tasksEndedJustNow')
    expect(ago(-5 * 60_000)).toBe('panel.tasksEndedJustNow')
  })

  it('E-3 minute boundaries', () => {
    expect(ago(59_999)).toBe('panel.tasksEndedJustNow')
    expect(ago(60_000)).toBe('panel.tasksEndedMinutesAgo:1')
    expect(ago(119_999)).toBe('panel.tasksEndedMinutesAgo:1')
    expect(ago(120_000)).toBe('panel.tasksEndedMinutesAgo:2')
  })

  it('E-4 hour boundaries', () => {
    expect(ago(3_599_999)).toBe('panel.tasksEndedMinutesAgo:59')
    expect(ago(3_600_000)).toBe('panel.tasksEndedHoursAgo:1')
    expect(ago(7_199_999)).toBe('panel.tasksEndedHoursAgo:1')
  })

  it('E-5 day boundaries', () => {
    expect(ago(86_399_999)).toBe('panel.tasksEndedHoursAgo:23')
    expect(ago(86_400_000)).toBe('panel.tasksEndedDaysAgo:1')
    expect(ago(10 * 86_400_000 + 3_600_000)).toBe('panel.tasksEndedDaysAgo:10')
  })

  describe('E-6 with the real en strings', () => {
    beforeAll(async () => {
      await i18n.init({ lng: 'en', resources: { en: { translation: en } } })
    })
    const real = (diff: number): string =>
      endedAgo(NOW - diff, NOW, (key, opts) => i18n.t(key, opts) as string)

    it('reads naturally', () => {
      expect(real(0)).toBe('Just ended')
      expect(real(60_000)).toBe('Ended 1m ago')
      expect(real(5 * 3_600_000)).toBe('Ended 5h ago')
      expect(real(2 * 86_400_000)).toBe('Ended 2d ago')
    })
  })
})
