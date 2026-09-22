/**
 * 地址 → `{type:'url'}` 客体的输入。宿主的导航门都经这里构造，策略于是总看到同一种写法：
 *  - 主机名小写、去掉结尾的点：`Example.COM.` 与 `example.com` 是同一台机器，而 URL 解析只对
 *    http(s) 这类协议做小写、从不去掉结尾的点 —— 按 host 写的规则不该被一个点绕开。
 *  - 地址里的账号口令（`https://user:pass@host/`）不进客体：客体会原样出现在询问卡片与决策日志里。
 *  - `blob:` 地址自己没有主机，它属于创建它的那个源（`URL.origin` 就是内层地址的源）——
 *    host / origin 按那个源给，按站点写的规则才管得到它。
 *
 * 只规整给策略看的这一份；真正导航去哪仍是调用方手里的原地址。解析不了时抛出（门之前应已校验）。
 *
 * `browser` 说明是哪个浏览器（应用内面板 / 用户的 Chrome），缺省 `app`。
 */
import type { UrlObjectInput } from './types'

export function urlObjectOf(
  raw: string,
  browser: UrlObjectInput['browser'] = 'app'
): UrlObjectInput {
  const parsed = new URL(raw)
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
