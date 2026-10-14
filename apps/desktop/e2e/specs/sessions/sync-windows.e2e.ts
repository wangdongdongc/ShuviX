/**
 * 视图同步跨窗口（pi 1.2 / chord2）—— 主窗口与悬浮聊天窗口（#pinned-chat）各自经自己的链路看同一条会话：
 *
 *   E2E-1 悬浮之后两个窗口里的探针看到同一份视图；从主窗口跑一轮，两边落到同一份终态、同一批消息 id
 *         （悬浮窗自己的界面也渲染出这些消息）；取消悬浮之后主窗口照样更新；主进程没有未捕获的异常
 *   E2E-2 悬浮窗里看着一条会话，主窗口把它删了 → 悬浮窗那条订阅报 `unavailable`；新的订阅以
 *         `not_found` 失败；删的是悬浮着的那条会话本身 → 悬浮窗随之关掉，主窗口的订阅报 `unavailable`
 *
 * 探针（harness/sync.ts）在 spec 进程里跑一个真的 chord 客户端，经那个窗口的 `window.api.sync` 开一条自己的
 * 链路 —— 所以两个窗口的探针走的是两条不同的窗口链路（主进程按 webContents 分开）。会话都带着非缺省标题建，
 * 自动标题不跑（不吃假提供商的 FIFO）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SessionView } from '@shuvix/chat-protocol/types/sessionView'
import { until, type CdpClient } from '../../harness/cdp'
import { startFakeProvider, type FakeProvider } from '../../harness/fakeProvider'
import { launchApp, uncaughtExceptions, type E2EApp } from '../../harness/launch'
import { chatPane } from '../../harness/pages'
import { seedFakeProvider, waitRendererReady } from '../../harness/seed'
import { syncProbe } from '../../harness/sync'

const MODEL = 'e2e-model'
const USAGE = { prompt: 60, completion: 6 }

let app: E2EApp
let provider: FakeProvider
const opened: CdpClient[] = []

beforeAll(async () => {
  app = await launchApp()
  provider = await startFakeProvider()
  await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  await waitRendererReady(app.main)
}, 180_000)

afterAll(async () => {
  for (const client of opened) client.close()
  await provider?.close()
  await app?.stop()
})

const createSession = (title: string): Promise<string> =>
  app.main.eval<string>(`window.api.session.create(${JSON.stringify({ title })}).then((s) => s.id)`)

/** 发一轮并等它落定（durable 的 submitUser 等这一轮落定才答）；失败也吞掉，断言另走视图 */
const promptAndSettle = (sid: string, text: string): Promise<unknown> =>
  app.main.eval(
    `window.api.agent.prompt(${JSON.stringify({ sessionId: sid, text })}).catch(() => undefined).then(() => true)`
  )

const pin = (sid: string): Promise<unknown> =>
  app.main.eval(`window.api.pinChat.pin(${JSON.stringify(sid)}).then(() => true)`)
const unpin = (sid: string): Promise<unknown> =>
  app.main.eval(`window.api.pinChat.unpin(${JSON.stringify(sid)}).then(() => true)`)

async function pinnedWindow(sid: string): Promise<CdpClient> {
  const client = await until(() => app.connectPinnedChatWindow(sid), `pinned window of ${sid}`)
  opened.push(client)
  return client
}

const ids = (view: SessionView): string[] => view.messages.map((m) => m.id)
const settledIdle =
  (count: number) =>
  (view: SessionView): boolean =>
    view.messages.length === count && view.run.state === 'idle' && view.live === null

describe('E2E-1 two windows, one session', () => {
  it('main and pinned windows converge through a turn; after unpin the main window still updates', async () => {
    provider.reset()
    const sid = await createSession('Sync two windows')
    provider.script({ text: ['seed ', 'answer'], usage: USAGE })
    await promptAndSettle(sid, 'seed question')

    await pin(sid)
    const pinned = await pinnedWindow(sid)
    const mainProbe = syncProbe(app.main)
    const pinnedProbe = syncProbe(pinned)
    const before = await mainProbe.waitView(sid, settledIdle(2), 30_000, 'main sees the seed turn')
    expect(
      await pinnedProbe.waitView(sid, settledIdle(2), 30_000, 'pinned sees the seed turn')
    ).toEqual(before)

    provider.script({ text: ['second ', 'streamed ', 'reply'], chunkDelayMs: 40, usage: USAGE })
    await promptAndSettle(sid, 'second question')
    const finalMain = await mainProbe.waitView(sid, settledIdle(4), 30_000, 'main final view')
    const finalPinned = await pinnedProbe.waitView(sid, settledIdle(4), 30_000, 'pinned final view')
    expect(ids(finalPinned)).toEqual(ids(finalMain))
    expect(finalPinned).toEqual(finalMain)
    expect(finalMain.messages.map((m) => m.content)).toEqual([
      'seed question',
      'seed answer',
      'second question',
      'second streamed reply'
    ])

    // 悬浮窗自己的界面（它自己的 syncClient）渲染出同一批消息
    const pinnedChat = chatPane(pinned)
    await until(
      async () =>
        JSON.stringify((await pinnedChat.settledItems()).map((item) => item.id)) ===
        JSON.stringify(ids(finalMain)),
      'pinned window renders the same message ids'
    )

    await unpin(sid)
    await until(
      async () => !(await app.pinnedChatSessions()).includes(sid),
      'pinned window closed after unpin'
    )

    provider.script({ text: 'third reply', usage: USAGE })
    await promptAndSettle(sid, 'third question')
    const after = await mainProbe.waitView(sid, settledIdle(6), 30_000, 'main updates after unpin')
    expect(after.messages.at(-1)?.content).toBe('third reply')
    expect(ids(after).slice(0, 4)).toEqual(ids(finalMain))
    expect(uncaughtExceptions(app)).toBe('')
  }, 120_000)
})

describe('E2E-2 deleting a session another window is viewing', () => {
  it('the pinned window’s subscription goes unavailable; a fresh subscription fails with not_found', async () => {
    provider.reset()
    const host = await createSession('Pinned host')
    const doomed = await createSession('Doomed session')
    provider.script({ text: 'doomed answer', usage: USAGE })
    await promptAndSettle(doomed, 'hello doomed')

    await pin(host)
    const pinned = await pinnedWindow(host)
    const probe = syncProbe(pinned)
    await probe.waitView(doomed, settledIdle(2), 30_000, 'pinned window views the doomed session')
    expect(await probe.availabilityOf(doomed)).toBe('available')

    await app.main.eval(`window.api.session.delete(${JSON.stringify(doomed)}).then(() => true)`)
    await until(
      async () => (await probe.availabilityOf(doomed)) === 'unavailable',
      'pinned subscription reports unavailable'
    )

    // 一个全新的探针（新的 CDP 连接 → 新的链路）：订阅这条会话 → not_found
    const fresh = await until(() => app.mainWindow(), 'a second main-window client')
    opened.push(fresh)
    const error = (await syncProbe(fresh)
      .viewOf(doomed)
      .then(
        () => undefined,
        (e: unknown) => e
      )) as { code?: string } | undefined
    expect(error?.code).toBe('not_found')

    // 悬浮窗与它自己的会话不受影响
    expect((await probe.viewOf(host))?.sessionId).toBe(host)
    expect(await app.pinnedChatSessions()).toContain(host)
    expect(uncaughtExceptions(app)).toBe('')
  }, 120_000)

  it('deleting the pinned session itself closes its window; the main window’s subscription goes unavailable', async () => {
    provider.reset()
    const sid = await createSession('Pinned and deleted')
    provider.script({ text: 'last words', usage: USAGE })
    await promptAndSettle(sid, 'say something')
    await pin(sid)
    await pinnedWindow(sid)
    const mainProbe = syncProbe(app.main)
    await mainProbe.waitView(sid, settledIdle(2), 30_000, 'main views the pinned session')

    await app.main.eval(`window.api.session.delete(${JSON.stringify(sid)}).then(() => true)`)
    await until(
      async () => !(await app.pinnedChatSessions()).includes(sid),
      'pinned window closed on delete'
    )
    await until(
      async () => (await mainProbe.availabilityOf(sid)) === 'unavailable',
      'main subscription reports unavailable'
    )
    expect(uncaughtExceptions(app)).toBe('')
  }, 120_000)
})
