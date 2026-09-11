/**
 * 两个根与 bundle 路径算术（桌面）。
 *
 *   `~/.shuvix/knowledge/`         用户的库（容器）—— 每个子目录是一个自带 index/log/git 的
 *                                  独立 bundle。宿主只读只搜，不投影、不盖章、不提交。
 *                                  本期还没有导入流程，先占住名字。
 *   `~/.shuvix/knowledge-shuvix/`  ShuviX 维护的（容器）—— 一个绑定实体一个 bundle，全套簿记
 *                                  归宿主。本期只有 `projects/<slug>/`。
 *
 * 「bundle id」是**相对 shuvix 根**的目录路径（如 `projects/acme`），它同时是条目 id 的前缀。
 * bundle 内部的路径一律 bundle 相对（OKF 的口径）。
 */
import { join } from 'path'
import { KNOWLEDGE_PROJECTS_DIR } from '@shuvix/chat-protocol/knowledge'
import { normalizeBundlePath } from '@shuvix/agent-runtime'
import { getShuvixKnowledgeRootDir, getUserKnowledgeRootDir } from '../../utils/paths'

/** ShuviX 维护的那个根（容器，不是 bundle） */
export function getShuvixKnowledgeRoot(): string {
  return getShuvixKnowledgeRootDir()
}

/** 用户的库根（容器，不是 bundle）；本期只占名字，无人扫描 */
export function getUserKnowledgeRoot(): string {
  return getUserKnowledgeRootDir()
}

/** 项目 bundle 的容器目录（shuvix 根相对） */
export const PROJECTS_CONTAINER = KNOWLEDGE_PROJECTS_DIR

/** bundle id（shuvix 根相对）→ 绝对目录 */
export function bundleDir(bundle: string): string {
  return join(getShuvixKnowledgeRoot(), ...normalizeBundlePath(bundle).split('/'))
}

/** bundle 内的相对路径 → 绝对路径 */
export function bundleFilePath(bundle: string, rel: string): string {
  return join(bundleDir(bundle), ...normalizeBundlePath(rel).split('/'))
}

/** 绝对路径 → shuvix 根相对；不在该根下返回 null */
export function toShuvixRelative(absPath: string): string | null {
  const root = getShuvixKnowledgeRoot().replace(/\\/g, '/').replace(/\/+$/, '')
  const p = absPath.replace(/\\/g, '/')
  if (!root || !p.startsWith(`${root}/`)) return null
  return p.slice(root.length + 1)
}

/**
 * 绝对路径 → 它所属的 bundle id 与 bundle 内相对路径；不在任何 bundle 内返回 null。
 * 本期的 bundle 边界恰是 `projects/<slug>`：容器目录本身与更浅的层级都不是 bundle。
 */
export function locateBundle(absPath: string): { bundle: string; rel: string } | null {
  const rel = toShuvixRelative(absPath)
  if (rel === null) return null
  const segs = normalizeBundlePath(rel).split('/')
  if (segs.length < 3 || segs[0] !== PROJECTS_CONTAINER) return null
  return { bundle: `${segs[0]}/${segs[1]}`, rel: segs.slice(2).join('/') }
}
