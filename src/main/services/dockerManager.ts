/**
 * Docker 容器管理器
 * 管理 per-session 的 Docker 容器生命周期
 * 容器在首次工具调用时创建，同一 AI 回复内复用，agent_end 后销毁
 */

import { spawn, spawnSync } from 'child_process'

/** 容器内固定工作目录，避免与容器自身路径冲突 */
export const CONTAINER_WORKSPACE = '/isolated-docker-workspace'

/** 容器信息 */
interface ContainerInfo {
  containerId: string
  image: string
  workingDirectory: string
}

export class DockerManager {
  /** sessionId → 容器信息 */
  private containers = new Map<string, ContainerInfo>()

  /** 检测 Docker 是否可用 */
  isDockerAvailable(): boolean {
    try {
      const result = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      return result.status === 0 && !!result.stdout.trim()
    } catch {
      return false
    }
  }

  /**
   * 校验 Docker 环境
   * - 不传 image：仅检查 Docker 命令是否可用
   * - 传 image：完整校验（命令可用 → 镜像存在 → 镜像支持 bash）
   * 返回 { ok, error? } — error 为具体失败原因的 i18n key
   */
  async validateSetup(image?: string): Promise<{ ok: boolean; error?: string }> {
    // 1. Docker 命令可用
    if (!this.isDockerAvailable()) {
      return { ok: false, error: 'dockerNotAvailable' }
    }

    // 仅检查可用性时到此返回
    if (!image) return { ok: true }

    // 2. 镜像是否在本地存在（不自动 pull，避免长时间阻塞）
    try {
      const inspectResult = spawnSync('docker', ['image', 'inspect', image], {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'pipe']
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
        stdio: ['ignore', 'pipe', 'pipe']
      })
      if (bashResult.status !== 0 || !bashResult.stdout?.includes('ok')) {
        return { ok: false, error: 'dockerNoBash' }
      }
    } catch {
      return { ok: false, error: 'dockerNoBash' }
    }

    return { ok: true }
  }

  /** 为 session 确保容器运行中（已有则复用） */
  async ensureContainer(
    sessionId: string,
    image: string,
    workingDirectory: string
  ): Promise<{ containerId: string; isNew: boolean }> {
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
    const containerId = await this.createContainer(containerName, image, workingDirectory)
    this.containers.set(sessionId, { containerId, image, workingDirectory })
    console.log(`[Docker] 创建容器 ${containerId.slice(0, 12)}`)
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

      const child = spawn('docker', [
        'exec',
        '-w', cwd,
        containerId,
        'bash', '-c', command
      ], {
        stdio: ['ignore', 'pipe', 'pipe']
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

  /** 销毁指定 session 的容器 */
  async destroyContainer(sessionId: string): Promise<boolean> {

    return new Promise((resolve, reject) => {
      const info = this.containers.get(sessionId)
      if (!info) {
        resolve(false)
        return
      }

      this.containers.delete(sessionId)
      try {
        spawnSync('docker', ['rm', '-f', info.containerId], {
        timeout: 10000,
        stdio: 'ignore'
      })
      } catch (e) {
        reject(e)
      }
      console.log(`[Docker] 销毁容器 ${info.containerId.slice(0, 12)}`)
      resolve(true)
    })
  }

  /** 销毁所有容器（应用退出时调用） */
  async destroyAll(): Promise<void> {
    const entries = Array.from(this.containers.entries())
    this.containers.clear()
    for (const [_, info] of entries) {
      try {
        spawnSync('docker', ['rm', '-f', info.containerId], {
          timeout: 10000,
          stdio: 'ignore'
        })
        console.log(`[Docker] 清理容器 ${info.containerId.slice(0, 12)}`)
      } catch {
        // 忽略错误
      }
    }
  }

  /** 创建并启动容器 */
  private async createContainer(
    name: string,
    image: string,
    workingDirectory: string
  ): Promise<string> {
    // 先尝试移除同名旧容器
    try {
      spawnSync('docker', ['rm', '-f', name], { timeout: 5000, stdio: 'ignore' })
    } catch {
      // 忽略
    }

    return new Promise((resolve, reject) => {
      const child = spawn('docker', [
        'run', '-d', '--rm',
        '-v', `${workingDirectory}:${CONTAINER_WORKSPACE}`,
        '-w', CONTAINER_WORKSPACE,
        '--name', name,
        image,
        'tail', '-f', '/dev/null'
      ], {
        stdio: ['ignore', 'pipe', 'pipe']
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
        stdio: ['ignore', 'pipe', 'pipe']
      })
      return result.status === 0 && result.stdout.trim() === 'true'
    } catch {
      return false
    }
  }
}

// 全局单例
export const dockerManager = new DockerManager()
