import { useState, useEffect } from 'react'
import { ChevronDown, ChevronRight, Puzzle } from 'lucide-react'

/** 工具信息 */
export interface ToolItem {
  name: string
  label: string
  group?: string
}

interface ToolSelectListProps {
  /** 所有可用工具（含 group 字段表示 MCP 工具） */
  tools: ToolItem[]
  /** 当前启用的工具名称列表 */
  enabledTools: string[]
  /** 切换工具启用状态 */
  onChange: (enabledTools: string[]) => void
  /** 是否使用紧凑模式（如 ToolPicker 下拉面板） */
  compact?: boolean
}

/** 从 MCP 全名中提取工具短名（mcp__server__tool → tool） */
function mcpShortName(fullName: string): string {
  const parts = fullName.split('__')
  return parts.length >= 3 ? parts.slice(2).join('__') : fullName
}

/**
 * 通用工具选择列表 — 支持内置工具和 MCP 工具分组
 * 被 ToolPicker / ProjectEditDialog / ProjectCreateDialog 共用
 */
export function ToolSelectList({ tools, enabledTools, onChange, compact }: ToolSelectListProps): React.JSX.Element {
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())

  // 紧凑模式下默认展开所有分组
  useEffect(() => {
    if (compact) {
      const groups = new Set(tools.filter(t => t.group).map(t => t.group!))
      setExpandedGroups(groups)
    }
  }, [compact, tools])

  /** 切换单个工具 */
  const toggle = (name: string): void => {
    onChange(
      enabledTools.includes(name)
        ? enabledTools.filter(n => n !== name)
        : [...enabledTools, name]
    )
  }

  /** 切换整个分组 */
  const toggleGroup = (groupTools: ToolItem[]): void => {
    const names = groupTools.map(t => t.name)
    const allChecked = names.every(n => enabledTools.includes(n))
    if (allChecked) {
      onChange(enabledTools.filter(n => !names.includes(n)))
    } else {
      onChange([...new Set([...enabledTools, ...names])])
    }
  }

  /** 切换分组展开/收起 */
  const toggleExpand = (group: string): void => {
    setExpandedGroups(prev => {
      const next = new Set(prev)
      if (next.has(group)) next.delete(group); else next.add(group)
      return next
    })
  }

  // 分离内置工具和 MCP 工具
  const builtinTools = tools.filter(t => !t.group)
  const mcpTools = tools.filter(t => t.group)
  const groups = [...new Set(mcpTools.map(t => t.group!))]

  return (
    <div>
      {/* 内置工具 */}
      <div className={compact ? 'py-0.5' : 'flex flex-wrap gap-x-3 gap-y-1.5'}>
        {builtinTools.map(tool => (
          <label
            key={tool.name}
            className={compact
              ? 'flex items-center gap-2 w-full px-2 py-1.5 hover:bg-bg-hover transition-colors cursor-pointer'
              : 'flex items-center gap-1.5 cursor-pointer select-none'
            }
          >
            <input
              type="checkbox"
              checked={enabledTools.includes(tool.name)}
              onChange={() => toggle(tool.name)}
              className="rounded border-border-primary accent-accent w-3.5 h-3.5 flex-shrink-0"
            />
            <span className="text-[11px] font-mono text-accent">{tool.name}</span>
            <span className="text-[10px] text-text-tertiary">{tool.label}</span>
          </label>
        ))}
      </div>

      {/* MCP 工具按 Server 分组 */}
      {groups.length > 0 && (
        <div className={compact ? 'border-t border-border-secondary mt-0.5' : 'mt-3 space-y-1.5'}>
          {groups.map(group => {
            const groupTools = mcpTools.filter(t => t.group === group)
            const isExpanded = expandedGroups.has(group)
            const allChecked = groupTools.every(t => enabledTools.includes(t.name))
            const someChecked = groupTools.some(t => enabledTools.includes(t.name))

            return (
              <div key={group} className={compact ? '' : 'border border-border-primary rounded-md overflow-hidden'}>
                {/* MCP Server 分组头部 */}
                <div className={`flex items-center gap-1.5 ${compact ? 'px-2 py-1.5 hover:bg-bg-hover' : 'px-2 py-1.5 bg-bg-tertiary'}`}>
                  <button
                    onClick={() => toggleExpand(group)}
                    className="text-text-tertiary hover:text-text-secondary flex-shrink-0"
                  >
                    {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  </button>
                  <input
                    type="checkbox"
                    checked={allChecked}
                    ref={el => { if (el) el.indeterminate = someChecked && !allChecked }}
                    onChange={() => toggleGroup(groupTools)}
                    className="rounded border-border-primary accent-accent w-3.5 h-3.5 flex-shrink-0"
                  />
                  <Puzzle size={11} className="text-purple-400 flex-shrink-0" />
                  <span className="text-[11px] font-medium text-purple-400">{group}</span>
                  <span className="text-[10px] text-text-tertiary ml-auto">{groupTools.length}</span>
                </div>

                {/* 展开的子工具 */}
                {isExpanded && (
                  <div className={compact ? 'py-0.5' : 'px-2 py-1.5 space-y-0.5'}>
                    {groupTools.map(tool => (
                      <label
                        key={tool.name}
                        className={compact
                          ? 'flex items-center gap-2 w-full px-2 pl-7 py-1.5 hover:bg-bg-hover transition-colors cursor-pointer'
                          : 'flex items-center gap-1.5 cursor-pointer select-none pl-5 py-0.5'
                        }
                      >
                        <input
                          type="checkbox"
                          checked={enabledTools.includes(tool.name)}
                          onChange={() => toggle(tool.name)}
                          className="rounded border-border-primary accent-accent w-3.5 h-3.5 flex-shrink-0"
                        />
                        <span className="text-[11px] font-mono text-purple-300">{mcpShortName(tool.name)}</span>
                        <span className="text-[10px] text-text-tertiary truncate">{tool.label}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
