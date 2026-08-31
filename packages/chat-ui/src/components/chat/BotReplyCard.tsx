/**
 * BotReply 的双形态渲染（设计 §6.2 / UI 形态裁决③）。
 *
 * 「有 points / table / status 走卡片，仅 headline(+body) 走气泡」这条判定**整个收在
 * 本组件内**：气泡形态 = 加粗结论 + 散文，不带任何卡片镶边；结构形态在此之上叠列点/
 * 表格/状态 chip。两种形态 AssistantBubble 一视同仁 —— 有 `metadata.reply` 就交给这里，
 * content 里那份 markdown 投影只服务复制/TTS/模型，不再重复渲染。
 *
 * followups 追问 chip 点击 = **填入输入框待编辑**（裁决③），复用消息回退的
 * `requestDraftRestore` 通道 —— 追问常要改两个字，直接发送还会立刻烧一轮意图段。
 */
import ReactMarkdown from 'react-markdown'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Check, X } from 'lucide-react'
import type { BotReply, BotReplyStatus } from '@shuvix/chat-protocol/botReply'
import {
  markdownComponents,
  markdownRemarkPlugins,
  markdownRehypePlugins
} from './markdownComponents'
import { useChatStore } from '../../stores/chatStore'

const STATUS_TONE: Record<BotReplyStatus, { cls: string; Icon: typeof Check }> = {
  ok: { cls: 'text-success bg-success/10 border-success/30', Icon: Check },
  warn: { cls: 'text-warning bg-warning/10 border-warning/30', Icon: AlertTriangle },
  error: { cls: 'text-error bg-error/10 border-error/30', Icon: X }
}

export function BotReplyCard({ reply }: { reply: BotReply }): React.JSX.Element {
  const { t } = useTranslation()
  const requestDraftRestore = useChatStore((s) => s.requestDraftRestore)

  const points = reply.points?.filter((p) => p.trim()) ?? []
  const table =
    reply.table && reply.table.columns.length > 0 && reply.table.rows.length > 0
      ? reply.table
      : null
  const followups = reply.followups?.filter((f) => f.trim()) ?? []
  const statusTone = reply.status ? STATUS_TONE[reply.status] : null

  return (
    <div className="markdown-body" data-bot-reply>
      {reply.headline.trim() && <p className="font-bold">{reply.headline}</p>}
      {reply.body?.trim() && (
        <ReactMarkdown
          components={markdownComponents}
          remarkPlugins={markdownRemarkPlugins}
          rehypePlugins={markdownRehypePlugins}
        >
          {reply.body}
        </ReactMarkdown>
      )}
      {points.length > 0 && (
        <ul>
          {points.map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ul>
      )}
      {table && (
        <table>
          <thead>
            <tr>
              {table.columns.map((c, i) => (
                <th key={i}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, ri) => (
              <tr key={ri}>
                {table.columns.map((_, ci) => (
                  <td key={ci}>{row?.[ci] ?? ''}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {statusTone && (
        <div className="mt-2">
          <span
            className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] ${statusTone.cls}`}
            data-bot-status={reply.status}
          >
            <statusTone.Icon size={11} strokeWidth={2.5} />
            {t(
              `bot.status${reply.status === 'ok' ? 'Ok' : reply.status === 'warn' ? 'Warn' : 'Error'}`
            )}
          </span>
        </div>
      )}
      {followups.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {followups.map((f, i) => (
            <button
              key={i}
              onClick={() => requestDraftRestore(f)}
              className="rounded-full border border-accent/35 px-3 py-0.5 text-xs text-accent hover:bg-accent/10 transition-colors"
              data-bot-followup
            >
              {f}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
