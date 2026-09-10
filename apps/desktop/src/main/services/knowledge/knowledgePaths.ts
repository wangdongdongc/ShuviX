/**
 * 知识库根目录与 bundle 路径算术（桌面）。根目录 = ~/.shuvix/knowledge（utils/paths）。
 * bundle 相对路径恒为 forward-slash、无前导 `/`（与 agent-runtime knowledge/ 的约定一致）。
 */
import { join } from 'path'
import { getKnowledgeRootDir } from '../../utils/paths'

export function getKnowledgeRoot(): string {
  return getKnowledgeRootDir()
}

/** 绝对路径 → bundle 相对路径；不在根目录下返回 null */
export function toBundlePath(absPath: string): string | null {
  const root = getKnowledgeRoot().replace(/\\/g, '/').replace(/\/+$/, '')
  const p = absPath.replace(/\\/g, '/')
  if (!root || !p.startsWith(`${root}/`)) return null
  return p.slice(root.length + 1)
}

/** bundle 相对路径 → 绝对路径 */
export function fromBundlePath(rel: string): string {
  return join(getKnowledgeRoot(), ...rel.split('/'))
}
