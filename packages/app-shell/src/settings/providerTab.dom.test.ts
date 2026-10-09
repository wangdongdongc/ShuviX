// @vitest-environment jsdom
/**
 * ProviderTab（设置 → 提供商）DOM 测试（jsdom）—— 订阅登录那一块（「Subscription sign-in」）。
 *
 * 宿主契约见 `ProviderTabApi.oauth`：`status` 决定这一块出不出现、按 `slug` 挑哪一家的文案；`login` 挂到
 * 登录结束；设备码 / 授权页 / 提问 / 结束信号经 `onEvent` 单独推来；`answer` 回答提问；`openExternal`
 * 是重开页面的入口。
 *
 *   PT-1  不支持（或宿主没给 oauth）→ 没有任何 `[data-oauth-*]`；没给 oauth 时也不查状态
 *   PT-2  三家各自的登录按钮文案与说明（说明在标题旁问号的气泡里）
 *   PT-3  不认识的 slug / 没给 slug → 通用文案
 *   PT-4  已登录：Connected + 退出按钮，说明换成「已登录」那句
 *   PT-5  点登录 → login 恰调一次；显示取消与等待文案
 *   PT-6  device_code → 显示用户码；重开打开验证页
 *   PT-7  auth_url → 浏览器提示；重开打开授权页；没有用户码
 *   PT-8  宿主没给 openExternal → 没有重开按钮
 *   PT-9  manual_code 提问 → 文本输入框、占位符照给、标签用界面自己的说明
 *   PT-10 text 提问标签是流程给的原文；secret 是密码框
 *   PT-11 回答去掉首尾空白，点按钮与回车都行；全空白时按钮禁用、回车不送
 *   PT-12 输入框一直在，直到 id 对得上的 prompt_closed
 *   PT-13 宿主没给 answer → 不显示输入框，但提示与取消照旧
 *   PT-14 取消 → cancel(id)；结果是 cancelled 时不报错，登录按钮回来
 *   PT-15 失败：宿主给的错误原文 / 没给原因用通用文案 / login 自己拒绝用它的 message
 *   PT-16 结束后：流程清掉、重查状态、onChanged、已登录则显示已登录
 *   PT-17 退出：logout → 重查状态 → onChanged，错误清掉
 *   PT-18 新提问（新 id）清空已输入的文字；PT-19 回答在途时按钮禁用；PT-20 别家的事件不显示
 *   PT-21 输入法组字中的回车不提交；PT-22 message 事件什么也不显示；PT-23 再登录清掉上次的错误
 *   PT-24 选中另一家 → 查它的状态
 *   PT-25 挂载时状态就是 pending（别处发起的登录）→ 进行中 + 取消；取消后重查状态
 *   PT-26 `finished`：不是本组件发起的 → 重查状态 + onChanged；本组件发起的（login 还挂着）→ 事件不重查
 *   PT-27 进行中按 provider 记：A 结束不影响 B 的进行中
 *   PT-28 列表行带 `data-provider-row=<id>`
 *
 * 包入口 `@shuvix/chat-ui` 顶掉：`isImeComposing` 照原实现（组字判定就是它），`useDialogClose` 给两个对话框
 * （本文件不打开它们）。i18n 用 en。文件是 `.ts`（app-shell 的单测只收 `*.test.ts`），所以不写 JSX。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import type { ProviderInfo } from '@shuvix/chat-protocol/types/provider'

vi.mock('@shuvix/chat-ui', () => ({
  isImeComposing: (e: { nativeEvent?: KeyboardEvent } & Partial<KeyboardEvent>) => {
    const native = (e.nativeEvent ?? e) as KeyboardEvent
    return native.isComposing || native.keyCode === 229
  },
  useDialogClose: (onClose: () => void) => ({ closing: false, handleClose: onClose })
}))

import {
  ProviderTab,
  type ProviderOAuthTabEvent,
  type ProviderOAuthTabStatus,
  type ProviderTabApi,
  type ProviderTabProps
} from './ProviderTab'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const S = en.settings
const OAUTH = S.oauthProviders

const XAI = 'row-xai'
const KIMI = 'row-kimi'
const OPENAI = 'openai'
const ANTHROPIC = 'anthropic'

const provider = (
  over: Partial<ProviderInfo> & Pick<ProviderInfo, 'id' | 'name'>
): ProviderInfo => ({
  displayName: '',
  apiKey: '',
  baseUrl: '',
  apiProtocol: 'openai-completions',
  metadata: '{}',
  isBuiltin: 1,
  isEnabled: 1,
  sortOrder: 0,
  createdAt: 0,
  updatedAt: 0,
  ...over
})

const PROVIDERS: ProviderInfo[] = [
  provider({ id: XAI, name: 'xai', displayName: 'xAI' }),
  provider({ id: KIMI, name: 'kimi-coding', displayName: 'Kimi Code' }),
  provider({ id: OPENAI, name: 'openai', displayName: 'OpenAI' }),
  provider({ id: ANTHROPIC, name: 'anthropic', displayName: 'Anthropic' })
]

const OFF: ProviderOAuthTabStatus = {
  supported: false,
  connected: false,
  expiresAt: null,
  pending: false
}
const signedOut = (slug?: string): ProviderOAuthTabStatus => ({
  supported: true,
  ...(slug ? { slug } : {}),
  connected: false,
  expiresAt: null,
  pending: false
})

type LoginResult = { success: boolean; error?: string; cancelled?: boolean }
interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (err: unknown) => void
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

interface Harness {
  api: ProviderTabApi
  oauth: {
    status: ReturnType<typeof vi.fn>
    login: ReturnType<typeof vi.fn>
    cancel: ReturnType<typeof vi.fn>
    logout: ReturnType<typeof vi.fn>
    answer: ReturnType<typeof vi.fn>
    onEvent: ReturnType<typeof vi.fn>
    openExternal: ReturnType<typeof vi.fn>
  }
  /** 当前的状态表（status 回它的拷贝；没写的行 = 不支持） */
  statuses: Record<string, ProviderOAuthTabStatus>
  /** 每次 login 一个由用例结束的 Promise（按调用顺序） */
  logins: Array<Deferred<LoginResult> & { providerId: string }>
  /** 订阅到的事件回调（没订阅 / 已退订时为 null） */
  listener: ((event: ProviderOAuthTabEvent) => void) | null
  onChanged: ReturnType<typeof vi.fn>
}

function harness(): Harness {
  const h = {
    statuses: {} as Record<string, ProviderOAuthTabStatus>,
    logins: [] as Harness['logins'],
    listener: null as Harness['listener'],
    onChanged: vi.fn(async () => {})
  } as Harness
  h.oauth = {
    status: vi.fn(async (id: string) => ({ ...(h.statuses[id] ?? OFF) })),
    login: vi.fn((providerId: string) => {
      const d = deferred<LoginResult>()
      h.logins.push({ ...d, providerId })
      return d.promise
    }),
    cancel: vi.fn(async () => ({ success: true })),
    logout: vi.fn(async () => ({ success: true })),
    answer: vi.fn(async () => ({ success: true })),
    onEvent: vi.fn((callback: (event: ProviderOAuthTabEvent) => void) => {
      h.listener = callback
      return () => {
        if (h.listener === callback) h.listener = null
      }
    }),
    openExternal: vi.fn()
  }
  h.api = {
    listModels: vi.fn(async () => []),
    toggleEnabled: vi.fn(async () => undefined),
    toggleModelEnabled: vi.fn(async () => undefined),
    updateConfig: vi.fn(async () => undefined),
    add: vi.fn(async () => undefined),
    addModel: vi.fn(async () => undefined),
    deleteModel: vi.fn(async () => undefined),
    syncModels: vi.fn(async () => ({ total: 0, added: 0 })),
    updateModelCapabilities: vi.fn(async () => undefined),
    oauth: h.oauth as unknown as NonNullable<ProviderTabApi['oauth']>
  }
  return h
}

let container: HTMLDivElement
let root: Root
let h: Harness

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

async function settle(fn?: () => void | Promise<void>): Promise<void> {
  await act(async () => {
    await fn?.()
    await flush()
    await flush()
  })
}

async function render(
  over: Partial<ProviderTabProps> = {},
  providers: ProviderInfo[] = PROVIDERS
): Promise<void> {
  const props: ProviderTabProps = {
    providers,
    api: h.api,
    onChanged: h.onChanged as unknown as ProviderTabProps['onChanged'],
    ...over
  }
  await settle(() => root.render(createElement(ProviderTab, props)))
}

const $ = <T extends Element = HTMLElement>(selector: string): T | null =>
  container.querySelector<T>(selector)

function must<T extends Element = HTMLElement>(selector: string): T {
  const el = $<T>(selector)
  if (!el) throw new Error(`${selector} not rendered`)
  return el
}

const OAUTH_SELECTOR = [
  'signin',
  'signout',
  'connected',
  'cancel',
  'device-code',
  'browser',
  'reopen',
  'prompt',
  'prompt-submit',
  'error'
]
  .map((name) => `[data-oauth-${name}]`)
  .join(',')

async function select(id: string): Promise<void> {
  await settle(() => must(`[data-provider-row="${id}"]`).click())
}

async function click(selector: string): Promise<void> {
  await settle(() => must(selector).click())
}

async function emit(event: ProviderOAuthTabEvent): Promise<void> {
  await settle(() => {
    if (!h.listener) throw new Error('no oauth event listener subscribed')
    h.listener(event)
  })
}

/** 受控输入框写值（走 React 认的 value setter + input 事件） */
async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  await settle(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function pressEnter(input: HTMLInputElement, init: KeyboardEventInit = {}): Promise<void> {
  await settle(() => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, ...init }))
  })
}

/** 「Subscription sign-in」标题旁问号气泡里的说明（聚焦问号才挂出来） */
async function oauthDescription(): Promise<string> {
  const hint = [...container.querySelectorAll<HTMLButtonElement>('[data-info-hint]')].find((b) =>
    (b.parentElement?.textContent ?? '').includes(S.oauthTitle)
  )
  if (!hint) throw new Error('no info hint beside the subscription sign-in title')
  await settle(() => hint.focus())
  const tip = document.body.querySelector('[data-info-tip]')
  const text = (tip?.textContent ?? '').trim()
  await settle(() => hint.blur())
  return text
}

const text = (selector: string): string => (must(selector).textContent ?? '').trim()
const containerText = (): string => container.textContent ?? ''

/** 渲染并选中某一家（状态先写好） */
async function open(
  id: string,
  status: ProviderOAuthTabStatus,
  over: Partial<ProviderTabProps> = {}
): Promise<void> {
  h.statuses[id] = status
  await render(over)
  await select(id)
}

/** 当前这一个登录（最后一次 login 调用） */
const lastLogin = (): Harness['logins'][number] => {
  const login = h.logins.at(-1)
  if (!login) throw new Error('login was not called')
  return login
}

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    showSupportNotice: false
  })
})

beforeEach(() => {
  h = harness()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

describe('whether the block shows', () => {
  it('PT-1 an unsupported provider shows no [data-oauth-*]', async () => {
    await open(ANTHROPIC, OFF)

    expect(h.oauth.status).toHaveBeenCalledWith(ANTHROPIC)
    expect(container.querySelectorAll(OAUTH_SELECTOR)).toHaveLength(0)
    expect(containerText()).not.toContain(S.oauthTitle)
  })

  it('PT-1 a host without oauth shows no [data-oauth-*] and queries no status', async () => {
    h.statuses[XAI] = signedOut('xai')
    await render({ api: { ...h.api, oauth: undefined } })
    await select(XAI)

    expect(h.oauth.status).not.toHaveBeenCalled()
    expect(h.oauth.onEvent).not.toHaveBeenCalled()
    expect(container.querySelectorAll(OAUTH_SELECTOR)).toHaveLength(0)
    expect(containerText()).not.toContain(S.oauthTitle)
  })

  it('PT-28 each provider row carries data-provider-row=<id>', async () => {
    await render()

    const ids = [...container.querySelectorAll<HTMLElement>('[data-provider-row]')].map(
      (el) => el.dataset.providerRow
    )
    expect(ids.sort()).toEqual([ANTHROPIC, KIMI, OPENAI, XAI].sort())
  })

  it('PT-24 selecting another provider queries its status', async () => {
    await render()
    h.oauth.status.mockClear()

    await select(KIMI)
    expect(h.oauth.status).toHaveBeenCalledWith(KIMI)
    await select(OPENAI)
    expect(h.oauth.status).toHaveBeenCalledWith(OPENAI)
  })
})

describe('texts', () => {
  it.each([
    [XAI, 'xai'],
    [KIMI, 'kimi-coding'],
    [OPENAI, 'openai']
  ] as const)(
    'PT-2 row %s (slug %s) gets its own sign-in label and description',
    async (id, slug) => {
      await open(id, signedOut(slug))

      expect(text('[data-oauth-signin]')).toBe(OAUTH[slug].signIn)
      expect(await oauthDescription()).toBe(OAUTH[slug].desc)
    }
  )

  it.each([['github-copilot'], [undefined]])(
    'PT-3 slug %s falls back to the generic label and description',
    async (slug) => {
      await open(XAI, signedOut(slug))

      expect(text('[data-oauth-signin]')).toBe(S.oauthSignIn)
      expect(await oauthDescription()).toBe(S.oauthDesc)
    }
  )

  it('PT-4 connected: Connected + sign out, no sign-in, the connected description', async () => {
    await open(OPENAI, { ...signedOut('openai'), connected: true, expiresAt: 1 })

    expect(text('[data-oauth-connected]')).toBe(S.oauthConnected)
    expect($('[data-oauth-signout]')).not.toBeNull()
    expect($('[data-oauth-signin]')).toBeNull()
    expect(await oauthDescription()).toBe(S.oauthConnectedDesc)
  })
})

describe('signing in', () => {
  it('PT-5 clicking sign in calls login once and shows cancel + the waiting text', async () => {
    await open(KIMI, signedOut('kimi-coding'))

    await click('[data-oauth-signin]')

    expect(h.oauth.login).toHaveBeenCalledTimes(1)
    expect(h.oauth.login).toHaveBeenCalledWith(KIMI)
    expect($('[data-oauth-cancel]')).not.toBeNull()
    expect($('[data-oauth-signin]')).toBeNull()
    expect(containerText()).toContain(S.oauthWaiting)
  })

  it('PT-6 device_code shows the user code; reopen opens the verification page', async () => {
    await open(KIMI, signedOut('kimi-coding'))
    await click('[data-oauth-signin]')

    await emit({
      providerId: KIMI,
      kind: 'device_code',
      userCode: 'KIMI-7788',
      verificationUri: 'https://auth.example/device?user_code=KIMI-7788',
      expiresInSeconds: 600
    })

    expect(text('[data-oauth-device-code]')).toBe('KIMI-7788')
    expect(containerText()).toContain(S.oauthDeviceHint)
    expect(containerText()).not.toContain(S.oauthWaiting)
    expect($('[data-oauth-browser]')).toBeNull()
    await click('[data-oauth-reopen]')
    expect(h.oauth.openExternal).toHaveBeenCalledTimes(1)
    expect(h.oauth.openExternal).toHaveBeenCalledWith(
      'https://auth.example/device?user_code=KIMI-7788'
    )
  })

  it('PT-7 auth_url shows the browser hint; reopen opens the authorization page; no user code', async () => {
    await open(OPENAI, signedOut('openai'))
    await click('[data-oauth-signin]')

    await emit({ providerId: OPENAI, kind: 'auth_url', url: 'https://auth.example/authorize?s=1' })

    expect(text('[data-oauth-browser]')).toBe(S.oauthBrowserHint)
    expect($('[data-oauth-device-code]')).toBeNull()
    expect(containerText()).not.toContain(S.oauthWaiting)
    await click('[data-oauth-reopen]')
    expect(h.oauth.openExternal).toHaveBeenCalledWith('https://auth.example/authorize?s=1')
  })

  it('PT-8 without openExternal there is no reopen button (device code nor browser)', async () => {
    const api = { ...h.api, oauth: { ...h.api.oauth!, openExternal: undefined } }
    h.statuses[KIMI] = signedOut('kimi-coding')
    h.statuses[OPENAI] = signedOut('openai')
    await render({ api })

    await select(KIMI)
    await click('[data-oauth-signin]')
    await emit({
      providerId: KIMI,
      kind: 'device_code',
      userCode: 'K-1',
      verificationUri: 'https://auth.example/d'
    })
    expect($('[data-oauth-device-code]')).not.toBeNull()
    expect($('[data-oauth-reopen]')).toBeNull()

    await select(OPENAI)
    await click('[data-oauth-signin]')
    await emit({ providerId: OPENAI, kind: 'auth_url', url: 'https://auth.example/a' })
    expect($('[data-oauth-browser]')).not.toBeNull()
    expect($('[data-oauth-reopen]')).toBeNull()
  })

  it('PT-14 cancel calls cancel(id); a cancelled result shows no error and brings sign in back', async () => {
    await open(XAI, signedOut('xai'))
    await click('[data-oauth-signin]')

    await click('[data-oauth-cancel]')
    expect(h.oauth.cancel).toHaveBeenCalledTimes(1)
    expect(h.oauth.cancel).toHaveBeenCalledWith(XAI)

    await settle(() =>
      lastLogin().resolve({ success: false, error: 'Login cancelled', cancelled: true })
    )
    expect($('[data-oauth-error]')).toBeNull()
    expect($('[data-oauth-signin]')).not.toBeNull()
    expect($('[data-oauth-cancel]')).toBeNull()
  })

  it.each<[string, () => void, string]>([
    ['the host’s error text', () => lastLogin().resolve({ success: false, error: 'boom' }), 'boom'],
    [
      'the generic text when no reason is given',
      () => lastLogin().resolve({ success: false }),
      S.oauthFailed
    ],
    ['a rejected login’s message', () => lastLogin().reject(new Error('ipc down')), 'ipc down'],
    ['the generic text for a non-Error rejection', () => lastLogin().reject('weird'), S.oauthFailed]
  ])('PT-15 a failure shows %s', async (_what, fail, expected) => {
    await open(XAI, signedOut('xai'))
    await click('[data-oauth-signin]')

    await settle(fail)

    expect(text('[data-oauth-error]')).toBe(expected)
    expect($('[data-oauth-signin]')).not.toBeNull()
  })

  it('PT-16 after the login settles: flow cleared, status re-queried, onChanged, connected shown', async () => {
    await open(XAI, signedOut('xai'))
    await click('[data-oauth-signin]')
    await emit({
      providerId: XAI,
      kind: 'device_code',
      userCode: 'XAI-1',
      verificationUri: 'https://auth.example/d'
    })
    expect($('[data-oauth-device-code]')).not.toBeNull()
    const statusCalls = h.oauth.status.mock.calls.length
    h.statuses[XAI] = { ...signedOut('xai'), connected: true, expiresAt: 2 }

    await settle(() => lastLogin().resolve({ success: true }))

    expect(h.oauth.status.mock.calls.length).toBe(statusCalls + 1)
    expect(h.oauth.status).toHaveBeenLastCalledWith(XAI)
    expect(h.onChanged).toHaveBeenCalledTimes(1)
    expect($('[data-oauth-device-code]')).toBeNull()
    expect($('[data-oauth-cancel]')).toBeNull()
    expect($('[data-oauth-connected]')).not.toBeNull()
  })

  it('PT-17 sign out: logout, status re-queried, onChanged, a previous error cleared', async () => {
    await open(XAI, signedOut('xai'))
    await click('[data-oauth-signin]')
    // 登录报错，但重查状态时已经是登录态（比如别处登好了）—— 错误仍在，旁边是退出按钮
    h.statuses[XAI] = { ...signedOut('xai'), connected: true, expiresAt: 2 }
    await settle(() => lastLogin().resolve({ success: false, error: 'boom' }))
    expect(text('[data-oauth-error]')).toBe('boom')
    h.onChanged.mockClear()
    h.oauth.status.mockClear()
    h.statuses[XAI] = signedOut('xai')

    await click('[data-oauth-signout]')

    expect(h.oauth.logout).toHaveBeenCalledWith(XAI)
    expect(h.oauth.status).toHaveBeenCalledWith(XAI)
    expect(h.onChanged).toHaveBeenCalledTimes(1)
    expect($('[data-oauth-error]')).toBeNull()
    expect($('[data-oauth-signin]')).not.toBeNull()
  })

  it('PT-23 starting a new login clears the previous error', async () => {
    await open(XAI, signedOut('xai'))
    await click('[data-oauth-signin]')
    await settle(() => lastLogin().resolve({ success: false, error: 'boom' }))
    expect($('[data-oauth-error]')).not.toBeNull()

    await click('[data-oauth-signin]')

    expect($('[data-oauth-error]')).toBeNull()
    expect(h.oauth.login).toHaveBeenCalledTimes(2)
  })

  it('PT-20 events for another provider are not rendered', async () => {
    await open(OPENAI, signedOut('openai'))
    await click('[data-oauth-signin]')

    await emit({
      providerId: KIMI,
      kind: 'device_code',
      userCode: 'OTHER',
      verificationUri: 'https://x/d'
    })
    await emit({ providerId: KIMI, kind: 'auth_url', url: 'https://x/a' })
    await emit({
      providerId: KIMI,
      kind: 'prompt',
      promptId: 'p',
      input: 'manual_code',
      message: 'm'
    })

    expect($('[data-oauth-device-code]')).toBeNull()
    expect($('[data-oauth-browser]')).toBeNull()
    expect($('[data-oauth-prompt]')).toBeNull()
    expect(containerText()).toContain(S.oauthWaiting)
  })

  it('PT-22 a message event renders nothing', async () => {
    await open(OPENAI, signedOut('openai'))
    await click('[data-oauth-signin]')
    const before = containerText()

    await emit({ providerId: OPENAI, kind: 'message', message: 'Exchanging authorization code' })

    expect(containerText()).toBe(before)
    expect(containerText()).not.toContain('Exchanging authorization code')
  })
})

describe('prompts', () => {
  async function promptOpen(
    prompt: Omit<Extract<ProviderOAuthTabEvent, { kind: 'prompt' }>, 'providerId' | 'kind'>,
    over: Partial<ProviderTabProps> = {}
  ): Promise<void> {
    await open(OPENAI, signedOut('openai'), over)
    await click('[data-oauth-signin]')
    await emit({ providerId: OPENAI, kind: 'auth_url', url: 'https://auth.example/a' })
    await emit({ providerId: OPENAI, kind: 'prompt', ...prompt })
  }

  /** 输入框上方那一行标签 */
  const promptLabel = (): string => {
    const field = must('[data-oauth-prompt]').closest('.space-y-1\\.5')
    return (field?.firstElementChild?.textContent ?? '').trim()
  }

  it('PT-9 a manual_code prompt is a text field with the given placeholder and the UI’s own label', async () => {
    await promptOpen({
      promptId: 'p-1',
      input: 'manual_code',
      message: 'Complete login in your browser, or paste the final redirect URL here:',
      placeholder: 'http://127.0.0.1:1455/auth/callback'
    })

    const input = must<HTMLInputElement>('[data-oauth-prompt]')
    expect(input.type).toBe('text')
    expect(input.placeholder).toBe('http://127.0.0.1:1455/auth/callback')
    expect(promptLabel()).toBe(S.oauthManualLabel)
    expect(text('[data-oauth-prompt-submit]')).toBe(S.oauthManualSubmit)
    // 浏览器提示与取消仍在
    expect($('[data-oauth-browser]')).not.toBeNull()
    expect($('[data-oauth-cancel]')).not.toBeNull()
  })

  it('PT-10 a text prompt is labelled with the flow’s message; a secret prompt is a password field', async () => {
    await promptOpen({ promptId: 'p-1', input: 'text', message: 'Enter the code shown' })
    expect(must<HTMLInputElement>('[data-oauth-prompt]').type).toBe('text')
    expect(promptLabel()).toBe('Enter the code shown')

    await emit({
      providerId: OPENAI,
      kind: 'prompt',
      promptId: 'p-2',
      input: 'secret',
      message: 'Password'
    })
    expect(must<HTMLInputElement>('[data-oauth-prompt]').type).toBe('password')
    expect(promptLabel()).toBe('Password')
  })

  it('PT-11 answers are trimmed and sent by click or Enter; whitespace only disables it', async () => {
    await promptOpen({ promptId: 'p-1', input: 'manual_code', message: 'm' })
    const input = must<HTMLInputElement>('[data-oauth-prompt]')
    const submit = must<HTMLButtonElement>('[data-oauth-prompt-submit]')

    expect(submit.disabled).toBe(true)
    await typeInto(input, '   ')
    expect(submit.disabled).toBe(true)
    await pressEnter(input)
    await click('[data-oauth-prompt-submit]')
    expect(h.oauth.answer).not.toHaveBeenCalled()

    await typeInto(input, '  http://127.0.0.1:1455/auth/callback?code=c  ')
    expect(submit.disabled).toBe(false)
    await click('[data-oauth-prompt-submit]')
    expect(h.oauth.answer).toHaveBeenCalledTimes(1)
    expect(h.oauth.answer).toHaveBeenLastCalledWith(
      OPENAI,
      'p-1',
      'http://127.0.0.1:1455/auth/callback?code=c'
    )

    await pressEnter(input)
    expect(h.oauth.answer).toHaveBeenCalledTimes(2)
    expect(h.oauth.answer).toHaveBeenLastCalledWith(
      OPENAI,
      'p-1',
      'http://127.0.0.1:1455/auth/callback?code=c'
    )
  })

  it('PT-12 the field stays until the matching prompt_closed', async () => {
    await promptOpen({ promptId: 'p-1', input: 'manual_code', message: 'm' })
    await typeInto(must<HTMLInputElement>('[data-oauth-prompt]'), 'x')
    await click('[data-oauth-prompt-submit]')
    // 回答送出去了，但输入框由 prompt_closed 收起
    expect($('[data-oauth-prompt]')).not.toBeNull()

    await emit({ providerId: OPENAI, kind: 'prompt_closed', promptId: 'other' })
    expect($('[data-oauth-prompt]')).not.toBeNull()

    await emit({ providerId: OPENAI, kind: 'prompt_closed', promptId: 'p-1' })
    expect($('[data-oauth-prompt]')).toBeNull()
    expect($('[data-oauth-browser]')).not.toBeNull()
    expect($('[data-oauth-cancel]')).not.toBeNull()
  })

  it('PT-13 without answer in the host there is no field, but the hint and cancel stay', async () => {
    const api = { ...h.api, oauth: { ...h.api.oauth!, answer: undefined } }
    await promptOpen({ promptId: 'p-1', input: 'manual_code', message: 'm' }, { api })

    expect($('[data-oauth-prompt]')).toBeNull()
    expect($('[data-oauth-prompt-submit]')).toBeNull()
    expect($('[data-oauth-browser]')).not.toBeNull()
    expect($('[data-oauth-cancel]')).not.toBeNull()
  })

  it('PT-18 a new prompt id resets what was typed', async () => {
    await promptOpen({ promptId: 'p-1', input: 'text', message: 'first' })
    await typeInto(must<HTMLInputElement>('[data-oauth-prompt]'), 'half typed')
    expect(must<HTMLInputElement>('[data-oauth-prompt]').value).toBe('half typed')

    await emit({
      providerId: OPENAI,
      kind: 'prompt',
      promptId: 'p-2',
      input: 'text',
      message: 'second'
    })

    expect(must<HTMLInputElement>('[data-oauth-prompt]').value).toBe('')
    expect(promptLabel()).toBe('second')
  })

  it('PT-19 the submit button is disabled while the answer is in flight', async () => {
    const inFlight = deferred<unknown>()
    h.oauth.answer.mockImplementationOnce(() => inFlight.promise)
    await promptOpen({ promptId: 'p-1', input: 'manual_code', message: 'm' })
    await typeInto(must<HTMLInputElement>('[data-oauth-prompt]'), 'value')

    await click('[data-oauth-prompt-submit]')
    expect(must<HTMLButtonElement>('[data-oauth-prompt-submit]').disabled).toBe(true)
    await pressEnter(must<HTMLInputElement>('[data-oauth-prompt]'))
    expect(h.oauth.answer).toHaveBeenCalledTimes(1)

    await settle(() => inFlight.resolve({ success: true }))
    expect(must<HTMLButtonElement>('[data-oauth-prompt-submit]').disabled).toBe(false)
  })

  it('PT-21 Enter while an IME is composing does not submit', async () => {
    await promptOpen({ promptId: 'p-1', input: 'text', message: 'm' })
    const input = must<HTMLInputElement>('[data-oauth-prompt]')
    await typeInto(input, '登录码')

    await pressEnter(input, { isComposing: true })
    expect(h.oauth.answer).not.toHaveBeenCalled()

    await pressEnter(input)
    expect(h.oauth.answer).toHaveBeenCalledWith(OPENAI, 'p-1', '登录码')
  })
})

describe('logins this component did not start, and per-provider busy state', () => {
  it('PT-25 a login already pending on mount shows as busy; cancelling it re-queries the status', async () => {
    await open(OPENAI, { ...signedOut('openai'), pending: true })

    expect($('[data-oauth-cancel]')).not.toBeNull()
    expect($('[data-oauth-signin]')).toBeNull()
    expect(containerText()).toContain(S.oauthWaiting)
    expect(h.oauth.login).not.toHaveBeenCalled()

    h.oauth.status.mockClear()
    h.statuses[OPENAI] = signedOut('openai')
    await click('[data-oauth-cancel]')

    expect(h.oauth.cancel).toHaveBeenCalledWith(OPENAI)
    expect(h.oauth.status).toHaveBeenCalledWith(OPENAI)
    expect(h.oauth.cancel.mock.invocationCallOrder[0]).toBeLessThan(
      h.oauth.status.mock.invocationCallOrder[0]
    )
    expect($('[data-oauth-signin]')).not.toBeNull()
    expect($('[data-oauth-cancel]')).toBeNull()
  })

  it('PT-26 finished for a login started elsewhere: flow cleared, status re-queried, onChanged called', async () => {
    await open(OPENAI, { ...signedOut('openai'), pending: true })
    await emit({ providerId: OPENAI, kind: 'auth_url', url: 'https://auth.example/a' })
    expect($('[data-oauth-browser]')).not.toBeNull()
    h.oauth.status.mockClear()
    h.statuses[OPENAI] = { ...signedOut('openai'), connected: true, expiresAt: 3 }

    await emit({ providerId: OPENAI, kind: 'finished' })

    expect(h.oauth.status).toHaveBeenCalledTimes(1)
    expect(h.oauth.status).toHaveBeenCalledWith(OPENAI)
    expect(h.onChanged).toHaveBeenCalledTimes(1)
    expect($('[data-oauth-browser]')).toBeNull()
    expect($('[data-oauth-connected]')).not.toBeNull()
  })

  it('PT-26 finished for this component’s own login does not re-query; the login’s own settle does, once', async () => {
    await open(OPENAI, signedOut('openai'))
    await click('[data-oauth-signin]')
    h.oauth.status.mockClear()

    await emit({ providerId: OPENAI, kind: 'finished' })
    expect(h.oauth.status).not.toHaveBeenCalled()
    expect(h.onChanged).not.toHaveBeenCalled()
    expect($('[data-oauth-cancel]')).not.toBeNull()

    await settle(() => lastLogin().resolve({ success: true }))
    expect(h.oauth.status).toHaveBeenCalledTimes(1)
    expect(h.onChanged).toHaveBeenCalledTimes(1)
  })

  it('PT-27 busy is per provider: A settling leaves B’s login showing as running', async () => {
    h.statuses[XAI] = signedOut('xai')
    h.statuses[KIMI] = signedOut('kimi-coding')
    await render()

    await select(XAI)
    await click('[data-oauth-signin]')
    const loginA = lastLogin()
    await select(KIMI)
    expect($('[data-oauth-signin]')).not.toBeNull()
    await click('[data-oauth-signin]')
    expect($('[data-oauth-cancel]')).not.toBeNull()

    await settle(() =>
      loginA.resolve({ success: false, error: 'Login cancelled', cancelled: true })
    )

    expect($('[data-oauth-cancel]')).not.toBeNull()
    expect($('[data-oauth-signin]')).toBeNull()
    await select(XAI)
    expect($('[data-oauth-signin]')).not.toBeNull()
    expect($('[data-oauth-cancel]')).toBeNull()
  })
})
