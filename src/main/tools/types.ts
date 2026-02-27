/**
 * 工具共享类型与辅助函数
 * 所有工具通过 ToolContext + resolveProjectConfig 获取运行时项目配置
 */

import { resolve, sep } from 'path'
import { projectDao } from '../dao/projectDao'
import { sessionService } from '../services/sessionService'
import { getTempWorkspace } from '../utils/paths'
import type { ReferenceDir } from '../types'

/** 中止操作的统一错误消息（用于 sentinel 检查） */
export const TOOL_ABORTED = 'Aborted'

/** 项目配置（工具执行时动态查询） */
export interface ProjectConfig {
  /** 项目工作目录（宿主机路径） */
  workingDirectory: string
  /** 是否启用沙箱模式（限制文件越界 + bash 需确认） */
  sandboxEnabled: boolean
  /** 参考目录列表（沙箱模式下按 access 属性控制读写权限） */
  referenceDirs: ReferenceDir[]
}

/** 工具上下文 — 所有工具共享的运行时信息 */
export interface ToolContext {
  /** 当前会话 ID（通过它查询项目配置 + Docker 容器管理） */
  sessionId: string
  /** Docker 容器创建时回调 */
  onContainerCreated?: (containerId: string, image: string) => void
  /** 沙箱模式下 bash 命令需用户确认，返回 approved=true 表示允许，reason 为用户拒绝时附加的说明 */
  requestApproval?: (toolCallId: string, command: string) => Promise<{ approved: boolean; reason?: string }>
  /** ask 工具：向用户提问并等待选择结果，返回用户选中的 label 列表 */
  requestUserInput?: (toolCallId: string, payload: UserInputPayload) => Promise<string[]>
  /** ssh 工具：请求用户输入 SSH 凭据（密码或密钥），凭据不经过大模型 */
  requestSshCredentials?: (toolCallId: string) => Promise<SshCredentialPayload | null>
  /** ssh 连接建立时回调 */
  onSshConnected?: (host: string, port: number, username: string) => void
  /** ssh 连接断开时回调 */
  onSshDisconnected?: (host: string, port: number, username: string) => void
}

/** SSH 凭据（仅在内存中传递，不持久化、不返回给大模型） */
export interface SshCredentialPayload {
  host: string
  port: number
  username: string
  /** 密码认证 */
  password?: string
  /** 私钥认证：私钥内容（PEM 格式） */
  privateKey?: string
  /** 私钥口令（如果私钥有加密） */
  passphrase?: string
}

/** ask 工具的用户输入请求数据 */
export interface UserInputPayload {
  question: string
  options: Array<{ label: string; description: string }>
  allowMultiple: boolean
}

/** 检查路径是否在工作目录内（沙箱路径越界检查） */
export function isPathWithinWorkspace(absolutePath: string, workingDirectory: string): boolean {
  const resolved = resolve(absolutePath)
  const base = resolve(workingDirectory)
  return resolved === base || resolved.startsWith(base + sep)
}

/** 检查路径是否在任一参考目录内 */
export function isPathWithinReferenceDirs(absolutePath: string, referenceDirs: ReferenceDir[]): boolean {
  const resolved = resolve(absolutePath)
  return referenceDirs.some(dir => {
    const base = resolve(dir.path)
    return resolved === base || resolved.startsWith(base + sep)
  })
}

/** 检查路径是否在某个 readwrite 参考目录内 */
export function isPathWithinReadwriteReferenceDirs(absolutePath: string, referenceDirs: ReferenceDir[]): boolean {
  const resolved = resolve(absolutePath)
  return referenceDirs.some(dir => {
    if ((dir.access ?? 'readonly') !== 'readwrite') return false
    const base = resolve(dir.path)
    return resolved === base || resolved.startsWith(base + sep)
  })
}

/**
 * 沙箱守卫：只读访问（workspace + referenceDirs 均允许）
 * 用于 read、ls、grep、glob 等只读工具
 */
export function assertSandboxRead(config: ProjectConfig, absolutePath: string, displayPath?: string): void {
  if (!config.sandboxEnabled) return
  if (isPathWithinWorkspace(absolutePath, config.workingDirectory)) return
  if (isPathWithinReferenceDirs(absolutePath, config.referenceDirs)) return
  const p = displayPath ?? absolutePath
  throw new Error(`Sandbox: access denied to path outside workspace: ${p}. Workspace: ${config.workingDirectory}`)
}

/**
 * 沙箱守卫：写入访问（workspace + readwrite 参考目录允许）
 * 用于 write、edit 等写入工具
 */
export function assertSandboxWrite(config: ProjectConfig, absolutePath: string, displayPath?: string): void {
  if (!config.sandboxEnabled) return
  if (isPathWithinWorkspace(absolutePath, config.workingDirectory)) return
  if (isPathWithinReadwriteReferenceDirs(absolutePath, config.referenceDirs)) return
  const p = displayPath ?? absolutePath
  // 区分只读参考目录和完全越界
  if (isPathWithinReferenceDirs(absolutePath, config.referenceDirs)) {
    throw new Error(`Sandbox: write denied — ${p} is inside a read-only reference directory. You can only read files from this directory.`)
  }
  throw new Error(`Sandbox: write denied to path outside workspace: ${p}. Workspace: ${config.workingDirectory}`)
}

/** 通过 sessionId 查询当前项目配置（每次工具执行时调用，获取最新值） */
export function resolveProjectConfig(ctx: ToolContext): ProjectConfig {
  const session = sessionService.getById(ctx.sessionId)
  const project = session?.projectId ? projectDao.findById(session.projectId) : undefined

  if (project) {
    // 有项目 → 使用项目配置
    let referenceDirs: ReferenceDir[] = []
    try {
      const settings = JSON.parse(project.settings || '{}')
      if (Array.isArray(settings.referenceDirs)) referenceDirs = settings.referenceDirs
    } catch { /* 忽略 */ }
    return {
      workingDirectory: session?.workingDirectory ?? project.path,
      sandboxEnabled: project.sandboxEnabled === 1,
      referenceDirs
    }
  }

  // 无项目（临时会话） → 使用 temp workspace，强制开启沙箱
  return {
    workingDirectory: getTempWorkspace(ctx.sessionId),
    sandboxEnabled: true,
    referenceDirs: []
  }
}
