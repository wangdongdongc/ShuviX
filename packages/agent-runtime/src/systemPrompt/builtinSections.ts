/**
 * 内置系统提示词卡片定义（跨端共享，单一真源）。
 *
 * 卡片「内容」全部来自共享 i18n（chat-protocol locales 的 systemPromptCards.*），
 * 桌面与扩展用各自的 i18next 实例解析同一 key → 文案一致。唯一平台相关的是 environment
 * 动态卡片：内容由各端注入的 renderEnvironment 生成（桌面 Node os/fs；扩展浏览器上下文）。
 */

/** 内置系统提示词卡片 id（也用作 i18n key 中缀） */
export type BuiltinSectionId =
  | 'identity'
  | 'doing_tasks'
  | 'using_tools'
  | 'executing_actions'
  | 'tone_style'
  | 'environment'

/** environment 动态卡片 id（内容由 renderEnvironment 注入，其余皆静态 i18n） */
export const ENVIRONMENT_SECTION_ID: BuiltinSectionId = 'environment'

/** 真实顺序的来源——不可被用户拖拽改变 */
export const BUILTIN_SECTION_ORDER: readonly BuiltinSectionId[] = [
  'identity',
  'doing_tasks',
  'using_tools',
  'executing_actions',
  'tone_style',
  'environment'
]

const BUILTIN_SECTION_SET: ReadonlySet<BuiltinSectionId> = new Set(BUILTIN_SECTION_ORDER)

/** 合法 id 校验，便于过滤掉残留的过期 id */
export function isBuiltinSectionId(id: string): id is BuiltinSectionId {
  return BUILTIN_SECTION_SET.has(id as BuiltinSectionId)
}

/** 卡片是否为动态生成（仅 environment）——UI 据此决定是否显示「预览」按钮 */
export function isDynamicBuiltin(id: BuiltinSectionId): boolean {
  return id === ENVIRONMENT_SECTION_ID
}

/** 取内置卡片标题（注入 t 解析当前语言） */
export function getBuiltinTitle(id: BuiltinSectionId, t: (key: string) => string): string {
  return t(`systemPromptCards.${id}.title`)
}

/** 取静态内置卡片内容（environment 返回空——其内容由 renderEnvironment 提供） */
export function getStaticBuiltinContent(id: BuiltinSectionId, t: (key: string) => string): string {
  if (isDynamicBuiltin(id)) return ''
  return t(`systemPromptCards.${id}.content`)
}

/** 支持语言的原生名（environment 卡片输出用户界面语言时用，非翻译文案故不进 locales） */
const LANGUAGE_NATIVE_NAMES: Record<string, string> = {
  zh: '中文',
  en: 'English',
  ja: '日本語'
}

/** 用户界面语言的展示形式（如 zh → 「中文 (zh)」；未知语言原样返回代码） */
export function formatLanguageDisplay(lang: string | undefined): string {
  const base = (lang || 'en').split('-')[0].toLowerCase()
  const native = LANGUAGE_NATIVE_NAMES[base]
  return native ? `${native} (${base})` : base
}

/** environment 卡片渲染上下文（仅动态卡片用） */
export interface BuiltinRenderCtx {
  /** 当前会话工作目录（桌面用于检测 git 仓库；不直接输出） */
  workingDirectory?: string
}
