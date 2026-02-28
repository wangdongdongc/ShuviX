/**
 * ls 工具单元测试
 * 使用临时目录结构（含 git init + .gitignore），mock resolveProjectConfig 和 i18n
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'

const TEST_DIR = join(tmpdir(), 'shuvix-ls-test-' + Date.now())
const MANY_DIR = join(tmpdir(), 'shuvix-ls-many-' + Date.now())
const SESSION_ID = 'test-session-ls'

// mock types 模块（完全替换，避免触发 Electron/DB 依赖）
vi.mock('../types', () => ({
  resolveProjectConfig: () => ({
    workingDirectory: TEST_DIR,
    dockerEnabled: false,
    dockerImage: '',
    sandboxEnabled: false,
    referenceDirs: []
  }),
  isPathWithinWorkspace: (absolutePath: string, workingDirectory: string) => {
    const r = resolve(absolutePath)
    const base = resolve(workingDirectory)
    return r === base || r.startsWith(base + sep)
  },
  assertSandboxRead: () => {},
  assertSandboxWrite: () => {},
  TOOL_ABORTED: 'Aborted'
}))

// mock i18n
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

import { createListTool } from '../ls'
import type { ToolContext } from '../types'

const ctx: ToolContext = { sessionId: SESSION_ID }

/** 从 execute 结果中提取文本 */
function getText(result: { content: Array<{ type: string; text?: string }> }): string {
  return (result.content[0] as { type: 'text'; text: string }).text
}

beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true })

  // 初始化 git 仓库（ripgrep 需要 .git 才能识别 .gitignore）
  execSync('git init', { cwd: TEST_DIR, stdio: 'ignore' })

  // 创建 .gitignore（ripgrep 会自动遵循）
  writeFileSync(join(TEST_DIR, '.gitignore'), 'node_modules/\ndist/\n')

  // 基本目录结构
  mkdirSync(join(TEST_DIR, 'src', 'utils'), { recursive: true })
  writeFileSync(join(TEST_DIR, 'src', 'index.ts'), 'export {}')
  writeFileSync(join(TEST_DIR, 'src', 'utils', 'helper.ts'), 'export {}')
  writeFileSync(join(TEST_DIR, 'README.md'), '# Hello')
  writeFileSync(join(TEST_DIR, 'package.json'), '{}')

  // 被 .gitignore 忽略的目录
  mkdirSync(join(TEST_DIR, 'node_modules', 'foo'), { recursive: true })
  writeFileSync(join(TEST_DIR, 'node_modules', 'foo', 'index.js'), '')
  mkdirSync(join(TEST_DIR, 'dist'), { recursive: true })
  writeFileSync(join(TEST_DIR, 'dist', 'bundle.js'), '')

  // 多文件目录（独立目录，无 git，用于截断测试）
  mkdirSync(MANY_DIR, { recursive: true })
  for (let i = 0; i < 120; i++) {
    writeFileSync(join(MANY_DIR, `file${String(i).padStart(3, '0')}.txt`), '')
  }
})

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
  rmSync(MANY_DIR, { recursive: true, force: true })
})

describe('ls 工具 - 基本功能', () => {
  it('列出目录树结构', async () => {
    const tool = createListTool(ctx)
    const result = await tool.execute('tc1', { path: join(TEST_DIR, 'src') })
    const text = getText(result)
    expect(text).toContain('utils/')
    expect(text).toContain('index.ts')
    expect(text).toContain('helper.ts')
  })

  it('默认使用工作目录', async () => {
    const tool = createListTool(ctx)
    const result = await tool.execute('tc2', {})
    const text = getText(result)
    expect(text).toContain('README.md')
    expect(text).toContain('package.json')
    expect(text).toContain('src/')
  })

  it('返回文件计数', async () => {
    const tool = createListTool(ctx)
    const result = await tool.execute('tc3', { path: join(TEST_DIR, 'src') })
    expect(result.details.count).toBe(2) // index.ts + helper.ts
    expect(result.details.truncated).toBe(false)
  })
})

describe('ls 工具 - 忽略模式', () => {
  it('.git 目录始终排除', async () => {
    const tool = createListTool(ctx)
    const result = await tool.execute('tc4', {})
    const text = getText(result)
    // .git/ 目录内容不应出现（.gitignore 文件本身是正常文件）
    expect(text).not.toContain('.git/')
    expect(text).not.toContain('objects')
    // .gitignore 文件应正常列出
    expect(text).toContain('.gitignore')
  })

  it('.gitignore 中的 node_modules/dist 被忽略', async () => {
    const tool = createListTool(ctx)
    const result = await tool.execute('tc5', {})
    const text = getText(result)
    expect(text).not.toContain('node_modules')
    expect(text).not.toContain('dist')
    expect(text).not.toContain('bundle.js')
    // 正常文件应存在
    expect(text).toContain('README.md')
  })

  it('自定义 ignore glob 排除额外文件', async () => {
    const tool = createListTool(ctx)
    const result = await tool.execute('tc6', { ignore: ['src/**'] })
    const text = getText(result)
    // src 下文件应被排除
    expect(text).not.toContain('index.ts')
    expect(text).not.toContain('helper.ts')
    // 其他文件应正常
    expect(text).toContain('README.md')
  })
})

describe('ls 工具 - 截断', () => {
  it('超过 LIMIT 时截断并提示', async () => {
    const tool = createListTool(ctx)
    const result = await tool.execute('tc7', { path: MANY_DIR })
    expect(result.details.truncated).toBe(true)
    expect(result.details.count).toBe(100)
    const text = getText(result)
    expect(text).toContain('Results truncated')
  })
})

describe('ls 工具 - 错误处理', () => {
  it('路径不存在时抛错', async () => {
    const tool = createListTool(ctx)
    try {
      await tool.execute('tc8', { path: join(TEST_DIR, 'nonexistent') })
      expect.fail('应该抛错')
    } catch (err: unknown) {
      expect(err instanceof Error ? err.message : '').toContain('Path not found')
    }
  })

  it('路径是文件时抛错', async () => {
    const tool = createListTool(ctx)
    try {
      await tool.execute('tc9', { path: join(TEST_DIR, 'README.md') })
      expect.fail('应该抛错')
    } catch (err: unknown) {
      expect(err instanceof Error ? err.message : '').toContain('is not a directory')
    }
  })
})
