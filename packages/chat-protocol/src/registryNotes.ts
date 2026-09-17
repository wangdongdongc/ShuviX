/**
 * ShuviX 注册表 md 的笔记本载体 —— bot / agent / 安全策略 / hook 这四类「宿主据以运行的 md」
 * 打开时与知识库条目走同一条路：一份文件 = 一个笔记本会话（live-preview、自动保存、外部改动
 * 自动重载），会话挂在该注册表目录的**隐藏项目**下（path = 目录本身，项目列表不可见），
 * notebookPath 就是文件名。
 *
 * 没有专门的编辑器、没有显式保存、没有写前校验：解析器的判定由 frontmatter 属性卡实时显示，
 * 写到一半的非法文件与外部编辑器写坏的文件同等对待 —— 不生效，列进「无法解析」那一组。
 */

export type RegistryNoteKind = 'bot' | 'agent' | 'policy' | 'hook'

/** 各注册表目录的隐藏载体项目 id（同 `__knowledge__` 那几个的做法） */
export const REGISTRY_NOTE_PROJECT_IDS: Readonly<Record<RegistryNoteKind, string>> = {
  bot: '__bots__',
  agent: '__agents__',
  policy: '__policies__',
  hook: '__hooks__'
}

/** 这个项目是不是某个注册表目录的笔记本载体 */
export function isRegistryNoteProjectId(id: string | null | undefined): boolean {
  return !!id && Object.values(REGISTRY_NOTE_PROJECT_IDS).includes(id)
}
