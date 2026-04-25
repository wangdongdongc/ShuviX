/**
 * Python 运行时状态管理（原由 pluginRegistry 集中缓存，拆除后各模块自行维护）
 */

import { chatFrontendRegistry } from '../../frontend/core/ChatFrontendRegistry'
import type { RuntimeStatus } from '../../frontend/core/types'

const RUNTIME_ID = 'python'
const STATUS: RuntimeStatus = { label: 'Python', icon: 'Code', color: '#eab308' }

const statuses = new Map<string, RuntimeStatus>()

export function setPythonRuntimeReady(sessionId: string): void {
  statuses.set(sessionId, STATUS)
  chatFrontendRegistry.broadcast({
    type: 'runtime_event',
    sessionId,
    runtimeId: RUNTIME_ID,
    status: STATUS
  })
}

export function setPythonRuntimeDestroyed(sessionId: string): void {
  if (!statuses.has(sessionId)) return
  statuses.delete(sessionId)
  chatFrontendRegistry.broadcast({
    type: 'runtime_event',
    sessionId,
    runtimeId: RUNTIME_ID,
    status: null
  })
}

export function getPythonRuntimeStatus(sessionId: string): RuntimeStatus | undefined {
  return statuses.get(sessionId)
}
