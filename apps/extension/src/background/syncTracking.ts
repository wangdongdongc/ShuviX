/**
 * 侧边栏视图同步订阅的记账（P3-09 PIN-11）—— SW 替每个侧边栏端口记下它开着的订阅，端口断开（侧边栏关了、
 * 页面刷新了，而标签页还开着）时替它补发退订：否则桌面上这条连接的订阅一直挂着，会话一直被钉住，
 * 直到标签页关掉或整条连接断开。
 *
 * 侧边栏的同步调用是 `channel.call {path:'sync.invoke', args:[target, call]}`，`call` 是 chord 的服务控制
 * 调用（`$chord.service` 的 subscribe / unsubscribe）。SW 不引 chord（它不跑客户端）：这里只认那两种调用的
 * 线上形状，与 chord 的 `createServiceSubscribeCall` / `createServiceUnsubscribeCall` 的一致性由单测钉住。
 */

/** chord 服务控制调用的 serviceId */
const SERVICE_CONTROL_ID = '$chord.service'

/** 一次订阅 / 退订（其余调用 → undefined） */
export type SyncControl =
  | { type: 'subscribe'; subscriptionId: string; target: unknown }
  | { type: 'unsubscribe'; subscriptionId: string; target: unknown }

const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0

/** 一次 `channel.call` 的参数是不是视图同步的订阅 / 退订 */
export function syncControlOf(params: unknown): SyncControl | undefined {
  const p = params as { path?: unknown; args?: unknown } | null | undefined
  if (!p || p.path !== 'sync.invoke' || !Array.isArray(p.args)) return undefined
  const [target, call] = p.args as [unknown, unknown]
  const c = call as { serviceId?: unknown; member?: unknown; args?: unknown } | null | undefined
  if (!c || c.serviceId !== SERVICE_CONTROL_ID || !Array.isArray(c.args)) return undefined
  const subscriptionId = c.args[0]
  if (!isId(subscriptionId)) return undefined
  if (c.member === 'subscribe') return { type: 'subscribe', subscriptionId, target }
  if (c.member === 'unsubscribe') return { type: 'unsubscribe', subscriptionId, target }
  return undefined
}

/** 补发退订用的 `channel.call` 参数（与侧边栏自己退订时发的同一个形状） */
export function syncUnsubscribeParams(
  target: unknown,
  subscriptionId: string
): { path: 'sync.invoke'; args: unknown[] } {
  return {
    path: 'sync.invoke',
    args: [target, { serviceId: SERVICE_CONTROL_ID, member: 'unsubscribe', args: [subscriptionId] }]
  }
}

/** 一个端口开着的订阅：订阅 id → 目标 */
export class PortSubscriptions {
  private readonly open = new Map<string, unknown>()

  /** 看一次发往桌面的 `channel.call`：订阅记下、退订划掉 */
  observe(params: unknown): void {
    const control = syncControlOf(params)
    if (control === undefined) return
    if (control.type === 'subscribe') this.open.set(control.subscriptionId, control.target)
    else this.open.delete(control.subscriptionId)
  }

  /** 交出全部还开着的订阅并清空（端口断开时补发退订用） */
  drain(): Array<{ subscriptionId: string; target: unknown }> {
    const out = [...this.open].map(([subscriptionId, target]) => ({ subscriptionId, target }))
    this.open.clear()
    return out
  }

  /** 桌面那头的客户端已经不在了（连接断开）：记账作废，不必再退 */
  clear(): void {
    this.open.clear()
  }

  get size(): number {
    return this.open.size
  }
}
