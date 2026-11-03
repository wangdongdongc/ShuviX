/**
 * 打开一条有记录的会话：空态（会话设置面板）一次都不出现，等视图到了直接是消息（chat-ui Conversation 的空态门）。
 * 从前只看「消息是空的」，而视图到达之前消息本来就是空的，于是每次切会话都先闪一下设置面板。
 *
 *   OPEN-1 两条有记录的会话来回切：每次 DOM 提交都没有空态，目标会话的消息最终上屏
 *   OPEN-2 从欢迎页（没有当前会话）打开：同上
 *   OPEN-3 停在有记录的会话上重载窗口：同上（整个页面从头来，看守脚本在页面脚本之前装好）
 *   OPEN-4 真正的空会话：空态照常出现并留在那里
 *
 * 判据用 MutationObserver 而不是截帧：它看得到每一次提交，窗口在不在前台都一样，闪一帧也漏不掉。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { until } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import { startFakeProvider, type FakeProvider } from '../../harness/fakeProvider'
import { seedFakeProvider, waitRendererReady } from '../../harness/seed'
import { chatPane, sidebarPane, type ChatPane, type SidebarPane } from '../../harness/pages'

const MODEL = 'e2e-model'
const USAGE = { prompt: 200, completion: 50 }
const TITLES = { a: 'OPEN-a', b: 'OPEN-b', empty: 'OPEN-empty' } as const
const EMPTY = '[data-conversation-empty]'

let app: E2EApp
let provider: FakeProvider
let chat: ChatPane
let sidebar: SidebarPane
const sids: Record<string, string> = {}
const ids: Record<string, string[]> = {}

/** 在页面里记下每次 DOM 提交时空态在不在、目标消息第一次上屏的时刻（幂等：页面脚本之前装也行） */
const WATCH = `(() => {
  window.__openWatch = { emptyCommits: 0, targets: [], t0: 0, shownAt: 0 }
  const scan = () => {
    const w = window.__openWatch
    if (document.querySelector(${JSON.stringify(EMPTY)})) w.emptyCommits++
    if (!w.shownAt && w.targets.some((id) => document.querySelector('[data-msg-id=' + JSON.stringify(id) + ']'))) {
      w.shownAt = performance.now()
    }
  }
  new MutationObserver(scan).observe(document, { childList: true, subtree: true, attributes: true })
})()`

interface WatchShot {
  emptyCommits: number
  shownAt: number
  t0: number
}

/** 重新布防：清零计数，下一次打开要等的是这些消息 */
const arm = (targets: string[]): Promise<boolean> =>
  app.main.eval<boolean>(
    `(() => {
      Object.assign(window.__openWatch, {
        emptyCommits: 0,
        targets: ${JSON.stringify(targets)},
        t0: performance.now(),
        shownAt: 0
      })
      return true
    })()`
  )

const shot = (): Promise<WatchShot> =>
  app.main.eval<WatchShot>(`(() => {
    const { emptyCommits, shownAt, t0 } = window.__openWatch
    return { emptyCommits, shownAt, t0 }
  })()`)

const hasMessage = (targets: string[]): Promise<boolean> =>
  app.main.eval<boolean>(
    `${JSON.stringify(targets)}.some((id) => document.querySelector('[data-msg-id=' + JSON.stringify(id) + ']'))`
  )

/** 打开一条有记录的会话，等它的消息上屏，核对这一路没有空态 */
async function openWithHistory(title: string, sid: string): Promise<number> {
  await arm(ids[sid])
  expect(await sidebar.openSession(title)).toBe(true)
  await until(async () => (await shot()).shownAt > 0, `${title}: messages on screen`)
  const seen = await shot()
  expect(seen.emptyCommits).toBe(0)
  return seen.shownAt - seen.t0
}

beforeAll(async () => {
  app = await launchApp()
  provider = await startFakeProvider()
  await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  await waitRendererReady(app.main)

  // 标题显式给出：默认标题会触发自动标题，titler 的请求要从假提供商的队列里取一轮
  const create = (title: string): Promise<string> =>
    app.main.eval<string>(
      `window.api.session.create(${JSON.stringify({ title })}).then((s) => s.id)`
    )
  sids.a = await create(TITLES.a)
  sids.b = await create(TITLES.b)
  sids.empty = await create(TITLES.empty)
  for (const key of ['a', 'b'] as const) {
    provider.script({ text: `${key} answer`, usage: USAGE })
    await app.main.eval(
      `window.api.agent.prompt(${JSON.stringify({ sessionId: sids[key], text: `${key} question` })}).then(() => true)`
    )
    ids[sids[key]] = await app.main.eval<string[]>(
      `window.api.message.list(${JSON.stringify(sids[key])}).then((list) => list.map((m) => m.id))`
    )
    expect(ids[sids[key]].length).toBe(2)
  }

  chat = chatPane(app.main)
  sidebar = sidebarPane(app.main)
  await sidebar.clickNewChat()
  await until(async () => (await sidebar.titles()).includes(TITLES.empty), 'sidebar refreshed')
  await app.main.eval(WATCH)
}, 180_000)

afterAll(async () => {
  await provider?.close()
  await app?.stop()
})

describe('打开有记录的会话不闪空态', () => {
  it('OPEN-1 两条会话来回切', async () => {
    const times: number[] = []
    for (let round = 0; round < 5; round++) {
      times.push(await openWithHistory(TITLES.a, sids.a))
      times.push(await openWithHistory(TITLES.b, sids.b))
    }
    console.log(`[OPEN-1] click → messages (ms): ${times.map((t) => t.toFixed(1)).join(' ')}`)
  })

  it('OPEN-2 从欢迎页打开', async () => {
    await sidebar.clickNewChat()
    await until(
      () => app.main.eval<boolean>(`!document.querySelector('[data-msg-id]')`),
      'welcome page is up'
    )
    await openWithHistory(TITLES.a, sids.a)
  })

  it('OPEN-3 停在有记录的会话上重载窗口', async () => {
    expect(await sidebar.openSession(TITLES.b)).toBe(true)
    await until(() => hasMessage(ids[sids.b]), 'b: messages on screen before reload')
    // 新文档脚本要 Page 域开着才生效
    await app.main.send('Page.enable')
    const install = await app.main.send<{ identifier: string }>(
      'Page.addScriptToEvaluateOnNewDocument',
      {
        source: `${WATCH}; window.__openWatch.targets = ${JSON.stringify(ids[sids.b])}`
      }
    )
    await app.main.eval('(window.__e2eBeforeReload = true)')
    await app.main.send('Page.reload')
    await until(
      () => app.main.eval<boolean>('window.__e2eBeforeReload === undefined').catch(() => false),
      'the page actually reloaded'
    )
    await waitRendererReady(app.main)
    await app.main.send('Page.removeScriptToEvaluateOnNewDocument', install)
    await until(async () => (await sidebar.titles()).includes(TITLES.b), 'sidebar after reload')
    expect(await sidebar.openSession(TITLES.b)).toBe(true)
    await until(async () => (await shot()).shownAt > 0, 'messages on screen after reload')
    expect((await shot()).emptyCommits).toBe(0)
  })
})

describe('真正的空会话', () => {
  it('OPEN-4 空态照常出现并留在那里', async () => {
    expect(await sidebar.openSession(TITLES.a)).toBe(true)
    await until(() => hasMessage(ids[sids.a]), 'a: messages on screen')
    expect(await sidebar.openSession(TITLES.empty)).toBe(true)
    await chat.ready()
    await until(
      () => app.main.eval<boolean>(`!!document.querySelector(${JSON.stringify(EMPTY)})`),
      'empty state on screen'
    )
    expect(await app.main.eval<boolean>(`!document.querySelector('[data-msg-id]')`)).toBe(true)
  })
})
