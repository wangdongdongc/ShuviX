import type { BrowserWindow } from 'electron'
import type { ChatFrontend, ChatFrontendCapabilities, ChatEvent } from '../core'

/** Electron BrowserWindow 前端实现（通过 IPC 'agent:event' 通道发送） */
export class ElectronFrontend implements ChatFrontend {
  readonly id = 'electron-main'
  readonly capabilities: ChatFrontendCapabilities = {
    streaming: true,
    toolApproval: true,
    userInput: true,
    sshCredentials: true
  }

  constructor(private window: BrowserWindow) {}

  sendEvent(event: ChatEvent): void {
    if (!this.window.isDestroyed()) {
      this.window.webContents.send('agent:event', event)
    }
  }

  isAlive(): boolean {
    return !!this.window && !this.window.isDestroyed()
  }
}
