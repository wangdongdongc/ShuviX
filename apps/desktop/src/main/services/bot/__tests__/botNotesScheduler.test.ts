/**
 * 笔记归纳的节流调度（设计 §8）单测 —— **假时钟 + 真 fs**。
 *
 * 这一层回答的问题只有三个：什么时候值得跑一次、跑的时候给它看哪些新材料、跑完记到哪儿。
 * 「怎么跑」经 `deps.runNotes` 注入，所以整组用例不需要 workflow、不需要会话树、
 * 也不需要 LLM —— 那半边在 botServiceNotes.test.ts。
 *
 * **刻意不 mock fs**：状态文件是这个模块唯一的持久面，而它的全部风险都在文件语义上 ——
 * 点号开头（不被注册表扫描）、坏 JSON 不能让归纳整个停摆、进程重启后从盘上接着算。
 * 换成假 fs 就只剩下「调了哪个函数」。
 *
 * **假时钟走 `deps.now`**（不是 vi.useFakeTimers）：被测的是两个门槛的算术，不是定时器；
 * 起点取一个真实纪元而不是 0 —— 全新 bot 的 `lastRunAt` 是 0，只有在真实纪元下
 * 「距上次 ≥30min」才像生产里那样天然成立（这一点也是 e2e 里三条消息就能触发归纳的原因）。
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join, resolve } from 'path'

const dirs = vi.hoisted(() => {
  const tmp = (process.env.TMPDIR || process.env.TEMP || '/tmp').replace(/[\\/]+$/, '')
  return { bots: `${tmp}/shuvix-botnotes-${process.pid}` }
})

vi.mock('../../../utils/paths', () => ({ getDefaultBotsDir: () => dirs.bots }))
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

import {
  BotNotesScheduler,
  NOTES_MIN_EVENTS,
  NOTES_MIN_INTERVAL_MS,
  type NotesSchedulerDeps
} from '../botNotesScheduler'

/** 状态文件：与 bot md 同目录、点号开头 —— 注册表扫描按 `.md` 收，它永远不在其中 */
const STATE = (): string => join(dirs.bots, '.notes-state.json')

/** 一个真实纪元（2023-11-14）—— 不能取 0，见文件头 */
const T0 = 1_700_000_000_000

type Dirty = Array<{ sessionId: string; sinceEntryId: string }>

interface Harness {
  sched: BotNotesScheduler
  /** 每次 runNotes 拿到的材料清单（调用了几次、各看到什么） */
  calls: Array<{ botName: string; dirty: Dirty }>
  /** 推进假时钟 */
  tick: (ms: number) => void
  now: () => number
  /** 让下一次 runNotes 的结局是这个 */
  outcome: (fn: (botName: string, dirty: Dirty) => Promise<boolean>) => void
}

function makeScheduler(opts: { ok?: boolean } = {}): Harness {
  let clock = T0
  const calls: Array<{ botName: string; dirty: Dirty }> = []
  let impl: (botName: string, dirty: Dirty) => Promise<boolean> = async () => opts.ok ?? true
  const deps: NotesSchedulerDeps = {
    runNotes: async (botName, dirty) => {
      calls.push({ botName, dirty: dirty.map((d) => ({ ...d })) })
      return await impl(botName, dirty)
    },
    now: () => clock
  }
  return {
    sched: new BotNotesScheduler(deps),
    calls,
    tick: (ms) => {
      clock += ms
    },
    now: () => clock,
    outcome: (fn) => {
      impl = fn
    }
  }
}

/** 攒 n 件（缺省都记在同一条会话上） */
function noteN(sched: BotNotesScheduler, botName: string, n: number, sessionId = 's1'): void {
  for (let i = 0; i < n; i++) sched.note(botName, sessionId)
}

const readState = (): Record<string, unknown> =>
  JSON.parse(readFileSync(STATE(), 'utf-8')) as Record<string, unknown>

beforeEach(() => {
  rmSync(dirs.bots, { recursive: true, force: true })
  mkdirSync(dirs.bots, { recursive: true })
})

afterAll(() => {
  rmSync(dirs.bots, { recursive: true, force: true })
})

// ────────────────────────── NS-A：双门槛 ──────────────────────────

/**
 * 两个门槛是**与**不是或，两边各防一种空转：只看时间会在闲置会话上每半小时白跑一次；
 * 只看件数会在一次密集对话里连跑好几次 —— 而每一次的代价都是一整份笔记进上下文
 * 外加一张（其实是两张，见 BP-B9）询问卡。
 */
describe('NS-A —— 什么时候值得跑一次', () => {
  it('NS-A1 门槛表：件数与时间都过了才跑', async () => {
    const table: Array<{ what: string; events: number; sinceLast: number; run: boolean }> = [
      // 全新 bot 的 lastRunAt 是 0，所以时间腿天然成立 —— 只剩件数在把关
      { what: '全新 bot 攒够 3 件', events: NOTES_MIN_EVENTS, sinceLast: 0, run: true },
      { what: '全新 bot 只攒了 2 件', events: NOTES_MIN_EVENTS - 1, sinceLast: 0, run: false },
      { what: '刚跑完又攒够 3 件', events: NOTES_MIN_EVENTS, sinceLast: 1000, run: false },
      {
        what: '刚跑完 29 分钟后攒够 3 件',
        events: NOTES_MIN_EVENTS,
        sinceLast: NOTES_MIN_INTERVAL_MS - 1,
        run: false
      },
      {
        what: '刚跑完 30 分钟后攒够 3 件',
        events: NOTES_MIN_EVENTS,
        sinceLast: NOTES_MIN_INTERVAL_MS,
        run: true
      },
      {
        what: '刚跑完 30 分钟后只攒了 2 件',
        events: NOTES_MIN_EVENTS - 1,
        sinceLast: NOTES_MIN_INTERVAL_MS,
        run: false
      }
    ]
    for (const row of table) {
      const h = makeScheduler()
      const bot = `b-${row.what}`
      if (row.sinceLast) {
        // 先制造一次成功归纳，把 lastRunAt 顶到「刚跑完」
        noteN(h.sched, bot, NOTES_MIN_EVENTS)
        await h.sched.maybeRun(bot)
        expect(h.calls, row.what).toHaveLength(1)
        h.calls.length = 0
        h.tick(row.sinceLast)
      }
      noteN(h.sched, bot, row.events)
      await h.sched.maybeRun(bot)
      expect(h.calls.length > 0, row.what).toBe(row.run)
    }
  })

  it('NS-A2 一件都没攒时直接返回 —— 这是最常被调用的那条路', async () => {
    // 每条值得记的事之后都会调一次 maybeRun，绝大多数时候它什么都不该做，
    // 也不该因此在状态文件里长出一条记录（见 NS-D4）
    const h = makeScheduler()
    await h.sched.maybeRun('scout')
    expect(h.calls).toHaveLength(0)
    expect(existsSync(STATE())).toBe(false)
  })

  it('NS-A3 force 忽略门槛，但仍要求攒了东西（没材料的强制跑没有意义）', async () => {
    const h = makeScheduler()
    noteN(h.sched, 'scout', 1)
    await h.sched.maybeRun('scout', true)
    expect(h.calls).toHaveLength(1)

    const empty = makeScheduler()
    await empty.sched.maybeRun('scout', true)
    expect(empty.calls).toHaveLength(0)
  })

  it('NS-A4 门槛按 bot 各算各的（一个 bot 的活跃不该替另一个开闸）', async () => {
    const h = makeScheduler()
    noteN(h.sched, 'scout', NOTES_MIN_EVENTS)
    noteN(h.sched, 'ranger', 1)
    await h.sched.maybeRun('scout')
    await h.sched.maybeRun('ranger')
    expect(h.calls.map((c) => c.botName)).toEqual(['scout'])
  })

  it('NS-A5 note 记的是「这个会话有增量」，重复记同一条会话不会记出第二个检查点位', () => {
    // 件数与会话是两个维度：三件事都发生在一条会话里，材料仍然只有那一条会话的增量
    const h = makeScheduler()
    noteN(h.sched, 'scout', 3, 's1')
    expect(h.sched.peek('scout')).toMatchObject({ pending: 3, sessions: 1 })
  })

  it('NS-A6 note 记新会话时种一个空检查点 —— 空串 = 这条会话还没归纳过，从头给', async () => {
    const h = makeScheduler()
    h.sched.note('scout', 's1')
    h.sched.note('scout', 's2')
    h.sched.note('scout', 's3')
    await h.sched.maybeRun('scout')
    expect(h.calls[0].dirty).toEqual([
      { sessionId: 's1', sinceEntryId: '' },
      { sessionId: 's2', sinceEntryId: '' },
      { sessionId: 's3', sinceEntryId: '' }
    ])
  })
})

// ─────────────────── NS-B：检查点只在成功之后前进 ───────────────────

/**
 * 这一组守的是**材料不丢**：失败的那一轮下次会看到一模一样的材料，所以整条链路上
 * 不需要任何补偿动作。它同时也是「宿主为什么不能只看 result.ok」那条判断的落点 ——
 * 判据从这里进来的时候已经是一个布尔，谁把它算错，材料就永远埋在那批 entry 里了。
 */
describe('NS-B —— 成功才前进，失败原样重来', () => {
  it('NS-B1 成功：pending 清零、lastRunAt 推到此刻', async () => {
    const h = makeScheduler({ ok: true })
    noteN(h.sched, 'scout', NOTES_MIN_EVENTS)
    await h.sched.maybeRun('scout')
    expect(h.sched.peek('scout')).toMatchObject({ pending: 0, lastRunAt: h.now() })
  })

  it('NS-B2 失败：pending 与 lastRunAt 一个都不动', async () => {
    const h = makeScheduler({ ok: false })
    noteN(h.sched, 'scout', NOTES_MIN_EVENTS)
    await h.sched.maybeRun('scout')
    expect(h.sched.peek('scout')).toMatchObject({ pending: NOTES_MIN_EVENTS, lastRunAt: 0 })
  })

  it('NS-B3 runNotes 抛异常：同样不动，且不往外冒（笔记失败不是任何人的紧急情况）', async () => {
    const h = makeScheduler()
    h.outcome(async () => {
      throw new Error('派不出去')
    })
    noteN(h.sched, 'scout', NOTES_MIN_EVENTS)
    await expect(h.sched.maybeRun('scout')).resolves.toBeUndefined()
    expect(h.sched.peek('scout')).toMatchObject({ pending: NOTES_MIN_EVENTS, lastRunAt: 0 })
  })

  it('NS-B4 失败之后的下一轮拿到的材料与上一轮逐字相同', async () => {
    const h = makeScheduler({ ok: false })
    h.sched.note('scout', 's1')
    h.sched.note('scout', 's2')
    h.sched.note('scout', 's3')
    await h.sched.maybeRun('scout')
    // 失败之后要等满一个退避间隔才会再试 —— 不退避的话 due() 从此恒真，
    // 之后每条消息都触发一次全量重跑（每次都要读遍所有 dirty 会话的树）
    await h.sched.maybeRun('scout')
    expect(h.calls).toHaveLength(1)

    h.tick(NOTES_MIN_INTERVAL_MS)
    await h.sched.maybeRun('scout')
    expect(h.calls).toHaveLength(2)
    // 材料逐字相同：检查点没有前进，这一批下次照样看得见
    expect(h.calls[1].dirty).toEqual(h.calls[0].dirty)
  })

  it('NS-B5 advance 之后同一条会话只给增量（下一轮从上次那条之后开始）', async () => {
    const h = makeScheduler()
    noteN(h.sched, 'scout', NOTES_MIN_EVENTS, 's1')
    await h.sched.maybeRun('scout')
    h.sched.advance('scout', { s1: 'e-42' })

    h.tick(NOTES_MIN_INTERVAL_MS)
    noteN(h.sched, 'scout', NOTES_MIN_EVENTS, 's1')
    await h.sched.maybeRun('scout')
    expect(h.calls[1].dirty).toEqual([{ sessionId: 's1', sinceEntryId: 'e-42' }])
  })

  it('NS-B6 advance 跳过空 entryId —— 「这条会话这轮没有增量」不等于「从头再来」', () => {
    // 宿主对没有新消息的会话根本不给检查点。把空串写进去会把它退回「还没归纳过」，
    // 于是下一轮把整段历史当新材料重灌一遍
    const h = makeScheduler()
    h.sched.advance('scout', { s1: 'e-1' })
    h.sched.advance('scout', { s1: '', s2: 'e-2' })
    const state = readState().scout as { sessions: Record<string, string> }
    expect(state.sessions).toEqual({ s1: 'e-1', s2: 'e-2' })
  })
})

// ────────────────── NS-C：同一个 bot 不重复派发 ──────────────────

describe('NS-C —— 在飞去重', () => {
  /**
   * 让归纳卡住的闸门。**放行是放掉全部在等的那些**，不是最后一个 —— NS-C4 会同时卡住
   * 两个 bot，只留一个 resolver 会让另一条 Promise 永远悬着（表现为一次与被测行为
   * 毫无关系的超时）
   */
  function gated(h: Harness): { release: (ok?: boolean) => void } {
    const waiters: Array<(ok: boolean) => void> = []
    h.outcome(
      () =>
        new Promise<boolean>((r) => {
          waiters.push(r)
        })
    )
    return {
      release: (ok = true) => {
        for (const w of waiters.splice(0)) w(ok)
      }
    }
  }

  it('NS-C1 同一 bot 在飞时的第二次触发不重复派发', async () => {
    // 跨会话串行由 workflow 的分道键兜底，这里省的是一次白跑到引擎门口的空转 ——
    // 那一趟要读遍所有 dirty 会话的树
    const h = makeScheduler()
    const gate = gated(h)
    noteN(h.sched, 'scout', NOTES_MIN_EVENTS)
    const first = h.sched.maybeRun('scout')
    await h.sched.maybeRun('scout')
    expect(h.calls).toHaveLength(1)
    gate.release()
    await first
  })

  it('NS-C2 跑完就释放：下一次（门槛再次满足时）照常派发', async () => {
    const h = makeScheduler()
    const gate = gated(h)
    noteN(h.sched, 'scout', NOTES_MIN_EVENTS)
    const first = h.sched.maybeRun('scout')
    gate.release(true)
    await first

    h.outcome(async () => true)
    h.tick(NOTES_MIN_INTERVAL_MS)
    noteN(h.sched, 'scout', NOTES_MIN_EVENTS)
    await h.sched.maybeRun('scout')
    expect(h.calls).toHaveLength(2)
  })

  it('NS-C3 抛异常也释放（finally）—— 否则一次故障就把这个 bot 永久锁死', async () => {
    const h = makeScheduler()
    h.outcome(async () => {
      throw new Error('boom')
    })
    noteN(h.sched, 'scout', NOTES_MIN_EVENTS)
    await h.sched.maybeRun('scout')
    // 抛异常同样走退避（它是一次失败的尝试）——所以这里推时钟，钉的是「锁被释放了」
    // 而不是「立刻又跑一次」
    h.tick(NOTES_MIN_INTERVAL_MS)
    await h.sched.maybeRun('scout')
    expect(h.calls).toHaveLength(2)
  })

  it('NS-C4 去重是 per-bot：另一个 bot 不被在飞的这个挡住', async () => {
    const h = makeScheduler()
    const gate = gated(h)
    noteN(h.sched, 'scout', NOTES_MIN_EVENTS)
    noteN(h.sched, 'ranger', NOTES_MIN_EVENTS)
    const first = h.sched.maybeRun('scout')
    const second = h.sched.maybeRun('ranger')
    expect(h.calls.map((c) => c.botName)).toEqual(['scout', 'ranger'])
    gate.release()
    await Promise.all([first, second])
  })
})

// ────────────────────────── NS-D：状态文件 ──────────────────────────

describe('NS-D —— 状态落盘', () => {
  it('NS-D1 落点是 bots 目录下点号开头的 .notes-state.json（注册表扫不到它）', async () => {
    const h = makeScheduler()
    noteN(h.sched, 'scout', NOTES_MIN_EVENTS)
    await h.sched.maybeRun('scout')
    expect(existsSync(STATE())).toBe(true)
    expect(readState()).toHaveProperty('scout')
  })

  it('NS-D2 新实例从盘上接着算 —— 「重启补扫」不是另一条路径，就是同一个检查点', async () => {
    const first = makeScheduler()
    noteN(first.sched, 'scout', NOTES_MIN_EVENTS)
    await first.sched.maybeRun('scout')
    first.sched.advance('scout', { s1: 'e-9' })

    // 进程重启：新实例、新时钟，只有盘上那份状态是共同的
    const restarted = makeScheduler()
    noteN(restarted.sched, 'scout', NOTES_MIN_EVENTS, 's1')
    // 上次归纳的时刻同样是持久的 —— 重启不该成为绕开时间门槛的办法
    await restarted.sched.maybeRun('scout')
    expect(restarted.calls).toHaveLength(0)

    restarted.tick(NOTES_MIN_INTERVAL_MS)
    await restarted.sched.maybeRun('scout')
    expect(restarted.calls[0].dirty).toEqual([{ sessionId: 's1', sinceEntryId: 'e-9' }])
  })

  it('NS-D3 坏 JSON 当空状态继续 —— 一份坏文件不该让笔记整个停摆', async () => {
    writeFileSync(STATE(), '{ 这不是 JSON')
    const h = makeScheduler()
    expect(h.sched.peek('scout')).toEqual({ pending: 0, lastRunAt: 0, sessions: 0 })
    noteN(h.sched, 'scout', NOTES_MIN_EVENTS)
    await h.sched.maybeRun('scout')
    expect(h.calls).toHaveLength(1)
  })

  it('NS-D4 note 只记账不落盘（一次密集对话不该每件事都写一次盘）', () => {
    // 真正需要持久的是检查点，而它只在归纳成功时前进 —— 那时才落盘。进程崩了最多丢掉
    // 「攒了几件」这个计数，下次对话很快会重新攒够
    const h = makeScheduler()
    noteN(h.sched, 'scout', 2)
    expect(existsSync(STATE())).toBe(false)
  })

  it('NS-D5 peek 不在读路径上种状态（看一眼不该让文件长出一个从没归纳过的 bot）', async () => {
    const h = makeScheduler()
    expect(h.sched.peek('never-seen')).toEqual({ pending: 0, lastRunAt: 0, sessions: 0 })
    // 让一次真正的落盘发生，再看那份状态里有没有混进被 peek 过的名字
    noteN(h.sched, 'scout', NOTES_MIN_EVENTS)
    await h.sched.maybeRun('scout')
    expect(Object.keys(readState())).toEqual(['scout'])
  })
})

// ──────────── NS-E：改名、删会话、退出前 flush ────────────

describe('NS-E —— 改名 / 删会话 / flushAll', () => {
  it('NS-E1 rename 整条搬过去（计数、上次时刻、全部检查点）', async () => {
    const h = makeScheduler()
    noteN(h.sched, 'scout', NOTES_MIN_EVENTS)
    await h.sched.maybeRun('scout')
    h.sched.advance('scout', { s1: 'e-1' })
    h.sched.note('scout', 's2')

    h.sched.rename('scout', 'ranger')
    expect(h.sched.peek('scout')).toEqual({ pending: 0, lastRunAt: 0, sessions: 0 })
    expect(h.sched.peek('ranger')).toMatchObject({ pending: 1, lastRunAt: h.now(), sessions: 2 })
    expect(Object.keys(readState())).toEqual(['ranger'])
  })

  it('NS-E2 rename 幂等：新名字已有状态就不覆盖（迁移做了一半重来不该抹掉已跑过的）', () => {
    // 后写的一方赢会把 ranger 已经跑过的归纳记录冲掉，于是同一批材料被归纳两遍
    const h = makeScheduler()
    h.sched.advance('scout', { s1: 'from-scout' })
    h.sched.advance('ranger', { s1: 'from-ranger' })

    h.sched.rename('scout', 'ranger')
    const state = readState() as Record<string, { sessions: Record<string, string> }>
    expect(state.ranger.sessions.s1).toBe('from-ranger')
    // 源也没被删 —— 什么都没做才是幂等
    expect(state.scout.sessions.s1).toBe('from-scout')
  })

  it('NS-E3 rename 源不存在 → 什么都不做（补做迁移时正常会走到这一支）', () => {
    const h = makeScheduler()
    h.sched.rename('ghost', 'ranger')
    expect(existsSync(STATE())).toBe(false)
    expect(h.sched.peek('ranger')).toEqual({ pending: 0, lastRunAt: 0, sessions: 0 })
  })

  it('NS-E4 forgetSession 抹掉所有 bot 上的这条检查点', () => {
    // 会话删了，它的检查点没有意义了；留着只会让状态文件无限长
    const h = makeScheduler()
    h.sched.advance('scout', { s1: 'e-1', s2: 'e-2' })
    h.sched.advance('ranger', { s1: 'e-3' })

    h.sched.forgetSession('s1')
    const state = readState() as Record<string, { sessions: Record<string, string> }>
    expect(state.scout.sessions).toEqual({ s2: 'e-2' })
    expect(state.ranger.sessions).toEqual({})
  })

  it('NS-E5 forgetSession 没命中就不落盘（删一条与笔记无关的会话不该刷一次盘）', () => {
    const h = makeScheduler()
    h.sched.advance('scout', { s1: 'e-1' })
    rmSync(STATE(), { force: true })
    h.sched.forgetSession('s-unrelated')
    expect(existsSync(STATE())).toBe(false)
  })

  it('NS-E6 flushAll 只跑攒了东西的 bot，且忽略门槛', async () => {
    const h = makeScheduler()
    noteN(h.sched, 'scout', 1) // 远不够门槛
    h.sched.advance('ranger', { s1: 'e-1' }) // 有状态但 pending = 0
    await h.sched.flushAll()
    expect(h.calls.map((c) => c.botName)).toEqual(['scout'])
  })

  it('NS-E7 flushAll 逐个跑完（一个 bot 失败不该让后面的都不跑）', async () => {
    const h = makeScheduler()
    h.outcome(async (botName) => botName !== 'scout')
    noteN(h.sched, 'scout', 1)
    noteN(h.sched, 'ranger', 1)
    await h.sched.flushAll()
    expect(h.calls.map((c) => c.botName).sort()).toEqual(['ranger', 'scout'])
  })

  it('NS-E8 flushAll 今天没有生产调用方 —— 退出前 flush 已被整条拿掉', () => {
    /**
     * 钉的是一个**决定**而不是一段代码：`before-quit` 那一刻窗口正在销毁，
     * `hasUserInputCapability` 已是 false，于是笔记段第一步的写盘询问卡当场取消 →
     * edit 失败 → run 失败。那条 flush 只白烧一次 LLM 调用，材料却一点没多写
     * （检查点只在成功后前进，下次启动照样看得见）。
     *
     * 方法留着是因为它本身没错，要让退出前归纳真的成立，缺的是一条免询问的路径 ——
     * 而那是用户该自己决定的事。有人把调用加回来时，这条会红并把上面这段话递给他。
     */
    const here = dirname(fileURLToPath(import.meta.url))
    const sources = ['../../../index.ts', '../../botService.ts'].map((rel) =>
      readFileSync(resolve(here, rel), 'utf-8')
    )
    for (const src of sources) {
      expect(src).not.toMatch(/flushNotes|flushAll/)
    }
    // 不空转的保证：这两份源文件确实是「会调笔记调度的那两份」
    expect(sources[1]).toContain('BotNotesScheduler')
  })
})
