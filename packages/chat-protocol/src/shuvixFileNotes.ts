/**
 * 「这条笔记本会话的文档是哪一种 ShuviX 文件」—— 按承载项目判（一份文件 = 一个笔记本会话，会话挂在
 * 那个目录的隐藏承载项目下，见 registryNotes / skillNotes / knowledge）。
 *
 * 为什么按承载项目而不按文件里的 `shuvix:` 标记：标记在读时可选（策略、hook、agent、bot 没写标记照样
 * 生效），写到一半的文件也可能暂时没有；而会话挂在哪个目录从建起就不变 —— 那个目录决定了宿主拿它当
 * 什么用。
 *
 * 两处读这份判定，口径必须一致：
 *  - 笔记本 agent 的提示词 `{{shuvix:documentKind}}`（这是什么文件、何时生效、规范在说明书哪一条）；
 *  - 会话的知识库 —— 文档是 ShuviX 文件的笔记本隐式启用内置说明书 `shuvix`（同项目会话隐式带项目库），
 *    否则提示词指着一份它查不到的规范。
 *
 * 日报、跟踪项不在其中：它们是用户自己的笔记，宿主不按什么格式解析它们。
 */
import { isKnowledgeProjectId } from './knowledge'
import { REGISTRY_NOTE_PROJECT_IDS, type RegistryNoteKind } from './registryNotes'
import { isSkillProjectId } from './skillNotes'

export type ShuvixFileKind = 'agent' | 'bot' | 'policy' | 'hook' | 'skill' | 'knowledge'

/**
 * 宿主拿真解析器判定的那几种（agent-runtime `validateShuvixMdText`）：只有它们有「能不能解析、为什么不能」
 * 可报 —— doc_read 的判定与笔记本提示词里那段「改动会被检查」都只给它们，两边读这一份
 */
export const PARSED_SHUVIX_FILE_KINDS: readonly ShuvixFileKind[] = [
  'agent',
  'bot',
  'policy',
  'hook'
]

export const isParsedShuvixFileKind = (kind: string | null | undefined): kind is ShuvixFileKind =>
  !!kind && (PARSED_SHUVIX_FILE_KINDS as readonly string[]).includes(kind)

/** 注册表载体 → 文件种类（内置的只读那几个归回本类） */
const REGISTRY_KIND: Readonly<Record<RegistryNoteKind, ShuvixFileKind>> = {
  bot: 'bot',
  agent: 'agent',
  agentBuiltin: 'agent',
  policy: 'policy',
  policyBuiltin: 'policy',
  hook: 'hook',
  hookBuiltin: 'hook'
}

/** 这个承载项目里的笔记本，文档是哪种 ShuviX 文件；不是 ShuviX 文件的载体（含普通项目、无项目）→ null */
export function shuvixFileKindOfProject(
  projectId: string | null | undefined
): ShuvixFileKind | null {
  if (!projectId) return null
  for (const kind of Object.keys(REGISTRY_NOTE_PROJECT_IDS) as RegistryNoteKind[]) {
    if (REGISTRY_NOTE_PROJECT_IDS[kind] === projectId) return REGISTRY_KIND[kind]
  }
  if (isSkillProjectId(projectId)) return 'skill'
  if (isKnowledgeProjectId(projectId)) return 'knowledge'
  return null
}
