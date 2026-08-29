/**
 * 内置工作流（md 文件 + 构建器，跨端共享）。
 *
 * 与 builtinAgents 同一交付形态：md 经 `?raw` 内联进 bundle，宿主注册表现算列表，
 * 用户以 `~/.shuvix/workflows/<name>.md` 同名覆盖。加一个内置工作流 = md/ 放文件 +
 * 本文件加一条 import 与 spec 条目。
 *
 * BUILTIN_WORKFLOW_NAMES 是宿主 autorun 缺省规则的依据：内置名（含用户覆盖内置的同名
 * 文件）自动触发默认启用 —— 它们是产品的一部分，auto-title 出厂即工作；纯用户工作流
 * 默认关闭，须在配置里显式启用（放下一个 md 不该能静默开始烧 token）。
 */
import { buildBuiltinWorkflow, type BuiltinWorkflowDeps, type BuiltinWorkflowSpec } from './spec'
import type { ParsedWorkflowFile } from '../workflowFile'

import autoTitleEn from './md/auto-title.md?raw'

export { buildBuiltinWorkflow, type BuiltinWorkflowDeps, type BuiltinWorkflowSpec } from './spec'

export const AUTO_TITLE_WORKFLOW_SPEC: BuiltinWorkflowSpec = {
  name: 'auto-title',
  sources: { en: autoTitleEn }
}

export const BUILTIN_WORKFLOW_SPECS: readonly BuiltinWorkflowSpec[] = [AUTO_TITLE_WORKFLOW_SPEC]

export const BUILTIN_WORKFLOW_NAMES: ReadonlySet<string> = new Set(
  BUILTIN_WORKFLOW_SPECS.map((s) => s.name)
)

/** 按宿主 deps 现算全部内置工作流（语言切换自动跟随） */
export function buildBuiltinWorkflows(deps: BuiltinWorkflowDeps): ParsedWorkflowFile[] {
  return BUILTIN_WORKFLOW_SPECS.map((spec) => buildBuiltinWorkflow(spec, deps)).filter(
    (w): w is ParsedWorkflowFile => w !== null
  )
}
