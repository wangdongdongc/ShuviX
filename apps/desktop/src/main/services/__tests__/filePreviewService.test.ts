/**
 * filePreviewService.previewSessionFile —— 预览窗口读文件：会话只用来解相对路径。
 *
 * 契约：
 *   - 预览窗口借的会话可能已经删了（md 窗口一关它的内存会话就没了），而它交来的是绝对路径 → 照读；
 *   - 会话没了（或没有工作目录）又给相对路径 → not-allowed，不碰文件系统；
 *   - 相对路径按会话的工作目录解，结果里的 path 是绝对路径（渲染端拿它拼 shuvix-preview://）；
 *   - 不做工作目录准入：工作目录之外的文件也照读（二进制就是 binary，不是 hex）。
 *
 * sessionService 是间谍；registryNotes / skillService / toolContext 只为满足导入而替掉。文件是真的临时文件。
 *
 *   P-1 会话已删 + 绝对路径 → 读出内容
 *   P-2 会话已删 + 相对路径 → not-allowed，文件系统没被碰
 *   P-3 相对路径按会话目录解，r.path 是绝对路径
 *   P-4 工作目录之外、带 NUL 的文件 → binary
 *
 * writeSessionFile 之后重算笔记的库关联（文件库 L1，docs/file-library-l1-tests.md §8.1）：`../fileLibrary` 的
 * recordNoteLinks 是间谍，`isPathWriteAllowed` 可控。
 *
 *   FP-LIB-1 写成功 → recordNoteLinks 恰调一次，参数是（绝对路径, content）；被调时盘上已是新内容
 *   FP-LIB-2 写入被 isPathWriteAllowed 拒、写盘失败 → 不调；recordNoteLinks reject 时 writeSessionFile 仍回 { ok: true }，
 *            没有未处理的拒绝
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const fx = vi.hoisted(() => ({
  getById: vi.fn<(id: string) => { workingDirectory?: string } | undefined>(),
  isPathWriteAllowed: vi.fn((_config: unknown, _path: string) => true),
  recordNoteLinks: vi.fn<(absPath: string, content?: string) => void>(),
  /** 给了就让 recordNoteLinks 回一个以它 reject 的 Promise */
  rejection: undefined as Error | undefined
}))

vi.mock('../sessionService', () => ({ sessionService: { getById: fx.getById } }))
vi.mock('../registryNotes', () => ({
  observeRegistryWrite: (_path: string, fn: () => Promise<unknown>) => fn()
}))
vi.mock('../skillService', () => ({ skillService: { noteFileWritten: vi.fn() } }))
vi.mock('../toolContext', () => ({
  isPathWriteAllowed: (config: unknown, path: string) => fx.isPathWriteAllowed(config, path),
  resolveProjectConfig: () => ({})
}))
// 间谍外面包一层：回的 Promise 是新建的原生 Promise。vi.fn 自己回的 Promise 会被它记 settledResults 时挂上处理器，
// reject 了也不算「未处理」，FP-LIB-2 就量不出来
vi.mock('../fileLibrary', () => ({
  recordNoteLinks: (absPath: string, content?: string): Promise<void> => {
    fx.recordNoteLinks(absPath, content)
    return fx.rejection ? Promise.reject(fx.rejection) : Promise.resolve()
  }
}))

import { readFileSync } from 'node:fs'
import { previewSessionFile, writeSessionFile } from '../filePreviewService'
import { nodeFileSystemPort } from '../../utils/toolUtils/nodeFileSystemPort'

const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'shuvix-fileprev-')))
const work = join(root, 'work')
const outside = join(root, 'outside')
mkdirSync(join(work, 'sub'), { recursive: true })
mkdirSync(outside)
writeFileSync(join(work, 'sub', 'a.txt'), 'hello preview\n')
writeFileSync(join(outside, 'blob'), Buffer.from([0x41, 0x00, 0x42]))

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

beforeEach(() => {
  vi.restoreAllMocks()
  fx.getById.mockReset()
})

describe('previewSessionFile', () => {
  it('P-1 会话已删 + 绝对路径 → 照读', async () => {
    fx.getById.mockReturnValue(undefined)
    const r = await previewSessionFile('sid-gone', join(work, 'sub', 'a.txt'))
    expect(r).toMatchObject({
      kind: 'text',
      path: join(work, 'sub', 'a.txt'),
      content: 'hello preview\n'
    })
  })

  it('P-2 会话已删 + 相对路径 → not-allowed，文件系统没被碰', async () => {
    fx.getById.mockReturnValue(undefined)
    const stat = vi.spyOn(nodeFileSystemPort, 'stat')
    const readBytes = vi.spyOn(nodeFileSystemPort, 'readBytes')
    const r = await previewSessionFile('sid-gone', 'sub/a.txt')
    expect(r).toMatchObject({ kind: 'not-allowed', path: 'sub/a.txt' })
    expect(stat).not.toHaveBeenCalled()
    expect(readBytes).not.toHaveBeenCalled()
  })

  it('P-2 会话在但没有工作目录 + 相对路径 → not-allowed', async () => {
    fx.getById.mockReturnValue({})
    expect(await previewSessionFile('sid-x', 'sub/a.txt')).toMatchObject({ kind: 'not-allowed' })
  })

  it('P-3 相对路径按会话目录解，r.path 是绝对路径', async () => {
    fx.getById.mockImplementation((id) =>
      id === 'sid-live' ? { workingDirectory: work } : undefined
    )
    const r = await previewSessionFile('sid-live', 'sub/a.txt')
    expect(r).toMatchObject({ kind: 'text', content: 'hello preview\n' })
    expect(r.path).toBe(join(work, 'sub', 'a.txt'))
  })

  it('P-4 工作目录之外、带 NUL 的文件 → binary', async () => {
    fx.getById.mockReturnValue({ workingDirectory: work })
    const r = await previewSessionFile('sid-live', join(outside, 'blob'))
    expect(r).toEqual({ kind: 'binary', path: join(outside, 'blob'), size: 3, ext: '' })
  })
})

describe('writeSessionFile → recordNoteLinks（FP-LIB）', () => {
  beforeEach(() => {
    fx.getById.mockImplementation((id) =>
      id === 'sid-live' ? { workingDirectory: work } : undefined
    )
    fx.isPathWriteAllowed.mockReset()
    fx.isPathWriteAllowed.mockReturnValue(true)
    fx.recordNoteLinks.mockReset()
    fx.rejection = undefined
  })

  it('FP-LIB-1 写成功 → 恰调一次（绝对路径, content）；被调时盘上已是新内容', async () => {
    const content = `# note\n\n![](shuvix://file/0199d3a2-7b3e-7c4d-9a1f-2e5b8c7d6f10/a.png)\n`
    writeFileSync(join(work, 'note.md'), 'old body\n')
    let onDisk: string | undefined
    fx.recordNoteLinks.mockImplementation((absPath) => {
      onDisk = readFileSync(absPath, 'utf8')
    })

    await expect(writeSessionFile('sid-live', 'note.md', content)).resolves.toEqual({ ok: true })

    expect(fx.recordNoteLinks).toHaveBeenCalledTimes(1)
    expect(fx.recordNoteLinks).toHaveBeenCalledWith(join(work, 'note.md'), content)
    expect(onDisk).toBe(content)
  })

  it('FP-LIB-2 isPathWriteAllowed 拒 → 不调', async () => {
    fx.isPathWriteAllowed.mockReturnValue(false)
    const r = await writeSessionFile('sid-live', 'denied.md', 'x')
    expect(r).toMatchObject({ ok: false })
    expect(fx.recordNoteLinks).not.toHaveBeenCalled()
  })

  it('FP-LIB-2 写盘失败（父目录不存在）→ 不调', async () => {
    const r = await writeSessionFile('sid-live', 'no-such-dir/note.md', 'x')
    expect(r).toMatchObject({ ok: false })
    expect(fx.recordNoteLinks).not.toHaveBeenCalled()
  })

  // 调用方不依赖 recordNoteLinks「从不抛」：它 reject 也不留下未处理的拒绝（测试设计发现，2026-11-11 修）
  it('FP-LIB-2 recordNoteLinks reject → 仍回 { ok: true }，没有未处理的拒绝', async () => {
    const unhandled: unknown[] = []
    // 截住这条用例里的 unhandledRejection（不交给 vitest 的全局处理器，免得把整次运行标红）
    const saved = process.listeners('unhandledRejection')
    process.removeAllListeners('unhandledRejection')
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      fx.rejection = new Error('index down')
      await expect(writeSessionFile('sid-live', 'note2.md', 'body\n')).resolves.toEqual({
        ok: true
      })
      expect(fx.recordNoteLinks).toHaveBeenCalledTimes(1)
      // 走过一轮事件循环：Node 在这一轮的微任务排空后才判未处理的拒绝
      await new Promise((r) => setImmediate(r))
      await new Promise((r) => setImmediate(r))
    } finally {
      process.off('unhandledRejection', onUnhandled)
      for (const listener of saved) {
        process.on('unhandledRejection', listener as (...args: unknown[]) => void)
      }
    }
    expect(unhandled).toEqual([])
  })
})
