/**
 * 保留文件投影（桌面接线）—— 每次变更后重生成**全库**的 index.md、追加 log.md。
 *
 * 全量而非增量：库只有几百个文件，渲染是纯函数，逐份比对内容只写有变化的 ——
 * 这样永远一致、没有"忘了更新某个目录的 index"的路径，git 历史也不会被无意义的重写刷满。
 * 空的作用域目录（初始化建出的 global/、刚建的 projects/<slug>/）也要有 index：从磁盘目录
 * 补进 extraDirs。用户自建的顶层目录不在这里 —— 它们有概念才存在，扫描自然带出来。
 */
import { existsSync, readdirSync } from 'fs'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname } from 'path'
import {
  KNOWLEDGE_DIRS,
  OKF_INDEX_FILE,
  OKF_LOG_FILE,
  OKF_VERSION
} from '@shuvix/chat-protocol/knowledge'
import { appendLogEntry, renderAllIndexes, type KnowledgeLogEvent } from '@shuvix/agent-runtime'
import { createLogger } from '../../logger'
import { fromBundlePath, getKnowledgeRoot } from './knowledgePaths'
import { invalidateKnowledgeScan, scanKnowledge } from './scan'

const log = createLogger('Knowledge')

/** 磁盘上存在的作用域目录（含二级：projects/* / bots/* / wiki/*），供无概念时也生成 index */
function existingScopeDirs(): string[] {
  const root = getKnowledgeRoot()
  const out: string[] = []
  const subdirsOf = (rel: string): string[] => {
    try {
      return readdirSync(fromBundlePath(rel), { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
        .map((d) => `${rel}/${d.name}`)
    } catch {
      return []
    }
  }
  for (const dir of Object.values(KNOWLEDGE_DIRS)) {
    if (!existsSync(fromBundlePath(dir))) continue
    out.push(dir)
    if (dir === KNOWLEDGE_DIRS.projects || dir === KNOWLEDGE_DIRS.bots) {
      out.push(...subdirsOf(dir))
    }
  }
  void root
  return out
}

async function writeIfChanged(rel: string, content: string): Promise<boolean> {
  const abs = fromBundlePath(rel)
  try {
    const current = await readFile(abs, 'utf-8')
    if (current === content) return false
  } catch {
    /* 不存在：写 */
  }
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, content, 'utf-8')
  invalidateKnowledgeScan(rel)
  return true
}

/**
 * 重投影全库 index，并（给了事件时）追加一条日志。返回实际写入的 bundle 相对路径 ——
 * 调用方把它们连同变更的概念一起交给 git。
 */
export async function projectKnowledgeBundle(event?: KnowledgeLogEvent): Promise<string[]> {
  const written: string[] = []
  try {
    const { concepts } = await scanKnowledge()
    const indexes = renderAllIndexes({
      concepts,
      extraDirs: existingScopeDirs(),
      okfVersion: OKF_VERSION
    })
    for (const [dir, content] of indexes) {
      const rel = dir ? `${dir}/${OKF_INDEX_FILE}` : OKF_INDEX_FILE
      if (await writeIfChanged(rel, content)) written.push(rel)
    }
    if (event) {
      let existing: string | null = null
      try {
        existing = await readFile(fromBundlePath(OKF_LOG_FILE), 'utf-8')
      } catch {
        existing = null
      }
      if (await writeIfChanged(OKF_LOG_FILE, appendLogEntry(existing, event)))
        written.push(OKF_LOG_FILE)
    }
  } catch (err) {
    log.warn(`knowledge projection failed: ${(err as Error).message}`)
  }
  return written
}
