/**
 * Bundler 模块入口 —— 主进程持有的 esbuild 打包能力单例。
 *
 * 本文件负责把 `BundlerService` / `ProjectManager` 实例化为进程级单例，
 * 并提供 `bundlerResourcePath` 用于定位打包器资源（模板、预置依赖）。
 *
 * 消费方：
 * - src/main/services/widget/ —— widget 运行时与导出
 * - src/main/tools/dev.ts —— dev 工具 (所有 kind)
 */

import { join, resolve } from 'path'
import { app } from 'electron'
import { BundlerService } from './bundlerService'
import { ProjectManager } from './projectManager'
import { createLogger } from '../../logger'

/** 解析打包器资源目录内相对路径（模板、预置 ESM bundles、tailwindcss-browser 等） */
export function bundlerResourcePath(relative: string): string {
  const base = app.isPackaged
    ? join(process.resourcesPath, 'bundler')
    : resolve(__dirname, '../../resources/bundler')
  return join(base, relative)
}

/**
 * 全局共享的 BundlerService —— esbuild-wasm 在整个进程内只初始化一次。
 * widgetServer 与 dev 工具都用这个实例。
 */
export const bundlerService = new BundlerService(bundlerResourcePath, createLogger('bundler'))

/**
 * 全局共享的 ProjectManager —— 管理 presentation / sketch 这类 per-session
 * 的 .shuvix/design/ 项目状态（fs.watch + 防抖 rebuild + dev server 生命周期）。
 */
export const projectManager = new ProjectManager(
  bundlerResourcePath,
  createLogger('projectManager'),
  bundlerService
)

export type { BundleResult, DevServerInfo } from './bundlerService'
