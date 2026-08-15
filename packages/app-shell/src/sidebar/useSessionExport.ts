/**
 * useSessionExport —— 会话导出为 Markdown（桌面/扩展单一来源）。
 *
 * 流程：取当前消息 → transcribeConversation 精简转写（仅用户 + 助手最终回复）
 * → Blob 触发 .md 下载。取数已统一在注入式 ChatApi 之后（getChatApi().message.*），
 * 下载走浏览器 anchor download（桌面 Electron 无 will-download 拦截 = 弹原生另存为）。
 *
 * 范围即当前上下文：自动压缩掉的历史不参与导出（`message.list` 走 buildContextEntries，
 * 自带压缩过滤），长会话导出到的是「摘要卡片 + 压缩点之后的原文」。原始全文仍在
 * 会话的 JSONL 转写文件里，但不再有读取入口。
 */
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { getChatApi, useChatStore, type Session } from '@shuvix/chat-ui'
import { transcribeConversation } from '@shuvix/chat-protocol/utils/transcript'

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

/** 导出会话为 Markdown 文件（当前上下文的精简转写） */
export function useSessionExport(): (sessionId: string) => Promise<void> {
  const { t } = useTranslation()

  return useCallback(
    async (sessionId: string) => {
      try {
        const current = await getChatApi().message.list(sessionId)

        const session: Session | undefined = useChatStore
          .getState()
          .sessions.find((s) => s.id === sessionId)
        const title = session?.title?.trim() || t('transcript.untitled')

        const markdown = transcribeConversation(current, {
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
