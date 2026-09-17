/**
 * search —— 一个 bundle 的检索（okf-minisearch）。钉的是中文分词那次修复：MiniSearch 默认只按
 * 空白与标点切词，中文两个标点之间的一整段曾是一个词，段中间的词（「令牌」）一条都搜不到。
 * 这里走「扫描 → 建索引 → 检索」的真实链路，不碰内部的分词函数。
 *
 * 读宽（设计附录 L）：库里每条笔记都要搜得到 —— 没有 frontmatter / 没有 type / 别家标记 / YAML 写坏的
 * 普通笔记、用户手写的 index.md / log.md，以及 okf-minisearch 拒收原文的合规条目；ShuviX 早先生成的
 * index / log 与 deprecated 条目不进结果。
 *
 * 内置库（`builtin/<库名>`）与另两种库共用这条链路，只是磁盘上多一层语言目录：检索面是**当前界面语言**
 * 那一版，别的语言不属于这个 bundle。索引按 bundle id 缓存，切语言不改 id —— 所以换的是
 * `refreshBuiltinKnowledge()`，不是让索引自己发现。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync } from 'node:fs'
import { buildRootIndexMd } from '@equationalapplications/core-okf'

const state = vi.hoisted(() => ({ root: '' }))
/** 界面语言：内置库解析到哪个语言目录只由它决定（见下面的 i18next 桩） */
const i18n = vi.hoisted(() => ({ language: 'en' }))

vi.mock('../../../utils/paths', () => ({
  getShuvixKnowledgeRootDir: () => state.root,
  getUserKnowledgeRootDir: () => `${state.root}-user`,
  // 内置库根替身：缺省不存在（于是「没有内置库」是缺省）；要有内置库的用例自己 seedBuiltin 往里种
  getBuiltinKnowledgeDir: () => `${state.root}-builtin`
}))
// builtinLanguageDir 直接读 i18next 单例：不桩的话 `i18next.language` 是 undefined、恒走 'en' 回落，
// 切语言那条就假绿（怎么切都还在 en 那一版上）
vi.mock('i18next', () => ({
  default: {
    get language() {
      return i18n.language
    },
    t: (key: string) => key
  }
}))
/** 建索引时被跳过的笔记只在日志里留痕：`SR-12` 要直接钉「没有任何一篇被跳过」 */
const logs = vi.hoisted(() => ({ warnings: [] as string[] }))
vi.mock('../../../logger', () => ({
  createLogger: () => ({
    info: () => {},
    warn: (msg: string) => {
      logs.warnings.push(msg)
    },
    error: () => {}
  })
}))

import { refreshBuiltinKnowledge } from '../changes'
import { invalidateKnowledgeScan } from '../scan'
import { invalidateKnowledgeSearch, searchBundle } from '../search'
import {
  BUNDLE,
  builtinRootOf,
  makeTempRoot,
  seedBuiltinConcept,
  seedConcept,
  seedFile
} from './fixture'

let root: string

beforeEach(() => {
  root = makeTempRoot()
  state.root = root
  i18n.language = 'en'
  logs.warnings.length = 0
  invalidateKnowledgeScan()
  invalidateKnowledgeSearch()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(builtinRootOf(root), { recursive: true, force: true })
})

const seed = (): void => {
  seedConcept(
    root,
    `${BUNDLE}/token.md`,
    ['type: Memory', 'title: 鉴权与令牌刷新', 'description: 改动登录时看', 'status: stable'],
    '## 刷新流程\n\n访问令牌过期后，用长效凭证换一个新的访问令牌。'
  )
  seedConcept(
    root,
    `${BUNDLE}/pipeline.md`,
    ['type: Memory', 'title: Build pipeline', 'description: before merging', 'status: stable'],
    'The pipeline runs the full end-to-end suite before merge.'
  )
  seedConcept(
    root,
    `${BUNDLE}/old.md`,
    ['type: Memory', 'title: 旧的令牌方案', 'description: 已废弃', 'status: deprecated'],
    '以前用长期令牌。'
  )
}

describe('searchBundle', () => {
  it('SR-1 中文段落中间的词能搜到（默认分词器会把整段当成一个词）', async () => {
    seed()
    for (const q of ['令牌', '刷新', '访问令牌']) {
      const paths = (await searchBundle(BUNDLE, q, { limit: 10 })).map((h) => h.path)
      expect(paths, q).toContain('token.md')
    }
  })

  it('SR-2 英文与整段标题照旧能搜到；deprecated 不出现在结果里', async () => {
    seed()
    expect((await searchBundle(BUNDLE, 'pipeline', { limit: 10 })).map((h) => h.path)).toEqual([
      'pipeline.md'
    ])
    expect(
      (await searchBundle(BUNDLE, '鉴权与令牌刷新', { limit: 10 })).map((h) => h.path)
    ).toContain('token.md')
    const paths = (await searchBundle(BUNDLE, '令牌', { limit: 10 })).map((h) => h.path)
    expect(paths).not.toContain('old.md')
  })

  it('SR-3 正文标题能命中；回包只有门面（无正文片段，也不残留分词用的词界标记）', async () => {
    seed()
    const [hit] = await searchBundle(BUNDLE, '刷新流程', { limit: 1 })
    // 命中的每个字段都取自笔记本身，不是索引 —— 所以既没有正文片段，也没有词界标记
    expect(hit).toEqual({
      path: 'token.md',
      title: '鉴权与令牌刷新',
      description: '改动登录时看',
      status: 'stable'
    })
    expect(JSON.stringify(hit)).not.toMatch(/\u200A/)
  })

  /**
   * 本轮（2026-09-17）的裁决：全文入索引误差太大 —— 一句常见的话就能把半个库拉回来，每条命中还拖一段
   * 正文。索引改成只收门面（title / description / tags / type）+ 正文标题行；正文里的散文靠 grep 找。
   */
  it('SR-3b 正文散文不进索引：只在散文里出现的词一条都搜不到，标题行照常命中', async () => {
    seed()
    expect(await pathsOf('长效凭证')).toEqual([])
    expect(await pathsOf('end-to-end')).toEqual([])
    expect(await pathsOf('刷新流程')).toEqual(['token.md'])
    // 门面照常：标题 / 描述 / 标签
    expect(await pathsOf('改动登录时看')).toEqual(['token.md'])
  })
})

/** 检索结果压成 `[path, title]`：一眼对照「恰好命中哪个文件、标题是什么」 */
const hitsOf = async (q: string): Promise<[string, string][]> =>
  (await searchBundle(BUNDLE, q, { limit: 10 })).map((h) => [h.path, h.title])

const pathsOf = async (q: string): Promise<string[]> =>
  (await searchBundle(BUNDLE, q, { limit: 10 })).map((h) => h.path)

const BOM = String.fromCharCode(0xfeff)

describe('searchBundle — 读宽：每条笔记都进索引', () => {
  it('SR-4 库里的普通笔记与用户手写的 index.md / log.md 都能检索到，检索不抛错', async () => {
    seedConcept(
      root,
      `${BUNDLE}/a.md`,
      ['type: Memory', 'title: A', 'description: da', 'status: stable'],
      '## zebra\n'
    )
    // 标记词一律落在**标题行**上（索引的正文面只有标题）；散文照写，用来顺带钉住它不可搜
    seedFile(root, `${BUNDLE}/plain.md`, '# Plain note\n\n## quokka\n\nlives here\n')
    seedFile(
      root,
      `${BUNDLE}/untyped.md`,
      '---\ntitle: Untyped\ndescription: du\n---\n\n## platypus\n'
    )
    seedFile(root, `${BUNDLE}/foreign.md`, '---\nshuvix: agent v1\nname: a\n---\n\n## meerkat\n')
    seedFile(root, `${BUNDLE}/broken.md`, '---\ntitle: [x\n---\n\n## narwhal\n')
    seedFile(root, `${BUNDLE}/index.md`, '# Home\n\n## wombat\n')
    seedFile(root, `${BUNDLE}/sub/log.md`, '# Diary\n\n## koala\n')

    // 保留名下的笔记以隐藏别名入索引，结果里必须换回真实路径
    const table: [string, string, string][] = [
      ['quokka', 'plain.md', 'Plain note'],
      ['platypus', 'untyped.md', 'Untyped'],
      ['meerkat', 'foreign.md', 'foreign'],
      ['narwhal', 'broken.md', 'broken'],
      ['wombat', 'index.md', 'Home'],
      ['koala', 'sub/log.md', 'Diary']
    ]
    for (const [q, path, title] of table) {
      expect(await hitsOf(q), q).toEqual([[path, title]])
    }
    const [untyped] = await searchBundle(BUNDLE, 'platypus', { limit: 10 })
    expect(untyped.description).toBe('du')
    // 合规条目不受连累
    expect(await pathsOf('zebra')).toEqual(['a.md'])
    // 散文（`lives here`）不在索引里
    expect(await pathsOf('lives')).toEqual([])
  })

  it('SR-5 生成形状的 index.md / log.md 不进结果；deprecated 条目照旧滤掉，没有 status 的普通笔记不被一并刷掉', async () => {
    seedConcept(root, `${BUNDLE}/a.md`, [
      'type: Memory',
      'title: Token refresh',
      'description: da',
      'status: stable'
    ])
    // 与当年投影同一个构建器
    seedFile(
      root,
      `${BUNDLE}/index.md`,
      buildRootIndexMd('0.2', [
        {
          heading: 'Entries',
          entries: [{ path: 'a.md', title: 'Token refresh', description: 'kiwi' }]
        }
      ])
    )
    seedFile(
      root,
      `${BUNDLE}/log.md`,
      '## 2026-09-09\n\n- **Creation** /a.md — Token refresh · by shuvix-work/gpt-5\n'
    )
    seedConcept(
      root,
      `${BUNDLE}/old.md`,
      ['type: Memory', 'title: Old', 'description: dold', 'status: deprecated'],
      '## kiwi\n'
    )
    seedFile(root, `${BUNDLE}/note.md`, '## kiwi\n\non the windowsill\n')

    expect(await pathsOf('kiwi')).toEqual(['note.md'])
    // `Creation` 只出现在生成的 log.md 里
    expect(await pathsOf('Creation')).not.toContain('log.md')
    expect(await pathsOf('Creation')).toEqual([])
  })

  it('SR-6 okf-minisearch 拒收原文的合规条目照样搜得到，也不连累别的笔记', async () => {
    // 开头多一个 BOM
    seedFile(root, `${BUNDLE}/bom.md`, `${BOM}---\ntype: Memory\ntitle: Bom\n---\n\n## alpaca\n`)
    // frontmatter 之前有空行
    seedFile(root, `${BUNDLE}/lead.md`, '\n\n---\ntype: Memory\ntitle: Lead\n---\n\n## bison\n')
    // 闭合线带一个尾随空格
    seedFile(root, `${BUNDLE}/ts.md`, '---\ntype: Memory\ntitle: TS\n--- \n\n## coyote\n')
    seedFile(root, `${BUNDLE}/plain.md`, '# P\n\n## dingo\n')

    const table: [string, string, string][] = [
      ['alpaca', 'bom.md', 'Bom'],
      ['bison', 'lead.md', 'Lead'],
      ['coyote', 'ts.md', 'TS'],
      ['dingo', 'plain.md', 'P']
    ]
    for (const [q, path, title] of table) {
      expect(await hitsOf(q), q).toEqual([[path, title]])
    }
  })

  it('SR-7 普通笔记入索引时不带可检索的 type：搜 type 名只命中真有这个 type 的条目', async () => {
    seedConcept(root, `${BUNDLE}/a.md`, ['type: Memory', 'title: Alpha'], '## zebra\n')
    seedFile(root, `${BUNDLE}/plain.md`, '# Plain\n\n## quokka\n')

    expect(await pathsOf('memory')).toEqual(['a.md'])
    expect(await pathsOf('note')).toEqual([])
  })
})

/**
 * 内置库：检索面恰是当前界面语言那一版。同一条 id（`builtin/<库名>/<路径>`）在不同语言下指向不同的文件，
 * 而索引是按 bundle id 缓存的 —— 语言变了 id 没变，只能由 `refreshBuiltinKnowledge()` 来换。
 */
describe('searchBundle — 内置库按界面语言取那一版', () => {
  const BUILTIN_BASE = 'shuvix'
  const BUILTIN = `builtin/${BUILTIN_BASE}`

  /** 同一条 id 的两版：各带一个另一版没有的独有词 */
  const seedBothLanguages = (): void => {
    seedBuiltinConcept(
      root,
      `${BUILTIN_BASE}/en/guide.md`,
      ['type: Guide', 'title: File formats', 'description: how ShuviX writes files'],
      '## The platypus section\n\nIt explains frontmatter.'
    )
    seedBuiltinConcept(
      root,
      `${BUILTIN_BASE}/zh/guide.md`,
      ['type: Guide', 'title: 文件格式', 'description: ShuviX 怎么写文件'],
      '## axolotl 这一节\n\n讲 frontmatter。'
    )
  }

  const builtinHits = async (q: string): Promise<[string, string][]> =>
    (await searchBundle(BUILTIN, q, { limit: 10 })).map((h) => [h.path, h.title])

  it('SR-8 内置库能检索，只命中当前语言那一版：另一版独有的词搜不到', async () => {
    seedBothLanguages()

    expect(await builtinHits('platypus')).toEqual([['guide.md', 'File formats']])
    // zh 那一版不属于这个 bundle：它独有的词一条都搜不出来
    expect(await builtinHits('axolotl')).toEqual([])
    // 两版共有的词（这里在描述里）也只命中一条（不是同一条 id 的两份）
    expect(await builtinHits('ShuviX')).toEqual([['guide.md', 'File formats']])
  })

  it('SR-9 切语言 + refreshBuiltinKnowledge：同一个查询换成新语言那一版的命中', async () => {
    seedBothLanguages()
    expect(await builtinHits('platypus')).toEqual([['guide.md', 'File formats']])

    // 索引按 bundle id 缓存，而语言不进 id：只切语言不 refresh，命中的还是建索引时那一版
    i18n.language = 'zh-CN'
    expect(await builtinHits('axolotl')).toEqual([])
    expect(await builtinHits('platypus')).toEqual([['guide.md', 'File formats']])

    refreshBuiltinKnowledge()

    expect(await builtinHits('axolotl')).toEqual([['guide.md', '文件格式']])
    expect(await builtinHits('platypus')).toEqual([])
  })
})

/**
 * SR-10..SR-25 —— 2026-09-17 那次裁决（设计附录 Q）的检索面对照表，走的还是「扫描 → 建索引 → 检索」
 * 那条真链路。
 *
 * **索引里有什么**：`title` / `description` / `tags` / `type` / `resource` / `sources`，加上正文里的
 * **标题行**。散文一概不进 —— 全文入索引时一句常见的话就能把半个库拉回来，而每条命中还拖一段正文。
 * 定位符（`resource` / `sources`）是**元数据不是散文**，所以留在索引里：「哪一篇引了 conceptFile.ts」
 * 得搜得到（okf-minisearch 给 `resource` 的权重是全字段最高）。
 */
describe('searchBundle —— 索引面（门面 + 正文标题行）', () => {
  it('SR-10 门面各字段都能单独命中：title / description / tags / type / 正文标题行', async () => {
    seedConcept(
      root,
      `${BUNDLE}/face.md`,
      [
        'type: Runbook',
        'title: Zebracorn',
        'description: about the quokka',
        'tags: [platypus, narwhal]'
      ],
      '## Marmoset section\n\nplain prose that must stay out\n'
    )
    // 每个词只出现在一个字段里 —— 命中即证明那个字段在索引面上
    for (const q of ['Zebracorn', 'quokka', 'platypus', 'narwhal', 'Runbook', 'Marmoset']) {
      expect(await pathsOf(q), q).toEqual(['face.md'])
    }
  })

  it('SR-11 定位符（resource / sources）在索引面上；散文、围栏内文字、generated / stale_after 不在', async () => {
    seedConcept(
      root,
      `${BUNDLE}/loc.md`,
      [
        'type: Memory',
        'title: Locators',
        'description: dl',
        'resource: https://example.com/aardvark',
        'sources:',
        '  - resource: /abs/path/capybara.ts',
        '    title: the capybara helper',
        '  - resource: https://example.com/gerenuk'
      ],
      '## heading\n\nprose\n'
    )
    seedConcept(
      root,
      `${BUNDLE}/neg.md`,
      [
        'type: Memory',
        'title: Negatives',
        'description: dn',
        'stale_after: 2031-12-31',
        'generated: { by: "shuvix-work/wombatmodel", at: "2026-09-09T08:12:03.000Z" }'
      ],
      '## heading two\n\nprose about the dingo\n\n```\nfenced kakapo text\n```\n'
    )

    // 正向：定位符是元数据，本轮把散文赶出索引的理由盖不到它们
    for (const q of ['aardvark', 'capybara', 'gerenuk']) {
      expect(await pathsOf(q), q).toEqual(['loc.md'])
    }
    // 反向：散文、围栏里的文字、宿主的章与过期日期一个都搜不到
    for (const q of ['dingo', 'kakapo', 'wombatmodel', '2031-12-31']) {
      expect(await pathsOf(q), q).toEqual([])
    }
  })

  it('SR-12 正文一个标题都没有的笔记：不被跳过、不发警告，门面照常命中', async () => {
    seedConcept(
      root,
      `${BUNDLE}/nohead.md`,
      ['type: Memory', 'title: Axolotl', 'description: dn'],
      'just prose, not a single heading in here\n'
    )
    seedFile(root, `${BUNDLE}/bare.md`, 'no frontmatter and no headings either\n')

    expect(await pathsOf('Axolotl')).toEqual(['nohead.md'])
    expect(await pathsOf('bare')).toEqual(['bare.md'])
    // 「被 okf-minisearch 拒了」只在日志里留痕：空正文不该走到那一步
    expect(logs.warnings.filter((w) => w.includes('left out of'))).toEqual([])
  })

  it('SR-13 一篇全是标题的笔记：各级标题都能命中；同一个词出现在多个标题里仍只回一条', async () => {
    seedFile(
      root,
      `${BUNDLE}/all.md`,
      [
        '# Gazelle one',
        '## Gazelle two',
        '### Gazelle three',
        '#### Ibex four',
        '##### Ibex five',
        '###### Ibex six'
      ].join('\n\n')
    )

    for (const q of ['one', 'two', 'three', 'four', 'five', 'six']) {
      expect(await pathsOf(q), q).toEqual(['all.md'])
    }
    // 库按文档去重：三个标题里都有 Gazelle，回来的仍是一条
    expect(await pathsOf('Gazelle')).toEqual(['all.md'])
    expect(await pathsOf('Ibex')).toEqual(['all.md'])
  })

  it('SR-14 嵌套标题：搜父与搜子都命中同一个文件，且各只有一条', async () => {
    seedFile(root, `${BUNDLE}/nest.md`, '# Okapi\n\n## Marmot parent\n\n### Lemur child\n\nprose\n')

    expect(await pathsOf('Marmot')).toEqual(['nest.md'])
    expect(await pathsOf('Lemur')).toEqual(['nest.md'])
    // 父子同时命中也还是一条
    expect(await pathsOf('Marmot Lemur')).toEqual(['nest.md'])
  })

  it('SR-15 标题里的 markdown：链接的可见文字 / 行内代码 / 强调可搜，链接的 URL 不可搜', async () => {
    seedFile(
      root,
      `${BUNDLE}/md.md`,
      [
        '# Title',
        '## See [the tapir docs](https://example.com/vicuna)',
        '### Use `serval` here',
        '#### **Caracal** and _Margay_'
      ].join('\n\n')
    )

    for (const q of ['tapir', 'serval', 'Caracal', 'Margay']) {
      expect(await pathsOf(q), q).toEqual(['md.md'])
    }
    // 标题行原样喂给索引，但 okf-minisearch 建 headingPath 时剥掉链接语法 —— URL 那一半进不去
    for (const q of ['vicuna', 'example.com', 'https']) {
      expect(await pathsOf(q), q).toEqual([])
    }
  })

  it('SR-16 回包形状：一条命中恰四个键，没有 snippet / 分数 / 词界标记泄漏', async () => {
    seedConcept(
      root,
      `${BUNDLE}/shape.md`,
      ['type: Memory', 'title: 形状', 'description: 描述一行', 'status: draft'],
      '## 小节标题\n\n散文\n'
    )
    const [hit] = await searchBundle(BUNDLE, '小节标题', { limit: 10 })
    expect(Object.keys(hit).sort()).toEqual(['description', 'path', 'status', 'title'])
    expect(hit).toEqual({
      path: 'shape.md',
      title: '形状',
      description: '描述一行',
      status: 'draft'
    })
    // 分词用的词界标记只活在喂给索引的那份文本里
    expect(JSON.stringify(hit)).not.toMatch(/\u200A/)
  })

  it('SR-17 围栏里的标题不进索引（真链路对照 CF-17）', async () => {
    seedFile(
      root,
      `${BUNDLE}/fence.md`,
      '# Fencepost\n\n```\n## Hidden gerenuk\n```\n\n## Visible bongo\n'
    )

    expect(await pathsOf('bongo')).toEqual(['fence.md'])
    expect(await pathsOf('Fencepost')).toEqual(['fence.md'])
    expect(await pathsOf('gerenuk')).toEqual([])
  })

  /**
   * SR-18 **已知取舍**（设计附录 Q 补充）：frontmatter 开了 `---` 却没闭合时整篇当正文 —— 于是里面的
   * `# 注释` 成了可检索的标题行，而 `title: …` 那一行只是散文、搜不到。标题那一半是旧行为，
   * 可检索这一半是本轮新增。
   */
  it('SR-18 未闭合的 frontmatter：里面的 `#` 注释成为可检索标题，`title:` 那一行仍是散文', async () => {
    seedFile(
      root,
      `${BUNDLE}/open.md`,
      '---\ntitle: Oryx\n## a yaml comment about the saiga\nprose about the numbat\n'
    )

    // 二级注释行 —— 不当一级标题用，免得它顺带成为笔记标题
    expect(await hitsOf('saiga')).toEqual([['open.md', 'open']])
    expect(await pathsOf('Oryx')).toEqual([])
    expect(await pathsOf('numbat')).toEqual([])
  })

  it('SR-19 多词查询是 OR：只含其中一个词的两条都回来', async () => {
    seedConcept(root, `${BUNDLE}/a.md`, ['type: Memory', 'title: Alpaca only', 'description: da'])
    seedConcept(root, `${BUNDLE}/b.md`, ['type: Memory', 'title: Bison only', 'description: db'])
    seedConcept(root, `${BUNDLE}/c.md`, ['type: Memory', 'title: Coyote only', 'description: dc'])

    expect((await pathsOf('alpaca bison')).sort()).toEqual(['a.md', 'b.md'])
  })

  it('SR-20 limit 截断：五条都命中时 limit: 2 恰回两条，且是双重命中的那两条', async () => {
    // 五条标题里都有 kudu；其中两条在描述与标签里再命中一次 —— 名次可预期，分数不钉
    for (const name of ['one', 'two', 'three']) {
      seedConcept(root, `${BUNDLE}/${name}.md`, [
        'type: Memory',
        `title: kudu ${name}`,
        `description: d${name}`
      ])
    }
    for (const name of ['top1', 'top2']) {
      seedConcept(root, `${BUNDLE}/${name}.md`, [
        'type: Memory',
        `title: kudu ${name}`,
        'description: kudu again',
        'tags: [kudu]'
      ])
    }

    expect((await pathsOf('kudu')).sort()).toEqual([
      'one.md',
      'three.md',
      'top1.md',
      'top2.md',
      'two.md'
    ])
    const capped = await searchBundle(BUNDLE, 'kudu', { limit: 2 })
    expect(capped.map((h) => h.path).sort()).toEqual(['top1.md', 'top2.md'])
  })

  it('SR-21 中日文的标题行 / 标签 / 描述都分词入索引', async () => {
    seedConcept(
      root,
      `${BUNDLE}/cjk.md`,
      [
        'type: Memory',
        'title: 中文标题',
        'description: 这是一条关于缓存击穿的描述',
        'tags: [数据库连接池, 索引重建]'
      ],
      '## 会话恢复的判定\n\n这一段散文不进索引\n'
    )
    seedFile(root, `${BUNDLE}/jp.md`, '# ひらがなの見出し\n\n## カタカナのミダシ\n')

    // 段中间的词（默认分词器会把整段当一个词，中文因此曾经一条都搜不到）
    for (const q of ['缓存', '击穿', '判定', '恢复', '数据库连接池', '索引重建']) {
      expect(await pathsOf(q), q).toEqual(['cjk.md'])
    }
    for (const q of ['ひらがな', 'カタカナ']) {
      expect(await pathsOf(q), q).toEqual(['jp.md'])
    }
    // 散文那一半照旧不在索引里
    expect(await pathsOf('散文')).toEqual([])
  })

  it('SR-22 type 是中文时搜它命中，且不连累 `type: ·` 的普通笔记', async () => {
    seedConcept(root, `${BUNDLE}/t.md`, ['type: 决策', 'title: 一个决定', 'description: dt'])
    seedFile(root, `${BUNDLE}/p.md`, '# 普通笔记\n\n## 小节\n')

    // 普通笔记的 type 占位是标点、切不出词，所以它不跟着任何 type 查询回来（英文那一半见 SR-7）
    expect(await pathsOf('决策')).toEqual(['t.md'])
    expect(await pathsOf('普通笔记')).toEqual(['p.md'])
  })

  it('SR-23 deprecated 即使标题行命中也不出现', async () => {
    seedConcept(
      root,
      `${BUNDLE}/dep.md`,
      ['type: Memory', 'title: Dep', 'description: dd', 'status: deprecated'],
      '## Pangolin section\n'
    )
    seedConcept(
      root,
      `${BUNDLE}/live.md`,
      ['type: Memory', 'title: Live', 'description: dl'],
      '## Pangolin section\n'
    )

    expect(await pathsOf('Pangolin')).toEqual(['live.md'])
  })

  it('SR-24 用户手写的 index.md / sub/log.md：只靠标题行命中时也换回真实路径；隐藏的同名别名不在库里', async () => {
    seedFile(root, `${BUNDLE}/index.md`, '## Tamarin section\n\nnot a projection, this is prose\n')
    seedFile(root, `${BUNDLE}/sub/log.md`, '## Saola section\n\nnot a projection either\n')
    // 别名（`sub/.index.md` 形状）撞不上真实笔记的理由：扫描从不收隐藏文件
    seedFile(root, `${BUNDLE}/.index.md`, '## Tamarin hidden decoy\n')

    // 标题回落到文件名（正文里没有一级标题）—— 命中只能来自标题行
    expect(await hitsOf('Tamarin')).toEqual([['index.md', 'index']])
    expect(await hitsOf('Saola')).toEqual([['sub/log.md', 'log']])
    expect(await pathsOf('decoy')).toEqual([])
  })

  it('SR-25 无 frontmatter、无标题、只有散文：仍按文件名命中（标题回落文件名，而标题是索引字段）', async () => {
    seedFile(root, `${BUNDLE}/quetzal-notes.md`, 'only prose about wombats, no headings at all\n')

    expect(await hitsOf('quetzal')).toEqual([['quetzal-notes.md', 'quetzal-notes']])
    expect(await pathsOf('wombats')).toEqual([])
  })
})
