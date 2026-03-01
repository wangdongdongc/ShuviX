export type { SshAuthType, SshCredential } from '../dao/types'
import type { SshAuthType } from '../dao/types'

/** IPC: 添加 SSH 凭据参数 */
export interface SshCredentialAddParams {
  name: string
  host: string
  port: number
  username: string
  authType: SshAuthType
  password?: string
  privateKey?: string
  passphrase?: string
}

/** IPC: 更新 SSH 凭据参数 */
export interface SshCredentialUpdateParams {
  id: string
  name?: string
  host?: string
  port?: number
  username?: string
  authType?: SshAuthType
  password?: string
  privateKey?: string
  passphrase?: string
}
