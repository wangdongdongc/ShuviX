/**
 * knowledge 工具 —— 知识库的结构化读写面（设计 §6.1，决策 D4）。
 *
 * 宿主无关：文件经内存 port，扫描 / 作用域解析 / 检索 / 写后处理全部由用例注入。钉四件事：
 * agent 面的枚举（尤其是 set-status 不能标 stable —— schema 与运行时各守一遍）、路径守卫表、
 * 各 action 的回执文本与 details，以及 write / set-status 以目标**绝对路径**过与文件写入
 * 同一道 PEP（review-knowledge-writes 因此同时盖住工具与直写文件）。
 */
import { describe, it, expect, vi, type Mock } from 'vitest'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import type { InputRequest, InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import {
  KNOWLEDGE_SCOPE_KINDS,
  KNOWLEDGE_TYPES,
  type KnowledgeScopeKind
} from '@shuvix/chat-protocol/knowledge'
import type { FileSystemPort } from '../../fileTools/port'
import { createSecurityContext } from '../../security/context'
import type { SecurityContext, SecurityHostProvider } from '../../security/types'
import { parseConceptText, type KnowledgeConcept } from '../conceptFile'
import {
  createKnowledgeTool,
  KNOWLEDGE_TOOL_NAME,
  KnowledgeParamsSchema,
  type KnowledgeScopeTarget,
  type KnowledgeSearchHit,
  type KnowledgeToolParams
} from '../knowledgeTool'
import { isReservedFile } from '../validate'

const ROOT = '/kb'
const NOW = new Date('2026-09-09T08:12:03.000Z')
const ACTOR = 'shuvix-work/gpt-5'
const STAMP = 'generated: { by: "shuvix-work/gpt-5", at: "2026-09-09T08:12:03.000Z" }'

/** 一份概念文本：frontmatter 行 + 正文（尾随换行，同 conceptFile.test 的 doc 惯例） */
const doc = (frontmatter: string[], body = 'body'): string =>
  ['---', ...frontmatter, '---', '', body, ''].join('\n')

const GLOBAL: KnowledgeScopeTarget = { dir: 'global', label: 'global' }

type ScopeTable = Partial<Record<KnowledgeScopeKind, KnowledgeScopeTarget | { error: string }>>

interface ToolOptions {
  /** 内存 port 的初始文件（绝对路径 → 内容） */
  files?: Record<string, string>
  /** 作用域解析表（缺省只有 global）；缺表项按 `{error}` 回 */
  scopes?: ScopeTable
  search?: (query: string, opts: { limit: number; dir?: string }) => Promise<KnowledgeSearchHit[]>
  /** 不传 = 只记录调用的 enforcePath 桩；KT-12 换成真实 SecurityContext */
  security?: SecurityContext
  abortError?: string
}

type Result = AgentToolResult<unknown>

interface Harness {
  tool: ReturnType<typeof createKnowledgeTool>
  files: Map<string, string>
  enforcePath: Mock
  resolveScope: Mock
  afterWrite: Mock
  /** 调用顺序流水：`enforce:<mode>:<abs>` / `write:<abs>` —— 钉「先过门再落盘」 */
  calls: string[]
  run: (id: string, params: KnowledgeToolParams, signal?: AbortSignal) => Promise<Result>
}

const textOf = (res: Result): string => (res.content[0] as { text: string }).text

function memoryPort(files: Map<string, string>, calls: string[]): FileSystemPort {
  return {
    stat: (p) => {
      const c = files.get(p)
      return Promise.resolve(
        c === undefined ? null : { isFile: true, isDirectory: false, size: c.length, mtimeMs: 1 }
      )
    },
    readFile: (p) => {
      const c = files.get(p)
      return c === undefined ? Promise.reject(new Error(`ENOENT: ${p}`)) : Promise.resolve(c)
    },
    async *readTextLines(p) {
      const c = files.get(p)
      if (c === undefined) throw new Error(`ENOENT: ${p}`)
      for (const line of c.split('\n')) yield line
    },
    writeFile: (p, content) => {
      calls.push(`write:${p}`)
      files.set(p, content)
      return Promise.resolve()
    },
    readBytes: () => {
      throw new Error('not used')
    },
    readdir: () => Promise.resolve([])
  }
}

/** 宿主扫描的替身：把 port 里根目录下的概念解析出来（保留文件与非概念不算） */
function conceptsOf(files: Map<string, string>): KnowledgeConcept[] {
  const out: KnowledgeConcept[] = []
  for (const [abs, text] of files) {
    if (!abs.startsWith(`${ROOT}/`)) continue
    const rel = abs.slice(ROOT.length + 1)
    if (isReservedFile(rel)) continue
    const concept = parseConceptText(text, rel)
    if (concept) out.push(concept)
  }
  return out
}

function makeTool(opts: ToolOptions = {}): Harness {
  const files = new Map(Object.entries(opts.files ?? {}))
  const calls: string[] = []
  const enforcePath = vi.fn(async (mode: string, abs: string) => {
    calls.push(`enforce:${mode}:${abs}`)
  })
  const security = opts.security ?? ({ enforcePath } as unknown as SecurityContext)
  const scopes: ScopeTable = { global: GLOBAL, ...opts.scopes }
  const resolveScope = vi.fn(
    async (scope: KnowledgeScopeKind): Promise<KnowledgeScopeTarget | { error: string }> =>
      scopes[scope] ?? { error: `no scope ${scope}` }
  )
  const afterWrite = vi.fn()
  const tool = createKnowledgeTool({
    root: ROOT,
    port: memoryPort(files, calls),
    security,
    listConcepts: async () => conceptsOf(files),
    resolveScope,
    search: opts.search,
    actor: () => ACTOR,
    now: () => NOW,
    afterWrite,
    abortError: opts.abortError,
    label: 'Knowledge'
  })
  return {
    tool,
    files,
    enforcePath,
    resolveScope,
    afterWrite,
    calls,
    run: (id, params, signal) => tool.execute(id, params, signal)
  }
}

describe('KT-1 schema 枚举与运行时守卫', () => {
  const props = KnowledgeParamsSchema.properties as unknown as Record<
    string,
    { enum?: string[]; description?: string }
  >

  it('KT-1 action / scope / status 三个枚举钉死；type 的描述列出全部词汇表；工具名与标签', () => {
    expect(KNOWLEDGE_TOOL_NAME).toBe('knowledge')
    const { tool } = makeTool()
    expect(tool.name).toBe('knowledge')
    expect(tool.label).toBe('Knowledge')
    expect(props.action.enum).toEqual(['search', 'read', 'write', 'set-status', 'list'])
    expect(props.scope.enum).toEqual([...KNOWLEDGE_SCOPE_KINDS])
    // agent 只能标 draft / deprecated —— stable 只有用户能设
    expect(props.status.enum).toEqual(['draft', 'deprecated'])
    for (const type of KNOWLEDGE_TYPES) expect(props.type.description, type).toContain(type)
  })

  it('KT-1 preExecute / securityCheck 不碰 PEP（逐 action 在内部按算出的路径过）；越过 schema 传 stable 也被运行时拒绝、不写文件', async () => {
    const h = makeTool({
      files: {
        '/kb/global/a.md': doc(['type: Memory', 'title: A', 'description: da', 'status: draft'])
      }
    })
    await h.tool.preExecute()
    await h.run('c1', { action: 'list' })
    expect(h.enforcePath).not.toHaveBeenCalled()

    const before = h.files.get('/kb/global/a.md')
    await expect(
      h.run('c2', {
        action: 'set-status',
        path: '/global/a.md',
        status: 'stable' as unknown as 'draft'
      })
    ).rejects.toThrow('only the user can make an entry stable')
    expect(h.files.get('/kb/global/a.md')).toBe(before)
    expect(h.calls).toEqual([])
    expect(h.afterWrite).not.toHaveBeenCalled()
  })
})

describe('KT-2 路径守卫表', () => {
  const RESERVED = 'reserved file maintained by the host'
  const table: [string, KnowledgeToolParams, string][] = [
    ['read /', { action: 'read', path: '/' }, 'not inside the knowledge base'],
    ['read ../etc/x.md', { action: 'read', path: '../etc/x.md' }, 'not inside the knowledge base'],
    ['read /global/x.txt', { action: 'read', path: '/global/x.txt' }, 'not a markdown entry (.md)'],
    ['write /log.md', { action: 'write', path: '/log.md', body: 'b' }, RESERVED],
    ['write /global/index.md', { action: 'write', path: '/global/index.md', body: 'b' }, RESERVED],
    ['set-status /index.md', { action: 'set-status', path: '/index.md', status: 'draft' }, RESERVED]
  ]

  it.each(table)('KT-2 %s → 拒绝，且不过 PEP、不写文件', async (_label, params, message) => {
    const h = makeTool({
      files: { '/kb/log.md': '## 2026-09-09\n', '/kb/index.md': '', '/kb/global/index.md': '' }
    })
    await expect(h.run('c1', params)).rejects.toThrow(message)
    expect(h.calls).toEqual([])
    expect(h.afterWrite).not.toHaveBeenCalled()
  })

  it('KT-2 读保留文件允许（index.md 正是给 agent 看的）；已中止的 signal → 抛注入的 abortError', async () => {
    const h = makeTool({
      files: { '/kb/global/index.md': '## Entries\n\n* [A](a.md)\n' },
      abortError: 'TOOL_ABORTED'
    })
    const res = await h.run('c1', { action: 'read', path: '/global/index.md' })
    expect(textOf(res)).toBe('/global/index.md:\n\n## Entries\n\n* [A](a.md)')

    const ac = new AbortController()
    ac.abort()
    await expect(h.run('c2', { action: 'list' }, ac.signal)).rejects.toThrow('TOOL_ABORTED')
  })
})

describe('KT-3 search —— 注入的检索（宿主 okf-minisearch）', () => {
  it('KT-3 命中：query 与 {limit, dir} 原样转发；逐行 `- /path (status) — description|title` + 缩进 snippet；作用域按 create:false 解析', async () => {
    const search = vi.fn(async () => [
      { path: '/global/a.md', title: 'A', description: 'd', status: 'draft', snippet: 's' },
      { path: 'global/b.md', title: 'B', status: 'stable' }
    ])
    const h = makeTool({
      search,
      scopes: { project: { dir: 'projects/acme', label: 'project "acme"' } }
    })
    const res = await h.run('c1', { action: 'search', query: 'q', scope: 'project' })
    expect(h.resolveScope).toHaveBeenCalledWith('project', { topic: undefined, create: false })
    expect(search).toHaveBeenCalledWith('q', { limit: 20, dir: 'projects/acme' })
    expect(textOf(res)).toBe(
      '2 result(s) for "q":\n- /global/a.md (draft) — d\n  s\n- /global/b.md — B'
    )
    expect(res.details).toEqual({ action: 'search' })
    expect(h.enforcePath).not.toHaveBeenCalled()
  })

  it('KT-3 零命中回一句话；缺 query 抛错；作用域解析失败按 list 同口径回文字（不抛）', async () => {
    const search = vi.fn(async () => [])
    const h = makeTool({
      search,
      scopes: { bot: { error: 'This session is not bound to a bot — there is no bot scope here.' } }
    })
    expect(textOf(await h.run('c1', { action: 'search', query: 'q', limit: 5 }))).toBe(
      'No entries match "q".'
    )
    expect(search).toHaveBeenCalledWith('q', { limit: 5, dir: undefined })
    await expect(h.run('c2', { action: 'search', query: '  ' })).rejects.toThrow(
      '"search" needs `query`'
    )
    const res = await h.run('c3', { action: 'search', query: 'q', scope: 'bot' })
    expect(textOf(res)).toBe('This session is not bound to a bot — there is no bot scope here.')
    expect(res.details).toEqual({ action: 'search' })
    expect(search).toHaveBeenCalledTimes(1)
  })
})

describe('KT-4 search —— 缺省子串检索（无 search 注入）', () => {
  const FILES = {
    '/kb/global/a.md': doc([
      'type: Memory',
      'title: Token refresh',
      'description: da',
      'status: draft',
      'generated: { by: g, at: "2026-09-09T08:12:03.000Z" }'
    ]),
    '/kb/global/b.md': doc(['type: Memory', 'title: B', 'description: db'], 'the TOKEN expires'),
    '/kb/global/c.md': doc(['type: Memory', 'title: C', 'description: dc', 'tags: [token]']),
    '/kb/global/d.md': doc([
      'type: Memory',
      'title: Token dep',
      'description: dd',
      'status: deprecated'
    ]),
    '/kb/projects/acme/e.md': doc(['type: Memory', 'title: Token in acme', 'description: de']),
    '/kb/global/f.md': doc(['type: Memory', 'title: F', 'description: df'])
  }

  it('KT-4 标题 / 正文（大小写不敏感）/ 标签都算命中，deprecated 排除；作用域按目录前缀过滤；计数看全部命中、行数按 limit 截', async () => {
    const h = makeTool({ files: FILES })
    const all = await h.run('c1', { action: 'search', query: 'token' })
    expect(textOf(all)).toBe(
      [
        '4 result(s) for "token":',
        '- /global/a.md (draft, 2026-09-09) — da',
        '- /global/b.md — db',
        '- /global/c.md — dc',
        '- /projects/acme/e.md — de'
      ].join('\n')
    )
    const scoped = await h.run('c2', {
      action: 'search',
      query: 'Token',
      scope: 'global',
      limit: 1
    })
    expect(textOf(scoped)).toBe('3 result(s) for "Token":\n- /global/a.md (draft, 2026-09-09) — da')
    expect(textOf(await h.run('c3', { action: 'search', query: 'zzz' }))).toBe(
      'No entries match "zzz".'
    )
  })
})

describe('KT-5 list', () => {
  const FILES = {
    '/kb/global/a.md': doc(['type: Memory', 'title: A', 'description: da', 'status: draft']),
    '/kb/global/b.md': doc(['type: Memory', 'title: B', 'description: db']),
    '/kb/global/d.md': doc(['type: Memory', 'title: D', 'description: dd', 'status: deprecated'])
  }

  it('KT-5 无作用域列全库（含 deprecated，带标注）；limit 之外折成一行计数', async () => {
    const h = makeTool({ files: FILES })
    expect(textOf(await h.run('c1', { action: 'list' }))).toBe(
      [
        '3 entries:',
        '- /global/a.md (draft) — da',
        '- /global/b.md — db',
        '- /global/d.md (deprecated) — dd'
      ].join('\n')
    )
    expect(textOf(await h.run('c2', { action: 'list', limit: 2 }))).toBe(
      ['3 entries:', '- /global/a.md (draft) — da', '- /global/b.md — db', '- … 1 more'].join('\n')
    )
  })

  it('KT-5 作用域解析失败回文字；空作用域 / 空库各有一句话；有作用域时表头点名标签', async () => {
    const h = makeTool({
      files: FILES,
      scopes: {
        project: { dir: 'projects/acme', label: 'project "acme"' },
        bot: { error: 'no bot here' }
      }
    })
    const failed = await h.run('c1', { action: 'list', scope: 'bot' })
    expect(textOf(failed)).toBe('no bot here')
    expect(failed.details).toEqual({ action: 'list' })
    expect(h.resolveScope).toHaveBeenCalledWith('bot', { topic: undefined, create: false })
    expect(textOf(await h.run('c2', { action: 'list', scope: 'project' }))).toBe(
      'No entries in project "acme" yet.'
    )
    expect(textOf(await h.run('c3', { action: 'list', scope: 'global', limit: 1 }))).toBe(
      '3 entries in global:\n- /global/a.md (draft) — da\n- … 2 more'
    )
    expect(textOf(await makeTool().run('c4', { action: 'list' }))).toBe(
      'The knowledge base is empty.'
    )
  })
})

describe('KT-6 read', () => {
  it('KT-6 过 read PEP（绝对路径 + 展示路径 + operation），回 `/path:` + 原文 trimEnd，details 带相对路径', async () => {
    const raw = `${doc(['type: Memory', 'title: A', 'description: da', 'status: draft'])}\n\n`
    const h = makeTool({ files: { '/kb/global/a.md': raw } })
    const res = await h.run('c1', { action: 'read', path: '/global/a.md' })
    expect(h.enforcePath).toHaveBeenCalledTimes(1)
    expect(h.enforcePath).toHaveBeenCalledWith('read', '/kb/global/a.md', {
      toolCallId: 'c1',
      toolName: 'knowledge',
      displayPath: '/global/a.md',
      operation: 'read',
      abortError: 'Aborted'
    })
    expect(textOf(res)).toBe(`/global/a.md:\n\n${raw.trimEnd()}`)
    expect(res.details).toEqual({ action: 'read', path: 'global/a.md' })
  })

  it('KT-6 条目不存在 / 缺 path', async () => {
    const h = makeTool()
    await expect(h.run('c1', { action: 'read', path: '/global/x.md' })).rejects.toThrow(
      'No entry at /global/x.md'
    )
    await expect(h.run('c2', { action: 'read' })).rejects.toThrow('"read" needs `path`')
  })
})

describe('KT-7 write —— 新建', () => {
  it('KT-7 作用域按 create:true 解析；文件形状（type 归一、draft、宿主章、pinned 扩展键、来源流式）；先过 write PEP 再落盘；afterWrite 无 status 键；回执', async () => {
    const h = makeTool()
    const res = await h.run('c1', {
      action: 'write',
      scope: 'global',
      type: 'memory',
      title: 'Token Refresh: Pitfalls',
      description: 'when touching auth',
      body: '\n\nbody\n',
      tags: ['auth'],
      sources: [{ resource: '/abs/p.ts', id: 's1' }],
      stale_after: '2026-12-31',
      pinned: true
    })
    expect(h.resolveScope).toHaveBeenCalledWith('global', { topic: undefined, create: true })

    const abs = '/kb/global/token-refresh-pitfalls.md'
    expect(h.files.get(abs)).toBe(
      [
        '---',
        'type: Memory',
        'title: "Token Refresh: Pitfalls"',
        'description: when touching auth',
        'tags:',
        '  - auth',
        'status: draft',
        'stale_after: 2026-12-31',
        'sources: [ { id: s1, resource: "/abs/p.ts" } ]',
        STAMP,
        'shuvix_pinned: true',
        '---',
        '',
        'body',
        ''
      ].join('\n')
    )
    expect(h.files.get(abs)).not.toContain('verified')
    // 先过门再落盘 —— 与文件写入同一道 PEP，review-knowledge-writes 两边都盖得住
    expect(h.calls).toEqual([`enforce:write:${abs}`, `write:${abs}`])
    expect(h.enforcePath).toHaveBeenCalledWith('write', abs, {
      toolCallId: 'c1',
      toolName: 'knowledge',
      displayPath: '/global/token-refresh-pitfalls.md',
      operation: 'write',
      abortError: 'Aborted'
    })
    expect(h.afterWrite).toHaveBeenCalledTimes(1)
    const event = h.afterWrite.mock.calls[0][0] as Record<string, unknown>
    expect(event).toEqual({
      path: 'global/token-refresh-pitfalls.md',
      op: 'create',
      title: 'Token Refresh: Pitfalls'
    })
    expect(event).not.toHaveProperty('status')
    expect(textOf(res)).toBe('Created /global/token-refresh-pitfalls.md (draft).')
    expect(res.details).toEqual({ action: 'write', path: 'global/token-refresh-pitfalls.md' })
  })
})

describe('KT-8 write —— 新建守卫与告警回执', () => {
  it('KT-8 缺 scope / 缺 type+body / 更新时空正文 / 作用域解析失败：都抛错、不落盘、不回调', async () => {
    const h = makeTool({
      files: {
        '/kb/global/a.md': doc(['type: Memory', 'title: A', 'description: da', 'status: draft'])
      },
      scopes: {
        project: { error: 'This session belongs to no project — use scope "global" instead.' }
      }
    })
    await expect(
      h.run('c1', { action: 'write', type: 'Memory', title: 'T', description: 'd', body: 'b' })
    ).rejects.toThrow('"write" needs `scope` when creating')
    await expect(
      h.run('c2', { action: 'write', scope: 'global', title: 'T', description: 'd' })
    ).rejects.toThrow('Creating an entry needs: type, body')
    await expect(
      h.run('c3', { action: 'write', path: '/global/a.md', body: '  ' })
    ).rejects.toThrow('The entry body must not be empty')
    await expect(
      h.run('c4', {
        action: 'write',
        scope: 'project',
        type: 'Memory',
        title: 'T',
        description: 'd',
        body: 'b'
      })
    ).rejects.toThrow('use scope "global"')
    expect(h.calls).toEqual([])
    expect(h.afterWrite).not.toHaveBeenCalled()
    expect(h.files.size).toBe(1)
  })

  it('KT-8 软告警随回执带回（文件照样写）：stale_after 不是日期', async () => {
    const h = makeTool()
    const res = await h.run('c1', {
      action: 'write',
      scope: 'global',
      type: 'Memory',
      title: 'T',
      description: 'd',
      body: 'b',
      stale_after: 'soon'
    })
    expect(textOf(res)).toBe(
      "Created /global/t.md (draft).\nNotes:\n- 'stale_after' should be an ISO 8601 date (YYYY-MM-DD)"
    )
    expect(h.files.get('/kb/global/t.md')).toContain('stale_after: soon')
    expect(h.afterWrite).toHaveBeenCalledTimes(1)
  })
})

describe('KT-9 新建文件名去重', () => {
  it('KT-9 与已扫描概念同 slug → -2；磁盘上已有但未入扫描的同名文件不被覆盖（后缀不钉死）', async () => {
    const h = makeTool({
      files: {
        '/kb/global/a.md': doc(['type: Memory', 'title: A', 'description: da']),
        '/kb/global/b.md': '# not a concept\n'
      }
    })
    const created = await h.run('c1', {
      action: 'write',
      scope: 'global',
      type: 'Memory',
      title: 'A',
      description: 'd',
      body: 'b'
    })
    expect(textOf(created)).toBe('Created /global/a-2.md (draft).')
    expect(h.files.get('/kb/global/a.md')).toContain('description: da')

    const second = await h.run('c2', {
      action: 'write',
      scope: 'global',
      type: 'Memory',
      title: 'B',
      description: 'd',
      body: 'b'
    })
    const path = (second.details as { path: string }).path
    expect(path).not.toBe('global/b.md')
    expect(path).toMatch(/^global\/b-[^/]+\.md$/)
    expect(h.files.get('/kb/global/b.md')).toBe('# not a concept\n')
  })
})

describe('KT-10 write —— 按 path 更新', () => {
  const A = doc(
    [
      'type: Memory',
      'title: A',
      'description: da',
      'resource: x',
      'tags: [old]',
      'status: stable',
      'stale_after: 2026-12-31',
      'verified: [{ by: "human:me", at: "2026-09-01T00:00:00Z" }]',
      'custom: kept'
    ],
    'old body'
  )

  it('KT-10 只给 body：状态 / verified / 未知键 / resource / 标题描述类型 / 标签 / stale_after 全部沿用，generated 刷新；回执提醒需重新核实', async () => {
    const h = makeTool({ files: { '/kb/global/a.md': A } })
    const res = await h.run('c1', { action: 'write', path: '/global/a.md', body: 'new' })
    const c = parseConceptText(h.files.get('/kb/global/a.md')!, 'global/a.md')!
    expect(c).toMatchObject({
      type: 'Memory',
      title: 'A',
      description: 'da',
      resource: 'x',
      tags: ['old'],
      // agent 不能把东西标成 stable —— 但既有的 stable 也不因它改写而降级，那是用户的判断
      status: 'stable',
      staleAfter: '2026-12-31',
      verified: [{ by: 'human:me', at: '2026-09-01T00:00:00Z' }],
      generated: { by: ACTOR, at: NOW.toISOString() },
      body: 'new\n'
    })
    expect(c.fields.custom).toBe('kept')
    expect(h.afterWrite).toHaveBeenCalledWith({ path: 'global/a.md', op: 'update', title: 'A' })
    expect(textOf(res)).toBe(
      'Updated /global/a.md (stable, verified earlier — the user will need to re-verify).'
    )
    expect(res.details).toEqual({ action: 'write', path: 'global/a.md' })
    expect(h.calls).toEqual(['enforce:write:/kb/global/a.md', 'write:/kb/global/a.md'])
  })

  it('KT-10 给了 tags 才替换；description 给空串即清空（设计如此，回执带告警）；不存在的 path 指路新建', async () => {
    const h = makeTool({ files: { '/kb/global/a.md': A } })
    await h.run('c1', { action: 'write', path: '/global/a.md', tags: ['n'] })
    expect(parseConceptText(h.files.get('/kb/global/a.md')!, 'global/a.md')!.tags).toEqual(['n'])

    const cleared = await h.run('c2', { action: 'write', path: '/global/a.md', description: '' })
    const c = parseConceptText(h.files.get('/kb/global/a.md')!, 'global/a.md')!
    expect(c.description).toBe('')
    expect(c.body).toBe('old body\n')
    expect(textOf(cleared)).toContain("Notes:\n- 'description' (one line) is recommended")

    await expect(h.run('c3', { action: 'write', path: '/global/x.md', body: 'b' })).rejects.toThrow(
      'No entry at /global/x.md — omit `path` to create a new one'
    )
  })
})

describe('KT-11 session 作用域按 sessionResource upsert', () => {
  const SESSION: KnowledgeScopeTarget = {
    dir: 'projects/acme/sessions',
    label: 'session summaries',
    sessionResource: 'shuvix://session/s1'
  }
  const OTHER = doc([
    'type: Session Summary',
    'title: Other',
    'description: do',
    'resource: shuvix://session/s1',
    'status: draft'
  ])

  it('KT-11 首写建 `<date>-<slug>.md` 并写 resource；再写同作用域即更新同一文件；别的目录里同 resource 的文件永不匹配', async () => {
    const h = makeTool({
      files: { '/kb/sessions/2026-09-08-other.md': OTHER },
      scopes: { session: SESSION }
    })
    const first = await h.run('c1', {
      action: 'write',
      scope: 'session',
      type: 'session summary',
      title: 'Fix login',
      description: 'd1',
      body: 'b1'
    })
    const rel = 'projects/acme/sessions/2026-09-09-fix-login.md'
    const abs = `/kb/${rel}`
    expect(textOf(first)).toBe(`Created /${rel} (draft).`)
    expect(parseConceptText(h.files.get(abs)!, rel)).toMatchObject({
      type: 'Session Summary',
      title: 'Fix login',
      resource: 'shuvix://session/s1',
      status: 'draft',
      body: 'b1\n'
    })

    const second = await h.run('c2', {
      action: 'write',
      scope: 'session',
      type: 'Session Summary',
      title: 'Fix login and logout',
      description: 'd2',
      body: 'b2'
    })
    expect(textOf(second)).toBe(`Updated /${rel} (draft).`)
    expect(h.afterWrite).toHaveBeenLastCalledWith({
      path: rel,
      op: 'update',
      title: 'Fix login and logout'
    })
    expect([...h.files.keys()].filter((k) => k.startsWith('/kb/projects/acme/sessions/'))).toEqual([
      abs
    ])
    expect(parseConceptText(h.files.get(abs)!, rel)).toMatchObject({
      title: 'Fix login and logout',
      body: 'b2\n',
      resource: 'shuvix://session/s1'
    })
    expect(h.files.get('/kb/sessions/2026-09-08-other.md')).toBe(OTHER)
  })
})

describe('KT-12 write 经真实 PEP（内置 review-knowledge-writes）', () => {
  function realSecurity(opts: {
    autoAllow: boolean
    respond: (req: InputRequest) => InputResponse
  }): { security: SecurityContext; requests: InputRequest[] } {
    const requests: InputRequest[] = []
    const provider: SecurityHostProvider = {
      host: 'desktop',
      pathSep: '/',
      getVars: () => ({
        workspace: '/ws',
        botsDir: '/tmp/shuvix-bots',
        toolResultsBase: '/nonexistent/tool_results',
        skillsDirs: [],
        memoryDirs: [],
        knowledgeRoot: '/kb',
        knowledgeSessionDirs: ['/kb/projects/acme/sessions'],
        home: '/fake-home',
        systemDirs: []
      }),
      getSessionGrants: () => ({ autoAllow: opts.autoAllow, allowList: [] }),
      isDirectory: () => false,
      persistGrant: () => {},
      requestUserInput: async (req) => {
        requests.push(req)
        return opts.respond(req)
      }
    }
    return {
      security: createSecurityContext(
        { kind: 'agent', sessionId: 's1', agentKind: 'root' },
        { host: 'desktop' },
        provider
      ),
      requests
    }
  }
  const SESSION: KnowledgeScopeTarget = {
    dir: 'projects/acme/sessions',
    label: 'session summaries',
    sessionResource: 'shuvix://session/s1'
  }
  const CREATE: KnowledgeToolParams = {
    action: 'write',
    scope: 'global',
    type: 'Memory',
    title: 'Token',
    description: 'd',
    body: 'b'
  }

  it('KT-12a 免询问开着也照问（force-ask）：恰一张卡，toolName=knowledge、command=Write(<绝对路径>)', async () => {
    const { security, requests } = realSecurity({
      autoAllow: true,
      respond: () => ({ kind: 'ask', allowed: true })
    })
    const h = makeTool({ security })
    await h.run('c1', CREATE)
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      kind: 'ask',
      id: 'c1',
      toolName: 'knowledge',
      command: 'Write(/kb/global/token.md)'
    })
    expect(h.files.has('/kb/global/token.md')).toBe(true)
  })

  it('KT-12b 用户拒绝：工具抛错、不落盘、不回调', async () => {
    const { security, requests } = realSecurity({
      autoAllow: true,
      respond: () => ({ kind: 'ask', allowed: false })
    })
    const h = makeTool({ security })
    await expect(h.run('c1', CREATE)).rejects.toThrow('User denied access to /global/token.md')
    expect(requests).toHaveLength(1)
    expect(h.files.size).toBe(0)
    expect(h.afterWrite).not.toHaveBeenCalled()
  })

  it('KT-12c 会话摘要目录是例外：免询问下零询问', async () => {
    const { security, requests } = realSecurity({
      autoAllow: true,
      respond: () => {
        throw new Error('must not ask')
      }
    })
    const h = makeTool({ security, scopes: { session: SESSION } })
    await h.run('c1', {
      action: 'write',
      scope: 'session',
      type: 'Session Summary',
      title: 'Fix login',
      description: 'd',
      body: 'b'
    })
    expect(requests).toEqual([])
    expect(h.files.has('/kb/projects/acme/sessions/2026-09-09-fix-login.md')).toBe(true)
  })
})

describe('KT-13 set-status', () => {
  const OLD = doc(
    [
      'type: Memory',
      'title: Old',
      'description: dold',
      'status: stable',
      'verified: [{ by: "human:me", at: "2026-09-01T00:00:00Z" }]',
      'custom: kept'
    ],
    'old body'
  )
  const NEW = doc(['type: Memory', 'title: New', 'description: dnew', 'status: draft'])
  const files = (): Record<string, string> => ({
    '/kb/global/old.md': OLD,
    '/kb/global/new.md': NEW
  })

  it('KT-13 deprecated + successor：正文追加一行 Superseded、状态改、章刷新、其余保留；过 write PEP（operation=set-status）；afterWrite 带 status；回执', async () => {
    const h = makeTool({ files: files() })
    const res = await h.run('c1', {
      action: 'set-status',
      path: '/global/old.md',
      status: 'deprecated',
      successor: '/global/new.md'
    })
    const c = parseConceptText(h.files.get('/kb/global/old.md')!, 'global/old.md')!
    expect(c).toMatchObject({
      status: 'deprecated',
      title: 'Old',
      description: 'dold',
      verified: [{ by: 'human:me', at: '2026-09-01T00:00:00Z' }],
      generated: { by: ACTOR, at: NOW.toISOString() },
      body: 'old body\n\nSuperseded by [New](/global/new.md).\n'
    })
    expect(c.fields.custom).toBe('kept')
    expect(h.files.get('/kb/global/old.md')!.split('Superseded by').length - 1).toBe(1)
    expect(h.enforcePath).toHaveBeenCalledWith('write', '/kb/global/old.md', {
      toolCallId: 'c1',
      toolName: 'knowledge',
      displayPath: '/global/old.md',
      operation: 'set-status',
      abortError: 'Aborted'
    })
    expect(h.calls).toEqual(['enforce:write:/kb/global/old.md', 'write:/kb/global/old.md'])
    expect(h.afterWrite).toHaveBeenCalledWith({
      path: 'global/old.md',
      op: 'set-status',
      title: 'Old',
      status: 'deprecated'
    })
    expect(textOf(res)).toBe('/global/old.md is now deprecated (superseded by /global/new.md).')
    expect(res.details).toEqual({ action: 'set-status', path: 'global/old.md' })
  })

  it('KT-13 successor 不存在：报错且不写、不过 PEP；status=draft 不写 Superseded 行', async () => {
    const h = makeTool({ files: files() })
    await expect(
      h.run('c1', {
        action: 'set-status',
        path: '/global/old.md',
        status: 'deprecated',
        successor: '/global/gone.md'
      })
    ).rejects.toThrow('Successor /global/gone.md does not exist')
    expect(h.calls).toEqual([])
    expect(h.files.get('/kb/global/old.md')).toBe(OLD)

    const res = await h.run('c2', {
      action: 'set-status',
      path: '/global/old.md',
      status: 'draft',
      successor: '/global/new.md'
    })
    const c = parseConceptText(h.files.get('/kb/global/old.md')!, 'global/old.md')!
    expect(c.status).toBe('draft')
    expect(c.body).toBe('old body\n')
    expect(h.files.get('/kb/global/old.md')).not.toContain('Superseded')
    expect(textOf(res)).toContain('/global/old.md is now draft')
    expect(h.afterWrite).toHaveBeenCalledWith({
      path: 'global/old.md',
      op: 'set-status',
      title: 'Old',
      status: 'draft'
    })
  })
})

describe('KT-14 set-status 守卫', () => {
  it('KT-14 缺 path / 缺 status / 条目不存在 / 保留文件：都抛错，且不过 PEP、不写文件', async () => {
    const h = makeTool({
      files: { '/kb/global/index.md': '', '/kb/global/a.md': doc(['type: Memory', 'title: A']) }
    })
    await expect(h.run('c1', { action: 'set-status', status: 'draft' })).rejects.toThrow(
      '"set-status" needs `path`'
    )
    await expect(h.run('c2', { action: 'set-status', path: '/global/a.md' })).rejects.toThrow(
      'needs `status` (draft / deprecated)'
    )
    await expect(
      h.run('c3', { action: 'set-status', path: '/global/x.md', status: 'draft' })
    ).rejects.toThrow('No entry at /global/x.md')
    await expect(
      h.run('c4', { action: 'set-status', path: '/global/index.md', status: 'draft' })
    ).rejects.toThrow('reserved file maintained by the host')
    expect(h.calls).toEqual([])
    expect(h.afterWrite).not.toHaveBeenCalled()
  })
})
