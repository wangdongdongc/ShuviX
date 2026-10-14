/**
 * 主窗口重载（pi 1.2 / chord2，E2E-3）—— 页面重载落定（`did-navigate`）时主进程收掉这个窗口的全部视图链路、
 * 放掉它们的持有；新页面的 syncClient 开新链路、拿一份新快照。用例：一轮回答挂在流式中途时重载主窗口 →
 * 对话重新渲染出来（历史 + 正在流式的那张卡），放行之后终答落进列表；下一轮照常流式。
 *
 * 重载走 CDP `Page.reload`（浏览器发起，等同 Cmd+R）：页面自己调 `location.reload()` 会被主进程的
 * `will-navigate` 守卫拦下（见 seed.waitRendererReady 的说明），在打包产物里永远等不到新页面。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { until } from '../../harness/cdp'
import { startFakeProvider, type FakeProvider } from '../../harness/fakeProvider'
import { launchApp, uncaughtExceptions, type E2EApp } from '../../harness/launch'
import { chatPane, sidebarPane, type ChatPane, type SidebarPane } from '../../harness/pages'
import { seedFakeProvider, waitRendererReady } from '../../harness/seed'

const MODEL = 'e2e-model'
const USAGE = { prompt: 80, completion: 6 }
const TITLE = 'Reload mid-session'

let app: E2EApp
let provider: FakeProvider
let chat: ChatPane
let sidebar: SidebarPane

beforeAll(async () => {
  app = await launchApp()
  provider = await startFakeProvider()
  await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  await waitRendererReady(app.main)
  await app.main.eval(
    `window.api.session.create(${JSON.stringify({ title: TITLE })}).then(() => true)`
  )
  chat = chatPane(app.main)
  sidebar = sidebarPane(app.main)
  await sidebar.clickNewChat()
  await until(async () => (await sidebar.titles()).includes(TITLE), 'sidebar lists the session')
}, 180_000)

afterAll(async () => {
  await provider?.close()
  await app?.stop()
})

const texts = async (): Promise<string[]> => (await chat.items()).map((item) => item.text)
const settledTexts = async (): Promise<string[]> =>
  (await chat.settledItems()).map((item) => item.text)

describe('E2E-3 the main window reloads mid-session', () => {
  it('the conversation renders again (incl. the card still streaming) and the next turn streams', async () => {
    provider.reset()
    provider.script({ text: ['first ', 'answer'], usage: USAGE })
    expect(await sidebar.openSession(TITLE)).toBe(true)
    await chat.ready()
    await chat.typeAndSend('question one')
    await until(
      async () => (await settledTexts()).some((t) => t.includes('first answer')),
      'turn 1'
    )
    await chat.waitIdle()

    // 第二轮流到一半挂住，此时重载
    provider.script({
      text: ['held ', 'midway'],
      chunkDelayMs: 30,
      holdMs: 25_000,
      usage: USAGE
    })
    await chat.typeAndSend('question two')
    await until(() => provider.holding(), 'turn 2 held mid-stream')
    await until(async () => (await texts()).some((t) => t.includes('held midway')), 'card streamed')

    // 记号随旧页面一起没了 = 真的重载了（不是同一个页面）
    await app.main.eval('(window.__e2eBeforeReload = true)')
    await app.main.send('Page.reload')
    await until(
      () => app.main.eval<boolean>('window.__e2eBeforeReload === undefined').catch(() => false),
      'the page actually reloaded'
    )
    await waitRendererReady(app.main)
    await until(async () => (await sidebar.titles()).includes(TITLE), 'sidebar after reload')
    expect(await sidebar.openSession(TITLE)).toBe(true)
    await chat.ready()
    // 历史与那张还在流式的卡都回来了（新链路上的新快照）
    await until(async () => {
      const now = await texts()
      return (
        now.some((t) => t.includes('question one')) &&
        now.some((t) => t.includes('first answer')) &&
        now.some((t) => t.includes('question two')) &&
        now.some((t) => t.includes('held midway'))
      )
    }, 'conversation rendered again after reload')

    provider.release()
    await until(
      async () => (await settledTexts()).some((t) => t.includes('held midway')),
      'turn 2 settles into the list'
    )
    await chat.waitIdle()

    // 下一轮照常流式：正文逐片出现，最后落定
    provider.script({ text: ['third ', 'turn ', 'streams'], chunkDelayMs: 250, usage: USAGE })
    await chat.typeAndSend('question three')
    await until(
      async () =>
        (await chat.isBusy()) &&
        (await texts()).some((t) => t.includes('third') && !t.includes('streams')),
      'turn 3 is streaming'
    )
    await until(
      async () => (await settledTexts()).some((t) => t.includes('third turn streams')),
      'turn 3 settled'
    )
    await chat.waitIdle()
    expect(await settledTexts()).toEqual([
      'question one',
      'first answer',
      'question two',
      'held midway',
      'question three',
      'third turn streams'
    ])
    expect(uncaughtExceptions(app)).toBe('')
  }, 120_000)
})
