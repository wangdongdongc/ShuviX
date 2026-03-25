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
        cachedShellConfig = { shell: path, args: ['-c'] }
        return cachedShellConfig
      }
    }

    // 回退：PATH 中查找 bash.exe
    const bashOnPath = findBashOnPath()
    if (bashOnPath) {
      cachedShellConfig = { shell: bashOnPath, args: ['-c'] }
      return cachedShellConfig
    }

    throw new Error('未找到 bash shell。请安装 Git for Windows 或将 bash 添加到 PATH。')
  }

  // Unix: 优先 /bin/bash
  if (existsSync('/bin/bash')) {
    cachedShellConfig = { shell: '/bin/bash', args: ['-c'] }
    return cachedShellConfig
  }

  const bashOnPath = findBashOnPath()
  if (bashOnPath) {
    cachedShellConfig = { shell: bashOnPath, args: ['-c'] }
    return cachedShellConfig
  }

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
 * 折叠进度类输出（通用方案，不绑定任何特定工具）
 *
 * 核心观察：进度刷屏的本质是——大量行共享相同的结构模式，只有数值部分在变化。
 *
 * 处理流程：
 * 1. 处理 \r 回车符：模拟终端行覆盖，只保留每次回车后的最终内容
 * 2. 计算每行的"骨架"（将数字、hex hash、百分比、文件大小替换为占位符），
 *    同一骨架出现 ≥ COLLAPSE_THRESHOLD 次时，只保留最后一行并标注折叠数量
 *
 * 覆盖场景：Docker pull/push/build、npm install、pip install、
 *           apt-get、wget/curl 进度、git clone 等
 */
export function collapseProgressOutput(text: string): string {
  // Step 1: 处理 \r — 模拟终端回车覆盖行为
  let lines = text.split('\n').map((line) => {
    if (!line.includes('\r')) return line
    const parts = line.split('\r')
    for (let i = parts.length - 1; i >= 0; i--) {
      if (parts[i].length > 0) return parts[i]
    }
    return ''
  })

  // Step 2: 骨架去重 — 同一骨架出现多次时只保留最后一行
  const COLLAPSE_THRESHOLD = 5
  const skeletonIndices = new Map<string, number[]>()

  for (let i = 0; i < lines.length; i++) {
    const skel = lineSkeleton(lines[i])
    if (skel === null) continue
    const arr = skeletonIndices.get(skel)
    if (arr) arr.push(i)
    else skeletonIndices.set(skel, [i])
  }

  const replaced = new Set<number>()
  const collapseNotice = new Map<number, string>()

  for (const [, indices] of skeletonIndices) {
    if (indices.length < COLLAPSE_THRESHOLD) continue
    const last = indices[indices.length - 1]
    for (const idx of indices) {
      if (idx !== last) replaced.add(idx)
    }
    collapseNotice.set(last, `[... ${indices.length - 1} similar lines collapsed ...]`)
  }

  if (replaced.size > 0) {
    const result: string[] = []
    for (let i = 0; i < lines.length; i++) {
      if (replaced.has(i)) continue
      const notice = collapseNotice.get(i)
      if (notice) result.push(notice)
      result.push(lines[i])
    }
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
