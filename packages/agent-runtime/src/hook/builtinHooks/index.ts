/**
 * 内置 hook（md 文件 + 构建器，跨端共享）。
 *
 * 与 builtinAgents / builtinPolicies 同一交付形态：md **随包发布到磁盘**，运行时经宿主注入的
 * `readMd` 现读（桌面 = `Resources/builtin-hooks/`，扩展 = 构建期内联的同一批文件，见
 * inlineSources.ts）—— 侧栏点开一份内置 hook 的只读笔记本，读的就是运行时读的那一份。
 * 宿主注册表现算列表，用户以 `~/.shuvix/hooks/<name>.md` 同名覆盖。
 * 加一个内置 hook = md/ 放三份文件（en/zh/ja）+ 本文件加一条 spec 条目（不再需要 import）。
 */
import { buildBuiltinHook, type BuiltinHookDeps, type BuiltinHookSpec } from './spec'
import type { ParsedHookFile } from '../hookFile'

export { buildBuiltinHook, type BuiltinHookDeps, type BuiltinHookSpec } from './spec'

/**
 * 会话自动标题：首条 prompt 起一个快标题，第二轮结束后精修一次；两条绑定都派发内置 `titler`。
 * 三语言整文件回落，只有 `shuvix-displayName` / `description` 随语言变。
 */
export const AUTO_TITLE_HOOK_SPEC: BuiltinHookSpec = {
  name: 'auto-title'
}

/**
 * 询问点的自动审查：策略判出 ask（非 force-ask）、弹卡片之前，判定型埋点 `permission.request` 派发
 * 内置 `permission-reviewer`，它的结论替用户作答（设计稿 docs/permission-review-design.md）。设置里的
 * `security.autoReview` 关掉时宿主不再问 hook；覆盖这份 md 可以改绑定条件或换审查 agent。
 */
export const AUTO_REVIEW_HOOK_SPEC: BuiltinHookSpec = {
  name: 'auto-review'
}

export const BUILTIN_HOOK_SPECS: readonly BuiltinHookSpec[] = [
  AUTO_TITLE_HOOK_SPEC,
  AUTO_REVIEW_HOOK_SPEC
]

/** 按宿主 deps 现算全部内置 hook（语言切换自动跟随） */
export function buildBuiltinHooks(deps: BuiltinHookDeps): ParsedHookFile[] {
  return BUILTIN_HOOK_SPECS.map((spec) => buildBuiltinHook(spec, deps)).filter(
    (h): h is ParsedHookFile => h !== null
  )
}
