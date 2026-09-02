/**
 * 群聊消息行 → `ChatMessage`（渲染层契约）。
 *
 * **表是存储层的形状，`ChatMessage` 仍然是渲染层的契约。** 这条分界是 v2 存储改造能
 * 「只换地基不动上层」的原因：`message.list` 的签名不变、`user_message` /
 * `assistant_message` 广播的形状不变，于是 markdown 渲染、图片、复制、TTS、追问 chip
 * 全部原样复用；渲染层唯一要改的是「气泡还是卡片」。
 *
 * 它替换掉的是 v1 的整棵 entry 树投影 + 署名侧车配对（`pendingSender` 那套「靠紧邻
 * 配对、中间不得有 await 逃逸点」的机制）—— 那是把「谁说的」硬塞进「一个助手」数据
 * 模型的补丁，而这里它只是一列。
 */
import { join } from 'path'
import type {
  AssistantMessage,
  ChatMessage,
  ImageMeta,
  InlineToken,
  UserTextMessage
} from '@shuvix/chat-protocol/types/chatMessage'
import { asBotReply } from '@shuvix/chat-protocol/botReply'
import type { ChatAttachmentRef, ChatMessageRow } from '../dao/types/chatMessage'
import { getChatAttachmentsDir } from '../utils/paths'

/**
 * 附件描述符 → `ImageMeta`。
 *
 * 走 `preview` 而不是 `data`：`imageSrc()` 对 `preview` 原样返回，而 `shuvix-media://`
 * 是「内部生成、路径可信」的直通协议 —— 于是渲染端一个字都不用改，也不必把字节读进
 * 内存再 base64 一遍（那正是不把它们放进表里的理由）。
 */
function toImageMeta(sessionId: string, refs: ChatAttachmentRef[]): ImageMeta[] {
  const dir = getChatAttachmentsDir(sessionId)
  return refs.map((ref) => ({
    mimeType: ref.mimeType,
    preview: `shuvix-media://${encodeURI(join(dir, ref.file))}`
  }))
}

function parseJson<T>(raw: string | undefined): T | undefined {
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as T
  } catch {
    // 坏的 JSON 不该让整条会话读不出来 —— 丢掉这一个字段，消息本身照常渲染
    return undefined
  }
}

/**
 * 一行 → 一条 `ChatMessage`。
 *
 * `model` / `provider` 在群聊里没有逐条意义（回复由某个 bot 的任务段产出，用哪个模型是
 * 那次派发的事，不是这条消息的属性），故一律留空 —— `MessageBase.model` 是必填字段，
 * 空串即「不声明」，UI 侧没有消费它的地方。
 */
export function rowToChatMessage(row: ChatMessageRow): ChatMessage {
  const base = {
    id: row.id,
    sessionId: row.sessionId,
    content: row.content,
    model: '',
    createdAt: row.createdAt
  }

  if (row.authorKind === 'user') {
    const images = row.attachments?.length ? toImageMeta(row.sessionId, row.attachments) : undefined
    const inlineTokens = parseJson<Record<string, InlineToken>>(row.inlineTokens)
    const metadata =
      images || inlineTokens
        ? { ...(images ? { images } : {}), ...(inlineTokens ? { inlineTokens } : {}) }
        : null
    return { ...base, role: 'user', type: 'text', metadata } as UserTextMessage
  }

  if (row.authorKind === 'system') {
    // 系统提示（如「本轮已达上限」）走 error_event 这一路：它是 Conversation 唯一放行的
    // system_notify 形态，UI 上是一条细行，不占气泡
    return { ...base, role: 'system_notify', type: 'error_event', metadata: null }
  }

  // bot 消息：恒为单个 text 块的终答（工具在派生 agent 自己的内存树里跑，不进这里）
  const reply = asBotReply(parseJson(row.reply))
  return {
    ...base,
    role: 'assistant',
    type: 'message',
    blocks: [{ type: 'text', text: row.content }],
    metadata: {
      sender: {
        kind: 'bot' as const,
        name: row.botName ?? '',
        displayName: row.displayName || row.botName || ''
      },
      ...(reply ? { reply } : {}),
      ...(row.isError ? { botFailure: true as const } : {})
    }
  } as AssistantMessage
}

export function rowsToChatMessages(rows: ChatMessageRow[]): ChatMessage[] {
  return rows.map(rowToChatMessage)
}
