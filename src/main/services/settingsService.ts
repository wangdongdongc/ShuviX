import { settingsDao } from '../dao/settingsDao'

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
