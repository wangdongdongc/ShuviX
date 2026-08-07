import { getSessionChannelApi, getHostApi } from '@shuvix/chat-ui'
import { useRef, useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Server, BookOpen, WifiOff } from 'lucide-react'
import { useChatStore } from '../../stores/chatStore'
import { useClickOutside } from '../../hooks/useClickOutside'
import type { ToolItem } from '../common/ToolSelectList'

const SKILLS_GROUP = '__skills__'

/** 提取 MCP 服务器短名（mcp:context7 → context7） */
function mcpShortName(name: string): string {
  return name.startsWith('mcp:') ? name.slice(4) : name
}

/** 提取 Skill 短名（skill:pdf → pdf） */
function skillShortName(name: string): string {
  return name.startsWith('skill:') ? name.slice(6) : name
}

/** 解析 skill 显示信息：内置 skill 去掉 builtin: 前缀并标记为内置 */
function parseSkillDisplay(name: string): { label: string; builtin: boolean } {
  const short = skillShortName(name)
  if (short.startsWith('builtin:')) {
    return { label: short.slice('builtin:'.length), builtin: true }
  }
  return { label: short, builtin: false }
}

/**
 * 工具选择器 — 动态切换会话启用的 MCP / Skill 集
 *
 * 内置工具与 SubAgent 始终启用，不在此处控制。
 */
export function ToolPicker(): React.JSX.Element | null {
  const { t } = useTranslation()
  const { activeSessionId, enabledTools, setEnabledTools } = useChatStore()

  const toolsRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [allTools, setAllTools] = useState<ToolItem[]>([])

  const close = useCallback(() => setOpen(false), [])
  useClickOutside(toolsRef, close, open)

  const fetchTools = useCallback(() => {
    const sid = useChatStore.getState().activeSessionId
    getSessionChannelApi()
      .tools.list(sid ?? undefined)
      .then((tools) => {
        setAllTools(tools)
        const validNames = new Set(tools.map((t) => t.name))
        const currentEnabled = useChatStore.getState().enabledTools
        const cleaned = currentEnabled.filter((n) => validNames.has(n))
        if (cleaned.length !== currentEnabled.length) {
          void handleChange(cleaned)
        }
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    fetchTools()
  }, [fetchTools])

  useEffect(() => {
    if (open) fetchTools()
  }, [open, fetchTools])

  const mcpTools = allTools.filter((t) => t.group?.startsWith('mcp:'))
  const skillTools = allTools.filter((t) => t.group === SKILLS_GROUP)

  if (mcpTools.length === 0 && skillTools.length === 0) return null

  const enabledMcpTools = mcpTools.filter((t) => enabledTools.includes(t.name))
  const enabledSkillTools = skillTools.filter((t) => enabledTools.includes(t.name))

  const handleChange = async (newTools: string[]): Promise<void> => {
    const host = getHostApi()
    if (!host) return // 渠道端无权改工具集（UI 已隐藏，双保险）
    setEnabledTools(newTools)
    if (activeSessionId) {
      // 单一写入口：落 active_tools_change entry（Agent 未创建时后端直接写树）
      await host.agent.setEnabledTools({ sessionId: activeSessionId, tools: newTools })
    }
  }

  const toggle = (name: string): void => {
    const next = enabledTools.includes(name)
      ? enabledTools.filter((n) => n !== name)
      : [...enabledTools, name]
    void handleChange(next)
  }

  return (
    <div ref={toolsRef} className="relative flex items-center group">
      <button
        onClick={() => setOpen(!open)}
        className="inline-flex items-center gap-1.5 text-[11px] text-text-tertiary hover:text-text-secondary transition-colors border border-transparent hover:border-border-secondary rounded px-1.5 py-0.5"
      >
        {mcpTools.length > 0 && (
          <span className="inline-flex items-center gap-0.5">
            <Server size={10} />
            <span>{enabledMcpTools.length}</span>
          </span>
        )}
        {skillTools.length > 0 && (
          <span className="inline-flex items-center gap-0.5">
            <BookOpen size={10} />
            <span>{enabledSkillTools.length}</span>
          </span>
        )}
      </button>

      {/* 悬浮 tooltip：已启用的工具列表 */}
      {!open && (enabledMcpTools.length > 0 || enabledSkillTools.length > 0) && (
        <div className="pointer-events-none absolute left-0 bottom-6 z-20 hidden min-w-[200px] max-w-[280px] rounded-md border border-border-primary bg-bg-secondary px-2 py-1.5 shadow-xl group-hover:block">
          <div className="text-[10px] text-text-tertiary mb-1">{t('input.tools')}</div>
          <div className="space-y-1 max-h-40 overflow-y-auto">
            {enabledMcpTools.length > 0 && (
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] text-text-secondary">[MCP]</span>
                <span className="text-[11px] text-text-primary truncate">
                  {enabledMcpTools.map((t) => mcpShortName(t.name)).join(', ')}
                </span>
              </div>
            )}
            {enabledSkillTools.length > 0 && (
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] text-text-secondary">[Skills]</span>
                <span className="text-[11px] text-text-primary truncate">
                  {enabledSkillTools.map((t) => parseSkillDisplay(t.name).label).join(', ')}
                </span>
              </div>
            )}
          </div>
        </div>
      )}

      {open && (
        <div className="picker-panel absolute left-0 bottom-8 z-30 w-[240px] rounded-lg border border-border-primary bg-bg-secondary shadow-2xl overflow-hidden">
          <div className="py-1 max-h-[60vh] overflow-y-auto">
            {mcpTools.length > 0 && (
              <div className="py-0.5">
                <div className="px-2 py-1 text-[10px] font-medium text-text-tertiary">MCP</div>
                {mcpTools.map((tool) => {
                  const isOnline = tool.serverStatus === 'connected'
                  return (
                    <label
                      key={tool.name}
                      className={`flex items-center gap-1.5 w-full px-2 py-0.5 hover:bg-bg-hover transition-colors cursor-pointer ${!isOnline ? 'opacity-50' : ''}`}
                    >
                      <input
                        type="checkbox"
                        checked={enabledTools.includes(tool.name)}
                        onChange={() => toggle(tool.name)}
                        className="rounded border-border-primary accent-accent w-3.5 h-3.5 flex-shrink-0"
                      />
                      {tool.isBuiltin && (
                        <span className="px-1 py-px rounded text-[9px] font-medium text-amber-500 bg-amber-500/10 whitespace-nowrap flex-shrink-0">
                          {t('input.skillBuiltinBadge')}
                        </span>
                      )}
                      <span
                        className={`text-[11px] font-mono whitespace-nowrap flex-shrink-0 ${isOnline ? 'text-purple-300' : 'text-red-300/60'}`}
                      >
                        {mcpShortName(tool.name)}
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
            )}
            {mcpTools.length > 0 && skillTools.length > 0 && (
              <div className="border-t border-border-secondary my-0.5" />
            )}
            {skillTools.length > 0 && (
              <div className="py-0.5">
                <div className="px-2 py-1 text-[10px] font-medium text-text-tertiary">SKILL</div>
                {skillTools.map((tool) => {
                  const { label, builtin } = parseSkillDisplay(tool.name)
                  return (
                    <label
                      key={tool.name}
                      className="flex items-center gap-1.5 w-full px-2 py-0.5 hover:bg-bg-hover transition-colors cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={enabledTools.includes(tool.name)}
                        onChange={() => toggle(tool.name)}
                        className="rounded border-border-primary accent-accent w-3.5 h-3.5 flex-shrink-0"
                      />
                      {builtin && (
                        <span className="px-1 py-px rounded text-[9px] font-medium text-amber-500 bg-amber-500/10 whitespace-nowrap flex-shrink-0">
                          {t('input.skillBuiltinBadge')}
                        </span>
                      )}
                      <span className="text-[11px] font-mono text-emerald-300 whitespace-nowrap flex-shrink-0">
                        {label}
                      </span>
                      <span className="text-[10px] text-text-tertiary truncate flex-1 min-w-0">
                        {tool.label}
                      </span>
                    </label>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
