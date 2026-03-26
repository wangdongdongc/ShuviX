import { useTranslation } from 'react-i18next'
import { Puzzle, WifiOff, BookOpen, Info, Search, Blocks, Bot, Globe } from 'lucide-react'

/** 工具信息 */
export interface ToolItem {
  name: string
  label: string
  /** 面向用户的工具简要说明（仅非紧凑模式展示） */
  hint?: string
  group?: string
  /** 新建会话时是否默认启用（来自后端注册表） */
  defaultEnabled?: boolean
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

/** 从 mcp:<serverName> 中提取服务器短名 */
function mcpServerName(fullName: string): string {
  return fullName.startsWith('mcp:') ? fullName.slice(4) : fullName
}

/** Skill 分组标识常量 */
const SKILLS_GROUP = '__skills__'

/** 从 skill: 前缀名中提取短名（skill:pdf → pdf） */
function skillShortName(fullName: string): string {
  return fullName.startsWith('skill:') ? fullName.slice(6) : fullName
}

/**
 * 通用工具选择列表 — 支持内置工具、MCP 工具分组和 Skills 分组
 * 被 ToolPicker / ProjectEditDialog / ProjectCreateDialog 共用
 */
export function ToolSelectList({
  tools,
  enabledTools,
  onChange,
  compact,
  builtinOnly
}: ToolSelectListProps): React.JSX.Element {
  const { t } = useTranslation()

  /** 切换单个工具 */
  const toggle = (name: string): void => {
    onChange(
      enabledTools.includes(name) ? enabledTools.filter((n) => n !== name) : [...enabledTools, name]
    )
  }

  // 分离各分组（group 由后端注册表提供，system 组不展示）
  const builtinTools = tools.filter((t) => t.group === 'general')
  const ripgrepTools = tools.filter((t) => t.group === 'ripgrep')
  const remoteTools = tools.filter((t) => t.group === 'remote')
  const subAgentTools = tools.filter((t) => t.group === 'subagent')
  const mcpTools = tools.filter((t) => t.group?.startsWith('mcp:'))
  const skillTools = tools.filter((t) => t.group === SKILLS_GROUP)

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
          <div className={compact ? '' : 'border-l-2 border-border-secondary pl-3'}>
            {!compact && (
              <div className="flex items-center gap-1.5 py-1">
                <Blocks size={11} className="text-text-secondary" />
                <span className="text-[11px] font-medium text-text-secondary">
                  {t('projectForm.toolsGeneralGroup')}
                </span>
              </div>
            )}
            <div className={compact ? '' : 'space-y-0.5'}>
              {builtinTools.map((tool) => (
                <label
                  key={tool.name}
                  className={
                    compact
                      ? 'flex items-center gap-1.5 w-full px-2 py-0.5 hover:bg-bg-hover transition-colors cursor-pointer'
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
                  <span className="text-[10px] text-text-tertiary truncate">
                    {tool.label}
                    {!compact && tool.hint ? ` — ${tool.hint}` : ''}
                  </span>
                </label>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Ripgrep 高性能检索工具组 */}
      {ripgrepTools.length > 0 && (
        <div className={compact ? 'border-t border-border-secondary mt-0.5' : 'mt-2'}>
          <div className={compact ? '' : 'border-l-2 border-cyan-500/40 pl-3'}>
            {!compact && (
              <div className="flex items-center gap-1.5 py-1">
                <Search size={11} className="text-cyan-400" />
                <span className="text-[11px] font-medium text-cyan-400">
                  {t('projectForm.toolsRipgrepGroup')}
                </span>
              </div>
            )}
            <div className={compact ? 'py-0.5' : 'space-y-0.5'}>
              {ripgrepTools.map((tool) => (
                <label
                  key={tool.name}
                  className={
                    compact
                      ? 'flex items-center gap-1.5 w-full px-2 py-0.5 hover:bg-bg-hover transition-colors cursor-pointer'
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
                  <span className="text-[10px] text-text-tertiary truncate">
                    {tool.label}
                    {!compact && tool.hint ? ` — ${tool.hint}` : ''}
                  </span>
                </label>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 远程访问工具组 */}
      {remoteTools.length > 0 && (
        <div className={compact ? 'border-t border-border-secondary mt-0.5' : 'mt-2'}>
          <div className={compact ? '' : 'border-l-2 border-blue-500/40 pl-3'}>
            {!compact && (
              <div className="flex items-center gap-1.5 py-1">
                <Globe size={11} className="text-blue-400" />
                <span className="text-[11px] font-medium text-blue-400">
                  {t('projectForm.toolsRemoteGroup')}
                </span>
              </div>
            )}
            <div className={compact ? 'py-0.5' : 'space-y-0.5'}>
              {remoteTools.map((tool) => (
                <label
                  key={tool.name}
                  className={
                    compact
                      ? 'flex items-center gap-1.5 w-full px-2 py-0.5 hover:bg-bg-hover transition-colors cursor-pointer'
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
                  <span className="text-[10px] text-text-tertiary truncate">
                    {tool.label}
                    {!compact && tool.hint ? ` — ${tool.hint}` : ''}
                  </span>
                </label>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 子智能体工具组 */}
      {subAgentTools.length > 0 && (
        <div className={compact ? 'border-t border-border-secondary mt-0.5' : 'mt-2'}>
          <div className={compact ? '' : 'border-l-2 border-amber-500/40 pl-3'}>
            {!compact && (
              <div className="py-1">
                <div className="flex items-center gap-1.5">
                  <Bot size={11} className="text-amber-400" />
                  <span className="text-[11px] font-medium text-amber-400">
                    {t('projectForm.toolsSubAgentGroup')}
                  </span>
                </div>
                <p className="text-[10px] text-text-tertiary leading-relaxed mt-1">
                  {t('projectForm.toolsSubAgentDesc')}
                </p>
              </div>
            )}
            <div className={compact ? 'py-0.5' : 'space-y-0.5'}>
              {subAgentTools.map((tool) => (
                <label
                  key={tool.name}
                  className={
                    compact
                      ? 'flex items-center gap-1.5 w-full px-2 py-0.5 hover:bg-bg-hover transition-colors cursor-pointer'
                      : 'flex items-center gap-1.5 cursor-pointer select-none py-0.5'
                  }
                >
                  <input
                    type="checkbox"
                    checked={enabledTools.includes(tool.name)}
                    onChange={() => toggle(tool.name)}
                    className="rounded border-border-primary accent-accent w-3.5 h-3.5 flex-shrink-0"
                  />
                  <span className="text-[11px] font-mono text-amber-300 whitespace-nowrap flex-shrink-0">
                    {tool.name}
                  </span>
                  <span className="text-[10px] text-text-tertiary truncate">
                    {tool.label}
                    {!compact && tool.hint ? ` — ${tool.hint}` : ''}
                  </span>
                </label>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* MCP 服务器（每个服务器一行开关） */}
      {!builtinOnly && mcpTools.length > 0 && (
        <div className={compact ? 'border-t border-border-secondary mt-0.5' : 'mt-3'}>
          <div className={compact ? '' : 'border-l-2 border-purple-500/40 pl-3'}>
            {!compact && (
              <div className="flex items-center gap-1.5 py-1">
                <Puzzle size={11} className="text-purple-400" />
                <span className="text-[11px] font-medium text-purple-400">MCP</span>
              </div>
            )}
            <div className={compact ? 'py-0.5' : 'space-y-0.5'}>
              {mcpTools.map((tool) => {
                const isOnline = tool.serverStatus === 'connected'
                return (
                  <label
                    key={tool.name}
                    className={
                      compact
                        ? `flex items-center gap-1.5 w-full px-2 py-0.5 hover:bg-bg-hover transition-colors cursor-pointer ${!isOnline ? 'opacity-50' : ''}`
                        : `flex items-center gap-1.5 cursor-pointer select-none py-0.5 ${!isOnline ? 'opacity-50' : ''}`
                    }
                  >
                    <input
                      type="checkbox"
                      checked={enabledTools.includes(tool.name)}
                      onChange={() => toggle(tool.name)}
                      className="rounded border-border-primary accent-accent w-3.5 h-3.5 flex-shrink-0"
                    />
                    <span
                      className={`text-[11px] font-mono whitespace-nowrap flex-shrink-0 ${isOnline ? 'text-purple-300' : 'text-red-300/60'}`}
                    >
                      {mcpServerName(tool.name)}
                    </span>
                    {!isOnline && (
                      <span
                        className="flex items-center gap-0.5 text-[10px] text-red-400"
                        title={t('settings.mcpStatusDisconnected')}
                      >
                        <WifiOff size={10} />
                      </span>
                    )}
                    <span className="text-[10px] text-text-tertiary truncate flex-1 min-w-0">
                      {tool.label}
                    </span>
                  </label>
                )
              })}
            </div>
          </div>
        </div>
      )}

      {/* Skills（每个 skill 一行开关） */}
      {!builtinOnly && skillTools.length > 0 && (
        <div className={compact ? 'border-t border-border-secondary mt-0.5' : 'mt-3'}>
          <div className={compact ? '' : 'border-l-2 border-emerald-500/40 pl-3'}>
            {!compact && (
              <div className="flex items-center gap-1.5 py-1">
                <BookOpen size={11} className="text-emerald-400" />
                <span className="text-[11px] font-medium text-emerald-400">Skills</span>
              </div>
            )}
            <div className={compact ? 'py-0.5' : 'space-y-0.5'}>
              {skillTools.map((tool) => (
                <label
                  key={tool.name}
                  className={
                    compact
                      ? 'flex items-center gap-1.5 w-full px-2 py-0.5 hover:bg-bg-hover transition-colors cursor-pointer'
                      : 'flex items-center gap-1.5 cursor-pointer select-none py-0.5'
                  }
                >
                  <input
                    type="checkbox"
                    checked={enabledTools.includes(tool.name)}
                    onChange={() => toggle(tool.name)}
                    className="rounded border-border-primary accent-accent w-3.5 h-3.5 flex-shrink-0"
                  />
                  <span className="text-[11px] font-mono text-emerald-300 whitespace-nowrap flex-shrink-0">
                    {skillShortName(tool.name)}
                  </span>
                  <span className="text-[10px] text-text-tertiary truncate flex-1 min-w-0">
                    {tool.label}
                  </span>
                </label>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
