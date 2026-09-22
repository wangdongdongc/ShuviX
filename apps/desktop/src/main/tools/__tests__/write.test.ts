/**
 * write 工具集成测试 —— 真实临时文件；mock 询问/询问/i18n/logger（P2 抽共享前补齐基线）
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  existsSync,
  lstatSync,
  symlinkSync,
  utimesSync
} from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'

const TEST_DIR = join(tmpdir(), 'shuvix-write-test-' + Date.now())
const SESSION_ID = 'test-session'

/** 门面 enforcePath 的 spy（恒放行）—— WR-L 看门问没问、问的是哪一条写法 */
const enforcePath = vi.hoisted(() =>
  vi.fn(async (_mode: string, _path: string, _opts: unknown): Promise<void> => {})
)

// mock toolContext（询问 no-op；与 read.test 一致，覆盖 BaseTool 所需导出）
vi.mock('../../services/toolContext', () => ({
  resolveProjectConfig: () => ({ workingDirectory: TEST_DIR, referenceDirs: [] }),
  isPathWithinWorkspace: (absolutePath: string, workingDirectory: string) => {
    const r = resolve(absolutePath)
    const base = resolve(workingDirectory)
    return r === base || r.startsWith(base + sep)
  },
  isPathWithinReferenceDirs: () => false,
  assertReadAllowed: () => {},
  assertWriteAllowed: () => {},
  // 共享 createFileToolSuite 经此 security 门面走统一评估；测试里恒放行（询问 no-op）
  getDesktopSecurityContext: () => ({
    evaluate: () => ({ effect: 'allow', matched: [], winning: 'test' }),
    evaluateReadOnly: () => true,
    enforcePath,
    enforceCommand: async () => ({ status: 'allowed' }),
    enforceGitOp: async () => {}
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

// 路径本身是符号链接 → 不跟（真的桌面 port.readLink）；中间段是链接的照常写。
// 门在这里是恒放行的 spy：看的是「问没问、问的是哪一条写法」，判定本身在 writeAskWiring.test
describe.skipIf(process.platform === 'win32')('write 工具 - 符号链接不跟（WR-L）', () => {
  /** fixture 都放在 links/ 下（随 TEST_DIR 一起清掉） */
  const L = join(TEST_DIR, 'links')

  /** links/ 下：deep → links/missing/a/b/c.txt（悬空，上级目录一个都没有）；wreal/、wdir → links/wreal */
  beforeAll(() => {
    mkdirSync(join(L, 'wreal'), { recursive: true })
    symlinkSync(join(L, 'missing', 'a', 'b', 'c.txt'), join(L, 'deep'))
    symlinkSync(join(L, 'wreal'), join(L, 'wdir'))
  })

  beforeEach(() => enforcePath.mockClear())

  it('WR-L1 经链接写一个连上级目录都还没有的深路径：拒（Not written，说出那头），什么都不建（连 missing/ 都没有），门没被问，链接原样', async () => {
    const link = join(L, 'deep')
    const real = join(realpathSync.native(L), 'missing', 'a', 'b', 'c.txt')

    await expect(makeWriteTool(ctx).execute('wrl1', { path: link, content: 'x' })).rejects.toThrow(
      `Not written: ${link} is a symbolic link to ${real}. Symbolic links are not followed`
    )
    expect(existsSync(join(L, 'missing'))).toBe(false)
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(readlinkSync(link)).toBe(join(L, 'missing', 'a', 'b', 'c.txt'))
    expect(enforcePath).not.toHaveBeenCalled()
  })

  it('WR-L2 链接在中间（经链接目录写一个新文件）：照常写进那头，门恰问一次、问的是写法那一条', async () => {
    const p = join(L, 'wdir', 'new.txt')

    await makeWriteTool(ctx).execute('wrl2', { path: p, content: 'hi' })
    expect(readFileSync(join(L, 'wreal', 'new.txt'), 'utf-8')).toBe('hi')
    expect(lstatSync(join(L, 'wdir')).isSymbolicLink()).toBe(true)
    expect(enforcePath).toHaveBeenCalledTimes(1)
    expect(enforcePath.mock.calls[0].slice(0, 2)).toEqual(['write', p])
  })
})
