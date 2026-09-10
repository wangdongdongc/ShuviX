/**
 * scan —— 根目录下全部 .md（ripgrep，跳过 .git）→ 概念清单，(mtime, size) 缓存；
 * 绑定概念（project.md / bot.md）按 `resource` 查目录，目录名只是 slug。
 * knowledgePaths 的 bundle 路径算术也在这里钉。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
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

import { fromBundlePath, toBundlePath } from '../knowledgePaths'
import {
  findBotDir,
  findProjectDir,
  invalidateKnowledgeScan,
  knownKnowledgePaths,
  scanKnowledge
} from '../scan'
import { conceptText, makeTempRoot, seedConcept, seedFile } from './fixture'

let root: string

beforeEach(() => {
  root = makeTempRoot()
  state.root = root
  invalidateKnowledgeScan()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('knowledgePaths', () => {
  it('SN-1 toBundlePath：根下 → forward-slash 相对路径；根本身 / 同前缀兄弟目录 → null；反斜杠归一；fromBundlePath 按平台分隔符拼', () => {
    expect(toBundlePath(join(root, 'global', 'x.md'))).toBe('global/x.md')
    expect(toBundlePath(root)).toBeNull()
    expect(toBundlePath(`${root}-other/x.md`)).toBeNull()
    expect(toBundlePath(`${root}\\global\\x.md`)).toBe('global/x.md')
    expect(fromBundlePath('projects/acme/x.md')).toBe(join(root, 'projects', 'acme', 'x.md'))
  })
})

describe('scanKnowledge', () => {
  it('SN-2 全部 .md（跳过 .git 与非 md），bundle 相对路径字典序；概念只算带 type 且无 shuvix 标记的；根目录不存在 → 空且不抛', async () => {
    seedFile(root, 'index.md', '---\nokf_version: "0.2"\n---\n')
    seedFile(root, 'log.md', '## 2026-09-09\n\n- x\n')
    seedFile(root, 'global/index.md', '')
    seedConcept(root, 'global/a.md', ['type: Memory', 'title: A', 'description: da'])
    seedFile(root, 'global/notes.md', '---\ntitle: notes\n---\n\nno type\n')
    seedFile(root, 'global/old.md', '---\nshuvix: memory v1\ntype: Memory\n---\n\nold\n')
    seedFile(root, '.git/x.md', '---\ntype: Memory\n---\n\nhidden\n')
    seedFile(root, 'raw/2026-x/original.txt', 'raw')

    const scan = await scanKnowledge()
    expect(scan.files.map((f) => f.path)).toEqual([
      'global/a.md',
      'global/index.md',
      'global/notes.md',
      'global/old.md',
      'index.md',
      'log.md'
    ])
    expect(scan.concepts.map((c) => c.path)).toEqual(['global/a.md'])
    expect(scan.files.find((f) => f.path === 'global/a.md')!.text).toContain('title: A')

    state.root = join(root, 'missing')
    invalidateKnowledgeScan()
    expect(await scanKnowledge()).toEqual({ files: [], concepts: [] })
  })

  it('SN-3 (mtime, size) 缓存：尺寸或 mtime 变即自然失效；同尺寸 + 同 mtime 的改写读不到，直到精确失效；删除的文件在下次扫描后从已知路径消失', async () => {
    const abs = seedConcept(root, 'global/a.md', ['type: Memory', 'title: A1', 'description: d'])
    const t1 = new Date(1_700_000_000_000)
    utimesSync(abs, t1, t1)
    expect((await scanKnowledge()).concepts[0].title).toBe('A1')
    expect(knownKnowledgePaths().has('global/a.md')).toBe(true)

    // 尺寸变 + mtime 变 → 自然失效
    writeFileSync(abs, conceptText(['type: Memory', 'title: A-long', 'description: d']))
    const t2 = new Date(1_700_000_001_000)
    utimesSync(abs, t2, t2)
    expect((await scanKnowledge()).concepts[0].title).toBe('A-long')

    // 同尺寸 + mtime 复原 → 命中缓存（陈旧）；精确失效后才读到新内容
    writeFileSync(abs, conceptText(['type: Memory', 'title: B-long', 'description: d']))
    utimesSync(abs, t2, t2)
    expect((await scanKnowledge()).concepts[0].title).toBe('A-long')
    invalidateKnowledgeScan('global/a.md')
    expect((await scanKnowledge()).concepts[0].title).toBe('B-long')

    unlinkSync(abs)
    expect((await scanKnowledge()).concepts).toEqual([])
    expect(knownKnowledgePaths().has('global/a.md')).toBe(false)
  })

  it('SN-4 绑定查找按 resource：目录名只是 slug；同 resource 落在别的顶层目录不算；未知 id → null；bot 同理', async () => {
    seedConcept(root, 'projects/acme-renamed/project.md', [
      'type: Project',
      'title: Acme',
      'resource: shuvix://project/p1'
    ])
    seedConcept(root, 'global/project.md', [
      'type: Project',
      'title: Stray',
      'resource: shuvix://project/p1'
    ])
    seedConcept(root, 'bots/alice/bot.md', [
      'type: Bot',
      'title: alice',
      'resource: shuvix://bot/alice'
    ])
    expect(await findProjectDir('p1')).toBe('projects/acme-renamed')
    expect(await findProjectDir('nope')).toBeNull()
    expect(await findBotDir('alice')).toBe('bots/alice')
    expect(await findBotDir('bob')).toBeNull()
  })
})
