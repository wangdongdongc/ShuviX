/**
 * BrowserBackend —— 统一浏览器自动化的后端契约（宿主无关）。
 *
 * 桌面（Electron 内嵌 WebContentsView 面板）与扩展（chrome.* 操作用户真实标签页）
 * 各自实现本接口；内置 browser MCP server（mcpServer.ts）只面向该契约分发。
 * 端差异用 BrowserCaps 表达：cap 为 false 的工具 / 参数不出现在工具表与描述里。
 */
/** 端能力开关：false 的工具 / 参数不进工具表、描述与 cdp_recipes */
export interface BrowserCaps {
  /** 导出 PDF（桌面：printToPDF + 准入落盘；扩展无落盘语义） */
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
  /**
   * 给文件 input 设本地文件（upload_file）。桌面 true；扩展 false —— 它的工作区是 OPFS /
   * 文件夹句柄，模型手里没有可以交给 DOM.setFileInputFiles 的本机路径。
   */
  upload: boolean
}

/** pdf 认得的纸张（Chromium printToPDF 的命名尺寸）；server 在过写路径门之前就校验 */
export const PDF_PAGE_SIZES = [
  'A0',
  'A1',
  'A2',
  'A3',
  'A4',
  'A5',
  'A6',
  'Legal',
  'Letter',
  'Tabloid',
  'Ledger'
] as const
export type PdfPageSize = (typeof PDF_PAGE_SIZES)[number]
/** pdf 的 scale 范围（printToPDF 超出即抛错） */
export const PDF_SCALE_RANGE = { min: 0.1, max: 2 } as const

/**
 * backend 方法的统一返回。mcpServer.ts 负责包成 MCP 的工具结果。
 * details.error 置位 = 业务失败（不抛错，让 agent 读到错误信息后改道）。
 */
export interface BrowserOpOutput {
  text?: string
  /** 内联图片（扩展 screenshot）；桌面截图落盘只回 text 路径 */
  images?: Array<{ data: string; mimeType: string }>
  /** 附加字段（url / elementCount / error 等）；error 置位 = 这次没做成 */
  details?: Record<string, unknown>
}

export type NavKind = 'goto' | 'back' | 'forward' | 'reload'
export type ScrollDirection = 'up' | 'down' | 'left' | 'right'

export interface BrowserBackend {
  readonly caps: BrowserCaps
  listTabs(): Promise<BrowserOpOutput>
  /**
   * 这个 tab 此刻显示的地址（没有这个 tab → undefined）。**无副作用**：不激活、不 attach。
   * server 用它把「在一个显示本地文件的 tab 上做任何事」都当成读那个文件 —— 页面自己导航过去的
   * （点了链接、被 evaluate 改了 location）也逃不过路径门。宿主不实现 = 不做这层检查（给了 site
   * 门的宿主必须实现）。**问不到就抛**，别回 undefined：undefined 的意思是「没有这个 tab」，门据此
   * 放行、让操作自己失败；问不到时放行就是不设门。
   */
  tabUrl?(p: { tabId: string }): Promise<string | undefined>
  /** 新标签页打开 URL，回显新 tabId */
  openTab(p: { url: string }): Promise<BrowserOpOutput>
  closeTab(p: { tabId: string }): Promise<BrowserOpOutput>
  navigate(p: { tabId: string; nav: NavKind; url?: string }): Promise<BrowserOpOutput>
  /**
   * full=true 时强制回全量；否则由 backend 决定是否回差异（见 cdp/snapshotDiff.ts）。
   * viewer：看这份快照的是谁（调用方 agent）—— 差异的基线按它分开存。
   */
  snapshot(p: { tabId: string; full?: boolean; viewer?: string }): Promise<BrowserOpOutput>
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
  /** 鼠标移到元素上（菜单 / tooltip） */
  hover(p: { tabId: string; uid: string }): Promise<BrowserOpOutput>
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
  /** 给文件 input 设文件；paths 已是过了安全门的绝对路径（cap: upload） */
  uploadFile?(p: { tabId: string; uid: string; paths: string[] }): Promise<BrowserOpOutput>
  /** outputPath 已过写路径门；pageSize / scale 已由 server 校验（见 PDF_PAGE_SIZES） */
  pdf?(p: {
    tabId: string
    outputPath: string
    pageSize?: PdfPageSize
    landscape?: boolean
    scale?: number
  }): Promise<BrowserOpOutput>
}
