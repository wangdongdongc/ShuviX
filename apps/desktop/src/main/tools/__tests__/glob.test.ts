/**
 * glob 工具单元测试（含 SO-06 结构化输出）
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { executeTool } from '@shuvix/agent-runtime/tools/testing/invokeTool'

const state = vi.hoisted(() => ({ dir: '' }))

vi.mock('../../services/toolContext', () => ({
  resolveProjectConfig: () => ({ workingDirectory: state.dir, referenceDirs: [] }),
  assertReadAllowed: async () => {},
  TOOL_ABORTED: 'Aborted'
}))
vi.mock('../../services/toolRegistry', () => ({ registerBuiltinTool: () => {} }))
vi.mock('../../i18n', () => ({ t: (k: string) => k }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

import { GlobTool } from '../glob'
import { getRgPath } from '../../utils/toolUtils/ripgrep'
import type { ToolContext } from '../../services/toolContext'

const RG_AVAILABLE = existsSync(getRgPath())
const ctx: ToolContext = { sessionId: 'glob-test-session' }

beforeEach(() => {
  state.dir = mkdtempSync(join(tmpdir(), 'shuvix-glob-tool-'))
})

afterEach(() => {
  if (state.dir) rmSync(state.dir, { recursive: true, force: true })
  state.dir = ''
})

describe.skipIf(!RG_AVAILABLE)('glob 工具 - 结构化输出（SO-06）', () => {
  it('SO-06 声明 structuredOutputSchema；正常匹配（按 mtime 降序）、无匹配、超 100 截断返回正确 { files, truncated }；路径不存在/非目录返回 isError 且无 structuredOutput', async () => {
    const tool = new GlobTool(ctx)
    expect(tool.structuredOutputSchema).toBeDefined()

    // 1) 正常匹配（按 mtime 降序，正斜杠）
    mkdirSync(join(state.dir, 'src', 'sub'), { recursive: true })
    const older = join(state.dir, 'src', 'older.ts')
    const newer = join(state.dir, 'src', 'sub', 'newer.ts')
    const other = join(state.dir, 'README.md')
    writeFileSync(older, 'export const a = 1\n')
    writeFileSync(newer, 'export const b = 2\n')
    writeFileSync(other, '# readme\n')
    utimesSync(older, new Date(1_700_000_000_000), new Date(1_700_000_000_000))
    utimesSync(newer, new Date(1_700_000_100_000), new Date(1_700_000_100_000))

    const matched = await executeTool(tool, 'so-glob-1', { pattern: '**/*.ts' })
    expect(matched.isError).toBeUndefined()
    expect((matched as { structuredOutput?: unknown }).structuredOutput).toEqual({
      files: ['src/sub/newer.ts', 'src/older.ts'],
      truncated: false
    })

    // 2) 无匹配
    const empty = await executeTool(tool, 'so-glob-2', { pattern: '**/*.py' })
    expect(empty.isError).toBeUndefined()
    expect((empty as { structuredOutput?: unknown }).structuredOutput).toEqual({
      files: [],
      truncated: false
    })

    // 3) 超 100 匹配截断
    const manyDir = join(state.dir, 'many')
    mkdirSync(manyDir, { recursive: true })
    for (let i = 0; i < 120; i++) {
      writeFileSync(join(manyDir, `item-${String(i).padStart(3, '0')}.log`), 'x')
    }
    const trunc = await executeTool(tool, 'so-glob-3', { pattern: '*.log', path: manyDir })
    expect(trunc.isError).toBeUndefined()
    const truncOut = (trunc as { structuredOutput?: { files: string[]; truncated: boolean } })
      .structuredOutput
    expect(truncOut?.truncated).toBe(true)
    expect(truncOut?.files).toHaveLength(100)
    expect(truncOut?.files.every((f) => f.startsWith('many/') && !f.includes('\\'))).toBe(true)

    // 4) 路径不存在 → isError: true 且无 structuredOutput
    const notFound = await executeTool(tool, 'so-glob-4', {
      pattern: '*.ts',
      path: join(state.dir, 'missing-dir')
    })
    expect(notFound.isError).toBe(true)
    expect(Object.prototype.hasOwnProperty.call(notFound, 'structuredOutput')).toBe(false)

    // 5) 路径不是目录 → isError: true 且无 structuredOutput
    const notDir = await executeTool(tool, 'so-glob-5', { pattern: '*.ts', path: other })
    expect(notDir.isError).toBe(true)
    expect(Object.prototype.hasOwnProperty.call(notDir, 'structuredOutput')).toBe(false)
  })
})
