/**
 * Terminal Service — 管理 PTY 终端实例
 * 使用 node-pty 创建真正的伪终端，提供与用户原生终端一致的环境
 */

import * as pty from 'node-pty'
import log from 'electron-log'
import { onClientGone, pushTo, type ClientRef } from '../ipc/registry'

interface TerminalInstance {
  pty: pty.IPty
  /** 创建终端的客户端（桌面窗口 = 它的 webContents）—— pty 输出回送给它 */
  client: ClientRef
  /** 撤掉「客户端没了就收掉」的监听（只有网络客户端有） */
  stopWatching?: () => void
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
  client: ClientRef
}): { terminalId: string } {
  const { cwd, cols = 80, rows = 24, client } = params
  const terminalId = `term_${++counter}_${Date.now()}`
  const shell = getDefaultShell()

  const ptyProcess = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: cwd || process.env.HOME || '/',
    env: process.env as Record<string, string>
  })

  const instance: TerminalInstance = { pty: ptyProcess, client }
  terminals.set(terminalId, instance)
  // 网络客户端（浏览器）的终端随连接走：页面关了 / 断了就收掉 pty（桌面窗口的终端照旧在主窗口关闭时收）
  if (client.kind === 'network') {
    instance.stopWatching = onClientGone(client, () => destroyTerminal(terminalId))
  }

  // PTY 输出 → 发起方（桌面窗口按 webContents 路由 —— BrowserWindow.id 与 webContents.id 是两套 ID，
  // 主窗口偶然相等，悬浮窗会发散；它已经销毁就不发）
  ptyProcess.onData((data) => {
    pushTo(client, 'terminal:data', { terminalId, data })
  })

  // PTY 退出 → 通知发起方
  ptyProcess.onExit(({ exitCode }) => {
    pushTo(client, 'terminal:exit', { terminalId, exitCode })
    if (terminals.get(terminalId) === instance) terminals.delete(terminalId)
    instance.stopWatching?.()
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
    inst.stopWatching?.()
    log.info(`[Terminal] Destroyed ${terminalId}`)
  }
}

/**
 * 销毁指定窗口（按 webContents.id）关联的所有终端
 */
export function destroyTerminalsByWindow(windowId: number): void {
  for (const [id, inst] of terminals) {
    if (inst.client.kind === 'window' && inst.client.webContentsId === windowId) {
      inst.pty.kill()
      terminals.delete(id)
      log.info(`[Terminal] Destroyed ${id} (window closed)`)
    }
  }
}
