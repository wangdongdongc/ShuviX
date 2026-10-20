/**
 * 策略变量表 —— 策略 md 里 `vars.*` 看到的东西，**唯一定义处**。
 *
 * 全部由宿主的 getVars 给出：事实变量（workspace / home / skillsDirs…）与会话权限表
 *   vars.aclRead   string[]  这条会话免询问可读的路径（写隐含读：可写的也在里面）
 *   vars.aclWrite  string[]  这条会话免询问可写的路径
 * （桌面见 services/acl：工作目录、会话目录、勾选的知识库与技能目录、「允许并记住」的授权，一张表）。
 *
 * 权限表的**逻辑**（谁在表外要问）写在策略 md 里（出厂的 ask-on-external-path），用户可覆盖可移除；
 * 表的**数据**（哪些路径）是运行时值，经 vars 以数据绑定进入求值上下文。md 里的表达式是固定文本
 * （`inDir(object.path, vars.aclWrite)`），路径从不拼进 CEL 源码。
 *
 * **必须两处共用**：match 的 vars 来自 evaluate 的 opts（context.ts 传入），lets 的 vars 来自
 * assemble —— 两处各取一次会在取值时机不同时给出不一致的视图。
 */
import type { PolicyVarValue, SecurityHostProvider } from './types'

/** 装配/求值当次的完整变量表（每次现取 —— 会话中途加授权须立即可见） */
export function buildPolicyVars(provider: SecurityHostProvider): Record<string, PolicyVarValue> {
  return provider.getVars()
}
