/**
 * 扩展这一端的那条线（background/nativeLink.ts）—— 侧边栏看到的「能不能用、为什么不能用」。
 *
 * 只钉 welcome 那一段：桌面拒了新连接（同一个扩展安装已经有一条活着的连接）时，侧边栏要说得出
 * 「这个浏览器已经连着了」，而不是笼统的「版本对不上，请更新扩展」—— 两句话要用户做的事完全不同。
 * 错误码是跨两个代码库比较的字面量（桌面写在 welcome 里、这边 switch 它），协议包那边由 CB-1 钉住。
 *
 *   EXT-1  welcome ok:false + already-connected → 状态 already-connected（并通知订阅者）
 *   EXT-2  welcome ok:false + 别的原因（含没有 error）→ 回落到 mismatch —— 老桌面只会说
 *          protocol-mismatch，新错误码不该把状态机卡在一个没人处理的值上
 *   EXT-3  之后来一条 host: connected：重说 hello、停在 connecting；只有新的 welcome ok 才是 ready
 *   EXT-4  host: offline / connected 这对状态：桌面走了是 desktop-offline，回来要重走一遍握手
 *
 * 在桌面的 vitest 配置里跑（node 环境）：nativeLink → browserOps → `@shuvix/agent-runtime/browser/extractPage`，
 * 那条子路径别名排在 `@shuvix/agent-runtime` 前缀别名之前才解析得了（见 apps/desktop/vitest.config.ts）。
 * 模块级状态（端口、状态、订阅者）每条用例 resetModules 后重新 import 一份。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BRIDGE_ERROR_ALREADY_CONNECTED,
  BRIDGE_ERROR_PROTOCOL_MISMATCH,
  CHROME_BRIDGE_HOST_NAME,
  CHROME_BRIDGE_PROTOCOL,
  type BridgeMessage
} from '@shuvix/chat-protocol/chromeBridge'
import type { PanelLinkState } from '../../shared/panelLink'

type NativeLink = typeof import('../nativeLink')

/** 本地组件那条原生消息端口的替身 */
class FakePort {
  readonly posted: unknown[] = []
  private readonly messageListeners: Array<(raw: unknown) => void> = []
  private readonly disconnectListeners: Array<() => void> = []

  readonly onMessage = {
    addListener: (fn: (raw: unknown) => void): void => {
      this.messageListeners.push(fn)
    }
  }
  readonly onDisconnect = {
    addListener: (fn: () => void): void => {
      this.disconnectListeners.push(fn)
    }
  }

  postMessage = (message: unknown): void => {
    this.posted.push(message)
  }

  /** 本地组件发过来一条（桌面转来的，或它自己的 host 状态） */
  deliver(message: BridgeMessage): void {
    for (const fn of this.messageListeners) fn(message)
  }

  disconnect(): void {
    for (const fn of this.disconnectListeners) fn()
  }
}

/** chrome.storage.local / session 的替身（identity.ts 拿它存 installId / runId） */
function fakeStorage(): {
  get: (key: string) => Promise<Record<string, unknown>>
  set: (patch: Record<string, unknown>) => Promise<void>
} {
  const data: Record<string, unknown> = {}
  return {
    get: async (key) => ({ [key]: data[key] }),
    set: async (patch) => {
      Object.assign(data, patch)
    }
  }
}

const welcome = (over: Record<string, unknown>): BridgeMessage =>
  ({ type: 'welcome', protocol: CHROME_BRIDGE_PROTOCOL, ...over }) as BridgeMessage

let port: FakePort
let connectNative: ReturnType<typeof vi.fn>
let link: NativeLink

beforeEach(async () => {
  vi.resetModules()
  port = new FakePort()
  connectNative = vi.fn(() => port)
  vi.stubGlobal('chrome', {
    runtime: {
      connectNative,
      getManifest: () => ({ version: '0.3.0' }),
      lastError: undefined
    },
    tabs: { query: async () => [{ id: 1 }, { id: 2 }] },
    storage: { local: fakeStorage(), session: fakeStorage() },
    debugger: { detach: async () => {} }
  })
  vi.stubGlobal('navigator', { userAgentData: { brands: [{ brand: 'Chrome', version: '140' }] } })
  link = await import('../nativeLink')
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('扩展 ⇄ 本地组件：welcome 决定侧边栏的状态', () => {
  it('EXT-1 桌面回 already-connected：状态就是 already-connected（不是笼统的 mismatch），订阅者收到一次', () => {
    const seen: PanelLinkState[] = []
    link.onLinkState((state) => seen.push(state))

    link.ensureNativeLink()
    expect(connectNative).toHaveBeenCalledWith(CHROME_BRIDGE_HOST_NAME)
    expect(link.linkState()).toBe('connecting')

    port.deliver(welcome({ ok: false, error: BRIDGE_ERROR_ALREADY_CONNECTED }))

    expect(link.linkState()).toBe('already-connected')
    expect(seen).toEqual(['already-connected'])
  })

  it.each([
    ['protocol-mismatch（老桌面唯一会说的那个）', BRIDGE_ERROR_PROTOCOL_MISMATCH],
    ['根本没有 error', undefined],
    ['一个这边还不认识的错误码', 'something-newer']
  ])('EXT-2 welcome ok:false、原因是%s：回落到 mismatch', (_label, error) => {
    link.ensureNativeLink()
    port.deliver(welcome(error === undefined ? { ok: false } : { ok: false, error }))
    expect(link.linkState()).toBe('mismatch')
  })

  it('EXT-3 already-connected 之后来一条 host: connected：重说一遍 hello、停在 connecting —— 只有新的 welcome ok 才变 ready，不会因为「本地组件说桌面在」就自认可用', async () => {
    link.ensureNativeLink()
    port.deliver(welcome({ ok: false, error: BRIDGE_ERROR_ALREADY_CONNECTED }))
    expect(link.linkState()).toBe('already-connected')

    port.deliver({ type: 'host', desktop: 'connected' })
    await vi.waitFor(() => expect(port.posted).toHaveLength(1))
    expect(port.posted[0]).toMatchObject({
      type: 'hello',
      protocol: CHROME_BRIDGE_PROTOCOL,
      extensionVersion: '0.3.0',
      openTabIds: [1, 2]
    })
    expect(link.linkState()).toBe('connecting')

    // 桌面再拒一次（那条旧连接还活着）：回到 already-connected
    port.deliver(welcome({ ok: false, error: BRIDGE_ERROR_ALREADY_CONNECTED }))
    expect(link.linkState()).toBe('already-connected')

    // 那条旧连接终于走了，桌面这回放行
    port.deliver(welcome({ ok: true }))
    expect(link.linkState()).toBe('ready')
  })

  it('EXT-4 host: offline：状态是 desktop-offline（本地组件在、桌面没开）；再连上还是重走一遍握手', async () => {
    link.ensureNativeLink()
    port.deliver(welcome({ ok: true }))
    expect(link.linkState()).toBe('ready')

    port.deliver({ type: 'host', desktop: 'offline' })
    expect(link.linkState()).toBe('desktop-offline')

    port.deliver({ type: 'host', desktop: 'connected' })
    await vi.waitFor(() => expect(port.posted).toHaveLength(1))
    expect(link.linkState()).toBe('connecting')
  })
})
