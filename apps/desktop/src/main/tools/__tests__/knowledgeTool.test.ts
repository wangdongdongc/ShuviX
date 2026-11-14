/**
 * knowledge 工具（桌面注册）—— 复用 agent-runtime 的共享内核，桌面只注入端适配。钉：
 *
 *   TK-1         注册元数据（name / group / presentation / describe / label）
 *   TK-2..TK-11  读侧：目标库按**会话 + base** 解析（`project` 是根会话所属项目的库，其余名字是用户库 / 内置库），
 *                拿到的 bundle 目录再反查回 bundle id（`projects/<id>` / `knowledge/<库名>` / `builtin/<库名>`）
 *                交给扫描 / 检索 / 读；条目一律按库内路径（`/x.md`）点名，**库目录只印给管理员**（调用方档案是
 *                `knowledge-writer`，按这次调用认人）；`bases` 直接走宿主的 listBases；submit 打到内置库由工具自己拒
 *   TA-1..TA-16  `submit` 的宿主一半（runAdmin）：与 `agent` 工具同一条派发路由同步派知识库管理员（子对话挂在
 *                这次工具调用下、带结果契约 `{accepted, entries, report}`），它收了就给它报的、仍合规的条目盖章 ——
 *                `generated` 是**提交者**（按这次调用认人），`verified` 是**管理员那条对话**现取的身份；每盖一条，
 *                变更管线记一笔 `Update`（actor 是提交者）。管理员自己的 submit 一律拒，它的读侧照常、看得到目录
 *
 * services/knowledge 只替到接口那一层：locateBundle 用**真的**（目录 → bundle id 这条往返正是适配层的实质），
 * 扫描 / 检索 / 变更管线是替身（扫描替身按 bundle id 读临时目录里的真文件）。管理员的派发路由
 * （agentManager.runTask）与档案表（agentService.getProfile）是替身 —— runTask 替身像管理员那样在任务文本给的
 * 库目录里新建 / 改写 / 删除条目、交回契约结果；toInProcessAgentType、buildKnowledgeAdminPrompt、
 * KNOWLEDGE_ADMIN_CONTRACT、readKnowledgeNote 用真件。文件是真的（临时目录）。
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
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
import {
  executeTool,
  failureText,
  invokeTool,
  type InvokeArgs
} from '@shuvix/agent-runtime/tools/testing/invokeTool'

const state = vi.hoisted(() => ({
  root: '',
  registered: [] as Array<Record<string, unknown>>,
  record: vi.fn(),
  resolveBase: vi.fn(),
  listBases: vi.fn(),
  search: vi.fn(),
  scan: vi.fn(),
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
  // 管理员的任务文本带提交会话的工作目录（提交内容里的相对路径据此拼成 sources 的绝对路径）
  resolveProjectConfig: () => ({ workingDirectory: '/probe-ws' }),
  TOOL_ABORTED: 'Aborted'
}))
// 管理员的档案表与派发路由：真 agentService 会扫 ~/.shuvix/agents，真 AgentManager 连着整套运行时
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
  KNOWLEDGE_ADMIN_CONTRACT,
  KNOWLEDGE_DESCRIPTION,
  KnowledgeParamsSchema,
  buildKnowledgeAdminPrompt,
  readKnowledgeNote,
  toInProcessAgentType,
  type AgentProfile,
  type KnowledgeBundleScan
} from '@shuvix/agent-runtime'
import { BUILTIN_TOOL_PRESENTATIONS } from '@shuvix/chat-protocol/builtinToolPresentations'
import { makeKnowledgeTool } from '../knowledge'
import type { ToolContext } from '../../services/toolContext'

/** 一次 knowledge 调用的参数 */
type KnowledgeArgs = InvokeArgs<ReturnType<typeof makeKnowledgeTool>>

const BUNDLE = 'projects/acme'
const SUBMITTER = 'shuvix-work/gpt-5'
const ADMIN = 'shuvix-knowledge-writer/claude-haiku-4-5'
/** 认不出管理员那条对话时章上的身份 —— 绝不能是提交者自己 */
const ADMIN_UNKNOWN = 'shuvix-knowledge-writer/unknown'

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
/** 管理员那条对话的 id（runTask 替身交回它） */
const ADMIN_CONVERSATION = 2
/** 会话级装配的 ctx：对话 2 是管理员，其余是 work / gpt-5 */
const sessionAgentOf = vi.fn((c: number) =>
  c === ADMIN_CONVERSATION
    ? identity('knowledge-writer', 'claude-haiku-4-5', 'spawned')
    : identity('work', 'gpt-5')
)
const sessionCtx: ToolContext = { sessionId: 's1', agentOf: sessionAgentOf }

const userRoot = (): string => `${state.root}-user`
const builtinRoot = (): string => `${state.root}-builtin`
/** 本会话的目标 bundle：`projects/acme`，落在临时 shuvix 根下 */
const projectDir = (): string => join(state.root, 'projects', 'acme')
const target = (): { bundle: string; dir: string; label: string } => ({
  bundle: BUNDLE,
  dir: projectDir(),
  label: 'project "Acme"'
})

const textOf = (res: { content: unknown[] }): string => (res.content[0] as { text: string }).text

/** 非管理员的回包里一个库目录都不该出现（用户根 / 内置根是 root 的兄弟，前缀相同，一并覆盖） */
const expectNoDirs = (out: string, ...more: string[]): void => {
  for (const dir of [state.root, ...more]) expect(out).not.toContain(dir)
}

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

/** 扫描替身：读目录里的真 md，像宿主那样每个都当一条笔记（readKnowledgeNote 是真件） */
const scanDir = (dir: string): KnowledgeBundleScan => {
  const files = treeOf(dir)
    .filter((p) => p.endsWith('.md'))
    .map((p) => ({ path: p, text: readFileSync(join(dir, p), 'utf-8') }))
  const notes = files.map((f) => readKnowledgeNote(f.text, f.path))
  return { files, concepts: notes.flatMap((n) => (n.concept ? [n.concept] : [])), notes }
}

/** bundle id → 临时目录（替身的「宿主」一侧；内置库按界面语言取那一层） */
const dirOfBundle = (bundle: string): string => {
  const [head, ...rest] = bundle.split('/')
  if (head === 'knowledge') return join(userRoot(), ...rest)
  if (head === 'builtin') return join(builtinRoot(), ...rest, i18n.language.split('-')[0])
  return join(state.root, bundle)
}

/** 管理员的档案（toInProcessAgentType 只读这些字段） */
const adminProfile = (overrides: Partial<AgentProfile> = {}): AgentProfile => ({
  name: 'knowledge-writer',
  displayName: 'Knowledge librarian',
  description: 'keeps the knowledge bases',
  systemPrompt: 'librarian prompt',
  tools: ['read', 'write', 'edit', 'move', 'delete', 'knowledge'],
  promptBlocks: [],
  source: 'builtin',
  basePath: '',
  ...overrides
})

/** 提交的内容 */
const CONTENT = '# Token refresh\n\nThe token is refreshed on 401 (see src/auth.ts).'
/** 用户自己的普通笔记（没有元数据） */
const PLAIN = "# Scratch\n\nThe user's own note.\n"
/** 管理员落笔的时刻（写钩子把 generated 盖成了管理员自己） */
const ADMIN_AT = '2026-10-12T00:00:00.000Z'
/** 一条合规的 OKF 条目，像管理员用文件工具写出来的那样 */
const okf = (title: string, body: string, by = ADMIN): string =>
  [
    '---',
    'shuvix: okf v0.2',
    'type: Memory',
    `title: ${title}`,
    `description: when touching ${title.toLowerCase()}`,
    'status: stable',
    `generated: { by: "${by}", at: "${ADMIN_AT}" }`,
    '---',
    '',
    body,
    ''
  ].join('\n')

/** 在某个库目录里种一篇，返回它的绝对路径 */
const seed = (dir: string, rel: string, text = PLAIN): string => {
  const abs = join(dir, rel)
  mkdirSync(dirname(abs), { recursive: true })
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

/** 派给管理员的任务里那一行 `- Base: "<base>" (<label>) — directory <abs>` */
const dirOf = (prompt: string): string => / — directory (.+)$/m.exec(prompt)![1]

interface AdminOpts {
  accepted?: boolean
  /** 给提交者的报告；函数形式拿到库目录（模拟管理员顺手写出了绝对路径） */
  report?: string | ((dir: string) => string)
  /** 覆盖交回的改动清单（缺省按落笔推：原来没有 = created，有 = updated，null = deleted） */
  entries?: unknown[]
  /** 管理员那条对话；`null` = 没交回 */
  conversationId?: number | null
}

/** runTask 替身：像管理员那样在任务文本给的库目录里落笔（`null` = 删掉），交回契约结果 */
const adminRecords =
  (
    files: Record<string, string | null> = { 'topic.md': okf('Topic', 'What holds.') },
    opts: AdminOpts = {}
  ) =>
  async (params: { prompt: string }) => {
    const dir = dirOf(params.prompt)
    const entries: Array<{ entry: string; change: string }> = []
    for (const [rel, text] of Object.entries(files)) {
      const abs = join(dir, rel)
      if (text === null) {
        rmSync(abs, { force: true })
        entries.push({ entry: `/${rel}`, change: 'deleted' })
        continue
      }
      const change = existsSync(abs) ? 'updated' : 'created'
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, text, 'utf-8')
      entries.push({ entry: `/${rel}`, change })
    }
    const report =
      typeof opts.report === 'function' ? opts.report(dir) : (opts.report ?? 'Recorded.')
    const structured = {
      accepted: opts.accepted ?? true,
      entries: opts.entries ?? entries,
      report
    }
    return {
      result: JSON.stringify(structured),
      structured,
      ...(opts.conversationId === null
        ? {}
        : { conversationId: opts.conversationId ?? ADMIN_CONVERSATION })
    }
  }

/** 交一次 submit（缺省：会话级装配、work 的对话 1、项目库） */
const submit = async (
  opts: {
    ctx?: ToolContext
    callId?: string
    conversationId?: number
    signal?: AbortSignal
    base?: string
    entry?: string
    content?: string
  } = {}
): Promise<Awaited<ReturnType<typeof invokeTool>>['result']> =>
  (
    await invokeTool(
      makeKnowledgeTool(opts.ctx ?? sessionCtx),
      {
        action: 'submit',
        base: opts.base ?? 'project',
        content: opts.content ?? CONTENT,
        ...(opts.entry === undefined ? {} : { entry: opts.entry })
      },
      {
        callId: opts.callId ?? 'call-submit',
        conversationId: opts.conversationId ?? 1,
        signal: opts.signal
      }
    )
  ).result

beforeAll(() => {
  state.root = mkdtempSync(join(tmpdir(), 'shuvix-knowledge-tool-'))
})
afterAll(() => {
  rmSync(state.root, { recursive: true, force: true })
  // 用户根与内置根都是 root 的**兄弟**目录：不在被删的那棵树下，各自收
  rmSync(userRoot(), { recursive: true, force: true })
  rmSync(builtinRoot(), { recursive: true, force: true })
})

beforeEach(() => {
  for (const dir of [projectDir(), userRoot(), builtinRoot()]) {
    rmSync(dir, { recursive: true, force: true })
  }
  i18n.language = 'en'
  state.record.mockReset()
  state.resolveBase.mockReset().mockResolvedValue(target())
  state.listBases.mockReset().mockResolvedValue([])
  state.scan.mockReset().mockImplementation(async (bundle: string) => scanDir(dirOfBundle(bundle)))
  state.search.mockReset().mockResolvedValue([])
  state.getProfile
    .mockReset()
    .mockImplementation((name: string) =>
      name === 'knowledge-writer' ? adminProfile() : undefined
    )
  state.runTask.mockReset().mockImplementation(adminRecords())
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

  it('TK-2 读侧（bases / list / search / read）不记账、不派管理员；base 原样交给宿主按根会话解析', async () => {
    seed(projectDir(), 'auth/token.md', okf('Token refresh', 'Body.'))
    const tool = makeKnowledgeTool(ctx)
    expect(tool.label).toBe('tool.knowledgeLabel')
    for (const params of [
      { action: 'list', base: 'project' },
      { action: 'search', base: 'project', query: 'q' },
      { action: 'read', base: 'project', entry: '/auth/token.md' }
    ] as const) {
      const res = await executeTool(tool, `c-${params.action}`, params)
      expect(res.isError, `${params.action}: ${textOf(res)}`).toBeFalsy()
      expect(state.resolveBase, params.action).toHaveBeenLastCalledWith('s1', 'project')
    }
    await executeTool(tool, 'c-bases', { action: 'bases' })
    expect(state.listBases).toHaveBeenCalledWith('s1')
    expect(state.record).not.toHaveBeenCalled()
    expect(state.runTask).not.toHaveBeenCalled()
    expect(state.getProfile).not.toHaveBeenCalled()
  })

  it('TK-3 list / search 把 bundle 目录反查成 bundle id 再交给扫描 / 检索，条目按 `/库内路径` 点名、不印目录；解析不出 bundle 的目录 → 不扫不搜', async () => {
    seed(projectDir(), 'auth/token.md', okf('Token refresh', 'Body.'))
    seed(projectDir(), 'scratch.md')
    state.search.mockResolvedValue([
      { path: 'auth/token.md', title: 'Token refresh', description: 'when touching token refresh' }
    ])
    const tool = makeKnowledgeTool(ctx)

    const listed = textOf(await executeTool(tool, 'c5', { action: 'list', base: 'project' }))
    expect(state.scan).toHaveBeenLastCalledWith(BUNDLE)
    expect(listed.split('\n')).toEqual([
      '2 entries in base "project" (project "Acme"):',
      '- /auth/token.md (2026-10-12) — when touching token refresh',
      '- /scratch.md — Scratch'
    ])
    expectNoDirs(listed)

    const searched = textOf(
      await executeTool(tool, 'c6', { action: 'search', base: 'project', query: 'token', limit: 5 })
    )
    expect(state.search).toHaveBeenLastCalledWith(BUNDLE, 'token', { limit: 5 })
    expect(searched.split('\n')).toEqual([
      '1 result(s) for "token" in base "project" (project "Acme"):',
      '- /auth/token.md — when touching token refresh'
    ])
    expectNoDirs(searched)

    const stray = mkdtempSync(join(tmpdir(), 'shuvix-knowledge-stray-'))
    try {
      seed(stray, 'loose.md')
      state.resolveBase.mockResolvedValue({ bundle: BUNDLE, dir: stray, label: 'stray' })
      state.scan.mockClear()
      state.search.mockClear()
      const strayList = textOf(await executeTool(tool, 'c8', { action: 'list', base: 'project' }))
      expect(state.scan).not.toHaveBeenCalled()
      expect(strayList).toBe('No entries in base "project" (stray) yet.')
      const straySearch = textOf(
        await executeTool(tool, 'c9', { action: 'search', base: 'project', query: 'token' })
      )
      expect(state.search).not.toHaveBeenCalled()
      expect(straySearch).toBe('No entries match "token".')
      expectNoDirs(strayList + straySearch, stray)
    } finally {
      rmSync(stray, { recursive: true, force: true })
    }
  })

  it('TK-4 [白盒·适配层] 用户库：list / search 拿 `knowledge/<库名>`；submit 到用户库 —— 管理员拿到用户库目录，章落在用户库的文件里，变更管线记一笔 Update', async () => {
    const dir = join(userRoot(), 'notes')
    seed(dir, 'scratch.md')
    state.resolveBase.mockResolvedValue({
      bundle: 'knowledge/notes',
      dir,
      label: 'knowledge base "notes"'
    })
    const tool = makeKnowledgeTool(ctx)

    const listed = textOf(await executeTool(tool, 'u1', { action: 'list', base: 'notes' }))
    expect(state.resolveBase).toHaveBeenLastCalledWith('s1', 'notes')
    expect(state.scan).toHaveBeenLastCalledWith('knowledge/notes')
    expect(listed.split('\n')).toEqual([
      '1 entry in base "notes" (knowledge base "notes"):',
      '- /scratch.md — Scratch'
    ])
    await executeTool(tool, 'u2', { action: 'search', base: 'notes', query: 'q', limit: 3 })
    expect(state.search).toHaveBeenLastCalledWith('knowledge/notes', 'q', { limit: 3 })

    const res = await executeTool(tool, 'u3', { action: 'submit', base: 'notes', content: CONTENT })
    expect(res.isError, textOf(res)).toBeFalsy()
    expect(dirOf((state.runTask.mock.calls[0][0] as { prompt: string }).prompt)).toBe(dir)
    expect(textOf(res).split('\n').slice(0, 2)).toEqual([
      'Recorded in base "notes":',
      '- /topic.md (created)'
    ])
    expectNoDirs(textOf(res))
    expect(stampsOf(readFileSync(join(dir, 'topic.md'), 'utf-8')).generated?.by).toBe(SUBMITTER)
    expect(state.record).toHaveBeenCalledTimes(1)
    expect(state.record).toHaveBeenCalledWith({
      bundle: 'knowledge/notes',
      path: 'topic.md',
      op: 'Update',
      actor: SUBMITTER
    })
  })

  it('TK-5 `bases` 直接走宿主的 listBases（传根会话 id），不解析任何 base；非管理员的行不带目录，管理员（按调用认人 / 按 agent 装配）的带', async () => {
    state.listBases.mockResolvedValue([
      { base: 'project', label: 'this project', note: 'this session does not belong to a project' },
      { base: 'notes', label: 'knowledge base "notes"', dir: '/u/notes' }
    ])
    const tool = makeKnowledgeTool(sessionCtx)

    const asWork = textOf(
      (await invokeTool(tool, { action: 'bases' }, { conversationId: 1 })).result
    )
    expect(state.listBases).toHaveBeenCalledWith('s1')
    expect(asWork.split('\n')).toEqual([
      'Knowledge bases in this session (pass the name as `base`):',
      '- project — this project (this session does not belong to a project)',
      '- notes — knowledge base "notes"'
    ])
    expect(asWork).not.toContain('/u/notes')

    const asAdmin = textOf(
      (await invokeTool(tool, { action: 'bases' }, { conversationId: ADMIN_CONVERSATION })).result
    )
    expect(sessionAgentOf).toHaveBeenCalledWith(ADMIN_CONVERSATION)
    expect(asAdmin.split('\n').slice(1)).toEqual([
      '- project — this project (this session does not belong to a project)',
      '- notes — knowledge base "notes" — /u/notes'
    ])

    // 按 agent 装配的管理员（工具固定属于它）同样看得到
    const perAgent = textOf(
      await executeTool(
        makeKnowledgeTool({
          sessionId: 's1',
          agent: identity('knowledge-writer', 'claude-haiku-4-5', 'spawned')
        }),
        'b3',
        { action: 'bases' }
      )
    )
    expect(perAgent).toContain('- notes — knowledge base "notes" — /u/notes')

    expect(state.listBases).toHaveBeenCalledTimes(3)
    expect(state.resolveBase).not.toHaveBeenCalled()
  })

  it('TK-11 read：条目经适配层按 bundle id 从扫描结果里取原文（不另读盘）；`/x.md`、省 `.md`、旧对话里的绝对路径都认，回包只印条目名；不在册 → 失败', async () => {
    const abs = seed(projectDir(), 'auth/token.md', okf('Token refresh', 'On disk.'))
    const cached = okf('Token refresh', 'From the scan cache.')
    state.scan.mockResolvedValue({
      files: [{ path: 'auth/token.md', text: cached }],
      concepts: [],
      notes: [readKnowledgeNote(cached, 'auth/token.md')]
    })
    const tool = makeKnowledgeTool(ctx)
    const total = cached.split('\n').length - 1

    for (const entry of ['/auth/token.md', 'auth/token', abs]) {
      state.scan.mockClear()
      const res = await executeTool(tool, 'r1', { action: 'read', base: 'project', entry })
      expect(res.isError, `${entry}: ${textOf(res)}`).toBeFalsy()
      expect(state.scan, entry).toHaveBeenCalledWith(BUNDLE)
      const lines = textOf(res).split('\n')
      expect(lines[0], entry).toBe(
        `Entry /auth/token.md in base "project" (project "Acme") — ${total} lines`
      )
      expect(lines.slice(2, -2).join('\n'), entry).toBe(cached.trimEnd())
      expect(lines[lines.length - 1], entry).toBe('(End of entry.)')
      expect(textOf(res)).not.toContain('On disk.')
      expectNoDirs(textOf(res))
    }

    const missing = await failureText(
      executeTool(tool, 'r2', { action: 'read', base: 'project', entry: '/nope.md' })
    )
    expect(missing).toBe(
      'No entry /nope.md in base "project" — "search" or "list" it for the right name'
    )
    expect(state.runTask).not.toHaveBeenCalled()
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
      'description: how agent md is written',
      '---',
      '',
      `${lang} body`,
      ''
    ].join('\n')
  const seedBuiltin = (lang: string): string => seed(builtinDir(lang), ENTRY, entryText(lang))

  beforeEach(() => {
    state.resolveBase.mockResolvedValue(builtinTarget())
  })

  it('TK-6 [白盒·适配层] 反查连语言那一层一起认：两种语言反查回同一个 `builtin/<库名>`，读到的是生效语言那一版；换了语言，另一版的目录就不属于任何 bundle；目录只印给管理员', async () => {
    const en = seedBuiltin('en')
    const zh = seedBuiltin('zh')
    state.search.mockImplementation(async (bundle: string) =>
      bundle === BUILTIN_BUNDLE
        ? [{ path: ENTRY, title: 'Agent md', description: 'how agent md is written' }]
        : []
    )
    const tool = makeKnowledgeTool(sessionCtx)
    const run = async (params: KnowledgeArgs, conversationId = 1): Promise<string> =>
      textOf((await invokeTool(tool, params, { conversationId })).result)

    const listed = await run({ action: 'list', base: 'shuvix' })
    expect(state.resolveBase).toHaveBeenLastCalledWith('s1', 'shuvix')
    expect(state.scan).toHaveBeenLastCalledWith(BUILTIN_BUNDLE)
    expect(listed.split('\n')).toEqual([
      `1 entry in base "shuvix" (${BUILTIN_LABEL}):`,
      `- /${ENTRY} — how agent md is written`
    ])
    expectNoDirs(listed)

    const searched = await run({ action: 'search', base: 'shuvix', query: 'agent', limit: 5 })
    expect(state.search).toHaveBeenLastCalledWith(BUILTIN_BUNDLE, 'agent', { limit: 5 })
    expect(searched).toContain(`- /${ENTRY} — how agent md is written`)
    expectNoDirs(searched)
    expect(await run({ action: 'read', base: 'shuvix', entry: `/${ENTRY}` })).toContain('en body')

    // 切到 zh（`zh-CN` 取基础段）：同一个 bundle id，另一个目录 —— 读到 zh 那一版
    i18n.language = 'zh-CN'
    state.resolveBase.mockResolvedValue(builtinTarget('zh'))
    state.scan.mockClear()
    expect(await run({ action: 'list', base: 'shuvix' })).toContain(`- /${ENTRY}`)
    expect(state.scan).toHaveBeenLastCalledWith(BUILTIN_BUNDLE)
    expect(await run({ action: 'read', base: 'shuvix', entry: ENTRY })).toContain('zh body')
    // 管理员看得到生效语言那一层的目录
    expect((await run({ action: 'list', base: 'shuvix' }, ADMIN_CONVERSATION)).split('\n')[0]).toBe(
      `1 entry in base "shuvix" (${BUILTIN_LABEL} — ${builtinDir('zh')}):`
    )

    // 生效语言是 zh 时，en 那一版不属于任何 bundle：扫描一次都不该被调用
    state.scan.mockClear()
    state.resolveBase.mockResolvedValue(builtinTarget('en'))
    const stale = await run({ action: 'list', base: 'shuvix' })
    expect(state.scan).not.toHaveBeenCalled()
    expect(stale).toBe(`No entries in base "shuvix" (${BUILTIN_LABEL}) yet.`)

    expect(readFileSync(en, 'utf-8')).toBe(entryText('en'))
    expect(readFileSync(zh, 'utf-8')).toBe(entryText('zh'))
    expect(state.runTask).not.toHaveBeenCalled()
  })

  it('TK-7 submit 打到内置库（点名条目也一样）：工具自己拒，话里点名「去用户的库记」、不印目录；管理员不派、不记账、不扫描、内置目录树不变', async () => {
    seedBuiltin('en')
    const before = treeOf(builtinRoot())
    const message = await failureText(
      executeTool(makeKnowledgeTool(ctx), 'k7', {
        action: 'submit',
        base: 'shuvix',
        content: CONTENT,
        entry: `/${ENTRY}`
      })
    )
    expect(message).toContain('"shuvix" is read-only')
    expect(message).toMatch(/user's knowledge bases/)
    expect(message).toContain('"bases"')
    expectNoDirs(message)
    expect(state.runTask).not.toHaveBeenCalled()
    expect(state.getProfile).not.toHaveBeenCalled()
    expect(state.record).not.toHaveBeenCalled()
    expect(state.scan).not.toHaveBeenCalled()
    expect(treeOf(builtinRoot())).toEqual(before)
  })

  it('TK-8 对照：同一把工具紧接着 submit 用户库照常收录、记一笔 Update —— 只读守的是内置库，不是把提交关上', async () => {
    seedBuiltin('en')
    const untouched = treeOf(builtinRoot())
    const libDir = join(userRoot(), 'lib')
    state.resolveBase.mockImplementation(async (_sessionId: string, base: string) =>
      base === 'shuvix'
        ? builtinTarget()
        : { bundle: 'knowledge/lib', dir: libDir, label: 'knowledge base "lib"' }
    )
    const tool = makeKnowledgeTool(ctx)

    expect(
      await failureText(
        executeTool(tool, 'k8', { action: 'submit', base: 'shuvix', content: CONTENT })
      )
    ).toContain('read-only')
    expect(state.record).not.toHaveBeenCalled()
    expect(state.runTask).not.toHaveBeenCalled()

    const res = await executeTool(tool, 'k9', { action: 'submit', base: 'lib', content: CONTENT })
    expect(res.isError, textOf(res)).toBeFalsy()
    expect(textOf(res).startsWith('Recorded in base "lib":')).toBe(true)
    expect(state.runTask).toHaveBeenCalledTimes(1)
    expect(state.record).toHaveBeenCalledTimes(1)
    expect(state.record).toHaveBeenCalledWith({
      bundle: 'knowledge/lib',
      path: 'topic.md',
      op: 'Update',
      actor: SUBMITTER
    })
    expect(treeOf(builtinRoot())).toEqual(untouched)
  })

  it('TK-9 `bases` 的回包：内置那一行带 `(read-only: …)` 且排最后（宿主的次序原样印出），其余两行不带；非管理员的三行都不带目录', async () => {
    state.listBases.mockResolvedValue([
      { base: 'notes', label: 'knowledge base "notes"', dir: '/u/notes' },
      { base: 'project', label: 'project "Acme"', dir: '/p/acme' },
      { base: 'shuvix', label: BUILTIN_LABEL, dir: builtinDir(), note: BUILTIN_NOTE }
    ])
    const lines = textOf(
      await executeTool(makeKnowledgeTool(ctx), 'k10', { action: 'bases' })
    ).split('\n')
    expect(lines).toEqual([
      'Knowledge bases in this session (pass the name as `base`):',
      '- notes — knowledge base "notes"',
      '- project — project "Acme"',
      `- shuvix — ${BUILTIN_LABEL} (${BUILTIN_NOTE})`
    ])
    expect(lines.filter((l) => l.includes('(read-only:'))).toHaveLength(1)
    expect(state.resolveBase).not.toHaveBeenCalled()
  })

  it('TK-10 不带 `base` 的 search 覆盖全部可用库（含内置库，跳过没有目录的），按库分组；每个库各按自己的 bundle id 检索；目录只印给管理员', async () => {
    state.listBases.mockResolvedValue([
      { base: 'notes', label: 'knowledge base "notes"', dir: join(userRoot(), 'notes') },
      { base: 'project', label: 'project "Acme"', dir: projectDir() },
      { base: 'gone', label: 'knowledge base "gone"', note: 'not available right now' },
      { base: 'shuvix', label: BUILTIN_LABEL, dir: builtinDir(), note: BUILTIN_NOTE }
    ])
    state.search.mockImplementation(async (bundle: string) => [
      { path: ENTRY, title: 'T', description: `hit in ${bundle}` }
    ])
    const tool = makeKnowledgeTool(sessionCtx)

    const out = textOf(
      (await invokeTool(tool, { action: 'search', query: 'token' }, { conversationId: 1 })).result
    )
    expect(state.search.mock.calls.map((c) => c[0])).toEqual([
      'knowledge/notes',
      'projects/acme',
      BUILTIN_BUNDLE
    ])
    expect(out.split('\n')).toEqual([
      '3 result(s) for "token" across 3 base(s):',
      'base "notes" (knowledge base "notes"):',
      `- /${ENTRY} — hit in knowledge/notes`,
      'base "project" (project "Acme"):',
      `- /${ENTRY} — hit in projects/acme`,
      `base "shuvix" (${BUILTIN_LABEL}):`,
      `- /${ENTRY} — hit in ${BUILTIN_BUNDLE}`
    ])
    expectNoDirs(out)

    const asAdmin = textOf(
      (
        await invokeTool(
          tool,
          { action: 'search', query: 'token' },
          { conversationId: ADMIN_CONVERSATION }
        )
      ).result
    )
    expect(asAdmin).toContain(
      `base "notes" (knowledge base "notes" — ${join(userRoot(), 'notes')}):`
    )
    expect(asAdmin).toContain(`base "project" (project "Acme" — ${projectDir()}):`)
    expect(asAdmin).toContain(`base "shuvix" (${BUILTIN_LABEL} — ${builtinDir()}):`)
    expect(state.resolveBase).not.toHaveBeenCalled()
  })
})

// ─── runAdmin 与盖章接线 ───────────────────────────────────────────────────────

describe('TA-1..TA-16 submit：派管理员与盖章', () => {
  it('TA-1 runTask 恰一次：会话、拥有者是这次工具调用、卡片 id、管理员类型、任务文本（库 / 目录 / 提交者 / 内容 / 工作目录 / 本会话出处）、结果契约、oneShot；不带模型配置', async () => {
    const res = await submit({ callId: 'k1', conversationId: 1 })
    expect(res.isError, textOf(res)).toBeFalsy()
    expect(state.runTask).toHaveBeenCalledTimes(1)
    const params = state.runTask.mock.calls[0][0] as Record<string, unknown>
    expect(params.sessionId).toBe('s1')
    expect(params.owner).toEqual({
      tool: expect.objectContaining({ callId: 'k1', conversationId: 1 })
    })
    expect(params.parentToolCallId).toBe('k1')
    expect(state.getProfile).toHaveBeenCalledWith('knowledge-writer')
    expect(params.agentType).toEqual(toInProcessAgentType(adminProfile()))
    expect(params.prompt).toBe(
      buildKnowledgeAdminPrompt({
        base: 'project',
        label: 'project "Acme"',
        bundleDir: projectDir(),
        content: CONTENT,
        submittedBy: SUBMITTER,
        sessionId: 's1',
        workingDirectory: '/probe-ws'
      })
    )
    const prompt = params.prompt as string
    // 库目录只有管理员知道：它在任务文本里拿到
    expect(prompt).toContain(`directory ${projectDir()}`)
    expect(prompt).toContain(`Submitted by: ${SUBMITTER}`)
    expect(prompt).toContain(CONTENT)
    // 提交内容里的相对路径（`src/auth.ts`）要靠它拼成 sources 的绝对路径
    expect(prompt).toContain('/probe-ws')
    expect(prompt).toContain('shuvix://session/s1')
    expect(prompt).not.toContain('It corrects or extends')
    expect(params.description).toBe('Record in project')
    expect(params.resultContract).toBe(KNOWLEDGE_ADMIN_CONTRACT)
    // 管理员的模型按通用规则来（md 声明或跟随调用方）：宿主不另给
    expect('modelConfig' in params).toBe(false)
    // 每次 submit 一个新管理员、落定即卸：不在监控面板里闲挂
    expect(params.oneShot).toBe(true)
  })

  it('TA-2 点名 `entry`：按扫描清单归一（`/auth/token` → `auth/token.md`）写进任务文本；不在册 → 失败；没有 content → 失败 —— 后两者都不派管理员', async () => {
    seed(projectDir(), 'auth/token.md', okf('Token refresh', 'Body.'))
    const res = await submit({ entry: '/auth/token' })
    expect(res.isError, textOf(res)).toBeFalsy()
    expect(state.scan).toHaveBeenCalledWith(BUNDLE)
    const prompt = (state.runTask.mock.calls[0][0] as { prompt: string }).prompt
    expect(prompt).toBe(
      buildKnowledgeAdminPrompt({
        base: 'project',
        label: 'project "Acme"',
        bundleDir: projectDir(),
        content: CONTENT,
        entry: 'auth/token.md',
        submittedBy: SUBMITTER,
        sessionId: 's1',
        workingDirectory: '/probe-ws'
      })
    )
    expect(prompt).toContain('- It corrects or extends: /auth/token.md')

    state.runTask.mockClear()
    state.record.mockClear()
    const unknown = await submit({ entry: '/nope.md' })
    expect(unknown.isError).toBe(true)
    expect(textOf(unknown)).toBe(
      'No entry /nope.md in base "project" — "search" or "list" it for the right name'
    )
    const empty = await submit({ content: '   ' })
    expect(empty.isError).toBe(true)
    expect(textOf(empty)).toBe('"submit" needs `content` — what to record, in markdown')
    expect(state.runTask).not.toHaveBeenCalled()
    expect(state.record).not.toHaveBeenCalled()
  })

  it('TA-3 取消随调用走：owner.tool.signal 与这次调用的中止态联动；runAdmin 自己不另传 signal；中止后不盖章、不记账', async () => {
    const controller = new AbortController()
    const seen: Array<boolean | undefined> = []
    let hasOwnSignal: boolean | undefined
    const records = adminRecords()
    state.runTask.mockImplementation(async (params: Record<string, unknown>) => {
      const signal = (params.owner as { tool: { signal?: AbortSignal } }).tool.signal
      hasOwnSignal = 'signal' in params
      seen.push(signal?.aborted)
      const out = await records(params as { prompt: string })
      controller.abort()
      seen.push(signal?.aborted)
      return out
    })
    await expect(submit({ signal: controller.signal })).rejects.toThrow('Aborted')
    // 中止前 false、中止后 true：owner 上的信号接的就是这次调用的取消
    expect(seen).toEqual([false, true])
    expect(hasOwnSignal).toBe(false)
    const { generated, verified } = stampsOf(readFileSync(join(projectDir(), 'topic.md'), 'utf-8'))
    expect(generated?.by).toBe(ADMIN)
    expect(verified).toBeUndefined()
    expect(state.record).not.toHaveBeenCalled()
  })

  it('TA-4 收了 → 报了 created / updated 的条目各盖一章：generated 是提交者、verified 是管理员那条对话现取的身份，同一时刻；每章一笔 Update（actor 是提交者），deleted 不记；报告里的库目录换成条目名', async () => {
    seed(projectDir(), 'auth/token.md', okf('Token refresh', 'Old body.', 'shuvix-work/old'))
    seed(projectDir(), 'old.md', okf('Old', 'Folded away.'))
    state.runTask.mockImplementation(
      adminRecords(
        {
          'topic.md': okf('Topic', 'New body.'),
          'auth/token.md': okf('Token refresh', 'Updated body.'),
          'old.md': null
        },
        { report: (dir) => `Created ${dir}/topic.md; folded /old.md into /auth/token.md.` }
      )
    )
    const res = await submit()
    expect(res.isError, textOf(res)).toBeFalsy()
    expect(textOf(res)).toBe(
      [
        'Recorded in base "project":',
        '- /topic.md (created)',
        '- /auth/token.md (updated)',
        '- /old.md (deleted)',
        '',
        'Created /topic.md; folded /old.md into /auth/token.md.'
      ].join('\n')
    )
    expectNoDirs(textOf(res))
    expect(res.details).toEqual({ action: 'submit', path: 'topic.md' })

    const topic = readFileSync(join(projectDir(), 'topic.md'), 'utf-8')
    const token = readFileSync(join(projectDir(), 'auth', 'token.md'), 'utf-8')
    expect(topic).toContain('New body.')
    expect(token).toContain('Updated body.')
    const stamps = [stampsOf(topic), stampsOf(token)]
    for (const { generated, verified } of stamps) {
      expect(generated?.by).toBe(SUBMITTER)
      expect(verified?.by).toBe(ADMIN)
      expect(generated?.at).toBe(verified?.at)
      expect(generated?.at).not.toBe(ADMIN_AT)
    }
    expect(stamps[0].generated?.at).toBe(stamps[1].generated?.at)
    expect(existsSync(join(projectDir(), 'old.md'))).toBe(false)

    expect(state.record.mock.calls).toEqual([
      [{ bundle: BUNDLE, path: 'topic.md', op: 'Update', actor: SUBMITTER }],
      [{ bundle: BUNDLE, path: 'auth/token.md', op: 'Update', actor: SUBMITTER }]
    ])
    expect(sessionAgentOf).toHaveBeenCalledWith(ADMIN_CONVERSATION)
  })

  it('TA-5 只给盖上章的记账：报了的普通笔记（没有元数据）照用户的写法留着、不盖不记；报了却不在的条目在回包那一行注明 not found', async () => {
    seed(projectDir(), 'scratch.md')
    const appended = `${PLAIN}\nAppended by the librarian.\n`
    state.runTask.mockImplementation(
      adminRecords(
        { 'scratch.md': appended, 'topic.md': okf('Topic', 'Body.') },
        {
          entries: [
            { entry: '/scratch.md', change: 'updated' },
            { entry: '/topic.md', change: 'created' },
            { entry: '/ghost.md', change: 'created' }
          ]
        }
      )
    )
    const res = await submit()
    expect(res.isError, textOf(res)).toBeFalsy()
    expect(textOf(res).split('\n').slice(0, 4)).toEqual([
      'Recorded in base "project":',
      '- /scratch.md (updated)',
      '- /topic.md (created)',
      '- /ghost.md (created; not found)'
    ])
    expect(readFileSync(join(projectDir(), 'scratch.md'), 'utf-8')).toBe(appended)
    expect(existsSync(join(projectDir(), 'ghost.md'))).toBe(false)
    expect(state.record).toHaveBeenCalledTimes(1)
    expect(state.record).toHaveBeenCalledWith({
      bundle: BUNDLE,
      path: 'topic.md',
      op: 'Update',
      actor: SUBMITTER
    })
  })

  it('TA-6 不收 → 普通结果 `Not recorded`（带管理员的报告）；它落过笔的文件也不盖章；不记账', async () => {
    const written = okf('Topic', 'Drafted, then turned down.')
    state.runTask.mockImplementation(
      adminRecords(
        { 'topic.md': written },
        { accepted: false, report: 'Already recorded in /auth/token.md.' }
      )
    )
    const res = await submit()
    expect(res.isError).toBeFalsy()
    expect(textOf(res)).toBe(
      'Not recorded in base "project".\n\nAlready recorded in /auth/token.md.'
    )
    expect(readFileSync(join(projectDir(), 'topic.md'), 'utf-8')).toBe(written)
    expect(state.record).not.toHaveBeenCalled()
  })

  it.each([
    ['结果是 error（无 structured）', { result: 'stopped', error: 'aborted' }, 'aborted'],
    ['既无 structured 也无 error', { result: 'done' }, 'it finished without an answer'],
    [
      'structured 形状不对',
      { result: 'x', structured: { accepted: 'yes', entries: [], report: '' } },
      'it finished without an answer'
    ]
  ])('TA-7 没有答复（%s）→ 失败、不盖章、不记账', async (_label, outcome, why) => {
    state.runTask.mockResolvedValue({ ...outcome, conversationId: ADMIN_CONVERSATION })
    const res = await submit()
    expect(res.isError).toBe(true)
    expect(textOf(res)).toBe(`The knowledge librarian could not take the submission: ${why}`)
    expect(treeOf(projectDir())).toEqual([])
    expect(state.record).not.toHaveBeenCalled()
  })

  it('TA-8 管理员档案不在 → 失败点名它不可用；runTask 零次', async () => {
    state.getProfile.mockReturnValue(undefined)
    const res = await submit()
    expect(res.isError).toBe(true)
    expect(textOf(res)).toBe(
      'The knowledge librarian could not take the submission: the "knowledge-writer" agent is not available'
    )
    expect(state.getProfile).toHaveBeenCalledWith('knowledge-writer')
    expect(state.runTask).not.toHaveBeenCalled()
    expect(state.record).not.toHaveBeenCalled()
  })

  it('TA-9 runTask 自己拒绝（契约不合法）→ 失败带那句消息；不盖章、不记账', async () => {
    state.runTask.mockRejectedValue(new Error('invalid result contract: bad schema'))
    const res = await submit()
    expect(res.isError).toBe(true)
    expect(textOf(res)).toContain('invalid result contract: bad schema')
    expect(treeOf(projectDir())).toEqual([])
    expect(state.record).not.toHaveBeenCalled()
  })

  it('TA-10 管理员对话的 id 没交回来 → verified.by 记成「管理员 / 模型未知」，不是提交者', async () => {
    state.runTask.mockImplementation(adminRecords(undefined, { conversationId: null }))
    const res = await submit()
    expect(res.isError, textOf(res)).toBeFalsy()
    const { generated, verified } = stampsOf(readFileSync(join(projectDir(), 'topic.md'), 'utf-8'))
    expect(verified?.by).toBe(ADMIN_UNKNOWN)
    expect(generated?.by).toBe(SUBMITTER)
  })

  it('TA-11 认不出管理员那条对话（会话级 agentOf 回 undefined / 抛错、按 agent 装配没有 agentOf）→ shuvix-knowledge-writer/unknown，绝不是提交者自己', async () => {
    const unknownAdmin: ToolContext = {
      sessionId: 's1',
      agentOf: (c) => (c === ADMIN_CONVERSATION ? undefined : identity('work', 'gpt-5'))
    }
    const throwingAdmin: ToolContext = {
      sessionId: 's1',
      agentOf: (c) => {
        if (c === ADMIN_CONVERSATION) throw new Error('no lock')
        return identity('work', 'gpt-5')
      }
    }
    for (const [name, c] of [
      ['ta11a.md', unknownAdmin],
      ['ta11b.md', throwingAdmin],
      // 按 agent 装配：工具固定属于 work / gpt-5，没有 agentOf —— 退回 ctx 原有身份就成了提交者自己盖章
      ['ta11c.md', ctx]
    ] as const) {
      state.runTask.mockImplementation(adminRecords({ [name]: okf('Topic', 'Body.') }))
      const res = await submit({ ctx: c })
      expect(res.isError, `${name}: ${textOf(res)}`).toBeFalsy()
      const { generated, verified } = stampsOf(readFileSync(join(projectDir(), name), 'utf-8'))
      expect(verified?.by, name).toBe(ADMIN_UNKNOWN)
      expect(verified?.by, name).not.toBe(generated?.by)
      expect(generated?.by, name).toBe(SUBMITTER)
    }
  })

  it('TA-12 管理员的模型来自它的 md：用户覆盖的档案声明了模型 → agentType.model 原样带上；章上的管理员仍按对话现取', async () => {
    state.getProfile.mockImplementation((name: string) =>
      name === 'knowledge-writer'
        ? adminProfile({ model: 'anthropic/claude-haiku-4-5', source: 'user' })
        : undefined
    )
    await submit()
    const params = state.runTask.mock.calls[0][0] as { agentType: { model?: string } }
    expect(params.agentType.model).toBe('anthropic/claude-haiku-4-5')
    expect(stampsOf(readFileSync(join(projectDir(), 'topic.md'), 'utf-8')).verified?.by).toBe(ADMIN)
  })

  it('TA-13 管理员自己 submit 被拒（判的是调用方档案名，会话级按调用认人 / 按 agent 装配都一样）：不解析库、不派、不落盘；同一把工具换成 work 的对话照常', async () => {
    state.getProfile.mockImplementation((name: string) =>
      name === 'knowledge-writer' ? adminProfile({ source: 'user' }) : undefined
    )
    const agentOf = (c: number): NonNullable<ToolContext['agent']> =>
      c === 7
        ? identity('knowledge-writer', 'claude-haiku-4-5', 'spawned')
        : identity('work', 'gpt-5')
    const tool = makeKnowledgeTool({ sessionId: 's1', agentOf })
    const args = { action: 'submit', base: 'project', content: CONTENT } as const

    const refused = (await invokeTool(tool, args, { callId: 'w7', conversationId: 7 })).result
    expect(refused.isError).toBe(true)
    expect(textOf(refused)).toContain('You are the librarian')

    const perAgent = await failureText(
      executeTool(
        makeKnowledgeTool({
          sessionId: 's1',
          agent: identity('knowledge-writer', undefined, 'spawned')
        }),
        'w8',
        args
      )
    )
    expect(perAgent).toContain('You are the librarian')
    expect(state.resolveBase).not.toHaveBeenCalled()
    expect(state.getProfile).not.toHaveBeenCalled()
    expect(state.runTask).not.toHaveBeenCalled()
    expect(treeOf(projectDir())).toEqual([])

    const ok = (await invokeTool(tool, args, { callId: 'w1', conversationId: 1 })).result
    expect(ok.isError, textOf(ok)).toBeFalsy()
    expect(state.runTask).toHaveBeenCalledTimes(1)
  })

  it('TA-14 管理员照常检索、盘点、读（isAdmin 只拦 submit），list / search 的表头带库目录', async () => {
    seed(projectDir(), 'auth/token.md', okf('Token refresh', 'Body.'))
    state.search.mockResolvedValue([
      { path: 'auth/token.md', title: 'Token refresh', description: 'when touching token refresh' }
    ])
    const tool = makeKnowledgeTool(sessionCtx)
    const asAdmin = async (
      params: KnowledgeArgs
    ): Promise<Awaited<ReturnType<typeof invokeTool>>['result']> =>
      (await invokeTool(tool, params, { conversationId: ADMIN_CONVERSATION })).result

    const listed = await asAdmin({ action: 'list', base: 'project' })
    expect(listed.isError, textOf(listed)).toBeFalsy()
    expect(textOf(listed).split('\n')[0]).toBe(
      `1 entry in base "project" (project "Acme" — ${projectDir()}):`
    )
    const searched = await asAdmin({ action: 'search', base: 'project', query: 'token' })
    expect(searched.isError, textOf(searched)).toBeFalsy()
    expect(textOf(searched).split('\n')[0]).toBe(
      `1 result(s) for "token" in base "project" (project "Acme" — ${projectDir()}):`
    )
    const read = await asAdmin({ action: 'read', base: 'project', entry: '/auth/token.md' })
    expect(read.isError, textOf(read)).toBeFalsy()
    expect(textOf(read)).toContain('Body.')
    expect(state.scan).toHaveBeenCalledWith(BUNDLE)
    expect(state.search).toHaveBeenCalledWith(BUNDLE, 'token', { limit: 20 })
    expect(state.runTask).not.toHaveBeenCalled()
  })

  it('TA-15 目录反查不出 bundle（不在任何根下）：照常盖章，但变更管线一笔都不记；回包不漏那个目录', async () => {
    const stray = mkdtempSync(join(tmpdir(), 'shuvix-knowledge-stray-'))
    try {
      state.resolveBase.mockResolvedValue({ bundle: BUNDLE, dir: stray, label: 'stray' })
      state.runTask.mockImplementation(
        adminRecords(undefined, { report: (dir) => `Wrote ${dir}/topic.md.` })
      )
      const res = await submit()
      expect(res.isError, textOf(res)).toBeFalsy()
      const { generated, verified } = stampsOf(readFileSync(join(stray, 'topic.md'), 'utf-8'))
      expect(generated?.by).toBe(SUBMITTER)
      expect(verified?.by).toBe(ADMIN)
      expect(state.record).not.toHaveBeenCalled()
      expect(textOf(res)).toContain('Wrote /topic.md.')
      expectNoDirs(textOf(res), stray)
    } finally {
      rmSync(stray, { recursive: true, force: true })
    }
  })

  /**
   * 会话级装配的工具（ctx 带 agentOf、没有固定 agent）：提交者（任务文本里的 Submitted by、generated.by 与
   * 变更管线的 actor）按**这次调用**的对话认人；管理员的那一章各次都取自管理员对话。
   */
  it('TA-16 提交者按调用认人：work / sonnet、认不出、身份中途换了、bot、派生 explore / haiku —— 各盖各的，管理员章始终是管理员', async () => {
    const ADMIN_C = 99
    let current: ToolContext['agent']
    const agentOf = vi.fn((c: number) =>
      c === ADMIN_C
        ? identity('knowledge-writer', 'claude-haiku-4-5', 'spawned')
        : c === 2
          ? identity('explore', 'claude-haiku-4-5', 'spawned')
          : current
    )
    const tctx: ToolContext = { sessionId: 's1', agentOf }

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
      state.runTask
        .mockClear()
        .mockImplementation(
          adminRecords({ [name]: okf('Topic', 'Body.') }, { conversationId: ADMIN_C })
        )
      const res = await submit({ ctx: tctx, conversationId })
      expect(res.isError, `${name}: ${textOf(res)}`).toBeFalsy()
      expect((state.runTask.mock.calls[0][0] as { prompt: string }).prompt, name).toContain(
        `Submitted by: ${expected}`
      )
      const { generated, verified } = stampsOf(readFileSync(join(projectDir(), name), 'utf-8'))
      expect(generated?.by, name).toBe(expected)
      expect(verified?.by, name).toBe(ADMIN)
      expect(state.record, name).toHaveBeenCalledWith({
        bundle: BUNDLE,
        path: name,
        op: 'Update',
        actor: expected
      })
    }
    expect(agentOf).toHaveBeenCalledWith(ADMIN_C)
  })
})
