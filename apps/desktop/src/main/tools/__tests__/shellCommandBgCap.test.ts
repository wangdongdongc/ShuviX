/**
 * 后台任务并发上限的**原样回归**：模型一次并行起 10 条后台命令。
 *
 * 旧实现里计数读进程簿记、列表读枢纽的 `list()`（只给宣告过的），而这一批在预热窗口里都还没宣告，
 * 于是第 9、10 条拿到的是「(0/8) 先停掉下面这些：」后面一条也没有。这里用真的 bgTaskService
 * （真进程）走一遍 bash 工具，钉住：正好 8 条起来、正好 2 条被拒，被拒的那两条说 (8/8) 并逐条列出
 * 那 8 条的停止命令 —— pid 与起来的 8 张回执一一对得上。
 *
 * 替身：toolContext（安全门放行、工作目录 = 系统临时目录）、i18n、electron、logger。
 * **bgTaskService 不桩**。沙箱设置读取器没注入 = 开关关着，命令不套沙箱（用例开头先确认这一点）。
 * 调用顺序不定，按集合断言而不按调用下标。
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ToolContext } from '../../services/toolContext'
import { executeTool } from '@shuvix/agent-runtime/tools/testing/invokeTool'

const STAMP = Date.now()
const USER_DATA_DIR = join(tmpdir(), `shuvix-bgcap-userdata-${STAMP}`)

const mocks = vi.hoisted(() => ({ enforceCommand: vi.fn() }))

vi.mock('electron', () => ({ app: { getPath: () => USER_DATA_DIR, isPackaged: false } }))
vi.mock('../../logger', () => {
  const noop = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
  return { default: noop, createLogger: () => noop }
})
vi.mock('../../services/toolContext', async () => {
  const { tmpdir: tmp } = await import('node:os')
  return {
    getDesktopSecurityContext: () => ({ enforceCommand: mocks.enforceCommand }),
    resolveProjectConfig: () => ({ workingDirectory: tmp(), envVars: {} }),
    TOOL_ABORTED: 'Aborted'
  }
})
vi.mock('../../i18n', () => ({ t: (key: string) => key }))

import { BashTool } from '../bash'
import { killAllBgTasks, MAX_RUNNING_PER_SESSION } from '../../services/bgTaskService'
import { sandboxGloballyActive } from '../../services/sandbox'

const SID = `sess-bgcap-${STAMP}`
const CTX = { sessionId: SID } as ToolContext
const BATCH = 10

const RECEIPT = /^Background task started, pid (\d+)/
const STOP_LINE = /^ {2}shuvix task stop (\d+) {3}# job \d+$/

afterEach(() => {
  killAllBgTasks()
})

afterAll(() => {
  rmSync(USER_DATA_DIR, { recursive: true, force: true })
})

describe.skipIf(process.platform === 'win32')('bash 后台任务并发上限（真 bgTaskService）', () => {
  it('并行起 10 条：8 条起来，2 条被拒 —— 被拒的说 (8/8) 并列出那 8 条的停止命令', async () => {
    mocks.enforceCommand.mockResolvedValue({ status: 'allowed' })
    // 前提：命令不套沙箱（设置读取器没注入）
    expect(sandboxGloballyActive()).toBe(false)
    expect(MAX_RUNNING_PER_SESSION).toBe(8)

    const tool = new BashTool(CTX)
    const results = await Promise.all(
      Array.from({ length: BATCH }, (_, i) =>
        executeTool(tool, `bgcap-${STAMP}-${i}`, {
          command: 'sleep 30',
          description: `job ${i}`,
          run_in_background: true
        } as never)
      )
    )
    const texts = results.map((r) => (r.content[0] as { type: 'text'; text: string }).text)

    const receipts = texts.filter((t) => RECEIPT.test(t))
    const refusals = texts.filter((t) => t.startsWith('Too many background tasks'))
    expect(receipts).toHaveLength(MAX_RUNNING_PER_SESSION)
    expect(refusals).toHaveLength(BATCH - MAX_RUNNING_PER_SESSION)

    const receiptPids = new Set(receipts.map((t) => Number(RECEIPT.exec(t)![1])))
    expect(receiptPids.size).toBe(MAX_RUNNING_PER_SESSION)

    for (const text of refusals) {
      expect(text).not.toContain('(0/8)')
      const lines = text.split('\n')
      expect(lines[0]).toBe('Too many background tasks in this session (8/8).')
      expect(lines[1]).toBe('Stop one before starting another:')
      const stopLines = lines.slice(2)
      expect(stopLines).toHaveLength(MAX_RUNNING_PER_SESSION)
      for (const line of stopLines) expect(line).toMatch(STOP_LINE)
      const listedPids = new Set(stopLines.map((line) => Number(STOP_LINE.exec(line)![1])))
      expect(listedPids).toEqual(receiptPids)
    }
  }, 20_000)
})
