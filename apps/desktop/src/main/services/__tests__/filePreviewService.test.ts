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
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const fx = vi.hoisted(() => ({
  getById: vi.fn<(id: string) => { workingDirectory?: string } | undefined>()
}))

vi.mock('../sessionService', () => ({ sessionService: { getById: fx.getById } }))
vi.mock('../registryNotes', () => ({
  observeRegistryWrite: (_path: string, fn: () => Promise<unknown>) => fn()
}))
vi.mock('../skillService', () => ({ skillService: { noteFileWritten: vi.fn() } }))
vi.mock('../toolContext', () => ({
  isPathWriteAllowed: () => true,
  resolveProjectConfig: () => ({})
}))

import { previewSessionFile } from '../filePreviewService'
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
