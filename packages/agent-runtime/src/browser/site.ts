/**
 * 「站点」的写法 —— 按站点过门时的记账键，server 与宿主（Chrome 的授权记录）共用这一份。
 *
 * 站点 = 网页的 host，**就是 url 客体（`urlObjectOf`）里的那个 host**：小写、去掉结尾的点；协议与
 * 端口不算（`http://a.com:8080` 与 `https://a.com` 是同一个站点 —— 登录态按 host 走）。直接从客体
 * 取而不是另写一遍解析：记账的键与策略看到的主机必须是同一个，差一点就是「策略没问、账却记成放行」。
 *
 * 几种「看上去不是网页、其实是某个站点」的地址按它里面那个站点算（客体已经这样规整）：
 *  - `blob:https://x/…`：同源文档，带着 x 的登录态 —— 属于创建它的那个源；
 *  - `view-source:https://x/…`：带着 x 的登录态读出来的源码；
 *  - `filesystem:https://x/…`：x 的沙箱文件系统。
 *
 * 其余地址（about:blank、data:、chrome://、扩展页、file:、没有源的 blob:）没有站点，回 undefined ——
 * 站点门不管它们（本地文件另有路径门）。出厂策略 ask-on-new-site 的匹配条件与这里同一个口径。
 */
import { urlObjectOf } from '../security/urlObject'

/** 有站点可言的协议（剥掉 view-source: / filesystem: 之后） */
const SITE_SCHEMES: ReadonlySet<string> = new Set(['http', 'https', 'blob'])

export function browserSiteOf(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  let object: ReturnType<typeof urlObjectOf>
  try {
    object = urlObjectOf(raw)
  } catch {
    return undefined
  }
  if (!SITE_SCHEMES.has(object.scheme)) return undefined
  return object.host || undefined
}
