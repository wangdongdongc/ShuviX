// @vitest-environment jsdom
/**
 * web_search 的搜索方式（WebSearchSettings，设置 → LLM 工具 → web_search 子页，2026-11-16）：三行单选 —— 内置浏览器
 * （缺省）、Tavily、Exa。选哪个就用哪个，没有密钥的那家也选得上（行下面说搜索会失败）。密钥只进不出：只在选中的
 * 那一行里填，存下之后界面只有「存没存」和末四位。
 *
 *   WU-1..6    渲染：读不到配置就不画；三行、单选状态、浏览器行的搜索引擎与设置入口、各种密钥状态
 *   WU-7..11   选：写 `webSearch.provider`、点已选的不写、换行清掉草稿、没密钥也选得上、写失败退回并报错
 *   WU-12..18  存 / 删密钥：去空白、回车、界面里没有明文、失败的提示、删除、删除失败
 *   WU-19..25  测试：进行中、成功、失败、通道断了、结果按行分开、存新密钥清掉旧结果、全程不露密钥
 *   WU-26      ToolSettings：web_search 子页挂它，bash 挂沙箱开关，别的不挂
 *
 * `window.api` 是浏览器窗口 DOM 单测共用的假件（browserDomSupport），这里补上 `webSearch`；真 en 文案。
 * 密钥是运行时拼出来的假值。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { isValidElement, type ReactElement } from 'react'
import type { WebSearchConfig, WebSearchTestResult } from '../../../../../shared/webSearchProviders'

const captured = vi.hoisted(() => ({
  props: null as null | { renderToolExtra?: (toolName: string) => unknown }
}))

vi.mock('@shuvix/app-shell', () => ({
  BuiltinToolsView: (props: { renderToolExtra?: (toolName: string) => unknown }) => {
    captured.props = props
    return null
  }
}))

import { WebSearchSettings } from '../WebSearchSettings'
import { SandboxSettings } from '../SandboxSettings'
import { ToolSettings } from '../ToolSettings'
import {
  click,
  flush,
  initEnI18n,
  installFakeApi,
  keyDown,
  mountInto,
  typeInto,
  type FakeApi,
  type Mounted
} from '../../browser/__tests__/browserDomSupport'

const KEY = ['tvly', 'SECRETSECRET', '1234'].join('-')

type Provider = WebSearchConfig['provider']
interface WebSearchApi {
  config: Mock<() => Promise<WebSearchConfig>>
  setKey: Mock<(params: { provider: string; apiKey: string }) => Promise<WebSearchConfig>>
  deleteKey: Mock<(provider: string) => Promise<WebSearchConfig>>
  test: Mock<(provider: string) => Promise<WebSearchTestResult>>
}

let api: FakeApi
let ws: WebSearchApi
let m: Mounted | null = null

const NO_KEY = { saved: false, last4: '' }
const cfg = (over: Partial<WebSearchConfig> = {}): WebSearchConfig => ({
  provider: 'browser',
  browserEngine: 'Google',
  keys: { tavily: NO_KEY, exa: NO_KEY },
  ...over
})
const saved = (last4 = '1234'): { saved: boolean; last4: string } => ({ saved: true, last4 })

const $ = <T extends Element = HTMLElement>(sel: string): T | null =>
  m!.container.querySelector<T>(sel)
const row = (id: Provider): HTMLElement => $(`[data-web-search-option="${id}"]`)!
const inRow = <T extends Element = HTMLElement>(id: Provider, sel: string): T | null =>
  row(id).querySelector<T>(sel)
const radio = (id: Provider): HTMLButtonElement => inRow<HTMLButtonElement>(id, '[role="radio"]')!
const checked = (): string[] =>
  (['browser', 'tavily', 'exa'] as Provider[]).filter(
    (id) => radio(id).getAttribute('aria-checked') === 'true'
  )
const input = (id: Provider): HTMLInputElement | null =>
  inRow<HTMLInputElement>(id, '[data-web-search-key-input]')
const saveButton = (id: Provider): HTMLButtonElement | null =>
  inRow<HTMLButtonElement>(id, '[data-web-search-save-key]')
const testButton = (id: Provider): HTMLButtonElement | null =>
  inRow<HTMLButtonElement>(id, '[data-web-search-test]')
const deleteButton = (id: Provider): HTMLButtonElement | null =>
  inRow<HTMLButtonElement>(id, '[data-web-search-delete-key]')
const status = (id: Provider): string | null =>
  inRow(id, '[data-web-search-status]')?.textContent?.trim() ?? null
const keyState = (id: Provider): string | null =>
  inRow(id, '[data-web-search-key-state]')?.textContent?.trim() ?? null

/** 页面上任何地方都没有这把密钥（文字、属性、输入框的值） */
function expectNoKeyInDom(): void {
  expect(document.body.innerHTML).not.toContain(KEY)
  for (const el of document.body.querySelectorAll('input')) expect(el.value).not.toContain(KEY)
}

async function mount(config: WebSearchConfig): Promise<void> {
  ws.config.mockResolvedValue(config)
  m = await mountInto(WebSearchSettings, {})
  await flush()
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const unhandled: unknown[] = []
const onUnhandled = (reason: unknown): void => void unhandled.push(reason)

beforeAll(async () => {
  await initEnI18n()
})

beforeEach(() => {
  api = installFakeApi()
  ws = {
    config: vi.fn(async () => cfg()),
    setKey: vi.fn(async () => cfg()),
    deleteKey: vi.fn(async () => cfg()),
    test: vi.fn(async () => ({ ok: true, count: 1, ms: 1 }) as WebSearchTestResult)
  }
  ;(api as unknown as { webSearch: WebSearchApi }).webSearch = ws
  captured.props = null
  unhandled.length = 0
  process.on('unhandledRejection', onUnhandled)
})

afterEach(async () => {
  await flush()
  m?.unmount()
  m = null
  process.off('unhandledRejection', onUnhandled)
  expect(unhandled).toEqual([])
})

describe('渲染', () => {
  it('WU-1 配置还没回来 / 读不到：什么都不画，也不抛', async () => {
    ws.config.mockReturnValue(new Promise(() => {}))
    m = await mountInto(WebSearchSettings, {})
    await flush()
    expect($('[data-web-search-settings]')).toBeNull()
    expect(m.container.textContent).toBe('')
    m.unmount()

    ws.config.mockRejectedValue(new Error('disconnected'))
    m = await mountInto(WebSearchSettings, {})
    await flush()
    expect($('[data-web-search-settings]')).toBeNull()
    expect(ws.config).toHaveBeenCalledTimes(2)
  })

  it('WU-2 浏览器（缺省）：三行单选，浏览器行写着搜索引擎并带设置入口，另两行「No key saved」', async () => {
    await mount(cfg())
    expect($('[data-web-search-settings]')).not.toBeNull()
    const rows = [...m!.container.querySelectorAll('[data-web-search-option]')]
    expect(rows.map((r) => r.getAttribute('data-web-search-option'))).toEqual([
      'browser',
      'tavily',
      'exa'
    ])
    const group = $('[role="radiogroup"]')
    expect(group?.getAttribute('aria-label')).toBe('Search method')
    expect(group!.querySelectorAll('[role="radio"]')).toHaveLength(3)
    expect(checked()).toEqual(['browser'])

    expect(row('browser').textContent).toContain('Browser')
    expect(row('browser').textContent).toContain('Google · searches in the in-app browser')
    const link = [...row('browser').querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Browser settings'
    )
    expect(link).toBeDefined()
    click(link!)
    expect(api.browserView.openSettings).toHaveBeenCalledTimes(1)
    expect(api.settings.set).not.toHaveBeenCalled()

    expect(row('tavily').textContent).toContain('Tavily')
    expect(row('exa').textContent).toContain('Exa')
    expect(keyState('tavily')).toBe('No key saved')
    expect(keyState('exa')).toBe('No key saved')
    expect($('input')).toBeNull()
    expect($('[data-web-search-status]')).toBeNull()
  })

  it('WU-3 没选中的行只说密钥存没存（末四位），没有测试 / 删除 / 输入框', async () => {
    await mount(cfg({ keys: { tavily: saved(), exa: NO_KEY } }))
    expect(keyState('tavily')).toBe('Saved ••••1234')
    expect(row('tavily').hasAttribute('data-selected')).toBe(false)
    expect(testButton('tavily')).toBeNull()
    expect(deleteButton('tavily')).toBeNull()
    expect(input('tavily')).toBeNull()
  })

  it('WU-4 选中而没有密钥：密码框 + Save（空着不能点）+ 一句「搜索会失败」；浏览器行没有设置入口', async () => {
    await mount(cfg({ provider: 'tavily' }))
    expect(checked()).toEqual(['tavily'])
    expect(row('tavily').hasAttribute('data-selected')).toBe(true)
    const field = input('tavily')!
    expect(field.type).toBe('password')
    expect(field.getAttribute('autocomplete')).toBe('off')
    expect(field.getAttribute('placeholder')).toBe('Paste the Tavily API key')
    expect(field.getAttribute('aria-label')).toBe('Paste the Tavily API key')
    expect(saveButton('tavily')!.textContent?.trim()).toBe('Save')
    expect(saveButton('tavily')!.disabled).toBe(true)
    typeInto(field, '   ')
    expect(saveButton('tavily')!.disabled).toBe(true)
    typeInto(field, 'x')
    expect(saveButton('tavily')!.disabled).toBe(false)
    expect(status('tavily')).toBe('No key: searches will fail')
    expect(testButton('tavily')).toBeNull()
    expect(deleteButton('tavily')).toBeNull()

    expect(row('browser').textContent).not.toContain('Browser settings')
    expect(keyState('exa')).toBe('No key saved')
    expect(input('exa')).toBeNull()
    expect(status('exa')).toBeNull()
  })

  it('WU-5 选中且存了密钥：遮住的末四位、Test、删除（有名字）；没有输入框、没有 Save、没有警告', async () => {
    await mount(cfg({ provider: 'tavily', keys: { tavily: saved(), exa: NO_KEY } }))
    expect(keyState('tavily')).toMatch(/^•+1234$/)
    expect(testButton('tavily')!.textContent?.trim()).toBe('Test')
    expect(testButton('tavily')!.disabled).toBe(false)
    expect(deleteButton('tavily')!.getAttribute('aria-label')).toBe('Delete key')
    expect(deleteButton('tavily')!.getAttribute('title')).toBe('Delete key')
    expect(input('tavily')).toBeNull()
    expect(saveButton('tavily')).toBeNull()
    expect(status('tavily')).toBeNull()
  })

  it('WU-6 短密钥（末四位不露）：只有遮罩，照样能测试和删除', async () => {
    await mount(cfg({ provider: 'exa', keys: { tavily: NO_KEY, exa: saved('') } }))
    expect(keyState('exa')).toMatch(/^•+$/)
    expect(testButton('exa')).not.toBeNull()
    expect(deleteButton('exa')).not.toBeNull()
  })
})

describe('选', () => {
  it('WU-7 点 Tavily：写 webSearch.provider = tavily 一次，行当场换过去；不碰密钥通道', async () => {
    await mount(cfg())
    click(radio('tavily'))
    expect(api.settings.set).toHaveBeenCalledTimes(1)
    expect(api.settings.set).toHaveBeenCalledWith({ key: 'webSearch.provider', value: 'tavily' })
    expect(checked()).toEqual(['tavily'])
    expect(input('tavily')).not.toBeNull()
    expect(ws.setKey).not.toHaveBeenCalled()
    expect(ws.deleteKey).not.toHaveBeenCalled()
    expect(ws.test).not.toHaveBeenCalled()
    await flush()
    expect(checked()).toEqual(['tavily'])
  })

  it('WU-8 点已经选中的那一项：不写', async () => {
    await mount(cfg({ provider: 'exa' }))
    click(radio('exa'))
    expect(api.settings.set).not.toHaveBeenCalled()
    expect(checked()).toEqual(['exa'])
  })

  it('WU-9 填了一半换到另一家再换回来：草稿没了，不会跑到别家的行里', async () => {
    await mount(cfg({ provider: 'tavily' }))
    typeInto(input('tavily')!, 'half-typed')
    click(radio('exa'))
    expect(input('exa')!.value).toBe('')
    expect(input('tavily')).toBeNull()
    click(radio('tavily'))
    expect(input('tavily')!.value).toBe('')
    expect(api.settings.set.mock.calls.map((c) => (c[0] as { value: string }).value)).toEqual([
      'exa',
      'tavily'
    ])
  })

  it('WU-10 没有密钥的那家也选得上，行下面说搜索会失败', async () => {
    await mount(cfg())
    click(radio('exa'))
    await flush()
    expect(checked()).toEqual(['exa'])
    expect(status('exa')).toBe('No key: searches will fail')
    expect(api.settings.set).toHaveBeenCalledWith({ key: 'webSearch.provider', value: 'exa' })
  })

  it('WU-11 设置没写进去：选中项退回原来那一个，不留未处理的拒绝', async () => {
    await mount(cfg())
    api.settings.set.mockRejectedValue(new Error('disconnected'))
    click(radio('tavily'))
    expect(checked()).toEqual(['tavily'])
    await flush()
    expect(checked()).toEqual(['browser'])
    expect(input('tavily')).toBeNull()
  })

  it('WU-11 原来选的是一家 API：退回它，并在它的行下面报出原因', async () => {
    await mount(cfg({ provider: 'tavily', keys: { tavily: saved(), exa: NO_KEY } }))
    api.settings.set.mockRejectedValue(new Error('disconnected'))
    click(radio('exa'))
    await flush()
    expect(checked()).toEqual(['tavily'])
    expect(status('tavily')).toBe('disconnected')
    expect(status('exa')).toBeNull()
  })
})

describe('存 / 删密钥', () => {
  const afterSave = cfg({ provider: 'tavily', keys: { tavily: saved(), exa: NO_KEY } })

  it('WU-12 填好点 Save：setKey(去掉空白的密钥) 一次；之后是遮住的末四位 + Test + 删除，警告没了', async () => {
    await mount(cfg({ provider: 'tavily' }))
    ws.setKey.mockResolvedValue(afterSave)
    typeInto(input('tavily')!, `  ${KEY} `)
    click(saveButton('tavily')!)
    await flush()
    expect(ws.setKey).toHaveBeenCalledTimes(1)
    expect(ws.setKey).toHaveBeenCalledWith({ provider: 'tavily', apiKey: KEY })
    expect(input('tavily')).toBeNull()
    expect(keyState('tavily')).toMatch(/^•+1234$/)
    expect(testButton('tavily')).not.toBeNull()
    expect(deleteButton('tavily')).not.toBeNull()
    expect(status('tavily')).toBeNull()
    // WU-14 存下之后界面里没有明文
    expectNoKeyInDom()
    expect(api.settings.set).not.toHaveBeenCalled()
  })

  it('WU-13 在输入框里按回车也是存；空着 / 只有空白时回车什么都不做', async () => {
    await mount(cfg({ provider: 'tavily' }))
    ws.setKey.mockResolvedValue(afterSave)
    keyDown(input('tavily')!, 'Enter')
    typeInto(input('tavily')!, '   ')
    keyDown(input('tavily')!, 'Enter')
    expect(ws.setKey).not.toHaveBeenCalled()

    typeInto(input('tavily')!, KEY)
    keyDown(input('tavily')!, 'a')
    expect(ws.setKey).not.toHaveBeenCalled()
    keyDown(input('tavily')!, 'Enter')
    await flush()
    expect(ws.setKey).toHaveBeenCalledTimes(1)
    expect(ws.setKey).toHaveBeenCalledWith({ provider: 'tavily', apiKey: KEY })
    expect(keyState('tavily')).toMatch(/^•+1234$/)
    expectNoKeyInDom()
  })

  it('WU-15 存失败：原因写在这一行下面（取代警告），输入框和草稿都留着；再存成功就清掉', async () => {
    await mount(cfg({ provider: 'tavily' }))
    ws.setKey.mockRejectedValueOnce(new Error('The API key is empty'))
    typeInto(input('tavily')!, 'draft-value')
    click(saveButton('tavily')!)
    await flush()
    expect(status('tavily')).toBe('The API key is empty')
    expect(inRow('tavily', '[data-web-search-status] .text-error')).not.toBeNull()
    expect(input('tavily')!.value).toBe('draft-value')

    ws.setKey.mockResolvedValue(afterSave)
    typeInto(input('tavily')!, KEY)
    click(saveButton('tavily')!)
    await flush()
    expect(status('tavily')).toBeNull()
    expect(keyState('tavily')).toMatch(/^•+1234$/)
  })

  it('WU-16 存失败的提示：换到另一家再换回来就没了', async () => {
    await mount(cfg({ provider: 'tavily' }))
    ws.setKey.mockRejectedValue(new Error('The API key is empty'))
    typeInto(input('tavily')!, 'draft-value')
    click(saveButton('tavily')!)
    await flush()
    expect(status('tavily')).toBe('The API key is empty')
    click(radio('exa'))
    expect(status('exa')).toBe('No key: searches will fail')
    click(radio('tavily'))
    expect(status('tavily')).toBe('No key: searches will fail')
  })

  it('WU-17 删除：deleteKey(这一家) 一次；行回到输入框 + Save + 警告，之前的测试结果没了', async () => {
    await mount(afterSave)
    ws.test.mockResolvedValue({ ok: true, count: 5, ms: 1234 })
    click(testButton('tavily')!)
    await flush()
    expect(status('tavily')).toContain('Works')

    ws.deleteKey.mockResolvedValue(cfg({ provider: 'tavily' }))
    click(deleteButton('tavily')!)
    await flush()
    expect(ws.deleteKey).toHaveBeenCalledTimes(1)
    expect(ws.deleteKey).toHaveBeenCalledWith('tavily')
    expect(input('tavily')).not.toBeNull()
    expect(input('tavily')!.value).toBe('')
    expect(saveButton('tavily')).not.toBeNull()
    expect(status('tavily')).toBe('No key: searches will fail')
    expect(testButton('tavily')).toBeNull()
  })

  it('WU-18 删除失败：行原样，原因写在下面，不留未处理的拒绝', async () => {
    await mount(afterSave)
    ws.deleteKey.mockRejectedValue(new Error('disconnected'))
    click(deleteButton('tavily')!)
    await flush()
    expect(keyState('tavily')).toMatch(/^•+1234$/)
    expect(testButton('tavily')).not.toBeNull()
    expect(deleteButton('tavily')).not.toBeNull()
    expect(input('tavily')).toBeNull()
    expect(status('tavily')).toBe('disconnected')
  })
})

describe('测试', () => {
  const withKey = cfg({ provider: 'tavily', keys: { tavily: saved(), exa: saved('9876') } })

  it('WU-19 / WU-20 进行中按钮是「Testing…」且点不了；成功 → 「Works · 5 results · 1.2 s」', async () => {
    await mount(withKey)
    const pending = deferred<WebSearchTestResult>()
    ws.test.mockReturnValue(pending.promise)
    click(testButton('tavily')!)
    expect(ws.test).toHaveBeenCalledTimes(1)
    expect(ws.test).toHaveBeenCalledWith('tavily')
    expect(testButton('tavily')!.textContent?.trim()).toBe('Testing…')
    expect(testButton('tavily')!.disabled).toBe(true)
    click(testButton('tavily')!)
    expect(ws.test).toHaveBeenCalledTimes(1)
    expect(status('tavily')).toBeNull()

    pending.resolve({ ok: true, count: 5, ms: 1234 })
    await flush()
    expect(status('tavily')).toBe('Works · 5 results · 1.2 s')
    expect(inRow('tavily', '[data-web-search-status] .text-success')).not.toBeNull()
    expect(testButton('tavily')!.textContent?.trim()).toBe('Test')
    expect(testButton('tavily')!.disabled).toBe(false)
  })

  it('WU-21 失败：原因原样写在行下面，界面不添别的话', async () => {
    await mount(withKey)
    ws.test.mockResolvedValue({ ok: false, error: 'Tavily rejected the API key (401).' })
    click(testButton('tavily')!)
    await flush()
    expect(status('tavily')).toBe('Tavily rejected the API key (401).')
    expect(inRow('tavily', '[data-web-search-status] .text-error')).not.toBeNull()
    expect(m!.container.textContent).not.toContain('Tell the user')
    expect(testButton('tavily')!.disabled).toBe(false)
  })

  it('WU-22 通道断了（test 被拒）：也是一行错误，不留未处理的拒绝', async () => {
    await mount(withKey)
    ws.test.mockRejectedValue(new Error('disconnected'))
    click(testButton('tavily')!)
    await flush()
    expect(status('tavily')).toBe('disconnected')
    expect(testButton('tavily')!.textContent?.trim()).toBe('Test')
  })

  it('WU-23 结果按行分开：Tavily 的结果不出现在 Exa 那一行', async () => {
    await mount(withKey)
    ws.test.mockResolvedValue({ ok: false, error: 'Tavily is rate limiting requests (429).' })
    click(testButton('tavily')!)
    await flush()
    expect(status('tavily')).toContain('429')
    click(radio('exa'))
    expect(status('exa')).toBeNull()
    expect(status('tavily')).toBeNull()
    expect(m!.container.textContent).not.toContain('429')
  })

  it('WU-24 测试失败之后删掉、存一把新的：旧结果清掉', async () => {
    await mount(withKey)
    ws.test.mockResolvedValue({ ok: false, error: 'Tavily rejected the API key (401).' })
    click(testButton('tavily')!)
    await flush()
    expect(status('tavily')).toContain('401')

    ws.deleteKey.mockResolvedValue(
      cfg({ provider: 'tavily', keys: { tavily: NO_KEY, exa: saved('9876') } })
    )
    click(deleteButton('tavily')!)
    await flush()
    ws.setKey.mockResolvedValue(withKey)
    typeInto(input('tavily')!, KEY)
    click(saveButton('tavily')!)
    await flush()
    expect(status('tavily')).toBeNull()
    expect(m!.container.textContent).not.toContain('401')
  })

  it('WU-25 一整套（存 → 测试成功 → 测试失败 → 删除）：存下之后页面里没有密钥，它只经 webSearch.setKey 走', async () => {
    await mount(cfg())
    click(radio('tavily'))
    ws.setKey.mockResolvedValue(cfg({ provider: 'tavily', keys: { tavily: saved(), exa: NO_KEY } }))
    typeInto(input('tavily')!, KEY)
    click(saveButton('tavily')!)
    await flush()
    expectNoKeyInDom()

    ws.test.mockResolvedValueOnce({ ok: true, count: 3, ms: 400 })
    click(testButton('tavily')!)
    await flush()
    expect(status('tavily')).toBe('Works · 3 results · 0.4 s')
    expectNoKeyInDom()

    ws.test.mockResolvedValueOnce({ ok: false, error: 'Tavily answered 500.' })
    click(testButton('tavily')!)
    await flush()
    expect(status('tavily')).toBe('Tavily answered 500.')
    expectNoKeyInDom()

    ws.deleteKey.mockResolvedValue(cfg({ provider: 'tavily' }))
    click(deleteButton('tavily')!)
    await flush()
    expectNoKeyInDom()

    expect(ws.setKey).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(api.settings.set.mock.calls)).not.toContain(KEY)
    expect(JSON.stringify(ws.test.mock.calls)).not.toContain(KEY)
    expect(JSON.stringify(ws.deleteKey.mock.calls)).not.toContain(KEY)
    expect(api.settings.set.mock.calls).toEqual([[{ key: 'webSearch.provider', value: 'tavily' }]])
  })
})

describe('挂在哪', () => {
  it('WU-26 ToolSettings：web_search 子页挂 WebSearchSettings，bash 挂 SandboxSettings，别的不挂', async () => {
    m = await mountInto(ToolSettings, {})
    const render = captured.props?.renderToolExtra
    expect(render).toBeTypeOf('function')

    const webSearch = render!('web_search')
    expect(isValidElement(webSearch)).toBe(true)
    expect((webSearch as ReactElement).type).toBe(WebSearchSettings)

    const bash = render!('bash')
    expect(isValidElement(bash)).toBe(true)
    expect((bash as ReactElement).type).toBe(SandboxSettings)

    for (const name of ['read', 'web_fetch', 'webSearch', 'WEB_SEARCH', '']) {
      expect(render!(name), name).toBeNull()
    }
    expect(ws.config).not.toHaveBeenCalled()
  })
})
