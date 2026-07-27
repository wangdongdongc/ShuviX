/**
 * git 各 op 的唯一实现（diff 除外，见 diffOps.ts）—— isomorphic-git 单后端，两端共享。
 *
 * 统一签名：(env, cache, params) => Promise<GitOpOutput>。
 * 业务失败不抛错：text 以 "Error: " 开头 + details.error 置错误消息（与 browser 工具同约定）；
 * 各 op 出口统一经 runOp 包裹，isomorphic-git 抛出的 NotFoundError/AlreadyExistsError 等
 * 一律转业务错误。cache 由 tool.ts 每会话创建一次、全程复用。
 */
import * as git from 'isomorphic-git'
import type { GitCache, GitEnv, GitOpOutput } from './env'
import type { GitOpParams } from './ops'
import { resolveAuthor, AUTHOR_MISSING_MESSAGE } from './author'

// ---------------------------------------------------------------------------
// 共享小工具（diffOps 也复用）
// ---------------------------------------------------------------------------

/** 业务错误输出（text "Error: " 开头 + details.error） */
export function bizError(message: string): GitOpOutput {
  return { text: `Error: ${message}`, details: { error: message } }
}

/** op 出口统一包裹：任何抛出的错误转业务错误 */
export async function runOp(fn: () => Promise<GitOpOutput>): Promise<GitOpOutput> {
  try {
    return await fn()
  } catch (e) {
    return bizError(e instanceof Error ? e.message : String(e))
  }
}

/** 仓库根 + 仓库相对路径 → env.fs 可用的路径（桌面绝对路径 / 扩展 '/x/y'） */
export function joinPath(dir: string, rel: string): string {
  if (dir === '/') return `/${rel}`
  return dir.endsWith('/') ? `${dir}${rel}` : `${dir}/${rel}`
}

/** ref（分支名/HEAD/长短 oid）→ 完整 oid */
export async function resolveMaybeOid(env: GitEnv, cache: GitCache, ref: string): Promise<string> {
  const { fs, dir } = env
  try {
    return await git.resolveRef({ fs, dir, ref })
  } catch (e) {
    if (/^[0-9a-f]{4,40}$/i.test(ref)) {
      return await git.expandOid({ fs, dir, oid: ref, cache })
    }
    throw e
  }
}

type MatrixRow = [string, 0 | 1, 0 | 1 | 2, 0 | 1 | 2 | 3]

/**
 * racy-git 保护的 statusMatrix（isomorphic-git 缺失的部分，见 racy-git.txt）。
 *
 * isomorphic-git 的 statusMatrix 靠 index 记录的 stat（秒级 mtime + size 等）跳过重哈希，
 * 因此「同一秒内、同尺寸」的修改会被误判为未变（real git 用 racy 条目重哈希规避）。
 * 这里补上：条目 mtime ≥ .git/index 文件 mtime（秒级）即视为 racy，重读工作区内容
 * hashBlob 比对，必要时纠正 workdir/stage 列，并记录真实 workdir blob oid 供 diff 复用。
 */
export async function racySafeStatusMatrix(
  env: GitEnv,
  cache: GitCache,
  filepaths?: string[]
): Promise<{ rows: MatrixRow[]; workdirOids: Map<string, string> }> {
  const { fs, dir } = env
  const rows = (await git.statusMatrix({ fs, dir, cache, filepaths })) as MatrixRow[]
  const workdirOids = new Map<string, string>()

  let indexMtimeSec: number
  try {
    const st = await fs.promises.stat(joinPath(dir, '.git/index'))
    indexMtimeSec = Math.floor(st.mtimeMs / 1000)
  } catch {
    return { rows, workdirOids } // 无 index（如刚 init），没有 stat 捷径可失效
  }

  // 只有「index 条目存在且工作区文件存在」的行才可能吃到 stat 捷径
  const suspects = new Set(rows.filter(([, , w, s]) => w !== 0 && s !== 0).map(([fp]) => fp))
  if (suspects.size === 0) return { rows, workdirOids }

  // 一次 STAGE walk 取可疑条目的 oid + index 记录的 mtime
  const stageInfo = new Map<string, { oid: string; mtimeSec: number }>()
  await git.walk({
    fs,
    dir,
    cache,
    trees: [git.STAGE()],
    map: async (fp, [entry]) => {
      if (!entry || fp === '.' || !suspects.has(fp)) return undefined
      if ((await entry.type()) === 'blob') {
        const st = (await entry.stat()) as { mtimeSeconds?: number; mtimeMs?: number } | undefined
        const mtimeSec =
          st?.mtimeSeconds ?? (st?.mtimeMs != null ? Math.floor(st.mtimeMs / 1000) : Infinity)
        stageInfo.set(fp, { oid: await entry.oid(), mtimeSec })
      }
      return undefined
    }
  })

  for (const row of rows) {
    const info = stageInfo.get(row[0])
    if (!info || info.mtimeSec < indexMtimeSec) continue // 非 racy，stat 捷径可信
    let data: Uint8Array
    try {
      const raw = await fs.promises.readFile(joinPath(dir, row[0]))
      data = typeof raw === 'string' ? new TextEncoder().encode(raw) : new Uint8Array(raw)
    } catch {
      continue
    }
    const { oid } = await git.hashBlob({ object: data })
    workdirOids.set(row[0], oid)
    if (oid === info.oid) continue // 内容确实没变
    row[2] = 2 // workdir 与 stage 实际不同
    if (row[3] === 2) row[3] = 3
  }
  return { rows, workdirOids }
}

/** statusMatrix 行 → porcelain 两列码；干净行返回 null */
function statusCodes(row: MatrixRow): string | null {
  const [, head, workdir, stage] = row
  if (head === 1 && workdir === 1 && stage === 1) return null
  const x = head === 0 ? (stage === 0 ? '?' : 'A') : stage === 0 ? 'D' : stage === 1 ? ' ' : 'M'
  const y =
    head === 0 && stage === 0
      ? '?'
      : workdir === 0
        ? stage === 0
          ? ' '
          : 'D'
        : workdir === 2 && stage !== 2
          ? 'M'
          : ' '
  return `${x}${y}`
}

/** 当前分支行（detached 时 HEAD detached at <7位oid>） */
async function branchHeader(env: GitEnv): Promise<string> {
  const { fs, dir } = env
  const branch = await git.currentBranch({ fs, dir, fullname: false })
  if (branch) return `On branch ${branch}`
  const oid = await git.resolveRef({ fs, dir, ref: 'HEAD' })
  return `HEAD detached at ${oid.slice(0, 7)}`
}

/**
 * 两棵 commit 树的 name-status 对比（fromOid 为 null = 与空树比，全部 A）。
 * showOp 与 diffOps 复用。返回按路径字母序。
 */
export async function treeNameStatus(
  env: GitEnv,
  cache: GitCache,
  fromOid: string | null,
  toOid: string
): Promise<Array<{ path: string; status: 'A' | 'M' | 'D'; fromOid?: string; toOid?: string }>> {
  const { fs, dir } = env
  const trees = fromOid
    ? [git.TREE({ ref: fromOid }), git.TREE({ ref: toOid })]
    : [git.TREE({ ref: toOid })]
  const results: Array<{
    path: string
    status: 'A' | 'M' | 'D'
    fromOid?: string
    toOid?: string
  }> =
    (await git.walk({
      fs,
      dir,
      cache,
      trees,
      map: async (filepath, entries) => {
        if (filepath === '.') return undefined
        const [a, b] = fromOid ? entries : [null, entries[0]]
        const aType = a ? await a.type() : undefined
        const bType = b ? await b.type() : undefined
        if (aType !== 'blob' && bType !== 'blob') return undefined
        const aOid = aType === 'blob' ? await a!.oid() : undefined
        const bOid = bType === 'blob' ? await b!.oid() : undefined
        if (aOid === bOid) return undefined
        const status = aOid == null ? 'A' : bOid == null ? 'D' : 'M'
        return { path: filepath, status, fromOid: aOid, toOid: bOid }
      }
    })) ?? []
  return results.sort((m, n) => (m.path < n.path ? -1 : 1))
}

// ---------------------------------------------------------------------------
// ops
// ---------------------------------------------------------------------------

/** status —— statusMatrix + currentBranch，porcelain 风格两列码（规格见测试/契约） */
export async function statusOp(
  env: GitEnv,
  cache: GitCache,
  params: GitOpParams
): Promise<GitOpOutput> {
  return runOp(async () => {
    const { rows: matrix } = await racySafeStatusMatrix(
      env,
      cache,
      params.paths?.length ? params.paths : undefined
    )
    const lines: string[] = []
    for (const row of matrix) {
      const codes = statusCodes(row)
      if (codes) lines.push(`${codes} ${row[0]}`)
    }
    lines.sort((a, b) => (a.slice(3) < b.slice(3) ? -1 : 1))
    const header = await branchHeader(env)
    const body = lines.length > 0 ? lines.join('\n') : 'nothing to commit, working tree clean'
    return { text: `${header}\n${body}`, details: { fileCount: lines.length } }
  })
}

/** log —— 历史，新→旧；行格式 `<7位oid> <YYYY-MM-DD> <author> — <subject>` */
export async function logOp(
  env: GitEnv,
  cache: GitCache,
  params: GitOpParams
): Promise<GitOpOutput> {
  return runOp(async () => {
    const { fs, dir } = env
    const ref = params.ref ?? 'HEAD'
    const commits = await git.log({
      fs,
      dir,
      cache,
      ref,
      depth: params.depth ?? 20,
      filepath: params.path
    })
    if (commits.length === 0) return bizError(`no commits found for ${ref}`)
    const lines = commits.map((c) => {
      const date = new Date(c.commit.author.timestamp * 1000).toISOString().slice(0, 10)
      const subject = c.commit.message.split('\n')[0]
      return `${c.oid.slice(0, 7)} ${date} ${c.commit.author.name} — ${subject}`
    })
    return { text: lines.join('\n'), details: { fileCount: commits.length, ref } }
  })
}

/** show —— commit 元数据 + 与首个 parent 的 name-status（根 commit 全 A） */
export async function showOp(
  env: GitEnv,
  cache: GitCache,
  params: GitOpParams
): Promise<GitOpOutput> {
  return runOp(async () => {
    const { fs, dir } = env
    const oid = await resolveMaybeOid(env, cache, params.ref!)
    const { commit } = await git.readCommit({ fs, dir, oid, cache })
    const parent = commit.parent[0] ?? null
    const changes = await treeNameStatus(env, cache, parent, oid)
    const date = new Date(commit.author.timestamp * 1000).toISOString()
    const text = [
      `commit ${oid}`,
      `Author: ${commit.author.name} <${commit.author.email}>`,
      `Date: ${date}`,
      '',
      commit.message.trimEnd(),
      '',
      ...changes.map((c) => `${c.status} ${c.path}`)
    ].join('\n')
    return { text, details: { oid, ref: params.ref, fileCount: changes.length } }
  })
}

/** add —— 暂存（工作区已删的走 remove；"."/目录经 statusMatrix 展开） */
export async function addOp(
  env: GitEnv,
  cache: GitCache,
  params: GitOpParams
): Promise<GitOpOutput> {
  return runOp(async () => {
    const { fs, dir } = env
    const toAdd = new Set<string>()
    const toRemove = new Set<string>()

    const expand = async (prefix?: string): Promise<void> => {
      const { rows: matrix } = await racySafeStatusMatrix(env, cache, prefix ? [prefix] : undefined)
      for (const [fp, , workdir, stage] of matrix) {
        if (workdir === 2 && stage !== 2) toAdd.add(fp)
        else if (workdir === 0 && stage !== 0) toRemove.add(fp)
      }
    }

    for (const p of params.paths ?? []) {
      if (p === '.') {
        await expand()
        continue
      }
      let isDirectory = false
      let exists = true
      try {
        isDirectory = (await env.fs.promises.stat(joinPath(dir, p))).isDirectory()
      } catch {
        exists = false
      }
      if (isDirectory) {
        await expand(p)
      } else if (exists) {
        toAdd.add(p)
      } else {
        // 工作区没有：tracked 则暂存删除，否则报错
        const rows = (await git.statusMatrix({ fs, dir, cache, filepaths: [p] })) as MatrixRow[]
        const row = rows.find(([fp]) => fp === p)
        if (row && row[3] !== 0) toRemove.add(p)
        else return bizError(`pathspec "${p}" did not match any files`)
      }
    }

    for (const fp of toAdd) await git.add({ fs, dir, cache, filepath: fp })
    for (const fp of toRemove) await git.remove({ fs, dir, cache, filepath: fp })

    const all = [...toAdd, ...toRemove].sort()
    return {
      text: `Staged ${all.length} file(s):\n${all.join('\n')}`,
      details: { fileCount: all.length }
    }
  })
}

/** unstage —— resetIndex 逐条（索引项还原为 HEAD 版本，工作区不动） */
export async function unstageOp(
  env: GitEnv,
  cache: GitCache,
  params: GitOpParams
): Promise<GitOpOutput> {
  return runOp(async () => {
    const { fs, dir } = env
    const paths = [...(params.paths ?? [])].sort()
    for (const p of paths) {
      await git.resetIndex({ fs, dir, cache, filepath: p })
    }
    return {
      text: `Unstaged ${paths.length} file(s):\n${paths.join('\n')}`,
      details: { fileCount: paths.length }
    }
  })
}

/** commit —— 提交暂存区；author 四级链；索引与 HEAD 一致 → nothing to commit */
export async function commitOp(
  env: GitEnv,
  cache: GitCache,
  params: GitOpParams
): Promise<GitOpOutput> {
  return runOp(async () => {
    const { fs, dir } = env
    // 无暂存变更检查（unborn HEAD —— 首次提交 —— 时 statusMatrix 不可用，退化为查索引非空）
    let hasStaged: boolean
    try {
      const matrix = (await git.statusMatrix({ fs, dir, cache })) as MatrixRow[]
      hasStaged = matrix.some(
        ([, head, , stage]) => (head === 0 && stage !== 0) || (head === 1 && stage !== 1)
      )
    } catch {
      hasStaged = (await git.listFiles({ fs, dir })).length > 0
    }
    if (!hasStaged) return bizError('nothing to commit')

    const author = await resolveAuthor(env, cache, params)
    if (!author) return bizError(AUTHOR_MISSING_MESSAGE)

    const oid = await git.commit({ fs, dir, cache, message: params.message!, author })
    const branch = (await git.currentBranch({ fs, dir, fullname: false })) ?? 'HEAD'
    const subject = params.message!.split('\n')[0]
    return {
      text: `[${branch} ${oid.slice(0, 7)}] ${subject}`,
      details: { oid, ref: branch }
    }
  })
}

/** branch —— 无 name 列表（当前 `* ` 标记）；name 创建并切换；delete:true 删除 */
export async function branchOp(
  env: GitEnv,
  cache: GitCache,
  params: GitOpParams
): Promise<GitOpOutput> {
  void cache // branch 系列 API 不消费 cache；保留参数以统一 op 签名
  return runOp(async () => {
    const { fs, dir } = env
    const current = await git.currentBranch({ fs, dir, fullname: false })
    if (!params.name) {
      const branches = (await git.listBranches({ fs, dir })).sort()
      const lines = branches.map((b) => (b === current ? `* ${b}` : `  ${b}`))
      return { text: lines.join('\n'), details: { ref: current, fileCount: branches.length } }
    }
    if (params.delete) {
      if (params.name === current) {
        return bizError(`cannot delete branch "${params.name}": it is the current branch`)
      }
      await git.deleteBranch({ fs, dir, ref: params.name })
      return { text: `Deleted branch ${params.name}`, details: { ref: params.name } }
    }
    const existing = await git.listBranches({ fs, dir })
    if (existing.includes(params.name)) {
      return bizError(`branch "${params.name}" already exists`)
    }
    await git.branch({ fs, dir, ref: params.name, checkout: true })
    return {
      text: `Switched to a new branch '${params.name}'`,
      details: { ref: params.name }
    }
  })
}

/** checkout —— 切换分支/commit；脏冲突转业务错误并列冲突文件；force 覆盖 */
export async function checkoutOp(
  env: GitEnv,
  cache: GitCache,
  params: GitOpParams
): Promise<GitOpOutput> {
  return runOp(async () => {
    const { fs, dir } = env
    const ref = params.ref!
    try {
      await git.checkout({ fs, dir, cache, ref, force: params.force ?? false })
    } catch (e) {
      if (e instanceof git.Errors.CheckoutConflictError) {
        const files = e.data.filepaths.join(', ')
        return bizError(
          `checkout would overwrite local changes: ${files}. Commit your changes first, or pass force:true (discards them).`
        )
      }
      throw e
    }
    return { text: `Switched to branch '${ref}'`, details: { ref } }
  })
}

/** restore —— 从 ref（默认 HEAD）恢复文件到工作区，丢弃本地修改；HEAD 不动 */
export async function restoreOp(
  env: GitEnv,
  cache: GitCache,
  params: GitOpParams
): Promise<GitOpOutput> {
  return runOp(async () => {
    const { fs, dir } = env
    const ref = params.ref ?? 'HEAD'
    const paths = [...(params.paths ?? [])].sort()
    const oid = await resolveMaybeOid(env, cache, ref)
    for (const p of paths) {
      try {
        await git.readBlob({ fs, dir, cache, oid, filepath: p })
      } catch {
        return bizError(`pathspec "${p}" did not match any file in ${ref}`)
      }
    }
    await git.checkout({
      fs,
      dir,
      cache,
      ref,
      filepaths: paths,
      force: true,
      noUpdateHead: true
    })
    return {
      text: `Restored ${paths.length} file(s) from ${ref}:\n${paths.join('\n')}`,
      details: { ref, fileCount: paths.length }
    }
  })
}

/** init —— 初始化仓库，默认分支 main（已是仓库时幂等） */
export async function initOp(
  env: GitEnv,
  cache: GitCache,
  params: GitOpParams
): Promise<GitOpOutput> {
  void cache
  void params
  return runOp(async () => {
    const { fs, dir } = env
    await git.init({ fs, dir, defaultBranch: 'main' })
    return { text: 'Initialized empty Git repository (branch main)' }
  })
}
