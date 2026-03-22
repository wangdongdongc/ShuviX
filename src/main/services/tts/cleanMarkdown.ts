/**
 * 将 Markdown 文本清洗为适合 TTS 朗读的纯文本
 *
 * 处理顺序经过精心设计：先移除块级结构（代码块、thinking 标签），
 * 再处理行内语法（链接、加粗），最后归一化空白。
 */
export function cleanMarkdownForTts(raw: string): string {
  let text = raw

  // ── Phase 1: 移除不适合朗读的块级内容 ──

  // 1. LLM thinking / reasoning 块
  text = text.replace(
    /<(?:think|thinking|reasoning)>[\s\S]*?<\/(?:think|thinking|reasoning)>/gi,
    ''
  )

  // 2. Fenced code blocks（整块删除，代码不适合语音）
  text = text.replace(/```[\s\S]*?```/g, '')

  // 3. HTML 注释
  text = text.replace(/<!--[\s\S]*?-->/g, '')

  // 4. HTML 标签（保留内部文本）
  text = text.replace(/<[^>]+>/g, '')

  // 5. 表格：删除分隔行，去掉管道符
  text = text.replace(/^\|?[\s\-:|]+\|[\s\-:|]*$/gm, '')
  text = text.replace(/\|/g, ' ')

  // 6. 水平线
  text = text.replace(/^[\s]*([-*_]){3,}\s*$/gm, '')

  // ── Phase 2: 行内语法转为纯文本 ──

  // 7. 图片 ![alt](url) → alt
  text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')

  // 8. 链接 [text](url) → text
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')

  // 9. 引用式链接定义 [ref]: url
  text = text.replace(/^\s*\[[^\]]+\]:\s*.+$/gm, '')

  // 10. 标题 # → 去掉前缀
  text = text.replace(/^#{1,6}\s+/gm, '')

  // 11. 加粗 + 斜体（先处理 *** 再 ** 再 *；下划线只处理 __ 不处理单 _ 避免误伤 snake_case）
  text = text.replace(/\*{3}(.+?)\*{3}/g, '$1')
  text = text.replace(/\*{2}(.+?)\*{2}/g, '$1')
  text = text.replace(/\*(.+?)\*/g, '$1')
  text = text.replace(/_{2}(.+?)_{2}/g, '$1')

  // 12. 删除线
  text = text.replace(/~~(.+?)~~/g, '$1')

  // 13. 行内代码
  text = text.replace(/`([^`]+)`/g, '$1')

  // 14. 引用前缀
  text = text.replace(/^>\s?/gm, '')

  // 15. 无序列表标记
  text = text.replace(/^[\s]*[-*+]\s+/gm, '')

  // 16. 有序列表标记
  text = text.replace(/^[\s]*\d+\.\s+/gm, '')

  // ── Phase 3: 移除 Emoji ──
  // 使用 Unicode property escape 匹配所有 emoji（含组合序列、修饰符、旗帜等）
  text = text.replace(/\p{Emoji_Presentation}|\p{Extended_Pictographic}/gu, '')

  // ── Phase 4: 归一化空白 ──
  text = text.replace(/\n{3,}/g, '\n\n')

  return text.trim()
}
