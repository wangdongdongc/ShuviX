import { useState, useCallback, useMemo } from 'react'

interface SlashCommandItem {
  commandId: string
  name: string
  description: string
}

/**
 * Hook: 管理斜杠命令 popover 的状态和键盘导航
 * selectedIndex 通过 keyedIndex 实现：filter 变化时 offset 归零
 */
export function useSlashCommands(
  commands: SlashCommandItem[],
  inputText: string
): {
  showPopover: boolean
  filter: string
  selectedIndex: number
  handleKeyDown: (e: React.KeyboardEvent) => boolean
  handleSelect: (commandId: string) => string
} {
  // offset 相对于 0（每次 filter 变化时应归零）
  // 通过记录上次的 filter 来检测变化并重置
  const [navState, setNavState] = useState<{ filter: string; index: number }>({
    filter: '',
    index: 0
  })

  // 判断是否显示 popover：以 / 开头、单行、用户还没输入空格（还在补全命令名阶段）
  const showPopover =
    inputText.startsWith('/') &&
    !inputText.includes('\n') &&
    !inputText.includes(' ') &&
    commands.length > 0

  // 提取过滤文本
  const filter = showPopover ? inputText.slice(1) : ''

  const filtered = useMemo(
    () => commands.filter((cmd) => cmd.commandId.toLowerCase().startsWith(filter.toLowerCase())),
    [commands, filter]
  )

  // 当 filter 变化时，selectedIndex 归零；否则用 navState 中的 index
  const selectedIndex = navState.filter === filter ? navState.index : 0

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent): boolean => {
      if (!showPopover || filtered.length === 0) return false

      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setNavState({
          filter,
          index: selectedIndex <= 0 ? filtered.length - 1 : selectedIndex - 1
        })
        return true
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setNavState({
          filter,
          index: selectedIndex >= filtered.length - 1 ? 0 : selectedIndex + 1
        })
        return true
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        return true
      }
      return false
    },
    [showPopover, filtered, filter, selectedIndex]
  )

  /** 返回补全后的输入文本 */
  const handleSelect = useCallback((commandId: string): string => {
    return `/${commandId} `
  }, [])

  return { showPopover, filter, selectedIndex, handleKeyDown, handleSelect }
}
