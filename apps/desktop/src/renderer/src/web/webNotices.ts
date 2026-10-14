/**
 * web 客户端的「桌面专属」提示（server mode phase C）：点了只有桌面应用能用的东西时由连接回调
 * （`wsConnection` 的 `onDesktopOnly`）记下一条，`WebStatusLayer` 订阅它浮出一句说明。同一时刻只留最新一条。
 */

export interface WebNotice {
  /** 递增的序号（同一条通道连点两次也是两条提示） */
  readonly id: number
  /** 被拒的通道 */
  readonly channel: string
}

let seq = 0
let current: WebNotice | null = null
const listeners = new Set<() => void>()

/** 一次桌面专属通道的调用被拒了：记下一条提示 */
export function notifyDesktopOnly(channel: string): void {
  current = { id: ++seq, channel }
  for (const listener of [...listeners]) listener()
}

/** 此刻最新的一条（没有 → null） */
export function currentNotice(): WebNotice | null {
  return current
}

/** 订阅提示的变化；返回注销 */
export function subscribeNotice(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
