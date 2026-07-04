import type { ChatEvent } from '@shuvix/chat-protocol/events'
import type { ChatFrontend, ChatFrontendCapabilities } from './ChatFrontend'
import { createLogger } from '../../logger'

const log = createLogger('ChatFrontend')

/** 需要 streaming 能力的事件类型 */
const STREAMING_EVENT_TYPES = new Set(['text_delta', 'thinking_delta', 'image_data'])

/** 事件类型 → 所需能力映射 */
const INTERACTION_CAPABILITY_MAP: Partial<
  Record<ChatEvent['type'], keyof ChatFrontendCapabilities>
> = {
  input_request: 'userInput'
}

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
   * 能力感知广播：发给该会话的所有绑定前端，按能力过滤
   *
   * 路由规则：
   * - text_delta / thinking_delta / image_data → 仅 streaming=true 的前端
   * - input_request → 仅 userInput=true 的前端
   * - 其他事件 → 所有绑定前端
   */
  broadcast(event: ChatEvent): void {
    const frontends = this.getFrontends(event.sessionId)

    // 子会话事件统一带 sessionId=subSessionId；会话级绑定的前端（如 WebUI 只绑父会话）据此收不到。
    // 故额外把子会话事件送达「父会话」绑定的前端：register/end 自带 parentSessionId（并维护 sub→parent
    // 映射），其余流式事件经该映射回溯。默认前端（Electron 主窗）本就收全部，去重后不重复发。
    const parentSessionId = this.resolveSubSessionParent(event)
    if (parentSessionId) {
      for (const pf of this.getFrontends(parentSessionId)) {
        if (!frontends.some((f) => f.id === pf.id)) frontends.push(pf)
      }
    }

    const isStreaming = STREAMING_EVENT_TYPES.has(event.type)
    const requiredCap = INTERACTION_CAPABILITY_MAP[event.type]

    for (const frontend of frontends) {
      // 清理已断开的前端
      if (!frontend.isAlive()) {
        this.pruneDeadFrontend(frontend.id)
        continue
      }
      // streaming 事件过滤
      if (isStreaming && !frontend.capabilities.streaming) continue
      // 交互请求能力过滤
      if (requiredCap && !frontend.capabilities[requiredCap]) continue

      try {
        frontend.sendEvent(event)
      } catch (err) {
        log.warn(`发送事件失败 frontend=${frontend.id}: ${err}`)
      }
    }
  }

  /**
   * 维护 sub→parent 映射并返回某事件对应的父会话；非子会话事件返回 null。
   * register 自带 parentSessionId → 记下映射；end → 返回父会话并清理映射；
   * 其余事件（流式 delta / 工具 / 步骤等只带 subSessionId）经映射回溯父会话。
   */
  private resolveSubSessionParent(event: ChatEvent): string | null {
    if (event.type === 'sub_session_register') {
      this.subToParent.set(event.sessionId, event.parentSessionId)
      return event.parentSessionId
    }
    if (event.type === 'sub_session_end') {
      const parent = event.parentSessionId
      this.subToParent.delete(event.sessionId)
      return parent
    }
    return this.subToParent.get(event.sessionId) ?? null
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
