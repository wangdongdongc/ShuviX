/**
 * Memory 模块入口 —— 项目记忆的扫描与注入解析。
 *
 * 注入契约：`createAgent` 在 profile.projectMemory 为真时调用 resolveProjectMemoryIndex，
 * 把返回文本包进 `<project_memory>` 围栏 append 到系统提示词（系统提示词不参与滚动压缩，
 * 天然免重注入）。索引是**现扫现渲染**的，不落地成文件 —— 物理索引会与正文漂移。
 *
 * 无项目会话解析为 null（不注入）：与项目提示词同一种降级，同一族开关不该有两种语义。
 */
import { renderMemoryIndex } from '@shuvix/agent-runtime'
import { sessionDao } from '../../dao/sessionDao'
import { getProjectMemoryDir } from '../../utils/paths'
import { scanProjectMemories } from './memoryScanner'

export { scanProjectMemories } from './memoryScanner'

/**
 * 解析某根会话的项目记忆索引正文；无项目 / 解析不出任何内容时返回 null。
 * 目录为空时**仍返回文本**（只有表头与写入段）—— 否则记忆库无法从空启动。
 */
export function resolveProjectMemoryIndex(rootSessionId: string): string | null {
  const projectId = sessionDao.pick(rootSessionId, ['projectId'])?.projectId
  if (!projectId) return null
  const memories = scanProjectMemories(projectId)
  return renderMemoryIndex(memories, getProjectMemoryDir(projectId)) || null
}
