/**
 * markdownFiles —— 从系统「打开方式」交进来的 md：路径判定与命令行解析。
 *
 * 契约：
 *   - 扩展名 `.md` / `.markdown`（大小写不敏感）才算 md；扩展名看的是 `extname`，
 *     所以一个就叫 `.md` 的文件（隐藏文件，没有扩展名）不算；
 *   - 「存在的普通文件」跟随符号链接：指向文件的链接算，目录 / 不存在 / 断链都不算；
 *   - argv 逐个判定，不按下标跳过：`-` 开头是开关（哪怕长得像 `--x=/a/b.md`），其余按**传入的**
 *     cwd 解析成绝对路径，md 扩展名 + 存在的普通文件才要；同一个文件的不同写法只留一份，保序；
 *   - 判定「是不是文件」可注入，注入之后缺省实现不再被问。
 *
 * 在真的临时目录上跑（符号链接、目录、断链都是真的）。
 *
 *   MF-1 isMarkdownPath：a.md / A.MD / x.Markdown 是；a.mdx / a.md.txt / a / 名叫 .md 的文件不是
 *   MF-2 isExistingFile：普通文件、指向文件的链接是；目录、不存在、断链不是
 *   MF-3 真实形状的 argv（electron / . / 脚本 / 开关 / 长得像 md 的开关 / a.md）只挑出 a.md 的绝对路径
 *   MF-4 相对参数按传入的 cwd 解析，而不是 process.cwd()
 *   MF-5 去重保序：同一个文件的绝对 / 相对 / ./ 写法只出现一次；两个文件保持 argv 顺序
 *   MF-6 丢掉：叫 x.md 的目录、不存在的 y.md、空串、相对的 -notes.md；保留绝对路径 /d/-notes.md
 *   MF-7 注入的 isFile 被用上、缺省实现不再被问（两个方向：注入说是 → 不存在也要；注入说不是 → 存在也不要）
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MARKDOWN_EXTENSIONS,
  isExistingFile,
  isMarkdownPath,
  markdownFilesFromArgv
} from '../markdownFiles'

/** 临时根取 realpath：macOS 的 /var → /private/var，否则 resolve 出来的路径与预期对不上 */
let root: string

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'shuvix-mdfiles-')))
  writeFileSync(join(root, 'a.md'), '# a\n')
  writeFileSync(join(root, 'b.md'), '# b\n')
  writeFileSync(join(root, 'notes.txt'), 'plain\n')
  writeFileSync(join(root, 'script.cjs'), '// script\n')
  writeFileSync(join(root, 'electron'), '')
  mkdirSync(join(root, 'x.md'))
  mkdirSync(join(root, 'd'))
  writeFileSync(join(root, 'd', '-notes.md'), '# dash\n')
  writeFileSync(join(root, '-notes.md'), '# dash at root\n')
  symlinkSync(join(root, 'a.md'), join(root, 'link-to-a.md'))
  symlinkSync(join(root, 'gone.md'), join(root, 'broken.md'))
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('MF-1 isMarkdownPath', () => {
  it.each(['a.md', 'A.MD', 'x.Markdown', '/abs/dir/notes.markdown', 'rel/dir/n.Md'])(
    'MF-1 %s 是 md',
    (path) => {
      expect(isMarkdownPath(path)).toBe(true)
    }
  )

  it.each(['a.mdx', 'a.md.txt', 'a', '.md', '/abs/dir/.md', 'md'])('MF-1 %s 不是 md', (path) => {
    expect(isMarkdownPath(path)).toBe(false)
  })

  it('MF-1 扩展名表就是 .md / .markdown（小写、带点）', () => {
    expect([...MARKDOWN_EXTENSIONS].sort()).toEqual(['.markdown', '.md'])
  })
})

describe('MF-2 isExistingFile', () => {
  it('MF-2 普通文件、指向文件的符号链接 → true', () => {
    expect(isExistingFile(join(root, 'a.md'))).toBe(true)
    expect(isExistingFile(join(root, 'link-to-a.md'))).toBe(true)
  })

  it('MF-2 目录、不存在、断链 → false', () => {
    expect(isExistingFile(join(root, 'x.md'))).toBe(false)
    expect(isExistingFile(join(root, 'missing.md'))).toBe(false)
    expect(isExistingFile(join(root, 'broken.md'))).toBe(false)
  })
})

describe('MF-3 ~ MF-6 markdownFilesFromArgv', () => {
  it('MF-3 真实形状的 argv 只挑出 a.md 的绝对路径', () => {
    const argv = [
      join(root, 'electron'),
      '.',
      join(root, 'script.cjs'),
      '--remote-debugging-port=1',
      // 长得像 md 的开关：值里的路径哪怕存在也不算
      `--x=${join(root, 'b.md')}`,
      join(root, 'a.md')
    ]
    expect(markdownFilesFromArgv(argv, root)).toEqual([join(root, 'a.md')])
  })

  it('MF-4 相对参数按传入的 cwd 解析，不按 process.cwd()', () => {
    // process.cwd() 是 vitest 的 root（apps/desktop），那里没有 a.md；传进去的 cwd 才有
    expect(process.cwd()).not.toBe(root)
    expect(markdownFilesFromArgv(['a.md'], root)).toEqual([join(root, 'a.md')])
    expect(markdownFilesFromArgv(['d/-notes.md'], root)).toEqual([join(root, 'd', '-notes.md')])
    // 换一个 cwd：同一个相对参数落到另一个目录（那里没有这个文件 → 什么都没有）
    expect(markdownFilesFromArgv(['a.md'], join(root, 'd'))).toEqual([])
  })

  it('MF-5 去重保序：同一个文件的几种写法只出现一次，两个文件保持 argv 顺序', () => {
    const a = join(root, 'a.md')
    const b = join(root, 'b.md')
    expect(markdownFilesFromArgv([a, 'a.md', './a.md', 'd/../a.md'], root)).toEqual([a])
    expect(markdownFilesFromArgv(['b.md', a, './b.md', 'a.md'], root)).toEqual([b, a])
    expect(markdownFilesFromArgv(['a.md', 'b.md'], root)).toEqual([a, b])
  })

  it('MF-6 丢掉目录 x.md、不存在的 y.md、空串、相对的 -notes.md；保留绝对路径 /d/-notes.md', () => {
    const argv = ['x.md', 'y.md', '', '-notes.md', join(root, 'd', '-notes.md')]
    expect(markdownFilesFromArgv(argv, root)).toEqual([join(root, 'd', '-notes.md')])
    // 对照：root 下确实有一个 -notes.md —— 丢它是因为 `-` 开头，不是因为不存在
    expect(isExistingFile(join(root, '-notes.md'))).toBe(true)
  })

  it('MF-6 非 md 的文件（.txt / 脚本）即使存在也不要', () => {
    expect(markdownFilesFromArgv(['notes.txt', 'script.cjs'], root)).toEqual([])
  })
})

describe('MF-7 isFile 可注入', () => {
  it('MF-7 注入说是 → 不存在的 md 也要；只问 md 候选，问的是解析后的绝对路径', () => {
    const isFile = vi.fn(() => true)
    const out = markdownFilesFromArgv(['--flag', 'ghost.md', 'notes.txt', '.'], root, isFile)
    expect(out).toEqual([join(root, 'ghost.md')])
    expect(isFile.mock.calls).toEqual([[join(root, 'ghost.md')]])
  })

  it('MF-7 注入说不是 → 真实存在的 a.md 也不要（缺省实现没有被问）', () => {
    const isFile = vi.fn(() => false)
    expect(markdownFilesFromArgv([join(root, 'a.md'), 'b.md'], root, isFile)).toEqual([])
    expect(isFile).toHaveBeenCalledTimes(2)
  })
})
