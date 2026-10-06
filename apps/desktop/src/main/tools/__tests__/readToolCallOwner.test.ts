/**
 * RCO —— ls / grep / glob 的路径询问带着这次调用的 durable 归属（P1-06）。
 *
 * 三个只读工具在 securityCheck 里经 `assertReadAllowed` 过路径门；询问与自动审查要按 durable 的
 * tool task 认人（provider 的 toolCallId 会话内可能重复，有的中转每轮从 `call_0` 数起），所以
 * `call.taskId` / `call.conversationId` 要作为守卫的最后一个参数交下去 —— 守卫再把它并进 EnforceOpts
 * （那一段在 toolContext 里是一行展开，真安全上下文那一侧由 agent-runtime 的 enforce / 文件工具测试钉）。
 *
 * 脚手架照 toolOutputStrategy.test.ts：mock 掉 toolContext（守卫换成记账的桩），工具本体跑在一个真临时目录上。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'

const TEST_DIR = join(tmpdir(), 'shuvix-rco-test-' + Date.now())
const SID = 'rco-session'

const guard = vi.hoisted(() => ({
  calls: [] as Array<{
    toolCallId: string
    toolName: string
    owner?: { taskId?: number; conversationId?: number }
  }>
}))

vi.mock('../../services/toolContext', () => ({
  resolveProjectConfig: () => ({ workingDirectory: TEST_DIR, referenceDirs: [] }),
  isPathWithinWorkspace: (absolutePath: string, workingDirectory: string) => {
    const r = resolve(absolutePath)
    const base = resolve(workingDirectory)
    return r === base || r.startsWith(base + sep)
  },
  assertReadAllowed: async (
    _ctx: unknown,
    _config: unknown,
    toolCallId: string,
    toolName: string,
    _absolutePath: string,
    _displayPath?: string,
    owner?: { taskId?: number; conversationId?: number }
  ) => {
    guard.calls.push({ toolCallId, toolName, owner })
  },
  assertWriteAllowed: async () => {},
  TOOL_ABORTED: 'Aborted'
}))
vi.mock('../../services/toolRegistry', () => ({ registerBuiltinTool: () => {} }))
vi.mock('../../i18n', () => ({ t: (key: string) => key }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

import type { AnyTool } from '@shuvix/agent-runtime'
import { invokeTool } from '@shuvix/agent-runtime/tools/testing/invokeTool'
import { ListTool } from '../ls'
import { GlobTool } from '../glob'
import { GrepTool } from '../grep'
import type { ToolContext } from '../../services/toolContext'

const ctx: ToolContext = { sessionId: SID }

beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true })
  writeFileSync(join(TEST_DIR, 'a.txt'), 'needle\n')
})

afterAll(() => rmSync(TEST_DIR, { recursive: true, force: true }))

beforeEach(() => {
  guard.calls = []
})

describe('RCO 只读工具的路径询问带着调用归属', () => {
  const rows: Array<[string, () => AnyTool, Record<string, unknown>]> = [
    ['ls', () => new ListTool(ctx), { path: TEST_DIR }],
    ['glob', () => new GlobTool(ctx), { pattern: '*.txt', path: TEST_DIR }],
    ['grep', () => new GrepTool(ctx), { pattern: 'needle', path: TEST_DIR }]
  ]

  it.each(rows)(
    'RCO-1 %s：守卫收到这次调用的 taskId / conversationId（toolCallId 相同的两次调用分得开）',
    async (name, make, args) => {
      const tool = make()
      await invokeTool(tool, args as never, { callId: 'call_0', taskId: 51, conversationId: 8 })
      await invokeTool(tool, args as never, { callId: 'call_0', taskId: 52 })

      expect(guard.calls).toEqual([
        { toolCallId: 'call_0', toolName: name, owner: { taskId: 51, conversationId: 8 } },
        // invokeTool 缺省根对话（1）
        { toolCallId: 'call_0', toolName: name, owner: { taskId: 52, conversationId: 1 } }
      ])
    }
  )
})
