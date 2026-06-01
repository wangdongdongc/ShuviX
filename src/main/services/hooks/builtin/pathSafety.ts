/**
 * 内置 hook：路径安全（PreToolUse）
 *
 * 阻止 edit / write 工具写入敏感路径，无论用户 autoApprove 设置如何。
 *
 * 按平台构建黑名单：
 *
 * - POSIX 共通：/etc /usr /bin /sbin /boot /proc /sys /root
 * - macOS：/System /Library /private/etc /private/var
 * - Windows：%SystemRoot% (一般 C:\Windows) / %ProgramFiles% / %ProgramFiles(x86)% / %ProgramData%
 * - 用户凭据（三平台通用）：~/.ssh ~/.aws ~/.gnupg ~/.config/gh ~/.netrc
 * - Windows 额外凭据：~/AppData/{Local,Roaming}/Microsoft/Credentials
 *
 * 实现细节：
 * - 比较前对路径做 path.resolve 规范化，Windows 上额外 toLowerCase 处理大小写不敏感
 * - 用 startsWith(prefix + sep) 而非纯 startsWith，避免 `.ssh` 误匹配 `.sshfoo`
 */

import { homedir, platform } from 'os'
import { resolve, sep } from 'path'
import type { HookHandler, HookInput, HookOutput } from '../types'

interface PathArgs {
  path?: unknown
}

const HOME = homedir()
const IS_WIN = platform() === 'win32'

/** 归一化：resolve + Windows 下 lowercase */
function normalize(p: string): string {
  const r = resolve(p)
  return IS_WIN ? r.toLowerCase() : r
}

function buildBlockedPrefixes(): string[] {
  const list: string[] = []

  if (IS_WIN) {
    list.push(
      process.env.SystemRoot ?? 'C:\\Windows',
      process.env.ProgramFiles ?? 'C:\\Program Files',
      process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
      process.env.ProgramData ?? 'C:\\ProgramData'
    )
    list.push(
      resolve(HOME, '.ssh'),
      resolve(HOME, '.aws'),
      resolve(HOME, '.gnupg'),
      resolve(HOME, '.config', 'gh'),
      resolve(HOME, 'AppData', 'Local', 'Microsoft', 'Credentials'),
      resolve(HOME, 'AppData', 'Roaming', 'Microsoft', 'Credentials')
    )
  } else {
    // POSIX 共通（Linux + macOS）
    list.push('/etc', '/usr', '/bin', '/sbin', '/boot', '/proc', '/sys', '/root')
    // macOS 额外
    if (platform() === 'darwin') {
      list.push('/System', '/Library', '/private/etc', '/private/var')
    }
    // 用户凭据
    list.push(
      resolve(HOME, '.ssh'),
      resolve(HOME, '.aws'),
      resolve(HOME, '.gnupg'),
      resolve(HOME, '.config', 'gh')
    )
  }

  return list.map(normalize)
}

function buildBlockedFiles(): string[] {
  const list = [resolve(HOME, '.netrc')]
  return list.map(normalize)
}

const BLOCKED_PREFIXES = buildBlockedPrefixes()
const BLOCKED_FILES = buildBlockedFiles()

export function isBlockedPath(absolutePath: string): boolean {
  const resolved = normalize(absolutePath)
  if (BLOCKED_FILES.includes(resolved)) return true
  for (const prefix of BLOCKED_PREFIXES) {
    if (resolved === prefix || resolved.startsWith(prefix + sep)) return true
  }
  return false
}

export const pathSafetyHandler: HookHandler = (input: HookInput): HookOutput | void => {
  const args = input.tool_input as PathArgs | undefined
  const p = args?.path
  if (typeof p !== 'string' || !p) return

  if (isBlockedPath(p)) {
    return {
      hookSpecificOutput: {
        permissionDecision: 'deny',
        reason: `path-safety: refused write to protected path ${p}`
      }
    }
  }
}
