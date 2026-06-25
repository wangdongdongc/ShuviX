/**
 * 桌面内部事件总线 —— main 进程 appEventBus + 转发到所有渲染窗口（'app:event' IPC）。
 *
 * 后端服务/工具经 appEventBus.publish 发布 AppEvent：进程内订阅者直接收到；同时桥接广播到
 * 主窗 + 悬浮窗（各自独立 Zustand），渲染层经 preload events.subscribe → useAppEvent 消费。
 * 与 agent:event 的转发对称。见 docs/internal-events.md。
 */
import { BrowserWindow } from 'electron'
import { appEventBus } from '../utils/appEventBus'

/** 安装「bus → 所有窗口」桥接（在 app ready、窗口体系就绪后调用一次） */
export function registerAppEventBridge(): void {
  appEventBus.subscribe((event) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('app:event', event)
    }
  })
}
