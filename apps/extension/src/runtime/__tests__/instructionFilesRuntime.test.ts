/**
 * 扩展端「项目指令文件」解析的清单语义 —— 与桌面 instructionInjector **逐条同结论**，
 * 只是底座换成 FSA 目录句柄（无 Node fs，相对路径要逐级下钻）。
 *
 * 对照表在 `apps/desktop/src/main/services/instruction/__tests__/instructionInjector.test.ts`
 * （IF-U-1~4 ↔ 本文件 IF-U-11）：两端各写一张表、不跨 app 目录 import —— 共用一份夹具
 * 会让「两端真的同语义」这件事失去证明力，一端悄悄改了行为，另一端的表还是绿的。
 *
 * mock 面：`handleForSession` 走工厂 mock 顶掉整个 filesRuntime 模块 —— 真模块会拖进
 * IndexedDB / chrome.* / OPFS，这些在 node 环境下根本起不来，而本模块只用到那一个导出。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../filesRuntime', () => ({ handleForSession: vi.fn() }))

import { handleForSession } from '../filesRuntime'
import { resolveInstructionForSession } from '../instructionFilesRuntime'

// ── 假 FSA 句柄树 ───────────────────────────────────────────────────────
// 字符串 = 文件内容；对象 = 目录；UNREADABLE = 存在但 getFile() 会 reject 的文件。

/** 存在但读不出来的文件（IF-U-16 的素材） */
const UNREADABLE: unique symbol = Symbol('unreadable-file')
interface FakeDir {
  [name: string]: FakeNode
}
type FakeNode = string | typeof UNREADABLE | FakeDir

/** FSA 的两种取用失败：名字不存在 / 名字存在但类型不对（目录当文件取，反之亦然） */
const fsaError = (name: 'NotFoundError' | 'TypeMismatchError'): Error =>
  Object.assign(new Error(name), { name })

/**
 * 把节点树包成目录句柄，并把每次取用记进 `calls`（形如 `dir:docs` / `file:house.md`）——
 * 「逐级下钻」这件事只在调用序列上看得见，返回值里看不出来。
 */
function fakeRoot(tree: FakeDir, calls: string[]): FileSystemDirectoryHandle {
  const wrapDir = (node: FakeDir): FileSystemDirectoryHandle =>
    ({
      getDirectoryHandle: async (name: string) => {
        calls.push(`dir:${name}`)
        const child = node[name]
        if (child === undefined) throw fsaError('NotFoundError')
        if (typeof child === 'string' || typeof child === 'symbol') {
          throw fsaError('TypeMismatchError')
        }
        return wrapDir(child)
      },
      getFileHandle: async (name: string) => {
        calls.push(`file:${name}`)
        const child = node[name]
        if (child === undefined) throw fsaError('NotFoundError')
        if (typeof child !== 'string' && typeof child !== 'symbol') {
          throw fsaError('TypeMismatchError')
        }
        return {
          getFile: async () => {
            if (child === UNREADABLE) throw fsaError('NotFoundError')
            return { text: async () => child }
          }
        }
      }
    }) as unknown as FileSystemDirectoryHandle
  return wrapDir(tree)
}

const mockedHandle = vi.mocked(handleForSession)

/** 让本会话看到这棵树，返回调用记录 */
function seed(tree: FakeDir): string[] {
  const calls: string[] = []
  mockedHandle.mockResolvedValue(fakeRoot(tree, calls))
  return calls
}

const SID = 'sess-1'

beforeEach(() => {
  mockedHandle.mockReset()
})

describe('resolveInstructionForSession —— 单选语义（与桌面同结论）', () => {
  it('IF-U-11a 顺序即优先级：同样两份文件，命中随清单顺序翻转；filename 原样回清单里那条', async () => {
    seed({ 'AGENTS.md': 'AGENTS BODY', 'CLAUDE.md': 'CLAUDE BODY' })
    await expect(resolveInstructionForSession(SID, ['CLAUDE.md', 'AGENTS.md'])).resolves.toEqual({
      filename: 'CLAUDE.md',
      content: 'CLAUDE BODY'
    })

    seed({ 'AGENTS.md': 'AGENTS BODY', 'CLAUDE.md': 'CLAUDE BODY' })
    await expect(resolveInstructionForSession(SID, ['AGENTS.md', 'CLAUDE.md'])).resolves.toEqual({
      filename: 'AGENTS.md',
      content: 'AGENTS BODY'
    })
  })

  it('IF-U-11b 至多一个：三条全存在也只回第一条，其余正文一个片段都不带', async () => {
    seed({ 'A.md': 'FIRST BODY', 'B.md': 'SECOND BODY', 'C.md': 'THIRD BODY' })

    const resolved = await resolveInstructionForSession(SID, ['A.md', 'B.md', 'C.md'])
    expect(resolved).toEqual({ filename: 'A.md', content: 'FIRST BODY' })
    expect(resolved!.content).not.toContain('SECOND BODY')
    expect(resolved!.content).not.toContain('THIRD BODY')
  })

  it('IF-U-11c 空/纯空白文件不算命中：落到第二条；两条都空则 null', async () => {
    seed({ 'EMPTY.md': '   \n', 'NEXT.md': 'NEXT BODY' })
    await expect(resolveInstructionForSession(SID, ['EMPTY.md', 'NEXT.md'])).resolves.toEqual({
      filename: 'NEXT.md',
      content: 'NEXT BODY'
    })

    seed({ 'EMPTY.md': '   \n', 'ALSO-EMPTY.md': '\n\t \n' })
    await expect(
      resolveInstructionForSession(SID, ['EMPTY.md', 'ALSO-EMPTY.md'])
    ).resolves.toBeNull()
  })

  it('IF-U-11d 不存在的条目跳过：第一条缺 → 第二条；全不存在 → null 且不抛', async () => {
    seed({ 'PRESENT.md': 'PRESENT BODY' })
    await expect(resolveInstructionForSession(SID, ['MISSING.md', 'PRESENT.md'])).resolves.toEqual({
      filename: 'PRESENT.md',
      content: 'PRESENT BODY'
    })

    seed({ 'PRESENT.md': 'PRESENT BODY' })
    await expect(
      resolveInstructionForSession(SID, ['MISSING.md', 'ALSO-MISSING.md'])
    ).resolves.toBeNull()
  })

  it('IF-U-11e 内容首尾空白被 trim（围栏由 createAgent 统一加）', async () => {
    seed({ 'AGENTS.md': '\n\nX\n\n' })

    const resolved = await resolveInstructionForSession(SID, ['AGENTS.md'])
    expect(resolved!.content).toBe('X')
  })
})

describe('resolveInstructionForSession —— FSA 底座差异', () => {
  it('IF-U-12 子路径逐级下钻：docs/house.md 先取目录句柄再取文件句柄', async () => {
    const calls = seed({ docs: { 'house.md': 'HOUSE BODY' } })

    await expect(resolveInstructionForSession(SID, ['docs/house.md'])).resolves.toEqual({
      filename: 'docs/house.md',
      content: 'HOUSE BODY'
    })
    expect(calls).toEqual(['dir:docs', 'file:house.md'])
  })

  it('IF-U-13 中间目录缺失 / 末段其实是目录 → 该条不算命中，继续下一条', async () => {
    // 'docs' 根本不存在；'notes' 存在但 'house.md' 在它下面是个目录
    const calls = seed({
      notes: { 'house.md': { 'inner.md': 'INNER' } },
      'AGENTS.md': 'AGENTS BODY'
    })

    await expect(
      resolveInstructionForSession(SID, ['docs/house.md', 'notes/house.md', 'AGENTS.md'])
    ).resolves.toEqual({ filename: 'AGENTS.md', content: 'AGENTS BODY' })
    // 三条都走到了：缺目录与类型不符都只是「这条不算命中」，不是中断
    expect(calls).toEqual(['dir:docs', 'dir:notes', 'file:house.md', 'file:AGENTS.md'])
  })

  it('IF-U-14 会话没有工作目录句柄（undefined）→ null，不抛', async () => {
    mockedHandle.mockResolvedValue(undefined)

    await expect(resolveInstructionForSession(SID, ['AGENTS.md', 'CLAUDE.md'])).resolves.toBeNull()
  })

  it('IF-U-15 清单为空即短路：null 且不去取工作目录句柄', async () => {
    seed({ 'AGENTS.md': 'AGENTS BODY' })
    mockedHandle.mockClear()

    await expect(resolveInstructionForSession(SID, [])).resolves.toBeNull()
    expect(mockedHandle).not.toHaveBeenCalled()
  })

  it('IF-U-16 读不动的文件不算命中：getFile() reject → 跳下一条', async () => {
    seed({ 'DENIED.md': UNREADABLE, 'NEXT.md': 'NEXT BODY' })

    await expect(resolveInstructionForSession(SID, ['DENIED.md', 'NEXT.md'])).resolves.toEqual({
      filename: 'NEXT.md',
      content: 'NEXT BODY'
    })
  })
})
