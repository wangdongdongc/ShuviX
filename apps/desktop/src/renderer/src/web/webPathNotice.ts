/**
 * web 客户端的「服务端路径」提示（server mode phase D）—— 桌面上「在文件管理器中打开 / 显示」会在运行 ShuviX 的
 * 那台电脑上打开 Finder（浏览器里的人看不见，那台电脑前的人却会被吓一跳）。web 客户端改成把那个路径显示出来、
 * 给一个复制按钮（`WebStatusLayer` 订阅它浮出一张小卡片，用户关掉为止）。同一时刻只留最新一条。
 */

export interface WebPathNotice {
  /** 递增的序号（同一个路径点两次也是两条） */
  readonly id: number
  /** 被换掉的那条桌面通道（`app:open-folder` / `knowledge:revealFile` …） */
  readonly channel: string
  /** 服务端上的绝对路径 */
  readonly path: string
  /** 是目录（打开文件夹）还是文件（在文件夹中显示） */
  readonly target: 'folder' | 'file'
}

let seq = 0
let current: WebPathNotice | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of [...listeners]) {
    if (!listeners.has(listener)) continue
    try {
      listener()
    } catch (error) {
      console.error('[web] path notice listener failed', error)
    }
  }
}

/** 显示一条服务端路径（取代上一条） */
export function showServerPath(notice: Omit<WebPathNotice, 'id'>): void {
  current = { id: ++seq, ...notice }
  emit()
}

/** 关掉那一条（已经换成别的了 → 什么也不做） */
export function dismissServerPath(id: number): void {
  if (current?.id !== id) return
  current = null
  emit()
}

/** 此刻的那一条（没有 → null） */
export function currentServerPath(): WebPathNotice | null {
  return current
}

/** 订阅变化；返回注销 */
export function subscribeServerPath(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
