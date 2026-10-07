/**
 * `runningBackgroundTasks(sessionId)` —— 「本会话有几条后台命令在跑、是哪几条」的唯一来源。
 *
 * 命令工具按它的**条数**卡第 9 条并发后台任务，撞上限时回给模型的停止命令也按它**逐条**列。
 * 回归点：一批并行起的 10 条后台命令在预热窗口里都还没宣告，旧实现计数读进程簿记、列表读枢纽的
 * `list()`（只给宣告过的），于是第 9、10 条拿到「(0/8)」加一张空列表。
 *
 *  - BR-1 预热窗口内（未宣告）的后台任务照样返回，且列表完整（核心回归）；
 *  - BR-2 宣告前后答案不变；宣告之后与 `listBgTasks` 的运行中条目一致；
 *  - BR-3 结束了的后台任务不在其中：预热内退出的 / 转后台后自己跑完的 / 被智能体停掉的；
 *  - BR-4 同步形态的命令不算，跑够阈值进了面板也不算；
 *  - BR-5 只给本会话的（别的会话、不存在的会话、本会话的非命令任务都不在）；
 *  - BR-6 按启动时间正序，同一时刻起的保持启动顺序。
 *
 * 真进程 + 真 bgTaskService + 桌面 taskRegistry。只桩 electron（utils/paths 要它）与 logger
 * （electron-log 在 Electron 外会写真家目录）。`runCommand` 在 `await taskRegistry.join` 之前全是同步的，
 * 所以调用之后不 await 立刻断言是确定的；转后台是真的 2s 定时器，每个用例只付一次。
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const STAMP = Date.now()
const USER_DATA_DIR = join(tmpdir(), `shuvix-bgtask-running-${STAMP}`)
const GATE_DIR = join(USER_DATA_DIR, 'gates')

vi.mock('electron', () => ({ app: { getPath: () => USER_DATA_DIR, isPackaged: false } }))
vi.mock('../../logger', () => {
  const noop = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
  return { default: noop, createLogger: () => noop }
})

import {
  runCommand,
  runningBackgroundTasks,
  listBgTasks,
  getBgTask,
  killAllBgTasks,
  stopBgTask,
  stopBgTaskByAgent,
  type CommandOutcome
} from '../bgTaskService'
import { taskRegistry } from '../taskRegistry'
import { platformShellKind } from '../../utils/toolUtils/shell'

/** 本平台的命令工具背后的 shell（`sleep` / `echo` 在 PowerShell 里也是别名） */
const SHELL = platformShellKind() ?? 'bash'

let callSeq = 0
const nextId = (): string => `bgrun-${STAMP}-${++callSeq}`

let sessionSeq = 0
/** 每个用例一个会话：procs 与 taskRegistry 都是模块级单例 */
const nextSession = (): string => `bgrun-sess-${STAMP}-${++sessionSeq}`

/** 本用例起的所有 runCommand —— afterEach 杀完之后等它们收尾 */
const pending: Promise<CommandOutcome>[] = []

interface Started {
  id: string
  promise: Promise<CommandOutcome>
}

/** 起一条命令，**不 await**（调用返回时进程簿记与枢纽登记都已同步完成） */
function start(
  sessionId: string,
  opts: { command?: string; description?: string; background?: boolean } = {}
): Started {
  const id = nextId()
  const promise = runCommand({
    sessionId,
    toolCallId: id,
    shell: SHELL,
    command: opts.command ?? 'sleep 30',
    description: opts.description ?? `task ${id}`,
    cwd: tmpdir(),
    background: opts.background ?? true
  })
  pending.push(promise)
  return { id, promise }
}

/** 一个闸门文件：命令轮询它，存在就退出 —— 想让它什么时候结束就什么时候结束 */
function gate(): { path: string; command: string; open: () => void } {
  mkdirSync(GATE_DIR, { recursive: true })
  const path = join(GATE_DIR, `gate-${++callSeq}`)
  return {
    path,
    command: `while [ ! -e "${path}" ]; do sleep 0.05; done`,
    open: () => writeFileSync(path, '')
  }
}

/** 轮询等任务落定（上限 15s） */
async function waitSettled(toolCallId: string): Promise<void> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (getBgTask(toolCallId)?.status !== 'running') return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`任务 ${toolCallId} 15s 内未落定`)
}

/** 轮询直到条件成立（上限 10s） */
async function waitUntil(cond: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`10s 内未等到：${what}`)
}

const idsOf = (sessionId: string): string[] =>
  runningBackgroundTasks(sessionId).map((t) => t.toolCallId)

afterEach(async () => {
  killAllBgTasks()
  await Promise.allSettled(pending)
  pending.length = 0
  vi.useRealTimers()
})

afterAll(() => {
  rmSync(USER_DATA_DIR, { recursive: true, force: true })
})

describe('BR-1 预热窗口里的后台任务（还没宣告）照样算、照样列', () => {
  it('并行起 10 条：一条不少地返回，每条的状态 / 会话 / 描述 / pid 都对得上', () => {
    const S1 = nextSession()
    const started = Array.from({ length: 10 }, (_, i) => ({
      ...start(S1, { description: `job ${i}` }),
      description: `job ${i}`
    }))

    // 前提：它们都还在预热窗口里，枢纽的 list() 一条都不给（旧实现的列表就是从这里来的）
    expect(listBgTasks(S1)).toEqual([])

    const running = runningBackgroundTasks(S1)
    expect(running).toHaveLength(10)
    expect(new Set(running.map((t) => t.toolCallId))).toEqual(new Set(started.map((s) => s.id)))

    for (const s of started) {
      const info = running.find((t) => t.toolCallId === s.id)!
      expect(info).toMatchObject({ status: 'running', sessionId: S1, description: s.description })
      expect(info.pid).toBeGreaterThan(0)
      expect(info.pid).toBe(getBgTask(s.id)!.pid)
      // 列出来的 pid 是活着的进程（模型拿去 `shuvix task stop` 的就是它）
      expect(() => process.kill(info.pid, 0)).not.toThrow()
    }
  }, 20_000)
})

describe('BR-2 宣告前后同一个答案', () => {
  it('两条已转后台 + 两条还在预热：四条都在；后两条宣告之后与 listBgTasks 的运行中条目一致', async () => {
    const S1 = nextSession()
    const a = start(S1)
    const b = start(S1)
    const [outA, outB] = await Promise.all([a.promise, b.promise])
    expect(outA.kind).toBe('background')
    expect(outB.kind).toBe('background')

    const c = start(S1)
    const d = start(S1)

    expect(idsOf(S1)).toEqual([a.id, b.id, c.id, d.id])
    // 枢纽此刻只认识宣告过的两条 —— 这正是两边会各说各话的那个窗口
    expect(
      listBgTasks(S1)
        .filter((t) => t.status === 'running')
        .map((t) => t.toolCallId)
    ).toEqual([a.id, b.id])

    const [outC, outD] = await Promise.all([c.promise, d.promise])
    expect(outC.kind).toBe('background')
    expect(outD.kind).toBe('background')

    expect(idsOf(S1)).toEqual([a.id, b.id, c.id, d.id])
    expect(runningBackgroundTasks(S1)).toEqual(
      listBgTasks(S1).filter((t) => t.status === 'running')
    )
  }, 20_000)
})

describe('BR-3 结束了的后台任务不在其中', () => {
  it('预热窗口内就退出的（settled）不在', async () => {
    const S1 = nextSession()
    const quick = start(S1, { command: 'echo hi' })
    const outcome = await quick.promise

    expect(outcome.kind).toBe('settled')
    expect(idsOf(S1)).not.toContain(quick.id)
    expect(idsOf(S1)).toEqual([])
  }, 20_000)

  it.skipIf(SHELL !== 'bash')(
    '转后台之后自己跑完的不在 —— 面板里那一行还留着（已退出）',
    async () => {
      const S1 = nextSession()
      const g = gate()
      const gated = start(S1, { command: g.command })
      const sleeper = start(S1)
      const outcomes = await Promise.all([gated.promise, sleeper.promise])
      expect(outcomes.map((o) => o.kind)).toEqual(['background', 'background'])
      expect(idsOf(S1)).toEqual([gated.id, sleeper.id])

      g.open()
      expect(existsSync(g.path)).toBe(true)
      await waitSettled(gated.id)

      expect(idsOf(S1)).toEqual([sleeper.id])
      expect(getBgTask(gated.id)?.status).toBe('exited')
      // 只是不再算「在跑」，不是被移除：面板（listBgTasks）照样列着它
      expect(listBgTasks(S1).map((t) => t.toolCallId)).toContain(gated.id)
    },
    20_000
  )

  it('被智能体停掉（shuvix task stop）的，退出之后不在', async () => {
    const S1 = nextSession()
    const first = start(S1)
    const second = start(S1)
    const outcomes = await Promise.all([first.promise, second.promise])
    expect(outcomes.map((o) => o.kind)).toEqual(['background', 'background'])

    const pid = getBgTask(first.id)!.pid
    expect(stopBgTaskByAgent(S1, pid)).toBe('stopped')
    // 停止请求与进程真正退出之间的那一刻不做断言（是否还算在跑取决于信号送达的时机）
    await waitSettled(first.id)

    expect(idsOf(S1)).toEqual([second.id])
  }, 20_000)
})

describe('BR-4 同步形态的命令不算', () => {
  it('前台的 sleep 30 不在其中；跑够阈值进了面板之后也不在', async () => {
    const S1 = nextSession()
    const sync = start(S1, { background: false })
    const bg = start(S1)

    expect(idsOf(S1)).toEqual([bg.id])

    // 同步形态跑够 ~2s 才进面板
    await waitUntil(
      () => listBgTasks(S1).some((t) => t.toolCallId === sync.id && t.status === 'running'),
      '同步命令进面板'
    )
    expect(idsOf(S1)).toEqual([bg.id])

    stopBgTask(sync.id, true)
    const outcome = await sync.promise
    expect(outcome.kind).toBe('settled')
  }, 20_000)
})

describe('BR-5 只给本会话的', () => {
  it('两个会话各拿各的；不存在的会话是空表；本会话的非命令任务不算', () => {
    const S1 = nextSession()
    const S2 = nextSession()
    const s1Tasks = [start(S1), start(S1)]
    const s2Tasks = [start(S2), start(S2), start(S2)]

    // 同会话里一条正在跑的派生 agent 任务（枢纽里有，但不是命令）
    const agentTaskId = `bgrun-agent-${STAMP}`
    taskRegistry.create({
      taskId: agentTaskId,
      kind: 'agent',
      sessionId: S1,
      title: 'explore',
      subject: { kind: 'agent', profileName: 'explore', depth: 1 },
      announceAfter: 0,
      stop: () => {}
    })
    expect(taskRegistry.get(agentTaskId)?.endedAt).toBeNull()

    const s1 = runningBackgroundTasks(S1)
    expect(new Set(s1.map((t) => t.toolCallId))).toEqual(new Set(s1Tasks.map((t) => t.id)))
    expect(s1.every((t) => t.sessionId === S1)).toBe(true)
    expect(s1.map((t) => t.toolCallId)).not.toContain(agentTaskId)

    const s2 = runningBackgroundTasks(S2)
    expect(new Set(s2.map((t) => t.toolCallId))).toEqual(new Set(s2Tasks.map((t) => t.id)))
    expect(s2.every((t) => t.sessionId === S2)).toBe(true)

    expect(runningBackgroundTasks('no-such-session')).toEqual([])
  }, 20_000)
})

describe('BR-6 按启动时间正序', () => {
  it('启动时刻乱序：按 startedAt 排；同一时刻起的保持启动顺序', () => {
    const S1 = nextSession()
    // 只假 Date：枢纽的 startedAt 取 Date.now()，转后台的定时器照旧是真的
    vi.useFakeTimers({ toFake: ['Date'] })
    const T = Date.UTC(2026, 0, 1)

    vi.setSystemTime(T + 300)
    const a = start(S1)
    vi.setSystemTime(T + 100)
    const b = start(S1)
    vi.setSystemTime(T + 200)
    const c = start(S1)
    const d = start(S1)

    const running = runningBackgroundTasks(S1)
    expect(running.map((t) => t.toolCallId)).toEqual([b.id, c.id, d.id, a.id])
    expect(running.map((t) => t.startedAt)).toEqual([T + 100, T + 200, T + 200, T + 300])
  }, 20_000)
})
