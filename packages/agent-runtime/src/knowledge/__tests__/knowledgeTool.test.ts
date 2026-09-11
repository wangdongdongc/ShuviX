/**
 * knowledge 工具 —— 知识库的结构化读写面（设计 §6.1，决策 D4）。
 *
 * 宿主无关：文件经内存 port，bundle 解析 / 扫描 / 检索 / 写后处理全部由用例注入。钉四件事：
 * agent 面的枚举（尤其是 set-status 不能标 stable —— schema 与运行时各守一遍）、路径守卫表、
 * 各 action 的回执文本与 details，以及 write / set-status 以目标**绝对路径**过与文件写入
 * 同一道 PEP（将来给知识库写策略时，工具与直写文件因此同时被盖住）。
 *
 * **作用域就是一个 bundle**：本会话所属项目的那一个，由宿主的 `resolveBundle` 给出，
 * 所以工具没有 scope 参数，路径一律 bundle 相对。
 */
import { describe, it, expect, vi, type Mock } from 'vitest'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import { KNOWLEDGE_TYPES } from '@shuvix/chat-protocol/knowledge'
import type { FileSystemPort } from '../../fileTools/port'
import type { SecurityContext } from '../../security/types'
import { parseConceptText, type KnowledgeConcept } from '../conceptFile'
import {
  createKnowledgeTool,
  KNOWLEDGE_TOOL_NAME,
  KnowledgeParamsSchema,
  type KnowledgeBundleTarget,
  type KnowledgeSearchHit,
  type KnowledgeToolParams
} from '../knowledgeTool'
import { isReservedFile } from '../validate'

/** 本会话的那一个 bundle（项目 bundle 的绝对目录） */
const ROOT = '/kb/projects/acme'
const NOW = new Date('2026-09-09T08:12:03.000Z')
const ACTOR = 'shuvix-work/gpt-5'
const STAMP = 'generated: { by: "shuvix-work/gpt-5", at: "2026-09-09T08:12:03.000Z" }'

/** 一份概念文本：frontmatter 行 + 正文（尾随换行，同 conceptFile.test 的 doc 惯例） */
const doc = (frontmatter: string[], body = 'body'): string =>
  ['---', ...frontmatter, '---', '', body, ''].join('\n')

const BUNDLE: KnowledgeBundleTarget = { dir: ROOT, label: 'project "Acme"' }

interface ToolOptions {
  /** 内存 port 的初始文件（绝对路径 → 内容） */
  files?: Record<string, string>
  /** bundle 解析结果（缺省即 BUNDLE）；给 `{error}` 模拟「会话不属于任何项目」 */
  bundle?: KnowledgeBundleTarget | { error: string }
  search?: (
    query: string,
    opts: { limit: number; bundleDir: string }
  ) => Promise<KnowledgeSearchHit[]>
  /** 不传 = 只记录调用的 enforcePath 桩；KT-12 换成真实 SecurityContext */
  security?: SecurityContext
  abortError?: string
}

type Result = AgentToolResult<unknown>

interface Harness {
  tool: ReturnType<typeof createKnowledgeTool>
  files: Map<string, string>
  enforcePath: Mock
  resolveBundle: Mock
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
  const resolveBundle = vi.fn(async () => opts.bundle ?? BUNDLE)
  const afterWrite = vi.fn()
  const tool = createKnowledgeTool({
    port: memoryPort(files, calls),
    security,
    listConcepts: async () => conceptsOf(files),
    resolveBundle,
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
    resolveBundle,
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

  it('KT-1 action / status 两个枚举钉死、没有 scope 参数；type 的描述列出全部词汇表；工具名与标签', () => {
    expect(KNOWLEDGE_TOOL_NAME).toBe('knowledge')
    const { tool } = makeTool()
    expect(tool.name).toBe('knowledge')
    expect(tool.label).toBe('Knowledge')
    expect(props.action.enum).toEqual(['search', 'read', 'write', 'set-status', 'list'])
    // 作用域就是本会话的那一个 bundle，没有可选项 —— 参数因此不存在
    expect(props.scope).toBeUndefined()
    // agent 只能标 draft / deprecated —— stable 只有用户能设
    expect(props.status.enum).toEqual(['draft', 'deprecated'])
    for (const type of KNOWLEDGE_TYPES) expect(props.type.description, type).toContain(type)
  })

  it('KT-1 preExecute / securityCheck 不碰 PEP（逐 action 在内部按算出的路径过）；越过 schema 传 stable 也被运行时拒绝、不写文件', async () => {
    const h = makeTool({
      files: {
        '/kb/projects/acme/a.md': doc([
          'type: Memory',
          'title: A',
          'description: da',
          'status: draft'
        ])
      }
    })
    await h.tool.preExecute()
    await h.run('c1', { action: 'list' })
    expect(h.enforcePath).not.toHaveBeenCalled()

    const before = h.files.get('/kb/projects/acme/a.md')
    await expect(
      h.run('c2', {
        action: 'set-status',
        path: '/a.md',
        status: 'stable' as unknown as 'draft'
      })
    ).rejects.toThrow('only the user can make an entry stable')
    expect(h.files.get('/kb/projects/acme/a.md')).toBe(before)
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
    ['write /index.md', { action: 'write', path: '/index.md', body: 'b' }, RESERVED],
    ['set-status /index.md', { action: 'set-status', path: '/index.md', status: 'draft' }, RESERVED]
  ]

  it.each(table)('KT-2 %s → 拒绝，且不过 PEP、不写文件', async (_label, params, message) => {
    const h = makeTool({
      files: { '/kb/projects/acme/log.md': '## 2026-09-09\n', '/kb/projects/acme/index.md': '' }
    })
    await expect(h.run('c1', params)).rejects.toThrow(message)
    expect(h.calls).toEqual([])
    expect(h.afterWrite).not.toHaveBeenCalled()
  })

  it('KT-2 读保留文件允许（index.md 正是给 agent 看的）；已中止的 signal → 抛注入的 abortError', async () => {
    const h = makeTool({
      files: { '/kb/projects/acme/index.md': '## Entries\n\n* [A](a.md)\n' },
      abortError: 'TOOL_ABORTED'
    })
    const res = await h.run('c1', { action: 'read', path: '/index.md' })
    expect(textOf(res)).toBe('/index.md:\n\n## Entries\n\n* [A](a.md)')

    const ac = new AbortController()
    ac.abort()
    await expect(h.run('c2', { action: 'list' }, ac.signal)).rejects.toThrow('TOOL_ABORTED')
  })
})

describe('KT-3 search —— 注入的检索（宿主 okf-minisearch）', () => {
  it('KT-3 命中：query 与 {limit, bundleDir} 原样转发；逐行 `- /path (status) — description|title` + 缩进 snippet；bundle 按 create:false 解析', async () => {
    const search = vi.fn(async () => [
      { path: '/a.md', title: 'A', description: 'd', status: 'draft', snippet: 's' },
      { path: 'b.md', title: 'B', status: 'stable' }
    ])
    const h = makeTool({ search })
    const res = await h.run('c1', { action: 'search', query: 'q' })
    expect(h.resolveBundle).toHaveBeenCalledWith({ create: false })
    expect(search).toHaveBeenCalledWith('q', { limit: 20, bundleDir: ROOT })
    expect(textOf(res)).toBe('2 result(s) for "q":\n- /a.md (draft) — d\n  s\n- /b.md — B')
    expect(res.details).toEqual({ action: 'search' })
    expect(h.enforcePath).not.toHaveBeenCalled()
  })

  it('KT-3 零命中回一句话；缺 query 抛错；bundle 解析失败按 list 同口径回文字（不抛）', async () => {
    const search = vi.fn(async () => [])
    const h = makeTool({ search })
    expect(textOf(await h.run('c1', { action: 'search', query: 'q', limit: 5 }))).toBe(
      'No entries match "q".'
    )
    expect(search).toHaveBeenCalledWith('q', { limit: 5, bundleDir: ROOT })
    await expect(h.run('c2', { action: 'search', query: '  ' })).rejects.toThrow(
      '"search" needs `query`'
    )
    // 会话不属于任何项目：检索是软条件，回一句话而不是抛
    const noProject = makeTool({ search, bundle: { error: 'no project here' } })
    const res = await noProject.run('c3', { action: 'search', query: 'q' })
    expect(textOf(res)).toBe('no project here')
    expect(res.details).toEqual({ action: 'search' })
    expect(search).toHaveBeenCalledTimes(1)
  })
})

describe('KT-4 search —— 缺省子串检索（无 search 注入）', () => {
  const FILES = {
    '/kb/projects/acme/a.md': doc([
      'type: Memory',
      'title: Token refresh',
      'description: da',
      'status: draft',
      'generated: { by: g, at: "2026-09-09T08:12:03.000Z" }'
    ]),
    '/kb/projects/acme/b.md': doc(
      ['type: Memory', 'title: B', 'description: db'],
      'the TOKEN expires'
    ),
    '/kb/projects/acme/c.md': doc(['type: Memory', 'title: C', 'description: dc', 'tags: [token]']),
    '/kb/projects/acme/d.md': doc([
      'type: Memory',
      'title: Token dep',
      'description: dd',
      'status: deprecated'
    ]),
    '/kb/projects/acme/sub/e.md': doc(['type: Memory', 'title: Token in acme', 'description: de']),
    '/kb/projects/acme/f.md': doc(['type: Memory', 'title: F', 'description: df'])
  }

  it('KT-4 标题 / 正文（大小写不敏感）/ 标签都算命中，deprecated 排除；作用域按目录前缀过滤；计数看全部命中、行数按 limit 截', async () => {
    const h = makeTool({ files: FILES })
    const all = await h.run('c1', { action: 'search', query: 'token' })
    expect(textOf(all)).toBe(
      [
        '4 result(s) for "token":',
        '- /a.md (draft, 2026-09-09) — da',
        '- /b.md — db',
        '- /c.md — dc',
        '- /sub/e.md — de'
      ].join('\n')
    )
    const capped = await h.run('c2', { action: 'search', query: 'Token', limit: 1 })
    expect(textOf(capped)).toBe('4 result(s) for "Token":\n- /a.md (draft, 2026-09-09) — da')
    expect(textOf(await h.run('c3', { action: 'search', query: 'zzz' }))).toBe(
      'No entries match "zzz".'
    )
  })
})

describe('KT-5 list', () => {
  const FILES = {
    '/kb/projects/acme/a.md': doc(['type: Memory', 'title: A', 'description: da', 'status: draft']),
    '/kb/projects/acme/b.md': doc(['type: Memory', 'title: B', 'description: db']),
    '/kb/projects/acme/d.md': doc([
      'type: Memory',
      'title: D',
      'description: dd',
      'status: deprecated'
    ])
  }

  it('KT-5 列出本 bundle 全部条目（含 deprecated，带标注）、表头点名标签；limit 之外折成一行计数', () =>
    (async () => {
      const h = makeTool({ files: FILES })
      expect(textOf(await h.run('c1', { action: 'list' }))).toBe(
        [
          '3 entries in project "Acme":',
          '- /a.md (draft) — da',
          '- /b.md — db',
          '- /d.md (deprecated) — dd'
        ].join('\n')
      )
      expect(textOf(await h.run('c2', { action: 'list', limit: 2 }))).toBe(
        ['3 entries in project "Acme":', '- /a.md (draft) — da', '- /b.md — db', '- … 1 more'].join(
          '\n'
        )
      )
    })())

  it('KT-5 bundle 解析失败回文字（不抛）；bundle 在但还没有条目也有一句话', async () => {
    const noProject = makeTool({ files: FILES, bundle: { error: 'no project here' } })
    const failed = await noProject.run('c1', { action: 'list' })
    expect(textOf(failed)).toBe('no project here')
    expect(failed.details).toEqual({ action: 'list' })
    expect(noProject.resolveBundle).toHaveBeenCalledWith({ create: false })

    expect(textOf(await makeTool().run('c2', { action: 'list' }))).toBe(
      'No entries in project "Acme" yet.'
    )
  })
})

describe('KT-6 read', () => {
  it('KT-6 过 read PEP（绝对路径 + 展示路径 + operation），回 `/path:` + 原文 trimEnd，details 带相对路径', async () => {
    const raw = `${doc(['type: Memory', 'title: A', 'description: da', 'status: draft'])}\n\n`
    const h = makeTool({ files: { '/kb/projects/acme/a.md': raw } })
    const res = await h.run('c1', { action: 'read', path: '/a.md' })
    expect(h.enforcePath).toHaveBeenCalledTimes(1)
    expect(h.enforcePath).toHaveBeenCalledWith('read', '/kb/projects/acme/a.md', {
      toolCallId: 'c1',
      toolName: 'knowledge',
      displayPath: '/a.md',
      operation: 'read',
      abortError: 'Aborted'
    })
    expect(textOf(res)).toBe(`/a.md:\n\n${raw.trimEnd()}`)
    expect(res.details).toEqual({ action: 'read', path: 'a.md' })
  })

  it('KT-6 条目不存在 / 缺 path', async () => {
    const h = makeTool()
    await expect(h.run('c1', { action: 'read', path: '/x.md' })).rejects.toThrow(
      'No entry at /x.md'
    )
    await expect(h.run('c2', { action: 'read' })).rejects.toThrow('"read" needs `path`')
  })
})

describe('KT-7 write —— 新建', () => {
  it('KT-7 bundle 按 create:true 解析；文件形状（okf 自述行、type 归一、draft、宿主章、来源流式）；先过 write PEP 再落盘；afterWrite 无 status 键；回执', async () => {
    const h = makeTool()
    const res = await h.run('c1', {
      action: 'write',
      type: 'memory',
      title: 'Token Refresh: Pitfalls',
      description: 'when touching auth',
      body: '\n\nbody\n',
      tags: ['auth'],
      sources: [{ resource: '/abs/p.ts', id: 's1' }],
      stale_after: '2026-12-31'
    })
    expect(h.resolveBundle).toHaveBeenCalledWith({ create: true })

    const abs = '/kb/projects/acme/token-refresh-pitfalls.md'
    expect(h.files.get(abs)).toBe(
      [
        '---',
        'shuvix: okf v0.2',
        'type: Memory',
        'title: "Token Refresh: Pitfalls"',
        'description: when touching auth',
        'tags:',
        '  - auth',
        'status: draft',
        'stale_after: 2026-12-31',
        'sources: [ { id: s1, resource: "/abs/p.ts" } ]',
        STAMP,
        '---',
        '',
        'body',
        ''
      ].join('\n')
    )
    expect(h.files.get(abs)).not.toContain('verified')
    // 先过门再落盘 —— 与文件写入同一道 PEP（将来给知识库写策略时两边同时被盖住）
    expect(h.calls).toEqual([`enforce:write:${abs}`, `write:${abs}`])
    expect(h.enforcePath).toHaveBeenCalledWith('write', abs, {
      toolCallId: 'c1',
      toolName: 'knowledge',
      displayPath: '/token-refresh-pitfalls.md',
      operation: 'write',
      abortError: 'Aborted'
    })
    expect(h.afterWrite).toHaveBeenCalledTimes(1)
    const event = h.afterWrite.mock.calls[0][0] as Record<string, unknown>
    expect(event).toEqual({
      bundleDir: ROOT,
      path: 'token-refresh-pitfalls.md',
      op: 'create',
      title: 'Token Refresh: Pitfalls'
    })
    expect(event).not.toHaveProperty('status')
    expect(textOf(res)).toBe('Created /token-refresh-pitfalls.md (draft).')
    expect(res.details).toEqual({ action: 'write', path: 'token-refresh-pitfalls.md' })
  })
})

describe('KT-8 write —— 新建守卫与告警回执', () => {
  it('KT-8 缺 type+body / 更新时空正文 / bundle 解析失败：都抛错、不落盘、不回调', async () => {
    const FILES = {
      '/kb/projects/acme/a.md': doc([
        'type: Memory',
        'title: A',
        'description: da',
        'status: draft'
      ])
    }
    const h = makeTool({ files: FILES })
    await expect(h.run('c1', { action: 'write', title: 'T', description: 'd' })).rejects.toThrow(
      'Creating an entry needs: type, body'
    )
    await expect(h.run('c2', { action: 'write', path: '/a.md', body: '  ' })).rejects.toThrow(
      'The entry body must not be empty'
    )
    expect(h.calls).toEqual([])
    expect(h.afterWrite).not.toHaveBeenCalled()
    expect(h.files.size).toBe(1)

    // 会话不属于任何项目：新建时抛（写入不是软条件 —— 落不了盘就得说清楚）
    const noProject = makeTool({ files: FILES, bundle: { error: 'no project here' } })
    await expect(
      noProject.run('c3', {
        action: 'write',
        type: 'Memory',
        title: 'T',
        description: 'd',
        body: 'b'
      })
    ).rejects.toThrow('no project here')
    expect(noProject.calls).toEqual([])
    expect(noProject.afterWrite).not.toHaveBeenCalled()
  })

  it('KT-8 软告警随回执带回（文件照样写）：stale_after 不是日期', async () => {
    const h = makeTool()
    const res = await h.run('c1', {
      action: 'write',
      type: 'Memory',
      title: 'T',
      description: 'd',
      body: 'b',
      stale_after: 'soon'
    })
    expect(textOf(res)).toBe(
      "Created /t.md (draft).\nNotes:\n- 'stale_after' should be an ISO 8601 date (YYYY-MM-DD)"
    )
    expect(h.files.get('/kb/projects/acme/t.md')).toContain('stale_after: soon')
    expect(h.afterWrite).toHaveBeenCalledTimes(1)
  })
})

describe('KT-9 新建文件名去重', () => {
  it('KT-9 与已扫描概念同 slug → -2；磁盘上已有但未入扫描的同名文件不被覆盖（后缀不钉死）', async () => {
    const h = makeTool({
      files: {
        '/kb/projects/acme/a.md': doc(['type: Memory', 'title: A', 'description: da']),
        '/kb/projects/acme/b.md': '# not a concept\n'
      }
    })
    const created = await h.run('c1', {
      action: 'write',
      type: 'Memory',
      title: 'A',
      description: 'd',
      body: 'b'
    })
    expect(textOf(created)).toBe('Created /a-2.md (draft).')
    expect(h.files.get('/kb/projects/acme/a.md')).toContain('description: da')

    const second = await h.run('c2', {
      action: 'write',
      type: 'Memory',
      title: 'B',
      description: 'd',
      body: 'b'
    })
    const path = (second.details as { path: string }).path
    expect(path).not.toBe('global/b.md')
    expect(path).toMatch(/^b-[^/]+\.md$/)
    expect(h.files.get('/kb/projects/acme/b.md')).toBe('# not a concept\n')
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
    const h = makeTool({ files: { '/kb/projects/acme/a.md': A } })
    const res = await h.run('c1', { action: 'write', path: '/a.md', body: 'new' })
    const c = parseConceptText(h.files.get('/kb/projects/acme/a.md')!, 'global/a.md')!
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
    expect(h.afterWrite).toHaveBeenCalledWith({
      bundleDir: ROOT,
      path: 'a.md',
      op: 'update',
      title: 'A'
    })
    expect(textOf(res)).toBe(
      'Updated /a.md (stable, verified earlier — the user will need to re-verify).'
    )
    expect(res.details).toEqual({ action: 'write', path: 'a.md' })
    expect(h.calls).toEqual([`enforce:write:${ROOT}/a.md`, `write:${ROOT}/a.md`])
  })

  it('KT-10 给了 tags 才替换；description 给空串即清空（设计如此，回执带告警）；不存在的 path 指路新建', async () => {
    const h = makeTool({ files: { '/kb/projects/acme/a.md': A } })
    await h.run('c1', { action: 'write', path: '/a.md', tags: ['n'] })
    expect(parseConceptText(h.files.get('/kb/projects/acme/a.md')!, 'global/a.md')!.tags).toEqual([
      'n'
    ])

    const cleared = await h.run('c2', { action: 'write', path: '/a.md', description: '' })
    const c = parseConceptText(h.files.get('/kb/projects/acme/a.md')!, 'global/a.md')!
    expect(c.description).toBe('')
    expect(c.body).toBe('old body\n')
    expect(textOf(cleared)).toContain("Notes:\n- 'description' (one line) is recommended")

    await expect(h.run('c3', { action: 'write', path: '/x.md', body: 'b' })).rejects.toThrow(
      'No entry at /x.md — omit `path` to create a new one'
    )
  })
})
