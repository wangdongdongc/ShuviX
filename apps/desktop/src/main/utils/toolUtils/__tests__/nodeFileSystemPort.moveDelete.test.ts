/**
 * nodeFileSystemPort.rename / remove —— move / delete 工具在桌面上落到的那两步（真实临时目录，不打桩）。
 *
 *   NR-1 rename 一个文件：建出目标的父目录，内容原样，源没了
 *   NR-2 目标已存在（文件或目录）：抛 code EEXIST，两边一个字节不动（POSIX rename 本会静默覆盖）
 *   NR-3 rename 一个目录：整棵挪过去
 *   NR-4 只改大小写：大小写不敏感的盘上（macOS / Windows 缺省）改名成功；大小写敏感的盘上两个名字是两个文件，
 *        目标不存在照常改名
 *   NR-5 remove：文件 → 没了；空目录 → 没了；非空目录 → 抛 ENOTEMPTY、原样；符号链接 → 删的是链接本身
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nodeFileSystemPort } from '../nodeFileSystemPort'

let T = ''

beforeEach(() => {
  T = mkdtempSync(join(tmpdir(), 'shuvix-nfp-mv-'))
})
afterEach(() => rmSync(T, { recursive: true, force: true }))

function port(): Required<Pick<typeof nodeFileSystemPort, 'rename' | 'remove'>> {
  const { rename, remove } = nodeFileSystemPort
  if (!rename || !remove) throw new Error('the desktop port must implement rename and remove')
  return { rename, remove }
}

const codeOf = async (work: Promise<unknown>): Promise<string | undefined> => {
  try {
    await work
  } catch (err) {
    return (err as NodeJS.ErrnoException).code
  }
  return undefined
}

describe('nodeFileSystemPort.rename', () => {
  it('NR-1 文件：建出父目录、内容原样、源没了', async () => {
    writeFileSync(join(T, 'a.md'), 'A')
    await port().rename(join(T, 'a.md'), join(T, 'x', 'y', 'b.md'))
    expect(readFileSync(join(T, 'x', 'y', 'b.md'), 'utf-8')).toBe('A')
    expect(existsSync(join(T, 'a.md'))).toBe(false)
  })

  it('NR-2 目标已存在（文件 / 目录）：EEXIST，两边不动', async () => {
    writeFileSync(join(T, 'a.md'), 'A')
    writeFileSync(join(T, 'b.md'), 'B')
    mkdirSync(join(T, 'dir'))
    expect(await codeOf(port().rename(join(T, 'a.md'), join(T, 'b.md')))).toBe('EEXIST')
    expect(await codeOf(port().rename(join(T, 'a.md'), join(T, 'dir')))).toBe('EEXIST')
    expect(readFileSync(join(T, 'a.md'), 'utf-8')).toBe('A')
    expect(readFileSync(join(T, 'b.md'), 'utf-8')).toBe('B')
    expect(readdirSync(join(T, 'dir'))).toEqual([])
  })

  it('NR-3 目录：整棵挪过去', async () => {
    mkdirSync(join(T, 'd', 'sub'), { recursive: true })
    writeFileSync(join(T, 'd', 'x.md'), 'X')
    writeFileSync(join(T, 'd', 'sub', 'y.md'), 'Y')
    await port().rename(join(T, 'd'), join(T, 'e', 'd2'))
    expect(existsSync(join(T, 'd'))).toBe(false)
    expect(readFileSync(join(T, 'e', 'd2', 'x.md'), 'utf-8')).toBe('X')
    expect(readFileSync(join(T, 'e', 'd2', 'sub', 'y.md'), 'utf-8')).toBe('Y')
  })

  it('NR-4 只改大小写', async () => {
    writeFileSync(join(T, 'note.md'), 'N')
    const caseInsensitive = existsSync(join(T, 'NOTE.md'))
    await port().rename(join(T, 'note.md'), join(T, 'Note.md'))
    expect(readdirSync(T)).toEqual(['Note.md'])
    expect(readFileSync(join(T, 'Note.md'), 'utf-8')).toBe('N')
    if (!caseInsensitive) {
      // 大小写敏感的盘上 Note.md 与 NOTE.md 是两个文件：已有的那个照样不替换
      writeFileSync(join(T, 'NOTE.md'), 'other')
      expect(await codeOf(port().rename(join(T, 'Note.md'), join(T, 'NOTE.md')))).toBe('EEXIST')
    }
  })
})

describe('nodeFileSystemPort.remove', () => {
  it('NR-5 文件 / 空目录删掉；非空目录 ENOTEMPTY 原样', async () => {
    writeFileSync(join(T, 'a.md'), 'A')
    mkdirSync(join(T, 'empty'))
    mkdirSync(join(T, 'full'))
    writeFileSync(join(T, 'full', 'x.md'), 'X')

    await port().remove(join(T, 'a.md'))
    await port().remove(join(T, 'empty'))
    expect(existsSync(join(T, 'a.md'))).toBe(false)
    expect(existsSync(join(T, 'empty'))).toBe(false)

    expect(await codeOf(port().remove(join(T, 'full')))).toMatch(/^(ENOTEMPTY|EEXIST)$/)
    expect(readFileSync(join(T, 'full', 'x.md'), 'utf-8')).toBe('X')
  })

  it.skipIf(process.platform === 'win32')('NR-5 符号链接：删的是链接本身，那头不动', async () => {
    mkdirSync(join(T, 'real'))
    writeFileSync(join(T, 'real', 'x.md'), 'X')
    symlinkSync(join(T, 'real'), join(T, 'dirlink'))
    symlinkSync(join(T, 'real', 'x.md'), join(T, 'filelink'))
    await port().remove(join(T, 'dirlink'))
    await port().remove(join(T, 'filelink'))
    expect(readdirSync(T).sort()).toEqual(['real'])
    expect(readFileSync(join(T, 'real', 'x.md'), 'utf-8')).toBe('X')
  })
})
