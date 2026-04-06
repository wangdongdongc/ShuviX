/**
 * RightPanel — 右侧面板容器
 * 顶部标签栏切换 Preview / Terminal
 *
 * 两个面板始终挂载，通过 visibility 切换，避免 xterm/iframe 重建
 */

import { Monitor, TerminalSquare } from 'lucide-react'
import { usePreviewStore, type PanelTab } from '../../stores/previewStore'
import { PreviewPanel } from './PreviewPanel'
import { TerminalPanel } from '../terminal/TerminalPanel'

const tabs: { key: PanelTab; label: string; Icon: typeof Monitor }[] = [
  { key: 'preview', label: 'Preview', Icon: Monitor },
  { key: 'terminal', label: 'Terminal', Icon: TerminalSquare }
]

export function RightPanel(): React.JSX.Element {
  const activeTab = usePreviewStore((s) => s.activeTab)
  const setActiveTab = usePreviewStore((s) => s.setActiveTab)
  const width = usePreviewStore((s) => s.width)

  return (
    <div className="flex flex-col h-full overflow-hidden" style={{ width, minWidth: 200 }}>
      {/* 顶部标签栏 */}
      <div className="titlebar-drag flex-shrink-0 flex items-center border-b border-border-secondary/30 bg-bg-primary">
        {tabs.map(({ key, label, Icon }) => (
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
            <span>{label}</span>
            {activeTab === key && (
              <span className="absolute bottom-0 left-2 right-2 h-[2px] bg-accent rounded-t" />
            )}
          </button>
        ))}
      </div>

      {/* 内容区 — 两个面板共存，visibility 切换 */}
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
      </div>
    </div>
  )
}
