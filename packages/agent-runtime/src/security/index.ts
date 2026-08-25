/**
 * 智能体安全模块（PDP + PEP 门面）—— 模块导览：
 *   types.ts          核心类型（请求五要素 / 属性文档客体 / 规则 / 决策 / 宿主注入面）
 *   allowEntries.ts   allowList 条目解析与路径段边界匹配（自桌面下沉，Node-free）
 *   celMatch.ts       CEL 匹配层（match/lets 编译与求值；唯一的匹配语义）
 *   policyFile.ts     策略 md 解析/序列化（`shuvix: policy v1`；规则 = effect + match）
 *   builtinPolicies/  内置策略（md ?raw 内联；用户可在 ~/.shuvix/policies 同名覆盖）
 *   assemble.ts       四层来源装配 + lets 求值 + tier 标定（force-allow 用原生谓词）
 *   evaluate.ts       统一评估纯函数（deny → force-ask → force-allow → ask → static-allow → default）
 *   enforce.ts        决策执行（询问挂起 + 四分支响应收敛）+ 决策日志埋点
 *   commandFacts.ts   命令客体的结构属性投影（ShellFacts → CEL 可消费的属性）
 *   context.ts        createSecurityContext —— PEP 唯一入口
 *   decisionLog.ts    每会话 ring buffer + RuntimeLogger 结构化输出
 *   shell/            bash 命令解析层（tree-sitter-bash；双轨事实抽取）
 */
export * from './types'
export {
  parseAllowEntry,
  buildAllowEntry,
  matchesPathEntry,
  isPathAllowedUnified,
  type AllowToolType
} from './allowEntries'
export {
  parsePolicyDefinitionFile,
  serializePolicyDefinitionFile,
  POLICY_FILE_MARKER,
  POLICY_FILE_MARKER_KEY,
  POLICY_RULES_KEY,
  POLICY_LETS_KEY,
  POLICY_PROMPT_MAX
} from './policyFile'
export {
  buildBuiltinPolicies,
  BUILTIN_POLICY_SPECS,
  type BuiltinPolicySpec
} from './builtinPolicies'
export { assembleRules, mergePolicyFiles } from './assemble'
export { evaluate, buildMatchContext, type EvaluateOpts } from './evaluate'
export { compileMatch, evaluateMatch, evaluateLet } from './celMatch'
export { executeDecision } from './enforce'
export { createSecurityContext } from './context'
export { projectCommandFacts, type CommandAttr, type CommandFactAttrs } from './commandFacts'
export { recordDecision, getSessionDecisions, clearSessionDecisions } from './decisionLog'
export * from './shell'
