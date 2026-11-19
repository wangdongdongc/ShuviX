/**
 * bundleIndex（落盘的那一半）—— 项目库与 bot 库的目录索引 index.md（2026-11-19）。
 *
 * 契约：
 *  - 只维护 ShuviX 自己的库（`projects/<id>`、`bots/<key>`）；用户的库与内置库里一个字不写；
 *  - 每个放着笔记的目录一份 index.md，内容变了才写；目录里没有笔记了的旧索引删掉（空目录一起收掉）；
 *  - 文件夹描述只存在父目录 index.md 的文件夹行里，重新生成时带过去；新描述先排队（queueFolderDescriptions），
 *    下一次 syncBundleIndexes 落盘；点了一个没有笔记的文件夹的描述丢掉；
 *  - 用户手写的 index.md 不读、不覆盖；
 *  - 生成的索引不是笔记：扫描不列、检索不收；
 *  - recordFolderDescriptions 经变更管线落盘并提交。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, readFileSync, rmSync, statSync, utimesSync } from 'node:fs'
import { join } from 'node:path'

const state = vi.hoisted(() => ({ root: '' }))
const logSpy = vi.hoisted(() => ({ warn: vi.fn() }))

vi.mock('../../../utils/paths', () => ({
  getShuvixKnowledgeRootDir: () => state.root,
  getUserKnowledgeRootDir: () => `${state.root}-user`,
  getBuiltinKnowledgeDir: () => `${state.root}-builtin`
}))
vi.mock('i18next', () => ({ default: { language: 'en', t: (key: string) => key } }))
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: logSpy.warn, error: () => {} })
}))

import {
  bundleOutline,
  maintainsBundleIndex,
  queueFolderDescriptions,
  syncBundleIndexes
} from '../bundleIndex'
import { flushKnowledgeChanges, recordFolderDescriptions, recordKnowledgeChange } from '../changes'
import { ensureBundleRepo } from '../repo'
import { invalidateKnowledgeScan, scanBundle } from '../scan'
import { invalidateKnowledgeSearch, searchBundle } from '../search'
import {
  BUNDLE,
  builtinRootOf,
  bundleAt,
  fileAt,
  gitCommitCount,
  gitHeadFiles,
  gitHeadMessage,
  gitOutput,
  gitStatus,
  makeTempRoot,
  seedBuiltinConcept,
  seedConcept,
  seedFile,
  treeOf,
  userRootOf
} from './fixture'

const ACTOR = 'shuvix-knowledge-writer/haiku'
const USER_BUNDLE = 'knowledge/notes'
const BOT_BUNDLE = 'bots/k1'
const DEFAULT_FM = '---\nokf_version: "0.2"\n---\n'

let root: string
let dir: string

const read = (bundle: string, rel: string): string =>
  readFileSync(fileAt(root, bundle, rel), 'utf-8')
const exists = (bundle: string, rel: string): boolean => existsSync(fileAt(root, bundle, rel))
const entry = (bundle: string, rel: string, title: string, extra: string[] = []): string =>
  seedConcept(root, `${bundle}/${rel}`, ['type: Memory', `title: ${title}`, ...extra])
/** 把某个文件的 mtime 拨到一个固定的过去时刻，返回它 —— 之后没被重写就还是这个值 */
const freeze = (bundle: string, rel: string): number => {
  const at = new Date('2026-01-01T00:00:00Z')
  utimesSync(fileAt(root, bundle, rel), at, at)
  return statSync(fileAt(root, bundle, rel)).mtimeMs
}

beforeEach(() => {
  root = makeTempRoot()
  state.root = root
  dir = bundleAt(root, BUNDLE)
  invalidateKnowledgeScan()
  invalidateKnowledgeSearch()
  logSpy.warn.mockClear()
})

afterEach(async () => {
  await flushKnowledgeChanges()
  // 清掉可能留在队列里的描述（队列是模块级的）
  for (const bundle of [BUNDLE, BOT_BUNDLE]) await syncBundleIndexes(bundle)
  rmSync(root, { recursive: true, force: true })
  rmSync(userRootOf(root), { recursive: true, force: true })
  rmSync(builtinRootOf(root), { recursive: true, force: true })
})

describe('syncBundleIndexes —— 生成', () => {
  it('DI-1 每个放着笔记的目录一份；返回写了的路径；再来一次什么都不写', async () => {
    entry(BUNDLE, 'a.md', 'Alpha', ['description: when a'])
    entry(BUNDLE, 'auth/login.md', 'Login')

    expect((await syncBundleIndexes(BUNDLE)).sort()).toEqual(['auth/index.md', 'index.md'])
    expect(read(BUNDLE, 'index.md')).toBe(
      `${DEFAULT_FM}\n## Folders\n\n* [auth](auth/)\n\n## Entries\n\n* [Alpha](a.md) - when a\n`
    )
    expect(read(BUNDLE, 'auth/index.md')).toBe('## Entries\n\n* [Login](login.md)\n')

    const before = [freeze(BUNDLE, 'index.md'), freeze(BUNDLE, 'auth/index.md')]
    invalidateKnowledgeScan()
    expect(await syncBundleIndexes(BUNDLE)).toEqual([])
    expect([
      statSync(fileAt(root, BUNDLE, 'index.md')).mtimeMs,
      statSync(fileAt(root, BUNDLE, 'auth/index.md')).mtimeMs
    ]).toEqual(before)
  })

  it('DI-2 生成的索引不是笔记：扫描不列进 notes，检索搜不到只在索引行里出现的词', async () => {
    entry(BUNDLE, 'auth/login.md', 'Login')
    queueFolderDescriptions(BUNDLE, [{ folder: 'auth', description: 'zebracorn flows' }])
    await syncBundleIndexes(BUNDLE)
    expect(read(BUNDLE, 'index.md')).toContain('zebracorn')

    const scan = await scanBundle(BUNDLE)
    expect(scan.files.map((f) => f.path).sort()).toEqual([
      'auth/index.md',
      'auth/login.md',
      'index.md'
    ])
    expect(scan.notes.map((n) => n.path)).toEqual(['auth/login.md'])
    invalidateKnowledgeSearch()
    expect(await searchBundle(BUNDLE, 'zebracorn', { limit: 10 })).toEqual([])
    expect((await searchBundle(BUNDLE, 'Login', { limit: 10 })).map((h) => h.path)).toEqual([
      'auth/login.md'
    ])
  })

  it('DI-12 根 index 已有的 frontmatter 留着；旧版投影的 index 换成新形状', async () => {
    entry(BUNDLE, 'sub/x.md', 'X')
    seedFile(
      root,
      `${BUNDLE}/index.md`,
      '---\nokf_version: "0.2"\nprofile: shuvix\n---\n\n## Entries\n\n* [X](sub/x.md)\n\n## Sections\n\n* [sub](sub/)\n'
    )
    expect((await syncBundleIndexes(BUNDLE)).sort()).toEqual(['index.md', 'sub/index.md'])
    expect(read(BUNDLE, 'index.md')).toBe(
      '---\nokf_version: "0.2"\nprofile: shuvix\n---\n\n## Folders\n\n* [sub](sub/)\n'
    )
  })
})

describe('文件夹描述', () => {
  it('DI-3 排队的描述下一次同步落进根 index；库再变也带着；简讯里读得到', async () => {
    entry(BUNDLE, 'auth/login.md', 'Login')
    entry(BUNDLE, 'auth/deep/x.md', 'X')
    expect(
      queueFolderDescriptions(BUNDLE, [{ folder: '/auth/', description: 'Sign-in flows' }])
    ).toBe(true)
    await syncBundleIndexes(BUNDLE)
    expect(read(BUNDLE, 'index.md')).toContain('* [auth](auth/) - Sign-in flows\n')

    entry(BUNDLE, 'ops/run.md', 'Run')
    invalidateKnowledgeScan()
    expect((await syncBundleIndexes(BUNDLE)).sort()).toEqual(['index.md', 'ops/index.md'])
    expect(read(BUNDLE, 'index.md')).toContain('* [auth](auth/) - Sign-in flows\n* [ops](ops/)\n')

    expect(await bundleOutline(BUNDLE)).toEqual({
      folders: [
        { name: 'auth', entries: 2, description: 'Sign-in flows' },
        { name: 'ops', entries: 1, description: '' }
      ],
      entries: [],
      more: 0
    })
  })

  it('DI-4 子文件夹的描述落在它父目录的 index 里，不在根', async () => {
    entry(BUNDLE, 'auth/oauth/pkce.md', 'PKCE')
    queueFolderDescriptions(BUNDLE, [{ folder: 'auth/oauth', description: 'OAuth details' }])
    await syncBundleIndexes(BUNDLE)
    expect(read(BUNDLE, 'auth/index.md')).toBe('## Folders\n\n* [oauth](oauth/) - OAuth details\n')
    expect(read(BUNDLE, 'index.md')).not.toContain('OAuth details')
  })

  it('DI-5 点了一个没有笔记的文件夹：哪儿都不长出一行；空描述 / 空路径不收', async () => {
    entry(BUNDLE, 'auth/login.md', 'Login')
    expect(queueFolderDescriptions(BUNDLE, [{ folder: 'ghost', description: 'nothing' }])).toBe(
      true
    )
    await syncBundleIndexes(BUNDLE)
    expect(treeOf(dir).filter((p) => !p.startsWith('.git'))).toEqual([
      'auth/',
      'auth/index.md',
      'auth/login.md',
      'index.md'
    ])
    expect(read(BUNDLE, 'index.md')).not.toContain('ghost')

    expect(queueFolderDescriptions(BUNDLE, [{ folder: 'auth', description: '  ' }])).toBe(false)
    expect(queueFolderDescriptions(BUNDLE, [{ folder: '/', description: 'root' }])).toBe(false)
    expect(queueFolderDescriptions(BUNDLE, [])).toBe(false)
  })

  it('DI-6 同一个文件夹排了两次：后一条为准；排队的描述盖过已存的', async () => {
    entry(BUNDLE, 'auth/login.md', 'Login')
    queueFolderDescriptions(BUNDLE, [{ folder: 'auth', description: 'first' }])
    queueFolderDescriptions(BUNDLE, [{ folder: 'auth', description: 'second' }])
    await syncBundleIndexes(BUNDLE)
    expect(read(BUNDLE, 'index.md')).toContain('* [auth](auth/) - second\n')

    queueFolderDescriptions(BUNDLE, [{ folder: 'auth', description: 'third <b>\nline' }])
    invalidateKnowledgeScan()
    expect(await syncBundleIndexes(BUNDLE)).toEqual(['index.md'])
    expect(read(BUNDLE, 'index.md')).toContain('* [auth](auth/) - third b line\n')
  })

  it('DI-13 名字带空格 / 括号 / 中文的文件夹：描述经两次同步仍在', async () => {
    entry(BUNDLE, 'my notes (old)/a.md', 'A')
    entry(BUNDLE, '认证/登录.md', '登录')
    queueFolderDescriptions(BUNDLE, [
      { folder: 'my notes (old)', description: 'Old notes - kept (for now)' },
      { folder: '认证', description: '登录与令牌' }
    ])
    await syncBundleIndexes(BUNDLE)
    const first = read(BUNDLE, 'index.md')
    expect(first).toContain(
      '* [my notes (old)](my%20notes%20%28old%29/) - Old notes - kept (for now)'
    )
    expect(first).toContain('* [认证](认证/) - 登录与令牌')

    entry(BUNDLE, 'z.md', 'Z')
    invalidateKnowledgeScan()
    await syncBundleIndexes(BUNDLE)
    const second = read(BUNDLE, 'index.md')
    expect(second).toContain(
      '* [my notes (old)](my%20notes%20%28old%29/) - Old notes - kept (for now)'
    )
    expect(second).toContain('* [认证](认证/) - 登录与令牌')
    expect((await bundleOutline(BUNDLE))!.folders).toEqual([
      { name: 'my notes (old)', entries: 1, description: 'Old notes - kept (for now)' },
      { name: '认证', entries: 1, description: '登录与令牌' }
    ])
  })
})

describe('用户手写的 index.md', () => {
  it('DI-7 手写的根 index：一个字不动、不在返回值里；子目录的索引照常生成；顶层描述无处可存', async () => {
    const mine = '# My own table of contents\n\nSome prose.\n'
    seedFile(root, `${BUNDLE}/index.md`, mine)
    entry(BUNDLE, 'auth/login.md', 'Login')
    queueFolderDescriptions(BUNDLE, [{ folder: 'auth', description: 'Sign-in flows' }])

    expect(await syncBundleIndexes(BUNDLE)).toEqual(['auth/index.md'])
    expect(read(BUNDLE, 'index.md')).toBe(mine)
    expect(read(BUNDLE, 'auth/index.md')).toBe('## Entries\n\n* [Login](login.md)\n')
    const outline = await bundleOutline(BUNDLE)
    expect(outline!.folders).toEqual([{ name: 'auth', entries: 1, description: '' }])
  })

  it('DI-8 手写的子目录 index：不覆盖，里面像文件夹行的那行也不当描述', async () => {
    const mine = '# Auth notes\n\n* [oauth](oauth/) - mine\n'
    seedFile(root, `${BUNDLE}/auth/index.md`, mine)
    entry(BUNDLE, 'auth/oauth/pkce.md', 'PKCE')

    await syncBundleIndexes(BUNDLE)
    expect(read(BUNDLE, 'auth/index.md')).toBe(mine)
    // 描述没被捡走：auth/oauth 自己的索引是生成的，根 index 的 auth 行没有描述
    expect(read(BUNDLE, 'index.md')).toContain('* [auth](auth/)\n')
    expect(read(BUNDLE, 'auth/oauth/index.md')).toBe('## Entries\n\n* [PKCE](pkce.md)\n')
  })
})

describe('没有笔记了的目录', () => {
  it('DI-9 文件夹里最后一条没了：它的索引删掉、空目录收掉、父目录的索引不再列它；还有别的文件时目录留着', async () => {
    entry(BUNDLE, 'top.md', 'Top')
    entry(BUNDLE, 'auth/login.md', 'Login')
    entry(BUNDLE, 'pics/note.md', 'Note')
    seedFile(root, `${BUNDLE}/pics/a.png`, 'png')
    await syncBundleIndexes(BUNDLE)
    expect(exists(BUNDLE, 'auth/index.md')).toBe(true)

    rmSync(fileAt(root, BUNDLE, 'auth/login.md'))
    rmSync(fileAt(root, BUNDLE, 'pics/note.md'))
    invalidateKnowledgeScan()
    expect((await syncBundleIndexes(BUNDLE)).sort()).toEqual([
      'auth/index.md',
      'index.md',
      'pics/index.md'
    ])
    expect(existsSync(join(dir, 'auth'))).toBe(false)
    expect(exists(BUNDLE, 'pics/index.md')).toBe(false)
    expect(exists(BUNDLE, 'pics/a.png')).toBe(true)
    expect(read(BUNDLE, 'index.md')).toBe(`${DEFAULT_FM}\n## Entries\n\n* [Top](top.md)\n`)
  })

  it('DI-10 笔记全没了：根 index 也删掉，库目录本身留着', async () => {
    entry(BUNDLE, 'a.md', 'A')
    await syncBundleIndexes(BUNDLE)
    rmSync(fileAt(root, BUNDLE, 'a.md'))
    invalidateKnowledgeScan()
    expect(await syncBundleIndexes(BUNDLE)).toEqual(['index.md'])
    expect(exists(BUNDLE, 'index.md')).toBe(false)
    expect(existsSync(dir)).toBe(true)
  })
})

describe('只维护 ShuviX 自己的库', () => {
  it('DI-11 用户的库与内置库：不维护、不收描述、不写文件；bot 库与项目库一样；不存在的库不建目录', async () => {
    expect(maintainsBundleIndex(BUNDLE)).toBe(true)
    expect(maintainsBundleIndex(BOT_BUNDLE)).toBe(true)
    expect(maintainsBundleIndex(USER_BUNDLE)).toBe(false)
    expect(maintainsBundleIndex('builtin/shuvix')).toBe(false)

    seedConcept(userRootOf(root), 'notes/sub/n.md', ['type: Memory', 'title: N'])
    seedBuiltinConcept(root, 'shuvix/en/sub/g.md', ['type: Guide', 'title: G'])
    for (const bundle of [USER_BUNDLE, 'builtin/shuvix']) {
      expect(queueFolderDescriptions(bundle, [{ folder: 'sub', description: 'd' }])).toBe(false)
      expect(await syncBundleIndexes(bundle)).toEqual([])
    }
    expect(treeOf(join(userRootOf(root), 'notes'))).toEqual(['sub/', 'sub/n.md'])
    expect(treeOf(builtinRootOf(root))).toEqual([
      'shuvix/',
      'shuvix/en/',
      'shuvix/en/sub/',
      'shuvix/en/sub/g.md'
    ])

    entry(BOT_BUNDLE, 'facts/x.md', 'X')
    expect(
      queueFolderDescriptions(BOT_BUNDLE, [{ folder: 'facts', description: 'Kept facts' }])
    ).toBe(true)
    expect((await syncBundleIndexes(BOT_BUNDLE)).sort()).toEqual(['facts/index.md', 'index.md'])
    expect(read(BOT_BUNDLE, 'index.md')).toContain('* [facts](facts/) - Kept facts\n')

    expect(await syncBundleIndexes('projects/never')).toEqual([])
    expect(existsSync(bundleAt(root, 'projects/never'))).toBe(false)
  })
})

describe('bundleOutline', () => {
  it('DI-14 库不存在 / 只有 deprecated 的条目 → null；deprecated 不进条目数', async () => {
    expect(await bundleOutline('projects/never')).toBeNull()

    entry(BUNDLE, 'old.md', 'Old', ['status: deprecated'])
    expect(await bundleOutline(BUNDLE)).toBeNull()

    entry(BUNDLE, 'auth/a.md', 'A')
    entry(BUNDLE, 'auth/gone.md', 'Gone', ['status: deprecated'])
    invalidateKnowledgeScan()
    expect(await bundleOutline(BUNDLE)).toEqual({
      folders: [{ name: 'auth', entries: 1, description: '' }],
      entries: [],
      more: 0
    })
  })
})

describe('经变更管线', () => {
  it('DC-1 项目库：一条新建的提交里带着这条、根 index 与它所在文件夹的 index', async () => {
    entry(BUNDLE, 'seed.md', 'Seed')
    await ensureBundleRepo(BUNDLE)
    entry(BUNDLE, 'auth/login.md', 'Login')
    recordKnowledgeChange({ bundle: BUNDLE, path: 'auth/login.md', op: 'Creation', actor: ACTOR })
    await flushKnowledgeChanges()

    expect(gitHeadMessage(dir)).toContain('kb(creation): /auth/login.md')
    expect(gitHeadFiles(dir)).toEqual(['auth/index.md', 'auth/login.md', 'index.md'])
    expect(gitStatus(dir)).toBe('')
  })

  it('DC-2 用户的库：提交里只有这条，盘上没有 index.md', async () => {
    const userRoot = userRootOf(root)
    const vault = join(userRoot, 'notes')
    seedConcept(userRoot, 'notes/sub/n.md', ['type: Memory', 'title: N'])
    recordKnowledgeChange({ bundle: USER_BUNDLE, path: 'sub/n.md', op: 'Creation', actor: ACTOR })
    await flushKnowledgeChanges()

    expect(gitHeadFiles(vault)).toEqual(['sub/n.md'])
    expect(treeOf(vault).filter((p) => !p.startsWith('.git'))).toEqual(['sub/', 'sub/n.md'])
  })

  it('DC-3 recordFolderDescriptions：描述落进根 index 并提交，trailer 记着 actor；用户的库什么都不记', async () => {
    entry(BUNDLE, 'auth/login.md', 'Login')
    await syncBundleIndexes(BUNDLE)
    await ensureBundleRepo(BUNDLE)
    const before = gitCommitCount(dir)

    recordFolderDescriptions(BUNDLE, [{ folder: 'auth', description: 'Sign-in flows' }], ACTOR)
    await flushKnowledgeChanges()
    expect(read(BUNDLE, 'index.md')).toContain('* [auth](auth/) - Sign-in flows\n')
    expect(gitCommitCount(dir)).toBe(before + 1)
    expect(gitHeadMessage(dir)).toBe(
      `kb(update): /index.md\n\nKnowledge-Op: update\nKnowledge-Actor: ${ACTOR}`
    )
    expect(gitHeadFiles(dir)).toEqual(['index.md'])
    expect(gitStatus(dir)).toBe('')

    const userRoot = userRootOf(root)
    const vault = join(userRoot, 'notes')
    seedConcept(userRoot, 'notes/sub/n.md', ['type: Memory', 'title: N'])
    recordFolderDescriptions(USER_BUNDLE, [{ folder: 'sub', description: 'd' }], ACTOR)
    await flushKnowledgeChanges()
    expect(existsSync(join(vault, '.git'))).toBe(false)
    expect(treeOf(vault)).toEqual(['sub/', 'sub/n.md'])
  })

  it('DC-4 与已存的描述一模一样、或文件夹没有笔记：文件不变，也不报错', async () => {
    entry(BUNDLE, 'auth/login.md', 'Login')
    queueFolderDescriptions(BUNDLE, [{ folder: 'auth', description: 'Sign-in flows' }])
    await syncBundleIndexes(BUNDLE)
    await ensureBundleRepo(BUNDLE)
    const text = read(BUNDLE, 'index.md')

    recordFolderDescriptions(BUNDLE, [{ folder: 'auth', description: 'Sign-in flows' }], ACTOR)
    recordFolderDescriptions(BUNDLE, [{ folder: 'ghost', description: 'nothing' }], ACTOR)
    await flushKnowledgeChanges()
    expect(read(BUNDLE, 'index.md')).toBe(text)
    expect(gitStatus(dir)).toBe('')
    expect(logSpy.warn).not.toHaveBeenCalled()
  })

  it('DC-5 删掉文件夹里最后一条：同一条提交里有这条的删除、那份索引的删除与父目录索引的更新', async () => {
    entry(BUNDLE, 'top.md', 'Top')
    entry(BUNDLE, 'auth/login.md', 'Login')
    await syncBundleIndexes(BUNDLE)
    await ensureBundleRepo(BUNDLE)

    rmSync(fileAt(root, BUNDLE, 'auth/login.md'))
    recordKnowledgeChange({ bundle: BUNDLE, path: 'auth/login.md', op: 'Deletion', actor: ACTOR })
    await flushKnowledgeChanges()

    expect(gitHeadFiles(dir)).toEqual(['auth/index.md', 'auth/login.md', 'index.md'])
    expect(
      gitOutput(dir, ['ls-tree', '-r', '--name-only', 'HEAD']).split('\n').filter(Boolean).sort()
    ).toEqual(['index.md', 'top.md'])
    expect(existsSync(join(dir, 'auth'))).toBe(false)
    expect(gitStatus(dir)).toBe('')
  })

  it('DC-6 第一次写进还不是仓库的库：基线里没有生成的索引，它们随这一批的提交到', async () => {
    // 拷进来时就在的一条：进基线
    entry(BUNDLE, 'old.md', 'Old')
    entry(BUNDLE, 'auth/new.md', 'New')
    recordKnowledgeChange({ bundle: BUNDLE, path: 'auth/new.md', op: 'Creation', actor: ACTOR })
    await flushKnowledgeChanges()

    expect(gitCommitCount(dir)).toBe(2)
    const baseline = gitOutput(dir, ['show', '--name-only', '--format=', 'HEAD~1'])
      .split('\n')
      .filter(Boolean)
    expect(baseline).toEqual(['old.md'])
    expect(gitHeadFiles(dir)).toEqual(['auth/index.md', 'auth/new.md', 'index.md'])
    expect(gitStatus(dir)).toBe('')
  })
})
