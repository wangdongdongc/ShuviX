/**
 * Shell 工具函数（精简版）
 * 从 pi-coding-agent 移植，去掉 SettingsManager 等外部依赖
 */

import { existsSync } from 'node:fs'
import { spawnSync, spawn } from 'child_process'

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
 * 移除控制字符（保留 tab/换行/回车）和 Unicode 格式字符
 */
export function sanitizeBinaryOutput(str: string): string {
  return Array.from(str)
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
