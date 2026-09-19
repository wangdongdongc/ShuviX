/**
 * 构建期内联的内置 **hook** md —— 给**没有文件系统的宿主**（浏览器扩展，一旦它接 hook）和
 * 本包自己的单测用（与 builtinAgents / builtinPolicies 的 inlineSources 同一个模式、同一条规矩）。
 *
 * 内置 hook 的事实源是 `md/` 目录里的那批文件：桌面把它们随包发布到
 * `Resources/builtin-hooks/`，运行时现读（见桌面的 getBuiltinHooksDir）。扩展跑在浏览器里
 * 读不了文件，于是构建期把**同一批文件**内联进 bundle —— 内联的是那份源文件的构建产物，
 * 不是另一份拷贝，仓库里仍然只有一处可编辑的 hook。
 *
 * **桌面产品代码一律不要导入本模块**（有守护测试扫这个）：它一旦进了 main 的依赖图，
 * 那批 md 就又以字符串形式躺进 bundle，「跑的和看的是同一份文件」这条就没了。
 */
import type { BuiltinMdReader } from '../../subagent/builtinAgents/spec'

/** 键形如 './md/auto-title.zh.md'（Vite glob 的路径以本模块为基准） */
const INLINED_MD = import.meta.glob('./md/*.md', {
  query: '?raw',
  import: 'default',
  eager: true
}) as Record<string, string>

/** 构建期内联表的读取口（宿主按文件名取，没有那一版回 null —— 构建器据此按语言回退） */
export function createInlineHookMdReader(): BuiltinMdReader {
  return (fileName) => INLINED_MD[`./md/${fileName}`] ?? null
}

/** 守护测试枚举语言文件用：内联表里全部 md 的文件名（`auto-title.zh.md`） */
export function inlinedHookMdFileNames(): string[] {
  return Object.keys(INLINED_MD).map((key) => key.slice('./md/'.length))
}
