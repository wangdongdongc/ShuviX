/**
 * 浏览器窗口停靠区（页面下方）的数据形状 —— 主进程（services/browser/agentDevtools.ts、devtoolsDock.ts）
 * 与浏览器窗口外壳（components/browser/BrowserDevtoolsDock.tsx）共用。
 *
 * 停靠区两个页签（2026-10-21 用户裁定）：
 *  - `devtools`：原生 Chromium DevTools（与 Chrome 同一份前端），主进程挂一个原生 view 在那块矩形上；
 *  - `agent`：agent 的 devtool —— agent 在这一页上的 devtool 调用记录，外加它手里的网络 / 控制台采集缓冲原样。
 * 停靠区只由用户打开（快捷键、⋮ 菜单、右键「检查」、提示条），agent 的动作从不打开它。
 */

export type DevtoolsDockPanel = 'devtools' | 'agent'

/** 一个 tab 的停靠区状态（没打开 = 没有这一项） */
export interface DevtoolsDockState {
  panel: DevtoolsDockPanel
}

/** 记进调用记录的工具：读页面运行时 / 网络 / 控制台、直接发 CDP 的那几个 */
export const AGENT_DEVTOOLS_TOOLS = ['evaluate', 'network', 'console', 'cdp', 'events'] as const
export type AgentDevtoolsTool = (typeof AGENT_DEVTOOLS_TOOLS)[number]

/** 调用记录的一行 */
export interface AgentDevtoolsCall {
  /** 进程内单调递增（行的 key） */
  id: number
  tool: AgentDevtoolsTool
  sessionId: string
  /** 会话标题（读的时候现查；查不到是空串） */
  sessionTitle: string
  /** 开始时刻（ms） */
  startedAt: number
  /** 一行能看懂的摘要：cdp 的方法名、evaluate 的表达式首行、network / console 的 limit …… */
  summary: string
  /** 参数（不含 tabId），缩进好的 JSON；太长截断 */
  params: string
  /** 还在跑 = 没有 */
  durationMs?: number
  /** 还在跑 = 没有；false = 没做成（agent 收到的是错误） */
  ok?: boolean
  /** 调用方放弃了（取消 / 超时）—— agent 什么也没收到 */
  aborted?: boolean
  /** agent 收到的文字（还在跑 = 没有）；太长截断 */
  result?: string
  /** result 被截断时的原始字符数 */
  resultTruncatedFrom?: number
}

/** agent 的网络采集里的一条（与 agent 的 network 工具读到的同一份） */
export interface AgentNetworkRow {
  /** requestId —— agent 拿它调 cdp Network.getResponseBody */
  id: string
  url: string
  method: string
  status?: number
  mimeType?: string
  completed: boolean
  failed: boolean
  /** 传输字节数（完成后才有） */
  size?: number
}

/** agent 的控制台采集里的一条（与 agent 的 console 工具读到的同一份） */
export interface AgentConsoleRow {
  id: number
  /** log / error / warning / info / debug … */
  type: string
  text: string
  url?: string
  lineNumber?: number
  /** ms */
  timestamp: number
}

/** 停靠区「Agent」页签一次要的全部内容 */
export interface AgentDevtoolsSnapshot {
  calls: AgentDevtoolsCall[]
  /** agent 此刻接着这一页（CDP）—— 没接着时两份采集都是空的 */
  attached: boolean
  /** agent 开了哪种采集（它第一次调 network / console 才开） */
  capturing: { network: boolean; console: boolean }
  network: AgentNetworkRow[]
  console: AgentConsoleRow[]
}
