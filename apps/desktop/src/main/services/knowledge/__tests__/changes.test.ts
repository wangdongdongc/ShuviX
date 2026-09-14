/**
 * changes —— 宿主观察到的每一次知识库写入都经这条管线：失效缓存 →（还不是 git 仓库的库先 init + 基线）→
 * 排队该 bundle 的 git 提交 → 广播 knowledge.changed。300ms 去抖合批：一批一个事件、每个 bundle 一条提交。
 * index.md / log.md 不再维护 —— 管线从不写它们，谁在什么时候改了哪条都记在提交里。
 * `notifyKnowledgeFileChanged` 是文件工具那一侧的入口：先按 locateBundle 判「这条路径属于哪个 bundle」
 * （落不进任何 bundle 的一概不算知识库变更），再按「扫描是否见过」区分新建 / 更新。
 *
 * 用户库（`knowledge/<库名>`）与项目库一视同仁：拷进来的文件夹在第一次观察到写入之前原封不动；没有 .git 的
 * 先 init + 基线（收下原貌，不含本批新写的文件），自带 .git 的原样沿用、只提交宿主碰过的路径。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const state = vi.hoisted(() => ({ root: '' }))
const logSpy = vi.hoisted(() => ({ warn: vi.fn() }))

vi.mock('../../../utils/paths', () => ({
  getShuvixKnowledgeRootDir: () => state.root,
  getUserKnowledgeRootDir: () => `${state.root}-user`
}))
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: logSpy.warn, error: () => {} })
}))

import { appEventBus } from '../../../utils/appEventBus'
import {
  flushKnowledgeChanges,
  notifyKnowledgeFileChanged,
  recordKnowledgeChange
} from '../changes'
import { ensureBundleRepo } from '../repo'
import { invalidateKnowledgeScan, scanBundle } from '../scan'
import {
  BUNDLE,
  OTHER_BUNDLE,
  PROJECTS,
  bundleAt,
  conceptText,
  fileAt,
  gitAsUser,
  gitCommitCount,
  gitCommitFiles,
  gitHeadFiles,
  gitHeadMessage,
  gitLog,
  gitOutput,
  gitStatus,
  makeTempRoot,
  seedConcept,
  seedFile,
  userRootOf
} from './fixture'

const ACTOR = 'shuvix-work/gpt-5'
const HOST_AUTHOR = 'ShuviX Knowledge <knowledge@shuvix.local>'

let root: string
let dir: string
let events: unknown[]
let unsubscribe: () => void

/** 一个已是 git 仓库、带一份初始笔记的 bundle */
const makeBundle = async (bundle: string): Promise<void> => {
  seedFile(root, `${bundle}/seed.md`, '# seed\n')
  await ensureBundleRepo(bundle)
}

/** 管线从不写 index.md / log.md */
const expectNoBookkeeping = (bundleDir: string): void => {
  expect(existsSync(join(bundleDir, 'index.md')), 'index.md').toBe(false)
  expect(existsSync(join(bundleDir, 'log.md')), 'log.md').toBe(false)
}

beforeEach(() => {
  root = makeTempRoot()
  state.root = root
  dir = bundleAt(root, BUNDLE)
  invalidateKnowledgeScan()
  logSpy.warn.mockClear()
  events = []
  unsubscribe = appEventBus.subscribe((e) => {
    if (e.type === 'knowledge.changed') events.push(e)
  })
})

afterEach(async () => {
  unsubscribe()
  await flushKnowledgeChanges()
  rmSync(root, { recursive: true, force: true })
  rmSync(userRootOf(root), { recursive: true, force: true })
})

describe('recordKnowledgeChange', () => {
  it('CH-1 一条变更 → 去抖后：一次提交（只含变更的文件）、恰一个 knowledge.changed，不写 index / log；窗口内两条 → 一个事件、一条 batch 提交', async () => {
    await makeBundle(BUNDLE)
    seedConcept(root, `${BUNDLE}/a.md`, [
      'type: Memory',
      'title: A',
      'description: da',
      'status: draft'
    ])

    recordKnowledgeChange({ bundle: BUNDLE, path: 'a.md', op: 'Creation', actor: ACTOR })
    // 返回即在后台跑：事件在去抖之后
    expect(events).toEqual([])
    await flushKnowledgeChanges()
    expect(gitHeadMessage(dir)).toBe(
      'kb(creation): /a.md\n\nKnowledge-Op: creation\nKnowledge-Actor: shuvix-work/gpt-5'
    )
    expect(gitHeadFiles(dir)).toEqual(['a.md'])
    expect(events).toEqual([{ type: 'knowledge.changed' }])
    expectNoBookkeeping(dir)
    const commits = gitCommitCount(dir)

    seedConcept(root, `${BUNDLE}/b.md`, [
      'type: Memory',
      'title: B',
      'description: db',
      'status: draft'
    ])
    writeFileSync(
      fileAt(root, BUNDLE, 'a.md'),
      conceptText(['type: Memory', 'title: A2', 'description: da2', 'status: draft'])
    )
    recordKnowledgeChange({ bundle: BUNDLE, path: 'b.md', op: 'Creation', actor: ACTOR })
    recordKnowledgeChange({ bundle: BUNDLE, path: 'a.md', op: 'Update', actor: ACTOR })
    await flushKnowledgeChanges()
    expect(events).toHaveLength(2)
    expect(gitCommitCount(dir)).toBe(commits + 1)
    expect(gitHeadMessage(dir)).toContain('kb(batch): 2 changes')
    expect(gitHeadFiles(dir)).toEqual(['a.md', 'b.md'])
    expectNoBookkeeping(dir)
  })

  it('CH-2 一批里跨两个 bundle：各自提交到各自的仓库，事件仍只发一个', async () => {
    await makeBundle(BUNDLE)
    await makeBundle(OTHER_BUNDLE)
    seedConcept(root, `${BUNDLE}/a.md`, ['type: Memory', 'title: A', 'description: da'])
    seedConcept(root, `${OTHER_BUNDLE}/b.md`, ['type: Memory', 'title: B', 'description: db'])
    const otherDir = bundleAt(root, OTHER_BUNDLE)
    const [before, otherBefore] = [gitCommitCount(dir), gitCommitCount(otherDir)]

    recordKnowledgeChange({ bundle: BUNDLE, path: 'a.md', op: 'Creation', actor: ACTOR })
    recordKnowledgeChange({ bundle: OTHER_BUNDLE, path: 'b.md', op: 'Creation', actor: ACTOR })
    await flushKnowledgeChanges()

    expect(events).toHaveLength(1)
    expect(gitCommitCount(dir)).toBe(before + 1)
    expect(gitCommitCount(otherDir)).toBe(otherBefore + 1)
    expect(gitHeadMessage(dir)).toContain('kb(creation): /a.md')
    expect(gitHeadMessage(otherDir)).toContain('kb(creation): /b.md')
    expect(gitHeadFiles(dir)).toEqual(['a.md'])
    expect(gitHeadFiles(otherDir)).toEqual(['b.md'])
  })
})

describe('notifyKnowledgeFileChanged', () => {
  it('CH-3 判定表：根外 / 根下但不属于任何 bundle / 非 md → 无事；新路径 write → Creation；已知路径 write → Update；未知路径 edit → Update；actor 进 trailer；index.md 也只是一个 md', async () => {
    await makeBundle(BUNDLE)
    const baseline = gitCommitCount(dir)

    for (const abs of [
      '/elsewhere/x.md',
      // 根下、容器下都还不是 bundle：bundle 边界恰是 projects/<id>
      join(root, 'x.md'),
      join(root, PROJECTS, 'x.md'),
      fileAt(root, BUNDLE, 'x.txt')
    ]) {
      notifyKnowledgeFileChanged(abs, { kind: 'write' })
    }
    await flushKnowledgeChanges()
    expect(events).toEqual([])
    expect(gitCommitCount(dir)).toBe(baseline)

    // 扫描没见过的路径 + write → Creation
    const n = seedConcept(root, `${BUNDLE}/n.md`, [
      'type: Memory',
      'title: N',
      'description: dn',
      'status: draft'
    ])
    notifyKnowledgeFileChanged(n, { kind: 'write', actor: ACTOR })
    await flushKnowledgeChanges()
    expect(gitHeadMessage(dir)).toBe(
      'kb(creation): /n.md\n\nKnowledge-Op: creation\nKnowledge-Actor: shuvix-work/gpt-5'
    )
    expect(events).toHaveLength(1)

    // 已知路径 + write → Update
    await scanBundle(BUNDLE)
    writeFileSync(n, conceptText(['type: Memory', 'title: N2', 'description: dn', 'status: draft']))
    notifyKnowledgeFileChanged(n, { kind: 'write', actor: ACTOR })
    await flushKnowledgeChanges()
    expect(gitHeadMessage(dir)).toContain('kb(update): /n.md')

    // 没见过的路径 + edit → 仍是 Update（edit 只可能发生在已有文件上）
    const m = seedConcept(root, `${BUNDLE}/sub/m.md`, [
      'type: Memory',
      'title: M',
      'description: dm',
      'status: draft'
    ])
    notifyKnowledgeFileChanged(m, { kind: 'edit', actor: ACTOR })
    await flushKnowledgeChanges()
    expect(gitHeadMessage(dir)).toBe(
      'kb(update): /sub/m.md\n\nKnowledge-Op: update\nKnowledge-Actor: shuvix-work/gpt-5'
    )

    // index.md 不再归宿主：写它就是一次普通的变更
    const index = seedFile(root, `${BUNDLE}/index.md`, '# Home\n')
    notifyKnowledgeFileChanged(index, { kind: 'write', actor: ACTOR })
    await flushKnowledgeChanges()
    expect(gitHeadMessage(dir)).toContain('kb(creation): /index.md')
    expect(events).toHaveLength(4)
  })
})

describe('管线容错', () => {
  it('CH-4 提交前一步抛错：flushKnowledgeChanges 仍 resolve、事件照发、记一条 warn', async () => {
    vi.resetModules()
    vi.doMock('../repo', () => ({
      ensureBundleRepo: vi.fn(async () => {
        throw new Error('boom')
      }),
      flushKnowledgeCommits: vi.fn(async () => {}),
      queueKnowledgeCommit: vi.fn()
    }))
    try {
      const changes = await import('../changes')
      const { appEventBus: bus } = await import('../../../utils/appEventBus')
      const seen: unknown[] = []
      const stop = bus.subscribe((e) => {
        if (e.type === 'knowledge.changed') seen.push(e)
      })
      try {
        changes.recordKnowledgeChange({ bundle: BUNDLE, path: 'a.md', op: 'Creation' })
        await expect(changes.flushKnowledgeChanges()).resolves.toBeUndefined()
        expect(seen).toEqual([{ type: 'knowledge.changed' }])
        expect(logSpy.warn).toHaveBeenCalledWith(
          expect.stringContaining('knowledge change pipeline failed: boom')
        )
      } finally {
        stop()
      }
    } finally {
      vi.doUnmock('../repo')
      vi.resetModules()
    }
  })
})

describe('用户库的簿记', () => {
  it('CH-5 没有 .git 的拷入库：观察到第一次写入之前原封不动；之后先 init + 基线（收下原貌、不含本批新文件），变更再以自己的 kb(<op>) 提交落地；宿主不生成 index / log，手写的 index.md 一个字节不动', async () => {
    const userRoot = userRootOf(root)
    const notes = join(userRoot, 'notes')
    const handIndex = '# my index\n'
    seedConcept(userRoot, 'notes/old.md', ['type: Memory', 'title: Old', 'description: do'])
    seedFile(userRoot, 'notes/index.md', handIndex)
    seedFile(userRoot, 'notes/assets/pic.png', 'png')
    seedConcept(userRoot, 'notes/sub/deep.md', ['type: Memory', 'title: Deep', 'description: dd'])

    // 读（扫描）不算观察到写入：一切原样
    await scanBundle('knowledge/notes')
    expect(existsSync(join(notes, '.git'))).toBe(false)

    const abs = seedConcept(userRoot, 'notes/new.md', [
      'type: Memory',
      'title: New',
      'description: dn'
    ])
    notifyKnowledgeFileChanged(abs, { kind: 'write', actor: ACTOR })
    await flushKnowledgeChanges()

    // 簿记只剩 git：不生成 index / log，手写的 index.md 原样
    expect(readFileSync(join(notes, 'index.md'), 'utf-8')).toBe(handIndex)
    expect(existsSync(join(notes, 'log.md'))).toBe(false)
    expect(existsSync(join(notes, 'sub', 'index.md'))).toBe(false)

    // git：仓库建在文件夹自己里，工作区干净，全部由 ShuviX Knowledge 署名，事件恰一个
    expect(existsSync(join(notes, '.git'))).toBe(true)
    expect(gitStatus(notes)).toBe('')
    expect(
      gitOutput(notes, ['ls-tree', '-r', '--name-only', 'HEAD']).split('\n').filter(Boolean).sort()
    ).toEqual(['assets/pic.png', 'index.md', 'new.md', 'old.md', 'sub/deep.md'])
    expect(gitLog(notes, '%an <%ae>')).toEqual([HOST_AUTHOR, HOST_AUTHOR])
    expect(events).toEqual([{ type: 'knowledge.changed' }])

    // 提交结构：基线是拷进来时的原貌，这次写入是它自己的一条
    expect(gitLog(notes, '%s')).toEqual(['kb(creation): /new.md', 'kb(init): knowledge base'])
    expect(gitCommitFiles(notes, 'HEAD~1')).toEqual([
      'assets/pic.png',
      'index.md',
      'old.md',
      'sub/deep.md'
    ])
    expect(gitCommitFiles(notes, 'HEAD')).toEqual(['new.md'])

    // 第二次写入：仓库已在，只多一条自己的提交
    const commits = gitCommitCount(notes)
    writeFileSync(abs, conceptText(['type: Memory', 'title: New', 'description: dn2']))
    notifyKnowledgeFileChanged(abs, { kind: 'edit', actor: ACTOR })
    await flushKnowledgeChanges()
    expect(gitCommitCount(notes)).toBe(commits + 1)
    expect(gitHeadMessage(notes)).toBe(
      'kb(update): /new.md\n\nKnowledge-Op: update\nKnowledge-Actor: shuvix-work/gpt-5'
    )
  })

  it('CH-6 自带 .git 的库：原样沿用用户的仓库（不 init、不补基线），只提交宿主碰过的路径 —— 用户自己未提交的改动与未跟踪文件原样留在工作区', async () => {
    const userRoot = userRootOf(root)
    const vault = join(userRoot, 'vault')
    seedConcept(userRoot, 'vault/note.md', ['type: Memory', 'title: Note', 'description: dnote'])
    seedFile(userRoot, 'vault/scratch.txt', 'draft 1\n')
    gitAsUser(vault, ['init'])
    gitAsUser(vault, ['add', '.'])
    gitAsUser(vault, ['commit', '-m', 'My notes'])
    writeFileSync(join(vault, 'scratch.txt'), 'draft 2\n')
    seedFile(userRoot, 'vault/todo.md', '- [ ] water the plants\n')

    const abs = seedConcept(userRoot, 'vault/x.md', ['type: Memory', 'title: X', 'description: dx'])
    notifyKnowledgeFileChanged(abs, { kind: 'write', actor: ACTOR })
    await flushKnowledgeChanges()

    expect(gitLog(vault, '%s')).toEqual(['kb(creation): /x.md', 'My notes'])
    expect(gitLog(vault, '%an')).toEqual(['ShuviX Knowledge', 'Alice'])
    expect(gitHeadFiles(vault)).toEqual(['x.md'])
    expect(gitStatus(vault).split('\n').sort()).toEqual([' M scratch.txt', '?? todo.md'])
    expectNoBookkeeping(vault)
    expect(events).toEqual([{ type: 'knowledge.changed' }])
  })

  it('CH-7 用户根一侧的判定表：用户根散文件 / 隐藏目录（根下与库内）/ 非 md / shuvix 根下的 knowledge 目录 → 无事、不建仓库；没扫过的路径 → Creation、扫过之后 → Update', async () => {
    const userRoot = userRootOf(root)
    const notes = join(userRoot, 'notes')
    const draft = conceptText(['type: Memory', 'title: X', 'description: dx'])
    seedConcept(userRoot, 'notes/a.md', ['type: Memory', 'title: A', 'description: da'])

    for (const abs of [
      seedFile(userRoot, 'x.md', draft),
      seedFile(userRoot, '.trash/x.md', draft),
      seedFile(userRoot, 'notes/x.txt', 'not markdown'),
      // knowledge-shuvix 根下没有 `knowledge` 容器：同形的路径不是用户库
      seedFile(root, 'knowledge/notes/x.md', draft),
      seedFile(userRoot, 'notes/.trash/x.md', draft)
    ]) {
      notifyKnowledgeFileChanged(abs, { kind: 'write', actor: ACTOR })
    }
    await flushKnowledgeChanges()
    expect(events).toEqual([])
    expect(existsSync(join(notes, '.git'))).toBe(false)

    // 扫描没见过的路径 → Creation；扫过之后再写 → Update
    const b = seedConcept(userRoot, 'notes/b.md', ['type: Memory', 'title: B', 'description: db'])
    notifyKnowledgeFileChanged(b, { kind: 'write', actor: ACTOR })
    await flushKnowledgeChanges()
    expect(gitHeadMessage(notes)).toBe(
      'kb(creation): /b.md\n\nKnowledge-Op: creation\nKnowledge-Actor: shuvix-work/gpt-5'
    )
    await scanBundle('knowledge/notes')
    writeFileSync(b, conceptText(['type: Memory', 'title: B', 'description: db2']))
    notifyKnowledgeFileChanged(b, { kind: 'write', actor: ACTOR })
    await flushKnowledgeChanges()
    expect(gitHeadMessage(notes)).toBe(
      'kb(update): /b.md\n\nKnowledge-Op: update\nKnowledge-Actor: shuvix-work/gpt-5'
    )
    expect(events).toHaveLength(2)
  })
})
