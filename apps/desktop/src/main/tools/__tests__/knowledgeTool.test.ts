/**
 * knowledge 工具（桌面注册）—— 复用 agent-runtime 的共享**读侧**内核，桌面只注入端适配。
 * 钉：注册元数据（name / group / presentation / describe）；以及适配那一层的两件事 ——
 * 目标库按**会话 + base** 解析（`project` 是根会话所属项目的库，其余名字是用户库），拿到的 bundle
 * 目录再反查回 bundle id（`projects/<id>` / `knowledge/<库名>`）交给扫描 / 检索；`bases` 直接走宿主的
 * listBases，不解析任何 base。
 *
 * 只有 `create` 会写盘并自己记一笔账；改动条目走普通 `edit`，那条路的记账钉在文件工具那侧。
 *
 * services/knowledge 只替到接口那一层：locateBundle 用**真的**（目录 → bundle id 这条往返
 * 正是适配层的实质），扫描 / 检索是替身。
 *
 * 第三个名字空间是随应用发布的**内置库**（`builtin/<库名>`，保留名 `shuvix`）：磁盘上比另外两个根多
 * 一层语言目录，只读 —— TK-6..TK-10 钉它在工具这一侧的样子。
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
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
import { join } from 'node:path'

const state = vi.hoisted(() => ({
  root: '',
  registered: [] as Array<Record<string, unknown>>,
  record: vi.fn(),
  resolveBase: vi.fn(),
  listBases: vi.fn(),
  search: vi.fn(),
  scan: vi.fn(),
  concepts: [] as unknown[]
}))

vi.mock('../../utils/paths', () => ({
  getShuvixKnowledgeRootDir: () => state.root,
  getUserKnowledgeRootDir: () => `${state.root}-user`,
  // 内置库根替身：root 的兄弟目录 —— 缺省不存在（TK-1..TK-5 里没有内置库），TK-6..TK-10 自己种
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
  agentActorOf: (ctx: {
    agent?: { profileName?: string; getModelConfig?: () => { model?: string } }
  }): string =>
    `shuvix-${ctx.agent?.profileName ?? 'agent'}/${ctx.agent?.getModelConfig?.().model ?? 'unknown'}`,
  getDesktopSecurityContext: () => ({ enforcePath: vi.fn() }),
  TOOL_ABORTED: 'Aborted'
}))
vi.mock('../../i18n', () => ({ t: (k: string) => k }))
// i18next 是单例：内置库的语言目录从它现读。真身在单测里没 init（`language` 是 undefined），
// 换成替身才说得清「当前界面语言是哪个」—— 语言那一层不进 bundle id，但决定磁盘上的哪一版生效
const i18n = vi.hoisted(() => ({ language: 'en' }))
vi.mock('i18next', () => ({
  default: {
    get language() {
      return i18n.language
    },
    t: (key: string) => `i18n(${key})`
  }
}))

import { KNOWLEDGE_DESCRIPTION, KnowledgeParamsSchema } from '@shuvix/agent-runtime'
import { BUILTIN_TOOL_PRESENTATIONS } from '@shuvix/chat-protocol/builtinToolPresentations'
import { makeKnowledgeTool } from '../knowledge'
import type { ToolContext } from '../../services/toolContext'

const BUNDLE = 'projects/acme'

const ctx: ToolContext = {
  sessionId: 's1',
  agent: {
    profileName: 'work',
    kind: 'root',
    getModelConfig: () => ({ provider: 'p', model: 'gpt-5', capabilities: {} })
  }
}

/** 本会话的目标 bundle：`projects/acme`，落在临时 shuvix 根下 */
const target = (): { bundle: string; dir: string; label: string } => ({
  bundle: BUNDLE,
  dir: join(state.root, 'projects', 'acme'),
  label: 'project "Acme"'
})

const textOf = (res: { content: unknown[] }): string => (res.content[0] as { text: string }).text

/** 目录下的全部条目（递归、`/` 分隔、字典序）；目录不在给 `[]` —— 「磁盘没多出东西」一律比它 */
const treeOf = (dir: string): string[] => {
  try {
    return readdirSync(dir, { recursive: true })
      .map((p) => String(p).replace(/\\/g, '/'))
      .sort()
  } catch {
    return []
  }
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
  state.record.mockClear()
  state.resolveBase.mockReset().mockResolvedValue(target())
  state.listBases.mockReset().mockResolvedValue([])
  state.scan.mockReset().mockResolvedValue({ files: [], concepts: state.concepts, notes: [] })
  state.search.mockReset().mockResolvedValue([])
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

  it('TK-2 create 把变更记成 Creation（actor = agentActorOf）；读侧不记账；base 原样交给宿主解析', async () => {
    const tool = makeKnowledgeTool(ctx)
    expect(tool.label).toBe('tool.knowledgeLabel')

    await tool.execute('c1', {
      action: 'create',
      base: 'project',
      type: 'Memory',
      title: 'T',
      description: 'd',
      body: 'b'
    })
    expect(state.resolveBase).toHaveBeenLastCalledWith('s1', 'project')
    const written = join(state.root, 'projects', 'acme', 't.md')
    expect(existsSync(written)).toBe(true)
    expect(readFileSync(written, 'utf-8')).toContain('shuvix: okf v0.2')
    expect(state.record).toHaveBeenLastCalledWith({
      bundle: BUNDLE,
      path: 't.md',
      op: 'Creation',
      actor: 'shuvix-work/gpt-5'
    })

    for (const action of ['list', 'search', 'validate'] as const) {
      await tool.execute('c2', { action, base: 'project', query: 'q' })
      expect(state.resolveBase, action).toHaveBeenLastCalledWith('s1', 'project')
    }
    expect(state.record).toHaveBeenCalledTimes(1)
  })

  it('TK-3 读路径：list / search / validate 都把 bundle 目录反查成 bundle id 再交给扫描 / 检索；解析不出 bundle 的目录 → 空清单、空结果', async () => {
    const tool = makeKnowledgeTool(ctx)

    await tool.execute('c5', { action: 'list', base: 'project' })
    expect(state.scan).toHaveBeenLastCalledWith(BUNDLE)

    await tool.execute('c6', { action: 'search', base: 'project', query: 'token', limit: 5 })
    expect(state.search).toHaveBeenLastCalledWith(BUNDLE, 'token', { limit: 5 })

    await tool.execute('c7', { action: 'validate', base: 'project' })
    expect(state.scan).toHaveBeenLastCalledWith(BUNDLE)

    // 目标目录不在 shuvix 根下（理论上不该发生）：扫描 / 检索不被调用
    const stray = mkdtempSync(join(tmpdir(), 'shuvix-knowledge-stray-'))
    try {
      state.resolveBase.mockResolvedValue({ bundle: BUNDLE, dir: stray, label: 'stray' })
      state.scan.mockClear()
      state.search.mockClear()

      const listed = await tool.execute('c8', { action: 'list', base: 'project' })
      expect(state.scan).not.toHaveBeenCalled()
      expect(listed.content[0]).toMatchObject({ text: `No entries in stray — ${stray} yet.` })
      await tool.execute('c9', { action: 'search', base: 'project', query: 'token' })
      expect(state.search).not.toHaveBeenCalled()
    } finally {
      rmSync(stray, { recursive: true, force: true })
    }
  })

  it('TK-4 [白盒·适配层] 用户库：解析出的用户根下目录经 locateBundle 反查回 `knowledge/<库名>`，list / search / validate / create 都拿这个 id 交给扫描 / 检索 / 变更管线；create 落在用户库目录里', async () => {
    const userRoot = `${state.root}-user`
    mkdirSync(join(userRoot, 'notes'), { recursive: true })
    state.resolveBase.mockResolvedValue({
      bundle: 'knowledge/notes',
      dir: join(userRoot, 'notes'),
      label: 'knowledge base "notes"'
    })
    const tool = makeKnowledgeTool(ctx)

    await tool.execute('u1', { action: 'list', base: 'notes' })
    expect(state.resolveBase).toHaveBeenLastCalledWith('s1', 'notes')
    expect(state.scan).toHaveBeenLastCalledWith('knowledge/notes')

    await tool.execute('u2', { action: 'search', base: 'notes', query: 'q', limit: 3 })
    expect(state.search).toHaveBeenLastCalledWith('knowledge/notes', 'q', { limit: 3 })

    state.scan.mockClear()
    await tool.execute('u3', { action: 'validate', base: 'notes' })
    expect(state.scan).toHaveBeenLastCalledWith('knowledge/notes')

    await tool.execute('u4', {
      action: 'create',
      base: 'notes',
      type: 'Memory',
      title: 'T',
      description: 'd',
      body: 'b'
    })
    expect(state.resolveBase).toHaveBeenLastCalledWith('s1', 'notes')
    const written = join(userRoot, 'notes', 't.md')
    expect(existsSync(written)).toBe(true)
    expect(readFileSync(written, 'utf-8')).toContain('shuvix: okf v0.2')
    expect(state.record).toHaveBeenLastCalledWith({
      bundle: 'knowledge/notes',
      path: 't.md',
      op: 'Creation',
      actor: 'shuvix-work/gpt-5'
    })
  })

  it('TK-5 `bases` 直接走宿主的 listBases（传根会话 id），不解析任何 base；每个库一行带标签与目录', async () => {
    state.listBases.mockResolvedValue([
      { base: 'project', label: 'this project', note: 'this session does not belong to a project' },
      { base: 'notes', label: 'knowledge base "notes"', dir: '/u/notes' }
    ])

    const res = await makeKnowledgeTool(ctx).execute('b1', { action: 'bases' })

    expect(state.listBases).toHaveBeenCalledTimes(1)
    expect(state.listBases).toHaveBeenCalledWith('s1')
    expect(state.resolveBase).not.toHaveBeenCalled()
    expect((res.content[0] as { text: string }).text).toContain(
      '- notes — knowledge base "notes" — /u/notes'
    )
  })
})

/**
 * 随应用发布的内置库（TK-6..TK-10）。与另外两个名字空间的差别只有两处，但都落在这一层：
 *
 *   - 磁盘上多一层**语言目录**（`<内置根>/<库名>/<语言>/…`），而语言**不进 bundle id** ——
 *     所以适配层那条「bundle 目录 → bundle id」的反查（探针路径）必须连语言一起认，
 *     两种语言反查回来是**同一个** id，且只有此刻生效的那一版算数。
 *   - 它**只读**：`create` 由工具自己拒（不留给安全策略 —— 策略拒的是路径，说不清该记到哪去），
 *     读侧四个动作与别的库一模一样。
 */
describe('TK-6..TK-10 内置库（语言目录、只读、垫底）', () => {
  const BUILTIN_BUNDLE = 'builtin/shuvix'
  /** 宿主 builtinTarget 的回包（sessionBundle.ts）——工具只用 dir / label / readonly */
  const BUILTIN_LABEL = 'ShuviX reference (read-only)'
  /** listBases 只给内置那一行加的只读提示 */
  const BUILTIN_NOTE = 'read-only: search and read it, never create or edit here'
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
  /** 种出某个语言那一版（真文件：read 是直接读盘的，不经扫描替身） */
  const seedBuiltin = (lang: string): string => {
    const abs = join(builtinDir(lang), ENTRY)
    mkdirSync(builtinDir(lang), { recursive: true })
    writeFileSync(abs, entryText(lang), 'utf-8')
    return abs
  }
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
    // 内置根是 root 的兄弟目录：种过的用例自己收，否则下一个用例凭空多出一个内置库
    rmSync(builtinRoot(), { recursive: true, force: true })
  })

  it('TK-6 [白盒·适配层] 反查连语言那一层一起认：两种语言反查回同一个 `builtin/<库名>`，list / search 拿它交给扫描 / 检索，read 读的是生效语言那一份真文件；换了语言，另一版的目录就不属于任何 bundle', async () => {
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

    const listed = await tool.execute('k1', { action: 'list', base: 'shuvix' })
    expect(state.resolveBase).toHaveBeenLastCalledWith('s1', 'shuvix')
    expect(state.scan).toHaveBeenLastCalledWith(BUILTIN_BUNDLE)
    expect(textOf(listed)).toContain(`1 entry in ${BUILTIN_LABEL} — ${builtinDir()}:`)
    expect(textOf(listed)).toContain(`- /${ENTRY}`)

    await tool.execute('k2', { action: 'search', base: 'shuvix', query: 'agent', limit: 5 })
    expect(state.search).toHaveBeenLastCalledWith(BUILTIN_BUNDLE, 'agent', { limit: 5 })

    // read 不经反查：按 bundle 目录直接读盘 —— 读到的必须是语言目录下那一份
    const read = await tool.execute('k3', { action: 'read', base: 'shuvix', path: `/${ENTRY}` })
    expect(textOf(read)).toContain(`${builtinDir()}/${ENTRY}:`)
    expect(textOf(read)).toContain('en body')

    // 切到 zh（`zh-CN` 取基础段）：同一个 bundle id，另一个目录、另一份原文
    i18n.language = 'zh-CN'
    state.resolveBase.mockResolvedValue(builtinTarget('zh'))
    state.scan.mockClear()
    await tool.execute('k4', { action: 'list', base: 'shuvix' })
    expect(state.scan).toHaveBeenLastCalledWith(BUILTIN_BUNDLE)
    const readZh = await tool.execute('k5', { action: 'read', base: 'shuvix', path: `/${ENTRY}` })
    expect(textOf(readZh)).toContain('zh body')

    // 生效语言是 zh 时，en 那一版不属于任何 bundle：扫描一次都不该被调用（与 TK-3 的界外目录同口径）
    state.scan.mockClear()
    state.resolveBase.mockResolvedValue(builtinTarget('en'))
    const stale = await tool.execute('k6', { action: 'list', base: 'shuvix' })
    expect(state.scan).not.toHaveBeenCalled()
    expect(textOf(stale)).toBe(`No entries in ${BUILTIN_LABEL} — ${builtinDir('en')} yet.`)

    // 全程只读：两份原文原样
    expect(readFileSync(en, 'utf-8')).toBe(entryText('en'))
    expect(readFileSync(zh, 'utf-8')).toBe(entryText('zh'))
  })

  it('TK-7 create 打到内置库：工具自己拒，话里点名「去用户的库记」；零落盘、库都没扫、变更管线零调用', async () => {
    seedBuiltin('en')
    const before = treeOf(builtinRoot())
    const tool = makeKnowledgeTool(ctx)

    const thrown = await tool
      .execute('k7', {
        action: 'create',
        base: 'shuvix',
        type: 'Memory',
        title: 'T',
        description: 'd',
        body: 'b'
      })
      .then(
        () => null,
        (e: unknown) => e
      )
    expect(thrown).toBeInstanceOf(Error)
    const message = (thrown as Error).message
    expect(message).toContain('"shuvix" is read-only')
    // 只说「不行」模型只会换个写法再试一次：得说清该记到哪里去，以及去哪儿看有哪些库
    expect(message).toMatch(/user's knowledge bases/)
    expect(message).toContain('"bases"')

    // 拒在最前：连库都没扫（拿不到文件名清单，就更不可能写）
    expect(state.scan).not.toHaveBeenCalled()
    expect(state.record).not.toHaveBeenCalled()
    expect(treeOf(builtinRoot())).toEqual(before)
  })

  it('TK-8 对照：同一会话里紧接着写用户库照常成功、照常记一条 Creation —— 只读守的是内置库，不是把新建关上', async () => {
    seedBuiltin('en')
    const untouched = treeOf(builtinRoot())
    const userRoot = `${state.root}-user`
    mkdirSync(join(userRoot, 'lib'), { recursive: true })
    // 同一个会话、同一把工具：base 名决定落到哪个库
    state.resolveBase.mockImplementation(async (_sessionId: string, base: string) =>
      base === 'shuvix'
        ? builtinTarget()
        : { bundle: 'knowledge/lib', dir: join(userRoot, 'lib'), label: 'knowledge base "lib"' }
    )
    const tool = makeKnowledgeTool(ctx)
    const params = {
      action: 'create' as const,
      type: 'Memory',
      title: 'Auth Notes',
      description: 'd',
      body: 'b'
    }

    await expect(tool.execute('k8', { ...params, base: 'shuvix' })).rejects.toThrow('read-only')
    expect(state.record).not.toHaveBeenCalled()

    const created = await tool.execute('k9', { ...params, base: 'lib' })
    const written = join(userRoot, 'lib', 'auth-notes.md')
    expect(existsSync(written)).toBe(true)
    expect(readFileSync(written, 'utf-8')).toContain('shuvix: okf v0.2')
    expect(textOf(created)).toContain(`Created ${written}`)
    expect(state.record).toHaveBeenCalledTimes(1)
    expect(state.record).toHaveBeenCalledWith({
      bundle: 'knowledge/lib',
      path: 'auth-notes.md',
      op: 'Creation',
      actor: 'shuvix-work/gpt-5'
    })
    expect(treeOf(builtinRoot())).toEqual(untouched)
  })

  it('TK-9 `bases` 的回包：内置那一行带 `(read-only: …)` 且排最后（宿主的次序原样印出），用户库 / 项目库那两行不带', async () => {
    state.listBases.mockResolvedValue([
      { base: 'notes', label: 'knowledge base "notes"', dir: '/u/notes' },
      { base: 'project', label: 'project "Acme"', dir: '/p/acme' },
      { base: 'shuvix', label: BUILTIN_LABEL, dir: builtinDir(), note: BUILTIN_NOTE }
    ])

    const res = await makeKnowledgeTool(ctx).execute('k10', { action: 'bases' })
    const lines = textOf(res).split('\n')

    expect(lines[0]).toBe('Knowledge bases in this session (pass the name as `base`):')
    // 垫底是宿主排的（说明书不是用户的内容），工具不重排 —— 两边一动，模型看到的次序就变了
    expect(lines.slice(1).map((l) => l.split(' — ')[0])).toEqual([
      '- notes',
      '- project',
      '- shuvix'
    ])
    expect(lines[lines.length - 1]).toBe(
      `- shuvix — ${BUILTIN_LABEL} — ${builtinDir()} (${BUILTIN_NOTE})`
    )
    // 只有它这一行带只读提示（label 里那个 `(read-only)` 不算 —— 判的是 note 的括号）
    expect(lines.filter((l) => l.includes('(read-only:'))).toHaveLength(1)
    expect(state.resolveBase).not.toHaveBeenCalled()
  })

  it('TK-10 不带 `base` 的 search 覆盖全部启用库（含内置库），按库分组；每个库各按自己的 bundle id 检索，一个 base 都不解析', async () => {
    const userRoot = `${state.root}-user`
    state.listBases.mockResolvedValue([
      { base: 'notes', label: 'knowledge base "notes"', dir: join(userRoot, 'notes') },
      { base: 'project', label: 'project "Acme"', dir: join(state.root, 'projects', 'acme') },
      { base: 'shuvix', label: BUILTIN_LABEL, dir: builtinDir(), note: BUILTIN_NOTE }
    ])
    state.search.mockImplementation(async (bundle: string) => [
      { path: ENTRY, title: 'T', description: `hit in ${bundle}` }
    ])

    const res = await makeKnowledgeTool(ctx).execute('k11', { action: 'search', query: 'token' })

    // 三个库各一次，各自反查出自己的 id —— 内置库那一次的目录里夹着语言层
    expect(state.search.mock.calls.map((c) => c[0])).toEqual([
      'knowledge/notes',
      'projects/acme',
      BUILTIN_BUNDLE
    ])
    expect(state.search.mock.calls.map((c) => c[1])).toEqual(['token', 'token', 'token'])

    const out = textOf(res)
    expect(out.split('\n')[0]).toBe('3 result(s) for "token" across 3 base(s):')
    // 按库分组：每个库一个小标题，标题里是该库的绝对目录（内置库的那一份到语言层）
    expect(out).toContain(`base "notes" — ${join(userRoot, 'notes')}:`)
    expect(out).toContain(`base "project" — ${join(state.root, 'projects', 'acme')}:`)
    expect(out).toContain(`base "shuvix" — ${builtinDir()}:`)
    expect(out).toContain(`hit in ${BUILTIN_BUNDLE}`)
    // 省略 base 的检索不解析任何 base：范围就是 listBases 给的那一份
    expect(state.resolveBase).not.toHaveBeenCalled()
  })
})
