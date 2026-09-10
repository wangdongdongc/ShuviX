/**
 * 根目录懒初始化 —— 首次写入（knowledge 工具的 create 作用域）才建：mkdir `global/`、
 * 投影 index/log、git init + 基线提交。幂等且串行；失败只记日志，调用方照常继续
 * （写入本身不依赖仓库存在）。
 *
 * 不在启动时建：目录的出现应当是用户意图的结果（同 wikiService「懒建根」的判断）。
 *
 * **不写任何规范文件**：编辑规范（布局、类型词汇表、写作规则）住在内置 `knowledge-writer`
 * 的提示词里，随版本走；往用户目录里放一份可编辑的副本只会带来一个没人维护的更新问题 ——
 * 它一旦落盘，后续版本就再也改不动它，而 agent 又被要求遵循它。bundle 里只放条目。
 */
import { existsSync } from 'fs'
import { mkdir } from 'fs/promises'
import { KNOWLEDGE_DIRS, OKF_INDEX_FILE } from '@shuvix/chat-protocol/knowledge'
import { createLogger } from '../../logger'
import { fromBundlePath, getKnowledgeRoot } from './knowledgePaths'
import { projectKnowledgeBundle } from './projection'
import { ensureKnowledgeRepo } from './repo'

const log = createLogger('Knowledge')

/** 宿主自身写文件时的 actor（OKF §5.2 `process:<id>`） */
export const HOST_ACTOR = 'process:shuvix'

let ensuring: Promise<string> | null = null

export function isKnowledgeRootInitialized(): boolean {
  return existsSync(fromBundlePath(OKF_INDEX_FILE))
}

async function initialize(): Promise<string> {
  const root = getKnowledgeRoot()
  const fresh = !isKnowledgeRootInitialized()
  await mkdir(fromBundlePath(KNOWLEDGE_DIRS.global), { recursive: true })
  await projectKnowledgeBundle()
  await ensureKnowledgeRepo()
  if (fresh) log.info(`initialized knowledge base at ${root}`)
  return root
}

/** 确保根目录可用（目录 + 投影 + 仓库），返回绝对路径 */
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
