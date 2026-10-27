/**
 * 组件宿主子进程的入口（主构建里的独立入口 → out/main/widgetHost.js）。
 *
 * 主进程（widgetRuntime.ts）用 `ELECTRON_RUN_AS_NODE` 拉起它，经 Node IPC 收发 hostProtocol.ts 的消息。
 * 逻辑全在 widgetHostCore.ts；这里只管进程：收消息、回结果、空闲退出、父进程走了就退出。
 */
import { WidgetHostCore, toHostError } from './widgetHostCore'
import type { HostRequest, HostResponse } from './hostProtocol'

/** 空闲多久自己退出（下次调用主进程再拉起） */
const IDLE_EXIT_MS = 5 * 60_000

const core = new WidgetHostCore()
let idleTimer: ReturnType<typeof setTimeout> | null = null
let inFlight = 0

function send(message: HostResponse | { ready: true }): void {
  if (process.connected) process.send?.(message)
}

function scheduleIdleExit(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    if (inFlight > 0) return scheduleIdleExit()
    core.closeAll()
    process.exit(0)
  }, IDLE_EXIT_MS)
}

process.on('message', (raw) => {
  const req = raw as HostRequest
  if (typeof req !== 'object' || req === null || typeof req.id !== 'number') return
  inFlight++
  scheduleIdleExit()
  core
    .handle(req)
    .then(
      (result) => send({ id: req.id, ok: true, result: result ?? null }),
      (err) => send({ id: req.id, ok: false, error: toHostError(err) })
    )
    .finally(() => {
      inFlight--
      scheduleIdleExit()
    })
})

// 父进程走了（主进程退出或断开）就跟着退
process.on('disconnect', () => {
  core.closeAll()
  process.exit(0)
})

process.on('uncaughtException', (err) => {
  console.error('[widgetHost] uncaught exception:', err)
})
process.on('unhandledRejection', (err) => {
  console.error('[widgetHost] unhandled rejection:', err)
})

scheduleIdleExit()
send({ ready: true })
