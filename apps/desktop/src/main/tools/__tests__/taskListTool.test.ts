/**
 * update_plan 的桌面注册（tools/taskList.ts）—— 共享的 createTaskListTool（agent-runtime，自身的用例在
 * packages/agent-runtime/src/__tests__/taskListTool.test.ts）接上桌面的三样东西：注册表、会话宿主里开着的
 * durable 会话（列表从那里读）、日志。
 *
 *   D-1  加载 ../taskList 就注册了 update_plan：group general、不限平台、不隐藏、呈现 ListChecks / #8b5cf6
 *   D-2  getLabel → t('tool.taskListLabel')、getHint → t('tool.taskListHint')
 *   D-3  describe() 交回 {TASK_LIST_DESCRIPTION, TaskListParamsSchema}；「LLM 工具」设置页的定义枚举里有它
 *   D-4  darwin / linux / win32 上都在当前平台的工具里
 *   D-5  factory(ctx) → 名字 update_plan、replay safe、label 是翻译过的
 *   D-6  会话宿主没起来 / 宿主里没有这条会话（get 拿到的是 ctx.sessionId）→ advance 是「还没有列表」，不读、不记日志
 *   D-7  会话开着 → readTaskList(session, 调用 id)，读到的列表决定那一行
 *   D-8  readTaskList 抛错 → 「还没有列表」，warn 恰一条，带 session=<id> 与错误原文
 *   D-9  items 调用不碰会话宿主
 *
 * 注册表用真的（工具模块加载时自注册）；会话宿主、日志、i18n 是替身；agent-runtime 只把 readTaskList 换成 vi.fn。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TaskListItem } from '@shuvix/chat-protocol/taskList'
import { invokeTool, resultText } from '@shuvix/agent-runtime/tools/testing/invokeTool'
import type { ToolContext } from '../../services/toolContext'

const state = vi.hoisted(() => ({
  loggers: [] as string[],
  lines: [] as string[],
  peekSessionHost: vi.fn(),
  readTaskList: vi.fn()
}))

vi.mock('../../logger', () => ({
  createLogger: (name: string) => {
    state.loggers.push(name)
    return {
      info: (m: string) => void state.lines.push(`info ${m}`),
      warn: (m: string) => void state.lines.push(`warn ${m}`),
      error: (m: string) => void state.lines.push(`error ${m}`),
      debug: (m: string) => void state.lines.push(`debug ${m}`)
    }
  }
}))
vi.mock('../../i18n', () => ({ t: (key: string) => `t(${key})` }))
vi.mock('../../services/sessionHost', () => ({
  peekSessionHost: (...args: unknown[]) => state.peekSessionHost(...args)
}))
vi.mock('@shuvix/agent-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shuvix/agent-runtime')>()
  return {
    ...actual,
    readTaskList: (...args: unknown[]) => state.readTaskList(...args)
  }
})

import {
  TaskListParamsSchema,
  TASK_LIST_DESCRIPTION,
  type TaskListTool
} from '@shuvix/agent-runtime'
import {
  getBuiltinToolEntries,
  getPlatformBuiltinToolEntries,
  type BuiltinToolMeta
} from '../../services/toolRegistry'
import { getBuiltinToolDefinitions } from '../../services/agentToolBuilder'
import '../taskList'

const NO_LIST = 'No task list in this request yet: send `items` first.'
const ctx = { sessionId: 'sess-plan' } as ToolContext

const I = (content: string): TaskListItem => ({ content, status: 'in_progress' })
const P = (content: string): TaskListItem => ({ content, status: 'pending' })

const ITEMS3 = {
  items: [
    { content: 'Read the code', status: 'in_progress' },
    { content: 'Fix the bug', status: 'pending' },
    { content: 'Run the tests', status: 'pending' }
  ]
}

/** 原始描述符 —— 还原时连 writable/enumerable 一起还原 */
const REAL_PLATFORM_DESC = Object.getOwnPropertyDescriptor(process, 'platform')!
const setPlatform = (platform: string): void => {
  Object.defineProperty(process, 'platform', { ...REAL_PLATFORM_DESC, value: platform })
}

function entry(): BuiltinToolMeta {
  const found = getBuiltinToolEntries().filter((e) => e.name === 'update_plan')
  expect(found, 'update_plan registered exactly once').toHaveLength(1)
  return found[0]!
}

/** factory 交回 object；这里按共享工具的类型用 */
const makeTool = (): TaskListTool => entry().factory!(ctx) as TaskListTool

const warns = (): string[] => state.lines.filter((l) => l.startsWith('warn '))

beforeEach(() => {
  state.lines.length = 0
  state.peekSessionHost.mockReset()
  state.readTaskList.mockReset()
})

afterEach(() => {
  Object.defineProperty(process, 'platform', REAL_PLATFORM_DESC)
})

describe('update_plan · registration', () => {
  it('D-1 importing ../taskList registers update_plan: group general, no platforms, not hidden, ListChecks / #8b5cf6', () => {
    const meta = entry()
    expect(meta.group).toBe('general')
    expect(meta.platforms).toBeUndefined()
    expect(meta.hidden).not.toBe(true)
    expect(meta.presentation).toMatchObject({ icon: 'ListChecks', iconColor: '#8b5cf6' })
    expect(state.loggers).toContain('tool:update_plan')
  })

  it('D-2 getLabel → t(tool.taskListLabel), getHint → t(tool.taskListHint)', () => {
    const meta = entry()
    expect(meta.getLabel()).toBe('t(tool.taskListLabel)')
    expect(meta.getHint()).toBe('t(tool.taskListHint)')
  })

  it('D-3 describe() returns the shared description and schema; the LLM-tools definitions list includes it', () => {
    const described = entry().describe!()
    expect(described.description).toBe(TASK_LIST_DESCRIPTION)
    expect(described.parameters).toBe(TaskListParamsSchema)

    const definition = getBuiltinToolDefinitions().find((d) => d.name === 'update_plan')
    expect(definition).toBeDefined()
    expect(definition).toMatchObject({
      name: 'update_plan',
      label: 't(tool.taskListLabel)',
      group: 'general',
      icon: 'ListChecks',
      iconColor: '#8b5cf6',
      description: TASK_LIST_DESCRIPTION
    })
    expect('platforms' in definition!).toBe(false)
  })

  it.each(['darwin', 'linux', 'win32'])(
    'D-4 present among the platform entries on %s',
    (platform) => {
      setPlatform(platform)
      expect(getPlatformBuiltinToolEntries().map((e) => e.name)).toContain('update_plan')
    }
  )

  it('D-5 factory(ctx) → update_plan, replay safe, the translated label', () => {
    const tool = makeTool()
    expect(tool.name).toBe('update_plan')
    expect(tool.replay).toBe('safe')
    expect(tool.label).toBe('t(tool.taskListLabel)')
  })
})

describe('update_plan · reading the list', () => {
  it('D-6 no session host → advance says no list yet; nothing read, nothing logged', async () => {
    state.peekSessionHost.mockReturnValue(undefined)
    const { result } = await invokeTool(makeTool(), { advance: true } as never, { callId: 'c1' })

    expect(result.isError).toBe(true)
    expect(resultText(result)).toBe(NO_LIST)
    expect(state.peekSessionHost).toHaveBeenCalled()
    expect(state.readTaskList).not.toHaveBeenCalled()
    expect(state.lines).toEqual([])
  })

  it('D-6 the host has no such session (get receives ctx.sessionId) → no list yet; nothing read, nothing logged', async () => {
    const get = vi.fn(() => undefined)
    state.peekSessionHost.mockReturnValue({ get })
    const { result } = await invokeTool(makeTool(), { done: [1] } as never, { callId: 'c1' })

    expect(get).toHaveBeenCalledWith('sess-plan')
    expect(result.isError).toBe(true)
    expect(resultText(result)).toBe(NO_LIST)
    expect(state.readTaskList).not.toHaveBeenCalled()
    expect(state.lines).toEqual([])
  })

  it('D-7 an open session → readTaskList(session, call id); the returned list drives the line', async () => {
    const session = { sessionId: 'sess-plan' }
    const get = vi.fn(() => session)
    state.peekSessionHost.mockReturnValue({ get })
    state.readTaskList.mockResolvedValue([I('a'), P('b'), P('c')])
    const { result } = await invokeTool(makeTool(), { advance: true } as never, { callId: 'c9' })

    expect(get).toHaveBeenCalledWith('sess-plan')
    expect(state.readTaskList).toHaveBeenCalledTimes(1)
    expect(state.readTaskList).toHaveBeenCalledWith(session, 'c9')
    expect(result.isError).not.toBe(true)
    expect(resultText(result)).toBe('Plan updated: step 2 of 3 is in progress.')
    expect(state.lines).toEqual([])
  })

  it('D-8 readTaskList throws → no list yet; exactly one warn naming the session and the error', async () => {
    state.peekSessionHost.mockReturnValue({ get: () => ({ sessionId: 'sess-plan' }) })
    state.readTaskList.mockRejectedValue(new Error('conversation gone'))
    const { result } = await invokeTool(makeTool(), { advance: true } as never, { callId: 'c1' })

    expect(result.isError).toBe(true)
    expect(resultText(result)).toBe(NO_LIST)
    expect(warns()).toHaveLength(1)
    expect(warns()[0]).toContain('session=sess-plan')
    expect(warns()[0]).toContain('conversation gone')
    expect(state.lines).toHaveLength(1)
  })

  it('D-9 an items call never touches the session host', async () => {
    const { result } = await invokeTool(makeTool(), ITEMS3 as never, { callId: 'c1' })

    expect(resultText(result)).toBe('Plan shown (3 steps).')
    expect(state.peekSessionHost).not.toHaveBeenCalled()
    expect(state.readTaskList).not.toHaveBeenCalled()
    expect(state.lines).toEqual([])
  })
})
