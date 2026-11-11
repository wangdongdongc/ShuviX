/**
 * createFileToolSuite 的 read × 文件库链接（`shuvix://file/<id>`，docs/file-library-design.md §9 / §15）——
 * securityCheck 与 executeInternal 两处的库分支（测试设计 docs/file-library-l1-tests.md §9.1，RD-1…8）。
 *
 * 套路同 fileToolSuiteAsk.test.ts：内存 port、真 createSecurityContext（内置策略经内联读取口读入，
 * env.host = desktop），requestUserInput 与审查接缝（onPermissionRequest）是 spy。宿主的库依赖
 * `deps.library` 由用例给：`match` 用真 parseLibraryLink，`describe` / `resolve` 是 spy。
 *
 * 库文件的 port 路径放在家目录里（`/fake-home/.shuvix/library/files/<两位>/<id>/…`）：同一个位置按普通路径
 * 读会撞外部目录门（ask-on-external-path#0），「没走路径门」因此看得出来（RD-1 的对照）。
 */

import { describe, it, expect, vi, afterEach, type Mock, type MockInstance } from 'vitest'
import type { InputRequest, InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import type { PermissionDecision } from '@shuvix/chat-protocol/types/permissionReview'
import { parseLibraryLink } from '@shuvix/chat-protocol/fileLibrary'
import type { FileSystemPort, FileGuards } from '../../fileTools/port'
import type {
  AccessMode,
  PermissionRequestEvent,
  PermissionReviewAnswer,
  SecurityContext,
  SecurityHostProvider
} from '../../security/types'
import { createSecurityContext } from '../../security/context'
import { clearSessionDecisions, getSessionDecisions } from '../../security/decisionLog'
import { clearReviewState } from '../../security/reviewState'
import {
  createFileToolSuite,
  type FileToolDeps,
  type FileToolSuite,
  type LibraryReadDeps,
  type ReadDecoders,
  type ReadTextDetection
} from '../fileToolSuite'
import { createInlinePolicyMdReader } from '../../security/builtinPolicies/inlineSources'
import { executeTool, failureText, resultText, type InvokedToolResult } from '../testing/invokeTool'

const INLINE_POLICY_MD = createInlinePolicyMdReader()

const ID = '0199d3a2-7b3e-7c4d-9a1f-2e5b8c7d6f10'
const ROOT = '/ws'
const HOME = '/fake-home'
/** 库里这件的目录（port 路径，家目录里） */
const ITEM_DIR = `${HOME}/.shuvix/library/files/01/${ID}`
const PNG_PATH = `${ITEM_DIR}/a.png`
const MD_PATH = `${ITEM_DIR}/a.md`
const PDF_PATH = `${ITEM_DIR}/a.pdf`
/** 内存 port 里的 PNG（字符串形式；detectText 认这个头判二进制） */
const PNG_BYTES = '\x89PNG\r\n\x1a\nIHDR'
const MD_TEXT = ['# Title', 'line two', 'line three', 'line four', 'line five'].join('\n')

const LINK_PNG = `shuvix://file/${ID}/a.png`
const ASK_COMMAND = `Read library file "a.png" (${ID})`

/** 图片解码器交回的结果（认得出是 readImage 交的） */
const IMAGE_RESULT = {
  content: [{ type: 'image' as const, data: 'iVBORw0KGgo=', mimeType: 'image/png' }],
  details: { type: 'read' as const, truncated: false }
}
/** 富文本解码器交回的结果 */
const RICH_RESULT = {
  content: [{ type: 'text' as const, text: '# PDF as markdown' }],
  details: { type: 'read' as const, truncated: false }
}

type ReviewSeam = (
  event: PermissionRequestEvent,
  signal?: AbortSignal
) => Promise<PermissionReviewAnswer | null>

const reviewAnswer = (decision: PermissionDecision): PermissionReviewAnswer => ({
  verdict: {
    decision,
    risk: 'low',
    summary: `summary: ${decision}`,
    reason: `reason: ${decision}`
  },
  source: 'auto-review'
})

interface LibraryHarness {
  suite: FileToolSuite
  files: Map<string, string>
  requestUserInput: Mock<(req: InputRequest) => Promise<InputResponse>>
  review: Mock<ReviewSeam>
  persistGrant: Mock<(mode: AccessMode, p: string) => void>
  library: {
    match: MockInstance<LibraryReadDeps['match']>
    describe: Mock<LibraryReadDeps['describe']>
    resolve: Mock<LibraryReadDeps['resolve']>
  }
  readImage: Mock<NonNullable<ReadDecoders['readImage']>>
  readRich: Mock<NonNullable<ReadDecoders['readRich']>>
  detectText: Mock<NonNullable<ReadDecoders['detectText']>>
  enforcePath: MockInstance<SecurityContext['enforcePath']>
  enforceLibrary: MockInstance<SecurityContext['enforceLibrary']>
  resolvePath: Mock<(p: string, mode: AccessMode) => string>
  recordRead: MockInstance<FileGuards['recordRead']>
  sid: string
}

/** 审查状态与决策日志都是进程级表（按会话分桶）：每个套件各用一个会话 id，用完清掉 */
const usedSids: string[] = []
let seq = 0
afterEach(() => {
  for (const sid of usedSids.splice(0)) {
    clearReviewState(sid)
    clearSessionDecisions(sid)
  }
})

interface HarnessOptions {
  /** describe 的答复（缺省 { name: 'a.png', linked: true }） */
  info?: { name: string; linked: boolean } | null
  /** resolve 的答复（缺省 PNG_PATH） */
  resolved?: string | null
  /** 询问卡片的回答（缺省允许） */
  respond?: (req: InputRequest) => InputResponse
  /** 审查接缝的回答（缺省 null = 没意见，照旧问人） */
  review?: ReviewSeam
  /** false = 不注入 deps.library（扩展端口径） */
  withLibrary?: boolean
}

function makeSuite(opts: HarnessOptions = {}): LibraryHarness {
  const sid = `library-read-${++seq}`
  usedSids.push(sid)
  const files = new Map<string, string>([
    [PNG_PATH, PNG_BYTES],
    [MD_PATH, MD_TEXT],
    [PDF_PATH, '%PDF-1.7 binary']
  ])

  const port: FileSystemPort = {
    stat: (p) => {
      const c = files.get(p)
      return Promise.resolve(
        c === undefined ? null : { isFile: true, isDirectory: false, size: c.length, mtimeMs: 1000 }
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
      files.set(p, content)
      return Promise.resolve()
    },
    readBytes: () => {
      throw new Error('not used')
    },
    readdir: () => Promise.resolve([]),
    readLink: () => Promise.resolve(null)
  }
  const readTimes = new Set<string>()
  const guards: FileGuards = {
    hasReadTime: (p) => readTimes.has(p),
    assertNotModifiedSinceRead: () => {},
    recordRead: (p) => void readTimes.add(p),
    withFileLock: (_p, fn) => fn()
  }
  const recordRead = vi.spyOn(guards, 'recordRead')

  const readImage = vi.fn<NonNullable<ReadDecoders['readImage']>>(async () => IMAGE_RESULT)
  const readRich = vi.fn<NonNullable<ReadDecoders['readRich']>>(async () => RICH_RESULT)
  // 照桌面的口径：二进制内容（这里是 PNG / PDF 的头）判 binary，其余交回 port 的行流
  const detectText = vi.fn<NonNullable<ReadDecoders['detectText']>>(
    async (p): Promise<ReadTextDetection> => {
      const c = files.get(p) ?? ''
      if (c.startsWith('\x89PNG') || c.startsWith('%PDF')) return { kind: 'binary' }
      return { kind: 'text', encoding: 'utf-8', readLines: () => port.readTextLines(p) }
    }
  )
  const decoders: ReadDecoders = {
    imageMimeByExt: { '.png': 'image/png', '.jpg': 'image/jpeg' },
    readImage,
    richExtensions: new Set(['.pdf']),
    readRich,
    detectText
  }

  const requestUserInput = vi.fn(
    async (req: InputRequest): Promise<InputResponse> =>
      opts.respond ? opts.respond(req) : { kind: 'ask', allowed: true }
  )
  const review = vi.fn<ReviewSeam>(opts.review ?? (async () => null))
  const persistGrant = vi.fn<(mode: AccessMode, p: string) => void>()

  // 桌面口径的 provider（同 fileToolSuiteAsk）：家目录 /fake-home 里、权限表外的读问（#0）
  const provider: SecurityHostProvider = {
    host: 'desktop',
    pathSep: '/',
    getVars: () => ({
      workspace: ROOT,
      toolResultsBase: '/nonexistent/tool_results',
      skillsDirs: [],
      knowledgeRoot: '/kb',
      knowledgeSessionDirs: [],
      home: HOME,
      systemDirs: [],
      aclRead: [ROOT],
      aclWrite: [ROOT]
    }),
    readBuiltinPolicyMd: INLINE_POLICY_MD,
    isDirectory: () => false,
    persistGrant,
    requestUserInput,
    onPermissionRequest: review
  }
  const security = createSecurityContext(
    { kind: 'agent', sessionId: sid, agentKind: 'root' },
    { host: 'desktop' },
    provider
  )
  const enforcePath = vi.spyOn(security, 'enforcePath')
  const enforceLibrary = vi.spyOn(security, 'enforceLibrary')
  const resolvePath = vi.fn((p: string, _mode: AccessMode) =>
    p.startsWith('/') ? p : `${ROOT}/${p}`
  )

  const libraryDeps = {
    match: (path: string): string | null => parseLibraryLink(path)?.itemId ?? null,
    describe: vi.fn<LibraryReadDeps['describe']>(() =>
      opts.info === undefined ? { name: 'a.png', linked: true } : opts.info
    ),
    resolve: vi.fn<LibraryReadDeps['resolve']>(() =>
      opts.resolved === undefined ? PNG_PATH : opts.resolved
    )
  }
  const match = vi.spyOn(libraryDeps, 'match')

  const deps: FileToolDeps = {
    port,
    guards,
    resolvePath,
    security,
    decoders,
    labels: { read: 'Read', write: 'Write', edit: 'Edit' },
    descriptions: { read: 'read', write: 'write', edit: 'edit' },
    ...(opts.withLibrary === false ? {} : { library: libraryDeps })
  }

  return {
    suite: createFileToolSuite(deps),
    files,
    requestUserInput,
    review,
    persistGrant,
    library: { match, describe: libraryDeps.describe, resolve: libraryDeps.resolve },
    readImage,
    readRich,
    detectText,
    enforcePath,
    enforceLibrary,
    resolvePath,
    recordRead,
    sid
  }
}

function askOf(req: InputRequest | undefined): Extract<InputRequest, { kind: 'ask' }> {
  if (req?.kind !== 'ask') throw new Error('expected an ask request')
  return req
}

const isImageResult = (res: InvokedToolResult): boolean =>
  res.isError !== true && res.content.some((block) => block.type === 'image')

describe('read × 文件库链接（fileToolSuite 的库分支）', () => {
  it('RD-1 有关联的库文件直接读（D4）：不弹卡、不审查；交给 readImage 的是库里那件的 port 路径；路径门一次都没问（对照：同一个位置按绝对路径读，撞外部目录门）', async () => {
    const h = makeSuite({ info: { name: 'a.png', linked: true } })

    const res = await executeTool(h.suite.read, 'rd-1', { path: LINK_PNG })

    expect(isImageResult(res)).toBe(true)
    expect(h.requestUserInput).not.toHaveBeenCalled()
    expect(h.review).not.toHaveBeenCalled()
    expect(h.readImage).toHaveBeenCalledTimes(1)
    expect(h.readImage.mock.calls[0]![0]).toBe(PNG_PATH)
    expect(h.readImage.mock.calls[0]![1]).toBe(LINK_PNG)
    expect(h.enforcePath).not.toHaveBeenCalled()
    expect(h.resolvePath).not.toHaveBeenCalled()
    expect(h.library.describe).toHaveBeenCalledWith(ID)
    expect(h.library.resolve).toHaveBeenCalledWith(ID)

    // 对照：库目录不在会话权限表里 —— 换成绝对路径来读，走路径门、问一次
    await executeTool(h.suite.read, 'rd-1b', { path: PNG_PATH })
    expect(h.enforcePath).toHaveBeenCalledTimes(1)
    expect(h.requestUserInput).toHaveBeenCalledTimes(1)
    expect(askOf(h.requestUserInput.mock.calls[0]![0]).command).toBe(`Read(${PNG_PATH})`)
    expect(h.review.mock.calls[0]![0].decision.winning).toBe('ask-on-external-path#0')
  })

  it('RD-2 无关联的问一次：卡片 command 是 Read library file "a.png" (ID)、toolName read，没有「允许并记住」；允许 → 图片结果', async () => {
    const h = makeSuite({ info: { name: 'a.png', linked: false } })

    const res = await executeTool(h.suite.read, 'rd-2', { path: LINK_PNG })

    expect(h.requestUserInput).toHaveBeenCalledTimes(1)
    const req = askOf(h.requestUserInput.mock.calls[0]![0])
    expect(req.command).toBe(ASK_COMMAND)
    expect(req.toolName).toBe('read')
    expect(req.id).toBe('rd-2')
    // 询问材料里没有记忆条目：会话权限表里没有库这一种行
    const event = h.review.mock.calls[0]![0]
    expect(event.decision.ask).toStrictEqual({ command: ASK_COMMAND })
    expect(event.decision.winning).toBe('ask-on-library-access#0')
    expect(isImageResult(res)).toBe(true)
    expect(h.readImage).toHaveBeenCalledTimes(1)
    expect(h.enforcePath).not.toHaveBeenCalled()
  })

  it('RD-2 允许时即使回了 rememberPath / remember，也什么都不记（没有记忆条目）', async () => {
    const h = makeSuite({
      info: { name: 'a.png', linked: false },
      respond: () => ({ kind: 'ask', allowed: true, extra: { rememberPath: true, remember: true } })
    })

    expect(isImageResult(await executeTool(h.suite.read, 'rd-2r', { path: LINK_PNG }))).toBe(true)
    expect(h.persistGrant).not.toHaveBeenCalled()
    expect(getSessionDecisions(h.sid)[0]!.userResponse).toBe('allowed')
  })

  it('RD-2 拒绝 → 工具失败，报 User denied reading library file "a.png" (ID)；readImage、resolve 都没被调', async () => {
    const h = makeSuite({
      info: { name: 'a.png', linked: false },
      respond: () => ({ kind: 'ask', allowed: false })
    })

    expect(await failureText(executeTool(h.suite.read, 'rd-2d', { path: LINK_PNG }))).toContain(
      `User denied reading library file "a.png" (${ID})`
    )
    expect(h.readImage).not.toHaveBeenCalled()
    expect(h.library.resolve).not.toHaveBeenCalled()
  })

  it('RD-3 自动审查接缝（§9）：无关联、审查放行 → 不弹卡，拿到图片结果；接缝收到的是库的询问', async () => {
    const h = makeSuite({
      info: { name: 'a.png', linked: false },
      review: async () => reviewAnswer('allow')
    })

    const res = await executeTool(h.suite.read, 'rd-3', { path: LINK_PNG })

    expect(h.review).toHaveBeenCalledTimes(1)
    const event = h.review.mock.calls[0]![0]
    expect(event.command).toBe(ASK_COMMAND)
    expect(event.toolCallId).toBe('rd-3')
    expect(event.decision).toMatchObject({ tier: 'ask', winning: 'ask-on-library-access#0' })
    expect(h.requestUserInput).not.toHaveBeenCalled()
    expect(isImageResult(res)).toBe(true)
  })

  it('RD-3 审查答 ask → 照常弹卡（卡上带审查意见）', async () => {
    const h = makeSuite({
      info: { name: 'a.png', linked: false },
      review: async () => reviewAnswer('ask')
    })

    const res = await executeTool(h.suite.read, 'rd-3a', { path: LINK_PNG })

    expect(h.review).toHaveBeenCalledTimes(1)
    expect(h.requestUserInput).toHaveBeenCalledTimes(1)
    const req = askOf(h.requestUserInput.mock.calls[0]![0])
    expect(req.command).toBe(ASK_COMMAND)
    expect(req.review).toMatchObject({ summary: 'summary: ask' })
    expect(isImageResult(res)).toBe(true)
  })

  it('RD-4 库分支只管 read：write / edit 收到 shuvix://file/… 时不问 match / describe，走普通路径（解析成工作区下的相对路径）', async () => {
    const h = makeSuite()

    await executeTool(h.suite.write, 'rd-4w', { path: LINK_PNG, content: 'x\n' })
    expect(h.library.match).not.toHaveBeenCalled()
    expect(h.library.describe).not.toHaveBeenCalled()
    expect(h.enforceLibrary).not.toHaveBeenCalled()
    expect(h.resolvePath).toHaveBeenCalledWith(LINK_PNG, 'write')
    expect(h.files.get(`${ROOT}/${LINK_PNG}`)).toBe('x\n')

    await executeTool(h.suite.edit, 'rd-4e', { path: LINK_PNG, oldText: 'x', newText: 'y' })
    expect(h.library.match).not.toHaveBeenCalled()
    expect(h.library.describe).not.toHaveBeenCalled()
    expect(h.enforceLibrary).not.toHaveBeenCalled()
    expect(h.files.get(`${ROOT}/${LINK_PNG}`)).toBe('y\n')
    // 库文件本身一个字节都没动，也没出现过库的询问
    expect(h.files.get(PNG_PATH)).toBe(PNG_BYTES)
    for (const [req] of h.requestUserInput.mock.calls) {
      expect(askOf(req).command.startsWith('Read library file')).toBe(false)
    }
  })

  it('RD-4 没注入 deps.library：read shuvix://file/ID/a.png 按普通相对路径处理 —— 不出现库询问，报 File not found', async () => {
    const h = makeSuite({ withLibrary: false })

    expect(await failureText(executeTool(h.suite.read, 'rd-4n', { path: LINK_PNG }))).toContain(
      `File not found: ${LINK_PNG}`
    )
    expect(h.resolvePath).toHaveBeenCalledWith(LINK_PNG, 'read')
    expect(h.enforceLibrary).not.toHaveBeenCalled()
    expect(h.requestUserInput).not.toHaveBeenCalled()
    expect(h.readImage).not.toHaveBeenCalled()
  })

  it('RD-5 按解析出的文件选解码器：不带文件名段的 shuvix://file/ID 指向 PNG → 图片结果，readImage 收到 ext .png', async () => {
    const h = makeSuite({ resolved: PNG_PATH })

    const res = await executeTool(h.suite.read, 'rd-5', { path: `shuvix://file/${ID}` })

    expect(isImageResult(res)).toBe(true)
    expect(h.readImage).toHaveBeenCalledTimes(1)
    expect(h.readImage.mock.calls[0]![0]).toBe(PNG_PATH)
    expect(h.readImage.mock.calls[0]![2]).toBe('.png')
    expect(h.detectText).not.toHaveBeenCalled()
  })

  it('RD-5 链接里写的是 x.txt、库里那件实际是 a.pdf → 走 readRich（文件名段在解析时忽略）', async () => {
    const h = makeSuite({ info: { name: 'a.pdf', linked: true }, resolved: PDF_PATH })
    const link = `shuvix://file/${ID}/x.txt`

    const res = await executeTool(h.suite.read, 'rd-5b', { path: link })

    expect(resultText(res)).toBe('# PDF as markdown')
    expect(h.readRich).toHaveBeenCalledTimes(1)
    expect(h.readRich.mock.calls[0]![0]).toBe(PDF_PATH)
    expect(h.readRich.mock.calls[0]![1]).toBe(link)
    expect(h.detectText).not.toHaveBeenCalled()
    expect(h.readImage).not.toHaveBeenCalled()
  })

  it('RD-6 resolve 回 null（删了、在回收站、文件不在）→ 报 Library file not found (deleted or missing): <path>；有关联的不问', async () => {
    const h = makeSuite({ info: { name: 'a.png', linked: true }, resolved: null })

    const msg = await failureText(executeTool(h.suite.read, 'rd-6', { path: LINK_PNG }))

    expect(msg).toContain(`Library file not found (deleted or missing): ${LINK_PNG}`)
    expect(h.requestUserInput).not.toHaveBeenCalled()
    expect(h.review).not.toHaveBeenCalled()
    expect(h.readImage).not.toHaveBeenCalled()
    expect(h.resolvePath).not.toHaveBeenCalled()
  })

  it('RD-6 伪造的 id（describe 回 null）：不弹询问卡、不审查、不记决策，直接报 not found（§15）', async () => {
    const h = makeSuite({ info: null, resolved: null })

    const msg = await failureText(executeTool(h.suite.read, 'rd-6f', { path: LINK_PNG }))

    expect(msg).toContain(`Library file not found (deleted or missing): ${LINK_PNG}`)
    expect(h.enforceLibrary).not.toHaveBeenCalled()
    expect(h.requestUserInput).not.toHaveBeenCalled()
    expect(h.review).not.toHaveBeenCalled()
    expect(getSessionDecisions(h.sid)).toEqual([])
    expect(h.readImage).not.toHaveBeenCalled()
  })

  it('RD-7 库里的文本文件 a.md：按行号读出，offset / limit 生效；recordRead 记的是库的 port 路径', async () => {
    const h = makeSuite({ info: { name: 'a.md', linked: true }, resolved: MD_PATH })
    const link = `shuvix://file/${ID}/a.md`

    const res = await executeTool(h.suite.read, 'rd-7', { path: link, offset: 2, limit: 2 })

    const text = resultText(res)
    expect(res.isError).not.toBe(true)
    expect(text.startsWith(`File: ${link} (5 lines,`)).toBe(true)
    expect(text).toContain('Showing: lines 2-3')
    expect(text).toContain('2│line two')
    expect(text).toContain('3│line three')
    expect(text).not.toContain('│# Title')
    expect(text).not.toContain('│line four')
    expect(text).toContain('Use offset=4 to continue.')
    expect(h.recordRead).toHaveBeenCalledTimes(1)
    expect(h.recordRead).toHaveBeenCalledWith(MD_PATH)
    expect(h.detectText).toHaveBeenCalledWith(MD_PATH, MD_TEXT.length)
  })

  it('RD-8 决策日志：恰记一条 —— objectKind library、摘要 library ID、action read；交给门面的客体是 {itemId, name, linked}', async () => {
    const h = makeSuite({ info: { name: 'a.png', linked: true } })

    await executeTool(h.suite.read, 'rd-8', { path: LINK_PNG })

    const records = getSessionDecisions(h.sid)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      sessionId: h.sid,
      toolCallId: 'rd-8',
      toolName: 'read',
      action: 'read',
      objectKind: 'library',
      objectSummary: `library ${ID}`,
      effect: 'allow',
      tool: { name: 'read' }
    })
    expect(h.enforceLibrary).toHaveBeenCalledTimes(1)
    expect(h.enforceLibrary.mock.calls[0]![0]).toStrictEqual({
      itemId: ID,
      name: 'a.png',
      linked: true
    })
    expect(h.enforceLibrary.mock.calls[0]![1]).toMatchObject({
      toolCallId: 'rd-8',
      toolName: 'read',
      displayPath: LINK_PNG
    })
  })

  it('RD-8 无关联那一次：交给策略的客体恰是 {type: library, itemId, name, linked}；日志一条，ask / allowed', async () => {
    const h = makeSuite({ info: { name: 'a.png', linked: false } })

    await executeTool(h.suite.read, 'rd-8b', { path: LINK_PNG })

    expect(h.review.mock.calls[0]![0].request.object).toStrictEqual({
      type: 'library',
      itemId: ID,
      name: 'a.png',
      linked: false
    })
    expect(h.review.mock.calls[0]![0].request.action).toBe('read')
    const records = getSessionDecisions(h.sid)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      action: 'read',
      objectKind: 'library',
      objectSummary: `library ${ID}`,
      effect: 'ask',
      winning: 'ask-on-library-access#0',
      userResponse: 'allowed'
    })
  })
})
