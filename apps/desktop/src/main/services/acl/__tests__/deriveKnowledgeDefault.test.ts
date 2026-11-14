/**
 * 内置说明书落到权限表上（ACL-D1）：它对每条会话都是隐式的（2026-11-14 裁决：始终可查，不是选项），派生行里
 * 总有一行只读的 `shuvix`、排在项目库和用户勾的库之后，agent 读说明书才不用问；显式的 `[]` 也去不掉它。
 *
 * derive.test.ts 把 enabledTargets 整个换成了假实现，看不到回落链，所以这里单开一份：**真的 derive + 真的
 * sessionBundle**，只替掉 dao、路径与会话目录。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const state = vi.hoisted(() => ({ root: '' }))

vi.mock('../../../utils/paths', () => ({
  getShuvixKnowledgeRootDir: () => state.root,
  getUserKnowledgeRootDir: () => `${state.root}-user`,
  getBuiltinKnowledgeDir: () => `${state.root}-builtin`,
  getBuiltinSkillsDir: () => '/app/skills/en',
  widgetDirPath: (id: string) => `/Users/u/.shuvix/widgets/${id}`
}))
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))
vi.mock('i18next', () => ({ default: { language: 'en', t: (key: string) => key } }))
vi.mock('../../../dao/projectDao', () => ({ projectDao: { findById: vi.fn(), pick: vi.fn() } }))
vi.mock('../../../dao/sessionDao', () => ({
  sessionDao: { pick: vi.fn(), pickSettings: vi.fn(() => ({ notebookPath: null })) }
}))
vi.mock('../workdir', () => ({ sessionWorkingDirectory: () => '/Users/u/proj' }))
vi.mock('../../sandbox', () => ({
  sessionOwnDirsView: () => ({
    workdir: '/Users/u/proj',
    workspaceUnsuitable: null,
    tmp: '/private/tmp/shuvix-501/abcd1234',
    artifacts: '/Users/u/.shuvix/artifacts/s1',
    toolResults: '/Users/u/Library/Application Support/ShuviX/tool_results/s1'
  }),
  settingDirForAcl: (dir: string) => dir
}))

import { projectDao } from '../../../dao/projectDao'
import { sessionDao } from '../../../dao/sessionDao'
import {
  builtinLangAt,
  builtinRootOf,
  bundleAt,
  makeTempRoot,
  userRootOf
} from '../../knowledge/__tests__/fixture'
import { derivePathEntries, type DerivedPathEntry } from '../derive'

const PROJECT = {
  id: 'p1',
  name: 'Acme Corp',
  path: '/repos/acme',
  systemPrompt: '',
  settings: {},
  archivedAt: 0,
  createdAt: 1,
  updatedAt: 1
}

const mockSession = (row: Record<string, unknown>): void => {
  vi.mocked(sessionDao.pick).mockImplementation(((id: string) =>
    id === 's1' ? row : undefined) as unknown as typeof sessionDao.pick)
}
const knowledgeRows = (): DerivedPathEntry[] =>
  derivePathEntries('s1').filter((e) => e.source === 'knowledge')

let root = ''

beforeEach(() => {
  vi.mocked(projectDao.findById).mockReset()
  vi.mocked(projectDao.pick).mockReset()
  root = makeTempRoot()
  state.root = root
  mkdirSync(builtinLangAt(root, 'shuvix', 'en'), { recursive: true })
  mkdirSync(join(userRootOf(root), 'notes'), { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(userRootOf(root), { recursive: true, force: true })
  rmSync(builtinRootOf(root), { recursive: true, force: true })
})

describe('ACL-D1 隐式的内置说明书在权限表里', () => {
  it('ACL-D1 谁都没设过：有一行只读的 shuvix，没有 write；项目会话排在项目库之后，用户库不进表', () => {
    const manual = {
      source: 'knowledge',
      sourceKey: 'shuvix',
      target: builtinLangAt(root, 'shuvix', 'en'),
      access: 'read'
    }

    mockSession({ projectId: null })
    expect(knowledgeRows()).toEqual([manual])

    mockSession({ projectId: 'p1' })
    vi.mocked(projectDao.findById).mockReturnValue(PROJECT)
    expect(knowledgeRows()).toEqual([
      {
        source: 'knowledge',
        sourceKey: 'project',
        target: bundleAt(root, 'projects/p1'),
        access: 'write'
      },
      manual
    ])
  })

  it('ACL-D1 显式的 [] 也有说明书那一行（只读）；勾上的用户库排在它前面', () => {
    const manualTarget = builtinLangAt(root, 'shuvix', 'en')

    mockSession({ projectId: null, settings: { knowledgeBases: [] } })
    expect(knowledgeRows()).toEqual([
      { source: 'knowledge', sourceKey: 'shuvix', target: manualTarget, access: 'read' }
    ])

    mockSession({ projectId: 'p1', settings: { knowledgeBases: [] } })
    vi.mocked(projectDao.findById).mockReturnValue(PROJECT)
    expect(knowledgeRows().map((e) => e.sourceKey)).toEqual(['project', 'shuvix'])

    // 选择里写了 shuvix：不重复；用户库在说明书之前
    mockSession({ projectId: 'p1', settings: { knowledgeBases: ['shuvix', 'notes'] } })
    expect(knowledgeRows().map((e) => [e.sourceKey, e.access])).toEqual([
      ['project', 'write'],
      ['notes', 'write'],
      ['shuvix', 'read']
    ])
  })

  it('ACL-D1 说明书目录不在：没有 shuvix 这一行、不抛', () => {
    rmSync(builtinRootOf(root), { recursive: true, force: true })
    mockSession({ projectId: null })
    expect(knowledgeRows()).toEqual([])
  })
})
