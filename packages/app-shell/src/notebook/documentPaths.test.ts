/**
 * 笔记里相对路径的解析：图片 `![](x)` 走 resolveAgainstDocDir（相对笔记所在目录，主窗口的笔记路径本身
 * 也是相对工作目录的），文件链接 `[t](x)` 走 resolveRelativeFileLink（打开文件要绝对路径）。
 */
import { describe, expect, it } from 'vitest'
import {
  isRelativeFileLink,
  resolveAgainstDocDir as R,
  resolveRelativeFileLink as RL
} from './documentPaths'

describe('resolveAgainstDocDir', () => {
  it('DP-1 relative target joins the note folder; `.` segments are skipped', () => {
    expect(R('docs/a.md', 'b.png')).toBe('docs/b.png')
    expect(R('docs/a.md', './sub/./b.png')).toBe('docs/sub/b.png')
    expect(R('/Users/me/p/docs/a.md', 'b.png')).toBe('/Users/me/p/docs/b.png')
  })

  it('DP-2 `..` goes up one folder', () => {
    expect(R('docs/a.md', '../b.png')).toBe('b.png')
    expect(R('/Users/me/p/docs/a.md', '../b.png')).toBe('/Users/me/p/b.png')
  })

  it('DP-3 a note at the working directory root: `..` stays at the front', () => {
    expect(R('a.md', '../b.png')).toBe('../b.png')
  })

  it('DP-4 more `..` than the relative note has folders: the rest stays at the front', () => {
    expect(R('docs/a.md', '../../../b.png')).toBe('../../b.png')
  })

  it('DP-5 a note path that itself starts with `..` is not popped into', () => {
    expect(R('../a.md', '../b.png')).toBe('../../b.png')
  })

  it('DP-6 a leading `./` on the note path does not count as a folder', () => {
    expect(R('./a.md', '../b.png')).toBe('../b.png')
    expect(R('./docs/a.md', '../../b.png')).toBe('../b.png')
  })

  it('DP-7 absolute note: `..` may reach the root', () => {
    expect(R('/a/b.md', '../c.png')).toBe('/c.png')
  })

  it('DP-8 absolute note: `..` past the root → null', () => {
    expect(R('/a.md', '../b.png')).toBeNull()
    expect(R('/a/b.md', '../../c.png')).toBeNull()
  })

  it('DP-9 query string and fragment are dropped', () => {
    expect(R('docs/a.md', 'b.png?raw=1#top')).toBe('docs/b.png')
    expect(R('docs/a.md', 'b.png#x?y')).toBe('docs/b.png')
  })

  it.each(['', '   ', '#x', '?x'])('DP-10 nothing left after cleaning (%j) → null', (rel) => {
    expect(R('docs/a.md', rel)).toBeNull()
  })

  it('DP-11 percent escapes are decoded once', () => {
    expect(R('docs/a.md', 'my%20pic.png')).toBe('docs/my pic.png')
    expect(R('docs/a.md', '%E5%9B%BE.png')).toBe('docs/图.png')
    expect(R('docs/a.md', 'a%2520b.png')).toBe('docs/a%20b.png')
  })

  it('DP-12 escaped `#` and `?` are part of the file name', () => {
    expect(R('docs/a.md', 'a%23b%3Fc.png')).toBe('docs/a#b?c.png')
  })

  it('DP-13 a bare `%` in a file name is kept', () => {
    expect(R('docs/a.md', '100%.png')).toBe('docs/100%.png')
    expect(R('docs/a.md', '100%.png#a')).toBe('docs/100%.png')
  })

  it('DP-14 an escaped `..` is still a parent step', () => {
    expect(R('docs/a.md', '%2e%2e/b.png')).toBe('b.png')
  })

  it('DP-15 names that only start with dots are ordinary names', () => {
    expect(R('docs/a.md', '..foo/...png')).toBe('docs/..foo/...png')
  })

  it('DP-16 valid escapes next to a bare `%`: each handled on its own', () => {
    expect(R('docs/a.md', 'my%20100%.png')).toBe('docs/my 100%.png')
  })

  it('DP-17 Windows drive paths keep the note path separator', () => {
    expect(R('C:\\p\\docs\\a.md', '..\\b.png')).toBe('C:\\p\\b.png')
    expect(R('C:\\p\\docs\\a.md', 'sub/b.png')).toBe('C:\\p\\docs\\sub\\b.png')
    expect(R('C:/p/docs/a.md', '../b.png')).toBe('C:/p/b.png')
  })

  it('DP-18 Windows drive root: reachable, not passable', () => {
    expect(R('C:\\p\\a.md', '../b.png')).toBe('C:\\b.png')
    expect(R('C:\\a.md', 'b.png')).toBe('C:\\b.png')
    expect(R('C:\\a.md', '../b.png')).toBeNull()
  })

  it('DP-19 UNC path inside the share', () => {
    expect(R('\\\\srv\\share\\d\\a.md', '../b.png')).toBe('\\\\srv\\share\\b.png')
  })

  it('DP-20 UNC path: `..` cannot leave the share', () => {
    expect(R('\\\\srv\\share\\a.md', '../b.png')).toBeNull()
    expect(R('\\\\srv\\share\\a.md', '../../b.png')).toBeNull()
  })

  it('DP-21 relative note: the separator follows the note path', () => {
    expect(R('docs\\a.md', '../../b.png')).toBe('..\\b.png')
    expect(R('docs/a.md', 'sub\\b.png')).toBe('docs/sub/b.png')
  })

  it('DP-27 a leading `~` / `@` the main process would expand stays a file name', () => {
    expect(R('a.md', '~/b.png')).toBe('./~/b.png')
    expect(R('a.md', '@b.png')).toBe('./@b.png')
    expect(R('docs/a.md', '../@b.png')).toBe('./@b.png')
    expect(R('docs/a.md', '~/b.png')).toBe('docs/~/b.png')
    expect(R('/p/a.md', '~/b.png')).toBe('/p/~/b.png')
  })
})

describe('isRelativeFileLink / resolveRelativeFileLink', () => {
  it.each(['b.md', './b.md', '../b.md', 'sub/b.md', './a:b.md'])(
    'DP-22 %j is a relative file link',
    (url) => {
      expect(isRelativeFileLink(url)).toBe(true)
    }
  )

  it.each([
    'https://x.y/a',
    'HTTP://x',
    'mailto:a@b.c',
    'file:///x',
    'data:x',
    '#x',
    '  #x',
    '',
    '   ',
    '/abs/x',
    'C:\\x',
    'C:/x',
    '\\\\s\\x',
    '//host/x'
  ])('DP-23 %j is not a relative file link', (url) => {
    expect(isRelativeFileLink(url)).toBe(false)
    expect(RL(url, 'docs/a.md', '/p')).toBeNull()
  })

  it('DP-24 a relative note needs the working directory', () => {
    expect(RL('../b.md', 'docs/a.md', '/Users/me/p')).toBe('/Users/me/p/b.md')
    expect(RL('../b.md', 'docs/a.md', null)).toBeNull()
    expect(RL('../b.md', 'docs/a.md', '')).toBeNull()
  })

  it('DP-25 the same note resolves alike by relative and absolute path; root ignored when absolute', () => {
    expect(RL('../../b.md', 'docs/a.md', '/Users/me/p')).toBe('/Users/me/b.md')
    expect(RL('../../b.md', '/Users/me/p/docs/a.md', null)).toBe('/Users/me/b.md')
    expect(RL('../../b.md', '/Users/me/p/docs/a.md', '/other')).toBe('/Users/me/b.md')
  })

  it('DP-26 root with a trailing separator, at the filesystem root, and on Windows', () => {
    expect(RL('b.md', 'docs/a.md', '/Users/me/p/')).toBe('/Users/me/p/docs/b.md')
    expect(RL('b.md', 'a.md', '/')).toBe('/b.md')
    expect(RL('b.md', 'a.md', 'C:\\')).toBe('C:\\b.md')
    expect(RL('b.md', 'docs\\a.md', 'C:\\p')).toBe('C:\\p\\docs\\b.md')
  })
})
