/**
 * edit 工具集成测试 —— 真实临时文件；覆盖精确/回退匹配、行尾、BOM、diff、mtime 守卫。
 * （P2 抽共享内核前补齐基线：edit 之前无集成测试。）
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync
} from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'

const TEST_DIR = join(tmpdir(), 'shuvix-edit-test-' + Date.now())
const SESSION_ID = 'test-session'

/** 门面 enforcePath 的 spy（恒放行）—— ED-L 看门问没问、问的是哪一条写法 */
const enforcePath = vi.hoisted(() =>
  vi.fn(async (_mode: string, _path: string, _opts: unknown): Promise<void> => {})
)

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

import { makeEditTool } from '../edit'
import { recordRead, getReadTime, _resetAll } from '../../utils/toolUtils/fileTime'
import type { ToolContext } from '../../services/toolContext'

const ctx: ToolContext = { sessionId: SESSION_ID }

/** 写文件 + 记录“已读”（读过才校验 mtime 守卫；未读也能编辑，这里模拟常见的「先读后改」路径） */
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

  it('未先读取也能编辑（内部整读即基线；与 write 对齐）', async () => {
    const p = join(TEST_DIR, 'unread.txt')
    writeFileSync(p, 'data\n') // 不调用 recordRead
    const result = await makeEditTool(ctx).execute('e7', { path: p, oldText: 'data', newText: 'x' })
    expect(readFileSync(p, 'utf-8')).toBe('x\n')
    expect(result.details).toMatchObject({ type: 'edit' })
  })

  it('读取后被外部修改 → 拒绝（mtime 守卫）', async () => {
    const p = seed('mod.txt', 'orig\n')
    const future = new Date(Date.now() + 60_000)
    utimesSync(p, future, future)
    await expect(
      makeEditTool(ctx).execute('e8', { path: p, oldText: 'orig', newText: 'x' })
    ).rejects.toThrow(/modified since it was last read/)
  })

  it('从未读文件首次 edit 登记基线：之后拨未来 mtime，第二次 edit 被拒绝', async () => {
    const p = join(TEST_DIR, 'unread-baseline.txt')
    writeFileSync(p, 'orig\n') // 不调用 recordRead
    await makeEditTool(ctx).execute('e9', { path: p, oldText: 'orig', newText: 'one' })
    expect(readFileSync(p, 'utf-8')).toBe('one\n')

    // 首次 edit 的内部整读/写入已登记基线（墙钟）；把 mtime 拨到基线之后 → 触发守卫
    const future = new Date(Date.now() + 60_000)
    utimesSync(p, future, future)
    await expect(
      makeEditTool(ctx).execute('e10', { path: p, oldText: 'one', newText: 'two' })
    ).rejects.toThrow(/modified since it was last read/)
    expect(readFileSync(p, 'utf-8')).toBe('one\n')
  })

  it('从未读文件连续两次 edit（无外部改动）都成功：自身写入不触发守卫', async () => {
    const p = join(TEST_DIR, 'unread-twice.txt')
    writeFileSync(p, 'a\nb\n') // 不调用 recordRead
    const tool = makeEditTool(ctx)
    await tool.execute('e11', { path: p, oldText: 'a', newText: 'A' })
    await tool.execute('e12', { path: p, oldText: 'b', newText: 'B' })
    expect(readFileSync(p, 'utf-8')).toBe('A\nB\n')
  })

  it('从未读文件 mtime 在未来：前置校验跳过，但桌面恒接询问 → 事后复检按墙钟基线抛 modified', async () => {
    // 裁决口径：基线记墙钟而非 mtime。前置校验对从未读文件整体跳过（所以能走到整读/算 diff），
    // 但桌面 edit 恒挂 ask hook（allow 只是不弹窗，hook 仍在）→ 事后复检拿墙钟基线比未来 mtime，
    // 必抛 modified —— 与「已读文件遇未来 mtime 在前置校验被拦」是同一份已接受语义，不修实现。
    const p = join(TEST_DIR, 'unread-future-mtime.txt')
    writeFileSync(p, 'data\n') // 不调用 recordRead
    const future = new Date(Date.now() + 60_000)
    utimesSync(p, future, future)
    await expect(
      makeEditTool(ctx).execute('e13', { path: p, oldText: 'data', newText: 'x' })
    ).rejects.toThrow(/modified since it was last read/)
    expect(readFileSync(p, 'utf-8')).toBe('data\n') // 不落盘
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

// 路径本身是符号链接 → 不跟（真的桌面 port.readLink）；中间段是链接的照常改。
// 门在这里是恒放行的 spy：看的是「问没问、问的是哪一条写法」，判定本身在 writeAskWiring.test
describe.skipIf(process.platform === 'win32')('edit 工具 - 符号链接不跟（ED-L）', () => {
  /** fixture 都放在 links/ 下（随 TEST_DIR 一起清掉） */
  const L = join(TEST_DIR, 'links')

  /** links/ 下：etarget.txt、elink → etarget.txt（相对原文）；ereal/f.txt、edir → links/ereal */
  beforeAll(() => {
    mkdirSync(join(L, 'ereal'), { recursive: true })
    writeFileSync(join(L, 'etarget.txt'), 'orig\n')
    symlinkSync('etarget.txt', join(L, 'elink'))
    writeFileSync(join(L, 'ereal', 'f.txt'), 'one\n')
    symlinkSync(join(L, 'ereal'), join(L, 'edir'))
  })

  beforeEach(() => enforcePath.mockClear())

  it('ED-L1 经相对原文的链接 edit：拒、原文原样引出；那头的字节 / mtime / 读取时间都不动，链接那一条也没落下读取时间，门没被问', async () => {
    const link = join(L, 'elink')
    const target = join(L, 'etarget.txt')
    recordRead(SESSION_ID, target)
    const readAt = getReadTime(SESSION_ID, target)
    const mtimeMs = statSync(target).mtimeMs

    await expect(
      makeEditTool(ctx).execute('edl1', { path: link, oldText: 'orig', newText: 'x' })
    ).rejects.toThrow(
      `Not edited: ${link} is a symbolic link to ${realpathSync.native(target)} (the link says "etarget.txt"). Symbolic links are not followed`
    )
    expect(readFileSync(target, 'utf-8')).toBe('orig\n')
    expect(statSync(target).mtimeMs).toBe(mtimeMs)
    expect(getReadTime(SESSION_ID, target)).toBe(readAt)
    expect(getReadTime(SESSION_ID, link)).toBeUndefined()
    expect(readlinkSync(link)).toBe('etarget.txt')
    expect(enforcePath).not.toHaveBeenCalled()
  })

  it('ED-L2 链接在中间（经链接目录 edit 那头的文件）：照常改到，门恰问一次、问的是写法那一条', async () => {
    const p = join(L, 'edir', 'f.txt')

    await makeEditTool(ctx).execute('edl2', { path: p, oldText: 'one', newText: 'two' })
    expect(readFileSync(join(L, 'ereal', 'f.txt'), 'utf-8')).toBe('two\n')
    expect(enforcePath).toHaveBeenCalledTimes(1)
    expect(enforcePath.mock.calls[0].slice(0, 2)).toEqual(['write', p])
  })
})
