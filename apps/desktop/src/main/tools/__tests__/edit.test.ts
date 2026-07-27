/**
 * edit 工具集成测试 —— 真实临时文件；覆盖精确/回退匹配、行尾、BOM、diff、mtime 守卫。
 * （P2 抽共享内核前补齐基线：edit 之前无集成测试。）
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { mkdirSync, writeFileSync, readFileSync, rmSync, utimesSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'

const TEST_DIR = join(tmpdir(), 'shuvix-edit-test-' + Date.now())
const SESSION_ID = 'test-session'

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

import { makeEditTool } from '../edit'
import { recordRead, _resetAll } from '../../utils/toolUtils/fileTime'
import type { ToolContext } from '../../services/toolContext'

const ctx: ToolContext = { sessionId: SESSION_ID }

/** 写文件 + 记录“已读”（edit 要求先 read 过；否则 mtime 守卫直接拒绝） */
function seed(name: string, content: string): string {
  const p = join(TEST_DIR, name)
  writeFileSync(p, content)
  recordRead(SESSION_ID, p)
  return p
}

beforeAll(() => mkdirSync(TEST_DIR, { recursive: true }))
afterAll(() => rmSync(TEST_DIR, { recursive: true, force: true }))
beforeEach(() => _resetAll())

describe('edit 工具', () => {
  it('精确替换成功 + 返回 diff', async () => {
    const p = seed('a.ts', 'const a = 1\nconst b = 2\n')
    const result = await makeEditTool(ctx).execute('e1', {
      path: p,
      oldText: 'const b = 2',
      newText: 'const b = 3'
    })
    expect(readFileSync(p, 'utf-8')).toBe('const a = 1\nconst b = 3\n')
    const details = result.details as { type: string; diff: string; firstChangedLine?: number }
    expect(details.type).toBe('edit')
    expect(details.diff).toContain('3')
    expect(details.firstChangedLine).toBe(2)
  })

  it('保留 CRLF 行尾', async () => {
    const p = seed('crlf.txt', 'a\r\nb\r\nc\r\n')
    await makeEditTool(ctx).execute('e2', { path: p, oldText: 'b', newText: 'B' })
    expect(readFileSync(p, 'utf-8')).toBe('a\r\nB\r\nc\r\n')
  })

  it('保留 BOM', async () => {
    const p = seed('bom.txt', '﻿hello world')
    await makeEditTool(ctx).execute('e3', { path: p, oldText: 'world', newText: 'there' })
    const out = readFileSync(p, 'utf-8')
    expect(out.startsWith('﻿')).toBe(true)
    expect(out).toBe('﻿hello there')
  })

  it('回退匹配：容忍行尾空格差异', async () => {
    // 文件行尾带空格，oldText 不带 → LineTrimmedReplacer 兜底
    const p = seed('fb.txt', 'foo   \nbar\n')
    await makeEditTool(ctx).execute('e4', { path: p, oldText: 'foo', newText: 'FOO' })
    expect(readFileSync(p, 'utf-8')).toContain('FOO')
  })

  it('oldText 找不到 → 报错', async () => {
    const p = seed('nf.txt', 'hello\n')
    await expect(
      makeEditTool(ctx).execute('e5', { path: p, oldText: 'NOPE', newText: 'x' })
    ).rejects.toThrow()
  })

  it('文件不存在 → File not found', async () => {
    const p = join(TEST_DIR, 'missing.txt')
    await expect(
      makeEditTool(ctx).execute('e6', { path: p, oldText: 'a', newText: 'b' })
    ).rejects.toThrow(/File not found/)
  })

  it('未先读取 → 要求先 read', async () => {
    const p = join(TEST_DIR, 'unread.txt')
    writeFileSync(p, 'data\n') // 不调用 recordRead
    await expect(
      makeEditTool(ctx).execute('e7', { path: p, oldText: 'data', newText: 'x' })
    ).rejects.toThrow(/read.*before|before overwriting/i)
  })

  it('读取后被外部修改 → 拒绝（mtime 守卫）', async () => {
    const p = seed('mod.txt', 'orig\n')
    const future = new Date(Date.now() + 60_000)
    utimesSync(p, future, future)
    await expect(
      makeEditTool(ctx).execute('e8', { path: p, oldText: 'orig', newText: 'x' })
    ).rejects.toThrow(/modified since it was last read/)
  })

  it('同文件并发多处 edit 全部累积（原子 read-modify-write，不丢改）', async () => {
    // 同一回合内对四个不同位置并发 edit；修复前是「最后写入者」覆盖其余 → 仅一处生效。
    const p = seed('concurrent.ts', 'a = 1\nb = 2\nc = 3\nd = 4\n')
    const tool = makeEditTool(ctx)
    const results = await Promise.all([
      tool.execute('c1', { path: p, oldText: 'a = 1', newText: 'a = 10' }),
      tool.execute('c2', { path: p, oldText: 'b = 2', newText: 'b = 20' }),
      tool.execute('c3', { path: p, oldText: 'c = 3', newText: 'c = 30' }),
      tool.execute('c4', { path: p, oldText: 'd = 4', newText: 'd = 40' })
    ])
    // 四次都成功
    expect(results).toHaveLength(4)
    // 四处改动全部落盘
    expect(readFileSync(p, 'utf-8')).toBe('a = 10\nb = 20\nc = 30\nd = 40\n')
  })
})
