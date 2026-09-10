/**
 * projectKnowledgeBundle —— 每次变更后全库重投影 index.md、追加 log.md，逐份比对只写有变化的。
 * 空的作用域目录（磁盘上有、没概念）也要有 index；隐藏子目录不算；再投影无变化时返回空数组。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const state = vi.hoisted(() => ({ root: '' }))

vi.mock('../../../utils/paths', () => ({
  getKnowledgeRootDir: () => state.root,
  getProjectMemoryDir: (id: string) => `${state.root}-memory/${id}`,
  listKnowledgeSessionDirs: () => []
}))
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

import { projectKnowledgeBundle } from '../projection'
import { invalidateKnowledgeScan, scanKnowledge } from '../scan'
import { makeTempRoot, seedConcept, seedFile } from './fixture'

let root: string

beforeEach(() => {
  root = makeTempRoot()
  state.root = root
  invalidateKnowledgeScan()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('projectKnowledgeBundle', () => {
  it('DP-1 概念目录、祖先目录与磁盘上空的作用域目录都得到 index（隐藏子目录除外）；带事件时追加 log；再投影无变化 → 空数组、log 不追加', async () => {
    seedConcept(root, 'global/a.md', ['type: Memory', 'title: A', 'description: da'])
    seedConcept(root, 'projects/acme/x.md', ['type: Memory', 'title: X', 'description: dx'])
    mkdirSync(join(root, 'bots'), { recursive: true })
    mkdirSync(join(root, 'projects', '.hidden'), { recursive: true })

    const written = await projectKnowledgeBundle({
      date: '2026-09-09',
      op: 'Creation',
      path: 'global/a.md',
      title: 'A',
      actor: 'shuvix-work/gpt-5'
    })
    expect([...written].sort()).toEqual(
      [
        'index.md',
        'global/index.md',
        'projects/index.md',
        'projects/acme/index.md',
        'bots/index.md',
        'log.md'
      ].sort()
    )
    expect(existsSync(join(root, 'projects', '.hidden', 'index.md'))).toBe(false)
    expect(readFileSync(join(root, 'global', 'index.md'), 'utf-8')).toBe(
      '## Entries\n\n* [A](a.md) - da\n'
    )
    // 空作用域目录的 index 是一份空文件，不是「无文件」
    expect(readFileSync(join(root, 'bots', 'index.md'), 'utf-8')).toBe('')
    const rootIndex = readFileSync(join(root, 'index.md'), 'utf-8')
    expect(rootIndex.startsWith('---\nokf_version: "0.2"\n---\n\n')).toBe(true)
    expect(rootIndex).toContain('## Global memory')
    expect(rootIndex).toContain('* [acme](projects/acme/index.md)')
    const log = readFileSync(join(root, 'log.md'), 'utf-8')
    expect(log).toBe('## 2026-09-09\n\n- **Creation** /global/a.md — A · by shuvix-work/gpt-5\n')

    expect(await projectKnowledgeBundle()).toEqual([])
    expect(readFileSync(join(root, 'log.md'), 'utf-8')).toBe(log)
  })

  it('DP-2 Update 事件带 title 与 actor 进 log；投影写出的 index 在下一次扫描里已是新内容（精确失效）', async () => {
    seedConcept(root, 'global/a.md', ['type: Memory', 'title: A', 'description: da'])
    seedFile(root, 'global/index.md', 'stale')
    await scanKnowledge()

    const written = await projectKnowledgeBundle({
      date: '2026-09-09',
      op: 'Update',
      path: 'global/a.md',
      title: 'A',
      actor: 'shuvix-work/gpt-5'
    })
    expect(written).toContain('global/index.md')
    expect(readFileSync(join(root, 'log.md'), 'utf-8')).toContain(
      '- **Update** /global/a.md — A · by shuvix-work/gpt-5'
    )
    const { files } = await scanKnowledge()
    expect(files.find((f) => f.path === 'global/index.md')!.text).toBe(
      '## Entries\n\n* [A](a.md) - da\n'
    )
  })
})
