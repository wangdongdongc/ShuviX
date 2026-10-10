/**
 * 读 frontmatter 里的 `shuvix-id` —— agent / bot / hook / policy 四个解析器共用（契约见 chat-protocol mdMeta.ts）。
 *
 * 写错的 id 不判整份文件非法：四个解析器对未知键本来一律宽容，id 只是 ShuviX 挂元数据用的身份，
 * 不该连累文件里的定义。它只让这份文件「没有 id」（于是不挂任何元数据），并经 warn 发一条软提示 ——
 * 属性卡把合法文件的 warn 显示成琥珀色提示，用户看得见为什么设置没生效。
 */
import { SHUVIX_ID_KEY, normalizeObjectId } from '@shuvix/chat-protocol/mdMeta'

/**
 * 归一后的对象 id；没写这个键、或写得不合法 → undefined（后者经 warn 提示）。
 * `who` 是诊断里的主语，沿用各解析器自己的写法（`agent 'explore'`、`security policy 'x'`…）。
 */
export function readObjectIdField(
  fields: Record<string, unknown>,
  who: string,
  warn?: (msg: string) => void
): string | undefined {
  if (!(SHUVIX_ID_KEY in fields)) return undefined
  const id = normalizeObjectId(fields[SHUVIX_ID_KEY])
  if (id === null) {
    warn?.(
      `${who}: '${SHUVIX_ID_KEY}' is not a valid object id (expected a UUID or '<kind>:builtin:<name>') — the file is read as having no object id, so no ShuviX settings apply to it`
    )
    return undefined
  }
  return id
}
