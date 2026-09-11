/**
 * paths —— 知识库 v2 的**两个根**：用户的库 `~/.shuvix/knowledge/` 与 ShuviX 维护的
 * `~/.shuvix/knowledge-shuvix/`。两者是并列的兄弟目录、名字不可互换（一个是容器，另一个的
 * 内容归宿主簿记），且都不自动创建 —— 目录的出现应当是写入的结果，不是启动的副作用。
 * HOME 指到临时目录（POSIX 上 os.homedir 读 $HOME）。
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent-user-data', isPackaged: false } }))

import { getShuvixKnowledgeRootDir, getUserKnowledgeRootDir } from '../paths'

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
  it('PA-1 两个根：knowledge-shuvix / knowledge 是 ~/.shuvix 下并列的两个目录，互不相同，调用不创建任何东西', () => {
    const shuvixRoot = join(HOME, '.shuvix', 'knowledge-shuvix')
    const userRoot = join(HOME, '.shuvix', 'knowledge')

    expect(getShuvixKnowledgeRootDir()).toBe(shuvixRoot)
    expect(getUserKnowledgeRootDir()).toBe(userRoot)
    expect(getShuvixKnowledgeRootDir()).not.toBe(getUserKnowledgeRootDir())

    // 懒建：读一遍路径不该把根（乃至 ~/.shuvix）建出来
    expect(existsSync(shuvixRoot)).toBe(false)
    expect(existsSync(userRoot)).toBe(false)
    expect(existsSync(join(HOME, '.shuvix'))).toBe(false)
  })
})
