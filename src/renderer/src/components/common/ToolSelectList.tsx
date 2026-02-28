import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, Puzzle, WifiOff, BookOpen, Info, Search, Blocks, Cog } from 'lucide-react'

/** 工具信息 */
export interface ToolItem {
  name: string
  label: string
  /** 面向用户的工具简要说明（仅非紧凑模式展示） */
  hint?: string
  group?: string
  /** MCP 工具所属 server 的连接状态 */
  serverStatus?: 'connected' | 'disconnected' | 'connecting' | 'error'
  /** Skill 的启用/禁用状态（仅 skill 类型工具） */
  isEnabled?: boolean
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
  /** 仅显示内置工具（隐藏 MCP / Skills） */
  builtinOnly?: boolean
}

/** 从 MCP 全名中提取工具短名（mcp__server__tool → tool） */
function mcpShortName(fullName: string): string {
  const parts = fullName.split('__')
  return parts.length >= 3 ? parts.slice(2).join('__') : fullName
}

/** Skill 分组标识常量 */
const SKILLS_GROUP = '__skills__'

/** 基于 ripgrep 的高性能检索工具 */
const RIPGREP_TOOLS = new Set(['ls', 'grep', 'glob'])

/** 从 skill: 前缀名中提取短名（skill:pdf → pdf） */
function skillShortName(fullName: string): string {
  return fullName.startsWith('skill:') ? fullName.slice(6) : fullName
}

/**
 * 通用工具选择列表 — 支持内置工具、MCP 工具分组和 Skills 分组
 * 被 ToolPicker / ProjectEditDialog / ProjectCreateDialog 共用
 */
export function ToolSelectList({ tools, enabledTools, onChange, compact, builtinOnly }: ToolSelectListProps): React.JSX.Element {
  const { t } = useTranslation()
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())

  // 非紧凑模式下默认展开所有分组（项目新建/编辑窗口）
  useEffect(() => {
    if (!compact) {
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

  // 分离：内置工具（通用 + ripgrep + shuvix）、MCP 工具、Skills
  const builtinTools = tools.filter(t => !t.group && !RIPGREP_TOOLS.has(t.name) && !t.name.startsWith('shuvix-'))
  const ripgrepTools = tools.filter(t => !t.group && RIPGREP_TOOLS.has(t.name))
  const shuvixTools = tools.filter(t => !t.group && t.name.startsWith('shuvix-'))
  const mcpTools = tools.filter(t => t.group && t.group !== SKILLS_GROUP)
  const skillTools = tools.filter(t => t.group === SKILLS_GROUP)
  const groups = [...new Set(mcpTools.map(t => t.group!))]

  return (
    <div>
      {/* 非紧凑模式：用户提醒 */}
      {!compact && (
        <div className="mb-3">
          <p className="flex items-start gap-1.5 text-[10px] text-text-tertiary leading-relaxed">
            <Info size={12} className="flex-shrink-0 mt-px text-text-tertiary/60" />
            {t('projectForm.toolsReminder')}
          </p>
        </div>
      )}

      {/* 通用工具组 */}
      {builtinTools.length > 0 && (
        <div className={compact ? 'py-0.5' : ''}>
          <div className={compact ? '' : 'border border-border-secondary rounded-md overflow-hidden'}>
            {!compact && (
              <div className="flex items-center gap-1.5 px-2 py-1.5">
                <Blocks size={11} className="text-text-secondary" />
                <span className="text-[11px] font-medium text-text-secondary">{t('projectForm.toolsGeneralGroup')}</span>
              </div>
            )}
            <div className={compact ? '' : 'px-2 pb-1.5 space-y-0.5'}>
              {builtinTools.map(tool => (
                <label
                  key={tool.name}
                  className={compact
                    ? 'flex items-center gap-2 w-full px-2 py-1.5 hover:bg-bg-hover transition-colors cursor-pointer'
                    : 'flex items-center gap-1.5 cursor-pointer select-none py-0.5'
                  }
                >
                  <input
                    type="checkbox"
                    checked={enabledTools.includes(tool.name)}
                    onChange={() => toggle(tool.name)}
                    className="rounded border-border-primary accent-accent w-3.5 h-3.5 flex-shrink-0"
                  />
                  <span className="text-[11px] font-mono text-accent">{tool.name}</span>
                  <span className="text-[10px] text-text-tertiary truncate">{tool.label}{!compact && tool.hint ? ` — ${tool.hint}` : ''}</span>
                </label>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Ripgrep 高性能检索工具组 */}
      {ripgrepTools.length > 0 && (
        <div className={compact ? 'border-t border-border-secondary mt-0.5' : 'mt-2'}>
          <div className={compact ? '' : 'border border-cyan-500/20 rounded-md overflow-hidden bg-cyan-500/[0.03]'}>
            {!compact && (
              <div className="flex items-center gap-1.5 px-2 py-1.5">
                <Search size={11} className="text-cyan-400" />
                <span className="text-[11px] font-medium text-cyan-400">{t('projectForm.toolsRipgrepGroup')}</span>
              </div>
            )}
            <div className={compact ? 'py-0.5' : 'px-2 pb-1.5 space-y-0.5'}>
              {ripgrepTools.map(tool => (
                <label
                  key={tool.name}
                  className={compact
                    ? 'flex items-center gap-2 w-full px-2 py-1.5 hover:bg-bg-hover transition-colors cursor-pointer'
                    : 'flex items-center gap-1.5 cursor-pointer select-none py-0.5'
                  }
                >
                  <input
                    type="checkbox"
                    checked={enabledTools.includes(tool.name)}
                    onChange={() => toggle(tool.name)}
                    className="rounded border-border-primary accent-accent w-3.5 h-3.5 flex-shrink-0"
                  />
                  <span className="text-[11px] font-mono text-accent">{tool.name}</span>
                  <span className="text-[10px] text-text-tertiary truncate">{tool.label}{!compact && tool.hint ? ` — ${tool.hint}` : ''}</span>
                </label>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ShuviX 系统工具组 */}
      {shuvixTools.length > 0 && (
        <div className={compact ? 'border-t border-border-secondary mt-0.5' : 'mt-2'}>
          <div className={compact ? '' : 'border border-border-secondary rounded-md overflow-hidden bg-bg-secondary/30'}>
            {!compact && (
              <div className="flex items-center gap-1.5 px-2 py-1.5">
                <Cog size={11} className="text-text-tertiary" />
                <span className="text-[11px] font-medium text-text-tertiary">{t('projectForm.toolsShuvixGroup')}</span>
              </div>
            )}
            <div className={compact ? 'py-0.5' : 'px-2 pb-1.5 space-y-0.5'}>
              {shuvixTools.map(tool => (
                <label
                  key={tool.name}
                  className={compact
                    ? 'flex items-center gap-2 w-full px-2 py-1.5 hover:bg-bg-hover transition-colors cursor-pointer'
                    : 'flex items-center gap-1.5 cursor-pointer select-none py-0.5'
                  }
                >
                  <input
                    type="checkbox"
                    checked={enabledTools.includes(tool.name)}
                    onChange={() => toggle(tool.name)}
                    className="rounded border-border-primary accent-accent w-3.5 h-3.5 flex-shrink-0"
                  />
                  <span className="text-[11px] font-mono text-accent">{tool.name}</span>
                  <span className="text-[10px] text-text-tertiary truncate">{tool.label}{!compact && tool.hint ? ` — ${tool.hint}` : ''}</span>
                </label>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* MCP 工具按 Server 分组 */}
      {!builtinOnly && groups.length > 0 && (
        <div className={compact ? 'border-t border-border-secondary mt-0.5' : 'mt-3 space-y-1.5'}>
          {groups.map(group => {
            const groupTools = mcpTools.filter(t => t.group === group)
            const isExpanded = expandedGroups.has(group)
            const allChecked = groupTools.every(t => enabledTools.includes(t.name))
            const someChecked = groupTools.some(t => enabledTools.includes(t.name))

            // 判断分组是否在线
            const isOnline = groupTools.some(t => t.serverStatus === 'connected')

            return (
              <div key={group} className={compact ? '' : `border rounded-md overflow-hidden ${isOnline ? 'border-border-primary' : 'border-red-500/30'}`}>
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
                  <Puzzle size={11} className={isOnline ? 'text-purple-400' : 'text-red-400'} />
                  <span className={`text-[11px] font-medium ${isOnline ? 'text-purple-400' : 'text-red-400'}`}>{group}</span>
                  {!isOnline && (
                    <span className="flex items-center gap-0.5 text-[10px] text-red-400" title={t('settings.mcpStatusDisconnected')}>
                      <WifiOff size={10} />
                      {t('settings.mcpStatusDisconnected')}
                    </span>
                  )}
                  <span className="text-[10px] text-text-tertiary ml-auto">{groupTools.length}</span>
                </div>

                {/* 展开的子工具 */}
                {isExpanded && (
                  <div className={compact ? 'py-0.5' : 'px-2 py-1.5 space-y-0.5'}>
                    {groupTools.map(tool => (
                      <label
                        key={tool.name}
                        className={compact
                          ? `flex items-center gap-2 w-full px-2 pl-7 py-1.5 hover:bg-bg-hover transition-colors cursor-pointer ${!isOnline ? 'opacity-50' : ''}`
                          : `flex items-center gap-1.5 cursor-pointer select-none pl-5 py-0.5 ${!isOnline ? 'opacity-50' : ''}`
                        }
                      >
                        <input
                          type="checkbox"
                          checked={enabledTools.includes(tool.name)}
                          onChange={() => toggle(tool.name)}
                          className="rounded border-border-primary accent-accent w-3.5 h-3.5 flex-shrink-0"
                        />
                        <span className={`text-[11px] font-mono whitespace-nowrap flex-shrink-0 ${isOnline ? 'text-purple-300' : 'text-red-300/60'}`}>{mcpShortName(tool.name)}</span>
                        <span className="text-[10px] text-text-tertiary truncate flex-1 min-w-0">{tool.label}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Skills 分组 */}
      {!builtinOnly && skillTools.length > 0 && (
        <div className={compact ? 'border-t border-border-secondary mt-0.5' : 'mt-3'}>
          {(() => {
            const isExpanded = expandedGroups.has(SKILLS_GROUP)

            return (
              <div className={compact ? '' : 'border rounded-md overflow-hidden border-emerald-500/30'}>
                {/* Skills 分组头部 */}
                <div className={`flex items-center gap-1.5 ${compact ? 'px-2 py-1.5 hover:bg-bg-hover' : 'px-2 py-1.5 bg-bg-tertiary'}`}>
                  <button
                    onClick={() => toggleExpand(SKILLS_GROUP)}
                    className="text-text-tertiary hover:text-text-secondary flex-shrink-0"
                  >
                    {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  </button>
                  <BookOpen size={11} className="text-emerald-400" />
                  <span className="text-[11px] font-medium text-emerald-400">Skills</span>
                  <span className="text-[10px] text-text-tertiary ml-auto">{skillTools.length}</span>
                </div>

                {/* 展开的 Skill 列表 */}
                {isExpanded && (
                  <div className={compact ? 'py-0.5' : 'px-2 py-1.5 space-y-0.5'}>
                    {skillTools.map(tool => (
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
                        <span className="text-[11px] font-mono text-emerald-300 whitespace-nowrap flex-shrink-0">{skillShortName(tool.name)}</span>
                        <span className="text-[10px] text-text-tertiary truncate flex-1 min-w-0">{tool.label}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            )
          })()}
        </div>
      )}
    </div>
  )
}
