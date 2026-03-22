/**
 * Pyodide Worker 生命周期管理
 * 管理每个 session 的 Pyodide worker_threads 实例
 */

import { Worker } from 'worker_threads'
import { resolve, join } from 'path'
import { existsSync } from 'fs'
import type { PluginContext, PluginSessionPaths } from '../../plugin-api'
import type { MountConfig, WorkerResponse } from './pythonWorker'

interface PendingRequest {
  resolve: (value: WorkerResponse) => void
  reject: (reason: unknown) => void
  timer: ReturnType<typeof setTimeout>
}

interface WorkerEntry {
  worker: Worker
  ready: boolean
  pending: Map<string, PendingRequest>
}

export class PyodideWorkerManager {
  private workers = new Map<string, WorkerEntry>()
  private initPromises = new Map<string, Promise<void>>()

  constructor(private ctx: PluginContext) {}

  /** 获取 worker 脚本路径（构建产物，非静态资源） */
  private getWorkerPath(): string {
    // pythonWorker 是 electron-vite 的独立构建入口，输出到 out/main/
    // 开发模式：与主进程入口同目录；打包模式：在 app.asar.unpacked 中
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { app } = require('electron') as typeof import('electron')
      if (app.isPackaged) {
        return join(process.resourcesPath, 'app.asar.unpacked', 'out', 'main', 'pythonWorker.js')
      }
    } catch {
      // 测试环境无 electron
    }
    return resolve(__dirname, 'pythonWorker.js')
  }

  /** 获取预装 wheel 文件目录路径 */
  private getWheelsDir(): string | undefined {
    const dir = this.ctx.getResourcePath('pyodide-wheels')
    return existsSync(dir) ? dir : undefined
  }

  /** 从 PluginSessionPaths 构建挂载配置 */
  private buildMounts(paths: PluginSessionPaths): MountConfig[] {
    const mounts: MountConfig[] = [{ hostPath: paths.workingDirectory, access: 'readwrite' }]
    for (const ref of paths.referenceDirs) {
      mounts.push({ hostPath: ref.path, access: ref.access })
    }
    return mounts
  }

  /** 确保 worker 已初始化并就绪 */
  async ensureReady(sessionId: string, onReady?: () => void): Promise<void> {
    const existing = this.workers.get(sessionId)
    if (existing?.ready) return

    const pending = this.initPromises.get(sessionId)
    if (pending) return pending

    const initPromise = this.createWorker(sessionId, onReady)
    this.initPromises.set(sessionId, initPromise)
    try {
      await initPromise
    } finally {
      this.initPromises.delete(sessionId)
    }
  }

  private async createWorker(sessionId: string, onReady?: () => void): Promise<void> {
    const workerPath = this.getWorkerPath()
    this.ctx.logger.info(`Creating Pyodide worker for session ${sessionId}: ${workerPath}`)

    const worker = new Worker(workerPath)
    const entry: WorkerEntry = { worker, ready: false, pending: new Map() }
    this.workers.set(sessionId, entry)

    const paths = this.ctx.getSessionPaths(sessionId)

    return new Promise<void>((resolveInit, rejectInit) => {
      const initTimeout = setTimeout(() => {
        rejectInit(new Error('Pyodide initialization timed out (60s)'))
        this.terminate(sessionId)
      }, 60_000)

      worker.on('message', (msg: WorkerResponse) => {
        if (msg.type === 'ready') {
          clearTimeout(initTimeout)
          entry.ready = true
          this.ctx.logger.info(`Pyodide worker ready for session ${sessionId}`)
          onReady?.()
          resolveInit()
          return
        }

        if (msg.id) {
          const req = entry.pending.get(msg.id)
          if (req) {
            clearTimeout(req.timer)
            entry.pending.delete(msg.id)
            req.resolve(msg)
          }
        } else if (msg.type === 'error' && !msg.id) {
          clearTimeout(initTimeout)
          rejectInit(new Error(msg.error || 'Unknown initialization error'))
          this.terminate(sessionId)
        }
      })

      worker.on('error', (err) => {
        clearTimeout(initTimeout)
        this.ctx.logger.error(`Pyodide worker error (session ${sessionId}):`, err)
        for (const [, req] of entry.pending) {
          clearTimeout(req.timer)
          req.reject(err)
        }
        entry.pending.clear()
        this.workers.delete(sessionId)
        rejectInit(err)
      })

      worker.on('exit', (code) => {
        this.ctx.logger.info(`Pyodide worker exited (session ${sessionId}, code ${code})`)
        if (this.workers.get(sessionId) === entry) {
          for (const [, req] of entry.pending) {
            clearTimeout(req.timer)
            req.reject(new Error(`Worker exited with code ${code}`))
          }
          entry.pending.clear()
          this.workers.delete(sessionId)
        }
      })

      const mounts = this.buildMounts(paths)
      const wheelsDir = this.getWheelsDir()
      worker.postMessage({
        type: 'init',
        mounts,
        workingDirectory: paths.workingDirectory,
        wheelsDir
      })
    })
  }

  /** 执行 Python 代码 */
  async execute(
    sessionId: string,
    id: string,
    code: string,
    packages?: string[],
    timeoutMs = 30_000
  ): Promise<WorkerResponse> {
    const entry = this.workers.get(sessionId)
    if (!entry?.ready) {
      throw new Error('Python worker not ready')
    }

    return new Promise<WorkerResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        entry.pending.delete(id)
        this.ctx.logger.warn(`Python execution timed out (${timeoutMs}ms), terminating worker`)
        this.terminate(sessionId)
        reject(new Error(`Python execution timed out (${timeoutMs / 1000}s)`))
      }, timeoutMs)

      entry.pending.set(id, { resolve, reject, timer })
      entry.worker.postMessage({ type: 'execute', id, code, packages })
    })
  }

  /** 检查 session 是否有活跃的 Python 运行时 */
  isActive(sessionId: string): boolean {
    return this.workers.get(sessionId)?.ready === true
  }

  /** 终止指定 session 的 worker */
  terminate(sessionId: string): void {
    const entry = this.workers.get(sessionId)
    if (!entry) return

    this.ctx.logger.info(`Terminating Pyodide worker for session ${sessionId}`)
    for (const [, req] of entry.pending) {
      clearTimeout(req.timer)
      req.reject(new Error('Worker terminated'))
    }
    entry.pending.clear()
    entry.worker.terminate()
    this.workers.delete(sessionId)
  }

  /** 终止所有 worker（应用退出时调用） */
  terminateAll(): void {
    for (const [sessionId] of this.workers) {
      this.terminate(sessionId)
    }
  }
}
