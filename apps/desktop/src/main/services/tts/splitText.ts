/**
 * 将文本按换行符切片，用于 TTS 分段合成
 *
 * - 按 `\n` 分割，过滤空行
 * - 相邻短行（< minLength）合并为一个 chunk，避免产生过碎的片段
 * - 至少返回 1 个元素（除非输入为空）
 */
export function splitTextForTts(text: string, minLength = 80): string[] {
  const lines = text.split('\n').filter((l) => l.trim().length > 0)

  if (lines.length === 0) return []

  const chunks: string[] = []
  let current = ''

  for (const line of lines) {
    if (current.length === 0) {
      current = line
    } else {
      current += '\n' + line
    }

    if (current.length >= minLength) {
      chunks.push(current)
      current = ''
    }
  }

  // 将剩余内容追加到最后一个 chunk 或作为新 chunk
  if (current.length > 0) {
    if (chunks.length > 0 && current.length < minLength) {
      chunks[chunks.length - 1] += '\n' + current
    } else {
      chunks.push(current)
    }
  }

  return chunks
}
