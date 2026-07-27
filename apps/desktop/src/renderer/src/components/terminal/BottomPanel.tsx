/**
 * BottomPanel — 底部面板（终端容器）
 * 位于聊天区 + 右侧面板之下（不含左侧边栏），顶部可拖拽调整高度。
 *
 * 终端以「浏览器式 tab 条」组织（样式对齐 BrowserTabBar）：一次只显示激活终端，
 * 占满整个内容区；所有 Terminal 常驻挂载，经 visibility 切换避免 xterm 重建。
 */

import { useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, TerminalSquare, X } from 'lucide-react'
import { useChatStore } from '@shuvix/chat-ui'
import { useBottomPanelStore } from '../../stores/bottomPanelStore'
import { useTerminalStore } from '../../stores/terminalStore'
import { XTerminal } from './XTerminal'

export function BottomPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const height = useBottomPanelStore((s) => s.height)
  const setHeight = useBottomPanelStore((s) => s.setHeight)
  const close = useBottomPanelStore((s) => s.close)
  const tabs = useTerminalStore((s) => s.tabs)
  const activeTabId = useTerminalStore((s) => s.activeTabId)
  const setActiveTab = useTerminalStore((s) => s.setActiveTab)
  const createTab = useTerminalStore((s) => s.createTab)
  const closeTab = useTerminalStore((s) => s.closeTab)
  const projectPath = useChatStore((s) => s.projectPath)

  const handleNewTab = useCallback(() => {
    createTab(projectPath || undefined)
  }, [createTab, projectPath])

  const dragRef = useRef<{ startY: number; startH: number } | null>(null)

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      dragRef.current = { startY: e.clientY, startH: useBottomPanelStore.getState().height }
      document.body.style.cursor = 'row-resize'
      document.body.style.userSelect = 'none'

      const onMove = (ev: MouseEvent): void => {
        if (!dragRef.current) return
        setHeight(dragRef.current.startH + (dragRef.current.startY - ev.clientY))
      }
      const onUp = (): void => {
        dragRef.current = null
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    },
    [setHeight]
  )

  return (
    <div
      className="flex-shrink-0 flex flex-col bg-bg-secondary overflow-hidden"
      style={{ height, maxHeight: '70%' }}
    >
      {/* 顶部拖拽分隔条（与 BrowserResizeHandle 同样式，横向版） */}
      <div
        className="flex-shrink-0 h-px bg-border-secondary/50 cursor-row-resize relative group z-10"
        onMouseDown={onMouseDown}
      >
        {/* 透明加高击中区域（上下各扩展 4px） */}
        <div className="absolute inset-x-0 -top-[4px] -bottom-[4px]" />
        {/* 可见高亮仅 1px 高 */}
        <div className="absolute inset-x-0 top-0 h-px group-hover:bg-accent/40 group-active:bg-accent/60 transition-colors" />
      </div>

      {/* tab 条（样式对齐 BrowserTabBar；激活 tab 与内容区同底色形成连接感） */}
      <div className="flex-shrink-0 flex items-end gap-0.5 px-1.5 pt-1 border-b border-border-secondary/30 select-none">
        <TerminalSquare size={13} className="flex-shrink-0 text-text-tertiary mx-1 mb-1.5" />
        <div className="flex items-end gap-0.5 min-w-0 overflow-x-auto">
          {tabs.map((tab) => {
            const isActive = tab.id === activeTabId
            return (
              <div
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`group flex items-center gap-1 min-w-0 max-w-36 px-1.5 py-1 rounded-t-md cursor-default transition-colors ${
                  isActive
                    ? 'bg-bg-primary text-text-primary'
                    : 'text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/50'
                }`}
              >
                <span
                  className={`flex-1 min-w-0 truncate text-[10px] leading-none ${tab.exited ? 'opacity-50 line-through' : ''}`}
                >
                  {tab.title}
                </span>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    closeTab(tab.id)
                  }}
                  title={t('panel.closeTerminal')}
                  className={`flex-shrink-0 p-px rounded hover:bg-bg-hover text-text-tertiary hover:text-text-secondary ${
                    isActive ? '' : 'opacity-0 group-hover:opacity-100'
                  }`}
                >
                  <X size={10} />
                </button>
              </div>
            )
          })}
        </div>
        <button
          onClick={handleNewTab}
          title={t('panel.newTerminal')}
          className="flex-shrink-0 p-1 mb-0.5 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/50 transition-colors"
        >
          <Plus size={11} />
        </button>
        <div className="flex-1" />
        <button
          onClick={close}
          title={t('common.close')}
          className="flex-shrink-0 p-1 mb-0.5 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/50 transition-colors"
        >
          <X size={13} />
        </button>
      </div>

      {/* 内容区 — 所有终端常驻挂载，仅激活者可见并占满全高 */}
      <div className="flex-1 min-h-0 relative bg-bg-primary">
        {tabs.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <button
              onClick={handleNewTab}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-text-tertiary hover:text-text-secondary bg-bg-secondary hover:bg-bg-hover/40 rounded-md transition-colors"
            >
              <Plus size={12} />
              <span>{t('panel.newTerminal')}</span>
            </button>
          </div>
        ) : (
          tabs.map((tab) => {
            const isActive = tab.id === activeTabId
            return (
              <div
                key={tab.id}
                className="absolute inset-0 p-1.5"
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
