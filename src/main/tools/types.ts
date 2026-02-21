/**
 * 工具共享类型与辅助函数
 * 所有工具通过 ToolContext + resolveProjectConfig 获取运行时项目配置
 */

import { join, resolve, sep } from 'path'
import { mkdirSync, existsSync } from 'fs'
import { app } from 'electron'
import { projectDao } from '../dao/projectDao'
import { sessionService } from '../services/sessionService'

/** 项目配置（工具执行时动态查询） */
export interface ProjectConfig {
  /** 项目工作目录（宿主机路径） */
  workingDirectory: string
  /** 是否启用 Docker 隔离 */
  dockerEnabled: boolean
  /** Docker 镜像名 */
  dockerImage: string
  /** 是否启用沙箱模式（限制文件越界 + bash 需确认） */
  sandboxEnabled: boolean
}

/** 工具上下文 — 所有工具共享的运行时信息 */
export interface ToolContext {
  /** 当前会话 ID（通过它查询项目配置 + Docker 容器管理） */
  sessionId: string
  /** Docker 容器创建时回调 */
  onContainerCreated?: (containerId: string) => void
  /** 沙箱模式下 bash 命令需用户确认，返回 true 表示允许执行 */
  requestApproval?: (toolCallId: string, command: string) => Promise<boolean>
}

/** 获取临时会话的工作目录 */
function getTempWorkspace(sessionId: string): string {
  const dir = join(app.getPath('userData'), 'temp_workspace', sessionId)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

/** 检查路径是否在工作目录内（沙箱路径越界检查） */
export function isPathWithinWorkspace(absolutePath: string, workingDirectory: string): boolean {
  const resolved = resolve(absolutePath)
  const base = resolve(workingDirectory)
  return resolved === base || resolved.startsWith(base + sep)
}

/** 通过 sessionId 查询当前项目配置（每次工具执行时调用，获取最新值） */
export function resolveProjectConfig(ctx: ToolContext): ProjectConfig {
  const session = sessionService.getById(ctx.sessionId)
  const project = session?.projectId ? projectDao.findById(session.projectId) : undefined

  if (project) {
    // 有项目 → 使用项目配置
    return {
      workingDirectory: session?.workingDirectory ?? project.path,
      dockerEnabled: project.dockerEnabled === 1,
      dockerImage: project.dockerImage || 'ubuntu:latest',
      sandboxEnabled: project.sandboxEnabled === 1
    }
  }

  // 无项目（临时会话） → 使用 temp workspace，强制开启沙箱
  return {
    workingDirectory: getTempWorkspace(ctx.sessionId),
    dockerEnabled: false,
    dockerImage: 'ubuntu:latest',
    sandboxEnabled: true
  }
}
