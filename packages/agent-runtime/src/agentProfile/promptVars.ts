/**
 * Prompt 变量（PromptVars）—— agent 无关的创建期变量表。
 *
 * md 正文（含内置档案各语言 body）用 `{{shuvix:name}}` 占位符引用会话动态值；
 * createAgent 时宿主经 `promptVars(ctx)` 现算一张变量表，`renderProfileSystemPrompt`
 * 对 body 做统一替换。语法与 i18next 插值互不干扰（`{{shuvix:*}}` 对 i18next 是
 * 缺值变量，skipOnVariables 默认开启 → 原样穿透；宿主参数如 `{{widgetsRoot}}`
 * 仍在档案构建期由 i18next 替换）。
 *
 * 约定：
 * - 标量（workingDirectory/platform/date/…）：md 自己组织句子与列表；
 * - 自含块（workspaceIntro 等）：值携带引导句，
 *   无内容时为空串，替换后的空行收敛（\n{3,} → \n\n）让空块整体消失；
 * - 未知/宿主不支持的占位符原样保留并 warn（信息面板可见，便于发现 typo）。
 */
import type { RuntimeLogger } from '../types'
import type { InProcessAgentType } from '../subagent/types'

export type AgentKind = 'root' | 'spawned'

export interface PromptVarsCtx {
  sessionId: string
  kind: AgentKind
  /** 工作目录（桌面=绝对路径；扩展=项目文件夹名或 'scratch'） */
  cwd: string
}

/** 变量表：name → 替换值（'' = 该占位符处整块消失） */
export type PromptVars = Record<string, string>

/** 占位符：{{shuvix:name}}（name 首字符为字母，后续字母/数字/_/-） */
const PLACEHOLDER_RE = /\{\{shuvix:([A-Za-z][\w-]*)\}\}/g

/** 支持语言的原生名（language 变量输出用户界面语言时用，非翻译文案故不进 locales） */
const LANGUAGE_NATIVE_NAMES: Record<string, string> = {
  zh: '中文',
  en: 'English',
  ja: '日本語'
}

/** 用户界面语言的展示形式（如 zh → 「中文 (zh)」；未知语言原样返回代码；两端 language 变量共用） */
export function formatLanguageDisplay(lang: string | undefined): string {
  const base = (lang || 'en').split('-')[0].toLowerCase()
  const native = LANGUAGE_NATIVE_NAMES[base]
  return native ? `${native} (${base})` : base
}

/** 对文本做 {{shuvix:*}} 替换 + 空行收敛（导出供宿主的独立渲染路径复用） */
export function substitutePromptVars(
  text: string,
  vars: PromptVars,
  logger?: RuntimeLogger
): string {
  const substituted = text.replace(PLACEHOLDER_RE, (match, name: string) => {
    const value = vars[name]
    if (value === undefined) {
      logger?.warn(`[promptVars] unknown placeholder "${match}" — kept verbatim`)
      return match
    }
    return value
  })
  return substituted.replace(/\n{3,}/g, '\n\n').trim()
}

/** 组装完整系统提示：md 正文即全部，占位符经宿主变量表替换 */
export function renderProfileSystemPrompt(
  profile: Pick<InProcessAgentType, 'systemPrompt'>,
  vars: PromptVars,
  logger?: RuntimeLogger
): string {
  return substitutePromptVars(profile.systemPrompt, vars, logger)
}
