/**
 * 浏览器里的 `window.api`（server mode phase C / D）—— 与桌面 preload 同一张通道表、同一个 `buildApi`，只是传输换成
 * WebSocket（`wsConnection.ts`），宿主自己的 override 换成：`app.platform = 'web'`、视图同步渠道走同一条 socket。
 *
 * 只有桌面能用的通道（`DESKTOP_ONLY_CHANNELS`：开窗、系统文件管理器、原生对话框 —— 服务端对网络客户端一律拒掉）
 * 在浏览器里有本地实现，不走到服务端（phase D，docs/server/phase-d-web-fallbacks.md §D3）：
 *
 *  - `app:open-settings(tab?)` → 新标签页里开 `#settings/<tab>`（同一个页面，按 hash 渲染设置面板）；
 *  - `app:open-external(url)` → 新标签页里开那个地址（只认 http / https / mailto，其余回 `success:false`）；
 *  - `files:open` → 新标签页里开 `#file-preview?…`（只读预览；md 也在那里只读渲染 —— 协作编辑窗口仍只在桌面）；
 *  - `widgetWindow:open` → 新标签页里开 `#widget-window?widgetId=…`（widget 经网络服务的 `/w/` 转发）；
 *  - `dialog:openDirectory` / `skill:pickExternalDir` → 页面里的目录浏览器（列的是服务端的目录）；
 *  - `app:open-folder` / `app:reveal-path` / `widget:revealExport` → 显示那个服务端路径、给一个复制按钮；
 *    `*:openFolder` / `knowledge:revealFile` 先经 `fs:locateFolder` 问到路径，再同样显示。
 *
 * 剩下的（`pinChat:pin` / `pinChat:focus` / `browser-view:open-window` / `browser-view:open-settings` /
 * `widget:pickExportTarget`）浏览器里没有
 * 对应的东西：入口在 web 上是藏起来的，万一被调到就当场拒绝并给一条看得见的提示（不悄悄假装成功）。
 */
import { API_TABLE, DESKTOP_ONLY_CHANNELS } from '../../../shared/apiTable'
import { buildApi, createCommonOverrides, type WebApi } from '../../../shared/buildApi'
import type { ServerFolderKind } from '../../../shared/serverFs'
import { filePreviewPageUrl, widgetPageUrl } from '../host/hostUrls'
import { requestDirectoryPick } from './webDirectoryPick'
import { showServerPath, type WebPathNotice } from './webPathNotice'
import type { WsConnection } from './wsConnection'

/** 本地实现要的那一点浏览器（`window` 满足它；单测给假的） */
export interface WebWindowLike {
  readonly location: { readonly origin: string; readonly pathname: string }
  open(url: string, target?: string, features?: string): unknown
}

/** 本地实现要的另外几样（缺省：本页的提示 / 目录浏览器；`invoke` 没给 → 要问服务端的那几条失败） */
export interface WebLocalDeps {
  /** 经网络调一条（非桌面专属的）请求通道 —— 问路径用（`fs:locateFolder`） */
  readonly invoke?: (channel: string, ...args: unknown[]) => Promise<unknown>
  /** 显示一个服务端路径（缺省：`webPathNotice` 的那张卡片） */
  readonly showPath?: (notice: Omit<WebPathNotice, 'id'>) => void
  /** 页面里选一个服务端目录（缺省：`webDirectoryPick` + `WebDirectoryPicker`）；取消 → null */
  readonly pickDirectory?: () => Promise<string | null>
}

/** 外链只放这几种协议（`javascript:` 之类不碰） */
const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

/** 「在文件管理器中打开」的那几条无参通道 → `fs:locateFolder` 的 kind */
export const WEB_FOLDER_CHANNELS: Readonly<Record<string, ServerFolderKind>> = {
  'subAgent:openFolder': 'agents',
  'policy:openFolder': 'policies',
  'hook:openFolder': 'hooks',
  'bot:openFolder': 'bots',
  'knowledge:openFolder': 'knowledge'
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0

/** 浏览器里本地实现的请求通道 */
export function webLocalHandlers(
  win: WebWindowLike,
  deps: WebLocalDeps = {}
): Record<string, (...args: unknown[]) => unknown> {
  const showPath = deps.showPath ?? showServerPath
  const pickDirectory = deps.pickDirectory ?? (() => requestDirectoryPick())

  /** 问服务端某条通道打开的是哪个路径；问不到（含断线、服务端出错）→ null —— 与桌面那几条一样从不拒绝 */
  const locate = async (params: unknown): Promise<string | null> => {
    if (!deps.invoke) return null
    try {
      const reply = (await deps.invoke('fs:locateFolder', params)) as { path?: unknown } | undefined
      return isNonEmptyString(reply?.path) ? reply.path : null
    } catch {
      return null
    }
  }

  /** 显示一个已知的路径（参数就是路径的那几条） */
  const showGiven =
    (channel: string, target: 'folder' | 'file') =>
    (path: unknown): { success: boolean } => {
      if (!isNonEmptyString(path)) return { success: false }
      showPath({ channel, path, target })
      return { success: true }
    }

  const handlers: Record<string, (...args: unknown[]) => unknown> = {
    'app:open-settings': (tab) => {
      const hash = typeof tab === 'string' && tab.length > 0 ? `#settings/${tab}` : '#settings'
      win.open(`${win.location.origin}${win.location.pathname}${hash}`, '_blank')
      return { success: true }
    },
    'app:open-external': (url) => {
      let parsed: URL
      try {
        parsed = new URL(String(url))
      } catch {
        return { success: false }
      }
      if (!EXTERNAL_PROTOCOLS.has(parsed.protocol)) return { success: false }
      win.open(parsed.href, '_blank', 'noopener,noreferrer')
      return { success: true }
    },
    'files:open': (params) => {
      const p = params as { sessionId?: unknown; path?: unknown; openedBy?: unknown } | undefined
      if (!isNonEmptyString(p?.sessionId) || !isNonEmptyString(p?.path)) return false
      win.open(
        filePreviewPageUrl(win.location, {
          sessionId: p.sessionId,
          path: p.path,
          openedBy: p.openedBy === 'agent' ? 'agent' : 'user'
        }),
        '_blank'
      )
      return true
    },
    'widgetWindow:open': (id) => {
      if (!isNonEmptyString(id)) return { success: false, error: 'missing widget id' }
      win.open(widgetPageUrl(win.location, id), '_blank')
      return { success: true }
    },
    'dialog:openDirectory': () => pickDirectory(),
    'skill:pickExternalDir': async () => {
      const path = await pickDirectory()
      return path ? { success: true, path } : { success: false, reason: 'canceled' }
    },
    'app:open-folder': showGiven('app:open-folder', 'folder'),
    'app:reveal-path': showGiven('app:reveal-path', 'file'),
    'widget:revealExport': (zipPath) => {
      showGiven('widget:revealExport', 'file')(zipPath)
      return { success: true }
    },
    'knowledge:revealFile': async (params) => {
      const entry = (params as { path?: unknown } | undefined)?.path
      if (!isNonEmptyString(entry)) return { success: false }
      const path = await locate({ kind: 'knowledgeEntry', path: entry })
      if (path === null) return { success: false }
      showPath({ channel: 'knowledge:revealFile', path, target: 'file' })
      return { success: true }
    }
  }
  for (const [channel, kind] of Object.entries(WEB_FOLDER_CHANNELS)) {
    handlers[channel] = async () => {
      const path = await locate({ kind })
      if (path === null) return { success: false }
      showPath({ channel, path, target: 'folder' })
      return { success: true }
    }
  }
  return handlers
}

/** 浏览器里当场拒绝的通道（桌面专属、又没有本地实现的那些） */
export function webDesktopOnlyChannels(local: Readonly<Record<string, unknown>>): Set<string> {
  return new Set(
    Object.keys(DESKTOP_ONLY_CHANNELS).filter((channel) => !Object.hasOwn(local, channel))
  )
}

/** 由连接建出浏览器里的 `window.api` */
export function createWebApi(connection: WsConnection): WebApi {
  return buildApi(API_TABLE, connection.transport, {
    ...createCommonOverrides(connection.transport),
    app: { platform: 'web' as const },
    sync: connection.sync
  })
}
