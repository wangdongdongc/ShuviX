import { useRef, useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Wrench } from 'lucide-react'
import { useChatStore } from '../../stores/chatStore'
import { useClickOutside } from '../../hooks/useClickOutside'
import { ToolSelectList, type ToolItem } from '../common/ToolSelectList'

/**
 * 工具选择器 — 动态切换会话启用的工具集
 */
export function ToolPicker(): React.JSX.Element | null {
  const { t } = useTranslation()
  const { activeSessionId, enabledTools, setEnabledTools } = useChatStore()

  const toolsRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [allTools, setAllTools] = useState<ToolItem[]>([])

  const close = useCallback(() => setOpen(false), [])
  useClickOutside(toolsRef, close, open)

  /** 拉取工具列表并清理陈旧名称 */
  const fetchTools = useCallback(() => {
    window.api.tools.list().then(tools => {
      setAllTools(tools)
      const validNames = new Set(tools.map(t => t.name))
      const currentEnabled = useChatStore.getState().enabledTools
      const cleaned = currentEnabled.filter(n => validNames.has(n))
      if (cleaned.length !== currentEnabled.length) {
        void handleChange(cleaned)
      }
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 挂载时加载一次
  useEffect(() => { fetchTools() }, [fetchTools])

  // 每次打开下拉面板时实时刷新
  useEffect(() => {
    if (open) fetchTools()
  }, [open, fetchTools])

  if (allTools.length === 0) return null

  // 仅统计在 allTools 中实际存在的已启用工具
  const validNames = new Set(allTools.map(t => t.name))
  const activeEnabledTools = enabledTools.filter(n => validNames.has(n))
  const activeCount = activeEnabledTools.length
  const totalCount = allTools.length
  const disabledCount = totalCount - activeCount

  // 分类统计已启用工具用于 tooltip
  const enabledBuiltinTools = allTools.filter(t => !t.group && activeEnabledTools.includes(t.name))
  const enabledMcpTools = allTools.filter(t => t.group && t.group !== '__skills__' && activeEnabledTools.includes(t.name))
  const enabledSkillTools = allTools.filter(t => t.group === '__skills__' && activeEnabledTools.includes(t.name))
  // 按 server 分组的 MCP 工具
  const enabledMcpGroups = [...new Set(enabledMcpTools.map(t => t.group!))]

  /** 工具变更：更新本地状态 + 同步 Agent + 持久化 */
  const handleChange = async (newTools: string[]): Promise<void> => {
    setEnabledTools(newTools)
    if (activeSessionId) {
      await window.api.agent.setEnabledTools({ sessionId: activeSessionId, tools: newTools })
      // 持久化到 session modelMetadata
      const currentMeta = (() => {
        const s = useChatStore.getState().sessions.find((s) => s.id === activeSessionId)
        try { return JSON.parse(s?.modelMetadata || '{}') } catch { return {} }
      })()
      currentMeta.enabledTools = newTools
      await window.api.session.updateModelMetadata({
        id: activeSessionId,
        modelMetadata: JSON.stringify(currentMeta)
      })
    }
  }

  return (
    <div ref={toolsRef} className="relative flex items-center group">
      <button
        onClick={() => setOpen(!open)}
        className={`inline-flex items-center gap-1 text-[11px] transition-colors ${
          disabledCount > 0
            ? 'text-amber-400 hover:text-amber-300'
            : 'text-amber-400/50 hover:text-amber-400'
        }`}
      >
        <Wrench size={11} />
        {disabledCount > 0 && <span>-{disabledCount}</span>}
      </button>

      {/* 悬浮 tooltip：已启用的工具列表（展开时不显示） */}
      {!open && activeCount > 0 && (
        <div className="pointer-events-none absolute left-0 bottom-6 z-20 hidden min-w-[200px] max-w-[280px] rounded-md border border-border-primary bg-bg-secondary px-2 py-1.5 shadow-xl group-hover:block">
          <div className="text-[10px] text-text-tertiary mb-1">{t('input.tools')}</div>
          <div className="space-y-1 max-h-40 overflow-y-auto">
            {/* 内置工具 */}
            {enabledBuiltinTools.length > 0 && (
              <div className="text-[11px] text-text-primary">
                {enabledBuiltinTools.map(t => t.name).join(', ')}
              </div>
            )}
            {/* MCP 工具按 server 分组 */}
            {enabledMcpGroups.map(group => {
              const tools = enabledMcpTools.filter(t => t.group === group)
              return (
                <div key={group} className="flex items-center gap-1.5">
                  <span className="text-[10px] text-purple-400">[{group}]</span>
                  <span className="text-[11px] text-text-primary truncate">
                    {tools.map(t => t.name.split('__').pop() || t.name).join(', ')}
                  </span>
                </div>
              )
            })}
            {/* Skills */}
            {enabledSkillTools.length > 0 && (
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] text-emerald-400">[Skills]</span>
                <span className="text-[11px] text-text-primary truncate">
                  {enabledSkillTools.map(t => t.name.startsWith('skill:') ? t.name.slice(6) : t.name).join(', ')}
                </span>
              </div>
            )}
          </div>
        </div>
      )}

      {open && (
        <div className="absolute left-0 bottom-8 w-[240px] rounded-lg border border-border-primary bg-bg-secondary shadow-2xl overflow-hidden">
          <div className="px-2 py-1.5 border-b border-border-secondary text-[10px] text-text-tertiary">{t('input.tools')}</div>
          <div className="py-1">
            <ToolSelectList
              tools={allTools}
              enabledTools={enabledTools}
              onChange={(tools) => { void handleChange(tools) }}
              compact
            />
          </div>
        </div>
      )}
    </div>
  )
}
