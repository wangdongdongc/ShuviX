// @vitest-environment jsdom
/**
 * 设置 → 通用 → 网络访问（NetworkAccessSettings）：两个开关 + 端口，无头运行时全部锁住。
 *
 *   NAS-1  无头运行（access on、LAN off、在监听）：网络访问开关显示为开且不可点、带无头说明；端口框不可改、值是端口、
 *          带「--port / 服务文件」说明；局域网开关显示为关且不可点、带无头说明；「只有这台电脑」说明、风险说明与地址行都在
 *   NAS-2  无头运行：点那个锁住的网络访问开关 → 从不调 setEnabled
 *   NAS-3  桌面应用（access on、LAN off）：三句无头说明都没有；网络访问开关、端口框与局域网开关都可用；「只有这台电脑」说明在
 *   NAS-4  （白盒）无头运行且监听失败（listening:false, error:'EADDRINUSE'）：错误行（端口被占）与无头说明同时在
 *   NAS-5  networkHeadlessNote / networkHeadlessPortNote 在 en/zh/ja 都非空；钉住 en 的两句原文
 *   NAS-6  网络访问关着：局域网开关不可点；没有「只有这台电脑」说明；风险说明照常在
 *   NAS-7  桌面应用（access on、LAN off）：局域网开关可点；「只有这台电脑」说明 = networkLocalOnly({port}) 且含
 *          `ssh -L P:127.0.0.1:P`；点一下 → setLan(true) 恰一次；回 lan:true 之后开关显示为开、说明消失、风险说明还在
 *   NAS-8  无头运行 lan:true：局域网开关显示为开且不可点、带无头局域网说明；没有「只有这台电脑」说明；点它从不调 setLan
 *   NAS-9  无头运行 lan:false：局域网开关显示为关且不可点；无头局域网说明与「只有这台电脑」说明都在
 *   NAS-10 （白盒）setLan 在途时局域网开关不可点；setLan 拒绝 → 重新拉一次 network.status，开关恢复可点
 *   NAS-11 networkLan / networkLocalOnly / networkHeadlessLanNote 在 en/zh/ja 都非空，networkLocalOnly 三种语言都含
 *          `{{port}}` 与 `ssh -L`；钉住 en 的 networkLan、networkHeadlessLanNote、networkEnable
 *
 * 「开放给」（只开放给一个网络，2026-10-15；候选 eth0 10.0.0.5/24、eth1 192.168.50.10/24）：
 *   NAS-12 桌面、局域网开、有候选、没选：一行 networkLanScope；`[data-network-lan-scope]` = all；选项依次是「所有网络」与
 *          `<网卡> · <网段>`；选中 ''；没有「只有 … 网段」那句
 *   NAS-13 局域网关：没有这一行，也没有 select
 *   NAS-14 选 eth1 → setLanInterface('eth1') 恰一次；回来的状态 → scope eth1、选中 eth1、networkLanScopeOnly({cidr})；
 *          再选「所有网络」→ setLanInterface(null)（不是 ''）
 *   NAS-15 存的网卡 eth7 不在候选里且 ENOINTERFACE：最后一个选项 'eth7 (not found)'、选中它；错误行 = networkErrorNoInterface
 *          （name eth7）；网络访问关着 → 没有错误行
 *   NAS-16 存的是候选的网卡名 → 没有「找不到」；存的是候选的地址（192.168.50.10）→ 也没有，选中的是那块网卡 eth1
 *   NAS-17 无头：没有 select，显示存的网卡名、带无头说明（networkHeadlessScopeNote），从不调 setLanInterface；没给 --bind →
 *          显示「所有网络」与那句说明
 *   NAS-18 setLanInterface 拒绝 → 重新拉一次 network.status，select 跟着拉回来的值
 *   NAS-19 networkLanScope / …All / …Missing / …Only / networkHeadlessScopeNote / networkErrorNoInterface 在 en/zh/ja 都非空；
 *          Missing 与 ErrorNoInterface 含 `{{name}}`、Only 含 `{{cidr}}`、HeadlessScopeNote 含 `--bind`；钉住 en 原文
 *
 * 桌面 vitest 对渲染层只收 `*.test.ts`（本文件自己切 jsdom），不带 react 插件 —— 一律 createElement。
 * 设置基元用 app-shell 的真件（Toggle 画成 `<button disabled>`、InlineInput 是 `<input disabled>`；按相对路径接进来，
 * 见下面的 mock）；`@shuvix/chat-ui` 只换掉组件用到的 copyToClipboard / useAppEvent。`window.api.network` 四个方法都是 spy。i18n 走真 en/zh/ja 资源
 * （界面按 en 画）。
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

vi.mock('@shuvix/chat-ui', () => ({
  copyToClipboard: vi.fn(),
  useAppEvent: vi.fn()
}))
// 本地的 SettingsPrimitives 只是再导出 `@shuvix/app-shell/settings/SettingsPrimitives`；这份 vitest 配置没有 app-shell
// 的路径别名（包的 exports 只认 `./src/*.ts`，而它是 .tsx），所以按相对路径把**真件**接过来
vi.mock(
  '../SettingsPrimitives',
  () => import('../../../../../../../../packages/app-shell/src/settings/SettingsPrimitives')
)

import { NetworkAccessSettings } from '../NetworkAccessSettings'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const P = 7799
const LOCALES = { en, zh, ja } as const

/** 桌面应用、网络访问开着、局域网关着、在监听 */
function statusOf(over: Partial<NetworkStatus> = {}): NetworkStatus {
  return {
    enabled: true,
    port: P,
    lan: false,
    lanCandidates: [],
    bindAddress: '127.0.0.1',
    listening: true,
    addresses: [`http://127.0.0.1:${P}`],
    clients: [],
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
  setPort: vi.fn<(port: number) => Promise<NetworkStatus>>(),
  setLan: vi.fn<(lan: boolean) => Promise<NetworkStatus>>(),
  setLanInterface: vi.fn<(spec: string | null) => Promise<NetworkStatus>>()
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
const lanButton = (): HTMLButtonElement =>
  container.querySelector<HTMLButtonElement>('[data-network-lan] button')!
const portInput = (): HTMLInputElement =>
  container.querySelector<HTMLInputElement>('[data-network-port] input')!
const scope = (): string | null =>
  $('[data-network-lan-scope]')?.getAttribute('data-network-lan-scope') ?? null
const scopeSelect = (): HTMLSelectElement | null =>
  container.querySelector<HTMLSelectElement>('[data-network-lan-scope] select')
const scopeOptions = (): Array<[string, string]> =>
  [...(scopeSelect()?.options ?? [])].map((o) => [o.value, o.textContent ?? ''])
/** 「开放给」那一行的标题（控件包在 `div.shrink-0` 里，行的第一个孩子是标题那一栏） */
const scopeTitle = (): string | null =>
  $('[data-network-lan-scope]')?.parentElement?.parentElement?.firstElementChild?.firstElementChild
    ?.textContent ?? null

async function chooseScope(value: string): Promise<void> {
  const select = scopeSelect()!
  await act(async () => {
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await flush()
}

const CANDS = [
  { interface: 'eth0', address: '10.0.0.5', cidr: '10.0.0.5/24' },
  { interface: 'eth1', address: '192.168.50.10', cidr: '192.168.50.10/24' }
]

/** 局域网开、所有网络、有候选 */
function sharedOf(over: Partial<NetworkStatus> = {}): NetworkStatus {
  return statusOf({
    lan: true,
    bindAddress: '0.0.0.0',
    lanCandidates: CANDS,
    addresses: [`http://10.0.0.5:${P}`, `http://192.168.50.10:${P}`, `http://127.0.0.1:${P}`],
    ...over
  })
}

/** 只开放给 eth1 */
function onEth1Of(over: Partial<NetworkStatus> = {}): NetworkStatus {
  return sharedOf({
    lanInterface: 'eth1',
    lanNetwork: CANDS[1],
    bindAddress: '192.168.50.10',
    addresses: [`http://192.168.50.10:${P}`],
    ...over
  })
}

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
  ;(window as unknown as { api: unknown }).api = { network }
})

beforeEach(() => {
  network.status.mockReset()
  network.setEnabled.mockReset()
  network.setPort.mockReset()
  network.setLan.mockReset()
  network.setLanInterface.mockReset()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

describe('NAS-1 / NAS-2 无头运行锁住网络访问开关与端口', () => {
  it('NAS-1 开关显示为开且不可点、端口框锁住、局域网开关锁住，各带说明；本机说明、风险说明与地址行都在', async () => {
    await mount(headlessOf())

    expect($('[data-network-toggle="on"]')).not.toBeNull()
    expect(enableButton().disabled).toBe(true)
    expect(textOf('[data-network-headless]')).toBe(tr('settings.networkHeadlessNote'))

    expect(portInput().disabled).toBe(true)
    expect(portInput().value).toBe(String(P))
    expect(textOf('[data-network-headless-port]')).toBe(tr('settings.networkHeadlessPortNote'))

    expect($('[data-network-lan="off"]')).not.toBeNull()
    expect(lanButton().disabled).toBe(true)
    expect($('[data-network-headless-lan]')).not.toBeNull()

    expect(textOf('[data-network-local-only]')).toBe(tr('settings.networkLocalOnly', { port: P }))
    expect(textOf('[data-network-risk]')).toBe(tr('settings.networkRisk'))
    expect($(`[data-network-address="http://127.0.0.1:${P}"]`)).not.toBeNull()
  })

  it('NAS-2 点锁住的网络访问开关 → 从不调 setEnabled', async () => {
    await mount(headlessOf())
    await click(enableButton())
    enableButton().dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    expect(network.setEnabled).not.toHaveBeenCalled()
    expect($('[data-network-toggle="on"]')).not.toBeNull()
  })
})

describe('NAS-3 桌面应用', () => {
  it('NAS-3 没有无头说明；网络访问开关、端口框、局域网开关都可用；本机说明在', async () => {
    await mount(statusOf())
    expect($('[data-network-headless]')).toBeNull()
    expect($('[data-network-headless-lan]')).toBeNull()
    expect($('[data-network-headless-port]')).toBeNull()

    expect($('[data-network-toggle="on"]')).not.toBeNull()
    expect(enableButton().disabled).toBe(false)
    expect(portInput().disabled).toBe(false)
    expect(portInput().value).toBe(String(P))
    expect($('[data-network-lan="off"]')).not.toBeNull()
    expect(lanButton().disabled).toBe(false)
    expect($('[data-network-local-only]')).not.toBeNull()
  })
})

describe('NAS-4 无头运行且监听失败', () => {
  it('NAS-4 错误行（端口被占）与无头说明同时在', async () => {
    await mount(headlessOf({ listening: false, error: 'EADDRINUSE', addresses: [] }))
    expect(textOf('[data-network-error]')).toBe(tr('settings.networkErrorInUse', { port: P }))
    expect(textOf('[data-network-headless]')).toBe(tr('settings.networkHeadlessNote'))
    expect(enableButton().disabled).toBe(true)
  })
})

describe('NAS-5 无头说明的文案', () => {
  it('NAS-5 en/zh/ja 都非空；钉住 en 原文', () => {
    for (const lang of ['en', 'zh', 'ja'] as const) {
      for (const key of ['networkHeadlessNote', 'networkHeadlessPortNote']) {
        const text = raw(lang, key)
        expect(typeof text, `${lang}.${key}`).toBe('string')
        expect((text as string).trim().length, `${lang}.${key}`).toBeGreaterThan(0)
      }
    }
    expect(raw('en', 'networkHeadlessNote')).toBe(
      'Headless mode keeps network access on; stop the ShuviX service to turn it off.'
    )
    expect(raw('en', 'networkHeadlessPortNote')).toBe('Set with --port or in the service file.')
  })
})

describe('NAS-6 网络访问关着', () => {
  it('NAS-6 局域网开关不可点；没有本机说明；风险说明在', async () => {
    await mount(
      statusOf({ enabled: false, listening: false, addresses: [], bindAddress: undefined })
    )
    expect($('[data-network-toggle="off"]')).not.toBeNull()
    expect(lanButton().disabled).toBe(true)
    expect($('[data-network-local-only]')).toBeNull()
    expect(textOf('[data-network-risk]')).toBe(tr('settings.networkRisk'))
  })
})

describe('NAS-7 局域网开关（桌面应用）', () => {
  it('NAS-7 可点；本机说明含 ssh -L；点一下 setLan(true)；回 lan:true 之后显示为开、说明消失、风险说明还在', async () => {
    await mount(statusOf())
    expect($('[data-network-lan="off"]')).not.toBeNull()
    expect(lanButton().disabled).toBe(false)
    const localOnly = textOf('[data-network-local-only]')
    expect(localOnly).toBe(tr('settings.networkLocalOnly', { port: P }))
    expect(localOnly).toContain(`ssh -L ${P}:127.0.0.1:${P}`)

    network.setLan.mockResolvedValue(statusOf({ lan: true, bindAddress: '0.0.0.0' }))
    await click(lanButton())
    expect(network.setLan).toHaveBeenCalledTimes(1)
    expect(network.setLan).toHaveBeenCalledWith(true)

    expect($('[data-network-lan="on"]')).not.toBeNull()
    expect($('[data-network-lan="off"]')).toBeNull()
    expect($('[data-network-local-only]')).toBeNull()
    expect(textOf('[data-network-risk]')).toBe(tr('settings.networkRisk'))
    expect(network.setEnabled).not.toHaveBeenCalled()
  })
})

describe('NAS-8 / NAS-9 无头运行的局域网开关', () => {
  it('NAS-8 lan:true → 显示为开且不可点、带无头局域网说明；没有本机说明；点它不调 setLan', async () => {
    await mount(headlessOf({ lan: true, bindAddress: '0.0.0.0' }))
    expect($('[data-network-lan="on"]')).not.toBeNull()
    expect(lanButton().disabled).toBe(true)
    expect(textOf('[data-network-headless-lan]')).toBe(tr('settings.networkHeadlessLanNote'))
    expect($('[data-network-local-only]')).toBeNull()

    await click(lanButton())
    lanButton().dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    expect(network.setLan).not.toHaveBeenCalled()
  })

  it('NAS-9 lan:false → 显示为关且不可点；无头局域网说明与本机说明都在', async () => {
    await mount(headlessOf())
    expect($('[data-network-lan="off"]')).not.toBeNull()
    expect(lanButton().disabled).toBe(true)
    expect(textOf('[data-network-headless-lan]')).toBe(tr('settings.networkHeadlessLanNote'))
    expect(textOf('[data-network-local-only]')).toBe(tr('settings.networkLocalOnly', { port: P }))
  })
})

describe('NAS-10 setLan 在途与失败', () => {
  it('NAS-10 在途时局域网开关不可点；拒绝 → 重新拉一次 status，开关恢复可点', async () => {
    await mount(statusOf())
    expect(network.status).toHaveBeenCalledTimes(1)

    let reject: (error: Error) => void = () => {}
    network.setLan.mockImplementation(
      () =>
        new Promise<NetworkStatus>((_resolve, rejectPromise) => {
          reject = rejectPromise
        })
    )
    await click(lanButton())
    expect(network.setLan).toHaveBeenCalledTimes(1)
    expect(lanButton().disabled).toBe(true)
    // 在途时再点也不会再发一次
    await click(lanButton())
    expect(network.setLan).toHaveBeenCalledTimes(1)

    await act(async () => {
      reject(new Error('boom'))
    })
    await flush()
    expect(network.status).toHaveBeenCalledTimes(2)
    expect($('[data-network-lan="off"]')).not.toBeNull()
    expect(lanButton().disabled).toBe(false)
  })
})

describe('NAS-11 局域网开关的文案', () => {
  it('NAS-11 en/zh/ja 都非空；networkLocalOnly 含 {{port}} 与 ssh -L；钉住 en 原文', () => {
    for (const lang of ['en', 'zh', 'ja'] as const) {
      for (const key of ['networkLan', 'networkLocalOnly', 'networkHeadlessLanNote']) {
        const text = raw(lang, key)
        expect(typeof text, `${lang}.${key}`).toBe('string')
        expect((text as string).trim().length, `${lang}.${key}`).toBeGreaterThan(0)
      }
      const localOnly = raw(lang, 'networkLocalOnly') as string
      expect(localOnly, lang).toContain('{{port}}')
      expect(localOnly, lang).toContain('ssh -L')
    }
    expect(raw('en', 'networkLan')).toBe('Allow other devices on the local network')
    expect(raw('en', 'networkHeadlessLanNote')).toBe(
      'Chosen at startup (--lan); restart ShuviX to change it.'
    )
    expect(raw('en', 'networkEnable')).toBe('Allow access from a browser')
  })
})

describe('NAS-12..NAS-18 开放给', () => {
  it('NAS-12 局域网开、没选：所有网络在前、候选依次列出；选中所有网络；没有网段那句', async () => {
    await mount(sharedOf())
    expect(scopeTitle()).toBe(tr('settings.networkLanScope'))
    expect(scope()).toBe('all')
    expect(scopeOptions()).toStrictEqual([
      ['', 'All networks'],
      ['eth0', 'eth0 · 10.0.0.5/24'],
      ['eth1', 'eth1 · 192.168.50.10/24']
    ])
    expect(scopeSelect()!.value).toBe('')
    expect($('[data-network-lan-only]')).toBeNull()
  })

  it('NAS-13 局域网关：没有这一行', async () => {
    await mount(statusOf({ lanCandidates: CANDS }))
    expect($('[data-network-lan-scope]')).toBeNull()
    expect(scopeSelect()).toBeNull()
  })

  it('NAS-14 选 eth1 → setLanInterface(eth1)；网段那句；再选所有网络 → null', async () => {
    await mount(sharedOf())
    network.setLanInterface.mockResolvedValueOnce(onEth1Of())
    await chooseScope('eth1')
    expect(network.setLanInterface).toHaveBeenCalledTimes(1)
    expect(network.setLanInterface).toHaveBeenCalledWith('eth1')
    expect(scope()).toBe('eth1')
    expect(scopeSelect()!.value).toBe('eth1')
    expect(textOf('[data-network-lan-only]')).toBe(
      tr('settings.networkLanScopeOnly', { cidr: '192.168.50.10/24' })
    )

    network.setLanInterface.mockResolvedValueOnce(sharedOf())
    await chooseScope('')
    expect(network.setLanInterface).toHaveBeenCalledTimes(2)
    expect(network.setLanInterface.mock.calls[1]).toStrictEqual([null])
    expect(scope()).toBe('all')
    expect($('[data-network-lan-only]')).toBeNull()
    expect(network.setLan).not.toHaveBeenCalled()
    expect(network.setEnabled).not.toHaveBeenCalled()
  })

  it('NAS-15 存的网卡找不到：选项里标「找不到」并选中；错误行；关着时没有错误行', async () => {
    const missing = sharedOf({
      lanInterface: 'eth7',
      error: 'ENOINTERFACE',
      listening: false,
      bindAddress: undefined,
      addresses: []
    })
    await mount(missing)
    const options = scopeOptions()
    expect(options).toHaveLength(4)
    expect(options.at(-1)).toStrictEqual(['eth7', 'eth7 (not found)'])
    expect(scopeSelect()!.value).toBe('eth7')
    expect(scope()).toBe('eth7')
    expect(textOf('[data-network-error]')).toBe(
      tr('settings.networkErrorNoInterface', { name: 'eth7' })
    )
    expect(textOf('[data-network-error]')).toContain('eth7')

    act(() => root.unmount())
    root = createRoot(container)
    await mount({ ...missing, enabled: false })
    expect($('[data-network-error]')).toBeNull()
  })

  it('NAS-16 存的是候选的网卡名或地址：没有「找不到」，选中那块网卡', async () => {
    await mount(onEth1Of())
    expect(scopeOptions().map(([, text]) => text)).not.toContain('eth1 (not found)')
    expect(scopeOptions()).toHaveLength(3)
    expect(scopeSelect()!.value).toBe('eth1')

    act(() => root.unmount())
    root = createRoot(container)
    await mount(onEth1Of({ lanInterface: '192.168.50.10' }))
    expect(scopeOptions()).toStrictEqual([
      ['', 'All networks'],
      ['eth0', 'eth0 · 10.0.0.5/24'],
      ['eth1', 'eth1 · 192.168.50.10/24']
    ])
    expect(scopeOptions().some(([, text]) => text.includes('(not found)'))).toBe(false)
    expect(scopeSelect()!.value).toBe('eth1')
    expect(scope()).toBe('192.168.50.10')
  })

  it('NAS-17 无头：没有 select，只显示网卡名与说明；从不调 setLanInterface', async () => {
    await mount(onEth1Of({ headless: true }))
    expect(scopeSelect()).toBeNull()
    expect(textOf('[data-network-lan-scope]')).toBe('eth1')
    expect(textOf('[data-network-headless-scope]')).toBe(tr('settings.networkHeadlessScopeNote'))
    expect($('[data-network-lan-only]')).toBeNull()
    expect(network.setLanInterface).not.toHaveBeenCalled()

    act(() => root.unmount())
    root = createRoot(container)
    await mount(sharedOf({ headless: true }))
    expect(scopeSelect()).toBeNull()
    expect(scope()).toBe('all')
    expect(textOf('[data-network-lan-scope]')).toBe('All networks')
    expect(textOf('[data-network-headless-scope]')).toBe(tr('settings.networkHeadlessScopeNote'))
    expect(network.setLanInterface).not.toHaveBeenCalled()
  })

  it('NAS-18 setLanInterface 拒绝 → 重新拉 status，select 跟着拉回来的值', async () => {
    await mount(sharedOf())
    expect(network.status).toHaveBeenCalledTimes(1)
    network.setLanInterface.mockRejectedValueOnce(new Error('boom'))
    network.status.mockResolvedValue(
      sharedOf({
        lanInterface: 'eth0',
        lanNetwork: CANDS[0],
        bindAddress: '10.0.0.5',
        addresses: [`http://10.0.0.5:${P}`]
      })
    )
    await chooseScope('eth1')
    expect(network.setLanInterface).toHaveBeenCalledWith('eth1')
    expect(network.status).toHaveBeenCalledTimes(2)
    expect(scopeSelect()!.value).toBe('eth0')
    expect(scope()).toBe('eth0')
  })
})

describe('NAS-19 开放给的文案', () => {
  it('NAS-19 en/zh/ja 都非空、占位符齐全；钉住 en 原文', () => {
    const keys = [
      'networkLanScope',
      'networkLanScopeAll',
      'networkLanScopeMissing',
      'networkLanScopeOnly',
      'networkHeadlessScopeNote',
      'networkErrorNoInterface'
    ]
    for (const lang of ['en', 'zh', 'ja'] as const) {
      for (const key of keys) {
        const text = raw(lang, key)
        expect(typeof text, `${lang}.${key}`).toBe('string')
        expect((text as string).trim().length, `${lang}.${key}`).toBeGreaterThan(0)
      }
      expect(raw(lang, 'networkLanScopeMissing'), lang).toContain('{{name}}')
      expect(raw(lang, 'networkErrorNoInterface'), lang).toContain('{{name}}')
      expect(raw(lang, 'networkLanScopeOnly'), lang).toContain('{{cidr}}')
      expect(raw(lang, 'networkHeadlessScopeNote'), lang).toContain('--bind')
    }
    expect(raw('en', 'networkLanScope')).toBe('Share on')
    expect(raw('en', 'networkLanScopeAll')).toBe('All networks')
    expect(raw('en', 'networkLanScopeMissing')).toBe('{{name}} (not found)')
    expect(raw('en', 'networkLanScopeOnly')).toBe('Only devices in {{cidr}} can connect.')
    expect(raw('en', 'networkHeadlessScopeNote')).toBe(
      'Chosen at startup (--bind); restart ShuviX to change it.'
    )
    expect(raw('en', 'networkErrorNoInterface')).toBe(
      'This computer has no network interface or address "{{name}}". Choose another network.'
    )
  })
})
