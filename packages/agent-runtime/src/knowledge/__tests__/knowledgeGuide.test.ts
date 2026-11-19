/**
 * `<knowledge_bases>` 围栏的正文（围栏本身由 createAgent 加）。
 *
 * 它回答的只有两件事：**这条会话手头有哪几个库、什么时候用**。早先这段是静态的、以「这个项目有
 * 一个知识库」开篇，每个项目会话都得付一整段项目库说教；现在主角是用户自己的库，项目库只是
 * 其中一个名字 —— 所以本文件钉的就是「压到列表 + 几句话」这个形状：
 *   - 一个库都没有 → **返回 null**（整段不注入，零成本），不是空串也不是只剩表头的一段；
 *   - 列表逐库一行，顺序原样（选择的顺序就是宿主给的顺序），不排序不去重；
 *   - 正文**不含条目、不含计数、不含任何路径** —— 条目怎么进系统提示词是尚未决定的设计；库目录只有
 *     知识库管理员知道（2026-11-08）：别的 agent 按库名经 `knowledge` 检索、读，要记的内容 `submit`
 *     给管理员，所以围栏不再印目录；
 *   - label 原样印出，渲染器**不认识任何一种库** —— 「只读的内置库」是宿主那一侧的概念，
 *     到这里只剩一个名字加一句 label，所以这里没有、也不该有按名字特判的分支。
 */
import { describe, it, expect } from 'vitest'
import {
  renderKnowledgeGuide,
  withoutKnowledgeOutline,
  type KnowledgeGuideBase
} from '../knowledgeGuide'
import type { KnowledgeOutline } from '../bundleIndex'

const listLines = (text: string): string[] => text.split('\n').filter((l) => l.startsWith('- '))

describe('KG-1..4 知识库围栏正文', () => {
  it('KG-1 一个库都没有 → null（不是空串、不是只有表头的一段）', () => {
    // 空串会被 createAgent 的 trim 判空而同样不注入，但 null 是契约里那一个 —— 「整段不存在」
    expect(renderKnowledgeGuide([])).toBeNull()
  })

  it('KG-2 逐库一行 `- <name> — <label>`；没有 label 只印名字；顺序原样，不排序不去重', () => {
    const text = renderKnowledgeGuide([
      { name: '读书笔记' },
      { name: 'project', label: 'Acme Corp' },
      { name: 'notes', label: 'notes' }
    ])!
    expect(listLines(text)).toEqual(['- 读书笔记', '- project — Acme Corp', '- notes — notes'])

    // 空串 label 与缺省同义：不印一个吊在后面的破折号
    expect(renderKnowledgeGuide([{ name: 'notes', label: '' }])).toContain('- notes\n')
    expect(renderKnowledgeGuide([{ name: 'notes', label: '' }])).not.toContain('notes —')

    // 顺序即宿主给的顺序（= 用户选择的顺序）；重名也不合并 —— 归一是解析那一侧的事
    const raw = renderKnowledgeGuide([{ name: 'b' }, { name: 'a' }, { name: 'b' }])!
    expect(listLines(raw)).toEqual(['- b', '- a', '- b'])
  })

  it('KG-3 正文只有清单 + 几句话：给入口不给内容', () => {
    const text = renderKnowledgeGuide([{ name: 'notes' }, { name: 'project', label: 'Acme' }])!

    // 入口：用哪个工具、什么时候搜、什么值得交、交了说一句
    expect(text).toContain('`search`')
    expect(text).toContain('`knowledge` tool')
    expect(text).toContain(
      'Submit only what a later session will need and cannot read off the repository'
    )
    // 2026-11-12 收紧：做完的事不是知识、多数任务没有可交的、被删减或否决之后不再交一次
    expect(text).toContain('Finished work is not knowledge')
    expect(text).toContain('Most tasks leave nothing to submit.')
    expect(text).toContain('do not submit it again')
    expect(text.replace(/\n/g, ' ')).toContain('Say in one line what you submitted.')
    expect(text).not.toContain('`create`')
    // 「留空 base 搜全部」是怎么用，归工具描述（KT-12 钉在那边），围栏不再重复付一遍
    expect(text).not.toContain('`base` out')

    // 不给内容：没有条目文件名、没有条目计数、没有任何路径
    expect(text).not.toContain('.md')
    expect(text).not.toContain('/')
    expect(/\d/.test(text), `no counts in: ${text}`).toBe(false)

    // 不再以项目库开篇 —— 它只是清单里可能有的一个名字
    expect(text).not.toContain('Each project has')
    expect(text.startsWith('Knowledge bases this session works with')).toBe(true)
  })

  it('KG-4 label 原样印在 `- <名> — <label>` 里，顺序原样；渲染器不认识「内置」这回事 —— 宿主给什么印什么', () => {
    // 一句完全普通的 label：它恰好在说「这个库是只读的说明书」，但对渲染器而言就是一串字
    const LABEL = 'read-only reference: how ShuviX files are written and where they live'
    const lines = (bases: Parameters<typeof renderKnowledgeGuide>[0]): string[] =>
      listLines(renderKnowledgeGuide(bases)!)

    // 带 label 的排在最前、没有 label 的夹在中间：字母序、「有 label 的靠后」之类的重排都会露馅
    expect(
      lines([
        { name: 'handbook', label: LABEL },
        { name: '读书笔记' },
        { name: 'project', label: 'Acme Corp' }
      ])
    ).toEqual([`- handbook — ${LABEL}`, '- 读书笔记', '- project — Acme Corp'])

    // 同一句 label 换个名字，行只差名字那一段 —— 没有按名字走的分支
    expect(lines([{ name: 'shuvix', label: LABEL }])).toEqual([`- shuvix — ${LABEL}`])
    // 反过来也一样：名字叫 shuvix 而宿主没给 label，就只有一个光名字，不自己补一句「内置 / 只读」
    expect(lines([{ name: 'shuvix' }])).toEqual(['- shuvix'])
    expect(renderKnowledgeGuide([{ name: 'shuvix' }])).not.toContain('read-only')
  })
})

/**
 * 不印库目录（2026-11-08）：库目录只有知识库管理员知道。`KnowledgeGuideBase` 上没有 `dir` 了；宿主那一侧
 * 若还带着旧字段塞进来，渲染器也不看它 —— 列表行恰为 `- <name>` / `- <name> — <label>`。
 */
describe('KG-5..7 不印库目录', () => {
  it('KG-5 KnowledgeGuideBase 恰为 name / label / readonly / note / outline —— 没有 dir', () => {
    const keys: Record<keyof KnowledgeGuideBase, true> = {
      name: true,
      label: true,
      readonly: true,
      note: true,
      outline: true
    }
    expect(Object.keys(keys).sort()).toEqual(['label', 'name', 'note', 'outline', 'readonly'])
  })

  it('KG-6 宿主仍塞进一个 dir（旧调用方）：不印，行里不多出一个 ` — `；整段没有任何路径', () => {
    const stale = [
      { name: 'project', label: 'Acme', dir: '/kb/projects/0199a2b3-7c4d-7e5f-8a9b-0c1d2e3f4a5b' },
      { name: 'notes', dir: '/Users/me/.shuvix/knowledge/notes' },
      { name: '读书笔记', label: '', dir: 'C:\\Users\\张 三\\.shuvix\\knowledge\\读书笔记' }
    ] as unknown as KnowledgeGuideBase[]
    const text = renderKnowledgeGuide(stale)!
    expect(listLines(text)).toEqual(['- project — Acme', '- notes', '- 读书笔记'])
    for (const piece of ['/kb/', '.shuvix', 'C:\\', '0199a2b3', '\\']) {
      expect(text, piece).not.toContain(piece)
    }
    expect(text).not.toContain('/')
  })

  it('KG-7 正文讲 submit（交给库、不讲写进目录）：没有 write / directory / record 的旧说法', () => {
    const text = renderKnowledgeGuide([{ name: 'notes' }])!
    const body = text
      .split('\n')
      .filter((l) => !l.startsWith('- '))
      .join('\n')
    expect(body).toContain('to the base the subject belongs to')
    expect(body).toContain('submit')
    for (const phrase of [
      '`write`',
      'write',
      'directory',
      'Record what',
      'and submit it',
      'what you\nrecorded',
      'recorded'
    ]) {
      expect(body, phrase).not.toContain(phrase)
    }
  })
})

/**
 * 只读的库（2026-11-02）：说明书默认启用之后，「搜了再干、交上去」那段不再是每条会话都该付的 —— 手头全是只读的库时
 * 交不了，而说明书也不是每件事都该先搜的。库自己的说明（`note`，宿主给）印在通用说明之后，什么时候来这个库由它说。
 */
describe('KG-R 只读的库与库自己的说明', () => {
  const NOTE = 'When a task touches this manual, read it first.'
  const paragraphsOf = (text: string): string[] => text.split('\n\n')
  /** 通用说明那一段（靠它教的两个动作认：搜索、提交） */
  const isRecordParagraph = (p: string): boolean => p.includes('`search`') && /submit/i.test(p)

  it('KG-R1 全是只读的库：没有搜索 / 提交那段，清单与说明照印', () => {
    const text = renderKnowledgeGuide([
      { name: 'shuvix', label: 'manual', readonly: true, note: NOTE }
    ])!

    expect(paragraphsOf(text).filter(isRecordParagraph)).toEqual([])
    expect(text).not.toContain('`search`')
    expect(text).not.toMatch(/submit/i)
    expect(listLines(text)).toEqual(['- shuvix — manual'])
    expect(paragraphsOf(text).at(-1)).toBe(NOTE)
  })

  it('KG-R2 一个可写加一个只读：那段只出现一次，说明排在它之后；只有可写的库时没有说明这一段', () => {
    const text = renderKnowledgeGuide([
      { name: 'shuvix', label: 'manual', readonly: true, note: NOTE },
      { name: 'notes' }
    ])!
    const paragraphs = paragraphsOf(text)

    expect(paragraphs.filter(isRecordParagraph)).toHaveLength(1)
    expect(paragraphs.findIndex(isRecordParagraph)).toBeLessThan(paragraphs.indexOf(NOTE))
    expect(paragraphs).toHaveLength(3)

    // 反过来：没有库带说明，就只有清单与通用说明两段
    expect(paragraphsOf(renderKnowledgeGuide([{ name: 'notes' }])!)).toHaveLength(2)
  })
})

/**
 * 顶层简讯（2026-11-19）：项目库与 bot 库那一行下面缩进两格印顶层的文件夹与条目；有简讯时清单后面多一段说明。
 * 简讯是建 agent 那一刻的快照 —— `withoutKnowledgeOutline` 摘掉它之后，与不带简讯渲染出来的一字不差
 * （durable lock 据此判「只是库里多了一条」不算提示词过期）。
 */
describe('KG-O1..O6 顶层简讯', () => {
  const OUTLINE: KnowledgeOutline = {
    folders: [
      { name: 'auth', entries: 3, description: 'Sign-in and tokens' },
      { name: 'misc', entries: 1, description: '' }
    ],
    entries: [
      { name: 'a.md', description: 'Open when a' },
      { name: 'b.md', description: '' }
    ],
    more: 0
  }
  const OTHER: KnowledgeOutline = {
    folders: [{ name: 'release', entries: 9, description: 'Shipping' }],
    entries: [{ name: 'z.md', description: 'Changed' }],
    more: 2
  }
  const indented = (text: string): string[] => text.split('\n').filter((l) => l.startsWith('  '))
  const isOutlineParagraph = (p: string): boolean => p.startsWith('The indented lines under a base')

  it('KG-O1 库那一行下面缩进两格：文件夹在前（单复数、没描述不带破折号），条目在后', () => {
    const text = renderKnowledgeGuide([{ name: 'project', label: 'Acme', outline: OUTLINE }])!
    const lines = text.split('\n')
    const at = lines.indexOf('- project — Acme')
    expect(lines.slice(at + 1, at + 5)).toEqual([
      '  auth/ (3 entries) — Sign-in and tokens',
      '  misc/ (1 entry)',
      '  /a.md — Open when a',
      '  /b.md'
    ])
    expect(indented(text)).toHaveLength(4)
  })

  it('KG-O2 more > 0 时最后一行报没列出来的个数；为 0 不印', () => {
    const text = renderKnowledgeGuide([{ name: 'project', outline: OTHER }])!
    expect(indented(text).at(-1)).toBe('  … and 2 more at the top level')
    expect(renderKnowledgeGuide([{ name: 'project', outline: OUTLINE }])).not.toContain('more at')
  })

  it('KG-O3 只有带简讯的库底下有缩进行；说明那一段恰一次，紧跟清单、排在通用说明之前', () => {
    const text = renderKnowledgeGuide([
      { name: 'project', label: 'Acme', outline: OUTLINE },
      { name: 'notes' },
      { name: 'shuvix', label: 'manual', readonly: true }
    ])!
    const lines = text.split('\n')
    expect(lines[lines.indexOf('- notes') + 1]).toBe('- shuvix — manual')
    const paragraphs = text.split('\n\n')
    expect(paragraphs.filter(isOutlineParagraph)).toHaveLength(1)
    expect(isOutlineParagraph(paragraphs[1])).toBe(true)
    expect(paragraphs[2]).toContain('`search` them')
  })

  it('KG-O4 没有库带简讯（缺省 / null）：与加这个功能之前一字不差', () => {
    const plain = renderKnowledgeGuide([{ name: 'project', label: 'Acme' }, { name: 'notes' }])!
    expect(
      renderKnowledgeGuide([{ name: 'project', label: 'Acme', outline: null }, { name: 'notes' }])
    ).toBe(plain)
    expect(plain.split('\n\n').filter(isOutlineParagraph)).toEqual([])
    expect(indented(plain)).toEqual([])
  })

  it('KG-O5 withoutKnowledgeOutline：摘掉简讯 = 不带简讯渲染；两份不同的简讯摘完相等', () => {
    const bases = (project?: KnowledgeOutline, bot?: KnowledgeOutline): KnowledgeGuideBase[] => [
      { name: 'project', label: 'Acme', ...(project ? { outline: project } : {}) },
      { name: 'bot', label: 'Scout', ...(bot ? { outline: bot } : {}) },
      { name: 'shuvix', label: 'manual', readonly: true, note: 'Read the manual first.' }
    ]
    const plain = renderKnowledgeGuide(bases())!
    expect(withoutKnowledgeOutline(renderKnowledgeGuide(bases(OUTLINE))!)).toBe(plain)
    expect(withoutKnowledgeOutline(renderKnowledgeGuide(bases(OTHER))!)).toBe(plain)
    expect(withoutKnowledgeOutline(renderKnowledgeGuide(bases(OUTLINE, OTHER))!)).toBe(plain)
    // 围栏包着也一样（lock 比的是带围栏的段落文本）
    const fenced = (t: string): string => `<knowledge_bases>\n${t}\n</knowledge_bases>`
    expect(withoutKnowledgeOutline(fenced(renderKnowledgeGuide(bases(OUTLINE))!))).toBe(
      fenced(plain)
    )
  })

  it('KG-O6 不带简讯的原样；库的集合 / 标签 / 说明 / 只读变了，摘完仍然不同', () => {
    const base: KnowledgeGuideBase[] = [
      { name: 'project', label: 'Acme', outline: OUTLINE },
      { name: 'shuvix', label: 'manual', readonly: true, note: 'Note A.' }
    ]
    const plain = renderKnowledgeGuide([{ name: 'project', label: 'Acme' }])!
    expect(withoutKnowledgeOutline(plain)).toBe(plain)

    const stripped = (bases: KnowledgeGuideBase[]): string =>
      withoutKnowledgeOutline(renderKnowledgeGuide(bases)!)
    const was = stripped(base)
    const variants: KnowledgeGuideBase[][] = [
      [...base, { name: 'notes' }],
      [{ ...base[0], label: 'Renamed', outline: OTHER }, base[1]],
      [base[0], { ...base[1], note: 'Note B.' }],
      [{ ...base[0], readonly: true }, base[1]]
    ]
    for (const variant of variants) expect(stripped(variant)).not.toBe(was)
  })
})
