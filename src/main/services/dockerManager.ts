/**
 * Docker 容器管理器
 * 管理 per-session 的 Docker 容器生命周期
 * 容器在首次工具调用时创建，同一 AI 回复内复用
 * agent_end 后延迟销毁（空闲超时），新消息到来时取消定时器复用容器
 */

import { spawn, spawnSync } from 'child_process'
import { createLogger } from '../logger'
import type { ReferenceDir } from '../types'
const log = createLogger('Docker')

/** 补充 macOS 打包应用中缺失的常见路径（Finder 启动时 PATH 极简） */
const EXTRA_PATHS = ['/usr/local/bin', '/opt/homebrew/bin', '/opt/homebrew/sbin']
const mergedPATH = [...new Set([...(process.env.PATH?.split(':') ?? []), ...EXTRA_PATHS])].join(':')
const spawnEnv: NodeJS.ProcessEnv = { ...process.env, PATH: mergedPATH }

/** 容器空闲超时时间（毫秒），超过此时间无命令执行则自动销毁 */
const IDLE_TIMEOUT_MS = 10 * 60 * 1000 // 10 分钟

/** 容器信息（含可选的延迟销毁定时器） */
interface ContainerInfo {
  containerId: string
  image: string
  workingDirectory: string
  /** 空闲超时销毁定时器（agent_end 后设置，新命令到来时取消） */
  destroyTimer?: ReturnType<typeof setTimeout>
}

export class DockerManager {
  /** sessionId → 容器信息（含延迟销毁定时器） */
  private containers = new Map<string, ContainerInfo>()

  /** 检测 Docker 状态：'ready' | 'notInstalled' | 'notRunning' */
  getDockerStatus(): 'ready' | 'notInstalled' | 'notRunning' {
    try {
      // 先检查 CLI 是否存在
      const cliResult = spawnSync('docker', ['--version'], {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: spawnEnv
      })
      if (cliResult.status !== 0 || !cliResult.stdout?.trim()) {
        return 'notInstalled'
      }
      // CLI 存在，检查引擎是否在运行
      const serverResult = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: spawnEnv
      })
      if (serverResult.status !== 0 || !serverResult.stdout?.trim()) {
        return 'notRunning'
      }
      return 'ready'
    } catch {
      return 'notInstalled'
    }
  }

  /** 查询指定 session 的容器信息（不含敏感数据），无容器则返回 null */
  getContainerInfo(sessionId: string): { containerId: string; image: string } | null {
    const info = this.containers.get(sessionId)
    if (!info) return null
    return { containerId: info.containerId, image: info.image }
  }

  /** 检测 Docker 是否可用（向后兼容） */
  isDockerAvailable(): boolean {
    return this.getDockerStatus() === 'ready'
  }

  /**
   * 校验 Docker 环境
   * - 不传 image：仅检查 Docker 命令是否可用
   * - 传 image：完整校验（命令可用 → 镜像存在 → 镜像支持 bash）
   * 返回 { ok, error? } — error 为具体失败原因的 i18n key
   */
  async validateSetup(image?: string): Promise<{ ok: boolean; error?: string }> {
    // 1. Docker 命令可用 + 引擎运行中
    const status = this.getDockerStatus()
    if (status === 'notInstalled') {
      return { ok: false, error: 'dockerNotInstalled' }
    }
    if (status === 'notRunning') {
      return { ok: false, error: 'dockerNotRunning' }
    }

    // 仅检查可用性时到此返回
    if (!image) return { ok: true }

    // 2. 镜像是否在本地存在（不自动 pull，避免长时间阻塞）
    try {
      const inspectResult = spawnSync('docker', ['image', 'inspect', image], {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: spawnEnv
      })
      if (inspectResult.status !== 0) {
        return { ok: false, error: 'dockerImageNotFound' }
      }
    } catch {
      return { ok: false, error: 'dockerImageNotFound' }
    }

    // 3. 镜像是否支持 bash
    try {
      const bashResult = spawnSync('docker', ['run', '--rm', image, 'bash', '-c', 'echo ok'], {
        encoding: 'utf-8',
        timeout: 15000,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: spawnEnv
      })
      if (bashResult.status !== 0 || !bashResult.stdout?.includes('ok')) {
        return { ok: false, error: 'dockerNoBash' }
      }
    } catch {
      return { ok: false, error: 'dockerNoBash' }
    }

    return { ok: true }
  }

  /** 为 session 确保容器运行中（已有则复用，自动取消待销毁定时器） */
  async ensureContainer(
    sessionId: string,
    image: string,
    workingDirectory: string,
    opts?: { memory?: string; cpus?: string; referenceDirs?: ReferenceDir[] }
  ): Promise<{ containerId: string; isNew: boolean }> {
    // 如果有待销毁定时器，取消它（复用容器）
    this.cancelScheduledDestroy(sessionId)

    const existing = this.containers.get(sessionId)
    if (existing) {
      // 检查容器是否仍在运行
      if (this.isContainerRunning(existing.containerId)) {
        return { containerId: existing.containerId, isNew: false }
      }
      // 容器已停止，清理引用
      this.containers.delete(sessionId)
    }

    // 创建新容器
    const containerName = `shuvix-${sessionId.replace(/-/g, '')}`
    const containerId = await this.createContainer(containerName, image, workingDirectory, opts)
    this.containers.set(sessionId, { containerId, image, workingDirectory })
    log.info(`创建容器 ${containerId.slice(0, 12)}`)
    return { containerId, isNew: true }
  }

  /** 在容器中执行命令 */
  async exec(
    containerId: string,
    command: string,
    cwd: string,
    signal?: AbortSignal
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('操作已中止'))
        return
      }

      const child = spawn('docker', ['exec', '-w', cwd, containerId, 'bash', '-c', command], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: spawnEnv
      })

      let stdout = ''
      let stderr = ''
      let aborted = false

      child.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString('utf-8')
      })
      child.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString('utf-8')
      })

      // abort 处理：终止 docker exec 子进程
      const onAbort = (): void => {
        aborted = true
        child.kill('SIGTERM')
      }
      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true })
      }

      child.on('close', (code) => {
        if (signal) signal.removeEventListener('abort', onAbort)
        if (aborted) {
          reject(new Error('操作已中止'))
          return
        }
        resolve({ stdout, stderr, exitCode: code ?? 1 })
      })

      child.on('error', (err) => {
        if (signal) signal.removeEventListener('abort', onAbort)
        reject(err)
      })
    })
  }

  /**
   * 延迟销毁容器 — agent_end 后调用，空闲超时后自动销毁
   * @param onDestroyed 实际销毁时的回调（用于发送 docker_event）
   */
  scheduleDestroy(sessionId: string, onDestroyed?: (containerId: string) => void): void {
    const info = this.containers.get(sessionId)
    if (!info) return

    // 如果已有待销毁定时器，先取消
    this.cancelScheduledDestroy(sessionId)

    const containerId = info.containerId
    log.info(`容器 ${containerId.slice(0, 12)} 将在 ${IDLE_TIMEOUT_MS / 1000}s 空闲后销毁`)

    info.destroyTimer = setTimeout(() => {
      info.destroyTimer = undefined
      this.doDestroy(sessionId)
        .then((destroyed) => {
          if (destroyed) onDestroyed?.(containerId)
        })
        .catch((err) => log.error(`延迟销毁容器失败: ${err}`))
    }, IDLE_TIMEOUT_MS)
  }

  /** 取消延迟销毁定时器（复用容器时调用） */
  cancelScheduledDestroy(sessionId: string): boolean {
    const info = this.containers.get(sessionId)
    if (info?.destroyTimer) {
      clearTimeout(info.destroyTimer)
      info.destroyTimer = undefined
      log.info(`取消容器 ${info.containerId.slice(0, 12)} 的延迟销毁`)
      return true
    }
    return false
  }

  /** 立刻销毁指定 session 的容器（返回 containerId，未找到返回 null） */
  async destroyContainer(sessionId: string): Promise<string | null> {
    // 先取消可能存在的延迟销毁
    this.cancelScheduledDestroy(sessionId)
    return this.doDestroy(sessionId).then((destroyed) => destroyed)
  }

  /** 销毁所有容器（应用退出时调用） */
  async destroyAll(): Promise<void> {
    const entries = Array.from(this.containers.entries())
    this.containers.clear()
    for (const [, info] of entries) {
      if (info.destroyTimer) clearTimeout(info.destroyTimer)
      try {
        spawnSync('docker', ['rm', '-f', info.containerId], {
          timeout: 10000,
          stdio: 'ignore',
          env: spawnEnv
        })
        log.info(`清理容器 ${info.containerId.slice(0, 12)}`)
      } catch {
        // 忽略错误
      }
    }
  }

  /** 内部执行实际销毁逻辑，返回 containerId 或 null */
  private async doDestroy(sessionId: string): Promise<string | null> {
    const info = this.containers.get(sessionId)
    if (!info) return null

    this.containers.delete(sessionId)
    try {
      spawnSync('docker', ['rm', '-f', info.containerId], {
        timeout: 10000,
        stdio: 'ignore',
        env: spawnEnv
      })
    } catch (e) {
      log.error(`销毁容器失败: ${e}`)
      return null
    }
    log.info(`销毁容器 ${info.containerId.slice(0, 12)}`)
    return info.containerId
  }

  /** 创建并启动容器 */
  private async createContainer(
    name: string,
    image: string,
    workingDirectory: string,
    opts?: { memory?: string; cpus?: string; referenceDirs?: ReferenceDir[] }
  ): Promise<string> {
    // 先尝试移除同名旧容器
    try {
      spawnSync('docker', ['rm', '-f', name], { timeout: 5000, stdio: 'ignore', env: spawnEnv })
    } catch {
      // 忽略
    }

    return new Promise((resolve, reject) => {
      const args = [
        'run',
        '-d',
        '--rm',
        '-v',
        `${workingDirectory}:${workingDirectory}`,
        '-w',
        workingDirectory,
        '--name',
        name
      ]
      // 挂载参考目录（与宿主机路径一致）：readonly 用 :ro，readwrite 正常挂载
      if (opts?.referenceDirs) {
        for (const dir of opts.referenceDirs) {
          const roFlag = (dir.access ?? 'readonly') === 'readonly' ? ':ro' : ''
          args.push('-v', `${dir.path}:${dir.path}${roFlag}`)
        }
      }
      // 资源限制
      if (opts?.memory) args.push('--memory', opts.memory)
      if (opts?.cpus) args.push('--cpus', opts.cpus)
      args.push(image, 'tail', '-f', '/dev/null')

      const child = spawn('docker', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: spawnEnv
      })

      let stdout = ''
      let stderr = ''

      child.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString('utf-8')
      })
      child.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString('utf-8')
      })

      child.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`Docker 容器创建失败: ${stderr}`))
        } else {
          resolve(stdout.trim())
        }
      })

      child.on('error', reject)
    })
  }

  /** 检查容器是否仍在运行 */
  private isContainerRunning(containerId: string): boolean {
    try {
      const result = spawnSync('docker', ['inspect', '-f', '{{.State.Running}}', containerId], {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: spawnEnv
      })
      return result.status === 0 && result.stdout.trim() === 'true'
    } catch {
      return false
    }
  }
}

// 全局单例
export const dockerManager = new DockerManager()
