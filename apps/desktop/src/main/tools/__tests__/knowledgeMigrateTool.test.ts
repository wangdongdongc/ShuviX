/**
 * knowledge 工具的迁移 —— 桌面注入的那三样（tools/knowledge.ts；docs/project-split-design.md §5）。工具内核的行为在
 * agent-runtime 的 knowledgeMigrate.test.ts；这里钉宿主一侧：
 *
 *   TM-1  带 `project` 的读：另一个项目的库按**会话 + 项目名**解析（projectBaseNamed），读之前过一次路径门 ——
 *         enforcePath('read', <库目录>)，给模型看的名字是「the knowledge base of project …」，不带说明
 *   TM-2  migrate 全程：写门（带一句给人看的说明）→ 派管理员（迁移的任务文本、迁移的结果契约、description
 *         「Migrate into <base>」）→ 它收下的条目从源库的磁盘上删掉，每条记一笔 Deletion（actor 是发起迁移的 agent、
 *         movedTo 是目标库的标签）；目标库里它写的条目照 submit 盖章；回包里没有任何库目录
 *   TM-3  收下了却删不掉（文件已经不在）：那一条列在「Taken in but still in …」里，只给错误码，不记 Deletion
 *   TM-4  写门被拒：失败，管理员不派，源库不动
 *   TM-5  submit 不受影响：照旧是提交的结果契约与「Record in <base>」
 *
 * services/knowledge 只替到接口那一层：locateBundle / bundleFilePath 用真的；扫描替身读临时目录里的真文件；变更管线、
 * 路径门（getDesktopSecurityContext）、管理员的派发（runTask）是替身。文件是真的（临时目录）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { failureText, invokeTool } from '@shuvix/agent-runtime/tools/testing/invokeTool'

const state = vi.hoisted(() => ({
  root: '',
  record: vi.fn(),
  resolveBase: vi.fn(),
  projectBase: vi.fn(),
  scan: vi.fn(),
  getProfile: vi.fn(),
  runTask: vi.fn(),
  enforcePath: vi.fn(),
  securityContext: vi.fn()
}))

vi.mock('../../utils/paths', () => ({
  getShuvixKnowledgeRootDir: () => state.root,
  getUserKnowledgeRootDir: () => `${state.root}-user`,
  getBuiltinKnowledgeDir: () => `${state.root}-builtin`
}))
vi.mock('../../services/knowledge', async () => {
  const real = await vi.importActual<typeof import('../../services/knowledge/knowledgePaths')>(
    '../../services/knowledge/knowledgePaths'
  )
  return {
    locateBundle: real.locateBundle,
    bundleFilePath: real.bundleFilePath,
    recordKnowledgeChange: state.record,
    listBases: vi.fn(async () => []),
    resolveBase: state.resolveBase,
    projectBaseNamed: state.projectBase,
    scanBundle: state.scan,
    searchBundle: vi.fn(async () => [])
  }
})
vi.mock('../../services/toolRegistry', () => ({ registerBuiltinTool: () => {} }))
vi.mock('../../services/toolContext', () => ({
  resolveProjectConfig: () => ({ workingDirectory: '/probe-ws' }),
  getDesktopSecurityContext: state.securityContext,
  TOOL_ABORTED: 'Aborted'
}))
vi.mock('../../services/agentService', () => ({
  agentService: { getProfile: state.getProfile }
}))
vi.mock('../../agents/AgentManager', () => ({ agentManager: { runTask: state.runTask } }))
vi.mock('../../i18n', () => ({ t: (k: string) => k }))
vi.mock('i18next', () => ({ default: { language: 'en', t: (key: string) => `i18n(${key})` } }))

import {
  KNOWLEDGE_ADMIN_CONTRACT,
  KNOWLEDGE_MIGRATION_CONTRACT,
  buildKnowledgeAdminPrompt,
  readKnowledgeNote,
  type AgentProfile,
  type KnowledgeBundleScan
} from '@shuvix/agent-runtime'
import { makeKnowledgeTool } from '../knowledge'
import type { ToolContext } from '../../services/toolContext'

const SUBMITTER = 'shuvix-work/gpt-5'
const ADMIN_CONVERSATION = 2
const identity = (
  profileName: string,
  model: string,
  kind: 'root' | 'spawned' = 'root'
): NonNullable<ToolContext['agent']> => ({
  profileName,
  kind,
  getModelConfig: () => ({ provider: 'anthropic', model, capabilities: {} })
})
const ctx: ToolContext = {
  sessionId: 's1',
  agentOf: (c: number) =>
    c === ADMIN_CONVERSATION
      ? identity('knowledge-writer', 'claude-haiku-4-5', 'spawned')
      : identity('work', 'gpt-5')
}

const targetDir = (): string => join(state.root, 'projects', 'acme')
const sourceDir = (): string => join(state.root, 'projects', 'big')
const TARGET_LABEL = 'project "Acme"'
const SOURCE_LABEL = 'project "Big"'

const okf = (title: string, body = 'What holds.'): string =>
  [
    '---',
    'shuvix: okf v0.2',
    'type: Memory',
    `title: ${title}`,
    `description: when touching ${title.toLowerCase()}`,
    'status: stable',
    '---',
    '',
    body,
    ''
  ].join('\n')

const LOGIN = okf('Login')
const REFRESH = okf('Refresh')

const seed = (dir: string, rel: string, text: string): void => {
  const abs = join(dir, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, text, 'utf-8')
}
const treeOf = (dir: string): string[] => {
  try {
    return readdirSync(dir, { recursive: true })
      .map((p) => String(p).replace(/\\/g, '/'))
      .filter((p) => p.endsWith('.md'))
      .sort()
  } catch {
    return []
  }
}
const scanDir = (dir: string): KnowledgeBundleScan => {
  const files = treeOf(dir).map((p) => ({ path: p, text: readFileSync(join(dir, p), 'utf-8') }))
  const notes = files.map((f) => readKnowledgeNote(f.text, f.path))
  return { files, concepts: notes.flatMap((n) => (n.concept ? [n.concept] : [])), notes }
}

const adminProfile: AgentProfile = {
  name: 'knowledge-writer',
  displayName: 'Knowledge librarian',
  description: 'keeps the knowledge bases',
  systemPrompt: 'librarian prompt',
  tools: ['read', 'write', 'edit', 'move', 'delete', 'knowledge'],
  promptBlocks: [],
  source: 'builtin',
  basePath: ''
}

/** 把交来的条目原样写进目标库、全部收下的管理员（任务文本里读得到目标库目录与每条的原路径） */
const takesAll =
  (opts: { before?: () => void } = {}) =>
  async (params: { prompt: string }) => {
    const dir = / — directory (.+)$/m.exec(params.prompt)![1]
    const taken: string[] = []
    const entries: Array<{ entry: string; change: string }> = []
    for (const m of params.prompt.matchAll(/<entry path="\/([^"]+)">\n([\s\S]*?)\n<\/entry>/g)) {
      seed(dir, m[1], `${m[2]}\n`)
      taken.push(`/${m[1]}`)
      entries.push({ entry: `/${m[1]}`, change: 'created' })
    }
    opts.before?.()
    const structured = { accepted: true, entries, taken, report: `Filed under ${dir}/auth.` }
    return { result: JSON.stringify(structured), structured, conversationId: ADMIN_CONVERSATION }
  }

const migrate = async (
  entries = ['/auth/login.md', '/auth/refresh.md']
): Promise<Awaited<ReturnType<typeof invokeTool>>['result']> =>
  (
    await invokeTool(
      makeKnowledgeTool(ctx),
      { action: 'migrate', project: 'Big', base: 'project', entries },
      { callId: 'call-migrate', conversationId: 1 }
    )
  ).result

const textOf = (res: { content: unknown[] }): string => (res.content[0] as { text: string }).text

beforeAll(() => {
  state.root = mkdtempSync(join(tmpdir(), 'shuvix-knowledge-migrate-'))
})
afterAll(() => {
  rmSync(state.root, { recursive: true, force: true })
})

beforeEach(() => {
  rmSync(join(state.root, 'projects'), { recursive: true, force: true })
  seed(sourceDir(), 'auth/login.md', LOGIN)
  seed(sourceDir(), 'auth/refresh.md', REFRESH)
  seed(sourceDir(), 'release.md', okf('Release', 'See [login](/auth/login.md).'))
  mkdirSync(targetDir(), { recursive: true })
  for (const fn of Object.values(state)) if (typeof fn === 'function') fn.mockReset()
  state.resolveBase.mockImplementation(async () => ({
    bundle: 'projects/acme',
    dir: targetDir(),
    label: TARGET_LABEL
  }))
  state.projectBase.mockImplementation(() => ({
    bundle: 'projects/big',
    dir: sourceDir(),
    label: SOURCE_LABEL
  }))
  state.scan.mockImplementation(async (bundle: string) => scanDir(join(state.root, bundle)))
  state.getProfile.mockReturnValue(adminProfile)
  state.runTask.mockImplementation(takesAll())
  state.enforcePath.mockResolvedValue(undefined)
  state.securityContext.mockReturnValue({ enforcePath: state.enforcePath })
})

describe('knowledge 工具的迁移 —— 桌面注入（TM）', () => {
  it('TM-1 带 project 的读：按会话 + 项目名解析，读之前过一次路径门（read、库目录、给模型看的名字不是目录、没有说明）', async () => {
    const res = (
      await invokeTool(
        makeKnowledgeTool(ctx),
        { action: 'list', project: 'Big' },
        { callId: 'call-list', conversationId: 1 }
      )
    ).result
    expect(textOf(res).split('\n')[0]).toBe('3 entries in the base of project "Big":')
    expect(state.projectBase).toHaveBeenCalledWith('s1', 'Big')
    expect(state.resolveBase).not.toHaveBeenCalled()

    expect(state.securityContext).toHaveBeenCalledTimes(1)
    const [gotCtx, getConfig] = state.securityContext.mock.calls[0]
    expect(gotCtx).toBe(ctx)
    expect(getConfig()).toEqual({ workingDirectory: '/probe-ws' })
    expect(state.enforcePath).toHaveBeenCalledTimes(1)
    const [access, path, opts] = state.enforcePath.mock.calls[0]
    expect(access).toBe('read')
    expect(path).toBe(sourceDir())
    expect(opts).toMatchObject({
      toolCallId: 'call-list',
      conversationId: 1,
      toolName: 'knowledge',
      displayPath: 'the knowledge base of project "Big"',
      abortError: 'Aborted'
    })
    expect(opts).not.toHaveProperty('description')
    expect(textOf(res)).not.toContain(state.root)
  })

  it('TM-2 migrate：写门带说明 → 管理员拿迁移的任务文本与结果契约 → 收下的从源库磁盘上删掉并各记一笔 Deletion（带 movedTo）；目标库的条目盖章；回包里没有库目录', async () => {
    const res = await migrate()
    const out = textOf(res)
    expect(res.isError).not.toBe(true)

    // 写门：收下的条目要从那边删
    expect(state.enforcePath).toHaveBeenCalledTimes(1)
    const [access, path, opts] = state.enforcePath.mock.calls[0]
    expect(access).toBe('write')
    expect(path).toBe(sourceDir())
    expect(opts).toMatchObject({
      toolCallId: 'call-migrate',
      toolName: 'knowledge',
      displayPath: 'the knowledge base of project "Big"',
      description:
        'Migrate 2 knowledge entries from project "Big" into base "project" (project "Acme"). The ones the librarian takes in are removed from project "Big".'
    })

    // 管理员：迁移的任务文本、迁移的契约
    expect(state.runTask).toHaveBeenCalledTimes(1)
    const task = state.runTask.mock.calls[0][0]
    expect(task.resultContract).toBe(KNOWLEDGE_MIGRATION_CONTRACT)
    expect(task.description).toBe('Migrate into project')
    expect(task.sessionId).toBe('s1')
    expect(task.oneShot).toBe(true)
    expect(task.prompt).toBe(
      buildKnowledgeAdminPrompt({
        base: 'project',
        label: TARGET_LABEL,
        bundleDir: targetDir(),
        content: '',
        submittedBy: SUBMITTER,
        migration: {
          from: SOURCE_LABEL,
          entries: [
            { entry: 'auth/login.md', text: LOGIN },
            { entry: 'auth/refresh.md', text: REFRESH }
          ]
        }
      })
    )
    // 源库的目录不给管理员
    expect(task.prompt).not.toContain(sourceDir())

    // 源库：收下的两条没了，没点名的还在
    expect(treeOf(sourceDir())).toEqual(['release.md'])
    // 目标库：两条都在，章是提交那一套
    expect(treeOf(targetDir())).toEqual(['auth/login.md', 'auth/refresh.md'])
    const stamped = readFileSync(join(targetDir(), 'auth/login.md'), 'utf-8')
    expect(stamped).toContain(`generated: { by: "${SUBMITTER}"`)
    expect(stamped).toContain('verified: { by: "shuvix-knowledge-writer/claude-haiku-4-5"')

    // 变更管线：目标库两笔盖章的 Update，源库两笔 Deletion（带去向）
    const records = state.record.mock.calls.map((c) => c[0])
    expect(records.filter((r) => r.op === 'Deletion')).toEqual([
      {
        bundle: 'projects/big',
        path: 'auth/login.md',
        op: 'Deletion',
        actor: SUBMITTER,
        movedTo: TARGET_LABEL
      },
      {
        bundle: 'projects/big',
        path: 'auth/refresh.md',
        op: 'Deletion',
        actor: SUBMITTER,
        movedTo: TARGET_LABEL
      }
    ])
    expect(records.filter((r) => r.op === 'Update').map((r) => [r.bundle, r.path])).toEqual([
      ['projects/acme', 'auth/login.md'],
      ['projects/acme', 'auth/refresh.md']
    ])

    expect(out).toContain(
      'Removed from the base of project "Big": /auth/login.md, /auth/refresh.md.'
    )
    expect(out).toContain('- /release.md → /auth/login.md')
    // 管理员报告里的目标库目录换成条目名的写法；哪个库的目录都不出现
    expect(out).toContain('Filed under /auth.')
    expect(out).not.toContain(state.root)
  })

  it('TM-3 收下了却删不掉（文件已经不在）：列在「Taken in but still in …」里，只给错误码；不记那一笔 Deletion', async () => {
    state.runTask.mockImplementation(
      takesAll({ before: () => rmSync(join(sourceDir(), 'auth/login.md')) })
    )
    const out = textOf(await migrate())
    expect(out).toContain('Removed from the base of project "Big": /auth/refresh.md.')
    expect(out).toContain(
      'Taken in but still in the base of project "Big": /auth/login.md (could not be deleted (ENOENT)).'
    )
    expect(out).not.toContain(state.root)
    const deletions = state.record.mock.calls.map((c) => c[0]).filter((r) => r.op === 'Deletion')
    expect(deletions.map((r) => r.path)).toEqual(['auth/refresh.md'])
  })

  it('TM-4 写门被拒：失败；管理员不派，源库不动，什么都没记', async () => {
    state.enforcePath.mockRejectedValue(
      new Error('User denied access to the knowledge base of project "Big"')
    )
    const failure = await failureText(migrate())
    expect(failure.split('\n')[0]).toBe('User denied access to the knowledge base of project "Big"')
    expect(failure).toContain('Nothing was migrated; do not try again unless the user asks.')
    expect(state.runTask).not.toHaveBeenCalled()
    expect(treeOf(sourceDir())).toEqual(['auth/login.md', 'auth/refresh.md', 'release.md'])
    expect(existsSync(join(targetDir(), 'auth'))).toBe(false)
    expect(state.record).not.toHaveBeenCalled()
  })

  it('TM-5 submit 不受影响：提交的结果契约、「Record in <base>」，不过路径门', async () => {
    state.runTask.mockImplementation(async () => {
      const structured = { accepted: true, entries: [], report: 'Recorded.' }
      return { result: JSON.stringify(structured), structured, conversationId: ADMIN_CONVERSATION }
    })
    await invokeTool(
      makeKnowledgeTool(ctx),
      { action: 'submit', base: 'project', content: '# T\n\nx' },
      { callId: 'call-submit', conversationId: 1 }
    )
    const task = state.runTask.mock.calls[0][0]
    expect(task.resultContract).toBe(KNOWLEDGE_ADMIN_CONTRACT)
    expect(task.description).toBe('Record in project')
    expect(state.enforcePath).not.toHaveBeenCalled()
  })
})
