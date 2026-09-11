/**
 * knowledge 工具 —— 知识库的**读侧**面（设计 §6.1，决策 D4）。
 *
 * 它不写文件：条目由 agent 用普通 write/edit 写出来。本文件因此钉的是读侧那几件 ——
 * agent 面的枚举、路径守卫表、各 action 的回执文本与 details，以及 read / validate 以目标
 * **绝对路径**过与文件读取同一道 PEP（将来给知识库写策略时两侧同时被盖住）。
 *
 * **作用域就是一个 bundle**：本会话所属项目的那一个，由宿主的 `resolveBundle` 给出，
 * 所以工具没有 scope 参数，路径一律 bundle 相对；回执表头点名 bundle 的绝对目录，
 * 因为 agent 要拿它拼出 write/edit 用的路径。
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
import { isReservedFile, type BundleFile } from '../validate'

/** 本会话的那一个 bundle（项目 bundle 的绝对目录） */
const ROOT = '/kb/projects/acme'
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
  /** 调用顺序流水：`enforce:<mode>:<abs>` / `write:<abs>` */
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

/** 宿主扫描的替身：bundle 下的全部 md 原文 + 解析得出的概念（保留文件与非概念不算概念） */
function scanOf(files: Map<string, string>): {
  files: BundleFile[]
  concepts: KnowledgeConcept[]
} {
  const all: BundleFile[] = []
  const concepts: KnowledgeConcept[] = []
  for (const [abs, text] of files) {
    if (!abs.startsWith(`${ROOT}/`)) continue
    const rel = abs.slice(ROOT.length + 1)
    all.push({ path: rel, text })
    if (isReservedFile(rel)) continue
    const concept = parseConceptText(text, rel)
    if (concept) concepts.push(concept)
  }
  return { files: all, concepts }
}

function makeTool(opts: ToolOptions = {}): Harness {
  const files = new Map(Object.entries(opts.files ?? {}))
  const calls: string[] = []
  const enforcePath = vi.fn(async (mode: string, abs: string) => {
    calls.push(`enforce:${mode}:${abs}`)
  })
  const security = opts.security ?? ({ enforcePath } as unknown as SecurityContext)
  const resolveBundle = vi.fn(async () => opts.bundle ?? BUNDLE)
  const tool = createKnowledgeTool({
    port: memoryPort(files, calls),
    security,
    scan: async () => scanOf(files),
    resolveBundle,
    search: opts.search,
    abortError: opts.abortError,
    label: 'Knowledge'
  })
  return {
    tool,
    files,
    enforcePath,
    resolveBundle,
    calls,
    run: (id, params, signal) => tool.execute(id, params, signal)
  }
}

describe('KT-1 schema 枚举与运行时守卫', () => {
  const props = KnowledgeParamsSchema.properties as unknown as Record<
    string,
    { enum?: string[]; description?: string }
  >

  it('KT-1 action 枚举钉死（只读五个，没有 write / set-status）、没有 scope 参数；工具名与标签', () => {
    expect(KNOWLEDGE_TOOL_NAME).toBe('knowledge')
    const { tool } = makeTool()
    expect(tool.name).toBe('knowledge')
    expect(tool.label).toBe('Knowledge')
    expect(props.action.enum).toEqual(['search', 'list', 'read', 'validate', 'locate'])
    // 作用域就是本会话的那一个 bundle，没有可选项 —— 参数因此不存在
    expect(props.scope).toBeUndefined()
    // 写入面整体不在这里：条目用普通 write/edit 写
    for (const gone of ['type', 'title', 'description', 'body', 'tags', 'sources', 'status']) {
      if (gone === 'title') continue // locate 借用同名参数表达「我要建这个标题的条目」
      expect(props[gone], gone).toBeUndefined()
    }
    // 但词汇表仍要到得了模型面 —— frontmatter 现在是它自己写的
    for (const type of KNOWLEDGE_TYPES) expect(tool.description, type).toContain(type)
  })

  it('KT-1 preExecute / securityCheck 不碰 PEP（逐 action 在内部按算出的路径过），且任何 action 都不写文件', async () => {
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
    for (const params of [
      { action: 'read' as const, path: '/a.md' },
      { action: 'validate' as const, path: '/a.md' },
      { action: 'validate' as const },
      { action: 'locate' as const, title: 'A' }
    ]) {
      await h.run('c2', params)
    }
    expect(h.files.get('/kb/projects/acme/a.md')).toBe(before)
    expect(h.calls.filter((c) => c.startsWith('write:'))).toEqual([])
  })
})

describe('KT-2 路径守卫表', () => {
  const table: [string, KnowledgeToolParams, string][] = [
    ['read /', { action: 'read', path: '/' }, 'not inside the knowledge base'],
    ['read ../etc/x.md', { action: 'read', path: '../etc/x.md' }, 'not inside the knowledge base'],
    ['read /sub/x.txt', { action: 'read', path: '/sub/x.txt' }, 'not a markdown entry (.md)'],
    [
      'validate ../etc/x.md',
      { action: 'validate', path: '../etc/x.md' },
      'not inside the knowledge base'
    ]
  ]

  it.each(table)('KT-2 %s → 拒绝，且不过 PEP', async (_label, params, message) => {
    const h = makeTool({
      files: { '/kb/projects/acme/log.md': '## 2026-09-09\n', '/kb/projects/acme/index.md': '' }
    })
    await expect(h.run('c1', params)).rejects.toThrow(message)
    expect(h.calls).toEqual([])
  })

  it('KT-2 读保留文件允许（index.md 正是给 agent 看的）；已中止的 signal → 抛注入的 abortError', async () => {
    const h = makeTool({
      files: { '/kb/projects/acme/index.md': '## Entries\n\n* [A](a.md)\n' },
      abortError: 'TOOL_ABORTED'
    })
    const res = await h.run('c1', { action: 'read', path: '/index.md' })
    expect(textOf(res)).toBe('/kb/projects/acme/index.md:\n\n## Entries\n\n* [A](a.md)')

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
    expect(textOf(res)).toBe(
      `2 result(s) for "q" in project "Acme" — ${ROOT}:\n- /a.md (draft) — d\n  s\n- /b.md — B`
    )
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
        `4 result(s) for "token" in project "Acme" — ${ROOT}:`,
        '- /a.md (draft, 2026-09-09) — da',
        '- /b.md — db',
        '- /c.md — dc',
        '- /sub/e.md — de'
      ].join('\n')
    )
    const capped = await h.run('c2', { action: 'search', query: 'Token', limit: 1 })
    expect(textOf(capped)).toBe(
      `4 result(s) for "Token" in project "Acme" — ${ROOT}:\n- /a.md (draft, 2026-09-09) — da`
    )
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
          `3 entries in project "Acme" — ${ROOT}:`,
          '- /a.md (draft) — da',
          '- /b.md — db',
          '- /d.md (deprecated) — dd'
        ].join('\n')
      )
      expect(textOf(await h.run('c2', { action: 'list', limit: 2 }))).toBe(
        [
          `3 entries in project "Acme" — ${ROOT}:`,
          '- /a.md (draft) — da',
          '- /b.md — db',
          '- … 1 more'
        ].join('\n')
      )
    })())

  it('KT-5 bundle 解析失败回文字（不抛）；bundle 在但还没有条目也有一句话', async () => {
    const noProject = makeTool({ files: FILES, bundle: { error: 'no project here' } })
    const failed = await noProject.run('c1', { action: 'list' })
    expect(textOf(failed)).toBe('no project here')
    expect(failed.details).toEqual({ action: 'list' })
    expect(noProject.resolveBundle).toHaveBeenCalledWith({ create: false })

    expect(textOf(await makeTool().run('c2', { action: 'list' }))).toBe(
      `No entries in project "Acme" — ${ROOT} yet.`
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
    expect(textOf(res)).toBe(`${ROOT}/a.md:\n\n${raw.trimEnd()}`)
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
