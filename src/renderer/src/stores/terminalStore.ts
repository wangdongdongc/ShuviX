import { create } from 'zustand'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { resolveTerminalTheme } from '../components/terminal/terminalTheme'
import { useSettingsStore } from './settingsStore'

export interface TerminalTab {
  id: string
  /** 主进程分配的 PTY ID */
  ptyId: string | null
  title: string
  /** PTY 已退出 */
  exited: boolean
  /** xterm.js Terminal 实例（常驻内存） */
  term: Terminal
  /** FitAddon 实例 */
  fitAddon: FitAddon
}

interface TerminalState {
  tabs: TerminalTab[]
  activeTabId: string | null

  createTab: (cwd?: string) => void
  closeTab: (id: string) => void
  setActiveTab: (id: string) => void
  updateTitle: (id: string, title: string) => void
  /** 连接 agent 创建的终端（PTY 已存在于 main process，跳过 IPC create） */
  connectAgentTerminal: (ptyId: string, title?: string) => void
}

/** IPC 全局监听（只注册一次） */
let ipcInitialized = false
function ensureIpcListeners(): void {
  if (ipcInitialized) return
  ipcInitialized = true

  // PTY 输出 → xterm.js（Terminal 对象常驻，无论组件是否挂载）
  window.api.terminal.onData((payload) => {
    const { tabs } = useTerminalStore.getState()
    const tab = tabs.find((t) => t.ptyId === payload.terminalId)
    if (tab) {
      tab.term.write(payload.data)
    }
  })

  // main process 请求读取 xterm buffer 最后 N 行
  window.api.terminal.onReadLines(({ ptyId, lines }) => {
    const { tabs } = useTerminalStore.getState()
    const tab = tabs.find((t) => t.ptyId === ptyId)
    if (!tab) return null
    const buf = tab.term.buffer.active
    const totalLines = buf.baseY + buf.cursorY
    const start = Math.max(0, totalLines - lines)
    const result: string[] = []
    for (let i = start; i <= totalLines; i++) {
      const line = buf.getLine(i)
      if (line) result.push(line.translateToString(true))
    }
    // 去掉尾部空行
    while (result.length > 0 && result[result.length - 1].trim() === '') result.pop()
    return result.join('\n')
  })

  // PTY 退出
  window.api.terminal.onExit((payload) => {
    const { tabs } = useTerminalStore.getState()
    const tab = tabs.find((t) => t.ptyId === payload.terminalId)
    if (tab) {
      tab.term.write(`\r\n[Process exited with code ${payload.exitCode}]`)
      useTerminalStore.setState({
        tabs: tabs.map((t) => (t.id === tab.id ? { ...t, exited: true } : t))
      })
    }
  })
}

let tabCounter = 0

export const useTerminalStore = create<TerminalState>((set, get) => ({
  tabs: [],
  activeTabId: null,

  createTab: (cwd) => {
    ensureIpcListeners()
    const idx = ++tabCounter
    const id = `tab_${idx}_${Date.now()}`

    const term = new Terminal({
      cursorBlink: true,
      fontSize: useSettingsStore.getState().fontSize - 1,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: resolveTerminalTheme(),
      scrollback: 5000
    })
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)

    const tab: TerminalTab = {
      id,
      ptyId: null,
      title: `Terminal ${idx}`,
      exited: false,
      term,
      fitAddon
    }
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: id }))

    // 异步创建 PTY
    window.api.terminal.create({ cwd }).then(({ terminalId: ptyId }) => {
      const { tabs } = get()
      if (!tabs.find((t) => t.id === id)) {
        window.api.terminal.destroy(ptyId)
        return
      }
      set({ tabs: tabs.map((t) => (t.id === id ? { ...t, ptyId } : t)) })

      // xterm 用户输入 → PTY
      term.onData((data) => {
        window.api.terminal.write({ terminalId: ptyId, data })
      })

      // 同步初始尺寸
      window.api.terminal.resize({ terminalId: ptyId, cols: term.cols, rows: term.rows })
    })
  },

  closeTab: (id) => {
    const { tabs, activeTabId } = get()
    const tab = tabs.find((t) => t.id === id)
    if (tab) {
      if (tab.ptyId && !tab.exited) {
        window.api.terminal.destroy(tab.ptyId)
      }
      tab.term.dispose()
    }

    const idx = tabs.findIndex((t) => t.id === id)
    const next = tabs.filter((t) => t.id !== id)
    const newActive =
      activeTabId === id
        ? next.length > 0
          ? next[Math.min(idx, next.length - 1)].id
          : null
        : activeTabId
    set({ tabs: next, activeTabId: newActive })
  },

  setActiveTab: (id) => set({ activeTabId: id }),

  updateTitle: (id, title) => {
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, title } : t)) }))
  },

  connectAgentTerminal: (ptyId, title) => {
    ensureIpcListeners()
    const { tabs } = get()

    // 已有该 ptyId 的 tab → 激活即可
    const existing = tabs.find((t) => t.ptyId === ptyId)
    if (existing) {
      set({ activeTabId: existing.id })
      return
    }

    const idx = ++tabCounter
    const id = `agent_${idx}_${Date.now()}`

    const term = new Terminal({
      cursorBlink: true,
      fontSize: useSettingsStore.getState().fontSize - 1,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: resolveTerminalTheme(),
      scrollback: 5000
    })
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)

    // PTY 已由 main process 创建，直接绑定 ptyId
    term.onData((data) => {
      window.api.terminal.write({ terminalId: ptyId, data })
    })

    const tab: TerminalTab = {
      id,
      ptyId,
      title: title || `Agent Terminal`,
      exited: false,
      term,
      fitAddon
    }
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: id }))
  }
}))
