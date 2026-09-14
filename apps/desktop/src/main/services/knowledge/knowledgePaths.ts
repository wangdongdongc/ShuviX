/**
 * 两个根与 bundle 路径算术（桌面）。
 *
 *   `~/.shuvix/knowledge/`         用户的库（容器）—— **每个子目录都是一个用户知识库**，不要求
 *                                  任何标记（OKF 连根 index 的 `okf_version` 都只是 MAY）。建库、
 *                                  改名、删库全交给文件系统；簿记与项目库一视同仁。
 *   `~/.shuvix/knowledge-shuvix/`  ShuviX 维护的（容器）—— 一个绑定实体一个 bundle，本期只有
 *                                  `projects/<projectId>/`。
 *
 * 「bundle id」同时是条目 id 的前缀，两个根共用一个名字空间：
 *   - 项目库 `projects/<projectId>`（相对 knowledge-shuvix 根，沿用至今 —— 存量会话与测试都不动）
 *   - 用户库 `knowledge/<库名>`（首段就是用户根的目录名）
 * 首段不同，两者天然不撞。代价是一条保留：knowledge-shuvix 根下永远不能出现名为 `knowledge` 的容器。
 *
 * bundle 内部的路径一律 bundle 相对（OKF 的口径）。
 */
import { join } from 'path'
import { KNOWLEDGE_PROJECTS_DIR, KNOWLEDGE_USER_ROOT_DIR } from '@shuvix/chat-protocol/knowledge'
import { normalizeBundlePath } from '@shuvix/agent-runtime'
import { getShuvixKnowledgeRootDir, getUserKnowledgeRootDir } from '../../utils/paths'

/** ShuviX 维护的那个根（容器，不是 bundle） */
export function getShuvixKnowledgeRoot(): string {
  return getShuvixKnowledgeRootDir()
}

/** 用户的库根（容器，不是 bundle）：每个子目录是一个用户知识库 */
export function getUserKnowledgeRoot(): string {
  return getUserKnowledgeRootDir()
}

/** 项目 bundle 的容器目录（knowledge-shuvix 根相对） */
export const PROJECTS_CONTAINER = KNOWLEDGE_PROJECTS_DIR

/** 用户库 bundle id 的首段 */
export const USER_CONTAINER = KNOWLEDGE_USER_ROOT_DIR

/** 项目 id → 项目库 bundle id（`projects/<projectId>`）；目录名就是项目 id，不改名、不撞车 */
export function projectBundleId(projectId: string): string {
  return `${PROJECTS_CONTAINER}/${projectId}`
}

/** 用户库名 → bundle id（`knowledge/<库名>`） */
export function userBundleId(name: string): string {
  return `${USER_CONTAINER}/${name}`
}

/** bundle id / 条目 id 是否指向用户库 */
export function isUserBundle(id: string): boolean {
  return normalizeBundlePath(id).split('/')[0] === USER_CONTAINER
}

/** 能当用户库名的目录名：非空、单段、不以点开头（隐藏目录不算库） */
export function isValidLibraryName(name: string): boolean {
  return !!name && !/[/\\]/.test(name) && !name.startsWith('.') && name !== '..'
}

/** 两个根共用名字空间里的 id（bundle 或条目）→ 绝对路径 */
function resolveId(id: string): string {
  const segs = normalizeBundlePath(id).split('/')
  if (segs[0] === USER_CONTAINER) return join(getUserKnowledgeRoot(), ...segs.slice(1))
  return join(getShuvixKnowledgeRoot(), ...segs)
}

/** bundle id → 绝对目录 */
export function bundleDir(bundle: string): string {
  return resolveId(bundle)
}

/** bundle 内的相对路径 → 绝对路径 */
export function bundleFilePath(bundle: string, rel: string): string {
  return join(bundleDir(bundle), ...normalizeBundlePath(rel).split('/'))
}

/**
 * 条目 id（`projects/<id>/x.md` / `knowledge/<库名>/x.md`）→ 绝对路径。只做算术不做准入 ——
 * 越界等检查交给 `locateBundle`（join 会把 `..` 解掉，落不进任何 bundle 就返回 null）。
 */
export function entryFilePath(id: string): string {
  return resolveId(id)
}

function relativeTo(root: string, absPath: string): string | null {
  const r = root.replace(/\\/g, '/').replace(/\/+$/, '')
  const p = absPath.replace(/\\/g, '/')
  if (!r || !p.startsWith(`${r}/`)) return null
  return p.slice(r.length + 1)
}

/** 绝对路径 → knowledge-shuvix 根相对；不在该根下返回 null */
export function toShuvixRelative(absPath: string): string | null {
  return relativeTo(getShuvixKnowledgeRoot(), absPath)
}

/** 绝对路径 → 用户根相对；不在该根下返回 null */
export function toUserRelative(absPath: string): string | null {
  return relativeTo(getUserKnowledgeRoot(), absPath)
}

/**
 * 绝对路径 → 它所属的 bundle id 与 bundle 内相对路径；不在任何 bundle 内返回 null。
 * 项目库的边界是 `projects/<projectId>`（容器目录本身与更浅的层级都不是 bundle）；
 * 用户库的边界是用户根下的第一层子目录（用户根下的散文件不属于任何库）。
 * 任一段以 `.` 开头（`.git` / `.obsidian` / `.trash` …）的路径也不属于任何 bundle —— 与扫描口径一致。
 */
/** 隐藏段：不是库的内容 */
const hasHiddenSegment = (segs: readonly string[]): boolean => segs.some((s) => s.startsWith('.'))

export function locateBundle(absPath: string): { bundle: string; rel: string } | null {
  const shuvixRel = toShuvixRelative(absPath)
  if (shuvixRel !== null) {
    const segs = normalizeBundlePath(shuvixRel).split('/')
    if (segs.length < 3 || segs[0] !== PROJECTS_CONTAINER || hasHiddenSegment(segs.slice(1))) {
      return null
    }
    return { bundle: `${segs[0]}/${segs[1]}`, rel: segs.slice(2).join('/') }
  }
  const userRel = toUserRelative(absPath)
  if (userRel !== null) {
    const segs = normalizeBundlePath(userRel).split('/')
    if (segs.length < 2 || !isValidLibraryName(segs[0]) || hasHiddenSegment(segs)) return null
    return { bundle: userBundleId(segs[0]), rel: segs.slice(1).join('/') }
  }
  return null
}
