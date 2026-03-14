import { useRef, useEffect, useMemo } from 'react'
import { Terminal } from 'lucide-react'

interface SlashCommandItem {
  commandId: string
  name: string
  description: string
}

interface SlashCommandPopoverProps {
  /** 过滤文本（`/` 后面的部分，不含空格后的 args） */
  filter: string
  /** 可用的斜杠命令列表 */
  commands: SlashCommandItem[]
  /** 选中命令回调 */
  onSelect: (commandId: string) => void
  /** 当前键盘选中索引 */
  selectedIndex: number
}

/**
 * 斜杠命令自动补全浮层
 * 在 textarea 上方显示匹配的命令列表
 */
export function SlashCommandPopover({
  filter,
  commands,
  onSelect,
  selectedIndex
}: SlashCommandPopoverProps): React.JSX.Element | null {
  const listRef = useRef<HTMLDivElement>(null)

  // 过滤匹配的命令
  const filtered = useMemo(
    () => commands.filter((cmd) => cmd.commandId.toLowerCase().startsWith(filter.toLowerCase())),
    [commands, filter]
  )

  // 确保选中项可见
  useEffect(() => {
    const container = listRef.current
    if (!container) return
    const item = container.children[selectedIndex] as HTMLElement | undefined
    if (item) {
      item.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedIndex])

  // 无匹配时不渲染
  if (filtered.length === 0) return null

  return (
    <div
      ref={listRef}
      className="absolute bottom-full left-0 right-0 mb-1 mx-2 max-h-48 overflow-y-auto rounded-lg border border-border-primary bg-bg-secondary shadow-xl z-30"
    >
      {filtered.map((cmd, idx) => (
        <button
          key={cmd.commandId}
          onClick={() => onSelect(cmd.commandId)}
          className={`w-full flex items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors ${
            idx === selectedIndex
              ? 'bg-accent/15 text-text-primary'
              : 'text-text-secondary hover:bg-bg-tertiary'
          }`}
        >
          <Terminal size={14} className="flex-shrink-0 text-text-tertiary" />
          <span className="font-mono text-accent">/{cmd.commandId}</span>
          {cmd.description && (
            <span className="text-text-tertiary text-xs truncate">{cmd.description}</span>
          )}
        </button>
      ))}
    </div>
  )
}
