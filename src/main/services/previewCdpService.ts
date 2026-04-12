/**
 * PreviewCdpService — CDP 会话管理 + A11y UID 映射 + 网络/控制台事件收集
 *
 * 单例服务，通过 Electron 的 webContents.debugger API 操作预览面板的 WebContentsView。
 * 懒 attach：首次自动化操作时自动连接，面板销毁时自动释放。
 */

import type { WebContents } from 'electron'
import { getPreviewView } from './previewViewService'
import { createLogger } from '../logger'

const log = createLogger('PreviewCDP')

// ====== CDP 类型 ======

/** CDP Accessibility.getFullAXTree 返回的节点 */
export interface AXNode {
  nodeId: string
  backendDOMNodeId?: number
  role?: { type: string; value: string }
  name?: { type: string; value: string }
  properties?: Array<{ name: string; value: { type: string; value: unknown } }>
  childIds?: string[]
  ignored?: boolean
}

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

/** 过滤掉的无意义角色 */
const IGNORED_ROLES = new Set(['none', 'generic', 'InlineTextBox', 'LineBreak'])

// ====== 服务 ======

class PreviewCdpService {
  private attached = false
  private webContents: WebContents | null = null

  // UID 系统
  private uidCounter = 0
  private uidMap = new Map<string, number>() // uid → backendDOMNodeId
  private backendIdToUid = new Map<number, string>() // backendDOMNodeId → uid（反向）
  private nodeMap = new Map<string, AXNode>() // uid → AXNode

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

    const view = getPreviewView()
    if (!view) {
      throw new Error('Preview panel is not open. Use action="open" first.')
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
    // UID
    this.uidCounter = 0
    this.uidMap.clear()
    this.backendIdToUid.clear()
    this.nodeMap.clear()
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

  // ====== A11y 快照 + UID ======

  /** 生成 A11y 快照，构建 UID 映射，返回格式化文本 */
  async buildSnapshot(): Promise<{ text: string; elementCount: number }> {
    const result = await this.sendCommand<{ nodes: AXNode[] }>('Accessibility.getFullAXTree')
    const nodes = result.nodes

    // 建立 nodeId → AXNode 索引
    const nodeById = new Map<string, AXNode>()
    for (const node of nodes) {
      nodeById.set(node.nodeId, node)
    }

    // 找到根节点（第一个节点通常是根）
    const root = nodes[0]
    if (!root) return { text: '(empty page)', elementCount: 0 }

    // 清理旧 UID（保留 backendDOMNodeId 仍存在的）
    const seenBackendIds = new Set<number>()
    for (const node of nodes) {
      if (node.backendDOMNodeId != null) {
        seenBackendIds.add(node.backendDOMNodeId)
      }
    }
    for (const [uid, backendId] of this.uidMap) {
      if (!seenBackendIds.has(backendId)) {
        this.uidMap.delete(uid)
        this.backendIdToUid.delete(backendId)
        this.nodeMap.delete(uid)
      }
    }

    // 递归格式化
    let elementCount = 0
    const lines: string[] = []

    const format = (node: AXNode, depth: number): void => {
      // 跳过 ignored 和无意义角色
      if (node.ignored) {
        // 但仍递归子节点
        for (const childId of node.childIds || []) {
          const child = nodeById.get(childId)
          if (child) format(child, depth)
        }
        return
      }

      const role = node.role?.value || ''
      if (IGNORED_ROLES.has(role) && !node.name?.value) {
        // 无名 generic/none 节点：跳过自身，递归子节点
        for (const childId of node.childIds || []) {
          const child = nodeById.get(childId)
          if (child) format(child, depth)
        }
        return
      }

      // 分配 UID
      const backendId = node.backendDOMNodeId
      let uid: string
      if (backendId != null && this.backendIdToUid.has(backendId)) {
        uid = this.backendIdToUid.get(backendId)!
      } else {
        uid = 'e' + (this.uidCounter++).toString(36)
        if (backendId != null) {
          this.uidMap.set(uid, backendId)
          this.backendIdToUid.set(backendId, uid)
        }
      }
      this.nodeMap.set(uid, node)
      elementCount++

      // 格式化行
      const parts: string[] = [`uid=${uid}`]
      if (role && !IGNORED_ROLES.has(role)) parts.push(role)
      if (node.name?.value) parts.push(`"${node.name.value}"`)

      // 属性
      if (node.properties) {
        for (const prop of node.properties) {
          const val = prop.value?.value
          if (prop.name === 'focused' && val === true) parts.push('[focused]')
          else if (prop.name === 'checked' && val !== 'false') parts.push(`[checked=${val}]`)
          else if (prop.name === 'expanded') parts.push(val ? '[expanded]' : '[collapsed]')
          else if (prop.name === 'level' && typeof val === 'number') parts.push(`level=${val}`)
          else if (prop.name === 'disabled' && val === true) parts.push('[disabled]')
          else if (prop.name === 'required' && val === true) parts.push('[required]')
          else if (prop.name === 'value' && val != null && val !== '') {
            const s = String(val)
            if (s.length <= 80) parts.push(`value="${s}"`)
            else parts.push(`value="${s.slice(0, 77)}..."`)
          }
        }
      }

      lines.push('  '.repeat(depth) + '- ' + parts.join(' '))

      // 递归子节点
      for (const childId of node.childIds || []) {
        const child = nodeById.get(childId)
        if (child) format(child, depth + 1)
      }
    }

    format(root, 0)

    const pageUrl = this.webContents?.getURL() || ''
    const header = `[snapshot] Page: ${pageUrl} — ${elementCount} elements\n`
    return { text: header + lines.join('\n'), elementCount }
  }

  /** 将 UID 解析为页面中的 (x, y) 中心坐标 */
  async resolveCoordinates(uid: string): Promise<{ x: number; y: number }> {
    const backendId = this.uidMap.get(uid)
    if (backendId == null) {
      throw new Error(`Element uid="${uid}" not found. Take a new snapshot.`)
    }

    // 解析 backendNodeId → objectId
    const { object } = await this.sendCommand<{ object: { objectId: string } }>('DOM.resolveNode', {
      backendNodeId: backendId
    })

    // 获取元素的 bounding rect 中心点
    const { result } = await this.sendCommand<{
      result: { value: { x: number; y: number } }
    }>('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration:
        'function(){ const r = this.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }',
      returnByValue: true
    })

    // 释放 object
    await this.sendCommand('Runtime.releaseObject', { objectId: object.objectId }).catch(() => {})

    return result.value
  }

  /** Focus 元素（用于 fill/type） */
  async focusElement(uid: string): Promise<void> {
    const backendId = this.uidMap.get(uid)
    if (backendId == null) {
      throw new Error(`Element uid="${uid}" not found. Take a new snapshot.`)
    }
    await this.sendCommand('DOM.focus', { backendNodeId: backendId })
  }

  /** 在元素上执行 JS 函数 */
  async callOnElement<T>(uid: string, fn: string): Promise<T> {
    const backendId = this.uidMap.get(uid)
    if (backendId == null) {
      throw new Error(`Element uid="${uid}" not found. Take a new snapshot.`)
    }

    const { object } = await this.sendCommand<{ object: { objectId: string } }>('DOM.resolveNode', {
      backendNodeId: backendId
    })

    const { result } = await this.sendCommand<{ result: { value: T } }>('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: fn,
      returnByValue: true
    })

    await this.sendCommand('Runtime.releaseObject', { objectId: object.objectId }).catch(() => {})
    return result.value
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

export const previewCdpService = new PreviewCdpService()
