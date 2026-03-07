/**
 * Python Worker 生命周期管理 — 单例服务
 * 管理每个 session 的 Pyodide worker_threads 实例
 */

import { Worker } from 'worker_threads'
import { resolve, join } from 'path'
import { existsSync } from 'fs'
import { app } from 'electron'
import type { MountConfig, WorkerResponse } from '../tools/utils/pythonWorker'
import type { ProjectConfig } from '../tools/types'
import { createLogger } from '../logger'

const log = createLogger('PythonWorkerManager')

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

class PythonWorkerManager {
  private workers = new Map<string, WorkerEntry>()
  private initPromises = new Map<string, Promise<void>>()

  /** 获取 worker 脚本路径 */
  private getWorkerPath(): string {
    if (app.isPackaged) {
      return join(process.resourcesPath, 'app.asar.unpacked', 'out', 'main', 'pythonWorker.js')
    }
    return resolve(__dirname, 'pythonWorker.js')
  }

  /** 获取预装 wheel 文件目录路径 */
  private getWheelsDir(): string | undefined {
    const candidates = app.isPackaged
      ? [join(process.resourcesPath, 'pyodide-wheels')]
      : [resolve(__dirname, '../../resources/pyodide-wheels')]
    for (const dir of candidates) {
      if (existsSync(dir)) return dir
    }
    return undefined
  }

  /** 从 ProjectConfig 构建挂载配置 */
  private buildMounts(config: ProjectConfig): MountConfig[] {
    const mounts: MountConfig[] = [
      { hostPath: config.workingDirectory, access: 'readwrite' }
    ]
    for (const ref of config.referenceDirs) {
      mounts.push({
        hostPath: ref.path,
        access: config.sandboxEnabled ? (ref.access ?? 'readonly') : 'readwrite'
      })
    }
    return mounts
  }

  /** 确保 worker 已初始化并就绪 */
  async ensureReady(
    sessionId: string,
    config: ProjectConfig,
    onReady?: () => void
  ): Promise<void> {
    // 已有并就绪
    const existing = this.workers.get(sessionId)
    if (existing?.ready) return

    // 正在初始化中，等待
    const pending = this.initPromises.get(sessionId)
    if (pending) return pending

    const initPromise = this.createWorker(sessionId, config, onReady)
    this.initPromises.set(sessionId, initPromise)
    try {
      await initPromise
    } finally {
      this.initPromises.delete(sessionId)
    }
  }

  private async createWorker(
    sessionId: string,
    config: ProjectConfig,
    onReady?: () => void
  ): Promise<void> {
    const workerPath = this.getWorkerPath()
    log.info(`Creating Python worker for session ${sessionId}: ${workerPath}`)

    const worker = new Worker(workerPath)
    const entry: WorkerEntry = { worker, ready: false, pending: new Map() }
    this.workers.set(sessionId, entry)

    return new Promise<void>((resolveInit, rejectInit) => {
      const initTimeout = setTimeout(() => {
        rejectInit(new Error('Pyodide initialization timed out (60s)'))
        this.terminate(sessionId)
      }, 60_000)

      worker.on('message', (msg: WorkerResponse) => {
        if (msg.type === 'ready') {
          clearTimeout(initTimeout)
          entry.ready = true
          log.info(`Python worker ready for session ${sessionId}`)
          onReady?.()
          resolveInit()
          return
        }

        // 处理执行结果
        if (msg.id) {
          const req = entry.pending.get(msg.id)
          if (req) {
            clearTimeout(req.timer)
            entry.pending.delete(msg.id)
            req.resolve(msg)
          }
        } else if (msg.type === 'error' && !msg.id) {
          // 初始化错误
          clearTimeout(initTimeout)
          rejectInit(new Error(msg.error || 'Unknown initialization error'))
          this.terminate(sessionId)
        }
      })

      worker.on('error', (err) => {
        clearTimeout(initTimeout)
        log.error(`Python worker error (session ${sessionId}):`, err)
        // 拒绝所有 pending 请求
        for (const [, req] of entry.pending) {
          clearTimeout(req.timer)
          req.reject(err)
        }
        entry.pending.clear()
        this.workers.delete(sessionId)
        rejectInit(err)
      })

      worker.on('exit', (code) => {
        log.info(`Python worker exited (session ${sessionId}, code ${code})`)
        for (const [, req] of entry.pending) {
          clearTimeout(req.timer)
          req.reject(new Error(`Worker exited with code ${code}`))
        }
        entry.pending.clear()
        this.workers.delete(sessionId)
      })

      // 发送初始化消息
      const mounts = this.buildMounts(config)
      const wheelsDir = this.getWheelsDir()
      worker.postMessage({ type: 'init', mounts, wheelsDir })
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
        // 超时 → 终止 worker（WASM 无法中断）
        log.warn(`Python execution timed out (${timeoutMs}ms), terminating worker`)
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

    log.info(`Terminating Python worker for session ${sessionId}`)
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

export const pythonWorkerManager = new PythonWorkerManager()
