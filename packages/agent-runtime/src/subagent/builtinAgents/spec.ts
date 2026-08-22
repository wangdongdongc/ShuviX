/**
 * 内置档案的声明式 spec + 统一构建器 —— 所有内置 agent（含 default / notebook）走同一套处理。
 *
 * **文案的唯一事实源是 md 文件**（同目录 `md/<name>[.<lang>].md`），格式与用户档案
 * `~/.shuvix/agents/<name>.md` 完全一致、经同一个 parseAgentDefinitionFile 解析。
 * 每个 agent 一语言一文件，构建期由 `?raw` 内联进 bundle（两端统一：扩展没有文件系统，
 * 桌面的包也是以源码内联进构建、不落磁盘）—— 部署后 md 只以字符串形式存在于 bundle 里。
 *
 * 语言解析：精确语言 → 基础语言 → en，**按文件整体回退**（半中半英的档案比全英文更难读）。
 * 未翻译的语言文件里正文先放英文原文，翻译债因此出现在正确的位置。
 *
 * 宿主参数（`{{widgetsRoot}}` / `{{wikiRoot}}`）在**构建档案时**就地替换，与迁移前时机
 * 一致（设置页展示内置档案时看到的是真实路径而非占位符）；spec 经 requiredParams 声明
 * 依赖，deps 缺参时该 agent 自动跳过（如扩展无 widget/wiki 根目录）。会话级的
 * `{{shuvix:*}}` 占位符不在此处理，留给 createAgent。
 */
import { parseAgentDefinitionFile } from '../../agentProfile/definitionFile'
import type { AgentProfile } from '../types'

/** 一个内置 agent 的各语言 md 原文（键为语言代码，'en' 必有） */
export type BuiltinProfileSources = Record<string, string> & { en: string }

/** 内置档案声明 —— 纯结构，文案全在 md 里 */
export interface BuiltinProfileSpec {
  name: string
  /** 各语言 md 原文（`?raw` 内联） */
  sources: BuiltinProfileSources
  /** md 正文/描述里的宿主参数名；deps 缺参时跳过本 agent */
  requiredParams?: readonly ('widgetsRoot' | 'wikiRoot')[]
}

export interface BuiltinProfileDeps {
  /** 当前界面语言（i18next.language，如 'zh' / 'zh-CN' / 'ja'）；缺省 en */
  language?: string
  /** widget 根目录（桌面 ~/.shuvix/widgets 展开路径）；缺省时跳过 widget agent */
  widgetsRoot?: string
  /** wiki 根目录；缺省时跳过 wiki agent */
  wikiRoot?: string
}

/**
 * 按语言挑选 md 原文：精确匹配（zh-CN）→ 基础语言（zh）→ en。
 * 导出供宿主的覆盖集（如扩展的浏览器变体 default）复用同一套回退规则。
 */
export function pickLocalizedSource(
  sources: Record<string, string>,
  language: string | undefined
): string {
  const lang = (language || 'en').toLowerCase()
  return sources[lang] ?? sources[lang.split('-')[0]] ?? sources.en
}

/** 宿主参数插值：`{{name}}`（不含 shuvix: 前缀的才是宿主参数，会话变量留给 createAgent） */
function interpolateHostParams(text: string, params: Record<string, string>): string {
  return text.replace(/\{\{([A-Za-z][\w-]*)\}\}/g, (match, key: string) => params[key] ?? match)
}

/**
 * 按 spec + 宿主 deps 现算一个内置档案；缺必需参数返回 null（宿主不支持该 agent）。
 * md 格式非法也返回 null —— 内置 md 随包发布、用户改不到，出现即为开发期错误（有守护测试）。
 */
export function buildBuiltinProfile(
  spec: BuiltinProfileSpec,
  deps: BuiltinProfileDeps
): AgentProfile | null {
  const params: Record<string, string> = {}
  for (const key of spec.requiredParams ?? []) {
    const value = deps[key]
    if (!value) return null
    params[key] = value
  }

  const raw = interpolateHostParams(pickLocalizedSource(spec.sources, deps.language), params)
  // 内置 md 解析失败属开发期错误（随包发布，用户改不到）——诊断通道现成，别静默
  const parsed = parseAgentDefinitionFile(raw, spec.name, (msg) =>
    console.warn(`[builtinAgents] ${msg}`)
  )
  if (!parsed) return null

  return { ...parsed, source: 'builtin', basePath: '' }
}
