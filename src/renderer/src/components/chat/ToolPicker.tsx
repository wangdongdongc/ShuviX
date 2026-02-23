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
  const activeCount = enabledTools.filter(n => validNames.has(n)).length
  const totalCount = allTools.length
  const disabledCount = totalCount - activeCount

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
    <div ref={toolsRef} className="relative flex items-center">
      <button
        onClick={() => setOpen(!open)}
        className={`inline-flex items-center gap-1 text-[11px] transition-colors ${
          disabledCount > 0
            ? 'text-amber-400 hover:text-amber-300'
            : 'text-amber-400/50 hover:text-amber-400'
        }`}
        title={t('input.tools')}
      >
        <Wrench size={11} />
        {disabledCount > 0 && <span>-{disabledCount}</span>}
      </button>

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
