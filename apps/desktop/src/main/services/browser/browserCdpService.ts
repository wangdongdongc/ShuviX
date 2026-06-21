/**
 * BrowserCdpService — CDP 会话管理 + A11y UID 映射 + 网络/控制台事件收集
 *
 * 单例服务，通过 Electron 的 webContents.debugger API 操作浏览器面板的 WebContentsView。
 * 懒 attach：首次自动化操作时自动连接，面板销毁时自动释放。
 */

import type { WebContents } from 'electron'
import { CdpController, type CdpTransport } from '@shuvix/agent-runtime'
import { getBrowserView } from './browserViewService'
import { createLogger } from '../../logger'

const log = createLogger('BrowserCDP')

// ====== CDP 类型 ======

// A11y 快照 / UID 映射已下沉 @shuvix/agent-runtime（CdpController），此处再导出兼容既有引用
export type { AXNode } from '@shuvix/agent-runtime'

/** 网络请求条目 */
export interface NetworkEntry {
  id: string
  url: string
  method: string
  status?: number
  mimeType?: string
  timestamp: number
  completed: boolean
  failed: boolean
  size?: number
}

/** 控制台消息条目 */
export interface ConsoleEntry {
  id: number
  type: string // log, error, warn, info, debug
  text: string
  url?: string
  lineNumber?: number
  timestamp: number
}

// ====== 常量 ======

const CDP_VERSION = '1.3'
const MAX_NETWORK_ENTRIES = 200
const MAX_CONSOLE_ENTRIES = 200

// ====== 服务 ======

class BrowserCdpService {
  private attached = false
  private webContents: WebContents | null = null

  // A11y 快照 / UID / 坐标解析等可移植内核（注入 webContents.debugger 传输）
  private controller: CdpController | null = null

  // 网络/控制台
  private networkEnabled = false
  private consoleEnabled = false
  private networkEntries: NetworkEntry[] = []
  private networkMap = new Map<string, NetworkEntry>() // requestId → entry
  private consoleEntries: ConsoleEntry[] = []
  private consoleCounter = 0

  // CDP message 监听器引用（用于移除）
  private messageHandler:
    | ((_event: unknown, method: string, params: Record<string, unknown>) => void)
    | null = null
  private detachHandler: (() => void) | null = null

  // ====== 生命周期 ======

  /** 确保 debugger 已连接，返回 webContents */
  ensureAttached(): WebContents {
    if (this.attached && this.webContents) return this.webContents

    const view = getBrowserView()
    if (!view) {
      throw new Error('Browser panel is not open. Use action="open" first.')
    }

    const wc = view.webContents
    try {
      wc.debugger.attach(CDP_VERSION)
    } catch (err) {
      // 可能已 attach（其他地方先调用了），忽略 "Already attached"
      if (!(err instanceof Error) || !err.message.includes('Already attached')) {
        throw new Error(`Failed to attach CDP debugger: ${(err as Error).message}`)
      }
    }

    this.attached = true
    this.webContents = wc

    // 可移植内核：注入 webContents.debugger 作为 CdpTransport
    const transport: CdpTransport = {
      sendCommand: (method, params) => wc.debugger.sendCommand(method, params)
    }
    this.controller = new CdpController(transport)

    // 监听 CDP 事件（网络/控制台）
    this.messageHandler = (_event, method, params) => this.onCdpMessage(method, params)
    wc.debugger.on('message', this.messageHandler)

    // 监听 debugger 断开（页面崩溃、面板销毁等）
    this.detachHandler = () => this.onDetach()
    wc.debugger.on('detach', this.detachHandler)

    log.info('CDP debugger attached')
    return wc
  }

  /** 断开 debugger 并重置所有状态 */
  detach(): void {
    if (this.webContents && this.attached) {
      try {
        if (this.messageHandler) {
          this.webContents.debugger.off('message', this.messageHandler)
        }
        if (this.detachHandler) {
          this.webContents.debugger.off('detach', this.detachHandler)
        }
        this.webContents.debugger.detach()
      } catch {
        // 可能已 detach，忽略
      }
    }
    this.resetState()
    log.info('CDP debugger detached')
  }

  isAttached(): boolean {
    return this.attached
  }

  private onDetach(): void {
    log.info('CDP debugger detached externally')
    this.resetState()
  }

  private resetState(): void {
    this.attached = false
    this.webContents = null
    this.messageHandler = null
    this.detachHandler = null
    // UID（下沉到 controller）
    this.controller?.reset()
    this.controller = null
    // 网络/控制台
    this.networkEnabled = false
    this.consoleEnabled = false
    this.networkEntries = []
    this.networkMap.clear()
    this.consoleEntries = []
    this.consoleCounter = 0
  }

  // ====== CDP 命令 ======

  async sendCommand<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    const wc = this.ensureAttached()
    return wc.debugger.sendCommand(method, params) as Promise<T>
  }

  // ====== A11y 快照 + UID（委托共享 CdpController） ======

  /** 确保已 attach 并返回 controller */
  private requireController(): CdpController {
    this.ensureAttached()
    return this.controller!
  }

  /** 生成 A11y 快照，构建 UID 映射，返回格式化文本 */
  async buildSnapshot(): Promise<{ text: string; elementCount: number }> {
    return this.requireController().buildSnapshot(this.webContents?.getURL() || '')
  }

  /** 将 UID 解析为页面中的 (x, y) 中心坐标 */
  async resolveCoordinates(uid: string): Promise<{ x: number; y: number }> {
    return this.requireController().resolveCoordinates(uid)
  }

  /** Focus 元素（用于 fill/type） */
  async focusElement(uid: string): Promise<void> {
    return this.requireController().focusElement(uid)
  }

  /** 在元素上执行 JS 函数 */
  async callOnElement<T>(uid: string, fn: string): Promise<T> {
    return this.requireController().callOnElement<T>(uid, fn)
  }

  /** 取某 uid 对应的 AX 节点（供动作生成描述） */
  getNode(uid: string): import('@shuvix/agent-runtime').AXNode | undefined {
    return this.controller?.getNode(uid)
  }

  // ====== 网络收集 ======

  async enableNetworkCapture(): Promise<void> {
    if (this.networkEnabled) return
    this.ensureAttached()
    await this.sendCommand('Network.enable')
    this.networkEnabled = true
    log.info('Network capture enabled')
  }

  getNetworkRequests(): NetworkEntry[] {
    return this.networkEntries
  }

  clearNetworkRequests(): void {
    this.networkEntries = []
    this.networkMap.clear()
  }

  // ====== 控制台收集 ======

  async enableConsoleCapture(): Promise<void> {
    if (this.consoleEnabled) return
    this.ensureAttached()
    await this.sendCommand('Runtime.enable')
    this.consoleEnabled = true
    log.info('Console capture enabled')
  }

  getConsoleMessages(): ConsoleEntry[] {
    return this.consoleEntries
  }

  clearConsoleMessages(): void {
    this.consoleEntries = []
    this.consoleCounter = 0
  }

  // ====== CDP 事件分发 ======

  private onCdpMessage(method: string, params: Record<string, unknown>): void {
    // 网络
    if (method === 'Network.requestWillBeSent') {
      const reqId = params.requestId as string
      const req = params.request as { url: string; method: string }
      const entry: NetworkEntry = {
        id: reqId,
        url: req.url,
        method: req.method,
        timestamp: params.timestamp as number,
        completed: false,
        failed: false
      }
      this.networkMap.set(reqId, entry)
      this.networkEntries.push(entry)
      if (this.networkEntries.length > MAX_NETWORK_ENTRIES) {
        const removed = this.networkEntries.shift()!
        this.networkMap.delete(removed.id)
      }
    } else if (method === 'Network.responseReceived') {
      const reqId = params.requestId as string
      const entry = this.networkMap.get(reqId)
      if (entry) {
        const resp = params.response as { status: number; mimeType: string }
        entry.status = resp.status
        entry.mimeType = resp.mimeType
      }
    } else if (method === 'Network.loadingFinished') {
      const reqId = params.requestId as string
      const entry = this.networkMap.get(reqId)
      if (entry) {
        entry.completed = true
        entry.size = (params.encodedDataLength as number) || 0
      }
    } else if (method === 'Network.loadingFailed') {
      const reqId = params.requestId as string
      const entry = this.networkMap.get(reqId)
      if (entry) {
        entry.completed = true
        entry.failed = true
      }
    }

    // 控制台
    if (method === 'Runtime.consoleAPICalled') {
      const args = params.args as Array<{ type: string; value?: unknown; description?: string }>
      const text = args
        .map((a) => (a.value != null ? String(a.value) : a.description || ''))
        .join(' ')
      const stackTrace = params.stackTrace as
        | { callFrames: Array<{ url: string; lineNumber: number }> }
        | undefined
      const frame = stackTrace?.callFrames?.[0]
      this.consoleEntries.push({
        id: ++this.consoleCounter,
        type: params.type as string,
        text,
        url: frame?.url,
        lineNumber: frame?.lineNumber,
        timestamp: params.timestamp as number
      })
      if (this.consoleEntries.length > MAX_CONSOLE_ENTRIES) {
        this.consoleEntries.shift()
      }
    } else if (method === 'Runtime.exceptionThrown') {
      const details = params.exceptionDetails as {
        text: string
        exception?: { description?: string }
        lineNumber?: number
        url?: string
      }
      this.consoleEntries.push({
        id: ++this.consoleCounter,
        type: 'error',
        text: details.exception?.description || details.text,
        url: details.url,
        lineNumber: details.lineNumber,
        timestamp: params.timestamp as number
      })
      if (this.consoleEntries.length > MAX_CONSOLE_ENTRIES) {
        this.consoleEntries.shift()
      }
    }
  }
}

export const browserCdpService = new BrowserCdpService()
