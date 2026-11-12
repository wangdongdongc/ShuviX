/**
 * 变更管线 —— 宿主观察到的每一次知识库写入都经这里：失效缓存 →（还不是 git 仓库的库先 init + 基线）→
 * 排队该 bundle 的 git 提交 → 广播 knowledge.changed。删除与挪动（文件工具的 delete / move）也走这条：
 * 删除记 Deletion，挪动记成源的 Deletion 加目标的 Creation；挪走 / 删掉的是一整个目录时整个 bundle 的
 * 扫描缓存一起失效，提交暂存那个目录（底下的增删都进去）。
 *
 * index.md / log.md 不再维护：谁在什么时候改了哪条，git 提交里都有（`kb(<op>): /path` 与
 * `Knowledge-Actor` trailer）。也没有「建库」这一步 —— 目录随第一次写入出现，仓库在第一次提交前按需建出。
 *
 * 去抖 300ms 而不是立刻做：文件工具的写入先落盘、再由写钩子补 `generated` 章回写一次，
 * 事件在两次之间到达时立刻提交会把没盖章的版本提交进历史；等一拍，最后落盘的才是提交的。
 * 管线串行，绝不并发。
 */
import { normalizeBundlePath } from '@shuvix/agent-runtime'
import { appEventBus } from '../../utils/appEventBus'
import { createLogger } from '../../logger'
import { isBuiltinBundle, locateBundle } from './knowledgePaths'
import {
  ensureBundleRepo,
  flushKnowledgeCommits,
  queueKnowledgeCommit,
  type KnowledgeChangeOp
} from './repo'
import { invalidateKnowledgeScan, knownKnowledgePaths, listAllBuiltinBundleIds } from './scan'
import { invalidateKnowledgeSearch } from './search'

const log = createLogger('Knowledge')
const CHANGE_DEBOUNCE_MS = 300

export interface KnowledgeChange {
  /** bundle id（`projects/<projectId>` / `knowledge/<库名>`） */
  bundle: string
  /** bundle 相对路径 */
  path: string
  op: KnowledgeChangeOp
  actor?: string
  /** path 是一整个目录（move / delete 一个目录）：失效整个 bundle 的扫描缓存 */
  isDirectory?: boolean
  /** 这条删除是迁移的收尾（`knowledge` 工具的 `migrate`）：条目去了哪个库（人读标签），记进提交信息 */
  movedTo?: string
}

let pending: KnowledgeChange[] = []
let timer: ReturnType<typeof setTimeout> | null = null
let chain: Promise<void> = Promise.resolve()

async function process(batch: KnowledgeChange[]): Promise<void> {
  const touched = new Map<string, Set<string>>()
  for (const change of batch) {
    // 目录底下每一条都可能变了：按条失效要先知道有哪些条，整个 bundle 一起失效更直接
    if (change.isDirectory) invalidateKnowledgeScan(change.bundle)
    else invalidateKnowledgeScan(change.bundle, change.path)
    const set = touched.get(change.bundle) ?? new Set<string>()
    set.add(change.path)
    touched.set(change.bundle, set)
  }
  invalidateKnowledgeSearch()
  try {
    // 拷进来的文件夹、第一次被写入的项目库都可能还不是 git 仓库：自带 .git 就原样沿用；没有就此刻
    // init —— 基线收下文件夹的原貌（本批刚写下的文件除外），这批变更再以自己的提交落地
    for (const [bundle, paths] of touched) await ensureBundleRepo(bundle, { exclude: [...paths] })
    for (const change of batch) {
      queueKnowledgeCommit(change.bundle, [...(touched.get(change.bundle) ?? [])], {
        op: change.op,
        path: change.path,
        actor: change.actor,
        ...(change.movedTo ? { movedTo: change.movedTo } : {})
      })
    }
  } catch (err) {
    log.warn(`knowledge change pipeline failed: ${(err as Error).message}`)
  }
  appEventBus.publish({ type: 'knowledge.changed' })
}

/** 记录一次变更（去抖合批；返回后管线在后台跑）。内置库只读：不该有写入，有也不提交、不广播 */
export function recordKnowledgeChange(change: KnowledgeChange): void {
  if (isBuiltinBundle(change.bundle)) {
    log.warn(`ignored a write into the read-only builtin base: ${change.bundle}/${change.path}`)
    return
  }
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
 * 文件工具改动回调：落在某个 bundle 里的 md 才是知识库变更（读宽：普通笔记与条目一视同仁）；
 * 一整个目录（move / delete 一个目录）不看扩展名 —— 里面有什么都跟着走了。
 * delete 记 Deletion；write / edit 按「扫描是否见过」区分新建 / 更新。move 由文件工具报成一对
 * （源 delete、目标 write），两头各自按自己落在哪个 bundle 判 —— 挪出库、挪进库都只记库里那一头。
 */
export function notifyKnowledgeFileChanged(
  absPath: string,
  meta: { kind: 'write' | 'edit' | 'delete'; actor?: string; isDirectory?: boolean }
): void {
  const located = locateBundle(absPath)
  if (!located) return
  if (!meta.isDirectory && !/\.md$/i.test(located.rel)) return
  const { bundle, rel } = located
  // 内置库在应用包里：不 git init、不提交、不广播。写入本身不设拒写策略（随包资源的统一裁决，
  // 见 builtinPolicies/index.ts）—— 真写进去了，下个版本会还原
  if (isBuiltinBundle(bundle)) return
  const op: KnowledgeChangeOp =
    meta.kind === 'delete'
      ? 'Deletion'
      : meta.kind === 'edit' || knownKnowledgePaths().has(`${bundle}/${rel}`)
        ? 'Update'
        : 'Creation'
  recordKnowledgeChange({
    bundle,
    path: rel,
    op,
    actor: meta.actor,
    ...(meta.isDirectory ? { isDirectory: true } : {})
  })
}

/**
 * 界面语言切换后：内置库解析到的是另一个目录（`<库名>/<lang>/`），扫描缓存按 mtime 自然失效，
 * 检索索引却按 bundle id 缓存 —— 整体失效一次，再广播让侧栏与配置卡重扫。
 */
export function refreshBuiltinKnowledge(): void {
  for (const bundle of listAllBuiltinBundleIds()) {
    invalidateKnowledgeScan(bundle)
    invalidateKnowledgeSearch(bundle)
  }
  appEventBus.publish({ type: 'knowledge.changed' })
}
