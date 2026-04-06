/**
 * AgentTerminalManager — 管理 agent 工具使用的 session 绑定终端
 *
 * 每个 session 至多一个 agent 终端，所有命令在其中串行执行。
 * 命令完成检测依赖 shell integration 的 OSC 633 序列。
 * 输出读取从 renderer 的 xterm buffer 最后 N 行获取（和用户看到的一致）。
 */

import { BrowserWindow, ipcMain } from 'electron'
import {
  createTerminal,
  writeTerminal,
  addDataListener,
  removeDataListener
} from './terminalService'
import { createLogger } from '../logger'

const log = createLogger('AgentTerminal')

interface SessionTerminal {
  terminalId: string
  queue: Promise<void>
}

const sessionTerminals = new Map<string, SessionTerminal>()

export function ensureAgentTerminal(sessionId: string, cwd?: string): string {
  const existing = sessionTerminals.get(sessionId)
  if (existing) return existing.terminalId

  const wins = BrowserWindow.getAllWindows()
  const mainWin = wins.find((w) => !w.isDestroyed())
  if (!mainWin) throw new Error('No available window for terminal')

  const { terminalId } = createTerminal({
    cwd,
    windowId: mainWin.webContents.id
  })

  sessionTerminals.set(sessionId, { terminalId, queue: Promise.resolve() })
  log.info(`Created agent terminal ${terminalId} for session ${sessionId}`)
  return terminalId
}

export function getAgentTerminalId(sessionId: string): string | null {
  return sessionTerminals.get(sessionId)?.terminalId ?? null
}

export function executeInTerminal(
  sessionId: string,
  command: string,
  timeout: number,
  signal?: AbortSignal
): Promise<{ output: string; exitCode: number; timedOut: boolean }> {
  const st = sessionTerminals.get(sessionId)
  if (!st) throw new Error(`No agent terminal for session ${sessionId}`)

  const result = st.queue.then(() => doExecute(st.terminalId, command, timeout, signal))
  st.queue = result.then(
    () => {},
    (err) => log.warn(`Command failed in agent terminal: ${err}`)
  )
  return result
}

// ─── 读取 xterm buffer ──────────────────────────────────────

const DEFAULT_TAIL_LINES = 50
let readCounter = 0

/**
 * 从 renderer 的 xterm buffer 读取最后 N 行
 */
export function readTerminalLines(ptyId: string, lines: number): Promise<string> {
  return new Promise((resolve) => {
    const requestId = `rl_${++readCounter}_${Date.now()}`
    const wins = BrowserWindow.getAllWindows()
    const win = wins.find((w) => !w.isDestroyed())
    if (!win) {
      resolve('')
      return
    }

    const timer = setTimeout(() => {
      ipcMain.removeListener('terminal:readLinesResult', handler)
      resolve('')
    }, 3000)

    const handler = (
      _: Electron.IpcMainEvent,
      result: { requestId: string; content: string | null }
    ): void => {
      if (result.requestId !== requestId) return
      clearTimeout(timer)
      ipcMain.removeListener('terminal:readLinesResult', handler)
      resolve(result.content || '')
    }
    ipcMain.on('terminal:readLinesResult', handler)

    win.webContents.send('terminal:readLines', { requestId, ptyId, lines })
  })
}

// ─── 命令执行 ────────────────────────────────────────────────

/**
 * 执行命令：OSC 633 检测完成 + 读取 xterm buffer tail
 *
 * - 633;C → 命令开始执行
 * - 633;D;{exitCode} → 命令完成，读取 buffer 最后 N 行作为输出
 * - 超时 → 读取当前 buffer tail，标记 timedOut
 */
function doExecute(
  terminalId: string,
  command: string,
  timeout: number,
  signal?: AbortSignal
): Promise<{ output: string; exitCode: number; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Aborted'))
      return
    }

    let buf = ''
    let capturing = false
    let done = false

    const cleanup = (): void => {
      done = true
      removeDataListener(terminalId, onData)
      if (signal) signal.removeEventListener('abort', onAbort)
      clearTimeout(timer)
    }

    const onData = (data: string): void => {
      if (done) return
      buf += data
      processBuffer()
    }

    const processBuffer = (): void => {
      for (;;) {
        if (!capturing) {
          const cIdx = findOsc633(buf, 'C')
          if (cIdx === -1) return
          capturing = true
          buf = buf.slice(cIdx.end)
        } else {
          const dIdx = findOsc633(buf, 'D')
          if (dIdx === -1) return

          const exitCode = parseInt(dIdx.param || '0', 10)
          cleanup()

          // 读取 xterm buffer 最后 N 行作为工具输出
          readTerminalLines(terminalId, DEFAULT_TAIL_LINES).then((output) => {
            resolve({
              output,
              exitCode: isNaN(exitCode) ? 0 : exitCode,
              timedOut: false
            })
          })
          return
        }
      }
    }

    const onAbort = (): void => {
      if (done) return
      cleanup()
      reject(new Error('Aborted'))
    }

    const timer = setTimeout(() => {
      if (done) return
      cleanup()
      // 超时：读取当前 buffer tail，标记超时
      readTerminalLines(terminalId, DEFAULT_TAIL_LINES).then((output) => {
        resolve({ output, exitCode: 124, timedOut: true })
      })
    }, timeout * 1000)

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true })
    }

    addDataListener(terminalId, onData)
    writeTerminal(terminalId, command + '\n')
  })
}

// ─── OSC 633 解析工具 ─────────────────────────────────────────

/** @internal exported for testing */
export function findOsc633(
  text: string,
  type: string
): { start: number; end: number; param: string } | -1 {
  const prefix = `\x1b]633;${type}`
  const idx = text.indexOf(prefix)
  if (idx === -1) return -1

  const bellIdx = text.indexOf('\x07', idx + prefix.length)
  if (bellIdx === -1) return -1

  const between = text.slice(idx + prefix.length, bellIdx)
  const param = between.startsWith(';') ? between.slice(1) : ''
  return { start: idx, end: bellIdx + 1, param }
}

/** @internal exported for testing */
export function stripOsc(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\][^\x07]*\x07/g, '')
}

export function destroyAgentTerminal(sessionId: string): void {
  const st = sessionTerminals.get(sessionId)
  if (st) {
    sessionTerminals.delete(sessionId)
    log.info(`Destroyed agent terminal ${st.terminalId} for session ${sessionId}`)
  }
}
