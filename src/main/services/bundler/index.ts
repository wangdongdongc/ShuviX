/**
 * Bundler 模块入口 —— 主进程持有的 esbuild 打包能力单例。
 *
 * 消费方：
 * - src/main/services/widget/ —— widget 运行时与导出
 */

import { join, resolve } from 'path'
import { app } from 'electron'
import { BundlerService } from './bundlerService'
import { createLogger } from '../../logger'

/** 解析打包器资源目录内相对路径（预置 ESM bundles、tailwindcss-browser 等） */
export function bundlerResourcePath(relative: string): string {
  const base = app.isPackaged
    ? join(process.resourcesPath, 'bundler')
    : resolve(__dirname, '../../resources/bundler')
  return join(base, relative)
}

/**
 * 全局共享的 BundlerService —— esbuild-wasm 在整个进程内只初始化一次。
 */
export const bundlerService = new BundlerService(bundlerResourcePath, createLogger('bundler'))

export type { BundleResult } from './bundlerService'
