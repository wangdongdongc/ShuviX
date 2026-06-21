/**
 * CdpTransport —— CDP 命令传输的注入式端口（宿主无关）。
 *
 * 幸运的是桌面 Electron `webContents.debugger` 与扩展 `chrome.debugger` 暴露的是同一个形状：
 * `sendCommand(method, params) → Promise<result>`。所以两端适配器几乎零代码：
 *   - 桌面：{ sendCommand: (m, p) => wc.debugger.sendCommand(m, p) }
 *   - 扩展：{ sendCommand: (m, p) => chrome.debugger.sendCommand({ tabId }, m, p) }
 */
export interface CdpTransport {
  sendCommand<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>
}
