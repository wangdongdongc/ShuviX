/**
 * Terminal Service — 管理 PTY 终端实例
 * 使用 node-pty 创建真正的伪终端，提供与用户原生终端一致的环境
 */

import * as pty from 'node-pty'
import { BrowserWindow } from 'electron'
import log from 'electron-log'

interface TerminalInstance {
  pty: pty.IPty
  windowId: number
}

/** 活跃的终端实例 Map: terminalId → TerminalInstance */
const terminals = new Map<string, TerminalInstance>()

let counter = 0

/** 获取用户默认 shell */
function getDefaultShell(): string {
  if (process.platform === 'win32') {
    return process.env.COMSPEC || 'powershell.exe'
  }
  return process.env.SHELL || '/bin/zsh'
}

/**
 * 创建一个新的终端实例
 */
export function createTerminal(params: {
  cwd?: string
  cols?: number
  rows?: number
  windowId: number
}): { terminalId: string } {
  const { cwd, cols = 80, rows = 24, windowId } = params
  const terminalId = `term_${++counter}_${Date.now()}`
  const shell = getDefaultShell()

  const ptyProcess = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: cwd || process.env.HOME || '/',
    env: process.env as Record<string, string>
  })

  terminals.set(terminalId, { pty: ptyProcess, windowId })

  // PTY 输出 → 渲染进程
  ptyProcess.onData((data) => {
    const win = BrowserWindow.fromId(windowId)
    if (win && !win.isDestroyed()) {
      win.webContents.send('terminal:data', { terminalId, data })
    }
  })

  // PTY 退出 → 通知渲染进程
  ptyProcess.onExit(({ exitCode }) => {
    const win = BrowserWindow.fromId(windowId)
    if (win && !win.isDestroyed()) {
      win.webContents.send('terminal:exit', { terminalId, exitCode })
    }
    terminals.delete(terminalId)
    log.info(`[Terminal] ${terminalId} exited with code ${exitCode}`)
  })

  log.info(`[Terminal] Created ${terminalId} (shell=${shell}, cwd=${cwd})`)
  return { terminalId }
}

/**
 * 向终端写入数据（用户键入）
 */
export function writeTerminal(terminalId: string, data: string): void {
  const inst = terminals.get(terminalId)
  if (inst) {
    inst.pty.write(data)
  }
}

/**
 * 调整终端尺寸
 */
export function resizeTerminal(terminalId: string, cols: number, rows: number): void {
  const inst = terminals.get(terminalId)
  if (inst) {
    inst.pty.resize(cols, rows)
  }
}

/**
 * 销毁终端实例
 */
export function destroyTerminal(terminalId: string): void {
  const inst = terminals.get(terminalId)
  if (inst) {
    inst.pty.kill()
    terminals.delete(terminalId)
    log.info(`[Terminal] Destroyed ${terminalId}`)
  }
}

/**
 * 销毁指定窗口关联的所有终端
 */
export function destroyTerminalsByWindow(windowId: number): void {
  for (const [id, inst] of terminals) {
    if (inst.windowId === windowId) {
      inst.pty.kill()
      terminals.delete(id)
      log.info(`[Terminal] Destroyed ${id} (window closed)`)
    }
  }
}
