/**
 * changes —— 宿主观察到的每一次知识库写入都经这条管线：失效缓存 → 重投影 index/log →
 * 排队 git 提交 → 广播 knowledge.changed。300ms 去抖合批：一批一个事件、逐条一行日志、一条提交。
 * `notifyKnowledgeFileChanged` 是文件工具那一侧的入口：按「扫描是否见过」区分新建 / 更新，
 * 保留文件只失效缓存。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const state = vi.hoisted(() => ({ root: '' }))
const logSpy = vi.hoisted(() => ({ warn: vi.fn() }))

vi.mock('../../../utils/paths', () => ({
  getKnowledgeRootDir: () => state.root,
  getProjectMemoryDir: (id: string) => `${state.root}-memory/${id}`,
  listKnowledgeSessionDirs: () => []
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
import { ensureKnowledgeRoot } from '../root'
import { invalidateKnowledgeScan, knownKnowledgePaths, scanKnowledge } from '../scan'
import { conceptText, gitCommitCount, gitHeadMessage, makeTempRoot, seedConcept } from './fixture'

const ACTOR = 'shuvix-work/gpt-5'

let root: string
let events: unknown[]
let unsubscribe: () => void

beforeEach(() => {
  root = makeTempRoot()
  state.root = root
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

/** 变更日志。空库没有它 —— 初始化本身不是一次变更，第一条变更才把它写出来 */
const readLog = (): string => {
  try {
    return readFileSync(join(root, 'log.md'), 'utf-8')
  } catch {
    return ''
  }
}

describe('recordKnowledgeChange', () => {
  it('CH-1 一条变更 → 去抖后：index 重投影、log 追加带 actor 的一行、一次提交、恰一个 knowledge.changed；窗口内两条 → 一个事件、两行日志、一条 batch 提交', async () => {
    await ensureKnowledgeRoot()
    seedConcept(root, 'global/a.md', [
      'type: Memory',
      'title: A',
      'description: da',
      'status: draft'
    ])

    recordKnowledgeChange({ path: 'global/a.md', op: 'Creation', title: 'A', actor: ACTOR })
    // 返回即在后台跑：事件在去抖之后
    expect(events).toEqual([])
    await flushKnowledgeChanges()
    expect(readFileSync(join(root, 'global', 'index.md'), 'utf-8')).toBe(
      '## Entries\n\n* [A](a.md) - da\n'
    )
    expect(readLog()).toContain('- **Creation** /global/a.md — A · by shuvix-work/gpt-5')
    expect(gitHeadMessage(root)).toBe(
      'kb(creation): /global/a.md\n\nKnowledge-Op: creation\nKnowledge-Actor: shuvix-work/gpt-5'
    )
    expect(events).toEqual([{ type: 'knowledge.changed' }])
    const commits = gitCommitCount(root)

    seedConcept(root, 'global/b.md', [
      'type: Memory',
      'title: B',
      'description: db',
      'status: draft'
    ])
    writeFileSync(
      join(root, 'global', 'a.md'),
      conceptText(['type: Memory', 'title: A2', 'description: da2', 'status: draft'])
    )
    recordKnowledgeChange({ path: 'global/b.md', op: 'Creation', title: 'B', actor: ACTOR })
    recordKnowledgeChange({ path: 'global/a.md', op: 'Update', title: 'A2', actor: ACTOR })
    await flushKnowledgeChanges()
    expect(events).toHaveLength(2)
    expect(readLog()).toContain('- **Creation** /global/b.md — B · by shuvix-work/gpt-5')
    expect(readLog()).toContain('- **Update** /global/a.md — A2 · by shuvix-work/gpt-5')
    expect(gitCommitCount(root)).toBe(commits + 1)
    expect(gitHeadMessage(root)).toContain('kb(batch): 2 changes')
    expect(readFileSync(join(root, 'global', 'index.md'), 'utf-8')).toBe(
      '## Entries\n\n* [A2](a.md) - da2\n* [B](b.md) - db\n'
    )
  })
})

describe('notifyKnowledgeFileChanged', () => {
  it('CH-2 判定表：根外 / 非 md → 无事；保留文件 → 只失效缓存；新路径 write → Creation；已知路径 write → Update；未知路径 edit → Update；actor 进日志与 trailer', async () => {
    await ensureKnowledgeRoot()
    const baseline = gitCommitCount(root)
    const logBefore = readLog()

    notifyKnowledgeFileChanged('/elsewhere/x.md', { kind: 'write' })
    notifyKnowledgeFileChanged(join(root, 'x.txt'), { kind: 'write' })
    await flushKnowledgeChanges()
    expect(events).toEqual([])
    expect(gitCommitCount(root)).toBe(baseline)
    expect(readLog()).toBe(logBefore)

    // 保留文件：宿主投影维护，agent 直写只失效缓存 —— 不记日志、不提交、不发事件
    await scanKnowledge()
    expect(knownKnowledgePaths().has('global/index.md')).toBe(true)
    notifyKnowledgeFileChanged(join(root, 'global', 'index.md'), { kind: 'write' })
    expect(knownKnowledgePaths().has('global/index.md')).toBe(false)
    await flushKnowledgeChanges()
    expect(events).toEqual([])
    expect(gitCommitCount(root)).toBe(baseline)
    expect(readLog()).toBe(logBefore)

    // 扫描没见过的路径 + write → Creation
    const n = seedConcept(root, 'global/n.md', [
      'type: Memory',
      'title: N',
      'description: dn',
      'status: draft'
    ])
    notifyKnowledgeFileChanged(n, { kind: 'write', actor: ACTOR })
    await flushKnowledgeChanges()
    expect(readLog()).toContain('- **Creation** /global/n.md · by shuvix-work/gpt-5')
    expect(gitHeadMessage(root)).toBe(
      'kb(creation): /global/n.md\n\nKnowledge-Op: creation\nKnowledge-Actor: shuvix-work/gpt-5'
    )
    expect(events).toHaveLength(1)

    // 已知路径 + write → Update
    await scanKnowledge()
    writeFileSync(n, conceptText(['type: Memory', 'title: N2', 'description: dn', 'status: draft']))
    notifyKnowledgeFileChanged(n, { kind: 'write', actor: ACTOR })
    await flushKnowledgeChanges()
    expect(readLog()).toContain('- **Update** /global/n.md · by shuvix-work/gpt-5')
    expect(gitHeadMessage(root)).toContain('kb(update): /global/n.md')

    // 没见过的路径 + edit → 仍是 Update（edit 只可能发生在已有文件上）
    const m = seedConcept(root, 'global/m.md', [
      'type: Memory',
      'title: M',
      'description: dm',
      'status: draft'
    ])
    notifyKnowledgeFileChanged(m, { kind: 'edit', actor: ACTOR })
    await flushKnowledgeChanges()
    expect(readLog()).toContain('- **Update** /global/m.md · by shuvix-work/gpt-5')
    expect(gitHeadMessage(root)).toBe(
      'kb(update): /global/m.md\n\nKnowledge-Op: update\nKnowledge-Actor: shuvix-work/gpt-5'
    )
    expect(events).toHaveLength(3)
  })
})

describe('管线容错', () => {
  it('CH-3 投影抛错：flushKnowledgeChanges 仍 resolve、事件照发、记一条 warn', async () => {
    vi.resetModules()
    vi.doMock('../projection', () => ({
      projectKnowledgeBundle: vi.fn(async () => {
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
        changes.recordKnowledgeChange({ path: 'global/a.md', op: 'Creation' })
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
