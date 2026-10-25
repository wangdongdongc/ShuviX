/**
 * bot 触发分发 —— `BotTriggerService.fire`（全局埋点 → 命中的 bot 绑定 → 新开一条 bot 会话发一条来源 `trigger` 的消息）。
 *
 * 契约（botTriggerService.ts 文件头 + 2026-10-24 的修订）：
 *  - 命中（无 `when` 或 `when` 为真）→ `sessionService.create({bot, title: '<显示名> · MM-DD HH:MM'})` → `ensureAgentSession`
 *    → `agent.prompt(message + <trigger_event> 围栏, …, origin)`；`fire` 本身同步返回，不等运行；
 *  - 同一条绑定上一次还在跑（prompt 没交回）→ 跳过这次；绑定之间、bot 之间互不阻塞；
 *  - `lastFiredAt`：设置 `triggers.bot.lastFired`（`{<objectId ?? name>#<index>#<trigger>: firedAt}`），**只在那一轮
 *    正常结束（prompt 没带 error）后**才往前推；上一次的值以本机时区偏移的 ISO（`localIso`）放进围栏；会话打不开、
 *    prompt 带 error / 抛错都不推；
 *  - `when` 求值出错 = 不命中，同一条绑定同一个错误只记一次 warn；
 *  - 一次运行（会话打开了）结束后提交一次跟踪项目录（commitTrackingChanges）。
 *
 * 触发日志（触发源与 bot 解绑，用户 2026-10-24；断言打在 triggerLogService 桩的调用上）：
 *   BTL-1  命中（无 when）：会话建出来之后、打开之前记一条 started（sourceId / trigger / bot / 显示名 / 文件名 /
 *          序号 / when '' / 会话 id / 原始事件）；prompt 交回之前不 finish，交回后 finish(id, 'completed')
 *   BTL-2  第二条绑定命中：bindingIndex 1、when 原文、botFile 取 basePath 的文件名；没命中的第一条不记
 *   BTL-3  不命中（when 为假、别的埋点、没有绑定）一条都不记
 *   BTL-4  会话打不开 → finish(id, 'failed', 'The run session could not be opened')
 *   BTL-5  prompt 带 error → finish(id, 'failed', error)
 *   BTL-6  prompt 抛错 → finish(id, 'failed', message)；抛的不是 Error → String()
 *   BTL-7  会话建不出来 → 记一条 failed（sessionId ''，error = 原因），不 finish；下一次照跑
 *   BTL-8  上一次还在跑 → 记一条 skipped（sessionId ''、这一次的事件）；跑完之后下一次又是 started
 *   BTL-9  when 求值出错 → condition-error（CEL 的报错）：同一个错误只记一次；换一个错误再记；出错 → 成功（假）→
 *          同一个错误又记；成功的求值（真或假）本身不记 condition-error
 *   BTL-10 记下的 event 是 `when` 看到的那个（载荷 + trigger）：不带围栏里的 lastFiredAt；没有 sourceId → ''
 *   BTL-11 一次 tick 命中几条绑定就记几条，各带自己的 bot / 序号 / 会话；finish 用各自的 id
 *   BTL-12 记日志失败（record 交回 null）不挡运行：照样 prompt、finish(null, …)、lastFired 照推
 *
 * mock 面：botService（listAll 给什么就是什么）、sessionService、settingsService（内存表）、trackingNotes、
 * triggerLogService（record / finish 两个桩）、logger。
 * `evaluateWhen` / `renderEventPrompt` / `setWhenHostFunctions` 是真的 —— CEL 的上下文、宿主函数、围栏都按真实走。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { setWhenHostFunctions, type BotBinding } from '@shuvix/agent-runtime'
import type { BotEntry } from '../botService'

const mocks = vi.hoisted(() => ({
  listAll: vi.fn<() => unknown[]>(),
  create: vi.fn<(input: Record<string, unknown>) => { id: string }>(),
  ensure: vi.fn<(id: string) => Promise<unknown>>(),
  prompt: vi.fn<(...args: unknown[]) => Promise<{ error?: string }>>(),
  commit: vi.fn<(message: string) => Promise<void>>(),
  record: vi.fn<(input: Record<string, unknown>) => string | null>(),
  finish: vi.fn<(id: string | null, outcome: string, error?: string) => void>(),
  settings: new Map<string, string>(),
  info: vi.fn(),
  warn: vi.fn()
}))

vi.mock('../botService', () => ({ botService: { listAll: mocks.listAll } }))
vi.mock('../sessionService', () => ({
  sessionService: { create: mocks.create, ensureAgentSession: mocks.ensure }
}))
vi.mock('../settingsService', () => ({
  settingsService: {
    get: (key: string) => mocks.settings.get(key),
    set: (key: string, value: string) => void mocks.settings.set(key, value)
  }
}))
vi.mock('../trackingNotes', () => ({ commitTrackingChanges: mocks.commit }))
// 触发日志：桩掉免得拉起数据库（服务本身的用例在 triggerLogService.test）；BTL-* 断言桩的调用
vi.mock('../triggerLogService', () => ({
  triggerLogService: { record: mocks.record, finish: mocks.finish }
}))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: mocks.info, warn: mocks.warn, error: vi.fn(), debug: vi.fn() })
}))

import {
  BotTriggerService,
  LAST_FIRED_KEY,
  TRIGGER_EVENT_TAG,
  bindingKey,
  localIso
} from '../botTriggerService'
import { timerPayloadAt } from '../triggerTimer'

const TICK: BotBinding = { trigger: 'timer.fired', message: 'Tick check-in.' }
const DAILY_WHEN = "event.local.time == '18:00' && activeSessions(event.local.date) > 0"

function bot(
  name: string,
  bindings: BotBinding[] | undefined,
  opts: { displayName?: string; objectId?: string } = {}
): BotEntry {
  return {
    file: {
      name,
      ...(opts.objectId ? { objectId: opts.objectId } : {}),
      displayName: opts.displayName ?? name,
      description: '',
      body: '',
      ...(bindings ? { bindings } : {})
    },
    basePath: `/bots/${name}.md`
  }
}

/** 2026-10-<d> 的本地 h:mi 那一分钟的 timer 事件 */
function minute(h: number, mi: number, d = 24): ReturnType<typeof timerPayloadAt> {
  return timerPayloadAt(new Date(2026, 9, d, h, mi))
}

/** 等派发里的 await 链（ensureAgentSession → prompt → commit）走完 */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
} {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** 第 i 次 prompt 的消息文本 */
function promptText(i: number): string {
  return mocks.prompt.mock.calls[i][0] as string
}

/** 消息里的事件围栏 → YAML 解析出来的 payload */
function fenceOf(text: string): Record<string, unknown> {
  const open = `<${TRIGGER_EVENT_TAG} trigger="timer.fired">\n`
  const close = `\n</${TRIGGER_EVENT_TAG}>`
  const start = text.indexOf(open)
  expect(start, text).toBeGreaterThanOrEqual(0)
  expect(text.endsWith(close), text).toBe(true)
  return parseYaml(text.slice(start + open.length, text.length - close.length)) as Record<
    string,
    unknown
  >
}

function lastFired(): Record<string, string> | undefined {
  const raw = mocks.settings.get(LAST_FIRED_KEY)
  return raw === undefined ? undefined : (JSON.parse(raw) as Record<string, string>)
}

function warnsMatching(re: RegExp): string[] {
  return mocks.warn.mock.calls.map((c) => String(c[0])).filter((m) => re.test(m))
}

let svc: BotTriggerService
let seq = 0
let logSeq = 0

beforeEach(() => {
  seq = 0
  logSeq = 0
  mocks.settings.clear()
  for (const m of [
    mocks.listAll,
    mocks.create,
    mocks.ensure,
    mocks.prompt,
    mocks.commit,
    mocks.record,
    mocks.finish
  ]) {
    m.mockReset()
  }
  mocks.record.mockImplementation(() => `log-${++logSeq}`)
  mocks.info.mockReset()
  mocks.warn.mockReset()
  mocks.create.mockImplementation(() => ({ id: `s-${++seq}` }))
  mocks.ensure.mockImplementation(async () => ({ prompt: mocks.prompt }))
  mocks.prompt.mockResolvedValue({})
  mocks.commit.mockResolvedValue(undefined)
  svc = new BotTriggerService()
})

afterEach(() => {
  setWhenHostFunctions({})
  vi.useRealTimers()
})

describe('派发的形状', () => {
  it('BT-1 无 when 的绑定：新建绑定该 bot 的会话（标题 = 显示名 · 本地时间，无项目无父）→ 打开 → prompt(消息 + 围栏, …, trigger 来源)', async () => {
    mocks.listAll.mockReturnValue([
      bot('ticker', [TICK], { displayName: 'Ticker', objectId: 'bot:x' })
    ])
    const p = minute(18, 0)
    svc.fire('timer.fired', p)
    await settle()

    expect(mocks.create).toHaveBeenCalledTimes(1)
    expect(mocks.create.mock.calls[0][0]).toStrictEqual({
      bot: 'ticker',
      title: 'Ticker · 10-24 18:00'
    })
    expect(mocks.ensure).toHaveBeenCalledWith('s-1')
    expect(mocks.prompt).toHaveBeenCalledTimes(1)
    const args = mocks.prompt.mock.calls[0]
    expect(args).toHaveLength(5)
    expect(args.slice(1, 4)).toEqual([undefined, undefined, undefined])
    expect(args[4]).toStrictEqual({
      kind: 'trigger',
      trigger: 'timer.fired',
      sourceId: 'timer:builtin:minute',
      bot: 'ticker'
    })
    const text = promptText(0)
    expect(text.startsWith('Tick check-in.\n\n<trigger_event trigger="timer.fired">\n')).toBe(true)
    // 围栏里就是事件 payload（trigger 在属性上，不在 YAML 里；第一次没有 lastFiredAt）
    expect(fenceOf(text)).toStrictEqual(p)
  })

  it('BT-2 when 门控：假 → 什么都不做；真 → 一次运行；CEL 看得到 event.trigger、event.local.*、env.host', async () => {
    const when =
      "event.trigger == 'timer.fired' && event.local.date == '2026-10-24' && event.local.time == '18:00' && env.host == 'desktop' && has(event.firedAt)"
    mocks.listAll.mockReturnValue([
      bot('gated', [{ ...TICK, when }]),
      bot('never', [{ ...TICK, when: 'false' }])
    ])
    svc.fire('timer.fired', minute(17, 59))
    await settle()
    expect(mocks.create).not.toHaveBeenCalled()

    svc.fire('timer.fired', minute(18, 0))
    await settle()
    expect(mocks.create).toHaveBeenCalledTimes(1)
    expect(mocks.create.mock.calls[0][0]).toMatchObject({ bot: 'gated' })
    expect(mocks.prompt).toHaveBeenCalledTimes(1)
    expect(mocks.warn).not.toHaveBeenCalled()
  })

  it('BT-3 绑在别的 / 不认识的埋点上的绑定从不派发', async () => {
    mocks.listAll.mockReturnValue([
      bot('other', [
        { trigger: 'webhook.received', message: 'hook' },
        { trigger: 'session.turn-completed', message: 'turn' }
      ]),
      bot('nobindings', undefined)
    ])
    svc.fire('timer.fired', minute(18, 0))
    await settle()
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.prompt).not.toHaveBeenCalled()
  })
})

describe('lastFiredAt —— 每条绑定上一次跑成的时刻', () => {
  it('BT-4 第一次围栏没有 lastFiredAt；跑成后设置记 {键: firedAt}；第二次围栏带 localIso(上一次)；重启（新实例）照样看得到', async () => {
    const ticker = bot('ticker', [TICK], { objectId: 'bot:x' })
    mocks.listAll.mockReturnValue([ticker])
    const first = minute(18, 0)
    svc.fire('timer.fired', first)
    await settle()
    expect(fenceOf(promptText(0))).not.toHaveProperty('lastFiredAt')
    expect(lastFired()).toStrictEqual({ 'bot:x#0#timer.fired': first.firedAt })

    const second = minute(18, 1)
    svc.fire('timer.fired', second)
    await settle()
    const fence = fenceOf(promptText(1))
    expect(fence.lastFiredAt).toBe(localIso(new Date(first.firedAt)))
    // 本地日期就是那一刻的本地日（带偏移，不是 Z）
    expect(fence.lastFiredAt).toMatch(/^2026-10-24T18:00:00[+-]\d{2}:\d{2}$/)
    expect(fence.firedAt).toBe(second.firedAt)
    expect(lastFired()).toStrictEqual({ 'bot:x#0#timer.fired': second.firedAt })

    // 重启：新实例、同一张设置表
    const restarted = new BotTriggerService()
    restarted.fire('timer.fired', minute(18, 2))
    await settle()
    expect(fenceOf(promptText(2)).lastFiredAt).toBe(localIso(new Date(second.firedAt)))
  })

  it('BT-5 绑定键 = <objectId ?? name>#<序号>#timer.fired：有 id 的 bot 改名后 lastFired 还在；（pin）没 id 的改名就丢了', async () => {
    const withId = bot('ticker', [TICK], { objectId: 'bot:x' })
    const noId = bot('plain', [{ trigger: 'webhook.received', message: 'x' }, TICK])
    expect(bindingKey(withId, 0, 'timer.fired')).toBe('bot:x#0#timer.fired')
    expect(bindingKey(noId, 1, 'timer.fired')).toBe('plain#1#timer.fired')

    mocks.listAll.mockReturnValue([withId, noId])
    const first = minute(9, 0)
    svc.fire('timer.fired', first)
    await settle()
    expect(lastFired()).toStrictEqual({
      'bot:x#0#timer.fired': first.firedAt,
      'plain#1#timer.fired': first.firedAt
    })

    // 两个都改了名
    mocks.listAll.mockReturnValue([
      bot('ticker2', [TICK], { objectId: 'bot:x' }),
      bot('plain2', [{ trigger: 'webhook.received', message: 'x' }, TICK])
    ])
    svc.fire('timer.fired', minute(9, 1))
    await settle()
    const byBot = new Map(
      mocks.create.mock.calls.slice(2).map((c, i) => [c[0].bot, fenceOf(promptText(2 + i))])
    )
    expect(byBot.get('ticker2')?.lastFiredAt).toBe(localIso(new Date(first.firedAt)))
    expect(byBot.get('plain2')).not.toHaveProperty('lastFiredAt')
  })

  it('BT-10 写坏的 triggers.bot.lastFired（"{" / "[]" / "\\"x\\""）按空表；非字符串的值丢掉、别的键写回时保留；解析不出时刻的值不进围栏', async () => {
    mocks.listAll.mockReturnValue([bot('ticker', [TICK], { objectId: 'bot:x' })])
    let m = 0
    for (const corrupt of ['{', '[]', '"x"']) {
      mocks.settings.set(LAST_FIRED_KEY, corrupt)
      const p = minute(10, m++)
      svc.fire('timer.fired', p)
      await settle()
      expect(fenceOf(promptText(mocks.prompt.mock.calls.length - 1)), corrupt).not.toHaveProperty(
        'lastFiredAt'
      )
      expect(lastFired(), corrupt).toStrictEqual({ 'bot:x#0#timer.fired': p.firedAt })
    }

    mocks.settings.set(
      LAST_FIRED_KEY,
      JSON.stringify({
        'other#0#timer.fired': '2026-10-23T10:00:00.000Z',
        bad: 5,
        'bot:x#0#timer.fired': 'not a date'
      })
    )
    const p = minute(11, 0)
    svc.fire('timer.fired', p)
    await settle()
    expect(fenceOf(promptText(mocks.prompt.mock.calls.length - 1))).not.toHaveProperty(
      'lastFiredAt'
    )
    expect(lastFired()).toStrictEqual({
      'other#0#timer.fired': '2026-10-23T10:00:00.000Z',
      'bot:x#0#timer.fired': p.firedAt
    })
  })
})

describe('在跑就跳过；绑定之间互不阻塞', () => {
  it('BT-6 prompt 还没交回 → 下一次不建会话、记「previous run still going」；交回后下一次照跑；prompt 抛错同样清掉在跑标记', async () => {
    const ticker = bot('ticker', [TICK], { objectId: 'bot:x' })
    const key = bindingKey(ticker, 0, 'timer.fired')
    mocks.listAll.mockReturnValue([ticker])
    const first = deferred<{ error?: string }>()
    mocks.prompt.mockReturnValueOnce(first.promise)

    svc.fire('timer.fired', minute(18, 0))
    await settle()
    expect(svc.isRunning(key)).toBe(true)

    svc.fire('timer.fired', minute(18, 1))
    await settle()
    expect(mocks.create).toHaveBeenCalledTimes(1)
    expect(mocks.info.mock.calls.map((c) => String(c[0]))).toContainEqual(
      expect.stringContaining('skipped: previous run still going')
    )

    first.resolve({})
    await settle()
    expect(svc.isRunning(key)).toBe(false)
    mocks.prompt.mockRejectedValueOnce(new Error('kaput'))
    svc.fire('timer.fired', minute(18, 2))
    await settle()
    expect(mocks.create).toHaveBeenCalledTimes(2)
    expect(svc.isRunning(key)).toBe(false)

    svc.fire('timer.fired', minute(18, 3))
    await settle()
    expect(mocks.create).toHaveBeenCalledTimes(3)
  })

  it('BT-7 同一 bot 的两条绑定、两个 bot 并行跑；一条在跑不挡另一条', async () => {
    const a = bot('a', [TICK, { trigger: 'timer.fired', message: 'second' }], { objectId: 'bot:a' })
    const b = bot('b', [TICK], { objectId: 'bot:b' })
    mocks.listAll.mockReturnValue([a, b])
    // 每条会话一个挂起的 prompt（按会话 id 记）
    const runs = new Map<
      string,
      { text: string; run: ReturnType<typeof deferred<{ error?: string }>> }
    >()
    mocks.ensure.mockImplementation(async (id: string) => ({
      prompt: (text: string) => {
        const run = deferred<{ error?: string }>()
        runs.set(id, { text, run })
        return run.promise
      }
    }))
    svc.fire('timer.fired', minute(18, 0))
    await settle()
    // 建会话是同步段，按 bot、按绑定的顺序：s-1 = a#0，s-2 = a#1，s-3 = b#0
    expect(mocks.create.mock.calls.map((c) => c[0].bot)).toEqual(['a', 'a', 'b'])
    expect([...runs.keys()].sort()).toEqual(['s-1', 's-2', 's-3'])
    expect(svc.isRunning('bot:a#0#timer.fired')).toBe(true)
    expect(svc.isRunning('bot:a#1#timer.fired')).toBe(true)
    expect(svc.isRunning('bot:b#0#timer.fired')).toBe(true)

    // 只放掉 a#1 与 b#0；a#0 还在跑
    runs.get('s-2')!.run.resolve({})
    runs.get('s-3')!.run.resolve({})
    await settle()
    svc.fire('timer.fired', minute(18, 1))
    await settle()
    expect(mocks.create.mock.calls.slice(3).map((c) => c[0].bot)).toEqual(['a', 'b'])
    expect(runs.get('s-4')!.text.startsWith('second\n\n')).toBe(true)
    expect(runs.get('s-5')!.text.startsWith('Tick check-in.\n\n')).toBe(true)
    expect(svc.isRunning('bot:a#0#timer.fired')).toBe(true)
    for (const { run } of runs.values()) run.resolve({})
    await settle()
  })

  it('BT-16 （pin）两个 bot 共用一个 shuvix-id（拷贝出来的文件）撞同一个键：第一个在跑时第二个被跳过；跑完共用同一个 lastFiredAt', async () => {
    // 原件只在 18:00 命中，拷贝每分钟都命中
    const original = bot('daily', [{ ...TICK, when: "event.local.time == '18:00'" }], {
      objectId: 'bot:builtin:daily'
    })
    const copy = bot('daily-copy', [TICK], { objectId: 'bot:builtin:daily' })
    mocks.listAll.mockReturnValue([original, copy])
    const run = deferred<{ error?: string }>()
    mocks.prompt.mockReturnValueOnce(run.promise)
    const first = minute(18, 0)
    svc.fire('timer.fired', first)
    await settle()
    // 原件起跑同步占住了键：拷贝被当成「上一次还在跑」跳过
    expect(mocks.create.mock.calls.map((c) => c[0].bot)).toEqual(['daily'])
    expect(mocks.info.mock.calls.map((c) => String(c[0]))).toContainEqual(
      expect.stringContaining('bot "daily-copy" binding 0 (timer.fired) skipped')
    )
    run.resolve({})
    await settle()
    expect(lastFired()).toStrictEqual({ 'bot:builtin:daily#0#timer.fired': first.firedAt })

    // 18:01 只有拷贝命中：它看到的是原件那次的 lastFiredAt
    svc.fire('timer.fired', minute(18, 1))
    await settle()
    expect(mocks.create.mock.calls.slice(1).map((c) => c[0].bot)).toEqual(['daily-copy'])
    expect(fenceOf(promptText(1)).lastFiredAt).toBe(localIso(new Date(first.firedAt)))
  })
})

describe('when 求值出错与宿主函数', () => {
  it('BT-8 同一个错误连着几分钟只记一次 warn；换一个错误再记一次；（pin）出错 → 成功 → 同一个错误又记一次；出错按不命中', async () => {
    let behaviour: string | number = 'error A'
    setWhenHostFunctions({
      activeSessions: () => {
        if (typeof behaviour === 'string') throw new Error(behaviour)
        return behaviour
      }
    })
    mocks.listAll.mockReturnValue([
      bot('flaky', [{ ...TICK, when: 'activeSessions(event.local.date) > 0' }])
    ])
    const whenWarns = (): string[] => warnsMatching(/when evaluation failed/)

    svc.fire('timer.fired', minute(18, 0))
    svc.fire('timer.fired', minute(18, 1))
    await settle()
    expect(whenWarns()).toHaveLength(1)
    expect(whenWarns()[0]).toContain('error A')
    expect(whenWarns()[0]).toContain('bot "flaky"')
    expect(mocks.create).not.toHaveBeenCalled()

    behaviour = 'error B'
    svc.fire('timer.fired', minute(18, 2))
    await settle()
    expect(whenWarns()).toHaveLength(2)
    expect(whenWarns()[1]).toContain('error B')

    behaviour = 1
    svc.fire('timer.fired', minute(18, 3))
    await settle()
    expect(mocks.create).toHaveBeenCalledTimes(1)

    behaviour = 'error B'
    svc.fire('timer.fired', minute(18, 4))
    await settle()
    expect(whenWarns()).toHaveLength(3)
    expect(mocks.create).toHaveBeenCalledTimes(1)
  })

  it('BT-9 宿主函数：activeSessions 返回 0 → 不跑；2 → 跑（收到的是事件的本地日）；没注入 → 不跑、记一次 warn', async () => {
    const impl = vi.fn<(date: string) => number>().mockReturnValue(0)
    setWhenHostFunctions({ activeSessions: impl })
    mocks.listAll.mockReturnValue([
      bot('daily', [{ ...TICK, when: DAILY_WHEN }], { objectId: 'bot:builtin:daily' })
    ])

    svc.fire('timer.fired', minute(17, 59))
    await settle()
    expect(impl).not.toHaveBeenCalled()

    svc.fire('timer.fired', minute(18, 0))
    await settle()
    expect(impl).toHaveBeenCalledWith('2026-10-24')
    expect(mocks.create).not.toHaveBeenCalled()

    impl.mockReturnValue(2)
    svc.fire('timer.fired', minute(18, 0, 25))
    await settle()
    expect(impl).toHaveBeenLastCalledWith('2026-10-25')
    expect(mocks.create).toHaveBeenCalledTimes(1)

    setWhenHostFunctions({})
    svc.fire('timer.fired', minute(18, 0, 26))
    svc.fire('timer.fired', minute(18, 0, 27))
    await settle()
    expect(mocks.create).toHaveBeenCalledTimes(1)
    const warns = warnsMatching(/when evaluation failed/)
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('not available on this host')
  })
})

describe('失败的运行', () => {
  it('BT-11 会话打不开（ensureAgentSession → null）：warn、不 prompt、不提交、清掉在跑标记、lastFired 不往前推', async () => {
    const ticker = bot('ticker', [TICK], { objectId: 'bot:x' })
    mocks.listAll.mockReturnValue([ticker])
    mocks.ensure.mockResolvedValueOnce(null)
    svc.fire('timer.fired', minute(18, 0))
    await settle()

    expect(mocks.create).toHaveBeenCalledTimes(1)
    expect(mocks.prompt).not.toHaveBeenCalled()
    expect(mocks.commit).not.toHaveBeenCalled()
    expect(warnsMatching(/could not be opened/)).toEqual([
      expect.stringContaining('session s-1 could not be opened')
    ])
    expect(svc.isRunning(bindingKey(ticker, 0, 'timer.fired'))).toBe(false)
    expect(lastFired()).toBeUndefined()

    // 下一分钟照跑，围栏里仍没有 lastFiredAt（失败的那次不算）
    svc.fire('timer.fired', minute(18, 1))
    await settle()
    expect(mocks.prompt).toHaveBeenCalledTimes(1)
    expect(fenceOf(promptText(0))).not.toHaveProperty('lastFiredAt')
  })

  it('BT-12 prompt 带 error → warn、照样提交、lastFired 不往前推；prompt 抛错同理 —— 下一次围栏仍是上一次跑成的时刻', async () => {
    mocks.listAll.mockReturnValue([
      bot('ticker', [TICK], { displayName: 'Ticker', objectId: 'bot:x' })
    ])
    const ok = minute(18, 0)
    svc.fire('timer.fired', ok)
    await settle()
    expect(lastFired()).toStrictEqual({ 'bot:x#0#timer.fired': ok.firedAt })

    mocks.prompt.mockResolvedValueOnce({ error: 'model refused' })
    svc.fire('timer.fired', minute(18, 1))
    await settle()
    expect(warnsMatching(/failed: model refused/)).toEqual([
      expect.stringContaining('run in s-2 failed: model refused')
    ])
    expect(mocks.commit).toHaveBeenCalledTimes(2)
    expect(lastFired()).toStrictEqual({ 'bot:x#0#timer.fired': ok.firedAt })

    mocks.prompt.mockRejectedValueOnce(new Error('socket hang up'))
    svc.fire('timer.fired', minute(18, 2))
    await settle()
    expect(warnsMatching(/trigger run failed: socket hang up/)).toHaveLength(1)
    expect(mocks.commit).toHaveBeenCalledTimes(3)
    expect(lastFired()).toStrictEqual({ 'bot:x#0#timer.fired': ok.firedAt })

    svc.fire('timer.fired', minute(18, 3))
    await settle()
    expect(fenceOf(promptText(3)).lastFiredAt).toBe(localIso(new Date(ok.firedAt)))
  })

  it('BT-13 每次打开了会话的运行提交一次跟踪项目录，消息含显示名、时间与会话 id', async () => {
    mocks.listAll.mockReturnValue([
      bot('ticker', [TICK], { displayName: 'Ticker', objectId: 'bot:x' })
    ])
    svc.fire('timer.fired', minute(18, 0))
    await settle()
    svc.fire('timer.fired', minute(18, 1))
    await settle()
    expect(mocks.commit).toHaveBeenCalledTimes(2)
    const [m1, m2] = mocks.commit.mock.calls.map((c) => c[0])
    for (const part of ['Ticker', '10-24 18:00', 's-1']) expect(m1).toContain(part)
    for (const part of ['Ticker', '10-24 18:01', 's-2']) expect(m2).toContain(part)
  })

  it('BT-14 botService.listAll 抛错 → warn，fire 不抛', () => {
    mocks.listAll.mockImplementation(() => {
      throw new Error('EACCES')
    })
    expect(() => svc.fire('timer.fired', minute(18, 0))).not.toThrow()
    expect(warnsMatching(/listing bots failed — EACCES/)).toHaveLength(1)
    expect(mocks.create).not.toHaveBeenCalled()
  })
})

describe('fire 是同步的', () => {
  it('BT-15 fire 在 prompt 交回之前就返回；事件没有 local → 标题按此刻的本地时间，没有 firedAt / sourceId 时照跑', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 0, 5, 7, 3, 21))
    const ticker = bot('ticker', [TICK], { displayName: 'Ticker', objectId: 'bot:x' })
    mocks.listAll.mockReturnValue([ticker])
    const run = deferred<{ error?: string }>()
    mocks.prompt.mockReturnValueOnce(run.promise)

    const ret = svc.fire('timer.fired', { sourceId: 'timer:test' } as unknown as ReturnType<
      typeof minute
    >)
    expect(ret).toBeUndefined()
    // 同步段已走完：在跑、会话已建，prompt 还没调到
    expect(svc.isRunning(bindingKey(ticker, 0, 'timer.fired'))).toBe(true)
    expect(mocks.create.mock.calls[0][0]).toStrictEqual({
      bot: 'ticker',
      title: 'Ticker · 01-05 07:03'
    })
    expect(mocks.prompt).not.toHaveBeenCalled()

    await settle()
    expect(mocks.prompt).toHaveBeenCalledTimes(1)
    expect(mocks.commit).not.toHaveBeenCalled()
    run.resolve({})
    await settle()
    expect(mocks.commit).toHaveBeenCalledTimes(1)
    // 没有 firedAt：记此刻
    expect(lastFired()).toStrictEqual({
      'bot:x#0#timer.fired': new Date(2026, 0, 5, 7, 3, 21).toISOString()
    })

    // 没有 sourceId：来源里就没有这个键
    mocks.prompt.mockResolvedValueOnce({})
    svc.fire('timer.fired', {} as unknown as ReturnType<typeof minute>)
    await settle()
    expect(mocks.prompt.mock.calls[1][4]).toStrictEqual({
      kind: 'trigger',
      trigger: 'timer.fired',
      bot: 'ticker'
    })
  })
})

describe('触发日志', () => {
  /** 第 i 次 record 的入参 */
  const recordInput = (i: number): Record<string, unknown> =>
    mocks.record.mock.calls[i][0] as Record<string, unknown>
  /** outcome 为 o 的那些 record 入参 */
  const recordsOf = (o: string): Array<Record<string, unknown>> =>
    mocks.record.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .filter((r) => r.outcome === o)
  /** when 看到的 event：载荷 + trigger */
  const eventOf = (p: ReturnType<typeof minute>): Record<string, unknown> => ({
    ...p,
    trigger: 'timer.fired'
  })

  it('BTL-1 命中（无 when）：会话建出来之后、打开之前记 started（字段逐一）；prompt 交回之前不 finish，交回后 completed', async () => {
    mocks.listAll.mockReturnValue([
      bot('ticker', [TICK], { displayName: 'Ticker', objectId: 'bot:x' })
    ])
    const run = deferred<{ error?: string }>()
    mocks.prompt.mockReturnValueOnce(run.promise)
    const p = minute(18, 0)
    svc.fire('timer.fired', p)
    await settle()

    expect(mocks.record).toHaveBeenCalledTimes(1)
    expect(recordInput(0)).toStrictEqual({
      sourceId: 'timer:builtin:minute',
      trigger: 'timer.fired',
      bot: 'ticker',
      botDisplayName: 'Ticker',
      botFile: 'ticker.md',
      bindingIndex: 0,
      when: '',
      outcome: 'started',
      sessionId: 's-1',
      error: '',
      event: eventOf(p)
    })
    // 会话建出来才记，记完才去打开
    const [created] = mocks.create.mock.invocationCallOrder
    const [recorded] = mocks.record.mock.invocationCallOrder
    const [opened] = mocks.ensure.mock.invocationCallOrder
    expect(created).toBeLessThan(recorded)
    expect(recorded).toBeLessThan(opened)
    // 这一轮还在跑：还是 started
    expect(mocks.prompt).toHaveBeenCalledTimes(1)
    expect(mocks.finish).not.toHaveBeenCalled()

    run.resolve({})
    await settle()
    expect(mocks.finish.mock.calls).toEqual([['log-1', 'completed']])
    expect(mocks.record).toHaveBeenCalledTimes(1)
  })

  it('BTL-2 第二条绑定命中：bindingIndex 1、when 原文、botFile 取 basePath 的文件名；没命中的第一条不记', async () => {
    const when = "event.local.time == '18:00'"
    mocks.listAll.mockReturnValue([
      {
        ...bot('multi', [
          { ...TICK, when: 'false' },
          { trigger: 'timer.fired', when, message: 'second' }
        ]),
        basePath: '/home/u/.shuvix/bots/My Bot.md'
      }
    ])
    svc.fire('timer.fired', minute(18, 0))
    await settle()

    expect(mocks.record).toHaveBeenCalledTimes(1)
    expect(recordInput(0)).toMatchObject({
      bot: 'multi',
      botDisplayName: 'multi',
      botFile: 'My Bot.md',
      bindingIndex: 1,
      when,
      outcome: 'started',
      sessionId: 's-1'
    })
    expect(mocks.finish.mock.calls).toEqual([['log-1', 'completed']])
  })

  it('BTL-3 不命中（when 为假、别的埋点、没有绑定）一条都不记', async () => {
    mocks.listAll.mockReturnValue([
      bot('never', [{ ...TICK, when: 'false' }]),
      bot('late', [{ ...TICK, when: "event.local.time == '23:59'" }]),
      bot('other', [
        { trigger: 'webhook.received', message: 'hook' },
        { trigger: 'session.turn-completed', message: 'turn' }
      ]),
      bot('nobindings', undefined)
    ])
    for (let mi = 0; mi < 3; mi++) svc.fire('timer.fired', minute(18, mi))
    await settle()
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.record).not.toHaveBeenCalled()
    expect(mocks.finish).not.toHaveBeenCalled()
  })

  it("BTL-4 会话打不开 → finish(id, 'failed', 'The run session could not be opened')", async () => {
    mocks.listAll.mockReturnValue([bot('ticker', [TICK], { objectId: 'bot:x' })])
    mocks.ensure.mockResolvedValueOnce(null)
    svc.fire('timer.fired', minute(18, 0))
    await settle()
    expect(recordsOf('started').map((r) => r.sessionId)).toEqual(['s-1'])
    expect(mocks.finish.mock.calls).toEqual([
      ['log-1', 'failed', 'The run session could not be opened']
    ])
  })

  it("BTL-5 prompt 带 error → finish(id, 'failed', error)", async () => {
    mocks.listAll.mockReturnValue([bot('ticker', [TICK], { objectId: 'bot:x' })])
    mocks.prompt.mockResolvedValueOnce({ error: 'model refused' })
    svc.fire('timer.fired', minute(18, 0))
    await settle()
    expect(mocks.record).toHaveBeenCalledTimes(1)
    expect(mocks.finish.mock.calls).toEqual([['log-1', 'failed', 'model refused']])
  })

  it("BTL-6 prompt 抛错 → finish(id, 'failed', message)；抛的不是 Error → String()", async () => {
    mocks.listAll.mockReturnValue([bot('ticker', [TICK], { objectId: 'bot:x' })])
    mocks.prompt.mockRejectedValueOnce(new Error('socket hang up'))
    svc.fire('timer.fired', minute(18, 0))
    await settle()
    mocks.prompt.mockRejectedValueOnce('plain failure')
    svc.fire('timer.fired', minute(18, 1))
    await settle()

    expect(recordsOf('started').map((r) => r.sessionId)).toEqual(['s-1', 's-2'])
    expect(mocks.record).toHaveBeenCalledTimes(2)
    expect(mocks.finish.mock.calls).toEqual([
      ['log-1', 'failed', 'socket hang up'],
      ['log-2', 'failed', 'plain failure']
    ])
  })

  it("BTL-7 会话建不出来 → 一条 failed（sessionId ''，error = 原因），不 finish；下一次照跑", async () => {
    const ticker = bot('ticker', [TICK], { displayName: 'Ticker', objectId: 'bot:x' })
    mocks.listAll.mockReturnValue([ticker])
    mocks.create.mockImplementationOnce(() => {
      throw new Error('SQLITE_FULL')
    })
    const p = minute(18, 0)
    svc.fire('timer.fired', p)
    await settle()

    expect(mocks.record).toHaveBeenCalledTimes(1)
    expect(recordInput(0)).toStrictEqual({
      sourceId: 'timer:builtin:minute',
      trigger: 'timer.fired',
      bot: 'ticker',
      botDisplayName: 'Ticker',
      botFile: 'ticker.md',
      bindingIndex: 0,
      when: '',
      outcome: 'failed',
      sessionId: '',
      error: 'SQLITE_FULL',
      event: eventOf(p)
    })
    expect(mocks.finish).not.toHaveBeenCalled()
    expect(mocks.ensure).not.toHaveBeenCalled()
    expect(svc.isRunning(bindingKey(ticker, 0, 'timer.fired'))).toBe(false)

    svc.fire('timer.fired', minute(18, 1))
    await settle()
    expect(recordInput(1)).toMatchObject({ outcome: 'started', sessionId: 's-1' })
    expect(mocks.finish.mock.calls).toEqual([['log-2', 'completed']])
  })

  it("BTL-8 上一次还在跑 → skipped（sessionId ''、这一次的事件）；跑完之后下一次又是 started", async () => {
    mocks.listAll.mockReturnValue([
      bot('ticker', [TICK], { displayName: 'Ticker', objectId: 'bot:x' })
    ])
    const run = deferred<{ error?: string }>()
    mocks.prompt.mockReturnValueOnce(run.promise)
    svc.fire('timer.fired', minute(18, 0))
    await settle()
    const second = minute(18, 1)
    svc.fire('timer.fired', second)
    await settle()

    expect(mocks.create).toHaveBeenCalledTimes(1)
    expect(mocks.record).toHaveBeenCalledTimes(2)
    expect(recordInput(1)).toStrictEqual({
      sourceId: 'timer:builtin:minute',
      trigger: 'timer.fired',
      bot: 'ticker',
      botDisplayName: 'Ticker',
      botFile: 'ticker.md',
      bindingIndex: 0,
      when: '',
      outcome: 'skipped',
      sessionId: '',
      error: '',
      event: eventOf(second)
    })
    // 跳过的那条没有结局可等
    expect(mocks.finish).not.toHaveBeenCalled()

    run.resolve({})
    await settle()
    expect(mocks.finish.mock.calls).toEqual([['log-1', 'completed']])

    svc.fire('timer.fired', minute(18, 2))
    await settle()
    expect(recordInput(2)).toMatchObject({ outcome: 'started', sessionId: 's-2' })
    expect(mocks.finish.mock.calls).toEqual([
      ['log-1', 'completed'],
      ['log-3', 'completed']
    ])
  })

  it('BTL-9 when 求值出错 → condition-error：同一个错误只记一次；换一个再记；出错 → 成功（假）→ 同一个错误又记；成功的求值不记', async () => {
    let behaviour: string | number = 'error A'
    setWhenHostFunctions({
      activeSessions: () => {
        if (typeof behaviour === 'string') throw new Error(behaviour)
        return behaviour
      }
    })
    const when = 'activeSessions(event.local.date) > 0'
    mocks.listAll.mockReturnValue([
      bot('flaky', [{ ...TICK, when }], { displayName: 'Flaky', objectId: 'bot:f' })
    ])

    const t0 = minute(18, 0)
    svc.fire('timer.fired', t0)
    svc.fire('timer.fired', minute(18, 1))
    await settle()
    expect(mocks.record).toHaveBeenCalledTimes(1)

    behaviour = 'error B'
    const t2 = minute(18, 2)
    svc.fire('timer.fired', t2)
    await settle()
    expect(mocks.record).toHaveBeenCalledTimes(2)

    // 求值成功（假）：不命中、不记，但清掉了「上一次的错误」
    behaviour = 0
    svc.fire('timer.fired', minute(18, 3))
    await settle()
    expect(mocks.record).toHaveBeenCalledTimes(2)

    behaviour = 'error B'
    const t4 = minute(18, 4)
    svc.fire('timer.fired', t4)
    svc.fire('timer.fired', minute(18, 5))
    await settle()

    const errors = recordsOf('condition-error')
    expect(errors).toHaveLength(3)
    expect(mocks.record).toHaveBeenCalledTimes(3)
    const expected = [
      ['error A', t0],
      ['error B', t2],
      ['error B', t4]
    ] as const
    errors.forEach((r, i) => {
      const [message, at] = expected[i]
      expect(r).toMatchObject({
        sourceId: 'timer:builtin:minute',
        trigger: 'timer.fired',
        bot: 'flaky',
        botDisplayName: 'Flaky',
        botFile: 'flaky.md',
        bindingIndex: 0,
        when,
        outcome: 'condition-error',
        sessionId: '',
        event: eventOf(at)
      })
      expect(String(r.error)).toContain(message)
    })
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.finish).not.toHaveBeenCalled()

    // 求值成功（真）：一条 started，不是 condition-error
    behaviour = 1
    svc.fire('timer.fired', minute(18, 6))
    await settle()
    expect(mocks.record).toHaveBeenCalledTimes(4)
    expect(recordInput(3)).toMatchObject({ outcome: 'started', sessionId: 's-1', error: '' })
  })

  it("BTL-10 记下的 event 是 `when` 看到的那个：不带围栏里的 lastFiredAt；载荷没有 sourceId → sourceId ''", async () => {
    mocks.listAll.mockReturnValue([bot('ticker', [TICK], { objectId: 'bot:x' })])
    svc.fire('timer.fired', minute(18, 0))
    await settle()
    const second = minute(18, 1)
    svc.fire('timer.fired', second)
    await settle()
    // 围栏里有 lastFiredAt，日志里的事件没有
    expect(fenceOf(promptText(1))).toHaveProperty('lastFiredAt')
    expect(recordInput(1).event).toStrictEqual(eventOf(second))

    const noSource: Record<string, unknown> = { ...minute(18, 2) }
    delete noSource.sourceId
    svc.fire('timer.fired', noSource as unknown as ReturnType<typeof minute>)
    await settle()
    expect(recordInput(2)).toMatchObject({
      sourceId: '',
      outcome: 'started',
      event: { ...noSource, trigger: 'timer.fired' }
    })
    expect(recordInput(2).event).not.toHaveProperty('sourceId')
  })

  it('BTL-11 一次 tick 命中几条绑定就记几条，各带自己的 bot / 序号 / 会话；finish 用各自的 id', async () => {
    const a = bot('a', [TICK, { trigger: 'timer.fired', message: 'second' }], { objectId: 'bot:a' })
    const b = bot('b', [TICK], { objectId: 'bot:b' })
    mocks.listAll.mockReturnValue([a, b])
    mocks.record.mockImplementation((input) => `log:${input.bot}#${input.bindingIndex}`)
    // s-2（a 的第二条）跑失败，其余跑成
    mocks.ensure.mockImplementation(async (id: string) => ({
      prompt: async () => (id === 's-2' ? { error: 'boom' } : {})
    }))
    svc.fire('timer.fired', minute(18, 0))
    await settle()

    expect(
      mocks.record.mock.calls.map((c) => {
        const r = c[0] as Record<string, unknown>
        return [r.bot, r.bindingIndex, r.outcome, r.sessionId]
      })
    ).toEqual([
      ['a', 0, 'started', 's-1'],
      ['a', 1, 'started', 's-2'],
      ['b', 0, 'started', 's-3']
    ])
    expect(
      [...mocks.finish.mock.calls].sort((x, y) => String(x[0]).localeCompare(String(y[0])))
    ).toEqual([
      ['log:a#0', 'completed'],
      ['log:a#1', 'failed', 'boom'],
      ['log:b#0', 'completed']
    ])
  })

  it('BTL-12 记日志失败（record 交回 null）不挡运行：照样 prompt、finish(null, …)、lastFired 照推', async () => {
    mocks.listAll.mockReturnValue([bot('ticker', [TICK], { objectId: 'bot:x' })])
    mocks.record.mockReturnValue(null)
    const p = minute(18, 0)
    svc.fire('timer.fired', p)
    await settle()
    expect(mocks.prompt).toHaveBeenCalledTimes(1)
    expect(mocks.finish.mock.calls).toEqual([[null, 'completed']])
    expect(lastFired()).toStrictEqual({ 'bot:x#0#timer.fired': p.firedAt })
    expect(mocks.commit).toHaveBeenCalledTimes(1)
  })
})
