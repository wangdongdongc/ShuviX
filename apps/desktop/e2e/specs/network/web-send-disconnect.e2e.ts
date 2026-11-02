/**
 * web 客户端发消息时连接断开（手机上屏幕一锁、网络一切就是这样）。
 *
 * `agent.prompt` 要等整轮落定才回，所以一轮跑着的时候连接一断，这次调用就以 `disconnected` 被拒 —— 那不是发送失败，
 * 除非这句话真的没进去：
 *   SD-1 消息已受理、整轮挂着时断开：输入框没有失败提示；连回来之后同一轮跑完，提示也没有冒出来
 *   SD-2 断着的时候发（`not_connected`，没发出去）：当场报本地化的那句（不露错误码），话留在输入框，没有占位，提供商没收到
 *        请求；连回来两样都还在。主窗口发一句让这条会话跑起来 → 提示消失、字不动；跑完回车发出去，答复照到
 *   SD-3 帧送出去了、socket 紧接着断（结果未知，真的重新同步）：连回来之后这句话恰好一条，没有提示，输入框空，
 *        提供商一次请求，答复照到
 *   SD-4 帧被吞了、socket 断（结果未知，真的宽限）：连回来 5 秒占位还在、没有提示；宽限过后占位撤下，话回到输入框、
 *        报本地化的那句，提供商没收到请求，列表里没有这句话；再发一次照常，用户消息只有一条
 */
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sleep, until } from '../../harness/cdp'
import { startFakeProvider, type FakeProvider } from '../../harness/fakeProvider'
import { freePort, launchApp, type E2EApp } from '../../harness/launch'
import {
  openWebClient,
  type NetworkStatus,
  type WebClientHandle
} from '../../harness/networkFixtures'
import { chatPane, sidebarPane, webClientPane, type ChatPane } from '../../harness/pages'
import { seedFakeProvider, waitRendererReady } from '../../harness/seed'

const MODEL = 'e2e-model'
const SEND_FAILED = en.input.sendFailed.replace('{{error}}', en.input.connectionLost)
const RAW_CODE = /disconnected|not connected|not_connected/

let app: E2EApp
let provider: FakeProvider
let web: WebClientHandle | undefined
let P1 = 0
let P2 = 0

const setPort = (port: number): Promise<NetworkStatus> =>
  app.main.eval<NetworkStatus>(`window.api.network.setPort(${JSON.stringify(port)})`)

const createSession = (title: string): Promise<string> =>
  app.main.eval<string>(`window.api.session.create(${JSON.stringify({ title })}).then((s) => s.id)`)

/** 让页面的 WebSocket 断开，等它看到断线；`reconnect` 把服务端放回原端口，等它连回来 */
async function dropConnection(): Promise<{ reconnect(): Promise<void> }> {
  const pane = webClientPane(web!.page)
  await setPort(P2)
  await until(
    async () => (await pane.connectionBanner()) === 'reconnecting',
    'the page shows the reconnecting banner'
  )
  return {
    reconnect: async () => {
      await setPort(P1)
      await until(
        async () => (await pane.connectionBanner()) === null,
        'the page reconnects',
        20_000
      )
    }
  }
}

/** 建一条会话，在 web 客户端里打开它 */
async function openSession(title: string): Promise<{ sid: string; chat: ChatPane }> {
  const sid = await createSession(title)
  const page = web!.page
  await until(
    async () => (await sidebarPane(page).titles()).includes(title),
    'the session is in the web sidebar'
  )
  expect(await sidebarPane(page).openSession(title)).toBe(true)
  const chat = chatPane(page)
  await chat.ready()
  return { sid, chat }
}

/**
 * 页面下一次发 `agent:prompt` 的帧时掐断这条 socket（一次性）。`deliver`：帧照常送出去（服务端收得到），否则吞掉。
 * 这样断线恰好落在「发出去了、不知道到没到」这一下，不靠挪服务端端口赶时机
 */
const cutSocketOnNextPrompt = (deliver: boolean): Promise<unknown> =>
  web!.page.eval(`(() => {
    const real = WebSocket.prototype.send
    WebSocket.prototype.send = function (data) {
      if (typeof data !== 'string' || !data.includes('agent:prompt')) return real.call(this, data)
      WebSocket.prototype.send = real
      ${deliver ? 'real.call(this, data)' : ''}
      this.close()
    }
  })()`)

/** 等掐断之后的重连：过了第一次退避（500 ms）再看横幅，否则可能看到的还是断开之前的「没有横幅」 */
async function waitReconnected(): Promise<void> {
  await sleep(1500)
  const pane = webClientPane(web!.page)
  await until(async () => (await pane.connectionBanner()) === null, 'the page reconnects', 20_000)
}

const usersSaying = async (chat: ChatPane, text: string): Promise<number> =>
  (await chat.settledItems()).filter((item) => item.role === 'user' && item.text === text).length

beforeAll(async () => {
  app = await launchApp()
  await app.main.eval(`window.api.settings.set({ key: 'general.language', value: 'en' })`)
  provider = await startFakeProvider()
  await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  await waitRendererReady(app.main)
  P1 = await freePort()
  do {
    P2 = await freePort()
  } while (P2 === P1)
  await setPort(P1)
  await app.main.eval(`window.api.network.setEnabled(true)`)
  web = await openWebClient(app, P1)
})

afterAll(async () => {
  if (web) await web.close().catch(() => undefined)
  await provider?.close().catch(() => undefined)
  await app?.stop()
})

describe('web client: the connection drops while sending', () => {
  it('SD-1 an accepted message running when the socket drops is not a send failure', async () => {
    const { chat } = await openSession('SD-1')

    provider.reset()
    provider.script({ text: 'Survived the drop', holdMs: 60_000 })
    await chat.typeAndSend('hello through the drop')
    await until(async () => provider.holding(), 'the turn is held at the provider')

    const link = await dropConnection()
    await sleep(500)
    expect(await chat.sendError()).toBeNull()

    await link.reconnect()
    provider.release()
    await chat.waitIdle()
    await until(
      async () => (await chat.settledItems()).at(-1)?.text === 'Survived the drop',
      'the same turn finishes after reconnecting'
    )
    expect(await chat.sendError()).toBeNull()
  }, 90_000)

  it('SD-2 sending while disconnected fails at once and keeps the text; a run started elsewhere clears the error', async () => {
    const TEXT = 'typed while offline'
    const { sid, chat } = await openSession('SD-2')
    provider.reset()

    const link = await dropConnection()
    await chat.typeAndSend(TEXT)
    await until(async () => (await chat.sendError()) !== null, 'the send fails at once')
    expect(await chat.sendError()).toBe(SEND_FAILED)
    expect(await chat.sendError()).not.toMatch(RAW_CODE)
    expect(await chat.inputValue()).toBe(TEXT)
    expect(await chat.pendingItem()).toBeNull()
    expect(provider.chatRequestCount()).toBe(0)

    await link.reconnect()
    expect(await chat.sendError()).toBe(SEND_FAILED)
    expect(await chat.inputValue()).toBe(TEXT)

    provider.script({ text: 'From the main window', holdMs: 60_000 })
    await app.main.eval(
      `void window.api.agent.prompt(${JSON.stringify({ sessionId: sid, text: 'from the main window' })}).catch(() => undefined)`
    )
    await until(async () => provider.holding(), 'the main window turn is held at the provider')
    await until(
      async () => (await chat.sendError()) === null,
      'the error clears when the run starts'
    )
    expect(await chat.inputValue()).toBe(TEXT)

    provider.release()
    await chat.waitIdle()
    provider.script({ text: 'Sent at last' })
    await chat.pressEnter()
    await until(
      async () => (await chat.settledItems()).at(-1)?.text === 'Sent at last',
      'the answer to the kept text arrives'
    )
    expect(await usersSaying(chat, TEXT)).toBe(1)
    expect(await chat.sendError()).toBeNull()
  }, 90_000)

  it('SD-3 the frame got out and the socket closed: after reconnecting the message is there once, with no error', async () => {
    const TEXT = 'delivered just before the cut'
    const { chat } = await openSession('SD-3')
    provider.reset()
    provider.script({ text: 'Through the cut' })

    await cutSocketOnNextPrompt(true)
    await chat.typeAndSend(TEXT)
    await waitReconnected()
    await until(
      async () => (await chat.settledItems()).at(-1)?.text === 'Through the cut',
      'the answer arrives after reconnecting'
    )
    expect(await usersSaying(chat, TEXT)).toBe(1)
    expect(await chat.pendingItem()).toBeNull()
    expect(await chat.sendError()).toBeNull()
    expect(await chat.inputValue()).toBe('')
    expect(provider.chatRequestCount()).toBe(1)
  }, 90_000)

  it('SD-4 the frame was lost and the socket closed: the bubble waits out the grace, then the text comes back', async () => {
    const TEXT = 'swallowed with the socket'
    const { chat } = await openSession('SD-4')
    provider.reset()

    await cutSocketOnNextPrompt(false)
    await chat.typeAndSend(TEXT)
    await waitReconnected()
    await sleep(5000)
    expect((await chat.pendingItem())?.text).toBe(TEXT)
    expect(await chat.sendError()).toBeNull()
    expect(await chat.inputValue()).toBe('')

    await until(async () => (await chat.sendError()) !== null, 'the grace runs out', 20_000)
    expect(await chat.sendError()).toBe(SEND_FAILED)
    expect(await chat.sendError()).not.toMatch(RAW_CODE)
    expect(await chat.pendingItem()).toBeNull()
    expect(await chat.inputValue()).toBe(TEXT)
    expect(provider.chatRequestCount()).toBe(0)
    expect(await usersSaying(chat, TEXT)).toBe(0)

    provider.script({ text: 'Second try landed' })
    await chat.pressEnter()
    await until(
      async () => (await chat.settledItems()).at(-1)?.text === 'Second try landed',
      'the resend is answered'
    )
    expect(await usersSaying(chat, TEXT)).toBe(1)
    expect(await chat.sendError()).toBeNull()
    expect(provider.chatRequestCount()).toBe(1)
  }, 90_000)
})
