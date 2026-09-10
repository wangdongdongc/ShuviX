/**
 * 根目录懒初始化 —— 首次写入（knowledge 工具的 create 作用域）才建：mkdir、写种子
 * （SCHEMA.md、global/）、投影 index/log、git init + 基线提交。幂等且串行；失败只记日志，
 * 调用方照常继续（写入本身不依赖仓库存在）。
 *
 * 不在启动时建：目录的出现应当是用户意图的结果（同 wikiService「懒建根」的判断）。
 */
import { existsSync } from 'fs'
import { mkdir, writeFile } from 'fs/promises'
import {
  KNOWLEDGE_DIRS,
  KNOWLEDGE_SCHEMA_FILE,
  OKF_INDEX_FILE
} from '@shuvix/chat-protocol/knowledge'
import { KNOWLEDGE_SCHEMA_SEED } from '@shuvix/agent-runtime'
import { createLogger } from '../../logger'
import { fromBundlePath, getKnowledgeRoot } from './knowledgePaths'
import { projectKnowledgeBundle } from './projection'
import { ensureKnowledgeRepo } from './repo'
import { invalidateKnowledgeScan } from './scan'

const log = createLogger('Knowledge')

/** 宿主自身写文件时的 actor（OKF §5.2 `process:<id>`） */
export const HOST_ACTOR = 'process:shuvix'

let ensuring: Promise<string> | null = null

export function isKnowledgeRootInitialized(): boolean {
  return existsSync(fromBundlePath(OKF_INDEX_FILE))
}

async function initialize(): Promise<string> {
  const root = getKnowledgeRoot()
  await mkdir(fromBundlePath(KNOWLEDGE_DIRS.global), { recursive: true })
  let seeded = false
  const schemaPath = fromBundlePath(KNOWLEDGE_SCHEMA_FILE)
  if (!existsSync(schemaPath)) {
    await writeFile(schemaPath, KNOWLEDGE_SCHEMA_SEED, 'utf-8')
    invalidateKnowledgeScan(KNOWLEDGE_SCHEMA_FILE)
    seeded = true
  }
  await projectKnowledgeBundle(
    seeded
      ? {
          date: new Date().toISOString().slice(0, 10),
          op: 'Creation',
          path: KNOWLEDGE_SCHEMA_FILE,
          title: 'Knowledge base schema',
          actor: HOST_ACTOR
        }
      : undefined
  )
  await ensureKnowledgeRepo()
  if (seeded) log.info(`initialized knowledge base at ${root}`)
  return root
}

/** 确保根目录可用（种子 + 投影 + 仓库），返回绝对路径 */
export async function ensureKnowledgeRoot(): Promise<string> {
  if (!ensuring) {
    ensuring = initialize()
      .catch((err) => {
        log.warn(`knowledge root initialization failed: ${(err as Error).message}`)
        return getKnowledgeRoot()
      })
      .finally(() => {
        ensuring = null
      })
  }
  return ensuring
}
