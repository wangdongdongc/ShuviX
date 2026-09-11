/**
 * 保留文件投影（桌面接线）—— **按 bundle** 重生成该 bundle 的 index.md、追加它的 log.md。
 *
 * 一个 bundle 内全量而非增量：一个项目的库只有几十到几百个文件，渲染是纯函数，逐份比对
 * 内容只写有变化的 —— 这样永远一致、没有「忘了更新某个目录的 index」的路径，git 历史也
 * 不会被无意义的重写刷满。跨 bundle 一概不碰：一次写入只重投影它自己那一个 bundle。
 */
import { readFile, writeFile, mkdir } from 'fs/promises'
import { dirname } from 'path'
import { OKF_INDEX_FILE, OKF_LOG_FILE, OKF_VERSION } from '@shuvix/chat-protocol/knowledge'
import { appendLogEntry, renderAllIndexes, type KnowledgeLogEvent } from '@shuvix/agent-runtime'
import { createLogger } from '../../logger'
import { bundleFilePath } from './knowledgePaths'
import { invalidateKnowledgeScan, scanBundle } from './scan'

const log = createLogger('Knowledge')

async function writeIfChanged(bundle: string, rel: string, content: string): Promise<boolean> {
  const abs = bundleFilePath(bundle, rel)
  try {
    const current = await readFile(abs, 'utf-8')
    if (current === content) return false
  } catch {
    /* 不存在：写 */
  }
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, content, 'utf-8')
  invalidateKnowledgeScan(bundle, rel)
  return true
}

/**
 * 重投影一个 bundle 的 index，并（给了事件时）往它的 log 追加一条。返回实际写入的
 * bundle 相对路径 —— 调用方把它们连同变更的概念一起交给该 bundle 的 git。
 */
export async function projectBundle(bundle: string, event?: KnowledgeLogEvent): Promise<string[]> {
  const written: string[] = []
  try {
    const { concepts } = await scanBundle(bundle)
    const indexes = renderAllIndexes({ concepts, extraDirs: [''], okfVersion: OKF_VERSION })
    for (const [dir, content] of indexes) {
      const rel = dir ? `${dir}/${OKF_INDEX_FILE}` : OKF_INDEX_FILE
      if (await writeIfChanged(bundle, rel, content)) written.push(rel)
    }
    if (event) {
      let existing: string | null = null
      try {
        existing = await readFile(bundleFilePath(bundle, OKF_LOG_FILE), 'utf-8')
      } catch {
        existing = null
      }
      if (await writeIfChanged(bundle, OKF_LOG_FILE, appendLogEntry(existing, event)))
        written.push(OKF_LOG_FILE)
    }
  } catch (err) {
    log.warn(`knowledge projection failed for ${bundle}: ${(err as Error).message}`)
  }
  return written
}
