export type { Settings } from '../dao/types'

/** IPC: 写入设置参数 */
export interface SettingsSetParams {
  key: string
  value: string
}
