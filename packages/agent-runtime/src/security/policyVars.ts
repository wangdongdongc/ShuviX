/**
 * 策略变量表 —— 策略 md 里 `vars.*` 看到的东西，**唯一定义处**。
 *
 * = 宿主静态变量（workspace / home / skillsDirs / memoryDirs…）⊕ 会话授权派生变量：
 *   vars.autoAllow     boolean   会话「免询问」开关
 *   vars.grantedRead   string[]  allowList 里的 Read(...) 路径
 *   vars.grantedWrite  string[]  allowList 里的 Write(...) 路径
 *
 * 为什么会话授权走 vars 而不是像从前那样在 assemble 里编译成原生谓词：
 * 授权的**逻辑**（写授权隐含读、路径段边界匹配）现在由内置的 session-path-grants /
 * session-auto-allow 两份策略 md 用 `effect: force-allow` 表达，用户可覆盖可移除；
 * 授权的**数据**（哪些路径）仍是运行时值，经 vars 以数据绑定进入求值上下文。
 * 注入安全性没有退化：md 里的表达式是固定文本（`inDir(object.path, vars.grantedWrite)`），
 * 路径从不拼进 CEL 源码 —— 这正是从前坚持用原生谓词想守住的性质。
 * `inDir` 的实现就是 allowList 那个 matchesPathEntry，所以两种写法逐字等价。
 *
 * **必须两处共用**：match 的 vars 来自 evaluate 的 opts（context.ts 传入），
 * lets 的 vars 来自 assemble —— 只在其中一处注入授权变量，另一处就会缺键，
 * strict 语义下报错走 fail-safe（allow 视为不命中），授权**静默失效**。
 */
import { parseAllowEntry } from './allowEntries'
import type { PolicyVarValue, SecurityHostProvider } from './types'

/** 装配/求值当次的完整变量表（每次现取 —— 会话中途改开关或加授权须立即可见） */
export function buildPolicyVars(provider: SecurityHostProvider): Record<string, PolicyVarValue> {
  const grants = provider.getSessionGrants()
  const grantedRead: string[] = []
  const grantedWrite: string[] = []
  for (const entry of grants.allowList) {
    const parsed = parseAllowEntry(entry)
    // 历史遗留的 Bash(...)/SSH(...) 条目解析为 null：等同失效字符串，不授予任何权限
    if (!parsed) continue
    if (parsed.toolType === 'write') grantedWrite.push(parsed.path)
    else grantedRead.push(parsed.path)
  }
  // 授权变量后置 —— 宿主 getVars 不慎同名定义也劫持不了会话授权
  return {
    ...provider.getVars(),
    autoAllow: grants.autoAllow,
    grantedRead,
    grantedWrite
  }
}
