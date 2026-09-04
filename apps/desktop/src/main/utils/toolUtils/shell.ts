/**
 * Shell 工具函数（精简版）
 * 从 pi-coding-agent 移植，去掉 SettingsManager 等外部依赖
 */

import { existsSync } from 'node:fs'
import { spawnSync, spawn } from 'child_process'
import { stripVTControlCharacters } from 'node:util'

let cachedShellConfig: { shell: string; args: string[] } | null = null

/** 在 PATH 中查找 bash 可执行文件 */
function findBashOnPath(): string | null {
  if (process.platform === 'win32') {
    try {
      const result = spawnSync('where', ['bash.exe'], { encoding: 'utf-8', timeout: 5000 })
      if (result.status === 0 && result.stdout) {
        const firstMatch = result.stdout.trim().split(/\r?\n/)[0]
        if (firstMatch && existsSync(firstMatch)) {
          return firstMatch
        }
      }
    } catch {
      // 忽略错误
    }
    return null
  }

  // Unix: 使用 which 查找
  try {
    const result = spawnSync('which', ['bash'], { encoding: 'utf-8', timeout: 5000 })
    if (result.status === 0 && result.stdout) {
      const firstMatch = result.stdout.trim().split(/\r?\n/)[0]
      if (firstMatch) {
        return firstMatch
      }
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
 * 获取 shell 配置
 * 解析优先级：
 * 1. Windows: Git Bash → PATH 中的 bash
 * 2. Unix: /bin/bash → PATH 中的 bash → sh
 */
export function getShellConfig(): { shell: string; args: string[] } {
  if (cachedShellConfig) {
    return cachedShellConfig
  }

  if (process.platform === 'win32') {
    // 尝试 Git Bash
    const paths: string[] = []
    const programFiles = process.env.ProgramFiles
    if (programFiles) {
      paths.push(`${programFiles}\\Git\\bin\\bash.exe`)
    }
    const programFilesX86 = process.env['ProgramFiles(x86)']
    if (programFilesX86) {
      paths.push(`${programFilesX86}\\Git\\bin\\bash.exe`)
    }

    for (const path of paths) {
      if (existsSync(path)) {
        cachedShellConfig = { shell: path, args: [...BASH_ARGS] }
        return cachedShellConfig
      }
    }

    // 回退：PATH 中查找 bash.exe
    const bashOnPath = findBashOnPath()
    if (bashOnPath) {
      cachedShellConfig = { shell: bashOnPath, args: [...BASH_ARGS] }
      return cachedShellConfig
    }

    throw new Error('未找到 bash shell。请安装 Git for Windows 或将 bash 添加到 PATH。')
  }

  // Unix: 优先 /bin/bash
  if (existsSync('/bin/bash')) {
    cachedShellConfig = { shell: '/bin/bash', args: [...BASH_ARGS] }
    return cachedShellConfig
  }

  const bashOnPath = findBashOnPath()
  if (bashOnPath) {
    cachedShellConfig = { shell: bashOnPath, args: [...BASH_ARGS] }
    return cachedShellConfig
  }

  // sh 回退刻意不加 --norc：dash/busybox 不认该 flag，且 sh 模式本身就不走 rshd 分支
  cachedShellConfig = { shell: 'sh', args: ['-c'] }
  return cachedShellConfig
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
        detached: true
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
