/**
 * RightPanel — 右侧面板容器
 * 顶部标签栏切换 Browser / Terminal / Widget / Sub-agent
 *
 * 各面板始终挂载，通过 visibility 切换，避免 xterm/iframe/WebContentsView 重建
 */

import { useEffect, useMemo } from 'react'
import { Bot, FolderTree, Monitor, TerminalSquare, Wrench } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useBrowserStore, type PanelTab } from '../../stores/browserStore'
import { BrowserPanel } from './BrowserPanel'
import { TerminalPanel } from '../terminal/TerminalPanel'
import {
  FilesPanel,
  SubAgentPanel,
  MediaUrlProvider,
  shuvixPreviewResolver,
  useCreateNotebook,
  PanelTabBar,
  type PanelTabItem
} from '@shuvix/app-shell'
import { WidgetPanel } from './WidgetPanel'
import { useWidgetStore } from '../../stores/widgetStore'
import { useSubAgentCount } from '@shuvix/chat-ui'
import { useChatStore } from '@shuvix/chat-ui'
import { useSettingsStore } from '../../stores/settingsStore'

interface TabDef {
  key: PanelTab
  labelKey: string
  Icon: typeof Monitor
  /** 返回 true 时才在 tab 栏渲染按钮；undefined 视作 always shown */
  visible?: () => boolean
}

const tabs: TabDef[] = [
  { key: 'files', labelKey: 'panel.files', Icon: FolderTree },
  { key: 'browser', labelKey: 'panel.browser', Icon: Monitor },
  { key: 'terminal', labelKey: 'panel.terminal', Icon: TerminalSquare },
  { key: 'widget', labelKey: 'panel.widget', Icon: Wrench },
  { key: 'subagent', labelKey: 'panel.subAgent', Icon: Bot }
]

interface RightPanelProps {
  /** 悬浮窗模式 —— 隐藏 browser tab（WebContentsView 当前为全局单例，无法跨窗口） */
  pinnedMode?: boolean
}

export function RightPanel({ pinnedMode = false }: RightPanelProps = {}): React.JSX.Element {
  const { t } = useTranslation()
  const activeTab = useBrowserStore((s) => s.activeTab)
  const setActiveTab = useBrowserStore((s) => s.setActiveTab)
  const width = useBrowserStore((s) => s.width)
  const widgetCount = useWidgetStore((s) => s.widgets.length)
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  /** 「创建笔记本」处理器（共享逻辑：建笔记本会话 + 刷新 + 选中） */
  const createNotebook = useCreateNotebook()
  const notebookTheme = useSettingsStore((s) => s.notebookTheme)
  /** Files 面板 markdown 只读 live-preview 的宿主能力（主题 / 外链）—— 与笔记本会话同源。
   *  只读预览不提供编辑右键菜单，故无需注入 popupContextMenu。 */
  const notebookCaps = useMemo(
    () => ({
      notebookTheme,
      openExternal: (url: string) => void window.api.app.openExternal(url)
    }),
    [notebookTheme]
  )

  // 当前主会话下的子会话数（共享 useSubAgentCount）—— >0 才显示 Sub-agent tab
  const subAgentCount = useSubAgentCount(activeSessionId)

  // 悬浮窗:browser tab 走主窗的全局 WebContentsView,无法跨窗口共享 → 隐藏
  // widget tab 当前也由主窗的 widgetServer 集中托管,在悬浮窗里展示意义不大 → 隐藏
  // subagent tab 只在当前主会话下有子会话时显示；其它 tab 始终显示
  const visibleTabs = tabs.filter((t) => {
    if (pinnedMode && (t.key === 'browser' || t.key === 'widget')) return false
    if (t.key === 'subagent') return subAgentCount > 0
    return true
  })

  // 悬浮窗默认 tab 落在 'files' 上;若 activeTab 是被隐藏的 browser/widget tab,自动切到 files
  useEffect(() => {
    if (pinnedMode && (activeTab === 'browser' || activeTab === 'widget')) {
      setActiveTab('files')
    }
  }, [pinnedMode, activeTab, setActiveTab])

  // tab 模型交共享 PanelTabBar 渲染（统一外观 + 自动 compact + 专注淡化）；徽标按 tab 取计数
  const tabItems: PanelTabItem[] = visibleTabs.map(({ key, labelKey, Icon }) => ({
    key,
    label: t(labelKey),
    Icon,
    badge: key === 'widget' ? widgetCount : key === 'subagent' ? subAgentCount : undefined
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
            activeTab === 'terminal' ? undefined : { visibility: 'hidden', pointerEvents: 'none' }
          }
        >
          <TerminalPanel />
        </div>
        <div
          className="absolute inset-0"
          style={
            activeTab === 'files' ? undefined : { visibility: 'hidden', pointerEvents: 'none' }
          }
        >
          {/* 媒体/PDF 走桌面 shuvix-preview:// 协议；.md 预览顶栏可「创建笔记本」绑定该文件 */}
          <MediaUrlProvider value={shuvixPreviewResolver}>
            <FilesPanel
              onCreateNotebook={createNotebook}
              notebookCaps={notebookCaps}
              onOpenFolder={(p) => void window.api.app.openFolder(p)}
            />
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
            activeTab === 'subagent' ? undefined : { visibility: 'hidden', pointerEvents: 'none' }
          }
        >
          <SubAgentPanel />
        </div>
      </div>
    </div>
  )
}
