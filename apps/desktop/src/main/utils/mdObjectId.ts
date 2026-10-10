import { v7 as uuidv7 } from 'uuid'
import { setShuvixIdLine } from '@shuvix/chat-protocol/mdMeta'

/**
 * ShuviX 新建的 agent / bot / hook / policy 文件「一出生就带 `shuvix-id`」（设计 docs/md-metadata-design.md）。
 *
 * 原文已经带着合法 id（「创建覆盖副本」沿用内置的 `<kind>:builtin:<name>`，或者用户自己写了）→ 原样返回。
 * 否则写进一个新的 UUIDv7（只改这一行文本，见 setShuvixIdLine），并用这类文件自己的解析器复核：
 * 复核不过（插不进去的罕见写法，比如整块 flow 风格的 frontmatter）就按原文返回 —— 不因为 id 拒绝新建，
 * 之后在属性卡上分配即可。写错的 id 会被替换成新的。
 */
export function ensureObjectId(
  text: string,
  parse: (text: string) => { objectId?: string } | null
): string {
  if (parse(text)?.objectId) return text
  const stamped = setShuvixIdLine(text, uuidv7())
  if (stamped === null || !parse(stamped)?.objectId) return text
  return stamped
}
