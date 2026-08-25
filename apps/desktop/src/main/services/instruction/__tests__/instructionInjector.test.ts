/**
 * instructionInjector 的清单解析语义 —— 「读哪些文件」全由 agent 档案的
 * `shuvix-instruction-files` 清单决定，本模块只负责「按清单在工作目录里找第一个
 * 存在且非空的读出来」。
 *
 * 钉死的是那条单选规则的每一个失败面：**顺序即优先级**、**至多一个**、
 * 「空文件 / 不存在 / 不是文件 / 读不动」都只是「这条不算命中」而非中断。
 * 这些分支各自对应一种线上表现（注入了错的那份 / 注入了两份 / 整条链路抛错），
 * 光靠 happy path 一条用例是看不出来的。
 *
 * 扩展端的同语义解析在 `apps/extension/src/runtime/__tests__/instructionFilesRuntime.test.ts`
 * —— 两端各自一张表、逐条同结论；改了这里记得对着看那边。
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { statSync } from 'fs'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync as realStatSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// mock 路径按**测试文件**解析：被测模块在 services/instruction/，测试在其 __tests__/ 下，
// 故比被测模块的 '../../logger' 多一层
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

/**
 * fs 只加一层透传探针（真实实现照跑）—— IF-U-8 要断言的是「短路，连 stat 都不发」，
 * 而 `join('', 'AGENTS.md')` 会退化成进程 cwd 下的相对路径，光看返回值分不出
 * 「短路了」还是「找了但没找到」。
 */
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    default: actual,
    statSync: vi.fn(actual.statSync),
    readFileSync: vi.fn(actual.readFileSync)
  }
})

import { resolveInstructionContent } from '../instructionInjector'

const roots: string[] = []
let dir = ''

/** 每个用例一个独立工作目录（chmod 000 之类的素材不该串味） */
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'shuvix-instr-'))
  roots.push(dir)
  vi.mocked(statSync).mockClear()
})
afterEach(() => {
  // 先恢复权限再删：chmod 000 的素材在部分平台上会让 rm 失败
  const denied = join(dir, 'DENIED.md')
  if (existsSync(denied)) chmodSync(denied, 0o644)
})
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/** 往工作目录写一份素材（自动建中间目录） */
const write = (relativePath: string, content: string): void => {
  const target = join(dir, relativePath)
  mkdirSync(join(target, '..'), { recursive: true })
  writeFileSync(target, content, 'utf-8')
}

describe('resolveInstructionContent —— 单选语义', () => {
  it('IF-U-1 顺序即优先级：同样两份文件，命中随清单顺序翻转；filename 原样回清单里那条', () => {
    write('AGENTS.md', 'AGENTS BODY')
    write('CLAUDE.md', 'CLAUDE BODY')

    expect(resolveInstructionContent(dir, ['CLAUDE.md', 'AGENTS.md'])).toEqual({
      filename: 'CLAUDE.md',
      content: 'CLAUDE BODY'
    })
    expect(resolveInstructionContent(dir, ['AGENTS.md', 'CLAUDE.md'])).toEqual({
      filename: 'AGENTS.md',
      content: 'AGENTS BODY'
    })
  })

  it('IF-U-2 至多一个：三条全存在也只回第一条，其余正文一个片段都不带', () => {
    write('A.md', 'FIRST BODY')
    write('B.md', 'SECOND BODY')
    write('C.md', 'THIRD BODY')

    const resolved = resolveInstructionContent(dir, ['A.md', 'B.md', 'C.md'])
    expect(resolved).toEqual({ filename: 'A.md', content: 'FIRST BODY' })
    expect(resolved!.content).not.toContain('SECOND BODY')
    expect(resolved!.content).not.toContain('THIRD BODY')
  })

  it('IF-U-3 空/纯空白文件不算命中：落到第二条；两条都空则 null', () => {
    write('EMPTY.md', '   \n')
    write('NEXT.md', 'NEXT BODY')
    expect(resolveInstructionContent(dir, ['EMPTY.md', 'NEXT.md'])).toEqual({
      filename: 'NEXT.md',
      content: 'NEXT BODY'
    })

    write('ALSO-EMPTY.md', '\n\t \n')
    expect(resolveInstructionContent(dir, ['EMPTY.md', 'ALSO-EMPTY.md'])).toBeNull()
  })

  it('IF-U-4 不存在的条目跳过：第一条 ENOENT → 第二条；全不存在 → null 且不抛', () => {
    write('PRESENT.md', 'PRESENT BODY')
    expect(resolveInstructionContent(dir, ['MISSING.md', 'PRESENT.md'])).toEqual({
      filename: 'PRESENT.md',
      content: 'PRESENT BODY'
    })
    expect(() => resolveInstructionContent(dir, ['MISSING.md', 'ALSO-MISSING.md'])).not.toThrow()
    expect(resolveInstructionContent(dir, ['MISSING.md', 'ALSO-MISSING.md'])).toBeNull()
  })

  it('IF-U-5 同名目录不算命中：存在但不是文件 → 跳下一条', () => {
    mkdirSync(join(dir, 'AGENTS.md'), { recursive: true })
    write('CLAUDE.md', 'CLAUDE BODY')

    expect(realStatSync(join(dir, 'AGENTS.md')).isDirectory()).toBe(true)
    expect(resolveInstructionContent(dir, ['AGENTS.md', 'CLAUDE.md'])).toEqual({
      filename: 'CLAUDE.md',
      content: 'CLAUDE BODY'
    })
  })

  it('IF-U-6 子目录条目命中：filename 原样回 `docs/house.md`（不改写成绝对路径/basename）', () => {
    write('docs/house.md', 'HOUSE BODY')

    expect(resolveInstructionContent(dir, ['docs/house.md'])).toEqual({
      filename: 'docs/house.md',
      content: 'HOUSE BODY'
    })
  })

  it('IF-U-7 内容首尾空白被 trim（围栏由 createAgent 统一加，原文不该带空行）', () => {
    write('AGENTS.md', '\n\nX\n\n')

    expect(resolveInstructionContent(dir, ['AGENTS.md'])!.content).toBe('X')
  })

  it('IF-U-8 短路：workingDir 为空串 / 清单为空 → null，且一次 stat 都不发', () => {
    write('AGENTS.md', 'AGENTS BODY')

    expect(resolveInstructionContent('', ['AGENTS.md'])).toBeNull()
    expect(resolveInstructionContent(dir, [])).toBeNull()
    expect(vi.mocked(statSync)).not.toHaveBeenCalled()
  })

  // root 跑测试时 chmod 000 照样读得动，断言无意义
  const canDenyRead = process.platform !== 'win32' && process.getuid?.() !== 0
  it.skipIf(!canDenyRead)('IF-U-9 读不动的文件不算命中：跳下一条且不抛', () => {
    write('DENIED.md', 'DENIED BODY')
    chmodSync(join(dir, 'DENIED.md'), 0o000)
    write('NEXT.md', 'NEXT BODY')

    expect(resolveInstructionContent(dir, ['DENIED.md', 'NEXT.md'])).toEqual({
      filename: 'NEXT.md',
      content: 'NEXT BODY'
    })
  })

  it('IF-U-10 大文件不截断：300KB 原样读出（注入的是整份指令文件，不是摘要）', () => {
    const body = 'x'.repeat(300 * 1024)
    write('BIG.md', body)

    expect(resolveInstructionContent(dir, ['BIG.md'])!.content.length).toBe(body.length)
  })
})
