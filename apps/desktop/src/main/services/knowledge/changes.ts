/**
 * 变更管线 —— 宿主观察到的每一次知识库写入都经这里：失效缓存 → 重投影**该 bundle** 的
 * index/log → 排队该 bundle 的 git 提交 → 广播 knowledge.changed。
 *
 * 去抖 300ms 而不是立刻做：文件工具的写入先落盘、再由写钩子补 `generated` 章回写一次，
 * 事件在两次之间到达时立刻投影会把没盖章的版本提交进历史；等一拍，最后落盘的才是提交的。
 * 一批里的事件按到达顺序各记一条日志，每个 bundle 只重投影一次。管线串行，绝不并发投影。
 */
import { isReservedFile, normalizeBundlePath, type KnowledgeLogOp } from '@shuvix/agent-runtime'
import { appEventBus } from '../../utils/appEventBus'
import { createLogger } from '../../logger'
import { locateBundle } from './knowledgePaths'
import { projectBundle } from './projection'
import { flushKnowledgeCommits, queueKnowledgeCommit } from './repo'
import { invalidateKnowledgeScan, knownKnowledgePaths } from './scan'
import { invalidateKnowledgeSearch } from './search'

const log = createLogger('Knowledge')
const CHANGE_DEBOUNCE_MS = 300

export interface KnowledgeChange {
  /** bundle id（shuvix 根相对） */
  bundle: string
  /** bundle 相对路径 */
  path: string
  op: KnowledgeLogOp
  title?: string
  actor?: string
}

let pending: KnowledgeChange[] = []
let timer: ReturnType<typeof setTimeout> | null = null
let chain: Promise<void> = Promise.resolve()

async function process(batch: KnowledgeChange[]): Promise<void> {
  const date = new Date().toISOString().slice(0, 10)
  const touched = new Map<string, Set<string>>()
  const touch = (bundle: string, rel: string): void => {
    const set = touched.get(bundle) ?? new Set<string>()
    set.add(rel)
    touched.set(bundle, set)
  }
  for (const change of batch) {
    invalidateKnowledgeScan(change.bundle, change.path)
    touch(change.bundle, change.path)
  }
  invalidateKnowledgeSearch()
  try {
    // 每条变更各记一条日志；index 在最后一次投影时已是全量结果
    for (const change of batch) {
      const written = await projectBundle(change.bundle, {
        date,
        op: change.op,
        path: change.path,
        title: change.title,
        actor: change.actor
      })
      for (const w of written) touch(change.bundle, w)
    }
    for (const change of batch) {
      queueKnowledgeCommit(change.bundle, [...(touched.get(change.bundle) ?? [])], {
        op: change.op,
        path: change.path,
        actor: change.actor
      })
    }
  } catch (err) {
    log.warn(`knowledge change pipeline failed: ${(err as Error).message}`)
  }
  appEventBus.publish({ type: 'knowledge.changed' })
}

/** 记录一次变更（去抖合批；返回后管线在后台跑） */
export function recordKnowledgeChange(change: KnowledgeChange): void {
  pending.push({ ...change, path: normalizeBundlePath(change.path) })
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    const batch = pending
    pending = []
    chain = chain.then(() => process(batch))
  }, CHANGE_DEBOUNCE_MS)
}

/** 把挂起的变更处理完并等提交落地（测试用） */
export async function flushKnowledgeChanges(): Promise<void> {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  const batch = pending
  pending = []
  if (batch.length > 0) chain = chain.then(() => process(batch))
  await chain
  await flushKnowledgeCommits()
}

/**
 * 文件工具写入回调：落在某个 bundle 里的 md 才是知识库变更。保留文件由宿主投影维护，
 * agent 直写只失效缓存不记日志；概念按「扫描是否见过」区分新建 / 更新。
 */
export function notifyKnowledgeFileChanged(
  absPath: string,
  meta: { kind: 'write' | 'edit'; actor?: string }
): void {
  const located = locateBundle(absPath)
  if (!located || !/\.md$/i.test(located.rel)) return
  const { bundle, rel } = located
  if (isReservedFile(rel)) {
    invalidateKnowledgeScan(bundle, rel)
    invalidateKnowledgeSearch()
    return
  }
  const existed = knownKnowledgePaths().has(`${bundle}/${rel}`)
  recordKnowledgeChange({
    bundle,
    path: rel,
    op: meta.kind === 'edit' || existed ? 'Update' : 'Creation',
    actor: meta.actor
  })
}
