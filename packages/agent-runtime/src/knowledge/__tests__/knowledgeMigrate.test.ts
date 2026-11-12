/**
 * knowledge 工具的迁移（2026-11-11，docs/project-split-design.md §5）—— 拆分项目时把**另一个项目的项目库**里的条目迁进
 * 本会话的库。两样东西：
 *
 *   - `project` 参数：`list` / `search` / `read` 带上它，看的是那个项目的库（只读地看，宿主先过一次读门）；
 *   - `migrate`：宿主读出点名条目的原文交给**目标库**的管理员（模型不重抄），它逐条决定收不收并交回 `taken`（收下的，
 *     按原路径）；宿主给它动过的条目盖章，再只把 `taken` 里的从源库删掉，源库里因此断掉的链接只报告。
 *
 *   KM-1..KM-5    带 `project` 的读侧：三种动作的表头与内容、读门恰过一次且是 read、不碰本会话的库；`base` 的冲突、
 *                 管理员不许用、宿主不支持、解析失败（list / search 回文字，read 是失败）、被拒
 *   KM-10..KM-12  migrate 的准入与先后：管理员自己、缺 project / entries / base、目标库解析失败 / 只读、宿主不支持、
 *                 源库解析失败、两头同一个库、一条都不在册、超过条数 / 字节上限 —— 都在过门与派管理员之前
 *   KM-20..KM-22  交给管理员的请求：字段恰好（content 为空串、migration 带源库标签与每条的原路径 + 原文）；名字的
 *                 几种写法、文件夹展开、去重；写门恰过一次（write、带一句给人看的说明），先门后管理员
 *   KM-30..KM-36  结论的分支：没跑成 / 不收 → 源库不动；只删 `taken` 点名且确是这次交过去的；省了 `.md` 也认；
 *                 删不掉的、没找到的各自列出；目标库的条目照 submit 盖章；断链只报告；报告里的库目录换成条目名
 *   KM-40..KM-43  review.ts 的那一半：迁移的任务文本（不带源库目录、每条一个 `<entry>` 围栏）、迁移的结果契约
 *                 （多一项必填的 taken；提交的契约没有它）、`taken` 的读法
 *
 * 失败一律是 isError 结果（BaseTool 裁定 Q12）。
 */
import { describe, it, expect, vi, type Mock } from 'vitest'
import { invokeTool, type InvokedToolResult } from '../../tools/testing/invokeTool'
import { validateContractSchema } from '../../subagent/nextTool'
import type { FileSystemPort } from '../../fileTools/port'
import type { ToolCallScope } from '../../tools/toolCall'
import { readKnowledgeNote, type KnowledgeConcept, type KnowledgeNote } from '../conceptFile'
import {
  createKnowledgeTool,
  KNOWLEDGE_DESCRIPTION,
  KNOWLEDGE_MIGRATE_MAX_ENTRIES,
  KnowledgeParamsSchema,
  type KnowledgeAdminRun,
  type KnowledgeBundleTarget,
  type KnowledgeProjectBaseAccess,
  type KnowledgeToolParams
} from '../knowledgeTool'
import {
  KNOWLEDGE_ADMIN_CONTRACT,
  KNOWLEDGE_MIGRATION_CONTRACT,
  buildKnowledgeAdminPrompt,
  readKnowledgeAdminResult,
  type KnowledgeAdminOutcome,
  type KnowledgeSubmission
} from '../review'
import { isProjectionFile, isReservedFile, type BundleFile } from '../validate'

const TARGET_DIR = '/kb/projects/auth'
const SOURCE_DIR = '/kb/projects/big'
const TARGET: KnowledgeBundleTarget = { dir: TARGET_DIR, label: 'project "Auth"' }
const SOURCE: KnowledgeBundleTarget = { dir: SOURCE_DIR, label: 'project "Big"' }
const FROM = 'the base of project "Big"'
const NOW = new Date('2026-11-11T08:00:00.000Z')
const NOW_ISO = NOW.toISOString()
const ACTOR = 'shuvix-work/gpt-5'
const ADMIN = 'shuvix-knowledge-writer/haiku'

const entry = (title: string, body = 'body'): string =>
  [
    '---',
    'shuvix: okf v0.2',
    'type: Memory',
    `title: ${title}`,
    `description: about ${title}`,
    'status: stable',
    '---',
    '',
    body,
    ''
  ].join('\n')

const LOGIN = entry('Login flow', 'See [refresh](/auth/token-refresh.md).')
const REFRESH = entry('Token refresh')
const RELEASE = entry(
  'Release steps',
  'Auth notes: [login](/auth/login.md) and [refresh](token.md).'
)
const OVERVIEW = entry('Overview', 'Start at [login](auth/login.md).')

/** 源库：auth/ 下两条、根上两条 */
const SOURCE_FILES: Record<string, string> = {
  [`${SOURCE_DIR}/auth/login.md`]: LOGIN,
  [`${SOURCE_DIR}/auth/token-refresh.md`]: REFRESH,
  [`${SOURCE_DIR}/release.md`]: RELEASE,
  [`${SOURCE_DIR}/overview.md`]: OVERVIEW
}

type AdminCtx = Parameters<KnowledgeAdminRun>[1]
type AdminImpl = (
  req: KnowledgeSubmission,
  ctx: AdminCtx,
  files: Map<string, string>
) => Promise<KnowledgeAdminOutcome>

/** 把交来的条目原样写进目标库同名位置、全部收下的管理员 */
const takesAll: AdminImpl = async (req, _ctx, files) => {
  const moved = req.migration?.entries ?? []
  for (const e of moved) files.set(`${req.bundleDir}/${e.entry}`, e.text)
  return {
    accepted: true,
    entries: moved.map((e) => ({ entry: e.entry, change: 'created' as const })),
    taken: moved.map((e) => e.entry),
    report: 'took them as they are',
    admin: ADMIN
  }
}

interface Options {
  files?: Record<string, string>
  target?: KnowledgeBundleTarget | { error: string }
  source?: KnowledgeBundleTarget | { error: string }
  admin?: AdminImpl | null
  isAdmin?: boolean
  /** 宿主不注入这几样（扩展端） */
  without?: Array<'resolveProjectBase' | 'removeEntries'>
  authorize?: (
    target: KnowledgeBundleTarget,
    access: 'read' | 'write',
    ctx: KnowledgeProjectBaseAccess
  ) => Promise<void>
  /** 删不掉的条目 → 原因 */
  stuck?: Record<string, string>
}

interface Harness {
  files: Map<string, string>
  resolveBase: Mock
  resolveProjectBase: Mock
  authorize: Mock
  removeEntries: Mock
  admin: Mock
  scan: Mock
  afterWrite: Mock
  /** 先后流水：`authorize:<access>` / `admin` / `write:<abs>` / `remove:<a,b>` */
  calls: string[]
  run: (params: KnowledgeToolParams, signal?: AbortSignal) => Promise<InvokedToolResult>
}

const textOf = (res: InvokedToolResult): string => (res.content[0] as { text: string }).text
const failure = (p: Promise<InvokedToolResult>): Promise<string> =>
  p.then((res) => {
    if (res.isError !== true) throw new Error(`expected the call to fail, got: ${textOf(res)}`)
    return textOf(res)
  })

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
    if (!rel.endsWith('.md')) continue
    all.push({ path: rel, text })
    if (isProjectionFile(rel, text)) continue
    const note = readKnowledgeNote(text, rel, { entry: !isReservedFile(rel) })
    notes.push(note)
    if (note.concept) concepts.push(note.concept)
  }
  return { files: all, concepts, notes }
}

function rig(opts: Options = {}): Harness {
  const files = new Map(Object.entries(opts.files ?? SOURCE_FILES))
  const calls: string[] = []
  const port: FileSystemPort = {
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
    async *readTextLines() {
      /* not used */
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
    readLink: () => Promise.resolve(null)
  }
  const resolveBase = vi.fn(async (_base: string) => opts.target ?? TARGET)
  const resolveProjectBase = vi.fn(async (_project: string) => opts.source ?? SOURCE)
  const authorize = vi.fn(
    async (
      target: KnowledgeBundleTarget,
      access: 'read' | 'write',
      ctx: KnowledgeProjectBaseAccess
    ) => {
      calls.push(`authorize:${access}`)
      await opts.authorize?.(target, access, ctx)
    }
  )
  const removeEntries = vi.fn(async (source: KnowledgeBundleTarget, entries: readonly string[]) => {
    calls.push(`remove:${entries.join(',')}`)
    const failed: Array<{ entry: string; reason: string }> = []
    for (const e of entries) {
      const why = opts.stuck?.[e]
      if (why) failed.push({ entry: e, reason: why })
      else files.delete(`${source.dir}/${e}`)
    }
    return failed
  })
  const impl = opts.admin === undefined ? takesAll : opts.admin
  const admin = vi.fn(async (req: KnowledgeSubmission, ctx: AdminCtx) => {
    calls.push('admin')
    return impl!(req, ctx, files)
  })
  const scan = vi.fn((bundleDir: string) => Promise.resolve(scanOf(files, bundleDir)))
  const afterWrite = vi.fn()
  const without = new Set(opts.without ?? [])
  const tool = createKnowledgeTool({
    port,
    scan,
    resolveBase,
    listBases: async () => [],
    actor: (_call: ToolCallScope | undefined) => ACTOR,
    now: () => NOW,
    admin: impl === null ? undefined : admin,
    isAdmin: () => opts.isAdmin === true,
    afterWrite,
    resolveProjectBase: without.has('resolveProjectBase') ? undefined : resolveProjectBase,
    authorizeProjectBase: authorize,
    removeEntries: without.has('removeEntries') ? undefined : removeEntries,
    abortError: 'Aborted',
    label: 'Knowledge'
  })
  return {
    files,
    resolveBase,
    resolveProjectBase,
    authorize,
    removeEntries,
    admin,
    scan,
    afterWrite,
    calls,
    run: async (params, signal) =>
      (await invokeTool(tool, params, { callId: 'call-1', signal })).result
  }
}

const MIGRATE: KnowledgeToolParams = {
  action: 'migrate',
  project: 'Big',
  base: 'project',
  entries: ['/auth/login.md', '/auth/token-refresh.md']
}

// ─── 带 `project` 的读侧 ─────────────────────────────────────────────────────────

describe('KM-1..KM-5 读另一个项目的库（project 参数）', () => {
  it('KM-1 list / search / read：看的是那个项目的库，表头点名「the base of project "Big"」，读门恰过一次（read、没有说明）；本会话的库没被解析', async () => {
    const h = rig()
    const listed = textOf(await h.run({ action: 'list', project: 'Big' }))
    expect(listed.split('\n')[0]).toBe(`4 entries in ${FROM}:`)
    expect(listed).toContain('- /auth/login.md')
    expect(listed).toContain('- /release.md')
    expect(h.resolveProjectBase).toHaveBeenCalledWith('Big')
    expect(h.authorize).toHaveBeenCalledTimes(1)
    const [target, access, ctx] = h.authorize.mock.calls[0]
    expect(target).toBe(SOURCE)
    expect(access).toBe('read')
    expect(ctx).toMatchObject({ toolCallId: 'call-1' })
    expect(ctx.purpose).toBeUndefined()
    expect(h.resolveBase).not.toHaveBeenCalled()

    const found = textOf(await h.run({ action: 'search', project: 'Big', query: 'token' }))
    expect(found.split('\n')[0]).toBe(`1 result(s) for "token" in ${FROM}:`)
    expect(found).toContain('- /auth/token-refresh.md')
    expect(
      textOf(await h.run({ action: 'search', project: 'Big', query: 'nothing-like-this' }))
    ).toBe(`No entries match "nothing-like-this" in ${FROM}.`)

    const read = textOf(await h.run({ action: 'read', project: 'Big', entry: '/auth/login.md' }))
    expect(read.split('\n')[0]).toBe(`Entry /auth/login.md in ${FROM} — 9 lines`)
    expect(read).toContain('title: Login flow')
    // `base: "project"` 写上也一样：它这时指的就是那个项目自己的库
    expect(
      textOf(await h.run({ action: 'read', project: 'Big', base: 'project', entry: 'auth/login' }))
    ).toContain('title: Login flow')
    expect(h.resolveBase).not.toHaveBeenCalled()
    // 读侧一个字不写、不派管理员、不删
    expect(h.calls.filter((c) => !c.startsWith('authorize:'))).toEqual([])
    // 没有任何一处输出带库目录
    for (const out of [listed, found, read]) {
      expect(out).not.toContain(SOURCE_DIR)
      expect(out).not.toContain('/kb/')
    }
  })

  it('KM-2 `project` 顶替 `base`：一起写了别的 base 也照 project 的来（不报错）；管理员自己不许用 —— 不解析、不过门', async () => {
    const h = rig()
    const out = textOf(await h.run({ action: 'list', project: 'Big', base: 'notes' }))
    expect(out.split('\n')[0]).toBe(`4 entries in ${FROM}:`)
    expect(h.resolveBase).not.toHaveBeenCalled()

    const librarian = rig({ isAdmin: true })
    expect(await failure(librarian.run({ action: 'list', project: 'Big' }))).toBe(
      'You are the librarian: work only inside the base the task names.'
    )
    expect(librarian.resolveProjectBase).not.toHaveBeenCalled()
    expect(librarian.authorize).not.toHaveBeenCalled()
  })

  it('KM-3 宿主不支持 / 项目解析不出：list 与 search 回文字（软条件），read 是失败；都不过门、不扫描', async () => {
    const unsupported = rig({ without: ['resolveProjectBase'] })
    const NOT_HERE = "Another project's knowledge base cannot be read on this host."
    expect(textOf(await unsupported.run({ action: 'list', project: 'Big' }))).toBe(NOT_HERE)
    expect(await failure(unsupported.run({ action: 'read', project: 'Big', entry: '/a.md' }))).toBe(
      NOT_HERE
    )

    const unknown = rig({ source: { error: 'No project is named "Nope".' } })
    expect(textOf(await unknown.run({ action: 'list', project: 'Nope' }))).toBe(
      'No project is named "Nope".'
    )
    expect(textOf(await unknown.run({ action: 'search', project: 'Nope', query: 'x' }))).toBe(
      'No project is named "Nope".'
    )
    expect(await failure(unknown.run({ action: 'read', project: 'Nope', entry: '/a.md' }))).toBe(
      'No project is named "Nope".'
    )
    for (const each of [unsupported, unknown]) {
      expect(each.authorize).not.toHaveBeenCalled()
      expect(each.scan).not.toHaveBeenCalled()
    }
  })

  it('KM-4 读门被拒：失败，文案是宿主给的那句；没有扫描', async () => {
    const h = rig({
      authorize: async () => {
        throw new Error('User denied access to the knowledge base of project "Big"')
      }
    })
    expect(await failure(h.run({ action: 'list', project: 'Big' }))).toBe(
      'User denied access to the knowledge base of project "Big"'
    )
    expect(h.scan).not.toHaveBeenCalled()
  })

  it('KM-5 read 缺 entry：先报缺参，不解析、不过门；不在册的名字点名那个项目的库', async () => {
    const h = rig()
    expect(await failure(h.run({ action: 'read', project: 'Big' }))).toContain(
      '"read" needs `entry`'
    )
    expect(h.resolveProjectBase).not.toHaveBeenCalled()
    expect(await failure(h.run({ action: 'read', project: 'Big', entry: '/nope.md' }))).toBe(
      `No entry /nope.md in ${FROM} — "search" or "list" it for the right name`
    )
  })
})

// ─── migrate：准入 ───────────────────────────────────────────────────────────────

describe('KM-10..KM-12 migrate 的准入', () => {
  const untouched = (h: Harness): void => {
    expect(h.authorize).not.toHaveBeenCalled()
    expect(h.admin).not.toHaveBeenCalled()
    expect(h.removeEntries).not.toHaveBeenCalled()
    expect(h.calls).toEqual([])
  }

  it('KM-10 管理员自己、缺 project / entries / base：各有一句，什么都没发生', async () => {
    const librarian = rig({ isAdmin: true })
    expect(await failure(librarian.run(MIGRATE))).toContain('You are the librarian')
    untouched(librarian)

    const h = rig()
    expect(await failure(h.run({ ...MIGRATE, project: '  ' }))).toBe(
      '"migrate" needs `project` — the project whose base the entries come from'
    )
    for (const entries of [undefined, [], ['  ', '']]) {
      expect(await failure(h.run({ ...MIGRATE, entries }))).toContain('"migrate" needs `entries`')
    }
    expect(await failure(h.run({ ...MIGRATE, base: undefined }))).toContain(
      '"migrate" needs `base`'
    )
    untouched(h)
    expect(h.resolveProjectBase).not.toHaveBeenCalled()
  })

  it('KM-11 目标库解析失败 / 只读、宿主不支持、源库解析失败、两头同一个库', async () => {
    const noTarget = rig({
      target: { error: '"x" is not one of this session\'s knowledge bases.' }
    })
    // 目标库不对：宿主那句之后补一句「条目只能迁进本会话自己的库；别的项目的库要从那个项目的会话里发起」
    const HINT =
      '"migrate" brings entries into one of this session\'s own bases ("bases" lists them). To bring them into another project\'s base, the user asks from a session of that project.'
    expect(await failure(noTarget.run(MIGRATE))).toBe(
      `"x" is not one of this session's knowledge bases. ${HINT}`
    )
    const readonly = rig({ target: { ...TARGET, readonly: true } })
    expect(await failure(readonly.run(MIGRATE))).toBe(
      `"project" is read-only — it is ShuviX's own reference, shipped with the app. ${HINT}`
    )

    for (const h of [
      rig({ admin: null }),
      rig({ without: ['resolveProjectBase'] }),
      rig({ without: ['removeEntries'] })
    ]) {
      expect(await failure(h.run(MIGRATE))).toBe(
        'Migrating knowledge entries is not available on this host'
      )
      untouched(h)
    }

    const noSource = rig({ source: { error: 'No project is named "Big".' } })
    expect(await failure(noSource.run(MIGRATE))).toBe('No project is named "Big".')
    const same = rig({ source: { dir: `${TARGET_DIR}/`, label: 'project "Auth"' } })
    expect(await failure(same.run(MIGRATE))).toBe(
      'The base of project "Auth" is base "project" itself — there is nothing to migrate.'
    )
    for (const h of [noTarget, readonly, noSource, same]) untouched(h)
  })

  it('KM-12 一条都不在册、超过条数上限、超过字节上限：都在过门之前', async () => {
    const h = rig()
    expect(await failure(h.run({ ...MIGRATE, entries: ['/nope.md', '../x.md'] }))).toBe(
      `None of these is an entry in ${FROM}: /nope.md, ../x.md — "list" it with \`project\` for the right names`
    )
    untouched(h)

    const many = Object.fromEntries(
      Array.from({ length: KNOWLEDGE_MIGRATE_MAX_ENTRIES + 1 }, (_, i) => [
        `${SOURCE_DIR}/bulk/e${i}.md`,
        entry(`E${i}`)
      ])
    )
    const crowded = rig({ files: many })
    expect(await failure(crowded.run({ ...MIGRATE, entries: ['/bulk'] }))).toBe(
      `That is ${KNOWLEDGE_MIGRATE_MAX_ENTRIES + 1} entries; one "migrate" takes at most ${KNOWLEDGE_MIGRATE_MAX_ENTRIES}. Bring them over in several calls.`
    )
    untouched(crowded)

    const heavy = rig({ files: { [`${SOURCE_DIR}/big.md`]: entry('Big', 'x'.repeat(210 * 1024)) } })
    expect(await failure(heavy.run({ ...MIGRATE, entries: ['/big.md'] }))).toContain(
      'one "migrate" takes at most 200.0KB'
    )
    untouched(heavy)
  })
})

// ─── migrate：交给管理员的请求 ─────────────────────────────────────────────────────

describe('KM-20..KM-22 交给管理员的请求', () => {
  it('KM-20 请求字段恰好：content 为空串，migration 带源库标签（不是目录）与每条的原路径 + 原文；写门恰过一次、带说明，先门后管理员后删', async () => {
    const h = rig()
    await h.run(MIGRATE)
    expect(h.admin).toHaveBeenCalledTimes(1)
    const [req, ctx] = h.admin.mock.calls[0]
    expect(req).toEqual({
      base: 'project',
      label: 'project "Auth"',
      bundleDir: TARGET_DIR,
      content: '',
      submittedBy: ACTOR,
      migration: {
        from: 'project "Big"',
        entries: [
          { entry: 'auth/login.md', text: LOGIN },
          { entry: 'auth/token-refresh.md', text: REFRESH }
        ]
      }
    })
    expect(JSON.stringify(req)).not.toContain(SOURCE_DIR)
    expect(ctx).toMatchObject({ toolCallId: 'call-1' })

    expect(h.authorize).toHaveBeenCalledTimes(1)
    const [target, access, access_ctx] = h.authorize.mock.calls[0]
    expect(target).toBe(SOURCE)
    expect(access).toBe('write')
    expect(access_ctx.purpose).toBe(
      'Migrate 2 knowledge entries from project "Big" into base "project" (project "Auth"). The ones the librarian takes in are removed from project "Big".'
    )
    expect(h.calls[0]).toBe('authorize:write')
    expect(h.calls[1]).toBe('admin')
    expect(h.calls[h.calls.length - 1]).toBe('remove:auth/login.md,auth/token-refresh.md')
  })

  it('KM-21 名字的几种写法：带不带前导 /、省掉 .md、反斜杠；文件夹 = 它底下的每一条；去重、保序', async () => {
    const h = rig()
    await h.run({
      ...MIGRATE,
      entries: ['release', '/auth', 'auth\\login.md', '/release.md', ' /overview.md ']
    })
    const [req] = h.admin.mock.calls[0]
    expect(req.migration.entries.map((e: { entry: string }) => e.entry)).toEqual([
      'release.md',
      'auth/login.md',
      'auth/token-refresh.md',
      'overview.md'
    ])
    expect(h.authorize.mock.calls[0][2].purpose).toContain('Migrate 4 knowledge entries')

    // `/` = 整个库（`.`、`./` 同）；`..` 不算
    for (const root of ['/', '.', './']) {
      const whole = rig()
      await whole.run({ ...MIGRATE, entries: [root] })
      expect(
        whole.admin.mock.calls[0][0].migration.entries.map((e: { entry: string }) => e.entry).sort()
      ).toEqual(['auth/login.md', 'auth/token-refresh.md', 'overview.md', 'release.md'])
    }
    const up = rig()
    expect(await failure(up.run({ ...MIGRATE, entries: ['..'] }))).toContain(
      'None of these is an entry'
    )
  })

  it('KM-22 单数的说明；写门被拒 → 失败，管理员不派、不删；中止在门后 → 以中止收尾', async () => {
    const one = rig()
    await one.run({ ...MIGRATE, entries: ['/release.md'] })
    expect(one.authorize.mock.calls[0][2].purpose).toContain('Migrate 1 knowledge entry from')

    const denied = rig({
      authorize: async () => {
        throw new Error('User denied access to the knowledge base of project "Big"')
      }
    })
    expect(await failure(denied.run(MIGRATE))).toBe(
      [
        'User denied access to the knowledge base of project "Big"',
        `That was the permission to change ${FROM}: migrated entries are removed from it. Nothing was migrated; do not try again unless the user asks.`
      ].join('\n')
    )
    expect(denied.admin).not.toHaveBeenCalled()
    expect(denied.removeEntries).not.toHaveBeenCalled()

    const controller = new AbortController()
    const aborted = rig({
      authorize: async () => {
        controller.abort()
      }
    })
    await expect(aborted.run(MIGRATE, controller.signal)).rejects.toThrow('Aborted')
    expect(aborted.admin).not.toHaveBeenCalled()
  })
})

// ─── migrate：结论的分支 ──────────────────────────────────────────────────────────

describe('KM-30..KM-36 管理员的结论', () => {
  it('KM-30 全部收下：目标库有了这两条（照 submit 盖章），源库里删掉，结果逐段列出', async () => {
    const h = rig()
    const out = textOf(await h.run(MIGRATE))
    expect(out).toBe(
      [
        `Migrated into base "project" from ${FROM}:`,
        '- /auth/login.md (created)',
        '- /auth/token-refresh.md (created)',
        '',
        `Removed from ${FROM}: /auth/login.md, /auth/token-refresh.md.`,
        `Links in ${FROM} that now point at removed entries:`,
        '- /release.md → /auth/login.md',
        '- /overview.md → /auth/login.md',
        '',
        'took them as they are'
      ].join('\n')
    )
    // 源库：只剩没点名的两条
    expect([...h.files.keys()].filter((k) => k.startsWith(SOURCE_DIR)).sort()).toEqual([
      `${SOURCE_DIR}/overview.md`,
      `${SOURCE_DIR}/release.md`
    ])
    // 目标库：两条都在，章是 submit 那一套（generated = 发起迁移的 agent，verified = 管理员）
    for (const rel of ['auth/login.md', 'auth/token-refresh.md']) {
      const text = h.files.get(`${TARGET_DIR}/${rel}`)!
      expect(text).toContain(`generated: { by: "${ACTOR}", at: "${NOW_ISO}" }`)
      expect(text).toContain(`verified: { by: "${ADMIN}", at: "${NOW_ISO}" }`)
    }
    expect(h.afterWrite).toHaveBeenCalledTimes(2)
    expect(h.removeEntries).toHaveBeenCalledWith(
      SOURCE,
      ['auth/login.md', 'auth/token-refresh.md'],
      expect.objectContaining({ movedTo: 'project "Auth"' })
    )
    expect(out).not.toContain('/kb/')
  })

  it('KM-31 管理员没跑成：失败，说明源库没动；不盖章、不删', async () => {
    const h = rig({ admin: async () => ({ error: `it crashed in ${TARGET_DIR}/x.md` }) })
    expect(await failure(h.run(MIGRATE))).toBe(
      `The knowledge librarian could not take the entries: it crashed in /x.md. Nothing was removed from ${FROM}.`
    )
    expect(h.removeEntries).not.toHaveBeenCalled()
    expect(h.files.has(`${SOURCE_DIR}/auth/login.md`)).toBe(true)
  })

  it('KM-32 一条都不收（accepted: false）：不是失败；源库不动 —— 即便它在 taken 里写了名字', async () => {
    const h = rig({
      admin: async () => ({
        accepted: false,
        entries: [],
        taken: ['auth/login.md'],
        report: 'these belong to the old project',
        admin: ADMIN
      })
    })
    const res = await h.run(MIGRATE)
    expect(res.isError).not.toBe(true)
    expect(textOf(res)).toBe(
      [
        `Nothing was migrated into base "project"; the entries stay in ${FROM}.`,
        '',
        'these belong to the old project'
      ].join('\n')
    )
    expect(h.removeEntries).not.toHaveBeenCalled()
  })

  it('KM-33 只删 taken 点名且确是这次交过去的：没点名的留在源库并列出；省了 .md 的名字也认；不是这次交过去的名字不删', async () => {
    const h = rig({
      admin: async (req, _ctx, files) => {
        files.set(`${req.bundleDir}/auth/session.md`, entry('Session (merged)'))
        return {
          accepted: true,
          entries: [{ entry: 'auth/session.md', change: 'created' }],
          // 省了 .md；另点了一条根本没交过去的
          taken: ['auth/login', 'release.md'],
          report: 'merged login into /auth/session.md',
          admin: ADMIN
        }
      }
    })
    const out = textOf(await h.run(MIGRATE))
    expect(h.removeEntries).toHaveBeenCalledWith(SOURCE, ['auth/login.md'], expect.anything())
    expect(out).toContain(`Removed from ${FROM}: /auth/login.md.`)
    expect(out).toContain(
      `Left in ${FROM} (the librarian did not take them): /auth/token-refresh.md.`
    )
    // 没交过去的 release.md 原样在源库
    expect(h.files.has(`${SOURCE_DIR}/release.md`)).toBe(true)
    expect(h.files.has(`${SOURCE_DIR}/auth/token-refresh.md`)).toBe(true)
  })

  it('KM-34 收了但 taken 是空的（或没给）：什么都不删，结果明说', async () => {
    for (const taken of [[], undefined]) {
      const h = rig({
        admin: async () => ({
          accepted: true,
          entries: [],
          ...(taken ? { taken } : {}),
          report: 'nothing new here',
          admin: ADMIN
        })
      })
      const out = textOf(await h.run(MIGRATE))
      expect(out).toContain(`Nothing was removed from ${FROM}.`)
      expect(out).toContain(
        `Left in ${FROM} (the librarian did not take them): /auth/login.md, /auth/token-refresh.md.`
      )
      expect(h.removeEntries).not.toHaveBeenCalled()
    }
  })

  it('KM-35 没找到的名字、删不掉的条目各自列出；断链只算真删掉的那几条', async () => {
    const h = rig({ stuck: { 'auth/login.md': 'could not be deleted (EACCES)' } })
    const out = textOf(await h.run({ ...MIGRATE, entries: [...MIGRATE.entries!, '/nope.md'] }))
    expect(out).toContain(`Removed from ${FROM}: /auth/token-refresh.md.`)
    expect(out).toContain(`Not found in ${FROM}: /nope.md.`)
    expect(out).toContain(
      `Taken in but still in ${FROM}: /auth/login.md (could not be deleted (EACCES)).`
    )
    // login 还在源库：指向它的链接没断；指向 token-refresh 的那一条（login 自己的正文）断了
    expect(out).toContain(`Links in ${FROM} that now point at removed entries:`)
    expect(out).toContain('- /auth/login.md → /auth/token-refresh.md')
    expect(out).not.toContain('→ /auth/login.md')
  })

  it('KM-36 没有断链就没有那一段；管理员报告里的库目录换成条目名的写法', async () => {
    const h = rig({
      admin: async (req, ctx, files) => ({
        ...(await takesAll(req, ctx, files)),
        report: `filed under ${TARGET_DIR}/auth/`
      })
    })
    const out = textOf(await h.run({ ...MIGRATE, entries: ['/overview.md'] }))
    expect(out).not.toContain('Links in')
    expect(out.split('\n').pop()).toBe('filed under /auth/')
    expect(out).not.toContain(TARGET_DIR)
  })
})

// ─── review.ts 的那一半 ───────────────────────────────────────────────────────────

describe('KM-40..KM-43 迁移的任务文本、结果契约与读法', () => {
  const REQ: KnowledgeSubmission = {
    base: 'project',
    label: 'project "Auth"',
    bundleDir: TARGET_DIR,
    content: '',
    submittedBy: ACTOR,
    migration: {
      from: 'project "Big"',
      entries: [
        { entry: 'auth/login.md', text: `${LOGIN}\n\n` },
        { entry: '/release.md', text: RELEASE }
      ]
    }
  }

  it('KM-40 任务文本逐行：一句任务 + 库（带目录）/ 来源（标签，不是目录）/ 发起者 + 每条一个 <entry> 围栏（原路径、原文去尾空白）', () => {
    expect(
      buildKnowledgeAdminPrompt({ ...REQ, sessionId: 's-1', workingDirectory: '/work/auth' })
    ).toBe(
      [
        'Take these entries into the knowledge base. They are being migrated from another base: each one you take in is removed from there afterwards.',
        '',
        `- Base: "project" (project "Auth") — directory ${TARGET_DIR}`,
        '- They come from: the base of project "Big"',
        `- Migrated by: ${ACTOR}`,
        '',
        'Entries (2), each with the path it had there:',
        '',
        '<entry path="/auth/login.md">',
        LOGIN.trimEnd(),
        '</entry>',
        '',
        '<entry path="/release.md">',
        RELEASE.trimEnd(),
        '</entry>'
      ].join('\n')
    )
  })

  it('KM-41 迁移的任务文本不带提交那几行：没有 Submission、工作目录、会话出处；源库的目录从不出现', () => {
    const text = buildKnowledgeAdminPrompt({
      ...REQ,
      sessionId: 's-1',
      workingDirectory: '/work/auth'
    })
    for (const gone of ['Submission:', 'Working directory', 'shuvix://session/', SOURCE_DIR]) {
      expect(text, gone).not.toContain(gone)
    }
    // 没有 migration 的请求照旧是提交的任务文本
    expect(buildKnowledgeAdminPrompt({ ...REQ, migration: undefined, content: 'c' })).toContain(
      'Record this submission in the knowledge base.'
    )
  })

  it('KM-42 迁移的结果契约：schema 合法，四个必填（多一项 taken），不收别的键；提交的契约没有 taken', () => {
    expect(validateContractSchema(KNOWLEDGE_MIGRATION_CONTRACT.schema)).toBeNull()
    const schema = KNOWLEDGE_MIGRATION_CONTRACT.schema as {
      required: string[]
      additionalProperties: boolean
      properties: Record<string, { type: string; items?: { type: string } }>
    }
    expect(schema.required).toEqual(['accepted', 'entries', 'taken', 'report'])
    expect(schema.additionalProperties).toBe(false)
    expect(Object.keys(schema.properties)).toEqual(['accepted', 'entries', 'taken', 'report'])
    expect(schema.properties.taken).toMatchObject({ type: 'array', items: { type: 'string' } })
    expect(KNOWLEDGE_MIGRATION_CONTRACT.sourceLabel).toBe('knowledge migrate')
    const submit = KNOWLEDGE_ADMIN_CONTRACT.schema as { properties: Record<string, unknown> }
    expect(Object.keys(submit.properties)).toEqual(['accepted', 'entries', 'report'])
  })

  it('KM-43 taken 的读法：归一成库内相对路径、去重、丢掉不是字符串与空的；不是数组 → 没有这一项', () => {
    const read = (taken: unknown): string[] | undefined =>
      readKnowledgeAdminResult({ accepted: true, entries: [], report: 'r', taken })?.taken
    expect(read(['/auth/login.md', ' auth\\login.md ', '//x.md', 3, '', '  '])).toEqual([
      'auth/login.md',
      'x.md'
    ])
    expect(read([])).toEqual([])
    expect(read(undefined)).toBeUndefined()
    expect(read('auth/login.md')).toBeUndefined()
    expect(
      Object.keys(readKnowledgeAdminResult({ accepted: true, entries: [], report: 'r' })!)
    ).toEqual(['accepted', 'entries', 'report'])
  })
})

// ─── 给模型的文案 ────────────────────────────────────────────────────────────────

describe('KM-50 给 agent 的文案', () => {
  it('KM-50 描述讲 migrate 的三个参数、「不要重抄正文」、收下的会从那边删掉，以及带 `project` 读另一个项目的库；参数说明各归其位', () => {
    for (const phrase of [
      '- "migrate":',
      '`project` is the project they come from',
      '`entries` their paths there',
      '`base` where they go (a name from "bases")',
      'do not copy their text',
      "removed from the other project's base",
      'pass `project` with "list", "search" or "read" in place of `base`',
      'The user is asked before'
    ]) {
      expect(KNOWLEDGE_DESCRIPTION, phrase).toContain(phrase)
    }
    const props = KnowledgeParamsSchema.properties as unknown as Record<
      string,
      { description?: string; type?: string }
    >
    expect(props.project.description).toContain('takes the place of `base`')
    expect(props.entries.type).toBe('array')
    expect(props.entries.description).toContain(`at most ${KNOWLEDGE_MIGRATE_MAX_ENTRIES}`)
    expect(props.entries.description).toContain(
      'a folder path takes every entry under it, and "/" is the whole base'
    )
  })
})
