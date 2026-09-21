/**
 * 内置能力服务器 `browser` 的**桌面接线** —— server 本体在 agent-runtime（两端共用），
 * 这里只给出两样宿主才知道的东西：后端（主窗口内嵌的浏览器面板）与安全门。
 *
 * 安全门把浏览器的几类本地访问接回现成的路径策略，而不是另起一套：
 *  - 打开 `file://…` 就是读那个文件 → enforcePath('read')。ask-on-read / protect-credentials /
 *    protect-system 于是自动覆盖「用浏览器打开 ~/.ssh/id_rsa」这条路。
 *  - 上传给网页的文件是「离开本机」的读 → enforcePath('read')，询问卡片写明要交给网页。
 *  - pdf 的输出位置是写 → enforcePath('write')。今天之前这里是硬编码的「工作区外直接拒绝」
 *    （工作区里则静默写），现在与 write 工具同一套：出厂的 ask-on-write 对每一次写都问，
 *    会话开了免询问就不问，写到系统目录 / 凭据目录则照旧拒绝。
 *  - http(s) 等其余地址上报 `{type:'url'}` 客体。出厂没有任何 url 策略（no policy = allow），
 *    这道门的意义是让用户能写「某个域名要问 / 禁止」。
 *
 * 相对路径按会话工作目录解析，**绝对路径也要 resolve**：路径策略按段前缀比较，不归一化的话
 * `/ws/../../Users/me/.ssh/id_rsa` 会被当成「在工作目录内」（与 ssh 传输同一个坑）。
 */
import { statSync } from 'fs'
import { isAbsolute, resolve as resolvePath } from 'path'
import { fileURLToPath } from 'url'
import {
  createBrowserMcpServerFactory,
  createBrowserTabQueue,
  urlObjectOf,
  type BrowserGateContext,
  type BrowserMcpGates,
  type BuiltinMcpFactory,
  type EnforceOpts
} from '@shuvix/agent-runtime'
import { createDesktopBrowserBackend } from '../browser'
import { getDesktopSecurityContext, resolveProjectConfig, TOOL_ABORTED } from '../toolContext'
import type { DesktopBuiltinMcpScope } from './types'

/** 接在 list_tabs 描述后面：这是谁的浏览器、tab 与登录会不会留着 */
const DESKTOP_HOST_NOTE =
  "This is ShuviX's own browser — the Browser panel in the app window, with a cookie jar separate from the user's everyday browser. It is shared across the app and persistent: tabs stay open and sign-ins survive between conversations, so reuse a tab that is already where you need it rather than signing in again."

function desktopGates(scope: DesktopBuiltinMcpScope): BrowserMcpGates {
  const security = (): ReturnType<typeof getDesktopSecurityContext> =>
    getDesktopSecurityContext({
      sessionId: scope.sessionId,
      requestUserInput: scope.requestUserInput
    })
  const toAbsolute = (p: string): string => {
    const cwd = resolveProjectConfig(scope.sessionId).workingDirectory
    return resolvePath(isAbsolute(p) ? p : resolvePath(cwd, p))
  }
  const enforceOpts = (ctx: BrowserGateContext, displayPath?: string): EnforceOpts => ({
    toolCallId: ctx.toolCallId,
    toolName: ctx.toolName,
    description: ctx.description,
    displayPath,
    abortError: TOOL_ABORTED,
    missingChannel: 'deny'
  })

  return {
    async navigate(url, ctx) {
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
      await security().enforceUrl(urlObjectOf(url), enforceOpts(ctx))
    },

    async fileRead(path, ctx) {
      const abs = toAbsolute(path)
      await security().enforcePath('read', abs, enforceOpts(ctx, path))
      // 放行之后再查存在：不存在的路径交给 DOM.setFileInputFiles，页面会收到一个空文件而不报错
      let isFile = false
      try {
        isFile = statSync(abs).isFile()
      } catch {
        /* 不存在 */
      }
      if (!isFile) throw new Error(`No such file: ${path}`)
      return abs
    },

    async fileWrite(path, ctx) {
      const abs = toAbsolute(path)
      await security().enforcePath('write', abs, enforceOpts(ctx, path))
      return abs
    }
  }
}

/** 浏览器面板的 tab 是全 app 共享的 —— 各会话的 server 共用这一条按 tab 的队列 */
const browserTabQueue = createBrowserTabQueue()

/** 键名 `browser` 见 builtinMcp/index.ts；后端每会话一个（open/close 广播与落盘路径都要 sessionId） */
export function createDesktopBrowserMcpServerFactory(): BuiltinMcpFactory<DesktopBuiltinMcpScope> {
  return createBrowserMcpServerFactory<DesktopBuiltinMcpScope>((scope) => ({
    backend: createDesktopBrowserBackend(scope.sessionId),
    gates: desktopGates(scope),
    hostNote: DESKTOP_HOST_NOTE,
    tabQueue: browserTabQueue
  }))
}
