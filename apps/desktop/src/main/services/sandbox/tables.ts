/**
 * 沙箱的清单 —— **唯一定义处**。profile（命令能碰什么）与策略变量（文件工具问不问）都从这里取，
 * 这两面必须说同一句话，否则模型会学会走不问的那条路。
 *
 * 路径分两类写法：相对家目录的（`homeRelative`）与绝对的。凡要进正则的，只放固定文本 ——
 * 用户路径永远以 SBPL `(param …)` 传入，不进正则（Claude Code 曾把目录名里的 `**` 编进正则，
 * 写穿到相邻项目）。
 */
import type { SandboxPattern } from './types'

/**
 * 工具缓存 —— 沙箱内可写，否则 npm install / pip / cargo 一装就失败。
 *
 * 已知代价（遗留风险，见 Plan）：这些目录里有东西会被用户**自己**不受限的工具以后执行
 * （npx 缓存、Maven/Gradle 插件、cargo 的 build.rs、corepack），沙箱里写进去的内容可以
 * 在沙箱外被跑起来。清单刻意只收包管理器的下载缓存，不收工具链安装目录（~/.rustup、
 * ~/.nvm …）。
 */
export const CACHE_DIRS_HOME_RELATIVE: readonly string[] = [
  '.npm',
  '.cache',
  '.yarn/berry/cache',
  '.pnpm-store',
  '.bun/install/cache',
  '.cargo/registry',
  '.cargo/git',
  'go/pkg/mod',
  '.gradle/caches',
  '.m2/repository',
  'Library/pnpm',
  'Library/Caches/pip',
  'Library/Caches/pnpm',
  'Library/Caches/Yarn',
  'Library/Caches/go-build',
  'Library/Caches/node-gyp',
  'Library/Caches/typescript',
  'Library/Caches/deno',
  'Library/Developer/Xcode/DerivedData'
]

/**
 * 凭据目录 —— 与内置策略 protect-credentials 的 `credentialDirs` let **逐项相同**
 * （守卫测试钉住）。沙箱里读写都拒，且放在最后一层：任何根、任何授权都放不回来。
 */
export const CREDENTIAL_DIRS_HOME_RELATIVE: readonly string[] = [
  '.ssh',
  '.aws',
  '.gnupg',
  '.config/gh',
  '.netrc',
  'AppData/Local/Microsoft/Credentials',
  'AppData/Roaming/Microsoft/Credentials'
]

/**
 * 沙箱外会被自动执行 / 读作配置的家目录位置 —— 拒写（最后一层）。
 *
 * 家目录本身从来不是可写根（根等于或覆盖家目录的会话直接不套沙箱），所以这份清单只在
 * 某个授权根恰好覆盖到它们时才起作用；它是纵深防御，不是主防线。
 */
export const EXECUTED_LATER_HOME_RELATIVE: readonly string[] = [
  '.zshrc',
  '.zshenv',
  '.zprofile',
  '.zlogin',
  '.zlogout',
  '.bashrc',
  '.bash_profile',
  '.bash_login',
  '.bash_logout',
  '.profile',
  '.config/fish',
  '.gitconfig',
  '.config/git',
  'Library/LaunchAgents'
]

/**
 * 工作区 / 授权根**顶层**的别家工具配置 —— 它们会被其他程序在沙箱外自动读取执行
 * （IDE 任务、其他 agent 的 hooks、direnv）。只拦根的顶层：monorepo 深处的 `.vscode`
 * 不会被自动执行，拦了只会误伤。
 */
export const ROOT_PROTECTED_NAMES: readonly string[] = [
  '.vscode',
  '.idea',
  '.claude',
  '.cursor',
  '.codex',
  '.zed',
  '.mcp.json',
  '.envrc'
]

/**
 * 个人资料目录 —— 沙箱里拒读**内容**（`file-read-data`/`xattr`），元数据照常：
 * 工作区常在 ~/Documents 下，node / python 起步时会 lstat 每一级祖先。read 工具读它们要问。
 */
export const PERSONAL_DIRS_HOME_RELATIVE: readonly string[] = [
  'Documents',
  'Desktop',
  'Downloads',
  'Pictures',
  'Movies',
  'Music',
  'Library/Mobile Documents',
  'Library/Mail',
  'Library/Messages',
  'Library/Safari',
  'Library/Cookies',
  'Library/Keychains',
  'Library/Containers',
  'Library/Group Containers',
  'Library/Calendars',
  'Library/Accounts',
  'Library/Application Support/AddressBook',
  'Library/Application Support/Google/Chrome',
  'Library/Application Support/Firefox',
  'Library/Application Support/Arc',
  'Library/Application Support/BraveSoftware',
  'Library/Application Support/Microsoft Edge'
]

/**
 * `~/.shuvix` 里可以当作可写根的内容目录（用户产出的东西）。工作区落在 `~/.shuvix` 的
 * 其他地方（agents / policies / hooks / bots / skills 的 notebook 会话）⇒ 该会话不套沙箱：
 * 那些文件会被主进程读作配置，命令改它们等于改 agent 自己的规矩。
 */
export const SHUVIX_CONTENT_DIRS: readonly string[] = [
  'knowledge',
  'knowledge-shuvix',
  'widgets',
  'artifacts'
]

/** 每个字母写成 `[Xx]`：APFS 默认不区分大小写，而 SBPL 与 JS 正则都区分 */
function ci(word: string): string {
  return word.replace(/[a-z]/gi, (ch) => `[${ch.toUpperCase()}${ch.toLowerCase()}]`)
}

const GIT = `/\\.${ci('git')}`
/** git 自己会执行 / 当作配置加载的元数据：hooks、config、config.worktree、commondir（指向另一处 config） */
const GIT_EXECUTED = `(${ci('hooks')}(/|$)|${ci('config')}$|${ci('config')}\\.${ci('worktree')}$|${ci('commondir')}$)`

/**
 * `.git` 元数据保护（只作用于工作区 + 授权根，见 SandboxSpec.gitRoots）。
 * 同一段文本就是两种方言共同的正则：只用 `[]`、`()`、`|`、`$`、`.*`、`\\.`。
 */
export const GIT_PATTERNS: readonly SandboxPattern[] = [
  // .git/hooks/**、.git/config、.git/config.worktree、.git/commondir
  { sbpl: `${GIT}/${GIT_EXECUTED}`, js: `${GIT}/${GIT_EXECUTED}` },
  // 子模块与 worktree 自己的那一份：.git/modules/<m>/…、.git/worktrees/<w>/…
  {
    sbpl: `${GIT}/(${ci('modules')}|${ci('worktrees')})/.*/${GIT_EXECUTED}`,
    js: `${GIT}/(${ci('modules')}|${ci('worktrees')})/.*/${GIT_EXECUTED}`
  }
]

/**
 * `.git` 这一项本身的创建 / 删除 / 改名（防「在别处写好含 fsmonitor 的 config 再改名成 .git」）。
 * 代价：沙箱里 `git init` / `git clone` 到工作区会失败 —— 它们本来也要写 hooks 与 config。
 */
export const GIT_ENTRY_PATTERN: SandboxPattern = { sbpl: `${GIT}$`, js: `${GIT}$` }

/** launchd 在 /private/tmp 下给 ssh-agent 等开的 socket 目录 */
export const LAUNCHD_TMP_PATTERN: SandboxPattern = {
  sbpl: '^/private/tmp/com\\.apple\\.launchd\\.',
  js: '^/private/tmp/com\\.apple\\.launchd\\.'
}

/** macOS 的 DNS 走这个 unix socket（不放行它，出网就解析不了域名） */
export const MDNS_RESPONDER_SOCKET = '/private/var/run/mDNSResponder'
