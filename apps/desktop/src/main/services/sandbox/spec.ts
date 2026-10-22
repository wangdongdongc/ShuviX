/**
 * 会话 → 会话自己的目录 / 会话权限表 → 沙箱规格。纯函数：路径解析由调用方注入（`real`），
 * 这样单测不碰文件系统，也不依赖 electron。
 *
 * **一份清单、两个面**：会话权限表（services/acl）既是沙箱里命令能读写的范围，
 * 也是文件工具不必询问的范围（外部目录访问策略读 `vars.aclRead` / `vars.aclWrite`）。两边各算一份就会漂移，
 * 模型会学会走不问的那条路。会话自己的那几个目录（{@link sessionOwnDirs}）是权限表派生行的来源。
 *
 * 这里同时回答「这个会话能不能套沙箱」。套不了就返回原因，调用方退回「命令逐条询问」——
 * 永远不会变成「不套沙箱又不问」。
 */
import { createHash } from 'crypto'
import { basename, dirname, join, sep } from 'path'
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
 * 这个会话可以当自己的那个临时工作区：工作目录**正是**某条会话的临时工作区（`temp_workspace/<id>` 本身 ——
 * 会话 fork 共用源会话的、子会话共用父会话的，`settings.workingDirectory` 只有主进程写）就是那一个，否则是本会话自己的
 * `temp_workspace/<sid>`。只认文件夹本身、不认它里面的子目录，与删除时认主人的口径（`tempWorkspaceOwnerOf`）
 * 一致。临时工作区里只有会话自己的文件，没有数据库、配置或转写 —— 放行它不会让命令出沙箱。
 */
function ownTempWorkspace(userData: string, sessionId: string, ws: string): string {
  const base = join(userData, 'temp_workspace')
  if (dirname(ws) === base && isSafeSessionId(basename(ws))) return ws
  return join(base, sessionId)
}

/**
 * 一个可写根（工作目录或写授权）为什么不适合放进沙箱（适合时返回 null）：
 *  - 是 `/` 或覆盖家目录 —— 放行它等于放行整个家目录；
 *  - 落在 ShuviX 自己的配置里（agents / policies / hooks / bots / skills 的 notebook）——
 *    主进程把那里的文件读作规矩；
 *  - 落在应用数据里（本会话可用的那个临时工作区除外，见 ownTempWorkspace）—— 数据库、其他会话的转写都在那里；
 *  - **包含** ShuviX 的配置或应用数据（如 `~/Library`）—— 数据库里有沙箱开关与「允许并记住」，
 *    命令改得到它们就等于出得了沙箱。
 * 判定只回答一句短语，前缀（「working directory」/「a write grant」）由调用方加。
 */
function rootUnsuitable(
  paths: Pick<SandboxHostPaths, 'home' | 'shuvixHome' | 'userData'>,
  tempWorkspace: string,
  root: string
): string | null {
  if (coversHome(root, paths.home)) return 'covers the home folder'
  if (isWithin(root, paths.shuvixHome)) {
    const content = SHUVIX_CONTENT_DIRS.map((d) => join(paths.shuvixHome, d))
    if (!withinAny(root, content)) return "is ShuviX's own configuration"
  }
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
  const why = rootUnsuitable(paths, ownTempWorkspace(paths.userData, sessionId, ws), ws)
  return why ? `working directory ${why}` : null
}

/**
 * 一个会话自己的目录 —— 会话权限表（services/acl）里 workdir / system 那几行的来源。路径都已 realpath。
 */
export interface SessionOwnDirs {
  /** 工作目录；不适合当会话目录（见 workingDirectoryUnsuitable）时为 null */
  workdir: string | null
  /** 工作目录不适合当会话目录的原因（适合时 null；不适合时沙箱也不套） */
  workspaceUnsuitable: string | null
  /** 本会话临时目录（命令的 TMPDIR） */
  tmp: string
  /** 本会话的 artifacts 目录 */
  artifacts: string
  /** 本会话的工具大结果目录（长输出、后台任务日志） */
  toolResults: string
}

/**
 * 一个会话自己的目录。坏会话 id 返回 null（空 id 会把它放大到所有会话的 artifacts，`..` 会放大到
 * `~/.shuvix`）。
 */
export function sessionOwnDirs(
  paths: SandboxHostPaths,
  input: Pick<SandboxSessionInput, 'sessionId' | 'workingDirectory'>,
  real: (p: string) => string
): SessionOwnDirs | null {
  const { sessionId } = input
  if (!isSafeSessionId(sessionId)) return null
  const resolved = {
    home: real(paths.home),
    shuvixHome: real(paths.shuvixHome),
    userData: real(paths.userData)
  }
  const ws = real(input.workingDirectory)
  const workspaceUnsuitable = workingDirectoryUnsuitable(resolved, sessionId, ws)
  return {
    workdir: workspaceUnsuitable ? null : ws,
    workspaceUnsuitable,
    tmp: join(paths.tmpRoot, sessionTmpName(sessionId)),
    // 与 utils/paths 的 getSessionArtifactsDir 同一个位置（那边用 homedir()，这里用注入的 shuvixHome，
    // 好让单测不碰真家目录）—— 改一边要同步另一边
    artifacts: join(resolved.shuvixHome, 'artifacts', sessionId),
    toolResults: join(real(paths.toolResultsBase), sessionId)
  }
}

/**
 * 会话设置带来的目录（勾选的知识库、技能目录）能不能进会话权限表：能 → 它的 realpath，不能（空串、`/`、
 * 覆盖家目录）→ null。防御：它们都在 ~/.shuvix 或应用包里，正常碰不到
 */
export function acceptableSettingDir(
  paths: Pick<SandboxHostPaths, 'home'>,
  dir: string,
  real: (p: string) => string
): string | null {
  if (dir === '') return null
  const resolved = real(dir)
  return coversHome(resolved, real(paths.home)) ? null : resolved
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
 *
 * 可读可写的范围就是会话权限表（`input.entries`）：派生的行（工作目录、会话自己的目录、知识库、技能）
 * 宿主已按会话设置算好；授予的写（`granted`）还要过一遍「适不适合当可写根」，不适合就整个不套。
 */
export function buildSandboxSpec(
  paths: SandboxHostPaths,
  input: SandboxSessionInput,
  real: (p: string) => string
): SpecResult {
  const own = sessionOwnDirs(paths, input, real)
  if (!own) return { ok: false, reason: 'unsafe session id' }
  if (own.workspaceUnsuitable) return { ok: false, reason: own.workspaceUnsuitable }

  const home = real(paths.home)
  const resolved = { home, shuvixHome: real(paths.shuvixHome), userData: real(paths.userData) }
  const ws = real(input.workingDirectory)
  const tempWorkspace = ownTempWorkspace(resolved.userData, input.sessionId, ws)
  const entries = input.entries
    .filter((e) => e.path !== '')
    .map((e) => ({ ...e, path: real(e.path) }))
  // 授予的写也是可写根，过同一套判定：覆盖家目录、碰到 ShuviX 的配置或应用数据的授权，命令拿着它
  // 就能改规矩 / 关沙箱 —— 与其套一个形同虚设的沙箱，不如逐条询问（文件工具照样凭授权写）
  for (const e of entries) {
    if (!e.granted || e.access !== 'write') continue
    const why = rootUnsuitable(resolved, tempWorkspace, e.path)
    if (why) return { ok: false, reason: `a write grant ${why}` }
  }
  // 派生的行不许覆盖家目录（防御：宿主算它们时已经滤过 —— 覆盖家目录的根等于沙箱没套）
  const usable = entries.filter((e) => e.granted || !coversHome(e.path, home))

  const readableRoots = dedupe([...usable.map((e) => e.path), own.tmp, ...paths.appPaths.map(real)])
  const readableFiles = [real(paths.cliToken)]
  const cliSocket = real(paths.cliSocket)
  // 家目录里的可读根，它们的上级目录要能 stat（node 的 realpath、shell 的 getcwd 逐级走）；
  // CLI 的 socket 与 token 在 ~/.shuvix 里，同理
  const metadataPaths = dedupe(
    [...readableRoots, ...readableFiles, cliSocket].flatMap((p) => ancestorsWithin(p, home))
  )

  // 本会话临时目录恒可写：命令的 TMPDIR 指着它
  const writableRoots = dedupe([
    ...usable.filter((e) => e.access === 'write').map((e) => e.path),
    own.tmp
  ])
  return {
    ok: true,
    spec: {
      sessionId: input.sessionId,
      workingDirectory: ws,
      home,
      readableRoots,
      readableFiles,
      metadataPaths,
      writableRoots,
      unixSockets: dedupe([cliSocket, MDNS_RESPONDER_SOCKET]),
      // 工作目录只在它可写时放 socket（只读的工作目录里已有的 socket 也不让连）
      unixSocketDirs: dedupe([own.tmp, ...(writableRoots.includes(ws) ? [ws] : [])]),
      tmpDir: own.tmp
    }
  }
}
