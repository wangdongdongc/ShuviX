/**
 * 构建期内联的内置**安全策略** md —— 给**没有文件系统的宿主**（浏览器扩展）和本包自己的
 * 单测用（与 builtinAgents/inlineSources.ts 同一个模式、同一条规矩）。
 *
 * 内置策略的事实源是 `md/` 目录里的那批文件：桌面把它们随包发布到
 * `Resources/builtin-policies/`，运行时现读（见桌面的 getBuiltinPoliciesDir）。扩展跑在
 * 浏览器里读不了文件，于是构建期把**同一批文件**内联进 bundle —— 内联的是那份源文件的
 * 构建产物，不是另一份拷贝，仓库里仍然只有一处可编辑的策略。
 *
 * **桌面产品代码一律不要导入本模块**（有守护测试扫这个）：它一旦进了 main 的依赖图，
 * 那批 md 就又以字符串形式躺进 bundle，「跑的和看的是同一份文件」这条就没了。
 */
import type { BuiltinMdReader } from '../../subagent/builtinAgents/spec'

/** 键形如 './md/ask-on-read.zh.md'（Vite glob 的路径以本模块为基准） */
const INLINED_MD = import.meta.glob('./md/*.md', {
  query: '?raw',
  import: 'default',
  eager: true
}) as Record<string, string>

/** 构建期内联表的读取口（宿主按文件名取，没有那一版回 null —— 构建器据此按语言回退） */
export function createInlinePolicyMdReader(): BuiltinMdReader {
  return (fileName) => INLINED_MD[`./md/${fileName}`] ?? null
}

/** 守护测试枚举语言文件用：内联表里全部 md 的文件名（`ask-on-read.zh.md`） */
export function inlinedPolicyMdFileNames(): string[] {
  return Object.keys(INLINED_MD).map((key) => key.slice('./md/'.length))
}
