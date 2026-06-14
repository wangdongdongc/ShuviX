/**
 * TerminalPanel — 终端面板，垂直堆叠的纯色卡片布局
 * 所有终端同屏可见，从上到下排列；卡片无头部、无边框，与 xterm 共享同一背景色。
 */

import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, X } from 'lucide-react'
import { useTerminalStore } from '../../stores/terminalStore'
import { useChatStore } from '@shuvix/chat-ui'
import { XTerminal } from './XTerminal'

export function TerminalPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const { tabs, createTab, closeTab } = useTerminalStore()
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

  if (tabs.length === 0) {
    return (
      <div className="flex items-center justify-center h-full bg-bg-secondary">
        <button
          onClick={handleNewTab}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-text-tertiary hover:text-text-secondary bg-bg-primary hover:bg-bg-hover/40 rounded-md transition-colors"
        >
          <Plus size={12} />
          <span>{t('panel.newTerminal')}</span>
        </button>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto bg-bg-secondary">
      <div className="flex flex-col gap-2 p-2">
        {tabs.map((tab) => (
          <div key={tab.id} className="group relative rounded-md overflow-hidden bg-bg-primary">
            <button
              onClick={(e) => handleCloseTab(e, tab.id)}
              className="absolute top-1 right-1 z-10 p-1 rounded text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/70 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
              title={t('panel.closeTerminal')}
            >
              <X size={11} />
            </button>
            <div className="h-72 p-1.5">
              <XTerminal tab={tab} />
            </div>
          </div>
        ))}
        <button
          onClick={handleNewTab}
          className="flex items-center justify-center gap-1.5 w-full py-1.5 text-[11px] text-text-tertiary hover:text-text-secondary bg-bg-primary/60 hover:bg-bg-primary rounded-md transition-colors"
          title={t('panel.newTerminal')}
        >
          <Plus size={12} />
          <span>{t('panel.newTerminal')}</span>
        </button>
      </div>
    </div>
  )
}
