/**
 * Agent 档案注册表接口 —— 纯 md 驱动：文件存在即可用，无启用开关/禁用集。
 *
 * 合并规则（两端共用语义，由各宿主实现）：用户同名覆盖内置。
 * 'default' 的内置兜底由宿主 registry 的 getProfile 保证（内置列表经 buildBuiltinProfiles
 * 现算,恒含 default —— 即使用户覆盖版损坏,主会话创建也永不失败于档案缺失）。
 */
import type { AgentProfile } from '../subagent/types'

/** 注册表（桌面 agentService 文件系统实现；扩展常量实现） */
export interface AgentProfileRegistry {
  /** 列出全部档案（用户同名覆盖内置后的合并结果） */
  listAll: () => AgentProfile[]
  /** 按名取档案（'default' 由实现方以内置现算结果兜底） */
  getProfile: (name: string) => AgentProfile | undefined
}
