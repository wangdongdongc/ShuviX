/**
 * WidgetRepo —— 每个 widget 目录一个独立 git 仓库，仓库的"存在性"由宿主保证。
 *
 * 分工：全归宿主 —— init、scaffold 基线提交、平台自身写文件后的提交（重命名改 manifest），以及
 * **每次构建成功后提交整棵树**（`commitBuild`，`widget` 工具的 `build`，可带 `message`）。改 widget 的 agent
 * 不碰 git：基础档案刻意不带 git 工具，沙箱里的 bash git 又读不到 `~/.gitconfig`。
 * 这样"这是不是个仓库""要不要 init""脏了怎么办""该不该提交"这类不变量不依赖 LLM 判断。
 *
 * 一切失败只记日志：版本控制是增益能力，绝不能让 widget 的创建 / 构建 / 重命名因它而失败。
 * 用 initOp/addOp/commitOp 而非 isomorphic-git 裸 API，是为了复用 git 工具里已被测试覆盖的
 * 竞态 status 修正、删除文件处理与"无暂存变更"判定。
 */

import * as nodeFs from 'node:fs'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  initOp,
  addOp,
  commitOp,
  type GitCache,
  type GitEnv,
  type GitFsClient,
  type GitOpOutput
} from '@shuvix/agent-runtime'
import { createLogger } from '../../logger'

const log = createLogger('WidgetRepo')

/**
 * 宿主自动提交的固定署名 —— 与 agent / 用户的提交区分开。
 * 这些提交是平台行为（脚手架、改名同步），归给具体的人反而是错误归属。
 */
const HOST_AUTHOR = { authorName: 'ShuviX', authorEmail: 'widget@shuvix.local' }

/**
 * 构建成功后那条提交的署名 —— 提交的是改 widget 的人（agent 或用户手改）的工作，与平台行为区分开。
 * 与从前内置 widget agent 经 git 工具提交时用的署名相同，新旧历史读起来是一个作者。
 */
const WORK_AUTHOR = { authorName: 'ShuviX Widget', authorEmail: 'widget@shuvix.local' }

function envFor(dir: string): GitEnv {
  return { fs: nodeFs as unknown as GitFsClient, dir }
}

/** git op 的业务失败不抛错，而是把说明放进 details.error */
function failureOf(out: GitOpOutput): string | undefined {
  const err = out.details?.error
  return typeof err === 'string' ? err : undefined
}

/** add + commit；"无暂存变更"是正常状态，不当作失败。返回是否走到了提交这一步 */
async function stageAndCommit(
  env: GitEnv,
  cache: GitCache,
  message: string,
  paths: string[],
  author: { authorName: string; authorEmail: string } = HOST_AUTHOR
): Promise<{ landed: boolean; oid?: string }> {
  const added = await addOp(env, cache, { paths })
  const addError = failureOf(added)
  if (addError) {
    log.warn(`git add failed in ${env.dir}: ${addError}`)
    return { landed: false }
  }
  const committed = await commitOp(env, cache, { message, ...author })
  const commitError = failureOf(committed)
  if (commitError && !/nothing to commit/i.test(commitError)) {
    log.warn(`git commit failed in ${env.dir}: ${commitError}`)
    return { landed: false }
  }
  const oid = committed.details?.oid
  return {
    landed: true,
    oid: commitError === undefined && typeof oid === 'string' ? oid : undefined
  }
}

/**
 * 确保 widget 目录是一个 git 仓库：已是仓库则原样返回（幂等），
 * 否则 init 并把当前全部文件作为基线提交。
 *
 * 对历史遗留 widget（创建时还没有版本控制）来说，这是它们的第一个提交 ——
 * 因此 widget 技能的维护流程要求"先 build 再改"，让基线落在改动之前。
 */
export async function ensureRepo(dir: string, baselineMessage: string): Promise<void> {
  try {
    if (!existsSync(dir)) return
    if (existsSync(join(dir, '.git'))) return
    const env = envFor(dir)
    const cache: GitCache = {}
    const initialized = await initOp(env, cache, {})
    const initError = failureOf(initialized)
    if (initError) {
      log.warn(`git init failed in ${dir}: ${initError}`)
      return
    }
    const { landed } = await stageAndCommit(env, cache, baselineMessage, ['.'])
    log.info(
      landed
        ? `initialized widget repo at ${dir}`
        : `initialized widget repo at ${dir}, but the baseline commit did not land`
    )
  } catch (err) {
    log.warn(`ensureRepo failed for ${dir}: ${(err as Error).message}`)
  }
}

/**
 * 提交宿主自己刚写进 widget 目录的改动（目前只有重命名同步 widget.json）。
 * 不是仓库就什么都不做 —— 宿主写入不该顺带把旧 widget 变成仓库。
 *
 * paths 必须精确到宿主改过的文件：这个提交署名是 ShuviX，用 '.' 会把 agent 或用户
 * 正在改的东西一并卷进一条"同步 manifest"的提交里，历史就说谎了。
 */
export async function commitHostChange(
  dir: string,
  message: string,
  paths: string[]
): Promise<void> {
  try {
    if (!existsSync(join(dir, '.git'))) return
    await stageAndCommit(envFor(dir), {}, message, paths)
  } catch (err) {
    log.warn(`commitHostChange failed for ${dir}: ${(err as Error).message}`)
  }
}

/** 构建成功后的那条提交的默认说明（`--message` 没给时） */
export function defaultBuildMessage(id: string): string {
  return `chore(${id}): build`
}

/**
 * 构建成功后提交整棵树（`.`，删除的文件一并记下）。不是仓库就什么都不做（`ensureRepo` 在构建之前已经补过）。
 * 返回新提交的 oid；没有改动（"nothing to commit"）或提交失败 → undefined。失败只记日志，构建结果照常返回。
 */
export async function commitBuild(dir: string, message: string): Promise<string | undefined> {
  try {
    if (!existsSync(join(dir, '.git'))) return undefined
    const { oid } = await stageAndCommit(envFor(dir), {}, message, ['.'], WORK_AUTHOR)
    return oid
  } catch (err) {
    log.warn(`commitBuild failed for ${dir}: ${(err as Error).message}`)
    return undefined
  }
}
