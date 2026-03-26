export type { DbType, DbCredential } from '../dao/types'

/** IPC: 添加数据库凭据参数 */
export interface DbCredentialAddParams {
  name: string
  dbType: 'mysql' | 'postgresql'
  host: string
  port: number
  username: string
  password: string
  database: string
  readonly?: boolean
}

/** IPC: 更新数据库凭据参数 */
export interface DbCredentialUpdateParams {
  id: string
  name?: string
  dbType?: 'mysql' | 'postgresql'
  host?: string
  port?: number
  username?: string
  password?: string
  database?: string
  readonly?: boolean
}

/** IPC: 测试连接参数 */
export interface DbCredentialTestParams {
  dbType: 'mysql' | 'postgresql'
  host: string
  port: number
  username: string
  password: string
  database: string
}
