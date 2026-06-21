/**
 * CdpController —— CDP 自动化的可移植内核（宿主无关，注入 CdpTransport）。
 *
 * 持有 A11y UID 映射，提供 snapshot / 坐标解析 / focus / 在元素上求值 等原语；
 * 上层 click/type/key/navigate 由各宿主用这些原语 + transport.sendCommand 组合。
 * 从桌面 browserCdpService 的可移植部分逐字搬出（网络/控制台采集、面板生命周期仍留桌面）。
 */
import type { CdpTransport } from './transport'

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

/** 过滤掉的无意义角色 */
const IGNORED_ROLES = new Set(['none', 'generic', 'InlineTextBox', 'LineBreak'])

export class CdpController {
  // UID 系统
  private uidCounter = 0
  private uidMap = new Map<string, number>() // uid → backendDOMNodeId
  private backendIdToUid = new Map<number, string>() // backendDOMNodeId → uid（反向）
  private nodeMap = new Map<string, AXNode>() // uid → AXNode

  constructor(private transport: CdpTransport) {}

  private send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    return this.transport.sendCommand<T>(method, params)
  }

  /** 清空 UID 状态（detach / 重新接管时调用） */
  reset(): void {
    this.uidCounter = 0
    this.uidMap.clear()
    this.backendIdToUid.clear()
    this.nodeMap.clear()
  }

  /** 取某 uid 对应的 AX 节点（供上层生成动作描述） */
  getNode(uid: string): AXNode | undefined {
    return this.nodeMap.get(uid)
  }

  // ====== A11y 快照 + UID ======

  /** 生成 A11y 快照，构建 UID 映射，返回格式化文本。pageUrl 由宿主提供（仅用于表头） */
  async buildSnapshot(pageUrl = ''): Promise<{ text: string; elementCount: number }> {
    const result = await this.send<{ nodes: AXNode[] }>('Accessibility.getFullAXTree')
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
    const { object } = await this.send<{ object: { objectId: string } }>('DOM.resolveNode', {
      backendNodeId: backendId
    })

    // 获取元素的 bounding rect 中心点
    const { result } = await this.send<{
      result: { value: { x: number; y: number } }
    }>('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration:
        'function(){ const r = this.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }',
      returnByValue: true
    })

    // 释放 object
    await this.send('Runtime.releaseObject', { objectId: object.objectId }).catch(() => {})

    return result.value
  }

  /** Focus 元素（用于 fill/type） */
  async focusElement(uid: string): Promise<void> {
    const backendId = this.uidMap.get(uid)
    if (backendId == null) {
      throw new Error(`Element uid="${uid}" not found. Take a new snapshot.`)
    }
    await this.send('DOM.focus', { backendNodeId: backendId })
  }

  /** 在元素上执行 JS 函数（this 绑定到该元素），返回值经 returnByValue 序列化 */
  async callOnElement<T>(uid: string, fn: string): Promise<T> {
    const backendId = this.uidMap.get(uid)
    if (backendId == null) {
      throw new Error(`Element uid="${uid}" not found. Take a new snapshot.`)
    }

    const { object } = await this.send<{ object: { objectId: string } }>('DOM.resolveNode', {
      backendNodeId: backendId
    })

    const { result } = await this.send<{ result: { value: T } }>('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: fn,
      returnByValue: true
    })

    await this.send('Runtime.releaseObject', { objectId: object.objectId }).catch(() => {})
    return result.value
  }
}
