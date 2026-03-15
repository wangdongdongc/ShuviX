import { createWriteStream, existsSync, unlinkSync, renameSync } from 'fs'
import { BrowserWindow } from 'electron'
import { createLogger } from '../logger'

const log = createLogger('DownloadManager')

/** 下载任务定义 */
export interface DownloadTask {
  /** 任务唯一标识 */
  id: string
  /** 下载 URL */
  url: string
  /** 目标文件路径 */
  destPath: string
}

/** 下载进度信息 */
export interface DownloadProgress {
  taskId: string
  percent: number
  downloadedBytes: number
  totalBytes: number
  speedBytesPerSec: number
  etaSeconds: number
}

interface ActiveTask {
  controller: AbortController
  progress: DownloadProgress
  startTime: number
  lastSampleTime: number
  lastSampleBytes: number
}

/**
 * 通用下载管理服务 — 管理多个并发下载任务，广播进度到所有渲染窗口
 */
class DownloadManager {
  private tasks = new Map<string, ActiveTask>()

  /** 开始下载，返回目标文件路径。失败抛异常 */
  async start(task: DownloadTask): Promise<string> {
    if (this.tasks.has(task.id)) {
      throw new Error(`Download task "${task.id}" is already running`)
    }

    const controller = new AbortController()
    const now = Date.now()
    const activeTask: ActiveTask = {
      controller,
      progress: {
        taskId: task.id,
        percent: 0,
        downloadedBytes: 0,
        totalBytes: 0,
        speedBytesPerSec: 0,
        etaSeconds: 0
      },
      startTime: now,
      lastSampleTime: now,
      lastSampleBytes: 0
    }
    this.tasks.set(task.id, activeTask)

    const tmpPath = task.destPath + '.download'

    try {
      log.info(`Starting download: ${task.id} → ${task.url}`)

      const response = await fetch(task.url, {
        signal: controller.signal,
        redirect: 'follow'
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }

      const totalBytes = Number(response.headers.get('content-length')) || 0
      activeTask.progress.totalBytes = totalBytes

      if (!response.body) {
        throw new Error('Response body is null')
      }

      const fileStream = createWriteStream(tmpPath)
      const reader = response.body.getReader()
      let downloadedBytes = 0

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        fileStream.write(Buffer.from(value))
        downloadedBytes += value.byteLength

        // 更新进度
        activeTask.progress.downloadedBytes = downloadedBytes
        activeTask.progress.percent = totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 0

        // 每 500ms 计算速度和 ETA
        const now = Date.now()
        const sampleElapsed = now - activeTask.lastSampleTime
        if (sampleElapsed >= 500) {
          const bytesDelta = downloadedBytes - activeTask.lastSampleBytes
          activeTask.progress.speedBytesPerSec = Math.round((bytesDelta / sampleElapsed) * 1000)
          const remaining = totalBytes - downloadedBytes
          activeTask.progress.etaSeconds =
            activeTask.progress.speedBytesPerSec > 0
              ? Math.round(remaining / activeTask.progress.speedBytesPerSec)
              : 0
          activeTask.lastSampleTime = now
          activeTask.lastSampleBytes = downloadedBytes
          this.broadcast(activeTask.progress)
        }
      }

      await new Promise<void>((resolve, reject) => {
        fileStream.end(() => {
          fileStream.close((err) => (err ? reject(err) : resolve()))
        })
      })

      // 下载完成，重命名到最终路径
      renameSync(tmpPath, task.destPath)

      // 发送 100% 进度
      activeTask.progress.percent = 100
      activeTask.progress.downloadedBytes = totalBytes || downloadedBytes
      activeTask.progress.speedBytesPerSec = 0
      activeTask.progress.etaSeconds = 0
      this.broadcast(activeTask.progress)

      log.info(`Download complete: ${task.id} (${downloadedBytes} bytes)`)
      return task.destPath
    } catch (err) {
      // 清理不完整文件
      if (existsSync(tmpPath)) {
        try {
          unlinkSync(tmpPath)
        } catch {
          /* ignore */
        }
      }

      if ((err as Error).name === 'AbortError') {
        log.info(`Download cancelled: ${task.id}`)
        throw new Error('Download cancelled')
      }

      log.error(`Download failed: ${task.id} — ${err}`)
      throw err
    } finally {
      this.tasks.delete(task.id)
    }
  }

  /** 取消指定任务 */
  cancel(taskId: string): void {
    const task = this.tasks.get(taskId)
    if (task) {
      task.controller.abort()
    }
  }

  /** 获取指定任务的当前进度（不存在则返回 undefined） */
  getProgress(taskId: string): DownloadProgress | undefined {
    return this.tasks.get(taskId)?.progress
  }

  /** 是否有正在运行的任务 */
  isRunning(taskId: string): boolean {
    return this.tasks.has(taskId)
  }

  /** 广播进度到所有渲染窗口 */
  private broadcast(progress: DownloadProgress): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('download:progress', progress)
      }
    }
  }
}

export const downloadManager = new DownloadManager()
