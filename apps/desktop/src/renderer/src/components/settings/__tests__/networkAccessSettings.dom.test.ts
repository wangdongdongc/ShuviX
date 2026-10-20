// @vitest-environment jsdom
/**
 * 设置 → 通用 → 网络访问（NetworkAccessSettings）：一个开关 + 端口；谁能连由安全策略 network-admission 定（2026-10-19，
 * 局域网开关与「开放给」去掉了），开着时按准入策略的状态给引导与「让 agent 帮我设置」；无头运行时开关与端口锁住。
 *
 *   NAS-1  无头运行（开着、在监听）：开关显示为开且不可点、带无头说明；端口框不可改、值是端口、带「--port / 服务文件」说明；
 *          风险说明、准入引导与地址行都在
 *   NAS-2  无头运行：点那个锁住的开关 → 从不调 setEnabled
 *   NAS-3  桌面应用：没有无头说明；开关与端口框都可用
 *   NAS-4  （白盒）无头运行且监听失败（EADDRINUSE）：错误行（端口被占）与无头说明同时在
 *   NAS-5  networkHeadlessNote / networkHeadlessPortNote 在 en/zh/ja 都非空；钉住 en 的两句原文
 *   NAS-6  网络访问关着：没有准入引导；风险说明照常在
 *   NAS-7  admission builtin：引导 = networkAdmission_builtin({port})，含 `ssh -L P:127.0.0.1:P`；按钮是「Set up with an agent」；
 *          有「Copy prompt」
 *   NAS-8  admission override → networkAdmission_override、按钮「Adjust with an agent」；disabled → 警告 networkAdmission_disabled
 *   NAS-9  点「让 agent 帮我设置」：新建会话（不属于项目、标题 networkPolicyChatTitle）→ 勾上 shuvix 知识库 →
 *          openSessionWithDraft({sessionId, draft})，draft 就是 buildNetworkPolicyPrompt 那一段；在途时按钮不可点
 *   NAS-10 「Copy prompt」复制同一段提示词
 *   NAS-11 连着的设备带设备 ID（短写、title 是完整的）；最近被拒：没有就没有这一节，有就逐条（摘要、策略名、×次数、降级说明）
 *   NAS-12 buildNetworkPolicyPrompt：端口、无头、三种状态、地址、设备行（含设备 ID）、拒绝行；什么都没有 → none
 *   NAS-13 新增的文案在 en/zh/ja 都非空；networkAdmission_builtin 三种语言都含 `{{port}}` 与 `ssh -L`；networkPrompt 三种语言
 *          都含全部占位符、`network-policy` 与 `network-admission.md`；局域网开关那批旧键一个都不剩
 *
 * 桌面 vitest 对渲染层只收 `*.test.ts`（本文件自己切 jsdom），不带 react 插件 —— 一律 createElement。
 * 设置基元用 app-shell 的真件（Toggle 画成 `<button disabled>`、InlineInput 是 `<input disabled>`；按相对路径接进来，
 * 见下面的 mock）；`@shuvix/chat-ui` 只换掉组件用到的 copyToClipboard / useAppEvent / getChatApi。`window.api.network`
 * 与 `window.api.app.openSessionWithDraft` 都是 spy。i18n 走真 en/zh/ja 资源（界面按 en 画）。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import ja from '@shuvix/chat-protocol/i18n/locales/ja.json'
import type { NetworkStatus } from '../../../../../shared/network'

const chat = vi.hoisted(() => ({
  copyToClipboard: vi.fn(),
  create: vi.fn(),
  updateKnowledgeBases: vi.fn()
}))

vi.mock('@shuvix/chat-ui', () => ({
  copyToClipboard: chat.copyToClipboard,
  useAppEvent: vi.fn(),
  getChatApi: () => ({
    session: { create: chat.create, updateKnowledgeBases: chat.updateKnowledgeBases }
  })
}))
// 本地的 SettingsPrimitives 只是再导出 `@shuvix/app-shell/settings/SettingsPrimitives`；这份 vitest 配置没有 app-shell
// 的路径别名（包的 exports 只认 `./src/*.ts`，而它是 .tsx），所以按相对路径把**真件**接过来
vi.mock(
  '../SettingsPrimitives',
  () => import('../../../../../../../../packages/app-shell/src/settings/SettingsPrimitives')
)

import { NetworkAccessSettings } from '../NetworkAccessSettings'
import { buildNetworkPolicyPrompt } from '../networkPolicyPrompt'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const P = 7799
const LOCALES = { en, zh, ja } as const
const DEVICE = 'AbCdEfGhIjKlMnOpQrStUv'

/** 桌面应用、网络访问开着、内置准入、在监听 */
function statusOf(over: Partial<NetworkStatus> = {}): NetworkStatus {
  return {
    enabled: true,
    port: P,
    listening: true,
    addresses: [`http://127.0.0.1:${P}`],
    clients: [],
    admission: 'builtin',
    denials: [],
    ...over
  }
}

/** 无头运行的状态（其余同上） */
function headlessOf(over: Partial<NetworkStatus> = {}): NetworkStatus {
  return statusOf({ headless: true, ...over })
}

const network = {
  status: vi.fn<() => Promise<NetworkStatus>>(),
  setEnabled: vi.fn<(enabled: boolean) => Promise<NetworkStatus>>(),
  setPort: vi.fn<(port: number) => Promise<NetworkStatus>>()
}
const app = {
  openSessionWithDraft: vi.fn<(p: { sessionId: string; draft: string }) => Promise<unknown>>()
}

let container: HTMLDivElement
let root: Root

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function mount(status: NetworkStatus): Promise<void> {
  network.status.mockResolvedValue(status)
  await act(async () => {
    root.render(createElement(NetworkAccessSettings))
  })
  await flush()
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    ;(el as HTMLElement).click()
  })
  await flush()
}

/** 当前语言（en）的译文；没译（回了键本身）就算错 */
const tr = (key: string, options?: Record<string, unknown>): string => {
  const text = i18n.t(key, options)
  expect(text, key).not.toBe(key)
  return text
}

/** 某种语言的 settings.<key> 原文（不经插值） */
const raw = (lang: keyof typeof LOCALES, key: string): unknown =>
  (LOCALES[lang] as unknown as { settings: Record<string, unknown> }).settings[key]

const $ = (selector: string): HTMLElement | null => container.querySelector(selector)
const textOf = (selector: string): string | null => $(selector)?.textContent ?? null
const enableButton = (): HTMLButtonElement =>
  container.querySelector<HTMLButtonElement>('[data-network-toggle] button')!
const portInput = (): HTMLInputElement =>
  container.querySelector<HTMLInputElement>('[data-network-port] input')!
const chatButton = (): HTMLButtonElement =>
  container.querySelector<HTMLButtonElement>('[data-network-policy-chat]')!

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: {
      en: { translation: en },
      zh: { translation: zh },
      ja: { translation: ja }
    },
    showSupportNotice: false
  })
  ;(window as unknown as { api: unknown }).api = { network, app }
})

beforeEach(() => {
  network.status.mockReset()
  network.setEnabled.mockReset()
  network.setPort.mockReset()
  app.openSessionWithDraft.mockReset()
  chat.copyToClipboard.mockReset()
  chat.create.mockReset()
  chat.updateKnowledgeBases.mockReset()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

describe('NAS-1..NAS-6 开关、端口与无头运行', () => {
  it('NAS-1 无头：开关与端口锁住，各带说明；风险、准入引导与地址都在', async () => {
    await mount(headlessOf())
    expect(enableButton().disabled).toBe(true)
    expect($('[data-network-toggle]')!.getAttribute('data-network-toggle')).toBe('on')
    expect(textOf('[data-network-headless]')).toBe(tr('settings.networkHeadlessNote'))
    expect(portInput().disabled).toBe(true)
    expect(portInput().value).toBe(String(P))
    expect(textOf('[data-network-headless-port]')).toBe(tr('settings.networkHeadlessPortNote'))
    expect(textOf('[data-network-risk]')).toBe(tr('settings.networkRisk'))
    expect($('[data-network-admission="builtin"]')).not.toBeNull()
    expect($(`[data-network-address="http://127.0.0.1:${P}"]`)).not.toBeNull()
  })

  it('NAS-2 无头：点锁住的开关从不调 setEnabled', async () => {
    await mount(headlessOf())
    await click(enableButton())
    expect(network.setEnabled).not.toHaveBeenCalled()
  })

  it('NAS-3 桌面：没有无头说明；开关与端口框可用', async () => {
    await mount(statusOf())
    expect($('[data-network-headless]')).toBeNull()
    expect($('[data-network-headless-port]')).toBeNull()
    expect(enableButton().disabled).toBe(false)
    expect(portInput().disabled).toBe(false)
  })

  it('NAS-4 无头且端口被占：错误行与无头说明同时在', async () => {
    await mount(headlessOf({ listening: false, addresses: [], error: 'EADDRINUSE' }))
    expect(textOf('[data-network-error]')).toBe(tr('settings.networkErrorInUse', { port: P }))
    expect($('[data-network-headless]')).not.toBeNull()
  })

  it('NAS-5 两句无头说明在三种语言都非空；钉住 en 原文', () => {
    for (const lang of ['en', 'zh', 'ja'] as const) {
      for (const key of ['networkHeadlessNote', 'networkHeadlessPortNote']) {
        expect(typeof raw(lang, key), `${lang}.${key}`).toBe('string')
        expect((raw(lang, key) as string).trim(), `${lang}.${key}`).not.toBe('')
      }
    }
    expect(raw('en', 'networkHeadlessNote')).toBe(
      'Headless mode keeps network access on; stop the ShuviX service to turn it off.'
    )
    expect(raw('en', 'networkHeadlessPortNote')).toBe('Set with --port or in the service file.')
  })

  it('NAS-6 关着：没有准入引导；风险说明照常在', async () => {
    await mount(statusOf({ enabled: false, listening: false, addresses: [] }))
    expect($('[data-network-admission]')).toBeNull()
    expect($('[data-network-policy-chat]')).toBeNull()
    expect(textOf('[data-network-risk]')).toBe(tr('settings.networkRisk'))
  })
})

describe('NAS-7..NAS-10 准入引导', () => {
  it('NAS-7 builtin：只放本机的说明（含 SSH 隧道）、「Set up with an agent」、「Copy prompt」', async () => {
    await mount(statusOf())
    const guide = textOf('[data-network-admission="builtin"]')!
    expect(guide).toContain(tr('settings.networkAdmission_builtin', { port: P }))
    expect(guide).toContain(`ssh -L ${P}:127.0.0.1:${P}`)
    expect(chatButton().textContent).toBe(tr('settings.networkPolicySetUp'))
    expect(textOf('[data-network-policy-copy]')).toBe(tr('settings.networkPolicyCopyPrompt'))
  })

  it('NAS-8 override / disabled 的说明与按钮', async () => {
    await mount(statusOf({ admission: 'override' }))
    expect(textOf('[data-network-admission="override"]')).toContain(
      tr('settings.networkAdmission_override')
    )
    expect(chatButton().textContent).toBe(tr('settings.networkPolicyAdjust'))
    act(() => root.unmount())
    root = createRoot(container)
    await mount(statusOf({ admission: 'disabled' }))
    expect(textOf('[data-network-admission="disabled"]')).toContain(
      tr('settings.networkAdmission_disabled')
    )
    expect(chatButton().textContent).toBe(tr('settings.networkPolicySetUp'))
  })

  it('NAS-9 点按钮：新建会话 → 勾上 shuvix → 带提示词打开；在途时不可点', async () => {
    const status = statusOf({
      clients: [
        {
          id: 'ws:1',
          remoteAddress: '192.168.1.23',
          userAgent: 'Safari',
          device: DEVICE,
          connectedAt: 1
        }
      ]
    })
    await mount(status)
    let resolveCreate: (value: { id: string }) => void = () => {}
    chat.create.mockReturnValue(new Promise((resolve) => (resolveCreate = resolve)))
    chat.updateKnowledgeBases.mockResolvedValue({ success: true })
    app.openSessionWithDraft.mockResolvedValue({ success: true })
    await click(chatButton())
    expect(chatButton().disabled).toBe(true)
    await act(async () => resolveCreate({ id: 's-new' }))
    await flush()
    expect(chat.create).toHaveBeenCalledWith({
      projectId: null,
      title: tr('settings.networkPolicyChatTitle')
    })
    expect(chat.updateKnowledgeBases).toHaveBeenCalledWith({
      id: 's-new',
      knowledgeBases: ['shuvix']
    })
    const draft = buildNetworkPolicyPrompt(i18n.t.bind(i18n), status)
    expect(app.openSessionWithDraft).toHaveBeenCalledWith({ sessionId: 's-new', draft })
    expect(draft).toContain(DEVICE)
    expect(chatButton().disabled).toBe(false)
  })

  it('NAS-10 「Copy prompt」复制同一段提示词', async () => {
    const status = statusOf()
    await mount(status)
    await click($('[data-network-policy-copy] button')!)
    expect(chat.copyToClipboard).toHaveBeenCalledWith(
      buildNetworkPolicyPrompt(i18n.t.bind(i18n), status)
    )
  })
})

describe('NAS-11 设备与最近被拒', () => {
  it('NAS-11 设备 ID 短写、title 完整；拒绝逐条，没有就没有这一节', async () => {
    await mount(
      statusOf({
        clients: [
          {
            id: 'ws:1',
            remoteAddress: '192.168.1.23',
            userAgent: 'Safari',
            device: DEVICE,
            connectedAt: 1
          }
        ]
      })
    )
    const device = $(`[data-network-client-device="${DEVICE}"]`)!
    expect(device.getAttribute('title')).toBe(DEVICE)
    expect(device.textContent).toContain(tr('settings.networkDevice', { id: 'AbCdEfGh…' }))
    expect($('[data-network-denial]')).toBeNull()
    expect(container.textContent).not.toContain(tr('settings.networkDenials'))

    act(() => root.unmount())
    root = createRoot(container)
    await mount(
      statusOf({
        denials: [
          {
            at: 1,
            lastAt: 2,
            count: 3,
            stage: 'request',
            summary: 'GET /',
            address: '192.168.1.40',
            device: DEVICE,
            rule: 'network-admission#0',
            policies: ['Remote Access From This Computer Only'],
            downgraded: false
          },
          {
            at: 1,
            lastAt: 2,
            count: 1,
            stage: 'channel',
            summary: 'session:prompt',
            address: '192.168.1.23',
            device: '',
            rule: 'mine#0',
            policies: [],
            downgraded: true
          }
        ]
      })
    )
    expect(container.textContent).toContain(tr('settings.networkDenials'))
    expect(textOf('[data-network-denial="request"]')).toBe('GET /')
    const rows = container.textContent!
    expect(rows).toContain('Remote Access From This Computer Only')
    expect(rows).toContain('×3')
    expect(rows).toContain('mine#0')
    expect(rows).toContain(tr('settings.networkDenialDowngraded'))
  })
})

describe('NAS-12 提示词', () => {
  it('NAS-12 端口、无头、状态、地址、设备、拒绝；空 → none', () => {
    const t = i18n.t.bind(i18n)
    const bare = buildNetworkPolicyPrompt(t, statusOf())
    expect(bare).toContain(`port ${P})`)
    expect(bare).toContain(tr('settings.networkPromptState_builtin'))
    expect(bare).toContain(`http://127.0.0.1:${P}`)
    expect(bare.match(/\nnone/g)).toHaveLength(2)
    expect(bare).toContain('network-policy')
    expect(bare).toContain('~/.shuvix/policies/network-admission.md')

    const full = buildNetworkPolicyPrompt(
      t,
      headlessOf({
        admission: 'override',
        addresses: [`http://192.168.1.10:${P}`, `http://127.0.0.1:${P}`],
        clients: [
          {
            id: 'ws:1',
            remoteAddress: '192.168.1.23',
            userAgent: '',
            device: DEVICE,
            connectedAt: 1
          }
        ],
        denials: [
          {
            at: 1,
            lastAt: 1,
            count: 1,
            stage: 'request',
            summary: 'GET /',
            address: '192.168.1.40',
            device: '',
            rule: 'network-admission#0',
            policies: [],
            downgraded: false
          }
        ]
      })
    )
    expect(full).toContain(`port ${P}${tr('settings.networkPromptHeadless')})`)
    expect(full).toContain(tr('settings.networkPromptState_override'))
    expect(full).toContain(`http://192.168.1.10:${P}  http://127.0.0.1:${P}`)
    expect(full).toContain(`- 192.168.1.23 (?), device ID ${DEVICE}`)
    expect(full).toContain('- 192.168.1.40, device ID none: GET / (rule network-admission#0)')
    expect(buildNetworkPolicyPrompt(t, statusOf({ admission: 'disabled' }))).toContain(
      tr('settings.networkPromptState_disabled')
    )
  })
})

describe('NAS-13 文案', () => {
  const NEW_KEYS = [
    'networkAdmission_builtin',
    'networkAdmission_override',
    'networkAdmission_disabled',
    'networkPolicySetUp',
    'networkPolicyAdjust',
    'networkPolicyCopyPrompt',
    'networkPolicyChatTitle',
    'networkDevice',
    'networkDenials',
    'networkDenialsDesc',
    'networkDenialDowngraded',
    'networkPrompt',
    'networkPromptHeadless',
    'networkPromptState_builtin',
    'networkPromptState_override',
    'networkPromptState_disabled',
    'networkPromptNone',
    'networkPromptClient',
    'networkPromptDenial'
  ]
  const GONE = [
    'networkLan',
    'networkLocalOnly',
    'networkHeadlessLanNote',
    'networkLanScope',
    'networkLanScopeAll',
    'networkLanScopeMissing',
    'networkLanScopeOnly',
    'networkHeadlessScopeNote',
    'networkErrorNoInterface'
  ]

  it('NAS-13 新键非空、占位符齐全；旧键不剩', () => {
    for (const lang of ['en', 'zh', 'ja'] as const) {
      for (const key of NEW_KEYS) {
        expect(typeof raw(lang, key), `${lang}.${key}`).toBe('string')
        expect((raw(lang, key) as string).trim(), `${lang}.${key}`).not.toBe('')
      }
      for (const key of GONE) expect(raw(lang, key), `${lang}.${key}`).toBeUndefined()
      const builtin = raw(lang, 'networkAdmission_builtin') as string
      expect(builtin, lang).toContain('{{port}}')
      expect(builtin, lang).toContain('ssh -L')
      const prompt = raw(lang, 'networkPrompt') as string
      for (const placeholder of ['port', 'headless', 'state', 'addresses', 'clients', 'denials']) {
        expect(prompt, `${lang} ${placeholder}`).toContain(`{{${placeholder}}}`)
      }
      expect(prompt, lang).toContain('network-policy')
      expect(prompt, lang).toContain('~/.shuvix/policies/network-admission.md')
      expect(raw(lang, 'networkPromptClient') as string, lang).toContain('{{device}}')
      expect(raw(lang, 'networkPromptDenial') as string, lang).toContain('{{rule}}')
    }
  })
})
