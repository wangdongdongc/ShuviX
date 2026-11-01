/**
 * 智能体停掉本会话的后台任务（`shuvix task stop <pid>` → cliServer `task.stop` →
 * bgTaskService.stopBgTaskByAgent）—— 查找矩阵与「自己停的不回头通知」。
 *
 *  - FU-1 按 pid 找：只找**本会话**、**进过面板**（宣告过）的 bash 任务；跑着的 → 'stopped'（与面板同一条
 *    停止路径，先 SIGINT：force=false）；跑完的 → 'not-running'；别的会话的、没有的、被移除的、
 *    还没宣告的（`announceAfter: Infinity`，例如预热窗口里的后台命令）→ 'not-found'；
 *  - FU-2 智能体自己停的，落定后不再通知它；面板上用户停的照常通知（对照）；连停两次也只落定一次、不通知；
 *  - FU-3 pid 复用：同一会话里一条早已结束的旧任务与一条正在跑的新任务同 pid → 停的是正在跑的那条。
 *
 * 真的 bgTaskService + 桌面 taskRegistry（枢纽内核也是真的），任务直接在枢纽里建（不起进程），
 * 停止实现是 spy。只桩 electron（utils/paths 要它）与 logger（electron-log 在 Electron 外会写真家目录）。
 * 通知合并窗口（250ms）用假时钟推过去。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/nonexistent/shuvix-stop-by-agent', isPackaged: false }
}))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
}))

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { taskRegistry } from '../taskRegistry'
import {
  clearFinishedBgTasks,
  dismissBgTask,
  getBgTask,
  killAllBgTasks,
  readBgTaskLog,
  setBgTaskNotifier,
  stopBgTask,
  stopBgTaskByAgent,
  stopTaskByAgentId
} from '../bgTaskService'

const S1 = 'sess-stop-1'
const S2 = 'sess-stop-2'
/** 比枢纽的通知合并窗口（250ms）宽裕得多 */
const PAST_COALESCE_MS = 1000

let seq = 0
const notifySpy = vi.fn<(sessionId: string, text: string) => void>()

interface Made {
  id: string
  stop: ReturnType<typeof vi.fn<(force: boolean) => void>>
}

/** 在枢纽里直接建一条 bash 任务（announceAfter 缺省 0 = 立刻进面板） */
function makeTask(sessionId: string, pid: number, opts: { announceAfter?: number } = {}): Made {
  const id = `tc-stop-${++seq}`
  const stop = vi.fn<(force: boolean) => void>()
  taskRegistry.create({
    taskId: id,
    kind: 'bash',
    sessionId,
    title: `task ${id}`,
    subject: {
      kind: 'bash',
      command: 'sleep 100',
      cwd: '/w',
      pid,
      logPath: `/nonexistent/${id}.log`,
      exitCode: null,
      signal: null,
      logCapped: false
    },
    announceAfter: opts.announceAfter,
    // 有通知文案：没人等的落定本来就会通知 —— 「不通知」只能来自「智能体自己停的」
    formatNotice: (task) => `<background-task pid="${pid}">${task.taskId}</background-task>`,
    stop
  })
  return { id, stop }
}

/** 拥有者把进程退出送回枢纽（被停的进程退出了） */
const exitAsKilled = (id: string): void => taskRegistry.settle(id, { status: 'killed' })

beforeEach(() => {
  vi.useFakeTimers()
  notifySpy.mockReset()
  setBgTaskNotifier(notifySpy)
})

afterEach(() => {
  // 清空枢纽（对还在跑的会以 force=true 回调各自的 stop spy —— 断言都已做完）
  killAllBgTasks()
  vi.useRealTimers()
})

describe('FU-1 stopBgTaskByAgent 的查找矩阵', () => {
  it('FU-1a 本会话正在跑的 pid → stopped；走面板同一条停止路径，先温和（force=false）只一次', () => {
    const t = makeTask(S1, 4242)

    expect(stopBgTaskByAgent(S1, 4242)).toBe('stopped')
    expect(t.stop.mock.calls).toEqual([[false]])
  })

  it('FU-1b 同一个 pid 从别的会话来问 → not-found；spy 不动，任务照跑', () => {
    const t = makeTask(S1, 4242)

    expect(stopBgTaskByAgent(S2, 4242)).toBe('not-found')
    expect(t.stop).not.toHaveBeenCalled()
    expect(getBgTask(t.id)?.status).toBe('running')
  })

  it('FU-1c 本会话没有这个 pid → not-found', () => {
    const t = makeTask(S1, 4242)

    expect(stopBgTaskByAgent(S1, 4243)).toBe('not-found')
    expect(stopBgTaskByAgent(S1, 1)).toBe('not-found')
    expect(t.stop).not.toHaveBeenCalled()
  })

  it.each([['done'], ['error'], ['killed']] as const)(
    'FU-1d 已落定（%s）的任务 → not-running；不再调 stop',
    (status) => {
      const t = makeTask(S1, 4242)
      taskRegistry.settle(t.id, { status })

      expect(stopBgTaskByAgent(S1, 4242)).toBe('not-running')
      expect(t.stop).not.toHaveBeenCalled()
    }
  )

  it('FU-1e 被移除（dismiss）的任务 → not-found', () => {
    const t = makeTask(S1, 4242)
    taskRegistry.settle(t.id, { status: 'done' })
    expect(dismissBgTask(t.id)).toBe(true)

    expect(stopBgTaskByAgent(S1, 4242)).toBe('not-found')
    expect(t.stop).not.toHaveBeenCalled()
  })

  it('FU-1f 还没宣告的任务（announceAfter: Infinity）→ not-found：命令里 `shuvix task stop $$` 找不到它自己', () => {
    const t = makeTask(S1, 4242, { announceAfter: Number.POSITIVE_INFINITY })

    expect(stopBgTaskByAgent(S1, 4242)).toBe('not-found')
    expect(t.stop).not.toHaveBeenCalled()
    expect(getBgTask(t.id)?.status).toBe('running')
  })
})

describe('FU-2 智能体自己停的不回头通知它', () => {
  it('FU-2a 智能体停 → 进程退出落定为 killed，通知一条都不发', () => {
    const t = makeTask(S1, 4242)
    expect(stopBgTaskByAgent(S1, 4242)).toBe('stopped')

    exitAsKilled(t.id)
    vi.advanceTimersByTime(PAST_COALESCE_MS)

    expect(getBgTask(t.id)?.status).toBe('killed')
    expect(notifySpy).not.toHaveBeenCalled()
  })

  it('FU-2b 对照：面板上用户停的 → 落定后通知本会话一次', () => {
    const t = makeTask(S1, 4242)
    expect(stopBgTask(t.id)).toBe(true)
    expect(t.stop.mock.calls).toEqual([[false]])

    exitAsKilled(t.id)
    vi.advanceTimersByTime(PAST_COALESCE_MS)

    expect(getBgTask(t.id)?.status).toBe('killed')
    expect(notifySpy).toHaveBeenCalledTimes(1)
    expect(notifySpy.mock.calls[0][0]).toBe(S1)
    expect(notifySpy.mock.calls[0][1]).toContain(t.id)
  })

  it('FU-2c 进程退出之前智能体连停两次：两次都 stopped，都是温和的停，只落定一次，不通知', () => {
    const t = makeTask(S1, 4242)

    expect(stopBgTaskByAgent(S1, 4242)).toBe('stopped')
    expect(stopBgTaskByAgent(S1, 4242)).toBe('stopped')
    expect(t.stop.mock.calls.length).toBeGreaterThan(0)
    expect(t.stop.mock.calls.every(([force]) => force === false)).toBe(true)

    exitAsKilled(t.id)
    // 拥有者再送一次落定也不会重复落定
    exitAsKilled(t.id)
    vi.advanceTimersByTime(PAST_COALESCE_MS)

    expect(getBgTask(t.id)?.status).toBe('killed')
    expect(notifySpy).not.toHaveBeenCalled()
    // 落定之后再问：已经不在跑了
    expect(stopBgTaskByAgent(S1, 4242)).toBe('not-running')
  })
})

describe('FU-3 pid 复用：先认正在跑的那条', () => {
  it('FU-3 同会话一条已结束的旧任务 + 一条正在跑的新任务同 pid → stopped，停的是新的那条', () => {
    const older = makeTask(S1, 4242)
    taskRegistry.settle(older.id, { status: 'done' })
    const newer = makeTask(S1, 4242)

    expect(stopBgTaskByAgent(S1, 4242)).toBe('stopped')
    expect(newer.stop.mock.calls).toEqual([[false]])
    expect(older.stop).not.toHaveBeenCalled()
    expect(getBgTask(older.id)?.status).toBe('exited')
  })

  it('FU-3 两条都已结束 → not-running；谁的 stop 都不调', () => {
    const a = makeTask(S1, 4242)
    taskRegistry.settle(a.id, { status: 'done' })
    const b = makeTask(S1, 4242)
    taskRegistry.settle(b.id, { status: 'killed' })

    expect(stopBgTaskByAgent(S1, 4242)).toBe('not-running')
    expect(a.stop).not.toHaveBeenCalled()
    expect(b.stop).not.toHaveBeenCalled()
  })
})

/**
 * FU-6 ssh 远端任务（services/builtinMcp/sshRemoteTasks）在枢纽里也是 bash 任务，但没有本机进程：
 * pid 恒为 -1、subject 带 host、logPath 是本机镜像。智能体按任务 id 停它；面板读日志、移除、清空都按
 * subject 上的镜像路径走（bgTaskService 的 procs 里没有它）。
 */
describe('FU-6 远端任务：按 id 停、镜像日志的读与删', () => {
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shuvix-remote-mirror-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function makeRemote(sessionId: string): { id: string; log: string; stop: Made['stop'] } {
    const id = `tc-remote-${++seq}`
    const log = join(dir, `${id}.log`)
    writeFileSync(log, 'line 1\nline 2\n')
    const stop = vi.fn<(force: boolean) => void>()
    taskRegistry.create({
      taskId: id,
      kind: 'bash',
      sessionId,
      title: 'remote',
      subject: {
        kind: 'bash',
        command: 'make',
        cwd: 'web:~',
        pid: -1,
        logPath: log,
        exitCode: null,
        signal: null,
        logCapped: false,
        host: 'web'
      },
      stop
    })
    return { id, log, stop }
  }

  it('FU-6a 按 id 停：本会话跑着的 → stopped（智能体停的，之后不通知）；别的会话 / 没有 / 已结束', async () => {
    const t = makeRemote(S1)
    expect(stopTaskByAgentId(S2, t.id)).toBe('not-found')
    expect(stopTaskByAgentId(S1, 'tc-nope')).toBe('not-found')
    expect(stopTaskByAgentId(S1, t.id)).toBe('stopped')
    expect(t.stop.mock.calls).toEqual([[false]])
    exitAsKilled(t.id)
    await vi.advanceTimersByTimeAsync(PAST_COALESCE_MS)
    expect(notifySpy).not.toHaveBeenCalled()
    expect(stopTaskByAgentId(S1, t.id)).toBe('not-running')
  })

  it('FU-6b 面板读日志读的是镜像；移除 / 清空连镜像一起删', () => {
    const a = makeRemote(S1)
    const b = makeRemote(S1)
    expect(readBgTaskLog({ toolCallId: a.id })).toMatchObject({
      exists: true,
      text: 'line 1\nline 2\n'
    })
    taskRegistry.settle(a.id, { status: 'done' })
    expect(dismissBgTask(a.id)).toBe(true)
    expect(existsSync(a.log)).toBe(false)
    taskRegistry.settle(b.id, { status: 'error' })
    expect(clearFinishedBgTasks(S1)).toBeGreaterThanOrEqual(1)
    expect(existsSync(b.log)).toBe(false)
  })
})
