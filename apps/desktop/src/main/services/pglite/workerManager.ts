/**
 * PGLite Worker 生命周期管理
 *
 * 唯一寻址方式是 **workerKey + dataDir**（当前只有 widget 共享库一个消费者：
 * key='widgets:shared'，dataDir=~/.shuvix/widgets-db/data）。存储恒为持久化，
 * 不挂载任何宿主目录 —— 会话/项目级 pglite（内存模式、按项目共享、
 * `shuvix pglite` CLI）已整条移除。
 */

import { Worker } from 'worker_threads'
import { resolve, join } from 'path'
import { mkdirSync } from 'fs'
import { homedir } from 'os'
import { createLogger } from '../../logger'
import type { WorkerResponse } from './sqlWorker'

const log = createLogger('pglite:workerManager')

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

export class PgliteWorkerManager {
  /** workerKey → WorkerEntry */
  private workers = new Map<string, WorkerEntry>()
  /** workerKey → init promise（防止并发初始化） */
  private initPromises = new Map<string, Promise<void>>()

  /** 获取 worker 脚本路径 */
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

  /** 确保指定 workerKey 的 worker 已就绪（幂等；并发调用共享同一个 init promise） */
  async ensureWorkerByKey(workerKey: string, dataDir: string): Promise<void> {
    const existing = this.workers.get(workerKey)
    if (existing?.ready) return

    const pending = this.initPromises.get(workerKey)
    if (pending) {
      await pending
      return
    }

    const initPromise = this.createWorkerByKey(workerKey, dataDir)
    this.initPromises.set(workerKey, initPromise)
    try {
      await initPromise
    } finally {
      this.initPromises.delete(workerKey)
    }
  }

  private async createWorkerByKey(workerKey: string, dataDir: string): Promise<void> {
    const workerPath = this.getWorkerPath()
    log.info(`Creating SQL worker [${workerKey}] dataDir=${dataDir}`)

    mkdirSync(dataDir, { recursive: true })

    const worker = new Worker(workerPath)
    const entry: WorkerEntry = {
      worker,
      ready: false,
      pending: new Map()
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
          return
        }

        // 初始化错误（无 id）
        if (msg.type === 'error') {
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
          this.workers.delete(workerKey)
        }
      })

      worker.postMessage({ type: 'init', dataDir })
    })
  }

  /** 默认 widgets DB 数据目录（~/.shuvix/widgets-db/data） */
  static defaultWidgetsDbDir(): string {
    return join(homedir(), '.shuvix', 'widgets-db', 'data')
  }

  /** 在指定 worker 上跑 execute（psql 文本输出；widget db-query CLI 用） */
  async executeOnWorker(
    workerKey: string,
    id: string,
    sql: string,
    timeoutMs = 30_000
  ): Promise<WorkerResponse> {
    return this.dispatch(workerKey, id, timeoutMs, { type: 'execute', id, sql })
  }

  /** 在指定 worker 上跑结构化参数化查询（REST API 用）—— 返回行数组而非 psql 文本 */
  async queryOnWorker(
    workerKey: string,
    id: string,
    sql: string,
    params: unknown[],
    timeoutMs = 30_000
  ): Promise<WorkerResponse> {
    return this.dispatch(workerKey, id, timeoutMs, { type: 'query', id, sql, params })
  }

  /** execute / query 的共享投递路径（登记 pending + 超时后回收） */
  private dispatch(
    workerKey: string,
    id: string,
    timeoutMs: number,
    message: Record<string, unknown>
  ): Promise<WorkerResponse> {
    const entry = this.workers.get(workerKey)
    if (!entry?.ready) {
      throw new Error(`SQL worker [${workerKey}] not ready`)
    }
    return new Promise<WorkerResponse>((resolveResp, rejectResp) => {
      const timer = setTimeout(() => {
        entry.pending.delete(id)
        rejectResp(new Error(`SQL execution timed out (${timeoutMs / 1000}s)`))
      }, timeoutMs)
      entry.pending.set(id, { resolve: resolveResp, reject: rejectResp, timer })
      entry.worker.postMessage(message)
    })
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
    this.workers.delete(workerKey)
  }

  /** 终止所有 worker（应用退出时调用） */
  terminateAll(): void {
    for (const [workerKey] of this.workers) {
      this.terminateWorker(workerKey)
    }
  }
}

export const pgliteWorkerManager = new PgliteWorkerManager()
