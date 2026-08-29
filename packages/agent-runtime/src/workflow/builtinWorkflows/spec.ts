/**
 * 内置工作流的声明式 spec + 构建器 —— 与 builtinAgents 同一模式：
 * md 是文案与逻辑的唯一事实源（`?raw` 内联进 bundle），spec 只留结构。
 *
 * 语言回退复用 pickLocalizedSource（精确 → 基础语言 → en，按文件整体回退）。
 * 注意：工作流 md 的**脚本与 frontmatter 结构**是行为语义 —— 若未来补本地化文件，
 * 必须沿 policy md 的先例「结构恒取 en、本地化文件只贡献人读面」+ 守护测试钉住；
 * v1 内置工作流仅有 en 文件，回退天然覆盖所有语言，先不引入这条机制。
 */
import { pickLocalizedSource } from '../../subagent/builtinAgents/spec'
import { parseWorkflowDefinitionFile, type ParsedWorkflowFile } from '../workflowFile'

/** 一个内置工作流的各语言 md 原文（'en' 必有） */
export type BuiltinWorkflowSources = Record<string, string> & { en: string }

export interface BuiltinWorkflowSpec {
  name: string
  sources: BuiltinWorkflowSources
}

export interface BuiltinWorkflowDeps {
  /** 当前界面语言；缺省 en */
  language?: string
}

/**
 * 按 spec 现算一个内置工作流。md 解析失败返回 null —— 内置 md 随包发布、用户改不到，
 * 出现即为开发期错误（诊断经 console.warn，与 buildBuiltinProfile 同策）。
 */
export function buildBuiltinWorkflow(
  spec: BuiltinWorkflowSpec,
  deps: BuiltinWorkflowDeps
): ParsedWorkflowFile | null {
  const raw = pickLocalizedSource(spec.sources, deps.language)
  return parseWorkflowDefinitionFile(raw, spec.name, (msg) =>
    console.warn(`[builtinWorkflows] ${msg}`)
  )
}
