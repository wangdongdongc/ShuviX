// @vitest-environment jsdom
/**
 * McpClientPanel（MCP 设置页，桌面与扩展共用）DOM 测试（jsdom）—— 这一轮加进来的两件事：
 *
 *   - **行的附加区** `renderServerExtra`：宿主给某台 server 的附加设置（桌面：内置 browser 的
 *     站点数据 / 证书处理）画在那一行展开区里、工具列表之后，包在 `[data-mcp-server-extra=<name>]`
 *     里。内置 browser 在设置页里恒是「未启动」（它按会话实例化，设置页从不连它），工具列表为空 ——
 *     附加区不能因此不画；返回假值（null / false / '' / 0）就什么也不画，也不漏出一个「0」；
 *   - **保存失败要说清楚**：宿主拒绝保存（名字撞了、含 `__` …）时对话框不关，
 *     `[data-mcp-dialog-error]` 显示宿主给的原因；没给原因显示通用的「保存失败」；
 *     编辑失败时后面那次「顺手启用」的 update 不发。
 *
 * 面板每 3 秒轮询一次列表 —— 用例都在一次事件循环的量级里跑完，afterEach 卸载时定时器随之清掉。
 * 包入口 `@shuvix/chat-ui` 顶掉，只留 `useDialogClose`（改成立即关闭，不等退场动画）。
 * 文件是 `.ts`（app-shell 的单测只收 `*.test.ts`），所以不写 JSX，一律 createElement。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import type { McpServerInfo, McpToolInfo } from '@shuvix/chat-protocol/types/mcp'

vi.mock('@shuvix/chat-ui', () => ({
  useDialogClose: (onClose: () => void) => ({ closing: false, handleClose: onClose })
}))

import { McpClientPanel, type McpApi, type McpClientPanelProps } from './McpClientPanel'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const row = (over: Partial<McpServerInfo>): McpServerInfo => ({
  id: 'x',
  name: 'x',
  type: 'http',
  command: '',
  args: '[]',
  env: '{}',
  url: '',
  headers: '{}',
  metadata: '{}',
  isEnabled: 1,
  isBuiltin: 0,
  cachedTools: '[]',
  createdAt: 1,
  updatedAt: 1,
  status: 'disconnected',
  toolCount: 0,
  ...over
})

/** 内置 browser：inproc、设置页里恒「未启动」、没有工具 */
const BROWSER = row({ id: 'builtin-mcp-browser', name: 'browser', type: 'inproc', isBuiltin: 1 })
/** 用户自己加的一台，已连上 */
const TAVILY = row({
  id: 'mcp-tavily',
  name: 'tavily',
  url: 'https://mcp.tavily.example/mcp',
  status: 'connected',
  toolCount: 1,
  createdAt: 0
})
/** 一台内置的 http server：停用着、env 待填（「填齐即启用」那条路径） */
const BUILTIN_HTTP = row({
  id: 'builtin-mcp-search',
  name: 'search',
  url: 'https://search.example/mcp',
  env: '{"API_KEY":""}',
  isEnabled: 0,
  isBuiltin: 1,
  createdAt: 2
})

const tool = (serverId: string, name: string): McpToolInfo => ({
  name,
  label: name.split('__').pop() ?? name,
  description: `${name} description`,
  group: `mcp:${serverId}`,
  serverId,
  serverStatus: 'connected'
})

let container: HTMLDivElement
let root: Root
let servers: McpServerInfo[]
let toolsById: Record<string, McpToolInfo[]>
let api: { [K in keyof McpApi]: ReturnType<typeof vi.fn> }

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function renderPanel(props: Partial<McpClientPanelProps> = {}): Promise<void> {
  await act(async () => {
    root.render(createElement(McpClientPanel, { api: api as unknown as McpApi, ...props }))
  })
  await flush()
}

const serverRow = (name: string): HTMLElement => {
  const el = container.querySelector<HTMLElement>(`[data-mcp-server="${name}"]`)
  if (!el) throw new Error(`server row ${name} not rendered`)
  return el
}
/** 行首的展开 / 收起按钮 */
async function toggle(name: string): Promise<void> {
  await act(async () => {
    ;(serverRow(name).querySelector('button') as HTMLButtonElement).click()
  })
  await flush()
}
const extraOf = (name: string): HTMLElement | null =>
  container.querySelector<HTMLElement>(`[data-mcp-server-extra="${name}"]`)
/** 展开区 = 行里头部之后的最后一块（没展开时是头部本身） */
const expandedArea = (name: string): HTMLElement => serverRow(name).lastElementChild as HTMLElement

const buttonByText = (text: string): HTMLButtonElement => {
  const hit = [...container.querySelectorAll('button')].find(
    (b) => (b.textContent ?? '').trim() === text
  )
  if (!hit) throw new Error(`button "${text}" not rendered`)
  return hit
}
async function click(button: HTMLElement): Promise<void> {
  await act(async () => {
    button.click()
  })
  await flush()
}

/** 受控 input 赋值：走原生 setter 再派发 input 事件，React 的 onChange 才收得到 */
async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const inputByPlaceholder = (placeholder: string): HTMLInputElement => {
  const el = container.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`)
  if (!el) throw new Error(`input "${placeholder}" not rendered`)
  return el
}

const dialogError = (): string | null =>
  container.querySelector('[data-mcp-dialog-error]')?.textContent ?? null
/** 对话框面板（设置区块自己也有 h3 标题，所以先圈出对话框再找标题）；没开 → null */
const dialogTitle = (): string | null =>
  container.querySelector('.dialog-panel')?.querySelector('h3')?.textContent ?? null

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'zh',
    resources: { zh: { translation: zh } },
    showSupportNotice: false
  })
})

beforeEach(() => {
  servers = [TAVILY, BROWSER]
  toolsById = { [TAVILY.id]: [tool(TAVILY.id, 'mcp__tavily__search')], [BROWSER.id]: [] }
  api = {
    list: vi.fn(async () => servers),
    add: vi.fn(async () => ({ success: true })),
    update: vi.fn(async () => ({ success: true })),
    delete: vi.fn(async () => ({ success: true })),
    connect: vi.fn(async () => ({ success: true })),
    disconnect: vi.fn(async () => ({ success: true })),
    getTools: vi.fn(async (id: string) => toolsById[id] ?? [])
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

/** 桌面那种用法：只给内置 browser 一块附加区 */
const browserExtra = (s: McpServerInfo): ReactNode =>
  s.isBuiltin === 1 && s.name === 'browser'
    ? createElement('div', { 'data-probe': 'browser-extra' }, 'Site data')
    : null

describe('renderServerExtra —— 行展开区里的宿主附加设置', () => {
  it('E-1 不传 renderServerExtra：展开哪一行都没有附加区', async () => {
    await renderPanel()
    await toggle('browser')
    await toggle('tavily')
    expect(container.querySelector('[data-mcp-server-extra]')).toBeNull()
  })

  it('E-2 给内置 browser 返回一块：展开后出现在 [data-mcp-server-extra="browser"] 里，排在工具列表之后', async () => {
    toolsById[BROWSER.id] = [tool(BROWSER.id, 'mcp__browser__click')]
    await renderPanel({ renderServerExtra: browserExtra })
    // 收着时不画
    expect(extraOf('browser')).toBeNull()

    await toggle('browser')
    const extra = extraOf('browser')
    expect(extra).not.toBeNull()
    expect(extra!.querySelector('[data-probe="browser-extra"]')?.textContent).toBe('Site data')
    // 在工具列表之后：工具名那一格在附加区前面
    const toolName = [...serverRow('browser').querySelectorAll('span')].find(
      (s) => s.textContent === 'click'
    )
    expect(toolName, '工具列表应当渲染出 click').toBeDefined()
    expect(toolName!.compareDocumentPosition(extra!) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
    // 别的行（返回 null 的）展开也没有
    await toggle('tavily')
    expect(extraOf('tavily')).toBeNull()
  })

  it('E-3 内置 browser 未启动、没有工具：附加区照画（设置页从不连它，工具列表恒空）', async () => {
    await renderPanel({ renderServerExtra: browserExtra })
    await toggle('browser')
    expect(api.getTools).toHaveBeenCalledWith(BROWSER.id)
    const area = expandedArea('browser')
    expect(area.textContent).toContain(i18n.t('settings.mcpStatusDisconnected'))
    const extra = extraOf('browser')
    expect(extra).not.toBeNull()
    expect(extra!.textContent).toBe('Site data')
  })

  it.each<[string, ReactNode]>([
    ['null', null],
    ['false', false],
    ["''", ''],
    ['0', 0]
  ])('E-4 返回 %s：不画附加区，展开区里也不漏出一个「0」', async (_label, value) => {
    await renderPanel({ renderServerExtra: () => value })
    await toggle('browser')
    expect(extraOf('browser')).toBeNull()
    // 展开区里只有状态那一句
    expect(expandedArea('browser').textContent).toBe(i18n.t('settings.mcpStatusDisconnected'))
  })

  it('E-5 只对展开的那一行调用、拿到的是那一行的 McpServerInfo；收起后附加区跟着消失', async () => {
    const spy = vi.fn(browserExtra)
    await renderPanel({ renderServerExtra: spy })
    expect(spy).not.toHaveBeenCalled()

    await toggle('browser')
    expect(spy).toHaveBeenCalled()
    for (const [arg] of spy.mock.calls) expect(arg).toEqual(BROWSER)

    await toggle('browser')
    expect(extraOf('browser')).toBeNull()
    spy.mockClear()

    await toggle('tavily')
    expect(spy).toHaveBeenCalled()
    for (const [arg] of spy.mock.calls) expect(arg).toEqual(TAVILY)
    expect(extraOf('tavily')).toBeNull()
  })
})

describe('保存失败 —— 对话框不关，原因写在按钮上方', () => {
  /** 打开「添加」对话框，填好名字与地址（扩展形态：只有 http） */
  async function openAddAndFill(name: string): Promise<void> {
    await renderPanel({ caps: { allowStdio: false } })
    await click(buttonByText(i18n.t('settings.mcpAdd')))
    expect(dialogTitle()).toBe(i18n.t('settings.mcpAddTitle'))
    await typeInto(inputByPlaceholder(i18n.t('settings.mcpNamePlaceholder')), name)
    await typeInto(
      inputByPlaceholder(i18n.t('settings.mcpUrlPlaceholder')),
      'https://x.example/mcp'
    )
  }

  it('E-6a 宿主给了原因（名字已被占用）：对话框留着，显示那句原因', async () => {
    api.add.mockResolvedValue({
      success: false,
      error: 'An MCP server named "browser" already exists'
    })
    await openAddAndFill('browser')
    await click(buttonByText(i18n.t('common.add')))
    expect(api.add).toHaveBeenCalledTimes(1)
    expect(api.add.mock.calls[0][0]).toMatchObject({
      name: 'browser',
      type: 'http',
      url: 'https://x.example/mcp'
    })
    expect(dialogTitle()).toBe(i18n.t('settings.mcpAddTitle'))
    expect(dialogError()).toBe('An MCP server named "browser" already exists')
  })

  it('E-6b 宿主没给原因：显示通用的「保存失败」', async () => {
    api.add.mockResolvedValue({ success: false })
    await openAddAndFill('dup')
    await click(buttonByText(i18n.t('common.add')))
    expect(dialogTitle()).toBe(i18n.t('settings.mcpAddTitle'))
    expect(dialogError()).toBe(i18n.t('settings.mcpSaveFailed'))
    expect(dialogError()).not.toBe('settings.mcpSaveFailed')
  })

  it('E-6c 保存成功：对话框关掉、列表重拉一次', async () => {
    await openAddAndFill('fresh')
    const listedBefore = api.list.mock.calls.length
    await click(buttonByText(i18n.t('common.add')))
    expect(api.add).toHaveBeenCalledTimes(1)
    expect(dialogTitle()).toBeNull()
    expect(dialogError()).toBeNull()
    expect(api.list.mock.calls.length).toBe(listedBefore + 1)
  })

  /** 编辑那台停用着的内置 http server，把 env 填齐（成功时会顺手发一次启用） */
  async function editBuiltinAndFillEnv(): Promise<void> {
    servers = [BUILTIN_HTTP, TAVILY, BROWSER]
    await renderPanel()
    const pencil = serverRow('search').querySelector('svg.lucide-pencil')?.closest('button')
    expect(pencil, '内置 http 行应当可以编辑').toBeTruthy()
    await click(pencil as HTMLButtonElement)
    expect(dialogTitle()).toBe(i18n.t('settings.mcpEditTitle'))
    await typeInto(inputByPlaceholder(i18n.t('settings.mcpEnvValuePlaceholder')), 'k-123')
  }

  it('E-6d 编辑失败：原因显示出来，后面那次 update({id, isEnabled:true}) 不发', async () => {
    api.update.mockResolvedValue({ success: false, error: 'nope' })
    await editBuiltinAndFillEnv()
    await click(buttonByText(i18n.t('common.save')))
    expect(api.update).toHaveBeenCalledTimes(1)
    expect(api.update.mock.calls[0][0]).toMatchObject({
      id: BUILTIN_HTTP.id,
      env: { API_KEY: 'k-123' }
    })
    expect(api.update).not.toHaveBeenCalledWith({ id: BUILTIN_HTTP.id, isEnabled: true })
    expect(dialogError()).toBe('nope')
    expect(dialogTitle()).toBe(i18n.t('settings.mcpEditTitle'))
  })

  it('E-6e 对照：编辑成功时那次启用照发（上一条的「不发」不是因为这条路径根本不走）', async () => {
    await editBuiltinAndFillEnv()
    await click(buttonByText(i18n.t('common.save')))
    expect(api.update).toHaveBeenCalledTimes(2)
    expect(api.update.mock.calls[1][0]).toEqual({ id: BUILTIN_HTTP.id, isEnabled: true })
    expect(dialogTitle()).toBeNull()
  })
})

describe('实验性质的内置 server（任务列表 plan）', () => {
  /** 内置 plan：inproc、设置页里恒「未启动」、没有工具 */
  const PLAN = row({ id: 'builtin-mcp-plan', name: 'plan', type: 'inproc', isBuiltin: 1 })
  /** 桌面 McpSettings 的形状：只给 browser / database / chrome 挂东西，别的内置行（plan）什么也不给 */
  const desktopExtra = (s: McpServerInfo): ReactNode =>
    s.isBuiltin === 1 && ['browser', 'database', 'chrome'].includes(s.name)
      ? createElement('div', { 'data-probe': `${s.name}-extra` }, s.name)
      : null
  const headerOf = (name: string): HTMLElement => serverRow(name).firstElementChild as HTMLElement
  const badgeOf = (name: string, text: string): HTMLElement | undefined =>
    [...headerOf(name).querySelectorAll<HTMLElement>('span')].find(
      (span) => span.textContent === text
    )

  it('MCP-X-1 内置 plan 行：「内置」徽标与 [data-experimental="taskList"] 都在，标签排在类型徽标之前', async () => {
    servers = [TAVILY, BROWSER, PLAN]
    toolsById[PLAN.id] = []
    await renderPanel()
    const builtin = badgeOf('plan', i18n.t('settings.mcpBuiltin'))
    const type = badgeOf('plan', 'inproc')
    const tag = headerOf('plan').querySelector<HTMLElement>('[data-experimental]')
    expect(builtin).toBeDefined()
    expect(type).toBeDefined()
    expect(tag).not.toBeNull()
    expect(tag!.getAttribute('data-experimental')).toBe('taskList')
    expect(tag!.textContent).toBe(i18n.t('experimental.tag'))
    expect(tag!.title).toBe(i18n.t('experimental.hint'))
    expect(builtin!.compareDocumentPosition(tag!) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
    expect(tag!.compareDocumentPosition(type!) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
    // 名字是界面文案、说明一行也在
    expect(headerOf('plan').textContent).toContain(i18n.t('tool.taskListLabel'))
    expect(headerOf('plan').querySelector('[data-mcp-hint]')?.textContent).toBe(
      i18n.t('tool.taskListHint')
    )
    expect(container.querySelectorAll('[data-experimental]')).toHaveLength(1)
  })

  it('MCP-X-2 不是内置的同名 plan 行、内置 browser 行都没有标签', async () => {
    servers = [BROWSER, row({ id: 'mcp-user-plan', name: 'plan', url: 'https://plan.example/mcp' })]
    await renderPanel()
    expect(headerOf('plan').querySelector('[data-experimental]')).toBeNull()
    expect(headerOf('browser').querySelector('[data-experimental]')).toBeNull()
    expect(container.querySelector('[data-experimental]')).toBeNull()
  })

  it('MCP-X-3 按桌面的接线展开 plan 行：没有附加区，展开区只有状态一句', async () => {
    servers = [BROWSER, PLAN]
    toolsById[PLAN.id] = []
    await renderPanel({ renderServerExtra: desktopExtra })
    await toggle('plan')
    expect(api.getTools).toHaveBeenCalledWith(PLAN.id)
    expect(extraOf('plan')).toBeNull()
    expect(container.querySelector('[data-mcp-server-extra]')).toBeNull()
    expect(expandedArea('plan').textContent).toBe(i18n.t('settings.mcpStatusDisconnected'))
  })
})
