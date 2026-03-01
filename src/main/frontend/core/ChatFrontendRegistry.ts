import type { ChatEvent } from './types'
import type { ChatFrontend, ChatFrontendCapabilities } from './ChatFrontend'
import { createLogger } from '../../logger'

const log = createLogger('ChatFrontend')

/** 交互请求超时（5 分钟） */
export const INTERACTION_TIMEOUT_MS = 5 * 60 * 1000

/** 需要 streaming 能力的事件类型 */
const STREAMING_EVENT_TYPES = new Set(['text_delta', 'thinking_delta', 'image_data'])

/** 事件类型 → 所需能力映射 */
const INTERACTION_CAPABILITY_MAP: Partial<
  Record<ChatEvent['type'], keyof ChatFrontendCapabilities>
> = {
  tool_approval_request: 'toolApproval',
  user_input_request: 'userInput',
  ssh_credential_request: 'sshCredentials'
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
   * - tool_approval_request → 仅 toolApproval=true 的前端
   * - user_input_request → 仅 userInput=true 的前端
   * - ssh_credential_request → 仅 sshCredentials=true 的前端
   * - 其他事件 → 所有绑定前端
   */
  broadcast(event: ChatEvent): void {
    const frontends = this.getFrontends(event.sessionId)
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
