/**
 * 库的目录索引（`index.md`）—— 落盘的那一半（纯函数在 agent-runtime `knowledge/bundleIndex.ts`）。
 *
 * **只维护 ShuviX 自己的库**（项目库与 bot 库）：用户的库是拷进来的文件夹，「宿主不往里写任何别的东西」那条
 * 承诺照旧；内置库只读。
 *
 * index.md 是**投影 + 一样存储**：条目行每次按 frontmatter 现生成，文件夹行的描述是唯一存在里面的东西 ——
 * 重新生成时从旧的那份读出来带过去。管理员写的新描述先排在 `pending` 里，由变更管线（changes.ts，串行）在下一批
 * 里一起落盘、随那一批提交 —— 不在这里直接写：管线同时可能正在重新生成同一份文件。
 *
 * 用户在保留名下手写的笔记（内容不是生成的形状）不是索引：不读它的描述，也不覆盖它 —— 那个目录就没有索引，
 * 它的子文件夹的描述无处可存（简讯里退回「名字 + 条目数」）。
 */
import { existsSync } from 'fs'
import { readdir, rm, rmdir, writeFile } from 'fs/promises'
import { dirname } from 'path'
import {
  buildKnowledgeOutline,
  cleanIndexLine,
  collectFolderDescriptions,
  foldersWithNotes,
  indexPathOf,
  isProjectionFile,
  isReservedFile,
  KNOWLEDGE_FOLDER_DESCRIPTION_MAX,
  normalizeBundlePath,
  readFolderDescriptions,
  renderBundleIndexes,
  type KnowledgeOutline
} from '@shuvix/agent-runtime'
import { createLogger } from '../../logger'
import { BOTS_CONTAINER, PROJECTS_CONTAINER, bundleDir, bundleFilePath } from './knowledgePaths'
import { invalidateKnowledgeScan, scanBundle } from './scan'

const log = createLogger('Knowledge')

/** 这个库的 index.md 归宿主维护（也就存得下文件夹描述）：项目库与 bot 库 */
export function maintainsBundleIndex(bundle: string): boolean {
  const container = bundle.split('/')[0]
  return container === PROJECTS_CONTAINER || container === BOTS_CONTAINER
}

/** 还没落盘的文件夹描述：bundle → 文件夹的库内路径 → 描述 */
const pending = new Map<string, Map<string, string>>()

/**
 * 排一批文件夹描述，等变更管线下一批落盘（调用方随后记一笔变更把管线叫起来，见 changes.ts
 * `recordFolderDescriptions`）。不归宿主维护索引的库不收。
 */
export function queueFolderDescriptions(
  bundle: string,
  folders: readonly { folder: string; description: string }[]
): boolean {
  if (!maintainsBundleIndex(bundle)) return false
  const queue = pending.get(bundle) ?? new Map<string, string>()
  for (const { folder, description } of folders) {
    const path = normalizeBundlePath(folder).replace(/\/+$/, '')
    const line = cleanIndexLine(description, KNOWLEDGE_FOLDER_DESCRIPTION_MAX)
    if (path && line) queue.set(path, line)
  }
  if (queue.size === 0) return false
  pending.set(bundle, queue)
  return true
}

function isIndexPath(path: string): boolean {
  return /(^|\/)index\.md$/.test(path)
}

/** 目录里除了我们要删的那份 index 再没有别的东西时，连目录一起收掉（一路往上，到库根为止） */
async function pruneEmptyDirs(bundle: string, rel: string): Promise<void> {
  const root = bundleDir(bundle)
  let dir = dirname(bundleFilePath(bundle, rel))
  while (dir.length > root.length && dir.startsWith(root)) {
    try {
      if ((await readdir(dir)).length > 0) return
      await rmdir(dir)
    } catch {
      return
    }
    dir = dirname(dir)
  }
}

/**
 * 按库此刻的内容重新生成每个目录的 index.md：内容变了才写；目录里已经没有笔记的旧索引删掉（管理员把条目全挪走
 * 之后，不留一个只剩 index.md 的空文件夹）。返回写了 / 删了的库内路径 —— 调用方把它们并进同一批提交。
 * 不归宿主维护的库、还不存在的库：什么都不做。
 */
export async function syncBundleIndexes(bundle: string): Promise<string[]> {
  if (!maintainsBundleIndex(bundle) || !existsSync(bundleDir(bundle))) {
    pending.delete(bundle)
    return []
  }
  // 先扫再取队列：扫描抛错时管理员写的描述还在队列里，等下一批
  const scan = await scanBundle(bundle)
  const queued = pending.get(bundle)
  pending.delete(bundle)
  const reserved = scan.files.filter((f) => isIndexPath(f.path) && isReservedFile(f.path))
  const generated = reserved.filter((f) => isProjectionFile(f.path, f.text))
  const handwritten = new Set(
    reserved.filter((f) => !isProjectionFile(f.path, f.text)).map((f) => f.path)
  )

  const dirs = foldersWithNotes(scan.notes)
  const descriptions = collectFolderDescriptions(generated)
  for (const [folder, description] of queued ?? []) {
    // 管理员点了一个并不存在的文件夹：没有可挂的行，丢掉
    if (dirs.has(folder)) descriptions.set(folder, description)
  }

  const existing = new Map(generated.map((f) => [f.path, f.text]))
  const rendered = renderBundleIndexes(scan.notes, {
    descriptions,
    rootIndex: existing.get(indexPathOf(''))
  })
  const changed: string[] = []
  for (const [dir, text] of rendered) {
    const rel = indexPathOf(dir)
    if (handwritten.has(rel) || existing.get(rel) === text) continue
    try {
      await writeFile(bundleFilePath(bundle, rel), text)
      changed.push(rel)
    } catch (err) {
      log.warn(`failed to write ${bundle}/${rel}: ${(err as Error).message}`)
    }
  }
  for (const rel of existing.keys()) {
    const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
    if (rendered.has(dir)) continue
    try {
      await rm(bundleFilePath(bundle, rel))
      changed.push(rel)
      await pruneEmptyDirs(bundle, rel)
    } catch (err) {
      log.warn(`failed to remove ${bundle}/${rel}: ${(err as Error).message}`)
    }
  }
  for (const rel of changed) invalidateKnowledgeScan(bundle, rel)
  return changed
}

/**
 * 库顶层的简讯（进 `<knowledge_bases>` 围栏）：顶层文件夹与条目各一行。文件夹描述从根 index.md 读 ——
 * 宿主生成的那份才算。库不存在或是空的 → null。
 */
export async function bundleOutline(bundle: string): Promise<KnowledgeOutline | null> {
  if (!existsSync(bundleDir(bundle))) return null
  const scan = await scanBundle(bundle)
  const root = scan.files.find((f) => f.path === indexPathOf(''))
  const descriptions =
    root && isProjectionFile(root.path, root.text)
      ? readFolderDescriptions(root.text)
      : new Map<string, string>()
  return buildKnowledgeOutline(scan.notes, descriptions)
}
