/**
 * write 工具集成测试 —— 真实临时文件；mock 审批/审批/i18n/logger（P2 抽共享前补齐基线）
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, utimesSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'

const TEST_DIR = join(tmpdir(), 'shuvix-write-test-' + Date.now())
const SESSION_ID = 'test-session'

// mock toolContext（审批 no-op；与 read.test 一致，覆盖 BaseTool 所需导出）
vi.mock('../../services/toolContext', () => ({
  resolveProjectConfig: () => ({ workingDirectory: TEST_DIR, referenceDirs: [] }),
  isPathWithinWorkspace: (absolutePath: string, workingDirectory: string) => {
    const r = resolve(absolutePath)
    const base = resolve(workingDirectory)
    return r === base || r.startsWith(base + sep)
  },
  isPathWithinReferenceDirs: () => false,
  assertReadApproved: () => {},
  assertWriteApproved: () => {},
  // 共享 createFileToolSuite 经此 policy 走 assertPathApproved；测试里恒放行（审批 no-op）
  makeDesktopApprovalPolicy: () => ({
    isAllowedWithoutPrompt: () => true,
    isAutoApprove: () => true,
    isInAllowList: () => false,
    buildApprovalCommand: () => '',
    isDirectory: () => false,
    persistAllow: () => {}
  }),
  TOOL_ABORTED: 'Aborted'
}))
vi.mock('../../services/toolRegistry', () => ({ registerBuiltinTool: () => {} }))
vi.mock('../../i18n', () => ({ t: (k: string) => k }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

import { makeWriteTool } from '../write'
import { recordRead, _resetAll } from '../../utils/toolUtils/fileTime'
import type { ToolContext } from '../../services/toolContext'

const ctx: ToolContext = { sessionId: SESSION_ID }

beforeAll(() => mkdirSync(TEST_DIR, { recursive: true }))
afterAll(() => rmSync(TEST_DIR, { recursive: true, force: true }))
beforeEach(() => _resetAll())

describe('write 工具', () => {
  it('写入内容（新文件）并返回字节数', async () => {
    const p = join(TEST_DIR, 'a.txt')
    const result = await makeWriteTool(ctx).execute('w1', { path: p, content: 'hello world' })
    expect(readFileSync(p, 'utf-8')).toBe('hello world')
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('11') // "hello world" = 11 字节
  })

  it('自动创建父目录', async () => {
    const p = join(TEST_DIR, 'nested', 'deep', 'b.txt')
    await makeWriteTool(ctx).execute('w2', { path: p, content: 'x' })
    expect(existsSync(p)).toBe(true)
    expect(readFileSync(p, 'utf-8')).toBe('x')
  })

  it('覆盖已有文件', async () => {
    const p = join(TEST_DIR, 'c.txt')
    writeFileSync(p, 'old')
    await makeWriteTool(ctx).execute('w3', { path: p, content: 'new' })
    expect(readFileSync(p, 'utf-8')).toBe('new')
  })

  it('文件读取后被外部修改 → 拒绝覆盖（mtime 守卫）', async () => {
    const p = join(TEST_DIR, 'd.txt')
    writeFileSync(p, 'v1')
    recordRead(SESSION_ID, p) // 模拟读过
    // 把 mtime 设到未来，模拟外部修改
    const future = new Date(Date.now() + 60_000)
    utimesSync(p, future, future)
    await expect(makeWriteTool(ctx).execute('w4', { path: p, content: 'v2' })).rejects.toThrow(
      /modified since it was last read/
    )
  })
})
