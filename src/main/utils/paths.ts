/**
 * 路径相关工具函数 — 所有数据目录的统一入口
 */

import { join } from 'path'
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
 * 需要手动追加常见路径以便找到 npx / docker / claude-agent-acp 等命令。
 */
const EXTRA_PATHS = ['/usr/local/bin', '/opt/homebrew/bin', '/opt/homebrew/sbin']
export const mergedPATH = [
  ...new Set([...(process.env.PATH?.split(':') ?? []), ...EXTRA_PATHS])
].join(':')

/**
 * 构建 spawn 用环境变量，自动合并 PATH。
 * 可传入额外 env 覆盖或追加变量。
 */
export function buildSpawnEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  return { ...process.env, ...extra, PATH: mergedPATH }
}
