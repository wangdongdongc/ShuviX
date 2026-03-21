/**
 * SQL Worker 生命周期管理 — 单例服务
 * 支持两种模式：
 * - 内存模式：每个 session 独立 worker（key = session:${sessionId}）
 * - 持久化模式：同一项目共享 worker（key = project:${projectId}），数据存储到项目文件夹
 */

import { Worker } from 'worker_threads'
import { resolve, join } from 'path'
import { mkdirSync } from 'fs'
import { app } from 'electron'
import type { MountConfig, WorkerResponse } from '../tools/utils/sqlWorker'
import type { ProjectConfig } from '../tools/types'
import { createLogger } from '../logger'

const log = createLogger('SqlWorkerManager')

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

class SqlWorkerManager {
  /** workerKey → WorkerEntry */
  private workers = new Map<string, WorkerEntry>()
  /** sessionId → workerKey */
  private sessionToWorkerKey = new Map<string, string>()
  /** workerKey → init promise（防止并发初始化） */
  private initPromises = new Map<string, Promise<void>>()

  /** 获取 worker 脚本路径 */
  private getWorkerPath(): string {
    if (app.isPackaged) {
      return join(process.resourcesPath, 'app.asar.unpacked', 'out', 'main', 'sqlWorker.js')
    }
    return resolve(__dirname, 'sqlWorker.js')
  }

  /** 从 ProjectConfig 构建挂载配置 */
  private buildMounts(config: ProjectConfig): MountConfig[] {
    const mounts: MountConfig[] = [{ hostPath: config.workingDirectory, access: 'readwrite' }]
    for (const ref of config.referenceDirs) {
      mounts.push({
        hostPath: ref.path,
        access: ref.access ?? 'readonly'
      })
    }
    return mounts
  }

  /** 计算 worker key */
  private resolveWorkerKey(sessionId: string, config: ProjectConfig): string {
    if (config.pglitePersist && config.projectId) {
      return `project:${config.projectId}`
    }
    return `session:${sessionId}`
  }

  /** 确保 worker 已初始化并就绪 */
  async ensureReady(sessionId: string, config: ProjectConfig, onReady?: () => void): Promise<void> {
    const workerKey = this.resolveWorkerKey(sessionId, config)
    this.sessionToWorkerKey.set(sessionId, workerKey)

    const existing = this.workers.get(workerKey)
    if (existing?.ready) {
      existing.sessionRefs.add(sessionId)
      return
    }

    const pending = this.initPromises.get(workerKey)
    if (pending) {
      await pending
      // 初始化完成后将自身加入 sessionRefs
      const entry = this.workers.get(workerKey)
      entry?.sessionRefs.add(sessionId)
      return
    }

    const initPromise = this.createWorker(workerKey, sessionId, config, onReady)
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
    config: ProjectConfig,
    onReady?: () => void
  ): Promise<void> {
    const workerPath = this.getWorkerPath()
    const storageMode: SqlStorageMode = config.pglitePersist ? 'persistent' : 'memory'
    log.info(
      `Creating SQL worker [${workerKey}] (${storageMode}) for session ${sessionId}: ${workerPath}`
    )

    // 持久化模式：确保数据目录存在
    let dataDir: string | undefined
    if (storageMode === 'persistent' && config.projectPath) {
      dataDir = join(config.projectPath, '.shuvix', 'pglite', 'data')
      mkdirSync(dataDir, { recursive: true })
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
          log.info(`SQL worker ready [${workerKey}]`)
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
        log.error(`SQL worker error [${workerKey}]:`, err)
        for (const [, req] of entry.pending) {
          clearTimeout(req.timer)
          req.reject(err)
        }
        entry.pending.clear()
        // 清除所有 session 映射
        for (const sid of entry.sessionRefs) {
          this.sessionToWorkerKey.delete(sid)
        }
        this.workers.delete(workerKey)
        rejectInit(err)
      })

      worker.on('exit', (code) => {
        log.info(`SQL worker exited [${workerKey}], code ${code}`)
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
      const mounts = this.buildMounts(config)
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
        log.warn(`SQL execution timed out (${timeoutMs}ms), terminating worker [${workerKey}]`)
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
      log.info(
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

    log.info(`Terminating SQL worker [${workerKey}]`)
    for (const [, req] of entry.pending) {
      clearTimeout(req.timer)
      req.reject(new Error('Worker terminated'))
    }
    entry.pending.clear()
    entry.worker.terminate()
    // 清除所有 session 映射
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

export const sqlWorkerManager = new SqlWorkerManager()
