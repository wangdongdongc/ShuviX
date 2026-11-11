/**
 * 桌面文件工具 deps 里与文件库有关的两处（fileToolDeps.ts，文件库 L1；docs/file-library-l1-tests.md §8.2）：
 *
 *   TD-1 onFileChange：write / edit 一个文件 → recordNoteLinks(portPath)（不带 content，自己读盘）；delete → forgetNoteLinks；
 *        整个目录（isDirectory）→ 两个都不调
 *   TD-2 library 依赖：match 只认 `shuvix://file/…`（回 id）；describe(id) → describeLibraryItem(id, 本会话)；
 *        resolve(id) → libraryFileOf(id)?.path，没有时回 null
 *
 * services/fileLibrary 换成间谍；toolContext / 知识库路径 / 事件总线换成最小替身，直接调 makeDesktopFileToolDeps(ctx) 交回的 deps。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'

const state = vi.hoisted(() => ({
  describeLibraryItem: vi.fn(),
  forgetNoteLinks: vi.fn(),
  libraryFileOf: vi.fn(),
  recordNoteLinks: vi.fn(async () => {}),
  publish: vi.fn()
}))

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
vi.mock('../../services/toolContext', () => ({
  resolveProjectConfig: () => ({ workingDirectory: '/w' }),
  getDesktopSecurityContext: () => ({}),
  isSessionDocument: () => false,
  TOOL_ABORTED: 'Aborted'
}))
vi.mock('../../services/fileLibrary', () => ({
  describeLibraryItem: state.describeLibraryItem,
  forgetNoteLinks: state.forgetNoteLinks,
  libraryFileOf: state.libraryFileOf,
  recordNoteLinks: state.recordNoteLinks
}))
vi.mock('../../services/knowledge/knowledgePaths', () => ({
  locateBundle: () => null,
  isBuiltinBundle: () => false
}))
vi.mock('../../utils/appEventBus', () => ({ appEventBus: { publish: state.publish } }))
vi.mock('../../i18n', () => ({ t: (k: string) => k }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

import { makeDesktopFileToolDeps } from '../fileToolDeps'
import type { ToolContext } from '../../services/toolContext'

const SID = 'sid-lib'
const ID = '0199d3a2-7b3e-7c4d-9a1f-2e5b8c7d6f10'
const ID_UP = ID.toUpperCase()

const deps = (): ReturnType<typeof makeDesktopFileToolDeps> =>
  makeDesktopFileToolDeps({ sessionId: SID } as ToolContext)

beforeEach(() => {
  vi.clearAllMocks()
})

describe('TD-1 onFileChange', () => {
  it.each(['write', 'edit'] as const)(
    '%s 一个文件 → recordNoteLinks(portPath)，不带 content',
    (kind) => {
      deps().onFileChange!({ portPath: '/w/n.md', kind }, undefined)
      expect(state.recordNoteLinks).toHaveBeenCalledTimes(1)
      expect(state.recordNoteLinks.mock.calls[0]).toEqual(['/w/n.md'])
      expect(state.forgetNoteLinks).not.toHaveBeenCalled()
      // 文件变更事件照常发
      expect(state.publish).toHaveBeenCalledWith({
        type: 'files.changed',
        root: '/w',
        paths: ['/w/n.md'],
        kind
      })
    }
  )

  it('delete 一个文件 → forgetNoteLinks(portPath)', () => {
    deps().onFileChange!({ portPath: '/w/n.md', kind: 'delete' }, undefined)
    expect(state.forgetNoteLinks).toHaveBeenCalledTimes(1)
    expect(state.forgetNoteLinks.mock.calls[0]).toEqual(['/w/n.md'])
    expect(state.recordNoteLinks).not.toHaveBeenCalled()
  })

  it.each(['write', 'edit', 'delete'] as const)(
    '整个目录（isDirectory, %s）→ 两个都不调',
    (kind) => {
      deps().onFileChange!({ portPath: '/w/notes', kind, isDirectory: true }, undefined)
      expect(state.recordNoteLinks).not.toHaveBeenCalled()
      expect(state.forgetNoteLinks).not.toHaveBeenCalled()
    }
  )
})

describe('TD-2 library 依赖', () => {
  it('match：shuvix://file/ID/a.png → ID（大写也统一成小写）；别的写法 → null', () => {
    const { match } = deps().library!
    expect(match(`shuvix://file/${ID}/a.png`)).toBe(ID)
    expect(match(`shuvix://file/${ID}`)).toBe(ID)
    expect(match(`shuvix://file/${ID_UP}/a.png`)).toBe(ID)
    for (const p of [
      '/w/a.png',
      'a.png',
      `https://e.example/shuvix://file/${ID}/a.png`,
      `library:${ID}`,
      `shuvix://file/${ID}/a/b.png`,
      `shuvix://session/${ID}`
    ]) {
      expect(match(p), p).toBeNull()
    }
  })

  it('describe(ID) → describeLibraryItem(ID, 本会话)，结果原样', () => {
    const facts = { name: 'a.png', linked: true }
    state.describeLibraryItem.mockReturnValueOnce(facts)
    expect(deps().library!.describe(ID)).toBe(facts)
    expect(state.describeLibraryItem).toHaveBeenCalledWith(ID, SID)

    state.describeLibraryItem.mockReturnValueOnce(null)
    expect(deps().library!.describe(ID)).toBeNull()
  })

  it('resolve(ID) → libraryFileOf(ID)?.path；没有时回 null', () => {
    state.libraryFileOf.mockReturnValueOnce({ item: { id: ID }, path: '/lib/01/ID/a.png' })
    expect(deps().library!.resolve(ID)).toBe('/lib/01/ID/a.png')
    expect(state.libraryFileOf).toHaveBeenCalledWith(ID)

    state.libraryFileOf.mockReturnValueOnce(null)
    expect(deps().library!.resolve(ID)).toBeNull()
  })
})
