/**
 * cliServer `task.stop`（FU-4）—— `shuvix task stop <pid>` 在主进程那一头：先看会话，再看 pid，
 * 然后按「请求带来的会话 id」去找（bgTaskService.stopBgTaskByAgent 是 spy），三种结局各一句话。
 *
 *  - 没有会话 id（CLI 不在 ShuviX 起的命令里跑）→ 拒绝，且先于 pid 的校验；
 *  - pid 只收正整数：数字，或全是数字的字符串（CLI 发的是 JSON 数字；别的写法 —— '0x10'、true、'1e3'、
 *    '12a' —— 一律不收，不做 Number() 式的宽松转换）；
 *  - 会话 id 原样传下去，不回落到别的会话（会话 id 由调用方自报、不鉴权 —— 这里只钉「按请求带来的会话查」）。
 *
 * handler 从私有的 `handlers` 表里取（构造时注册，不用 start 起 socket）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  stopBgTaskByAgent:
    vi.fn<(sessionId: string, pid: number) => 'stopped' | 'not-found' | 'not-running'>()
}))

vi.mock('../bgTaskService', () => ({ stopBgTaskByAgent: mocks.stopBgTaskByAgent }))
// 其余依赖本文件一个都不碰：给空壳
vi.mock('../widget', () => ({
  widgetService: {},
  exportWidget: vi.fn(),
  resolveExportZipPath: vi.fn(),
  WidgetExportError: class WidgetExportError extends Error {},
  runWidgetDbQuery: vi.fn()
}))
vi.mock('../widgetWindowService', () => ({ open: vi.fn() }))
vi.mock('../sessionService', () => ({ sessionService: { addAllowListPaths: vi.fn() } }))
vi.mock('../toolContext', () => ({
  resolveProjectConfig: vi.fn(),
  isPathWithinWorkspace: vi.fn()
}))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
}))

import { cliServer } from '../cliServer'

type Handler = (params: Record<string, unknown>, sessionId: string | undefined) => Promise<unknown>

const stopHandler = (): Handler => {
  const handler = (cliServer as unknown as { handlers: Map<string, Handler> }).handlers.get(
    'task.stop'
  )
  if (!handler) throw new Error('task.stop handler is not registered')
  return handler
}

const BAD_PIDS: unknown[] = [
  undefined,
  null,
  '',
  0,
  -3,
  1.5,
  'abc',
  NaN,
  // 只收数字或全是数字的字符串：这些 Number() 能转、但 CLI 永远不会发
  '0x10',
  true,
  '12a',
  '1e3',
  ' 7',
  '-3',
  '1.5'
]

beforeEach(() => {
  mocks.stopBgTaskByAgent.mockReset()
  mocks.stopBgTaskByAgent.mockReturnValue('stopped')
})

describe('FU-4 task.stop 的入参', () => {
  it.each([undefined, ''])(
    'FU-4 会话 id 为 %j → 拒绝（SHUVIX_SESSION_ID is not set），不去找',
    async (sid) => {
      await expect(stopHandler()({ pid: 123 }, sid)).rejects.toThrow(/SHUVIX_SESSION_ID is not set/)
      expect(mocks.stopBgTaskByAgent).not.toHaveBeenCalled()
    }
  )

  it('FU-4 会话 id 缺、pid 也坏 → 先报会话', async () => {
    await expect(stopHandler()({ pid: 'abc' }, undefined)).rejects.toThrow(
      /SHUVIX_SESSION_ID is not set/
    )
    await expect(stopHandler()({}, '')).rejects.toThrow(/SHUVIX_SESSION_ID is not set/)
    expect(mocks.stopBgTaskByAgent).not.toHaveBeenCalled()
  })

  it.each(BAD_PIDS.map((pid) => [pid]))(
    'FU-4 pid = %j → 拒绝（pid must be a positive integer），不去找',
    async (pid) => {
      await expect(stopHandler()({ pid }, 'sess-1')).rejects.toThrow(
        'pid must be a positive integer'
      )
      expect(mocks.stopBgTaskByAgent).not.toHaveBeenCalled()
    }
  )

  it('FU-4 没带 pid 这个键 → 同样拒绝', async () => {
    await expect(stopHandler()({}, 'sess-1')).rejects.toThrow('pid must be a positive integer')
    expect(mocks.stopBgTaskByAgent).not.toHaveBeenCalled()
  })

  it.each([[123], ['123']])('FU-4 pid = %j → 按 (会话 id, 数字 pid) 去找', async (pid) => {
    await stopHandler()({ pid }, 'sess-1')
    expect(mocks.stopBgTaskByAgent.mock.calls).toEqual([['sess-1', 123]])
    expect(typeof mocks.stopBgTaskByAgent.mock.calls[0][1]).toBe('number')
  })

  it('FU-4 会话 id 原样传下去：sess-2 问的就是 sess-2 的任务，不回落到别的会话', async () => {
    await stopHandler()({ pid: 123 }, 'sess-2')
    expect(mocks.stopBgTaskByAgent.mock.calls).toEqual([['sess-2', 123]])
  })
})

describe('FU-4 task.stop 的三种结局', () => {
  it('FU-4 stopped → 「stopping background task 123」', async () => {
    mocks.stopBgTaskByAgent.mockReturnValue('stopped')
    await expect(stopHandler()({ pid: 123 }, 'sess-1')).resolves.toBe(
      'stopping background task 123'
    )
  })

  it('FU-4 not-running → 「task 123 is not running」（成功回话，不是错误）', async () => {
    mocks.stopBgTaskByAgent.mockReturnValue('not-running')
    await expect(stopHandler()({ pid: 123 }, 'sess-1')).resolves.toBe('task 123 is not running')
  })

  it('FU-4 not-found → 以「no background task with pid 123 in this session」拒绝', async () => {
    mocks.stopBgTaskByAgent.mockReturnValue('not-found')
    await expect(stopHandler()({ pid: 123 }, 'sess-1')).rejects.toThrow(
      /^no background task with pid 123 in this session$/
    )
  })
})
