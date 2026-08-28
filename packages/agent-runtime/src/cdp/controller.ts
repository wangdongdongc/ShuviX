/**
 * CdpController —— CDP 自动化的可移植内核（宿主无关，注入 CdpTransport）。
 *
 * 持有 A11y UID 映射，提供 snapshot / 坐标解析 / focus / 在元素上求值 等原语；
 * 上层 click/type/key/navigate 由各宿主用这些原语 + transport.sendCommand 组合。
 * 从桌面 browserCdpService 的可移植部分逐字搬出（网络/控制台采集、面板生命周期仍留桌面）。
 */
import type { CdpTransport } from './transport'
import { diffSnapshotBody, diffHeader } from './snapshotDiff'

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

/**
 * 纯排版构造 —— **任何情况下都不打印**，连同它们的名字。
 *
 * InlineTextBox 是浏览器折行产生的文本碎片：一段 StaticText "很长的一句话" 会挂上
 * 若干 InlineTextBox，各自是这句话的一截。它们既不是 DOM 节点（没有
 * backendDOMNodeId，uid 解析不了），文字也全部来自父节点，打印出来纯属噪声 ——
 * 实测 wikipedia 有 863 个、github 133 个。
 *
 * 早先它们和 none/generic 放在同一个集合里，只在「无名」时才跳过 —— 而它们恰恰
 * 都有名字，于是全部漏了出来。
 */
const LAYOUT_ONLY_ROLES = new Set(['InlineTextBox', 'LineBreak'])

/** 无名时才跳过的容器角色（有名字时可能承载语义，要留） */
const IGNORED_ROLES = new Set(['none', 'generic'])

/**
 * 可交互角色 —— R4 的安全边界：子孙里有这些就不吞子树，否则页面会变得点不了。
 * 实测这条 guard 在 hn 触发 64 次、mdn 27 次、github 23 次，不是假想。
 */
const INTERACTIVE_ROLES = new Set([
  'link',
  'button',
  'textbox',
  'searchbox',
  'checkbox',
  'radio',
  'combobox',
  'listbox',
  'option',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'switch',
  'slider',
  'spinbutton',
  'textarea'
])

/**
 * 取归一化后的 accessible name。
 *
 * 空白折叠成单个空格再 trim：AX 树里有大量 name 为 "\n  " 的 StaticText 和
 * name 为 "\n" 的 LineBreak（实测 github 170 个、hn 58 行），不归一的话
 *   - 换行会把一个节点渲染成多行，表头的 elementCount 与实际行数对不上
 *   - 纯空白节点白占一行和一个 uid
 * 归一后纯空白 name 变成空串，自然走「无名」分支被跳过。
 */
function nameOf(node: AXNode): string {
  return (node.name?.value ?? '').replace(/\s+/g, ' ').trim()
}

/** 渲染成行尾属性标注的那几个 property（白名单，顺序即输出顺序） */
function attrParts(node: AXNode): string[] {
  const out: string[] = []
  for (const prop of node.properties || []) {
    const val = prop.value?.value
    if (prop.name === 'focused' && val === true) out.push('[focused]')
    else if (prop.name === 'checked' && val !== 'false') out.push(`[checked=${val}]`)
    else if (prop.name === 'expanded') out.push(val ? '[expanded]' : '[collapsed]')
    else if (prop.name === 'level' && typeof val === 'number') out.push(`level=${val}`)
    else if (prop.name === 'disabled' && val === true) out.push('[disabled]')
    else if (prop.name === 'required' && val === true) out.push('[required]')
    else if (prop.name === 'value' && val != null && val !== '') {
      const str = String(val)
      out.push(`value="${str.length <= 80 ? str : str.slice(0, 77) + '...'}"`)
    }
  }
  return out
}

/** 去掉全部空白 —— R4 比较专用，见调用处对 accname 空格规则的说明 */
function squash(text: string | undefined): string {
  return (text ?? '').replace(/\s+/g, '')
}

/** R4 的另一条安全边界：带属性的子孙不能吞（属性是它唯一的出处） */
function hasAttrs(node: AXNode): boolean {
  return attrParts(node).length > 0
}

export class CdpController {
  // UID 系统
  //
  // uid 按**内容键**跨快照沿用，而不是按 backendDOMNodeId。原因：页面重渲染后
  // DOM 节点是全新的（backendDOMNodeId 全变），内容却一模一样 —— 实测一次整树
  // 重渲染，26 行里 24 行的 uid 会变，而真实内容变化只有 1 行，92% 是纯噪声。
  // 这对差异回传是致命的：diff 会永远看到满屏假变化。
  //
  // uidMap（uid → backendDOMNodeId）则**每次快照重建** —— 内容键是稳定的身份，
  // backendNodeId 是当下的句柄，两者职责分开：uid 用来在对话里指代同一个东西，
  // 句柄用来真正操作它。
  private uidCounter = 0
  private uidMap = new Map<string, number>() // uid → backendDOMNodeId（每快照重建）
  private keyToUid = new Map<string, number>() // 内容键 → uid 编号（跨快照沿用）
  private nodeMap = new Map<string, AXNode>() // uid → AXNode（每快照重建）
  /** 上一次快照的正文行，用于差异回传；reset / 全量请求后作废 */
  private lastBody: string[] | null = null

  constructor(private transport: CdpTransport) {}

  private send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    return this.transport.sendCommand<T>(method, params)
  }

  /** 清空 UID 状态（detach / 重新接管时调用） */
  reset(): void {
    this.uidCounter = 0
    this.uidMap.clear()
    this.keyToUid.clear()
    this.nodeMap.clear()
    this.lastBody = null
  }

  /** 取某 uid 对应的 AX 节点（供上层生成动作描述） */
  getNode(uid: string): AXNode | undefined {
    return this.nodeMap.get(uid)
  }

  // ====== A11y 快照 + UID ======

  /**
   * 生成 A11y 快照，构建 UID 映射，返回格式化文本。pageUrl 由宿主提供（仅用于表头）。
   *
   * 编码规则与实测收益见同目录的 SNAPSHOT-ENCODING.md。四条压缩规则：
   *   R1 与父同名、role 被抑制的行不打印（AX 树把一段文字拆成 StaticText/InlineTextBox 两层）
   *   R3 StaticText 的 role 名不打印，只留引号里的文字
   *   R4 子孙文字（去相邻重复）恰好等于自身 name，且子孙中无可交互元素、无属性 → 吞掉子树
   *   R5 缩进 1 空格/层
   *
   * R4 的依据是 W3C accname 规范：父节点的 name 本就是浏览器从子孙文字算出来的，
   * 相等时子树确实没有新信息。它是四条里的大头（实测省 27%~61%）。
   *
   * ⚠️ R4 必须**先去相邻重复再比**：树里文字本就是重复的（"立即登录立即登录"），
   * 直接拼起来不等于 name，R4 会在多份夹具上一个子树都吞不动（静默失效）。
   *
   * 聚合是自底向上一次算完（subtreeText/subtreeBlocked），不是每个节点重走子孙 ——
   * 后者在 7000 节点的页面上是 O(n²)。
   */
  async buildSnapshot(
    pageUrl = '',
    opts: { full?: boolean } = {}
  ): Promise<{ text: string; elementCount: number; diffed?: boolean }> {
    const result = await this.send<{ nodes: AXNode[] }>('Accessibility.getFullAXTree')
    const nodes = result.nodes

    const nodeById = new Map<string, AXNode>()
    for (const node of nodes) nodeById.set(node.nodeId, node)

    const root = nodes[0]
    if (!root) {
      this.lastBody = null
      return { text: '(empty page)', elementCount: 0 }
    }

    // uidMap / nodeMap 每次快照重建 —— uid 的契约本就是「只在最新快照内有效」，
    // 而增量清理会让无 backendId 的条目永不回收（实测 wikipedia 每拍 +2499，真泄漏）。
    this.uidMap.clear()
    this.nodeMap.clear()
    // keyToUid 跨快照沿用（这正是 uid 稳定性的来源），但要收敛到本次出现过的键，
    // 否则长会话里逛过的每个页面都会在表里留下残渣。
    const seenKeys = new Set<string>()

    // ── 自底向上聚合（一次遍历，供 R4 O(1) 判定）
    /** 子孙文字，相邻重复已折叠 */
    const subtreeText = new Map<string, string>()
    /** 子孙里有可交互元素或带属性 —— R4 不得吞 */
    const subtreeBlocked = new Map<string, boolean>()
    const aggregate = (node: AXNode): void => {
      const parts: string[] = []
      let blocked = false
      for (const childId of node.childIds || []) {
        const child = nodeById.get(childId)
        if (!child) continue
        aggregate(child)
        if (LAYOUT_ONLY_ROLES.has(child.role?.value || '')) continue
        const cname = nameOf(child)
        if (cname && parts[parts.length - 1] !== cname) parts.push(cname)
        const ctext = subtreeText.get(childId)
        if (ctext && parts[parts.length - 1] !== ctext) parts.push(ctext)
        if (INTERACTIVE_ROLES.has(child.role?.value || '') || hasAttrs(child)) blocked = true
        if (subtreeBlocked.get(childId)) blocked = true
      }
      subtreeText.set(node.nodeId, parts.join(' '))
      subtreeBlocked.set(node.nodeId, blocked)
    }
    aggregate(root)

    let elementCount = 0
    const lines: string[] = []
    /** 内容键的出现计数：同一个 (role, name) 出现第几次 */
    const keySeq = new Map<string, number>()

    const format = (node: AXNode, depth: number, parentName: string): void => {
      const role = node.role?.value || ''
      const name = nameOf(node)

      // ignored、纯排版构造、或「容器角色且无名」：跳过自身，子节点顶上来（depth 不加）
      if (node.ignored || LAYOUT_ONLY_ROLES.has(role) || (IGNORED_ROLES.has(role) && !name)) {
        for (const childId of node.childIds || []) {
          const child = nodeById.get(childId)
          if (child) format(child, depth, parentName)
        }
        return
      }

      // R1：与父同名、role 又被抑制 —— 这一层是 AX 树的实现细节，没有新信息
      if (IGNORED_ROLES.has(role) && name && name === parentName) {
        for (const childId of node.childIds || []) {
          const child = nodeById.get(childId)
          if (child) format(child, depth, parentName)
        }
        return
      }

      // 渲染出来只剩一个 uid、什么内容都没有的行（归一后无名的 StaticText 等）：
      // 跳过自身、子节点顶上来。这类行既没信息也占一个 uid，是缺陷 #5 的同类。
      const printsRole = !!role && !IGNORED_ROLES.has(role) && role !== 'StaticText'
      if (!printsRole && !name && attrParts(node).length === 0) {
        for (const childId of node.childIds || []) {
          const child = nodeById.get(childId)
          if (child) format(child, depth, parentName)
        }
        return
      }

      // 内容键 = 角色 + 名字 + 「同名同角色里的第几个」。不含位置路径：在别处插入
      // 一个元素不该让后面所有元素改名。同名同角色的重复项按出现序区分，其中一个
      // 被插到中间时只有它之后的同类会漂，代价可接受。
      const kind = role || (name ? 'text' : 'node')
      const base = `${kind}\u0000${name}`
      const nth = (keySeq.get(base) ?? 0) + 1
      keySeq.set(base, nth)
      const key = `${base}\u0000${nth}`
      seenKeys.add(key)

      // 编号来自内容键（跨快照稳定），前缀来自**本次快照**的可解析性：
      //   e = 有 backendDOMNodeId，click/fill/$uid 宏都能用
      //   t = 没有（AX 树里的纯文本构造），只能用来指代，不能操作
      // 两者分开是为了别向模型广告一个用了会抛错的 uid。编号全局唯一，所以
      // 'e3' 与 't3' 不会同时存在。
      let seq = this.keyToUid.get(key)
      if (seq == null) {
        seq = this.uidCounter++
        this.keyToUid.set(key, seq)
      }
      const backendId = node.backendDOMNodeId
      const uid = (backendId != null ? 'e' : 't') + seq.toString(36)
      if (backendId != null) this.uidMap.set(uid, backendId)
      this.nodeMap.set(uid, node)
      elementCount++

      const parts: string[] = [`uid=${uid}`]
      // R3：StaticText 的 role 名是废话 —— 引号里的文字已经说明一切
      if (printsRole) parts.push(role)
      if (name) parts.push(`"${name}"`)
      parts.push(...attrParts(node))

      lines.push(' '.repeat(depth) + '- ' + parts.join(' '))

      // R4：子孙文字恰好等于自身 name，且子孙无可交互元素/属性 → 子树无新信息。
      //
      // 比较**忽略全部空白**：Chromium 算 accname 时，行内元素之间不插空格、块级之间
      // 插空格，而 AX 树里没有 display 信息，拼接策略无论选哪个都会错一半
      // （`link "图标带子元素的链接"` 挂两个 StaticText，拼出来是 "图标 带子元素的链接"）。
      // 忽略空白不会丢信息：父行印的 name 才是权威渲染，子孙只在空白上有差异时吞掉即可。
      if (
        name &&
        !subtreeBlocked.get(node.nodeId) &&
        squash(subtreeText.get(node.nodeId)) === squash(name)
      ) {
        return
      }

      for (const childId of node.childIds || []) {
        const child = nodeById.get(childId)
        if (child) format(child, depth + 1, name)
      }
    }

    format(root, 0, '')

    // 收敛 keyToUid 到本次出现过的键
    if (this.keyToUid.size > seenKeys.size) {
      for (const k of this.keyToUid.keys()) if (!seenKeys.has(k)) this.keyToUid.delete(k)
    }

    // 差异回传：调用方说可以、且手上有上一份时才试；不值得回差异时 diffSnapshotBody
    // 返回 null，自然退回全量（见该模块对判定条件与安全边界的说明）。
    const prev = this.lastBody
    this.lastBody = lines
    if (!opts.full && prev) {
      const d = diffSnapshotBody(prev, lines)
      if (d)
        return {
          text: diffHeader(pageUrl, elementCount, d) + '\n' + d.body,
          elementCount,
          diffed: true
        }
    }

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
