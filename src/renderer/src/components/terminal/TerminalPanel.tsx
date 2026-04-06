/**
 * TerminalPanel — 终端面板，支持多标签
 * 每个标签对应一个独立的 PTY 终端实例（由 terminalStore 管理生命周期）
 */

import { useCallback } from 'react'
import { Plus, X } from 'lucide-react'
import { useTerminalStore } from '../../stores/terminalStore'
import { useChatStore } from '../../stores/chatStore'
import { XTerminal } from './XTerminal'

export function TerminalPanel(): React.JSX.Element {
  const { tabs, activeTabId, createTab, closeTab, setActiveTab } = useTerminalStore()
  const projectPath = useChatStore((s) => s.projectPath)

  const handleNewTab = useCallback(() => {
    createTab(projectPath || undefined)
  }, [createTab, projectPath])

  const handleCloseTab = useCallback(
    (e: React.MouseEvent, id: string) => {
      e.stopPropagation()
      closeTab(id)
    },
    [closeTab]
  )

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* 标签栏 */}
      <div className="flex-shrink-0 flex items-center min-h-7 bg-bg-secondary/40 border-b border-border-secondary/30">
        <div className="flex items-center flex-1 min-w-0 overflow-x-auto scrollbar-none">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-1.5 px-2.5 h-7 text-[11px] transition-colors group whitespace-nowrap ${
                activeTabId === tab.id
                  ? 'text-text-primary bg-bg-primary'
                  : 'text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/30'
              }`}
            >
              <span>{tab.title}</span>
              <span
                onClick={(e) => handleCloseTab(e, tab.id)}
                className="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-bg-hover transition-opacity"
              >
                <X size={10} />
              </span>
            </button>
          ))}
        </div>
        <button
          onClick={handleNewTab}
          className="flex-shrink-0 p-1.5 mx-0.5 text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/50 rounded transition-colors"
          title="New Terminal"
        >
          <Plus size={12} />
        </button>
      </div>

      {/* 终端内容区 */}
      <div className="flex-1 min-h-0 relative bg-bg-secondary">
        {tabs.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <button
              onClick={handleNewTab}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-text-tertiary hover:text-text-secondary bg-bg-secondary/40 hover:bg-bg-secondary/70 rounded-md transition-colors"
            >
              <Plus size={12} />
              <span>New Terminal</span>
            </button>
          </div>
        ) : (
          tabs.map((tab) => {
            const isActive = activeTabId === tab.id
            return (
              <div
                key={tab.id}
                className="absolute inset-0"
                style={isActive ? undefined : { visibility: 'hidden', pointerEvents: 'none' }}
              >
                <XTerminal tab={tab} visible={isActive} />
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
