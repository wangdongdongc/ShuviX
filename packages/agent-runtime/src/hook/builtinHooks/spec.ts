/**
 * 内置 hook 的声明式 spec + 构建器 —— 与 builtinAgents 同一模式：
 * md 是唯一事实源（`?raw` 内联进 bundle），spec 只留结构。
 *
 * 语言回退复用 pickLocalizedSource（精确 → 基础语言 → en，按文件整体回退）。
 * 一份 hook 只有十几行：本地化文件只动 `shuvix-displayName` / `description`，正文（任务文本）
 * 与 frontmatter 结构和 en 保持一致 —— 用眼睛就能对，不再需要字节一致的守护测试。
 */
import { pickLocalizedSource } from '../../subagent/builtinAgents/spec'
import { parseHookDefinitionFile, type ParsedHookFile } from '../hookFile'

/** 一个内置 hook 的各语言 md 原文（'en' 必有） */
export type BuiltinHookSources = Record<string, string> & { en: string }

export interface BuiltinHookSpec {
  name: string
  sources: BuiltinHookSources
}

export interface BuiltinHookDeps {
  /** 当前界面语言；缺省 en */
  language?: string
}

/**
 * 按 spec 现算一个内置 hook。md 解析失败返回 null —— 内置 md 随包发布、用户改不到，
 * 出现即为开发期错误（诊断经 console.warn，与 buildBuiltinProfile 同策）。
 */
export function buildBuiltinHook(
  spec: BuiltinHookSpec,
  deps: BuiltinHookDeps
): ParsedHookFile | null {
  const raw = pickLocalizedSource(spec.sources, deps.language)
  return parseHookDefinitionFile(raw, spec.name, (msg) => console.warn(`[builtinHooks] ${msg}`))
}
