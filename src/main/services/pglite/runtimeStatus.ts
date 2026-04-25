/**
 * SQL 运行时状态管理（原由 pluginRegistry 集中缓存，拆除后各模块自行维护）
 *
 * - 在 worker ready / destroy 时调用 setSqlRuntimeReady/Destroyed，向 renderer
 *   广播 runtime_event；同时写入内存 map 供 DefaultChatGateway 查询 sessionId 下的活跃运行时
 */

import { chatFrontendRegistry } from '../../frontend/core/ChatFrontendRegistry'
import type { RuntimeStatus } from '../../frontend/core/types'
import type { SqlStorageMode } from './workerManager'

const RUNTIME_ID = 'sql'

const statuses = new Map<string, RuntimeStatus>()

function buildStatus(storageMode: SqlStorageMode): RuntimeStatus {
  return {
    label: 'Postgres',
    icon: 'Database',
    color: '#3b82f6',
    description: storageMode === 'persistent' ? 'persistent' : 'memory'
  }
}

export function setSqlRuntimeReady(sessionId: string, storageMode: SqlStorageMode): void {
  const status = buildStatus(storageMode)
  statuses.set(sessionId, status)
  chatFrontendRegistry.broadcast({
    type: 'runtime_event',
    sessionId,
    runtimeId: RUNTIME_ID,
    status
  })
}

export function setSqlRuntimeDestroyed(sessionId: string): void {
  if (!statuses.has(sessionId)) return
  statuses.delete(sessionId)
  chatFrontendRegistry.broadcast({
    type: 'runtime_event',
    sessionId,
    runtimeId: RUNTIME_ID,
    status: null
  })
}

export function getSqlRuntimeStatus(sessionId: string): RuntimeStatus | undefined {
  return statuses.get(sessionId)
}
