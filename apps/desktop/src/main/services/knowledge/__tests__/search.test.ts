/**
 * search —— 一个 bundle 的检索（okf-minisearch）。钉的是中文分词那次修复：MiniSearch 默认只按
 * 空白与标点切词，中文两个标点之间的一整段曾是一个词，段中间的词（「令牌」）一条都搜不到。
 * 这里走「扫描 → 建索引 → 检索」的真实链路，不碰内部的分词函数。
 *
 * 读宽（设计附录 L）：库里每条笔记都要搜得到 —— 没有 frontmatter / 没有 type / 别家标记 / YAML 写坏的
 * 普通笔记、用户手写的 index.md / log.md，以及 okf-minisearch 拒收原文的合规条目；ShuviX 早先生成的
 * index / log 与 deprecated 条目不进结果。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync } from 'node:fs'
import { buildRootIndexMd } from '@equationalapplications/core-okf'

const state = vi.hoisted(() => ({ root: '' }))

vi.mock('../../../utils/paths', () => ({
  getShuvixKnowledgeRootDir: () => state.root,
  getUserKnowledgeRootDir: () => `${state.root}-user`,
  // 内置库根替身：不存在的兄弟目录 —— 这些用例里没有内置库
  getBuiltinKnowledgeDir: () => `${state.root}-builtin`
}))
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

import { invalidateKnowledgeScan } from '../scan'
import { invalidateKnowledgeSearch, searchBundle } from '../search'
import { BUNDLE, makeTempRoot, seedConcept, seedFile } from './fixture'

let root: string

beforeEach(() => {
  root = makeTempRoot()
  state.root = root
  invalidateKnowledgeScan()
  invalidateKnowledgeSearch()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const seed = (): void => {
  seedConcept(
    root,
    `${BUNDLE}/token.md`,
    ['type: Memory', 'title: 鉴权与令牌刷新', 'description: 改动登录时看', 'status: stable'],
    '访问令牌过期后，用刷新令牌换一个新的访问令牌。'
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

  it('SR-3 片段里不残留分词用的词界标记，回来的是原文', async () => {
    seed()
    const [hit] = await searchBundle(BUNDLE, '令牌', { limit: 1 })
    expect(hit.snippet).toBeDefined()
    expect(hit.snippet).not.toMatch(/\u200A/)
    expect(hit.snippet).toContain('访问令牌过期后')
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
      'zebra'
    )
    seedFile(root, `${BUNDLE}/plain.md`, '# Plain note\n\nquokka lives here\n')
    seedFile(
      root,
      `${BUNDLE}/untyped.md`,
      '---\ntitle: Untyped\ndescription: du\n---\n\nplatypus\n'
    )
    seedFile(root, `${BUNDLE}/foreign.md`, '---\nshuvix: agent v1\nname: a\n---\n\nmeerkat\n')
    seedFile(root, `${BUNDLE}/broken.md`, '---\ntitle: [x\n---\n\nnarwhal\n')
    seedFile(root, `${BUNDLE}/index.md`, '# Home\n\nwombat\n')
    seedFile(root, `${BUNDLE}/sub/log.md`, '# Diary\n\nkoala\n')

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
      'kiwi'
    )
    seedFile(root, `${BUNDLE}/note.md`, 'a kiwi on the windowsill\n')

    expect(await pathsOf('kiwi')).toEqual(['note.md'])
    // `Creation` 只出现在生成的 log.md 里
    expect(await pathsOf('Creation')).not.toContain('log.md')
    expect(await pathsOf('Creation')).toEqual([])
  })

  it('SR-6 okf-minisearch 拒收原文的合规条目照样搜得到，也不连累别的笔记', async () => {
    // 开头多一个 BOM
    seedFile(root, `${BUNDLE}/bom.md`, `${BOM}---\ntype: Memory\ntitle: Bom\n---\n\nalpaca\n`)
    // frontmatter 之前有空行
    seedFile(root, `${BUNDLE}/lead.md`, '\n\n---\ntype: Memory\ntitle: Lead\n---\n\nbison\n')
    // 闭合线带一个尾随空格
    seedFile(root, `${BUNDLE}/ts.md`, '---\ntype: Memory\ntitle: TS\n--- \n\ncoyote\n')
    seedFile(root, `${BUNDLE}/plain.md`, '# P\n\ndingo\n')

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
    seedConcept(root, `${BUNDLE}/a.md`, ['type: Memory', 'title: Alpha'], 'zebra')
    seedFile(root, `${BUNDLE}/plain.md`, '# Plain\n\nquokka\n')

    expect(await pathsOf('memory')).toEqual(['a.md'])
    expect(await pathsOf('note')).toEqual([])
  })
})
