/**
 * 群聊会话的附件落盘（v2）。
 *
 * 字节写 `<userData>/data/chat-attachments/<sessionId>/`，消息行里只留描述符。
 * base64 进表会让「读整个会话」变得昂贵 —— 与 http_logs 默认关闭是同一条理由；
 * 而 v1 的「按引用取字节」本来就假设了描述符与字节分离，这里只是把它落实到存储层。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getChatAttachmentsDir } from '../utils/paths'
import { createLogger } from '../logger'
import type { ChatAttachmentRef } from '../dao/types/chatMessage'

const log = createLogger('ChatAttachments')

/** mime → 扩展名。协议靠 Content-Type 而不是扩展名，这里只为让目录可读、可手动排查 */
const EXT_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/avif': '.avif',
  'image/svg+xml': '.svg'
}

/**
 * 落盘一条消息的全部附件，返回描述符（顺序与入参一致 —— 它就是消息里的图片顺序）。
 *
 * 单个附件写失败只丢它自己：一张图没存下不该让整条消息发不出去。
 */
export function saveChatAttachments(
  sessionId: string,
  messageId: string,
  images: Array<{ data: string; mimeType: string }>
): ChatAttachmentRef[] {
  if (!images.length) return []
  const dir = getChatAttachmentsDir(sessionId)
  const out: ChatAttachmentRef[] = []
  images.forEach((img, i) => {
    const file = `${messageId}-${i}${EXT_BY_MIME[img.mimeType] ?? '.bin'}`
    try {
      const bytes = Buffer.from(img.data, 'base64')
      writeFileSync(join(dir, file), bytes)
      out.push({ file, mimeType: img.mimeType, size: bytes.byteLength })
    } catch (e) {
      log.warn(`附件写盘失败（${sessionId}/${file}）:`, e)
    }
  })
  return out
}

/** 读回字节（派发时按引用取图；文件不在就跳过这一张，不抛） */
export function readChatAttachment(
  sessionId: string,
  ref: ChatAttachmentRef
): { data: string; mimeType: string } | null {
  const path = join(getChatAttachmentsDir(sessionId), ref.file)
  if (!existsSync(path)) return null
  try {
    // 与协议层的 <img> 路径分工：那边流式直读文件，这里是「喂给模型」的 base64
    return { data: readFileSync(path).toString('base64'), mimeType: ref.mimeType }
  } catch (e) {
    log.warn(`附件读取失败（${sessionId}/${ref.file}）:`, e)
    return null
  }
}

/** 删指定文件（回退时清理被删消息的附件） */
export function deleteChatAttachments(sessionId: string, refs: ChatAttachmentRef[]): void {
  if (!refs.length) return
  const dir = getChatAttachmentsDir(sessionId)
  for (const ref of refs) {
    try {
      rmSync(join(dir, ref.file), { force: true })
    } catch {
      /* 删不掉一个孤儿文件不值得中断回退 */
    }
  }
}

/** 删整个会话的附件目录（清空对话 / 删除会话） */
export function deleteSessionAttachments(sessionId: string): void {
  try {
    const dir = getChatAttachmentsDir(sessionId)
    rmSync(dir, { recursive: true, force: true })
  } catch (e) {
    log.warn(`附件目录清理失败（${sessionId}）:`, e)
  }
}

/** 目录存在性（仅供排错/测试；getChatAttachmentsDir 自身会 ensureDir） */
export function ensureChatAttachmentsDir(sessionId: string): string {
  const dir = getChatAttachmentsDir(sessionId)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}
