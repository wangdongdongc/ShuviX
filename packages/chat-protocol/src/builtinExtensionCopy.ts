/**
 * 内置技能与内置 MCP 的界面文案 —— 一个本地化的名字（label）和一行说明（hint），给人看的那几处用：
 * 工具选择器、扩展能力、设置 → MCP、侧边栏的技能行、斜杠命令。
 *
 * 文案住在界面语言文件里（各端用自己的 t 解析，切换语言即时生效），不在 SKILL.md：SKILL.md 的
 * description 是写给模型的触发说明（skill 工具的描述原样带它），塞满关键词，不适合当界面文案；
 * 内置 MCP 则根本没有 md。标识名（`drawing` / `browser`）照旧是斜杠命令、`skill:builtin:<name>` /
 * `mcp:<name>` 与 agent 档案引用的名字，界面上要保留可见。
 *
 * 内置 MCP 的名字与工具调用块上的标签是同一个键（BUILTIN_MCP_PRESENTATIONS 的 labelKey），
 * 两处不会各说各话。
 */
import { BUILTIN_MCP_PRESENTATIONS } from './builtinMcpPresentations'

export interface BuiltinExtensionCopy {
  /** 本地化的名字（「绘图」「浏览器」） */
  label: string
  /** 一行说明它做什么 */
  hint: string
}

interface BuiltinCopyKeys {
  labelKey: string
  hintKey: string
}

/**
 * 内置技能 → 文案键。键是技能名（`resources/skills/<lang>/<name>/`），与技能目录的一致性
 * 由桌面的守护用例（builtinSkillsResources）钉住：漏一个，那个技能在界面上就只剩标识名与触发说明。
 */
export const BUILTIN_SKILL_COPY: Record<string, BuiltinCopyKeys> = {
  drawing: { labelKey: 'builtinSkill.drawing.label', hintKey: 'builtinSkill.drawing.hint' },
  widget: { labelKey: 'builtinSkill.widget.label', hintKey: 'builtinSkill.widget.hint' }
}

/** 自有属性才算：`toString` / `constructor` 这类名字不能从原型上捡到一份文案 */
function ownEntry<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined
}

/**
 * 内置技能的文案。认 `builtin:drawing` 与选择器里的 `skill:builtin:drawing` 两种写法；
 * 别的技能（包括外部目录里同名的 `drawing`）→ undefined。
 */
export function builtinSkillCopy(
  name: string,
  t: (key: string) => string
): BuiltinExtensionCopy | undefined {
  const id = name.startsWith('skill:') ? name.slice('skill:'.length) : name
  if (!id.startsWith('builtin:')) return undefined
  const keys = ownEntry(BUILTIN_SKILL_COPY, id.slice('builtin:'.length))
  return keys && { label: t(keys.labelKey), hint: t(keys.hintKey) }
}

/**
 * 内置 MCP 的文案。认 server 名（`browser`）与选择器里的 `mcp:browser`；不是内置 server 的名字 → undefined。
 * 只凭名字认：内置行占着这几个名字（撞名的自定义行会被迁移改名），调用方手里有 isBuiltin 时仍应先看它。
 */
export function builtinMcpCopy(
  name: string,
  t: (key: string) => string
): BuiltinExtensionCopy | undefined {
  const server = name.startsWith('mcp:') ? name.slice('mcp:'.length) : name
  const def = ownEntry(BUILTIN_MCP_PRESENTATIONS, server)
  return def && { label: t(def.labelKey), hint: t(def.hintKey) }
}

/** 名字与标识名只差大小写（`SSH` / `ssh`）时不必再把标识名并排写一遍 */
export function sameAsIdentifier(label: string, identifier: string): boolean {
  return label.trim().toLowerCase() === identifier.toLowerCase()
}
