// @vitest-environment jsdom
/**
 * 内置 MCP 能力服务器（browser / ssh）在对话流里的样子（jsdom）—— 宿主下发的呈现表里没有它们，
 * 于是 ToolCallBlock / StepGroup / AskForm 都经 chat-protocol 的 `fallbackToolPresentation` 兜底：
 *
 *   - 工具行：`mcp__browser__*` 显示「浏览器」+ Globe、`mcp__ssh__*` 显示「SSH」；折叠摘要照
 *     「动作 + 最有信息量的参数」；宿主表里有条目时宿主的赢；
 *   - ssh `exec` 展开成终端形态：主机名按**工具名**认（内置 ssh server 的 exec），所以命令还在跑、
 *     结果与 details 都没到时主机名也在；第三方 server 的同名工具不享受这一条；
 *   - 第三方 MCP 工具维持通用形态（原始工具名、扳手、参数 / 结果两块）；退役的 multiplex
 *     `browser` 工具的历史块照旧有名字与图标；
 *   - 步骤合并行：同为浏览器的不同动作 → 「浏览器 ×2」；同一动作 → 图标 + 「浏览器」；
 *   - 询问卡片：内置 MCP 工具的询问以工具名为标题；路径询问（`Read(…)`）不看呈现。
 *
 * 包入口 `@shuvix/chat-ui` 整个顶掉（AskForm 从入口取 getHostApi，入口会带上模块加载期就读
 * window.location 的 useSessionInit —— 同 toolPicker.dom.test.tsx）。i18n 走真 zh 资源。
 * 文件是 .tsx 但不写 JSX，一律 createElement（与同目录其它 DOM 用例一致）。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import type { AskInputRequest } from '@shuvix/chat-protocol/types/inputRequest'
import type { ToolResultDetails } from '@shuvix/chat-protocol/types/chatMessage'

vi.mock('@shuvix/chat-ui', () => ({ getHostApi: () => null }))

import { useChatStore } from '../../../stores/chatStore'
import { ToolCallBlock } from '../ToolCallBlock'
import { StepGroup } from '../StepGroup'
import { AskForm } from '../inputs/AskForm'
import type { StepBlock } from '../stepGrouping'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

/** jsdom 会把颜色规整成它自己的写法 —— 用同一个实现算出期望值，不手写 rgb() */
function cssColor(hex: string): string {
  const probe = document.createElement('span')
  probe.style.color = hex
  return probe.style.color
}

function render(element: ReturnType<typeof createElement>): void {
  act(() => {
    root.render(element)
  })
}

type ToolCallProps = Parameters<typeof ToolCallBlock>[0]
const renderTool = (props: ToolCallProps): void => render(createElement(ToolCallBlock, props))

/** 工具行（`data-tool-name` 是它在 DOM 上的语义锚点） */
const toolRow = (name: string): HTMLElement => {
  const el = container.querySelector<HTMLElement>(`[data-tool-name="${name}"]`)
  if (!el) throw new Error(`tool row ${name} not rendered`)
  return el
}
/** 摘要行按钮（StepRow） */
const stepButton = (scope: HTMLElement): HTMLButtonElement =>
  scope.querySelector('button') as HTMLButtonElement
const labelOf = (scope: HTMLElement): string | null =>
  stepButton(scope).querySelector('span.font-medium')?.textContent ?? null
const detailOf = (scope: HTMLElement): string | null =>
  stepButton(scope).querySelector('span.font-mono')?.textContent ?? null

function expand(scope: HTMLElement): void {
  act(() => {
    stepButton(scope).click()
  })
}

/** 终端形态的提示符行：`[位置] ❯ 命令`（没有终端形态 → null） */
function terminalPrompt(): HTMLElement | null {
  const caret = [...container.querySelectorAll('span')].find((s) => s.textContent === '❯')
  return caret?.parentElement ?? null
}
/** 提示符行里的位置（主机名 / cwd）—— 带 title 的那个 span；没有 → null */
function terminalLocation(): { text: string; title: string } | null {
  const loc = terminalPrompt()?.querySelector<HTMLElement>('span[title]')
  return loc ? { text: loc.textContent ?? '', title: loc.getAttribute('title') ?? '' } : null
}

const ICON_BROWSER = '#60a5fa'
const ICON_SSH = '#38bdf8'

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'zh',
    resources: { zh: { translation: zh } },
    showSupportNotice: false
  })
})

beforeEach(() => {
  // 宿主表一律清空：下面每条都在测「宿主表里没有时」的兜底（D-2 自己塞一条）
  useChatStore.setState({
    toolPresentations: {},
    activeSessionId: null,
    sessionToolExecutions: {},
    sessionPendingInputs: {}
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

describe('ToolCallBlock — 内置 MCP 工具的兜底呈现', () => {
  it('D-1 mcp__browser__open_tab（完成）：「浏览器」+ Globe（#60a5fa）+ 摘要，data-tool-name 是完整工具名', () => {
    renderTool({
      toolName: 'mcp__browser__open_tab',
      args: { url: 'https://a.example' },
      result: 'Opened tab t1',
      status: 'done'
    })
    const row = toolRow('mcp__browser__open_tab')
    expect(labelOf(row)).toBe('浏览器')
    expect(detailOf(row)).toBe('open_tab https://a.example')
    const icon = row.querySelector<SVGElement>('svg.lucide-globe')
    expect(icon).not.toBeNull()
    expect(icon!.style.color).toBe(cssColor(ICON_BROWSER))
    expect(row.getAttribute('data-tool-status')).toBe('done')
  })

  it('D-2 宿主表里有这个名字时，宿主的呈现赢（标签与图标都用宿主的）', () => {
    useChatStore.setState({
      toolPresentations: { mcp__browser__open_tab: { label: 'Host label', icon: 'Monitor' } }
    })
    renderTool({
      toolName: 'mcp__browser__open_tab',
      args: { url: 'https://a.example' },
      status: 'done'
    })
    const row = toolRow('mcp__browser__open_tab')
    expect(labelOf(row)).toBe('Host label')
    expect(row.querySelector('svg.lucide-monitor')).not.toBeNull()
    expect(row.querySelector('svg.lucide-globe')).toBeNull()
    // 摘要仍按工具名取（与呈现来自哪张表无关）
    expect(detailOf(row)).toBe('open_tab https://a.example')
  })

  it('D-3 mcp__ssh__exec 展开成终端：没有参数 / 结果两块，提示符前是主机名（title 也是），命令与输出都在', () => {
    const details: ToolResultDetails = { type: 'mcp', server: 'ssh', tool: 'exec' }
    renderTool({
      toolName: 'mcp__ssh__exec',
      args: { host: 'prod', command: 'uptime' },
      result: 'up 3 days',
      details,
      status: 'done'
    })
    const row = toolRow('mcp__ssh__exec')
    // 折叠行：SSH + 终端图标 + 主机名摘要
    expect(labelOf(row)).toBe('SSH')
    const icon = row.querySelector<SVGElement>('svg.lucide-terminal')
    expect(icon).not.toBeNull()
    expect(icon!.style.color).toBe(cssColor(ICON_SSH))
    expect(detailOf(row)).toBe('prod')

    expand(row)
    const prompt = terminalPrompt()
    expect(prompt, '应当是终端形态').not.toBeNull()
    expect(terminalLocation()).toEqual({ text: 'prod', title: 'prod' })
    expect(prompt!.textContent).toContain('uptime')
    expect([...row.querySelectorAll('pre')].map((p) => p.textContent)).toContain('up 3 days')
    // 通用表单形态的两个标签一个都没有
    expect(row.textContent).not.toContain(i18n.t('toolCall.params'))
    expect(row.textContent).not.toContain(i18n.t('toolCall.result'))
  })

  it('D-4a 命令还在跑（没有结果、没有 details）：主机名照样在 —— 按工具名认，不等 details', () => {
    renderTool({
      toolName: 'mcp__ssh__exec',
      args: { host: 'prod', command: 'sleep 10' },
      status: 'running'
    })
    expand(toolRow('mcp__ssh__exec'))
    expect(terminalPrompt(), '应当是终端形态').not.toBeNull()
    expect(terminalLocation()).toEqual({ text: 'prod', title: 'prod' })
  })

  it('D-4b host 不是字符串 → 不显示主机名（终端形态本身照旧）', () => {
    renderTool({
      toolName: 'mcp__ssh__exec',
      args: { host: 42, command: 'uptime' },
      result: 'up',
      details: { type: 'mcp', server: 'ssh', tool: 'exec' },
      status: 'done'
    })
    expand(toolRow('mcp__ssh__exec'))
    expect(terminalPrompt()).not.toBeNull()
    expect(terminalLocation()).toBeNull()
  })

  it('D-4c 第三方 server 的同名 exec（宿主给了终端形态）：args.host 不当主机名显示', () => {
    useChatStore.setState({
      toolPresentations: { mcp__x__exec: { label: 'X exec', detailView: 'terminal' } }
    })
    renderTool({
      toolName: 'mcp__x__exec',
      args: { host: 'prod', command: 'uptime' },
      result: 'up',
      details: { type: 'mcp', server: 'x', tool: 'exec' },
      status: 'done'
    })
    expand(toolRow('mcp__x__exec'))
    expect(terminalPrompt(), '宿主声明了终端形态').not.toBeNull()
    expect(terminalLocation()).toBeNull()
  })

  it('D-5 第三方 mcp__tavily__search 维持通用形态：原始工具名、扳手、无摘要；展开是参数 / 结果两块', () => {
    renderTool({
      toolName: 'mcp__tavily__search',
      args: { query: 'shuvix' },
      result: 'three hits',
      status: 'done'
    })
    const row = toolRow('mcp__tavily__search')
    expect(labelOf(row)).toBe('mcp__tavily__search')
    expect(row.querySelector('svg.lucide-wrench')).not.toBeNull()
    expect(detailOf(row)).toBeNull()

    expand(row)
    expect(terminalPrompt()).toBeNull()
    expect(row.textContent).toContain(i18n.t('toolCall.params'))
    expect(row.textContent).toContain(i18n.t('toolCall.result'))
    const pres = [...row.querySelectorAll('pre')].map((p) => p.textContent ?? '')
    expect(pres.some((t) => t.includes('"query": "shuvix"'))).toBe(true)
    expect(pres).toContain('three hits')
  })

  it('D-6 历史会话里退役的 multiplex browser 块（宿主表为空）：「浏览器」+ Globe + 旧摘要', () => {
    renderTool({
      toolName: 'browser',
      args: { action: 'click', uid: 'e5' },
      result: 'ok',
      status: 'done'
    })
    const row = toolRow('browser')
    expect(labelOf(row)).toBe('浏览器')
    expect(row.querySelector('svg.lucide-globe')).not.toBeNull()
    expect(detailOf(row)).toBe('click e5')
  })
})

describe('StepGroup — 浏览器步骤的合并行', () => {
  const step = (id: string, tool: string, args: Record<string, unknown>): StepBlock => ({
    type: 'tool',
    toolCallId: id,
    toolName: `mcp__browser__${tool}`,
    args,
    result: 'ok'
  })
  const group = (): HTMLElement => {
    const el = container.querySelector<HTMLElement>('[data-step-group]')
    if (!el) throw new Error('step group not rendered')
    return el
  }

  it('D-7a 同为浏览器的两个不同动作：标签「浏览器 ×2」、摘要逐条拼接、计数 2、不出图标', () => {
    render(
      createElement(StepGroup, {
        blocks: [
          step('c1', 'snapshot', { tabId: 't1' }),
          step('c2', 'click', { tabId: 't1', uid: 'e5' })
        ]
      })
    )
    const g = group()
    expect(g.getAttribute('data-group-size')).toBe('2')
    expect(labelOf(g)).toBe('浏览器 ×2')
    expect(detailOf(g)).toBe('snapshot t1 · click e5')
    expect(g.querySelector('[data-group-count]')?.textContent).toBe('2')
    // 混合段（工具名不同）不出图标
    expect(stepButton(g).querySelector('svg')).toBeNull()
  })

  it('D-7b 同一个动作两次：Globe 图标 + 「浏览器」、摘要 click e5 · click e6', () => {
    render(
      createElement(StepGroup, {
        blocks: [
          step('c1', 'click', { tabId: 't1', uid: 'e5' }),
          step('c2', 'click', { tabId: 't1', uid: 'e6' })
        ]
      })
    )
    const g = group()
    expect(g.getAttribute('data-group-size')).toBe('2')
    expect(labelOf(g)).toBe('浏览器')
    expect(detailOf(g)).toBe('click e5 · click e6')
    const icon = stepButton(g).querySelector<SVGElement>('svg.lucide-globe')
    expect(icon).not.toBeNull()
    expect(icon!.style.color).toBe(cssColor(ICON_BROWSER))
  })
})

describe('AskForm — 内置 MCP 工具发起的询问', () => {
  const ask = (toolName: string, command: string, description?: string): AskInputRequest => ({
    id: 'tc-1',
    kind: 'ask',
    toolName,
    command,
    description,
    createdAt: 0
  })
  const renderAsk = (request: AskInputRequest): void =>
    render(
      createElement(AskForm, {
        request,
        draft: {},
        onDraftChange: vi.fn(),
        onSubmit: vi.fn()
      })
    )
  /** 标题行（第一行：图标 + 标题 + 说明） */
  const titleRow = (): HTMLElement => container.querySelector('p')!.parentElement as HTMLElement
  const title = (): string | null => container.querySelector('p')?.textContent ?? null

  it('D-8a 浏览器打开一个地址：标题「浏览器」+ Globe', () => {
    renderAsk(ask('mcp__browser__open_tab', 'https://a.example', 'Open https://a.example'))
    expect(title()).toBe('浏览器')
    expect(titleRow().querySelector('svg.lucide-globe')).not.toBeNull()
    expect(titleRow().querySelector('svg.lucide-shield-alert')).toBeNull()
  })

  it('D-8b ssh exec 的命令询问：标题「SSH」+ 终端图标', () => {
    renderAsk(ask('mcp__ssh__exec', 'ssh prod: uptime', 'Run on prod'))
    expect(title()).toBe('SSH')
    expect(titleRow().querySelector('svg.lucide-terminal')).not.toBeNull()
  })

  it('D-8c 第三方 MCP 工具：退回「等待确认」+ 盾牌图标', () => {
    renderAsk(ask('mcp__tavily__search', 'search shuvix'))
    expect(title()).toBe(i18n.t('toolCall.pendingAsk'))
    expect(titleRow().querySelector('svg.lucide-shield-alert')).not.toBeNull()
    expect(titleRow().querySelector('svg.lucide-globe')).toBeNull()
  })

  it('D-8d upload_file 的路径询问 Read(/x)：标题是「读取路径」那一句，不用浏览器的呈现', () => {
    renderAsk(ask('mcp__browser__upload_file', 'Read(/x)'))
    expect(title()).toBe(i18n.t('toolCall.pendingPathRead'))
    expect(titleRow().querySelector('svg.lucide-file-text')).not.toBeNull()
    expect(titleRow().querySelector('svg.lucide-globe')).toBeNull()
    // 路径预览里是那条路径本身
    expect(container.textContent).toContain('/x')
  })
})
