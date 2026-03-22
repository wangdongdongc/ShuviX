/**
 * PGLite Worker 生命周期管理
 * 支持两种模式：
 * - 内存模式：每个 session 独立 worker（key = session:${sessionId}）
 * - 持久化模式：同一项目共享 worker（key = workingDirectory），数据存储到项目文件夹
 */

import { Worker } from 'worker_threads'
import { resolve, join } from 'path'
import { mkdirSync } from 'fs'
import type { PluginContext } from '../../plugin-api'
import type { MountConfig, WorkerResponse } from './sqlWorker'

export type SqlStorageMode = 'memory' | 'persistent'

interface PendingRequest {
  resolve: (value: WorkerResponse) => void
  reject: (reason: unknown) => void
  timer: ReturnType<typeof setTimeout>
}

interface WorkerEntry {
  worker: Worker
  ready: boolean
  pending: Map<string, PendingRequest>
  /** 存储模式 */
  storageMode: SqlStorageMode
  /** 使用此 worker 的 session 集合（持久化模式下可能有多个） */
  sessionRefs: Set<string>
}

export class PgliteWorkerManager {
  /** workerKey → WorkerEntry */
  private workers = new Map<string, WorkerEntry>()
  /** sessionId → workerKey */
  private sessionToWorkerKey = new Map<string, string>()
  /** workerKey → init promise（防止并发初始化） */
  private initPromises = new Map<string, Promise<void>>()

  constructor(private ctx: PluginContext) {}

  /** 获取 worker 脚本路径（与 Pyodide 插件相同的模式：运行时 require electron） */
  private getWorkerPath(): string {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { app } = require('electron') as typeof import('electron')
      if (app.isPackaged) {
        return join(process.resourcesPath, 'app.asar.unpacked', 'out', 'main', 'sqlWorker.js')
      }
    } catch {
      // 测试环境无 electron
    }
    return resolve(__dirname, 'sqlWorker.js')
  }

  /** 确保 worker 已初始化并就绪 */
  async ensureReady(sessionId: string, onReady?: () => void): Promise<void> {
    const paths = this.ctx.getSessionPaths(sessionId)
    const persist = !!paths.persist
    const workerKey = persist ? paths.workingDirectory : `session:${sessionId}`

    this.sessionToWorkerKey.set(sessionId, workerKey)

    const existing = this.workers.get(workerKey)
    if (existing?.ready) {
      existing.sessionRefs.add(sessionId)
      return
    }

    const pending = this.initPromises.get(workerKey)
    if (pending) {
      await pending
      const entry = this.workers.get(workerKey)
      entry?.sessionRefs.add(sessionId)
      return
    }

    const initPromise = this.createWorker(
      workerKey,
      sessionId,
      paths.workingDirectory,
      persist,
      onReady
    )
    this.initPromises.set(workerKey, initPromise)
    try {
      await initPromise
    } finally {
      this.initPromises.delete(workerKey)
    }
  }

  private async createWorker(
    workerKey: string,
    sessionId: string,
    workingDirectory: string,
    persist: boolean,
    onReady?: () => void
  ): Promise<void> {
    const workerPath = this.getWorkerPath()
    const storageMode: SqlStorageMode = persist ? 'persistent' : 'memory'
    this.ctx.logger.info(
      `Creating SQL worker [${workerKey}] (${storageMode}) for session ${sessionId}: ${workerPath}`
    )

    // 持久化模式：确保数据目录存在
    let dataDir: string | undefined
    if (persist) {
      dataDir = join(workingDirectory, '.shuvix', 'pglite', 'data')
      mkdirSync(dataDir, { recursive: true })
    }

    // 构建挂载配置
    const paths = this.ctx.getSessionPaths(sessionId)
    const mounts: MountConfig[] = [{ hostPath: workingDirectory, access: 'readwrite' }]
    for (const ref of paths.referenceDirs) {
      mounts.push({ hostPath: ref.path, access: ref.access ?? 'readonly' })
    }

    const worker = new Worker(workerPath)
    const entry: WorkerEntry = {
      worker,
      ready: false,
      pending: new Map(),
      storageMode,
      sessionRefs: new Set([sessionId])
    }
    this.workers.set(workerKey, entry)

    return new Promise<void>((resolveInit, rejectInit) => {
      const initTimeout = setTimeout(() => {
        rejectInit(new Error('PGLite initialization timed out (60s)'))
        this.terminateWorker(workerKey)
      }, 60_000)

      worker.on('message', (msg: WorkerResponse) => {
        if (msg.type === 'ready') {
          clearTimeout(initTimeout)
          entry.ready = true
          this.ctx.logger.info(`SQL worker ready [${workerKey}]`)
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
          this.terminateWorker(workerKey)
        }
      })

      worker.on('error', (err) => {
        clearTimeout(initTimeout)
        this.ctx.logger.error(`SQL worker error [${workerKey}]:`, err)
        for (const [, req] of entry.pending) {
          clearTimeout(req.timer)
          req.reject(err)
        }
        entry.pending.clear()
        for (const sid of entry.sessionRefs) {
          this.sessionToWorkerKey.delete(sid)
        }
        this.workers.delete(workerKey)
        rejectInit(err)
      })

      worker.on('exit', (code) => {
        this.ctx.logger.info(`SQL worker exited [${workerKey}], code ${code}`)
        if (this.workers.get(workerKey) === entry) {
          for (const [, req] of entry.pending) {
            clearTimeout(req.timer)
            req.reject(new Error(`Worker exited with code ${code}`))
          }
          entry.pending.clear()
          for (const sid of entry.sessionRefs) {
            this.sessionToWorkerKey.delete(sid)
          }
          this.workers.delete(workerKey)
        }
      })

      // 发送初始化消息
      worker.postMessage({ type: 'init', mounts, dataDir })
    })
  }

  /** 执行 SQL */
  async execute(
    sessionId: string,
    id: string,
    sql: string,
    extensions?: string[],
    timeoutMs = 30_000
  ): Promise<WorkerResponse> {
    const workerKey = this.sessionToWorkerKey.get(sessionId)
    const entry = workerKey ? this.workers.get(workerKey) : undefined
    if (!entry?.ready) {
      throw new Error('SQL worker not ready')
    }

    return new Promise<WorkerResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        entry.pending.delete(id)
        this.ctx.logger.warn(
          `SQL execution timed out (${timeoutMs}ms), terminating worker [${workerKey}]`
        )
        this.terminate(sessionId)
        reject(new Error(`SQL execution timed out (${timeoutMs / 1000}s)`))
      }, timeoutMs)

      entry.pending.set(id, { resolve, reject, timer })
      entry.worker.postMessage({ type: 'execute', id, sql, extensions })
    })
  }

  /** 查询 session 的 SQL 运行时状态 */
  getStatus(sessionId: string): { ready: boolean; storageMode: SqlStorageMode } | null {
    const workerKey = this.sessionToWorkerKey.get(sessionId)
    if (!workerKey) return null
    const entry = this.workers.get(workerKey)
    if (!entry?.ready) return null
    return { ready: true, storageMode: entry.storageMode }
  }

  /** 检查 session 是否有活跃的 worker */
  isActive(sessionId: string): boolean {
    const workerKey = this.sessionToWorkerKey.get(sessionId)
    return !!workerKey && this.workers.has(workerKey)
  }

  /**
   * 终止指定 session 的 worker
   * - 内存模式：直接终止
   * - 持久化模式：从 sessionRefs 移除，仅当最后一个 session 离开时才终止 worker
   */
  terminate(sessionId: string): void {
    const workerKey = this.sessionToWorkerKey.get(sessionId)
    if (!workerKey) return
    const entry = this.workers.get(workerKey)
    if (!entry) return

    this.sessionToWorkerKey.delete(sessionId)
    entry.sessionRefs.delete(sessionId)

    // 持久化模式：仍有其他 session 引用则不终止
    if (entry.storageMode === 'persistent' && entry.sessionRefs.size > 0) {
      this.ctx.logger.info(
        `Session ${sessionId} detached from shared worker [${workerKey}], ${entry.sessionRefs.size} refs remaining`
      )
      return
    }

    this.terminateWorker(workerKey)
  }

  /** 强制终止指定 workerKey 的 worker */
  private terminateWorker(workerKey: string): void {
    const entry = this.workers.get(workerKey)
    if (!entry) return

    this.ctx.logger.info(`Terminating SQL worker [${workerKey}]`)
    for (const [, req] of entry.pending) {
      clearTimeout(req.timer)
      req.reject(new Error('Worker terminated'))
    }
    entry.pending.clear()
    entry.worker.terminate()
    for (const sid of entry.sessionRefs) {
      this.sessionToWorkerKey.delete(sid)
    }
    this.workers.delete(workerKey)
  }

  /** 终止所有 worker（应用退出时调用） */
  terminateAll(): void {
    for (const [workerKey] of this.workers) {
      this.terminateWorker(workerKey)
    }
  }
}
