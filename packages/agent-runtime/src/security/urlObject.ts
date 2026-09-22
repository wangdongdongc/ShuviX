/**
 * 地址 → `{type:'url'}` 客体的输入。宿主的导航门都经这里构造，策略于是总看到同一种写法：
 *  - 主机名小写、去掉结尾的点：`Example.COM.` 与 `example.com` 是同一台机器，而 URL 解析只对
 *    http(s) 这类协议做小写、从不去掉结尾的点 —— 按 host 写的规则不该被一个点绕开。
 *  - 地址里的账号口令（`https://user:pass@host/`）不进客体：客体会原样出现在询问卡片与决策日志里。
 *  - `blob:` 地址自己没有主机，它属于创建它的那个源（`URL.origin` 就是内层地址的源）——
 *    host / origin 按那个源给，按站点写的规则才管得到它。
 *  - `view-source:` / `filesystem:` 包着另一个地址（带着那个站点的登录态读它的源码 / 它的沙箱文件），
 *    客体就是里面那个地址 —— 否则它在策略眼里是个没有主机的怪协议，按站点写的规则全部落空，
 *    而按站点记账的一方（`browserSiteOf`）却会把里面的站点记成放行过。
 *
 * 只规整给策略看的这一份；真正导航去哪仍是调用方手里的原地址。解析不了时抛出（门之前应已校验）。
 *
 * `browser` 说明是哪个浏览器（应用内面板 / 用户的 Chrome），缺省 `app`。
 */
import type { UrlObjectInput } from './types'

/** 包着另一个地址的前缀 —— 剥掉之后才是真正被访问的那个 */
const WRAPPER_PREFIXES = ['view-source:', 'filesystem:'] as const

/** 剥掉 `view-source:` / `filesystem:`（可叠、大小写不敏感），回里面那个地址；没有包装原样回 */
export function innerUrlOf(raw: string): string {
  let text = raw.trim()
  for (;;) {
    const lower = text.slice(0, 16).toLowerCase()
    const prefix = WRAPPER_PREFIXES.find((p) => lower.startsWith(p))
    if (!prefix) return text
    text = text.slice(prefix.length)
  }
}

export function urlObjectOf(
  raw: string,
  browser: UrlObjectInput['browser'] = 'app'
): UrlObjectInput {
  const parsed = new URL(innerUrlOf(raw))
  parsed.username = ''
  parsed.password = ''
  const scheme = parsed.protocol.replace(/:$/, '')
  // 没有主机却有非 null 的源 = blob:（WHATWG 只给它内层地址的源）
  const inner = !parsed.hostname && parsed.origin !== 'null' ? new URL(parsed.origin) : undefined
  const site = inner ?? parsed
  const host = site.hostname.toLowerCase().replace(/\.+$/, '')
  if (!inner && host !== parsed.hostname) {
    try {
      parsed.hostname = host
    } catch {
      /* 不透明主机的协议改不了主机名：url 留原样，host / origin 仍是规整后的 */
    }
  }
  const origin =
    parsed.origin === 'null'
      ? 'null'
      : `${site.protocol.replace(/:$/, '')}://${host}${site.port ? `:${site.port}` : ''}`
  return { url: parsed.href, scheme, host, origin, browser }
}
