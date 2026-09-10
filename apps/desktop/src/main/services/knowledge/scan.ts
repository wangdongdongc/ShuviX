/**
 * 知识库扫描 —— 根目录下全部 `.md`（ripgrep，遵循 .gitignore、跳过 .git）→ 概念清单。
 *
 * 按 (mtime, size) 缓存解析结果：注入 / 工具 / 投影每次都要整库清单，而库通常几百个文件，
 * 全量 stat 便宜、全量读盘不便宜。缓存是内存的（P6：无数据库表）；宿主自己的写入经
 * invalidateKnowledgeScan 精确失效，外部编辑靠 mtime 自然失效。
 */
import { existsSync } from 'fs'
import { readFile, stat } from 'fs/promises'
import {
  BOT_CONCEPT_FILE,
  KNOWLEDGE_DIRS,
  PROJECT_CONCEPT_FILE,
  botResource,
  projectResource
} from '@shuvix/chat-protocol/knowledge'
import {
  isReservedFile,
  normalizeBundlePath,
  parseConceptText,
  type BundleFile,
  type KnowledgeConcept
} from '@shuvix/agent-runtime'
import { rgFilesList } from '../../utils/toolUtils/ripgrep'
import { createLogger } from '../../logger'
import { fromBundlePath, getKnowledgeRoot } from './knowledgePaths'

const log = createLogger('Knowledge')
const SCAN_LIMIT = 20000

interface CacheEntry {
  mtimeMs: number
  size: number
  text: string
  concept: KnowledgeConcept | null
}

const cache = new Map<string, CacheEntry>()

export interface KnowledgeScan {
  /** 全部 md（含保留文件），bundle 相对路径 + 原文 */
  files: BundleFile[]
  /** 解析成功的概念（保留文件与非概念文件不在其中） */
  concepts: KnowledgeConcept[]
}

/** 根目录下全部 md 的 bundle 相对路径（字典序）；根目录不存在为空 */
export async function listKnowledgeFiles(): Promise<string[]> {
  const root = getKnowledgeRoot()
  if (!existsSync(root)) return []
  const { files, truncated } = await rgFilesList({ cwd: root, glob: ['*.md'], limit: SCAN_LIMIT })
  if (truncated) log.warn(`knowledge scan truncated at ${SCAN_LIMIT} files`)
  return files.map(normalizeBundlePath).sort()
}

export async function scanKnowledge(): Promise<KnowledgeScan> {
  const rels = await listKnowledgeFiles()
  const live = new Set(rels)
  for (const key of cache.keys()) if (!live.has(key)) cache.delete(key)

  const files: BundleFile[] = []
  const concepts: KnowledgeConcept[] = []
  for (const rel of rels) {
    const abs = fromBundlePath(rel)
    let st: { mtimeMs: number; size: number }
    try {
      st = await stat(abs)
    } catch {
      cache.delete(rel)
      continue
    }
    const hit = cache.get(rel)
    let entry = hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size ? hit : null
    if (!entry) {
      let text: string
      try {
        text = await readFile(abs, 'utf-8')
      } catch (e) {
        log.warn(`failed to read ${rel}: ${(e as Error).message}`)
        continue
      }
      const concept = isReservedFile(rel)
        ? null
        : parseConceptText(text, rel, (msg) => log.warn(`${rel}: ${msg}`))
      entry = { mtimeMs: st.mtimeMs, size: st.size, text, concept }
      cache.set(rel, entry)
    }
    files.push({ path: rel, text: entry.text })
    if (entry.concept) concepts.push(entry.concept)
  }
  return { files, concepts }
}

/** 上一次扫描已知的路径（写钩子据此区分「新建」与「更新」） */
export function knownKnowledgePaths(): ReadonlySet<string> {
  return new Set(cache.keys())
}

/** 精确失效一条（宿主自己写的文件）；不给路径则整表失效 */
export function invalidateKnowledgeScan(rel?: string): void {
  if (rel === undefined) cache.clear()
  else cache.delete(normalizeBundlePath(rel))
}

function dirOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? '' : path.slice(0, i)
}

/** 项目作用域目录（`projects/<slug>`）：按 project.md 的 `resource` 绑定找，目录名只是 slug */
export async function findProjectDir(projectId: string): Promise<string | null> {
  const resource = projectResource(projectId)
  const { concepts } = await scanKnowledge()
  const hit = concepts.find(
    (c) =>
      c.resource === resource &&
      c.path.startsWith(`${KNOWLEDGE_DIRS.projects}/`) &&
      c.path.endsWith(`/${PROJECT_CONCEPT_FILE}`)
  )
  return hit ? dirOf(hit.path) : null
}

/** bot 作用域目录（`bots/<name>`）：按 bot.md 的 `resource` 绑定找 */
export async function findBotDir(botName: string): Promise<string | null> {
  const resource = botResource(botName)
  const { concepts } = await scanKnowledge()
  const hit = concepts.find(
    (c) =>
      c.resource === resource &&
      c.path.startsWith(`${KNOWLEDGE_DIRS.bots}/`) &&
      c.path.endsWith(`/${BOT_CONCEPT_FILE}`)
  )
  return hit ? dirOf(hit.path) : null
}
