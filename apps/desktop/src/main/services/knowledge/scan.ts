/**
 * 知识库扫描 —— **按 bundle** 扫（项目库与用户库一视同仁）：每个 bundle 下的全部 `.md`（ripgrep，遵循 .gitignore、
 * 跳过隐藏文件与目录）→ 该 bundle 的笔记清单（每个 md 一条，合规的另带 OKF 条目；ShuviX 早先生成的
 * index / log 不算笔记），路径 bundle 相对。
 *
 * 按 (mtime, size) 缓存解析结果：清单每次都要全量，而库通常几百个文件，全量 stat 便宜、
 * 全量读盘不便宜。缓存是内存的（P6：无数据库表），键是 `<bundle>/<rel>`；宿主自己的写入经
 * invalidateKnowledgeScan 精确失效，外部编辑靠 mtime 自然失效。
 */
import { existsSync, readdirSync } from 'fs'
import { readFile, stat } from 'fs/promises'
import { join } from 'path'
import {
  isProjectionFile,
  isReservedFile,
  normalizeBundlePath,
  readKnowledgeNote,
  type BundleFile,
  type KnowledgeConcept,
  type KnowledgeNote
} from '@shuvix/agent-runtime'
import { rgFilesList } from '../../utils/toolUtils/ripgrep'
import { createLogger } from '../../logger'
import {
  PROJECTS_CONTAINER,
  builtinBundleId,
  bundleDir,
  bundleFilePath,
  getBuiltinKnowledgeRoot,
  getUserKnowledgeRoot,
  isValidLibraryName,
  userBundleId
} from './knowledgePaths'

const log = createLogger('Knowledge')
const SCAN_LIMIT = 20000

/** 一个库里最多列多少层目录 —— 侧栏画不下的规模，扫下去也只是白花时间 */
const DIR_LIMIT = 500

interface CacheEntry {
  mtimeMs: number
  size: number
  text: string
  concept: KnowledgeConcept | null
  /** 除 ShuviX 早先生成的 index / log 外每个 md 都有 */
  note: KnowledgeNote | null
}

/** 键：`<bundle>/<bundle 内相对路径>` */
const cache = new Map<string, CacheEntry>()

export interface BundleScan {
  /** bundle id（`projects/<projectId>` / `knowledge/<库名>`） */
  bundle: string
  /** 全部 md（含保留文件），bundle 相对路径 + 原文 */
  files: BundleFile[]
  /** 解析成功的 OKF 条目（保留名文件与普通笔记不在其中） */
  concepts: KnowledgeConcept[]
  /** 除 ShuviX 早先生成的 index.md / log.md 外的每个 md —— 读宽：普通笔记与合规条目一视同仁 */
  notes: KnowledgeNote[]
}

/** 子目录名（不含隐藏目录，字典序）；目录不存在为空 */
function subdirectories(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)
      .sort()
  } catch {
    return []
  }
}

/** 磁盘上现存的项目库 bundle id（`projects/<projectId>`，字典序） */
export function listProjectBundles(): string[] {
  return subdirectories(bundleDir(PROJECTS_CONTAINER)).map((d) => `${PROJECTS_CONTAINER}/${d}`)
}

/** 用户知识库的名字：`~/.shuvix/knowledge/` 下**每个**非隐藏子目录都算一个，不要求任何标记 */
export function listUserLibraries(): string[] {
  return subdirectories(getUserKnowledgeRoot()).filter(isValidLibraryName)
}

/** 一个 bundle 里的全部非隐藏子目录（bundle 相对，深度优先，字典序）；目录不存在为空 */
export function listBundleDirs(bundle: string, limit = DIR_LIMIT): string[] {
  const out: string[] = []
  const walk = (abs: string, prefix: string): void => {
    for (const name of subdirectories(abs)) {
      if (out.length >= limit) return
      const rel = prefix ? `${prefix}/${name}` : name
      out.push(rel)
      walk(join(abs, name), rel)
    }
  }
  walk(bundleDir(bundle), '')
  return out
}

/**
 * 随应用发布的内置库 bundle id（`builtin/<库名>`）：内置根下每个非隐藏子目录一个。根不在（开发期没拷、
 * 打包漏了）就一个都没有 —— 内置库是增益，缺席不该让别的库跟着出错。
 *
 * 判据要**深到语言那一层**（`bundleDir` 现算的那一版）：某个库只发了别的语言、又没有 en 兜底时，
 * 它在 `bases` / 缺省选择 / 围栏里都不存在（sessionBundle 的 `builtinTarget` 按语言目录判），
 * 这里若只看库目录在不在，侧栏就会多出一行永远空的只读库 —— 同一件东西两个答案。
 */
export function listBuiltinBundles(): string[] {
  return subdirectories(getBuiltinKnowledgeRoot())
    .filter(isValidLibraryName)
    .map(builtinBundleId)
    .filter((bundle) => existsSync(bundleDir(bundle)))
}

/** 磁盘上现存的全部 bundle id：项目库在前，用户库（`knowledge/<库名>`）居中，内置库（`builtin/<库名>`）在后 */
export function listBundles(): string[] {
  return [
    ...listProjectBundles(),
    ...listUserLibraries().map(userBundleId),
    ...listBuiltinBundles()
  ]
}

/** 一个 bundle 下全部 md 的 bundle 相对路径（字典序）；目录不存在为空 */
async function listBundleFiles(bundle: string): Promise<string[]> {
  const dir = bundleDir(bundle)
  if (!existsSync(dir)) return []
  const { files, truncated } = await rgFilesList({
    cwd: dir,
    glob: ['*.md'],
    // 隐藏目录（.obsidian / .trash / .git …）不是库的内容：拷进来的 Obsidian 库回收站不该进侧栏与索引
    hidden: false,
    limit: SCAN_LIMIT
  })
  if (truncated) log.warn(`knowledge scan truncated at ${SCAN_LIMIT} files in ${bundle}`)
  return files.map(normalizeBundlePath).sort()
}

/** 扫一个 bundle */
export async function scanBundle(bundle: string): Promise<BundleScan> {
  const rels = await listBundleFiles(bundle)
  const live = new Set(rels.map((r) => `${bundle}/${r}`))
  for (const key of cache.keys()) {
    if (key.startsWith(`${bundle}/`) && !live.has(key)) cache.delete(key)
  }

  const files: BundleFile[] = []
  const concepts: KnowledgeConcept[] = []
  const notes: KnowledgeNote[] = []
  for (const rel of rels) {
    const key = `${bundle}/${rel}`
    const abs = bundleFilePath(bundle, rel)
    let st: { mtimeMs: number; size: number }
    try {
      st = await stat(abs)
    } catch {
      cache.delete(key)
      continue
    }
    const hit = cache.get(key)
    let entry = hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size ? hit : null
    if (!entry) {
      let text: string
      try {
        text = await readFile(abs, 'utf-8')
      } catch (e) {
        log.warn(`failed to read ${key}: ${(e as Error).message}`)
        continue
      }
      // ShuviX 早先生成的 index / log 不是笔记；保留名下用户自己的笔记是笔记，但不当 OKF 条目
      const note = isProjectionFile(rel, text)
        ? null
        : readKnowledgeNote(text, rel, {
            entry: !isReservedFile(rel),
            warn: (msg) => log.warn(`${key}: ${msg}`)
          })
      entry = { mtimeMs: st.mtimeMs, size: st.size, text, concept: note?.concept ?? null, note }
      cache.set(key, entry)
    }
    files.push({ path: rel, text: entry.text })
    if (entry.concept) concepts.push(entry.concept)
    if (entry.note) notes.push(entry.note)
  }
  return { bundle, files, concepts, notes }
}

/** 扫全部 bundle */
export async function scanAllBundles(): Promise<BundleScan[]> {
  // 两个根各自可能不存在：listBundles 对缺失目录返回空，不必再按根判
  return Promise.all(listBundles().map((b) => scanBundle(b)))
}

/** 上一次扫描已知的键（`<bundle>/<rel>`）—— 写钩子据此区分「新建」与「更新」 */
export function knownKnowledgePaths(): ReadonlySet<string> {
  return new Set(cache.keys())
}

/** 精确失效一条；不给参数则整表失效 */
export function invalidateKnowledgeScan(bundle?: string, rel?: string): void {
  if (bundle === undefined) {
    cache.clear()
    return
  }
  if (rel === undefined) {
    for (const key of cache.keys()) if (key.startsWith(`${bundle}/`)) cache.delete(key)
    return
  }
  cache.delete(`${bundle}/${normalizeBundlePath(rel)}`)
}
