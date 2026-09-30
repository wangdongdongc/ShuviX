/**
 * 命令失败后，判断「是不是沙箱拦的」并写一段给模型看的说明。纯函数，确定性。
 *
 * 不读系统日志（`log stream` 要常驻进程、投递是异步的、有的账户跑不了）：沙箱拒绝在程序那边
 * 表现为 EPERM（"Operation not permitted"），而大多数工具会把出错的路径一起打印出来 ——
 * 把这些路径拿去对照规格，对得上的才说是沙箱拦的。对不上的（比如 TCC 拒绝，同样是 EPERM）
 * 什么都不说：猜错比不说更糟，模型会去申请它根本不需要的完全访问。
 *
 * 说明写给模型，用英文（与工具描述、其他工具结果一致）。
 */
import { isAbsolute, resolve } from 'path'
import { isWithin } from './spec'
import { GIT_ENTRY_PATTERN, GIT_PATTERNS } from './tables'
import type { SandboxSpec } from './types'

/** 最多列几个被拦的路径 —— 多了是噪音，模型看前几个就够判断 */
const MAX_LISTED = 5

const EPERM_LINE = /operation not permitted|\bEPERM\b|permission denied|read-only file system/i

const SETUID = 'running sudo or another setuid program (ps, top, su, login …)'

/**
 * 系统自带程序的目录：这里的 EPERM 不会是「写入被沙箱拒」（用户本来就写不了，SIP 管着），而是
 * 沙箱里执行 setuid 程序被拒 —— `/bin/bash: /bin/ps: Operation not permitted`，与重定向写失败
 * 同一个格式，只能按路径认。
 */
const SYSTEM_BIN = /^\/(s?bin|usr\/(s?bin|libexec)|System)\//

/** 知道沙箱会拦、且输出里通常没有路径的几类事 */
const SIGNATURES: { test: RegExp; what: string }[] = [
  {
    // LaunchServices 被拒：open 报 LSOpen… / 找不到应用；osascript 报 -600 / -10827 / -1743
    test: /-10827|LSOpenURLsWithRole|kLSServerCommunicationErr|Unable to find application named|execution error: .*\((-600|-10827|-1743)\)/,
    what: 'opening apps or sending AppleScript / Apple Events (open, osascript)'
  },
  {
    test: /docker\.sock|Cannot connect to the Docker daemon/i,
    what: 'talking to the Docker daemon'
  },
  {
    // 跨沙箱实例发信号被拒（沙箱只放行给同一条命令里的进程发信号）—— 停后台任务要走宿主
    test: /\bkill: .*(operation not permitted|not permitted)/i,
    what: 'signalling a process that another command started — stop a background task with `shuvix task stop <pid>`'
  },
  {
    test: /sandbox_apply: Operation not permitted/,
    what: 'a tool that tries to sandbox itself (swift build, xcodebuild, Playwright / Electron test runners)'
  },
  {
    test: /\bsudo\b.*(not permitted|must be setuid|effective uid)/i,
    what: SETUID
  }
]

/** 输出里的路径常是未解析的写法；按 macOS 的系统级符号链接对齐到规格用的真实路径 */
function normalize(raw: string): string {
  const p = raw.replace(/\/+$/, '') || '/'
  for (const [from, to] of [
    ['/tmp', '/private/tmp'],
    ['/var', '/private/var'],
    ['/etc', '/private/etc']
  ] as const) {
    if (p === from || p.startsWith(from + '/')) return to + p.slice(from.length)
  }
  return p
}

/** 读类工具的报错前缀（`ls: /Volumes/x: Operation not permitted`）—— 这类行里的 EPERM 不会是写入被拒 */
const READ_TOOL_PREFIX =
  /^\s*(ls|cat|head|tail|less|more|grep|egrep|rg|find|stat|du|wc|file|xattr|mdls|diff|open):/i

/**
 * 写入的迹象：动词、写类工具前缀、shell 重定向报错（`bash: /x: Operation not permitted`）、
 * node 的 `EPERM: operation not permitted, open|mkdir|rename …`。只有带着它，「落在可写根外」
 * 才算沙箱拦的 —— 否则一次 TCC 拒绝的读（/Volumes、网络卷）会被说成沙箱问题，模型还会去
 * 申请它根本不需要的完全访问。
 */
const WRITE_CUE =
  /\b(touch|mkdir|cp|mv|rm|ln|tee|install|write|writing|create|creating|lock|rename|unlink|save|chmod)\b|read-only file system|^\s*(\/bin\/)?(ba|z|da)?sh\b|EPERM: operation not permitted, (open|mkdir|rename|unlink|symlink|copyfile|rmdir|link)/i

/** `tool: <这一段>: Operation not permitted` —— 两个冒号之间的整段（可带空格） */
const COLON_FORM =
  /(?:^|:\s)([^:\n]+?):\s*(?:operation not permitted|permission denied|read-only file system)/gi

/**
 * 从一行里抽出路径：引号里的、`tool: <路径>: Operation not permitted` 形式的（可带空格——
 * userData 就在 `Application Support` 下）、裸露的绝对路径。相对路径（git 的
 * `could not lock config file .git/config`）按命令的工作目录解析。
 */
function pathsIn(line: string, cwd: string): string[] {
  const found = new Set<string>()
  // 行首的 `程序名:` 不是被拒的对象（`/bin/bash: /x: Operation not permitted` 里被拒的是 /x）——
  // 但只在它后面还有一段 `…: <EPERM 短语>` 时才算程序名；`/x/.git/hooks/y: Operation not permitted`
  // 这种只有路径的行，行首那段就是被拒的路径
  // 判据：`<token>: ` 之后、拒绝短语之前还有别的内容（`line 1: kill: (-N) - …` 也算）
  const lead =
    /^\s*([^\s:]+):\s+(?!operation not permitted|permission denied|read-only file system)\S[^\n]*(?:operation not permitted|permission denied|read-only file system)/i.exec(
      line
    )?.[1]
  const add = (raw: string): void => {
    const p = raw.trim()
    if (!p || !p.includes('/') || p === lead) return
    found.add(isAbsolute(p) ? p : resolve(cwd, p))
  }
  for (const m of line.matchAll(/['"`‘“]([^'"`’”\n]+)['"`’”]/g)) add(m[1])
  for (const m of line.matchAll(COLON_FORM)) {
    const segment = m[1]
    // 段里若有绝对路径，从它的 `/` 起整段都是路径（保留空格）；否则取最后一个带 `/` 的词
    const abs = segment.search(/(^|\s)\//)
    if (abs >= 0) add(segment.slice(segment.indexOf('/', abs)))
    else
      add(
        segment
          .split(/\s+/)
          .filter((w) => w.includes('/'))
          .pop() ?? ''
      )
  }
  for (const m of line.matchAll(/(?:^|[\s(=])(\/[^\s'"`:,()]+)/g)) add(m[1])
  // 裸路径在空格处被截断的那一截（`/Users/u/Library/Application`）：已有更完整的同前缀路径就丢掉
  const all = [...found]
  return all.filter((p) => !all.some((q) => q !== p && q.startsWith(p + ' ')))
}

function matchesAny(path: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => new RegExp(p).test(path))
}

/**
 * 这条路径的写入会不会被规格拦下（与 profile 的四层同义）：
 * 'outside' = 不在任何可写根里；'protected' = 在根里、但落在受保护的位置；null = 允许写。
 */
export function writeBlockReason(spec: SandboxSpec, path: string): 'outside' | 'protected' | null {
  const p = normalize(path)
  const inRoot = spec.writableRoots.some((r) => isWithin(p, r))
  if (!inRoot) return 'outside'
  const deniedWhole =
    spec.writeDenied.some((d) => isWithin(p, d)) && !spec.writeAllowBack.some((r) => isWithin(p, r))
  if (deniedWhole) return 'protected'
  if (spec.writeDeniedFinal.some((d) => isWithin(p, d))) return 'protected'
  if (
    matchesAny(
      p,
      spec.writeDeniedPatterns.map((x) => x.js)
    )
  )
    return 'protected'
  const inGitRoot = spec.gitRoots.some((r) => isWithin(p, r))
  if (inGitRoot && matchesAny(p, [...GIT_PATTERNS.map((x) => x.js), GIT_ENTRY_PATTERN.js])) {
    return 'protected'
  }
  return null
}

export function isWriteBlocked(spec: SandboxSpec, path: string): boolean {
  return writeBlockReason(spec, path) !== null
}

/** 这条路径的读取会不会被规格拦下（只有凭据位置） */
export function isReadBlocked(spec: SandboxSpec, path: string): boolean {
  const p = normalize(path)
  return spec.readDenied.some((d) => isWithin(p, d))
}

export interface ExplainInput {
  spec: SandboxSpec
  outputTail: string
  exitCode: number | null
  /** 本工具实例带不带 `dangerouslyDisableSandbox` 参数 —— 不带就不能教模型用它 */
  offerEscalation: boolean
}

export function explainSandboxDenial(input: ExplainInput): string | null {
  const { spec, outputTail, exitCode } = input
  // 成功的命令不追究（试探性的访问失败很常见，工具自己兜住了）；被杀的也不猜
  if (exitCode === 0 || exitCode === null) return null

  const blocked: string[] = []
  const seen = new Set<string>()
  const reasons = new Set<string>()
  for (const line of outputTail.split('\n')) {
    for (const sig of SIGNATURES) if (sig.test.test(line)) reasons.add(sig.what)
    if (!EPERM_LINE.test(line)) continue
    const readTool = READ_TOOL_PREFIX.test(line)
    const writeCue = !readTool && WRITE_CUE.test(line)
    for (const path of pathsIn(line, spec.workingDirectory)) {
      if (blocked.length >= MAX_LISTED) break
      const p = normalize(path)
      if (seen.has(p)) continue
      seen.add(p)
      if (isReadBlocked(spec, p)) {
        blocked.push(`cannot read: ${p}`)
        continue
      }
      if (readTool) continue
      // 读类工具之外、系统程序目录里的 EPERM：沙箱里执行 setuid 程序被拒（`find /System` 这类读
      // 被拒已在上一行放过去，不会被说成 setuid）
      if (SYSTEM_BIN.test(p)) {
        reasons.add(SETUID)
        continue
      }
      const why = writeBlockReason(spec, p)
      // 受保护的位置很具体，拦下它的几乎只可能是沙箱；「在根外」则要行里有写入的迹象才算
      if (why === 'protected' || (why === 'outside' && writeCue)) {
        blocked.push(`cannot write: ${p}`)
      }
    }
  }
  if (blocked.length === 0 && reasons.size === 0) return null

  const out = [
    '[sandbox] This command runs confined, and the failure looks like the sandbox refusing it:'
  ]
  for (const b of blocked) out.push(`  - ${b}`)
  for (const what of reasons) out.push(`  - ${what}`)
  out.push(
    'Confined commands may change files only in the working directory, $TMPDIR, /tmp and package-manager caches; ' +
      'they cannot read or write credentials (~/.ssh, ~/.aws …), ' +
      "and cannot write git hooks, git config or ShuviX's own files."
  )
  out.push(
    input.offerEscalation
      ? 'If you can, do the work inside the working directory instead. If the command cannot work confined, rerun it with `dangerouslyDisableSandbox: true` — the user may be asked to approve.'
      : 'If you can, do the work inside the working directory instead; otherwise tell the user what the command needs.'
  )
  return out.join('\n')
}
