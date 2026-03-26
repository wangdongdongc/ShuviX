/**
 * 数据库引擎类型
 * 当前驱动已实现：mysql | postgresql
 * 其余类型已预留类型定义，dbManager 中按需补充实现
 */
export type DbType =
  | 'mysql'
  | 'postgresql'
  | 'sqlite' // database = 文件路径，host/port 留空
  | 'duckdb' // database = 文件路径，host/port 留空
  | 'clickhouse' // HTTP/Native 协议，兼容 MySQL 驱动
  | 'mongodb'
  | 'snowflake' // host = account.region.snowflakecomputing.com
  | 'bigquery' // authType = key_json，token = Service Account JSON

/**
 * 认证方式
 * password    — 用户名 + 密码（最常见）
 * token       — API Token / Personal Access Token
 * key_json    — Service Account JSON（BigQuery 等云数仓）
 * integrated  — Windows Auth / IAM / 无显式凭据
 */
export type DbAuthType = 'password' | 'token' | 'key_json' | 'integrated'

/** 数据库凭据扩展元数据（存储为 JSON，用于驱动级杂项参数，如 SSL、authSource 等） */
export interface DbCredentialMetadata {
  [key: string]: unknown
}

/** 数据库凭据（对应 DB 表 db_credentials，password/token/connStr 加密存储） */
export interface DbCredential {
  id: string
  /** 唯一名称，供 LLM 引用 */
  name: string
  dbType: DbType
  /** 主机名 / IP / Snowflake account；文件型 DB 留空 */
  host: string
  /** 端口，0 表示不适用（文件型 DB 或使用 connStr 时） */
  port: number
  /** 用户名；integrated 认证或 key_json 认证时可为空 */
  username: string
  /** 密码认证凭据（加密存储） */
  password: string
  /** 数据库名 / Schema / 文件路径 / GCP Project */
  database: string
  /** 认证方式，默认 password */
  authType: DbAuthType
  /** Token / OAuth Token / Service Account JSON（加密存储） */
  token: string
  /**
   * 完整连接字符串（加密存储）
   * 非空时优先级最高，覆盖 host/port/username/password/database 等所有字段
   * 格式示例：mysql://user:pass@host/db  postgresql://user:pass@host/db
   */
  connStr: string
  /** 是否只读（默认 true） */
  readonly: boolean
  /** 扩展元数据（JSON，不加密，存放驱动杂项参数） */
  metadata: DbCredentialMetadata
  createdAt: number
  updatedAt: number
}
