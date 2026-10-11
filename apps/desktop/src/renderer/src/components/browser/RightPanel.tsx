/**
 * RightPanel — 右侧面板容器（app 级工具栏：Widget / Calendar / Agents，终端在底部栏 BottomPanel；
 * 会话绑定的 Files / Sub-agent 在聊天区内的会话面板 SessionPanel；浏览器是独立窗口 BrowserWindowShell；
 * 文件预览是独立窗口，见 previewWindowService）
 *
 * 各面板始终挂载，通过 visibility 切换，避免 iframe 重建
 */

import { useEffect } from 'react'
import { Activity, CalendarDays, Wrench } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useBrowserStore, type PanelTab } from '../../stores/browserStore'
import { PanelTabBar, type PanelTabItem } from '@shuvix/app-shell'
import { WidgetPanel } from './WidgetPanel'
import { CalendarPanel } from './CalendarPanel'
import { AgentMonitorPanel } from './AgentMonitorPanel'
import { useWidgetStore } from '../../stores/widgetStore'

interface TabDef {
  key: PanelTab
  labelKey: string
  Icon: typeof Wrench
}

const tabs: TabDef[] = [
  { key: 'widget', labelKey: 'panel.widget', Icon: Wrench },
  { key: 'calendar', labelKey: 'panel.calendar', Icon: CalendarDays },
  { key: 'agents', labelKey: 'panel.agents', Icon: Activity }
]

export function RightPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const activeTab = useBrowserStore((s) => s.activeTab)
  const setActiveTab = useBrowserStore((s) => s.setActiveTab)
  const width = useBrowserStore((s) => s.width)
  const widgetCount = useWidgetStore((s) => s.widgets.length)
  // activeTab 兜底：共享 store 默认 'files'（该 tab 已移至会话面板）、持久化里留着已移除的
  // 'preview'（文件预览改成了独立窗口）→ 落到 widget
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
            activeTab === 'calendar' ? undefined : { visibility: 'hidden', pointerEvents: 'none' }
          }
        >
          <CalendarPanel />
        </div>
        <div
          className="absolute inset-0"
          style={
            activeTab === 'agents' ? undefined : { visibility: 'hidden', pointerEvents: 'none' }
          }
        >
          {/* 常驻挂载，故轮询由 active 门控：只有 tab 可见时才每秒取数 */}
          <AgentMonitorPanel active={activeTab === 'agents'} />
        </div>
      </div>
    </div>
  )
}
