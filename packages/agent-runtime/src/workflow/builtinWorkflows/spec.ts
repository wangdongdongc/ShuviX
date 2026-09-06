/**
 * 内置工作流的声明式 spec + 构建器 —— 与 builtinAgents 同一模式：
 * md 是文案与逻辑的唯一事实源（`?raw` 内联进 bundle），spec 只留结构。
 *
 * 语言回退复用 pickLocalizedSource（精确 → 基础语言 → en，按文件整体回退）。
 * 注意：工作流 md 的**脚本与 frontmatter 结构**是行为语义，而整文件回落意味着各语言文件
 * 真的会被逐份解析执行 —— 所以纪律是「本地化只许动人读面（`shuvix-displayName` /
 * `description` / 散文 / `md prompt=` 块），脚本块、schema 块与结构字段与 en 逐字节同」，
 * 每份内置各有一条守护测试钉住（workflow/__tests__/*Localization.test.ts）。
 * 与 policy md 的做法（构建器主动忽略本地化文件的判定字段、结构恒取 en）取向不同：
 * 那边靠机制，这边靠守护测试 —— 因为工作流没有「判定字段」这样一小撮可枚举的键。
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
