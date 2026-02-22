import { useRef, useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Wrench } from 'lucide-react'
import { useChatStore } from '../stores/chatStore'
import { useClickOutside } from '../hooks/useClickOutside'

/**
 * 工具选择器 — 动态切换会话启用的工具集
 */
export function ToolPicker(): React.JSX.Element | null {
  const { t } = useTranslation()
  const { activeSessionId, enabledTools, setEnabledTools } = useChatStore()

  const toolsRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [allTools, setAllTools] = useState<Array<{ name: string; label: string }>>([])

  const close = useCallback(() => setOpen(false), [])
  useClickOutside(toolsRef, close, open)

  // 加载工具列表
  useEffect(() => {
    window.api.tools.list().then(setAllTools)
  }, [])

  if (allTools.length === 0) return null

  /** 切换单个工具的启用状态 */
  const handleToggleTool = async (toolName: string): Promise<void> => {
    const newTools = enabledTools.includes(toolName)
      ? enabledTools.filter((n) => n !== toolName)
      : [...enabledTools, toolName]
    setEnabledTools(newTools)
    // 动态更新 Agent 工具集
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
    <div ref={toolsRef} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className={`h-6 inline-flex items-center gap-1 px-2 rounded-md border bg-bg-primary/45 backdrop-blur-sm text-[10px] hover:bg-bg-primary/60 transition-colors ${
          enabledTools.length < allTools.length
            ? 'border-orange-500/50 text-orange-400'
            : 'border-border-primary/70 text-text-secondary hover:text-text-primary'
        }`}
        title={t('input.tools')}
      >
        <Wrench size={11} />
        <span>{enabledTools.length}/{allTools.length}</span>
      </button>

      {open && (
        <div className="absolute left-0 bottom-8 w-[160px] rounded-lg border border-border-primary bg-bg-secondary shadow-2xl overflow-hidden">
          <div className="px-2 py-1.5 border-b border-border-secondary text-[10px] text-text-tertiary">{t('input.tools')}</div>
          <div className="py-1">
            {allTools.map((tool) => (
              <label
                key={tool.name}
                className="flex items-center gap-2 w-full px-2 py-1.5 text-[11px] text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={enabledTools.includes(tool.name)}
                  onChange={() => { void handleToggleTool(tool.name) }}
                  className="rounded border-border-primary accent-accent w-3.5 h-3.5"
                />
                {tool.label}
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
