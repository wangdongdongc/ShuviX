/**
 * 知识库 git 仓库 —— 整个 bundle 一个仓库（决策 D1），存在性与提交都由宿主保证（P3）。
 *
 * 与 widgetRepo 同一模式：驱动 agent-runtime 的 initOp/addOp/commitOp（复用已测试的竞态
 * status 修正与"无暂存变更"判定），一切失败只记日志 —— 版本控制是增益能力，绝不能让写入
 * 因它而失败。与 widget 的差别：这里 agent 从不自己提交，宿主把每批观察到的变更提交一次
 * （300ms 去抖：一次任务里连写几个文件、加上投影出来的 index/log，合成一条提交）。
 *
 * 提交署名固定为 ShuviX Knowledge：作者记的是「谁提交的」；内容出自谁写在 trailer
 * `Knowledge-Actor`（OKF actor 字符串）与文件自己的 `generated` 章里。
 */
import * as nodeFs from 'node:fs'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  addOp,
  commitOp,
  initOp,
  type GitCache,
  type GitEnv,
  type GitFsClient,
  type GitOpOutput,
  type KnowledgeLogOp
} from '@shuvix/agent-runtime'
import { createLogger } from '../../logger'
import { getKnowledgeRoot } from './knowledgePaths'

const log = createLogger('KnowledgeRepo')

const HOST_AUTHOR = { authorName: 'ShuviX Knowledge', authorEmail: 'knowledge@shuvix.local' }
const COMMIT_DEBOUNCE_MS = 300

function envFor(dir: string): GitEnv {
  return { fs: nodeFs as unknown as GitFsClient, dir }
}

function failureOf(out: GitOpOutput): string | undefined {
  const err = out.details?.error
  return typeof err === 'string' ? err : undefined
}

async function stageAndCommit(
  env: GitEnv,
  cache: GitCache,
  message: string,
  paths: string[]
): Promise<boolean> {
  const added = await addOp(env, cache, { paths })
  const addError = failureOf(added)
  if (addError) {
    log.warn(`git add failed in ${env.dir}: ${addError}`)
    return false
  }
  const committed = await commitOp(env, cache, { message, ...HOST_AUTHOR })
  const commitError = failureOf(committed)
  if (commitError && !/nothing to commit/i.test(commitError)) {
    log.warn(`git commit failed in ${env.dir}: ${commitError}`)
    return false
  }
  return true
}

/** 根目录不是仓库就 init 并把当前全部文件作为基线提交（幂等） */
export async function ensureKnowledgeRepo(): Promise<void> {
  const dir = getKnowledgeRoot()
  try {
    if (!existsSync(dir) || existsSync(join(dir, '.git'))) return
    const env = envFor(dir)
    const cache: GitCache = {}
    const initError = failureOf(await initOp(env, cache, {}))
    if (initError) {
      log.warn(`git init failed in ${dir}: ${initError}`)
      return
    }
    const committed = await stageAndCommit(env, cache, 'kb(init): knowledge base', ['.'])
    log.info(
      committed
        ? `initialized knowledge repo at ${dir}`
        : `initialized knowledge repo at ${dir}, baseline commit did not land`
    )
  } catch (err) {
    log.warn(`ensureKnowledgeRepo failed: ${(err as Error).message}`)
  }
}

export interface KnowledgeCommitEvent {
  op: KnowledgeLogOp
  /** bundle 相对路径 */
  path: string
  actor?: string
}

interface PendingBatch {
  paths: Set<string>
  events: KnowledgeCommitEvent[]
}

let pending: PendingBatch | null = null
let timer: ReturnType<typeof setTimeout> | null = null
let chain: Promise<void> = Promise.resolve()

function buildMessage(events: KnowledgeCommitEvent[]): string {
  const actor = events.find((e) => e.actor)?.actor
  if (events.length === 1) {
    const [e] = events
    const trailers = [
      `Knowledge-Op: ${e.op.toLowerCase()}`,
      ...(actor ? [`Knowledge-Actor: ${actor}`] : [])
    ]
    return `kb(${e.op.toLowerCase()}): /${e.path}\n\n${trailers.join('\n')}`
  }
  const lines = events.map((e) => `- ${e.op.toLowerCase()} /${e.path}`)
  const trailers = ['Knowledge-Op: batch', ...(actor ? [`Knowledge-Actor: ${actor}`] : [])]
  return `kb(batch): ${events.length} changes\n\n${lines.join('\n')}\n\n${trailers.join('\n')}`
}

async function flush(batch: PendingBatch): Promise<void> {
  const dir = getKnowledgeRoot()
  try {
    if (!existsSync(join(dir, '.git'))) return
    await stageAndCommit(envFor(dir), {}, buildMessage(batch.events), [...batch.paths])
  } catch (err) {
    log.warn(`knowledge commit failed: ${(err as Error).message}`)
  }
}

/**
 * 排队一次提交：paths 是本次要 add 的 bundle 相对路径（变更的概念 + 投影出来的 index / log），
 * event 记入提交信息。去抖窗口内的多次调用合成一条提交；提交彼此串行。
 */
export function queueKnowledgeCommit(paths: readonly string[], event: KnowledgeCommitEvent): void {
  if (!pending) pending = { paths: new Set(), events: [] }
  for (const p of paths) pending.paths.add(p)
  pending.events.push(event)
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    const batch = pending
    pending = null
    if (batch) chain = chain.then(() => flush(batch))
  }, COMMIT_DEBOUNCE_MS)
}

/** 立刻提交挂起的批次并等待（初始化种子 / 测试用） */
export async function flushKnowledgeCommits(): Promise<void> {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  const batch = pending
  pending = null
  if (batch) chain = chain.then(() => flush(batch))
  await chain
}
