/**
 * Chrome 标签页会话的形态判定 —— 桌面与扩展共用的一份。
 *
 * 用户在某个 Chrome 标签页上打开 ShuviX 侧边栏，桌面就为这个标签页开一条会话（`settings.chromeTab`）。
 * 它是一条**普通会话**：无项目（落在临时工作区）、根档案由形态推出基座 `tab`，于是模型、询问、
 * 压缩、导出这些会话该有的一切都天然成立。与普通会话的差别只有三处：
 *
 *  - **不进列表**：侧栏、日历都看不到它 —— 它是那个标签页的临时对话，不是用户的一条会话记录；
 *  - **寿命跟着标签页**：标签页关掉就删；浏览器重启后标签页 id 全换，上一轮留下的一并清掉；
 *  - **只有它能操作用户的 Chrome**（内置能力 `chrome` 只由 `tab` 档案声明）；桌面自己的会话
 *    只用应用内的浏览器面板。
 *
 * 判定一律走这里，别在各处手写 `!!settings.chromeTab`：字段不全的算「不是」。
 */

/** 会话挂着的那个标签页 —— 创建那一刻定死 */
export interface ChromeTabBinding {
  /** 扩展安装 id（区分不同浏览器 / profile；跨浏览器重启不变） */
  installId: string
  /** 浏览器这一轮运行的 id（浏览器重启即换 —— 标签页 id 只在一轮运行内有意义） */
  runId: string
  /** Chrome 的标签页 id */
  tabId: number
}

/** 判定所需的最小字段（SessionSettings 是它的超集） */
export interface ChromeTabSessionShape {
  chromeTab?: unknown
}

/** 会话挂着的标签页；不是标签页会话则为 undefined */
export function chromeTabOf(settings?: ChromeTabSessionShape | null): ChromeTabBinding | undefined {
  const raw = settings?.chromeTab
  if (!raw || typeof raw !== 'object') return undefined
  const { installId, runId, tabId } = raw as Record<string, unknown>
  if (typeof installId !== 'string' || !installId) return undefined
  if (typeof runId !== 'string' || !runId) return undefined
  // Chrome 的 tabs.TAB_ID_NONE 是 -1（不是标签页的上下文，如 devtools 窗口）—— 负数都不是标签页
  if (typeof tabId !== 'number' || !Number.isInteger(tabId) || tabId < 0) return undefined
  return { installId, runId, tabId }
}

/** 这是不是一条 Chrome 标签页会话 */
export function isChromeTabSessionSettings(settings?: ChromeTabSessionShape | null): boolean {
  return !!chromeTabOf(settings)
}
