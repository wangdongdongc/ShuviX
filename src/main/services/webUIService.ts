import { createLogger } from '../logger'

const log = createLogger('WebUI')

export type ShareMode = 'readonly' | 'chat' | 'full'

/** WebUIServer 接口（避免直接 import 造成循环依赖） */
interface WebUIServerRef {
  isRunning(): boolean
  start(port?: number): void
  stop(): void
  getPort(): number
  getAccessUrls(): string[]
}

/**
 * WebUI 分享状态管理
 * 管理哪些 session 已开启局域网分享，按需启停 HTTP 服务器
 */
class WebUIService {
  private sharedSessions = new Map<string, ShareMode>()
  private serverRef: WebUIServerRef | null = null

  /** 由 WebUIServer 初始化时调用，注册自身引用 */
  registerServer(server: WebUIServerRef): void {
    this.serverRef = server
  }

  /** 开启/关闭指定 session 的分享 */
  setShared(sessionId: string, shared: boolean, mode: ShareMode = 'readonly'): void {
    if (shared) {
      this.sharedSessions.set(sessionId, mode)
      log.info(`开启分享: session=${sessionId} mode=${mode}`)
    } else {
      this.sharedSessions.delete(sessionId)
      log.info(`关闭分享: session=${sessionId}`)
    }
    this.syncServer()
  }

  /** 查询是否已分享 */
  isShared(sessionId: string): boolean {
    return this.sharedSessions.has(sessionId)
  }

  /** 获取分享模式，未分享返回 null */
  getShareMode(sessionId: string): ShareMode | null {
    return this.sharedSessions.get(sessionId) ?? null
  }

  /** 获取所有已分享 session */
  listShared(): Array<{ sessionId: string; mode: ShareMode }> {
    return Array.from(this.sharedSessions.entries()).map(([sessionId, mode]) => ({
      sessionId,
      mode
    }))
  }

  /** 获取服务器状态 */
  getServerStatus(): { running: boolean; port?: number; urls?: string[] } {
    if (!this.serverRef || !this.serverRef.isRunning()) return { running: false }
    return {
      running: true,
      port: this.serverRef.getPort(),
      urls: this.serverRef.getAccessUrls()
    }
  }

  /** 按需启停服务器 */
  private syncServer(): void {
    if (!this.serverRef) return
    if (this.sharedSessions.size > 0 && !this.serverRef.isRunning()) {
      this.serverRef.start()
    } else if (this.sharedSessions.size === 0 && this.serverRef.isRunning()) {
      this.serverRef.stop()
    }
  }
}

/** 全局单例 */
export const webUIService = new WebUIService()
