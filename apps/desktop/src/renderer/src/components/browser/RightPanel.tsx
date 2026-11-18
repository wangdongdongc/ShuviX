/**
 * RightPanel — 右侧面板容器（app 级工具栏：Widget / Agents / 文件时间线，终端在底部栏 BottomPanel；
 * 会话绑定的 Files / Sub-agent 在聊天区内的会话面板 SessionPanel；浏览器是独立窗口 BrowserWindowShell；
 * 文件预览是独立窗口，见 previewWindowService）
 *
 * 各面板始终挂载，通过 visibility 切换，避免 iframe 重建
 *
 * 收件箱与日历原先也是这里的标签；2026-11-16 起它们是左侧栏的两种视图（见 Sidebar 的 SidebarViewSwitch），
 * 这里只剩小组件与智能体
 */

import { useEffect } from 'react'
import { Activity, Images, Wrench } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useBrowserStore, type PanelTab } from '../../stores/browserStore'
import { LibraryTimeline, PanelTabBar, type PanelTabItem } from '@shuvix/app-shell'
import { useChatStore } from '@shuvix/chat-ui'
import { WidgetPanel } from './WidgetPanel'
import { AgentMonitorPanel } from './AgentMonitorPanel'
import { useWidgetStore } from '../../stores/widgetStore'

interface TabDef {
  key: PanelTab
  labelKey: string
  Icon: typeof Wrench
}

const tabs: TabDef[] = [
  { key: 'widget', labelKey: 'panel.widget', Icon: Wrench },
  { key: 'agents', labelKey: 'panel.agents', Icon: Activity },
  // 键是 library 而不是 files：共享 store 的旧默认值就叫 'files'，用它会让老用户一打开就落在这一页
  { key: 'library', labelKey: 'library.tab', Icon: Images }
]

export function RightPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const activeTab = useBrowserStore((s) => s.activeTab)
  const setActiveTab = useBrowserStore((s) => s.setActiveTab)
  const width = useBrowserStore((s) => s.width)
  const widgetCount = useWidgetStore((s) => s.widgets.length)
  const openSession = useChatStore((s) => s.setActiveSessionId)
  // activeTab 兜底：共享 store 默认 'files'（该 tab 已移至会话面板）、持久化里留着已移除的
  // 'preview' / 'inbox' / 'calendar'（后两个搬去了左侧栏）→ 落到第一个（小组件）
  useEffect(() => {
    if (!tabs.some((td) => td.key === activeTab)) setActiveTab('widget')
  }, [activeTab, setActiveTab])

  // tab 模型交共享 PanelTabBar 渲染（统一外观 + 自动 compact + 专注淡化）；徽标按 tab 取计数
  const tabItems: PanelTabItem[] = tabs.map(({ key, labelKey, Icon }) => ({
    key,
    label: t(labelKey),
    Icon,
    badge: key === 'widget' ? widgetCount : undefined
  }))

  return (
    <div className="flex flex-col h-full overflow-hidden" style={{ width, minWidth: 200 }}>
      {/* 顶部标签栏（共享 PanelTabBar；Electron 窗口拖拽 + bg-bg-primary 背景） */}
      <PanelTabBar
        tabs={tabItems}
        activeKey={activeTab}
        onSelect={(key) => setActiveTab(key as PanelTab)}
        windowDrag
        className="bg-bg-primary"
      />

      {/* 内容区 — 所有面板共存，visibility 切换 */}
      <div className="flex-1 min-h-0 relative">
        <div
          data-right-panel-pane="widget"
          className="absolute inset-0"
          style={
            activeTab === 'widget' ? undefined : { visibility: 'hidden', pointerEvents: 'none' }
          }
        >
          <WidgetPanel />
        </div>
        <div
          data-right-panel-pane="agents"
          className="absolute inset-0"
          style={
            activeTab === 'agents' ? undefined : { visibility: 'hidden', pointerEvents: 'none' }
          }
        >
          {/* 常驻挂载，故轮询由 active 门控：只有 tab 可见时才每秒取数 */}
          <AgentMonitorPanel active={activeTab === 'agents'} />
        </div>
        <div
          data-right-panel-pane="library"
          className="absolute inset-0"
          style={
            activeTab === 'library' ? undefined : { visibility: 'hidden', pointerEvents: 'none' }
          }
        >
          {/* 常驻挂载：重新可见时重取一次，之后跟着 library.changed */}
          <LibraryTimeline active={activeTab === 'library'} onOpenSession={openSession} />
        </div>
      </div>
    </div>
  )
}
