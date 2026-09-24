/** 笔记本右侧目录的标题数据 + 解析 —— 与组件分离，便于 fast-refresh / 复用。 */

export interface NotebookHeading {
  /** 标题级别 1-6 */
  level: number
  /** 标题文本（去掉 # 标记） */
  text: string
  /** 所在行号（1-based，对应 CM6 doc.line） */
  line: number
}

/** 围栏定界线：三个以上同种字符（``` / ~~~）+ 其后的信息串 */
const FENCE_RE = /^[ \t]*(`{3,}|~{3,})(.*)$/
/**
 * ATX 标题：至多 3 格缩进（编辑器按 CommonMark 渲染，这样的行照样显示成标题）。收尾的 # 串只有与正文
 * 隔着空白时才算收尾 —— `# Learn C#` 的 # 是正文的一部分。
 */
const HEADING_RE = /^ {0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?\s*$/
/** frontmatter 的闭合线与扫描上限 —— 与 frontmatterCard 的 findFrontmatter 同一判定 */
const FRONTMATTER_CLOSER_RE = /^---[ \t]*$/
const FRONTMATTER_MAX_SCAN_LINES = 200

/**
 * 开头的 frontmatter 占几行（没有则 0）：首行恰为 `---`（容 BOM）且 200 行内闭合。属性卡盖住的正是这一段，
 * 其中的 YAML 注释（`# …`）不该出现在目录里。
 */
function frontmatterLineCount(lines: readonly string[]): number {
  if (lines[0]?.replace(/^\uFEFF/, '') !== '---') return 0
  const last = Math.min(lines.length, FRONTMATTER_MAX_SCAN_LINES)
  for (let i = 1; i < last; i++) if (FRONTMATTER_CLOSER_RE.test(lines[i])) return i + 1
  return 0
}

/**
 * 从 markdown 文本解析出标题：跳过开头的 frontmatter 和围栏代码块（避免把 YAML 注释、代码里的 # 当成标题）。
 * 行号按 `\n` 切分计 —— 与 CM6 doc.line 一致；CRLF 文件的行尾 `\r` 先剥掉。
 */
export function parseHeadings(md: string): NotebookHeading[] {
  const lines = md.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))
  const out: NotebookHeading[] = []
  // 当前所在围栏的开头定界串（null = 不在围栏里）
  let fence: string | null = null
  for (let i = frontmatterLineCount(lines); i < lines.length; i++) {
    const line = lines[i]
    const f = FENCE_RE.exec(line)
    if (fence !== null) {
      // 结尾须同种字符、不短于开头、其后只有空白 —— 四个反引号包着三个反引号的围栏不会被里面那层提前关掉
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && f[2].trim() === '') {
        fence = null
      }
      continue
    }
    // 反引号围栏的信息串里不能再有反引号（那是一行行内代码，不开围栏）
    if (f && !(f[1][0] === '`' && f[2].includes('`'))) {
      fence = f[1]
      continue
    }
    const m = HEADING_RE.exec(line)
    const text = m?.[2].trim()
    if (m && text) out.push({ level: m[1].length, text, line: i + 1 })
  }
  return out
}

/**
 * 当前章节：行号不超过 probeLine 的最后一个标题（probeLine 取视口顶部附近的那一行）。
 * probeLine 落在第一个标题之前（正文还没进入任何章节）时为 -1。headings 须按行号升序 —— parseHeadings 的输出即是。
 */
export function activeHeadingIndex(
  headings: readonly NotebookHeading[],
  probeLine: number
): number {
  let active = -1
  for (let i = 0; i < headings.length; i++) {
    if (headings[i].line > probeLine) break
    active = i
  }
  return active
}

/** 相对级别：文档里最高的一级记为 0 —— 从 H2 写起的文档，H2 / H3 之间照样有长短之分 */
export function relativeLevels(headings: readonly NotebookHeading[]): number[] {
  const top = Math.min(...headings.map((h) => h.level))
  return headings.map((h) => h.level - top)
}
