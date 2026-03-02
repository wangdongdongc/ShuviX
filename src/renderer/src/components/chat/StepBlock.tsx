import { useState } from 'react'
import { Brain, MessageSquareText, ChevronDown, ChevronRight } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import type { ChatMessage } from '../../stores/chatStore'

interface StepBlockProps {
  message: ChatMessage
}

/**
 * 中间步骤块 — 展示中间轮次的思考或文本输出
 * 折叠/展开，视觉风格与 ToolCallBlock 一致
 */
export function StepBlock({ message }: StepBlockProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const isThinking = message.type === 'step_thinking'

  // 首行预览
  const firstLine = message.content.split('\n')[0] || ''
  const preview = firstLine.length > 80 ? firstLine.slice(0, 77) + '...' : firstLine

  const icon = isThinking ? (
    <Brain size={12} className="text-text-tertiary flex-shrink-0" />
  ) : (
    <MessageSquareText size={12} className="text-text-tertiary flex-shrink-0" />
  )

  return (
    <div className="my-0.5">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-1.5 py-0.5 text-left text-[11px] text-text-tertiary hover:text-text-secondary transition-colors group"
      >
        {expanded ? (
          <ChevronDown size={10} className="flex-shrink-0 opacity-50" />
        ) : (
          <ChevronRight size={10} className="flex-shrink-0 opacity-50" />
        )}
        {icon}
        {!expanded && preview && (
          <span className="flex-1 truncate font-mono opacity-70">{preview}</span>
        )}
        {(expanded || !preview) && <span className="flex-1" />}
      </button>

      {expanded && (
        <div className="mt-0.5 mb-1 ml-3 pl-2 border-l border-border-secondary/50">
          {isThinking ? (
            <pre className="text-[11px] text-text-secondary/80 bg-bg-tertiary/50 rounded px-2 py-1 overflow-auto max-h-64 whitespace-pre-wrap break-words">
              {message.content}
            </pre>
          ) : (
            <div className="text-[12px] text-text-secondary prose prose-sm prose-invert max-w-none overflow-auto max-h-64">
              <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                {message.content}
              </ReactMarkdown>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
