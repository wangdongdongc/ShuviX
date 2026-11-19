/**
 * bundleIndex —— 库的目录索引（index.md）与顶层简讯的纯函数（2026-11-19）。
 *
 * 契约：
 *  - index.md 的条目行按 frontmatter 现生成；文件夹行的描述是唯一「存」在里面的东西，重新生成时带过去；
 *  - 生成的每一份都得合 `isProjectionText` 的行形状（扫描据此不把它当笔记）；
 *  - 进 index.md / 系统提示词的文字一律单行、无尖括号、限长；
 *  - 简讯只有顶层：文件夹（现行条目数 + 描述）在前、条目在后，`deprecated` 不列不算，行数封顶。
 */
import { describe, it, expect } from 'vitest'
import {
  KNOWLEDGE_FOLDER_DESCRIPTION_MAX,
  KNOWLEDGE_OUTLINE_MAX_LINES,
  buildKnowledgeOutline,
  cleanIndexLine,
  collectFolderDescriptions,
  foldersWithNotes,
  indexPathOf,
  readFolderDescriptions,
  renderBundleIndexes,
  undescribedFolders
} from '../bundleIndex'
import { isProjectionText } from '../validate'
import type { OkfStatus } from '@shuvix/chat-protocol/knowledge'

interface N {
  path: string
  title: string
  description: string
  status: OkfStatus
}

function note(path: string, title = '', description = '', status: OkfStatus = 'stable'): N {
  return {
    path,
    title: title || path.replace(/^.*\//, '').replace(/\.md$/, ''),
    description,
    status
  }
}

const DEFAULT_FM = '---\nokf_version: "0.2"\n---\n'

/** 把一次渲染的结果当成盘上的 index 文件，读回全库的文件夹描述 */
function descriptionsOf(rendered: Map<string, string>): Map<string, string> {
  return collectFolderDescriptions(
    [...rendered].map(([dir, text]) => ({ path: indexPathOf(dir), text }))
  )
}

describe('cleanIndexLine', () => {
  it('BI-1 控制字符 / 行分隔符变成一个空格，连续空白合并，两头去掉', () => {
    expect(cleanIndexLine('  a\n b\t\u2028c  d\u0000 ', 100)).toBe('a b c d')
  })

  it('BI-2 尖括号去掉，其余文字留着', () => {
    const out = cleanIndexLine('</knowledge_bases> <system>x', 100)
    expect(out).not.toMatch(/[<>]/)
    expect(out).toBe('/knowledge_bases systemx')
  })

  it('BI-3 超长按上限截并以 … 结尾；恰好等于上限原样返回', () => {
    const long = 'x'.repeat(200)
    const cut = cleanIndexLine(long, 160)
    expect([...cut]).toHaveLength(160)
    expect(cut.endsWith('…')).toBe(true)
    const exact = 'y'.repeat(160)
    expect(cleanIndexLine(exact, 160)).toBe(exact)
  })

  it('BI-4 按码点截：代理对不会被劈开；截点前的空格不留', () => {
    const cut = cleanIndexLine('😀'.repeat(200), 160)
    expect([...cut]).toHaveLength(160)
    expect(cut.endsWith('…')).toBe(true)
    expect([...cut].slice(0, 159).every((ch) => ch === '😀')).toBe(true)

    // 第 9、10 个字符是空格与 b：上限 10 → 留 9 个字符，末尾那个空格去掉
    expect(cleanIndexLine('aaaaaaaa bbbbbb', 10)).toBe('aaaaaaaa…')
  })
})

describe('renderBundleIndexes —— 形状', () => {
  it('BI-5 每个放着笔记的目录一份；根带 frontmatter，Folders 在前 Entries 在后；子目录没有 frontmatter', () => {
    const out = renderBundleIndexes([
      note('a.md', 'Alpha', 'when a'),
      note('auth/login.md', 'Login'),
      note('auth/oauth/pkce.md', 'PKCE')
    ])
    expect([...out.keys()].sort()).toEqual(['', 'auth', 'auth/oauth'])
    const root = out.get('')!
    expect(root.startsWith(DEFAULT_FM)).toBe(true)
    expect(root).toContain('## Folders\n\n* [auth](auth/)\n')
    expect(root).toContain('## Entries\n\n* [Alpha](a.md) - when a\n')
    expect(root.indexOf('## Folders')).toBeLessThan(root.indexOf('## Entries'))
    expect(out.get('auth')!.startsWith('---')).toBe(false)
    expect(out.get('auth')).toBe(
      '## Folders\n\n* [oauth](oauth/)\n\n## Entries\n\n* [Login](login.md)\n'
    )
    expect(out.get('auth/oauth')).toBe('## Entries\n\n* [PKCE](pkce.md)\n')
  })

  it('BI-6 只有子文件夹的目录只有 Folders 节；叶子目录只有 Entries 节', () => {
    const out = renderBundleIndexes([note('x/y/n.md', 'N')])
    expect(out.get('')).toContain('## Folders')
    expect(out.get('')).not.toContain('## Entries')
    expect(out.get('x')).toBe('## Folders\n\n* [y](y/)\n')
    expect(out.get('x/y')).toBe('## Entries\n\n* [N](n.md)\n')
  })

  it('BI-7 没有描述的条目行不带 " - "；标题为空回落文件名', () => {
    const out = renderBundleIndexes([{ path: 'plain.md', title: '', description: '' }])
    expect(out.get('')).toContain('* [plain.md](plain.md)\n')
    expect(out.get('')).not.toContain(' - ')
  })

  it('BI-8 没有笔记：一份都不生成（连根 index 都没有）', () => {
    expect(renderBundleIndexes([]).size).toBe(0)
  })

  it('BI-9 根 index 已有的 frontmatter 留着，旧正文被换掉', () => {
    const fm = '---\nokf_version: "0.2"\nprofile: x\n---\n'
    const out = renderBundleIndexes([note('a.md', 'A')], {
      rootIndex: `${fm}\n## Old\n\n* [gone](gone.md)\n`
    })
    const root = out.get('')!
    expect(root.startsWith(fm)).toBe(true)
    expect(root).not.toContain('gone')
    expect(root).toContain('* [A](a.md)')

    // BOM / CRLF：键都还在（不要求逐字节）
    for (const variant of [`\uFEFF${fm}\nbody\n`, `${fm.replace(/\n/g, '\r\n')}\r\nbody\r\n`]) {
      const again = renderBundleIndexes([note('a.md', 'A')], { rootIndex: variant }).get('')!
      expect(again).toContain('okf_version: "0.2"')
      expect(again).toContain('profile: x')
      expect(again.startsWith('---\n')).toBe(true)
      expect(again).not.toContain('body')
    }
  })

  it('BI-10 根 index 没有 frontmatter：用缺省那一块', () => {
    const out = renderBundleIndexes([note('a.md', 'A')], { rootIndex: '## Entries\n' })
    expect(out.get('')!.startsWith(DEFAULT_FM)).toBe(true)
  })

  it('BI-11 幂等：拿上一次的产物再生成一次，每个目录一字不差', () => {
    const notes = [
      note('a.md', 'Alpha', 'when a'),
      note('auth/login.md', 'Login', 'sign in'),
      note('auth/oauth/pkce.md', 'PKCE'),
      note('ops/run.md', 'Run')
    ]
    const first = renderBundleIndexes(notes, {
      descriptions: new Map([
        ['auth', 'Sign-in flows'],
        ['auth/oauth', 'OAuth details'],
        ['ops', 'How things are run']
      ])
    })
    const second = renderBundleIndexes(notes, {
      descriptions: descriptionsOf(first),
      rootIndex: first.get('')
    })
    expect([...second]).toEqual([...first])
  })
})

/** 名字里带特殊字符的文件夹与条目：BI-12 逐个验形状，BI-14..17 验往返 */
const SPECIAL_NOTES = [
  note('my notes (old)/a.md', 'A'),
  note('a]b[c/a.md', 'A'),
  note('50%off/a.md', 'A'),
  note('认证/登录.md', '登录', '改登录时看'),
  note('x (1).md', 'Fix [urgent] \\ now', 'has - dash (and) [brackets] * # in it'),
  note('with space.md', 'With space')
]
const SPECIAL_DESCRIPTIONS = new Map([
  ['my notes (old)', 'Old notes - kept (for now) [see] * #'],
  ['a]b[c', 'Brackets'],
  ['50%off', 'Percent'],
  ['认证', '登录与令牌相关']
])

describe('文件夹描述 —— 往返与特殊名字', () => {
  it('BI-12 生成的每一份（根与子目录）都合 isProjectionText 的形状', () => {
    const out = renderBundleIndexes(SPECIAL_NOTES, { descriptions: SPECIAL_DESCRIPTIONS })
    expect(out.size).toBe(5)
    for (const [dir, text] of out) {
      expect(isProjectionText(indexPathOf(dir), text), `dir "${dir}"\n${text}`).toBe(true)
    }
  })

  it('BI-13 描述写进根 index 的文件夹行，读回一字不差；没有描述的文件夹不在读回的表里', () => {
    const description = 'Sign-in flows; look here before touching tokens'
    const out = renderBundleIndexes([note('auth/a.md'), note('ops/b.md')], {
      descriptions: new Map([['auth', description]])
    })
    expect(out.get('')).toContain(`* [auth](auth/) - ${description}\n`)
    expect(out.get('')).toContain('* [ops](ops/)\n')
    expect(readFolderDescriptions(out.get('')!)).toEqual(new Map([['auth', description]]))
  })

  it('BI-14 名字带空格与括号的文件夹：链接目标里没有裸空格 / 括号，文字留可读的名字，读回原名', () => {
    const out = renderBundleIndexes(SPECIAL_NOTES, { descriptions: SPECIAL_DESCRIPTIONS })
    const root = out.get('')!
    expect(root).toContain('* [my notes (old)](my%20notes%20%28old%29/) - ')
    expect(readFolderDescriptions(root).get('my notes (old)')).toBe(
      'Old notes - kept (for now) [see] * #'
    )
  })

  it('BI-15 名字带方括号 / 百分号的文件夹：文字里转义，目标里 % 编码，都读回原名', () => {
    const root = renderBundleIndexes(SPECIAL_NOTES, { descriptions: SPECIAL_DESCRIPTIONS }).get('')!
    expect(root).toContain('* [a\\]b\\[c](a]b[c/) - Brackets')
    expect(root).toContain('* [50%off](50%25off/) - Percent')
    const read = readFolderDescriptions(root)
    expect(read.get('a]b[c')).toBe('Brackets')
    expect(read.get('50%off')).toBe('Percent')
  })

  it('BI-16 中文名的文件夹：文字与目标都不编码，读回原名', () => {
    const root = renderBundleIndexes(SPECIAL_NOTES, { descriptions: SPECIAL_DESCRIPTIONS }).get('')!
    expect(root).toContain('* [认证](认证/) - 登录与令牌相关')
    expect(readFolderDescriptions(root).get('认证')).toBe('登录与令牌相关')
  })

  it('BI-17 名字带括号、标题带方括号与反斜杠的条目：是条目行，不被当成文件夹行', () => {
    const root = renderBundleIndexes(SPECIAL_NOTES, { descriptions: SPECIAL_DESCRIPTIONS }).get('')!
    expect(root).toContain('* [Fix \\[urgent\\] \\\\ now](x%20%281%29.md) - has - dash')
    expect([...readFolderDescriptions(root).keys()].sort()).toEqual(
      ['50%off', 'a]b[c', 'my notes (old)', '认证'].sort()
    )
  })

  it('BI-18 以短横开头、中间带 " - " 的描述原样往返', () => {
    const descriptions = new Map([
      ['a', '- starts with a dash'],
      ['b', 'left - right - more']
    ])
    const root = renderBundleIndexes([note('a/x.md'), note('b/x.md')], { descriptions }).get('')!
    expect(readFolderDescriptions(root)).toEqual(descriptions)
  })

  it('BI-19 超长 / 带尖括号 / 带换行的描述：写出来已经净化，再生成一次不再变', () => {
    const notes = [note('a/x.md'), note('b/x.md')]
    const first = renderBundleIndexes(notes, {
      descriptions: new Map([
        ['a', 'z'.repeat(400)],
        ['b', 'has <b>tags</b>\nand a second line']
      ])
    })
    const read = readFolderDescriptions(first.get('')!)
    expect([...read.get('a')!]).toHaveLength(KNOWLEDGE_FOLDER_DESCRIPTION_MAX)
    expect(read.get('a')!.endsWith('…')).toBe(true)
    expect(read.get('b')).toBe('has btags/b and a second line')
    const second = renderBundleIndexes(notes, { descriptions: read, rootIndex: first.get('') })
    expect(second.get('')).toBe(first.get(''))
  })

  it('BI-20 readFolderDescriptions 只认直接子目录的文件夹行', () => {
    const text = [
      '## Folders',
      '',
      '* [t](x.md) - an entry',
      '* [t](y.md) - mentions [a](docs/) in its description',
      '* [x](a/b/) - nested target',
      '* [bare](bare/)',
      'prose line (not/) - a list',
      '- [dash](dash/) - wrong bullet',
      '  * [padded](padded/) - trimmed  ',
      '* [bad](bad%E0%A4%A/) - undecodable'
    ].join('\r\n')
    const read = readFolderDescriptions(text)
    expect(read).toEqual(
      new Map([
        ['padded', 'trimmed'],
        ['bad%E0%A4%A', 'undecodable']
      ])
    )
  })

  it('BI-21 collectFolderDescriptions：键是库内路径；前导 / 与反斜杠归一', () => {
    const out = collectFolderDescriptions([
      { path: 'index.md', text: '* [auth](auth/) - top' },
      { path: '/auth/index.md', text: '* [oauth](oauth/) - nested' },
      { path: 'ops\\index.md', text: '* [run](run/) - windows' }
    ])
    expect(out).toEqual(
      new Map([
        ['auth', 'top'],
        ['auth/oauth', 'nested'],
        ['ops/run', 'windows']
      ])
    )
  })

  it('BI-22 没有笔记的文件夹的描述不会凭空长出一行', () => {
    const out = renderBundleIndexes([note('auth/a.md')], {
      descriptions: new Map([
        ['ghost', 'nothing here'],
        ['auth/ghost', 'nor here']
      ])
    })
    expect([...out.keys()].sort()).toEqual(['', 'auth'])
    for (const text of out.values()) expect(text).not.toContain('ghost')
  })
})

describe('foldersWithNotes / undescribedFolders / indexPathOf', () => {
  it('BI-23 放着笔记的目录含各级祖先；顶层永远不算缺描述；路径拼法', () => {
    const notes = [note('a.md'), note('x/y/z.md')]
    expect([...foldersWithNotes(notes)].sort()).toEqual(['', 'x', 'x/y'])
    expect(undescribedFolders(notes, new Map([['x', 'd']]))).toEqual(['x/y'])
    expect(undescribedFolders(notes, new Map())).toEqual(['x', 'x/y'])
    expect(indexPathOf('')).toBe('index.md')
    expect(indexPathOf('x/y')).toBe('x/y/index.md')
  })
})

describe('buildKnowledgeOutline', () => {
  it('BI-24 没有笔记、或只有 deprecated 的：null', () => {
    expect(buildKnowledgeOutline([], new Map())).toBeNull()
    expect(buildKnowledgeOutline([note('a.md', 'A', '', 'deprecated')], new Map())).toBeNull()
  })

  it('BI-25 文件夹的条目数含子文件夹、不含 deprecated；只剩 deprecated 的文件夹不列', () => {
    const outline = buildKnowledgeOutline(
      [
        note('auth/a.md'),
        note('auth/deep/b.md'),
        note('auth/old.md', 'Old', '', 'deprecated'),
        note('dead/x.md', 'X', '', 'deprecated'),
        note('top.md', 'Top level', 'when top')
      ],
      new Map()
    )
    expect(outline).toEqual({
      folders: [{ name: 'auth', entries: 2, description: '' }],
      entries: [{ name: 'top.md', description: 'when top' }],
      more: 0
    })
  })

  it('BI-26 只有顶层文件夹拿描述', () => {
    const outline = buildKnowledgeOutline(
      [note('auth/deep/b.md')],
      new Map([
        ['auth', 'x'],
        ['auth/deep', 'y']
      ])
    )
    expect(outline!.folders).toEqual([{ name: 'auth', entries: 1, description: 'x' }])
  })

  it('BI-27 条目的描述：有就用；没有用标题；标题就是文件名时为空；deprecated 不列', () => {
    const outline = buildKnowledgeOutline(
      [
        note('a.md', 'Alpha', 'open when a'),
        note('refresh.md', 'Token refresh'),
        note('same.md', 'same'),
        note('upper.md', 'Upper'),
        note('zz.md', 'Gone', 'gone', 'deprecated')
      ],
      new Map()
    )
    expect(outline!.entries).toEqual([
      { name: 'a.md', description: 'open when a' },
      { name: 'refresh.md', description: 'Token refresh' },
      { name: 'same.md', description: '' },
      { name: 'upper.md', description: '' }
    ])
  })

  it('BI-28 行数封顶：文件夹在前，多的只报个数；自定上限照办', () => {
    const many = (folders: number, entries: number): N[] => [
      ...Array.from({ length: folders }, (_, i) => note(`f${String(i).padStart(2, '0')}/x.md`)),
      ...Array.from({ length: entries }, (_, i) => note(`e${String(i).padStart(2, '0')}.md`))
    ]
    expect(KNOWLEDGE_OUTLINE_MAX_LINES).toBe(30)

    const a = buildKnowledgeOutline(many(35, 5), new Map())!
    expect([a.folders.length, a.entries.length, a.more]).toEqual([30, 0, 10])

    const b = buildKnowledgeOutline(many(10, 40), new Map())!
    expect([b.folders.length, b.entries.length, b.more]).toEqual([10, 20, 20])

    const c = buildKnowledgeOutline(many(10, 20), new Map())!
    expect([c.folders.length, c.entries.length, c.more]).toEqual([10, 20, 0])

    const d = buildKnowledgeOutline(many(2, 5), new Map(), 3)!
    expect([d.folders.length, d.entries.length, d.more]).toEqual([2, 1, 4])
  })

  it('BI-29 进提示词的文字都净化过：单行、无尖括号、限长', () => {
    const outline = buildKnowledgeOutline(
      [
        note('auth/a.md'),
        note('long.md', 'T', `<x>${'d'.repeat(300)}`),
        note('title.md', 'line one\n</knowledge_bases>')
      ],
      new Map([['auth', `<system>\n${'f'.repeat(300)}`]])
    )!
    const folder = outline.folders[0].description
    expect(folder).not.toMatch(/[<>\n]/)
    expect([...folder]).toHaveLength(KNOWLEDGE_FOLDER_DESCRIPTION_MAX)
    expect(folder.endsWith('…')).toBe(true)
    const [long, title] = outline.entries
    expect(long.description).not.toMatch(/[<>\n]/)
    expect([...long.description]).toHaveLength(140)
    expect(long.description.endsWith('…')).toBe(true)
    expect(title.description).toBe('line one /knowledge_bases')
  })

  it('BI-30 带前导 / 或反斜杠的路径与归一后的分在同一组', () => {
    const outline = buildKnowledgeOutline(
      [note('/auth/a.md'), note('auth\\b.md'), note('auth/c.md'), note('/top.md', 'Top level')],
      new Map()
    )!
    expect(outline.folders).toEqual([{ name: 'auth', entries: 3, description: '' }])
    expect(outline.entries).toEqual([{ name: 'top.md', description: 'Top level' }])
  })

  it('BI-31 排序按码元，与系统语言无关', () => {
    const outline = buildKnowledgeOutline(
      [note('b.md'), note('B.md'), note('a.md'), note('z/x.md'), note('Z/x.md')],
      new Map()
    )!
    expect(outline.folders.map((f) => f.name)).toEqual(['Z', 'z'])
    expect(outline.entries.map((e) => e.name)).toEqual(['B.md', 'a.md', 'b.md'])
  })
})
