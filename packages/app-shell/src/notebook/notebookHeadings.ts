/** minimap 标题数据 + 解析 —— 与组件分离，便于 fast-refresh / 复用。 */

export interface NotebookHeading {
  /** 标题级别 1-6 */
  level: number
  /** 标题文本（去掉 # 标记） */
  text: string
  /** 所在行号（1-based，对应 CM6 doc.line） */
  line: number
}

/** 从 markdown 文本解析出标题（跳过围栏代码块，避免把代码里的 # 误判为标题） */
export function parseHeadings(md: string): NotebookHeading[] {
  const lines = md.split('\n')
  const out: NotebookHeading[] = []
  let fence: string | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/)
    if (fenceMatch) {
      const marker = fenceMatch[1][0].repeat(3) // ``` 或 ~~~
      if (fence === null) fence = marker
      else if (line.trim().startsWith(fence)) fence = null
      continue
    }
    if (fence !== null) continue
    const m = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/)
    if (m) out.push({ level: m[1].length, text: m[2].trim(), line: i + 1 })
  }
  return out
}
