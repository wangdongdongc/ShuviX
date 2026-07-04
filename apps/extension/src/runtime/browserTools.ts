/**
 * 浏览器操控工具 —— 让 agent 读取（并在 Phase 2 操作）用户已打开的任意标签页。
 * 这是扩展形态独有的「超能力」：读 live 渲染后 DOM，覆盖登录态 / SPA 等 URL 抓取拿不到的页面。
 *
 * 与文件工具不同，浏览器工具不绑定项目文件夹 —— 对所有会话（含临时对话）始终可用。
 *
 * 读取（list_tabs + read_page）走 chrome.scripting（注入预置函数，无调试横幅）。
 * 操作（snapshot + click/fill/navigate/key/screenshot）走 chrome.debugger/CDP（可信输入，
 * 接管后目标页挂「正在调试」横幅）；snapshot 给每个可交互元素分配 uid，后续动作按 uid 定位。
 */
import { Type } from 'typebox'
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import type { InputRequest, InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import * as cdp from './cdp'

const ABORT = 'TOOL_ABORTED'

/** read_page 转换后 Markdown 字符上限 */
const MAX_PAGE_MARKDOWN_CHARS = 200_000

/** 本扩展页面的 URL 前缀（chrome-extension://<id>/）—— 用于识别并保护 ShuviX 自己的标签页 */
const SELF_PREFIX = chrome.runtime.getURL('')

type ToolResult = AgentToolResult<undefined>

/** 拒绝在 ShuviX 自己的整页标签页上操作（navigate 会把 ShuviX 自身替换掉/销毁 agent 循环） */
async function assertNotSelfTab(tabId: number): Promise<void> {
  let tab: chrome.tabs.Tab
  try {
    tab = await chrome.tabs.get(tabId)
  } catch {
    return // 标签页不存在，交由下游报错
  }
  if (tab.url && tab.url.startsWith(SELF_PREFIX)) {
    throw new Error(
      `Refusing to operate on the ShuviX app tab itself (tab ${tabId}). ` +
        `Use open_tab to open a new page, or target a content tab from list_tabs.`
    )
  }
}

const ListTabsSchema = Type.Object({})

const OpenTabSchema = Type.Object({
  url: Type.String({ description: 'The URL to open in a new browser tab' })
})

const ReadPageSchema = Type.Object({
  tabId: Type.Number({
    description:
      'The id of the tab to read (obtain it from list_tabs). Reads the live rendered DOM.'
  })
})

const LIST_TABS_DESCRIPTION =
  'List the browser tabs currently open (id, title, URL, whether active). Use this to find the tab id to pass to read_page. The ShuviX app tab itself is excluded.'
const OPEN_TAB_DESCRIPTION =
  'Open a URL in a NEW browser tab and return its tab id. Use this to open a web page. Do NOT use navigate for opening a fresh page — navigate replaces the content of an existing tab.'
const READ_PAGE_DESCRIPTION =
  "Read an open browser tab's live rendered content (after JavaScript) and convert it to Markdown. Works on authenticated pages and single-page apps that a plain URL fetch cannot read. Pass a tabId from list_tabs."

/** 列出打开的标签页（chrome.tabs，无需注入/横幅） */
const listTabsTool: AgentTool<typeof ListTabsSchema> = {
  name: 'list_tabs',
  label: 'List Tabs',
  description: LIST_TABS_DESCRIPTION,
  parameters: ListTabsSchema,
  async execute(_id, _params, signal): Promise<ToolResult> {
    if (signal?.aborted) throw new Error(ABORT)
    const tabs = await chrome.tabs.query({})
    const lines = tabs
      // 排除 ShuviX 自己的标签页，避免 agent 误把它当内容页操作
      .filter((t) => t.id != null && !(t.url ?? '').startsWith(SELF_PREFIX))
      .map((t) => {
        const flags = [t.active ? 'active' : '', t.audible ? 'audible' : ''].filter(Boolean)
        const tag = flags.length ? ` (${flags.join(', ')})` : ''
        return `[${t.id}]${tag} ${t.title ?? '(untitled)'} — ${t.url ?? ''}`
      })
    return {
      content: [{ type: 'text', text: lines.join('\n') || '(no open content tabs)' }],
      details: undefined
    }
  }
}

/** 在新标签页打开 URL（chrome.tabs.create）—— "打开网页"的正确原语，避免误用 navigate 替换当前页 */
const openTabTool: AgentTool<typeof OpenTabSchema> = {
  name: 'open_tab',
  label: 'Open Tab',
  description: OPEN_TAB_DESCRIPTION,
  parameters: OpenTabSchema,
  async execute(_id, params, signal): Promise<ToolResult> {
    if (signal?.aborted) throw new Error(ABORT)
    const tab = await chrome.tabs.create({ url: params.url, active: true })
    return {
      content: [
        {
          type: 'text',
          text: `Opened ${params.url} in new tab ${tab.id}. Use read_page/snapshot with this tab id.`
        }
      ],
      details: undefined
    }
  }
}

/** 注入页面的抽取函数（自包含；序列化后在目标页执行）：去脚本/样式，返回正文 HTML + 元信息 */
function extractPage(): { title: string; url: string; html: string } {
  const rootSrc = document.body ?? document.documentElement
  const clone = rootSrc.cloneNode(true) as Element
  clone
    .querySelectorAll('script,style,noscript,svg,template,link,iframe')
    .forEach((el) => el.remove())
  return { title: document.title, url: location.href, html: clone.innerHTML }
}

/** 读取某标签页渲染后内容 → Markdown（chrome.scripting 注入，无横幅；turndown 按需加载） */
const readPageTool: AgentTool<typeof ReadPageSchema> = {
  name: 'read_page',
  label: 'Read Page',
  description: READ_PAGE_DESCRIPTION,
  parameters: ReadPageSchema,
  async execute(_id, params, signal): Promise<ToolResult> {
    if (signal?.aborted) throw new Error(ABORT)
    const { tabId } = params
    await assertNotSelfTab(tabId)

    let extracted: { title: string; url: string; html: string }
    try {
      const [inj] = await chrome.scripting.executeScript({
        target: { tabId },
        func: extractPage
      })
      extracted = inj?.result as { title: string; url: string; html: string }
      if (!extracted) throw new Error('no result')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(
        `无法读取标签页 ${tabId}：${msg}。（chrome://、Chrome 应用商店、其他扩展页等受限页面无法注入。）`
      )
    }

    const { default: TurndownService } = await import('turndown')
    const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' })
    let md = td.turndown(extracted.html)

    let note = ''
    if (md.length > MAX_PAGE_MARKDOWN_CHARS) {
      md = md.slice(0, MAX_PAGE_MARKDOWN_CHARS)
      note = '\n\n[Output truncated — page content exceeded limit.]'
    }

    const header = `Page: ${extracted.title || '(untitled)'}\nURL: ${extracted.url}\n\n`
    return { content: [{ type: 'text', text: header + md + note }], details: undefined }
  }
}

// ─── 操作（CDP / chrome.debugger，可信输入；接管后挂调试横幅） ──────────────────
// snapshot / UID 映射 / 坐标解析走共享 cdp.getController(tabId)（与桌面同一份 CdpController）。

const TabIdSchema = Type.Number({ description: 'Target tab id (from list_tabs)' })
const UidSchema = Type.String({ description: 'Element uid from the latest snapshot of this tab' })

const SnapshotSchema = Type.Object({ tabId: TabIdSchema })
const ClickSchema = Type.Object({ tabId: TabIdSchema, uid: UidSchema })
const FillSchema = Type.Object({
  tabId: TabIdSchema,
  uid: UidSchema,
  text: Type.String({ description: 'Text to type into the element (replaces existing value)' })
})
const KeySchema = Type.Object({
  tabId: TabIdSchema,
  key: Type.String({
    description: 'Key to press: Enter, Tab, Escape, Backspace, Delete, ArrowUp/Down/Left/Right'
  })
})
const NavigateSchema = Type.Object({
  tabId: TabIdSchema,
  url: Type.String({ description: 'URL to navigate the tab to' })
})
const ScreenshotSchema = Type.Object({ tabId: TabIdSchema })
const ReleaseSchema = Type.Object({ tabId: TabIdSchema })

/** 发一次按键（keyDown + keyUp） */
async function pressKey(
  tabId: number,
  def: { key: string; code: string; vk: number; text?: string },
  modifiers = 0
): Promise<void> {
  const base = {
    key: def.key,
    code: def.code,
    windowsVirtualKeyCode: def.vk,
    nativeVirtualKeyCode: def.vk,
    modifiers
  }
  await cdp.send(tabId, 'Input.dispatchKeyEvent', {
    type: def.text ? 'keyDown' : 'rawKeyDown',
    ...base,
    ...(def.text ? { text: def.text } : {})
  })
  await cdp.send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base })
}

const KEYMAP: Record<string, { key: string; code: string; vk: number; text?: string }> = {
  Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  Delete: { key: 'Delete', code: 'Delete', vk: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 }
}

const SNAPSHOT_DESCRIPTION =
  'Capture an accessibility snapshot of a tab: a list of interactive elements (buttons, links, inputs, …) each with a uid. Required before click/fill — pass the uid you see here. Re-run after the page changes.'
const CLICK_DESCRIPTION =
  'Click an element on a tab by its uid (from snapshot), using a trusted mouse event at the element center.'
const FILL_DESCRIPTION =
  'Type text into an input/textarea element by its uid (from snapshot); selects existing content first so it is replaced.'
const KEY_DESCRIPTION =
  'Press a single key on a tab (e.g. Enter to submit, Tab to move focus). The currently focused element receives it.'
const NAVIGATE_DESCRIPTION =
  'Navigate a tab to a URL. The previous snapshot is invalidated — call snapshot again after the page loads.'
const SCREENSHOT_DESCRIPTION =
  "Capture a JPEG screenshot of a tab's visible viewport, returned as an inline image for visual inspection."
const RELEASE_DESCRIPTION =
  'Stop controlling a tab and remove its "being debugged" banner. Call this when finished operating a tab.'

const snapshotTool: AgentTool<typeof SnapshotSchema> = {
  name: 'snapshot',
  label: 'Snapshot',
  description: SNAPSHOT_DESCRIPTION,
  parameters: SnapshotSchema,
  async execute(_id, params, signal): Promise<ToolResult> {
    if (signal?.aborted) throw new Error(ABORT)
    const { tabId } = params
    await assertNotSelfTab(tabId)
    await cdp.send(tabId, 'Accessibility.enable')
    const pageUrl = (await chrome.tabs.get(tabId)).url ?? ''
    const { text } = await cdp.getController(tabId).buildSnapshot(pageUrl)
    return { content: [{ type: 'text', text }], details: undefined }
  }
}

const clickTool: AgentTool<typeof ClickSchema> = {
  name: 'click',
  label: 'Click',
  description: CLICK_DESCRIPTION,
  parameters: ClickSchema,
  async execute(_id, params, signal): Promise<ToolResult> {
    if (signal?.aborted) throw new Error(ABORT)
    const { tabId, uid } = params
    await assertNotSelfTab(tabId)
    const { x, y } = await cdp.getController(tabId).resolveCoordinates(uid)
    await cdp.send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await cdp.send(tabId, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      clickCount: 1
    })
    await cdp.send(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      clickCount: 1
    })
    return {
      content: [{ type: 'text', text: `Clicked ${uid} on tab ${tabId}.` }],
      details: undefined
    }
  }
}

const fillTool: AgentTool<typeof FillSchema> = {
  name: 'fill',
  label: 'Fill',
  description: FILL_DESCRIPTION,
  parameters: FillSchema,
  async execute(_id, params, signal): Promise<ToolResult> {
    if (signal?.aborted) throw new Error(ABORT)
    const { tabId, uid, text } = params
    await assertNotSelfTab(tabId)
    const controller = cdp.getController(tabId)
    // 与桌面 fillAction 同一配方：focus → 清空（触发 input）→ insertText → 触发 change
    await controller.focusElement(uid)
    await controller.callOnElement(
      uid,
      `function(){ this.value = ''; this.dispatchEvent(new Event('input', { bubbles: true })); }`
    )
    await cdp.send(tabId, 'Input.insertText', { text })
    await controller.callOnElement(
      uid,
      `function(){ this.dispatchEvent(new Event('change', { bubbles: true })); }`
    )
    return {
      content: [{ type: 'text', text: `Filled ${uid} on tab ${tabId}.` }],
      details: undefined
    }
  }
}

const keyTool: AgentTool<typeof KeySchema> = {
  name: 'key',
  label: 'Press Key',
  description: KEY_DESCRIPTION,
  parameters: KeySchema,
  async execute(_id, params, signal): Promise<ToolResult> {
    if (signal?.aborted) throw new Error(ABORT)
    const { tabId, key } = params
    await assertNotSelfTab(tabId)
    const def = KEYMAP[key]
    if (!def)
      throw new Error(`Unsupported key "${key}". Supported: ${Object.keys(KEYMAP).join(', ')}.`)
    await pressKey(tabId, def)
    return {
      content: [{ type: 'text', text: `Pressed ${key} on tab ${tabId}.` }],
      details: undefined
    }
  }
}

const navigateTool: AgentTool<typeof NavigateSchema> = {
  name: 'navigate',
  label: 'Navigate',
  description: NAVIGATE_DESCRIPTION,
  parameters: NavigateSchema,
  async execute(_id, params, signal): Promise<ToolResult> {
    if (signal?.aborted) throw new Error(ABORT)
    const { tabId, url } = params
    await assertNotSelfTab(tabId)
    await cdp.send(tabId, 'Page.enable')
    await cdp.send(tabId, 'Page.navigate', { url })
    cdp.resetController(tabId)
    return {
      content: [
        { type: 'text', text: `Navigating tab ${tabId} to ${url}. Call snapshot after it loads.` }
      ],
      details: undefined
    }
  }
}

const screenshotTool: AgentTool<typeof ScreenshotSchema> = {
  name: 'screenshot',
  label: 'Screenshot',
  description: SCREENSHOT_DESCRIPTION,
  parameters: ScreenshotSchema,
  async execute(_id, params, signal): Promise<ToolResult> {
    if (signal?.aborted) throw new Error(ABORT)
    const { tabId } = params
    await assertNotSelfTab(tabId)
    await cdp.send(tabId, 'Page.enable')
    const { data } = await cdp.send<{ data: string }>(tabId, 'Page.captureScreenshot', {
      format: 'jpeg',
      quality: 60
    })
    return {
      content: [
        { type: 'image', data, mimeType: 'image/jpeg' },
        { type: 'text', text: `Screenshot of tab ${tabId}.` }
      ],
      details: undefined
    }
  }
}

const releaseTool: AgentTool<typeof ReleaseSchema> = {
  name: 'release_tab',
  label: 'Release Tab',
  description: RELEASE_DESCRIPTION,
  parameters: ReleaseSchema,
  async execute(_id, params): Promise<ToolResult> {
    const { tabId } = params
    await cdp.detach(tabId) // 同时 reset 并丢弃该页 controller
    return { content: [{ type: 'text', text: `Released tab ${tabId}.` }], details: undefined }
  }
}

/** 浏览器操控工具集（应用级单例，不绑定会话/项目） */
export const browserTools: AgentTool[] = [
  listTabsTool,
  openTabTool,
  readPageTool,
  snapshotTool,
  clickTool,
  fillTool,
  keyTool,
  navigateTool,
  screenshotTool,
  releaseTool
] as AgentTool[]

/** 会改变用户真实页面状态、需 autoApprove 门控的工具名（点击/输入/按键/导航） */
const MUTATING_TOOL_NAMES = new Set(['click', 'fill', 'key', 'navigate'])

export interface BrowserApprovalDeps {
  /** 会话级自动批准开关：开 → 直接放行；关 → 每次操作前弹审批 */
  isAutoApprove: () => boolean
  /** 挂起/恢复审批（RuntimeSession.requestUserInput）；无前端时返回 cancel → 操作中止 */
  requestUserInput: (req: InputRequest) => Promise<InputResponse>
}

/** 把某次操作渲染成审批面板里展示的命令文本 */
function describeBrowserOp(name: string, params: Record<string, unknown>): string {
  const tabId = params.tabId
  switch (name) {
    case 'click':
      return `click(tab ${tabId}, element ${String(params.uid)})`
    case 'fill': {
      const text = String(params.text ?? '')
      const shown = text.length > 80 ? `${text.slice(0, 80)}…` : text
      return `fill(tab ${tabId}, element ${String(params.uid)}, text: ${JSON.stringify(shown)})`
    }
    case 'key':
      return `key(tab ${tabId}, ${String(params.key)})`
    case 'navigate':
      return `navigate(tab ${tabId} → ${String(params.url)})`
    default:
      return `${name}(tab ${tabId})`
  }
}

/**
 * 给「操作用户真实浏览器」的工具套上审批门控（CDP 点击/输入/按键/导航）。
 * autoApprove 开 → 透传；关 → 每次操作前向前端弹 Allow/Deny：
 *   - 允许 → 执行原 execute；
 *   - 拒绝 → 返回一条「已拒绝」工具结果（agent 可据此改道，不视为崩溃）；
 *   - 中止/无前端（cancel）→ 抛 ABORT 终止本轮。
 * 只读/低危工具（list_tabs/read_page/snapshot/screenshot/open_tab/release_tab）原样返回。
 */
export function gateBrowserTools(tools: AgentTool[], deps: BrowserApprovalDeps): AgentTool[] {
  return tools.map((tool) => {
    if (!MUTATING_TOOL_NAMES.has(tool.name)) return tool
    const run = tool.execute.bind(tool)
    return {
      ...tool,
      async execute(id: string, params: Record<string, unknown>, signal?: AbortSignal) {
        if (!deps.isAutoApprove()) {
          const response = await deps.requestUserInput({
            id,
            kind: 'approval',
            toolName: tool.name,
            command: describeBrowserOp(tool.name, params),
            createdAt: Date.now()
          })
          if (response.kind === 'cancel') throw new Error(ABORT)
          if (response.kind !== 'approval' || !response.approved) {
            return {
              content: [
                {
                  type: 'text',
                  text: `User denied the browser operation "${tool.name}". Do not retry it; consider an alternative or ask the user.`
                }
              ],
              details: undefined
            } satisfies ToolResult
          }
        }
        return run(id, params, signal)
      }
    } as AgentTool
  })
}
