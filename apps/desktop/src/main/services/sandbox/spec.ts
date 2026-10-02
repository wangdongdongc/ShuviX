/**
 * 会话 → 会话目录清单 → 沙箱规格。纯函数：路径解析由调用方注入（`real`），
 * 这样单测不碰文件系统，也不依赖 electron。
 *
 * **一份清单、两个面**：{@link sessionDirsFor} 算出的会话目录既是沙箱里命令能读写的范围，
 * 也是文件工具不必询问的范围（外部目录访问策略读 `vars.sessionDirs` / `vars.sessionReadDirs`）。两边各算一份就会漂移，
 * 模型会学会走不问的那条路。
 *
 * 这里同时回答「这个会话能不能套沙箱」。套不了就返回原因，调用方退回「命令逐条询问」——
 * 永远不会变成「不套沙箱又不问」。
 */
import { createHash } from 'crypto'
import { dirname, join, sep } from 'path'
import { isSafeSessionId } from '../../utils/paths'
import { MDNS_RESPONDER_SOCKET, SHUVIX_CONTENT_DIRS } from './tables'
import type { SandboxHostPaths, SandboxSessionInput, SandboxSpec } from './types'

export type SpecResult = { ok: true; spec: SandboxSpec } | { ok: false; reason: string }

/** `p` 就是 `dir` 或在它里面（按路径段边界比，与安全模块的 inDir 同义） */
export function isWithin(p: string, dir: string): boolean {
  if (p === dir) return true
  const withSep = dir.endsWith(sep) ? dir : dir + sep
  return p.startsWith(withSep)
}

function withinAny(p: string, dirs: readonly string[]): boolean {
  return dirs.some((d) => isWithin(p, d))
}

function dedupe(list: string[]): string[] {
  return [...new Set(list)]
}

/** 会话临时目录名：会话 id 的短摘要（完整 uuid 放进路径会逼近 AF_UNIX 的 104 字节上限） */
export function sessionTmpName(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex').slice(0, 8)
}

/** 根等于或覆盖家目录：沙箱等于没套，文件工具的豁免也等于没有 */
function coversHome(root: string, home: string): boolean {
  return root === '/' || isWithin(home, root)
}

/**
 * 一个可写根（工作目录或写授权）为什么不适合放进沙箱（适合时返回 null）：
 *  - 是 `/` 或覆盖家目录 —— 放行它等于放行整个家目录；
 *  - 落在 ShuviX 自己的配置里（agents / policies / hooks / bots / skills 的 notebook）——
 *    主进程把那里的文件读作规矩；
 *  - 落在应用数据里（本会话的临时工作区除外）—— 数据库、其他会话的转写都在那里；
 *  - **包含** ShuviX 的配置或应用数据（如 `~/Library`）—— 数据库里有沙箱开关与「允许并记住」，
 *    命令改得到它们就等于出得了沙箱。
 * 判定只回答一句短语，前缀（「working directory」/「a write grant」）由调用方加。
 */
function rootUnsuitable(
  paths: Pick<SandboxHostPaths, 'home' | 'shuvixHome' | 'userData'>,
  sessionId: string,
  root: string
): string | null {
  if (coversHome(root, paths.home)) return 'covers the home folder'
  if (isWithin(root, paths.shuvixHome)) {
    const content = SHUVIX_CONTENT_DIRS.map((d) => join(paths.shuvixHome, d))
    if (!withinAny(root, content)) return "is ShuviX's own configuration"
  }
  const tempWorkspace = join(paths.userData, 'temp_workspace', sessionId)
  if (isWithin(root, paths.userData) && !isWithin(root, tempWorkspace)) {
    return "is inside ShuviX's application data"
  }
  if (isWithin(paths.shuvixHome, root) || isWithin(paths.userData, root)) {
    return "contains ShuviX's own configuration or application data"
  }
  return null
}

/** 工作目录为什么不能当作会话目录（能当作时返回 null）—— 与「不套沙箱」同一批理由，见 rootUnsuitable */
export function workingDirectoryUnsuitable(
  paths: Pick<SandboxHostPaths, 'home' | 'shuvixHome' | 'userData'>,
  sessionId: string,
  ws: string
): string | null {
  const why = rootUnsuitable(paths, sessionId, ws)
  return why ? `working directory ${why}` : null
}

export interface SessionDirs {
  /** 本会话的目录：工作目录（适合时）、本会话临时目录、artifacts、工具结果、勾选的知识库 */
  dirs: string[]
  /** 本会话只读的目录：技能目录、只读的内置知识库 */
  readDirs: string[]
  /** 工作目录不适合当会话目录的原因（不适合时它不在 dirs 里；沙箱也不套） */
  workspaceUnsuitable: string | null
  tmpDir: string
}

/**
 * 一个会话的会话目录 —— 沙箱与外部目录访问策略共用的那一份清单。坏会话 id 返回 null
 * （空 id 会把清单放大到所有会话的 artifacts，`..` 会放大到 `~/.shuvix`）。
 */
export function sessionDirsFor(
  paths: SandboxHostPaths,
  input: Pick<SandboxSessionInput, 'sessionId' | 'workingDirectory' | 'extras'>,
  real: (p: string) => string
): SessionDirs | null {
  const { sessionId } = input
  if (!isSafeSessionId(sessionId)) return null
  const resolved = {
    home: real(paths.home),
    shuvixHome: real(paths.shuvixHome),
    userData: real(paths.userData)
  }
  const ws = real(input.workingDirectory)
  const workspaceUnsuitable = workingDirectoryUnsuitable(resolved, sessionId, ws)
  const tmpDir = join(paths.tmpRoot, sessionTmpName(sessionId))
  // 会话设置带来的目录同样不许覆盖家目录（防御：它们都在 ~/.shuvix 或应用包里，正常碰不到）
  const extra = (list: readonly string[] | undefined): string[] =>
    (list ?? [])
      .filter((d) => d !== '')
      .map(real)
      .filter((d) => !coversHome(d, resolved.home))
  const dirs = dedupe([
    ...(workspaceUnsuitable ? [] : [ws]),
    tmpDir,
    // 与 utils/paths 的 getSessionArtifactsDir 同一个位置（那边用 homedir()，这里用注入的 shuvixHome，
    // 好让单测不碰真家目录）—— 改一边要同步另一边
    join(resolved.shuvixHome, 'artifacts', sessionId),
    join(real(paths.toolResultsBase), sessionId),
    ...extra(input.extras?.readWrite)
  ])
  const readDirs = dedupe(extra(input.extras?.readOnly)).filter((d) => !dirs.includes(d))
  return { dirs, readDirs, workspaceUnsuitable, tmpDir }
}

/** `p` 在 `home` 里面时，从它的上一级到 `home` 本身的每一级（只放元数据用） */
function ancestorsWithin(p: string, home: string): string[] {
  if (!isWithin(p, home) || p === home) return []
  const out: string[] = []
  let cur = dirname(p)
  while (isWithin(cur, home)) {
    out.push(cur)
    if (cur === home) break
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return out
}

/**
 * 算出一个会话的沙箱规格。`real` 把路径解析成它真正指向的位置（realpath，不存在的部分按
 * 最近的已存在祖先拼回）—— Seatbelt 按解析后的路径比对，不解析的话 `/tmp/x` 永远对不上。
 */
export function buildSandboxSpec(
  paths: SandboxHostPaths,
  input: SandboxSessionInput,
  real: (p: string) => string
): SpecResult {
  const session = sessionDirsFor(paths, input, real)
  if (!session) return { ok: false, reason: 'unsafe session id' }
  if (session.workspaceUnsuitable) return { ok: false, reason: session.workspaceUnsuitable }

  const home = real(paths.home)
  const grantsWrite = dedupe(input.grantedWrite.map(real))
  const grantsRead = dedupe(input.grantedRead.map(real))
  // 写授权也是可写根，过同一套判定：覆盖家目录、碰到 ShuviX 的配置或应用数据的授权，命令拿着它
  // 就能改规矩 / 关沙箱 —— 与其套一个形同虚设的沙箱，不如逐条询问（文件工具照样凭授权写）
  const resolved = { home, shuvixHome: real(paths.shuvixHome), userData: real(paths.userData) }
  for (const g of grantsWrite) {
    const why = rootUnsuitable(resolved, input.sessionId, g)
    if (why) return { ok: false, reason: `a write grant ${why}` }
  }

  const ws = real(input.workingDirectory)
  const readableRoots = dedupe([
    ...session.dirs,
    ...session.readDirs,
    ...grantsWrite,
    ...grantsRead,
    ...paths.appPaths.map(real)
  ])
  const readableFiles = [real(paths.cliToken)]
  const cliSocket = real(paths.cliSocket)
  // 家目录里的可读根，它们的上级目录要能 stat（node 的 realpath、shell 的 getcwd 逐级走）；
  // CLI 的 socket 与 token 在 ~/.shuvix 里，同理
  const metadataPaths = dedupe(
    [...readableRoots, ...readableFiles, cliSocket].flatMap((p) => ancestorsWithin(p, home))
  )

  return {
    ok: true,
    spec: {
      sessionId: input.sessionId,
      workingDirectory: ws,
      home,
      sessionDirs: session.dirs,
      sessionReadDirs: session.readDirs,
      readableRoots,
      readableFiles,
      metadataPaths,
      writableRoots: dedupe([...session.dirs, ...grantsWrite]),
      unixSockets: dedupe([cliSocket, MDNS_RESPONDER_SOCKET]),
      unixSocketDirs: dedupe([session.tmpDir, ws]),
      tmpDir: session.tmpDir
    }
  }
}
