/**
 * BundlerRuntime —— 主进程持有的 esbuild 打包能力单例。
 *
 * `BundlerService` / `ProjectManager` 类定义在 src/plugins/esbuild/ 下（那里无法
 * 依赖 electron 或 main），本文件在主进程侧把它们实例化为全局单例，并提供
 * `esbuildResourcePath` 用于定位 esbuild 资源（模板、预置依赖）。
 *
 * 消费方：
 * - src/main/services/widgetServer.ts —— widget kind
 * - src/main/tools/dev.ts              —— dev 工具 (所有 kind)
 */

import { join, resolve } from 'path'
import { app } from 'electron'
import { BundlerService } from '../../plugins/esbuild/bundlerService'
import { ProjectManager } from '../../plugins/esbuild/projectManager'
import { createLogger } from '../logger'

/** 解析 esbuild 资源目录内相对路径（模板、预置 ESM bundles、tailwindcss-browser 等） */
export function esbuildResourcePath(relative: string): string {
  const base = app.isPackaged
    ? join(process.resourcesPath, 'plugins', 'esbuild')
    : resolve(__dirname, '../../resources/plugins/esbuild')
  return join(base, relative)
}

/**
 * 全局共享的 BundlerService —— esbuild-wasm 在整个进程内只初始化一次。
 * widgetServer 与 dev 工具都用这个实例。
 */
export const bundlerService = new BundlerService(esbuildResourcePath, createLogger('bundler'))

/**
 * 全局共享的 ProjectManager —— 管理 presentation / sketch 这类 per-session
 * 的 .shuvix/design/ 项目状态（fs.watch + 防抖 rebuild + dev server 生命周期）。
 */
export const projectManager = new ProjectManager(
  esbuildResourcePath,
  createLogger('projectManager'),
  bundlerService
)
