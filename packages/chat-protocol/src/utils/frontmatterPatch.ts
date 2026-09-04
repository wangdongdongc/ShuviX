/**
 * 改/删 frontmatter 里一个标量键（首个 `---` 块内）。value 为 null 删除该行；
 * 键不存在则插到闭合 `---` 之前。frontmatter 缺失时原样返回（bot-intent 的 md 恒有）。
 */
export function patchFrontmatterScalar(text: string, key: string, value: string | null): string {
  const lines = text.split('\n')
  if (lines[0]?.trim() !== '---') return text
  let close = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      close = i
      break
    }
  }
  if (close < 0) return text
  const keyRe = new RegExp(`^${key}\\s*:`)
  const at = lines.findIndex((l, i) => i > 0 && i < close && keyRe.test(l))
  if (value === null) {
    if (at >= 0) lines.splice(at, 1)
    return lines.join('\n')
  }
  const line = `${key}: ${value}`
  if (at >= 0) lines[at] = line
  else lines.splice(close, 0, line)
  return lines.join('\n')
}

/**
 * 改/删 frontmatter 里一个**嵌套映射**的一条（`key:` 下缩进的 `entry: value` 行）——
 * （改制前 bot md 的 `shuvix-bot-agents.<槽位>` 是这种形状；更深的嵌套用下面的
 * patchFrontmatterPath）。value 为 null 删除该条；映射块整个
 * 变空时连 `key:` 那一行一起删。键不存在则在闭合 `---` 之前新起一块。
 *
 * 与 `patchFrontmatterScalar` 同一条纪律：纯文本行级改写，其余行原样活过去（注释、键序、
 * 用户手写的其它键）。只认「块级缩进」的写法；`key: { a: b }` 这种流式写法整行替换成块。
 */
export function patchFrontmatterMappingEntry(
  text: string,
  key: string,
  entry: string,
  value: string | null
): string {
  const lines = text.split('\n')
  if (lines[0]?.trim() !== '---') return text
  let close = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      close = i
      break
    }
  }
  if (close < 0) return text
  const keyRe = new RegExp(`^${key}\\s*:`)
  const start = lines.findIndex((l, i) => i > 0 && i < close && keyRe.test(l))
  // 块的范围：key 行之后连续的缩进行（空行与缩进注释也算块内）
  let end = start + 1
  if (start >= 0) {
    while (end < close && (lines[end].trim() === '' || /^\s+\S/.test(lines[end]))) end++
    // 尾部空行不算块的一部分
    while (end > start + 1 && lines[end - 1].trim() === '') end--
  }
  const flow = start >= 0 && /^\S+\s*:\s*\{/.test(lines[start])
  const current: Array<[string, string]> = []
  if (start >= 0 && !flow) {
    for (const l of lines.slice(start + 1, end)) {
      const m = /^\s+([^\s:#][^:]*?)\s*:\s*(.*)$/.exec(l)
      if (m) current.push([m[1], m[2]])
    }
  }
  const next = current.filter(([k]) => k !== entry)
  if (value !== null) {
    const at = current.findIndex(([k]) => k === entry)
    if (at >= 0) next.splice(at, 0, [entry, value])
    else next.push([entry, value])
  }
  const block = next.length ? [`${key}:`, ...next.map(([k, v]) => `  ${k}: ${v}`)] : []
  if (start >= 0) lines.splice(start, (flow ? start + 1 : end) - start, ...block)
  else if (block.length) lines.splice(close, 0, ...block)
  return lines.join('\n')
}

/** 一次嵌套路径改写：`path` 从顶层键起（长度 ≥ 1），value 为 null 删除该条 */
export interface FrontmatterPathEdit {
  path: string[]
  value: string | null
}

/**
 * YAML 标量的最小安全写出（与属性卡 frontmatterCard.yamlScalar 同一套判据）：含 ` #`、`: `、
 * 以指示符起头、首尾空白或空串的值加单引号并转义 —— 工作流名 / agent 名通常是标识符，
 * 但这条写路径也接用户自取的名字，直接拼接会在这些取值上被 YAML 误解析。
 */
function yamlScalarText(value: string): string {
  const risky =
    value === '' ||
    value !== value.trim() ||
    /\s#/.test(value) ||
    value.includes(': ') ||
    value.endsWith(':') ||
    /^[-?:,[\]{}#&*!|>'"%@`]/.test(value)
  return risky ? `'${value.replace(/'/g, "''")}'` : value
}

const indentOf = (line: string): number => /^[ \t]*/.exec(line)![0].length

/**
 * 按**路径**改/删 frontmatter 里嵌套映射的一条标量 —— bot md 的
 * `shuvix-bot-pipeline.agents.<槽位>` / `shuvix-bot-pipeline.workflow` 就是这种形状。
 *
 * 与本文件另两个原语同一条纪律：**纯文本行级改写**，目标行之外的一切（块内注释、其它
 * 条目、键序、正文）逐字节活过去 —— 这是属性卡「文档文本是唯一事实源」的前提。
 *   - 沿路径逐层定位块（父键行之后、缩进更深的连续行；块内空行与缩进注释算块内），
 *     缺失的中间键就地创建在父块块尾；缩进沿用该层已有子行，没有子行则父缩进 + 文件的
 *     缩进单位（frontmatter 里第一条缩进行的缩进；一条都没有则 2）。
 *   - 目标条目：有则原位替换值段，无则追加到该层块尾，null 则删除整行。
 *   - 删到某层块空时连它的 `key:` 行一起删，逐层向上（顶层键也删）—— 不留值为 null 的裸键。
 *   - 父键行带流式值（`agents: { intent: x }`）时，先把它摊成块再改（简单的一层 `k: v`
 *     列表逐条保留；含嵌套括号的流式值不猜，原样返回、什么都不改）；父键行带标量值时
 *     那个标量被块取代（把一份旧格式的 `shuvix-bot-pipeline: bot-chat` 改成块的正是这条路）。
 *   - 无 frontmatter / 没有闭合 `---` / 路径为空 → 原样返回。
 * 多条改写用 `patchFrontmatterPaths` 一次做完（属性卡换工作流 = 改 workflow + 删旧槽位，
 * 得落成一次文档变更）。
 */
export function patchFrontmatterPath(text: string, path: string[], value: string | null): string {
  if (path.length === 0) return text
  const lines = text.split('\n')
  if (lines[0]?.trim() !== '---') return text
  let close = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      close = i
      break
    }
  }
  if (close < 0) return text

  /** 在 [from, to) 内找恰为 indent 缩进的 `key:` 行 */
  const findKey = (from: number, to: number, indent: number, key: string): number => {
    // 行尾容 \r（CRLF 文件）：`key:\r` 也是纯键行
    const re = new RegExp(`^[ \\t]{${indent}}${escapeRegExp(key)}[ \\t]*:(?:[ \\t\\r]|$)`)
    for (let i = from; i < to; i++) {
      if (indentOf(lines[i]) !== indent) continue
      if (re.test(lines[i])) return i
    }
    return -1
  }
  /** 键行之后属于它的块：缩进更深的连续行（空行算块内，尾部空行不算） */
  const blockEnd = (keyAt: number, to: number): number => {
    const indent = indentOf(lines[keyAt])
    let end = keyAt + 1
    while (end < to && (lines[end].trim() === '' || indentOf(lines[end]) > indent)) end++
    while (end > keyAt + 1 && lines[end - 1].trim() === '') end--
    return end
  }
  /** 文件的缩进单位：frontmatter 里第一条缩进行的缩进（四空格文件新起的层也落四空格）；没有则 2 */
  let unit = 2
  for (let i = 1; i < close; i++) {
    const n = indentOf(lines[i])
    if (n > 0 && lines[i].trim() !== '') {
      unit = n
      break
    }
  }
  /** 该块里子行的缩进（取第一条非空子行；没有则父缩进 + 缩进单位） */
  const childIndent = (keyAt: number, end: number): number => {
    for (let i = keyAt + 1; i < end; i++) {
      if (lines[i].trim() !== '') return indentOf(lines[i])
    }
    return indentOf(lines[keyAt]) + unit
  }
  /** 键行的值段（冒号之后）；空串 = 纯 `key:` */
  const valueOf = (keyAt: number): string => lines[keyAt].replace(/^[^:]*:[ \t]?/, '').trim()

  // ── 沿路径定位 / 创建各层父块 ──
  // 每层记 [keyAt, end)；顶层的"父块"是整个 frontmatter [1, close)
  let from = 1
  let to = close
  let indent = 0
  // 记录路径上各层的键行号，删空时逐层回溯
  const keyLines: number[] = []
  for (let depth = 0; depth < path.length - 1; depth++) {
    let keyAt = findKey(from, to, indent, path[depth])
    if (keyAt < 0) {
      if (value === null) return lines.join('\n') // 删一条本就不存在的：无事发生
      // 在父块块尾新起一层
      const line = `${' '.repeat(indent)}${path[depth]}:`
      lines.splice(to, 0, line)
      close++
      keyAt = to
      to++
    } else {
      const v = valueOf(keyAt)
      if (v.startsWith('{')) {
        // 流式映射摊成块（只认一层 `k: v` 列表；含嵌套括号不猜）
        const inner = v.replace(/^\{/, '').replace(/\}$/, '').trim()
        if (/[{[]/.test(inner)) return text
        const entries = inner
          ? inner.split(',').map((e) => {
              const m = /^\s*([^:]+?)\s*:\s*(.*?)\s*$/.exec(e)
              return m ? [m[1], m[2]] : null
            })
          : []
        if (entries.some((e) => e === null)) return text
        const head = lines[keyAt].replace(/:[ \t]?.*$/, ':')
        const ci = indent + unit
        const block = [head, ...entries.map((e) => `${' '.repeat(ci)}${e![0]}: ${e![1]}`)]
        lines.splice(keyAt, 1, ...block)
        close += block.length - 1
        to += block.length - 1
      } else if (v !== '') {
        // 标量值让位给块（旧格式 `shuvix-bot-pipeline: bot-chat` → 块）
        lines[keyAt] = lines[keyAt].replace(/:[ \t]?.*$/, ':')
      }
    }
    keyLines.push(keyAt)
    const end = blockEnd(keyAt, to)
    indent = childIndent(keyAt, end)
    from = keyAt + 1
    to = end
  }

  // ── 目标条目 ──
  const leaf = path[path.length - 1]
  const at = findKey(from, to, indent, leaf)
  if (value === null) {
    if (at < 0) return lines.join('\n')
    lines.splice(at, 1)
    close--
    // 块空则连父键行一起删，逐层向上
    for (let depth = keyLines.length - 1; depth >= 0; depth--) {
      const keyAt = keyLines[depth]
      const end = blockEnd(keyAt, close)
      const hasChild = lines.slice(keyAt + 1, end).some((l) => l.trim() !== '')
      if (hasChild) break
      lines.splice(keyAt, end - keyAt)
      close -= end - keyAt
    }
    return lines.join('\n')
  }
  const line = `${' '.repeat(indent)}${leaf}: ${yamlScalarText(value)}`
  if (at >= 0) lines[at] = line
  else lines.splice(to, 0, line)
  return lines.join('\n')
}

/** 依次应用多条路径改写（一次落成一份文本，供属性卡作为一次文档变更派发） */
export function patchFrontmatterPaths(text: string, edits: FrontmatterPathEdit[]): string {
  return edits.reduce((acc, e) => patchFrontmatterPath(acc, e.path, e.value), text)
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
