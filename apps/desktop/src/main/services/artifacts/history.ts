/**
 * 会话 Artifacts 的版本历史 —— **一个 artifacts 目录一个 git 仓库**，init 与提交全归宿主（与知识库、
 * widget、跟踪项同一模式：驱动 agent-runtime 的 initOp/addOp/commitOp，复用已测试的竞态 status 修正与
 * 「无暂存变更」判定）。一切失败只记日志：版本是增益能力，绝不能让工具调用因它而失败。
 *
 * **提交时机：每次工具调用之后**（工具包装器的执行钩子，见 wrapToolOutput），目录有变化就提交一版。
 * 不只挂在 `artifact` 与 write / edit 上：bash 里的 `sed -i`、MCP 工具一样写得到这个目录，挂在工具
 * 出口上一处就全看得见。一版对应一次工具调用，于是它在转写里有确定的位置 —— 将来引用围栏按「它
 * 所在那条消息之前的最后一版」显示，靠的就是这个（工具总在包含它的那条消息之后才执行）。
 *
 * **执行之前也看一眼**：目录在、仓库不在，就是升级前写下的产物 —— 先把它们原样提交成基线，这次
 * 调用的改动才落成自己的一版，而不是与旧内容糊成一条。目录是这次调用新建的就没有基线，第一版
 * 就是它。
 *
 * **便宜的那条路**：绝大多数会话没有产物，一次调用只多一次 existsSync；有产物时先比目录签名
 * （文件名 + 大小 + mtime），没变就不碰 git。签名与历史缓存都在内存里，重启后第一次调用会走一遍
 * add（干净则什么都不提交）。
 *
 * **同一目录串行**：同一批里并行的两个工具调用各自触发一次，git 的 index 不能被两个提交同时改。
 * 代价是先到的那次可能把两边的改动一起提交（署名记成它），版本内容仍然对，只是归属粗一档。
 * 同理，后台命令在两次调用之间写下的改动，记在它之后的那次调用名下。
 *
 * 提交信息：标题 `<工具名>: <变了的文件>`，trailer 记调用 id 与毫秒时间（git 的作者时间只到秒，
 * 同一秒里的两版要靠它排先后）。
 */
import * as nodeFs from 'node:fs'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  addOp,
  commitOp,
  initOp,
  readBlobText,
  readCommitChanges,
  writeBlobText,
  type CommitChanges,
  type GitCache,
  type GitEnv,
  type GitFsClient,
  type GitOpOutput
} from '@shuvix/agent-runtime'
import { createLogger } from '../../logger'
import { appEventBus } from '../../utils/appEventBus'
import { getSessionArtifactsDir, isSafeSessionId } from '../../utils/paths'

const log = createLogger('ArtifactHistory')

/** 宿主提交的固定署名：内容出自哪次工具调用写在 trailer 里 */
const HOST_AUTHOR = { authorName: 'ShuviX', authorEmail: 'artifacts@shuvix.local' }

/** 标题里最多列几个文件（其余记成「另 N 个」） */
const SUBJECT_MAX_FILES = 5

/** 读历史的深度上限：一场会话改上千版的产物不现实，这只是防失控 */
const HISTORY_DEPTH = 2000

/** 改了产物目录的那次工具调用 */
export interface ArtifactToolCall {
  toolName: string
  callId: string
}

/** 一件产物在历史里的概况 */
export interface ArtifactVersionInfo {
  /** 记下的版本数（新建与每次修改各算一版） */
  versions: number
  /** 最近一版的时间（ms） */
  updatedAt: number
}

function envFor(dir: string): GitEnv {
  return { fs: nodeFs as unknown as GitFsClient, dir }
}

function failureOf(out: GitOpOutput): string | undefined {
  const err = out.details?.error
  return typeof err === 'string' ? err : undefined
}

/** 每个目录一条串行队列：前一个失败不拦后一个 */
const queues = new Map<string, Promise<unknown>>()

function serial<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const next = (queues.get(dir) ?? Promise.resolve()).then(fn, fn)
  const tail = next.catch(() => undefined)
  queues.set(dir, tail)
  void tail.then(() => {
    if (queues.get(dir) === tail) queues.delete(dir)
  })
  return next
}

/** 上次提交（或确认干净）时的目录签名 */
const signatures = new Map<string, string>()
/** 读过的历史（只有宿主提交，所以在提交处作废就够了） */
const histories = new Map<string, CommitChanges[]>()

/** 目录签名：顶层每一项的名字 + 大小 + mtime（产物目录是平的）；读不了 → null */
function signatureOf(dir: string): string | null {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.name !== '.git')
      .map((e) => {
        const st = statSync(join(dir, e.name))
        return `${e.name}\0${st.size}\0${st.mtimeMs}`
      })
      .sort()
      .join('\n')
  } catch {
    return null
  }
}

function subjectOf(toolName: string, paths: string[]): string {
  if (paths.length === 0) return toolName
  const shown = paths.slice(0, SUBJECT_MAX_FILES).join(', ')
  const more = paths.length - SUBJECT_MAX_FILES
  return `${toolName}: ${shown}${more > 0 ? ` (+${more})` : ''}`
}

/**
 * add 全部 + commit（提交信息按这次暂存的文件现写）。返回提交落没落地与这次暂存了哪些文件；
 * 失败 = null（已记日志）。
 *
 * 暂存为空也照样去提交：上一次 add 成功、commit 没走完（中途退出）留下的暂存内容，add 不会再报
 * 一遍，只有 commit 看得见 —— 交给 commitOp 判「有没有要提交的」。
 */
async function commitAll(
  env: GitEnv,
  cache: GitCache,
  messageFor: (paths: string[]) => string
): Promise<{ committed: boolean; paths: string[] } | null> {
  const added = await addOp(env, cache, { paths: ['.'] })
  const addError = failureOf(added)
  if (addError) {
    log.warn(`git add failed in ${env.dir}: ${addError}`)
    return null
  }
  const paths = Array.isArray(added.details?.paths) ? (added.details.paths as string[]) : []
  const commitError = failureOf(
    await commitOp(env, cache, { message: messageFor(paths), ...HOST_AUTHOR })
  )
  if (commitError) {
    if (/nothing to commit/i.test(commitError)) return { committed: false, paths }
    log.warn(`git commit failed in ${env.dir}: ${commitError}`)
    return null
  }
  return { committed: true, paths }
}

/** 不是仓库就 init；成功（或本来就是）返回 true */
async function ensureRepo(env: GitEnv, cache: GitCache): Promise<boolean> {
  if (existsSync(join(env.dir, '.git'))) return true
  const initError = failureOf(await initOp(env, cache, {}))
  if (initError) {
    log.warn(`git init failed in ${env.dir}: ${initError}`)
    return false
  }
  return true
}

/**
 * 仓库有没有第一个提交 —— 看分支的 ref 文件（initOp 建的是 main，isomorphic-git 只写松散 ref）。
 * 用它而不是 `.git` 在不在来判基线：init 成功、基线提交失败时，下一次调用还会再补。
 */
const hasFirstCommit = (dir: string): boolean =>
  existsSync(join(dir, '.git', 'refs', 'heads', 'main'))

/**
 * 工具执行之前：目录在、还没有第一个提交（升级前写下的产物）→ init 并把现有内容提交成基线。
 * 其余情况什么都不做 —— 这是每次工具调用都会走的路，常态只有两次 existsSync。
 */
export function prepareArtifactHistory(sessionId: string): Promise<void> {
  if (!isSafeSessionId(sessionId)) return Promise.resolve()
  const dir = getSessionArtifactsDir(sessionId)
  if (!existsSync(dir) || hasFirstCommit(dir)) return Promise.resolve()
  return serial(dir, async () => {
    try {
      if (hasFirstCommit(dir)) return
      const env = envFor(dir)
      const cache: GitCache = {}
      if (!(await ensureRepo(env, cache))) return
      const sig = signatureOf(dir)
      const result = await commitAll(
        env,
        cache,
        () => 'Baseline: artifacts written before versions were kept'
      )
      if (result === null) return
      histories.delete(dir)
      if (sig !== null) signatures.set(dir, sig)
    } catch (err) {
      log.warn(`baseline failed for ${dir}: ${(err as Error).message}`)
    }
  })
}

/**
 * 工具执行之后：目录有变化就提交一版，并发 `artifacts.changed`。目录不存在（会话没有产物）
 * 或签名没变就直接返回。
 */
export function recordArtifactChange(sessionId: string, call: ArtifactToolCall): Promise<void> {
  if (!isSafeSessionId(sessionId)) return Promise.resolve()
  const dir = getSessionArtifactsDir(sessionId)
  if (!existsSync(dir)) return Promise.resolve()
  return serial(dir, async () => {
    try {
      const sig = signatureOf(dir)
      if (sig === null || sig === signatures.get(dir)) return
      const env = envFor(dir)
      const cache: GitCache = {}
      if (!(await ensureRepo(env, cache))) return
      const result = await commitAll(env, cache, (changed) =>
        [
          subjectOf(call.toolName || 'tool', changed),
          '',
          `Tool-Call-Id: ${call.callId}`,
          `Recorded-At: ${new Date().toISOString()}`
        ].join('\n')
      )
      if (result === null) return
      signatures.set(dir, sig)
      if (!result.committed) return
      histories.delete(dir)
      appEventBus.publish({ type: 'artifacts.changed', sessionIds: [sessionId] })
    } catch (err) {
      log.warn(`recording artifact change failed for ${dir}: ${(err as Error).message}`)
    }
  })
}

/**
 * 提交信息里的毫秒时间。基线没有 —— 它记的是升级那一刻，不是这些文件写下的时候，拿它当
 * 时间会把旧产物全压成同一秒；交回 0，调用方回落到文件的 mtime。
 */
function recordedAt(c: CommitChanges): number {
  const m = /^Recorded-At: (.+)$/m.exec(c.message)
  const at = m ? Date.parse(m[1]) : NaN
  return Number.isFinite(at) ? at : 0
}

/**
 * 每件产物的版本数与最近一版的时间（按文件名）。没有仓库、或文件从没进过历史的，不在表里；
 * 只有基线那一版的，时间是 0 —— 两种都由调用方兜底（算一版 / 时间取 mtime）。
 * 删掉又建回同名的一件只算新的这一段：从新往旧数，遇到它的删除就停。
 */
export function artifactVersionStats(sessionId: string): Promise<Map<string, ArtifactVersionInfo>> {
  const stats = new Map<string, ArtifactVersionInfo>()
  if (!isSafeSessionId(sessionId)) return Promise.resolve(stats)
  const dir = getSessionArtifactsDir(sessionId)
  if (!existsSync(join(dir, '.git'))) return Promise.resolve(stats)
  return serial(dir, async () => {
    try {
      let history = histories.get(dir)
      if (!history) {
        history = await readCommitChanges(envFor(dir), {}, { depth: HISTORY_DEPTH })
        histories.set(dir, history)
      }
      const ended = new Set<string>()
      for (const c of history) {
        const at = recordedAt(c)
        for (const change of c.changes) {
          if (ended.has(change.path)) continue
          if (change.status === 'D') {
            ended.add(change.path)
            continue
          }
          const prev = stats.get(change.path)
          stats.set(change.path, {
            versions: (prev?.versions ?? 0) + 1,
            updatedAt: Math.max(prev?.updatedAt ?? 0, at)
          })
        }
      }
    } catch (err) {
      log.warn(`reading artifact history failed for ${dir}: ${(err as Error).message}`)
    }
    return stats
  })
}

/**
 * 把一段内容存进这场会话产物目录的对象库，交回它的哈希（引用钉版本用，见 pins.ts）。不进提交 —— 只是让
 * 那一份内容以后凭哈希取得回来。目录还不是仓库就先 init；目录不在或写不进 → null（已记日志）。
 */
export function storeArtifactBlob(sessionId: string, content: string): Promise<string | null> {
  if (!isSafeSessionId(sessionId)) return Promise.resolve(null)
  const dir = getSessionArtifactsDir(sessionId)
  if (!existsSync(dir)) return Promise.resolve(null)
  return serial(dir, async () => {
    try {
      const env = envFor(dir)
      if (!(await ensureRepo(env, {}))) return null
      return await writeBlobText(env, content)
    } catch (err) {
      log.warn(`storing artifact blob failed for ${dir}: ${(err as Error).message}`)
      return null
    }
  })
}

/** 按哈希取回一份内容；没有仓库、或对象库里没有这一份 → null */
export function readArtifactBlob(sessionId: string, oid: string): Promise<string | null> {
  if (!isSafeSessionId(sessionId)) return Promise.resolve(null)
  const dir = getSessionArtifactsDir(sessionId)
  if (!existsSync(join(dir, '.git'))) return Promise.resolve(null)
  return readBlobText(envFor(dir), {}, oid)
}
