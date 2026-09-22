/**
 * 构建期内联的内置 md —— **只给单测用**（本包与桌面的测试读的就是这批源文件）。
 *
 * 内置档案的事实源是 `md/` 目录里的那批文件：桌面把它们随包发布，运行时现读
 * （见 spec.ts 的 readMd 与桌面的 getBuiltinAgentsDir）。这里把**同一批文件**经 Vite glob
 * 内联进来，给测试一个不依赖磁盘布局的读取口 —— 内联的是源文件本身，不是另一份拷贝。
 *
 * **产品代码一律不要导入本模块**（有守护测试扫这个）：它一旦进了 main 的依赖图，那批 md
 * 就又以字符串形式躺进 bundle，「跑的和看的是同一份文件」这条就没了。
 */
import type { BuiltinMdReader } from './spec'

/** 键形如 './md/work.zh.md'（Vite glob 的路径以本模块为基准） */
const INLINED_MD = import.meta.glob('./md/*.md', {
  query: '?raw',
  import: 'default',
  eager: true
}) as Record<string, string>

/** 构建期内联表的读取口（按文件名取，没有那一版回 null —— 构建器据此按语言回退） */
export function createInlineMdReader(): BuiltinMdReader {
  return (fileName) => INLINED_MD[`./md/${fileName}`] ?? null
}
