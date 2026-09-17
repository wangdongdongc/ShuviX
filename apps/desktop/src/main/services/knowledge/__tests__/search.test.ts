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
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
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
