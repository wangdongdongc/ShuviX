/**
 * Docker Operations 适配器
 * 仅隔离 bash 命令执行，read/write/edit 通过本地 fs 直接操作挂载的工作目录
 */

import type { DockerManager } from '../services/dockerManager'
import type { BashOperations } from './bash'

/**
 * 创建 Docker 模式下的工具操作实现
 * 只有 bash 在容器中执行，文件操作使用本地默认实现
 */
export function createDockerOperations(
  dockerManager: DockerManager,
  sessionId: string,
  image: string,
  workingDirectory: string
): { bash: BashOperations } {
  /** 确保容器运行中并返回 containerId */
  const getContainer = (): Promise<string> =>
    dockerManager.ensureContainer(sessionId, image, workingDirectory)

  const bashOps: BashOperations = {
    spawn: async (command, cwd, _timeout, _signal) => {
      const containerId = await getContainer()
      return dockerManager.exec(containerId, command, cwd)
    }
  }

  return {
    bash: bashOps
  }
}
