/**
 * 被中断的会话（P3-12，Q-P3-10）—— 上个进程退出时正在跑的会话：侧栏圆点、输入卡片横幅、[继续]、
 * 直接发新消息（abort-then-send），外加重试倒计时与「重试 ×N」。
 *
 * 做法：两条会话 S1（继续）/ S2（直接发）各起一轮挂住的回复（`holdMs`），等假提供商挂住、再多等一会儿让
 * 'stale' 那段部分正文落进实时状态（PIN-24），然后 `stop({ keepHome: true })` 停机、`launchApp({ home })`
 * 用同一个 HOME 重开。假提供商活在 vitest 进程里，跨两次启动不变。
 *
 *   INT-1 (P3-12-22) 两条会话都还没打开：`session.list` 报 `runState:'interrupted'`，库里的镜像仍是 busy，
 *         侧栏两行都有圆点
 *   INT-2 (P3-12-23) 打开 S1：横幅文案逐字、提示行在；`message.list` 只有 [user 'first']；视图 run.state 是 interrupted
 *   INT-3 (P3-12-24) 点 [继续]：假提供商收到新请求；`message.list` = [user 'first', assistant(中止的 'stale'),
 *         assistant 'resumed answer']；横幅没了、`session.list` 报 idle、圆点没了
 *   INT-4 (P3-12-25) 打开 S2（横幅在）、输入 'new question' 回车：重开之后 S2 恰一次请求、最后一条用户消息是
 *         'new question'；'first' 只出现一次、以 user 'new question' → assistant 'fresh answer' 收尾（若有 'stale'
 *         卡则是中止的）；横幅、圆点都没了
 *   INT-5 (P3-12-26) 503 一次再成功：页面侧观察到 `[data-run-retry]` 提到第 2 次尝试；最后那张卡「retried ×1」，
 *         `message.list` 那条消息 `metadata.retried.count === 1`
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sleep, until } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import { startFakeProvider, type FakeProvider, type FakeRequest } from '../../harness/fakeProvider'
import { seedFakeProvider, sqliteJson, waitRendererReady } from '../../harness/seed'
import { chatPane, sidebarPane, type ChatPane, type SidebarPane } from '../../harness/pages'
import { syncProbe } from '../../harness/sync'

const MODEL = 'e2e-model'
const BANNER = 'This run was interrupted when ShuviX closed'
const HINT = 'Or send a new message — the interrupted run will be stopped first.'

interface ListedMessage {
  id: string
  role: string
  type: string
  content: string
  metadata?: Record<string, unknown> | null
}

interface ListedSession {
  id: string
  title: string
  settings: { runState?: string }
}

let first: E2EApp | undefined
let app: E2EApp
let home = ''
let provider: FakeProvider
let chat: ChatPane
let sidebar: SidebarPane
const sids: Record<'continue' | 'send', string> = { continue: '', send: '' }

const listMessages = (sid: string): Promise<ListedMessage[]> =>
  app.main.eval<ListedMessage[]>(`window.api.message.list(${JSON.stringify(sid)})`)

const listSessions = (): Promise<ListedSession[]> =>
  app.main.eval<ListedSession[]>(`window.api.session.list()`)

const runStateOf = async (sid: string): Promise<string | undefined> =>
  (await listSessions()).find((s) => s.id === sid)?.settings.runState

const brief = (m: ListedMessage): string => `${m.role}:${m.content}`

/** S1 / S2 在第一个进程里各挂住一轮 */
async function holdTurn(sid: string): Promise<void> {
  const before = provider.chatRequestCount()
  provider.script({ text: 'stale', holdMs: 60_000 })
  // 不 await：prompt 要等整轮落定才回，而这一轮挂着
  await first!.main.eval(
    `(window.api.agent.prompt(${JSON.stringify({ sessionId: sid, text: 'first' })}), true)`
  )
  await until(
    () => provider.chatRequestCount() > before && provider.holding(),
    `turn of ${sid} holding`
  )
  // PIN-24：部分正文进了实时状态之后再停机
  await sleep(600)
}

beforeAll(async () => {
  provider = await startFakeProvider()
  first = await launchApp()
  home = first.home
  await seedFakeProvider(first.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  await waitRendererReady(first.main)
  // 文案断言用英文：界面语言写进设置，重开之后照样生效（缺省跟随系统语言）
  await first.main.eval(`window.api.settings.set({ key: 'general.language', value: 'en' })`)
  const create = (title: string): Promise<string> =>
    first!.main.eval<string>(
      `window.api.session.create(${JSON.stringify({ title })}).then((s) => s.id)`
    )
  sids.continue = await create('INT-continue')
  sids.send = await create('INT-send')

  provider.reset()
  await holdTurn(sids.continue)
  await holdTurn(sids.send)

  await first.stop({ keepHome: true })
  first = undefined
  app = await launchApp({ home })
  await waitRendererReady(app.main)
  chat = chatPane(app.main)
  sidebar = sidebarPane(app.main)
  await until(async () => {
    const titles = await sidebar.titles()
    return titles.includes('INT-continue') && titles.includes('INT-send')
  }, 'sidebar rows after relaunch')
}, 120_000)

afterAll(async () => {
  await first?.stop()
  await app?.stop()
  await provider?.close()
})

describe('INT-1 marker', () => {
  it('P3-12-22 before either session is opened: session.list says interrupted, the mirror still says busy, both rows show the dot', async () => {
    expect(await runStateOf(sids.continue)).toBe('interrupted')
    expect(await runStateOf(sids.send)).toBe('interrupted')
    const rows = sqliteJson<{ id: string; runState: string | null }>(
      home,
      `SELECT id, json_extract(settings, '$.runState') AS runState FROM sessions WHERE id IN ('${sids.continue}', '${sids.send}')`
    )
    expect(new Map(rows.map((r) => [r.id, r.runState]))).toEqual(
      new Map([
        [sids.continue, 'busy'],
        [sids.send, 'busy']
      ])
    )
    expect(await sidebar.interruptedOf('INT-continue')).toBe(true)
    expect(await sidebar.interruptedOf('INT-send')).toBe(true)
  })
})

describe('INT-2 / INT-3 continue', () => {
  it('P3-12-23 opening S1 shows the banner with the exact copy and the hint; message.list is [user first]', async () => {
    expect(await sidebar.openSession('INT-continue')).toBe(true)
    await chat.ready()
    await until(async () => (await chat.interruptedBanner()) !== null, 'interrupted banner')
    expect(await chat.interruptedBanner()).toEqual({
      text: BANNER,
      hint: HINT,
      continueDisabled: false
    })
    expect((await listMessages(sids.continue)).map(brief)).toEqual(['user:first'])
    const view = await syncProbe(app.main).waitView(
      sids.continue,
      (v) => v.run.state === 'interrupted',
      10_000,
      'S1 view interrupted'
    )
    expect(view.source).toBe('durable')
  })

  it('P3-12-24 Continue: a new provider request; the transcript ends with the aborted stale card and the resumed answer; banner, runState and dot follow', async () => {
    provider.reset()
    provider.script({ text: 'resumed answer' })
    expect(await chat.clickContinue()).toBe(true)
    await until(() => provider.chatRequestCount() === 1, 'continue reached the provider')
    await syncProbe(app.main).waitView(
      sids.continue,
      (v) => v.run.state === 'idle' && v.messages.some((m) => m.content === 'resumed answer'),
      30_000,
      'S1 resumed and settled'
    )
    const listed = await listMessages(sids.continue)
    // 'stale' 是被中断那一轮的部分正文：继续时它落成自己的一条（中止收尾，P3-02-29 —— 界面消息上不带
    // stopReason，形状本身就是证据：它单独成卡、后面跟着重跑出来的回答）
    expect(listed.map(brief)).toEqual(['user:first', 'assistant:stale', 'assistant:resumed answer'])
    await until(async () => (await chat.interruptedBanner()) === null, 'banner gone')
    await until(async () => (await runStateOf(sids.continue)) === 'idle', 'session.list idle')
    expect(await sidebar.interruptedOf('INT-continue')).toBe(false)
  })
})

describe('INT-4 send while interrupted', () => {
  it('P3-12-25 typing a new message aborts the interrupted run first, then sends; one request, ends with new question → fresh answer', async () => {
    provider.reset()
    provider.script({ text: 'fresh answer' })
    expect(await sidebar.openSession('INT-send')).toBe(true)
    await chat.ready()
    await until(async () => (await chat.interruptedBanner()) !== null, 'S2 banner')
    await chat.typeAndSend('new question')
    await syncProbe(app.main).waitView(
      sids.send,
      (v) => v.run.state === 'idle' && v.messages.some((m) => m.content === 'fresh answer'),
      30_000,
      'S2 answered'
    )
    const requests: FakeRequest[] = provider.chatRequests()
    expect(requests).toHaveLength(1)
    expect(requests[0]!.lastUserText).toBe('new question')
    const listed = await listMessages(sids.send)
    expect(listed.filter((m) => m.role === 'user' && m.content === 'first')).toHaveLength(1)
    expect(listed.slice(-2).map(brief)).toEqual(['user:new question', 'assistant:fresh answer'])
    // 先中止再发：被中断的那一轮最多留下它的部分正文（一条 'stale'），绝不会在新消息之后再续出什么
    expect(listed.filter((m) => m.content === 'stale').length).toBeLessThanOrEqual(1)
    expect(listed.map(brief).slice(0, 1)).toEqual(['user:first'])
    await until(async () => (await chat.interruptedBanner()) === null, 'S2 banner gone')
    expect(await sidebar.interruptedOf('INT-send')).toBe(false)
  })
})

describe('INT-5 retry', () => {
  it('P3-12-26 a 503 then success: the countdown mentions attempt 2 while waiting; the final card says retried ×1 and the message carries retried.count 1', async () => {
    const sid = await app.main.eval<string>(
      `window.api.session.create(${JSON.stringify({ title: 'INT-retry' })}).then((s) => s.id)`
    )
    await until(async () => (await sidebar.titles()).includes('INT-retry'), 'INT-retry row')
    expect(await sidebar.openSession('INT-retry')).toBe(true)
    await chat.ready()
    // 页面侧观察者：倒计时只在退避那两秒里在屏，轮询可能漏掉
    await app.main.eval(`(() => {
      window.__e2eRetrySeen = []
      const seen = () => {
        const el = document.querySelector('[data-run-retry]')
        if (el) window.__e2eRetrySeen.push(el.textContent || '')
      }
      new MutationObserver(seen).observe(document.body, { subtree: true, childList: true, characterData: true })
      return true
    })()`)
    provider.reset()
    provider.script({ httpStatus: 503 }, { text: 'after retry' })
    await chat.typeAndSend('retry me')
    await syncProbe(app.main).waitView(
      sid,
      (v) => v.run.state === 'idle' && v.messages.some((m) => m.content === 'after retry'),
      30_000,
      'retry settled'
    )
    const seen = await app.main.eval<string[]>(`window.__e2eRetrySeen`)
    expect(seen.some((text) => text.includes('attempt 2'))).toBe(true)
    // 重试成功恢复后卡上不留重试记录（倒计时只在重试进行中出现，上面已断言）
    expect(await chat.retriedHints()).toEqual([])
    const listed = await listMessages(sid)
    const answer = listed.find((m) => m.content === 'after retry')!
    expect((answer.metadata as { retried?: { count: number } }).retried?.count).toBe(1)
    expect(await chat.errorRows()).toBe(0)
  })
})
