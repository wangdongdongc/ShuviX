/**
 * read 工具集成测试
 * 使用临时文件/目录，mock resolveProjectConfig 和 i18n
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'

const TEST_DIR = join(tmpdir(), 'shuvix-read-test-' + Date.now())
const SESSION_ID = 'test-session'

// mock types 模块（完全替换，不加载原始模块避免触发 Electron/DB 依赖）
vi.mock('../types', () => ({
  BaseTool: class {
    async securityCheck(..._args: unknown[]): Promise<void> {}
    async executeInternal(..._args: unknown[]): Promise<unknown> {
      return {}
    }
    async execute(toolCallId: string, params: unknown, signal?: AbortSignal, onUpdate?: unknown) {
      await this.securityCheck(toolCallId, params, signal)
      return this.executeInternal(toolCallId, params, signal, onUpdate)
    }
  },
  resolveProjectConfig: () => ({
    workingDirectory: TEST_DIR,
    dockerEnabled: false,
    dockerImage: '',
    sandboxEnabled: false,
    referenceDirs: []
  }),
  isPathWithinWorkspace: (absolutePath: string, workingDirectory: string) => {
    const resolved = resolve(absolutePath)
    const base = resolve(workingDirectory)
    return resolved === base || resolved.startsWith(base + sep)
  },
  isPathWithinReferenceDirs: () => false,
  assertSandboxRead: () => {},
  assertSandboxWrite: () => {},
  TOOL_ABORTED: 'Aborted'
}))

// mock i18n — 返回 key 本身（带参数展开）
vi.mock('../../i18n', () => ({
  t: (key: string, params?: Record<string, unknown>) => {
    if (!params) return key
    let result = key
    for (const [k, v] of Object.entries(params)) {
      result += ` ${k}=${v}`
    }
    return result
  }
}))

// mock logger
vi.mock('../../logger', () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {}
  })
}))

// mock markitdown-ts 和 word-extractor（避免不必要的加载）
vi.mock('markitdown-ts', () => ({
  MarkItDown: class {
    convert() {
      return { markdown: '' }
    }
  }
}))
vi.mock('word-extractor', () => ({
  default: class {
    extract() {
      return { getBody: () => '' }
    }
  }
}))

import { ReadTool } from '../read'
import type { ToolContext } from '../types'

const ctx: ToolContext = { sessionId: SESSION_ID }

/** 从 execute 结果中提取文本内容（类型断言） */
function getText(result: { content: Array<{ type: string; text?: string }> }): string {
  const item = result.content[0]
  return (item as { type: 'text'; text: string }).text
}

beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true })

  // 纯文本文件
  writeFileSync(join(TEST_DIR, 'hello.txt'), 'line1\nline2\nline3\nline4\nline5\n')

  // 空文件
  writeFileSync(join(TEST_DIR, 'empty.txt'), '')

  // 超长单行文件（minified）
  writeFileSync(join(TEST_DIR, 'minified.js'), 'x'.repeat(5000) + '\nshort line\n')

  // 二进制文件（含 NULL 字节）
  const binBuf = Buffer.alloc(100)
  binBuf[50] = 0 // NULL 字节
  binBuf.write('hello', 0)
  writeFileSync(join(TEST_DIR, 'binary.dat'), binBuf)

  // 已知二进制扩展名
  writeFileSync(join(TEST_DIR, 'image.png'), 'not really a png')

  // 子目录
  mkdirSync(join(TEST_DIR, 'subdir'), { recursive: true })
  writeFileSync(join(TEST_DIR, 'subdir', 'a.ts'), 'export const a = 1')
  mkdirSync(join(TEST_DIR, 'subdir', 'nested'), { recursive: true })

  // 目录中有多个文件（用于测试目录分页）
  mkdirSync(join(TEST_DIR, 'bigdir'), { recursive: true })
  for (let i = 0; i < 10; i++) {
    writeFileSync(join(TEST_DIR, 'bigdir', `file${String(i).padStart(2, '0')}.txt`), `content ${i}`)
  }

  // 大文件（超过 50KB）
  mkdirSync(join(TEST_DIR, 'largedir'), { recursive: true })
  const largeLines = Array.from({ length: 5000 }, (_, i) => `line ${i + 1}: ${'x'.repeat(20)}`)
  writeFileSync(join(TEST_DIR, 'largedir', 'large.txt'), largeLines.join('\n'))

  // 模糊匹配测试文件
  writeFileSync(join(TEST_DIR, 'README.md'), '# README')
})

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
})

describe('read 工具 - 纯文本文件', () => {
  it('读取纯文本文件返回带行号的内容', async () => {
    const tool = new ReadTool(ctx)
    const result = await tool.execute('tc1', { path: join(TEST_DIR, 'hello.txt') })
    const text = getText(result)
    // 应包含行号
    expect(text).toContain('1│line1')
    expect(text).toContain('5│line5')
  })

  it('分页读取 offset/limit', async () => {
    const tool = new ReadTool(ctx)
    const result = await tool.execute('tc2', {
      path: join(TEST_DIR, 'hello.txt'),
      offset: 2,
      limit: 2
    })
    const text = getText(result)
    expect(text).toContain('2│line2')
    expect(text).toContain('3│line3')
    // 不应包含 line1
    expect(text).not.toContain('1│line1')
  })

  it('空文件正常返回', async () => {
    const tool = new ReadTool(ctx)
    const result = await tool.execute('tc3', { path: join(TEST_DIR, 'empty.txt') })
    expect(getText(result)).toBeDefined()
    expect((result.details as { totalLines: number }).totalLines).toBeLessThanOrEqual(1)
  })
})

describe('read 工具 - 单行截断', () => {
  it('超长单行被截断到 2000 字符', async () => {
    const tool = new ReadTool(ctx)
    const result = await tool.execute('tc4', { path: join(TEST_DIR, 'minified.js') })
    const text = getText(result)
    // 第一行应被截断
    expect(text).toContain('line truncated to')
    // 第二行应正常
    expect(text).toContain('short line')
  })
})

describe('read 工具 - 目录读取', () => {
  it('读取目录返回排序的条目列表', async () => {
    const tool = new ReadTool(ctx)
    const result = await tool.execute('tc5', { path: join(TEST_DIR, 'subdir') })
    const text = getText(result)
    // 目录条目加 / 后缀
    expect(text).toContain('nested/')
    // 文件条目不加 /
    expect(text).toContain('a.ts')
  })

  it('目录分页 offset/limit', async () => {
    const tool = new ReadTool(ctx)
    const result = await tool.execute('tc6', {
      path: join(TEST_DIR, 'bigdir'),
      offset: 1,
      limit: 3
    })
    const text = getText(result)
    const details = result.details as { totalEntries: number; truncated: boolean }
    expect(details.totalEntries).toBe(10)
    expect(details.truncated).toBe(true)
    // 应包含分页提示
    expect(text).toContain('offset=4')
  })
})

describe('read 工具 - 文件不存在', () => {
  it('有近似文件时返回 Did you mean', async () => {
    const tool = new ReadTool(ctx)
    try {
      await tool.execute('tc7', { path: join(TEST_DIR, 'readme') })
      expect.fail('应该抛错')
    } catch (err: unknown) {
      expect(err instanceof Error ? err.message : '').toContain('Did you mean')
    }
  })

  it('无近似文件时返回普通 fileNotFound', async () => {
    const tool = new ReadTool(ctx)
    try {
      await tool.execute('tc8', { path: join(TEST_DIR, 'zzzznonexistent') })
      expect.fail('应该抛错')
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : ''
      expect(msg).toContain('File not found')
      expect(msg).not.toContain('Did you mean')
    }
  })
})

describe('read 工具 - 二进制文件拒绝', () => {
  it('已知扩展名直接拒绝', async () => {
    const tool = new ReadTool(ctx)
    try {
      await tool.execute('tc9', { path: join(TEST_DIR, 'image.png') })
      expect.fail('应该抛错')
    } catch (err: unknown) {
      expect(err instanceof Error ? err.message : '').toContain('Unsupported format')
    }
  })

  it('NULL 字节检测拒绝', async () => {
    const tool = new ReadTool(ctx)
    try {
      await tool.execute('tc10', { path: join(TEST_DIR, 'binary.dat') })
      expect.fail('应该抛错')
    } catch (err: unknown) {
      expect(err instanceof Error ? err.message : '').toContain('Unsupported format')
    }
  })
})

describe('read 工具 - 大文件字节上限', () => {
  it('超 50KB 时截断并提示 offset', async () => {
    const tool = new ReadTool(ctx)
    const result = await tool.execute('tc11', {
      path: join(TEST_DIR, 'largedir', 'large.txt')
    })
    const text = getText(result)
    expect((result.details as { truncated: boolean }).truncated).toBe(true)
    // 应包含截断提示
    expect(text).toContain('offset=')
  })
})
