/**
 * BrowserBackend —— 统一浏览器自动化的后端契约（宿主无关）。
 *
 * 桌面（Electron 内嵌 WebContentsView 面板）与扩展（chrome.* 操作用户真实标签页）
 * 各自实现本接口；上层 multiplex `browser` 工具（tool.ts）只面向该契约分发。
 * 端差异用 BrowserCaps 表达：cap 为 false 的操作不出现在工具 schema / 手册里。
 */
import type { InputRequest, InputResponse } from '@shuvix/chat-protocol/types/inputRequest'

/** 端能力开关：false 的 op / 参数不进 schema、description、help */
export interface BrowserCaps {
  /** 导出 PDF（桌面：printToPDF + 沙箱落盘；扩展无落盘语义） */
  pdf: boolean
  /** 全页截图（视口外内容；桌面经 Emulation + capturePage） */
  fullPageScreenshot: boolean
  /** 元素级截图（--uid 裁剪） */
  elementScreenshot: boolean
  /** 截图落盘返回路径（桌面，需 read 工具查看）；false = 内联图片返回（扩展）。只影响 help 文案 */
  screenshotToFile: boolean
  /** 执行任意 JS（策略上可关） */
  evaluate: boolean
  /** 捕获 HTTP 请求 */
  network: boolean
  /** 捕获 console 消息 */
  console: boolean
  /** 原生 CDP 逃生口（cdp / events action）；两端 CDP 传输均支持 → 恒 true */
  rawCdp: boolean
}

/**
 * backend 方法的统一返回。tool.ts 负责包成 AgentToolResult<BrowserToolDetails>。
 * details.error 置位 = 业务失败（不抛错，让 agent 读到错误信息后改道）。
 */
export interface BrowserOpOutput {
  text?: string
  /** 内联图片（扩展 screenshot）；桌面截图落盘只回 text 路径 */
  images?: Array<{ data: string; mimeType: string }>
  /** 合并进 BrowserToolDetails 的附加字段（url / elementCount / error 等） */
  details?: Record<string, unknown>
}

export type NavKind = 'goto' | 'back' | 'forward' | 'reload'
export type ScrollDirection = 'up' | 'down' | 'left' | 'right'

export interface BrowserBackend {
  readonly caps: BrowserCaps
  listTabs(): Promise<BrowserOpOutput>
  /** 新标签页打开 URL，回显新 tabId */
  openTab(p: { url: string }): Promise<BrowserOpOutput>
  closeTab(p: { tabId: string }): Promise<BrowserOpOutput>
  navigate(p: { tabId: string; nav: NavKind; url?: string }): Promise<BrowserOpOutput>
  snapshot(p: { tabId: string }): Promise<BrowserOpOutput>
  readPage(p: { tabId: string }): Promise<BrowserOpOutput>
  screenshot(p: { tabId: string; fullPage?: boolean; uid?: string }): Promise<BrowserOpOutput>
  click(p: { tabId: string; uid: string }): Promise<BrowserOpOutput>
  fill(p: { tabId: string; uid: string; text: string }): Promise<BrowserOpOutput>
  type(p: {
    tabId: string
    text: string
    uid?: string
    submitKey?: string
  }): Promise<BrowserOpOutput>
  pressKey(p: { tabId: string; key: string }): Promise<BrowserOpOutput>
  scroll(p: {
    tabId: string
    direction?: ScrollDirection
    amount?: number
    uid?: string
  }): Promise<BrowserOpOutput>
  waitFor(p: {
    tabId: string
    text: string
    timeout?: number
    /** 轮询间隙检查；aborted 时提前返回（tool 层随后按 abortError 抛出终止） */
    signal?: AbortSignal
  }): Promise<BrowserOpOutput>
  // ── caps 对应的可选方法（cap=false 时可不实现） ──
  evaluate?(p: { tabId: string; expression: string }): Promise<BrowserOpOutput>
  network?(p: { tabId: string; limit?: number }): Promise<BrowserOpOutput>
  console?(p: { tabId: string; limit?: number }): Promise<BrowserOpOutput>
  /** 原生 CDP 逃生口：发一条命令（method 已由 tool 层分类/门控，backend 只负责解析宏 + 发送 + 落盘） */
  cdp?(p: {
    tabId: string
    method: string
    params?: Record<string, unknown>
  }): Promise<BrowserOpOutput>
  /** 增量拉取事件缓冲 */
  events?(p: {
    tabId: string
    event?: string
    sinceSeq?: number
    limit?: number
  }): Promise<BrowserOpOutput>
  pdf?(p: {
    tabId: string
    outputPath: string
    pageSize?: string
    landscape?: boolean
    scale?: number
  }): Promise<BrowserOpOutput>
}

/** 逐操作审批依赖（gate.ts 消费；与 ask 工具同一 requestUserInput 通道） */
export interface BrowserApprovalDeps {
  /** 会话级自动批准开关：开 → 直接放行；关 → 每次 mutating 操作前弹审批 */
  isAutoApprove: () => boolean
  /** 挂起/恢复审批（桌面 IPC InputRequest / 扩展 RuntimeSession）；cancel → 中止本轮 */
  requestUserInput: (req: InputRequest) => Promise<InputResponse>
}
