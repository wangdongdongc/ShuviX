/** SSH 认证类型 */
export type SshAuthType = 'password' | 'key'

/** SSH 凭据扩展元数据（存储为 JSON，便于未来扩展字段而无需改表结构） */
export interface SshCredentialMetadata {
  /** SOCKS5/4 代理 URL，例如 socks5://localhost:6153，空则直连 */
  proxyUrl?: string
}

/** SSH 凭据数据结构（对应 DB 表 ssh_credentials，敏感字段加密存储） */
export interface SshCredential {
  id: string
  /** 唯一名称，供 LLM 引用 */
  name: string
  host: string
  port: number
  username: string
  authType: SshAuthType
  /** 密码认证（加密存储） */
  password: string
  /** 私钥内容 PEM（加密存储） */
  privateKey: string
  /** 私钥口令（加密存储） */
  passphrase: string
  /** 扩展元数据（JSON，不加密） */
  metadata: SshCredentialMetadata
  createdAt: number
  updatedAt: number
}
