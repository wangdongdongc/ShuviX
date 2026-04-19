/**
 * RightPanel — 右侧面板容器
 * 顶部标签栏切换 Preview / Terminal / Widget
 *
 * 各面板始终挂载，通过 visibility 切换，避免 xterm/iframe/WebContentsView 重建
 */

import { Monitor, TerminalSquare, Wrench } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { usePreviewStore, type PanelTab } from '../../stores/previewStore'
import { PreviewPanel } from './PreviewPanel'
import { TerminalPanel } from '../terminal/TerminalPanel'
import { WidgetPanel } from './WidgetPanel'
import { useWidgetStore } from '../../stores/widgetStore'

const tabs: { key: PanelTab; labelKey: string; Icon: typeof Monitor }[] = [
  { key: 'preview', labelKey: 'panel.preview', Icon: Monitor },
  { key: 'terminal', labelKey: 'panel.terminal', Icon: TerminalSquare },
  { key: 'widget', labelKey: 'panel.widget', Icon: Wrench }
]

export function RightPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const activeTab = usePreviewStore((s) => s.activeTab)
  const setActiveTab = usePreviewStore((s) => s.setActiveTab)
  const width = usePreviewStore((s) => s.width)
  const widgetCount = useWidgetStore((s) => s.widgets.length)

  return (
    <div className="flex flex-col h-full overflow-hidden" style={{ width, minWidth: 200 }}>
      {/* 顶部标签栏 */}
      <div className="titlebar-drag flex-shrink-0 flex items-center border-b border-border-secondary/30 bg-bg-primary">
        {tabs.map(({ key, labelKey, Icon }) => (
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
            {activeTab === key && (
              <span className="absolute bottom-0 left-2 right-2 h-[2px] bg-accent rounded-t" />
            )}
          </button>
        ))}
      </div>

      {/* 内容区 — 三个面板共存，visibility 切换 */}
      <div className="flex-1 min-h-0 relative">
        <div
          className="absolute inset-0"
          style={
            activeTab === 'preview' ? undefined : { visibility: 'hidden', pointerEvents: 'none' }
          }
        >
          <PreviewPanel />
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
      </div>
    </div>
  )
}
