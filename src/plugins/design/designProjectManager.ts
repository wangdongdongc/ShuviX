/**
 * DesignProjectManager — 设计项目生命周期管理（插件版）
 *
 * 职责：
 * - 初始化/脚手架设计项目目录 ({workingDir}/.shuvix/design/)
 * - 文件监听 + debounce 触发重新打包
 * - per-session 生命周期管理（启动/停止 dev server + watcher）
 */

import { join } from 'path'
import { existsSync, mkdirSync, cpSync, watch, type FSWatcher } from 'fs'
import { BundlerService, type DevServerInfo } from './bundlerService'
import type { PluginLogger } from '../../plugin-api'

/** 设计项目在项目目录中的子路径 */
const DESIGN_SUBDIR = '.shuvix/design'

/** 可用的模板列表 */
const VALID_TEMPLATES = new Set(['blank', 'app', 'landing', 'dashboard'])

// ────────────────────── Types ──────────────────────

interface DesignProjectState {
  /** 设计项目绝对路径 */
  designDir: string
  /** 关联的工作目录 */
  workingDir: string
  /** fs.watch 实例 */
  watcher: FSWatcher | null
  /** rebuild debounce 定时器 */
  rebuildTimer: ReturnType<typeof setTimeout> | null
}

// ────────────────────── DesignProjectManager ──────────────────────

/** rebuild debounce 间隔（ms） */
const DEBOUNCE_MS = 300

export class DesignProjectManager {
  private sessions = new Map<string, DesignProjectState>()

  constructor(
    private getResourcePath: (relativePath: string) => string,
    private log: PluginLogger,
    private bundlerService: BundlerService
  ) {}

  /** 获取设计项目目录路径 */
  getDesignDir(workingDir: string): string {
    return join(workingDir, DESIGN_SUBDIR)
  }

  /** 获取指定模板的资源目录 */
  private getTemplateDir(template: string): string {
    const name = VALID_TEMPLATES.has(template) ? template : 'app'
    return join(this.getResourcePath('templates'), name)
  }

  /** 检查设计项目是否已存在 */
  hasDesignProject(workingDir: string): boolean {
    const dir = this.getDesignDir(workingDir)
    return existsSync(join(dir, 'index.tsx'))
  }

  /**
   * 初始化设计项目：创建目录 + 脚手架模板文件（如果不存在）
   * @returns 设计项目目录绝对路径
   */
  async init(_sessionId: string, workingDir: string, template: string = 'app'): Promise<string> {
    const designDir = this.getDesignDir(workingDir)

    // 仅在入口文件不存在时从资源模板复制
    const indexPath = join(designDir, 'index.tsx')
    if (!existsSync(indexPath)) {
      const templateDir = this.getTemplateDir(template)
      cpSync(templateDir, designDir, { recursive: true })
      // 确保空目录也被创建（cpSync 不会复制空目录）
      for (const sub of ['hooks', 'utils', 'types']) {
        mkdirSync(join(designDir, sub), { recursive: true })
      }
      this.log.info(`Scaffolded design project (template: ${template}) at ${designDir}`)
    }

    return designDir
  }

  /**
   * 启动 dev server + 文件监听
   * 如果该 session 已有运行中的 dev server，先停止再重启
   */
  async startDev(sessionId: string, workingDir: string, template?: string): Promise<DevServerInfo> {
    // 确保设计项目已初始化
    const designDir = await this.init(sessionId, workingDir, template)

    // 停止已有实例
    this.dispose(sessionId)

    // 启动 dev server（首次构建在 bundlerService 内完成）
    const serverInfo = await this.bundlerService.startDevServer(sessionId, designDir)

    // 启动文件监听
    const state: DesignProjectState = {
      designDir,
      workingDir,
      watcher: null,
      rebuildTimer: null
    }

    try {
      state.watcher = watch(designDir, { recursive: true }, (_event, filename) => {
        if (!filename) return
        // 忽略隐藏文件和非源码文件
        if (filename.startsWith('.') || filename.includes('node_modules')) return
        this.scheduleRebuild(sessionId, state)
      })

      state.watcher.on('error', (err) => {
        this.log.warn(`File watcher error for session ${sessionId}:`, err)
      })
    } catch (err) {
      this.log.warn(`Failed to start file watcher for ${designDir}:`, err)
      // watcher 失败不影响 dev server，用户可手动触发 rebuild
    }

    this.sessions.set(sessionId, state)
    this.log.info(`Design dev started for session ${sessionId}: ${serverInfo.url}`)

    return serverInfo
  }

  /** 停止 dev server + 文件监听 */
  stopDev(sessionId: string): void {
    this.dispose(sessionId)
  }

  /** 查询 session 是否有活跃的设计预览 */
  isActive(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  /** 清理单个 session 的资源 */
  dispose(sessionId: string): void {
    const state = this.sessions.get(sessionId)
    if (!state) return

    // 清除 debounce 定时器
    if (state.rebuildTimer) {
      clearTimeout(state.rebuildTimer)
      state.rebuildTimer = null
    }

    // 关闭文件监听
    if (state.watcher) {
      state.watcher.close()
      state.watcher = null
    }

    // 停止 dev server
    this.bundlerService.stopDevServer(sessionId)

    this.sessions.delete(sessionId)
    this.log.info(`Design dev stopped for session ${sessionId}`)
  }

  /** 清理所有 session（应用退出时调用） */
  disposeAll(): void {
    for (const sessionId of [...this.sessions.keys()]) {
      this.dispose(sessionId)
    }
  }

  // ── Private ──

  /** debounce 重新打包 */
  private scheduleRebuild(sessionId: string, state: DesignProjectState): void {
    if (state.rebuildTimer) {
      clearTimeout(state.rebuildTimer)
    }
    state.rebuildTimer = setTimeout(async () => {
      state.rebuildTimer = null
      try {
        await this.bundlerService.rebuild(sessionId, state.designDir)
      } catch (err) {
        this.log.error(`Rebuild failed for session ${sessionId}:`, err)
      }
    }, DEBOUNCE_MS)
  }
}
