/**
 * Shell Integration — 为各种 shell 注入 OSC 633 生命周期 hooks
 *
 * 支持的 shell：zsh, bash, fish, PowerShell
 * 注入方式：
 *   - zsh:  ZDOTDIR 重定向，在 .zshenv/.zshrc 中注入
 *   - bash: --init-file 指向自定义初始化脚本
 *   - fish: --init-command source 集成脚本
 *   - pwsh: -noexit -command 注入 prompt 覆写
 *
 * OSC 633 序列：
 *   633;A — prompt 开始
 *   633;C — 命令执行开始（preexec）
 *   633;D;{exitCode} — 命令结束（precmd）
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'

const SCRIPTS_DIR = join(tmpdir(), 'shuvix-shell-integration')

let initialized = false
function ensureScriptsDir(): void {
  if (initialized) return
  initialized = true
  if (!existsSync(SCRIPTS_DIR)) mkdirSync(SCRIPTS_DIR, { recursive: true })
  writeZshScripts()
  writeBashScript()
  writeFishScript()
  writePwshScript()
}

// ─── Zsh ─────────────────────────────────────────────────

function writeZshScripts(): void {
  const dir = join(SCRIPTS_DIR, 'zsh')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  // .zshenv — 保存用户 ZDOTDIR，设置 PROMPT_EOL_MARK，source 用户 .zshenv
  // 注意：不 unset ZDOTDIR，让 zsh 继续从我们的目录加载 .zshrc
  writeFileSync(
    join(dir, '.zshenv'),
    `SHUVIX_ZDOTDIR="$ZDOTDIR"
export USER_ZDOTDIR="\${USER_ZDOTDIR:-$HOME}"
PROMPT_EOL_MARK=''
if [ -f "\${USER_ZDOTDIR}/.zshenv" ]; then
  ZDOTDIR="$USER_ZDOTDIR"
  source "\${USER_ZDOTDIR}/.zshenv"
  ZDOTDIR="$SHUVIX_ZDOTDIR"
fi
`
  )

  // .zprofile — 透传用户 .zprofile
  writeFileSync(
    join(dir, '.zprofile'),
    `[ -f "\${USER_ZDOTDIR}/.zprofile" ] && source "\${USER_ZDOTDIR}/.zprofile"
`
  )

  // .zshrc — source 用户 .zshrc，然后注入 shell integration hooks
  writeFileSync(
    join(dir, '.zshrc'),
    `[ -f "\${USER_ZDOTDIR}/.zshrc" ] && source "\${USER_ZDOTDIR}/.zshrc"

# ShuviX shell integration — emit OSC 633 sequences
__shuvix_precmd() {
  builtin local __status="$?"
  builtin printf '\\e]633;D;%s\\a' "$__status"
  builtin printf '\\e]633;A\\a'
}
__shuvix_preexec() {
  builtin printf '\\e]633;C\\a'
}
autoload -Uz add-zsh-hook
add-zsh-hook precmd __shuvix_precmd
add-zsh-hook preexec __shuvix_preexec
`
  )

  // .zlogin — 透传用户 .zlogin
  writeFileSync(
    join(dir, '.zlogin'),
    `[ -f "\${USER_ZDOTDIR}/.zlogin" ] && source "\${USER_ZDOTDIR}/.zlogin"
`
  )
}

// ─── Bash ────────────────────────────────────────────────

function writeBashScript(): void {
  writeFileSync(
    join(SCRIPTS_DIR, 'bash-integration.sh'),
    `# ShuviX shell integration for bash
# Source user's bashrc first
if [ -f ~/.bashrc ]; then
  . ~/.bashrc
fi

__shuvix_in_cmd=0
__shuvix_precmd() {
  local __status="$?"
  if [ "$__shuvix_in_cmd" = "1" ]; then
    __shuvix_in_cmd=0
    builtin printf '\\e]633;D;%s\\a' "$__status"
  fi
  builtin printf '\\e]633;A\\a'
}
__shuvix_preexec() {
  if [ "$__shuvix_in_cmd" = "0" ]; then
    __shuvix_in_cmd=1
    builtin printf '\\e]633;C\\a'
  fi
}
trap '__shuvix_preexec' DEBUG
PROMPT_COMMAND=__shuvix_precmd
`
  )
}

// ─── Fish ────────────────────────────────────────────────

function writeFishScript(): void {
  writeFileSync(
    join(SCRIPTS_DIR, 'fish-integration.fish'),
    `# ShuviX shell integration for fish
function __shuvix_prompt --on-event fish_prompt
  builtin printf '\\e]633;A\\a'
end
function __shuvix_preexec --on-event fish_preexec
  builtin printf '\\e]633;C\\a'
end
function __shuvix_postexec --on-event fish_postexec
  builtin printf '\\e]633;D;%s\\a' $status
end
`
  )
}

// ─── PowerShell ──────────────────────────────────────────

function writePwshScript(): void {
  writeFileSync(
    join(SCRIPTS_DIR, 'pwsh-integration.ps1'),
    `# ShuviX shell integration for PowerShell
$Global:__ShuvixInExecution = $false
$Global:__ShuvixOriginalPrompt = $function:prompt

function Global:prompt {
  $exitCode = [int]!$?
  if ($Global:__ShuvixInExecution) {
    $Global:__ShuvixInExecution = $false
    [Console]::Write("$([char]0x1b)]633;D;$exitCode\`a")
  }
  [Console]::Write("$([char]0x1b)]633;A\`a")
  $result = & $Global:__ShuvixOriginalPrompt
  [Console]::Write("$([char]0x1b)]633;B\`a")
  return $result
}

if (Get-Module PSReadLine) {
  $Global:__ShuvixOriginalReadLine = $function:PSConsoleHostReadLine
  function Global:PSConsoleHostReadLine {
    $line = & $Global:__ShuvixOriginalReadLine
    $Global:__ShuvixInExecution = $true
    [Console]::Write("$([char]0x1b)]633;C\`a")
    return $line
  }
}
`
  )
}

// ─── Shell 类型检测 ──────────────────────────────────────

export type ShellType = 'zsh' | 'bash' | 'fish' | 'pwsh' | 'unknown'

export function detectShellType(shellPath: string): ShellType {
  const name =
    shellPath
      .split('/')
      .pop()
      ?.replace(/\.exe$/i, '') || ''
  if (name === 'zsh') return 'zsh'
  if (name === 'bash' || name === 'sh') return 'bash'
  if (name === 'fish') return 'fish'
  if (name === 'pwsh' || name === 'powershell') return 'pwsh'
  return 'unknown'
}

// ─── 注入参数构建 ────────────────────────────────────────

export interface ShellIntegrationConfig {
  /** 额外的 shell 启动参数 */
  args: string[]
  /** 需要注入的环境变量 */
  env: Record<string, string>
}

/**
 * 根据 shell 类型返回注入配置
 */
export function getShellIntegration(shellPath: string): ShellIntegrationConfig {
  ensureScriptsDir()
  const type = detectShellType(shellPath)

  switch (type) {
    case 'zsh': {
      const zshDir = join(SCRIPTS_DIR, 'zsh')
      return {
        args: [],
        env: {
          ZDOTDIR: zshDir,
          USER_ZDOTDIR: process.env.ZDOTDIR || homedir()
        }
      }
    }
    case 'bash':
      return {
        args: ['--init-file', join(SCRIPTS_DIR, 'bash-integration.sh')],
        env: {}
      }
    case 'fish':
      return {
        args: ['--init-command', `source ${join(SCRIPTS_DIR, 'fish-integration.fish')}`],
        env: {}
      }
    case 'pwsh':
      return {
        args: ['-noexit', '-command', `. "${join(SCRIPTS_DIR, 'pwsh-integration.ps1')}"`],
        env: {}
      }
    default:
      return { args: [], env: {} }
  }
}
