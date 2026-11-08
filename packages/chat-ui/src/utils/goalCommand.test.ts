/**
 * 输入框的内置命令 `/goal`（goalCommand.ts）—— 纯逻辑。
 *
 *   GC-1 芯片态：内置 goal 芯片 → 参数原文（去首尾空白，多行保留）；空参数 → ''；别的芯片（同名的项目命令也算）→ null
 *   GC-2 直输态：`/goal` / `/goal 条件` / 前后空白 / 换行分隔 → 条件；`/goals`、`/goal-x`、`x /goal`、普通文字 → null
 *   GC-3 合进命令表：排第一；同名的项目命令 / 技能让位；不可用（null）→ 原表原样（同一个引用）
 *   GC-4 会话形态：根会话能设；子会话、bot、笔记本、Chrome 标签页不能；找不到会话行按能处理
 */
import { describe, expect, it } from 'vitest'
import {
  GOAL_COMMAND_ID,
  goalCommandArgs,
  goalEligibleSession,
  withGoalCommand
} from './goalCommand'

const goalChip = { commandId: GOAL_COMMAND_ID, kind: 'builtin' }

describe('goalCommandArgs', () => {
  it('GC-1 芯片态', () => {
    expect(goalCommandArgs({ chip: goalChip, text: '  all tests pass  ' })).toBe('all tests pass')
    expect(goalCommandArgs({ chip: goalChip, text: 'line 1\nline 2\n' })).toBe('line 1\nline 2')
    expect(goalCommandArgs({ chip: goalChip, text: '   ' })).toBe('')
    expect(goalCommandArgs({ chip: { commandId: 'goal', kind: 'project' }, text: 'x' })).toBeNull()
    expect(goalCommandArgs({ chip: { commandId: 'review', kind: 'skill' }, text: 'x' })).toBeNull()
    // 芯片在时不再看文字本身：参数里写 /goal 也只是参数
    expect(goalCommandArgs({ chip: { commandId: 'cmd' }, text: '/goal x' })).toBeNull()
  })

  it.each([
    ['/goal', ''],
    ['/goal   ', ''],
    ['  /goal ship it  ', 'ship it'],
    ['/goal\nmulti\nline', 'multi\nline'],
    ['/goal  a  b ', 'a  b']
  ])('GC-2 直输 %j → %j', (text, args) => {
    expect(goalCommandArgs({ chip: null, text })).toBe(args)
  })

  it.each(['/goals x', '/goal-x', 'x /goal y', 'hello', '', '/Goal x', '//goal x'])(
    'GC-2 直输 %j → null',
    (text) => {
      expect(goalCommandArgs({ chip: null, text })).toBeNull()
    }
  )
})

describe('withGoalCommand', () => {
  it('GC-3 排第一、同名让位、不可用原样', () => {
    const goal = { commandId: 'goal', kind: 'builtin' as const }
    const list = [
      { commandId: 'review', kind: 'skill' as const },
      { commandId: 'goal', kind: 'project' as const },
      { commandId: 'deploy', kind: 'project' as const }
    ]
    expect(withGoalCommand<{ commandId: string; kind: string }>(list, goal)).toEqual([
      goal,
      list[0],
      list[2]
    ])
    expect(withGoalCommand(list, null)).toBe(list)
    expect(withGoalCommand([], goal)).toEqual([goal])
  })
})

describe('goalEligibleSession', () => {
  it('GC-4 只有人发起的根会话', () => {
    expect(goalEligibleSession({ parentId: null, settings: {} })).toBe(true)
    expect(goalEligibleSession({ parentId: null, settings: null })).toBe(true)
    expect(goalEligibleSession(undefined)).toBe(true)
    expect(goalEligibleSession({ parentId: 'root', settings: {} })).toBe(false)
    expect(goalEligibleSession({ parentId: null, settings: { bot: 'diary' } })).toBe(false)
    expect(goalEligibleSession({ parentId: null, settings: { notebookPath: 'a.md' } })).toBe(false)
    expect(
      goalEligibleSession({
        parentId: null,
        settings: { chromeTab: { installId: 'i', runId: 'r', tabId: 3 } }
      })
    ).toBe(false)
    // 不完整的标签页绑定不算标签页会话（同 chromeTabOf）
    expect(goalEligibleSession({ parentId: null, settings: { chromeTab: { tabId: -1 } } })).toBe(
      true
    )
  })
})
