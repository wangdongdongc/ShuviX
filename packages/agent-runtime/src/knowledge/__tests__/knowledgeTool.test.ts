/**
 * knowledge 工具 —— 检索 / 盘点 + 条目的**提交检查**（`submit`，2026-10-12 改版）。
 *
 * 条目正文一律走文件工具（主 agent 把一篇普通 md `write` 进库目录、用 `edit` 改），工具本身不落正文；
 * 早先担保元数据形状的 `create`、以及 `read` / `validate` 都已删除。`submit` 同步派内置写手补元数据、
 * 判内容，**通过了才由宿主盖章**（`generated` 记提交者、`verified` 记写手的机器确认，见 review.ts）。
 * 本文件钉：
 *
 *   KT-1′..KT-12′   agent 面的枚举与参数表、给模型的文案（「写进目录再 submit」「别写 verified」）
 *   KT-3..KT-33     读侧（search / list / bases）：照旧，只是列表与命中一律印**绝对路径**
 *   KT-40..KT-42    list / 兜底检索的信任档记号（status → 信任档 → generated 日期）
 *   KS-1..KS-9      submit 的准入：参数、只读库、写手自己提交、宿主不支持、路径解析（越界 / 保留名 /
 *                   隐藏路径 / 符号链接 / 盘符 / POSIX 绝对路径的歧义）—— 拒绝时门、写手、落盘一概没发生
 *   KS-10..KS-14    与文件工具同一道写门（先门后派）、交给写手的请求
 *   KS-20..KS-37    写手结论的各个分支：没跑成、不通过、判过却仍不合规、通过后盖章与回调、中止
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
import type { SecurityContext } from '../../security/types'
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
  type KnowledgeBaseInfo,
  type KnowledgeBundleTarget,
  type KnowledgeSearchHit,
  type KnowledgeToolDeps,
  type KnowledgeToolParams
} from '../knowledgeTool'
import type { KnowledgeReviewOutcome, KnowledgeReviewRequest } from '../review'
import { isProjectionFile, isReservedFile, type BundleFile } from '../validate'

/** 本会话的那一个 bundle（项目 bundle 的绝对目录） */
const ROOT = '/kb/projects/acme'
const NOW = new Date('2026-10-12T08:00:00.000Z')
const NOW_ISO = NOW.toISOString()
const ACTOR = 'shuvix-work/gpt-5'
const REVIEWER = 'shuvix-knowledge-writer/haiku'
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
/** 错误话术里点名库的那一截（whereLine） */
const WHERE = `project "Acme" — ${ROOT}`
/** 通过后的两个章 */
const GENERATED_LINE = `generated: { by: "${ACTOR}", at: "${NOW_ISO}" }`
const VERIFIED_LINE = `verified: { by: "${REVIEWER}", at: "${NOW_ISO}" }`

type ReviewCtx = Parameters<NonNullable<KnowledgeToolDeps['review']>>[1]
/** 写手替身：可以改 `files`（模拟写手 edit 了元数据）再交回结论 */
type ReviewImpl = (
  req: KnowledgeReviewRequest,
  ctx: ReviewCtx,
  files: Map<string, string>
) => Promise<KnowledgeReviewOutcome>

const PASS: ReviewImpl = async () => ({ passed: true, report: 'ok', reviewer: REVIEWER })

interface ToolOptions {
  /** 内存 port 的初始文件（绝对路径 → 内容） */
  files?: Record<string, string>
  /** bundle 解析结果（缺省即 BUNDLE）；给 `{error}` 模拟解析失败 */
  bundle?: KnowledgeBundleTarget | { error: string }
  /** `bases` 列举的库（缺省空表） */
  bases?: readonly KnowledgeBaseInfo[]
  search?: KnowledgeToolDeps['search']
  /** 不传 = 只记录调用的 enforcePath 桩 */
  security?: SecurityContext
  abortError?: string
  /** 写手替身（缺省 PASS）；`null` = 宿主不注入 review（扩展端） */
  review?: ReviewImpl | null
  isReviewer?: (call: ToolCallScope | undefined) => boolean
  actor?: (call: ToolCallScope | undefined) => string
  /** port 路径 → 它是符号链接时 readLink 的答复 */
  links?: Record<string, { target: string; resolved: string }>
}

type Result = InvokedToolResult

interface Harness {
  tool: ReturnType<typeof createKnowledgeTool>
  files: Map<string, string>
  enforcePath: Mock
  resolveBase: Mock
  listBases: Mock
  scan: Mock
  afterWrite: Mock
  review: Mock
  isReviewer?: Mock
  actor: Mock
  now: Mock
  stat: MockInstance<FileSystemPort['stat']>
  /** 调用顺序流水：`enforce:<mode>:<abs>` / `review:<abs>` / `write:<abs>` / `after:<bundleDir>|<rel>` */
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

/** 宿主扫描的替身：`bundleDir` 下的全部 md 原文 + 解析得出的笔记 / 概念 */
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
    all.push({ path: rel, text })
    // 宿主投影的 index / log 不是笔记；其余每个 md 都是（读宽），合规的另带 OKF 条目
    if (isProjectionFile(rel, text)) continue
    const note = readKnowledgeNote(text, rel, { entry: !isReservedFile(rel) })
    notes.push(note)
    if (note.concept) concepts.push(note.concept)
  }
  return { files: all, concepts, notes }
}

function makeTool(opts: ToolOptions = {}): Harness {
  const files = new Map(Object.entries(opts.files ?? {}))
  const calls: string[] = []
  const enforcePath = vi.fn(async (mode: string, abs: string) => {
    calls.push(`enforce:${mode}:${abs}`)
  })
  const security = opts.security ?? ({ enforcePath } as unknown as SecurityContext)
  const resolveBase = vi.fn(async (_base: string) => opts.bundle ?? BUNDLE)
  const listBases = vi.fn(async () => opts.bases ?? [])
  // 扫描跟着宿主解析出的目录走：resolveBase 给的是别的库时，清单也得是那个库的
  const scan = vi.fn((bundleDir: string) => Promise.resolve(scanOf(files, bundleDir)))
  const afterWrite = vi.fn((e: { bundleDir: string; path: string }) => {
    calls.push(`after:${e.bundleDir}|${e.path}`)
  })
  const impl = opts.review === undefined ? PASS : opts.review
  const review = vi.fn(async (req: KnowledgeReviewRequest, ctx: ReviewCtx) => {
    calls.push(`review:${req.path}`)
    return impl!(req, ctx, files)
  })
  const isReviewer = opts.isReviewer ? vi.fn(opts.isReviewer) : undefined
  const actor = vi.fn(opts.actor ?? ((_call: ToolCallScope | undefined) => ACTOR))
  const now = vi.fn(() => NOW)
  const port = memoryPort(files, calls, opts.links ?? {})
  const stat = vi.spyOn(port, 'stat')
  const tool = createKnowledgeTool({
    port,
    security,
    scan,
    resolveBase,
    listBases,
    search: opts.search,
    actor,
    now,
    review: impl === null ? undefined : review,
    isReviewer,
    afterWrite,
    abortError: opts.abortError,
    label: 'Knowledge'
  })
  return {
    tool,
    files,
    enforcePath,
    resolveBase,
    listBases,
    scan,
    afterWrite,
    review,
    isReviewer,
    actor,
    now,
    stat,
    calls,
    run: async (id, params, signal) =>
      (await invokeTool(tool, params, { callId: id, signal })).result,
    invoke: async (params, options) => (await invokeTool(tool, params, options)).result
  }
}

/** 拒绝之后该是什么都没发生：门、写手、落盘、回调一样都没有 */
function expectNothingHappened(h: Harness): void {
  expect(h.enforcePath).not.toHaveBeenCalled()
  expect(h.review).not.toHaveBeenCalled()
  expect(h.calls.filter((c) => c.startsWith('write:'))).toEqual([])
  expect(h.afterWrite).not.toHaveBeenCalled()
}

// ─── 1.1 Schema 与文案 ─────────────────────────────────────────────────────────

describe('KT-1′ schema 与运行时守卫', () => {
  const props = KnowledgeParamsSchema.properties as unknown as Record<
    string,
    { enum?: string[]; description?: string }
  >

  it('KT-1′ action 枚举恰为 bases / search / list / submit；参数恰为 action / base / query / path / limit；replay 取最保守的 unsafe', () => {
    expect(KNOWLEDGE_TOOL_NAME).toBe('knowledge')
    const { tool } = makeTool()
    expect(tool.name).toBe('knowledge')
    expect(tool.label).toBe('Knowledge')
    expect(props.action.enum).toEqual(['bases', 'search', 'list', 'submit'])
    // 动作 / 参数一旦漂回旧形状，模型就会以为还能 create
    expect(Object.keys(props).sort()).toEqual(['action', 'base', 'limit', 'path', 'query'])
    for (const gone of [
      'type',
      'title',
      'description',
      'body',
      'tags',
      'sources',
      'status',
      'stale_after',
      'scope'
    ]) {
      expect(props[gone], gone).toBeUndefined()
    }
    // submit 会派写手、回写章：durable 的重跑策略只能取最保守的那个
    expect(tool.replay).toBe('unsafe')
  })

  it('KT-1b preExecute / securityCheck 不碰 PEP；bases / search / list 一个字节都不写、不派写手', async () => {
    const h = makeTool({
      files: { [`${ROOT}/a.md`]: ENTRY },
      bases: [{ base: 'project', label: 'project "Acme"', dir: ROOT }]
    })
    await h.tool.preExecute()
    const before = h.files.get(`${ROOT}/a.md`)
    await h.run('c1', { action: 'bases' })
    await h.run('c2', { action: 'search', base: 'project', query: 'A' })
    await h.run('c3', { action: 'search', query: 'A' })
    await h.run('c4', { action: 'list', base: 'project' })
    expect(h.files.get(`${ROOT}/a.md`)).toBe(before)
    expectNothingHappened(h)
  })
})

describe('KT-12′ 给 agent 的文案', () => {
  const props = KnowledgeParamsSchema.properties as unknown as Record<
    string,
    { description?: string }
  >

  it('KT-12′ 两处文案都指向 "bases"、不点名 "project"；base 的说明点名 list / submit 必填、search 可省', () => {
    for (const [where, copy] of [
      ['base.description', props.base.description],
      ['KNOWLEDGE_DESCRIPTION', KNOWLEDGE_DESCRIPTION]
    ] as const) {
      expect(copy, where).toContain('"bases"')
      expect(copy, where).not.toContain('"project"')
    }
    expect(props.base.description).toContain('Required for "list" and "submit"')
    expect(props.base.description).toContain('"search" without it')
  })

  it('KT-12′ 描述教「写进库目录再 submit」「用 edit 改」「别写 verified」；动作条目恰为四个，没有 read / validate / create', () => {
    for (const phrase of [
      'user picks which bases',
      'leave `base` out',
      '`write`',
      '`edit`',
      'submit',
      'Never write `verified`',
      'shuvix://'
    ]) {
      expect(KNOWLEDGE_DESCRIPTION, phrase).toContain(phrase)
    }
    // 按动作行判：描述里另有 `read` the file（那是 read 工具）
    const actionLines = KNOWLEDGE_DESCRIPTION.split('\n')
      .filter((line) => line.startsWith('- "'))
      .map((line) => /^- "([a-z]+)"/.exec(line)?.[1])
    expect(actionLines).toEqual(['bases', 'search', 'list', 'submit'])
  })
})

// ─── 1.2 读侧（保留，路径改成绝对） ─────────────────────────────────────────────

describe('KT-3 search —— 注入的检索（宿主 okf-minisearch）', () => {
  it('KT-3 命中：query 与 {limit, bundleDir} 原样转发；每条恰一行 `- <绝对路径> (status) — description|title`', async () => {
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
      `2 result(s) for "q" in ${WHERE}:\n- ${ROOT}/a.md (draft) — d\n- ${ROOT}/b.md — B`
    )
    expect(res.details).toEqual({ action: 'search' })
    expect(h.enforcePath).not.toHaveBeenCalled()
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
        `4 result(s) for "token" in ${WHERE}:`,
        `- ${ROOT}/a.md (draft, 2026-09-09) — da`,
        `- ${ROOT}/b.md — db`,
        `- ${ROOT}/c.md — dc`,
        `- ${ROOT}/sub/e.md — de`
      ].join('\n')
    )
    const capped = await h.run('c2', {
      action: 'search',
      base: 'project',
      query: 'Token',
      limit: 1
    })
    expect(textOf(capped)).toBe(
      `4 result(s) for "Token" in ${WHERE}:\n- ${ROOT}/a.md (draft, 2026-09-09) — da`
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

  it('KT-5 列出全部条目（含 deprecated，带标注）、表头点名标签与目录；limit 之外折成一行计数', async () => {
    const h = makeTool({ files: FILES })
    expect(textOf(await h.run('c1', { action: 'list', base: 'project' }))).toBe(
      [
        `3 entries in ${WHERE}:`,
        `- ${ROOT}/a.md (draft) — da`,
        `- ${ROOT}/b.md — db`,
        `- ${ROOT}/d.md (deprecated) — dd`
      ].join('\n')
    )
    expect(textOf(await h.run('c2', { action: 'list', base: 'project', limit: 2 }))).toBe(
      [
        `3 entries in ${WHERE}:`,
        `- ${ROOT}/a.md (draft) — da`,
        `- ${ROOT}/b.md — db`,
        '- … 1 more'
      ].join('\n')
    )
  })

  it('KT-5b bundle 解析失败回文字（不失败）；bundle 在但还没有条目也有一句话', async () => {
    const noProject = makeTool({ files: FILES, bundle: { error: 'no project here' } })
    const failed = await noProject.run('c1', { action: 'list', base: 'project' })
    expect(textOf(failed)).toBe('no project here')
    expect(failed.isError).toBeFalsy()
    expect(failed.details).toEqual({ action: 'list' })
    expect(noProject.resolveBase).toHaveBeenCalledWith('project')

    expect(textOf(await makeTool().run('c2', { action: 'list', base: 'project' }))).toBe(
      `No entries in ${WHERE} yet.`
    )
  })
})

/**
 * 以下钉 base 本身（设计附录 U）。**刻意不给缺省**：缺省一旦落到项目库，agent 就永远想不起用户库 ——
 * 所以缺 base 必须失败。工具也不区分库的种类：名字去空白后交给宿主，标签与目录全用宿主给的。
 */
describe('KT-8 bases —— 只列库', () => {
  it('KT-8 表头 + 逐行 `- <base> — <label> — <dir>`；不解析 base、不过 PEP、不写盘；多带的 base / path 一概不看', async () => {
    const h = makeTool({
      bases: [
        { base: 'project', label: 'project "Acme"', dir: '/kb/projects/acme' },
        { base: 'notes', label: 'knowledge base "notes"', dir: '/u/notes' }
      ]
    })
    const expected = [
      'Knowledge bases in this session (pass the name as `base`):',
      '- project — project "Acme" — /kb/projects/acme',
      '- notes — knowledge base "notes" — /u/notes'
    ].join('\n')

    const res = await h.run('c1', { action: 'bases' })
    expect(textOf(res)).toBe(expected)
    expect(res.details).toEqual({ action: 'bases' })
    expect(h.listBases).toHaveBeenCalledTimes(1)

    const again = await h.run('c2', { action: 'bases', base: 'notes', path: '/x.md' })
    expect(textOf(again)).toBe(expected)
    expect(again.details).toEqual({ action: 'bases' })
    expect(h.listBases).toHaveBeenCalledTimes(2)

    expect(h.resolveBase).not.toHaveBeenCalled()
    expect(h.calls).toEqual([])
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
  /** list 与 submit（带 path）—— search 不在其中：省略 base 是它的正常用法 */
  const CALLS: KnowledgeToolParams[] = [{ action: 'list' }, { action: 'submit', path: 'a.md' }]
  const table = CALLS.flatMap((params) =>
    MISSING.map((base): [string, string, KnowledgeToolParams] => [
      params.action,
      base === undefined ? '不传' : JSON.stringify(base),
      base === undefined ? params : { ...params, base }
    ])
  )

  it.each(table)(
    'KT-9′ %s，base %s → 失败点名 `base`（并指向 "bases"）；不解析、不检索、不过 PEP、不写盘',
    async (_label, _base, params) => {
      const search = vi.fn(async () => [])
      // 条目真实存在：少了这道守卫，submit 会成功，而不是碰巧因为别的原因失败
      const h = makeTool({ search, files: { [`${ROOT}/a.md`]: ENTRY } })
      const message = await rejectionOf(h.run('c1', params))
      expect(message).toBe(
        `"${params.action}" needs \`base\` — one of the names "bases" lists for this session`
      )
      expect(message).not.toContain('"project"')
      expect(h.resolveBase).not.toHaveBeenCalled()
      expect(h.scan).not.toHaveBeenCalled()
      expect(search).not.toHaveBeenCalled()
      expect(h.calls).toEqual([])
      expectNothingHappened(h)
    }
  )
})

describe('KT-10′ 工具不关心 base 是哪种库', () => {
  const DIR = '/u/读书笔记'
  const USER_BASE: KnowledgeBundleTarget = { dir: DIR, label: 'knowledge base "读书笔记"' }
  /** 带首尾空白的库名：工具只去空白，其余原样交给宿主 */
  const RAW = '  读书笔记 '

  it('KT-10′ list / search / submit 都按去空白的名字解析；表头、命中、PEP、写手请求、afterWrite 全用宿主给的目录与标签', async () => {
    const search = vi.fn(async () => [{ path: 'a.md', title: 'A', description: 'da' }])
    const h = makeTool({
      bundle: USER_BASE,
      search,
      files: {
        [`${DIR}/a.md`]: ENTRY,
        [`${DIR}/b.md`]: doc(['type: Memory', 'title: B', 'description: db']),
        // 别的库里的条目：清单只含宿主解析出的那个目录
        [`${ROOT}/x.md`]: doc(['type: Memory', 'title: X', 'description: dx'])
      }
    })

    expect(textOf(await h.run('c1', { action: 'list', base: RAW }))).toBe(
      [
        `2 entries in knowledge base "读书笔记" — ${DIR}:`,
        `- ${DIR}/a.md — da`,
        `- ${DIR}/b.md — db`
      ].join('\n')
    )
    expect(textOf(await h.run('c2', { action: 'search', base: RAW, query: 'q' }))).toBe(
      `1 result(s) for "q" in knowledge base "读书笔记" — ${DIR}:\n- ${DIR}/a.md — da`
    )
    expect(search).toHaveBeenCalledWith('q', { limit: 20, bundleDir: DIR })

    const submitted = await h.run('c3', { action: 'submit', base: RAW, path: 'a.md' })
    expect(textOf(submitted).startsWith(`Confirmed: ${DIR}/a.md`)).toBe(true)
    expect(h.review.mock.calls[0][0]).toMatchObject({
      base: '读书笔记',
      label: 'knowledge base "读书笔记"',
      bundleDir: DIR,
      path: `${DIR}/a.md`,
      rel: 'a.md'
    })

    expect(h.resolveBase.mock.calls).toEqual([['读书笔记'], ['读书笔记'], ['读书笔记']])
    expect(h.calls).toEqual([
      `enforce:write:${DIR}/a.md`,
      `review:${DIR}/a.md`,
      `write:${DIR}/a.md`,
      `after:${DIR}|a.md`
    ])
  })
})

describe('KT-11′ base 解析失败', () => {
  const ERR = 'No knowledge base named "nope". Available: "project", "notes".'

  it('KT-11′ submit 以宿主原文失败（硬错）；list / search 回这句原文、不失败（软条件）；两边都不过 PEP', async () => {
    const search = vi.fn(async () => [])
    const h = makeTool({ bundle: { error: ERR }, search, files: { [`${ROOT}/a.md`]: ENTRY } })

    expect(await rejectionOf(h.run('c1', { action: 'submit', base: 'nope', path: 'a.md' }))).toBe(
      ERR
    )

    const listed = await h.run('c2', { action: 'list', base: 'nope' })
    expect(listed.isError).toBeFalsy()
    expect(textOf(listed)).toBe(ERR)
    expect(listed.details).toEqual({ action: 'list' })
    const searched = await h.run('c3', { action: 'search', base: 'nope', query: 'q' })
    expect(searched.isError).toBeFalsy()
    expect(textOf(searched)).toBe(ERR)
    expect(searched.details).toEqual({ action: 'search' })

    expect(search).not.toHaveBeenCalled()
    expect(h.stat).not.toHaveBeenCalled()
    expectNothingHappened(h)
  })
})

/**
 * 读宽（设计附录 L）：库里每个 md 都是一条笔记 —— list / search 都算它。ShuviX 早先生成的 index.md /
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
        `4 entries in ${WHERE}:`,
        `- ${ROOT}/a.md (draft) — da`,
        `- ${ROOT}/log.md — My log`,
        `- ${ROOT}/notes/plain.md — Plain heading`,
        `- ${ROOT}/u.md (draft) — du`
      ].join('\n')
    )
  })

  it('KT-15 不注入 search 时的子串检索覆盖普通笔记；只出现在生成 index 里的词不命中', async () => {
    const h = makeTool({ files: NOTE_FILES })
    expect(
      textOf(await h.run('c1', { action: 'search', base: 'project', query: 'plain heading' }))
    ).toBe(`1 result(s) for "plain heading" in ${WHERE}:\n- ${ROOT}/notes/plain.md — Plain heading`)
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

  it('KT-16 省略 base：按库分组、逐库成块，表头报总命中数与参与的库数；只问 listBases，不解析 base', async () => {
    const h = makeTool({ files: HIT_FILES, bases: [NOTES_BASE, PROJECT_BASE] })
    const res = await h.run('c1', { action: 'search', query: 'token' })
    expect(textOf(res)).toBe(
      [
        '2 result(s) for "token" across 2 base(s):',
        `base "notes" — ${NOTES}:`,
        `- ${NOTES}/n1.md — dn1`,
        `base "project" — ${ROOT}:`,
        `- ${ROOT}/a.md — da`
      ].join('\n')
    )
    expect(res.details).toEqual({ action: 'search' })
    expect(h.resolveBase).not.toHaveBeenCalled()
    expect(h.listBases).toHaveBeenCalledTimes(1)
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
        `base "notes" — ${NOTES}:`,
        `- ${NOTES}/n1.md — dn1`
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
      `1 result(s) for "token" in knowledge base "notes" — ${NOTES}:\n- ${NOTES}/n1.md — dn1`
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
 * 就是被读：list / search 照常，`submit` 在动手之前被拒（KS-6）。
 */
describe('KT-22′ / KT-23 只读库（随应用发布的内置库）', () => {
  const DIR = '/kb/builtin/shuvix/en'
  const BUILTIN: KnowledgeBundleTarget = {
    dir: DIR,
    label: 'ShuviX reference (read-only)',
    readonly: true
  }
  const READONLY_NOTE = 'read-only: search and read it, never write or submit here'
  const GUIDE = `${DIR}/agent-md.md`
  const FILES = {
    [GUIDE]: doc(
      ['type: Reference', 'title: Agent md', 'description: how an agent md file is written'],
      'frontmatter keys, then the body'
    )
  }

  it('KT-22′ 只读库照常被 list / search；读侧不过 PEP，且一个字都不写', async () => {
    const h = makeTool({ bundle: BUILTIN, files: FILES })
    expect(textOf(await h.run('c1', { action: 'list', base: 'shuvix' }))).toBe(
      [
        `1 entry in ShuviX reference (read-only) — ${DIR}:`,
        `- ${GUIDE} — how an agent md file is written`
      ].join('\n')
    )
    expect(textOf(await h.run('c2', { action: 'search', base: 'shuvix', query: 'agent md' }))).toBe(
      [
        `1 result(s) for "agent md" in ShuviX reference (read-only) — ${DIR}:`,
        `- ${GUIDE} — how an agent md file is written`
      ].join('\n')
    )
    expect(h.calls).toEqual([])
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
      '- notes — knowledge base "notes" — /u/notes',
      '- alpha — knowledge base "alpha" — /u/alpha',
      `- shuvix — ShuviX reference (read-only) — ${DIR} (${READONLY_NOTE})`
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
      `2 result(s) for "q" in ${WHERE}:`,
      `- ${ROOT}/a.md — da`,
      `- ${ROOT}/b.md — db`
    ])
    expect(out).not.toMatch(/paragraph|prose|12\.5/)
  })

  it('KT-26 逐字渲染：description 优先于 title、status 非 stable 才括注、路径一律归一后拼到库目录下', async () => {
    const search = vi.fn(
      async (): Promise<KnowledgeSearchHit[]> => [
        { path: '/a.md', title: 'A', description: 'da', status: 'stable' },
        { path: 'b.md', title: 'B', description: '', status: 'draft' },
        { path: 'sub/c.md', title: 'C', status: 'deprecated' },
        { path: '/sub/d.md', title: 'D', description: 'dd' },
        { path: './e.md', title: 'E', description: 'de', status: 'stable' }
      ]
    )
    const h = makeTool({ search })
    expect(textOf(await h.run('c1', { action: 'search', base: 'project', query: 'q' }))).toBe(
      [
        `5 result(s) for "q" in ${WHERE}:`,
        `- ${ROOT}/a.md — da`,
        `- ${ROOT}/b.md (draft) — B`,
        `- ${ROOT}/sub/c.md (deprecated) — C`,
        `- ${ROOT}/sub/d.md — dd`,
        `- ${ROOT}/e.md — de`
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
        `base "notes" — ${NOTES}:`,
        `- ${NOTES}/n1.md — dn1`,
        `base "project" — ${ROOT}:`,
        `- ${ROOT}/a1.md — da1`,
        `- ${ROOT}/a2.md (draft) — A2`
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
    ['Zebracorn', [`- ${ROOT}/title.md — dt`]],
    ['quokka', [`- ${ROOT}/desc.md — about the quokka`]],
    ['Runbook', [`- ${ROOT}/type.md — d3`]],
    ['platypus', [`- ${ROOT}/tags.md — d4`]],
    ['Marmoset', [`- ${ROOT}/head.md — d5`]],
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
      `1 result(s) for "dingo" in ${WHERE}:\n- ${ROOT}/dingo-only.md — the host said so`
    )
    expect(h.scan).not.toHaveBeenCalled()
  })

  /** 命中行的路径（`- <path> …` 的第一段） */
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
    expect(await hits('okapi')).toEqual([`${ROOT}/a.md`])
    expect(await hits('numbat')).toEqual([])
    expect(await hits('saiga')).toEqual([`${ROOT}/open.md`])
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
      expect(await hits(q), q).toEqual([`${ROOT}/a.md`])
    }
    expect(await hits('令牌刷新')).toEqual([`${ROOT}/z.md`])
    expect(await hits('与令牌')).toEqual([`${ROOT}/z.md`])
    expect(await hits('令牌 刷新')).toEqual([])
    expect(await hits('鉴权刷新')).toEqual([])
  })
})

describe('KT-32..KT-33 文案与 limit', () => {
  it('KT-32 文案与类型：描述同时教 `read` 与 `grep`；KnowledgeSearchHit 上没有 snippet', () => {
    expect(KNOWLEDGE_DESCRIPTION).toContain('`grep`')
    expect(KNOWLEDGE_DESCRIPTION).toContain('`read`')
    expect(KNOWLEDGE_DESCRIPTION).toContain('not the prose')
    expect(KNOWLEDGE_DESCRIPTION).toContain('then `read`')
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
      expect(out.split('\n')[0], String(limit)).toBe(`3 result(s) for "kudu" in ${WHERE}:`)
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
    const two = [`- ${ROOT}/a.md — da`, `- ${ROOT}/b.md — db`, '- … 1 more']
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
      `7 entries in ${WHERE}:`,
      `- ${ROOT}/a.md (machine-confirmed, 2026-09-05) — da`,
      `- ${ROOT}/b.md (human-reviewed, 2026-09-05) — db`,
      // 人看过的是旧内容：不是 human-reviewed
      `- ${ROOT}/c.md (machine-confirmed, 2026-09-05) — dc`,
      `- ${ROOT}/d.md (edited since checked, 2026-09-05) — dd`,
      `- ${ROOT}/e.md (draft, machine-confirmed, 2026-09-05) — de`,
      `- ${ROOT}/f.md (2026-09-05) — df`,
      `- ${ROOT}/g.md — g plain`
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
    ).toEqual([
      `2 result(s) for "x" in ${WHERE}:`,
      `- ${ROOT}/c.md — c`,
      `- ${ROOT}/e.md (draft) — de`
    ])
  })

  it('KT-42 兜底检索的命中行与 list 同一种写法：旧人工 + 新机器那一份同样印 machine-confirmed', async () => {
    const h = makeTool({ files: FILES })
    expect(textOf(await h.run('c1', { action: 'search', base: 'project', query: 'dc' }))).toBe(
      `1 result(s) for "dc" in ${WHERE}:\n- ${ROOT}/c.md (machine-confirmed, 2026-09-05) — dc`
    )
  })
})

// ─── 1.4 submit —— 准入与路径解析 ──────────────────────────────────────────────

describe('KS-1..KS-9 submit 的准入', () => {
  /** 一个库（ROOT）+ 库外的几个干扰项 */
  const FILES = {
    [`${ROOT}/a.md`]: ENTRY,
    [`${ROOT}/sub/b.md`]: ENTRY,
    [`${ROOT}/NOTE.MD`]: ENTRY,
    [`${ROOT}/index.md`]: ENTRY,
    [`${ROOT}/sub/log.md`]: ENTRY,
    '/elsewhere/draft.md': ENTRY,
    // 前缀与库目录相同的兄弟目录
    '/kb/projects/acme-old/a.md': ENTRY
  }
  const notInside = (raw: string): string => `"${raw}" is not inside ${WHERE}`
  const outsideFile = (raw: string): string =>
    `${notInside(raw)} — write the entry into the base's directory`
  const noFile = (abs: string): string =>
    `No file at ${abs} — write the entry there first, then submit it`

  type Expect = { rel: string } | { error: string }
  const KS1: [string, string, Expect][] = [
    ['#1 库内绝对路径', `${ROOT}/a.md`, { rel: 'a.md' }],
    ['#2 库内绝对路径（子目录）', `${ROOT}/sub/b.md`, { rel: 'sub/b.md' }],
    ['#3 库相对', 'a.md', { rel: 'a.md' }],
    ['#4 前导 / 是库根', '/a.md', { rel: 'a.md' }],
    ['#5 ./ 前缀', './sub/b.md', { rel: 'sub/b.md' }],
    ['#6 首尾空白', `  ${ROOT}/a.md  `, { rel: 'a.md' }],
    ['#7a 库目录本身', ROOT, { error: notInside(ROOT) }],
    ['#7b 库目录带尾斜杠', `${ROOT}/`, { error: notInside(`${ROOT}/`) }],
    ['#8 ../ 越界', '../x.md', { error: notInside('../x.md') }],
    // 任何 `..` 段都拒（保守口径：哪怕折算回来仍在库里）
    ['#9 中间带 ..', 'sub/../a.md', { error: notInside('sub/../a.md') }],
    ['#10 不是 .md', 'a.txt', { error: '"a.txt" is not a markdown entry (.md)' }],
    ['#11 扩展名大小写不敏感', 'NOTE.MD', { rel: 'NOTE.MD' }],
    ['#12a 保留名', 'index.md', { error: '/index.md is a reserved name, not an entry' }],
    [
      '#12b 任何深度的保留名',
      'sub/log.md',
      { error: '/sub/log.md is a reserved name, not an entry' }
    ],
    ['#13 库外真文件', '/elsewhere/draft.md', { error: outsideFile('/elsewhere/draft.md') }],
    ['#14 哪都没有', '/elsewhere/missing.md', { error: noFile(`${ROOT}/elsewhere/missing.md`) }],
    [
      '#15 前缀相同的兄弟目录',
      '/kb/projects/acme-old/a.md',
      { error: outsideFile('/kb/projects/acme-old/a.md') }
    ],
    ['#16 库里没有', 'missing.md', { error: noFile(`${ROOT}/missing.md`) }]
  ]

  it.each(KS1)('KS-1 %s：%s', async (_label, path, expected) => {
    const h = makeTool({ files: FILES })
    const res = await h.run('c1', { action: 'submit', base: 'project', path })
    if ('rel' in expected) {
      expect(res.isError, textOf(res)).toBeFalsy()
      expect(textOf(res).startsWith(`Confirmed: ${ROOT}/${expected.rel}`)).toBe(true)
      expect(h.review).toHaveBeenCalledTimes(1)
      expect(h.review.mock.calls[0][0]).toMatchObject({
        rel: expected.rel,
        path: `${ROOT}/${expected.rel}`
      })
      return
    }
    expect(res.isError).toBe(true)
    expect(textOf(res)).toBe(expected.error)
    expectNothingHappened(h)
  })

  it('KS-1 #13 的判定顺序：先按库相对问 stat，库里没有才拿原路径再问一次', async () => {
    const h = makeTool({ files: FILES })
    await h.run('c1', { action: 'submit', base: 'project', path: '/elsewhere/draft.md' })
    expect(h.stat.mock.calls.map((c) => c[0])).toEqual([
      `${ROOT}/elsewhere/draft.md`,
      '/elsewhere/draft.md'
    ])
  })

  it('KS-2 [白盒] POSIX 歧义：`/sub/b.md` 在库里与磁盘根下都存在 → 按库相对处理（库内优先，原路径一次都不问）', async () => {
    const h = makeTool({ files: { ...FILES, '/sub/b.md': PLAIN } })
    const res = await h.run('c1', { action: 'submit', base: 'project', path: '/sub/b.md' })
    expect(res.isError).toBeFalsy()
    expect(h.review.mock.calls[0][0]).toMatchObject({ rel: 'sub/b.md', path: `${ROOT}/sub/b.md` })
    expect(h.stat.mock.calls.map((c) => c[0])).not.toContain('/sub/b.md')
    expect(h.files.get('/sub/b.md')).toBe(PLAIN)
  })

  it('KS-3 [白盒] 盘符路径：库内的（盘符大小写不敏感）通过；别的盘上的直接拒，stat 一次都不问', async () => {
    const DIR = 'C:\\kb\\notes'
    const target: KnowledgeBundleTarget = { dir: DIR, label: 'knowledge base "notes"' }
    // joinRoot 的输出形状：去尾分隔符后拼 `/`
    const ABS = 'C:\\kb\\notes/a.md'
    // 盘符不分大小写（`c:/` 与 `C:\` 是同一处）；其余照字面比
    for (const path of ['C:\\kb\\notes\\a.md', 'c:/kb/notes/a.md', 'c:\\kb\\notes\\a.md']) {
      const h = makeTool({ bundle: target, files: { [ABS]: ENTRY } })
      const res = await h.run('c1', { action: 'submit', base: 'notes', path })
      expect(res.isError, `${path}: ${textOf(res)}`).toBeFalsy()
      expect(h.review.mock.calls[0][0], path).toMatchObject({ rel: 'a.md', path: ABS })
    }

    const h = makeTool({ bundle: target, files: { [ABS]: ENTRY, 'D:\\other\\a.md': ENTRY } })
    expect(
      await rejectionOf(h.run('c2', { action: 'submit', base: 'notes', path: 'D:\\other\\a.md' }))
    ).toBe(`"D:\\other\\a.md" is not inside knowledge base "notes" — ${DIR}`)
    expect(h.stat).not.toHaveBeenCalled()
    expectNothingHappened(h)
  })

  it('KS-4 缺参顺序：path 先于 base（两样都缺报 path）；path 全空白也算缺；都不解析', async () => {
    const h = makeTool({ files: FILES })
    const NEEDS_PATH = '"submit" needs `path` — the entry\'s file'
    const NEEDS_BASE = '"submit" needs `base` — one of the names "bases" lists for this session'

    expect(await rejectionOf(h.run('c1', { action: 'submit' }))).toBe(NEEDS_PATH)
    for (const base of [undefined, '', '   ']) {
      const params: KnowledgeToolParams =
        base === undefined
          ? { action: 'submit', path: 'a.md' }
          : { action: 'submit', path: 'a.md', base }
      const message = await rejectionOf(h.run('c2', params))
      expect(message, JSON.stringify(base)).toBe(NEEDS_BASE)
      expect(message).not.toContain('"project"')
    }
    expect(await rejectionOf(h.run('c3', { action: 'submit', base: 'project', path: '   ' }))).toBe(
      NEEDS_PATH
    )
    expect(h.resolveBase).not.toHaveBeenCalled()
    expect(h.stat).not.toHaveBeenCalled()
    expectNothingHappened(h)
  })

  it('KS-5 base 解析失败是硬错误：失败文字恰为宿主那句原文', async () => {
    const ERR = 'No knowledge base named "nope". Available: "project", "notes".'
    const h = makeTool({ bundle: { error: ERR }, files: FILES })
    expect(await rejectionOf(h.run('c1', { action: 'submit', base: 'nope', path: 'a.md' }))).toBe(
      ERR
    )
    expect(h.stat).not.toHaveBeenCalled()
    expectNothingHappened(h)
  })

  it('KS-6 只读库：在动手之前拒（点名库、指回 "bases"）；只读判定先于路径解析，缺参又先于只读', async () => {
    const DIR = '/kb/builtin/shuvix/en'
    const builtin: KnowledgeBundleTarget = {
      dir: DIR,
      label: 'ShuviX reference (read-only)',
      readonly: true
    }
    const h = makeTool({ bundle: builtin, files: { [`${DIR}/agent-md.md`]: ENTRY } })

    // 去空白后的名字既用来解析，也是话里点名的那一个
    const message = await rejectionOf(
      h.run('c1', { action: 'submit', base: '  shuvix ', path: 'agent-md.md' })
    )
    expect(message).toContain('"shuvix" is read-only')
    expect(message).toContain("user's knowledge bases")
    expect(message).toContain('"bases"')
    expect(h.resolveBase.mock.calls).toEqual([['shuvix']])

    // 越界的路径也报只读：路径根本还没看
    expect(
      await rejectionOf(h.run('c2', { action: 'submit', base: 'shuvix', path: '../x.md' }))
    ).toContain('"shuvix" is read-only')

    // 缺 path：报的是缺参，连 base 都还没解析
    const before = h.resolveBase.mock.calls.length
    const missing = await rejectionOf(h.run('c3', { action: 'submit', base: 'shuvix' }))
    expect(missing).toBe('"submit" needs `path` — the entry\'s file')
    expect(h.resolveBase.mock.calls.length).toBe(before)

    expect(h.stat).not.toHaveBeenCalled()
    expect(h.scan).not.toHaveBeenCalled()
    expectNothingHappened(h)
    expect(h.files.get(`${DIR}/agent-md.md`)).toBe(ENTRY)
  })

  it('KS-7 写手自己 submit：拒在一切之前（参数全缺也报这句），判据收的是这次调用的 scope', async () => {
    const isReviewer = vi.fn((_call: ToolCallScope | undefined) => true)
    const h = makeTool({ files: FILES, isReviewer })
    const MSG =
      'The knowledge librarian does not submit entries — edit the entry you were given and answer with `next`.'

    expect(
      await rejectionOf(
        h.invoke(
          { action: 'submit', base: 'project', path: 'a.md' },
          { callId: 'w1', conversationId: 7 }
        )
      )
    ).toBe(MSG)
    expect(await rejectionOf(h.run('w2', { action: 'submit' }))).toBe(MSG)

    expect(h.isReviewer).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 7 }))
    expect(h.resolveBase).not.toHaveBeenCalled()
    expect(h.stat).not.toHaveBeenCalled()
    expectNothingHappened(h)
  })

  it('KS-8 isReviewer 不碍读侧（写手要靠它们查重）；不注入 isReviewer 时 submit 照常（缺省 = 不是写手）', async () => {
    const reviewer = makeTool({
      files: FILES,
      isReviewer: () => true,
      bases: [{ base: 'project', label: 'project "Acme"', dir: ROOT }]
    })
    expect((await reviewer.run('r1', { action: 'list', base: 'project' })).isError).toBeFalsy()
    expect(
      textOf(await reviewer.run('r2', { action: 'search', base: 'project', query: 'da' }))
    ).toContain(`${ROOT}/a.md`)
    expect(textOf(await reviewer.run('r3', { action: 'bases' }))).toContain('- project')
    expect(reviewer.isReviewer).not.toHaveBeenCalled()

    const plain = makeTool({ files: FILES })
    const res = await plain.run('p1', { action: 'submit', base: 'project', path: 'a.md' })
    expect(res.isError).toBeFalsy()
    expect(plain.review).toHaveBeenCalledTimes(1)
  })

  it('KS-9 宿主不注入 review（扩展端）：报「不支持」，且在路径解析与存在检查之前 —— 文件在不在、路径越不越界都一样', async () => {
    const h = makeTool({ files: FILES, review: null })
    const MSG = 'Submitting entries is not available on this host'
    for (const path of ['a.md', 'missing.md', '../x.md']) {
      expect(
        await rejectionOf(h.run('c1', { action: 'submit', base: 'project', path })),
        path
      ).toBe(MSG)
    }
    expect(h.stat).not.toHaveBeenCalled()
    expect(h.enforcePath).not.toHaveBeenCalled()
    expect(h.calls).toEqual([])
    expect(h.afterWrite).not.toHaveBeenCalled()
  })

  it('KS-38 隐藏路径（任何一段以 `.` 开头）不是库内容：拒绝，绝对路径与库相对都一样', async () => {
    const h = makeTool({
      files: { ...FILES, [`${ROOT}/.obsidian/x.md`]: ENTRY, [`${ROOT}/sub/.draft.md`]: ENTRY }
    })
    for (const path of ['.obsidian/x.md', `${ROOT}/.obsidian/x.md`, 'sub/.draft.md']) {
      expect(
        await rejectionOf(h.run('c1', { action: 'submit', base: 'project', path })),
        path
      ).toBe(`"${path}" is a hidden path — it is not part of the knowledge base`)
    }
    expect(h.stat).not.toHaveBeenCalled()
    expectNothingHappened(h)
  })

  it('KS-39 符号链接不跟（与文件工具同一条规矩）：拒绝并说出它通向哪里；不过门、不派写手', async () => {
    const h = makeTool({
      files: FILES,
      links: { [`${ROOT}/a.md`]: { target: '../../secret.md', resolved: '/kb/secret.md' } }
    })
    expect(
      await rejectionOf(h.run('c1', { action: 'submit', base: 'project', path: 'a.md' }))
    ).toBe(
      `${ROOT}/a.md is a symbolic link to /kb/secret.md — entries must be real files inside the base`
    )
    expectNothingHappened(h)
    expect(h.files.get(`${ROOT}/a.md`)).toBe(ENTRY)
  })
})

// ─── 1.5 submit —— PEP ───────────────────────────────────────────────────────

describe('KS-10..KS-12 与文件工具同一道写门', () => {
  it('KS-10 / KT-6b′ PEP 形状：write + 条目绝对路径 + 调用归属；先门、后派写手、再落盘、最后回调', async () => {
    const h = makeTool({ files: { [`${ROOT}/sub/b.md`]: ENTRY }, abortError: 'TOOL_ABORTED' })
    await h.invoke(
      { action: 'submit', base: 'project', path: 'sub/b.md' },
      { callId: 'c7', taskId: 21, conversationId: 9 }
    )
    const abs = `${ROOT}/sub/b.md`
    expect(h.enforcePath).toHaveBeenCalledTimes(1)
    expect(h.enforcePath).toHaveBeenCalledWith(
      'write',
      abs,
      expect.objectContaining({
        toolCallId: 'c7',
        taskId: 21,
        conversationId: 9,
        toolName: 'knowledge',
        displayPath: abs,
        operation: 'submit',
        abortError: 'TOOL_ABORTED'
      })
    )
    expect(h.calls).toEqual([
      `enforce:write:${abs}`,
      `review:${abs}`,
      `write:${abs}`,
      `after:${ROOT}|sub/b.md`
    ])
  })

  it('KS-11 PEP 拒绝：失败文字即那句话；写手不派、文件一字不动、不回调', async () => {
    const DENIED = `User denied access to ${ROOT}/a.md`
    const enforcePath = vi.fn(async () => {
      throw new Error(DENIED)
    })
    const h = makeTool({
      files: { [`${ROOT}/a.md`]: ENTRY },
      security: { enforcePath } as unknown as SecurityContext
    })
    expect(
      await rejectionOf(h.run('c1', { action: 'submit', base: 'project', path: 'a.md' }))
    ).toBe(DENIED)
    expect(enforcePath).toHaveBeenCalledTimes(1)
    expect(h.review).not.toHaveBeenCalled()
    expect(h.files.get(`${ROOT}/a.md`)).toBe(ENTRY)
    expect(h.afterWrite).not.toHaveBeenCalled()
  })

  it('KS-12 PEP 收到这次调用的取消信号（按中止态联动判，不比对象同一性）', async () => {
    let seen: AbortSignal | undefined
    const enforcePath = vi.fn(async (_m: string, _p: string, opts: { signal?: AbortSignal }) => {
      seen = opts.signal
    })
    const h = makeTool({
      files: { [`${ROOT}/a.md`]: ENTRY },
      security: { enforcePath } as unknown as SecurityContext
    })
    const controller = new AbortController()
    await h.run('c1', { action: 'submit', base: 'project', path: 'a.md' }, controller.signal)
    expect(seen).toBeDefined()
    expect(seen!.aborted).toBe(false)
    controller.abort()
    expect(seen!.aborted).toBe(true)
  })
})

// ─── 1.6 submit —— 交给写手的请求 ─────────────────────────────────────────────

describe('KS-13..KS-14 交给写手的请求', () => {
  it('KS-13 请求体恰为 {base, label, bundleDir, path, rel, submittedBy}；第二参带这次调用的 scope 与 toolCallId', async () => {
    const DIR = '/u/读书笔记'
    const h = makeTool({
      bundle: { dir: DIR, label: 'knowledge base "读书笔记"' },
      files: { [`${DIR}/sub/x.md`]: ENTRY }
    })
    await h.invoke(
      { action: 'submit', base: '  读书笔记 ', path: `${DIR}/sub/x.md` },
      { callId: 'k13', taskId: 5, conversationId: 3 }
    )
    expect(h.resolveBase).toHaveBeenCalledWith('读书笔记')
    expect(h.review).toHaveBeenCalledTimes(1)
    const [req, ctx] = h.review.mock.calls[0]
    expect(req).toStrictEqual({
      base: '读书笔记',
      label: 'knowledge base "读书笔记"',
      bundleDir: DIR,
      path: `${DIR}/sub/x.md`,
      rel: 'sub/x.md',
      submittedBy: ACTOR
    })
    expect(ctx).toEqual({
      call: expect.objectContaining({ callId: 'k13', taskId: 5, conversationId: 3 }),
      toolCallId: 'k13',
      signal: undefined
    })
  })

  it('KS-14 提交者按调用现取：同一工具两次 submit、两个对话 → 请求与落盘的 generated.by 各是各的', async () => {
    const actor = (call: ToolCallScope | undefined): string =>
      call?.conversationId === 1 ? 'shuvix-work/a' : 'shuvix-explore/b'
    const h = makeTool({
      files: { [`${ROOT}/a.md`]: ENTRY, [`${ROOT}/b.md`]: ENTRY },
      actor
    })
    await h.invoke({ action: 'submit', base: 'project', path: 'a.md' }, { conversationId: 1 })
    await h.invoke({ action: 'submit', base: 'project', path: 'b.md' }, { conversationId: 2 })

    expect(h.review.mock.calls.map(([req]) => req.submittedBy)).toEqual([
      'shuvix-work/a',
      'shuvix-explore/b'
    ])
    expect(h.files.get(`${ROOT}/a.md`)).toContain(`generated: { by: "shuvix-work/a", at:`)
    expect(h.files.get(`${ROOT}/b.md`)).toContain(`generated: { by: "shuvix-explore/b", at:`)
    expect(h.actor.mock.calls.map(([call]) => call?.conversationId)).toEqual([1, 2])
  })
})

// ─── 1.7 submit —— 写手结论的分支 ─────────────────────────────────────────────

describe('KS-20..KS-37 写手结论的分支', () => {
  const ABS = `${ROOT}/a.md`
  /** 写手 edit 过的版本：补了 frontmatter，写钩子把 generated 盖成了写手自己 */
  const WRITER_AT = '2026-10-12T07:59:00.000Z'
  const WRITER_VERSION = doc(
    [
      'shuvix: okf v0.2',
      'type: Memory',
      'title: Plain',
      'description: dp',
      'status: stable',
      `generated: { by: "${REVIEWER}", at: "${WRITER_AT}" }`
    ],
    '# Plain\n\nbody'
  )
  const submit = (h: Harness, path = 'a.md'): Promise<Result> =>
    h.run('c1', { action: 'submit', base: 'project', path })

  it('KS-20 写手没跑成（error）→ 失败点名条目与原因；文件不动、不回调、没取时间', async () => {
    const h = makeTool({
      files: { [ABS]: ENTRY },
      review: async () => ({ error: 'aborted by user' })
    })
    expect(await rejectionOf(submit(h))).toBe(
      `The knowledge librarian could not check ${ABS}: aborted by user`
    )
    expect(h.files.get(ABS)).toBe(ENTRY)
    expect(h.afterWrite).not.toHaveBeenCalled()
    expect(h.now).not.toHaveBeenCalled()
  })

  it('KS-21 review 自己失败（宿主抛错）→ 失败带那句消息；不盖章', async () => {
    const h = makeTool({
      files: { [ABS]: ENTRY },
      review: async () => {
        throw new Error('invalid result contract: result schema must declare top-level `type`')
      }
    })
    expect(await rejectionOf(submit(h))).toContain('invalid result contract')
    expect(h.files.get(ABS)).toBe(ENTRY)
    expect(h.afterWrite).not.toHaveBeenCalled()
  })

  it('KS-22 不通过是正常结论（不是失败）：逐行「Not confirmed / 报告原文 / 先重读再修」；不写、不回调', async () => {
    const report = 'Two subjects — split it.\nNo source for claim 2.'
    const h = makeTool({
      files: { [ABS]: ENTRY },
      review: async () => ({ passed: false, report, reviewer: REVIEWER })
    })
    const res = await submit(h)
    expect(res.isError).toBeFalsy()
    expect(textOf(res).split('\n')).toEqual([
      `Not confirmed: ${ABS}`,
      '',
      'Two subjects — split it.',
      'No source for claim 2.',
      '',
      'Fix the entry and submit it again. Re-read it first — the librarian may have edited its metadata.'
    ])
    expect(res.details).toEqual({ action: 'submit', path: 'a.md' })
    expect(h.calls.filter((c) => c.startsWith('write:'))).toEqual([])
    expect(h.afterWrite).not.toHaveBeenCalled()
  })

  it('KS-23 不通过但写手改过文件：保持写手改后的样子（宿主不回滚），没有 verified，generated 仍是写手版本里的', async () => {
    const h = makeTool({
      files: { [ABS]: PLAIN },
      review: async (req, _ctx, files) => {
        files.set(req.path, WRITER_VERSION)
        return { passed: false, report: 'No source.', reviewer: REVIEWER }
      }
    })
    await submit(h)
    expect(h.files.get(ABS)).toBe(WRITER_VERSION)
    expect(h.files.get(ABS)).not.toContain('verified')
    expect(h.calls.filter((c) => c.startsWith('write:'))).toEqual([])
  })

  it('KS-24 report 为空 → 正文那一行是 `(no report)`（通过与不通过都一样）', async () => {
    const failed = makeTool({
      files: { [ABS]: ENTRY },
      review: async () => ({ passed: false, report: '', reviewer: REVIEWER })
    })
    expect(textOf(await submit(failed)).split('\n')[2]).toBe('(no report)')

    const passed = makeTool({
      files: { [ABS]: ENTRY },
      review: async () => ({ passed: true, report: '', reviewer: REVIEWER })
    })
    expect(textOf(await submit(passed)).split('\n')).toEqual([
      `Confirmed: ${ABS} (machine-confirmed by ${REVIEWER}). Re-read it before editing it again.`,
      '',
      '(no report)'
    ])
  })

  /** 写手判过、文件却仍过不了格式：不盖章，说清哪里不行 */
  const brokenAfterPass = (lines: string[]): string[] => [
    `Not confirmed: ${ABS} — the librarian passed it, but the file still breaks the format:`,
    ...lines,
    '',
    'ok',
    '',
    'Submit it again.'
  ]

  it.each([
    ['KS-25 普通笔记（没有 frontmatter）', PLAIN, ['- it has no OKF frontmatter with a `type`']],
    [
      'KS-26 带自述行但缺 type',
      doc(['shuvix: okf v0.2', 'title: A', 'description: da']),
      ["- 'type' is required and must be a non-empty string"]
    ],
    [
      'KS-27 带自述行、YAML 写坏',
      '---\nshuvix: okf v0.2\ntype: Memory\ntitle: [x\n---\n\nbody\n',
      ['- frontmatter is not parseable YAML, or is not a key/value mapping']
    ],
    [
      // 外来标记不是概念：章不能盖到别家契约的文件上
      'KS-28 外来标记（agent md）',
      doc(['shuvix: agent v1', 'type: Memory', 'name: x']),
      ['- it has no OKF frontmatter with a `type`']
    ]
  ])('%s：写手判过也不盖章，不写盘、不回调', async (_label, text, why) => {
    const h = makeTool({ files: { [ABS]: text } })
    const res = await submit(h)
    expect(res.isError).toBeFalsy()
    expect(textOf(res).split('\n')).toEqual(brokenAfterPass(why))
    expect(res.details).toEqual({ action: 'submit', path: 'a.md' })
    expect(h.files.get(ABS)).toBe(text)
    expect(h.calls.filter((c) => c.startsWith('write:'))).toEqual([])
    expect(h.afterWrite).not.toHaveBeenCalled()
  })

  it('KS-29 只有 warning（缺 description）不挡章：照常盖章、Confirmed', async () => {
    const text = doc(['shuvix: okf v0.2', 'type: Memory', 'title: A'])
    const h = makeTool({ files: { [ABS]: text } })
    const res = await submit(h)
    expect(textOf(res).startsWith(`Confirmed: ${ABS}`)).toBe(true)
    expect(h.files.get(ABS)).toContain(VERIFIED_LINE)
  })

  it('KS-30 通过 → 盖章：generated 记提交者、verified 记写手，同一时刻（now 只取一次）；回读是机器确认且仍当前', async () => {
    const h = makeTool({ files: { [ABS]: ENTRY } })
    const res = await submit(h)
    expect(textOf(res).split('\n')).toEqual([
      `Confirmed: ${ABS} (machine-confirmed by ${REVIEWER}). Re-read it before editing it again.`,
      '',
      'ok'
    ])
    expect(res.details).toEqual({ action: 'submit', path: 'a.md' })
    expect(h.files.get(ABS)).toBe(
      doc([
        'shuvix: okf v0.2',
        'type: Memory',
        'title: A',
        'description: da',
        'status: stable',
        GENERATED_LINE,
        VERIFIED_LINE
      ])
    )
    expect(h.now).toHaveBeenCalledTimes(1)
    const concept = parseConceptText(h.files.get(ABS)!, 'a.md')!
    expect(isVerificationCurrent(concept)).toBe(true)
    expect(currentTrustTierOf(concept)).toBe('machine-confirmed')
  })

  it('KS-31 主流程：普通笔记 → 写手补元数据 → 宿主盖章；读的是派写手之后的内容，generated 改回提交者', async () => {
    const h = makeTool({
      files: { [ABS]: PLAIN },
      review: async (req, _ctx, files) => {
        files.set(req.path, WRITER_VERSION)
        return { passed: true, report: 'Added type and description.', reviewer: REVIEWER }
      }
    })
    const res = await submit(h)
    expect(textOf(res).startsWith(`Confirmed: ${ABS}`)).toBe(true)
    expect(h.files.get(ABS)).toBe(
      doc(
        [
          'shuvix: okf v0.2',
          'type: Memory',
          'title: Plain',
          'description: dp',
          'status: stable',
          GENERATED_LINE,
          VERIFIED_LINE
        ],
        '# Plain\n\nbody'
      )
    )
  })

  it('KS-32 旧章处置：人工章保留在前、旧机器章被替换，只剩一条机器章；回读是机器确认', async () => {
    const T0 = '2026-09-01T00:00:00.000Z'
    const text = doc([
      'shuvix: okf v0.2',
      'type: Memory',
      'title: A',
      'description: da',
      `verified: [{ by: "human:alice", at: "${T0}" }, { by: "shuvix-knowledge-writer/old", at: "${T0}" }]`
    ])
    const h = makeTool({ files: { [ABS]: text } })
    await submit(h)
    const concept = parseConceptText(h.files.get(ABS)!, 'a.md')!
    expect(concept.verified).toEqual([
      { by: 'human:alice', at: T0 },
      { by: REVIEWER, at: NOW_ISO }
    ])
    expect(currentTrustTierOf(concept)).toBe('machine-confirmed')
  })

  it('KS-33 afterWrite：通过且文件真被改写 → 恰一次，参数只有 {bundleDir, path}（没有 title）与这次调用的 scope，排在落盘之后', async () => {
    const h = makeTool({ files: { [ABS]: ENTRY } })
    await h.invoke(
      { action: 'submit', base: 'project', path: 'a.md' },
      { callId: 'k33', taskId: 4, conversationId: 2 }
    )
    expect(h.afterWrite).toHaveBeenCalledTimes(1)
    expect(h.afterWrite).toHaveBeenCalledWith(
      { bundleDir: ROOT, path: 'a.md' },
      expect.objectContaining({ conversationId: 2, taskId: 4 })
    )
    expect(Object.keys(h.afterWrite.mock.calls[0][0]).sort()).toEqual(['bundleDir', 'path'])
    expect(h.calls.indexOf(`after:${ROOT}|a.md`)).toBeGreaterThan(h.calls.indexOf(`write:${ABS}`))
  })

  it('KS-34 没改就不写、不回调：同一时刻连交两次，第二次章已在位 —— 只写一次、回调一次，仍回 Confirmed', async () => {
    const h = makeTool({ files: { [ABS]: ENTRY } })
    await submit(h)
    const second = await submit(h)
    expect(textOf(second).startsWith(`Confirmed: ${ABS}`)).toBe(true)
    expect(h.calls.filter((c) => c === `write:${ABS}`)).toHaveLength(1)
    expect(h.afterWrite).toHaveBeenCalledTimes(1)
    expect(h.review).toHaveBeenCalledTimes(2)
  })

  it('KS-35 中止：已中止的 signal → reject 注入的 abortError、写手不派；写手期间中止 → 迟到的「通过」不算数', async () => {
    const aborted = new AbortController()
    aborted.abort()
    const h1 = makeTool({ files: { [ABS]: ENTRY }, abortError: 'TOOL_ABORTED' })
    await expect(
      h1.run('c1', { action: 'submit', base: 'project', path: 'a.md' }, aborted.signal)
    ).rejects.toThrow('TOOL_ABORTED')
    expect(h1.review).not.toHaveBeenCalled()

    const during = new AbortController()
    const h2 = makeTool({
      files: { [ABS]: ENTRY },
      abortError: 'TOOL_ABORTED',
      review: async () => {
        during.abort()
        return { passed: true, report: 'ok', reviewer: REVIEWER }
      }
    })
    await expect(
      h2.run('c2', { action: 'submit', base: 'project', path: 'a.md' }, during.signal)
    ).rejects.toThrow('TOOL_ABORTED')
    expect(h2.files.get(ABS)).toBe(ENTRY)
    expect(h2.calls.filter((c) => c.startsWith('write:'))).toEqual([])
    expect(h2.afterWrite).not.toHaveBeenCalled()
  })

  it('KS-36 [白盒] 写手判过但文件没了 → 失败（读文件的错误原文）；不写', async () => {
    const h = makeTool({
      files: { [ABS]: ENTRY },
      review: async (req, _ctx, files) => {
        files.delete(req.path)
        return { passed: true, report: 'ok', reviewer: REVIEWER }
      }
    })
    expect(await rejectionOf(submit(h))).toContain(`ENOENT: ${ABS}`)
    expect(h.calls.filter((c) => c.startsWith('write:'))).toEqual([])
    expect(h.afterWrite).not.toHaveBeenCalled()
  })

  it('KS-37 正文字节不动：正文里的 `---` 分隔线、`verified: fake` 原样；CRLF 文件里新插入的行也带 `\\r`', async () => {
    const head = ['---', 'shuvix: okf v0.2', 'type: Memory', 'title: A', 'description: da', '---']
    const body = ['', 'intro', '', '---', '', 'verified: fake', 'generated: nope', ''].join('\r\n')
    const text = `${head.join('\r\n')}\r\n${body}`
    const h = makeTool({ files: { [ABS]: text } })
    const res = await submit(h)
    expect(textOf(res).startsWith(`Confirmed: ${ABS}`)).toBe(true)
    const after = h.files.get(ABS)!
    // 第一处 `\r\n---\r\n` 就是闭合定界线（开栏那一行前面没有 `\r\n`）
    const tail = (s: string): string => s.slice(s.indexOf('\r\n---\r\n'))
    expect(tail(after)).toBe(tail(text))
    expect(after).toContain(`\r\n${GENERATED_LINE}\r\n${VERIFIED_LINE}\r\n---\r\n`)
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
      { action: 'submit', base: 'project', path: 'a.md' }
    ] as KnowledgeToolParams[]) {
      await expect(h.run('c1', params, ac.signal), params.action).rejects.toThrow('TOOL_ABORTED')
    }
    expectNothingHappened(h)
  })
})
