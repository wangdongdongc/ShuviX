/**
 * root —— 根目录懒初始化：mkdir `global/`、投影 index/log、git init + 基线提交。
 * 幂等且串行：再调不重复提交，并发调用只初始化一次。
 *
 * **不写任何规范文件**：编辑规范住在内置 knowledge-writer 的提示词里。曾经这里会种一份
 * SCHEMA.md 到用户目录，那份文件一落盘就再也更新不了（后续版本不敢覆盖用户的改动），
 * 而 agent 又被要求遵循它 —— 拆掉之后 bundle 里只剩条目。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

import { ensureKnowledgeRoot, isKnowledgeRootInitialized } from '../root'
import { invalidateKnowledgeScan } from '../scan'
import { gitCommitCount, gitLog, makeTempRoot } from './fixture'

let root: string

beforeEach(() => {
  root = makeTempRoot()
  state.root = root
  invalidateKnowledgeScan()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('ensureKnowledgeRoot', () => {
  it('RT-1 首次：建 global/、投影根 index（okf_version）与空 log、git 基线提交；不写任何规范文件', async () => {
    expect(isKnowledgeRootInitialized()).toBe(false)
    expect(await ensureKnowledgeRoot()).toBe(root)
    expect(isKnowledgeRootInitialized()).toBe(true)

    expect(existsSync(join(root, 'global', 'index.md'))).toBe(true)
    const index = readFileSync(join(root, 'index.md'), 'utf-8')
    expect(index.startsWith('---\nokf_version: "0.2"\n---\n\n')).toBe(true)
    expect(index).toContain('## Global memory')
    // 空库没有根级概念，也就没有 Bundle 节
    expect(index).not.toContain('## Bundle')
    expect(existsSync(join(root, '.git'))).toBe(true)
    expect(gitLog(root, '%s')).toEqual(['kb(init): knowledge base'])

    // 规范文件不再随初始化落盘（它住在 agent 提示词里）
    expect(existsSync(join(root, 'SCHEMA.md'))).toBe(false)
    // log.md 是变更日志：初始化本身不是一次变更，空库里它还不存在，第一条变更才写出来
    expect(existsSync(join(root, 'log.md'))).toBe(false)
  })

  it('RT-2 幂等：再调不重复提交、用户自己放的根级文件原样保留；并发两次只初始化一次', async () => {
    await ensureKnowledgeRoot()
    // 用户自己往根目录放的文件（宿主既不种也不动它）
    writeFileSync(join(root, 'NOTES.md'), '---\ntype: Guide\ntitle: Mine\n---\n\nkeep\n')
    await ensureKnowledgeRoot()
    expect(readFileSync(join(root, 'NOTES.md'), 'utf-8')).toContain('keep')
    expect(gitCommitCount(root)).toBe(1)

    const fresh = makeTempRoot()
    try {
      state.root = fresh
      invalidateKnowledgeScan()
      await Promise.all([ensureKnowledgeRoot(), ensureKnowledgeRoot()])
      expect(gitCommitCount(fresh)).toBe(1)
    } finally {
      rmSync(fresh, { recursive: true, force: true })
    }
  })
})
