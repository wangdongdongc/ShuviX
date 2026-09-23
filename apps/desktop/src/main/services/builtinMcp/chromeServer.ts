/**
 * 内置能力服务器 `chrome` 的**桌面接线** —— 用户真实的 Chrome，经 ShuviX 扩展执行。
 *
 * 与 `browser`（应用内浏览器面板）是同一份 server（agent-runtime `browser/mcpServer.ts`），差别只在
 * 注入：后端经桥转发到扩展（chromeBridge），门按「这是用户自己的、登录着的浏览器」来设：
 *
 *  - **按站点问**（site 门）：在一个显示网页的标签页上做任何事之前，按它此刻所在的站点过
 *    `{type:'url', browser:'chrome'}` 客体 —— 出厂策略 ask-on-new-site 据此每个站点每条会话问一次。
 *    用户随消息带上的标签页所在的站点不问（见 chromeBridge/siteGrants）：带上它就是在问它。
 *    会话挂着的那一页**不**因为「是它」就放行 —— 它会变：agent 点了个链接、页面自己跳走了，
 *    就已经不是用户打开侧边栏时问的那一页了。
 *  - **导航**同一个客体过门（用户带上过的站点同样不问）；`file://` 按读那个本地路径（现有的路径
 *    策略自动生效）。
 *  - **本地文件交给网页、决定下载落在哪**：一律拒绝。upload_file / pdf 不在工具表上（caps 关着 ——
 *    扩展的 chrome.debugger 下 `DOM.setFileInputFiles` 本就回 "Not allowed"），但原生 cdp 里等价的
 *    方法还在，不给门 = 不设门，所以这里要给一道「不」。
 *
 * **只有 Chrome 标签页会话带它**（基座档案 `tab` 在 shuvix-tools 里声明）：普通会话的扩展能力
 * 选择里看不到它 —— 桌面自己的会话只用应用内的浏览器面板（产品裁决：应用与扩展走两条路）。
 */
import { fileURLToPath } from 'url'
import {
  browserSiteOf,
  createBrowserMcpServerFactory,
  createBrowserTabQueue,
  urlObjectOf,
  type BrowserGateContext,
  type BrowserMcpGates,
  type BuiltinMcpFactory,
  type EnforceOpts
} from '@shuvix/agent-runtime'
import { chromeTabOf } from '@shuvix/chat-protocol/chromeTabSession'
import { sessionRecords } from '../sessionRecords'
import { chromeBrowserState, createChromeBrowserBackend, isSiteGranted } from '../chromeBridge'
import { getDesktopSecurityContext, TOOL_ABORTED } from '../toolContext'
import type { DesktopBuiltinMcpScope } from './types'

/** `mcp_servers.name`，也是工具名前缀（`mcp__chrome__click`） */
export const CHROME_MCP_SERVER_NAME = 'chrome'

/** 接在 list_tabs 描述后面：这是谁的浏览器、对话挂在哪一页、操作会留下什么 */
const CHROME_HOST_NOTE =
  "These are the user's real Chrome tabs, signed in as the user. This conversation is attached to one of them — the tab the user opened the ShuviX side panel on; it is listed first, and each user message names the tabs the user selected. The sites of the tabs the user sent are already allowed; the first time you open or work on any other site in this conversation, the user is asked. Reading a tab (list_tabs, read_page) leaves no trace; operating one (snapshot, click, type, screenshot, …) attaches a debugger and shows a banner in Chrome until your turn ends. Tabs you open go into this conversation's tab group, in the background. Tab ids are Chrome's numeric tab ids."

function chromeGates(scope: DesktopBuiltinMcpScope): BrowserMcpGates {
  const security = (): ReturnType<typeof getDesktopSecurityContext> =>
    getDesktopSecurityContext({
      sessionId: scope.sessionId,
      requestUserInput: scope.requestUserInput
    })
  const enforceOpts = (ctx: BrowserGateContext, displayPath?: string): EnforceOpts => ({
    toolCallId: ctx.toolCallId,
    toolName: ctx.toolName,
    description: ctx.description,
    displayPath,
    abortError: TOOL_ABORTED,
    missingChannel: 'deny'
  })
  const enforceTarget = async (url: string, ctx: BrowserGateContext): Promise<void> => {
    const parsed = new URL(url) // server 已校验过是绝对地址
    if (parsed.protocol === 'file:') {
      let path: string
      try {
        path = fileURLToPath(parsed)
      } catch {
        throw new Error(`"${url}" does not name a file on this machine.`)
      }
      await security().enforcePath('read', path, enforceOpts(ctx, path))
      return
    }
    await security().enforceUrl(urlObjectOf(url, 'chrome'), enforceOpts(ctx))
  }

  /** 用户随消息带上过这个站点的标签页：带上它就是在问它 */
  const granted = (url: string): boolean => isSiteGranted(scope.sessionId, browserSiteOf(url))

  return {
    async navigate(url, ctx) {
      if (granted(url)) return
      await enforceTarget(url, ctx)
    },
    async site(url, ctx) {
      if (granted(url)) return
      await enforceTarget(url, ctx)
    },
    async fileRead() {
      throw new Error('Local files cannot be handed to a page in the user’s Chrome.')
    },
    async fileWrite() {
      throw new Error('ShuviX does not choose where the user’s Chrome saves files.')
    }
  }
}

/** 不是标签页会话（不该发生：只有 `tab` 档案声明它）时的队列 —— 后端随后会拒绝每个操作 */
const orphanTabQueue = createBrowserTabQueue()

export function createChromeMcpServerFactory(): BuiltinMcpFactory<DesktopBuiltinMcpScope> {
  return createBrowserMcpServerFactory<DesktopBuiltinMcpScope>((scope) => {
    const binding = chromeTabOf(sessionRecords.pickSettings(scope.sessionId, ['chromeTab']))
    return {
      serverName: CHROME_MCP_SERVER_NAME,
      backend: createChromeBrowserBackend(scope.sessionId),
      gates: chromeGates(scope),
      hostNote: CHROME_HOST_NOTE,
      // 同一个浏览器里的标签页属于那个浏览器 —— 各会话的 server 共用它的队列
      tabQueue: binding ? chromeBrowserState(binding.installId).tabQueue : orphanTabQueue
    }
  })
}
