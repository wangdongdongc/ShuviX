/**
 * 构建期内联的内置 md —— 给**没有文件系统的宿主**（浏览器扩展）和本包自己的单测用。
 *
 * 内置档案的事实源是 `md/` 目录里的那批文件：桌面把它们随包发布，运行时现读
 * （见 spec.ts 的 readMd 与桌面的 getBuiltinAgentsDir）。扩展跑在浏览器里读不了文件，
 * 于是构建期把**同一批文件**内联进 bundle —— 内联的是那份源文件的构建产物，不是另一份
 * 拷贝，所以仓库里仍然只有一处可编辑的文案。
 *
 * **桌面侧一律不要导入本模块**：它一旦进了 main 的依赖图，那批 md 就又以字符串形式
 * 躺进 bundle，「跑的和看的是同一份文件」这条就没了。
 */
import type { BuiltinMdReader } from './spec'

/** 键形如 './md/work.zh.md'（Vite glob 的路径以本模块为基准） */
const INLINED_MD = import.meta.glob('./md/*.md', {
  query: '?raw',
  import: 'default',
  eager: true
}) as Record<string, string>

/**
 * 构建期内联表的读取口。`dir` 是 glob 键的目录前缀，默认本包的 `md/`；
 * 宿主自带一批变体档案时（扩展的 work/chat 浏览器版）传自己的表，见 createInlineMdReaderFrom。
 */
export function createInlineMdReader(): BuiltinMdReader {
  return (fileName) => INLINED_MD[`./md/${fileName}`] ?? null
}

/**
 * 给宿主自己的内联表用的读取口：`sources` 是 `import.meta.glob(..., { eager: true })` 的结果，
 * 键是路径、值是原文；按文件名后缀匹配，于是宿主的目录结构与本包无关。
 */
export function createInlineMdReaderFrom(sources: Record<string, string>): BuiltinMdReader {
  const byFileName = new Map<string, string>()
  for (const [path, text] of Object.entries(sources)) {
    const fileName = path.split('/').pop()
    if (fileName) byFileName.set(fileName, text)
  }
  return (fileName) => byFileName.get(fileName) ?? null
}
