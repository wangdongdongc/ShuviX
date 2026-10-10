import type { MdAttrNamespace } from '@shuvix/chat-protocol/mdMeta'

/**
 * 一条 md 扩展元数据（对应 DB 表 md_attrs）—— 挂在文件 frontmatter 的 `shuvix-id` 上，一个顶层键一行。
 * `value` 已从 JSON 解析（YAML 1.2 core 解析出来的那棵树里 JSON 表达得了的部分）。
 */
export interface MdAttr {
  /** `shuvix-id` 的值（已归一）：UUID，或内置的 `<kind>:builtin:<name>` */
  objectId: string
  /** '' = 全局；预留 'project:<projectId>' */
  scope: string
  ns: MdAttrNamespace
  key: string
  value: unknown
  updatedAt: number
}

/** 定位一条元数据的四段主键 */
export interface MdAttrKey {
  objectId: string
  /** 缺省 '' = 全局 */
  scope?: string
  ns: MdAttrNamespace
  key: string
}
