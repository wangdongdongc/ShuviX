/**
 * 内置 hook：路径安全（PreToolUse on edit|write）—— 工厂式，注入路径环境。
 *
 * 阻止 edit / write 工具写入敏感路径，无论用户 autoApprove 设置如何。
 * 黑名单与路径语义（`homedir`/`platform`/`resolve`/`sep`）由宿主注入：
 * - 桌面：注入 Node `os`/`path`（真实文件系统，见下方默认黑名单）
 * - 扩展：OPFS/FSA 虚拟沙箱无 `/etc` 等真实路径，首版不注册本 hook
 *
 * 按平台构建黑名单：
 * - POSIX 共通：/etc /usr /bin /sbin /boot /proc /sys /root
 * - macOS：/System /Library /private/etc /private/var
 * - Windows：%SystemRoot% / %ProgramFiles% / %ProgramFiles(x86)% / %ProgramData%
 * - 用户凭据（三平台通用）：~/.ssh ~/.aws ~/.gnupg ~/.config/gh ~/.netrc
 * - Windows 额外凭据：~/AppData/{Local,Roaming}/Microsoft/Credentials
 */
import type { HookHandler, HookInput, HookOutput } from '@shuvix/chat-protocol/types/hook'

/** 宿主注入的路径环境（桌面用 Node os/path 实现） */
export interface PathSafetyEnv {
  /** 用户主目录绝对路径 */
  homedir: string
  /** 平台标识（'win32' / 'darwin' / 'linux' …） */
  platform: string
  /** 路径拼接 + 规范化（等价 Node path.resolve） */
  resolve: (...parts: string[]) => string
  /** 路径分隔符（Node path.sep） */
  sep: string
  /** 环境变量（Windows 下读取 SystemRoot / ProgramFiles 等）；缺省为空 */
  env?: Record<string, string | undefined>
}

interface PathArgs {
  path?: unknown
}

/** 构造 path-safety handler。 */
export function makePathSafety(pathEnv: PathSafetyEnv): HookHandler {
  const { homedir: HOME, platform, resolve, sep, env = {} } = pathEnv
  const IS_WIN = platform === 'win32'

  /** 归一化：resolve + Windows 下 lowercase */
  const normalize = (p: string): string => {
    const r = resolve(p)
    return IS_WIN ? r.toLowerCase() : r
  }

  const blockedPrefixes: string[] = (() => {
    const list: string[] = []
    if (IS_WIN) {
      list.push(
        env.SystemRoot ?? 'C:\\Windows',
        env.ProgramFiles ?? 'C:\\Program Files',
        env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
        env.ProgramData ?? 'C:\\ProgramData'
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
      if (platform === 'darwin') {
        list.push('/System', '/Library', '/private/etc', '/private/var')
      }
      list.push(
        resolve(HOME, '.ssh'),
        resolve(HOME, '.aws'),
        resolve(HOME, '.gnupg'),
        resolve(HOME, '.config', 'gh')
      )
    }
    return list.map(normalize)
  })()

  const blockedFiles: string[] = [resolve(HOME, '.netrc')].map(normalize)

  const isBlockedPath = (absolutePath: string): boolean => {
    const resolved = normalize(absolutePath)
    if (blockedFiles.includes(resolved)) return true
    for (const prefix of blockedPrefixes) {
      if (resolved === prefix || resolved.startsWith(prefix + sep)) return true
    }
    return false
  }

  const handler: HookHandler = (input: HookInput): HookOutput | void => {
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
  return handler
}
