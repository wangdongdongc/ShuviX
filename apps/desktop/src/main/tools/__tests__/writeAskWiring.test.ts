/**
 * 桌面 write/edit 的询问接线集成测试 —— 真实临时文件 + 真实 fileTime + **真实安全模块**
 * （createSecurityContext + 内置策略），只把宿主 provider 换成可编程实现（requestUserInput 是 spy）。
 *
 * 与同目录 write.test.ts / edit.test.ts 的分工：那两个把询问 mock 成恒放行，测的是写入内核；
 * 这里恒不放行，测的是「工作目录内写入要弹窗、read 不弹」以及 diff 预览与落盘的一致性。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import type { InputRequest, InputResponse } from '@shuvix/chat-protocol/types/inputRequest'

const TEST_DIR = join(tmpdir(), 'shuvix-ask-on-write-' + Date.now())
const SESSION_ID = 'ask-session'

const state = vi.hoisted(() => ({
  requests: [] as InputRequest[],
  respond: (() => ({ kind: 'ask', allowed: true })) as (
    req: InputRequest
  ) => InputResponse | Promise<InputResponse>,
  persisted: [] as { mode: string; path: string }[]
}))

// 可编程 provider：桌面口径（内置 workspace-boundary 策略给出工作目录内 read 免询问、
// write 必询问），询问挂起走 spy —— 评估链本身用真实 createSecurityContext
vi.mock('../../services/toolContext', async () => {
  const { createSecurityContext } = await import('@shuvix/agent-runtime')
  const { sep: pathSep } = await import('node:path')
  const makeContext = (): unknown =>
    createSecurityContext(
      { kind: 'agent', sessionId: SESSION_ID, agentKind: 'root' },
      { host: 'desktop' },
      {
        host: 'desktop',
        pathSep,
        getVars: () => ({
          workspace: TEST_DIR,
          botsDir: '/tmp/shuvix-bots',
          toolResultsBase: join(TEST_DIR, '.nonexistent-tool-results'),
          skillsDirs: [],
          memoryDirs: [],
          home: join(TEST_DIR, '.nonexistent-home'),
          systemDirs: []
        }),
        getSessionGrants: () => ({ autoAllow: false, allowList: [] }),
        isDirectory: () => false,
        persistGrant: (mode: string, path: string) => void state.persisted.push({ mode, path }),
        requestUserInput: async (req: InputRequest) => {
          state.requests.push(req)
          return state.respond(req)
        }
      }
    )
  return {
    resolveProjectConfig: () => ({ workingDirectory: TEST_DIR }),
    isPathWithinWorkspace: (absolutePath: string, workingDirectory: string) => {
      const r = resolve(absolutePath)
      const base = resolve(workingDirectory)
      return r === base || r.startsWith(base + sep)
    },
    getDesktopSecurityContext: makeContext,
    TOOL_ABORTED: 'Aborted'
  }
})
vi.mock('../../services/toolRegistry', () => ({ registerBuiltinTool: () => {} }))
vi.mock('../../i18n', () => ({ t: (k: string) => k }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

import { makeWriteTool } from '../write'
import { makeEditTool } from '../edit'
import { makeReadTool } from '../read'
import { _resetAll } from '../../utils/toolUtils/fileTime'
import type { ToolContext } from '../../services/toolContext'

const ctx: ToolContext = { sessionId: SESSION_ID }

beforeAll(() => mkdirSync(TEST_DIR, { recursive: true }))
afterAll(() => rmSync(TEST_DIR, { recursive: true, force: true }))
beforeEach(() => {
  _resetAll()
  state.requests = []
  state.persisted = []
  state.respond = () => ({ kind: 'ask', allowed: true })
})

describe('桌面 write/edit — 工作目录内写入的询问接线', () => {
  it('PERM-2: 工作目录内 write 弹一次带 diff 预览的询问，同路径 read 不弹', async () => {
    const p = join(TEST_DIR, 'perm2.txt')

    await makeWriteTool(ctx).execute('w1', { path: p, content: 'hello\n' })
    expect(state.requests).toHaveLength(1)
    const req = state.requests[0]
    if (req.kind !== 'ask') throw new Error('expected an ask request')
    expect(req.toolName).toBe('write')
    expect(req.command).toBe(`Write(${p})`)
    expect(req.preview).toMatchObject({ kind: 'diff', path: p, isNewFile: true })
    expect(readFileSync(p, 'utf-8')).toBe('hello\n')

    state.requests = []
    await makeReadTool(ctx).execute('r1', { path: p })
    expect(state.requests).toEqual([])
  })

  it('PERM-2: 拒绝时不落盘', async () => {
    const p = join(TEST_DIR, 'perm2-denied.txt')
    writeFileSync(p, 'original\n')
    state.respond = () => ({ kind: 'ask', allowed: false })

    await expect(
      makeWriteTool(ctx).execute('w2', { path: p, content: 'overwritten\n' })
    ).rejects.toThrow(/User denied access/)
    expect(readFileSync(p, 'utf-8')).toBe('original\n')
  })

  it('CONS-6: CRLF 文件 edit —— 预览 diff 与 details.diff 一致，落盘仍是 CRLF', async () => {
    const p = join(TEST_DIR, 'crlf.txt')
    writeFileSync(p, 'a\r\nb\r\nc\r\n')

    // edit 要求先读；走真实 read 工具记录读取时间（顺带确认 read 不弹询问）
    await makeReadTool(ctx).execute('r2', { path: p })
    expect(state.requests).toEqual([])

    const res = await makeEditTool(ctx).execute('e1', { path: p, oldText: 'b', newText: 'B' })

    const req = state.requests[0]
    if (req.kind !== 'ask') throw new Error('expected an ask request')
    const details = res.details as { type: 'edit'; diff: string }
    expect(req.preview?.diff).toBe(details.diff)
    // 按 LF 比较，只有一行被标为改动 —— 不是整篇
    expect(details.diff.split('\n').filter((l) => l.startsWith('-'))).toEqual(['-2 b'])
    expect(details.diff.split('\n').filter((l) => l.startsWith('+'))).toEqual(['+2 B'])
    expect(details.diff).not.toContain('\r')
    // 落盘仍是 CRLF
    expect(readFileSync(p, 'utf-8')).toBe('a\r\nB\r\nc\r\n')
  })
})
