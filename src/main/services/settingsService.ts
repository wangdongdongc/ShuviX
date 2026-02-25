import { settingsDao } from '../dao/settingsDao'

// ---------- 设置元数据注册表 ----------

export interface SettingMeta {
  /** 对应设置页面的 i18n key（用于前端展示） */
  labelKey: string
  /** AI 可读描述（用于工具参数 description 和 prompt） */
  desc: string
}

/**
 * 所有已知系统设置的元数据注册表
 * 新增设置时在此追加一行，工具参数描述、AI prompt、审批弹窗标签自动同步
 */
export const KNOWN_SETTINGS: Record<string, SettingMeta> = {
  'general.theme': { labelKey: 'settings.theme', desc: 'dark | light | system' },
  'general.language': { labelKey: 'settings.language', desc: 'zh | en | ja' },
  'general.fontSize': { labelKey: 'settings.fontSize', desc: 'number as string, 12-20' },
  'general.defaultProvider': { labelKey: 'settings.defaultProvider', desc: 'provider id' },
  'general.defaultModel': { labelKey: 'settings.defaultModel', desc: 'model id' },
  'general.systemPrompt': { labelKey: 'settings.systemPrompt', desc: 'global system prompt text' },
  'tool.bash.dockerEnabled': { labelKey: 'settings.toolBashDocker', desc: 'true | false — run bash commands in Docker container' },
  'tool.bash.dockerImage': { labelKey: 'settings.toolBashImage', desc: 'Docker image name, e.g. "python:latest"' },
  'tool.bash.dockerMemory': { labelKey: 'settings.toolBashMemory', desc: 'Container memory limit, e.g. "512m", "1g", "2g" (empty = unlimited)' },
  'tool.bash.dockerCpus': { labelKey: 'settings.toolBashCpus', desc: 'Container CPU limit, e.g. "0.5", "1", "2" (empty = unlimited)' }
}

/** 所有已知设置 key 描述列表（供 AI prompt / 参数 description 使用） */
export function getSettingKeyDescriptions(): string {
  return Object.entries(KNOWN_SETTINGS)
    .map(([key, e]) => `${key} (${e.desc})`)
    .join(', ')
}

// ---------- 设置服务 ----------

/**
 * 设置服务 — 编排设置相关的业务逻辑
 * 目前为薄封装，后续可扩展校验、缓存等逻辑
 */
export class SettingsService {
  /** 获取所有设置 */
  getAll(): Record<string, string> {
    return settingsDao.findAll()
  }

  /** 获取单个设置 */
  get(key: string): string | undefined {
    return settingsDao.findByKey(key)
  }

  /** 保存设置 */
  set(key: string, value: string): void {
    settingsDao.upsert(key, value)
  }
}

export const settingsService = new SettingsService()
