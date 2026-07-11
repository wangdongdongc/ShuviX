/**
 * useSessionExport —— 会话导出为 Markdown（桌面/扩展单一来源）。
 *
 * 流程：分页取全归档历史（compaction 前的原始消息）→ 取当前消息 →
 * transcribeConversation 精简转写（仅用户 + 助手最终回复）→ Blob 触发 .md 下载。
 * 取数已统一在注入式 ChatApi 之后（getChatApi().message.*），下载走浏览器
 * anchor download（桌面 Electron 无 will-download 拦截 = 弹原生另存为）。
 */
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { getChatApi, useChatStore, type Session } from '@shuvix/chat-ui'
import type { ChatMessage } from '@shuvix/chat-protocol/types/chatMessage'
import { transcribeConversation } from '@shuvix/chat-protocol/utils/transcript'

/** 归档历史分页批大小 */
const ARCHIVED_PAGE_SIZE = 200

/** 清洗文件名非法字符；空标题回退 'session' */
function toFilename(title: string): string {
  const safe = title
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return `${safe || 'session'}.md`
}

/** Blob + anchor 触发文本文件下载 */
function downloadTextFile(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/** 分页取全归档消息，按 createdAt 升序返回（DAO 返回 DESC） */
async function fetchAllArchived(sessionId: string): Promise<ChatMessage[]> {
  const api = getChatApi()
  const total = await api.message.countArchived(sessionId)
  if (total <= 0) return []
  const pages: ChatMessage[] = []
  for (let offset = 0; offset < total; offset += ARCHIVED_PAGE_SIZE) {
    pages.push(
      ...(await api.message.listArchived({ sessionId, limit: ARCHIVED_PAGE_SIZE, offset }))
    )
  }
  return pages.sort((a, b) => a.createdAt - b.createdAt)
}

/** 导出会话为 Markdown 文件（含归档历史的完整记录，精简转写） */
export function useSessionExport(): (sessionId: string) => Promise<void> {
  const { t } = useTranslation()

  return useCallback(
    async (sessionId: string) => {
      try {
        const archived = await fetchAllArchived(sessionId)
        let current = await getChatApi().message.list(sessionId)
        // 含归档原文时，压缩摘要消息与其内容重复，滤掉
        if (archived.length > 0) {
          current = current.filter(
            (m) => !(m.type === 'text' && m.role === 'assistant' && m.metadata?.isCompactionSummary)
          )
        }

        const session: Session | undefined = useChatStore
          .getState()
          .sessions.find((s) => s.id === sessionId)
        const title = session?.title?.trim() || t('transcript.untitled')

        const markdown = transcribeConversation([...archived, ...current], {
          title,
          headingLevel: 1,
          labels: {
            user: t('transcript.user'),
            assistant: t('transcript.assistant'),
            steer: t('transcript.steer'),
            thinking: t('transcript.thinking'),
            toolCall: t('transcript.toolCall'),
            toolResult: t('transcript.toolResult'),
            systemNotice: t('transcript.systemNotice'),
            image: t('transcript.image')
          }
        })
        downloadTextFile(toFilename(title), markdown)
      } catch (err) {
        console.error('[useSessionExport] export failed:', err)
      }
    },
    [t]
  )
}
