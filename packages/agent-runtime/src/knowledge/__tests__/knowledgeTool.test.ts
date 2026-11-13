/**
 * knowledge 工具 —— 检索 / 盘点 / 读条目 + 把要记的内容**交给知识库管理员**（`submit`，2026-11-08 改版）。
 *
 * 库目录只有管理员（内置 `knowledge-writer`）知道：别的 agent 眼里只有库名与条目名（库内路径带前导 `/`，
 * 如 `/auth/x.md`）。正文经 `read` 看（宿主的扫描缓存，不经文件门）；`submit` 交的是内容（`content`，可点名
 * 它更正 / 补充的 `entry`），宿主同步派管理员，由它决定怎么记；它报上来的、仍合规的 OKF 条目由宿主盖章
 * （`generated` 记提交者、`verified` 记管理员的机器确认，见 review.ts）。本文件钉：
 *
 *   KT-1′..KT-12′   agent 面的枚举与参数表、给模型的文案（讲 read / submit，不讲 write / grep / 目录）
 *   KT-3..KT-33     读侧（search / list / bases）：列表与命中一律印**条目名**（`/rel`），表头只点名库与标签
 *   KT-40..KT-42    list / 兜底检索的信任档记号（status → 信任档 → generated 日期）
 *   KA-1..KA-4      管理员看得到库目录、别人看不到：非管理员的每一种输出里都没有目录；isAdmin 按调用判
 *   KE-1..KE-9      read：名字的几种写法、分页（offset / limit / 字节上限 / 收尾句）、不在册的名字、越界 / 隐藏
 *   KS-1..KS-9      submit 的准入与先后：管理员自己、缺 content / base、库解析失败、只读库、宿主不支持、entry 校验
 *   KS-10..KS-14    交给管理员的请求：字段恰好、entry 归一、提交者按调用现取、取消信号
 *   KS-20..KS-27    管理员结论的分支：没跑成、抛错、不收、空报告、报告里的目录换成条目名、中止
 *   KO-1..KO-6      organize：准入、派管理员（`organize: true`、转述的要求）、回包、盖章记管理员、只挪位置的不盖
 *   KS-30..KS-46    收了之后的盖章：created / updated 盖、deleted 跳过、普通笔记不动、不在 / 符号链接 / 不是条目名
 *                   记在那一行、人工章保留、afterWrite、没改不写、正文字节不动
 *
 * 失败一律是 isError 结果（BaseTool 裁定 Q12），只有已中止的 signal 会 reject。每次调用点名一个 base，
 * 由宿主的 `resolveBase` 解析成一个 bundle；工具本身不认识任何一种库。
 */
import { describe, it, expect, vi, type Mock, type MockInstance } from 'vitest'
import {
  invokeTool,
  type InvokedToolResult,
  type InvokeToolOptions
} from '../../tools/testing/invokeTool'
import type { FileSystemPort } from '../../fileTools/port'
import type { ToolCallScope } from '../../tools/toolCall'
import {
  currentTrustTierOf,
  isVerificationCurrent,
  parseConceptText,
  readKnowledgeNote,
  type KnowledgeConcept,
  type KnowledgeNote
} from '../conceptFile'
import {
  createKnowledgeTool,
  KNOWLEDGE_DESCRIPTION,
  KNOWLEDGE_TOOL_NAME,
  KnowledgeParamsSchema,
  type KnowledgeAdminRun,
  type KnowledgeBaseInfo,
  type KnowledgeBundleTarget,
  type KnowledgeSearchHit,
  type KnowledgeToolDeps,
  type KnowledgeToolParams
} from '../knowledgeTool'
import type {
  KnowledgeAdminOutcome,
  KnowledgeEntryChangeRecord,
  KnowledgeSubmission
} from '../review'
import { isProjectionFile, isReservedFile, type BundleFile } from '../validate'

/** 本会话的那一个 bundle（项目 bundle 的绝对目录） */
const ROOT = '/kb/projects/acme'
const NOW = new Date('2026-11-08T08:00:00.000Z')
const NOW_ISO = NOW.toISOString()
const ACTOR = 'shuvix-work/gpt-5'
const ADMIN = 'shuvix-knowledge-writer/haiku'
/** 一份概念文本：frontmatter 行 + 正文（尾随换行，同 conceptFile.test 的 doc 惯例） */
const doc = (frontmatter: string[], body = 'body'): string =>
  ['---', ...frontmatter, '---', '', body, ''].join('\n')
/** 合规条目（带自述行、门面齐全）；没有 generated / verified */
const ENTRY = doc([
  'shuvix: okf v0.2',
  'type: Memory',
  'title: A',
  'description: da',
  'status: stable'
])
/** 用户的普通笔记 */
const PLAIN = '# Plain\n\nbody\n'

const BUNDLE: KnowledgeBundleTarget = { dir: ROOT, label: 'project "Acme"' }
/** 非管理员表头里点名库的那一截 */
const IN_PROJECT = 'base "project" (project "Acme")'
/** 管理员表头里的那一截（标签后带目录） */
const IN_PROJECT_ADMIN = `base "project" (project "Acme" — ${ROOT})`
/** 收录后的两个章 */
const GENERATED_LINE = `generated: { by: "${ACTOR}", at: "${NOW_ISO}" }`
const VERIFIED_LINE = `verified: { by: "${ADMIN}", at: "${NOW_ISO}" }`

type AdminCtx = Parameters<KnowledgeAdminRun>[1]
/** 管理员替身：可以改 `files`（模拟它用文件工具动了库）再交回结论 */
type AdminImpl = (
  req: KnowledgeSubmission,
  ctx: AdminCtx,
  files: Map<string, string>
) => Promise<KnowledgeAdminOutcome>

/**
 * 照 `changes` 改库的管理员（库内相对路径 → 新内容；`null` = 删掉），按改前在不在报 created / updated /
 * deleted；`report` 可以是函数（拿得到请求，好把库目录写进报告里）
 */
const librarian =
  (
    changes: Record<string, string | null>,
    report: string | ((req: KnowledgeSubmission) => string) = 'ok'
  ): AdminImpl =>
  async (req, _ctx, files) => {
    const entries: KnowledgeEntryChangeRecord[] = []
    for (const [rel, text] of Object.entries(changes)) {
      const abs = `${req.bundleDir}/${rel}`
      const existed = files.has(abs)
      if (text === null) {
        files.delete(abs)
        entries.push({ entry: rel, change: 'deleted' })
      } else {
        files.set(abs, text)
        entries.push({ entry: rel, change: existed ? 'updated' : 'created' })
      }
    }
    return {
      accepted: true,
      entries,
      report: typeof report === 'function' ? report(req) : report,
      admin: ADMIN
    }
  }

/** 只报结论、一个字不写的管理员 */
const reports =
  (entries: KnowledgeEntryChangeRecord[], report = 'ok'): AdminImpl =>
  async () => ({ accepted: true, entries, report, admin: ADMIN })

interface ToolOptions {
  /** 内存 port 的初始文件（绝对路径 → 内容） */
  files?: Record<string, string>
  /** bundle 解析结果（缺省即 BUNDLE）；给 `{error}` 模拟解析失败 */
  bundle?: KnowledgeBundleTarget | { error: string }
  /** `bases` 列举的库（缺省空表） */
  bases?: readonly KnowledgeBaseInfo[]
  search?: KnowledgeToolDeps['search']
  abortError?: string
  /** 管理员替身（缺省：收了、一条没动）；`null` = 宿主不注入 admin（扩展端） */
  admin?: AdminImpl | null
  isAdmin?: (call: ToolCallScope | undefined) => boolean
  actor?: (call: ToolCallScope | undefined) => string
  /** port 路径 → 它是符号链接时 readLink 的答复 */
  links?: Record<string, { target: string; resolved: string }>
}

type Result = InvokedToolResult

interface Harness {
  tool: ReturnType<typeof createKnowledgeTool>
  files: Map<string, string>
  resolveBase: Mock
  listBases: Mock
  scan: Mock
  afterWrite: Mock
  admin: Mock
  isAdmin?: Mock
  actor: Mock
  now: Mock
  stat: MockInstance<FileSystemPort['stat']>
  readFile: MockInstance<FileSystemPort['readFile']>
  /** 调用顺序流水：`admin:<base>` / `write:<abs>` / `after:<bundleDir>|<rel>` */
  calls: string[]
  run: (id: string, params: KnowledgeToolParams, signal?: AbortSignal) => Promise<Result>
  invoke: (params: KnowledgeToolParams, options: InvokeToolOptions) => Promise<Result>
}

const textOf = (res: Result): string => (res.content[0] as { text: string }).text

/** 这次调用失败交回的文字（不是 isError 结果即判红） */
const rejectionOf = (p: Promise<Result>): Promise<string> =>
  p.then((res) => {
    if (res.isError !== true) throw new Error(`expected the call to fail, got: ${textOf(res)}`)
    return textOf(res)
  })

function memoryPort(
  files: Map<string, string>,
  calls: string[],
  links: Record<string, { target: string; resolved: string }>
): FileSystemPort {
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
    readdir: () => Promise.resolve([]),
    readLink: (p) => Promise.resolve(links[p] ?? null)
  }
}

/**
 * 宿主扫描的替身：`bundleDir` 下的全部 md 原文 + 解析得出的笔记 / 概念。与宿主一样不看隐藏路径
 * （rg `hidden: false`：`.obsidian/`、`.draft.md` 不是库的内容）。
 */
function scanOf(
  files: Map<string, string>,
  bundleDir: string
): { files: BundleFile[]; concepts: KnowledgeConcept[]; notes: KnowledgeNote[] } {
  const all: BundleFile[] = []
  const concepts: KnowledgeConcept[] = []
  const notes: KnowledgeNote[] = []
  for (const [abs, text] of files) {
    if (!abs.startsWith(`${bundleDir}/`)) continue
    const rel = abs.slice(bundleDir.length + 1)
    if (!rel.endsWith('.md') || rel.split('/').some((seg) => seg.startsWith('.'))) continue
    all.push({ path: rel, text })
    // 宿主投影的 index / log 不是笔记；其余每个 md 都是（读宽），合规的另带 OKF 条目
    if (isProjectionFile(rel, text)) continue
    const note = readKnowledgeNote(text, rel, { entry: !isReservedFile(rel) })
    notes.push(note)
    if (note.concept) concepts.push(note.concept)
  }
  return { files: all, concepts, notes }
}

/** 缺省的管理员：收了，一条没动 */
const NOTHING: AdminImpl = reports([])

function makeTool(opts: ToolOptions = {}): Harness {
  const files = new Map(Object.entries(opts.files ?? {}))
  const calls: string[] = []
  const resolveBase = vi.fn(async (_base: string) => opts.bundle ?? BUNDLE)
  const listBases = vi.fn(async () => opts.bases ?? [])
  // 扫描跟着宿主解析出的目录走：resolveBase 给的是别的库时，清单也得是那个库的
  const scan = vi.fn((bundleDir: string) => Promise.resolve(scanOf(files, bundleDir)))
  const afterWrite = vi.fn((e: { bundleDir: string; path: string }) => {
    calls.push(`after:${e.bundleDir}|${e.path}`)
  })
  const impl = opts.admin === undefined ? NOTHING : opts.admin
  const admin = vi.fn(async (req: KnowledgeSubmission, ctx: AdminCtx) => {
    calls.push(`admin:${req.base}`)
    return impl!(req, ctx, files)
  })
  const isAdmin = opts.isAdmin ? vi.fn(opts.isAdmin) : undefined
  const actor = vi.fn(opts.actor ?? ((_call: ToolCallScope | undefined) => ACTOR))
  const now = vi.fn(() => NOW)
  const port = memoryPort(files, calls, opts.links ?? {})
  const stat = vi.spyOn(port, 'stat')
  const readFile = vi.spyOn(port, 'readFile')
  const tool = createKnowledgeTool({
    port,
    scan,
    resolveBase,
    listBases,
    search: opts.search,
    actor,
    now,
    admin: impl === null ? undefined : admin,
    isAdmin,
    afterWrite,
    abortError: opts.abortError,
    label: 'Knowledge'
  })
  return {
    tool,
    files,
    resolveBase,
    listBases,
    scan,
    afterWrite,
    admin,
    isAdmin,
    actor,
    now,
    stat,
    readFile,
    calls,
    run: async (id, params, signal) =>
      (await invokeTool(tool, params, { callId: id, signal })).result,
    invoke: async (params, options) => (await invokeTool(tool, params, options)).result
  }
}

/** 拒绝之后该是什么都没发生：管理员不派、不落盘、不回调、连文件都没碰 */
function expectNothingHappened(h: Harness): void {
  expect(h.admin).not.toHaveBeenCalled()
  expect(h.calls).toEqual([])
  expect(h.afterWrite).not.toHaveBeenCalled()
  expect(h.stat).not.toHaveBeenCalled()
  expect(h.readFile).not.toHaveBeenCalled()
}

// ─── 1.1 Schema 与文案 ─────────────────────────────────────────────────────────

describe('KT-1′ schema 与运行时守卫', () => {
  const props = KnowledgeParamsSchema.properties as unknown as Record<
    string,
    { enum?: string[]; description?: string }
  >

  it('KT-1′ action 枚举恰为 bases / search / list / read / submit / organize / migrate；参数恰为 action / base / query / entry / project / entries / content / offset / limit（没有 path）；replay 取最保守的 unsafe', () => {
    expect(KNOWLEDGE_TOOL_NAME).toBe('knowledge')
    const { tool } = makeTool()
    expect(tool.name).toBe('knowledge')
    expect(tool.label).toBe('Knowledge')
    expect(props.action.enum).toEqual([
      'bases',
      'search',
      'list',
      'read',
      'submit',
      'organize',
      'migrate'
    ])
    // 动作 / 参数一旦漂回旧形状，模型就会以为还能交一个路径
    expect(Object.keys(props).sort()).toEqual([
      'action',
      'base',
      'content',
      'entries',
      'entry',
      'limit',
      'offset',
      'project',
      'query'
    ])
    for (const gone of [
      'path',
      'dir',
      'type',
      'title',
      'description',
      'body',
      'tags',
      'sources',
      'status',
      'scope'
    ]) {
      expect(props[gone], gone).toBeUndefined()
    }
    // submit 会派管理员、回写章：durable 的重跑策略只能取最保守的那个
    expect(tool.replay).toBe('unsafe')
  })

  it('KT-1b 读侧（bases / search / list / read）一个字节都不写、不派管理员，也不经 port 读文件 —— 读的是宿主的扫描缓存', async () => {
    const h = makeTool({
      files: { [`${ROOT}/a.md`]: ENTRY },
      bases: [{ base: 'project', label: 'project "Acme"', dir: ROOT }]
    })
    await h.tool.preExecute()
    const before = h.files.get(`${ROOT}/a.md`)
    for (const params of [
      { action: 'bases' },
      { action: 'search', base: 'project', query: 'A' },
      { action: 'search', query: 'A' },
      { action: 'list', base: 'project' },
      { action: 'read', base: 'project', entry: '/a.md' }
    ] as KnowledgeToolParams[]) {
      expect((await h.run('c1', params)).isError, params.action).toBeFalsy()
    }
    expect(h.files.get(`${ROOT}/a.md`)).toBe(before)
    expectNothingHappened(h)
  })

  it('KT-1c 未知动作（如旧的 write / create）：失败并列出合法的七个', async () => {
    const h = makeTool()
    for (const action of ['write', 'create', 'validate']) {
      expect(
        await rejectionOf(h.run('c1', { action } as unknown as KnowledgeToolParams)),
        action
      ).toBe(
        `Unknown action "${action}". Valid: bases, search, list, read, submit, organize, migrate`
      )
    }
    expectNothingHappened(h)
  })
})

describe('KT-12′ 给 agent 的文案', () => {
  const props = KnowledgeParamsSchema.properties as unknown as Record<
    string,
    { description?: string }
  >

  it('KT-12′ 两处文案都指向 "bases"、不点名 "project"；base 的说明点名 list / read / submit / organize / migrate 必填、search 可省', () => {
    for (const [where, copy] of [
      ['base.description', props.base.description],
      ['KNOWLEDGE_DESCRIPTION', KNOWLEDGE_DESCRIPTION]
    ] as const) {
      expect(copy, where).toContain('"bases"')
      expect(copy, where).not.toContain('"project"')
    }
    expect(props.base.description).toContain(
      'Required for "list", "read", "submit", "organize" and "migrate" (where the entries go)'
    )
    expect(props.base.description).toContain('"search" without it')
    // entry 的说明：名字就是 search / list 给出来的那一种
    expect(props.entry.description).toContain('as "search" and "list" give it')
    expect(props.content.description).toContain('"submit"')
    expect(props.content.description).toContain('"organize"')
    expect(props.offset.description).toContain('"read"')
  })

  it('KT-12′ 描述讲 read、submit（交给 librarian、它决定留什么）与 organize（用户要整理时）；动作条目恰为七个（末尾是 migrate）', () => {
    for (const phrase of [
      'user picks which bases',
      'leave `base` out',
      'not the prose',
      'then "read" the entry',
      '`offset`',
      '`limit`',
      "hand the base's librarian",
      '`content`',
      'name that `entry`',
      'The librarian decides what the base keeps',
      'part of what you sent, or nothing',
      'when the user wants a base tidied up',
      'removing what has no lasting value',
      '"/auth/token-refresh.md"'
    ]) {
      expect(KNOWLEDGE_DESCRIPTION, phrase).toContain(phrase)
    }
    const actionLines = KNOWLEDGE_DESCRIPTION.split('\n')
      .filter((line) => line.startsWith('- "'))
      .map((line) => /^- "([a-z]+)"/.exec(line)?.[1])
    expect(actionLines).toEqual([
      'bases',
      'search',
      'list',
      'read',
      'submit',
      'organize',
      'migrate'
    ])
  })

  it('KT-12′ 描述与参数说明里没有文件工具、目录、元数据的话：不教 write / edit / grep，不说 directory / permanent / verified', () => {
    const copies = [
      KNOWLEDGE_DESCRIPTION,
      ...Object.values(props).map((p) => p.description ?? '')
    ].join('\n')
    for (const phrase of [
      '`write`',
      '`edit`',
      '`grep`',
      'directory',
      'absolute',
      'permanent',
      'verified',
      'shuvix://',
      '`path`'
    ]) {
      expect(copies, phrase).not.toContain(phrase)
    }
  })
})

// ─── 1.2 读侧 ────────────────────────────────────────────────────────────────

describe('KT-3 search —— 注入的检索（宿主 okf-minisearch）', () => {
  it('KT-3 命中：query 与 {limit, bundleDir} 原样转发；每条恰一行 `- /<条目名> (status) — description|title`', async () => {
    // 一条命中一行，没有正文片段那一行 —— 检索给的是候选清单，正文由 `read` 取（2026-09-17 裁决）
    const search = vi.fn(async () => [
      { path: '/a.md', title: 'A', description: 'd', status: 'draft' },
      { path: 'b.md', title: 'B', status: 'stable' }
    ])
    const h = makeTool({ search })
    const res = await h.run('c1', { action: 'search', base: 'project', query: 'q' })
    expect(h.resolveBase).toHaveBeenCalledWith('project')
    expect(search).toHaveBeenCalledWith('q', { limit: 20, bundleDir: ROOT })
    expect(textOf(res)).toBe(
      `2 result(s) for "q" in ${IN_PROJECT}:\n- /a.md (draft) — d\n- /b.md — B`
    )
    expect(res.details).toEqual({ action: 'search' })
  })

  it('KT-3b 零命中回一句话；缺 query 是失败；bundle 解析失败按 list 同口径回文字（不失败）', async () => {
    const search = vi.fn(async () => [])
    const h = makeTool({ search })
    expect(
      textOf(await h.run('c1', { action: 'search', base: 'project', query: 'q', limit: 5 }))
    ).toBe('No entries match "q".')
    expect(search).toHaveBeenCalledWith('q', { limit: 5, bundleDir: ROOT })
    expect(
      await rejectionOf(h.run('c2', { action: 'search', base: 'project', query: '  ' }))
    ).toContain('"search" needs `query`')
    const noProject = makeTool({ search, bundle: { error: 'no project here' } })
    const res = await noProject.run('c3', { action: 'search', base: 'project', query: 'q' })
    expect(textOf(res)).toBe('no project here')
    expect(res.isError).toBeFalsy()
    expect(res.details).toEqual({ action: 'search' })
    expect(search).toHaveBeenCalledTimes(1)
  })
})

describe('KT-4 search —— 缺省子串检索（无 search 注入）', () => {
  const FILES = {
    [`${ROOT}/a.md`]: doc([
      'type: Memory',
      'title: Token refresh',
      'description: da',
      'status: draft',
      'generated: { by: g, at: "2026-09-09T08:12:03.000Z" }'
    ]),
    // 正文里的**标题行**算命中（索引的正文面只有标题）；散文不算 —— 下面 g.md 钉这一半
    [`${ROOT}/b.md`]: doc(
      ['type: Memory', 'title: B', 'description: db'],
      '## the TOKEN section\n\nit expires'
    ),
    [`${ROOT}/c.md`]: doc(['type: Memory', 'title: C', 'description: dc', 'tags: [token]']),
    [`${ROOT}/d.md`]: doc([
      'type: Memory',
      'title: Token dep',
      'description: dd',
      'status: deprecated'
    ]),
    [`${ROOT}/sub/e.md`]: doc(['type: Memory', 'title: Token in acme', 'description: de']),
    [`${ROOT}/f.md`]: doc(['type: Memory', 'title: F', 'description: df']),
    [`${ROOT}/g.md`]: doc(
      ['type: Memory', 'title: G', 'description: dg'],
      'a paragraph about the token, in prose only'
    )
  }

  it('KT-4 标题 / 描述 / 标签 / 正文标题行算命中，散文不算，deprecated 排除；表头报全部命中、行数按 limit 截', async () => {
    const h = makeTool({ files: FILES })
    const all = await h.run('c1', { action: 'search', base: 'project', query: 'token' })
    expect(textOf(all)).toBe(
      [
        `4 result(s) for "token" in ${IN_PROJECT}:`,
        '- /a.md (draft, 2026-09-09) — da',
        '- /b.md — db',
        '- /c.md — dc',
        '- /sub/e.md — de'
      ].join('\n')
    )
    const capped = await h.run('c2', {
      action: 'search',
      base: 'project',
      query: 'Token',
      limit: 1
    })
    expect(textOf(capped)).toBe(
      `4 result(s) for "Token" in ${IN_PROJECT}:\n- /a.md (draft, 2026-09-09) — da`
    )
    expect(textOf(await h.run('c3', { action: 'search', base: 'project', query: 'zzz' }))).toBe(
      'No entries match "zzz".'
    )
  })
})

describe('KT-5 list', () => {
  const FILES = {
    [`${ROOT}/a.md`]: doc(['type: Memory', 'title: A', 'description: da', 'status: draft']),
    [`${ROOT}/b.md`]: doc(['type: Memory', 'title: B', 'description: db']),
    [`${ROOT}/d.md`]: doc(['type: Memory', 'title: D', 'description: dd', 'status: deprecated'])
  }

  it('KT-5 列出全部条目（含 deprecated，带标注）、表头点名库与标签；limit 之外折成一行计数', async () => {
    const h = makeTool({ files: FILES })
    const res = await h.run('c1', { action: 'list', base: 'project' })
    expect(textOf(res)).toBe(
      [
        `3 entries in ${IN_PROJECT}:`,
        '- /a.md (draft) — da',
        '- /b.md — db',
        '- /d.md (deprecated) — dd'
      ].join('\n')
    )
    expect(res.details).toEqual({ action: 'list' })
    expect(textOf(await h.run('c2', { action: 'list', base: 'project', limit: 2 }))).toBe(
      [`3 entries in ${IN_PROJECT}:`, '- /a.md (draft) — da', '- /b.md — db', '- … 1 more'].join(
        '\n'
      )
    )
  })

  it('KT-5b bundle 解析失败回文字（不失败）；bundle 在但还没有条目也有一句话（不点名目录）', async () => {
    const noProject = makeTool({ files: FILES, bundle: { error: 'no project here' } })
    const failed = await noProject.run('c1', { action: 'list', base: 'project' })
    expect(textOf(failed)).toBe('no project here')
    expect(failed.isError).toBeFalsy()
    expect(failed.details).toEqual({ action: 'list' })
    expect(noProject.resolveBase).toHaveBeenCalledWith('project')

    expect(textOf(await makeTool().run('c2', { action: 'list', base: 'project' }))).toBe(
      `No entries in ${IN_PROJECT} yet.`
    )
  })
})

/**
 * 以下钉 base 本身（设计附录 U）。**刻意不给缺省**：缺省一旦落到项目库，agent 就永远想不起用户库 ——
 * 所以缺 base 必须失败。工具也不区分库的种类：名字去空白后交给宿主，标签与目录全用宿主给的。
 */
describe('KT-8 bases —— 只列库', () => {
  it('KT-8 表头 + 逐行 `- <base> — <label>`（不带目录）；不解析 base、不写盘；多带的 base / entry 一概不看', async () => {
    const h = makeTool({
      bases: [
        { base: 'project', label: 'project "Acme"', dir: '/kb/projects/acme' },
        { base: 'notes', label: 'knowledge base "notes"', dir: '/u/notes' }
      ]
    })
    const expected = [
      'Knowledge bases in this session (pass the name as `base`):',
      '- project — project "Acme"',
      '- notes — knowledge base "notes"'
    ].join('\n')

    const res = await h.run('c1', { action: 'bases' })
    expect(textOf(res)).toBe(expected)
    expect(res.details).toEqual({ action: 'bases' })
    expect(h.listBases).toHaveBeenCalledTimes(1)

    const again = await h.run('c2', { action: 'bases', base: 'notes', entry: '/x.md' })
    expect(textOf(again)).toBe(expected)
    expect(again.details).toEqual({ action: 'bases' })
    expect(h.listBases).toHaveBeenCalledTimes(2)

    expect(h.resolveBase).not.toHaveBeenCalled()
    expectNothingHappened(h)
  })

  it('KT-8 宿主给了说明就括注出来；一个库都没启用时只说一句「是用户在设置里选的」', async () => {
    const withNote = makeTool({
      bases: [{ base: 'notes', label: 'knowledge base "notes"', note: 'not on disk right now' }]
    })
    expect(textOf(await withNote.run('c1', { action: 'bases' }))).toBe(
      [
        'Knowledge bases in this session (pass the name as `base`):',
        '- notes — knowledge base "notes" (not on disk right now)'
      ].join('\n')
    )

    const none = makeTool({ bases: [] })
    const text = textOf(await none.run('c1', { action: 'bases' }))
    expect(text).toContain('no knowledge bases')
    expect(text).toContain('the user picks')
  })
})

describe('KT-9′ 缺 base 是硬错误', () => {
  /** 不传 / 空串 / 全空白 */
  const MISSING: (string | undefined)[] = [undefined, '', '   ']
  /** list / read / submit —— search 不在其中：省略 base 是它的正常用法 */
  const CALLS: KnowledgeToolParams[] = [
    { action: 'list' },
    { action: 'read', entry: 'a.md' },
    { action: 'submit', content: 'x' }
  ]
  const table = CALLS.flatMap((params) =>
    MISSING.map((base): [string, string, KnowledgeToolParams] => [
      params.action,
      base === undefined ? '不传' : JSON.stringify(base),
      base === undefined ? params : { ...params, base }
    ])
  )

  it.each(table)(
    'KT-9′ %s，base %s → 失败点名 `base`（并指向 "bases"）；不解析、不扫描、不检索、不派管理员',
    async (_label, _base, params) => {
      const search = vi.fn(async () => [])
      // 条目真实存在：少了这道守卫，read / submit 会成功，而不是碰巧因为别的原因失败
      const h = makeTool({ search, files: { [`${ROOT}/a.md`]: ENTRY } })
      const message = await rejectionOf(h.run('c1', params))
      expect(message).toBe(
        `"${params.action}" needs \`base\` — one of the names "bases" lists for this session`
      )
      expect(message).not.toContain('"project"')
      expect(h.resolveBase).not.toHaveBeenCalled()
      expect(h.scan).not.toHaveBeenCalled()
      expect(search).not.toHaveBeenCalled()
      expectNothingHappened(h)
    }
  )
})

describe('KT-10′ 工具不关心 base 是哪种库', () => {
  const DIR = '/u/读书笔记'
  const USER_BASE: KnowledgeBundleTarget = { dir: DIR, label: 'knowledge base "读书笔记"' }
  /** 带首尾空白的库名：工具只去空白，其余原样交给宿主 */
  const RAW = '  读书笔记 '
  const IN_USER = 'base "读书笔记" (knowledge base "读书笔记")'

  it('KT-10′ list / search / read / submit 都按去空白的名字解析；表头用宿主给的标签，扫描、检索、管理员请求、afterWrite 用宿主给的目录', async () => {
    const search = vi.fn(async () => [{ path: 'a.md', title: 'A', description: 'da' }])
    const h = makeTool({
      bundle: USER_BASE,
      search,
      admin: librarian({ 'a.md': ENTRY }),
      files: {
        [`${DIR}/a.md`]: ENTRY,
        [`${DIR}/b.md`]: doc(['type: Memory', 'title: B', 'description: db']),
        // 别的库里的条目：清单只含宿主解析出的那个目录
        [`${ROOT}/x.md`]: doc(['type: Memory', 'title: X', 'description: dx'])
      }
    })

    expect(textOf(await h.run('c1', { action: 'list', base: RAW }))).toBe(
      [`2 entries in ${IN_USER}:`, '- /a.md — da', '- /b.md — db'].join('\n')
    )
    expect(textOf(await h.run('c2', { action: 'search', base: RAW, query: 'q' }))).toBe(
      `1 result(s) for "q" in ${IN_USER}:\n- /a.md — da`
    )
    expect(search).toHaveBeenCalledWith('q', { limit: 20, bundleDir: DIR })
    expect(
      textOf(await h.run('c3', { action: 'read', base: RAW, entry: 'a.md' })).split('\n')[0]
    ).toBe(`Entry /a.md in base "读书笔记" (knowledge base "读书笔记") — 9 lines`)

    const submitted = await h.run('c4', {
      action: 'submit',
      base: RAW,
      content: 'x',
      entry: '/a.md'
    })
    expect(textOf(submitted).split('\n').slice(0, 2)).toEqual([
      'Recorded in base "读书笔记":',
      '- /a.md (updated)'
    ])
    expect(h.admin.mock.calls[0][0]).toMatchObject({
      base: '读书笔记',
      label: 'knowledge base "读书笔记"',
      bundleDir: DIR,
      entry: 'a.md'
    })

    expect(h.resolveBase.mock.calls).toEqual([
      ['读书笔记'],
      ['读书笔记'],
      ['读书笔记'],
      ['读书笔记']
    ])
    expect(h.scan.mock.calls.every(([dir]) => dir === DIR)).toBe(true)
    expect(h.calls).toEqual(['admin:读书笔记', `write:${DIR}/a.md`, `after:${DIR}|a.md`])
  })
})

describe('KT-11′ base 解析失败', () => {
  const ERR = 'No knowledge base named "nope". Available: "project", "notes".'

  it('KT-11′ read / submit 以宿主原文失败（硬错）；list / search 回这句原文、不失败（软条件）；都不扫描、不派管理员', async () => {
    const search = vi.fn(async () => [])
    const h = makeTool({ bundle: { error: ERR }, search, files: { [`${ROOT}/a.md`]: ENTRY } })

    expect(await rejectionOf(h.run('c1', { action: 'submit', base: 'nope', content: 'x' }))).toBe(
      ERR
    )
    expect(await rejectionOf(h.run('c2', { action: 'read', base: 'nope', entry: 'a.md' }))).toBe(
      ERR
    )

    const listed = await h.run('c3', { action: 'list', base: 'nope' })
    expect(listed.isError).toBeFalsy()
    expect(textOf(listed)).toBe(ERR)
    expect(listed.details).toEqual({ action: 'list' })
    const searched = await h.run('c4', { action: 'search', base: 'nope', query: 'q' })
    expect(searched.isError).toBeFalsy()
    expect(textOf(searched)).toBe(ERR)
    expect(searched.details).toEqual({ action: 'search' })

    expect(search).not.toHaveBeenCalled()
    expect(h.scan).not.toHaveBeenCalled()
    expectNothingHappened(h)
  })
})

/**
 * 读宽（设计附录 L）：库里每个 md 都是一条笔记 —— list / search / read 都算它。ShuviX 早先生成的 index.md /
 * log.md 不再维护、按形状藏起来；用户手写的同名文件是普通笔记。
 */
const NOTE_FILES = {
  [`${ROOT}/a.md`]: doc(['type: Memory', 'title: A', 'description: da', 'status: draft']),
  // 生成形状的 index：不是笔记
  [`${ROOT}/index.md`]: '## Entries\n\n* [A](a.md)\n',
  // 手写的 log：是笔记
  [`${ROOT}/log.md`]: '# My log\n',
  [`${ROOT}/notes/plain.md`]: '# Plain heading\n\nbody\n',
  [`${ROOT}/u.md`]: '---\ndescription: du\nstatus: draft\n---\n\nbody\n'
}

describe('KT-13 / KT-15 读宽', () => {
  it('KT-13 list：普通笔记与条目一起列出；行尾取 description，否则取笔记标题；生成形状的 index 不列，手写 log 照列', async () => {
    const h = makeTool({ files: NOTE_FILES })
    expect(textOf(await h.run('c1', { action: 'list', base: 'project' }))).toBe(
      [
        `4 entries in ${IN_PROJECT}:`,
        '- /a.md (draft) — da',
        '- /log.md — My log',
        '- /notes/plain.md — Plain heading',
        '- /u.md (draft) — du'
      ].join('\n')
    )
  })

  it('KT-15 不注入 search 时的子串检索覆盖普通笔记；只出现在生成 index 里的词不命中', async () => {
    const h = makeTool({ files: NOTE_FILES })
    expect(
      textOf(await h.run('c1', { action: 'search', base: 'project', query: 'plain heading' }))
    ).toBe(`1 result(s) for "plain heading" in ${IN_PROJECT}:\n- /notes/plain.md — Plain heading`)
    expect(textOf(await h.run('c2', { action: 'search', base: 'project', query: 'Entries' }))).toBe(
      'No entries match "Entries".'
    )
  })
})

/**
 * 省略 `base` 的**跨库检索**（设计附录 N）：范围是用户自己圈定的那几个库。跨库这条路刻意不解析 base ——
 * 它问的是 `listBases`。不做跨库分数归一：按库分组、逐库成块；`limit` 逐库生效。
 */
describe('KT-16..20 跨库检索（省略 base）', () => {
  /** 用户库的目录 —— 与 ROOT 互不为前缀（scanOf 按目录前缀分派） */
  const NOTES = '/kb/user/notes'
  const ALPHA = '/kb/user/alpha'
  const NOTES_BASE: KnowledgeBaseInfo = {
    base: 'notes',
    label: 'knowledge base "notes"',
    dir: NOTES
  }
  const PROJECT_BASE: KnowledgeBaseInfo = { base: 'project', label: 'project "Acme"', dir: ROOT }
  const HIT_FILES = {
    [`${NOTES}/n1.md`]: doc(['type: Memory', 'title: Token notes', 'description: dn1']),
    [`${ROOT}/a.md`]: doc(['type: Memory', 'title: Token in acme', 'description: da'])
  }

  it('KT-16 省略 base：按库分组、逐库成块（块头是库名 + 标签），表头报总命中数与参与的库数；只问 listBases，不解析 base', async () => {
    const h = makeTool({ files: HIT_FILES, bases: [NOTES_BASE, PROJECT_BASE] })
    const res = await h.run('c1', { action: 'search', query: 'token' })
    expect(textOf(res)).toBe(
      [
        '2 result(s) for "token" across 2 base(s):',
        'base "notes" (knowledge base "notes"):',
        '- /n1.md — dn1',
        'base "project" (project "Acme"):',
        '- /a.md — da'
      ].join('\n')
    )
    expect(res.details).toEqual({ action: 'search' })
    expect(h.resolveBase).not.toHaveBeenCalled()
    expect(h.listBases).toHaveBeenCalledTimes(1)
    expect(h.scan.mock.calls).toEqual([[NOTES], [ROOT]])
    expectNothingHappened(h)
  })

  it('KT-17 零命中的库不占块，但库数仍按圈定的范围算；全部零命中时另说一句', async () => {
    const h = makeTool({
      files: {
        [`${NOTES}/n1.md`]: doc(['type: Memory', 'title: Token notes', 'description: dn1']),
        [`${ROOT}/b.md`]: doc(['type: Memory', 'title: B', 'description: db'])
      },
      bases: [NOTES_BASE, PROJECT_BASE]
    })
    const one = textOf(await h.run('c1', { action: 'search', query: 'token' }))
    expect(one).toBe(
      [
        '1 result(s) for "token" across 2 base(s):',
        'base "notes" (knowledge base "notes"):',
        '- /n1.md — dn1'
      ].join('\n')
    )
    const none = await h.run('c2', { action: 'search', query: 'zzz' })
    expect(textOf(none)).toBe(`No entries match "zzz" in any of this session's knowledge bases.`)
    expect(none.details).toEqual({ action: 'search' })
  })

  it('KT-18 跨库时 limit 逐库生效、不是总额；宿主说「此刻不在」（无 dir）的库整条跳过', async () => {
    const search = vi.fn(async (_q: string, opts: { limit: number; bundleDir: string }) => [
      { path: '/h.md', title: `hit in ${opts.bundleDir}`, description: 'd' }
    ])
    const h = makeTool({
      search,
      bases: [
        NOTES_BASE,
        { base: 'gone', label: 'knowledge base "gone"' },
        { base: 'alpha', label: 'knowledge base "alpha"', dir: ALPHA }
      ]
    })
    const res = await h.run('c1', { action: 'search', query: 'q', limit: 3 })
    expect(search.mock.calls).toEqual([
      ['q', { limit: 3, bundleDir: NOTES }],
      ['q', { limit: 3, bundleDir: ALPHA }]
    ])
    expect(textOf(res).split('\n')[0]).toBe('2 result(s) for "q" across 2 base(s):')
    expect(textOf(res)).not.toContain('gone')
  })

  it('KT-19 一个库都没启用时，省略 base 的检索与 bases 说同一句话', async () => {
    const h = makeTool({ bases: [] })
    const res = await h.run('c1', { action: 'search', query: 'token' })
    const text = textOf(res)
    expect(text).toContain('no knowledge bases')
    expect(text).toContain('the user picks')
    expect(text).toBe(textOf(await h.run('c2', { action: 'bases' })))
    expect(res.details).toEqual({ action: 'search' })
    expect(h.resolveBase).not.toHaveBeenCalled()
  })

  it('KT-20 点名 base 就不跨库：单库表头、不分组，走 resolveBase 而不是 listBases', async () => {
    const h = makeTool({
      files: HIT_FILES,
      bases: [NOTES_BASE, PROJECT_BASE],
      bundle: { dir: NOTES, label: 'knowledge base "notes"' }
    })
    const res = await h.run('c1', { action: 'search', base: 'notes', query: 'token' })
    expect(textOf(res)).toBe(
      `1 result(s) for "token" in base "notes" (knowledge base "notes"):\n- /n1.md — dn1`
    )
    expect(
      textOf(res)
        .split('\n')
        .filter((line) => line.startsWith('base "'))
    ).toEqual([])
    expect(h.listBases).not.toHaveBeenCalled()
    expect(h.resolveBase).toHaveBeenCalledTimes(1)
    expect(h.resolveBase).toHaveBeenCalledWith('notes')
  })
})

/**
 * 只读库 —— 宿主随应用发布的那一个内置库：`resolveBase` 回的 target 带 `readonly: true`。它存在的意义
 * 就是被读：list / search / read 照常，`submit` 在派管理员之前被拒（KS-5）。
 */
describe('KT-22′ / KT-23 只读库（随应用发布的内置库）', () => {
  const DIR = '/kb/builtin/shuvix/en'
  const BUILTIN: KnowledgeBundleTarget = {
    dir: DIR,
    label: 'ShuviX reference (read-only)',
    readonly: true
  }
  const READONLY_NOTE = 'read-only: search and read it, never submit here'
  const GUIDE = `${DIR}/agent-md.md`
  const FILES = {
    [GUIDE]: doc(
      ['type: Reference', 'title: Agent md', 'description: how an agent md file is written'],
      'frontmatter keys, then the body'
    )
  }
  const IN_BUILTIN = 'base "shuvix" (ShuviX reference (read-only))'

  it('KT-22′ 只读库照常被 list / search / read；一个字都不写', async () => {
    const h = makeTool({ bundle: BUILTIN, files: FILES })
    expect(textOf(await h.run('c1', { action: 'list', base: 'shuvix' }))).toBe(
      [`1 entry in ${IN_BUILTIN}:`, '- /agent-md.md — how an agent md file is written'].join('\n')
    )
    expect(textOf(await h.run('c2', { action: 'search', base: 'shuvix', query: 'agent md' }))).toBe(
      [
        `1 result(s) for "agent md" in ${IN_BUILTIN}:`,
        '- /agent-md.md — how an agent md file is written'
      ].join('\n')
    )
    const read = textOf(await h.run('c3', { action: 'read', base: 'shuvix', entry: 'agent-md' }))
    expect(read.split('\n')[0]).toBe(`Entry /agent-md.md in ${IN_BUILTIN} — 7 lines`)
    expect(read).toContain('frontmatter keys, then the body')
    expectNothingHappened(h)
    expect(h.files.get(GUIDE)).toBe(FILES[GUIDE])
    expect(h.scan).toHaveBeenCalledWith(DIR)
  })

  it('KT-23 bases：带 note 的行原样括注（括在最后），没有 note 的行不多出一对空括号', async () => {
    const h = makeTool({
      bases: [
        { base: 'notes', label: 'knowledge base "notes"', dir: '/u/notes' },
        { base: 'alpha', label: 'knowledge base "alpha"', dir: '/u/alpha', note: '' },
        { base: 'shuvix', label: BUILTIN.label, dir: DIR, note: READONLY_NOTE }
      ]
    })
    const lines = textOf(await h.run('c1', { action: 'bases' })).split('\n')
    expect(lines).toEqual([
      'Knowledge bases in this session (pass the name as `base`):',
      '- notes — knowledge base "notes"',
      '- alpha — knowledge base "alpha"',
      `- shuvix — ShuviX reference (read-only) (${READONLY_NOTE})`
    ])
    for (const line of [lines[1], lines[2]]) expect(line).not.toContain('(')
  })
})

/**
 * KT-25..KT-33 —— 2026-09-17 的裁决（设计附录 Q）：一条命中恰一行（`snippet` 整个字段删掉了），扩展端
 * 没有宿主索引时的子串兜底与宿主索引同一个召回口径（门面 + 正文标题行）。
 */
type LooseHit = KnowledgeSearchHit & Record<string, unknown>

describe('KT-25..KT-27 一条命中恰一行', () => {
  it('KT-25 宿主回包里多带 snippet / score 等字段：渲染不受影响，仍是一行', async () => {
    const search = vi.fn(
      async (): Promise<LooseHit[]> => [
        {
          path: '/a.md',
          title: 'A',
          description: 'da',
          status: 'stable',
          snippet: 'a whole paragraph of body text\nwith a second line',
          score: 12.5
        },
        { path: '/b.md', title: 'B', description: 'db', status: 'stable', snippet: 'more prose' }
      ]
    )
    const h = makeTool({ search })
    const out = textOf(await h.run('c1', { action: 'search', base: 'project', query: 'q' }))
    expect(out.split('\n')).toEqual([
      `2 result(s) for "q" in ${IN_PROJECT}:`,
      '- /a.md — da',
      '- /b.md — db'
    ])
    expect(out).not.toMatch(/paragraph|prose|12\.5/)
  })

  it('KT-26 逐字渲染：description 优先于 title、status 非 stable 才括注、条目名一律归一成 `/rel`', async () => {
    const search = vi.fn(
      async (): Promise<KnowledgeSearchHit[]> => [
        { path: '/a.md', title: 'A', description: 'da', status: 'stable' },
        { path: 'b.md', title: 'B', description: '', status: 'draft' },
        { path: 'sub/c.md', title: 'C', status: 'deprecated' },
        { path: '/sub/d.md', title: 'D', description: 'dd' },
        { path: './e.md', title: 'E', description: 'de', status: 'stable' },
        { path: 'sub\\f.md', title: 'F', description: 'df' }
      ]
    )
    const h = makeTool({ search })
    expect(textOf(await h.run('c1', { action: 'search', base: 'project', query: 'q' }))).toBe(
      [
        `6 result(s) for "q" in ${IN_PROJECT}:`,
        '- /a.md — da',
        '- /b.md (draft) — B',
        '- /sub/c.md (deprecated) — C',
        '- /sub/d.md — dd',
        '- /e.md — de',
        '- /sub/f.md — df'
      ].join('\n')
    )
  })

  it('KT-27 跨库：每条命中仍恰一行、按库分组，块与块之间没有正文片段', async () => {
    const NOTES = '/kb/user/notes'
    const search = vi.fn(
      async (_q: string, opts: { limit: number; bundleDir: string }): Promise<LooseHit[]> =>
        opts.bundleDir === NOTES
          ? [{ path: '/n1.md', title: 'N1', description: 'dn1', snippet: 'prose from notes' }]
          : [
              { path: '/a1.md', title: 'A1', description: 'da1', snippet: 'prose from acme' },
              { path: '/a2.md', title: 'A2', status: 'draft', snippet: 'more acme prose' }
            ]
    )
    const h = makeTool({
      search,
      bases: [
        { base: 'notes', label: 'knowledge base "notes"', dir: NOTES },
        { base: 'project', label: 'project "Acme"', dir: ROOT }
      ]
    })
    const res = await h.run('c1', { action: 'search', query: 'q' })
    expect(textOf(res)).toBe(
      [
        '3 result(s) for "q" across 2 base(s):',
        'base "notes" (knowledge base "notes"):',
        '- /n1.md — dn1',
        'base "project" (project "Acme"):',
        '- /a1.md — da1',
        '- /a2.md (draft) — A2'
      ].join('\n')
    )
    expect(textOf(res).split('\n')).toHaveLength(6)
  })
})

describe('KT-28..KT-31 子串兜底的召回口径', () => {
  const FILES = {
    [`${ROOT}/title.md`]: doc(['type: Memory', 'title: Zebracorn', 'description: dt']),
    [`${ROOT}/desc.md`]: doc(['type: Memory', 'title: T2', 'description: about the quokka']),
    [`${ROOT}/type.md`]: doc(['type: Runbook', 'title: T3', 'description: d3']),
    [`${ROOT}/tags.md`]: doc(['type: Memory', 'title: T4', 'description: d4', 'tags: [platypus]']),
    [`${ROOT}/head.md`]: doc(
      ['type: Memory', 'title: T5', 'description: d5'],
      '## Marmoset section\n\na paragraph about the dingo'
    ),
    [`${ROOT}/fence.md`]: doc(
      ['type: Memory', 'title: T6', 'description: d6'],
      '```\n## Hidden kakapo\n```\n'
    )
  }
  /** `[query, 渲染出来的命中行]`；空数组 = 一条都不该命中 */
  const TABLE: [string, string[]][] = [
    ['Zebracorn', ['- /title.md — dt']],
    ['quokka', ['- /desc.md — about the quokka']],
    ['Runbook', ['- /type.md — d3']],
    ['platypus', ['- /tags.md — d4']],
    ['Marmoset', ['- /head.md — d5']],
    ['dingo', []],
    ['kakapo', []]
  ]

  it.each(TABLE)('KT-28 不注入 search：查 %s 的命中就是 %j', async (query, expected) => {
    const h = makeTool({ files: FILES })
    const out = textOf(await h.run('c1', { action: 'search', base: 'project', query }))
    if (expected.length === 0) {
      expect(out).toBe(`No entries match "${query}".`)
      return
    }
    expect(out.split('\n').slice(1)).toEqual(expected)
  })

  it('KT-28 注入 search：工具一条都不自己筛 —— 宿主给什么就渲染什么', async () => {
    const search = vi.fn(
      async (): Promise<KnowledgeSearchHit[]> => [
        { path: '/dingo-only.md', title: 'Prose hit', description: 'the host said so' }
      ]
    )
    const h = makeTool({ files: FILES, search })
    expect(textOf(await h.run('c1', { action: 'search', base: 'project', query: 'dingo' }))).toBe(
      `1 result(s) for "dingo" in ${IN_PROJECT}:\n- /dingo-only.md — the host said so`
    )
    expect(h.scan).not.toHaveBeenCalled()
  })

  /** 命中行的条目名（`- <entry> …` 的第一段） */
  const found =
    (h: Harness) =>
    async (query: string): Promise<string[]> =>
      textOf(await h.run('c1', { action: 'search', base: 'project', query }))
        .split('\n')
        .slice(1)
        .map((line) => line.slice(2).split(' ')[0])

  it('KT-29 兜底只看标题行不看整段正文；未闭合 frontmatter 时与宿主同样把 YAML 注释当标题', async () => {
    const h = makeTool({
      files: {
        [`${ROOT}/a.md`]: doc(
          ['type: Memory', 'title: A', 'description: da'],
          '## the okapi heading\n\nand a paragraph about the numbat'
        ),
        [`${ROOT}/open.md`]:
          '---\ntitle: Oryx\n## a yaml comment about the saiga\nprose about the tapir\n'
      }
    })
    const hits = found(h)
    expect(await hits('okapi')).toEqual(['/a.md'])
    expect(await hits('numbat')).toEqual([])
    expect(await hits('saiga')).toEqual(['/open.md'])
    expect(await hits('Oryx')).toEqual([])
    expect(await hits('tapir')).toEqual([])
  })

  it('KT-30 相邻标题用空格连接：标题 ["ab","cd"] 查 "b c" 会命中（兜底本就是粗口径）', async () => {
    const h = makeTool({
      files: {
        [`${ROOT}/a.md`]: doc(['type: Memory', 'title: A', 'description: da'], '## ab\n\n## cd\n')
      }
    })
    const hit = async (query: string): Promise<boolean> =>
      !textOf(await h.run('c1', { action: 'search', base: 'project', query })).startsWith(
        'No entries'
      )
    expect(await hit('b c')).toBe(true)
    expect(await hit('ab cd')).toBe(true)
    expect(await hit('ab')).toBe(true)
    expect(await hit('bc')).toBe(false)
  })

  it('KT-31 兜底大小写不敏感；对 CJK 不分词（整串包含即可，中间加空格就不算）', async () => {
    const h = makeTool({
      files: {
        [`${ROOT}/a.md`]: doc(['type: Memory', 'title: Token Refresh', 'description: da']),
        [`${ROOT}/z.md`]: doc([
          'type: Memory',
          'title: 鉴权与令牌刷新',
          'description: 改动登录时看'
        ])
      }
    })
    const hits = found(h)
    for (const q of ['token refresh', 'TOKEN REFRESH', 'ToKeN']) {
      expect(await hits(q), q).toEqual(['/a.md'])
    }
    expect(await hits('令牌刷新')).toEqual(['/z.md'])
    expect(await hits('与令牌')).toEqual(['/z.md'])
    expect(await hits('令牌 刷新')).toEqual([])
    expect(await hits('鉴权刷新')).toEqual([])
  })
})

describe('KT-32..KT-33 类型与 limit', () => {
  it('KT-32 KnowledgeSearchHit 上没有 snippet', () => {
    const keys: Record<keyof KnowledgeSearchHit, true> = {
      path: true,
      title: true,
      description: true,
      status: true
    }
    expect(Object.keys(keys).sort()).toEqual(['description', 'path', 'status', 'title'])
  })

  it('KT-33 兜底路径：表头报全部命中数、行数按 limit 截；非正数回落缺省，小数截断取整', async () => {
    const files: Record<string, string> = {}
    for (const n of ['a', 'b', 'c']) {
      files[`${ROOT}/${n}.md`] = doc(['type: Memory', `title: kudu ${n}`, `description: d${n}`])
    }
    const h = makeTool({ files })
    const lineCount = async (limit?: number): Promise<number> => {
      const out = textOf(
        await h.run('c1', { action: 'search', base: 'project', query: 'kudu', limit })
      )
      expect(out.split('\n')[0], String(limit)).toBe(`3 result(s) for "kudu" in ${IN_PROJECT}:`)
      return out.split('\n').length - 1
    }
    expect(await lineCount(1)).toBe(1)
    expect(await lineCount(2)).toBe(2)
    expect(await lineCount(undefined)).toBe(3)
    for (const limit of [0, -1, -5, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(await lineCount(limit), String(limit)).toBe(3)
    }
    expect(await lineCount(2.7)).toBe(2)
  })

  it('KT-33 list 的 limit 同一套：缺省 100，非正数回落，小数截断', async () => {
    const files: Record<string, string> = {}
    for (const n of ['a', 'b', 'c']) {
      files[`${ROOT}/${n}.md`] = doc(['type: Memory', `title: ${n}`, `description: d${n}`])
    }
    const h = makeTool({ files })
    const listed = async (limit?: number): Promise<string[]> =>
      textOf(await h.run('c1', { action: 'list', base: 'project', limit }))
        .split('\n')
        .slice(1)
    expect(await listed(undefined)).toHaveLength(3)
    for (const limit of [0, -1, 0.5]) {
      expect(await listed(limit), String(limit)).toHaveLength(3)
    }
    const two = ['- /a.md — da', '- /b.md — db', '- … 1 more']
    expect(await listed(2)).toEqual(two)
    expect(await listed(2.7)).toEqual(two)
  })
})

// ─── 1.3 信任档记号 ──────────────────────────────────────────────────────────

/**
 * 这是模型在工具里唯一能看到信任档的地方：记号顺序「status（非 stable 才有）→ 信任档 → generated 日期」。
 * 信任档按 currentTrustTierOf（为当前内容背书的那几条章）判，核实不再当前时写「edited since checked」。
 */
describe('KT-40..KT-42 列表与兜底检索里的信任档记号', () => {
  const T0 = '2026-09-01T00:00:00.000Z'
  const T1 = '2026-09-05T00:00:00.000Z'
  const T2 = '2026-09-07T00:00:00.000Z'
  const GEN = `generated: { by: "g", at: "${T1}" }`
  const MACHINE = (at: string): string => `{ by: "shuvix-knowledge-writer/x", at: "${at}" }`
  const HUMAN = (at: string): string => `{ by: "human:alice", at: "${at}" }`
  const entry = (title: string, extra: string[]): string =>
    doc(['type: Memory', `title: ${title}`, `description: d${title}`, ...extra])
  /** 按此顺序种进替身扫描（Map 保序 = 清单顺序） */
  const FILES = {
    [`${ROOT}/a.md`]: entry('a', [GEN, `verified: ${MACHINE(T1)}`]),
    [`${ROOT}/b.md`]: entry('b', [GEN, `verified: ${HUMAN(T2)}`]),
    [`${ROOT}/c.md`]: entry('c', [GEN, `verified: [${HUMAN(T0)}, ${MACHINE(T1)}]`]),
    [`${ROOT}/d.md`]: entry('d', [GEN, `verified: ${HUMAN(T0)}`]),
    [`${ROOT}/e.md`]: entry('e', ['status: draft', GEN, `verified: ${MACHINE(T1)}`]),
    [`${ROOT}/f.md`]: entry('f', [GEN]),
    [`${ROOT}/g.md`]: '# g plain\n\nbody\n'
  }

  it('KT-40 list：机器章 / 人工章 / 旧人工 + 新机器 / 核实后又改 / draft + 机器 / 未核实 / 普通笔记 —— 逐行全文', async () => {
    const h = makeTool({ files: FILES })
    expect(textOf(await h.run('c1', { action: 'list', base: 'project' })).split('\n')).toEqual([
      `7 entries in ${IN_PROJECT}:`,
      '- /a.md (machine-confirmed, 2026-09-05) — da',
      '- /b.md (human-reviewed, 2026-09-05) — db',
      // 人看过的是旧内容：不是 human-reviewed
      '- /c.md (machine-confirmed, 2026-09-05) — dc',
      '- /d.md (edited since checked, 2026-09-05) — dd',
      '- /e.md (draft, machine-confirmed, 2026-09-05) — de',
      '- /f.md (2026-09-05) — df',
      '- /g.md — g plain'
    ])
  })

  it('KT-41 注入检索的命中行只带 status 记号（命中结构里没有 verified）', async () => {
    const search = vi.fn(async () => [
      { path: 'c.md', title: 'c', status: 'stable' },
      { path: 'e.md', title: 'e', description: 'de', status: 'draft' }
    ])
    const h = makeTool({ files: FILES, search })
    expect(
      textOf(await h.run('c1', { action: 'search', base: 'project', query: 'x' })).split('\n')
    ).toEqual([`2 result(s) for "x" in ${IN_PROJECT}:`, '- /c.md — c', '- /e.md (draft) — de'])
  })

  it('KT-42 兜底检索的命中行与 list 同一种写法：旧人工 + 新机器那一份同样印 machine-confirmed', async () => {
    const h = makeTool({ files: FILES })
    expect(textOf(await h.run('c1', { action: 'search', base: 'project', query: 'dc' }))).toBe(
      `1 result(s) for "dc" in ${IN_PROJECT}:\n- /c.md (machine-confirmed, 2026-09-05) — dc`
    )
  })
})

// ─── 1.4 库目录：管理员看得到，别人看不到 ──────────────────────────────────────────

describe('KA-1..KA-4 库目录只给管理员', () => {
  const NOTES = '/kb/user/notes'
  const BASES: KnowledgeBaseInfo[] = [
    { base: 'project', label: 'project "Acme"', dir: ROOT },
    { base: 'notes', label: 'knowledge base "notes"', dir: NOTES, note: 'the user’s notes' }
  ]
  const FILES = {
    [`${ROOT}/a.md`]: ENTRY,
    [`${ROOT}/sub/b.md`]: doc(['type: Memory', 'title: B', 'description: db']),
    [`${NOTES}/n1.md`]: doc(['type: Memory', 'title: A note', 'description: dn1'])
  }
  /** 管理员把库目录写进了报告；content 为 "decline" 时不收 */
  const LEAKY: AdminImpl = async (req, ctx, files) => {
    if (req.content === 'decline') {
      return {
        accepted: false,
        entries: [],
        report: `Already covered by ${req.bundleDir}/a.md (see ${req.bundleDir}).`,
        admin: ADMIN
      }
    }
    return librarian(
      { 'auth/x.md': ENTRY, 'a.md': ENTRY },
      (r) => `Created ${r.bundleDir}/auth/x.md and linked it from ${r.bundleDir}/a.md.`
    )(req, ctx, files)
  }

  /** 每一种动作、成功与失败的路子都走一遍，收齐交回给模型的文字 */
  const sweep = async (h: Harness): Promise<string[]> => {
    const out: string[] = []
    const take = async (params: KnowledgeToolParams): Promise<void> => {
      out.push(textOf(await h.run('s', params)))
    }
    await take({ action: 'bases' })
    await take({ action: 'search', base: 'project', query: 'd' })
    await take({ action: 'search', query: 'A' })
    await take({ action: 'search', query: 'zzz' })
    await take({ action: 'list', base: 'project' })
    await take({ action: 'read', base: 'project', entry: '/a.md' })
    // 旧对话里留下的绝对路径也认得，回出来的仍是条目名
    await take({ action: 'read', base: 'project', entry: `${ROOT}/sub/b.md` })
    await take({ action: 'read', base: 'project', entry: '/missing.md' })
    await take({ action: 'read', base: 'project', entry: '../x.md' })
    await take({ action: 'submit', base: 'project', content: 'x', entry: `${ROOT}/a.md` })
    await take({ action: 'submit', base: 'project', content: 'decline' })
    await take({ action: 'submit', base: 'project', content: 'x', entry: 'missing' })
    return out
  }

  it('KA-1 非管理员（不注入 isAdmin / isAdmin 回 false）：bases / search / list / read / submit 的每一种输出里都没有库目录', async () => {
    for (const isAdmin of [undefined, () => false]) {
      const h = makeTool({ files: FILES, bases: BASES, admin: LEAKY, isAdmin })
      const texts = await sweep(h)
      expect(texts).toHaveLength(12)
      for (const text of texts) {
        expect(text).not.toContain(ROOT)
        expect(text).not.toContain(NOTES)
        expect(text).not.toContain('/kb/')
      }
      // 不是因为什么都没印才通过：条目名确实印出来了
      const all = texts.join('\n')
      for (const name of ['/a.md', '/sub/b.md', '/n1.md', '/auth/x.md']) {
        expect(all, name).toContain(name)
      }
    }
  })

  it('KA-2 管理员：bases 行、search（单库与跨库的块头）、list 表头带目录；条目行仍是 `/rel`；read 的表头不带目录', async () => {
    const h = makeTool({ files: FILES, bases: BASES, isAdmin: () => true })
    expect(textOf(await h.run('c1', { action: 'bases' })).split('\n')).toEqual([
      'Knowledge bases in this session (pass the name as `base`):',
      `- project — project "Acme" — ${ROOT}`,
      `- notes — knowledge base "notes" — ${NOTES} (the user’s notes)`
    ])
    expect(textOf(await h.run('c2', { action: 'search', base: 'project', query: 'db' }))).toBe(
      `1 result(s) for "db" in ${IN_PROJECT_ADMIN}:\n- /sub/b.md — db`
    )
    expect(textOf(await h.run('c3', { action: 'search', query: 'A' }))).toBe(
      [
        '2 result(s) for "A" across 2 base(s):',
        `base "project" (project "Acme" — ${ROOT}):`,
        '- /a.md — da',
        `base "notes" (knowledge base "notes" — ${NOTES}):`,
        '- /n1.md — dn1'
      ].join('\n')
    )
    expect(textOf(await h.run('c4', { action: 'list', base: 'project' }))).toBe(
      [`2 entries in ${IN_PROJECT_ADMIN}:`, '- /a.md — da', '- /sub/b.md — db'].join('\n')
    )
    expect(textOf(await h.run('c5', { action: 'list', base: 'project', limit: 1 }))).toBe(
      [`2 entries in ${IN_PROJECT_ADMIN}:`, '- /a.md — da', '- … 1 more'].join('\n')
    )
    const read = textOf(await h.run('c6', { action: 'read', base: 'project', entry: 'a' }))
    expect(read.split('\n')[0]).toBe(`Entry /a.md in ${IN_PROJECT} — 9 lines`)
    expect(read).not.toContain(ROOT)
  })

  it('KA-2b 管理员看到的目录去掉尾随分隔符；空库的那句话也带目录；宿主没给目录的库（此刻不在）不印目录', async () => {
    const h = makeTool({
      bundle: { dir: `${ROOT}/`, label: 'project "Acme"' },
      bases: [
        { base: 'project', label: 'project "Acme"', dir: `${ROOT}/` },
        { base: 'gone', label: 'knowledge base "gone"', note: 'not on disk right now' }
      ],
      isAdmin: () => true
    })
    expect(
      textOf(await h.run('c1', { action: 'bases' }))
        .split('\n')
        .slice(1)
    ).toEqual([
      `- project — project "Acme" — ${ROOT}`,
      '- gone — knowledge base "gone" (not on disk right now)'
    ])
    expect(textOf(await h.run('c2', { action: 'list', base: 'project' }))).toBe(
      `No entries in ${IN_PROJECT_ADMIN} yet.`
    )
  })

  it('KA-3 isAdmin 按这次调用判（收的是调用的 scope）：同一个工具实例，管理员那条对话看得到目录，别的对话看不到', async () => {
    const isAdmin = vi.fn((call: ToolCallScope | undefined) => call?.conversationId === 7)
    const h = makeTool({ files: FILES, bases: BASES, isAdmin })
    const asAdmin = await h.invoke({ action: 'list', base: 'project' }, { conversationId: 7 })
    const asOther = await h.invoke({ action: 'list', base: 'project' }, { conversationId: 1 })
    expect(textOf(asAdmin).split('\n')[0]).toBe(`2 entries in ${IN_PROJECT_ADMIN}:`)
    expect(textOf(asOther).split('\n')[0]).toBe(`2 entries in ${IN_PROJECT}:`)
    expect(isAdmin.mock.calls.map(([call]) => call?.conversationId)).toEqual([7, 1])
  })

  it('KA-4 管理员读侧照常（它要靠它们查重、找该改的那一条）；它的 submit 被拒（见 KS-1）', async () => {
    const h = makeTool({ files: FILES, bases: BASES, isAdmin: () => true })
    for (const params of [
      { action: 'bases' },
      { action: 'search', query: 'A' },
      { action: 'list', base: 'project' },
      { action: 'read', base: 'project', entry: 'sub/b.md' }
    ] as KnowledgeToolParams[]) {
      expect((await h.run('c1', params)).isError, params.action).toBeFalsy()
    }
    expect(
      await rejectionOf(h.run('c2', { action: 'submit', base: 'project', content: 'x' }))
    ).toContain('You are the librarian')
    expectNothingHappened(h)
  })
})

// ─── 1.5 read ───────────────────────────────────────────────────────────────

describe('KE-1..KE-9 read', () => {
  const TOKEN = doc(
    ['type: Memory', 'title: Token refresh', 'description: dt'],
    '## Steps\n\nrefresh before expiry'
  )
  const FIVE = 'l1\nl2\nl3\nl4\nl5\n'
  const FILES = {
    [`${ROOT}/auth/token.md`]: TOKEN,
    [`${ROOT}/five.md`]: FIVE
  }
  const read = (h: Harness, params: Partial<KnowledgeToolParams>): Promise<Result> =>
    h.run('c1', { action: 'read', base: 'project', ...params } as KnowledgeToolParams)
  const lines = async (h: Harness, params: Partial<KnowledgeToolParams>): Promise<string[]> =>
    textOf(await read(h, params)).split('\n')

  it('KE-1 全文：表头点名条目与库（行数）、空行、原文逐行（frontmatter 一并给、没有行号）、空行、`(End of entry.)`', async () => {
    const h = makeTool({ files: FILES })
    const res = await read(h, { entry: '/auth/token.md' })
    expect(textOf(res).split('\n')).toEqual([
      `Entry /auth/token.md in ${IN_PROJECT} — 9 lines`,
      '',
      '---',
      'type: Memory',
      'title: Token refresh',
      'description: dt',
      '---',
      '',
      '## Steps',
      '',
      'refresh before expiry',
      '',
      '(End of entry.)'
    ])
    expect(res.isError).toBeFalsy()
    expect(res.details).toEqual({ action: 'read', path: 'auth/token.md' })
    expect(h.resolveBase).toHaveBeenCalledWith('project')
    expect(h.scan).toHaveBeenCalledWith(ROOT)
    // 读的是宿主的扫描缓存：不经 port、不派管理员、不写
    expectNothingHappened(h)
  })

  it('KE-1b 读到的是扫描缓存里的那一份（宿主给什么就是什么），即使 port 上的文件已经变了', async () => {
    const h = makeTool({ files: FILES })
    const CACHED = 'cached one\ncached two\n'
    h.scan.mockImplementationOnce(async () => ({
      files: [{ path: 'five.md', text: CACHED }],
      concepts: [],
      notes: [readKnowledgeNote(CACHED, 'five.md')]
    }))
    expect(await lines(h, { entry: 'five.md' })).toEqual([
      `Entry /five.md in ${IN_PROJECT} — 2 lines`,
      '',
      'cached one',
      'cached two',
      '',
      '(End of entry.)'
    ])
    expect(h.readFile).not.toHaveBeenCalled()
  })

  it.each([
    ['前导 /', '/auth/token.md'],
    ['库相对', 'auth/token.md'],
    ['省掉 .md', 'auth/token'],
    ['前导 / 且省掉 .md', '/auth/token'],
    ['./ 前缀', './auth/token.md'],
    ['首尾空白', '  /auth/token.md  '],
    ['重复分隔符', '//auth//token.md'],
    ['反斜杠', 'auth\\token.md'],
    ['库内绝对路径（旧对话里留下的）', `${ROOT}/auth/token.md`],
    ['库内绝对路径、反斜杠', '\\kb\\projects\\acme\\auth\\token.md'],
    ['库内绝对路径、省掉 .md', `${ROOT}/auth/token`]
  ])('KE-2 名字的写法：%s（%s）→ 同一条 /auth/token.md', async (_label, entry) => {
    const h = makeTool({ files: FILES })
    const res = await read(h, { entry })
    expect(res.isError, textOf(res)).toBeFalsy()
    expect(textOf(res).split('\n')[0]).toBe(`Entry /auth/token.md in ${IN_PROJECT} — 9 lines`)
    expect(res.details).toEqual({ action: 'read', path: 'auth/token.md' })
  })

  it('KE-2b Windows 库目录：库内的绝对路径（正反斜杠都认）落回条目名', async () => {
    const DIR = 'C:\\kb\\notes'
    const h = makeTool({
      bundle: { dir: DIR, label: 'knowledge base "notes"' },
      files: { [`${DIR}/a.md`]: ENTRY }
    })
    // 盘符不分大小写（`c:/` 与 `C:\` 是同一处）
    for (const entry of [
      'C:\\kb\\notes\\a.md',
      'C:/kb/notes/a.md',
      'c:/kb/notes/a.md',
      'c:\\kb\\notes\\a.md',
      'a.md',
      '/a'
    ]) {
      const res = await read(h, { base: 'notes', entry })
      expect(res.isError, `${entry}: ${textOf(res)}`).toBeFalsy()
      expect(textOf(res).split('\n')[0], entry).toBe(
        'Entry /a.md in base "notes" (knowledge base "notes") — 9 lines'
      )
    }
  })

  it('KE-3 分页：offset / limit 按行；没读完说下一页从哪开始，读到底说 end of entry；越过末尾只说一共几行', async () => {
    const h = makeTool({ files: FILES })
    const head = `Entry /five.md in ${IN_PROJECT} — 5 lines`
    expect(await lines(h, { entry: 'five.md', offset: 2, limit: 2 })).toEqual([
      head,
      '',
      'l2',
      'l3',
      '',
      '(Showing lines 2-3 of 5. Use offset=4 to continue.)'
    ])
    expect(await lines(h, { entry: 'five.md', limit: 2 })).toEqual([
      head,
      '',
      'l1',
      'l2',
      '',
      '(Showing lines 1-2 of 5. Use offset=3 to continue.)'
    ])
    expect(await lines(h, { entry: 'five.md', offset: 4 })).toEqual([
      head,
      '',
      'l4',
      'l5',
      '',
      '(Lines 4-5, end of entry.)'
    ])
    expect(await lines(h, { entry: 'five.md', offset: 5, limit: 1 })).toEqual([
      head,
      '',
      'l5',
      '',
      '(Lines 5-5, end of entry.)'
    ])
    expect(await lines(h, { entry: 'five.md', offset: 6 })).toEqual([
      head,
      '',
      '',
      '(The entry has 5 lines.)'
    ])
  })

  it('KE-3b offset 非正数 / NaN 从第 1 行起、小数截断；limit 非正数 / NaN / Infinity 回落缺省（2000 行）、小数截断', async () => {
    const h = makeTool({ files: FILES })
    const whole = await lines(h, { entry: 'five.md' })
    expect(whole.at(-1)).toBe('(End of entry.)')
    expect(whole.slice(2, 7)).toEqual(['l1', 'l2', 'l3', 'l4', 'l5'])
    for (const offset of [0, -3, Number.NaN, 0.5]) {
      expect(await lines(h, { entry: 'five.md', offset }), String(offset)).toEqual(whole)
    }
    for (const limit of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 0.5]) {
      expect(await lines(h, { entry: 'five.md', limit }), String(limit)).toEqual(whole)
    }
    expect((await lines(h, { entry: 'five.md', offset: 2.9 })).slice(2)).toEqual([
      'l2',
      'l3',
      'l4',
      'l5',
      '',
      '(Lines 2-5, end of entry.)'
    ])
    expect((await lines(h, { entry: 'five.md', limit: 2.7 })).at(-1)).toBe(
      '(Showing lines 1-2 of 5. Use offset=3 to continue.)'
    )
  })

  it('KE-4 字节上限 50KB（与文件 read 同一套口径）：先到的那一个截断；超长单行截到 2000 字符', async () => {
    const wide = 'x'.repeat(2000)
    const BIG = `${Array.from({ length: 30 }, () => wide).join('\n')}\n`
    const LONG = `short\n${'y'.repeat(2500)}\n`
    const h = makeTool({ files: { [`${ROOT}/big.md`]: BIG, [`${ROOT}/long.md`]: LONG } })

    // 每行 2001 字节（含换行）：25 行 = 50025 ≤ 51200，第 26 行就超了
    const capped = await lines(h, { entry: 'big.md' })
    expect(capped[0]).toBe(`Entry /big.md in ${IN_PROJECT} — 30 lines`)
    expect(capped.slice(2, -2)).toHaveLength(25)
    expect(capped.at(-1)).toBe(
      '(Output capped at 50.0KB. Showing lines 1-25. Use offset=26 to continue.)'
    )
    const rest = await lines(h, { entry: 'big.md', offset: 26 })
    expect(rest.slice(2, -2)).toHaveLength(5)
    expect(rest.at(-1)).toBe('(Lines 26-30, end of entry.)')
    // 行数上限先到：照常说「还有」
    expect((await lines(h, { entry: 'big.md', limit: 3 })).at(-1)).toBe(
      '(Showing lines 1-3 of 30. Use offset=4 to continue.)'
    )

    expect(await lines(h, { entry: 'long.md' })).toEqual([
      `Entry /long.md in ${IN_PROJECT} — 2 lines`,
      '',
      'short',
      `${'y'.repeat(2000)}... (line truncated to 2000 chars)`,
      '',
      '(End of entry.)'
    ])
  })

  it('KE-5 行的切法：CRLF 不留 `\\r`；末尾换行不多算一行，没有末尾换行也一样；多出来的空行照算', async () => {
    const h = makeTool({
      files: {
        [`${ROOT}/crlf.md`]: '---\r\ntype: Memory\r\ntitle: C\r\n---\r\n\r\nbody\r\n',
        [`${ROOT}/bare.md`]: 'a\nb',
        [`${ROOT}/tail.md`]: 'a\nb\n\n'
      }
    })
    const crlf = await lines(h, { entry: 'crlf.md' })
    expect(crlf).toEqual([
      `Entry /crlf.md in ${IN_PROJECT} — 6 lines`,
      '',
      '---',
      'type: Memory',
      'title: C',
      '---',
      '',
      'body',
      '',
      '(End of entry.)'
    ])
    expect(crlf.join('\n')).not.toContain('\r')
    expect((await lines(h, { entry: 'bare.md' }))[0]).toBe(
      `Entry /bare.md in ${IN_PROJECT} — 2 lines`
    )
    expect(await lines(h, { entry: 'tail.md' })).toEqual([
      `Entry /tail.md in ${IN_PROJECT} — 3 lines`,
      '',
      'a',
      'b',
      '',
      '',
      '(End of entry.)'
    ])
  })

  it('KE-6 缺参：先 base 后 entry；entry 不传 / 空串 / 全空白都算缺；都不解析、不扫描', async () => {
    const h = makeTool({ files: FILES })
    const NEEDS_ENTRY = '"read" needs `entry` — an entry\'s path inside the base'
    expect(await rejectionOf(h.run('c1', { action: 'read' }))).toBe(
      '"read" needs `base` — one of the names "bases" lists for this session'
    )
    for (const entry of [undefined, '', '   ']) {
      expect(await rejectionOf(read(h, { entry })), JSON.stringify(entry)).toBe(NEEDS_ENTRY)
    }
    expect(h.resolveBase).not.toHaveBeenCalled()
    expect(h.scan).not.toHaveBeenCalled()
  })

  it.each([
    ['不在册', 'missing.md', '/missing.md'],
    ['不在册、没有 .md', 'missing', '/missing'],
    ['扩展名大小写对不上（只认扫描清单）', 'FIVE.MD', '/FIVE.MD'],
    ['不是 md', 'notes.txt', '/notes.txt'],
    // 宿主扫描不看隐藏路径：磁盘上有这个文件也一样
    ['隐藏目录', '.obsidian/x.md', '/.obsidian/x.md'],
    ['隐藏文件', 'auth/.draft.md', '/auth/.draft.md'],
    // 生成形状的 index 不是笔记
    ['生成的 index', 'index.md', '/index.md'],
    // 前缀相同的兄弟目录：不是这个库里的绝对路径，当库相对的名字处理
    ['前缀相同的兄弟目录', '/kb/projects/acme-old/a.md', '/kb/projects/acme-old/a.md']
  ])('KE-7 %s（%s）→ 「No entry … in base」，指回 search / list', async (_label, entry, name) => {
    const h = makeTool({
      files: {
        ...FILES,
        [`${ROOT}/notes.txt`]: 'not md',
        [`${ROOT}/.obsidian/x.md`]: ENTRY,
        [`${ROOT}/auth/.draft.md`]: ENTRY,
        [`${ROOT}/index.md`]: '## Entries\n\n* [A](a.md)\n',
        '/kb/projects/acme-old/a.md': ENTRY
      }
    })
    expect(await rejectionOf(read(h, { entry }))).toBe(
      `No entry ${name} in base "project" — "search" or "list" it for the right name`
    )
    expectNothingHappened(h)
  })

  it.each([
    ['../ 越界', '../x.md'],
    ['中间带 ..', 'auth/../five.md'],
    ['库外再绕回来', `${ROOT}/../acme/five.md`],
    ['只有 /', '/'],
    ['库目录本身', ROOT],
    ['库目录带尾斜杠', `${ROOT}/`]
  ])('KE-8 %s（%s）不是条目名：拒绝，连扫描都不做', async (_label, entry) => {
    const h = makeTool({ files: FILES })
    expect(await rejectionOf(read(h, { entry }))).toBe(`"${entry}" is not an entry name`)
    expect(h.scan).not.toHaveBeenCalled()
    expectNothingHappened(h)
  })

  it('KE-9 符号链接、真实磁盘上的东西一概够不着：read 只认扫描清单，从不问 port（stat / readFile / readLink）', async () => {
    const h = makeTool({
      files: FILES,
      links: { [`${ROOT}/five.md`]: { target: '../../secret.md', resolved: '/kb/secret.md' } }
    })
    const res = await read(h, { entry: 'five.md' })
    expect(res.isError).toBeFalsy()
    expect(h.stat).not.toHaveBeenCalled()
    expect(h.readFile).not.toHaveBeenCalled()
  })
})

// ─── 1.6 submit —— 准入 ──────────────────────────────────────────────────────

describe('KS-1..KS-9 submit 的准入', () => {
  const FILES = { [`${ROOT}/a.md`]: ENTRY, [`${ROOT}/sub/b.md`]: ENTRY }
  const NEEDS_CONTENT = '"submit" needs `content` — what to record, in markdown'
  const NEEDS_BASE = '"submit" needs `base` — one of the names "bases" lists for this session'

  it('KS-1 管理员自己 submit：拒在一切之前（参数全缺也报这句），判据收的是这次调用的 scope', async () => {
    const isAdmin = vi.fn((_call: ToolCallScope | undefined) => true)
    const h = makeTool({ files: FILES, isAdmin })
    const MSG =
      'You are the librarian: record the submission yourself with the file tools, and answer with `next`.'

    expect(
      await rejectionOf(
        h.invoke(
          { action: 'submit', base: 'project', content: 'x', entry: 'a.md' },
          { callId: 'w1', conversationId: 7 }
        )
      )
    ).toBe(MSG)
    expect(await rejectionOf(h.run('w2', { action: 'submit' }))).toBe(MSG)

    expect(h.isAdmin).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 7 }))
    expect(h.resolveBase).not.toHaveBeenCalled()
    expect(h.scan).not.toHaveBeenCalled()
    expect(h.actor).not.toHaveBeenCalled()
    expectNothingHappened(h)
  })

  it('KS-2 缺 content（不传 / 空串 / 全空白）：先于 base 报（两样都缺报 content）；不解析', async () => {
    const h = makeTool({ files: FILES })
    expect(await rejectionOf(h.run('c1', { action: 'submit' }))).toBe(NEEDS_CONTENT)
    for (const content of [undefined, '', '  \n\t ']) {
      expect(
        await rejectionOf(h.run('c2', { action: 'submit', base: 'project', content })),
        JSON.stringify(content)
      ).toBe(NEEDS_CONTENT)
    }
    expect(await rejectionOf(h.run('c3', { action: 'submit', content: 'x', base: ' ' }))).toBe(
      NEEDS_BASE
    )
    expect(h.resolveBase).not.toHaveBeenCalled()
    expectNothingHappened(h)
  })

  it('KS-3 base 解析失败是硬错误：失败文字恰为宿主那句原文；不扫描、不派', async () => {
    const ERR = 'No knowledge base named "nope". Available: "project", "notes".'
    const h = makeTool({ bundle: { error: ERR }, files: FILES })
    expect(
      await rejectionOf(
        h.run('c1', { action: 'submit', base: 'nope', content: 'x', entry: 'a.md' })
      )
    ).toBe(ERR)
    expect(h.scan).not.toHaveBeenCalled()
    expectNothingHappened(h)
  })

  it('KS-4 只读库：在派管理员之前拒（点名库、指回 "bases"）；先于 entry 校验与「宿主不支持」', async () => {
    const DIR = '/kb/builtin/shuvix/en'
    const builtin: KnowledgeBundleTarget = {
      dir: DIR,
      label: 'ShuviX reference (read-only)',
      readonly: true
    }
    const READONLY = `"shuvix" is read-only — it is ShuviX's own reference, shipped with the app. Submit to one of the user's knowledge bases instead ("bases" lists them).`
    const h = makeTool({ bundle: builtin, files: { [`${DIR}/agent-md.md`]: ENTRY } })

    // 去空白后的名字既用来解析，也是话里点名的那一个
    expect(
      await rejectionOf(h.run('c1', { action: 'submit', base: '  shuvix ', content: 'x' }))
    ).toBe(READONLY)
    expect(h.resolveBase.mock.calls).toEqual([['shuvix']])
    // 越界 / 不在册的 entry 也报只读：entry 根本还没看
    for (const entry of ['../x.md', 'missing.md']) {
      expect(
        await rejectionOf(h.run('c2', { action: 'submit', base: 'shuvix', content: 'x', entry })),
        entry
      ).toBe(READONLY)
    }
    // 宿主不注入 admin 也一样先报只读
    const noAdmin = makeTool({ bundle: builtin, admin: null })
    expect(
      await rejectionOf(noAdmin.run('c3', { action: 'submit', base: 'shuvix', content: 'x' }))
    ).toBe(READONLY)

    expect(h.scan).not.toHaveBeenCalled()
    expectNothingHappened(h)
  })

  it('KS-5 宿主不注入 admin（扩展端）：报「不支持」，在 entry 校验之前 —— entry 在不在册、越不越界都一样', async () => {
    const h = makeTool({ files: FILES, admin: null })
    const MSG = 'Submitting to a knowledge base is not available on this host'
    for (const entry of [undefined, 'a.md', 'missing.md', '../x.md']) {
      expect(
        await rejectionOf(h.run('c1', { action: 'submit', base: 'project', content: 'x', entry })),
        String(entry)
      ).toBe(MSG)
    }
    expect(h.scan).not.toHaveBeenCalled()
    expect(h.calls).toEqual([])
    expect(h.afterWrite).not.toHaveBeenCalled()
  })

  it('KS-6 entry 校验与 read 同一套：不在册 → 「No entry …」，越界 → 「不是条目名」；都不派管理员、不取提交者', async () => {
    const h = makeTool({ files: FILES })
    const submit = (entry: string): Promise<Result> =>
      h.run('c1', { action: 'submit', base: 'project', content: 'x', entry })
    expect(await rejectionOf(submit('missing.md'))).toBe(
      'No entry /missing.md in base "project" — "search" or "list" it for the right name'
    )
    expect(await rejectionOf(submit('../x.md'))).toBe('"../x.md" is not an entry name')
    expect(await rejectionOf(submit(ROOT))).toBe(`"${ROOT}" is not an entry name`)
    expect(h.actor).not.toHaveBeenCalled()
    expectNothingHappened(h)
  })

  it('KS-7 entry 全空白 = 没点名：照常派，请求里没有 entry 键；扫描只有派管理员之前记库的样子那一次', async () => {
    const h = makeTool({ files: FILES })
    const res = await h.run('c1', { action: 'submit', base: 'project', content: 'x', entry: '  ' })
    expect(res.isError, textOf(res)).toBeFalsy()
    expect(h.admin).toHaveBeenCalledTimes(1)
    expect(h.admin.mock.calls[0][0]).not.toHaveProperty('entry')
    expect(h.scan).toHaveBeenCalledTimes(1)
  })

  it('KS-8 不注入 isAdmin 时 submit 照常（缺省 = 不是管理员）', async () => {
    const h = makeTool({ files: FILES })
    const res = await h.run('p1', { action: 'submit', base: 'project', content: 'x' })
    expect(res.isError).toBeFalsy()
    expect(h.admin).toHaveBeenCalledTimes(1)
  })

  it('KS-9 准入顺序一览：管理员 → content → base → 解析 → 只读 → 宿主支持 → entry', async () => {
    // 每一步都让它后面那一步也是坏的：报出来的必须是前面那一个
    const builtin: KnowledgeBundleTarget = { dir: '/kb/b', label: 'ref', readonly: true }
    const order: [string, ToolOptions, KnowledgeToolParams, string][] = [
      [
        '管理员先于缺 content',
        { isAdmin: () => true },
        { action: 'submit' },
        'You are the librarian'
      ],
      ['content 先于 base', {}, { action: 'submit' }, 'needs `content`'],
      [
        'base 先于解析',
        { bundle: { error: 'E' } },
        { action: 'submit', content: 'x' },
        'needs `base`'
      ],
      [
        '解析先于只读',
        { bundle: { error: 'resolve failed' } },
        { action: 'submit', content: 'x', base: 'b' },
        'resolve failed'
      ],
      [
        '只读先于宿主支持',
        { bundle: builtin, admin: null },
        { action: 'submit', content: 'x', base: 'b', entry: '../x' },
        'is read-only'
      ],
      [
        '宿主支持先于 entry',
        { admin: null },
        { action: 'submit', content: 'x', base: 'b', entry: '../x' },
        'not available on this host'
      ]
    ]
    for (const [label, opts, params, expected] of order) {
      const h = makeTool(opts)
      expect(await rejectionOf(h.run('c1', params)), label).toContain(expected)
      expect(h.admin, label).not.toHaveBeenCalled()
    }
  })
})

// ─── 1.7 submit —— 交给管理员的请求 ───────────────────────────────────────────

describe('KS-10..KS-14 交给管理员的请求', () => {
  it('KS-10 请求体恰为 {base, label, bundleDir, content, submittedBy}（没点名 entry 就没有这个键）；content 去首尾空白；第二参带这次调用的 scope 与 toolCallId', async () => {
    const DIR = '/u/读书笔记'
    const h = makeTool({ bundle: { dir: DIR, label: 'knowledge base "读书笔记"' } })
    await h.invoke(
      {
        action: 'submit',
        base: '  读书笔记 ',
        content: '\n  ## Token refresh\n\nrefresh early.  \n'
      },
      { callId: 'k10', taskId: 5, conversationId: 3 }
    )
    expect(h.resolveBase).toHaveBeenCalledWith('读书笔记')
    expect(h.admin).toHaveBeenCalledTimes(1)
    const [req, ctx] = h.admin.mock.calls[0]
    expect(req).toStrictEqual({
      base: '读书笔记',
      label: 'knowledge base "读书笔记"',
      bundleDir: DIR,
      content: '## Token refresh\n\nrefresh early.',
      submittedBy: ACTOR
    })
    expect(ctx).toEqual({
      call: expect.objectContaining({ callId: 'k10', taskId: 5, conversationId: 3 }),
      toolCallId: 'k10',
      signal: undefined
    })
  })

  it.each([
    ['/sub/b.md'],
    ['sub/b.md'],
    ['sub/b'],
    ['  /sub/b  '],
    ['sub\\b.md'],
    [`${ROOT}/sub/b.md`]
  ])(
    'KS-11 点名的 entry（%s）归一成库内相对路径、不带前导 / ：entry = "sub/b.md"',
    async (entry) => {
      const h = makeTool({ files: { [`${ROOT}/sub/b.md`]: ENTRY } })
      await h.run('c1', { action: 'submit', base: 'project', content: 'fix', entry })
      expect(h.admin.mock.calls[0][0]).toStrictEqual({
        base: 'project',
        label: 'project "Acme"',
        bundleDir: ROOT,
        content: 'fix',
        entry: 'sub/b.md',
        submittedBy: ACTOR
      })
      expect(h.scan).toHaveBeenCalledWith(ROOT)
    }
  )

  it('KS-12 提交者按调用现取：同一工具两次 submit、两个对话 → 请求与章里的 generated.by 各是各的', async () => {
    const actor = (call: ToolCallScope | undefined): string =>
      call?.conversationId === 1 ? 'shuvix-work/a' : 'shuvix-explore/b'
    const h = makeTool({
      actor,
      admin: async (req, ctx, files) => librarian({ [req.content]: ENTRY })(req, ctx, files)
    })
    await h.invoke({ action: 'submit', base: 'project', content: 'a.md' }, { conversationId: 1 })
    await h.invoke({ action: 'submit', base: 'project', content: 'b.md' }, { conversationId: 2 })

    expect(h.admin.mock.calls.map(([req]) => req.submittedBy)).toEqual([
      'shuvix-work/a',
      'shuvix-explore/b'
    ])
    expect(h.files.get(`${ROOT}/a.md`)).toContain(`generated: { by: "shuvix-work/a", at:`)
    expect(h.files.get(`${ROOT}/b.md`)).toContain(`generated: { by: "shuvix-explore/b", at:`)
    expect(h.actor.mock.calls.map(([call]) => call?.conversationId)).toEqual([1, 2])
  })

  it('KS-13 管理员收到这次调用的取消信号（按中止态联动判，不比对象同一性）', async () => {
    const h = makeTool()
    const controller = new AbortController()
    await h.run('c1', { action: 'submit', base: 'project', content: 'x' }, controller.signal)
    const seen = h.admin.mock.calls[0][1].signal
    expect(seen).toBeDefined()
    expect(seen!.aborted).toBe(false)
    controller.abort()
    expect(seen!.aborted).toBe(true)
  })

  it('KS-14 管理员同步跑完才回：一次 submit 恰派一次；请求里的库目录只经这里交给管理员', async () => {
    const h = makeTool({ admin: librarian({ 'x.md': ENTRY }) })
    const res = await h.run('c1', { action: 'submit', base: 'project', content: 'x' })
    expect(h.admin).toHaveBeenCalledTimes(1)
    expect(h.admin.mock.calls[0][0].bundleDir).toBe(ROOT)
    // 回包时管理员已经写完、宿主已经盖完
    expect(textOf(res).split('\n')[1]).toBe('- /x.md (created)')
    expect(h.files.get(`${ROOT}/x.md`)).toContain(VERIFIED_LINE)
  })
})

// ─── 1.8 submit —— 管理员结论的分支 ───────────────────────────────────────────

describe('KS-20..KS-27 管理员结论的分支', () => {
  const submit = (h: Harness, params: Partial<KnowledgeToolParams> = {}): Promise<Result> =>
    h.run('c1', { action: 'submit', base: 'project', content: 'x', ...params })

  it('KS-20 管理员没跑成（error）→ 失败带原因；不盖章、不回调、没取时间', async () => {
    const h = makeTool({
      files: { [`${ROOT}/a.md`]: ENTRY },
      admin: async () => ({ error: 'it finished without an answer' })
    })
    expect(await rejectionOf(submit(h))).toBe(
      'The knowledge librarian could not take the submission: it finished without an answer'
    )
    expect(h.files.get(`${ROOT}/a.md`)).toBe(ENTRY)
    expect(h.calls).toEqual(['admin:project'])
    expect(h.afterWrite).not.toHaveBeenCalled()
    expect(h.now).not.toHaveBeenCalled()
  })

  it('KS-20b 没跑成的原因里带着库目录 → 同报告一样换成条目名的写法，提交者看不到目录', async () => {
    const h = makeTool({ admin: async () => ({ error: `could not write ${ROOT}/a.md` }) })
    const failure = await rejectionOf(submit(h))
    expect(failure).toBe(
      'The knowledge librarian could not take the submission: could not write /a.md'
    )
    expect(failure).not.toContain(ROOT)
  })

  it('KS-21 admin 自己抛错（宿主那一侧失败）→ 失败带那句消息；不盖章', async () => {
    const h = makeTool({
      files: { [`${ROOT}/a.md`]: ENTRY },
      admin: async () => {
        throw new Error('invalid result contract: result schema must declare top-level `type`')
      }
    })
    expect(await rejectionOf(submit(h))).toContain('invalid result contract')
    expect(h.files.get(`${ROOT}/a.md`)).toBe(ENTRY)
    expect(h.afterWrite).not.toHaveBeenCalled()
    expect(h.now).not.toHaveBeenCalled()
  })

  it('KS-20b 没跑成的原因里带着库目录 → 同报告一样换成条目名的写法，提交者看不到目录', async () => {
    const h = makeTool({ admin: async () => ({ error: `could not write ${ROOT}/a.md` }) })
    const failure = await rejectionOf(submit(h))
    expect(failure).toBe(
      'The knowledge librarian could not take the submission: could not write /a.md'
    )
    expect(failure).not.toContain(ROOT)
  })

  it('KS-22 不收是正常结论（不是失败）：「Not recorded in base …」+ 空行 + 报告原文；不盖章、不回调 —— 哪怕它报了动过的条目', async () => {
    const report = 'Already recorded in /auth/token.md.\nNothing new.'
    const h = makeTool({
      files: { [`${ROOT}/a.md`]: ENTRY },
      admin: async () => ({
        accepted: false,
        entries: [{ entry: 'a.md', change: 'updated' }],
        report,
        admin: ADMIN
      })
    })
    const res = await submit(h)
    expect(res.isError).toBeFalsy()
    expect(textOf(res).split('\n')).toEqual([
      'Not recorded in base "project".',
      '',
      'Already recorded in /auth/token.md.',
      'Nothing new.'
    ])
    expect(res.details).toEqual({ action: 'submit' })
    expect(h.files.get(`${ROOT}/a.md`)).toBe(ENTRY)
    expect(h.calls).toEqual(['admin:project'])
    expect(h.afterWrite).not.toHaveBeenCalled()
    expect(h.now).not.toHaveBeenCalled()
  })

  it('KS-20b 没跑成的原因里带着库目录 → 同报告一样换成条目名的写法，提交者看不到目录', async () => {
    const h = makeTool({ admin: async () => ({ error: `could not write ${ROOT}/a.md` }) })
    const failure = await rejectionOf(submit(h))
    expect(failure).toBe(
      'The knowledge librarian could not take the submission: could not write /a.md'
    )
    expect(failure).not.toContain(ROOT)
  })

  it('KS-23 报告为空 → 正文那一行是 `(no report)`（收与不收都一样）', async () => {
    const declined = makeTool({
      admin: async () => ({ accepted: false, entries: [], report: '', admin: ADMIN })
    })
    expect(textOf(await submit(declined)).split('\n')).toEqual([
      'Not recorded in base "project".',
      '',
      '(no report)'
    ])

    const taken = makeTool({ admin: librarian({ 'x.md': ENTRY }, '') })
    expect(textOf(await submit(taken)).split('\n')).toEqual([
      'Recorded in base "project":',
      '- /x.md (created)',
      '',
      '(no report)'
    ])
  })

  it('KS-24 收了却一条没动：「Recorded in base ….」（句号，没有条目行）+ 报告；details 不带 path', async () => {
    const h = makeTool({
      admin: reports([], 'Merged into the existing wording; no change needed.')
    })
    const res = await submit(h)
    expect(textOf(res).split('\n')).toEqual([
      'Recorded in base "project".',
      '',
      'Merged into the existing wording; no change needed.'
    ])
    expect(res.details).toEqual({ action: 'submit' })
    expect(h.calls).toEqual(['admin:project'])
  })

  it('KS-25 报告里的库目录换成条目名的写法（`<dir>/x.md` → `/x.md`，光目录 → `/`）；不收的报告也一样', async () => {
    const h = makeTool({
      admin: librarian(
        { 'auth/x.md': ENTRY },
        (req) => `Wrote ${req.bundleDir}/auth/x.md.\nThe base lives at ${req.bundleDir}.`
      )
    })
    expect(
      textOf(await submit(h))
        .split('\n')
        .slice(-2)
    ).toEqual(['Wrote /auth/x.md.', 'The base lives at /.'])

    const declined = makeTool({
      admin: async (req) => ({
        accepted: false,
        entries: [],
        report: `See ${req.bundleDir}/a.md`,
        admin: ADMIN
      })
    })
    expect(textOf(await submit(declined)).split('\n')[2]).toBe('See /a.md')
  })

  it('KS-25b Windows 库目录：反斜杠与正斜杠两种写法、尾随分隔符都换掉', async () => {
    const DIR = 'C:\\kb\\notes\\'
    const h = makeTool({
      bundle: { dir: DIR, label: 'knowledge base "notes"' },
      admin: async () => ({
        accepted: false,
        entries: [],
        report: 'Saw C:\\kb\\notes\\a.md and C:/kb/notes/sub/b.md under C:\\kb\\notes',
        admin: ADMIN
      })
    })
    const text = textOf(await submit(h, { base: 'notes' }))
    expect(text.split('\n')[2]).toBe('Saw /a.md and /sub/b.md under /')
    expect(text).not.toContain('kb')
  })

  it('KS-26 中止：已中止的 signal → reject 注入的 abortError、管理员不派；管理员跑的时候中止 → 迟到的「收了」不算数，不盖章', async () => {
    const aborted = new AbortController()
    aborted.abort()
    const h1 = makeTool({ abortError: 'TOOL_ABORTED' })
    await expect(
      h1.run('c1', { action: 'submit', base: 'project', content: 'x' }, aborted.signal)
    ).rejects.toThrow('TOOL_ABORTED')
    expect(h1.admin).not.toHaveBeenCalled()

    const during = new AbortController()
    const h2 = makeTool({
      abortError: 'TOOL_ABORTED',
      admin: async (req, ctx, files) => {
        const out = await librarian({ 'x.md': ENTRY })(req, ctx, files)
        during.abort()
        return out
      }
    })
    await expect(
      h2.run('c2', { action: 'submit', base: 'project', content: 'x' }, during.signal)
    ).rejects.toThrow('TOOL_ABORTED')
    // 管理员已经写下的东西留着（宿主不回滚），只是不盖章
    expect(h2.files.get(`${ROOT}/x.md`)).toBe(ENTRY)
    expect(h2.calls).toEqual(['admin:project'])
    expect(h2.afterWrite).not.toHaveBeenCalled()
    expect(h2.now).not.toHaveBeenCalled()
  })

  it('KS-27 没有注入 abortError 时中止 reject 的是缺省的 "Aborted"', async () => {
    const aborted = new AbortController()
    aborted.abort()
    const h = makeTool()
    await expect(
      h.run('c1', { action: 'submit', base: 'project', content: 'x' }, aborted.signal)
    ).rejects.toThrow('Aborted')
  })
})

// ─── 1.9 submit —— 收了之后的盖章 ────────────────────────────────────────────

describe('KS-30..KS-46 收录之后宿主盖章', () => {
  /** 管理员写的版本：写钩子把 generated 盖成了管理员自己 */
  const ADMIN_AT = '2026-11-08T07:59:00.000Z'
  const X = doc([
    'shuvix: okf v0.2',
    'type: Memory',
    'title: X',
    'description: dx',
    'status: stable',
    `generated: { by: "${ADMIN}", at: "${ADMIN_AT}" }`
  ])
  const X_STAMPED = doc([
    'shuvix: okf v0.2',
    'type: Memory',
    'title: X',
    'description: dx',
    'status: stable',
    GENERATED_LINE,
    VERIFIED_LINE
  ])
  const submit = (h: Harness): Promise<Result> =>
    h.run('c1', { action: 'submit', base: 'project', content: 'x' })

  it('KS-30 created → 盖章：generated 改回提交者、verified 记管理员，同一时刻（now 只取一次）；回读是机器确认且仍当前', async () => {
    const h = makeTool({ admin: librarian({ 'auth/x.md': X }) })
    const res = await submit(h)
    expect(textOf(res).split('\n')).toEqual([
      'Recorded in base "project":',
      '- /auth/x.md (created)',
      '',
      'ok'
    ])
    expect(res.details).toEqual({ action: 'submit', path: 'auth/x.md' })
    expect(h.files.get(`${ROOT}/auth/x.md`)).toBe(X_STAMPED)
    expect(h.now).toHaveBeenCalledTimes(1)
    const concept = parseConceptText(h.files.get(`${ROOT}/auth/x.md`)!, 'auth/x.md')!
    expect(concept.generated).toEqual({ by: ACTOR, at: NOW_ISO })
    expect(isVerificationCurrent(concept)).toBe(true)
    expect(currentTrustTierOf(concept)).toBe('machine-confirmed')
  })

  it('KS-31 updated → 同样盖章；点名的那一条被改写', async () => {
    const h = makeTool({ files: { [`${ROOT}/a.md`]: ENTRY }, admin: librarian({ 'a.md': X }) })
    const res = await h.run('c1', {
      action: 'submit',
      base: 'project',
      content: 'correction',
      entry: '/a.md'
    })
    expect(textOf(res).split('\n')[1]).toBe('- /a.md (updated)')
    expect(h.files.get(`${ROOT}/a.md`)).toBe(X_STAMPED)
  })

  it('KS-32 deleted 不盖、不查、不标；改名 = 旧的 deleted + 新的 created，只有新的那一条盖章', async () => {
    const h = makeTool({
      files: { [`${ROOT}/old.md`]: ENTRY },
      admin: librarian({ 'old.md': null, 'new.md': X })
    })
    const res = await submit(h)
    expect(textOf(res).split('\n')).toEqual([
      'Recorded in base "project":',
      '- /old.md (deleted)',
      '- /new.md (created)',
      '',
      'ok'
    ])
    expect(res.details).toEqual({ action: 'submit', path: 'old.md' })
    expect(h.files.has(`${ROOT}/old.md`)).toBe(false)
    expect(h.files.get(`${ROOT}/new.md`)).toBe(X_STAMPED)
    expect(h.stat.mock.calls.map(([p]) => p)).toEqual([`${ROOT}/new.md`])
    expect(h.calls).toEqual(['admin:project', `write:${ROOT}/new.md`, `after:${ROOT}|new.md`])
  })

  it('KS-33 普通笔记（没有 frontmatter）照用户的写法留着：不盖章、不标、不回调', async () => {
    const h = makeTool({
      files: { [`${ROOT}/plain.md`]: PLAIN },
      admin: librarian({ 'plain.md': `${PLAIN}\nmore\n` })
    })
    const res = await submit(h)
    expect(textOf(res).split('\n')[1]).toBe('- /plain.md (updated)')
    expect(h.files.get(`${ROOT}/plain.md`)).toBe(`${PLAIN}\nmore\n`)
    expect(h.calls).toEqual(['admin:project'])
    expect(h.afterWrite).not.toHaveBeenCalled()
  })

  it('KS-34 不是 OKF 的 frontmatter（别家的标记、没有 type 的普通元数据）同样不动、不标', async () => {
    const AGENT_MD = doc(['shuvix: agent v1', 'type: Memory', 'name: x'])
    const META = doc(['title: just a title', 'tags: [a]'])
    const h = makeTool({ admin: librarian({ 'agent.md': AGENT_MD, 'meta.md': META }) })
    expect(
      textOf(await submit(h))
        .split('\n')
        .slice(1, 3)
    ).toEqual(['- /agent.md (created)', '- /meta.md (created)'])
    expect(h.files.get(`${ROOT}/agent.md`)).toBe(AGENT_MD)
    expect(h.files.get(`${ROOT}/meta.md`)).toBe(META)
    expect(h.calls).toEqual(['admin:project'])
  })

  /** 带 ShuviX 自述行、却过不了格式的条目：管理员写坏了 */
  const BROKEN: [string, string, string][] = [
    [
      '缺 type',
      doc(['shuvix: okf v0.2', 'title: A', 'description: da']),
      "'type' is required and must be a non-empty string"
    ],
    [
      'YAML 写坏',
      '---\nshuvix: okf v0.2\ntype: Memory\ntitle: [x\n---\n\nbody\n',
      'frontmatter is not parseable YAML, or is not a key/value mapping'
    ]
  ]

  it('KS-35a 带自述行却过不了格式的条目：不盖章、不回调（管理员的一句「收了」不能替校验作证）', async () => {
    for (const [label, text] of BROKEN) {
      const h = makeTool({ admin: librarian({ 'broken.md': text }) })
      const res = await submit(h)
      expect(res.isError, label).toBeFalsy()
      expect(h.files.get(`${ROOT}/broken.md`), label).toBe(text)
      expect(h.calls, label).toEqual(['admin:project'])
      expect(h.afterWrite, label).not.toHaveBeenCalled()
    }
  })

  // 回归：stampChanged 曾先按 isOkfConceptText 筛、筛下来的一律当普通笔记跳过 —— 可 validateKnowledgeText 的
  // error 只有「没有 frontmatter / YAML 写坏 / 缺 type」三种，都让 isOkfConceptText 为假，「not confirmed — …」
  // 那一支因此永远走不到。现在先校验、再判是不是 OKF 条目
  it('KS-35b 带自述行却过不了格式的条目在那一行标出来：`(created; not confirmed — <校验原文>)`', async () => {
    for (const [label, text, why] of BROKEN) {
      const h = makeTool({ admin: librarian({ 'broken.md': text }) })
      expect(textOf(await submit(h)).split('\n')[1], label).toBe(
        `- /broken.md (created; not confirmed — ${why})`
      )
    }
  })

  it('KS-36b 报上来的是保留名（index.md / log.md，带 OKF frontmatter 也一样）→ 标 `a reserved name, not an entry`；不盖章', async () => {
    const h = makeTool({
      files: { [`${ROOT}/index.md`]: ENTRY, [`${ROOT}/sub/log.md`]: ENTRY },
      admin: reports([
        { entry: 'index.md', change: 'updated' },
        { entry: 'sub/log.md', change: 'created' }
      ])
    })
    const lines = textOf(await submit(h)).split('\n')
    expect(lines.slice(1, 3)).toEqual([
      '- /index.md (updated; a reserved name, not an entry)',
      '- /sub/log.md (created; a reserved name, not an entry)'
    ])
    expect(h.files.get(`${ROOT}/index.md`)).toBe(ENTRY)
    expect(h.files.get(`${ROOT}/sub/log.md`)).toBe(ENTRY)
    expect(h.afterWrite).not.toHaveBeenCalled()
  })

  it('KS-36 报了却不在（管理员说建了、文件没有）→ 那一行标 `not found`；不写', async () => {
    const h = makeTool({ admin: reports([{ entry: 'ghost.md', change: 'created' }]) })
    const res = await submit(h)
    expect(res.isError).toBeFalsy()
    expect(textOf(res).split('\n')[1]).toBe('- /ghost.md (created; not found)')
    expect(h.calls).toEqual(['admin:project'])
    expect(h.afterWrite).not.toHaveBeenCalled()
  })

  it('KS-37 符号链接不跟（章会写进它通向的那头）→ 那一行标 `a symbolic link, not confirmed`；链接与它通向的文件都不动', async () => {
    const h = makeTool({
      files: { [`${ROOT}/link.md`]: ENTRY, '/kb/secret.md': ENTRY },
      links: { [`${ROOT}/link.md`]: { target: '../../secret.md', resolved: '/kb/secret.md' } },
      admin: reports([{ entry: 'link.md', change: 'updated' }])
    })
    expect(textOf(await submit(h)).split('\n')[1]).toBe(
      '- /link.md (updated; a symbolic link, not confirmed)'
    )
    expect(h.files.get(`${ROOT}/link.md`)).toBe(ENTRY)
    expect(h.files.get('/kb/secret.md')).toBe(ENTRY)
    expect(h.readFile).not.toHaveBeenCalled()
    expect(h.calls).toEqual(['admin:project'])
  })

  it('KS-38 报上来的不是条目名（越界、不是 .md、空）→ 那一行标 `not an entry name`；不问 port', async () => {
    const h = makeTool({
      files: { '/kb/projects/x.md': ENTRY },
      admin: reports([
        { entry: '../x.md', change: 'updated' },
        { entry: 'notes.txt', change: 'created' },
        { entry: '', change: 'created' }
      ])
    })
    expect(
      textOf(await submit(h))
        .split('\n')
        .slice(1, 4)
    ).toEqual([
      '- /../x.md (updated; not an entry name)',
      '- /notes.txt (created; not an entry name)',
      '- / (created; not an entry name)'
    ])
    expect(h.stat).not.toHaveBeenCalled()
    expect(h.files.get('/kb/projects/x.md')).toBe(ENTRY)
    expect(h.calls).toEqual(['admin:project'])
  })

  it('KS-39 旧章处置：人工章原样保留在前、旧机器章被替换，只剩一条机器章；回读是机器确认', async () => {
    const T0 = '2026-09-01T00:00:00.000Z'
    const text = doc([
      'shuvix: okf v0.2',
      'type: Memory',
      'title: A',
      'description: da',
      `verified: [{ by: "human:alice", at: "${T0}", note: "checked" }, { by: "shuvix-knowledge-writer/old", at: "${T0}" }]`
    ])
    const h = makeTool({ files: { [`${ROOT}/a.md`]: text }, admin: librarian({ 'a.md': text }) })
    await submit(h)
    const concept = parseConceptText(h.files.get(`${ROOT}/a.md`)!, 'a.md')!
    expect(concept.verified).toEqual([
      { by: 'human:alice', at: T0 },
      { by: ADMIN, at: NOW_ISO }
    ])
    // 人工章连同多出来的键原样写回（宿主不替人改写他的记录）
    expect(h.files.get(`${ROOT}/a.md`)).toContain(
      `verified: [{"by":"human:alice","at":"${T0}","note":"checked"}, { by: "${ADMIN}", at: "${NOW_ISO}" }]`
    )
    expect(currentTrustTierOf(concept)).toBe('machine-confirmed')
  })

  it('KS-40 只有 warning（缺 description）不挡章：照常盖、不标', async () => {
    const text = doc(['shuvix: okf v0.2', 'type: Memory', 'title: A'])
    const h = makeTool({ admin: librarian({ 'a.md': text }) })
    expect(textOf(await submit(h)).split('\n')[1]).toBe('- /a.md (created)')
    expect(h.files.get(`${ROOT}/a.md`)).toContain(VERIFIED_LINE)
  })

  it('KS-41 afterWrite：每盖一条恰一次，参数只有 {bundleDir, path}（库内相对）与这次调用的 scope，排在那一笔落盘之后', async () => {
    const h = makeTool({ admin: librarian({ 'a.md': X, 'sub/b.md': X }) })
    await h.invoke(
      { action: 'submit', base: 'project', content: 'x' },
      { callId: 'k41', taskId: 4, conversationId: 2 }
    )
    expect(h.afterWrite).toHaveBeenCalledTimes(2)
    expect(h.afterWrite).toHaveBeenNthCalledWith(
      1,
      { bundleDir: ROOT, path: 'a.md' },
      expect.objectContaining({ conversationId: 2, taskId: 4 })
    )
    expect(h.afterWrite).toHaveBeenNthCalledWith(
      2,
      { bundleDir: ROOT, path: 'sub/b.md' },
      expect.objectContaining({ conversationId: 2, taskId: 4 })
    )
    expect(Object.keys(h.afterWrite.mock.calls[0][0]).sort()).toEqual(['bundleDir', 'path'])
    expect(h.calls).toEqual([
      'admin:project',
      `write:${ROOT}/a.md`,
      `after:${ROOT}|a.md`,
      `write:${ROOT}/sub/b.md`,
      `after:${ROOT}|sub/b.md`
    ])
  })

  it('KS-42 没改就不写、不回调：同一时刻连交两次、第二次章已在位 —— 只写一次、回调一次，两次都回 Recorded', async () => {
    const h = makeTool({
      files: { [`${ROOT}/a.md`]: ENTRY },
      admin: reports([{ entry: 'a.md', change: 'updated' }])
    })
    await submit(h)
    const second = await submit(h)
    expect(textOf(second).split('\n').slice(0, 2)).toEqual([
      'Recorded in base "project":',
      '- /a.md (updated)'
    ])
    expect(h.calls.filter((c) => c === `write:${ROOT}/a.md`)).toHaveLength(1)
    expect(h.afterWrite).toHaveBeenCalledTimes(1)
    expect(h.admin).toHaveBeenCalledTimes(2)
  })

  it('KS-43 正文字节不动：正文里的 `---` 分隔线、`verified: fake` 原样；CRLF 文件里新插入的行也带 `\\r`', async () => {
    const head = ['---', 'shuvix: okf v0.2', 'type: Memory', 'title: A', 'description: da', '---']
    const body = ['', 'intro', '', '---', '', 'verified: fake', 'generated: nope', ''].join('\r\n')
    const text = `${head.join('\r\n')}\r\n${body}`
    const h = makeTool({
      files: { [`${ROOT}/a.md`]: text },
      admin: reports([{ entry: 'a.md', change: 'updated' }])
    })
    await submit(h)
    const after = h.files.get(`${ROOT}/a.md`)!
    // 第一处 `\r\n---\r\n` 就是闭合定界线（开栏那一行前面没有 `\r\n`）
    const tail = (s: string): string => s.slice(s.indexOf('\r\n---\r\n'))
    expect(tail(after)).toBe(tail(text))
    expect(after).toContain(`\r\n${GENERATED_LINE}\r\n${VERIFIED_LINE}\r\n---\r\n`)
  })

  it('KS-44 一次报多条、结果各异：行序同管理员报的顺序，各自的记号只落在自己那一行；只有合规的那条盖章', async () => {
    const h = makeTool({
      files: { [`${ROOT}/old.md`]: ENTRY, [`${ROOT}/plain.md`]: PLAIN },
      admin: async (req, ctx, files) => {
        const out = await librarian({ 'auth/x.md': X, 'old.md': null, 'plain.md': `${PLAIN}+\n` })(
          req,
          ctx,
          files
        )
        if ('error' in out) return out
        return { ...out, entries: [...out.entries, { entry: 'ghost.md', change: 'created' }] }
      }
    })
    const res = await submit(h)
    expect(textOf(res).split('\n')).toEqual([
      'Recorded in base "project":',
      '- /auth/x.md (created)',
      '- /old.md (deleted)',
      '- /plain.md (updated)',
      '- /ghost.md (created; not found)',
      '',
      'ok'
    ])
    expect(res.details).toEqual({ action: 'submit', path: 'auth/x.md' })
    expect(h.calls).toEqual(['admin:project', `write:${ROOT}/auth/x.md`, `after:${ROOT}|auth/x.md`])
  })

  it('KS-45 报上来的条目名带前导 /（宿主没归一时）也照样找得到、盖得上', async () => {
    const h = makeTool({
      files: { [`${ROOT}/a.md`]: ENTRY },
      admin: reports([{ entry: '/a.md', change: 'updated' }])
    })
    expect(textOf(await submit(h)).split('\n')[1]).toBe('- /a.md (updated)')
    expect(h.files.get(`${ROOT}/a.md`)).toContain(VERIFIED_LINE)
    expect(h.afterWrite).toHaveBeenCalledWith({ bundleDir: ROOT, path: 'a.md' }, expect.anything())
  })

  it('KS-46 盖章用的是管理员交回的 actor（不是写死的档案名）', async () => {
    const h = makeTool({
      admin: async (req, ctx, files) => {
        const out = await librarian({ 'a.md': ENTRY })(req, ctx, files)
        return 'error' in out ? out : { ...out, admin: 'shuvix-my-librarian/opus' }
      }
    })
    await submit(h)
    expect(h.files.get(`${ROOT}/a.md`)).toContain(
      `verified: { by: "shuvix-my-librarian/opus", at: "${NOW_ISO}" }`
    )
  })
})

// ─── organize：请管理员把一个库整个过一遍（2026-11-12）──────────────────────────

describe('KO-1..KO-6 organize', () => {
  /** 人工核实过的一条：`generated` 早于 `verified`，核实仍当前 */
  const HUMAN = doc([
    'shuvix: okf v0.2',
    'type: Concept',
    'title: State machine',
    'description: ds',
    'status: stable',
    'generated: { by: "shuvix-work/gpt-5", at: "2026-10-12T03:10:00.000Z" }',
    'verified: { by: "human:alice", at: "2026-10-20T08:00:00.000Z" }'
  ])
  /** 管理员合并出来的一条：写钩子已经把 generated 盖成了它自己 */
  const MERGED = doc(
    [
      'shuvix: okf v0.2',
      'type: Decision',
      'title: Export paging',
      'description: de',
      'status: stable',
      `generated: { by: "${ADMIN}", at: "2026-11-08T07:59:00.000Z" }`
    ],
    'merged body'
  )
  const FILES = {
    [`${ROOT}/a.md`]: ENTRY,
    [`${ROOT}/b.md`]: doc(['shuvix: okf v0.2', 'type: Memory', 'title: B', 'status: stable']),
    [`${ROOT}/state.md`]: HUMAN,
    [`${ROOT}/note.md`]: PLAIN
  }

  it('KO-1 准入：管理员自己被拒；缺 base、base 解析失败、只读库、宿主不支持都是失败，一律不派', async () => {
    const admin = makeTool({ files: FILES, isAdmin: () => true })
    expect(await rejectionOf(admin.run('c1', { action: 'organize', base: 'project' }))).toBe(
      'You are the librarian: reorganize the base yourself with the file tools, and answer with `next`.'
    )
    expect(admin.admin).not.toHaveBeenCalled()

    const h = makeTool({ files: FILES })
    expect(await rejectionOf(h.run('c2', { action: 'organize' }))).toContain(
      '"organize" needs `base`'
    )
    expect(h.admin).not.toHaveBeenCalled()

    const missing = makeTool({ bundle: { error: 'No base "x" in this session.' } })
    expect(await rejectionOf(missing.run('c3', { action: 'organize', base: 'x' }))).toBe(
      'No base "x" in this session.'
    )

    const readonly = makeTool({ bundle: { dir: '/kb/b', label: 'ref', readonly: true } })
    expect(await rejectionOf(readonly.run('c4', { action: 'organize', base: 'shuvix' }))).toBe(
      '"shuvix" is read-only — it is ShuviX\'s own reference, shipped with the app. Only the user\'s knowledge bases can be reorganized ("bases" lists them).'
    )
    expect(readonly.admin).not.toHaveBeenCalled()

    const extension = makeTool({ files: FILES, admin: null })
    expect(await rejectionOf(extension.run('c5', { action: 'organize', base: 'project' }))).toBe(
      'Reorganizing a knowledge base is not available on this host'
    )
  })

  it('KO-2 空库：一句话，不派管理员', async () => {
    const h = makeTool()
    const res = await h.run('c1', { action: 'organize', base: 'project' })
    expect(res.isError).toBeFalsy()
    expect(textOf(res)).toBe('Base "project" has no entries yet — there is nothing to reorganize.')
    expect(h.admin).not.toHaveBeenCalled()
  })

  it('KO-3 派管理员：请求带 `organize: true`、库目录、发起者；content 是转述的要求（去首尾空白，没给就是空串）；没有 entry / migration', async () => {
    const h = makeTool({ files: FILES })
    await h.run('c1', {
      action: 'organize',
      base: ' project ',
      content: '  merge the auth notes \n'
    })
    expect(h.admin).toHaveBeenCalledTimes(1)
    expect(h.admin.mock.calls[0][0]).toEqual({
      base: 'project',
      label: 'project "Acme"',
      bundleDir: ROOT,
      content: 'merge the auth notes',
      submittedBy: ACTOR,
      organize: true
    })

    const bare = makeTool({ files: FILES })
    await bare.run('c2', { action: 'organize', base: 'project' })
    expect(bare.admin.mock.calls[0][0]).toMatchObject({ content: '', organize: true })
  })

  it('KO-4 回包：表头报整理前后的文件数、逐条改动、空行、报告；报告里漏出来的库目录换成条目名；一条没动另说一句', async () => {
    const h = makeTool({
      files: FILES,
      admin: librarian(
        { 'export/paging.md': MERGED, 'a.md': null, 'b.md': null },
        (req) => `Merged ${req.bundleDir}/a.md and b.md into ${req.bundleDir}/export/paging.md.`
      )
    })
    const res = await h.run('c1', { action: 'organize', base: 'project' })
    expect(res.isError, textOf(res)).toBeFalsy()
    expect(textOf(res).split('\n')).toEqual([
      'Reorganized base "project" — 4 file(s) before, 3 now:',
      '- /export/paging.md (created)',
      '- /a.md (deleted)',
      '- /b.md (deleted)',
      '',
      'Merged /a.md and b.md into /export/paging.md.'
    ])
    expect(textOf(res)).not.toContain(ROOT)

    const idle = makeTool({ files: FILES, admin: reports([], 'Already in order.') })
    const nothing = await idle.run('c2', { action: 'organize', base: 'project' })
    expect(textOf(nothing)).toBe('Nothing was changed in base "project".\n\nAlready in order.')
    expect(idle.calls).toEqual(['admin:project'])
  })

  it('KO-5 盖章：管理员改写的条目两个章都记管理员（合并出来的正文是它写的，不是发起整理的 agent）', async () => {
    const h = makeTool({ files: FILES, admin: librarian({ 'export/paging.md': MERGED }) })
    await h.run('c1', { action: 'organize', base: 'project' })
    const stamped = h.files.get(`${ROOT}/export/paging.md`)!
    expect(stamped).toContain(`generated: { by: "${ADMIN}", at: "${NOW_ISO}" }`)
    expect(stamped).toContain(VERIFIED_LINE)
    expect(stamped).not.toContain(ACTOR)
    expect(h.afterWrite).toHaveBeenCalledTimes(1)
  })

  it('KO-6 只挪了位置的条目（路径是新的、原文一字未改）不盖章：人工核实仍当前；用户的普通笔记挪了也不动。submit 里的改名同理', async () => {
    const moves: AdminImpl = async (req, _ctx, files) => {
      for (const [from, to] of [
        ['state.md', 'order/state.md'],
        ['note.md', 'misc/note.md']
      ]) {
        files.set(`${req.bundleDir}/${to}`, files.get(`${req.bundleDir}/${from}`)!)
        files.delete(`${req.bundleDir}/${from}`)
      }
      return {
        accepted: true,
        entries: [
          { entry: 'state.md', change: 'deleted' },
          { entry: 'order/state.md', change: 'created' },
          { entry: 'note.md', change: 'deleted' },
          { entry: 'misc/note.md', change: 'created' }
        ],
        report: 'moved',
        admin: ADMIN
      }
    }
    for (const params of [
      { action: 'organize', base: 'project' },
      { action: 'submit', base: 'project', content: 'x' }
    ] as KnowledgeToolParams[]) {
      const h = makeTool({ files: FILES, admin: moves })
      const res = await h.run('c1', params)
      expect(res.isError, textOf(res)).toBeFalsy()
      expect(textOf(res), params.action).toContain('- /order/state.md (created)')
      // 一个字节都没写：原文、章都还是挪之前的
      expect(h.files.get(`${ROOT}/order/state.md`), params.action).toBe(HUMAN)
      expect(h.files.get(`${ROOT}/misc/note.md`), params.action).toBe(PLAIN)
      expect(
        h.calls.filter((c) => c.startsWith('write:')),
        params.action
      ).toEqual([])
      expect(h.afterWrite, params.action).not.toHaveBeenCalled()
      const concept = parseConceptText(h.files.get(`${ROOT}/order/state.md`)!, 'order/state.md')!
      expect(isVerificationCurrent(concept)).toBe(true)
      expect(currentTrustTierOf(concept)).toBe('human-reviewed')
    }
  })
})

describe('KO-7 挤了的文件夹随请求交给管理员', () => {
  it('KO-7 submit / organize：库里有文件夹直接放着一打以上条目时请求带 `crowded`（数的是在册的笔记，用户的普通笔记也算）；没有就没有这个键', async () => {
    const crowdedFiles: Record<string, string> = { [`${ROOT}/note.md`]: PLAIN }
    for (let i = 0; i < 12; i++) crowdedFiles[`${ROOT}/e${i}.md`] = ENTRY
    for (let i = 0; i < 3; i++) crowdedFiles[`${ROOT}/pay/p${i}.md`] = ENTRY
    for (const params of [
      { action: 'submit', base: 'project', content: 'x' },
      { action: 'organize', base: 'project' }
    ] as KnowledgeToolParams[]) {
      const h = makeTool({ files: crowdedFiles })
      await h.run('c1', params)
      expect(h.admin.mock.calls[0][0].crowded, params.action).toEqual([{ folder: '', entries: 13 }])

      const roomy = makeTool({ files: { [`${ROOT}/a.md`]: ENTRY } })
      await roomy.run('c2', params)
      expect(roomy.admin.mock.calls[0][0], params.action).not.toHaveProperty('crowded')
    }
  })
})

describe('KT-2′ 中止', () => {
  it('KT-2′ 已中止的 signal → 任何动作都 reject 注入的 abortError', async () => {
    const h = makeTool({
      files: { [`${ROOT}/a.md`]: ENTRY },
      abortError: 'TOOL_ABORTED',
      bases: [{ base: 'project', label: 'project "Acme"', dir: ROOT }]
    })
    const ac = new AbortController()
    ac.abort()
    for (const params of [
      { action: 'bases' },
      { action: 'list', base: 'project' },
      { action: 'search', base: 'project', query: 'q' },
      { action: 'read', base: 'project', entry: 'a.md' },
      { action: 'submit', base: 'project', content: 'x' },
      { action: 'organize', base: 'project' }
    ] as KnowledgeToolParams[]) {
      await expect(h.run('c1', params, ac.signal), params.action).rejects.toThrow('TOOL_ABORTED')
    }
    expect(h.listBases).not.toHaveBeenCalled()
    expect(h.resolveBase).not.toHaveBeenCalled()
    expectNothingHappened(h)
  })
})
