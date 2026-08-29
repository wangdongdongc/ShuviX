/**
 * RightPanel — 右侧面板容器（app 级工具栏：Browser / Preview / Widget / Calendar，终端在底部栏 BottomPanel；
 * 会话绑定的 Files / Sub-agent 在聊天区内的会话面板 SessionPanel）
 *
 * Preview 是会话无关的独立文件预览（preview 工具事件 / Files 面板点击 / 笔记本 wiki-link 均落到此），
 * 目标状态在共享 usePreviewPanelStore；媒体/PDF 经桌面 shuvix-preview:// 协议。
 *
 * 各面板始终挂载，通过 visibility 切换，避免 iframe/WebContentsView 重建
 */

import { useEffect, useMemo } from 'react'
import { CalendarDays, Eye, Monitor, Wrench } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useBrowserStore, type PanelTab } from '../../stores/browserStore'
import { BrowserPanel } from './BrowserPanel'
import {
  MediaUrlProvider,
  PanelTabBar,
  PreviewPanel,
  shuvixPreviewResolver,
  useCreateNotebook,
  usePreviewPanelStore,
  type PanelTabItem
} from '@shuvix/app-shell'
import { WidgetPanel } from './WidgetPanel'
import { CalendarPanel } from './CalendarPanel'
import { useWidgetStore } from '../../stores/widgetStore'
import { useSettingsStore } from '../../stores/settingsStore'

interface TabDef {
  key: PanelTab
  labelKey: string
  Icon: typeof Monitor
}

const tabs: TabDef[] = [
  { key: 'browser', labelKey: 'panel.browser', Icon: Monitor },
  { key: 'preview', labelKey: 'panel.previewTab', Icon: Eye },
  { key: 'widget', labelKey: 'panel.widget', Icon: Wrench },
  { key: 'calendar', labelKey: 'panel.calendar', Icon: CalendarDays }
]

export function RightPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const activeTab = useBrowserStore((s) => s.activeTab)
  const setActiveTab = useBrowserStore((s) => s.setActiveTab)
  const width = useBrowserStore((s) => s.width)
  const widgetCount = useWidgetStore((s) => s.widgets.length)
  // Preview tab 与会话面板 Sub-agent 同款语义：有预览目标才出现（关闭预览即隐藏）
  const hasPreviewTarget = usePreviewPanelStore((s) => s.target !== null)
  const visibleTabs = tabs.filter((td) => td.key !== 'preview' || hasPreviewTarget)

  // activeTab 兜底：共享 store 默认 'files'（该 tab 已移至会话面板）→ 落到 browser；
  // 停在 preview 但目标已关闭（tab 随之隐藏）同走此兜底
  useEffect(() => {
    if (!visibleTabs.some((td) => td.key === activeTab)) setActiveTab('browser')
  }, [visibleTabs, activeTab, setActiveTab])

  /** Preview tab 的 markdown 宿主能力（主题 / 外链）与「创建笔记本」—— 与会话面板 Files 同源 */
  const createNotebook = useCreateNotebook()
  const notebookTheme = useSettingsStore((s) => s.notebookTheme)
  const notebookCaps = useMemo(
    () => ({
      notebookTheme,
      openExternal: (url: string) => void window.api.app.openExternal(url)
    }),
    [notebookTheme]
  )

  // tab 模型交共享 PanelTabBar 渲染（统一外观 + 自动 compact + 专注淡化）；徽标按 tab 取计数
  const tabItems: PanelTabItem[] = visibleTabs.map(({ key, labelKey, Icon }) => ({
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
            activeTab === 'browser' ? undefined : { visibility: 'hidden', pointerEvents: 'none' }
          }
        >
          <BrowserPanel />
        </div>
        <div
          className="absolute inset-0"
          style={
            activeTab === 'preview' ? undefined : { visibility: 'hidden', pointerEvents: 'none' }
          }
        >
          <MediaUrlProvider value={shuvixPreviewResolver}>
            <PreviewPanel notebookCaps={notebookCaps} onCreateNotebook={createNotebook} />
          </MediaUrlProvider>
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
            activeTab === 'calendar' ? undefined : { visibility: 'hidden', pointerEvents: 'none' }
          }
        >
          <CalendarPanel />
        </div>
      </div>
    </div>
  )
}
