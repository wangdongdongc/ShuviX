import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Terminal, FileText, FilePen, FileOutput, Wrench, Check, X, ChevronDown, ChevronRight, Loader2, ShieldAlert, MessageCircleQuestion } from 'lucide-react'
import { useChatStore } from '../stores/chatStore'

interface ToolCallBlockProps {
  toolName: string
  toolCallId?: string
  args?: any
  result?: string
  status: 'running' | 'done' | 'error' | 'pending_approval' | 'pending_user_input'
  /** 审批回调（仅 pending_approval 时使用） */
  onApproval?: (toolCallId: string, approved: boolean) => void
}

/**
 * 工具调用块 — 在对话流中内联展示工具调用过程
 * 折叠/展开显示参数和结果；沙箱模式下 bash 审批内联卡片
 */
export function ToolCallBlock({
  toolName,
  toolCallId,
  args,
  result,
  status: propStatus,
  onApproval,
}: ToolCallBlockProps): React.JSX.Element {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)

  // 从 store 读取实时工具执行状态，确保审批状态变更时组件能独立重渲染
  const liveStatus = useChatStore((s) => {
    if (!toolCallId) return undefined
    return s.toolExecutions.find((te) => te.toolCallId === toolCallId)?.status
  })
  const status = liveStatus || propStatus

  // 根据工具类型生成摘要
  const { icon, detail } = (() => {
    const ic = 'text-text-tertiary flex-shrink-0'
    switch (toolName) {
      case 'bash': {
        const line = (args?.command || '').split('\n')[0]
        return { icon: <Terminal size={14} className={ic} />, detail: line.length > 80 ? line.slice(0, 77) + '...' : line }
      }
      case 'read':
        return { icon: <FileText size={14} className={ic} />, detail: args?.path || '' }
      case 'write':
        return { icon: <FileOutput size={14} className={ic} />, detail: args?.path || '' }
      case 'edit':
        return { icon: <FilePen size={14} className={ic} />, detail: args?.path || '' }
      case 'ask': {
        const q = (args?.question || '').slice(0, 60)
        return { icon: <MessageCircleQuestion size={14} className={ic} />, detail: q + (args?.question?.length > 60 ? '...' : '') }
      }
      default:
        return { icon: <Wrench size={14} className={ic} />, detail: '' }
    }
  })()

  const statusConfig: Record<string, { icon: React.ReactNode; label: string; borderColor: string }> = {
    running: {
      icon: <Loader2 size={14} className="animate-spin text-accent" />,
      label: t('toolCall.running'),
      borderColor: 'border-accent/40'
    },
    done: {
      icon: <Check size={14} className="text-success" />,
      label: t('toolCall.done'),
      borderColor: 'border-success/40'
    },
    error: {
      icon: <X size={14} className="text-error" />,
      label: t('toolCall.error'),
      borderColor: 'border-error/40'
    },
    pending_approval: {
      icon: <ShieldAlert size={14} className="text-warning" />,
      label: t('toolCall.pendingApproval'),
      borderColor: 'border-warning/40'
    },
    pending_user_input: {
      icon: <MessageCircleQuestion size={14} className="text-accent" />,
      label: t('toolCall.pendingUserInput'),
      borderColor: 'border-accent/40'
    }
  }

  const config = statusConfig[status]

  return (
    <div className={`mx-4 my-2 rounded-lg border-l-2 ${config.borderColor} bg-bg-tertiary/50 overflow-hidden`}>
      {/* 头部 — 可点击展开 */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-bg-hover/50 transition-colors"
      >
        {icon}
        <span className="text-xs font-medium text-text-primary flex-shrink-0">{toolName}</span>
        {detail && <span className="flex-1 text-[11px] text-text-secondary truncate font-mono">{detail}</span>}
        {!detail && <span className="flex-1" />}
        <span className="flex items-center gap-1.5 text-[10px] text-text-tertiary flex-shrink-0">
          {config.icon}
          {config.label}
        </span>
        {(args || result) && (
          expanded
            ? <ChevronDown size={12} className="text-text-tertiary flex-shrink-0" />
            : <ChevronRight size={12} className="text-text-tertiary flex-shrink-0" />
        )}
      </button>

      {/* 沙箱审批：显示命令内容 + 允许/拒绝按钮 */}
      {status === 'pending_approval' && (
        <div className="px-3 pb-2.5 border-t border-border-secondary/50">
          <pre className="mt-2 text-[11px] text-text-secondary bg-bg-primary/50 rounded px-2 py-1.5 overflow-auto max-h-32 whitespace-pre-wrap break-words font-mono">
            {args?.command || ''}
          </pre>
          <div className="flex items-center gap-2 mt-2">
            <button
              onClick={() => toolCallId && onApproval?.(toolCallId, true)}
              className="px-3 py-1 rounded-md text-[11px] font-medium bg-accent text-white hover:bg-accent/90 transition-colors"
            >
              {t('toolCall.allow')}
            </button>
            <button
              onClick={() => toolCallId && onApproval?.(toolCallId, false)}
              className="px-3 py-1 rounded-md text-[11px] font-medium bg-bg-secondary border border-border-primary text-text-secondary hover:bg-bg-hover transition-colors"
            >
              {t('toolCall.deny')}
            </button>
            <span className="text-[10px] text-text-tertiary ml-1">{t('toolCall.sandboxHint')}</span>
          </div>
        </div>
      )}

      {/* 展开内容 */}
      {expanded && status !== 'pending_approval' && status !== 'pending_user_input' && (
        <div className="px-3 pb-2.5 space-y-2 border-t border-border-secondary/50">
          {args && Object.keys(args).length > 0 && (
            <div className="pt-2">
              <div className="text-[10px] text-text-tertiary mb-1">{t('toolCall.params')}</div>
              <pre className="text-[11px] text-text-secondary bg-bg-primary/50 rounded px-2 py-1.5 overflow-auto max-h-32 whitespace-pre-wrap break-words">
                {typeof args === 'string' ? args : JSON.stringify(args, null, 2)}
              </pre>
            </div>
          )}
          {result && (
            <div>
              <div className="text-[10px] text-text-tertiary mb-1">{t('toolCall.result')}</div>
              <pre className="text-[11px] text-text-secondary bg-bg-primary/50 rounded px-2 py-1.5 overflow-auto max-h-32 whitespace-pre-wrap break-words">
                {result}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
