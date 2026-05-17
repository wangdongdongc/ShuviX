/**
 * 路径相关工具函数 — 所有数据目录的统一入口
 */

import { join, resolve, dirname, delimiter } from 'path'
import { homedir } from 'os'
import { mkdirSync, existsSync } from 'fs'
import { app } from 'electron'

/** 确保目录存在并返回路径 */
function ensureDir(dir: string): string {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

/** 应用数据目录：~/Library/Application Support/shuvix/data/ */
export function getDataDir(): string {
  return ensureDir(join(app.getPath('userData'), 'data'))
}

/** 用户配置目录：~/.shuvix/ */
export function getUserConfigDir(): string {
  return ensureDir(join(homedir(), '.shuvix'))
}

/** TTS 临时音频文件缓存目录 */
export function getTtsCacheDir(): string {
  return ensureDir(join(app.getPath('userData'), 'tts_cache'))
}

/** Whisper 模型存储目录：~/.shuvix/stt/whisper/models/ */
export function getWhisperModelsDir(): string {
  return ensureDir(join(homedir(), '.shuvix', 'stt', 'whisper', 'models'))
}

/** Qwen3 TTS 基础目录：~/.shuvix/tts/qwen3/ */
export function getQwen3TtsDir(): string {
  return ensureDir(join(homedir(), '.shuvix', 'tts', 'qwen3'))
}

/** 全局 Skills 目录：~/.shuvix/skills/（不自动创建，由 skillService 管理） */
export function getDefaultSkillsDir(): string {
  return join(homedir(), '.shuvix', 'skills')
}

/**
 * 内置 Skills 资源目录 —— 随应用版本包发布，只读
 * 打包后位于 Resources/skills/，开发时位于 resources/skills/
 */
export function getBuiltinSkillsDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'skills')
    : resolve(__dirname, '../../resources/skills')
}

/** Widgets 根目录：~/.shuvix/widgets/（懒创建） */
export function getWidgetsDir(): string {
  return ensureDir(join(homedir(), '.shuvix', 'widgets'))
}

/** 获取临时会话的工作目录 */
export function getTempWorkspace(sessionId: string): string {
  return ensureDir(join(app.getPath('userData'), 'temp_workspace', sessionId))
}

/** 工具大结果持久化根目录（不自动创建） */
export function getToolResultsBase(): string {
  return join(app.getPath('userData'), 'tool_results')
}

/** 工具大结果持久化目录：~/Library/Application Support/shuvix/tool_results/{sessionId}/ */
export function getToolResultsDir(sessionId: string): string {
  return ensureDir(join(getToolResultsBase(), sessionId))
}

/**
 * 合并 PATH — 打包后的 Electron GUI 应用不继承 shell PATH，
 * 需要手动追加常见路径以便找到 npx / docker 等命令。
 */
const EXTRA_PATHS = ['/usr/local/bin', '/opt/homebrew/bin', '/opt/homebrew/sbin']
export const mergedPATH = [
  ...new Set([...(process.env.PATH?.split(':') ?? []), ...EXTRA_PATHS])
].join(':')

/**
 * shuvix CLI 入口绝对路径：
 *   - SHUVIX_ELECTRON  当前 Electron 二进制（CLI 用 ELECTRON_RUN_AS_NODE 复用之）
 *   - SHUVIX_CLI_JS    打包后的 cli 入口（out/main/cli.js / Resources/app.asar 内）
 *   - SHUVIX_CLI       wrapper 脚本绝对路径（同时 wrapper 所在目录会被 prepend 到 PATH，
 *                      AI 直接 `shuvix widget …` 即可，不必引用此 env）
 */
export function getShuvixCliEnv(): {
  SHUVIX_ELECTRON: string
  SHUVIX_CLI_JS: string
  SHUVIX_CLI: string
} {
  const electron = process.execPath
  const isWin = process.platform === 'win32'
  const wrapperName = isWin ? 'shuvix.cmd' : 'shuvix'
  const cliJs = app.isPackaged
    ? join(app.getAppPath(), 'out', 'main', 'cli.js')
    : resolve(__dirname, '../../out/main/cli.js')
  const wrapper = app.isPackaged
    ? join(process.resourcesPath, 'cli', wrapperName)
    : resolve(__dirname, '../../resources/cli', wrapperName)
  return {
    SHUVIX_ELECTRON: electron,
    SHUVIX_CLI_JS: cliJs,
    SHUVIX_CLI: wrapper
  }
}

/**
 * 构建 spawn 用环境变量：
 *   - PATH 合并系统 PATH + EXTRA_PATHS + shuvix CLI wrapper 所在目录（prepended）
 *     这样 AI 可直接 `shuvix widget …`，不需要引用 $SHUVIX_CLI
 *   - 额外注入 SHUVIX_ELECTRON / SHUVIX_CLI_JS / SHUVIX_CLI（debugging / fallback）
 */
export function buildSpawnEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const cliEnv = getShuvixCliEnv()
  const cliDir = dirname(cliEnv.SHUVIX_CLI)
  // 仅 POSIX 走 mergedPATH（用 ":" 解析）；Windows 直接用原始 PATH
  const basePath = process.platform === 'win32' ? (process.env.PATH ?? '') : mergedPATH
  const PATH = [cliDir, basePath].filter(Boolean).join(delimiter)
  return { ...process.env, ...cliEnv, ...extra, PATH }
}
