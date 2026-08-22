/**
 * 允许列表工具 —— 实现已下沉 @shuvix/agent-runtime（security/allowEntries，两端共用，
 * sep 参数化；「命令类条目不再识别」的完整 rationale 见那里的文件头注释）。
 * 此处保留桌面便捷封装：绑定 Node path.sep，维持既有三参签名。
 */
import { sep } from 'path'
import {
  parseAllowEntry,
  buildAllowEntry,
  matchesPathEntry as coreMatchesPathEntry,
  isPathAllowedUnified as coreIsPathAllowedUnified,
  type AllowToolType
} from '@shuvix/agent-runtime'

export { parseAllowEntry, buildAllowEntry }
export type { AllowToolType }

/** 路径前缀匹配（绑定平台 sep；语义见 agent-runtime security/allowEntries） */
export function matchesPathEntry(entryPath: string, absolutePath: string): boolean {
  return coreMatchesPathEntry(entryPath, absolutePath, sep)
}

/** 统一路径允许列表检查（绑定平台 sep） */
export function isPathAllowedUnified(
  allowList: string[] | undefined,
  mode: AllowToolType,
  absolutePath: string
): boolean {
  return coreIsPathAllowedUnified(allowList, mode, absolutePath, sep)
}
