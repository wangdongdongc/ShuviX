/**
 * 快照差异回传 —— 只把变化的行发给模型，未变的折叠成一句话。
 *
 * 为什么值得：实测四组真实的「动作前后」AX 树对，全量分别是 688 / 24 / 28 / 26 行，
 * 真实变化只有 0 / 1 / 4 / 4 行。其中「只滚动了一下」那次 AX 树**零变化**，
 * 却要重发 688 行约 22k 字符。
 *
 * 为什么现在才能做：diff 建在不稳定的 id 上会永远看到满屏假变化 —— 改造前一次整树
 * 重渲染，26 行里 24 行的 uid 会变而内容只变 1 行，92% 是噪声。uid 改成按内容键跨
 * 快照沿用之后，四个场景的「带 uid 差异」全部等于「真实差异」，这才有了做 diff 的地基。
 *
 * ## 比对方式：按 uid，不做 LCS
 *
 * uid 现在是稳定的内容身份，所以直接按 uid 配对即可，O(n)；LCS 在 wikipedia 这种
 * 2000+ 行的页面上是 O(n²)。代价是**顺序变化**看不出来（同一行换了位置但文本不变），
 * 所以额外做一次「幸存 uid 的相对顺序是否保持」检查，不保持就退回全量 —— 顺序变了
 * 说明页面结构真的动了，此时省那点字符不值得冒误导的风险。
 *
 * ## 安全边界
 *
 * diff 有个结构性弱点：它依赖模型上下文里还留着上一份快照，而自动压缩可能把它删掉，
 * **工具无从知道这件事**。三道防线：
 *
 * 1. 调用方只在「距上次快照没隔几次操作」时才请求 diff（见 tool.ts 的 opsSinceSnapshot）
 * 2. 输出**自证**：表头写明它相对于谁、有多少行未变，模型看得出自己缺不缺东西，
 *    从而主动重取全量 —— 把静默误读变成优雅降级
 * 3. `snapshot(tabId, full:true)` 让模型随时可以要全量
 *
 * 更彻底的解法是把「压缩纪元」透到工具侧，纪元一变就作废缓存，那样连模型自省都不需要。
 * 现在 `ToolContext` 里没有这个信号，留作后续增强。
 */

/** 变化太多时不值得回差异 —— 省不了多少，还让模型多做一次拼接 */
const MAX_CHANGE_RATIO = 0.5

/** 每段变化前保留几行上下文（让模型知道新增的行挂在哪儿） */
const CONTEXT_LINES = 1

export interface SnapshotDiffResult {
  /** 要发给模型的正文（不含表头） */
  body: string
  /** 变化行数（新增 + 改动） */
  changed: number
  /** 未变行数 */
  unchanged: number
  /** 删除行数 */
  removed: number
}

/** 从一行里取 uid；取不到返回 null（理论上不该发生，防御性处理） */
function uidOf(line: string): string | null {
  const m = line.match(/- (uid=\S+)/)
  return m ? m[1] : null
}

/**
 * 计算差异正文；判定「不值得回差异」时返回 null，调用方应回全量。
 *
 * 返回 null 的三种情况：没有上一份快照、变化占比过高、幸存 uid 的相对顺序变了。
 */
export function diffSnapshotBody(prev: string[], next: string[]): SnapshotDiffResult | null {
  if (prev.length === 0 || next.length === 0) return null

  const prevByUid = new Map<string, string>()
  const prevOrder = new Map<string, number>()
  prev.forEach((line, i) => {
    const uid = uidOf(line)
    if (uid == null) return
    prevByUid.set(uid, line)
    prevOrder.set(uid, i)
  })

  // 分类每一行：unchanged / changed（uid 还在但内容变了）/ added（uid 是新的）
  type Kind = 'same' | 'changed' | 'added'
  const kinds: Kind[] = []
  const survivors: number[] = [] // 幸存 uid 在 prev 里的下标，用来查顺序
  const seen = new Set<string>()
  for (const line of next) {
    const uid = uidOf(line)
    if (uid == null) {
      kinds.push('added')
      continue
    }
    seen.add(uid)
    const before = prevByUid.get(uid)
    if (before === undefined) {
      kinds.push('added')
    } else {
      kinds.push(before === line ? 'same' : 'changed')
      survivors.push(prevOrder.get(uid)!)
    }
  }

  // 顺序检查：幸存的 uid 在两份快照里必须保持相对顺序，否则说明结构真的动了
  for (let i = 1; i < survivors.length; i++) {
    if (survivors[i] < survivors[i - 1]) return null
  }

  const removed = [...prevByUid.keys()].filter((u) => !seen.has(u))
  const changed = kinds.filter((k) => k !== 'same').length
  const unchanged = kinds.length - changed

  // 变化太多就别回差异了
  if ((changed + removed.length) / next.length > MAX_CHANGE_RATIO) return null
  // 一点没变也要走这里 —— 那正是收益最大的情况（实测滚动一下 = 688 行零变化）

  // 需要展示的行：变化行本身 + 每段变化前的少量上下文
  const show = new Array<boolean>(kinds.length).fill(false)
  kinds.forEach((k, i) => {
    if (k === 'same') return
    for (let j = Math.max(0, i - CONTEXT_LINES); j <= i; j++) show[j] = true
  })

  const out: string[] = []
  let skipped = 0
  const flush = (): void => {
    if (skipped > 0) {
      out.push(`  … ${skipped} line${skipped > 1 ? 's' : ''} unchanged`)
      skipped = 0
    }
  }
  next.forEach((line, i) => {
    if (!show[i]) {
      skipped++
      return
    }
    flush()
    out.push((kinds[i] === 'added' ? '+' : kinds[i] === 'changed' ? '~' : ' ') + line)
  })
  flush()

  for (const uid of removed) out.push(`- ${uid} (gone)`)

  return { body: out.join('\n'), changed, unchanged, removed: removed.length }
}

/** 差异模式的表头 —— **自证**：说清相对于谁、多少未变，模型据此判断自己缺不缺东西 */
export function diffHeader(pageUrl: string, elementCount: number, d: SnapshotDiffResult): string {
  const parts = [`${d.changed} changed`]
  if (d.removed > 0) parts.push(`${d.removed} gone`)
  parts.push(`${d.unchanged} unchanged`)
  // 尽量短，但**自证**所需的三样都要在：相对于谁、多少没变、丢了怎么补。
  // 小页面上表头本身就是主要成本，冗长的措辞会把收益吃掉。
  return (
    `[snapshot] Page: ${pageUrl} — ${elementCount} elements\n` +
    `(diff vs your previous snapshot of this tab — ${parts.join(', ')}. ` +
    `+added ~changed, … = unchanged. Lost it? snapshot(full:true))`
  )
}
