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
 * bot md 的 `shuvix-bot-agents.<槽位>` 就是这种形状。value 为 null 删除该条；映射块整个
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
