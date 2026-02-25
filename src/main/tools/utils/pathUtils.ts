/**
 * 路径处理工具函数
 * 从 pi-coding-agent 移植，处理路径解析、~ 展开、macOS 特殊字符等
 */

import { accessSync, constants, readdirSync } from 'node:fs'
import * as os from 'node:os'
import { isAbsolute, resolve as resolvePath, dirname, basename, join } from 'node:path'

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g
const NARROW_NO_BREAK_SPACE = '\u202F'

/** 规范化 Unicode 空格为普通空格 */
function normalizeUnicodeSpaces(str: string): string {
  return str.replace(UNICODE_SPACES, ' ')
}

/** 尝试 macOS 截图文件名中 AM/PM 前的窄不换行空格 */
function tryMacOSScreenshotPath(filePath: string): string {
  return filePath.replace(/ (AM|PM)\./g, `${NARROW_NO_BREAK_SPACE}$1.`)
}

/** 尝试 NFD 规范化（macOS 以 NFD 形式存储文件名） */
function tryNFDVariant(filePath: string): string {
  return filePath.normalize('NFD')
}

/** 尝试弯引号变体（macOS 截图名称中的 U+2019） */
function tryCurlyQuoteVariant(filePath: string): string {
  return filePath.replace(/'/g, '\u2019')
}

/** 检查文件是否存在 */
function fileExists(filePath: string): boolean {
  try {
    accessSync(filePath, constants.F_OK)
    return true
  } catch {
    return false
  }
}

/** 去除路径开头的 @ 前缀 */
function normalizeAtPrefix(filePath: string): string {
  return filePath.startsWith('@') ? filePath.slice(1) : filePath
}

/** 展开路径中的 ~ */
export function expandPath(filePath: string): string {
  const normalized = normalizeUnicodeSpaces(normalizeAtPrefix(filePath))
  if (normalized === '~') {
    return os.homedir()
  }
  if (normalized.startsWith('~/')) {
    return os.homedir() + normalized.slice(1)
  }
  return normalized
}

/** 将路径解析为基于 cwd 的绝对路径 */
export function resolveToCwd(filePath: string, cwd: string): string {
  const expanded = expandPath(filePath)
  if (isAbsolute(expanded)) {
    return expanded
  }
  return resolvePath(cwd, expanded)
}

/** 解析读取路径，尝试多种 macOS 文件名变体 */
export function resolveReadPath(filePath: string, cwd: string): string {
  const resolved = resolveToCwd(filePath, cwd)

  if (fileExists(resolved)) {
    return resolved
  }

  // 尝试 macOS AM/PM 变体
  const amPmVariant = tryMacOSScreenshotPath(resolved)
  if (amPmVariant !== resolved && fileExists(amPmVariant)) {
    return amPmVariant
  }

  // 尝试 NFD 变体
  const nfdVariant = tryNFDVariant(resolved)
  if (nfdVariant !== resolved && fileExists(nfdVariant)) {
    return nfdVariant
  }

  // 尝试弯引号变体
  const curlyVariant = tryCurlyQuoteVariant(resolved)
  if (curlyVariant !== resolved && fileExists(curlyVariant)) {
    return curlyVariant
  }

  // 尝试 NFD + 弯引号组合
  const nfdCurlyVariant = tryCurlyQuoteVariant(nfdVariant)
  if (nfdCurlyVariant !== resolved && fileExists(nfdCurlyVariant)) {
    return nfdCurlyVariant
  }

  return resolved
}

/**
 * 文件不存在时，从父目录中模糊匹配近似文件名
 * 返回最多 maxResults 个建议的绝对路径
 */
export function suggestSimilarFiles(absolutePath: string, maxResults = 3): string[] {
  const dir = dirname(absolutePath)
  const base = basename(absolutePath).toLowerCase()

  try {
    const entries = readdirSync(dir)
    return entries
      .filter((entry) => {
        const lower = entry.toLowerCase()
        return lower.includes(base) || base.includes(lower)
      })
      .map((entry) => join(dir, entry))
      .slice(0, maxResults)
  } catch {
    // 父目录不存在或无权限
    return []
  }
}
