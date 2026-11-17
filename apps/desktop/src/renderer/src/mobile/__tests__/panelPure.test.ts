/**
 * 手机布局的文件 / 后台任务 / 产物几页用的纯函数（mobile/panelPure.ts）。
 *
 * 契约：
 * - formatFileSize：1023 B、1.5 KB、12 MB、3.4 GB —— 不到 10 带一位小数（`.0` 不写），四舍五入后够 1024 的进一位；
 *   负数 / 非有限数是空串；
 * - isHiddenName / nameOf：只看最后一段（文件夹条目的尾斜杠不算）；
 * - searchFiles：在 `dir` 以下、对相对 `dir` 的路径做不分大小写的子串匹配；名字里命中的排在只在路径里命中的前面，
 *   各自保持给的顺序；最多 100 个；空查询没有结果；
 * - taskDotState：没结束的 —— 等你回答 > 命令是「常驻」、智能体与子会话是「智能体在跑」；结束的 —— 出错 / 其余；
 * - artifactKey / groupArtifacts：按会话分组，组与组内都保持清单的顺序。
 *
 *   PP-1..4   formatFileSize
 *   PP-5      isHiddenName / nameOf
 *   PP-6..10  searchFiles
 *   PP-11     taskDotState
 *   PP-12..14 artifactKey / groupArtifacts
 */
import { describe, expect, it, vi } from 'vitest'
import type { SessionArtifact } from '@shuvix/chat-protocol/artifacts'
import type { TaskInfo } from '@shuvix/chat-protocol/types/task'

// 两个包的入口会拉进整套界面；这里只要它们各一个纯函数
vi.mock('@shuvix/chat-ui', () => ({
  isTaskFinished: (task: { status: string }) =>
    task.status === 'done' || task.status === 'error' || task.status === 'killed'
}))
vi.mock('@shuvix/app-shell', () => ({
  basename: (p: string) =>
    p
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() ?? ''
}))

import {
  FILE_SEARCH_LIMIT,
  artifactKey,
  formatFileSize,
  groupArtifacts,
  isHiddenName,
  nameOf,
  searchFiles,
  taskDotState
} from '../panelPure'
import { artifactKeyOf, artifactPage } from '../panelHistory'

describe('panelPure: formatFileSize', () => {
  it.each<[number, string]>([
    [0, '0 B'],
    [1, '1 B'],
    [1023, '1023 B'],
    [1024, '1 KB'],
    [1536, '1.5 KB'],
    [10 * 1024, '10 KB'],
    [12.4 * 1024, '12 KB'],
    [1024 ** 2, '1 MB'],
    [3.4 * 1024 ** 3, '3.4 GB'],
    [2 * 1024 ** 4, '2 TB']
  ])('PP-1 %d bytes → %s', (bytes, text) => {
    expect(formatFileSize(bytes)).toBe(text)
  })

  it('PP-2 one decimal below 10, ".0" dropped', () => {
    expect(formatFileSize(2048)).toBe('2 KB')
    expect(formatFileSize(9.94 * 1024)).toBe('9.9 KB')
  })

  it.each([-1, NaN, Infinity, -Infinity])('PP-3 %d is no size', (bytes) => {
    expect(formatFileSize(bytes)).toBe('')
  })

  it('PP-4 just below a unit boundary moves to the next unit', () => {
    expect(formatFileSize(1024 * 1024 - 1)).toBe('1 MB')
    expect(formatFileSize(1024 ** 3 - 1)).toBe('1 GB')
    expect(formatFileSize(1024 ** 4 - 1)).toBe('1 TB')
    expect(formatFileSize(9.96 * 1024)).toBe('10 KB')
  })

  it('PP-4b beyond the largest unit it stays in TB', () => {
    expect(formatFileSize(5000 * 1024 ** 4)).toBe('5000 TB')
  })
})

describe('panelPure: isHiddenName / nameOf', () => {
  it('PP-5 only the last segment counts', () => {
    expect(nameOf('a/b/c.txt')).toBe('c.txt')
    expect(nameOf('src/')).toBe('src')
    expect(isHiddenName('.env')).toBe(true)
    expect(isHiddenName('a/.git/')).toBe(true)
    expect(isHiddenName('a/.x')).toBe(true)
    expect(isHiddenName('a.b')).toBe(false)
    expect(isHiddenName('.a/b')).toBe(false)
  })
})

describe('panelPure: searchFiles', () => {
  it.each(['', '   ', '\t'])('PP-6 a blank query (%j) finds nothing', (query) => {
    expect(searchFiles(['a.txt', 'b/a.txt'], '', query)).toEqual([])
  })

  it('PP-7 name matches first, then path-only matches, each in input order, case-insensitive', () => {
    const paths = ['docs/readme.md', 'src/readme/x.ts', 'README.md', 'src/a.ts']
    expect(searchFiles(paths, '', 'readme')).toEqual([
      'docs/readme.md',
      'README.md',
      'src/readme/x.ts'
    ])
    expect(searchFiles(paths, '', '  ReadMe ')).toEqual([
      'docs/readme.md',
      'README.md',
      'src/readme/x.ts'
    ])
  })

  it('PP-8 only paths under the folder', () => {
    const paths = ['src/readme.md', 'src2/readme.md', 'src', 'readme.md', 'src/deep/readme.txt']
    expect(searchFiles(paths, 'src', 'readme')).toEqual(['src/readme.md', 'src/deep/readme.txt'])
  })

  it('PP-9 matching is against the path relative to the folder', () => {
    const paths = ['src/a.ts', 'src/src-util.ts', 'src/srcdir/a.ts']
    expect(searchFiles(paths, 'src', 'src')).toEqual(['src/src-util.ts', 'src/srcdir/a.ts'])
  })

  it('PP-10 at most 100: the first 100 name matches in input order', () => {
    expect(FILE_SEARCH_LIMIT).toBe(100)
    const paths = Array.from({ length: 150 }, (_, i) => `d/hit${i}.txt`)
    const found = searchFiles(paths, '', 'hit')
    expect(found).toHaveLength(100)
    expect(found).toEqual(paths.slice(0, 100))
  })

  it('PP-10 at most 100: all name matches, then the first path-only ones', () => {
    const byPath = Array.from({ length: 60 }, (_, i) => `hit/p${i}.txt`)
    const byName = Array.from({ length: 60 }, (_, i) => `d/hit${i}.txt`)
    // 只在路径里命中的排在输入的前面，结果里仍在后面
    const found = searchFiles([...byPath, ...byName], '', 'hit')
    expect(found).toHaveLength(100)
    expect(found).toEqual([...byName, ...byPath.slice(0, 40)])
  })
})

describe('panelPure: taskDotState', () => {
  const task = (kind: string, status: string): TaskInfo => ({ kind, status }) as unknown as TaskInfo

  it.each<[string, string, boolean, string]>([
    ['bash', 'running', false, 'resident'],
    ['agent', 'running', false, 'agent'],
    ['sub-session', 'running', false, 'agent'],
    ['bash', 'waiting-input', true, 'blocked'],
    ['agent', 'waiting-input', true, 'blocked'],
    ['sub-session', 'waiting-input', true, 'blocked'],
    ['bash', 'running', true, 'blocked'],
    ['agent', 'running', true, 'blocked'],
    ['agent', 'waiting-input', false, 'agent'],
    ['bash', 'done', false, 'ended'],
    ['agent', 'killed', false, 'ended'],
    ['bash', 'error', false, 'error'],
    ['bash', 'done', true, 'ended'],
    ['agent', 'killed', true, 'ended'],
    ['sub-session', 'error', true, 'error']
  ])('PP-11 %s / %s / blocked=%s → %s', (kind, status, blocked, dot) => {
    expect(taskDotState(task(kind, status), blocked)).toBe(dot)
  })
})

describe('panelPure: artifactKey / groupArtifacts', () => {
  const art = (sessionId: string, name: string, subSessionTitle?: string): SessionArtifact => ({
    sessionId,
    name,
    title: name,
    path: `/a/${sessionId}/${name}`,
    versions: 1,
    updatedAt: 1,
    ...(subSessionTitle !== undefined ? { subSessionTitle } : {})
  })

  it('PP-12 no rows, no groups', () => {
    expect(groupArtifacts([])).toEqual([])
  })

  it('PP-12b the key is `<session id>/<name>`, the same as the history page id', () => {
    expect(artifactKey({ sessionId: 's1', name: 'a.svg' })).toBe('s1/a.svg')
    const odd = { sessionId: 's1', name: 'a:b.svg' }
    expect(artifactKeyOf(artifactPage(odd.sessionId, odd.name))).toBe(artifactKey(odd))
  })

  it('PP-13 own rows, then each sub-session, in first-appearance order', () => {
    const rows = [
      art('s1', 'a.svg'),
      art('s1', 'b.html'),
      art('c1', 'a.svg', 'Child one'),
      art('c2', 'x.csv', 'Child two'),
      art('c2', 'y.csv', 'Child two')
    ]
    const groups = groupArtifacts(rows)
    expect(groups.map((g) => g.sessionId)).toEqual(['s1', 'c1', 'c2'])
    expect(groups[0].subSessionTitle).toBeUndefined()
    expect(groups[1].subSessionTitle).toBe('Child one')
    expect(groups[2].subSessionTitle).toBe('Child two')
    expect(groups[0].items).toEqual([rows[0], rows[1]])
    expect(groups[1].items).toEqual([rows[2]])
    expect(groups[2].items).toEqual([rows[3], rows[4]])
  })

  it('PP-14 rows of one session that are not contiguous join its first group', () => {
    const rows = [art('s1', 'a.svg'), art('c1', 'b.svg', 'Child'), art('s1', 'c.svg')]
    const groups = groupArtifacts(rows)
    expect(groups.map((g) => g.sessionId)).toEqual(['s1', 'c1'])
    expect(groups[0].items).toEqual([rows[0], rows[2]])
    expect(groups[1].items).toEqual([rows[1]])
  })
})
