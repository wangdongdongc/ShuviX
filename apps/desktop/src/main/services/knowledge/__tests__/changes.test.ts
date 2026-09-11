/**
 * changes —— 宿主观察到的每一次知识库写入都经这条管线：失效缓存 → 重投影**该 bundle** 的
 * index/log → 排队该 bundle 的 git 提交 → 广播 knowledge.changed。300ms 去抖合批：一批一个
 * 事件、逐条一行日志、每个 bundle 一条提交。`notifyKnowledgeFileChanged` 是文件工具那一侧的
 * 入口：先按 locateBundle 判「这条路径属于哪个 bundle」（落不进任何 bundle 的一概不算知识库
 * 变更），再按「扫描是否见过」区分新建 / 更新，保留文件只失效缓存。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
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
import { invalidateKnowledgeScan, knownKnowledgePaths, scanBundle } from '../scan'
import {
  BUNDLE,
  OTHER_BUNDLE,
  PROJECTS,
  bundleAt,
  conceptText,
  fileAt,
  gitCommitCount,
  gitHeadMessage,
  makeTempRoot,
  seedConcept,
  seedFile
} from './fixture'

const ACTOR = 'shuvix-work/gpt-5'
const PROJECT_MD = '---\ntype: Project\ntitle: Acme\nresource: shuvix://project/p1\n---\n\nacme\n'

let root: string
let dir: string
let events: unknown[]
let unsubscribe: () => void

/** 某个 bundle 的变更日志。空 bundle 没有它 —— 建库本身不是一次变更，第一条变更才把它写出来 */
const readLog = (bundle = BUNDLE): string => {
  try {
    return readFileSync(fileAt(root, bundle, 'log.md'), 'utf-8')
  } catch {
    return ''
  }
}

/** 一个建好、已是 git 仓库的 bundle */
const makeBundle = async (bundle: string): Promise<void> => {
  seedFile(root, `${bundle}/project.md`, PROJECT_MD)
  await ensureBundleRepo(bundle)
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
})

describe('recordKnowledgeChange', () => {
  it('CH-1 一条变更 → 去抖后：index 重投影、log 追加带 actor 的一行、一次提交、恰一个 knowledge.changed；窗口内两条 → 一个事件、两行日志、一条 batch 提交', async () => {
    await makeBundle(BUNDLE)
    seedConcept(root, `${BUNDLE}/a.md`, [
      'type: Memory',
      'title: A',
      'description: da',
      'status: draft'
    ])

    recordKnowledgeChange({
      bundle: BUNDLE,
      path: 'a.md',
      op: 'Creation',
      title: 'A',
      actor: ACTOR
    })
    // 返回即在后台跑：事件在去抖之后
    expect(events).toEqual([])
    await flushKnowledgeChanges()
    expect(readFileSync(fileAt(root, BUNDLE, 'index.md'), 'utf-8')).toContain('* [A](a.md) - da')
    expect(readLog()).toContain('- **Creation** /a.md — A · by shuvix-work/gpt-5')
    expect(gitHeadMessage(dir)).toBe(
      'kb(creation): /a.md\n\nKnowledge-Op: creation\nKnowledge-Actor: shuvix-work/gpt-5'
    )
    expect(events).toEqual([{ type: 'knowledge.changed' }])
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
    recordKnowledgeChange({
      bundle: BUNDLE,
      path: 'b.md',
      op: 'Creation',
      title: 'B',
      actor: ACTOR
    })
    recordKnowledgeChange({ bundle: BUNDLE, path: 'a.md', op: 'Update', title: 'A2', actor: ACTOR })
    await flushKnowledgeChanges()
    expect(events).toHaveLength(2)
    expect(readLog()).toContain('- **Creation** /b.md — B · by shuvix-work/gpt-5')
    expect(readLog()).toContain('- **Update** /a.md — A2 · by shuvix-work/gpt-5')
    expect(gitCommitCount(dir)).toBe(commits + 1)
    expect(gitHeadMessage(dir)).toContain('kb(batch): 2 changes')
    const index = readFileSync(fileAt(root, BUNDLE, 'index.md'), 'utf-8')
    expect(index).toContain('* [A2](a.md) - da2')
    expect(index).toContain('* [B](b.md) - db')
  })

  it('CH-2 一批里跨两个 bundle：各自投影、各自提交到各自的仓库，事件仍只发一个', async () => {
    await makeBundle(BUNDLE)
    await makeBundle(OTHER_BUNDLE)
    seedConcept(root, `${BUNDLE}/a.md`, ['type: Memory', 'title: A', 'description: da'])
    seedConcept(root, `${OTHER_BUNDLE}/b.md`, ['type: Memory', 'title: B', 'description: db'])
    const otherDir = bundleAt(root, OTHER_BUNDLE)
    const [before, otherBefore] = [gitCommitCount(dir), gitCommitCount(otherDir)]

    recordKnowledgeChange({
      bundle: BUNDLE,
      path: 'a.md',
      op: 'Creation',
      title: 'A',
      actor: ACTOR
    })
    recordKnowledgeChange({
      bundle: OTHER_BUNDLE,
      path: 'b.md',
      op: 'Creation',
      title: 'B',
      actor: ACTOR
    })
    await flushKnowledgeChanges()

    expect(events).toHaveLength(1)
    expect(readLog(BUNDLE)).toContain('- **Creation** /a.md — A')
    expect(readLog(BUNDLE)).not.toContain('/b.md')
    expect(readLog(OTHER_BUNDLE)).toContain('- **Creation** /b.md — B')
    expect(gitCommitCount(dir)).toBe(before + 1)
    expect(gitCommitCount(otherDir)).toBe(otherBefore + 1)
    expect(gitHeadMessage(dir)).toContain('kb(creation): /a.md')
    expect(gitHeadMessage(otherDir)).toContain('kb(creation): /b.md')
  })
})

describe('notifyKnowledgeFileChanged', () => {
  it('CH-3 判定表：根外 / 根下但不属于任何 bundle / 非 md → 无事；保留文件 → 只失效缓存；新路径 write → Creation；已知路径 write → Update；未知路径 edit → Update；actor 进日志与 trailer', async () => {
    await makeBundle(BUNDLE)
    const baseline = gitCommitCount(dir)
    const logBefore = readLog()

    for (const abs of [
      '/elsewhere/x.md',
      // 根下、容器下都还不是 bundle：bundle 边界恰是 projects/<slug>
      join(root, 'x.md'),
      join(root, PROJECTS, 'x.md'),
      fileAt(root, BUNDLE, 'x.txt')
    ]) {
      notifyKnowledgeFileChanged(abs, { kind: 'write' })
    }
    await flushKnowledgeChanges()
    expect(events).toEqual([])
    expect(gitCommitCount(dir)).toBe(baseline)
    expect(readLog()).toBe(logBefore)

    // 保留文件：宿主投影维护，agent 直写只失效缓存 —— 不记日志、不提交、不发事件
    seedFile(root, `${BUNDLE}/index.md`, '')
    await scanBundle(BUNDLE)
    expect(knownKnowledgePaths().has(`${BUNDLE}/index.md`)).toBe(true)
    notifyKnowledgeFileChanged(fileAt(root, BUNDLE, 'index.md'), { kind: 'write' })
    expect(knownKnowledgePaths().has(`${BUNDLE}/index.md`)).toBe(false)
    await flushKnowledgeChanges()
    expect(events).toEqual([])
    expect(gitCommitCount(dir)).toBe(baseline)
    expect(readLog()).toBe(logBefore)

    // 扫描没见过的路径 + write → Creation
    const n = seedConcept(root, `${BUNDLE}/n.md`, [
      'type: Memory',
      'title: N',
      'description: dn',
      'status: draft'
    ])
    notifyKnowledgeFileChanged(n, { kind: 'write', actor: ACTOR })
    await flushKnowledgeChanges()
    expect(readLog()).toContain('- **Creation** /n.md · by shuvix-work/gpt-5')
    expect(gitHeadMessage(dir)).toBe(
      'kb(creation): /n.md\n\nKnowledge-Op: creation\nKnowledge-Actor: shuvix-work/gpt-5'
    )
    expect(events).toHaveLength(1)

    // 已知路径 + write → Update
    await scanBundle(BUNDLE)
    writeFileSync(n, conceptText(['type: Memory', 'title: N2', 'description: dn', 'status: draft']))
    notifyKnowledgeFileChanged(n, { kind: 'write', actor: ACTOR })
    await flushKnowledgeChanges()
    expect(readLog()).toContain('- **Update** /n.md · by shuvix-work/gpt-5')
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
    expect(readLog()).toContain('- **Update** /sub/m.md · by shuvix-work/gpt-5')
    expect(gitHeadMessage(dir)).toBe(
      'kb(update): /sub/m.md\n\nKnowledge-Op: update\nKnowledge-Actor: shuvix-work/gpt-5'
    )
    expect(events).toHaveLength(3)
  })
})

describe('管线容错', () => {
  it('CH-4 投影抛错：flushKnowledgeChanges 仍 resolve、事件照发、记一条 warn', async () => {
    vi.resetModules()
    vi.doMock('../projection', () => ({
      projectBundle: vi.fn(async () => {
        throw new Error('boom')
      })
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
      vi.doUnmock('../projection')
      vi.resetModules()
    }
  })
})
