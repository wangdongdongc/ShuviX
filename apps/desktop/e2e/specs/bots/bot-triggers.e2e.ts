/**
 * bot 触发绑定（`shuvix-bot-on`，实验）—— 内置 timer 每分钟一次的 `timer.fired` 真的叫起一个 bot：
 *
 *   BT-E1 绑定命中 → 新开一条绑定该 bot 的临时会话（无项目、无父会话），标题「显示名 · MM-DD HH:MM」
 *   BT-E2 发给模型的就是「绑定里的 message + 空行 + <trigger_event> 围栏」，围栏 YAML 里是这一分钟的事实，第一次没有 lastFiredAt
 *   BT-E3 打开那条会话：用户气泡带「触发器」来源标签（悬停说出 bot 与埋点），脚本回复照常渲染
 *   BT-E4 `when: "false"` 与求值出错（函数名拼错）的绑定都不建会话；出错只记一次日志
 *   BT-E5 设置 → 触发源：tab 带实验标签；开关缺省开（设置项没写）；副标题是上次触发的时刻；三个订阅者各带自己的 when
 *   BT-E6 下一分钟又一条：围栏里的 lastFiredAt = 上一次（跑成了的）firedAt，带本机时区偏移；firedAt 恰好晚 60 秒
 *   BT-E7 关掉开关：设置项写成 'false'，跨过下一个整分钟不再建会话，「上次触发」不动
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
  chatOriginBadges,
  chatPane,
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
const EVERY_TIME = LOCALES.map((l) => l.settings.triggersEveryTime)
const NOT_FIRED_YET = LOCALES.map((l) => l.settings.triggersNotFiredYet)
const LAST_FIRED_PREFIXES = LOCALES.map((l) => l.settings.triggersLastFired.split('{{time}}')[0])
const ORIGIN_TRIGGER = LOCALES.map((l) => l.message.originTrigger)

/** 围栏里的 YAML（TimerFiredPayload + 这条绑定上一次跑成的时刻） */
interface TriggerFence {
  sourceId: string
  firedAt: string
  lastFiredAt?: string
  local: { date: string; time: string; weekday: number; hour: number; minute: number }
}

interface TickerSession {
  id: string
  title: string
  projectId: string | null
  parentId: string | null
  bot: string
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
        createdAt: s.createdAt
      }))
      .sort((a, b) => a.createdAt - b.createdAt))`
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
  it('BT-E1 一分钟之内冒出一条绑定 ticker 的临时会话：无项目、无父会话，标题「Ticker · MM-DD HH:MM」', async () => {
    first = await until(
      async () => (await tickerSessions())[0],
      'first ticker session',
      NEXT_FIRE_MS
    )
    expect(first.bot).toBe('ticker')
    expect(first.projectId).toBeNull()
    expect(first.parentId).toBeNull()
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

  it('BT-E3 打开那条会话：用户气泡带「触发器」来源标签（悬停说出 ticker 与 timer.fired），脚本回复照常渲染', async () => {
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
  it('BT-E5 tab 带实验标签；开关缺省开（设置项没写）；副标题是上次触发的时刻；三个订阅者各带自己的 when', async () => {
    settings = await app.openSettings('triggers')
    triggers = triggerSettingsPane(settings)
    await triggers.waitSource(TIMER_ID)
    expect(await triggers.tabExperimental()).toBe(true)

    const shot = await until(async () => {
      const s = await triggers.source(TIMER_ID)
      return s && s.subscribers.length === 3 ? s : null
    }, 'timer source with three subscribers')
    expect(shot.enabled).toBe(true)
    expect(await timerSetting()).toBeFalsy()
    expect(NOT_FIRED_YET).not.toContain(shot.subtitle)
    expect(LAST_FIRED_PREFIXES.some((p) => shot.subtitle.startsWith(p))).toBe(true)

    const byName = new Map(shot.subscribers.map((s) => [s.displayName, s.when]))
    expect([...byName.keys()].sort()).toEqual(['Never', 'Ticker', 'Typo'])
    expect(EVERY_TIME).toContain(byName.get('Ticker'))
    expect(byName.get('Never')).toBe('false')
    expect(byName.get('Typo')).toBe(TYPO_WHEN)
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
})

/** firedAt：UTC ISO，对齐到整分钟 */
function firedAtShape(iso: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/.test(iso)
}
