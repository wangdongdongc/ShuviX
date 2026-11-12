/**
 * changes —— 文件工具的 delete / move 进知识库变更管线（notifyKnowledgeFileChanged 的 'delete' kind 与
 * 目录事件）。move 由文件工具报成一对：源 delete、目标 write（见 agent-runtime 的 FileChangeEvent）。
 *
 *   KD-1 删一条：`kb(deletion): /a.md` 提交、HEAD 树里没了、工作区干净、恰一个 knowledge.changed
 *   KD-2 挪一条（源 delete + 目标 write）：一条 batch 提交（deletion + creation），HEAD 树里换了位置
 *   KD-3 挪一整个目录（两条都带 isDirectory）：底下每个文件的删除与新增都进提交；整个 bundle 的扫描缓存
 *        立即失效（旧目录下的键当场没了，不等下一次扫描）
 *   KD-4 同一批里刚写下又挪走（从没进过仓库）的源：跳过，不拖垮整批 —— 目标照常提交
 *   KD-5 删一个空目录（git 不跟踪空目录，没有可记的）：不报错、不提交，同批别的变更照常落地
 *   KD-6 非 md 文件的删除、内置库里的删除：与写入同一口径，不进管线
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, renameSync, rmSync, rmdirSync } from 'node:fs'
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

import { appEventBus } from '../../../utils/appEventBus'
import {
  flushKnowledgeChanges,
  notifyKnowledgeFileChanged,
  recordKnowledgeChange
} from '../changes'
import { ensureBundleRepo } from '../repo'
import { invalidateKnowledgeScan, knownKnowledgePaths, scanBundle } from '../scan'
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
  seedBuiltin,
  seedFile,
  userRootOf
} from './fixture'

const ACTOR = 'shuvix-knowledge-writer/gpt-5'

let root: string
let dir: string
let events: unknown[]
let unsubscribe: () => void

/** HEAD 树里的全部文件（字典序） */
const headTree = (): string[] =>
  gitOutput(dir, ['ls-tree', '-r', '--name-only', 'HEAD']).split('\n').filter(Boolean).sort()

/** 一个已是 git 仓库的 bundle，基线收下给定的文件 */
const makeBundle = async (files: Record<string, string>): Promise<void> => {
  for (const [rel, text] of Object.entries(files)) seedFile(root, `${BUNDLE}/${rel}`, text)
  await ensureBundleRepo(BUNDLE)
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
  rmSync(builtinRootOf(root), { recursive: true, force: true })
})

describe('notifyKnowledgeFileChanged — delete / move', () => {
  it('KD-1 删一条：kb(deletion) 提交、HEAD 树里没了、工作区干净、恰一个事件', async () => {
    await makeBundle({ 'seed.md': '# seed\n', 'a.md': '# a\n' })
    const abs = fileAt(root, BUNDLE, 'a.md')
    rmSync(abs)

    notifyKnowledgeFileChanged(abs, { kind: 'delete', actor: ACTOR })
    await flushKnowledgeChanges()

    expect(gitHeadMessage(dir)).toBe(
      `kb(deletion): /a.md\n\nKnowledge-Op: deletion\nKnowledge-Actor: ${ACTOR}`
    )
    expect(gitHeadFiles(dir)).toEqual(['a.md'])
    expect(headTree()).toEqual(['seed.md'])
    expect(gitStatus(dir)).toBe('')
    expect(events).toEqual([{ type: 'knowledge.changed' }])
    expect((await scanBundle(BUNDLE)).files.map((f) => f.path)).toEqual(['seed.md'])
  })

  it('KD-1b 迁移收尾的删除（recordKnowledgeChange 带 movedTo）：提交信息多一行 Knowledge-Moved-To；同一批的几条只写一次', async () => {
    await makeBundle({ 'seed.md': '# seed\n', 'a.md': '# a\n', 'b.md': '# b\n' })
    rmSync(fileAt(root, BUNDLE, 'a.md'))
    recordKnowledgeChange({
      bundle: BUNDLE,
      path: 'a.md',
      op: 'Deletion',
      actor: ACTOR,
      movedTo: 'project "Auth"'
    })
    await flushKnowledgeChanges()
    expect(gitHeadMessage(dir)).toBe(
      [
        'kb(deletion): /a.md',
        '',
        'Knowledge-Op: deletion',
        `Knowledge-Actor: ${ACTOR}`,
        'Knowledge-Moved-To: project "Auth"'
      ].join('\n')
    )

    rmSync(fileAt(root, BUNDLE, 'b.md'))
    rmSync(fileAt(root, BUNDLE, 'seed.md'))
    for (const path of ['b.md', 'seed.md']) {
      recordKnowledgeChange({
        bundle: BUNDLE,
        path,
        op: 'Deletion',
        actor: ACTOR,
        movedTo: 'project "Auth"'
      })
    }
    await flushKnowledgeChanges()
    expect(gitHeadMessage(dir)).toBe(
      [
        'kb(batch): 2 changes',
        '',
        '- deletion /b.md',
        '- deletion /seed.md',
        '',
        'Knowledge-Op: batch',
        `Knowledge-Actor: ${ACTOR}`,
        'Knowledge-Moved-To: project "Auth"'
      ].join('\n')
    )
    expect(headTree()).toEqual([])
  })

  it('KD-2 挪一条：一条 batch 提交（deletion + creation），HEAD 树里换了位置', async () => {
    await makeBundle({ 'seed.md': '# seed\n', 'a.md': '# a\n' })
    const from = fileAt(root, BUNDLE, 'a.md')
    const to = fileAt(root, BUNDLE, 'topics/b.md')
    mkdirSync(join(dir, 'topics'))
    renameSync(from, to)

    notifyKnowledgeFileChanged(from, { kind: 'delete', actor: ACTOR })
    notifyKnowledgeFileChanged(to, { kind: 'write', actor: ACTOR })
    await flushKnowledgeChanges()

    expect(gitHeadMessage(dir)).toBe(
      [
        'kb(batch): 2 changes',
        '',
        '- deletion /a.md',
        '- creation /topics/b.md',
        '',
        'Knowledge-Op: batch',
        `Knowledge-Actor: ${ACTOR}`
      ].join('\n')
    )
    expect(headTree()).toEqual(['seed.md', 'topics/b.md'])
    expect(gitStatus(dir)).toBe('')
    expect(events).toEqual([{ type: 'knowledge.changed' }])
  })

  it('KD-3 挪一整个目录：底下的删除与新增都进提交；整个 bundle 的扫描缓存当场失效', async () => {
    await makeBundle({
      'seed.md': '# seed\n',
      'topics/a.md': '# a\n',
      'topics/deep/b.md': '# b\n',
      'topics/pic.png': 'png'
    })
    // 建好扫描缓存：旧目录下的键都在
    await scanBundle(BUNDLE)
    expect([...knownKnowledgePaths()]).toEqual(
      expect.arrayContaining([`${BUNDLE}/topics/a.md`, `${BUNDLE}/topics/deep/b.md`])
    )
    const from = join(dir, 'topics')
    const to = join(dir, 'areas', 'topics')
    mkdirSync(join(dir, 'areas'))
    renameSync(from, to)

    notifyKnowledgeFileChanged(from, { kind: 'delete', actor: ACTOR, isDirectory: true })
    notifyKnowledgeFileChanged(to, { kind: 'write', actor: ACTOR, isDirectory: true })
    await flushKnowledgeChanges()

    expect(gitHeadMessage(dir)).toContain('- deletion /topics\n- creation /areas/topics')
    expect(headTree()).toEqual([
      'areas/topics/a.md',
      'areas/topics/deep/b.md',
      'areas/topics/pic.png',
      'seed.md'
    ])
    expect(gitStatus(dir)).toBe('')
    // 不等下一次扫描：旧目录下的键已经没了（按条失效只会删掉 `topics` 这一个不存在的键）
    expect([...knownKnowledgePaths()].filter((k) => k.startsWith(`${BUNDLE}/`))).toEqual([])
    expect(events).toEqual([{ type: 'knowledge.changed' }])
  })

  it('KD-4 同一批里刚写下又挪走的源（从没进过仓库）：跳过，目标照常提交', async () => {
    await makeBundle({ 'seed.md': '# seed\n' })
    const draft = seedFile(root, `${BUNDLE}/draft.md`, '# d\n')
    notifyKnowledgeFileChanged(draft, { kind: 'write', actor: ACTOR })
    const to = fileAt(root, BUNDLE, 'final.md')
    renameSync(draft, to)
    notifyKnowledgeFileChanged(draft, { kind: 'delete', actor: ACTOR })
    notifyKnowledgeFileChanged(to, { kind: 'write', actor: ACTOR })
    await flushKnowledgeChanges()

    expect(gitCommitCount(dir)).toBe(2)
    expect(headTree()).toEqual(['final.md', 'seed.md'])
    expect(gitStatus(dir)).toBe('')
    expect(logSpy.warn).not.toHaveBeenCalled()
  })

  it('KD-5 删一个空目录：没有可记的 —— 不报错、不多提交；同批别的变更照常落地', async () => {
    await makeBundle({ 'seed.md': '# seed\n' })
    mkdirSync(join(dir, 'empty'))
    rmdirSync(join(dir, 'empty'))
    notifyKnowledgeFileChanged(join(dir, 'empty'), {
      kind: 'delete',
      actor: ACTOR,
      isDirectory: true
    })
    await flushKnowledgeChanges()
    expect(gitCommitCount(dir)).toBe(1)
    expect(logSpy.warn).not.toHaveBeenCalled()
    expect(events).toEqual([{ type: 'knowledge.changed' }])

    mkdirSync(join(dir, 'empty2'))
    rmdirSync(join(dir, 'empty2'))
    const note = seedFile(root, `${BUNDLE}/n.md`, '# n\n')
    notifyKnowledgeFileChanged(join(dir, 'empty2'), {
      kind: 'delete',
      actor: ACTOR,
      isDirectory: true
    })
    notifyKnowledgeFileChanged(note, { kind: 'write', actor: ACTOR })
    await flushKnowledgeChanges()
    expect(gitCommitCount(dir)).toBe(2)
    expect(headTree()).toEqual(['n.md', 'seed.md'])
    expect(logSpy.warn).not.toHaveBeenCalled()
  })

  it('KD-6 非 md 文件的删除、内置库里的删除：不进管线', async () => {
    await makeBundle({ 'seed.md': '# seed\n', 'pic.png': 'png' })
    rmSync(join(dir, 'pic.png'))
    notifyKnowledgeFileChanged(join(dir, 'pic.png'), { kind: 'delete', actor: ACTOR })

    const guide = seedBuiltin(root, 'shuvix/en/guide.md', '# g\n')
    rmSync(guide)
    notifyKnowledgeFileChanged(guide, { kind: 'delete', actor: ACTOR })
    await flushKnowledgeChanges()

    expect(gitCommitCount(dir)).toBe(1)
    expect(events).toEqual([])
    expect(existsSync(join(builtinRootOf(root), 'shuvix', 'en', '.git'))).toBe(false)
    expect(logSpy.warn).not.toHaveBeenCalled()
  })
})
