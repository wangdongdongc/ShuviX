/**
 * 跟踪项（trackingNotes.ts，实验）的纯函数 —— 文件名规则、行标题、载体项目 id。
 *
 * 文件名就是身份：侧栏只列认得的文件，主进程打开笔记本之前也用同一条规则挡住 `../`、子目录与隐藏文件 ——
 * 放宽一格，侧栏里点一行就能打开跟踪项目录以外的文件。标题是侧栏那一行的文字：要跳过 frontmatter、
 * 只认一级标题，取不到就退回文件名，不能是空行。
 *
 * 分组：TK-1 文件名 · TK-2 标题 · TK-3 载体项目 id
 */
import { describe, expect, it } from 'vitest'
import {
  isTrackingFileName,
  isTrackingProjectId,
  trackingTitle,
  TRACKING_PROJECT_ID
} from './trackingNotes'

describe('TK-1 isTrackingFileName', () => {
  it.each(['a.md', 'A.MD', 'Alpha bug.md', 'x.Md'])('TK-1 %j 是跟踪项', (name) => {
    expect(isTrackingFileName(name)).toBe(true)
  })

  it.each(['.a.md', 'a.txt', 'a.md.bak', 'a.markdown', 'sub/a.md', 'sub\\a.md', '../a.md', ''])(
    'TK-1 %j 不是（隐藏文件 / 别的扩展名 / 带路径分隔符 / 空串）',
    (name) => {
      expect(isTrackingFileName(name)).toBe(false)
    }
  )
})

describe('TK-2 trackingTitle', () => {
  it('TK-2 跳过开头的 frontmatter（LF 与 CRLF），取正文第一个一级标题', () => {
    expect(trackingTitle('---\nshuvix: track v1\n---\n# Alpha bug\n\nbody', 'a.md')).toBe(
      'Alpha bug'
    )
    expect(trackingTitle('---\r\nshuvix: track v1\r\n---\r\n# Alpha bug\r\n\r\nbody', 'a.md')).toBe(
      'Alpha bug'
    )
    // frontmatter 里的 YAML 注释长得像一级标题：块被跳过，它就不会被当成标题
    expect(trackingTitle('---\n# yaml comment\nshuvix: track v1\n---\n# Real', 'a.md')).toBe('Real')
  })

  it('TK-2 第一个 `# ` 标题胜出；`## x` 与 `#x` 不算；结尾的 ` ##` 去掉', () => {
    expect(trackingTitle('intro\n# First\n# Second', 'a.md')).toBe('First')
    expect(trackingTitle('## Sub\n#nospace\n# Top', 'a.md')).toBe('Top')
    expect(trackingTitle('# Closed heading ##', 'a.md')).toBe('Closed heading')
    expect(trackingTitle('#\tTabbed', 'a.md')).toBe('Tabbed')
  })

  it('TK-2 空的 `# ` / 没有标题 → 文件名去掉 .md（大小写不敏感）', () => {
    expect(trackingTitle('# \n\nbody', 'empty.md')).toBe('empty')
    expect(trackingTitle('#   \n', 'blank.md')).toBe('blank')
    expect(trackingTitle('---\nshuvix: track v1\n---\nno heading here', 'b.md')).toBe('b')
    expect(trackingTitle('', 'UPPER.MD')).toBe('UPPER')
    expect(trackingTitle('## only level two', 'c.Md')).toBe('c')
  })

  it('TK-2 （钉现状）围栏代码块里的 `# ` 行也会被取；不在第 0 字节的 frontmatter 不跳过', () => {
    expect(trackingTitle('```sh\n# install deps\n```\n\n# Real title', 'a.md')).toBe('install deps')
    // 前面多一个空行：不算 frontmatter，块里那行 YAML 注释就成了第一个一级标题
    expect(trackingTitle('\n---\n# yaml comment\n---\n# Real', 'a.md')).toBe('yaml comment')
  })
})

describe('TK-3 isTrackingProjectId', () => {
  it('TK-3 只认 `__tracking__`（整串比较）；日报载体、空值与形似输入不算', () => {
    expect(TRACKING_PROJECT_ID).toBe('__tracking__')
    expect(isTrackingProjectId('__tracking__')).toBe(true)
    for (const id of [
      '__daily__',
      null,
      undefined,
      '',
      '__tracking',
      ' __tracking__',
      '__TRACKING__'
    ]) {
      expect(isTrackingProjectId(id), String(id)).toBe(false)
    }
  })
})
