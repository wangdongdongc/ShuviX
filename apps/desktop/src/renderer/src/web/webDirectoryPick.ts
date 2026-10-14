/**
 * web 客户端的「选择文件夹」（server mode phase D）—— 原生的选择框弹在运行 ShuviX 的那台电脑上；浏览器里改用页面里
 * 的目录浏览器（`WebDirectoryPicker`，一层一层地问服务端的 `fs:listDirectories`）。这里是它与调用方之间的小仓库：
 * `requestDirectoryPick()` 挂起一次选择（回选中的绝对路径，取消 → null），浏览器组件订阅它、选完调 `settle`。
 * 同一时刻只有一次：再来一次时上一次按取消结束。
 */

export interface DirectoryPickRequest {
  /** 递增的序号 */
  readonly id: number
  /** 从哪个目录开始（不给 → 服务端的主目录） */
  readonly startPath?: string
}

interface Pending extends DirectoryPickRequest {
  readonly resolve: (path: string | null) => void
}

let seq = 0
let pending: Pending | null = null
/** 交给订阅者的快照（不带 resolve；同一次选择是同一个对象 —— useSyncExternalStore 要求快照稳定） */
let snapshot: DirectoryPickRequest | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of [...listeners]) {
    if (!listeners.has(listener)) continue
    try {
      listener()
    } catch (error) {
      console.error('[web] directory pick listener failed', error)
    }
  }
}

/** 挂起一次选择：回选中的绝对路径，取消 → null */
export function requestDirectoryPick(startPath?: string): Promise<string | null> {
  const previous = pending
  return new Promise((resolve) => {
    const id = ++seq
    snapshot = typeof startPath === 'string' && startPath ? { id, startPath } : { id }
    pending = { ...snapshot, resolve }
    previous?.resolve(null)
    emit()
  })
}

/** 结束那一次选择（已经不是它了 → 什么也不做）：给路径 = 选中，null = 取消 */
export function settleDirectoryPick(id: number, path: string | null): void {
  if (pending?.id !== id) return
  const done = pending
  pending = null
  snapshot = null
  done.resolve(path)
  emit()
}

/** 此刻挂着的那一次（没有 → null） */
export function currentDirectoryPick(): DirectoryPickRequest | null {
  return snapshot
}

/** 订阅变化；返回注销 */
export function subscribeDirectoryPick(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
