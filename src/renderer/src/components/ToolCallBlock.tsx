import { useState } from 'react'
import { Terminal, FileText, FilePen, FileOutput, Wrench, Check, X, ChevronDown, ChevronRight, Loader2 } from 'lucide-react'

interface ToolCallBlockProps {
  toolName: string
  args?: any
  result?: string
  status: 'running' | 'done' | 'error'
}

/**
 * 工具调用块 — 在对话流中内联展示工具调用过程
 * 折叠/展开显示参数和结果
 */
export function ToolCallBlock({
  toolName,
  args,
  result,
  status,
}: ToolCallBlockProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)

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
      default:
        return { icon: <Wrench size={14} className={ic} />, detail: '' }
    }
  })()

  const statusConfig = {
    running: {
      icon: <Loader2 size={14} className="animate-spin text-accent" />,
      label: '执行中...',
      borderColor: 'border-accent/40'
    },
    done: {
      icon: <Check size={14} className="text-success" />,
      label: '完成',
      borderColor: 'border-success/40'
    },
    error: {
      icon: <X size={14} className="text-error" />,
      label: '出错',
      borderColor: 'border-error/40'
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

      {/* 展开内容 */}
      {expanded && (
        <div className="px-3 pb-2.5 space-y-2 border-t border-border-secondary/50">
          {args && Object.keys(args).length > 0 && (
            <div className="pt-2">
              <div className="text-[10px] text-text-tertiary mb-1">参数</div>
              <pre className="text-[11px] text-text-secondary bg-bg-primary/50 rounded px-2 py-1.5 overflow-auto max-h-32 whitespace-pre-wrap break-words">
                {typeof args === 'string' ? args : JSON.stringify(args, null, 2)}
              </pre>
            </div>
          )}
          {result && (
            <div>
              <div className="text-[10px] text-text-tertiary mb-1">结果</div>
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
