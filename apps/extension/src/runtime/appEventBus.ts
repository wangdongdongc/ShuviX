/**
 * 扩展内部事件总线 —— 进程内单例（前端与后端同一对象，零序列化）。
 *
 * 后端(工具/服务)经 appEventBus.publish 发布 AppEvent；chatApiAdapter.events.subscribe 直接订阅同一 bus，
 * UI 经 useAppEvent 消费。见 docs/internal-events.md。
 */
import { createAppEventBus } from '@shuvix/chat-protocol/appEvents'

export const appEventBus = createAppEventBus()
