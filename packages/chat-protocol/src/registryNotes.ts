/**
 * ShuviX 注册表 md 的笔记本载体 —— bot / agent / 安全策略 / hook 这四类「宿主据以运行的 md」
 * 打开时与知识库条目走同一条路：一份文件 = 一个笔记本会话（live-preview、自动保存、外部改动
 * 自动重载），会话挂在该注册表目录的**隐藏项目**下（path = 目录本身，项目列表不可见），
 * notebookPath 就是文件名。
 *
 * 没有专门的编辑器、没有显式保存、没有写前校验：解析器的判定由 frontmatter 属性卡实时显示，
 * 写到一半的非法文件与外部编辑器写坏的文件同等对待 —— 不生效，列进「无法解析」那一组。
 *
 * 第五种 `agentBuiltin` 是同一条路的**只读**分支：内置 agent 档案的 md 随包发布在应用包里
 * （`Resources/builtin-agents/`），运行时读的就是它，于是点开一份内置档案与点开自己的档案
 * 长得一样 —— 只是没有输入卡片、编辑器只渲染（见 isReadOnlyRegistryNoteProjectId）。
 * `policyBuiltin` / `hookBuiltin` 是它的安全策略与 hook 翻版（`Resources/builtin-policies/` /
 * `Resources/builtin-hooks/`），同一套只读语义。
 */

export type RegistryNoteKind =
  | 'bot'
  | 'agent'
  | 'agentBuiltin'
  | 'policy'
  | 'policyBuiltin'
  | 'hook'
  | 'hookBuiltin'

/** 各注册表目录的隐藏载体项目 id（同 `__knowledge__` 那几个的做法） */
export const REGISTRY_NOTE_PROJECT_IDS: Readonly<Record<RegistryNoteKind, string>> = {
  bot: '__bots__',
  agent: '__agents__',
  agentBuiltin: '__agents_builtin__',
  policy: '__policies__',
  policyBuiltin: '__policies_builtin__',
  hook: '__hooks__',
  hookBuiltin: '__hooks_builtin__'
}

/**
 * 只读的注册表笔记：内置 agent 档案 / 内置安全策略 / 内置 hook 随包发布（应用包里的
 * `builtin-agents/` / `builtin-policies/` / `builtin-hooks/`），它就是运行时读的那一份，
 * 但不是用户的文件 —— 笔记本只渲染、不给输入卡片（同内置知识库的 KNOWLEDGE_BUILTIN）。
 * 改它没有意义：下次更新整目录被替换，macOS 上还会破坏应用签名。
 */
export const isReadOnlyRegistryNoteProjectId = (id: string | null | undefined): boolean =>
  id === REGISTRY_NOTE_PROJECT_IDS.agentBuiltin ||
  id === REGISTRY_NOTE_PROJECT_IDS.policyBuiltin ||
  id === REGISTRY_NOTE_PROJECT_IDS.hookBuiltin

/** 这个项目是不是某个注册表目录的笔记本载体 */
export function isRegistryNoteProjectId(id: string | null | undefined): boolean {
  return !!id && Object.values(REGISTRY_NOTE_PROJECT_IDS).includes(id)
}
