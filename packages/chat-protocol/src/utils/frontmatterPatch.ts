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
