/**
 * 浏览器操作目录 —— 单一真源。
 *
 * 每个 op 声明：一行 description（进工具 description）、参数必选/可选、
 * mutating（需审批）、cap 依赖（端不支持则整个 op 不进 schema/手册）、usage（参数错误时回显）。
 * tool.ts 的 schema / description、help.ts 的手册骨架都从这里生成，避免多处漂移。
 */
import type { BrowserCaps } from './backend'

export const BROWSER_ACTIONS = [
  'help',
  'list_tabs',
  'open_tab',
  'close_tab',
  'navigate',
  'snapshot',
  'read_page',
  'screenshot',
  'click',
  'fill',
  'type',
  'press_key',
  'scroll',
  'evaluate',
  'wait_for',
  'network',
  'console',
  'pdf',
  'cdp',
  'events'
] as const
export type BrowserAction = (typeof BROWSER_ACTIONS)[number]

/** 扁平参数超集的键名（与 tool.ts 的参数 schema 一一对应） */
export type BrowserParamKey =
  | 'tabId'
  | 'url'
  | 'uid'
  | 'text'
  | 'key'
  | 'nav'
  | 'direction'
  | 'amount'
  | 'expression'
  | 'timeout'
  | 'submitKey'
  | 'fullPage'
  | 'outputPath'
  | 'pageSize'
  | 'landscape'
  | 'scale'
  | 'topic'
  | 'method'
  | 'params'
  | 'event'
  | 'sinceSeq'
  | 'limit'

export interface BrowserOpSpec {
  name: BrowserAction
  /** 一行英文描述（token 预算 ~1 行/op） */
  description: string
  required: readonly BrowserParamKey[]
  optional: readonly BrowserParamKey[]
  /** 会改变页面/浏览器状态，需 autoApprove 门控 */
  mutating: boolean
  /**
   * 审批需求由参数动态决定（cdp：按 classifyCdpMethod 的 method 分类）。
   * tool.ts 对这类 op 走专门的分类门控，而非静态 mutating 标记。
   */
  dynamicGate?: boolean
  /** 依赖的端能力；undefined = 核心操作恒可用 */
  cap?: keyof BrowserCaps
  /** 参数错误时回显的 usage 行 */
  usage: string
}

export const BROWSER_OPS: readonly BrowserOpSpec[] = [
  {
    name: 'help',
    description: 'Show the full browser manual (optionally a single topic). Call when unsure.',
    required: [],
    optional: ['topic'],
    mutating: false,
    usage: 'help(topic?: workflow|interaction|navigation|capture|debugging|devtools)'
  },
  {
    name: 'list_tabs',
    description: 'List open browser tabs with their tabId, title and URL.',
    required: [],
    optional: [],
    mutating: false,
    usage: 'list_tabs()'
  },
  {
    name: 'open_tab',
    description:
      'Open a URL in a NEW tab and return its tabId. Do NOT use navigate to open a fresh page.',
    required: ['url'],
    optional: [],
    mutating: false,
    usage: 'open_tab(url)'
  },
  {
    name: 'close_tab',
    description: 'Close a tab.',
    required: ['tabId'],
    optional: [],
    mutating: true,
    usage: 'close_tab(tabId)'
  },
  {
    name: 'navigate',
    description:
      'Navigate a tab: goto a url (default), or back/forward/reload. Invalidates uids — snapshot again.',
    required: ['tabId'],
    optional: ['nav', 'url'],
    mutating: true,
    usage: 'navigate(tabId, url) or navigate(tabId, nav: back|forward|reload)'
  },
  {
    name: 'snapshot',
    description:
      'Accessibility snapshot of a tab: interactive elements each with a uid. REQUIRED before click/fill/type.',
    required: ['tabId'],
    optional: [],
    mutating: false,
    usage: 'snapshot(tabId)'
  },
  {
    name: 'read_page',
    description: "Read the tab's rendered content (after JavaScript) converted to Markdown.",
    required: ['tabId'],
    optional: [],
    mutating: false,
    usage: 'read_page(tabId)'
  },
  {
    name: 'screenshot',
    description: 'Capture the tab viewport as an image.',
    required: ['tabId'],
    optional: ['fullPage', 'uid'],
    mutating: false,
    usage: 'screenshot(tabId[, fullPage][, uid])'
  },
  {
    name: 'click',
    description: 'Click an element by its uid from the latest snapshot (trusted mouse event).',
    required: ['tabId', 'uid'],
    optional: [],
    mutating: true,
    usage: 'click(tabId, uid) — uid comes from the latest snapshot'
  },
  {
    name: 'fill',
    description: 'Replace the value of an input/textarea by uid, then fire input/change events.',
    required: ['tabId', 'uid', 'text'],
    optional: [],
    mutating: true,
    usage: 'fill(tabId, uid, text)'
  },
  {
    name: 'type',
    description:
      'Type text into the focused element (or focus uid first); optionally press submitKey after.',
    required: ['tabId', 'text'],
    optional: ['uid', 'submitKey'],
    mutating: true,
    usage: 'type(tabId, text[, uid][, submitKey])'
  },
  {
    name: 'press_key',
    description: 'Press a key or combo on the focused element, e.g. "Enter", "Control+A".',
    required: ['tabId', 'key'],
    optional: [],
    mutating: true,
    usage: 'press_key(tabId, key) — e.g. "Enter", "Tab", "Control+A", "Meta+Shift+R"'
  },
  {
    name: 'scroll',
    description: 'Scroll the page (or an element by uid). Default: down 500px.',
    required: ['tabId'],
    optional: ['direction', 'amount', 'uid'],
    mutating: false,
    usage: 'scroll(tabId[, direction: up|down|left|right][, amount][, uid])'
  },
  {
    name: 'evaluate',
    description: 'Run a JavaScript expression in the page and return its JSON value.',
    required: ['tabId', 'expression'],
    optional: [],
    mutating: true,
    cap: 'evaluate',
    usage: 'evaluate(tabId, expression)'
  },
  {
    name: 'wait_for',
    description: 'Poll until the given text appears in the page body (default timeout 10000ms).',
    required: ['tabId', 'text'],
    optional: ['timeout'],
    mutating: false,
    usage: 'wait_for(tabId, text[, timeout])'
  },
  {
    name: 'network',
    description: 'HTTP requests captured on this tab since automation attached.',
    required: ['tabId'],
    optional: ['limit'],
    mutating: false,
    cap: 'network',
    usage: 'network(tabId[, limit])'
  },
  {
    name: 'console',
    description: 'Console messages captured on this tab since automation attached.',
    required: ['tabId'],
    optional: ['limit'],
    mutating: false,
    cap: 'console',
    usage: 'console(tabId[, limit])'
  },
  {
    name: 'pdf',
    description: 'Export the page to a PDF file inside the session sandbox.',
    required: ['tabId', 'outputPath'],
    optional: ['pageSize', 'landscape', 'scale'],
    mutating: false,
    cap: 'pdf',
    usage: 'pdf(tabId, outputPath[, pageSize: A4|Letter|…][, landscape][, scale])'
  },
  {
    name: 'cdp',
    description:
      'Escape hatch: send a raw Chrome DevTools Protocol command (e.g. Network.getResponseBody, Emulation.setDeviceMetricsOverride). Use help(topic:"devtools") first.',
    required: ['tabId', 'method'],
    optional: ['params'],
    mutating: false, // 由 dynamicGate + classifyCdpMethod 决定审批
    dynamicGate: true,
    cap: 'rawCdp',
    usage:
      'cdp(tabId, method:"Domain.method"[, params]) — params may use {"$uid":"e7"} / {"$uidX":"e7"} / {"$uidY":"e7"} macros'
  },
  {
    name: 'events',
    description:
      'Pull buffered CDP events for domains you enabled via cdp (e.g. Network.responseReceived). Incremental via sinceSeq.',
    required: ['tabId'],
    optional: ['event', 'sinceSeq', 'limit'],
    mutating: false,
    cap: 'rawCdp',
    usage: 'events(tabId[, event:"Domain.event"][, sinceSeq][, limit])'
  }
]

/** 过滤出某端可用的操作（cap 为 false 的 op 整体剔除） */
export function opsForCaps(caps: BrowserCaps): readonly BrowserOpSpec[] {
  return BROWSER_OPS.filter((op) => !op.cap || caps[op.cap])
}
