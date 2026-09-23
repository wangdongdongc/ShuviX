/**
 * 聊天输入框 `@` 引用「知识库」源的候选清单 —— 该会话**启用库**内的条目视图
 * （chat-protocol `KnowledgeMentionEntry`，不含正文）。与侧栏的 `listKnowledgeEntries` 不同：
 * 这里按会话圈定（`enabledTargets` 与 knowledge 工具同一口径的启用库硬边界），并随每条
 * 带上发给 agent 的指针（`baseName` + `bundlePath`，knowledge 工具 `read` 直接接受）。
 *
 * 清单是只读的：复用 scanBundle 的缓存扫描，不建任何东西。
 */
import {
  KNOWLEDGE_BUILTIN_BASE,
  KNOWLEDGE_PROJECT_BASE,
  type KnowledgeMentionEntry
} from '@shuvix/chat-protocol/knowledge'
import { projectDao } from '../../dao/projectDao'
import { sessionRecords } from '../sessionRecords'
import { builtinBaseDisplayName } from './knowledgePaths'
import { scanBundle } from './scan'
import { enabledTargets } from './sessionBundle'

/** 该会话启用库内的全部条目（用户库在前、保留名按启用选择里的顺序；每库内按路径字典序） */
export async function listKnowledgeMentionEntries(
  sessionId: string
): Promise<KnowledgeMentionEntry[]> {
  const targets = enabledTargets(sessionId)
  if (targets.length === 0) return []
  // 项目库显示名 = 项目当前的名字（改名即时生效，同侧栏口径）
  const projectId = sessionRecords.pick(sessionId, ['projectId'])?.projectId
  const projectName = (projectId ? projectDao.findById(projectId)?.name : undefined)?.trim()

  const out: KnowledgeMentionEntry[] = []
  for (const { name, target } of targets) {
    const bundleLabel =
      name === KNOWLEDGE_PROJECT_BASE
        ? projectName || name
        : name === KNOWLEDGE_BUILTIN_BASE
          ? builtinBaseDisplayName()
          : name
    const scan = await scanBundle(target.bundle)
    for (const note of scan.notes) {
      out.push({
        path: `${target.bundle}/${note.path}`,
        baseName: name,
        bundlePath: `/${note.path}`,
        title: note.title,
        description: note.description,
        bundleLabel
      })
    }
  }
  return out
}
