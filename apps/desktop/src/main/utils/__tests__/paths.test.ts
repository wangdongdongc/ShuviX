/**
 * paths —— 知识库根目录与会话摘要目录清单（策略变量 vars.knowledgeSessionDirs 的数据源）：
 * 根目录不自动创建，清单每次现读。HOME 指到临时目录（POSIX 上 os.homedir 读 $HOME）。
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent-user-data', isPackaged: false } }))

import { getKnowledgeRootDir, listKnowledgeSessionDirs } from '../paths'

const HOME = mkdtempSync(join(tmpdir(), 'shuvix-paths-home-'))
const ORIGINAL_HOME = process.env.HOME

beforeAll(() => {
  process.env.HOME = HOME
})

afterAll(() => {
  process.env.HOME = ORIGINAL_HOME
  rmSync(HOME, { recursive: true, force: true })
})

describe('knowledge paths', () => {
  it('PA-1 根目录不自动创建；无根 → 只有顶层 sessions；projects/ 下每个目录各贡献一个 sessions（文件跳过），每次现读', () => {
    const root = join(HOME, '.shuvix', 'knowledge')
    expect(getKnowledgeRootDir()).toBe(root)
    expect(existsSync(root)).toBe(false)
    expect(listKnowledgeSessionDirs()).toEqual([join(root, 'sessions')])

    mkdirSync(join(root, 'projects', 'acme'), { recursive: true })
    mkdirSync(join(root, 'projects', 'beta'), { recursive: true })
    writeFileSync(join(root, 'projects', 'README.md'), 'not a project dir')
    const dirs = listKnowledgeSessionDirs()
    expect(dirs[0]).toBe(join(root, 'sessions'))
    expect(dirs.slice(1).sort()).toEqual([
      join(root, 'projects', 'acme', 'sessions'),
      join(root, 'projects', 'beta', 'sessions')
    ])
    expect(dirs).toHaveLength(3)
  })
})
