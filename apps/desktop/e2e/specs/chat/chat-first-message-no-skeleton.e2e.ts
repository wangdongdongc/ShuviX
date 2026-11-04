/**
 * 骨架只属于加载历史：没有历史要等的时候，再慢也不画（chat-ui Conversation 的 awaitsHistory）。
 * 从前新会话的第一句话也算「打开」，渲染进程一忙，列表定位超过 200ms，骨架就盖住刚发出去的话。
 *
 *   SKEL-1 欢迎页发第一句话，渲染进程很忙（CPU 降到 1/6），模型也迟迟不回：骨架一次都不出现，这句话上屏
 *   SKEL-2 从没发过消息的会话，主进程停住、视图迟到：骨架一次都不出现，等来的是空态
 *   SKEL-3 对照：有记录的会话同样停住主进程：骨架出现（上面两条不是因为这招不灵才过的）
 *
 * SKEL-1 必须先跑：应用刚启动时才在欢迎页（没有当前会话）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sleep, until } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import { startFakeProvider, type FakeProvider } from '../../harness/fakeProvider'
import { seedFakeProvider, waitRendererReady } from '../../harness/seed'
import { chatPane, sidebarPane, type ChatPane, type SidebarPane } from '../../harness/pages'

const MODEL = 'e2e-model'
const USAGE = { prompt: 200, completion: 50 }
const TITLES = { never: 'SKEL-never', used: 'SKEL-used' } as const
const EMPTY = '[data-conversation-empty]'
const SKELETON = '[data-conversation-skeleton]'
/** 主进程停多久：远超骨架的 200ms */
const STALL_MS = 900
const FIRST_MESSAGE = 'first message'

let app: E2EApp
let provider: FakeProvider
let chat: ChatPane
let sidebar: SidebarPane

/** 在页面里记下骨架、空态、可见消息第一次出现的时刻（主进程停住时 CDP 不通，只能靠它） */
const WATCH = `(() => {
  window.__skelWatch = { skeletonAt: 0, emptyAt: 0, shownAt: 0 }
  const scan = () => {
    const w = window.__skelWatch
    if (!w.skeletonAt && document.querySelector(${JSON.stringify(SKELETON)})) w.skeletonAt = performance.now()
    if (!w.emptyAt && document.querySelector(${JSON.stringify(EMPTY)})) w.emptyAt = performance.now()
    const message = document.querySelector('[data-msg-id]')
    if (!w.shownAt && message && getComputedStyle(message).visibility === 'visible') w.shownAt = performance.now()
  }
  new MutationObserver(scan).observe(document, { childList: true, subtree: true, attributes: true })
})()`

interface WatchShot {
  skeletonAt: number
  emptyAt: number
  shownAt: number
}

const arm = (): Promise<boolean> =>
  app.main.eval<boolean>(
    `(Object.assign(window.__skelWatch, { skeletonAt: 0, emptyAt: 0, shownAt: 0 }), true)`
  )
const shot = (): Promise<WatchShot> => app.main.eval<WatchShot>(`({ ...window.__skelWatch })`)

/** 点开侧栏里的会话，主进程紧接着停住：这段时间里视图一个都到不了 */
async function openDuringStall(title: string): Promise<void> {
  await arm()
  expect(await sidebar.clickSessionAfter(title, 30)).toBe(true)
  process.kill(app.pid, 'SIGSTOP')
  try {
    await sleep(STALL_MS)
  } finally {
    process.kill(app.pid, 'SIGCONT')
  }
}

beforeAll(async () => {
  app = await launchApp()
  provider = await startFakeProvider()
  await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  await waitRendererReady(app.main)
  chat = chatPane(app.main)
  sidebar = sidebarPane(app.main)
  await app.main.eval(WATCH)
}, 180_000)

afterAll(async () => {
  await provider?.close()
  await app?.stop()
})

describe('没有历史要等，不画骨架', () => {
  it('SKEL-1 欢迎页发第一句话，渲染进程很忙、模型迟迟不回', async () => {
    expect(
      await app.main.eval<boolean>(
        `!document.querySelector(${JSON.stringify(EMPTY)}) && !document.querySelector('[data-virtuoso-scroller]')`
      )
    ).toBe(true)
    // 第一个内容片之前就挂住：模型一个字都没回（chunkDelayMs 是发完一片才等，拦不住第一片）
    provider.script({
      text: '',
      holdMs: 60_000,
      usage: USAGE,
      when: (req) => req.lastUserText.includes(FIRST_MESSAGE)
    })
    provider.script({ text: 'title', usage: USAGE })
    await arm()
    await app.main.send('Emulation.setCPUThrottlingRate', { rate: 6 })
    try {
      await chat.typeAndSend(FIRST_MESSAGE)
      await until(() => provider.holding(), 'the model is holding its reply')
      await until(async () => (await shot()).shownAt > 0, 'the message is visible')
      // 骨架要来早该来了（200ms）：多等一段，模型还是没回
      await sleep(600)
      expect(provider.holding()).toBe(true)
    } finally {
      await app.main.send('Emulation.setCPUThrottlingRate', { rate: 1 })
      provider.release()
    }
    await until(() => !provider.holding(), 'the model finished')
    expect((await shot()).skeletonAt).toBe(0)
  })

  it('SKEL-2 从没发过消息的会话，视图迟到', async () => {
    await app.main.eval(
      `window.api.session.create(${JSON.stringify({ title: TITLES.never })}).then((s) => s.id)`
    )
    await sidebar.clickNewChat()
    await until(async () => (await sidebar.titles()).includes(TITLES.never), 'sidebar refreshed')

    await openDuringStall(TITLES.never)
    await until(async () => (await shot()).emptyAt > 0, 'empty state after the stall')
    expect((await shot()).skeletonAt).toBe(0)
  })
})

describe('对照', () => {
  it('SKEL-3 有记录的会话，视图迟到：骨架出现', async () => {
    const sid = await app.main.eval<string>(
      `window.api.session.create(${JSON.stringify({ title: TITLES.used })}).then((s) => s.id)`
    )
    provider.script({ text: 'used answer', usage: USAGE })
    await app.main.eval(
      `window.api.agent.prompt(${JSON.stringify({ sessionId: sid, text: 'used question' })}).then(() => true)`
    )
    await sidebar.clickNewChat()
    await until(async () => (await sidebar.titles()).includes(TITLES.used), 'sidebar refreshed')

    await openDuringStall(TITLES.used)
    await until(async () => (await shot()).shownAt > 0, 'messages after the stall')
    expect((await shot()).skeletonAt).toBeGreaterThan(0)
  })
})
