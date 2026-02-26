import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Terminal, FileText, FilePen, FileOutput, Wrench, Check, X, ChevronDown, ChevronRight, Loader2, ShieldAlert, MessageCircleQuestion, BookOpen, FolderTree, Search, FileSearch2 } from 'lucide-react'
import { useChatStore } from '../../stores/chatStore'

interface ToolCallBlockProps {
  toolName: string
  toolCallId?: string
  args?: any
  result?: string
  status: 'running' | 'done' | 'error' | 'pending_approval' | 'pending_user_input' | 'pending_ssh_credentials'
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
}: ToolCallBlockProps): React.JSX.Element {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)

  // 从 store 读取实时工具执行状态，确保审批状态变更时组件能独立重渲染
  const liveStatus = useChatStore((s) => {
    if (!toolCallId || !s.activeSessionId) return undefined
    const execs = s.sessionToolExecutions[s.activeSessionId]
    return execs?.find((te) => te.toolCallId === toolCallId)?.status
  })
  const status = liveStatus || propStatus

  // 根据工具类型生成摘要
  const { icon, detail } = (() => {
    const ic = 'text-text-tertiary flex-shrink-0'
    switch (toolName) {
      case 'bash': {
        const line = (args?.command || '').split('\n')[0]
        return { icon: <Terminal size={12} className={ic} />, detail: line.length > 80 ? line.slice(0, 77) + '...' : line }
      }
      case 'read':
        return { icon: <FileText size={12} className={ic} />, detail: args?.path || '' }
      case 'write':
        return { icon: <FileOutput size={12} className={ic} />, detail: args?.path || '' }
      case 'edit':
        return { icon: <FilePen size={12} className={ic} />, detail: args?.path || '' }
      case 'ask': {
        const q = (args?.question || '').slice(0, 60)
        return { icon: <MessageCircleQuestion size={12} className={ic} />, detail: q + (args?.question?.length > 60 ? '...' : '') }
      }
      case 'ls':
        return { icon: <FolderTree size={12} className={ic} />, detail: args?.path || '.' }
      case 'grep': {
        const pat = args?.pattern || ''
        const inc = args?.include ? ` (${args.include})` : ''
        return { icon: <Search size={12} className={ic} />, detail: pat + inc }
      }
      case 'glob':
        return { icon: <FileSearch2 size={12} className={ic} />, detail: args?.pattern || '' }
      case 'ssh': {
        const action = args?.action || ''
        const cmd = args?.command ? `: ${args.command.split('\n')[0].slice(0, 60)}` : ''
        return { icon: <Terminal size={12} className="text-emerald-400 flex-shrink-0" />, detail: `${action}${cmd}` }
      }
      case 'skill':
        return { icon: <BookOpen size={12} className="text-emerald-400 flex-shrink-0" />, detail: args?.command || '' }
      default:
        return { icon: <Wrench size={12} className={ic} />, detail: '' }
    }
  })()

  const statusConfig: Record<string, { icon: React.ReactNode; label: string; borderColor: string }> = {
    running: {
      icon: <Loader2 size={12} className="animate-spin text-accent" />,
      label: t('toolCall.running'),
      borderColor: 'border-accent/40'
    },
    done: {
      icon: <Check size={12} className="text-success" />,
      label: t('toolCall.done'),
      borderColor: 'border-success/40'
    },
    error: {
      icon: <X size={12} className="text-error" />,
      label: t('toolCall.error'),
      borderColor: 'border-error/40'
    },
    pending_approval: {
      icon: <ShieldAlert size={12} className="text-warning" />,
      label: t('toolCall.pendingApproval'),
      borderColor: 'border-warning/40'
    },
    pending_user_input: {
      icon: <MessageCircleQuestion size={12} className="text-accent" />,
      label: t('toolCall.pendingUserInput'),
      borderColor: 'border-accent/40'
    },
    pending_ssh_credentials: {
      icon: <Terminal size={12} className="text-accent" />,
      label: t('toolCall.pendingSshCredentials'),
      borderColor: 'border-accent/40'
    }
  }

  const config = statusConfig[status]

  return (
    <div className="my-0.5">
      {/* 单行摘要 — 可点击展开详情 */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-1.5 py-0.5 text-left text-[11px] text-text-tertiary hover:text-text-secondary transition-colors group"
      >
        {(args || result) && (
          expanded
            ? <ChevronDown size={10} className="flex-shrink-0 opacity-50" />
            : <ChevronRight size={10} className="flex-shrink-0 opacity-50" />
        )}
        {icon}
        <span className="font-medium text-text-secondary flex-shrink-0">{toolName}</span>
        {detail && <span className="flex-1 truncate font-mono opacity-70">{detail}</span>}
        {!detail && <span className="flex-1" />}
        <span className="flex items-center gap-1 flex-shrink-0 opacity-80">
          {config.icon}
          <span className="text-[10px]">{config.label}</span>
        </span>
      </button>

      {/* 展开详情 */}
      {expanded && status !== 'pending_approval' && status !== 'pending_user_input' && (
        <div className="mt-0.5 mb-1 ml-3 pl-2 border-l border-border-secondary/50 space-y-1.5">
          {args && Object.keys(args).length > 0 && (
            <div>
              <div className="text-[10px] text-text-tertiary mb-0.5">{t('toolCall.params')}</div>
              <pre className="text-[11px] text-text-secondary bg-bg-tertiary/50 rounded px-2 py-1 overflow-auto max-h-32 whitespace-pre-wrap break-words">
                {typeof args === 'string' ? args : JSON.stringify(args, null, 2)}
              </pre>
            </div>
          )}
          {result && (
            <div>
              <div className="text-[10px] text-text-tertiary mb-0.5">{t('toolCall.result')}</div>
              <pre className="text-[11px] text-text-secondary bg-bg-tertiary/50 rounded px-2 py-1 overflow-auto max-h-32 whitespace-pre-wrap break-words">
                {result}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
