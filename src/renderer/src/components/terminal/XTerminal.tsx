/**
 * XTerminal — xterm.js DOM 挂载组件
 *
 * Terminal 实例由 terminalStore 常驻内存。
 * 本组件仅负责 DOM attach/detach（与 VS Code 的 setVisible 模式一致）：
 * - mount → term.open(container) 将已有 Terminal 挂载到 DOM
 * - unmount → 从 DOM 移除，不 dispose Terminal
 */

import { useEffect, useRef, useCallback } from 'react'
import '@xterm/xterm/css/xterm.css'
import { useSettingsStore } from '../../stores/settingsStore'
import { useTerminalStore, type TerminalTab } from '../../stores/terminalStore'
import { resolveTerminalTheme } from './terminalTheme'

interface XTerminalProps {
  tab: TerminalTab
  visible?: boolean
}

export function XTerminal({ tab, visible = true }: XTerminalProps): React.JSX.Element {
  const fontSize = useSettingsStore((s) => s.fontSize) - 1
  const containerRef = useRef<HTMLDivElement>(null)

  const { term, fitAddon } = tab

  // mount → attach Terminal 到 DOM；unmount → detach
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    if (!term.element) {
      term.open(container)
    } else {
      container.appendChild(term.element)
    }

    requestAnimationFrame(() => {
      try {
        fitAddon.fit()
        const ptyId = useTerminalStore.getState().tabs.find((t) => t.id === tab.id)?.ptyId
        if (ptyId) {
          window.api.terminal.resize({ terminalId: ptyId, cols: term.cols, rows: term.rows })
        }
      } catch {
        /* ignore */
      }
    })

    const ro = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        try {
          fitAddon.fit()
          const ptyId = useTerminalStore.getState().tabs.find((t) => t.id === tab.id)?.ptyId
          if (ptyId) {
            window.api.terminal.resize({ terminalId: ptyId, cols: term.cols, rows: term.rows })
          }
        } catch {
          /* ignore */
        }
      })
    })
    ro.observe(container)

    const themeObserver = new MutationObserver(() => {
      term.options.theme = resolveTerminalTheme()
    })
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme']
    })

    return () => {
      ro.disconnect()
      themeObserver.disconnect()
      // 只从 DOM 移除，不 dispose Terminal
      if (term.element && container.contains(term.element)) {
        container.removeChild(term.element)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id])

  // 字体大小变化
  useEffect(() => {
    term.options.fontSize = fontSize
    try {
      fitAddon.fit()
      const ptyId = useTerminalStore.getState().tabs.find((t) => t.id === tab.id)?.ptyId
      if (ptyId) {
        window.api.terminal.resize({ terminalId: ptyId, cols: term.cols, rows: term.rows })
      }
    } catch {
      /* ignore */
    }
  }, [fontSize, term, fitAddon, tab.id])

  // visible 变化时 refit
  useEffect(() => {
    if (visible) {
      requestAnimationFrame(() => {
        try {
          fitAddon.fit()
          const ptyId = useTerminalStore.getState().tabs.find((t) => t.id === tab.id)?.ptyId
          if (ptyId) {
            window.api.terminal.resize({ terminalId: ptyId, cols: term.cols, rows: term.rows })
          }
        } catch {
          /* ignore */
        }
      })
    }
  }, [visible, term, fitAddon, tab.id])

  const handleFocus = useCallback(() => {
    term.focus()
  }, [term])

  return (
    <div
      ref={containerRef}
      className="w-full h-full xterm-container"
      style={
        visible ? undefined : { visibility: 'hidden', position: 'absolute', overflow: 'hidden' }
      }
      onClick={handleFocus}
    />
  )
}
