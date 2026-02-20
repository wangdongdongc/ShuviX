/**
 * 工具共享类型与辅助函数
 * 所有工具通过 ToolContext + resolveProjectConfig 获取运行时项目配置
 */

import { sessionDao } from '../dao/sessionDao'
import { projectDao } from '../dao/projectDao'

/** 项目配置（工具执行时动态查询） */
export interface ProjectConfig {
  /** 项目工作目录（宿主机路径） */
  workingDirectory: string
  /** 是否启用 Docker 隔离 */
  dockerEnabled: boolean
  /** Docker 镜像名 */
  dockerImage: string
}

/** 工具上下文 — 所有工具共享的运行时信息 */
export interface ToolContext {
  /** 当前会话 ID（通过它查询项目配置 + Docker 容器管理） */
  sessionId: string
  /** Docker 容器创建时回调 */
  onContainerCreated?: (containerId: string) => void
}

/** 通过 sessionId 查询当前项目配置（每次工具执行时调用，获取最新值） */
export function resolveProjectConfig(ctx: ToolContext): ProjectConfig {
  const session = sessionDao.findById(ctx.sessionId)
  const project = session?.projectId ? projectDao.findById(session.projectId) : undefined
  return {
    workingDirectory: project?.path || process.cwd(),
    dockerEnabled: project ? project.dockerEnabled === 1 : false,
    dockerImage: project?.dockerImage || 'ubuntu:latest'
  }
}
