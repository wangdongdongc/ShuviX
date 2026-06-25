/**
 * 桌面内部事件总线单例（main 进程）。
 *
 * 放在 util 层而非 service 层：service 模块（services/widget/* 等）与 util（sessionConfigBroadcast）
 * 都要发布事件，按架构边界只能向下依赖 util，故 bus 落在这里。「bus → 所有窗口」的桥接（用到
 * BrowserWindow，属 service 级编排）见 services/appEvents.ts。见 docs/internal-events.md。
 */
import { createAppEventBus } from '@shuvix/chat-protocol/appEvents'

export const appEventBus = createAppEventBus()
