/**
 * RightPanel — 右侧面板容器
 * 顶部标签栏切换 Browser / Terminal / Widget / Sub-agent
 *
 * 各面板始终挂载，通过 visibility 切换，避免 xterm/iframe/WebContentsView 重建
 */

import { useMemo } from 'react'
import { Bot, Monitor, TerminalSquare, Wrench } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useBrowserStore, type PanelTab } from '../../stores/browserStore'
import { BrowserPanel } from './BrowserPanel'
import { TerminalPanel } from '../terminal/TerminalPanel'
import { WidgetPanel } from './WidgetPanel'
import { SubAgentPanel } from '../subagent/SubAgentPanel'
import { useWidgetStore } from '../../stores/widgetStore'
import { useSubSessionStore, selectSubSessionList } from '../../stores/subSessionStore'
import { useChatStore } from '../../stores/chatStore'

interface TabDef {
  key: PanelTab
  labelKey: string
  Icon: typeof Monitor
  /** 返回 true 时才在 tab 栏渲染按钮；undefined 视作 always shown */
  visible?: () => boolean
}

const tabs: TabDef[] = [
  { key: 'browser', labelKey: 'panel.browser', Icon: Monitor },
  { key: 'terminal', labelKey: 'panel.terminal', Icon: TerminalSquare },
  { key: 'widget', labelKey: 'panel.widget', Icon: Wrench },
  { key: 'subagent', labelKey: 'panel.subAgent', Icon: Bot }
]

export function RightPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const activeTab = useBrowserStore((s) => s.activeTab)
  const setActiveTab = useBrowserStore((s) => s.setActiveTab)
  const width = useBrowserStore((s) => s.width)
  const widgetCount = useWidgetStore((s) => s.widgets.length)
  const allSubSessions = useSubSessionStore(selectSubSessionList)
  const activeSessionId = useChatStore((s) => s.activeSessionId)

  // 仅统计归属当前主会话的子会话
  const subAgentCount = useMemo(
    () =>
      activeSessionId
        ? allSubSessions.filter((s) => s.parentSessionId === activeSessionId).length
        : 0,
    [allSubSessions, activeSessionId]
  )

  // subagent tab 只在当前主会话下有子会话时显示；其它 tab 始终显示
  const visibleTabs = tabs.filter((t) => (t.key === 'subagent' ? subAgentCount > 0 : true))

  return (
    <div className="flex flex-col h-full overflow-hidden" style={{ width, minWidth: 200 }}>
      {/* 顶部标签栏 */}
      <div className="titlebar-drag flex-shrink-0 flex items-center border-b border-border-secondary/30 bg-bg-primary">
        {visibleTabs.map(({ key, labelKey, Icon }) => (
          <button
            key={key}
            onClick={() => setActiveTab(key)}
            className={`titlebar-no-drag flex items-center gap-1 px-3 h-8 text-[11px] font-medium transition-colors relative ${
              activeTab === key
                ? 'text-text-primary'
                : 'text-text-tertiary hover:text-text-secondary'
            }`}
          >
            <Icon size={12} />
            <span>{t(labelKey)}</span>
            {key === 'widget' && widgetCount > 0 && (
              <span className="ml-0.5 text-[10px] text-text-tertiary/60 tabular-nums">
                {widgetCount}
              </span>
            )}
            {key === 'subagent' && subAgentCount > 0 && (
              <span className="ml-0.5 text-[10px] text-text-tertiary/60 tabular-nums">
                {subAgentCount}
              </span>
            )}
            {activeTab === key && (
              <span className="absolute bottom-0 left-2 right-2 h-[2px] bg-accent rounded-t" />
            )}
          </button>
        ))}
      </div>

      {/* 内容区 — 所有面板共存，visibility 切换 */}
      <div className="flex-1 min-h-0 relative">
        <div
          className="absolute inset-0"
          style={
            activeTab === 'browser' ? undefined : { visibility: 'hidden', pointerEvents: 'none' }
          }
        >
          <BrowserPanel />
        </div>
        <div
          className="absolute inset-0"
          style={
            activeTab === 'terminal' ? undefined : { visibility: 'hidden', pointerEvents: 'none' }
          }
        >
          <TerminalPanel />
        </div>
        <div
          className="absolute inset-0"
          style={
            activeTab === 'widget' ? undefined : { visibility: 'hidden', pointerEvents: 'none' }
          }
        >
          <WidgetPanel />
        </div>
        <div
          className="absolute inset-0"
          style={
            activeTab === 'subagent' ? undefined : { visibility: 'hidden', pointerEvents: 'none' }
          }
        >
          <SubAgentPanel />
        </div>
      </div>
    </div>
  )
}
