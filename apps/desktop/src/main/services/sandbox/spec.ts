/**
 * 会话 → 沙箱规格，规格 → 策略变量。纯函数：路径解析由调用方注入（`real`），
 * 这样单测不碰文件系统，也不依赖 electron。
 *
 * 这里同时回答「这个会话能不能套沙箱」。套不了就返回原因，调用方退回「命令逐条询问」——
 * 永远不会变成「不套沙箱又不问」。
 */
import { createHash } from 'crypto'
import { join, sep } from 'path'
import { isSafeSessionId } from '../../utils/paths'
import {
  CACHE_DIRS_HOME_RELATIVE,
  CREDENTIAL_DIRS_HOME_RELATIVE,
  EXECUTED_LATER_HOME_RELATIVE,
  GIT_ENTRY_PATTERN,
  GIT_PATTERNS,
  LAUNCHD_TMP_PATTERN,
  MDNS_RESPONDER_SOCKET,
  PERSONAL_DIRS_HOME_RELATIVE,
  ROOT_PROTECTED_NAMES,
  SHUVIX_CONTENT_DIRS
} from './tables'
import type {
  SandboxHostPaths,
  SandboxSessionInput,
  SandboxSpec,
  SessionSandboxView
} from './types'

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

/**
 * 算出一个会话的沙箱规格。`real` 把路径解析成它真正指向的位置（realpath，不存在的部分按
 * 最近的已存在祖先拼回）—— Seatbelt 按解析后的路径比对，不解析的话 `/tmp/x` 永远对不上。
 */
export function buildSandboxSpec(
  paths: SandboxHostPaths,
  input: SandboxSessionInput,
  real: (p: string) => string
): SpecResult {
  const { sessionId } = input
  if (!isSafeSessionId(sessionId)) return { ok: false, reason: 'unsafe session id' }

  const home = real(paths.home)
  const shuvixHome = real(paths.shuvixHome)
  const userData = real(paths.userData)
  const ws = real(input.workingDirectory)
  const grantsWrite = dedupe(input.grantedWrite.map(real))
  const grantsRead = dedupe(input.grantedRead.map(real))

  // 根等于或覆盖家目录：受保护清单会变成打地鼠（rc、LaunchAgents、各家工具配置……数不完），
  // 不如老老实实逐条询问
  for (const root of [ws, ...grantsWrite]) {
    if (root === '/' || isWithin(home, root)) {
      return {
        ok: false,
        reason: `${root === ws ? 'working directory' : 'a write grant'} covers the home folder`
      }
    }
  }
  // 工作区是 ShuviX 自己的配置（agents / policies / hooks / bots / skills 的 notebook）：
  // 主进程把那里的文件读作规矩，命令不该能改
  if (isWithin(ws, shuvixHome)) {
    const content = SHUVIX_CONTENT_DIRS.map((d) => join(shuvixHome, d))
    if (!withinAny(ws, content)) {
      return { ok: false, reason: "working directory is ShuviX's own configuration" }
    }
  }
  const tempWorkspace = join(userData, 'temp_workspace', sessionId)
  if (isWithin(ws, userData) && !isWithin(ws, tempWorkspace)) {
    return { ok: false, reason: "working directory is inside ShuviX's application data" }
  }
  const credentialDirs = CREDENTIAL_DIRS_HOME_RELATIVE.map((d) => join(home, d))
  if (withinAny(ws, credentialDirs)) {
    return { ok: false, reason: 'working directory is a credential directory' }
  }
  // 根**严格包含**敏感目录（工作区是 ~/Library、授权了 ~/Library/Application Support……）：
  // 放回根会把里面的邮件、钥匙串、ShuviX 自己的数据一起放出来。与其在最后一层补一张越来越长的
  // 例外表，不如老实逐条询问。根**等于**个人资料目录（工作区就是 ~/Documents）不算 —— 那是用户选的项目
  const personalDirs = PERSONAL_DIRS_HOME_RELATIVE.map((d) => join(home, d))
  const sensitive = [...personalDirs, ...credentialDirs, shuvixHome, userData]
  for (const root of [ws, ...grantsWrite]) {
    const inside = sensitive.find((d) => d !== root && isWithin(d, root))
    if (inside) {
      return {
        ok: false,
        reason: `${root === ws ? 'working directory' : 'a write grant'} contains ${inside}`
      }
    }
  }

  const tmpDir = join(paths.tmpRoot, sessionTmpName(sessionId))
  const artifactsDir = join(shuvixHome, 'artifacts', sessionId)
  const caches = CACHE_DIRS_HOME_RELATIVE.map((d) => join(home, d))
  const writableRoots = dedupe([
    ws,
    tmpDir,
    '/private/tmp',
    ...caches,
    artifactsDir,
    ...grantsWrite
  ])
  const writeDenied = [shuvixHome, userData]
  // 放回：落在第 2 层整片拒写里、但本来就归这场对话 / 归用户产出的根 —— 本会话临时工作区、本会话
  // artifacts、~/.shuvix 内容目录（knowledge / widgets …）里的授权根。~/.shuvix 其余位置（policies、
  // agents、hooks、bots、skills）里的写授权**不**放回：文件工具凭授权照写，命令不行 —— 那些文件是
  // 主进程读作规矩的东西，命令改它们等于改 agent 自己的规矩
  const shuvixContent = SHUVIX_CONTENT_DIRS.map((d) => join(shuvixHome, d))
  const writeAllowBack = writableRoots.filter(
    (r) =>
      r === artifactsDir ||
      isWithin(r, tempWorkspace) ||
      (isWithin(r, shuvixHome) && withinAny(r, shuvixContent))
  )
  const gitRoots = dedupe([ws, ...grantsWrite])
  const writeDeniedFinal = dedupe([
    ...credentialDirs,
    ...EXECUTED_LATER_HOME_RELATIVE.map((d) => join(home, d)),
    `/private/tmp/shuvix-ssh-${paths.uid}`,
    `/private/tmp/tmux-${paths.uid}`,
    ...gitRoots.flatMap((root) => ROOT_PROTECTED_NAMES.map((name) => join(root, name)))
  ])

  const toolResultsDir = join(userData, 'tool_results', sessionId)
  const readDenied = [...personalDirs, userData]
  const readAllowBack = dedupe([ws, toolResultsDir, ...grantsRead, ...grantsWrite])
  const readDeniedFinal = dedupe([
    ...credentialDirs,
    join(shuvixHome, '.session-state'),
    join(userData, 'data')
  ])

  return {
    ok: true,
    spec: {
      sessionId,
      workingDirectory: ws,
      writableRoots,
      writeDenied,
      writeAllowBack,
      writeDeniedFinal,
      writeDeniedPatterns: [LAUNCHD_TMP_PATTERN],
      gitRoots,
      readDenied,
      readAllowBack,
      readDeniedFinal,
      unixSockets: dedupe([real(paths.cliSocket), MDNS_RESPONDER_SOCKET]),
      unixSocketDirs: dedupe([tmpDir, ws]),
      tmpDir
    }
  }
}

/**
 * 规格 → 策略变量。与 profile 同源，所以 write/read 工具的免询问范围恰好是命令能碰的范围：
 *   - 写：可写根里、且不在最后一层拒写里的位置免询问；第 2 层整片拒写（~/.shuvix、userData）
 *     只在它落在某个根里面时才需要列出（平常它包着根、根又被放回）
 *   - 读：敏感清单里、且不在放回范围里的位置要问；cli-token 额外列入——沙箱为了让
 *     shuvix CLI 能用而放它可读，但没有理由让 read 工具把它读进模型上下文
 */
/**
 * 写入要照旧询问的路径模式（JS 方言）：git 自己会执行 / 加载的元数据，`.git` 这一项本身，以及规格里
 * 的其余拒写模式。沙箱视图与工作区写入视图（workspaceWriteView）共用这一份 —— 两边的「受保护」
 * 必须是同一组。
 */
export function protectedWritePatterns(spec: SandboxSpec): string[] {
  return [
    ...GIT_PATTERNS.map((p) => p.js),
    GIT_ENTRY_PATTERN.js,
    ...spec.writeDeniedPatterns.map((p) => p.js)
  ]
}

export function toPolicyView(spec: SandboxSpec, cliToken: string): SessionSandboxView {
  // 实际可写的根：落在整片拒写里、又没被放回的根（如 ~/.shuvix/policies 里的写授权）不算
  const effectiveRoots = spec.writableRoots.filter(
    (r) => !spec.writeDenied.some((d) => isWithin(r, d)) || spec.writeAllowBack.includes(r)
  )
  const deniedInsideRoots = spec.writeDenied.filter((d) =>
    effectiveRoots.some((r) => isWithin(d, r) && !spec.writeAllowBack.includes(r))
  )
  return {
    sandboxActive: true,
    sandboxWritableRoots: effectiveRoots,
    sandboxWriteDenied: dedupe([...deniedInsideRoots, ...spec.writeDeniedFinal]),
    sandboxProtectedPatterns: protectedWritePatterns(spec),
    sandboxReadDenied: dedupe([...spec.readDenied, ...spec.readDeniedFinal, cliToken]),
    sandboxReadAllowed: [...spec.readAllowBack]
  }
}
