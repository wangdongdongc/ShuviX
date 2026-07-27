/**
 * diff 实现（体量大，独立文件）—— isomorphic-git 无内置 diff，
 * 用 statusMatrix / TREE walk 找变更文件 + readBlob 取两侧内容 + `diff` 包生成 unified patch。
 *
 * 三种模式（互斥；staged 与 from 同给 → 业务错误 "not both"）：
 *   1. 默认：工作区 vs 索引（未暂存的改动；不含 untracked —— 对齐 git diff）
 *   2. staged:true：索引 vs HEAD（已暂存的改动）
 *   3. from（+to?）：两 commit 树之间；to 缺省 = 工作区（untracked 不计入）
 * params.path 过滤单个文件或目录前缀。
 *
 * 输出格式（git apply 兼容）：diff --git 头 + ---/+++（新增/删除侧 /dev/null）+ @@ hunk（context 3）；
 * 二进制（任一侧前 8000 字节含 \0）整段替换为 `Binary files a/<p> and b/<p> differ`。
 * 无变更 → `no changes`。大输出不在此截断（交给宿主 wrapToolOutput）。
 */
import * as git from 'isomorphic-git'
import { structuredPatch } from 'diff'
import type { GitCache, GitEnv, GitOpOutput } from './env'
import type { GitOpParams } from './ops'
import {
  bizError,
  joinPath,
  racySafeStatusMatrix,
  resolveMaybeOid,
  runOp,
  treeNameStatus
} from './gitOps'

/** 一侧内容来源：blob oid / 工作区文件 / 不存在 */
type Side = { kind: 'blob'; oid: string } | { kind: 'workdir' } | { kind: 'absent' }

interface FileChange {
  path: string
  oldSide: Side
  newSide: Side
}

const ABSENT: Side = { kind: 'absent' }
const WORKDIR_SIDE: Side = { kind: 'workdir' }

function matchesPath(filepath: string, filter?: string): boolean {
  if (!filter) return true
  return filepath === filter || filepath.startsWith(`${filter}/`)
}

/** 默认模式：工作区 vs 索引（旧侧 = 索引 blob，新侧 = 工作区；untracked/已暂存删除 不计入） */
async function collectWorkdirVsIndex(
  env: GitEnv,
  cache: GitCache,
  pathFilter?: string
): Promise<FileChange[]> {
  const { fs, dir } = env
  const { rows: matrix } = await racySafeStatusMatrix(
    env,
    cache,
    pathFilter ? [pathFilter] : undefined
  )
  const wanted: string[] = []
  const changes: FileChange[] = []
  for (const [fp, , workdir, stage] of matrix) {
    if (stage === 0) continue // untracked（无索引侧）/ 已暂存删除（两侧一致）
    const changed = (workdir === 2 && stage !== 2) || workdir === 0
    if (!changed) continue
    wanted.push(fp)
    changes.push({
      path: fp,
      oldSide: { kind: 'blob', oid: '' }, // oid 由下方 STAGE walk 回填
      newSide: workdir === 0 ? ABSENT : WORKDIR_SIDE
    })
  }
  if (changes.length === 0) return []
  // 一次 STAGE walk 回填索引 blob oid
  const wantedSet = new Set(wanted)
  const oids = new Map<string, string>()
  await git.walk({
    fs,
    dir,
    cache,
    trees: [git.STAGE()],
    map: async (fp, [entry]) => {
      if (!entry || fp === '.' || !wantedSet.has(fp)) return undefined
      if ((await entry.type()) === 'blob') oids.set(fp, await entry.oid())
      return undefined
    }
  })
  return changes
    .filter((c) => oids.has(c.path))
    .map((c) => ({ ...c, oldSide: { kind: 'blob', oid: oids.get(c.path)! } }))
}

/** staged 模式：HEAD vs 索引 */
async function collectIndexVsHead(
  env: GitEnv,
  cache: GitCache,
  pathFilter?: string
): Promise<FileChange[]> {
  const { fs, dir } = env
  const results: FileChange[] =
    (await git.walk({
      fs,
      dir,
      cache,
      trees: [git.TREE({ ref: 'HEAD' }), git.STAGE()],
      map: async (fp, [a, b]) => {
        if (fp === '.' || !matchesPath(fp, pathFilter)) return undefined
        const aType = a ? await a.type() : undefined
        const bType = b ? await b.type() : undefined
        if (aType !== 'blob' && bType !== 'blob') return undefined
        const aOid = aType === 'blob' ? await a!.oid() : undefined
        const bOid = bType === 'blob' ? await b!.oid() : undefined
        if (aOid === bOid) return undefined
        return {
          path: fp,
          oldSide: aOid ? { kind: 'blob', oid: aOid } : ABSENT,
          newSide: bOid ? { kind: 'blob', oid: bOid } : ABSENT
        } satisfies FileChange
      }
    })) ?? []
  return results
}

/** from..to 模式（to 缺省 = 工作区，untracked 不计入） */
async function collectCommitRange(
  env: GitEnv,
  cache: GitCache,
  from: string,
  to: string | undefined,
  pathFilter?: string
): Promise<FileChange[]> {
  const fromOid = await resolveMaybeOid(env, cache, from)
  if (to) {
    const toOid = await resolveMaybeOid(env, cache, to)
    const changes = await treeNameStatus(env, cache, fromOid, toOid)
    return changes
      .filter((c) => matchesPath(c.path, pathFilter))
      .map((c) => ({
        path: c.path,
        oldSide: c.fromOid ? { kind: 'blob', oid: c.fromOid } : ABSENT,
        newSide: c.toOid ? { kind: 'blob', oid: c.toOid } : ABSENT
      }))
  }
  // vs 工作区：tracked 集合 = 索引文件 ∪ from 树文件（排除 untracked）；
  // WORKDIR walker 的 oid() 同样吃 index stat 捷径，racy 纠正后的真实 oid 优先
  const { fs, dir } = env
  const tracked = new Set(await git.listFiles({ fs, dir }))
  const { workdirOids } = await racySafeStatusMatrix(
    env,
    cache,
    pathFilter ? [pathFilter] : undefined
  )
  const results: FileChange[] =
    (await git.walk({
      fs,
      dir,
      cache,
      trees: [git.TREE({ ref: fromOid }), git.WORKDIR()],
      map: async (fp, [a, b]) => {
        if (fp === '.' || !matchesPath(fp, pathFilter)) return undefined
        const aType = a ? await a.type() : undefined
        const bType = b ? await b.type() : undefined
        if (aType !== 'blob' && bType !== 'blob') return undefined
        if (aType !== 'blob' && !tracked.has(fp)) return undefined // untracked
        const aOid = aType === 'blob' ? await a!.oid() : undefined
        const bOid = bType === 'blob' ? (workdirOids.get(fp) ?? (await b!.oid())) : undefined
        if (aOid === bOid) return undefined
        return {
          path: fp,
          oldSide: aOid ? { kind: 'blob', oid: aOid } : ABSENT,
          newSide: bType === 'blob' ? WORKDIR_SIDE : ABSENT
        } satisfies FileChange
      }
    })) ?? []
  return results
}

async function loadSide(
  env: GitEnv,
  cache: GitCache,
  path: string,
  side: Side
): Promise<Uint8Array | null> {
  if (side.kind === 'absent') return null
  if (side.kind === 'blob') {
    const { fs, dir } = env
    const { blob } = await git.readBlob({ fs, dir, cache, oid: side.oid })
    return blob
  }
  try {
    const data = await env.fs.promises.readFile(joinPath(env.dir, path))
    return typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data)
  } catch {
    return null
  }
}

function isBinary(bytes: Uint8Array | null): boolean {
  if (!bytes) return false
  const limit = Math.min(bytes.byteLength, 8000)
  for (let i = 0; i < limit; i++) {
    if (bytes[i] === 0) return true
  }
  return false
}

const decoder = new TextDecoder('utf-8')

/** 单文件 patch 段（git apply 兼容；二进制降级为 Binary files 行） */
function formatFilePatch(
  path: string,
  oldBytes: Uint8Array | null,
  newBytes: Uint8Array | null
): string {
  const header = `diff --git a/${path} b/${path}`
  if (isBinary(oldBytes) || isBinary(newBytes)) {
    return `${header}\nBinary files a/${path} and b/${path} differ`
  }
  const oldText = oldBytes ? decoder.decode(oldBytes) : ''
  const newText = newBytes ? decoder.decode(newBytes) : ''
  const patch = structuredPatch(path, path, oldText, newText, undefined, undefined, { context: 3 })
  const lines = [
    header,
    `--- ${oldBytes == null ? '/dev/null' : `a/${path}`}`,
    `+++ ${newBytes == null ? '/dev/null' : `b/${path}`}`
  ]
  for (const h of patch.hunks) {
    lines.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`)
    lines.push(...h.lines)
  }
  return lines.join('\n')
}

export async function diffOp(
  env: GitEnv,
  cache: GitCache,
  params: GitOpParams
): Promise<GitOpOutput> {
  return runOp(async () => {
    if (params.staged && params.from) {
      return bizError('pass either staged or from/to, not both')
    }
    let changes: FileChange[]
    if (params.from) {
      changes = await collectCommitRange(env, cache, params.from, params.to, params.path)
    } else if (params.staged) {
      changes = await collectIndexVsHead(env, cache, params.path)
    } else {
      changes = await collectWorkdirVsIndex(env, cache, params.path)
    }
    changes.sort((a, b) => (a.path < b.path ? -1 : 1))
    if (changes.length === 0) {
      return { text: 'no changes', details: { fileCount: 0 } }
    }
    const sections: string[] = []
    for (const c of changes) {
      const oldBytes = await loadSide(env, cache, c.path, c.oldSide)
      const newBytes = await loadSide(env, cache, c.path, c.newSide)
      sections.push(formatFilePatch(c.path, oldBytes, newBytes))
    }
    return { text: `${sections.join('\n')}\n`, details: { fileCount: changes.length } }
  })
}
