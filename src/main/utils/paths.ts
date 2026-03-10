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

/** 获取临时会话的工作目录 */
export function getTempWorkspace(sessionId: string): string {
  return ensureDir(join(app.getPath('userData'), 'temp_workspace', sessionId))
}

/**
 * 合并 PATH — 打包后的 Electron GUI 应用不继承 shell PATH，
 * 需要手动追加常见路径以便找到 docker / claude-agent-acp 等命令。
 */
const EXTRA_PATHS = ['/usr/local/bin', '/opt/homebrew/bin', '/opt/homebrew/sbin']
export const mergedPATH = [
  ...new Set([...(process.env.PATH?.split(':') ?? []), ...EXTRA_PATHS])
].join(':')

/** 带合并 PATH 的 spawn 环境变量 */
export const spawnEnv: NodeJS.ProcessEnv = { ...process.env, PATH: mergedPATH }
