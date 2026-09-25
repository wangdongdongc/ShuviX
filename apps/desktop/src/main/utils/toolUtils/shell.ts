/**
 * Shell 工具函数（精简版）
 * 从 pi-coding-agent 移植，去掉 SettingsManager 等外部依赖
 *
 * 命令工具按平台分成两个：`bash`（macOS / Linux）与 `powershell`（Windows），各自只在自己的
 * 平台上解析给 agent（见 toolRegistry 的 `platforms`）。Windows 上不再经 Git Bash 跑 bash：
 * 模型在 Windows 上天然会写 PowerShell，夹在 bash 里的 `powershell -Command "…$_…"` 会先被
 * bash 把 `$` 展开掉；MSYS 运行时还会自行重解析命令行（引号内 `\\` 减半、约 8K 截断），
 * 并把 `/PID` 这类参数当 POSIX 路径改写。
 */

import { existsSync } from 'node:fs'
import { spawnSync, spawn } from 'child_process'
import { stripVTControlCharacters } from 'node:util'
import type { ToolPlatform } from '@shuvix/chat-protocol/chatApi'

/** 命令工具背后的 shell —— 与工具名一一对应 */
export type ShellKind = 'bash' | 'powershell'

/** 两个命令工具各自存在的平台 —— 注册项的 `platforms` 与 platformShellKind 读的是同一份 */
export const BASH_PLATFORMS: readonly ToolPlatform[] = ['darwin', 'linux']
export const POWERSHELL_PLATFORMS: readonly ToolPlatform[] = ['win32']

/**
 * 当前平台上的命令工具（没有则 null —— ShuviX 不发布的平台）。系统提示词据此说出 Shell 与工具名。
 */
export function platformShellKind(platform: string = process.platform): ShellKind | null {
  if ((POWERSHELL_PLATFORMS as readonly string[]).includes(platform)) return 'powershell'
  if ((BASH_PLATFORMS as readonly string[]).includes(platform)) return 'bash'
  return null
}

/** 一次命令调用要 spawn 的可执行文件与完整参数（命令本身已在 args 里） */
export interface ShellInvocation {
  file: string
  args: string[]
}

let cachedBashConfig: { shell: string; args: string[] } | null = null

/** 在 PATH 中查找可执行文件（Windows 用 where，其余用 which）；找不到返回 null */
function findOnPath(name: string): string | null {
  const isWin = process.platform === 'win32'
  try {
    const result = spawnSync(isWin ? 'where' : 'which', [name], {
      encoding: 'utf-8',
      timeout: 5000,
      windowsHide: true
    })
    if (result.status === 0 && result.stdout) {
      const firstMatch = result.stdout.trim().split(/\r?\n/)[0]
      // where 会列出不可执行的同名项，逐一存在性校验只对 Windows 有意义
      if (firstMatch && (!isWin || existsSync(firstMatch))) return firstMatch
    }
  } catch {
    // 忽略错误
  }
  return null
}

/**
 * bash 的固定参数 —— `--norc` 不是可有可无的防御，是正确性要求。
 *
 * macOS 的 /bin/bash（Apple 版 3.2）启动时会做 rshd/sshd 探测：在非交互、非登录、未被当作
 * sh 调用的前提下，若 `isnetconn(fd 0)` 为真且 SHLVL < 2，它就认定自己是被远程守护进程拉起
 * 的，于是在执行 `-c` 命令**之前**先 source ~/.bashrc。而 `isnetconn` 只是 getpeername 成功
 * 与否 —— **unix socketpair 也算数**。
 *
 * 后台任务恰好凑齐这三个条件：libuv 在 Unix 上用 socketpair() 实现 'pipe' stdio（后台把 stdin
 * 留成管道供用户干涉，见 bgTaskService），而 Finder/launchd 拉起的打包应用环境里没有 SHLVL。
 * 结果是后台任务 100% 会执行用户的 ~/.bashrc，前台（stdin 为 /dev/null，不是 socket）则永不
 * 触发 —— 一个日常用 zsh 的用户可能从不知道自己 .bashrc 有问题，却只在后台任务上撞见它。
 *
 * ⚠️ 该 bug 在 `npm run dev` 下**复现不出来**：从终端启动会继承 SHLVL，恰好压住这条分支。
 * 写回归测试必须显式 `delete env.SHLVL` 并复刻后台的 stdio 形态。
 *
 * 只加在 bash 分支上：sh 回退分支不受影响（act_like_sh 本身就是抑制条件），且能走到那个分支
 * 的系统上 /bin/sh 多半是 dash/busybox，根本不认这个 flag。
 */
const BASH_ARGS = ['--norc', '-c']

/**
 * 获取 bash 配置（仅 macOS / Linux —— Windows 上的命令工具是 powershell）。
 * 解析优先级：/bin/bash → PATH 中的 bash → sh
 */
export function getBashConfig(): { shell: string; args: string[] } {
  if (cachedBashConfig) {
    return cachedBashConfig
  }

  if (process.platform === 'win32') {
    // 工具解析按平台过滤，走到这里说明有调用方绕过了注册表
    throw new Error('The bash tool is not available on Windows; use the powershell tool.')
  }

  if (existsSync('/bin/bash')) {
    cachedBashConfig = { shell: '/bin/bash', args: [...BASH_ARGS] }
    return cachedBashConfig
  }

  const bashOnPath = findOnPath('bash')
  if (bashOnPath) {
    cachedBashConfig = { shell: bashOnPath, args: [...BASH_ARGS] }
    return cachedBashConfig
  }

  // sh 回退刻意不加 --norc：dash/busybox 不认该 flag，且 sh 模式本身就不走 rshd 分支
  cachedBashConfig = { shell: 'sh', args: ['-c'] }
  return cachedBashConfig
}

// ─── PowerShell ──────────────────────────────────────

/**
 * 两个版本的语法差异会直接写进工具描述：5.1 没有 `&&` / `||`，
 * 且调原生程序时对内嵌双引号的传参是旧式（Legacy）规则。
 */
export type PowerShellEdition = 'pwsh' | 'windows-powershell'

export interface PowerShellConfig {
  exe: string
  edition: PowerShellEdition
}

let cachedPowerShellConfig: PowerShellConfig | null = null

/**
 * 获取 PowerShell 配置（仅 Windows）。
 * 解析优先级：PowerShell 7（Program Files 安装位置 → PATH，含应用商店版的执行别名）
 * → 系统自带的 Windows PowerShell 5.1（Win10/11 恒有）。
 */
export function getPowerShellConfig(): PowerShellConfig {
  if (cachedPowerShellConfig) return cachedPowerShellConfig

  if (process.platform !== 'win32') {
    throw new Error('The powershell tool is only available on Windows; use the bash tool.')
  }

  const programFiles = process.env.ProgramFiles
  const installed = programFiles ? `${programFiles}\\PowerShell\\7\\pwsh.exe` : null
  const pwsh = installed && existsSync(installed) ? installed : findOnPath('pwsh.exe')
  if (pwsh) {
    cachedPowerShellConfig = { exe: pwsh, edition: 'pwsh' }
    return cachedPowerShellConfig
  }

  const systemRoot = process.env.SystemRoot || process.env.windir
  const builtin = systemRoot
    ? `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    : null
  cachedPowerShellConfig = {
    // 系统目录缺失（极少见的精简环境）时交给 PATH 解析
    exe: builtin && existsSync(builtin) ? builtin : 'powershell.exe',
    edition: 'windows-powershell'
  }
  return cachedPowerShellConfig
}

/** 版本的展示名 —— 系统提示词的 Shell 一行与工具描述共用 */
export function powerShellEditionLabel(edition: PowerShellEdition): string {
  return edition === 'pwsh' ? 'PowerShell 7 (pwsh)' : 'Windows PowerShell 5.1'
}

/**
 * PowerShell 的固定参数。
 *
 * - `-NoProfile`：用户 profile 里的别名 / 函数 / 提示符改动会改变命令语义，且拖慢每条命令；
 * - `-NonInteractive`：需要确认的 cmdlet（如对非空目录不带 -Recurse 的 Remove-Item）报错
 *   而不是挂起等一个永远不来的回答 —— 与 bash 形态的「stdin 恒为 EOF」同义；
 * - `-ExecutionPolicy Bypass`（仅本进程）：客户端 Windows 默认 Restricted，否则连 Node 自带的
 *   `npm.ps1` 这类 shim 都跑不起来。组策略强制的执行策略仍然优先，这里改变不了；
 * - `-Command` 之后**恰好一个**参数：整条命令作为单个 argv 元素传入。PowerShell 是原生程序，
 *   libuv 按 MSVCRT 规则加的引号 / 转义会被它原样还原 —— 不存在 bash 那种再解析一层的问题。
 */
const POWERSHELL_ARGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass']

/**
 * 命令前的固定前导（与命令之间隔一个换行，命令从第二行开始）。
 *
 * - `$ProgressPreference`：5.1 在 stdout / stderr 被重定向时，会把进度条序列化成
 *   `#< CLIXML <Objs …>` 写进输出，关掉进度即可；
 * - 输出编码：中文 Windows 的控制台代码页是 936，不改的话写进日志的是 GBK，按 UTF-8 读就是乱码。
 *   用不带 BOM 的 UTF8Encoding —— `[Text.Encoding]::UTF8` 会在输出开头写一个 BOM。
 *   设 [Console]::OutputEncoding 在没有控制台时会抛，包一层 try（spawn 带 windowsHide，
 *   正常情况下有一个隐藏的控制台）。`$OutputEncoding` 管的是往原生程序管道里写的编码。
 */
const POWERSHELL_PRELUDE =
  "$ProgressPreference = 'SilentlyContinue'; " +
  'try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch {}; ' +
  '$OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n'

/**
 * 单条命令放进命令行后的长度上限（字符）。CreateProcess 的整条命令行上限是 32767 字符，
 * 含可执行文件路径、固定参数与前导 —— 这里给命令留 30000，剩下的足够那几样。
 * 按 powerShellCommandLineLength 估的长度判（转义之后），超出就在询问用户之前直接回话，
 * 而不是让 spawn 在用户批准之后才失败。
 */
export const MAX_POWERSHELL_COMMAND_CHARS = 30_000

/**
 * 命令作为一个参数放进 Windows 命令行后的长度**上界**。libuv 按 MSVCRT 规则转义：
 * 外面包一对引号，每个 `"` 前加一个反斜杠，紧挨在 `"` 前（或参数末尾）的反斜杠翻倍 ——
 * 所以每个 `"` 与 `\` 至多各多出一个字符。一条大半是引号的命令转义后能翻一倍，按原始长度
 * 判断会放过一条 spawn 起不来的命令。
 */
export function powerShellCommandLineLength(command: string): number {
  const line = POWERSHELL_PRELUDE + command
  let extra = 2
  for (const ch of line) if (ch === '"' || ch === '\\') extra++
  return line.length + extra
}

/** 一条命令的完整调用形态 —— bgTaskService 的唯一 spawn 路径据此起进程 */
export function shellInvocation(kind: ShellKind, command: string): ShellInvocation {
  if (kind === 'powershell') {
    const { exe } = getPowerShellConfig()
    return { file: exe, args: [...POWERSHELL_ARGS, '-Command', POWERSHELL_PRELUDE + command] }
  }
  const { shell, args } = getBashConfig()
  return { file: shell, args: [...args, command] }
}

/**
 * 清理二进制输出中的非安全字符
 * 1. 先用 Node 内置 stripVTControlCharacters 完整移除 ANSI 转义序列
 *    （如 \x1b[32m 整条删除，而非只删 \x1b 留下 [32m 垃圾文本）
 * 2. 再逐字符过滤残余控制字符和 Unicode 格式字符
 */
export function sanitizeBinaryOutput(str: string): string {
  // Step 1: 完整剥离 ANSI 转义序列（颜色、光标移动、擦除等）
  const stripped = stripVTControlCharacters(str)
  // Step 2: 过滤残余控制字符
  return Array.from(stripped)
    .filter((char) => {
      const code = char.codePointAt(0)
      if (code === undefined) return false
      // 保留 tab、换行、回车
      if (code === 0x09 || code === 0x0a || code === 0x0d) return true
      // 过滤控制字符
      if (code <= 0x1f) return false
      // 过滤 Unicode 格式字符
      if (code >= 0xfff9 && code <= 0xfffb) return false
      return true
    })
    .join('')
}

/**
 * 已知会产生大量进度输出的命令模式。
 * 只有匹配这些模式的命令才会执行骨架去重折叠，避免误伤普通输出。
 */
const PROGRESS_COMMAND_PATTERNS = [
  /\bdocker\b.*\b(pull|push|build|load|save|compose)\b/,
  /\bgit\b.*\b(clone|fetch|pull|push|lfs)\b/,
  /\b(wget|curl)\b/,
  /\b(npm|pnpm|yarn|bun)\b.*\b(install|ci|add|update)\b/,
  /\bpip3?\b.*\binstall\b/,
  /\b(apt-get|apt|yum|dnf|pacman|brew)\b.*\b(install|update|upgrade)\b/,
  /\brsync\b/,
  /\bscp\b/
]

function isProgressCommand(command: string): boolean {
  return PROGRESS_COMMAND_PATTERNS.some((p) => p.test(command))
}

/**
 * 折叠进度类输出
 *
 * 核心观察：进度刷屏的本质是——大量行共享相同的结构模式，只有数值部分在变化。
 *
 * 处理流程：
 * 1. 处理 \r 回车符：模拟终端行覆盖，只保留每次回车后的最终内容（始终执行）
 * 2. 当 command 匹配进度类命令时，计算每行的"骨架"并折叠重复行
 *
 * 覆盖场景：Docker pull/push/build、npm install、pip install、
 *           apt-get、wget/curl 进度、git clone 等
 */
export function collapseProgressOutput(text: string, command?: string): string {
  // Step 1: 处理 \r — 模拟终端回车覆盖行为
  let lines = text.split('\n').map((line) => {
    if (!line.includes('\r')) return line
    const parts = line.split('\r')
    for (let i = parts.length - 1; i >= 0; i--) {
      if (parts[i].length > 0) return parts[i]
    }
    return ''
  })

  // Step 2: 连续相似行折叠 — 仅在命令匹配进度类模式时执行
  //   只折叠连续的同骨架行段（run），不跨越不同内容区域
  if (command && isProgressCommand(command)) {
    const COLLAPSE_THRESHOLD = 5
    const result: string[] = []
    let runSkel: string | null = null
    let runLines: string[] = []

    const flushRun = (): void => {
      if (runLines.length >= COLLAPSE_THRESHOLD) {
        result.push(`[... ${runLines.length - 1} similar lines collapsed ...]`)
        result.push(runLines[runLines.length - 1])
      } else {
        result.push(...runLines)
      }
      runLines = []
      runSkel = null
    }

    for (const line of lines) {
      const skel = lineSkeleton(line)
      if (skel !== null && skel === runSkel) {
        runLines.push(line)
      } else {
        if (runLines.length > 0) flushRun()
        if (skel !== null) {
          runSkel = skel
          runLines = [line]
        } else {
          result.push(line)
        }
      }
    }
    if (runLines.length > 0) flushRun()

    lines = result
  }

  return lines.join('\n')
}

/**
 * 计算行的"骨架"——将易变的数值部分替换为占位符，保留结构
 * 返回 null 表示该行不参与去重（空行、过短的行）
 *
 * 示例：
 *   "c032818082ff Downloading 1.049MB"  → "<H> Downloading <S>"
 *   "  50% [========>   ] 1,234,567"    → "  <P> [========>   ] <N>"
 *   "Receiving objects:  50% (100/200)"  → "Receiving objects:  <P> (<N>/<N>)"
 */
function lineSkeleton(line: string): string | null {
  const trimmed = line.trim()
  if (!trimmed || trimmed.length < 4) return null
  return (
    trimmed
      // 8+ 位十六进制串 → <H>（git hash、docker layer hash 等）
      .replace(/[0-9a-f]{8,}/gi, '<H>')
      // 进度条图案 → <BAR>（[====>   ]、[####....]、█░▒▓ 等）
      .replace(/\[[\s=\-#.>|█░▒▓]+\]/g, '[<BAR>]')
      // 百分比 → <P>
      .replace(/\d+(\.\d+)?%/g, '<P>')
      // 带单位的大小 → <S>
      .replace(/\d[\d,.]*(\.\d+)?\s*(KB|MB|GB|TB|kB|bytes?|B)\b/gi, '<S>')
      // 剩余数字（含千分位逗号、小数点）→ <N>
      .replace(/\d[\d,.]*(\.\d+)?/g, '<N>')
  )
}

/** 杀死进程树（跨平台） */
export function killProcessTree(pid: number): void {
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/F', '/T', '/PID', String(pid)], {
        stdio: 'ignore',
        detached: true,
        windowsHide: true
      })
    } catch {
      // 忽略错误
    }
  } else {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // 进程已退出
      }
    }
  }
}
