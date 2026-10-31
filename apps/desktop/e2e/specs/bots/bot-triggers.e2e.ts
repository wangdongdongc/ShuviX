/**
 * bot 触发绑定（`shuvix-bot-on`，实验）—— 内置 timer 每分钟一次的 `timer.fired` 真的叫起一个 bot：
 *
 *   BT-E1 绑定命中 → 新开一条绑定该 bot 的临时会话（无项目、无父会话、无工作项目引用，标着 triggerRun），
 *         标题「显示名 · MM-DD HH:MM」
 *   BT-E2 发给模型的就是「绑定里的 message + 空行 + <trigger_event> 围栏」，围栏 YAML 里是这一分钟的事实，第一次没有 lastFiredAt
 *   BT-E3 侧栏里它折在 ticker 组的「定时运行」那一行里（缺省收起，不在用户自己开的会话之列）；照样点得开：
 *         用户气泡带「触发器」来源标签（悬停说出 bot 与埋点），脚本回复照常渲染
 *   BT-E4 `when: "false"` 与求值出错（函数名拼错）的绑定都不建会话；出错只记一次日志
 *   BT-E5 设置 → 触发源：tab 带实验标签；开关缺省开（设置项没写）；副标题是上次触发的时刻；**不列订阅者**（触发源与
 *         bot 解绑，2026-10-24）；「上一次的事件」块缺省收起、点得开，JSON 就是 `when` 看到的 event（trigger + local.time）
 *   BT-E8 触发日志：ticker 第一次运行一条 completed（带运行会话；展开是绑定一行 / 「没有条件」/ 无错误 / 事件 = 围栏 +
 *         trigger）；DOM 与 trigger.logs() 同序，`{limit: 1}` 只给最新一条；「打开对话」把主窗切到那条运行会话
 *   BT-E9 typo（when 里函数名拼错）恰一条 condition-error（无打开钮；展开是 when 原文与 CEL 的报错）；never 一条都没有
 *   BT-E6 下一分钟又一条：围栏里的 lastFiredAt = 上一次（跑成了的）firedAt，带本机时区偏移；firedAt 恰好晚 60 秒；
 *         开着的触发源页随 `trigger.logged` 列出这一次（不用重开）；typo 仍恰一条
 *   BT-E7 关掉开关：设置项写成 'false'，跨过下一个整分钟不再建会话，「上次触发」不动
 *   BT-E10 清空日志：弹确认；取消什么都不动；确认后是空态、没有「清空」钮，trigger.logs() 为 []
 *
 * 一次冷启动（缺省不带随应用提供的日报 bot）。timer 对齐整分钟，所以整份文件要跨三个分钟边界（约 3 分钟）。
 * 假提供商的脚本按 `<trigger_event` 围栏认领 —— 触发的运行与别的请求（自动标题之类）谁先到不确定，纯 FIFO 会错位。
 * 第二次运行要读到 lastFiredAt，第一次运行必须**正常跑完**（只有跑成了才记），所以第一次给脚本化的回复。
 */
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import ja from '@shuvix/chat-protocol/i18n/locales/ja.json'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import { until, type CdpClient } from '../../harness/cdp'
import { startFakeProvider, type FakeProvider, type FakeRequest } from '../../harness/fakeProvider'
import { launchApp, type E2EApp } from '../../harness/launch'
import {
  seedFakeProvider,
  sessionsBoundTo,
  waitRendererReady,
  writeBotMd
} from '../../harness/seed'
import {
  botsPane,
  chatOriginBadges,
  chatPane,
  confirmPane,
  sidebarPane,
  triggerSettingsPane,
  type TriggerSettingsPane
} from '../../harness/pages'

const TIMER_ID = 'timer:builtin:minute'
const TIMER_KEY = 'triggers.timer.enabled'
const FENCE_OPEN = '<trigger_event trigger="timer.fired">'
const MESSAGE = 'Tick check-in.'
const REPLY = 'Ticker reply: all quiet.'
const TYPO_WHEN = 'activeSession(event.local.date) > 0'
/** 第一次触发最晚什么时候到：写完 bot 恰好错过一个整分钟时要等满下一分钟（60 s + 余量） */
const NEXT_FIRE_MS = 80_000

const LOCALES = [en, zh, ja]
const NOT_FIRED_YET = LOCALES.map((l) => l.settings.triggersNotFiredYet)
const LAST_FIRED_PREFIXES = LOCALES.map((l) => l.settings.triggersLastFired.split('{{time}}')[0])
const ORIGIN_TRIGGER = LOCALES.map((l) => l.message.originTrigger)
const LAST_EVENT_SUMMARY = LOCALES.map((l) => l.settings.triggersLastEvent)
const COMPLETED = LOCALES.map((l) => l.settings.triggerLogCompleted)
const CONDITION_ERROR = LOCALES.map((l) => l.settings.triggerLogConditionError)
const NO_CONDITION = LOCALES.map((l) => l.settings.triggerLogNoCondition)
const LOG_EMPTY = LOCALES.map((l) => l.settings.triggerLogEmpty)
const CLEAR_CONFIRM = LOCALES.map((l) => l.settings.triggerLogClearConfirm)
/** 展开后绑定那一行（各语言的写法） */
const bindingLines = (file: string, index: number, trigger: string): string[] =>
  LOCALES.map((l) =>
    l.settings.triggerLogBinding
      .replace('{{file}}', file)
      .replace('{{index}}', String(index))
      .replace('{{trigger}}', trigger)
  )
/** BT-E8 切走主窗用的对照会话 */
const CONTROL_TITLE = 'bt-e8-control'

/** 围栏里的 YAML（TimerFiredPayload + 这条绑定上一次跑成的时刻） */
interface TriggerFence {
  sourceId: string
  firedAt: string
  lastFiredAt?: string
  local: { date: string; time: string; weekday: number; hour: number; minute: number }
}

/** trigger:logs 的一条（TriggerLogEntry） */
interface LogEntry {
  id: string
  createdAt: number
  updatedAt: number
  sourceId: string
  trigger: string
  bot: string
  botDisplayName: string
  botFile: string
  bindingIndex: number
  when: string
  outcome: string
  sessionId: string
  error: string
  event: Record<string, unknown>
}

interface TickerSession {
  id: string
  title: string
  projectId: string | null
  parentId: string | null
  bot: string
  /** 触发器开出来的运行会话（侧栏折进「定时运行」） */
  triggerRun: boolean
  /** 工作项目的引用（绑定没写 project → 没有） */
  workProject: string | null
  createdAt: number
}

let app: E2EApp
let provider: FakeProvider
let settings: CdpClient | null = null
let triggers: TriggerSettingsPane
let first: TickerSession
let firstFence: TriggerFence

const pad = (n: number): string => String(n).padStart(2, '0')
const dayKey = (d: Date): string =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/** 带本机时区偏移的 ISO（`2026-10-24T18:00:00+08:00`）—— bot 读到的 lastFiredAt 就是这个形状 */
function localIso(at: Date): string {
  const offset = -at.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const abs = Math.abs(offset)
  return (
    `${dayKey(at)}T${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}` +
    `${sign}${pad(Math.trunc(abs / 60))}:${pad(abs % 60)}`
  )
}

/** 一条触发的用户消息 → 围栏 YAML；形状不对就抛（消息必须是「message + 空行 + 围栏」，前后不多一个字） */
function fenceOf(text: string): TriggerFence {
  const m =
    /^Tick check-in\.\n\n<trigger_event trigger="timer\.fired">\n([\s\S]*)\n<\/trigger_event>$/.exec(
      text
    )
  if (!m) throw new Error(`not a ticker trigger message: ${JSON.stringify(text)}`)
  return parseYaml(m[1]) as TriggerFence
}

/** 这次请求是 ticker 的一次触发运行（按围栏认，`raw` 是 JSON —— 引号被转义过，只能读解码后的文本） */
const isTickRequest = (req: FakeRequest): boolean =>
  req.lastUserText.startsWith(MESSAGE) && req.lastUserText.includes(FENCE_OPEN)

/** 标题与围栏里的本地时刻对得上的那次触发请求 */
function tickRequestFor(title: string): FakeRequest | undefined {
  return provider.requests().find((req) => {
    if (!isTickRequest(req)) return false
    try {
      const fence = fenceOf(req.lastUserText)
      return title === `Ticker · ${fence.local.date.slice(5)} ${fence.local.time}`
    } catch {
      return false
    }
  })
}

/** 绑定 ticker 的会话，按创建先后 */
function tickerSessions(): Promise<TickerSession[]> {
  return app.main.eval<TickerSession[]>(
    `window.api.session.list().then((ss) => ss
      .filter((s) => s.settings && s.settings.bot === 'ticker')
      .map((s) => ({
        id: s.id,
        title: s.title,
        projectId: s.projectId,
        parentId: s.parentId,
        bot: s.settings.bot,
        triggerRun: s.settings.triggerRun === true,
        workProject: s.settings.workProject ?? null,
        createdAt: s.createdAt
      }))
      .sort((a, b) => a.createdAt - b.createdAt))`
  )
}

/** 触发日志（新的在前）；不给 limit 走缺省 */
function triggerLogs(limit?: number): Promise<LogEntry[]> {
  return app.main.eval<LogEntry[]>(
    `window.api.trigger.logs(${limit === undefined ? '' : JSON.stringify({ limit })})`
  )
}

function timerSetting(): Promise<string | null | undefined> {
  return app.main.eval<string | null | undefined>(
    `window.api.settings.get(${JSON.stringify(TIMER_KEY)})`
  )
}

function timerLastFiredAt(): Promise<string | null> {
  return app.main.eval<string | null>(
    `window.api.trigger.status().then((ss) => {
      const s = ss.find((x) => x.id === ${JSON.stringify(TIMER_ID)})
      return s && s.lastFiredAt ? s.lastFiredAt : null
    })`
  )
}

beforeAll(async () => {
  app = await launchApp()
  provider = await startFakeProvider()
  await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: 'e2e-trigger-model' })
  await waitRendererReady(app.main)
  // 每次触发运行一个回复：第一次必须正常跑完（lastFiredAt 只在跑成之后记），之后多出来的走缺省 OK（同样跑成）
  for (let i = 0; i < 4; i++) {
    provider.script({ when: isTickRequest, text: REPLY, usage: { prompt: 300, completion: 12 } })
  }
  writeBotMd(app, 'ticker', {
    displayName: 'Ticker',
    rawLines: ['shuvix-bot-on:', '  - trigger: timer.fired', `    message: ${MESSAGE}`]
  })
  writeBotMd(app, 'never', {
    displayName: 'Never',
    rawLines: [
      'shuvix-bot-on:',
      '  - trigger: timer.fired',
      '    when: "false"',
      '    message: Never runs.'
    ]
  })
  writeBotMd(app, 'typo', {
    displayName: 'Typo',
    rawLines: [
      'shuvix-bot-on:',
      '  - trigger: timer.fired',
      `    when: "${TYPO_WHEN}"`,
      '    message: Typo runs.'
    ]
  })
}, 120_000)

afterAll(async () => {
  // 先拿掉 bot 文件：收尾期间不再有分钟触发去建会话
  if (app) {
    for (const name of ['ticker', 'never', 'typo']) {
      rmSync(join(app.botsDir, `${name}.md`), { force: true })
    }
  }
  settings?.close()
  await app?.stop()
  await provider?.close()
})

describe('timer.fired 叫起 bot', () => {
  it('BT-E1 一分钟之内冒出一条绑定 ticker 的临时会话：无项目、无父会话、无工作项目，标着 triggerRun，标题「Ticker · MM-DD HH:MM」', async () => {
    first = await until(
      async () => (await tickerSessions())[0],
      'first ticker session',
      NEXT_FIRE_MS
    )
    expect(first.bot).toBe('ticker')
    expect(first.projectId).toBeNull()
    expect(first.parentId).toBeNull()
    expect(first.triggerRun).toBe(true)
    expect(first.workProject).toBeNull()
    expect(first.title).toMatch(/^Ticker · \d{2}-\d{2} \d{2}:\d{2}$/)
  }, 120_000)

  it('BT-E2 发给模型的是 message + 空行 + <trigger_event> 围栏：这一分钟的事实，第一次没有 lastFiredAt', async () => {
    const req = await until(() => tickRequestFor(first.title), 'provider request of the first run')
    // 整条消息逐字是「message + 空行 + 围栏」（fenceOf 的正则锚定首尾）
    expect(req.lastUserText.startsWith(`${MESSAGE}\n\n${FENCE_OPEN}\n`)).toBe(true)
    expect(req.lastUserText.endsWith('\n</trigger_event>')).toBe(true)
    firstFence = fenceOf(req.lastUserText)

    expect(Object.keys(firstFence).sort()).toEqual(['firedAt', 'local', 'sourceId'])
    expect(firstFence.sourceId).toBe(TIMER_ID)
    // 对齐整分钟：秒与毫秒恒为 0
    expect(firedAtShape(firstFence.firedAt)).toBe(true)
    // 本地字段与 firedAt 是同一刻，标题取的就是它们
    const at = new Date(firstFence.firedAt)
    expect(firstFence.local).toEqual({
      date: dayKey(at),
      time: `${pad(at.getHours())}:${pad(at.getMinutes())}`,
      weekday: at.getDay(),
      hour: at.getHours(),
      minute: at.getMinutes()
    })
    expect(first.title).toBe(`Ticker · ${firstFence.local.date.slice(5)} ${firstFence.local.time}`)
  })

  it('BT-E3 侧栏里它折在 ticker 组的「定时运行」里；点开：用户气泡带「触发器」来源标签（悬停说出 ticker 与 timer.fired），脚本回复照常渲染', async () => {
    const bots = botsPane(app.main)
    // 分节一挂上就扫了（那时 ticker.md 还没落盘）—— 刷新一次，组头才是生效的 ticker 组
    await bots.refresh()
    await bots.waitGroup('ticker')
    const runs = await until(async () => {
      const r = await bots.runs('ticker')
      return r && r.rows.some((row) => row.title === first.title) ? r : null
    }, "the first run inside the ticker group's scheduled-runs row")
    expect(runs.state).toBe('collapsed')
    expect(runs.count).toBe(runs.rows.length)
    expect(await bots.groupSessions('ticker')).toEqual([])

    // 折叠只收高度，行仍在 DOM 里：照样点得开
    const sidebar = sidebarPane(app.main)
    await until(() => sidebar.openSession(first.title), `sidebar row "${first.title}"`)
    const chat = chatPane(app.main)
    await chat.ready()
    await until(
      async () =>
        (await chat.items()).some((it) => it.role === 'assistant' && it.text.includes(REPLY)),
      'scripted reply rendered'
    )
    const badge = await until(
      async () => (await chatOriginBadges(app.main)).find((b) => b.origin === 'trigger'),
      'trigger origin badge'
    )
    expect(badge.role).toBe('user')
    expect(badge.title).toContain('ticker')
    expect(badge.title).toContain('timer.fired')
    expect(ORIGIN_TRIGGER).toContain(badge.text)
    // 触发器不是一条会话：标签不是可点的按钮
    expect(badge.button).toBe(false)
    // 气泡正文就是绑定里的那句话（围栏也在，渲染成正文的一部分）
    const userItem = (await chat.items()).find((it) => it.id === badge.msgId)
    expect(userItem?.text).toContain(MESSAGE)
  })

  it('BT-E4 when 为 false、when 求值出错的绑定都不建会话；出错只记一次日志', async () => {
    // fire 在同一次 tick 里逐个求值全部 bot：ticker 的会话已经在了，never / typo 这一分钟也已求值过
    expect(await sessionsBoundTo(app.main, 'never')).toEqual([])
    expect(await sessionsBoundTo(app.main, 'typo')).toEqual([])
    const failures = app.mainLog().match(/bot "typo": when evaluation failed/g) ?? []
    expect(failures).toHaveLength(1)
    expect(app.mainLog()).not.toMatch(/bot "never": when evaluation failed/)
  })
})

describe('设置 → 触发源', () => {
  it('BT-E5 tab 带实验标签；开关缺省开；副标题是上次触发的时刻；不列订阅者；「上一次的事件」缺省收起，JSON 是 when 看到的 event', async () => {
    settings = await app.openSettings('triggers')
    triggers = triggerSettingsPane(settings)
    await triggers.waitSource(TIMER_ID)
    expect(await triggers.tabExperimental()).toBe(true)

    const shot = (await triggers.source(TIMER_ID))!
    expect(shot.enabled).toBe(true)
    expect(await timerSetting()).toBeFalsy()
    expect(NOT_FIRED_YET).not.toContain(shot.subtitle)
    expect(LAST_FIRED_PREFIXES.some((p) => shot.subtitle.startsWith(p))).toBe(true)

    // 触发源与 bot 解绑：块里没有订阅者列表，三个 bot 的名字与 when 都不在触发源块里
    expect(shot.subscriberList).toBe(false)
    expect(await triggers.anySubscriberList()).toBe(false)
    for (const text of ['Ticker', 'Never', 'Typo', TYPO_WHEN]) expect(shot.text).not.toContain(text)

    // 上一次的原始事件：缺省收起，点 summary 展开
    const last = await until(() => triggers.lastEvent(TIMER_ID), 'last-event block')
    expect(last.open).toBe(false)
    expect(LAST_EVENT_SUMMARY).toContain(last.summary)
    await triggers.toggleLastEvent(TIMER_ID)
    expect((await triggers.lastEvent(TIMER_ID))?.open).toBe(true)

    const event = JSON.parse(last.json) as TriggerFence & { trigger: string }
    expect(Object.keys(event).sort()).toEqual(['firedAt', 'local', 'sourceId', 'trigger'])
    expect(event.trigger).toBe('timer.fired')
    expect(event.sourceId).toBe(TIMER_ID)
    expect(firedAtShape(event.firedAt)).toBe(true)
    expect(Date.parse(event.firedAt)).toBeGreaterThanOrEqual(Date.parse(firstFence.firedAt))
    const at = new Date(event.firedAt)
    expect(event.local.time).toMatch(/^\d{2}:\d{2}$/)
    expect(event.local).toEqual({
      date: dayKey(at),
      time: `${pad(at.getHours())}:${pad(at.getMinutes())}`,
      weekday: at.getDay(),
      hour: at.getHours(),
      minute: at.getMinutes()
    })
  })

  it('BT-E8 触发日志列出 ticker 的第一次运行：completed、带会话、展开看绑定 / 没有条件 / 事件；「打开对话」切到那条会话', async () => {
    // 那一轮跑完才改成 completed（BT-E6 的 lastFiredAt 同样靠它跑成）
    const entry = await until(
      async () =>
        (await triggerLogs()).find((e) => e.sessionId === first.id && e.outcome === 'completed'),
      'completed log entry of the first run'
    )
    expect(entry).toMatchObject({
      sourceId: TIMER_ID,
      trigger: 'timer.fired',
      bot: 'ticker',
      botDisplayName: 'Ticker',
      botFile: 'ticker.md',
      bindingIndex: 0,
      when: '',
      error: ''
    })
    // 日志里的事件 = 这一分钟的载荷 + trigger（围栏里第一次没有 lastFiredAt，两边一样）
    expect(entry.event).toEqual({ ...firstFence, trigger: 'timer.fired' })
    expect((await triggerLogs()).filter((e) => e.sessionId === first.id)).toHaveLength(1)

    const row = await until(
      async () =>
        (await triggers.logRows())?.find((r) => r.id === entry.id && r.outcome === 'completed'),
      'log row of the first run shown as completed'
    )
    expect(row.botDisplayName).toBe('Ticker')
    expect(COMPLETED).toContain(row.outcomeLabel)
    expect(row.time).not.toBe('')
    expect(row.canOpen).toBe(true)
    expect(row.details).toBeNull()

    // 页里的行与 trigger.logs() 同序；{limit: 1} 只给最新一条（此刻至少有 ticker 与 typo 两条）
    await until(async () => {
      const api = (await triggerLogs()).map((e) => e.id)
      const dom = ((await triggers.logRows()) ?? []).map((r) => r.id)
      return api.length >= 2 && JSON.stringify(api) === JSON.stringify(dom)
    }, 'log rows in the same order as trigger.logs()')
    await until(async () => {
      const one = await triggerLogs(1)
      const all = await triggerLogs()
      return one.length === 1 && all.length >= 2 && one[0].id === all[0].id
    }, 'trigger.logs({limit: 1}) returns only the newest entry')

    await triggers.expandLogRow(entry.id)
    const open = (await triggers.logRows())!.find((r) => r.id === entry.id)!
    expect(open.details).not.toBeNull()
    expect(bindingLines('ticker.md', 1, 'timer.fired')).toContain(open.details!.binding)
    expect(NO_CONDITION).toContain(open.details!.when)
    expect(open.details!.error).toBeNull()
    expect(JSON.parse(open.details!.event)).toEqual(entry.event)

    // 主窗先切到一条对照会话，再点「打开对话」：主窗切回那次运行的会话
    await app.main.eval(`window.api.session.create({ title: ${JSON.stringify(CONTROL_TITLE)} })`)
    const sidebar = sidebarPane(app.main)
    await until(() => sidebar.openSession(CONTROL_TITLE), `sidebar row "${CONTROL_TITLE}"`)
    expect(await sidebar.activeTitle()).toBe(CONTROL_TITLE)
    await triggers.openLogSession(entry.id)
    await until(
      async () => (await sidebar.activeTitle()) === first.title,
      'main window switched to the run session'
    )
  })

  it('BT-E9 typo 恰一条 condition-error（无打开钮；展开是 when 原文与 CEL 报错）；never 一条都没有', async () => {
    const logs = await triggerLogs()
    const typo = logs.filter((e) => e.bot === 'typo')
    expect(typo).toHaveLength(1)
    expect(typo[0]).toMatchObject({
      sourceId: TIMER_ID,
      trigger: 'timer.fired',
      botDisplayName: 'Typo',
      botFile: 'typo.md',
      bindingIndex: 0,
      when: TYPO_WHEN,
      outcome: 'condition-error',
      sessionId: ''
    })
    expect(typo[0].error).toContain('activeSession')
    expect(typo[0].event).toMatchObject({ trigger: 'timer.fired', sourceId: TIMER_ID })
    expect(logs.filter((e) => e.bot === 'never')).toEqual([])

    const row = await until(
      async () => (await triggers.logRows())?.find((r) => r.id === typo[0].id),
      'condition-error row of typo'
    )
    expect(row.outcome).toBe('condition-error')
    expect(row.botDisplayName).toBe('Typo')
    expect(CONDITION_ERROR).toContain(row.outcomeLabel)
    expect(row.canOpen).toBe(false)

    await triggers.expandLogRow(typo[0].id)
    const open = (await triggers.logRows())!.find((r) => r.id === typo[0].id)!
    expect(bindingLines('typo.md', 1, 'timer.fired')).toContain(open.details!.binding)
    expect(open.details!.when).toBe(TYPO_WHEN)
    expect(open.details!.error).toBe(typo[0].error.trim())
    expect(JSON.parse(open.details!.event)).toEqual(typo[0].event)

    expect((await triggers.logRows())!.some((r) => r.botDisplayName === 'Never')).toBe(false)
  })
})

describe('下一分钟', () => {
  it('BT-E6 第二条 ticker 会话：lastFiredAt = 上一次的 firedAt（本机时区偏移），firedAt 恰好晚 60 秒', async () => {
    const sessions = await until(
      async () => {
        const all = await tickerSessions()
        return all.length >= 2 ? all : null
      },
      'second ticker session',
      NEXT_FIRE_MS
    )
    expect(sessions[0].id).toBe(first.id)
    const second = sessions[1]
    expect(second.title).toMatch(/^Ticker · \d{2}-\d{2} \d{2}:\d{2}$/)
    expect(second.title).not.toBe(first.title)

    const req = await until(
      () => tickRequestFor(second.title),
      'provider request of the second run'
    )
    const fence = fenceOf(req.lastUserText)
    expect(Object.keys(fence).sort()).toEqual(['firedAt', 'lastFiredAt', 'local', 'sourceId'])
    expect(fence.sourceId).toBe(TIMER_ID)
    expect(fence.firedAt).toBe(new Date(Date.parse(firstFence.firedAt) + 60_000).toISOString())
    // 同一刻，换成带本机时区偏移的写法（日期就是本地日）
    expect(fence.lastFiredAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/)
    expect(Date.parse(fence.lastFiredAt!)).toBe(Date.parse(firstFence.firedAt))
    expect(fence.lastFiredAt).toBe(localIso(new Date(firstFence.firedAt)))

    // 开着的触发源页随 trigger.logged 列出这一次（日志不靠 30 秒的状态轮询，也没重开页）
    const secondRow = await until(async () => {
      const entry = (await triggerLogs()).find((e) => e.sessionId === second.id)
      if (!entry) return null
      return (await triggers.logRows())?.find((r) => r.id === entry.id) ?? null
    }, 'log row of the second run on the open page')
    expect(secondRow.botDisplayName).toBe('Ticker')
    expect(['started', 'completed']).toContain(secondRow.outcome)
    expect(secondRow.canOpen).toBe(true)
    // 又求值了一分钟：typo 的同一个错误不再记，never 仍一条都没有
    const logs = await triggerLogs()
    expect(logs.filter((e) => e.bot === 'typo')).toHaveLength(1)
    expect(logs.filter((e) => e.bot === 'never')).toEqual([])
  }, 120_000)

  it("BT-E7 关掉开关：设置项写成 'false'，跨过下一个整分钟不再建会话，「上次触发」不动", async () => {
    await triggers.toggle(TIMER_ID)
    await until(async () => (await timerSetting()) === 'false', 'timer setting written as false')
    expect((await triggers.source(TIMER_ID))?.enabled).toBe(false)

    // 设置落定之后的每一次 tick 都不发事件：此刻的会话数与「上次触发」就是之后该有的样子
    const count = (await tickerSessions()).length
    const lastFired = await timerLastFiredAt()
    expect(lastFired).not.toBeNull()

    // 跨过下一个整分钟（tick 在整分后 50 ms，会话在 tick 里同步建出来）再多留 3 秒
    const boundary = Math.ceil(Date.now() / 60_000) * 60_000
    await until(() => Date.now() > boundary + 3_000, 'next minute boundary passed', 70_000, {
      intervalMs: 500
    })
    expect(await tickerSessions()).toHaveLength(count)
    expect(await timerLastFiredAt()).toBe(lastFired)
  }, 90_000)

  it('BT-E10 清空日志：弹确认；取消什么都不动；确认后是空态、没有「清空」钮，trigger.logs() 为 []', async () => {
    // 开关已关：不再有新条目，两次运行也都跑完了
    const before = await until(async () => {
      const logs = await triggerLogs()
      return logs.length > 0 && logs.every((e) => e.outcome !== 'started') ? logs : null
    }, 'settled trigger log')
    await until(
      async () => ((await triggers.logRows()) ?? []).length === before.length,
      'log rows match trigger.logs()'
    )
    expect(await triggers.hasClearButton()).toBe(true)

    const confirm = confirmPane(settings!)
    await triggers.clickClearLog()
    await confirm.waitOpen()
    expect(CLEAR_CONFIRM).toContain((await confirm.snapshot()).title)
    await confirm.cancel()
    await confirm.waitClosed()
    expect((await triggerLogs()).map((e) => e.id)).toEqual(before.map((e) => e.id))
    expect(((await triggers.logRows()) ?? []).map((r) => r.id)).toEqual(before.map((e) => e.id))

    await triggers.clickClearLog()
    await confirm.waitOpen()
    await confirm.confirm()
    await confirm.waitClosed()
    const empty = await until(() => triggers.logEmpty(), 'trigger log empty state')
    expect(LOG_EMPTY).toContain(empty)
    expect(await triggers.logRows()).toEqual([])
    expect(await triggers.hasClearButton()).toBe(false)
    expect(await triggerLogs()).toEqual([])
  })
})

/** firedAt：UTC ISO，对齐到整分钟 */
function firedAtShape(iso: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/.test(iso)
}
