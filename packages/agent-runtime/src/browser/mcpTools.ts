/**
 * 内置 browser MCP server 的工具目录 —— 单一真源（描述、参数 JSON Schema、annotations、cap 依赖）。
 *
 * **一个动作一个工具**，而不是一个 multiplex 工具带 `action` 参数：
 *  - annotations 是逐工具的。multiplex 工具不可能「snapshot 只读、click 有破坏性」，策略于是
 *    写不出「浏览器的非只读动作要问」；拆开后策略还能按 `object.mcpTool` 点名。
 *  - 每个工具的描述就是它的手册，不再需要一次 `help` 调用去拉长文（实测模型很少主动调 help）。
 *
 * **四个 hint 每个工具都显式写全**：规范的缺省是保守的（destructive、openWorld 缺省为 true），
 * 漏写一个，`snapshot` 在策略眼里就成了「有破坏性、触达外部」。
 *
 * 「只读」的口径：不改页面、不改用户的文件。写进 ShuviX 自己的 tool-results 目录不算，
 * 所以 `screenshot` 只读，而写到用户指定位置的 `pdf` 不是。
 *
 * 纯数据 + 纯函数，不依赖 MCP SDK —— server 与测试都从这里取。
 */
import { PDF_PAGE_SIZES, PDF_SCALE_RANGE, type BrowserCaps } from './backend'
import { KEY_DEFS } from './keyboard'

export type BrowserToolName =
  | 'list_tabs'
  | 'open_tab'
  | 'close_tab'
  | 'navigate'
  | 'snapshot'
  | 'read_page'
  | 'screenshot'
  | 'click'
  | 'fill'
  | 'type'
  | 'press_key'
  | 'hover'
  | 'upload_file'
  | 'scroll'
  | 'wait_for'
  | 'evaluate'
  | 'network'
  | 'console'
  | 'pdf'
  | 'cdp'
  | 'events'
  | 'cdp_recipes'

export interface BrowserToolAnnotations {
  title: string
  readOnlyHint: boolean
  destructiveHint: boolean
  idempotentHint: boolean
  openWorldHint: boolean
}

/** 一个参数的 JSON Schema（外加它依赖的端能力：不支持时这个参数不出现） */
interface ParamSpec {
  schema: Record<string, unknown>
  cap?: keyof BrowserCaps
}

interface BrowserToolSpec {
  name: BrowserToolName
  title: string
  description: (caps: BrowserCaps) => string
  params: Record<string, ParamSpec>
  required: readonly string[]
  /** 必选参数里允许传空字符串的（缺省：空串视为缺失） —— fill 用 "" 清空字段 */
  allowEmpty?: readonly string[]
  /** 整个工具依赖的端能力；缺省 = 两端都有 */
  cap?: keyof BrowserCaps
  hints: Omit<BrowserToolAnnotations, 'title'>
}

/** tools/list 里的一项（形状就是 MCP 的 Tool） */
export interface BrowserMcpTool {
  name: BrowserToolName
  title: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, Record<string, unknown>>
    required: string[]
    additionalProperties: false
  }
  annotations: BrowserToolAnnotations
}

// ─── 参数积木 ────────────────────────────────────────────────────────────

const str = (description: string): ParamSpec => ({ schema: { type: 'string', description } })
const num = (description: string): ParamSpec => ({ schema: { type: 'number', description } })
const bool = (description: string): ParamSpec => ({ schema: { type: 'boolean', description } })

const TAB_ID = str('Tab id from list_tabs or open_tab.')
const UID = str('Element uid from the latest snapshot of this tab.')

/**
 * 只读：不改页面数据、不写用户的文件。规范说 idempotent 只在非只读时有意义，这里一律写 true，
 * 免得「只读却不幂等」这种组合被策略当成一条信号去读。
 * scroll / hover 也归这一类：会改滚动位置、会让菜单弹出来，但不改任何数据 —— 否则
 * 「非只读就问」会问每一次滚动。
 */
const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
} as const

/** 改页面、可能触发外部请求 —— 一次点击可以提交表单、删除条目、下单，所以保守标 destructive */
const INTERACTS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true
} as const

const namedKeys = Object.keys(KEY_DEFS)
  .filter((k) => k !== ' ')
  .join(', ')

// ─── 目录 ────────────────────────────────────────────────────────────────

const TOOLS: readonly BrowserToolSpec[] = [
  {
    name: 'list_tabs',
    title: 'List browser tabs',
    description: () =>
      'List the open browser tabs with their tabId, title and URL. Start here when the page may already be open: a tab that is already on the right site (and possibly signed in) should be reused rather than opened again.',
    params: {},
    required: [],
    hints: READ_ONLY
  },
  {
    name: 'open_tab',
    title: 'Open a page in a new tab',
    description: () =>
      'Open a URL in a NEW tab, wait for it to load (up to ~10s), and return its tabId. This is the way to open a page — do not use navigate for a fresh page.',
    params: { url: str('The URL to open (http, https or file).') },
    required: ['url'],
    hints: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    }
  },
  {
    name: 'close_tab',
    title: 'Close a tab',
    description: () => 'Close a tab when you are done with it.',
    params: { tabId: TAB_ID },
    required: ['tabId'],
    hints: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  {
    name: 'navigate',
    title: 'Navigate a tab',
    description: () =>
      'Navigate an existing tab: go to a url (nav "goto", the default), or back / forward / reload. Waits for the page to load and reports load failures. All uids become invalid — take a new snapshot before interacting.',
    params: {
      tabId: TAB_ID,
      url: str('Where to go (required for nav "goto").'),
      nav: {
        schema: {
          type: 'string',
          enum: ['goto', 'back', 'forward', 'reload'],
          description: 'What kind of navigation (default "goto").'
        }
      }
    },
    required: ['tabId'],
    hints: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    }
  },
  {
    name: 'snapshot',
    title: 'Snapshot a tab',
    description: (caps) =>
      `Accessibility snapshot of a tab: the page's elements, each interactive one tagged with a uid. Required before ${caps.upload ? 'click / fill / type / hover / upload_file' : 'click / fill / type / hover'} — uids come from, and are only valid for, the latest snapshot of that tab. A repeat snapshot of the same tab returns only what changed (lines marked +/~, unchanged runs collapsed); pass full:true if you no longer have your earlier snapshot of it.`,
    params: {
      tabId: TAB_ID,
      full: bool('Return the complete snapshot instead of the changes since your previous one.')
    },
    required: ['tabId'],
    hints: READ_ONLY
  },
  {
    name: 'read_page',
    title: 'Read a page as Markdown',
    description: (caps) =>
      "Read the tab's whole rendered content (after JavaScript) as Markdown — thousands of tokens on a real page, truncated at 200k characters. Use it when you need to READ the content" +
      (caps.evaluate
        ? '; for one specific value (a cell, a label, a style) use evaluate instead.'
        : '.'),
    params: { tabId: TAB_ID },
    required: ['tabId'],
    hints: READ_ONLY
  },
  {
    name: 'screenshot',
    title: 'Screenshot a tab',
    description: (caps) =>
      [
        `Capture the tab viewport as an image (~900 tokens${caps.fullPageScreenshot ? ', more with fullPage' : ''}). For genuinely visual questions only — layout, spacing, overlap, visual regressions${caps.evaluate ? '; for facts about the page (text, state, styles, counts) use evaluate' : ''}.`,
        caps.fullPageScreenshot ? 'fullPage:true captures beyond the viewport.' : '',
        caps.elementScreenshot
          ? `uid captures a single element${caps.fullPageScreenshot ? ' (wins over fullPage)' : ''}.`
          : '',
        caps.screenshotToFile
          ? 'The image is saved as a PNG file and its path returned — read that path when you actually need to look at it.'
          : 'The image is returned inline.'
      ]
        .filter(Boolean)
        .join(' '),
    params: {
      tabId: TAB_ID,
      fullPage: {
        ...bool('Capture the full page beyond the viewport.'),
        cap: 'fullPageScreenshot'
      },
      uid: {
        ...str('Capture only this element (uid from the latest snapshot).'),
        cap: 'elementScreenshot'
      }
    },
    required: ['tabId'],
    hints: READ_ONLY
  },
  {
    name: 'click',
    title: 'Click an element',
    description: () =>
      'Click an element by its uid from the latest snapshot — a trusted mouse click at its centre. It scrolls the element into view first; when the element is hidden or covered by something else (a dialog, banner or overlay) it says so instead of clicking. When the click navigates, it waits for the new page and says so — snapshot again before interacting.',
    params: { tabId: TAB_ID, uid: UID },
    required: ['tabId', 'uid'],
    hints: INTERACTS
  },
  {
    name: 'fill',
    title: 'Fill a field',
    description: () =>
      'REPLACE the value of an input, textarea or contenteditable editor by uid (as one real edit, so frameworks like React see it), or pick an option of a <select> by its label or value. "" clears the field. Waits briefly for fields a script disables, then reports what the field actually shows — including when the page reformatted the value or moved focus elsewhere.',
    params: {
      tabId: TAB_ID,
      uid: UID,
      text: str('The new value ("" clears the field); for a <select>, an option label or value.')
    },
    required: ['tabId', 'uid', 'text'],
    allowEmpty: ['text'],
    hints: INTERACTS
  },
  {
    name: 'type',
    title: 'Type text',
    description: () =>
      'Type text at the caret without clearing anything — with uid it focuses that element first (caret at the end). submitKey (e.g. "Enter") is pressed afterwards. Use it for search boxes and editors where replacing the value with fill is wrong.',
    params: {
      tabId: TAB_ID,
      text: str('Text to type.'),
      uid: str('Element to focus first (uid from the latest snapshot).'),
      submitKey: str('Key to press after typing, e.g. "Enter".')
    },
    required: ['tabId', 'text'],
    hints: INTERACTS
  },
  {
    name: 'press_key',
    title: 'Press a key',
    description: () =>
      `Press a key or key combination on the focused element. Named keys: ${namedKeys}. Combinations join with "+": "Shift+Tab", "Control+A", "Meta+Shift+R"; a single character types itself. On macOS, Control+A/C/V/X/Z/Y are sent as the Cmd shortcuts. When the key navigates, it waits for the new page and says so.`,
    params: { tabId: TAB_ID, key: str('The key or combination, e.g. "Enter" or "Control+A".') },
    required: ['tabId', 'key'],
    hints: INTERACTS
  },
  {
    name: 'hover',
    title: 'Hover over an element',
    description: () =>
      'Move the mouse over an element by uid (scrolled into view first) — for menus and tooltips that only appear on hover. Take a snapshot afterwards to see what appeared.',
    params: { tabId: TAB_ID, uid: UID },
    required: ['tabId', 'uid'],
    hints: READ_ONLY
  },
  {
    name: 'upload_file',
    title: 'Upload files to a file input',
    description: () =>
      'Set local files on a file input by uid: the <input type=file> itself, or the label / button that wraps it. Paths are absolute or relative to the session working directory. Each file is checked like any other local read before it leaves this machine.',
    params: {
      tabId: TAB_ID,
      uid: UID,
      paths: {
        schema: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: 'Local files to upload.'
        }
      }
    },
    required: ['tabId', 'uid', 'paths'],
    cap: 'upload',
    hints: INTERACTS
  },
  {
    name: 'scroll',
    title: 'Scroll',
    description: () =>
      'Scroll the page, or the element with uid, by amount pixels (default: down 500). If an element you need is off-screen, scroll and snapshot again.',
    params: {
      tabId: TAB_ID,
      direction: {
        schema: {
          type: 'string',
          enum: ['up', 'down', 'left', 'right'],
          description: 'Scroll direction (default "down").'
        }
      },
      amount: num('Distance in pixels (default 500).'),
      uid: str('Scroll inside this element instead of the page.')
    },
    required: ['tabId'],
    hints: READ_ONLY
  },
  {
    name: 'wait_for',
    title: 'Wait for text',
    description: () =>
      'Poll until the text appears in the page body (default timeout 10000 ms). Use it after a navigation or on a slow page instead of guessing.',
    params: {
      tabId: TAB_ID,
      text: str('The text to wait for.'),
      timeout: num('Timeout in milliseconds (default 10000).')
    },
    required: ['tabId', 'text'],
    hints: READ_ONLY
  },
  {
    name: 'evaluate',
    title: 'Evaluate JavaScript',
    description: () =>
      'Run a JavaScript expression in the page and return its JSON value (promises are awaited; ~20 tokens). The cheap, exact way to check any fact: text content, an attribute, a computed style, an element count, visibility. Prefer it over read_page or screenshot for a specific question.',
    params: { tabId: TAB_ID, expression: str('The JavaScript expression to evaluate.') },
    required: ['tabId', 'expression'],
    cap: 'evaluate',
    hints: INTERACTS
  },
  {
    name: 'network',
    title: 'List network requests',
    description: (caps) =>
      'HTTP requests captured on this tab, most recent first. The first call starts capturing, so navigate or reload and call again. Each line starts with its requestId' +
      (caps.rawCdp ? ' (for cdp Network.getResponseBody).' : '.'),
    params: { tabId: TAB_ID, limit: num('At most this many entries (default all).') },
    required: ['tabId'],
    cap: 'network',
    hints: READ_ONLY
  },
  {
    name: 'console',
    title: 'List console messages',
    description: () =>
      'Console messages and errors captured on this tab, most recent first. The first call starts capturing, so reproduce the problem and call again.',
    params: { tabId: TAB_ID, limit: num('At most this many entries (default all).') },
    required: ['tabId'],
    cap: 'console',
    hints: READ_ONLY
  },
  {
    name: 'pdf',
    title: 'Export a page to PDF',
    description: () =>
      'Export the page to a PDF file. outputPath is absolute or relative to the session working directory, and is checked like any other file write.',
    params: {
      tabId: TAB_ID,
      outputPath: str('Where to write the PDF.'),
      pageSize: str(`Paper size: ${PDF_PAGE_SIZES.join(', ')} (default A4).`),
      landscape: bool('Landscape orientation.'),
      scale: num(`Scale ${PDF_SCALE_RANGE.min}–${PDF_SCALE_RANGE.max} (default 1).`)
    },
    required: ['tabId', 'outputPath'],
    cap: 'pdf',
    hints: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  {
    name: 'cdp',
    title: 'Send a raw DevTools Protocol command',
    description: () =>
      'Escape hatch: send one raw Chrome DevTools Protocol command to the tab, for what the other tools do not cover (response bodies, viewport emulation, CSS inspection, performance, storage). Read cdp_recipes before your first call. Methods outside the tab (Browser, Target, Tracing, …) are refused. params may refer to snapshot elements with {"$uid":"e7"}, {"$uidX":"e7"} and {"$uidY":"e7"}.',
    params: {
      tabId: TAB_ID,
      method: str('CDP method, e.g. "Network.getResponseBody".'),
      params: {
        schema: {
          type: 'object',
          additionalProperties: true,
          description: 'Method parameters (may use the uid macros).'
        }
      }
    },
    required: ['tabId', 'method'],
    cap: 'rawCdp',
    hints: INTERACTS
  },
  {
    name: 'events',
    title: 'Pull buffered DevTools events',
    description: () =>
      'Pull the CDP events buffered for domains you enabled with cdp (e.g. Network.responseReceived), about the last 1000. Pass sinceSeq = the nextSeq of your previous pull to get only new ones.',
    params: {
      tabId: TAB_ID,
      event: str('Only this event, e.g. "Network.responseReceived".'),
      sinceSeq: num('Only events after this sequence number.'),
      limit: num('At most this many entries, most recent first (default 100).')
    },
    required: ['tabId'],
    cap: 'rawCdp',
    hints: READ_ONLY
  },
  {
    name: 'cdp_recipes',
    title: 'DevTools escape-hatch recipes',
    description: () =>
      'Conventions and worked recipes for cdp / events: request and response bodies, responsive layout, why a style is not applied, Web Vitals, storage, breakpoints. Read it before your first cdp call.',
    params: {},
    required: [],
    cap: 'rawCdp',
    hints: READ_ONLY
  }
]

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]))

/** 这台 server 在这组端能力下提供哪些工具（按目录顺序，确定性 —— 2026-07-28 规范要求列表稳定） */
function specsForCaps(caps: BrowserCaps): BrowserToolSpec[] {
  return TOOLS.filter((t) => !t.cap || caps[t.cap])
}

/** 工具名 → 目录条目（端不支持的工具返回 undefined） */
export function browserToolSpec(
  name: string,
  caps: BrowserCaps
): { required: readonly string[]; allowEmpty: readonly string[] } | undefined {
  const spec = BY_NAME.get(name as BrowserToolName)
  if (!spec || (spec.cap && !caps[spec.cap])) return undefined
  return { required: spec.required, allowEmpty: spec.allowEmpty ?? [] }
}

/**
 * tools/list 的内容。
 *
 * `hostNote` 接在 list_tabs 的描述后面 —— 那是模型进入浏览器的第一站，「这是谁的浏览器、
 * tab 与登录会不会留着」这类宿主差异讲在那里（桌面：内置面板、跨会话持久；扩展：用户真实的
 * 标签页、操作会挂调试横幅）。
 */
export function browserToolsForCaps(caps: BrowserCaps, hostNote?: string): BrowserMcpTool[] {
  return specsForCaps(caps).map((spec) => {
    const params = Object.entries(spec.params).filter(([, p]) => !p.cap || caps[p.cap])
    let description = spec.description(caps)
    if (spec.name === 'list_tabs' && hostNote) description += `\n\n${hostNote}`
    return {
      name: spec.name,
      title: spec.title,
      description,
      inputSchema: {
        type: 'object',
        properties: Object.fromEntries(params.map(([k, p]) => [k, p.schema])),
        required: [...spec.required],
        additionalProperties: false
      },
      annotations: { title: spec.title, ...spec.hints }
    }
  })
}
