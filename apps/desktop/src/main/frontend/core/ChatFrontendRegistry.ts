import type { ChatEvent } from '@shuvix/chat-protocol/events'
import type { ChatFrontend, ChatFrontendCapabilities } from './ChatFrontend'
import { createLogger } from '../../logger'

const log = createLogger('ChatFrontend')

/**
 * 聊天前端注册中心 — 会话级绑定 + 能力感知广播
 *
 * 绑定模型：
 * - 默认前端（registerDefault）：自动绑定到所有会话
 * - 会话级额外绑定（bind）：仅接收指定会话的事件
 */
export class ChatFrontendRegistry {
  /** 默认前端：自动绑定到所有会话（如 Electron 主窗口） */
  private defaultFrontends = new Map<string, ChatFrontend>()
  /** 会话级额外绑定：sessionId → (frontendId → ChatFrontend) */
  private sessionBindings = new Map<string, Map<string, ChatFrontend>>()
  /** 子会话 → 父会话 映射（register 时建立、end 时清理），供子会话事件回溯送达父会话绑定的前端 */
  private subToParent = new Map<string, string>()

  /** 注册默认前端（绑定到所有现有和未来的会话），同 id 覆盖 */
  registerDefault(frontend: ChatFrontend): void {
    this.defaultFrontends.set(frontend.id, frontend)
    log.info(`注册默认前端: ${frontend.id}`)
  }

  /** 为指定会话绑定额外前端 */
  bind(sessionId: string, frontend: ChatFrontend): void {
    let map = this.sessionBindings.get(sessionId)
    if (!map) {
      map = new Map()
      this.sessionBindings.set(sessionId, map)
    }
    map.set(frontend.id, frontend)
    log.info(`绑定前端: ${frontend.id} → session=${sessionId}`)
  }

  /** 解除指定会话的某前端绑定 */
  unbind(sessionId: string, frontendId: string): void {
    const map = this.sessionBindings.get(sessionId)
    if (map) {
      map.delete(frontendId)
      if (map.size === 0) this.sessionBindings.delete(sessionId)
    }
    log.info(`解绑前端: ${frontendId} ← session=${sessionId}`)
  }

  /** 注销前端（从默认列表 + 所有会话绑定中移除） */
  unregister(frontendId: string): void {
    this.defaultFrontends.delete(frontendId)
    for (const [sessionId, map] of this.sessionBindings) {
      map.delete(frontendId)
      if (map.size === 0) this.sessionBindings.delete(sessionId)
    }
    log.info(`注销前端: ${frontendId}`)
  }

  /** 获取指定会话的所有生效前端（默认 + 额外绑定），去重 */
  getFrontends(sessionId: string): ChatFrontend[] {
    const result = new Map<string, ChatFrontend>()
    for (const [id, frontend] of this.defaultFrontends) {
      result.set(id, frontend)
    }
    const sessionMap = this.sessionBindings.get(sessionId)
    if (sessionMap) {
      for (const [id, frontend] of sessionMap) {
        result.set(id, frontend)
      }
    }
    return Array.from(result.values())
  }

  /** 检查指定会话是否有支持某能力的存活前端 */
  hasCapability(sessionId: string, cap: keyof ChatFrontendCapabilities): boolean {
    return this.getFrontends(sessionId).some((f) => f.isAlive() && f.capabilities[cap])
  }

  /**
   * 广播：发给该会话的所有存活绑定前端（P3-08 起不再按能力过滤 —— 剩下的都是余项事件，内容与询问
   * 走视图同步，每个前端都该收到全部余项）。
   */
  broadcast(event: ChatEvent): void {
    const frontends = this.getFrontends(event.sessionId)

    // 子会话事件统一带 sessionId=subSessionId；会话级绑定的前端（只绑父会话）据此收不到。
    // 故额外把子会话事件送达「父会话」绑定的前端：register/end 自带 parentSessionId（并维护 sub→parent
    // 映射），其余事件（生命周期等）经该映射回溯。默认前端（Electron 主窗）本就收全部，去重后不重复发。
    const parentSessionId = this.resolveSubSessionParent(event)
    if (parentSessionId) {
      for (const pf of this.getFrontends(parentSessionId)) {
        if (!frontends.some((f) => f.id === pf.id)) frontends.push(pf)
      }
    }

    for (const frontend of frontends) {
      // 清理已断开的前端
      if (!frontend.isAlive()) {
        this.pruneDeadFrontend(frontend.id)
        continue
      }
      try {
        frontend.sendEvent(event)
      } catch (err) {
        log.warn(`发送事件失败 frontend=${frontend.id}: ${err}`)
      }
    }
  }

  /**
   * 维护 sub→parent 映射并返回某事件对应的**根会话**；非派生 agent 事件返回 null。
   * register 自带 parentSessionId → 记下映射；end → 返回根会话并清理映射；
   * 其余事件（流式 delta / 工具 / 步骤等只带派生 agentId）经映射回溯。
   * 嵌套派生时 parentSessionId 可能本身是派生 agent —— 沿映射链上溯到根会话
   * （只有根会话有前端绑定）。
   */
  private resolveSubSessionParent(event: ChatEvent): string | null {
    if (event.type === 'sub_session_register') {
      this.subToParent.set(event.sessionId, event.parentSessionId)
      return this.walkToRoot(event.parentSessionId)
    }
    if (event.type === 'sub_session_end') {
      const root = this.walkToRoot(event.parentSessionId)
      this.subToParent.delete(event.sessionId)
      return root
    }
    const parent = this.subToParent.get(event.sessionId)
    return parent != null ? this.walkToRoot(parent) : null
  }

  /** 沿 sub→parent 映射上溯到第一个不在映射里的 id（即根会话；带环保护） */
  private walkToRoot(sessionId: string): string {
    let current = sessionId
    const seen = new Set<string>()
    while (this.subToParent.has(current) && !seen.has(current)) {
      seen.add(current)
      current = this.subToParent.get(current)!
    }
    return current
  }

  /** 清理已断开的前端（从默认列表 + 所有会话绑定中移除） */
  private pruneDeadFrontend(frontendId: string): void {
    this.defaultFrontends.delete(frontendId)
    for (const [sessionId, map] of this.sessionBindings) {
      map.delete(frontendId)
      if (map.size === 0) this.sessionBindings.delete(sessionId)
    }
    log.info(`清理已断开前端: ${frontendId}`)
  }
}

/** 全局单例 */
export const chatFrontendRegistry = new ChatFrontendRegistry()
