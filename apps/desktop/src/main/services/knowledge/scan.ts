/**
 * 知识库扫描 —— **按 bundle** 扫：每个 bundle 下的全部 `.md`（ripgrep，遵循 .gitignore、
 * 跳过 .git）→ 该 bundle 的概念清单，路径 bundle 相对。
 *
 * 按 (mtime, size) 缓存解析结果：清单每次都要全量，而库通常几百个文件，全量 stat 便宜、
 * 全量读盘不便宜。缓存是内存的（P6：无数据库表），键是 `<bundle>/<rel>`；宿主自己的写入经
 * invalidateKnowledgeScan 精确失效，外部编辑靠 mtime 自然失效。
 */
import { existsSync, readdirSync } from 'fs'
import { readFile, stat } from 'fs/promises'
import {
  isReservedFile,
  normalizeBundlePath,
  parseConceptText,
  type BundleFile,
  type KnowledgeConcept
} from '@shuvix/agent-runtime'
import { rgFilesList } from '../../utils/toolUtils/ripgrep'
import { createLogger } from '../../logger'
import {
  PROJECTS_CONTAINER,
  bundleDir,
  bundleFilePath,
  getShuvixKnowledgeRoot
} from './knowledgePaths'

const log = createLogger('Knowledge')
const SCAN_LIMIT = 20000

interface CacheEntry {
  mtimeMs: number
  size: number
  text: string
  concept: KnowledgeConcept | null
}

/** 键：`<bundle>/<bundle 内相对路径>` */
const cache = new Map<string, CacheEntry>()

export interface BundleScan {
  /** bundle id（shuvix 根相对，如 `projects/acme`） */
  bundle: string
  /** 全部 md（含保留文件），bundle 相对路径 + 原文 */
  files: BundleFile[]
  /** 解析成功的概念（保留文件与非概念文件不在其中） */
  concepts: KnowledgeConcept[]
}

/** 磁盘上现存的 bundle id（本期恒为 `projects/<slug>`，字典序） */
export function listBundles(): string[] {
  const container = bundleDir(PROJECTS_CONTAINER)
  try {
    return readdirSync(container, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => `${PROJECTS_CONTAINER}/${d.name}`)
      .sort()
  } catch {
    return []
  }
}

/** 一个 bundle 下全部 md 的 bundle 相对路径（字典序）；目录不存在为空 */
async function listBundleFiles(bundle: string): Promise<string[]> {
  const dir = bundleDir(bundle)
  if (!existsSync(dir)) return []
  const { files, truncated } = await rgFilesList({ cwd: dir, glob: ['*.md'], limit: SCAN_LIMIT })
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
      const concept = isReservedFile(rel)
        ? null
        : parseConceptText(text, rel, (msg) => log.warn(`${key}: ${msg}`))
      entry = { mtimeMs: st.mtimeMs, size: st.size, text, concept }
      cache.set(key, entry)
    }
    files.push({ path: rel, text: entry.text })
    if (entry.concept) concepts.push(entry.concept)
  }
  return { bundle, files, concepts }
}

/** 扫全部 bundle */
export async function scanAllBundles(): Promise<BundleScan[]> {
  if (!existsSync(getShuvixKnowledgeRoot())) return []
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
