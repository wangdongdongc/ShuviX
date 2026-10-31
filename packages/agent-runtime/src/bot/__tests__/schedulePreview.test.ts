/**
 * bot 文件的排期预演（bot/schedulePreview）—— `previewTimerBinding` 按真的 timer 的 payload（timerPayloadAt）
 * 逐分钟求同一个 `when`（evaluateWhen），从 `now` 的下一分钟起看 `days` 天；`botScheduleNote` 把一份文件的绑定写成
 * 回执里那一段（模型面英文）。
 *
 * 契约（schedulePreview.ts 文件头 + 2026-10-31 的裁定）：
 *  - 窗口：第一分钟是 `now` 所在分钟的下一分钟（恰在整分钟上也是下一分钟），一共 days × 1440 个真实分钟
 *    （夏令时回拨那一小时的两个 01:30 各算一分钟，拨快那天没有 02:xx）；至多 limit 个命中（缺省 3）；
 *  - 事件 = payload + `trigger: 'timer.fired'`，`env` 原样交给 CEL；没有 `when`（或空串）= 每分钟都命中；
 *  - 出错的那一分钟算不命中、接着往下看（同真的触发源）：有命中 → fires 带 `error`（第一次错误的第一行）；
 *    一个都没命中且出过错 → error；没命中没出错 → never；
 *  - `activeSessions(date)` 一律当 1：全局注入的那份不被调、也不被换掉；`== 0` / `>= 2` 于是「从不触发」（钉住），
 *    用到它的定时绑定让回执开头带上这个假设（`activeSessions (` 中间有空白也算）；
 *  - 回执：开头一行 + 每条 `timer.fired` 绑定一行（按它在文件里的序号），`project` 对不上恰好一个项目时
 *    紧跟着再一行；没有定时绑定 → null。
 *
 *   SP-1  第一分钟是 now 的下一分钟（17:59:30 → 当天 18:00；恰 18:00:00.000 → 明天 18:00）
 *   SP-2  窗口最后一分钟算、再下一分钟不算；days 照用
 *   SP-3  limit 缺省 3、可指定
 *   SP-4  窗口先到头：周日 20:00 在 14 天里恰是 11-01 与 11-08
 *   SP-5  没有 when → 接下来几分钟，payload 恰是 timerPayloadAt 的
 *   SP-6  事件与 env 的形状：trigger、sourceId（缺省 / 指定）、env 原样；env 缺键 → error
 *   SP-7  weekday 写成 'Sunday' → never；== 0 → 周日的分钟（回执里 Sun）
 *   SP-8  错误消息只要第一行（缺键、非布尔、重载不匹配）
 *   SP-9  activeSessions 换成桩：全局 spy 不被调、事后仍在位
 *   SP-10 activeSessions('today') → error（日期形状不对）
 *   SP-11 （钉住）activeSessions == 0 / >= 2 → never；== 1 → fires
 *   SP-12 部分分钟出错：命中的分钟照算，回执末尾说「其他分钟求值出错，算不触发」
 *   SP-13 夏令时（America/New_York）：回拨那天两个 01:30；拨快那天没有 02:30
 *   SP-14 14 天恰是 14 × 1440 个真实分钟（跨回拨），一个不重、一个不漏
 *   SP-15 假设那句：任一定时绑定用到 activeSessions（含带空白的写法）才有、只有一次；非定时绑定不算
 *   SP-16 逐字：开头、fires / never / error 三种行；days: 7 / days: 1 的措辞；恰 1 + N 行
 *   SP-17 没有 when 与 when: '' 同一句；'true' 列出时刻
 *   SP-18 序号按文件里的位置（中间夹着非定时绑定）；只有非定时 / 空列表 → null
 *   SP-19 project 对不上 0 / 2 个 → 紧跟在那条绑定的行后面（never / error 行之后也是）；恰 1 个 → 没有
 *   SP-20 projectMatches：每条带 project 的定时绑定恰调一次、名字原样；别的不调
 *   SP-21 不给 projectMatches → 没有 project 行
 *   SP-22 纯函数：同样的输入同样的输出，不改绑定
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { timerPayloadAt } from '../../hook/timerPayload'
import { evaluateWhen, setWhenHostFunctions } from '../../hook/when'
import type { TimerFiredPayload } from '../../hook/triggerPoints'
import type { BotBinding } from '../botFile'
import { botScheduleNote, previewTimerBinding, type TimerBindingPreview } from '../schedulePreview'

const savedTz = process.env.TZ
beforeEach(() => {
  process.env.TZ = 'Asia/Shanghai'
})
afterEach(() => {
  setWhenHostFunctions({})
  if (savedTz === undefined) delete process.env.TZ
  else process.env.TZ = savedTz
})

/** 本地时刻（月份按人读的 1–12） */
function at(y: number, mo: number, d: number, h: number, mi: number, s = 0, ms = 0): Date {
  return new Date(y, mo - 1, d, h, mi, s, ms)
}

/** 缺省的此刻：周六 2026-10-31 12:00:30（本地） */
const now = (): Date => at(2026, 10, 31, 12, 0, 30)

/** 命中的本地 `YYYY-MM-DD HH:MM` */
function hits(preview: TimerBindingPreview): string[] {
  expect(preview.kind, JSON.stringify(preview)).toBe('fires')
  return (preview as { at: TimerFiredPayload[] }).at.map((p) => `${p.local.date} ${p.local.time}`)
}

const timer = (when?: string, extra: Partial<BotBinding> = {}): BotBinding => ({
  trigger: 'timer.fired',
  ...(when === undefined ? {} : { when }),
  message: 'Run.',
  ...extra
})

const FIELDS =
  "event.local has date 'YYYY-MM-DD', time 'HH:MM' (24-hour), weekday 0–6 (0 = Sunday, a number), hour and minute (numbers), all local time"
const HEADER = (days = '14 days'): string => `Schedule check (local time, the next ${days}):`
const HEADER_SESSIONS =
  'Schedule check (local time, the next 14 days, counting every day as one with sessions):'
const NEVER = (i: number, days = '14 days'): string =>
  `- binding #${i} (timer.fired): never fires in the next ${days}. Check its \`when\` — ${FIELDS}.`
const FAILS = (i: number, message: string): string =>
  `- binding #${i} (timer.fired): its \`when\` fails to evaluate (${message}), so it never fires. ${FIELDS}.`

const AT_20 = "event.local.time == '20:00'"

describe('previewTimerBinding —— 窗口', () => {
  it('SP-1 第一分钟是 now 的下一分钟：17:59:30 → 当天 18:00；恰 18:00:00.000 → 明天 18:00', () => {
    const when = "event.local.time == '18:00'"
    expect(hits(previewTimerBinding(when, { now: at(2026, 10, 31, 17, 59, 30) }))[0]).toBe(
      '2026-10-31 18:00'
    )
    expect(hits(previewTimerBinding(when, { now: at(2026, 10, 31, 18, 0, 0, 0) }))[0]).toBe(
      '2026-11-01 18:00'
    )
    // 没有 when：第一分钟就是下一分钟
    expect(hits(previewTimerBinding(undefined, { now: now() }))[0]).toBe('2026-10-31 12:01')
  })

  it('SP-2 窗口最后一分钟（14 天后的 12:00）算，再下一分钟不算；days: 1 → 明天 12:00 算、12:01 不算', () => {
    const exact = (date: string, time: string): string =>
      `event.local.date == '${date}' && event.local.time == '${time}'`
    expect(hits(previewTimerBinding(exact('2026-11-14', '12:00'), { now: now() }))).toEqual([
      '2026-11-14 12:00'
    ])
    expect(previewTimerBinding(exact('2026-11-14', '12:01'), { now: now() })).toEqual({
      kind: 'never'
    })
    expect(
      hits(previewTimerBinding(exact('2026-11-01', '12:00'), { now: now(), days: 1 }))
    ).toEqual(['2026-11-01 12:00'])
    expect(previewTimerBinding(exact('2026-11-01', '12:01'), { now: now(), days: 1 })).toEqual({
      kind: 'never'
    })
  })

  it('SP-3 limit 缺省 3、可指定（整点）', () => {
    const when = 'event.local.minute == 0'
    expect(hits(previewTimerBinding(when, { now: now() }))).toEqual([
      '2026-10-31 13:00',
      '2026-10-31 14:00',
      '2026-10-31 15:00'
    ])
    expect(hits(previewTimerBinding(when, { now: now(), limit: 5 }))).toHaveLength(5)
    expect(hits(previewTimerBinding(when, { now: now(), limit: 1 }))).toEqual(['2026-10-31 13:00'])
  })

  it('SP-4 窗口先到头：周日 20:00 在 14 天里恰是 11-01 与 11-08（不到 limit）', () => {
    expect(
      hits(previewTimerBinding(`event.local.weekday == 0 && ${AT_20}`, { now: now() }))
    ).toEqual(['2026-11-01 20:00', '2026-11-08 20:00'])
  })

  it('SP-5 没有 when → 接下来三分钟，payload 恰是 timerPayloadAt 给的（缺省 sourceId / 指定的）', () => {
    expect(previewTimerBinding(undefined, { now: now() })).toStrictEqual({
      kind: 'fires',
      at: [1, 2, 3].map((mi) => timerPayloadAt(at(2026, 10, 31, 12, mi), 'timer:builtin:minute'))
    })
    expect(previewTimerBinding(undefined, { now: now(), sourceId: 'timer:x' })).toStrictEqual({
      kind: 'fires',
      at: [1, 2, 3].map((mi) => timerPayloadAt(at(2026, 10, 31, 12, mi), 'timer:x'))
    })
  })
})

describe('previewTimerBinding —— 事件、env 与求值', () => {
  it('SP-6 event.trigger / sourceId（缺省与指定）/ firedAt / env 原样可达；env 缺键 → error', () => {
    const shape =
      "event.trigger == 'timer.fired' && has(event.firedAt) && env.host == 'desktop' && env.platform == 'darwin'"
    const env = { host: 'desktop', platform: 'darwin' }
    expect(
      hits(
        previewTimerBinding(`${shape} && event.sourceId == 'timer:builtin:minute'`, {
          now: now(),
          env
        })
      )
    ).toEqual(['2026-10-31 12:01', '2026-10-31 12:02', '2026-10-31 12:03'])
    expect(
      hits(
        previewTimerBinding(`${shape} && event.sourceId == 'timer:x'`, {
          now: now(),
          env,
          sourceId: 'timer:x'
        })
      )
    ).toHaveLength(3)
    // 缺省 sourceId 时写别的 id → 不命中
    expect(previewTimerBinding("event.sourceId == 'timer:x'", { now: now() })).toEqual({
      kind: 'never'
    })
    // env 缺省是 {}：读它的键 = 求值出错
    expect(previewTimerBinding("env.host == 'desktop'", { now: now() })).toEqual({
      kind: 'error',
      message: 'No such key: host'
    })
    expect(
      previewTimerBinding("env.platform == 'darwin'", { now: now(), env: { host: 'desktop' } })
    ).toEqual({
      kind: 'error',
      message: 'No such key: platform'
    })
  })

  it("SP-7 weekday 写成 'Sunday'（数字比字符串）→ never；== 0 → 周日的分钟，回执里写 Sun", () => {
    expect(previewTimerBinding("event.local.weekday == 'Sunday'", { now: now() })).toEqual({
      kind: 'never'
    })
    const preview = previewTimerBinding('event.local.weekday == 0', { now: now() })
    expect(hits(preview)).toEqual(['2026-11-01 00:00', '2026-11-01 00:01', '2026-11-01 00:02'])
    expect(botScheduleNote([timer('event.local.weekday == 0')], { now: now() })).toBe(
      `${HEADER()}\n- binding #0 (timer.fired): next at Sun 2026-11-01 00:00, Sun 2026-11-01 00:01, Sun 2026-11-01 00:02.`
    )
  })

  it.each([
    ['缺键', 'event.local.nope == 1', 'No such key: nope'],
    ['非布尔', 'event.local.hour', 'when expression must evaluate to a boolean, got number'],
    ['重载不匹配', 'activeSessions(1) > 0', "found no matching overload for 'activeSessions(int)'"]
  ])(
    'SP-8 错误消息只要第一行（%s）：CEL 的原文带源码与插入符，预演里没有换行',
    (_label, when, message) => {
      const preview = previewTimerBinding(when, { now: now() })
      expect(preview).toEqual({ kind: 'error', message })
      expect((preview as { message: string }).message).not.toContain('\n')
    }
  )

  it('SP-8 自检：CEL 的原始错误确实是多行的（否则上一条什么都没证明）', () => {
    expect(() => evaluateWhen('event.local.nope == 1', { event: { local: {} }, env: {} })).toThrow(
      /No such key: nope\n/
    )
  })

  it('SP-9 activeSessions 换成桩（当 1）：全局注入的 spy 一次都不调；事后全局那份照旧在位', () => {
    const global = vi.fn((_date: string) => 0)
    setWhenHostFunctions({ activeSessions: global })
    const when = `event.local.time == '18:00' && activeSessions(event.local.date) > 0`
    expect(hits(previewTimerBinding(when, { now: now() }))).toEqual([
      '2026-10-31 18:00',
      '2026-11-01 18:00',
      '2026-11-02 18:00'
    ])
    expect(global).not.toHaveBeenCalled()
    expect(evaluateWhen("activeSessions('2026-10-31') > 0", { event: {}, env: {} })).toBe(false)
    expect(global).toHaveBeenCalledWith('2026-10-31')
  })

  it("SP-10 activeSessions('today')（日期形状不对）→ error，消息是宿主函数的那句", () => {
    expect(previewTimerBinding("activeSessions('today') > 0", { now: now() })).toEqual({
      kind: 'error',
      message: "activeSessions() expects a local date like '2026-10-24', got 'today'"
    })
  })

  it.each([
    ['== 0', 'never'],
    ['>= 2', 'never'],
    ['== 1', 'fires']
  ])(
    'SP-11 （钉住）activeSessions(event.local.date) %s → %s：预演把每一天都当作有一个会话',
    (op, kind) => {
      const preview = previewTimerBinding(`activeSessions(event.local.date) ${op}`, { now: now() })
      expect(preview.kind).toBe(kind)
    }
  )

  it("SP-12 部分分钟出错：time == '20:00' || 缺键 → 每天 20:00 照样命中，error 记第一行；12:01 那次命中也保留", () => {
    const tail = ' || event.local.nope == 1'
    expect(previewTimerBinding(`${AT_20}${tail}`, { now: now() })).toEqual({
      kind: 'fires',
      at: [
        timerPayloadAt(at(2026, 10, 31, 20, 0), 'timer:builtin:minute'),
        timerPayloadAt(at(2026, 11, 1, 20, 0), 'timer:builtin:minute'),
        timerPayloadAt(at(2026, 11, 2, 20, 0), 'timer:builtin:minute')
      ],
      error: 'No such key: nope'
    })
    expect(hits(previewTimerBinding(`event.local.time == '12:01'${tail}`, { now: now() }))).toEqual(
      ['2026-10-31 12:01', '2026-11-01 12:01', '2026-11-02 12:01']
    )
    expect(botScheduleNote([timer(`${AT_20}${tail}`)], { now: now() })).toBe(
      `${HEADER()}\n- binding #0 (timer.fired): next at Sat 2026-10-31 20:00, Sun 2026-11-01 20:00, Mon 2026-11-02 20:00.` +
        ' On other minutes its `when` fails to evaluate (No such key: nope), which counts as not firing.'
    )
  })
})

describe('previewTimerBinding —— 夏令时（TZ=America/New_York）', () => {
  beforeEach(() => {
    process.env.TZ = 'America/New_York'
  })

  it('SP-13 回拨（2026-11-01 02:00 EDT → 01:00 EST）：两个 01:30 各是一分钟、firedAt 不同；拨快（2027-03-14）那天没有 02:30', () => {
    const back = previewTimerBinding("event.local.time == '01:30'", {
      now: new Date('2026-11-01T04:59:30.000Z')
    })
    expect(hits(back)).toEqual(['2026-11-01 01:30', '2026-11-01 01:30', '2026-11-02 01:30'])
    expect((back as { at: TimerFiredPayload[] }).at.map((p) => p.firedAt)).toEqual([
      '2026-11-01T05:30:00.000Z',
      '2026-11-01T06:30:00.000Z',
      '2026-11-02T06:30:00.000Z'
    ])

    const forward = previewTimerBinding("event.local.time == '02:30'", {
      now: at(2027, 3, 13, 12, 0, 30)
    })
    expect(hits(forward)).toEqual(['2027-03-15 02:30', '2027-03-16 02:30', '2027-03-17 02:30'])
    expect(
      previewTimerBinding("event.local.date == '2027-03-14' && event.local.hour == 2", {
        now: at(2027, 3, 13, 12, 0, 30)
      })
    ).toEqual({ kind: 'never' })
  })

  it('SP-14 跨回拨的 14 天恰是 14 × 1440 个真实分钟：逐个相隔 60 秒，本地 01:30 在回拨那天出现两次', () => {
    const start = at(2026, 10, 25, 12, 0, 30)
    const preview = previewTimerBinding('true', { now: start, limit: Number.MAX_SAFE_INTEGER })
    const all = (preview as { at: TimerFiredPayload[] }).at
    expect(all).toHaveLength(14 * 1440)
    const first = Date.parse(all[0].firedAt)
    expect(all[0].firedAt).toBe(at(2026, 10, 25, 12, 1).toISOString())
    all.forEach((p, i) => {
      if (Date.parse(p.firedAt) !== first + i * 60_000) throw new Error(`minute ${i}: ${p.firedAt}`)
    })
    expect(
      all.filter((p) => p.local.date === '2026-11-01' && p.local.time === '01:30')
    ).toHaveLength(2)
    // 本地钟面少走了一小时：最后一分钟是 11-08 11:00（不是 12:00）
    expect(`${all.at(-1)!.local.date} ${all.at(-1)!.local.time}`).toBe('2026-11-08 11:00')
  })
})

describe('botScheduleNote —— 回执那一段', () => {
  it.each([
    ['activeSessions(event.local.date) > 0'],
    ['activeSessions (event.local.date) > 0'],
    ['activeSessions\t(event.local.date) > 0']
  ])('SP-15 定时绑定用到 activeSessions（%s）→ 开头带假设那句，恰一次', (call) => {
    const note = botScheduleNote(
      [timer(`${AT_20} && ${call}`), timer(`event.local.time == '21:00' && ${call}`)],
      { now: now() }
    )!
    expect(note.split('\n')[0]).toBe(HEADER_SESSIONS)
    expect(note.split('counting every day as one with sessions')).toHaveLength(2)
  })

  it('SP-15 没有绑定用到它 → 没有假设那句；只有非定时绑定用到它也没有', () => {
    const nonTimer: BotBinding = {
      trigger: 'no.such.trigger',
      when: 'activeSessions(event.local.date) > 0',
      message: 'x'
    }
    for (const bindings of [[timer(AT_20)], [nonTimer, timer(AT_20)]]) {
      const note = botScheduleNote(bindings, { now: now() })!
      expect(note.split('\n')[0]).toBe(HEADER())
      expect(note).not.toContain('counting every day')
    }
  })

  it('SP-16 逐字：fires / never / error 三行；恰 1 + 3 行', () => {
    const note = botScheduleNote(
      [timer(AT_20), timer("event.local.weekday == 'Sunday'"), timer('event.local.nope == 1')],
      { now: now() }
    )
    expect(note).toBe(
      [
        HEADER(),
        '- binding #0 (timer.fired): next at Sat 2026-10-31 20:00, Sun 2026-11-01 20:00, Mon 2026-11-02 20:00.',
        NEVER(1),
        FAILS(2, 'No such key: nope')
      ].join('\n')
    )
    expect(note!.split('\n')).toHaveLength(4)
  })

  it.each([
    [7, '7 days'],
    [1, '1 day']
  ])('SP-16 days: %i → 开头与 never 行都说「%s」', (days, text) => {
    const note = botScheduleNote([timer("event.local.weekday == 'Sunday'")], { now: now(), days })
    expect(note).toBe(`${HEADER(text)}\n${NEVER(0, text)}`)
  })

  it("SP-17 没有 when 与 when: '' 同一句「每分钟都触发」；'true' 列出接下来三分钟", () => {
    const every = '- binding #0 (timer.fired): no `when`, so it fires every minute.'
    expect(botScheduleNote([timer()], { now: now() })).toBe(`${HEADER()}\n${every}`)
    expect(botScheduleNote([timer('')], { now: now() })).toBe(`${HEADER()}\n${every}`)
    expect(botScheduleNote([timer('true')], { now: now() })).toBe(
      `${HEADER()}\n- binding #0 (timer.fired): next at Sat 2026-10-31 12:01, Sat 2026-10-31 12:02, Sat 2026-10-31 12:03.`
    )
  })

  it('SP-18 序号是它在文件里的位置：中间夹着非定时绑定时跳号；只有非定时 / 空列表 → null', () => {
    const other: BotBinding = { trigger: 'no.such.trigger', message: 'x' }
    const note = botScheduleNote([other, timer(AT_20), other, timer()], { now: now() })!
    const lines = note.split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[1].startsWith('- binding #1 (timer.fired): next at ')).toBe(true)
    expect(lines[2]).toBe('- binding #3 (timer.fired): no `when`, so it fires every minute.')
    expect(botScheduleNote([other, other], { now: now() })).toBeNull()
    expect(botScheduleNote([], { now: now() })).toBeNull()
  })

  it('SP-19 project 对不上 0 个 / 不止一个 → 紧跟在那条绑定的行后面（never / error 行之后也是）；恰 1 个 → 没有', () => {
    const counts: Record<string, number> = { Ghost: 0, Twin: 2, Acme: 1, Lost: 0 }
    const note = botScheduleNote(
      [
        timer(AT_20, { project: 'Ghost' }),
        timer("event.local.weekday == 'Sunday'", { project: 'Twin' }),
        timer(AT_20, { project: 'Acme' }),
        timer('event.local.nope == 1', { project: 'Lost' })
      ],
      { now: now(), projectMatches: (name) => counts[name] }
    )
    expect(note!.split('\n')).toEqual([
      HEADER(),
      '- binding #0 (timer.fired): next at Sat 2026-10-31 20:00, Sun 2026-11-01 20:00, Mon 2026-11-02 20:00.',
      '- binding #0 (timer.fired): no project is named "Ghost", so every run would be skipped.',
      NEVER(1),
      '- binding #1 (timer.fired): more than one project is named "Twin", so every run would be skipped.',
      '- binding #2 (timer.fired): next at Sat 2026-10-31 20:00, Sun 2026-11-01 20:00, Mon 2026-11-02 20:00.',
      FAILS(3, 'No such key: nope'),
      '- binding #3 (timer.fired): no project is named "Lost", so every run would be skipped.'
    ])
  })

  it('SP-20 projectMatches：每条带 project 的定时绑定恰调一次、名字原样；没写 project 的、非定时的不调', () => {
    const lookup = vi.fn((_name: string) => 1)
    botScheduleNote(
      [
        timer(AT_20, { project: 'Acme Site' }),
        timer(AT_20),
        { trigger: 'no.such.trigger', message: 'x', project: 'Other' },
        timer(undefined, { project: 'acme site' })
      ],
      { now: now(), projectMatches: lookup }
    )
    expect(lookup.mock.calls).toEqual([['Acme Site'], ['acme site']])
  })

  it('SP-21 不给 projectMatches → 没有 project 行', () => {
    expect(botScheduleNote([timer(AT_20, { project: 'Ghost' })], { now: now() })).toBe(
      `${HEADER()}\n- binding #0 (timer.fired): next at Sat 2026-10-31 20:00, Sun 2026-11-01 20:00, Mon 2026-11-02 20:00.`
    )
  })

  it('SP-22 纯函数：同样的输入两次同样的输出，绑定不被改动', () => {
    const bindings = Object.freeze([
      Object.freeze(timer(AT_20, { project: 'Ghost' })),
      Object.freeze(timer('activeSessions(event.local.date) > 0'))
    ])
    const options = { now: now(), projectMatches: () => 0 }
    const first = botScheduleNote(bindings, options)
    expect(botScheduleNote(bindings, options)).toBe(first)
    expect(bindings[0]).toEqual(timer(AT_20, { project: 'Ghost' }))
    expect(options.now.getTime()).toBe(now().getTime())
  })
})
