/**
 * 用户随消息带上的标签页所在的站点 —— 这条会话里用户**亲手指过**的站点。
 *
 * 侧边栏的每条消息都带着一排标签页芯片（缺省是本标签页）：带上一个标签页，就是在问它。它此刻所在
 * 的站点于是记为这条会话已经同意的站点，`chrome` 的站点门与导航门遇到它都不再问。其余站点 ——
 * agent 自己打开的、页面自己跳过去的 —— 每条会话第一次用到时问一次（出厂策略 ask-on-new-site）。
 *
 * 为什么不是「会话挂着的那个标签页一律放行」：那个页会变。agent 在上面点了个链接、页面自己跳去了
 * 别的站点，那已经不是用户打开侧边栏时问的那一页了。
 *
 * 只记站点（`browserSiteOf` 的写法），按会话；会话删掉（标签页关了）时清掉。只在进程内存里 ——
 * 桌面重启之后，侧边栏的下一条消息会再带上。
 */
const grants = new Map<string, Set<string>>()

export function grantSite(sessionId: string, site: string): void {
  let set = grants.get(sessionId)
  if (!set) {
    set = new Set()
    grants.set(sessionId, set)
  }
  set.add(site)
}

export function isSiteGranted(sessionId: string, site: string | undefined): boolean {
  return !!site && !!grants.get(sessionId)?.has(site)
}

export function forgetSiteGrants(sessionId: string): void {
  grants.delete(sessionId)
}
