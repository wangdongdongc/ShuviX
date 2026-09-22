/**
 * 一个地址能不能交给操作系统 —— 全桌面端共用的裁决。
 *
 * `shell.openExternal` 是应用与系统之间的交接：系统按协议或文件类型挑一个已注册的程序打开它，
 * `file:///…/X.app` 就是启动那个程序，`.command` 就是让 Terminal 跑里面的命令。而想让应用走这一步
 * 的地址，很多并不是我们写的 —— 面板里的任意站点、widget 里模型写的 HTML、聊天与笔记本里模型给出
 * 的链接，都能说一句「打开这个地址」。裁决因此放在交接之前，且只此一份：
 *  - `web`    http(s)：面板新开 tab / 其余窗口交给系统浏览器。这一档不问 —— 最频繁、风险最低，
 *             天天弹只会把用户训练成闭眼点确认。
 *  - `open`   mailto:：不问，直接交给系统 —— 它只会起一封草稿。带 attach 类参数的除外（有的邮件
 *             客户端照做，把本地文件塞进草稿），改走 ask。
 *  - `refuse` 指向文件的：file:、单字母协议（Windows 盘符，`c:/…/calc.exe` 交给系统就是运行它）、
 *             网络共享（smb / afp / nfs / ftp …）—— 询问框里只有一个路径，说不清 `.app` / `.command`
 *             一打开就是运行，用户据此点确认等于没确认；浏览器内部地址（about / blob / data /
 *             javascript …，离开页面毫无意义）；解析不了的。
 *  - `ask`    其余协议（别的应用的 URL scheme）：原生询问框写明地址，用户点了才交给系统。
 *
 * 交给系统的是裁决时解析出的规范化地址（`URL.href`），不是原串 —— 被判的就是被打开的。
 * 本文件不依赖 electron；询问框、shell.openExternal 与各窗口的接线都在 gate.ts。
 *
 * 实测（Electron 39）哪些路径会走到这里：**弹窗**（`window.open` / `target=_blank`）一律经过窗口的
 * setWindowOpenHandler，且不需要用户手势；自定义协议、mailto、`about:blank`（`window.open()` 与
 * `javascript:` 弹窗到这里都是它）、`data:`、`blob:` 都到得了，正显示本地文件的页面还能弹 `file:`。
 * 页面**导航**到非网页协议则由 Electron 以 `openExternal` 权限去问会话的权限处理器（见 gate.ts）。
 */

export type ExternalOpenDecision =
  | { action: 'web'; url: string }
  | { action: 'open'; url: string }
  | { action: 'ask'; url: string }
  | { action: 'refuse'; reason: 'unparsable' | 'file' | 'internal' }

const WEB_SCHEMES = new Set(['http:', 'https:'])

/** 不问就交给系统的协议 */
const OPEN_WITHOUT_ASKING = new Set(['mailto:'])

/** 指向文件的协议（本地或网络共享）：一律拒绝，不问。单字母的盘符另判 */
const FILE_SCHEMES = new Set([
  'file:',
  'smb:',
  'cifs:',
  'afp:',
  'nfs:',
  'ftp:',
  'ftps:',
  'sftp:',
  'webdav:',
  'webdavs:',
  'dav:',
  'davs:'
])

/** 浏览器内部的地址：离开页面没有意义，交给系统也没有应用能接 */
const INTERNAL_SCHEMES = new Set([
  'about:',
  'blob:',
  'data:',
  'javascript:',
  'view-source:',
  'filesystem:',
  'chrome:',
  'chrome-untrusted:',
  'chrome-extension:',
  'devtools:'
])

/** 裁决一个弹窗目标地址；`url` 字段是之后真正要用的规范化地址 */
export function externalOpenDecision(raw: string): ExternalOpenDecision {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { action: 'refuse', reason: 'unparsable' }
  }
  const scheme = url.protocol
  if (WEB_SCHEMES.has(scheme)) return { action: 'web', url: url.href }
  // protocol 带冒号，长度 2 就是单字母协议 —— Windows 盘符
  if (FILE_SCHEMES.has(scheme) || scheme.length === 2) return { action: 'refuse', reason: 'file' }
  if (INTERNAL_SCHEMES.has(scheme)) return { action: 'refuse', reason: 'internal' }
  if (OPEN_WITHOUT_ASKING.has(scheme) && !carriesAttachment(url)) {
    return { action: 'open', url: url.href }
  }
  return { action: 'ask', url: url.href }
}

const ATTACH_PARAM = /[?&;#]\s*attach/i

/**
 * mailto 里有没有 attach / attachment 类参数。宁可多问一次：参数名按 URLSearchParams 读
 * （大小写、百分号编码、`+` 都不算数），整条地址再按「先解码、后切分」的客户端读一遍
 * （`%3Fattach=`、`;attach=`、`#?attach=` 这类写法）。
 */
function carriesAttachment(url: URL): boolean {
  for (const name of url.searchParams.keys()) {
    if (/^\s*attach/i.test(name)) return true
  }
  let decoded = url.href
  try {
    decoded = decodeURIComponent(url.href)
  } catch {
    // 残缺的 % 转义：只按原串读
  }
  return ATTACH_PARAM.test(url.href) || ATTACH_PARAM.test(decoded)
}

/** 用户拒绝一次之后，这段时间内的询问请求直接拒绝 */
export const DECLINE_QUIET_MS = 10_000

/**
 * 给 `ask` 裁决套上节流：同一时刻至多一个询问，弹着时再来的请求直接拒绝（不排队）；
 * 用户拒绝（或询问本身失败）后 `quietMs` 内的请求也直接拒绝，不再调 confirm。
 * 一份节流管所有窗口 —— 模态框压住的是窗口，按来源各算各的等于没算。
 *
 * 弹窗不要用户手势，页面可以在循环里 window.open：排队就是点完一个取消又来一个；拒绝后立刻重弹，
 * 窗口就一直被模态框压着，连关掉那个页面的空当都没有。用户自己点出来的那一档（渲染进程经
 * `app:open-external` 递过来的）传 `quietMs: 0`：它没有循环触发的可能，而「刚点过取消所以这次点击
 * 静默失效」只会让人以为界面坏了。返回的函数不会 reject。
 */
export function createExternalOpenAsk<T>(
  confirm: (request: T) => Promise<boolean>,
  opts: { now?: () => number; quietMs?: number } = {}
): (request: T) => Promise<boolean> {
  const now = opts.now ?? ((): number => Date.now())
  const quietMs = opts.quietMs ?? DECLINE_QUIET_MS
  let asking = false
  let quietUntil = 0
  return async (request) => {
    if (asking || now() < quietUntil) return false
    asking = true
    let allowed = false
    try {
      allowed = (await confirm(request)) === true
    } catch {
      // 询问框本身失败：按拒绝处理
    } finally {
      asking = false
    }
    if (!allowed) quietUntil = now() + quietMs
    return allowed
  }
}

/** 询问框与日志里的地址截断：data: 与自定义协议的地址可以有几 MB */
export function clipUrl(url: string, max = 300): string {
  return url.length > max ? `${url.slice(0, max)}…` : url
}
