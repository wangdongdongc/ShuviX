/**
 * knowledge 工具（桌面注册）—— 复用 agent-runtime 的共享内核，桌面只注入端适配。钉：
 *
 *   TK-1        注册元数据（name / group / presentation / describe）
 *   TK-2′..TK-10 目标库按**会话 + base** 解析（`project` 是根会话所属项目的库，其余名字是用户库 / 内置库），
 *               拿到的 bundle 目录再反查回 bundle id（`projects/<id>` / `knowledge/<库名>` / `builtin/<库名>`）
 *               交给扫描 / 检索；`bases` 直接走宿主的 listBases；submit 打到内置库由工具自己拒
 *   TR-1..TR-15 `submit` 的宿主一半（runReview）：与 `agent` 工具同一条派发路由同步派写手（子对话挂在这次
 *               工具调用下、带结果契约），通过后盖章 —— `generated` 是**提交者**（按这次调用认人），`verified`
 *               是**写手那条对话**现取的身份；变更管线记一笔 `Update`
 *
 * services/knowledge 只替到接口那一层：locateBundle 用**真的**（目录 → bundle id 这条往返正是适配层的实质），
 * 扫描 / 检索 / 变更管线是替身。写手的派发路由（agentManager.runTask）与档案表（agentService.getProfile）
 * 是替身 —— runTask 替身像写手那样把文件改成带元数据的条目、交回契约结果；toInProcessAgentType、
 * buildKnowledgeReviewPrompt、KNOWLEDGE_REVIEW_CONTRACT 用真件。文件是真的（临时目录）。
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  executeTool,
  failureText,
  invokeTool
} from '@shuvix/agent-runtime/tools/testing/invokeTool'

const state = vi.hoisted(() => ({
  root: '',
  registered: [] as Array<Record<string, unknown>>,
  record: vi.fn(),
  resolveBase: vi.fn(),
  listBases: vi.fn(),
  search: vi.fn(),
  scan: vi.fn(),
  /** PEP：getDesktopSecurityContext 每次都交回同一个 spy，便于断言时序 */
  enforcePath: vi.fn(),
  getProfile: vi.fn(),
  runTask: vi.fn()
}))

vi.mock('../../utils/paths', () => ({
  getShuvixKnowledgeRootDir: () => state.root,
  getUserKnowledgeRootDir: () => `${state.root}-user`,
  // 内置库根替身：root 的兄弟目录 —— 缺省不存在，TK-6..TK-10 自己种
  getBuiltinKnowledgeDir: () => `${state.root}-builtin`
}))
vi.mock('../../services/knowledge', async () => {
  const real = await vi.importActual<typeof import('../../services/knowledge/knowledgePaths')>(
    '../../services/knowledge/knowledgePaths'
  )
  return {
    locateBundle: real.locateBundle,
    recordKnowledgeChange: state.record,
    listBases: state.listBases,
    resolveBase: state.resolveBase,
    scanBundle: state.scan,
    searchBundle: state.search
  }
})
vi.mock('../../services/toolRegistry', () => ({
  registerBuiltinTool: (meta: Record<string, unknown>) => {
    state.registered.push(meta)
  }
}))
vi.mock('../../services/toolContext', () => ({
  getDesktopSecurityContext: () => ({ enforcePath: state.enforcePath }),
  // 写手的任务文本带提交会话的工作目录（条目里的相对路径据此解析）
  resolveProjectConfig: () => ({ workingDirectory: '/probe-ws' }),
  TOOL_ABORTED: 'Aborted'
}))
// 写手的档案表与派发路由：真 agentService 会扫 ~/.shuvix/agents，真 AgentManager 连着整套运行时
vi.mock('../../services/agentService', () => ({
  agentService: { getProfile: state.getProfile }
}))
vi.mock('../../agents/AgentManager', () => ({ agentManager: { runTask: state.runTask } }))
vi.mock('../../i18n', () => ({ t: (k: string) => k }))
// i18next 是单例：内置库的语言目录从它现读
const i18n = vi.hoisted(() => ({ language: 'en' }))
vi.mock('i18next', () => ({
  default: {
    get language() {
      return i18n.language
    },
    t: (key: string) => `i18n(${key})`
  }
}))

import {
  KNOWLEDGE_DESCRIPTION,
  KNOWLEDGE_REVIEW_CONTRACT,
  KnowledgeParamsSchema,
  buildKnowledgeReviewPrompt,
  toInProcessAgentType,
  type AgentProfile
} from '@shuvix/agent-runtime'
import { BUILTIN_TOOL_PRESENTATIONS } from '@shuvix/chat-protocol/builtinToolPresentations'
import { makeKnowledgeTool } from '../knowledge'
import type { ToolContext } from '../../services/toolContext'

const BUNDLE = 'projects/acme'
const SUBMITTER = 'shuvix-work/gpt-5'
const WRITER = 'shuvix-knowledge-writer/claude-haiku-4-5'

/** 一个 agent 的身份（ToolContext['agent'] 的形状） */
const identity = (
  profileName: string,
  model: string | undefined,
  kind: 'root' | 'spawned' = 'root'
): NonNullable<ToolContext['agent']> => ({
  profileName,
  kind,
  ...(model === undefined
    ? {}
    : { getModelConfig: () => ({ provider: 'anthropic', model, capabilities: {} }) })
})

/** 按 agent 装配的 ctx：工具固定属于 work / gpt-5 */
const ctx: ToolContext = { sessionId: 's1', agent: identity('work', 'gpt-5') }
/** 写手那条对话的 id（runTask 替身交回它） */
const WRITER_CONVERSATION = 2
/** 会话级装配的 ctx：对话 2 是写手，其余是 work / gpt-5 */
const sessionAgentOf = vi.fn((c: number) =>
  c === WRITER_CONVERSATION
    ? identity('knowledge-writer', 'claude-haiku-4-5', 'spawned')
    : identity('work', 'gpt-5')
)
const sessionCtx: ToolContext = { sessionId: 's1', agentOf: sessionAgentOf }

/** 本会话的目标 bundle：`projects/acme`，落在临时 shuvix 根下 */
const projectDir = (): string => join(state.root, 'projects', 'acme')
const target = (): { bundle: string; dir: string; label: string } => ({
  bundle: BUNDLE,
  dir: projectDir(),
  label: 'project "Acme"'
})

const textOf = (res: { content: unknown[] }): string => (res.content[0] as { text: string }).text

/** 目录下的全部条目（递归、`/` 分隔、字典序）；目录不在给 `[]` */
const treeOf = (dir: string): string[] => {
  try {
    return readdirSync(dir, { recursive: true })
      .map((p) => String(p).replace(/\\/g, '/'))
      .sort()
  } catch {
    return []
  }
}

/** 写手的档案（toInProcessAgentType 只读这些字段） */
const writerProfile = (overrides: Partial<AgentProfile> = {}): AgentProfile => ({
  name: 'knowledge-writer',
  displayName: 'Knowledge writer',
  description: 'checks knowledge entries',
  systemPrompt: 'writer prompt',
  tools: ['read', 'edit', 'knowledge'],
  instructionFiles: [],
  projectAwareness: false,
  source: 'builtin',
  basePath: '',
  ...overrides
})

/** 用户写下的普通笔记（没有元数据）—— 主 agent 写进库里、再 submit 的那一份 */
const PLAIN = '# Token refresh\n\nThe token is refreshed on 401 (see src/auth.ts).\n'
/** 写手补完元数据之后的样子（写钩子把 generated 盖成了写手自己） */
const WRITER_AT = '2026-10-12T00:00:00.000Z'
const writerVersion = (body = PLAIN): string =>
  [
    '---',
    'shuvix: okf v0.2',
    'type: Memory',
    'title: Token refresh',
    'description: when touching auth',
    'status: stable',
    `generated: { by: "${WRITER}", at: "${WRITER_AT}" }`,
    '---',
    '',
    body.trimEnd(),
    ''
  ].join('\n')

/** 派给写手的任务里那一行 `- Entry: <abs>` */
const entryOf = (prompt: string): string => /^- Entry: (.+)$/m.exec(prompt)![1]

/** runTask 替身：像写手那样把条目改成带元数据的版本，交回契约结果 */
const writerPasses =
  (structured: unknown = { passed: true, report: 'ok' }, conversationId = WRITER_CONVERSATION) =>
  async (params: { prompt: string }) => {
    writeFileSync(entryOf(params.prompt), writerVersion(), 'utf-8')
    return { result: JSON.stringify(structured), structured, conversationId }
  }

/** 在某个库目录里种一篇普通笔记，返回它的绝对路径 */
const seed = (dir: string, rel: string, text = PLAIN): string => {
  const abs = join(dir, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, text, 'utf-8')
  return abs
}

/** 文件里两个章的 by / at */
const stampsOf = (
  text: string
): { generated?: { by: string; at: string }; verified?: { by: string; at: string } } => {
  const pick = (key: string): { by: string; at: string } | undefined => {
    const m = new RegExp(`^${key}: \\{ by: "([^"]*)", at: "([^"]*)" \\}$`, 'm').exec(text)
    return m ? { by: m[1], at: m[2] } : undefined
  }
  return { generated: pick('generated'), verified: pick('verified') }
}

beforeAll(() => {
  state.root = mkdtempSync(join(tmpdir(), 'shuvix-knowledge-tool-'))
})
afterAll(() => {
  rmSync(state.root, { recursive: true, force: true })
  // 用户根与内置根都是 root 的**兄弟**目录：不在被删的那棵树下，各自收
  rmSync(`${state.root}-user`, { recursive: true, force: true })
  rmSync(`${state.root}-builtin`, { recursive: true, force: true })
})

beforeEach(() => {
  state.record.mockReset()
  state.resolveBase.mockReset().mockResolvedValue(target())
  state.listBases.mockReset().mockResolvedValue([])
  state.scan.mockReset().mockResolvedValue({ files: [], concepts: [], notes: [] })
  state.search.mockReset().mockResolvedValue([])
  state.enforcePath.mockReset().mockResolvedValue(undefined)
  state.getProfile
    .mockReset()
    .mockImplementation((name: string) =>
      name === 'knowledge-writer' ? writerProfile() : undefined
    )
  state.runTask.mockReset().mockImplementation(writerPasses())
  sessionAgentOf.mockClear()
})

describe('knowledge 工具（桌面注册）', () => {
  it('TK-1 注册元数据：name / group / presentation / describe / label', () => {
    const meta = state.registered.find((m) => m.name === 'knowledge')!
    expect(meta).toBeDefined()
    expect(meta.group).toBe('general')
    expect(meta.presentation).toEqual(BUILTIN_TOOL_PRESENTATIONS.knowledge.presentation)
    expect((meta.presentation as { icon: string }).icon).toBe('BookOpen')
    const described = (meta.describe as () => { description: string; parameters: unknown })()
    expect(described.description).toBe(KNOWLEDGE_DESCRIPTION)
    expect(described.parameters).toBe(KnowledgeParamsSchema)
    expect((meta.getLabel as () => string)()).toBe('tool.knowledgeLabel')
  })

  it('TK-2′ 读侧（list / search）不记账、不派写手；base 原样交给宿主按根会话解析', async () => {
    const tool = makeKnowledgeTool(ctx)
    expect(tool.label).toBe('tool.knowledgeLabel')
    for (const action of ['list', 'search'] as const) {
      await executeTool(tool, 'c1', { action, base: 'project', query: 'q' })
      expect(state.resolveBase, action).toHaveBeenLastCalledWith('s1', 'project')
    }
    expect(state.record).not.toHaveBeenCalled()
    expect(state.runTask).not.toHaveBeenCalled()
    expect(state.enforcePath).not.toHaveBeenCalled()
  })

  it('TK-3′ 读路径：list / search 把 bundle 目录反查成 bundle id 再交给扫描 / 检索；解析不出 bundle 的目录 → 不扫不搜', async () => {
    const tool = makeKnowledgeTool(ctx)
    await executeTool(tool, 'c5', { action: 'list', base: 'project' })
    expect(state.scan).toHaveBeenLastCalledWith(BUNDLE)
    await executeTool(tool, 'c6', { action: 'search', base: 'project', query: 'token', limit: 5 })
    expect(state.search).toHaveBeenLastCalledWith(BUNDLE, 'token', { limit: 5 })

    const stray = mkdtempSync(join(tmpdir(), 'shuvix-knowledge-stray-'))
    try {
      state.resolveBase.mockResolvedValue({ bundle: BUNDLE, dir: stray, label: 'stray' })
      state.scan.mockClear()
      state.search.mockClear()
      const listed = await executeTool(tool, 'c8', { action: 'list', base: 'project' })
      expect(state.scan).not.toHaveBeenCalled()
      expect(textOf(listed)).toBe(`No entries in stray — ${stray} yet.`)
      await executeTool(tool, 'c9', { action: 'search', base: 'project', query: 'token' })
      expect(state.search).not.toHaveBeenCalled()
    } finally {
      rmSync(stray, { recursive: true, force: true })
    }
  })

  it('TK-4′ [白盒·适配层] 用户库：list / search 拿 `knowledge/<库名>`；submit 到用户库 —— 章落在用户库的文件里，变更管线记一笔 Update', async () => {
    const userRoot = `${state.root}-user`
    const dir = join(userRoot, 'notes')
    const abs = seed(dir, 'tk4.md')
    state.resolveBase.mockResolvedValue({
      bundle: 'knowledge/notes',
      dir,
      label: 'knowledge base "notes"'
    })
    const tool = makeKnowledgeTool(ctx)

    await executeTool(tool, 'u1', { action: 'list', base: 'notes' })
    expect(state.resolveBase).toHaveBeenLastCalledWith('s1', 'notes')
    expect(state.scan).toHaveBeenLastCalledWith('knowledge/notes')
    await executeTool(tool, 'u2', { action: 'search', base: 'notes', query: 'q', limit: 3 })
    expect(state.search).toHaveBeenLastCalledWith('knowledge/notes', 'q', { limit: 3 })

    const res = await executeTool(tool, 'u3', { action: 'submit', base: 'notes', path: 'tk4.md' })
    expect(textOf(res).startsWith(`Confirmed: ${dir}/tk4.md`)).toBe(true)
    expect(stampsOf(readFileSync(abs, 'utf-8')).generated?.by).toBe(SUBMITTER)
    expect(state.record).toHaveBeenCalledTimes(1)
    expect(state.record).toHaveBeenCalledWith({
      bundle: 'knowledge/notes',
      path: 'tk4.md',
      op: 'Update',
      actor: SUBMITTER
    })
  })

  it('TK-5 `bases` 直接走宿主的 listBases（传根会话 id），不解析任何 base；每个库一行带标签与目录', async () => {
    state.listBases.mockResolvedValue([
      { base: 'project', label: 'this project', note: 'this session does not belong to a project' },
      { base: 'notes', label: 'knowledge base "notes"', dir: '/u/notes' }
    ])
    const res = await executeTool(makeKnowledgeTool(ctx), 'b1', { action: 'bases' })
    expect(state.listBases).toHaveBeenCalledTimes(1)
    expect(state.listBases).toHaveBeenCalledWith('s1')
    expect(state.resolveBase).not.toHaveBeenCalled()
    expect(textOf(res)).toContain('- notes — knowledge base "notes" — /u/notes')
  })
})

/**
 * 随应用发布的内置库（TK-6..TK-10）：磁盘上多一层**语言目录**、语言不进 bundle id；它**只读** ——
 * `submit` 由工具自己拒（不留给安全策略），读侧照常。
 */
describe('TK-6..TK-10 内置库（语言目录、只读、垫底）', () => {
  const BUILTIN_BUNDLE = 'builtin/shuvix'
  const BUILTIN_LABEL = 'ShuviX reference (read-only)'
  /** listBases 只给内置那一行加的只读提示 */
  const BUILTIN_NOTE = 'read-only: search and read it, never write or submit here'
  const ENTRY = 'agent-md.md'

  const builtinRoot = (): string => `${state.root}-builtin`
  /** bundle 目录就是语言那一层 */
  const builtinDir = (lang = 'en'): string => join(builtinRoot(), 'shuvix', lang)
  const builtinTarget = (lang = 'en'): Record<string, unknown> => ({
    bundle: BUILTIN_BUNDLE,
    dir: builtinDir(lang),
    label: BUILTIN_LABEL,
    readonly: true
  })
  const entryText = (lang: string): string =>
    [
      '---',
      'shuvix: okf v0.2',
      'type: Guide',
      'title: Agent md',
      '---',
      '',
      `${lang} body`,
      ''
    ].join('\n')
  const seedBuiltin = (lang: string): string => seed(builtinDir(lang), ENTRY, entryText(lang))
  const builtinNote = (): Record<string, unknown> => ({
    path: ENTRY,
    title: 'Agent md',
    description: 'how agent md is written',
    tags: [],
    status: 'stable',
    type: 'Guide',
    concept: null
  })

  beforeEach(() => {
    i18n.language = 'en'
    state.resolveBase.mockResolvedValue(builtinTarget())
  })
  afterEach(() => {
    rmSync(builtinRoot(), { recursive: true, force: true })
  })

  it('TK-6′ [白盒·适配层] 反查连语言那一层一起认：两种语言反查回同一个 `builtin/<库名>`，list 行印生效语言目录下的绝对路径；换了语言，另一版的目录就不属于任何 bundle', async () => {
    const en = seedBuiltin('en')
    const zh = seedBuiltin('zh')
    state.scan.mockImplementation(async (bundle: string) => ({
      files: bundle === BUILTIN_BUNDLE ? [{ path: ENTRY, text: entryText('en') }] : [],
      concepts: [],
      notes: bundle === BUILTIN_BUNDLE ? [builtinNote()] : []
    }))
    state.search.mockImplementation(async (bundle: string) =>
      bundle === BUILTIN_BUNDLE
        ? [{ path: ENTRY, title: 'Agent md', description: 'how agent md is written' }]
        : []
    )
    const tool = makeKnowledgeTool(ctx)

    const listed = await executeTool(tool, 'k1', { action: 'list', base: 'shuvix' })
    expect(state.resolveBase).toHaveBeenLastCalledWith('s1', 'shuvix')
    expect(state.scan).toHaveBeenLastCalledWith(BUILTIN_BUNDLE)
    expect(textOf(listed).split('\n')).toEqual([
      `1 entry in ${BUILTIN_LABEL} — ${builtinDir()}:`,
      `- ${builtinDir()}/${ENTRY} — how agent md is written`
    ])

    const searched = await executeTool(tool, 'k2', {
      action: 'search',
      base: 'shuvix',
      query: 'agent',
      limit: 5
    })
    expect(state.search).toHaveBeenLastCalledWith(BUILTIN_BUNDLE, 'agent', { limit: 5 })
    expect(textOf(searched)).toContain(`- ${builtinDir()}/${ENTRY} — how agent md is written`)

    // 切到 zh（`zh-CN` 取基础段）：同一个 bundle id，另一个目录
    i18n.language = 'zh-CN'
    state.resolveBase.mockResolvedValue(builtinTarget('zh'))
    state.scan.mockClear()
    const listedZh = await executeTool(tool, 'k4', { action: 'list', base: 'shuvix' })
    expect(state.scan).toHaveBeenLastCalledWith(BUILTIN_BUNDLE)
    expect(textOf(listedZh)).toContain(`- ${builtinDir('zh')}/${ENTRY}`)

    // 生效语言是 zh 时，en 那一版不属于任何 bundle：扫描一次都不该被调用
    state.scan.mockClear()
    state.resolveBase.mockResolvedValue(builtinTarget('en'))
    const stale = await executeTool(tool, 'k6', { action: 'list', base: 'shuvix' })
    expect(state.scan).not.toHaveBeenCalled()
    expect(textOf(stale)).toBe(`No entries in ${BUILTIN_LABEL} — ${builtinDir('en')} yet.`)

    expect(readFileSync(en, 'utf-8')).toBe(entryText('en'))
    expect(readFileSync(zh, 'utf-8')).toBe(entryText('zh'))
  })

  it('TK-7′ submit 打到内置库：工具自己拒，话里点名「去用户的库记」；写手不派、不过门、不记账、内置目录树不变', async () => {
    seedBuiltin('en')
    const before = treeOf(builtinRoot())
    const message = await failureText(
      executeTool(makeKnowledgeTool(ctx), 'k7', { action: 'submit', base: 'shuvix', path: ENTRY })
    )
    expect(message).toContain('"shuvix" is read-only')
    expect(message).toMatch(/user's knowledge bases/)
    expect(message).toContain('"bases"')
    expect(state.runTask).not.toHaveBeenCalled()
    expect(state.enforcePath).not.toHaveBeenCalled()
    expect(state.record).not.toHaveBeenCalled()
    expect(state.scan).not.toHaveBeenCalled()
    expect(treeOf(builtinRoot())).toEqual(before)
  })

  it('TK-8′ 对照：同一把工具紧接着 submit 用户库照常通过、记一笔 Update —— 只读守的是内置库，不是把提交关上', async () => {
    seedBuiltin('en')
    const untouched = treeOf(builtinRoot())
    const libDir = join(`${state.root}-user`, 'lib')
    seed(libDir, 'auth-notes.md')
    state.resolveBase.mockImplementation(async (_sessionId: string, base: string) =>
      base === 'shuvix'
        ? builtinTarget()
        : { bundle: 'knowledge/lib', dir: libDir, label: 'knowledge base "lib"' }
    )
    const tool = makeKnowledgeTool(ctx)

    expect(
      await failureText(executeTool(tool, 'k8', { action: 'submit', base: 'shuvix', path: ENTRY }))
    ).toContain('read-only')
    expect(state.record).not.toHaveBeenCalled()

    const res = await executeTool(tool, 'k9', {
      action: 'submit',
      base: 'lib',
      path: 'auth-notes.md'
    })
    expect(textOf(res).startsWith(`Confirmed: ${libDir}/auth-notes.md`)).toBe(true)
    expect(state.record).toHaveBeenCalledTimes(1)
    expect(state.record).toHaveBeenCalledWith({
      bundle: 'knowledge/lib',
      path: 'auth-notes.md',
      op: 'Update',
      actor: SUBMITTER
    })
    expect(treeOf(builtinRoot())).toEqual(untouched)
  })

  it('TK-9 `bases` 的回包：内置那一行带 `(read-only: …)` 且排最后（宿主的次序原样印出），其余两行不带', async () => {
    state.listBases.mockResolvedValue([
      { base: 'notes', label: 'knowledge base "notes"', dir: '/u/notes' },
      { base: 'project', label: 'project "Acme"', dir: '/p/acme' },
      { base: 'shuvix', label: BUILTIN_LABEL, dir: builtinDir(), note: BUILTIN_NOTE }
    ])
    const lines = textOf(
      await executeTool(makeKnowledgeTool(ctx), 'k10', { action: 'bases' })
    ).split('\n')
    expect(lines[0]).toBe('Knowledge bases in this session (pass the name as `base`):')
    expect(lines.slice(1).map((l) => l.split(' — ')[0])).toEqual([
      '- notes',
      '- project',
      '- shuvix'
    ])
    expect(lines[lines.length - 1]).toBe(
      `- shuvix — ${BUILTIN_LABEL} — ${builtinDir()} (${BUILTIN_NOTE})`
    )
    expect(lines.filter((l) => l.includes('(read-only:'))).toHaveLength(1)
    expect(state.resolveBase).not.toHaveBeenCalled()
  })

  it('TK-10 不带 `base` 的 search 覆盖全部启用库（含内置库），按库分组；每个库各按自己的 bundle id 检索', async () => {
    const userRoot = `${state.root}-user`
    state.listBases.mockResolvedValue([
      { base: 'notes', label: 'knowledge base "notes"', dir: join(userRoot, 'notes') },
      { base: 'project', label: 'project "Acme"', dir: projectDir() },
      { base: 'shuvix', label: BUILTIN_LABEL, dir: builtinDir(), note: BUILTIN_NOTE }
    ])
    state.search.mockImplementation(async (bundle: string) => [
      { path: ENTRY, title: 'T', description: `hit in ${bundle}` }
    ])
    const res = await executeTool(makeKnowledgeTool(ctx), 'k11', {
      action: 'search',
      query: 'token'
    })
    expect(state.search.mock.calls.map((c) => c[0])).toEqual([
      'knowledge/notes',
      'projects/acme',
      BUILTIN_BUNDLE
    ])
    const out = textOf(res)
    expect(out.split('\n')[0]).toBe('3 result(s) for "token" across 3 base(s):')
    expect(out).toContain(`base "notes" — ${join(userRoot, 'notes')}:`)
    expect(out).toContain(`base "project" — ${projectDir()}:`)
    expect(out).toContain(`base "shuvix" — ${builtinDir()}:`)
    expect(out).toContain(`- ${builtinDir()}/${ENTRY} — hit in ${BUILTIN_BUNDLE}`)
    expect(state.resolveBase).not.toHaveBeenCalled()
  })
})

// ─── runReview 与盖章接线 ───────────────────────────────────────────────────────

describe('TR-1..TR-15 submit：派写手与盖章', () => {
  /** 在项目库里种一篇、submit 一次；返回结果与文件路径 */
  const submitOne = async (
    name: string,
    opts: {
      ctx?: ToolContext
      callId?: string
      conversationId?: number
      signal?: AbortSignal
    } = {}
  ): Promise<{ res: Awaited<ReturnType<typeof invokeTool>>['result']; abs: string }> => {
    const abs = seed(projectDir(), name)
    const { result } = await invokeTool(
      makeKnowledgeTool(opts.ctx ?? sessionCtx),
      { action: 'submit', base: 'project', path: name },
      {
        callId: opts.callId ?? `call-${name}`,
        conversationId: opts.conversationId ?? 1,
        signal: opts.signal
      }
    )
    return { res: result, abs }
  }

  it('TR-1 runTask 恰一次：会话、拥有者是这次工具调用、卡片 id、写手类型、任务文本（含本会话出处）、结果契约；不带模型配置', async () => {
    const { abs } = await submitOne('tr1.md', { callId: 'k1', conversationId: 1 })
    expect(state.runTask).toHaveBeenCalledTimes(1)
    const params = state.runTask.mock.calls[0][0] as Record<string, unknown>
    expect(params.sessionId).toBe('s1')
    expect(params.owner).toEqual({
      tool: expect.objectContaining({ callId: 'k1', conversationId: 1 })
    })
    expect(params.parentToolCallId).toBe('k1')
    expect(params.agentType).toEqual(toInProcessAgentType(writerProfile()))
    expect(state.getProfile).toHaveBeenCalledWith('knowledge-writer')
    expect(params.prompt).toBe(
      buildKnowledgeReviewPrompt({
        base: 'project',
        label: 'project "Acme"',
        bundleDir: projectDir(),
        path: abs,
        rel: 'tr1.md',
        submittedBy: SUBMITTER,
        sessionId: 's1',
        workingDirectory: '/probe-ws'
      })
    )
    expect(params.prompt).toContain('shuvix://session/s1')
    // 条目里的相对路径（`src/auth/refresh.ts`）要靠它解析成 sources 的绝对路径
    expect(params.prompt).toContain('/probe-ws')
    expect(params.description).toBe('Check tr1.md')
    expect(params.resultContract).toBe(KNOWLEDGE_REVIEW_CONTRACT)
    // 写手的模型按通用规则来（md 声明或跟随调用方）：宿主不另给
    expect('modelConfig' in params).toBe(false)
  })

  it('TR-2 取消随调用走：owner.tool.signal 与这次调用的中止态联动；runReview 自己不另传 signal', async () => {
    const controller = new AbortController()
    const seen: Array<boolean | undefined> = []
    let hasOwnSignal: boolean | undefined
    state.runTask.mockImplementation(async (params: Record<string, unknown>) => {
      const signal = (params.owner as { tool: { signal?: AbortSignal } }).tool.signal
      hasOwnSignal = 'signal' in params
      seen.push(signal?.aborted)
      controller.abort()
      seen.push(signal?.aborted)
      return { result: '{}', structured: { passed: true, report: 'ok' }, conversationId: 2 }
    })
    await expect(submitOne('tr2.md', { signal: controller.signal })).rejects.toThrow('Aborted')
    // 中止前 false、中止后 true：owner 上的信号接的就是这次调用的取消
    expect(seen).toEqual([false, true])
    expect(hasOwnSignal).toBe(false)
    expect(state.record).not.toHaveBeenCalled()
  })

  it('TR-3 通过 → generated 是提交者、verified 是写手那条对话现取的身份，同一时刻；变更管线恰一笔 Update（actor 是提交者）', async () => {
    const { res, abs } = await submitOne('tr3.md')
    expect(textOf(res)).toContain(`machine-confirmed by ${WRITER}`)
    const text = readFileSync(abs, 'utf-8')
    const { generated, verified } = stampsOf(text)
    expect(generated?.by).toBe(SUBMITTER)
    expect(verified?.by).toBe(WRITER)
    expect(generated?.at).toBe(verified?.at)
    expect(generated?.at).not.toBe(WRITER_AT)
    expect(state.record).toHaveBeenCalledTimes(1)
    expect(state.record).toHaveBeenCalledWith({
      bundle: BUNDLE,
      path: 'tr3.md',
      op: 'Update',
      actor: SUBMITTER
    })
    expect(sessionAgentOf).toHaveBeenCalledWith(WRITER_CONVERSATION)
  })

  it('TR-4 写手的模型来自它的 md：用户覆盖的档案声明了模型 → agentType.model 原样带上；章上的写手仍按对话现取', async () => {
    state.getProfile.mockImplementation((name: string) =>
      name === 'knowledge-writer'
        ? writerProfile({ model: 'anthropic/claude-haiku-4-5', source: 'user' })
        : undefined
    )
    const { abs } = await submitOne('tr4.md')
    const params = state.runTask.mock.calls[0][0] as { agentType: { model?: string } }
    expect(params.agentType.model).toBe('anthropic/claude-haiku-4-5')
    expect(stampsOf(readFileSync(abs, 'utf-8')).verified?.by).toBe(WRITER)
  })

  it.each([
    [
      '结果是 error（无 structured）',
      'tr5a.md',
      { result: 'stopped', error: 'aborted' },
      'aborted'
    ],
    ['既无 structured 也无 error', 'tr5b.md', { result: 'done' }, 'it finished without a verdict'],
    [
      'structured 形状不对',
      'tr5c.md',
      { result: 'x', structured: { passed: 'yes' } },
      'it finished without a verdict'
    ]
  ])('TR-5 没有结论（%s）→ 失败、不盖章、不记账', async (_label, name, outcome, why) => {
    state.runTask.mockResolvedValue({ ...outcome, conversationId: 2 })
    const { res, abs } = await submitOne(name)
    expect(res.isError).toBe(true)
    expect(textOf(res)).toBe(`The knowledge writer could not check ${abs}: ${why}`)
    expect(readFileSync(abs, 'utf-8')).toBe(PLAIN)
    expect(state.record).not.toHaveBeenCalled()
  })

  it('TR-6 不通过 → 普通结果 `Not confirmed`；文件保留写手的改动、没有 verified；不记账', async () => {
    state.runTask.mockImplementation(
      writerPasses({ passed: false, report: 'No source for the 401 claim.' })
    )
    const { res, abs } = await submitOne('tr6.md')
    expect(res.isError).toBeFalsy()
    expect(textOf(res).split('\n')[0]).toBe(`Not confirmed: ${abs}`)
    expect(textOf(res)).toContain('No source for the 401 claim.')
    expect(readFileSync(abs, 'utf-8')).toBe(writerVersion())
    expect(state.record).not.toHaveBeenCalled()
  })

  it('TR-7 写手档案不在 → 失败点名写手不可用；runTask 零次', async () => {
    state.getProfile.mockReturnValue(undefined)
    const { res, abs } = await submitOne('tr7.md')
    expect(res.isError).toBe(true)
    expect(textOf(res)).toBe(
      `The knowledge writer could not check ${abs}: the "knowledge-writer" agent is not available`
    )
    expect(state.runTask).not.toHaveBeenCalled()
  })

  it('TR-8 runTask 自己拒绝（契约不合法）→ 失败带那句消息；不盖章、不记账', async () => {
    state.runTask.mockRejectedValue(new Error('invalid result contract: bad schema'))
    const { res, abs } = await submitOne('tr8.md')
    expect(res.isError).toBe(true)
    expect(textOf(res)).toContain('invalid result contract: bad schema')
    expect(readFileSync(abs, 'utf-8')).toBe(PLAIN)
    expect(state.record).not.toHaveBeenCalled()
  })

  it('TR-9 写手对话的 id 没交回来 → verified.by 记成「写手 / 模型未知」', async () => {
    state.runTask.mockImplementation(async (params: { prompt: string }) => {
      writeFileSync(entryOf(params.prompt), writerVersion(), 'utf-8')
      return { result: '{}', structured: { passed: true, report: 'ok' } }
    })
    const { abs } = await submitOne('tr9.md')
    expect(stampsOf(readFileSync(abs, 'utf-8')).verified?.by).toBe(
      'shuvix-knowledge-writer/unknown'
    )
  })

  it('TR-10 认不出写手那条对话（会话级 agentOf 回 undefined / 抛错、按 agent 装配没有 agentOf）→ shuvix-knowledge-writer/unknown，绝不是提交者自己', async () => {
    const unknownWriter: ToolContext = {
      sessionId: 's1',
      agentOf: (c) => (c === WRITER_CONVERSATION ? undefined : identity('work', 'gpt-5'))
    }
    const throwingWriter: ToolContext = {
      sessionId: 's1',
      agentOf: (c) => {
        if (c === WRITER_CONVERSATION) throw new Error('no lock')
        return identity('work', 'gpt-5')
      }
    }
    for (const [name, c] of [
      ['tr10a.md', unknownWriter],
      ['tr10b.md', throwingWriter],
      // 按 agent 装配：工具固定属于 work / gpt-5，没有 agentOf —— 退回 ctx 原有身份就成了提交者自己盖章
      ['tr10c.md', ctx]
    ] as const) {
      const { abs } = await submitOne(name, { ctx: c })
      const { generated, verified } = stampsOf(readFileSync(abs, 'utf-8'))
      expect(verified?.by, name).toBe('shuvix-knowledge-writer/unknown')
      expect(verified?.by, name).not.toBe(generated?.by)
      expect(generated?.by, name).toBe(SUBMITTER)
    }
  })

  it('TR-11 写手自己 submit 被拒（判的是档案名，用户按名覆盖的同名写手一样）；同一把工具换成 work 的对话照常', async () => {
    state.getProfile.mockImplementation((name: string) =>
      name === 'knowledge-writer' ? writerProfile({ source: 'user' }) : undefined
    )
    const agentOf = (c: number): NonNullable<ToolContext['agent']> =>
      c === 7
        ? identity('knowledge-writer', 'claude-haiku-4-5', 'spawned')
        : identity('work', 'gpt-5')
    const tool = makeKnowledgeTool({ sessionId: 's1', agentOf })
    const abs = seed(projectDir(), 'tr11.md')

    const refused = (
      await invokeTool(
        tool,
        { action: 'submit', base: 'project', path: 'tr11.md' },
        { callId: 'w7', conversationId: 7 }
      )
    ).result
    expect(refused.isError).toBe(true)
    expect(textOf(refused)).toContain('does not submit entries')
    expect(state.resolveBase).not.toHaveBeenCalled()
    expect(state.enforcePath).not.toHaveBeenCalled()
    expect(state.runTask).not.toHaveBeenCalled()
    expect(readFileSync(abs, 'utf-8')).toBe(PLAIN)

    const ok = (
      await invokeTool(
        tool,
        { action: 'submit', base: 'project', path: 'tr11.md' },
        { callId: 'w1', conversationId: 1 }
      )
    ).result
    expect(ok.isError).toBeFalsy()
    expect(state.runTask).toHaveBeenCalledTimes(1)
  })

  it('TR-12 写手照常检索（isReviewer 只拦 submit）', async () => {
    const tool = makeKnowledgeTool(sessionCtx)
    for (const params of [
      { action: 'search' as const, base: 'project', query: 'q' },
      { action: 'list' as const, base: 'project' }
    ]) {
      const res = (await invokeTool(tool, params, { conversationId: WRITER_CONVERSATION })).result
      expect(res.isError, params.action).toBeFalsy()
    }
    expect(state.search).toHaveBeenCalledTimes(1)
    expect(state.scan).toHaveBeenCalledTimes(1)
  })

  it('TR-13 写门在派写手之前；门拒了 → 写手不派、文件不动', async () => {
    await submitOne('tr13a.md')
    expect(state.enforcePath.mock.invocationCallOrder[0]).toBeLessThan(
      state.runTask.mock.invocationCallOrder[0]
    )

    state.enforcePath.mockReset().mockRejectedValue(new Error('User denied access'))
    state.runTask.mockClear()
    const { res, abs } = await submitOne('tr13b.md')
    expect(res.isError).toBe(true)
    expect(textOf(res)).toBe('User denied access')
    expect(state.runTask).not.toHaveBeenCalled()
    expect(readFileSync(abs, 'utf-8')).toBe(PLAIN)
  })

  it('TR-14 目录反查不出 bundle（不在任何根下）：照常盖章，但变更管线一笔都不记', async () => {
    const stray = mkdtempSync(join(tmpdir(), 'shuvix-knowledge-stray-'))
    try {
      state.resolveBase.mockResolvedValue({ bundle: BUNDLE, dir: stray, label: 'stray' })
      const abs = seed(stray, 'tr14.md')
      const res = (
        await invokeTool(
          makeKnowledgeTool(sessionCtx),
          { action: 'submit', base: 'project', path: 'tr14.md' },
          { conversationId: 1 }
        )
      ).result
      expect(res.isError, textOf(res)).toBeFalsy()
      expect(stampsOf(readFileSync(abs, 'utf-8')).verified?.by).toBe(WRITER)
      expect(state.record).not.toHaveBeenCalled()
    } finally {
      rmSync(stray, { recursive: true, force: true })
    }
  })

  /**
   * H11-51′（原 create 的章按调用盖，改成 submit 版）：会话级装配的工具（ctx 带 agentOf、没有固定 agent）——
   * 提交者（generated.by 与变更管线的 actor）按**这次调用**的对话认人；写手的那一章各次都取自写手对话。
   */
  it('TR-15 提交者按调用认人：work / sonnet、认不出、身份中途换了、派生 explore / haiku —— 各盖各的，写手章始终是写手', async () => {
    const WRITER_C = 99
    let current: ToolContext['agent']
    const agentOf = vi.fn((c: number) =>
      c === WRITER_C
        ? identity('knowledge-writer', 'claude-haiku-4-5', 'spawned')
        : c === 2
          ? identity('explore', 'claude-haiku-4-5', 'spawned')
          : current
    )
    const tctx: ToolContext = { sessionId: 's1', agentOf }
    state.runTask.mockImplementation(writerPasses(undefined, WRITER_C))

    const cases: [string, NonNullable<ToolContext['agent']> | undefined, number, string][] = [
      ['h1.md', identity('work', 'claude-sonnet-4-5'), 1, 'shuvix-work/claude-sonnet-4-5'],
      ['h2.md', undefined, 1, 'shuvix-agent/unknown'],
      ['h3.md', identity('work', 'm1'), 1, 'shuvix-work/m1'],
      ['h4.md', identity('bot', 'm2'), 1, 'shuvix-bot/m2'],
      ['h5.md', identity('work', 'claude-sonnet-4-5'), 2, 'shuvix-explore/claude-haiku-4-5']
    ]
    for (const [name, who, conversationId, expected] of cases) {
      current = who
      state.record.mockClear()
      const { abs } = await submitOne(name, { ctx: tctx, conversationId })
      const { generated, verified } = stampsOf(readFileSync(abs, 'utf-8'))
      expect(generated?.by, name).toBe(expected)
      expect(verified?.by, name).toBe(WRITER)
      expect(state.record, name).toHaveBeenCalledWith(
        expect.objectContaining({ op: 'Update', actor: expected })
      )
    }
    expect(agentOf).toHaveBeenCalledWith(WRITER_C)
  })
})
