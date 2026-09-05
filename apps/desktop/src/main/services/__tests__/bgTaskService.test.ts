/**
 * 后台任务的输出必须真的落到日志文件、退出码必须来自命令本身 —— Windows 回归测试
 *
 * 背景：bgTaskService 曾用 openSync(logPath, 'a') 把日志 fd 直传给子进程。Windows 上
 * libuv 以 append-only 访问权（FILE_APPEND_DATA，无 FILE_WRITE_DATA）打开 O_APPEND
 * 文件，而 MSYS2/cygwin 子进程（Git Bash）对磁盘文件按偏移写 —— 往这种继承句柄里
 * 一个字节都写不进：日志恒为空；且命令最后一个 echo 写失败会把整条命令的退出码
 * 带成 1，成功命令被误报成失败。修复：win32 改用 'w' 打开（logPath 按 toolCallId
 * 唯一，无跨调用追加场景，'w' 与 'a' 等价）。
 *
 * POSIX 上 'a' 本就工作，但本测试全平台跑 —— 「输出落盘 + 退出码透传」这条行为
 * 契约跨平台成立，钉死它比钉死某个平台的打开方式更有用。
 */

import { describe, it, expect, afterAll, afterEach, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const STAMP = Date.now()
const USER_DATA_DIR = join(tmpdir(), `shuvix-bgtask-userdata-${STAMP}`)

// bgTaskService → utils/paths 需要 app.getPath（日志目录）与 app.isPackaged（CLI 路径）
vi.mock('electron', () => ({ app: { getPath: () => USER_DATA_DIR, isPackaged: false } }))

import { startBgTask, getBgTask, killAllBgTasks, readBgTaskLog } from '../bgTaskService'

const SESSION_ID = 'bgtask-test-session'
const MARKER = 'BGTASK_PAYLOAD_MARKER'

let callSeq = 0
const nextId = (): string => `bgtask-${STAMP}-${++callSeq}`

/** 轮询等任务落定（上限 15s，正常 3s 出头） */
async function waitSettled(toolCallId: string): Promise<void> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (getBgTask(toolCallId)?.status !== 'running') return
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`任务 ${toolCallId} 15s 内未落定`)
}

afterAll(() => {
  rmSync(USER_DATA_DIR, { recursive: true, force: true })
})

afterEach(() => {
  killAllBgTasks()
})

describe('后台任务：输出落盘 + 退出码透传', () => {
  it('预热窗口内退出的命令：settled 输出带命令内容，退出码 0', async () => {
    const started = await startBgTask({
      sessionId: SESSION_ID,
      toolCallId: nextId(),
      command: `echo ${MARKER}`,
      description: 'settled 路径输出捕获',
      cwd: tmpdir()
    })

    expect(started.kind).toBe('settled')
    expect(started.info.exitCode).toBe(0)
    expect(started.kind === 'settled' && started.output).toContain(MARKER)
  })

  it('转入后台的命令：日志文件持续追加命令输出，退出后 exitCode 为 0', async () => {
    const toolCallId = nextId()
    const started = await startBgTask({
      sessionId: SESSION_ID,
      toolCallId,
      // sleep 3 秒保过 2s 预热窗口，强制走 background 形态
      command: `echo ${MARKER}; sleep 3; echo DONE`,
      description: 'background 路径输出捕获',
      cwd: tmpdir()
    })

    expect(started.kind).toBe('background')

    await waitSettled(toolCallId)

    const info = getBgTask(toolCallId)
    expect(info?.status).toBe('exited')
    expect(info?.exitCode).toBe(0)

    const chunk = readBgTaskLog({ toolCallId })
    expect(chunk.text).toContain(MARKER)
    expect(chunk.text).toContain('DONE')
  }, 20_000)
})
