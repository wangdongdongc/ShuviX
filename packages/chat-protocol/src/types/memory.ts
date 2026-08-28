/**
 * 项目记忆的**前端视图形状** —— 侧栏「项目记忆」子文件夹列表所需的一条一行。
 *
 * 与 agent-runtime 的 ParsedMemoryFile 刻意分开：那边是解析器的产物（含正文 body，
 * 每条几 KB），侧栏只需要标题/摘要/召回条件这几行；把正文一并送进渲染进程，等于
 * 每次展开项目组都把整个记忆库搬一遍。正文由笔记本会话按需读（files.read）。
 *
 * `slug` 是路径的唯一真源（= 磁盘 basename，见 memoryFile.ts 的同名字段注释）；
 * `path` 给宿主做绝对定位（笔记本会话绑定它），前端只把它当不透明串传回。
 */
export interface ProjectMemoryEntry {
  /** 文件名（不含 .md）—— 打开/去重都以它为准 */
  slug: string
  /** frontmatter 的 name：人话标题，列表显示用；缺省回落 slug */
  name: string
  /** 一句话摘要（给人看） */
  description: string
  /** 什么时候值得展开（给模型看的召回条件）—— 列表悬浮提示里补充展示 */
  recall: string
  /** 常驻记忆：正文每会话全额注入，列表上单独标记 */
  pinned: boolean
  /** 最后更新日期（YYYY-MM-DD，可缺） */
  updated?: string
  /** md 文件绝对路径（笔记本会话的 notebookPath） */
  path: string
}
