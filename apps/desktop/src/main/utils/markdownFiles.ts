/**
 * 从系统「打开方式」交进来的 md 文件 —— 路径判定与命令行解析。
 *
 * 三个平台交路径的方式不同：macOS 只走 `open-file` 事件（冷启动与已运行都是），Windows / Linux
 * 冷启动时在 `process.argv` 里、已运行时在 `second-instance` 的 argv 里。这里只管「这一串参数里
 * 哪些是要打开的 md 文件」，不管窗口。
 */
import { extname, resolve } from 'path'
import { statSync } from 'fs'

/** 认作 markdown 的扩展名（小写、带点）。与 electron-builder 的文件关联同一份 */
export const MARKDOWN_EXTENSIONS: readonly string[] = ['.md', '.markdown']

/** 按扩展名判定（大小写不敏感） */
export function isMarkdownPath(path: string): boolean {
  return MARKDOWN_EXTENSIONS.includes(extname(path).toLowerCase())
}

/** 是一个存在的普通文件（不是目录、不存在、读不到都算否） */
export function isExistingFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * 从一串命令行参数里挑出要打开的 md 文件（绝对路径，去重保序）。
 *
 * 不按下标跳过可执行文件 / 脚本路径：打包后是 `[exe, file]`，开发时是 `[electron, ., file]`，
 * 第二实例的 argv 里 Chromium 还会插入自己的开关 —— 下标不可靠。改为逐个判定：
 * `-` 开头的是开关，跳过；其余按 `cwd` 解析成绝对路径，扩展名是 md 且确实是个存在的文件才要。
 * 可执行文件、`.`、脚本路径都过不了扩展名这一关。
 */
export function markdownFilesFromArgv(
  argv: readonly string[],
  cwd: string,
  isFile: (path: string) => boolean = isExistingFile
): string[] {
  const files: string[] = []
  for (const arg of argv) {
    if (!arg || arg.startsWith('-')) continue
    const path = resolve(cwd, arg)
    if (!isMarkdownPath(path) || !isFile(path)) continue
    if (!files.includes(path)) files.push(path)
  }
  return files
}
