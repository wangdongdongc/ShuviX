/** 设置数据结构 */
export interface Settings {
  key: string
  value: string
}

/** IPC: 写入设置参数 */
export interface SettingsSetParams {
  key: string
  value: string
}
