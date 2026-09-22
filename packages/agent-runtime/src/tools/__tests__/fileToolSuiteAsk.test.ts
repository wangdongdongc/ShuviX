/**
 * createFileToolSuite 的询问接线单测 —— 内存 port + 可编程 SecurityHostProvider（requestUserInput 是 spy）。
 *
 * 关注点在「工具壳怎么问」：写类工具把询问推迟到 apply 层（一次调用只弹一张带 diff 预览的卡），
 * 放行短路（工作目录读 / 免询问 / allowList，经统一评估的 force-allow/static-allow 层）逐层生效，
 * 以及 InputResponse 判别联合的五个分支。
 *
 * 组 7（SYM）问的是门之前的那一步：路径本身是符号链接（port.readLink 答非 null）就不跟 —— 抛一句
 * 说明它指向哪里，门不问、卡不弹、port 一个字节都不读写。链接由假 port 的 `links` 表给出
 * （port 路径 → readLink 的答复），真文件系统上的那一半在桌面的 nodeFileSystemPort.test /
 * writeAskWiring.test。「门没被问」看 enforcePath 的 spy 与决策日志（每次 enforce 都记一条）。
 */

import { describe, it, expect, vi, beforeEach, type Mock, type MockInstance } from 'vitest'
import type { InputRequest, InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import type { FileSystemPort, FileGuards } from '../../fileTools/port'
import type { AccessMode, SecurityContext, SecurityHostProvider } from '../../security/types'
import { createSecurityContext } from '../../security/context'
import { clearSessionDecisions, getSessionDecisions } from '../../security/decisionLog'
import {
  createFileToolSuite,
  type FileToolDeps,
  type FileToolSuite,
  type ReadDecoders
} from '../fileToolSuite'
import { createInlinePolicyMdReader } from '@shuvix/agent-runtime/security/builtinPolicies/inlineSources'

/** 内置策略 md 的构建期内联读取口（真实装配链要它；测试进程，不进桌面 bundle） */
const INLINE_POLICY_MD = createInlinePolicyMdReader()

/** 套件的会话 id（决策日志按它分桶） */
const SID = 'test-session'
const ROOT = '/ws'
const INSIDE = 'notes.txt'
const INSIDE_ABS = '/ws/notes.txt'
// 原则反转后读取默认放行；触发 read 询问卡要用带内置 ask 门的凭据路径（home 见 provider vars）
const CREDENTIAL_ABS = '/fake-home/.ssh/secret.txt'

/** 桌面口径的允许清单条目文案（decision.ask.command 的期望形态） */
const allowEntry = (mode: AccessMode, p: string): string =>
  `${mode === 'write' ? 'Write' : 'Read'}(${p})`

interface SuiteOptions {
  files?: Record<string, string>
  autoAllow?: boolean
  /** 会话 allowList 条目（`Read(...)` / `Write(...)` 字面值；默认空） */
  allowList?: string[]
  /** 不传 = 无询问通道（模拟无前端） */
  respond?: (req: InputRequest) => InputResponse | Promise<InputResponse>
  abortError?: string
  /** 曾经是知识库会话摘要目录的豁免清单（策略已撤）；保留为普通变量，默认空 */
  knowledgeSessionDirs?: string[]
  /** OKF 写钩子的知识库注入（不传 = 扩展端口径：根目录下的 md 与普通 md 无异） */
  knowledge?: FileToolDeps['knowledge']
  /** port 路径 → 它是符号链接时 readLink 的答复；表外 = 不是链接（null）。表是活的，用例可中途改 */
  links?: Record<string, LinkInfo>
  /** false = port 不带 readLink（扩展端口径：没有符号链接可言）；缺省带 */
  withReadLink?: boolean
  /** read 的内容解码器（URL / 相似路径建议…）；缺省不注入 */
  decoders?: ReadDecoders
}

/** port.readLink 的非 null 答复 */
interface LinkInfo {
  target: string
  resolved: string
}

interface SuiteHarness {
  suite: FileToolSuite
  files: Map<string, string>
  requests: InputRequest[]
  requestUserInput?: Mock<(req: InputRequest) => Promise<InputResponse>>
  persistGrant: Mock<(mode: AccessMode, p: string) => void>
  onFileChange: Mock<(e: { portPath: string; kind: 'write' | 'edit' }) => void>
  readTimes: Set<string>
  /** 与 opts.links 同一个对象（用例改它 = 改盘上的链接） */
  links: Record<string, LinkInfo>
  port: FileSystemPort
  /** port.readLink 的 spy；withReadLink:false 时没有 */
  readLink?: MockInstance<(p: string) => Promise<LinkInfo | null>>
  resolvePath: Mock<(p: string, mode: AccessMode) => string>
  /** 门面 enforcePath 的 spy（照常调真实现，只记实参） */
  enforcePath: MockInstance<SecurityContext['enforcePath']>
  /** port / guards 各方法的 spy（照常调真实现，只记实参） */
  spies: {
    stat: MockInstance<FileSystemPort['stat']>
    readFile: MockInstance<FileSystemPort['readFile']>
    readTextLines: MockInstance<FileSystemPort['readTextLines']>
    readBytes: MockInstance<FileSystemPort['readBytes']>
    readdir: MockInstance<FileSystemPort['readdir']>
    writeFile: MockInstance<FileSystemPort['writeFile']>
    withFileLock: MockInstance<(p: string, fn: () => Promise<unknown>) => Promise<unknown>>
    recordRead: MockInstance<FileGuards['recordRead']>
  }
}

function makeSuite(opts: SuiteOptions = {}): SuiteHarness {
  const files = new Map(Object.entries(opts.files ?? {}))
  const readTimes = new Set<string>()
  const requests: InputRequest[] = []
  const links = opts.links ?? {}

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
    ...(opts.withReadLink === false
      ? {}
      : { readLink: (p: string) => Promise.resolve(links[p] ?? null) })
  }

  // 并发串行由 applyAsk.test.ts 覆盖；这里只关心询问接线
  const guards: FileGuards = {
    hasReadTime: (p) => readTimes.has(p),
    assertNotModifiedSinceRead: () => {},
    recordRead: (p) => void readTimes.add(p),
    withFileLock: (_p, fn) => fn()
  }
  const spies: SuiteHarness['spies'] = {
    stat: vi.spyOn(port, 'stat'),
    readFile: vi.spyOn(port, 'readFile'),
    readTextLines: vi.spyOn(port, 'readTextLines'),
    readBytes: vi.spyOn(port, 'readBytes'),
    readdir: vi.spyOn(port, 'readdir'),
    writeFile: vi.spyOn(port, 'writeFile'),
    withFileLock: vi.spyOn(guards, 'withFileLock'),
    recordRead: vi.spyOn(guards, 'recordRead')
  }
  const readLink = port.readLink ? vi.spyOn(port, 'readLink') : undefined

  const requestUserInput = opts.respond
    ? vi.fn(async (req: InputRequest): Promise<InputResponse> => {
        requests.push(req)
        return opts.respond!(req)
      })
    : undefined

  const persistGrant = vi.fn<(mode: AccessMode, p: string) => void>()
  const onFileChange = vi.fn<(e: { portPath: string; kind: 'write' | 'edit' }) => void>()

  // 桌面口径的 provider：workspace={{ROOT}}（内置 workspace-boundary 策略给出目录内只读放行），
  // 写入一律走询问链；allowList/autoAllow 进 force-allow 层
  const provider: SecurityHostProvider = {
    host: 'desktop',
    pathSep: '/',
    getVars: () => ({
      workspace: ROOT,
      toolResultsBase: '/nonexistent/tool_results',
      skillsDirs: [],
      memoryDirs: [],
      knowledgeRoot: '/kb',
      knowledgeSessionDirs: opts.knowledgeSessionDirs ?? [],
      home: '/fake-home',
      systemDirs: []
    }),
    readBuiltinPolicyMd: INLINE_POLICY_MD,
    getSessionGrants: () => ({
      autoAllow: !!opts.autoAllow,
      allowList: opts.allowList ?? []
    }),
    isDirectory: () => false,
    persistGrant,
    requestUserInput
  }
  const security = createSecurityContext(
    { kind: 'agent', sessionId: SID, agentKind: 'root' },
    { host: 'desktop' },
    provider
  )
  const enforcePath = vi.spyOn(security, 'enforcePath')
  const resolvePath = vi.fn((p: string, _mode: AccessMode) =>
    p.startsWith('/') ? p : `${ROOT}/${p}`
  )

  const deps: FileToolDeps = {
    port,
    guards,
    resolvePath,
    security,
    decoders: opts.decoders,
    abortError: opts.abortError,
    labels: { read: 'Read', write: 'Write', edit: 'Edit' },
    descriptions: { read: 'read', write: 'write', edit: 'edit' },
    onFileChange,
    knowledge: opts.knowledge
  }

  return {
    suite: createFileToolSuite(deps),
    files,
    requests,
    requestUserInput,
    persistGrant,
    onFileChange,
    readTimes,
    links,
    port,
    readLink,
    resolvePath,
    enforcePath,
    spies
  }
}

const allowed = (): InputResponse => ({ kind: 'ask', allowed: true })

// ─── 组 1：一次写入只弹一张卡，且卡里带预览 ──────────────────────────────────

describe('文件工具套件 — 询问请求的次数与形状', () => {
  it('CONS-11: 一次 write 只触发一次 requestUserInput（不先弹路径卡再弹预览卡）', async () => {
    const h = makeSuite({ respond: allowed })
    await h.suite.write.execute('call-1', { path: INSIDE, content: 'hello\n' })
    expect(h.requestUserInput).toHaveBeenCalledTimes(1)
  })

  it('CONS-11: 一次 edit 只触发一次 requestUserInput', async () => {
    const h = makeSuite({ files: { [INSIDE_ABS]: 'alpha\nbeta\n' }, respond: allowed })
    await h.suite.edit.execute('call-2', { path: INSIDE, oldText: 'beta', newText: 'BETA' })
    expect(h.requestUserInput).toHaveBeenCalledTimes(1)
  })

  it('CONS-12: write 的询问请求形状（id/toolName/command/preview 全对齐）', async () => {
    const h = makeSuite({ respond: allowed })
    const res = await h.suite.write.execute('call-3', { path: INSIDE, content: 'hello\n' })

    const req = h.requests[0]
    expect(req.kind).toBe('ask')
    expect(req.id).toBe('call-3')
    expect(req.toolName).toBe('write')
    if (req.kind !== 'ask') throw new Error('expected an ask request')
    expect(req.command).toBe(allowEntry('write', INSIDE_ABS))
    expect(req.preview).toMatchObject({ kind: 'diff', path: INSIDE, isNewFile: true })
    // 卡片里的 diff 就是 tool result 里的那一份
    expect(req.preview?.diff).toBe(
      (res.details as { type: 'write'; diff: string; isNewFile: boolean }).diff
    )
  })

  it('CONS-12: edit 的询问请求形状（toolName=edit，预览路径取展示路径）', async () => {
    const h = makeSuite({ files: { [INSIDE_ABS]: 'alpha\nbeta\n' }, respond: allowed })
    await h.suite.edit.execute('call-4', { path: INSIDE, oldText: 'beta', newText: 'BETA' })

    const req = h.requests[0]
    if (req.kind !== 'ask') throw new Error('expected an ask request')
    expect(req.toolName).toBe('edit')
    expect(req.command).toBe(allowEntry('write', INSIDE_ABS))
    expect(req.preview).toMatchObject({ kind: 'diff', path: INSIDE })
    expect(req.preview?.isNewFile).toBeUndefined()
  })

  it('PERM-10: read 的询问请求不带 preview（凭据目录读取门触发）', async () => {
    const h = makeSuite({ files: { [CREDENTIAL_ABS]: 'secret\n' }, respond: allowed })
    await h.suite.read.execute('call-5', { path: CREDENTIAL_ABS })

    const req = h.requests[0]
    if (req.kind !== 'ask') throw new Error('expected an ask request')
    expect(req.toolName).toBe('read')
    expect(req.preview).toBeUndefined()
    expect(req.command).toBe(allowEntry('read', CREDENTIAL_ABS))
  })

  it('PERM-10b: 工作区外读取经内置 ask-on-read 门弹询问；允许后照常读取', async () => {
    const h = makeSuite({ files: { '/outside/gated.txt': 'hello\n' }, respond: allowed })
    const res = await h.suite.read.execute('call-6', { path: '/outside/gated.txt' })
    expect(h.requestUserInput).toHaveBeenCalledTimes(1)
    const req = h.requests[0]
    if (req.kind !== 'ask') throw new Error('expected an ask request')
    expect(req.command).toBe(allowEntry('read', '/outside/gated.txt'))
    expect((res.content[0] as { text: string }).text).toContain('hello')
  })
})

// ─── 组 2：工作目录写入收紧 + 放行短路 ───────────────────────────────────────

describe('文件工具套件 — 放行短路', () => {
  it('PERM-2: 工作目录内 write 会弹窗，同路径 read 不弹', async () => {
    const h = makeSuite({ files: { [INSIDE_ABS]: 'alpha\n' }, respond: allowed })

    await h.suite.read.execute('r1', { path: INSIDE })
    expect(h.requestUserInput).not.toHaveBeenCalled()

    await h.suite.write.execute('w1', { path: INSIDE, content: 'beta\n' })
    expect(h.requestUserInput).toHaveBeenCalledTimes(1)
  })

  it('PERM-3: 会话免询问 → 不弹窗、照常写入、details.diff 仍完整', async () => {
    const h = makeSuite({ autoAllow: true, respond: allowed })
    const res = await h.suite.write.execute('w2', { path: INSIDE, content: 'one\ntwo\n' })

    expect(h.requestUserInput).not.toHaveBeenCalled()
    expect(h.files.get(INSIDE_ABS)).toBe('one\ntwo\n')
    const details = res.details as { diff: string; isNewFile: boolean }
    expect(details.diff.split('\n')).toEqual(['+1 one', '+2 two'])
    expect(details.isNewFile).toBe(true)
  })

  it('PERM-4: allowList 命中 Write(abs) → 不弹窗', async () => {
    const h = makeSuite({ allowList: [`Write(${INSIDE_ABS})`], respond: allowed })
    await h.suite.write.execute('w3', { path: INSIDE, content: 'hi\n' })

    expect(h.requestUserInput).not.toHaveBeenCalled()
    expect(h.files.get(INSIDE_ABS)).toBe('hi\n')
  })

  it('PERM-4: 只有 Read(abs) 条目时 write 仍弹窗（读权限不隐含写权限）', async () => {
    const h = makeSuite({ allowList: [`Read(${INSIDE_ABS})`], respond: allowed })
    await h.suite.write.execute('w4', { path: INSIDE, content: 'hi\n' })

    expect(h.requestUserInput).toHaveBeenCalledTimes(1)
  })

  it('PERM-5: 允许 + rememberPath → persistGrant 一次；拒绝时不调用', async () => {
    const remember = makeSuite({
      respond: () => ({ kind: 'ask', allowed: true, extra: { rememberPath: true } })
    })
    await remember.suite.write.execute('w5', { path: INSIDE, content: 'hi\n' })
    expect(remember.persistGrant).toHaveBeenCalledTimes(1)
    expect(remember.persistGrant).toHaveBeenCalledWith('write', INSIDE_ABS)

    const denied = makeSuite({
      respond: () => ({ kind: 'ask', allowed: false, extra: { rememberPath: true } })
    })
    await expect(
      denied.suite.write.execute('w6', { path: INSIDE, content: 'hi\n' })
    ).rejects.toThrow()
    expect(denied.persistGrant).not.toHaveBeenCalled()
  })

  it('PERM-7: 无询问通道时目录内 write 被拒，read 仍放行', async () => {
    const h = makeSuite({ files: { [INSIDE_ABS]: 'alpha\n' } })

    await expect(h.suite.write.execute('w7', { path: INSIDE, content: 'x\n' })).rejects.toThrow(
      `Access denied: path outside workspace and no way to ask: ${INSIDE}`
    )
    expect(h.files.get(INSIDE_ABS)).toBe('alpha\n')

    const read = await h.suite.read.execute('r2', { path: INSIDE })
    expect((read.content[0] as { text: string }).text).toContain('alpha')
  })
})

// ─── 组 3：InputResponse 判别联合 ────────────────────────────────────────────

describe('文件工具套件 — InputResponse 分支', () => {
  it('RESP-1: allowed:true → 写入发生', async () => {
    const h = makeSuite({ respond: allowed })
    await h.suite.write.execute('resp1', { path: INSIDE, content: 'yes\n' })
    expect(h.files.get(INSIDE_ABS)).toBe('yes\n')
  })

  it('RESP-2: allowed:false 无 reason → 抛 User denied access to <displayPath>，文件不变', async () => {
    const h = makeSuite({
      files: { [INSIDE_ABS]: 'old\n' },
      respond: () => ({ kind: 'ask', allowed: false })
    })
    await expect(
      h.suite.write.execute('resp2', { path: INSIDE, content: 'new\n' })
    ).rejects.toThrow(`User denied access to ${INSIDE}`)
    expect(h.files.get(INSIDE_ABS)).toBe('old\n')
  })

  it('RESP-3: allowed:false 带 reason → 抛该 reason', async () => {
    const h = makeSuite({
      respond: () => ({ kind: 'ask', allowed: false, reason: '这个文件别动' })
    })
    await expect(
      h.suite.write.execute('resp3', { path: INSIDE, content: 'new\n' })
    ).rejects.toThrow('这个文件别动')
  })

  it('RESP-4: kind:other → 抛含 provided feedback instead 的错误，且无任何副作用', async () => {
    const h = makeSuite({
      files: { [INSIDE_ABS]: 'old\n' },
      respond: () => ({ kind: 'other', text: '改另一个文件吧' })
    })

    await expect(
      h.suite.write.execute('resp4', { path: INSIDE, content: 'new\n' })
    ).rejects.toThrow(/provided feedback instead: 改另一个文件吧/)
    expect(h.files.get(INSIDE_ABS)).toBe('old\n')
    expect(h.persistGrant).not.toHaveBeenCalled()
    expect(h.readTimes.has(INSIDE_ABS)).toBe(false)
  })

  it.each([['Aborted'], ['TOOL_ABORTED']])(
    'RESP-5: kind:cancel → 抛注入的 abortError（%s），写入未发生',
    async (abortError) => {
      const h = makeSuite({
        files: { [INSIDE_ABS]: 'old\n' },
        abortError,
        respond: () => ({ kind: 'cancel', reason: 'aborted' })
      })
      await expect(
        h.suite.write.execute('resp5', { path: INSIDE, content: 'new\n' })
      ).rejects.toThrow(abortError)
      expect(h.files.get(INSIDE_ABS)).toBe('old\n')
    }
  )

  it('RESP-6: 非法 kind → 走未允许分支抛错，绝不放行', async () => {
    const h = makeSuite({
      files: { [INSIDE_ABS]: 'old\n' },
      respond: () => ({ kind: 'choice', selections: ['yes'] })
    })
    await expect(
      h.suite.write.execute('resp6', { path: INSIDE, content: 'new\n' })
    ).rejects.toThrow(`User denied access to ${INSIDE}`)
    expect(h.files.get(INSIDE_ABS)).toBe('old\n')
  })
})

// ─── 组 5：回归 ─────────────────────────────────────────────────────────────

describe('文件工具套件 — 文件变更回调', () => {
  it('REG-4: write/edit 成功后 onFileChange 带 kind 触发', async () => {
    const h = makeSuite({ files: { [INSIDE_ABS]: 'alpha\nbeta\n' }, respond: allowed })

    await h.suite.edit.execute('c1', { path: INSIDE, oldText: 'beta', newText: 'BETA' })
    expect(h.onFileChange).toHaveBeenCalledWith({ portPath: INSIDE_ABS, kind: 'edit' })

    await h.suite.write.execute('c2', { path: INSIDE, content: 'fresh\n' })
    expect(h.onFileChange).toHaveBeenCalledWith({ portPath: INSIDE_ABS, kind: 'write' })
    expect(h.onFileChange).toHaveBeenCalledTimes(2)
  })

  it('REG-4: 被拒 / 被中止时 onFileChange 不触发', async () => {
    const denied = makeSuite({ respond: () => ({ kind: 'ask', allowed: false }) })
    await expect(
      denied.suite.write.execute('c3', { path: INSIDE, content: 'x\n' })
    ).rejects.toThrow()
    expect(denied.onFileChange).not.toHaveBeenCalled()

    const cancelled = makeSuite({ respond: () => ({ kind: 'cancel', reason: 'aborted' }) })
    await expect(
      cancelled.suite.write.execute('c4', { path: INSIDE, content: 'x\n' })
    ).rejects.toThrow('Aborted')
    expect(cancelled.onFileChange).not.toHaveBeenCalled()
  })
})

// ─── 组 6：OKF 知识库写钩子（deps.knowledge） ────────────────────────────────

describe('文件工具套件 — OKF 知识库写钩子（deps.knowledge）', () => {
  const DRAFT = [
    '---',
    'type: Memory',
    'title: T',
    'description: d',
    'status: draft',
    '---',
    '',
    'body',
    ''
  ].join('\n')
  const textOf = (res: { content: unknown[] }): string => (res.content[0] as { text: string }).text

  it('FS-1 bundle 内的合法概念落盘后盖 generated（actor 惰性、每次写现取）、回执 [OKF] Stamped，onFileChange 恰一次；bundle 外无回执', async () => {
    const actor = vi.fn(() => 'shuvix-work/m1')
    // 免询问下无需通道即可写（知识库上已无任何内置策略）
    const h = makeSuite({
      autoAllow: true,
      knowledgeSessionDirs: ['/kb/sessions'],
      // 宿主答「这份文件属于哪个 bundle、在它里面是什么相对路径」；bundle 外返回 null
      knowledge: { locate: (p) => (p.startsWith('/kb/') ? p.slice('/kb/'.length) : null), actor }
    })

    const res = await h.suite.write.execute('k1', { path: '/kb/sessions/x.md', content: DRAFT })
    expect(h.files.get('/kb/sessions/x.md')).toContain('generated: { by: "shuvix-work/m1", at: "')
    expect(textOf(res)).toContain('[OKF] Stamped generated')
    expect(actor).toHaveBeenCalledTimes(1)
    // 广播在盖章回写之后、且只有一次 —— 面板刷新读到的是最终内容
    expect(h.onFileChange).toHaveBeenCalledTimes(1)
    expect(h.onFileChange).toHaveBeenCalledWith({ portPath: '/kb/sessions/x.md', kind: 'write' })

    // 模型中途切换：actor 每次写现取
    actor.mockReturnValue('shuvix-work/m2')
    await h.suite.write.execute('k2', { path: '/kb/sessions/y.md', content: DRAFT })
    expect(actor).toHaveBeenCalledTimes(2)
    expect(h.files.get('/kb/sessions/y.md')).toContain('generated: { by: "shuvix-work/m2", at: "')

    const outside = await h.suite.write.execute('k3', { path: '/ws/notes.md', content: DRAFT })
    expect(textOf(outside)).not.toContain('[OKF]')
    expect(h.files.get('/ws/notes.md')).toBe(DRAFT)
  })

  it('FS-2 不注入 deps.knowledge：同一文件只是普通 markdown（不盖章、无回执）', async () => {
    const h = makeSuite({ autoAllow: true, knowledgeSessionDirs: ['/kb/sessions'] })
    const res = await h.suite.write.execute('k1', { path: '/kb/sessions/x.md', content: DRAFT })
    expect(h.files.get('/kb/sessions/x.md')).toBe(DRAFT)
    expect(textOf(res)).not.toContain('[OKF]')
    expect(h.onFileChange).toHaveBeenCalledTimes(1)
  })
})

// ─── 组 7：路径本身是符号链接 —— 不跟，只说出它指向哪里 ──────────────────────

/** 抓住一次拒绝的原话（没拒就判红） */
async function messageOf(work: Promise<unknown>): Promise<string> {
  try {
    await work
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
  throw new Error('expected the call to be refused')
}

/** 取出一次询问（不是 ask 就判红） */
function askOf(req: InputRequest | undefined): Extract<InputRequest, { kind: 'ask' }> {
  if (req?.kind !== 'ask') throw new Error('expected an ask request')
  return req
}

describe('文件工具套件 — 路径本身是符号链接：不跟（port.readLink）', () => {
  /** 工作区里一条指向私钥的链接：R 本身归凭据门管（read 询问 / write 拒绝） */
  const KEY_REAL = '/fake-home/.ssh/id_rsa'
  const keyLink = (): Record<string, LinkInfo> => ({
    '/ws/key': { target: KEY_REAL, resolved: KEY_REAL }
  })
  /** 工作区外的一个真文件（写它要问） */
  const OUT = '/outside/target.txt'
  const textOf = (res: { content: unknown[] }): string => (res.content[0] as { text: string }).text

  // 决策日志是模块级的：每条用例从空桶起，「门没被问」才看得出来
  beforeEach(() => clearSessionDecisions(SID))

  it('SYM-1 read 一条链接：原话说出它指向哪里（D 照写、R 取 readLink 的 resolved）；readLink 恰一次、问的是 port 路径；门不问、卡不弹、port 一个字节都不读、不落读取时间', async () => {
    // 放行的应答器：没弹卡不是因为被拒
    const h = makeSuite({
      files: { [KEY_REAL]: 'PRIVATE KEY\n' },
      links: keyLink(),
      respond: allowed
    })

    expect(await messageOf(h.suite.read.execute('s1', { path: 'key' }))).toBe(
      `key is a symbolic link to ${KEY_REAL}. Symbolic links are not followed — read ${KEY_REAL} directly if that is the file you mean.`
    )
    expect(h.readLink?.mock.calls).toEqual([['/ws/key']])
    expect(h.enforcePath).not.toHaveBeenCalled()
    expect(getSessionDecisions(SID)).toEqual([])
    expect(h.requestUserInput).not.toHaveBeenCalled()
    for (const [name, spy] of Object.entries(h.spies)) expect(spy, name).not.toHaveBeenCalled()
    expect(h.readTimes.size).toBe(0)
  })

  it('SYM-2 write 一条链接：原话以 Not written 起头；一个字节都没写 —— 不加锁、不 stat、不 writeFile，门不问、卡不弹、不广播变更、不记读取时间', async () => {
    const h = makeSuite({
      files: { [OUT]: 'old\n' },
      links: { '/ws/wlink': { target: OUT, resolved: OUT } },
      respond: allowed
    })

    expect(await messageOf(h.suite.write.execute('s2', { path: 'wlink', content: 'new\n' }))).toBe(
      `Not written: wlink is a symbolic link to ${OUT}. Symbolic links are not followed — write to ${OUT} directly if that is the file you mean.`
    )
    expect([...h.files]).toEqual([[OUT, 'old\n']])
    for (const [name, spy] of Object.entries(h.spies)) expect(spy, name).not.toHaveBeenCalled()
    expect(h.enforcePath).not.toHaveBeenCalled()
    expect(getSessionDecisions(SID)).toEqual([])
    expect(h.requestUserInput).not.toHaveBeenCalled()
    expect(h.onFileChange).not.toHaveBeenCalled()
    expect(h.readTimes.size).toBe(0)
  })

  it('SYM-3 edit 一条链接（两头先前都读过）：原话以 Not edited 起头；那头原文不动，先前记下的读取时间原样', async () => {
    const DOC = '/outside/doc.txt'
    const h = makeSuite({
      files: { [DOC]: 'alpha\nbeta\n' },
      links: { '/ws/elink': { target: DOC, resolved: DOC } },
      respond: allowed
    })
    h.readTimes.add(DOC)
    h.readTimes.add('/ws/elink')

    expect(
      await messageOf(
        h.suite.edit.execute('s3', { path: 'elink', oldText: 'beta', newText: 'BETA' })
      )
    ).toBe(
      `Not edited: elink is a symbolic link to ${DOC}. Symbolic links are not followed — edit ${DOC} directly if that is the file you mean.`
    )
    expect([...h.files]).toEqual([[DOC, 'alpha\nbeta\n']])
    expect([...h.readTimes].sort()).toEqual([DOC, '/ws/elink'])
    for (const [name, spy] of Object.entries(h.spies)) expect(spy, name).not.toHaveBeenCalled()
    expect(h.enforcePath).not.toHaveBeenCalled()
    expect(getSessionDecisions(SID)).toEqual([])
    expect(h.requestUserInput).not.toHaveBeenCalled()
    expect(h.onFileChange).not.toHaveBeenCalled()
  })

  it('SYM-4 引不引链接原文：相对的原样引出（含 `~/x`、盘符相对的 `C:t.txt`）；绝对的（POSIX、Windows 盘符、UNC、根相对）从不引', async () => {
    const R = '/resolved/end.txt'
    const cases: Array<[text: string, quoted: boolean]> = [
      ['../../.ssh/id_rsa', true],
      ['real/a.txt', true],
      ['./x', true],
      ['x', true],
      ['..', true],
      // 链接原文里的 `~` 不是家目录，是一个名叫 `~` 的相对目录
      ['~/x', true],
      // 盘符后面没有分隔符：那个盘当前目录下的相对路径
      ['C:t.txt', true],
      ['/etc/passwd', false],
      ['/', false],
      ['C:\\Users\\me\\t.txt', false],
      ['c:/Users/me/t.txt', false],
      ['\\\\server\\share\\t.txt', false],
      ['\\rooted\\t.txt', false]
    ]
    for (const [text, quoted] of cases) {
      const h = makeSuite({ links: { '/ws/l': { target: text, resolved: R } } })
      const msg = await messageOf(h.suite.read.execute('s4', { path: 'l' }))
      // 引文紧跟在 R 后面、句号前面；两处说的都是 resolved，原文只出现在引文里
      const said = quoted ? ` (the link says "${text}")` : ''
      expect(msg, text).toContain(
        `l is a symbolic link to ${R}${said}. Symbolic links are not followed — read ${R} directly`
      )
      expect(msg.includes('the link says'), text).toBe(quoted)
    }

    // write / edit 的引法与 read 同一条
    const h = makeSuite({ links: { '/ws/l': { target: '../x', resolved: R } } })
    expect(await messageOf(h.suite.write.execute('s4w', { path: 'l', content: 'x' }))).toContain(
      `Not written: l is a symbolic link to ${R} (the link says "../x").`
    )
    expect(
      await messageOf(h.suite.edit.execute('s4e', { path: 'l', oldText: 'a', newText: 'b' }))
    ).toContain(`Not edited: l is a symbolic link to ${R} (the link says "../x").`)
  })

  it('SYM-5 链接链：说出的是链的尽头（resolved），引出的是第一跳的原文；工具自己不沿链再去问', async () => {
    const END = '/ws/real/a.txt'
    const h = makeSuite({
      files: { [END]: 'a\n' },
      // c1 → c2 → c3 → real/a.txt：port 把整条链跟到底，只交回第一跳原文与尽头
      links: { '/ws/c1': { target: 'c2', resolved: END } },
      respond: allowed
    })

    const msg = await messageOf(h.suite.read.execute('s5', { path: 'c1' }))
    expect(msg).toContain(`c1 is a symbolic link to ${END} (the link says "c2").`)
    expect(msg).toContain(`read ${END} directly`)
    expect(msg).not.toContain('/ws/c2')
    expect(h.readLink).toHaveBeenCalledTimes(1)
  })

  it('SYM-6 悬空链接也算：read 拒的是链接这一条（不是 File not found，也不去找相似路径）；write 同样拒、什么都不建', async () => {
    const GONE = '/nowhere/x.txt'
    const suggestSimilar = vi.fn((_p: string) => ['/ws/dang.txt'])
    const h = makeSuite({
      links: { '/ws/dang': { target: GONE, resolved: GONE } },
      decoders: { suggestSimilar },
      respond: allowed
    })

    const readMsg = await messageOf(h.suite.read.execute('s6r', { path: 'dang' }))
    expect(readMsg).toContain(`dang is a symbolic link to ${GONE}.`)
    expect(readMsg).not.toContain('File not found')
    expect(readMsg).not.toContain('Did you mean')
    expect(suggestSimilar).not.toHaveBeenCalled()

    const writeMsg = await messageOf(h.suite.write.execute('s6w', { path: 'dang', content: 'x\n' }))
    expect(writeMsg).toContain(`Not written: dang is a symbolic link to ${GONE}.`)
    expect(h.files.size).toBe(0)
    expect(h.spies.writeFile).not.toHaveBeenCalled()
    expect(h.requestUserInput).not.toHaveBeenCalled()
    expect(getSessionDecisions(SID)).toEqual([])

    // 对照：同一个套件里真不存在（不是链接）的路径才走 File not found + 相似路径建议
    const missing = await messageOf(h.suite.read.execute('s6m', { path: 'dang.tx' }))
    expect(missing).toContain('File not found: dang.tx')
    expect(missing).toContain('Did you mean')
    expect(suggestSimilar).toHaveBeenCalledTimes(1)
  })

  it('SYM-7 会话授权跳不过这一条：免询问、allowList（链接与 R 的 Read / Write 条目都在）下 read / write / edit 照样拒，一个字节都不动', async () => {
    const grantCases: Array<Pick<SuiteOptions, 'autoAllow' | 'allowList'>> = [
      { autoAllow: true },
      { allowList: ['Read(/ws/key)', 'Write(/ws/key)', `Read(${KEY_REAL})`, `Write(${KEY_REAL})`] }
    ]
    for (const grants of grantCases) {
      const label = JSON.stringify(grants)
      const h = makeSuite({
        ...grants,
        files: { [KEY_REAL]: 'PRIVATE KEY\n' },
        links: keyLink(),
        respond: allowed
      })

      expect(await messageOf(h.suite.read.execute('s7r', { path: 'key' })), label).toContain(
        `key is a symbolic link to ${KEY_REAL}.`
      )
      expect(
        await messageOf(h.suite.write.execute('s7w', { path: 'key', content: 'x' })),
        label
      ).toContain(`Not written: key is a symbolic link to ${KEY_REAL}.`)
      expect(
        await messageOf(
          h.suite.edit.execute('s7e', { path: 'key', oldText: 'PRIVATE', newText: 'x' })
        ),
        label
      ).toContain(`Not edited: key is a symbolic link to ${KEY_REAL}.`)

      expect([...h.files], label).toEqual([[KEY_REAL, 'PRIVATE KEY\n']])
      expect(h.enforcePath, label).not.toHaveBeenCalled()
      expect(h.requestUserInput, label).not.toHaveBeenCalled()
      expect(h.persistGrant, label).not.toHaveBeenCalled()
      expect(h.readTimes.size, label).toBe(0)
    }
    expect(getSessionDecisions(SID)).toEqual([])
  })

  it('SYM-8 照提示改用 R 重发：那一次照常过门 —— read 问一次 Read(R)、允许后读到；凭据目录里的新 key 被 protect-credentials 直接拒；区外文件带 diff 问一次、允许后落盘', async () => {
    // read：R 在凭据目录里 → 询问（链接那一次一张卡都没弹）
    const r = makeSuite({
      files: { [KEY_REAL]: 'PRIVATE KEY\n' },
      links: keyLink(),
      respond: allowed
    })
    expect(await messageOf(r.suite.read.execute('s8a', { path: 'key' }))).toContain(
      `key is a symbolic link to ${KEY_REAL}.`
    )
    expect(r.requestUserInput).not.toHaveBeenCalled()
    const read = await r.suite.read.execute('s8b', { path: KEY_REAL })
    expect(r.requestUserInput).toHaveBeenCalledTimes(1)
    expect(askOf(r.requests[0]).command).toBe(allowEntry('read', KEY_REAL))
    expect(textOf(read)).toContain('PRIVATE KEY')

    // write 一把还不存在的新 key（悬空链接的那头）：链接那一次被这一条拒；R 那一次被凭据门拒 —— 都不弹卡
    const NEW_KEY = '/fake-home/.ssh/new_key'
    const d = makeSuite({
      links: { '/ws/newkey': { target: NEW_KEY, resolved: NEW_KEY } },
      respond: allowed
    })
    expect(
      await messageOf(d.suite.write.execute('s8c', { path: 'newkey', content: 'k' }))
    ).toContain(`Not written: newkey is a symbolic link to ${NEW_KEY}.`)
    const denied = await messageOf(d.suite.write.execute('s8d', { path: NEW_KEY, content: 'k' }))
    expect(denied.startsWith(`Denied by security policy rule 'protect-credentials#0'`)).toBe(true)
    expect(d.requestUserInput).not.toHaveBeenCalled()
    expect(d.files.size).toBe(0)

    // write 区外真文件：链接那一次不弹卡；R 那一次恰一张带 diff 的卡，允许后字节落在 R
    const w = makeSuite({
      files: { [OUT]: 'old\n' },
      links: { '/ws/wlink': { target: OUT, resolved: OUT } },
      respond: allowed
    })
    expect(
      await messageOf(w.suite.write.execute('s8e', { path: 'wlink', content: 'new\n' }))
    ).toContain(`Not written: wlink is a symbolic link to ${OUT}.`)
    expect(w.requestUserInput).not.toHaveBeenCalled()
    const res = await w.suite.write.execute('s8f', { path: OUT, content: 'new\n' })
    expect(w.requestUserInput).toHaveBeenCalledTimes(1)
    const req = askOf(w.requests[0])
    expect(req.command).toBe(allowEntry('write', OUT))
    expect(req.preview).toMatchObject({ kind: 'diff', path: OUT, isNewFile: false })
    expect(req.preview?.diff).toBe((res.details as { diff: string }).diff)
    expect(req.preview?.diff).toContain('-1 old')
    expect(req.preview?.diff).toContain('+1 new')
    expect(w.files.get(OUT)).toBe('new\n')
  })

  it('SYM-9 readLink 答 null：什么都不变 —— 每次调用拿 port 路径问一次，其后照旧（read 不弹，edit / write 各弹一次并落盘）', async () => {
    const h = makeSuite({ files: { [INSIDE_ABS]: 'alpha\nbeta\n' }, respond: allowed })

    expect(textOf(await h.suite.read.execute('s9r', { path: INSIDE }))).toContain('alpha')
    expect(h.requestUserInput).not.toHaveBeenCalled()
    await h.suite.edit.execute('s9e', { path: INSIDE, oldText: 'beta', newText: 'BETA' })
    await h.suite.write.execute('s9w', { path: 'fresh.txt', content: 'x\n' })

    expect(h.requestUserInput).toHaveBeenCalledTimes(2)
    expect(h.readLink?.mock.calls).toEqual([[INSIDE_ABS], [INSIDE_ABS], ['/ws/fresh.txt']])
    expect(h.files.get(INSIDE_ABS)).toBe('alpha\nBETA\n')
    expect(h.files.get('/ws/fresh.txt')).toBe('x\n')
  })

  it('SYM-10 port 不带 readLink（扩展端）：照旧 —— read 读到，edit / write 各问一次并落盘', async () => {
    const h = makeSuite({
      withReadLink: false,
      files: { [INSIDE_ABS]: 'alpha\n' },
      respond: allowed
    })
    expect('readLink' in h.port).toBe(false)
    expect(h.readLink).toBeUndefined()

    expect(textOf(await h.suite.read.execute('s10r', { path: INSIDE }))).toContain('alpha')
    await h.suite.edit.execute('s10e', { path: INSIDE, oldText: 'alpha', newText: 'ALPHA' })
    await h.suite.write.execute('s10w', { path: 'fresh.txt', content: 'x\n' })

    expect(h.requestUserInput).toHaveBeenCalledTimes(2)
    expect(h.files.get(INSIDE_ABS)).toBe('ALPHA\n')
    expect(h.files.get('/ws/fresh.txt')).toBe('x\n')
  })

  it('SYM-11 URL 读取不沾这一步：readLink、resolvePath、门都不碰，照常交给 readUrl', async () => {
    const readUrl = vi.fn(async (url: string) => ({
      content: [{ type: 'text' as const, text: `page ${url}` }],
      details: { type: 'read' as const, truncated: false, url }
    }))
    const h = makeSuite({ decoders: { readUrl }, respond: allowed })

    const res = await h.suite.read.execute('s11', { path: 'https://example.com/a' })
    expect(textOf(res)).toBe('page https://example.com/a')
    expect(readUrl).toHaveBeenCalledTimes(1)
    expect(h.readLink).not.toHaveBeenCalled()
    expect(h.resolvePath).not.toHaveBeenCalled()
    expect(h.enforcePath).not.toHaveBeenCalled()
    expect(h.requestUserInput).not.toHaveBeenCalled()
  })

  it('SYM-12 没有询问通道时照样是这一句（不是「no way to ask」）—— 拒在门之前', async () => {
    const h = makeSuite({ files: { [KEY_REAL]: 'PRIVATE KEY\n' }, links: keyLink() })
    expect(h.requestUserInput).toBeUndefined()

    const readMsg = await messageOf(h.suite.read.execute('s12r', { path: 'key' }))
    expect(readMsg).toContain(`key is a symbolic link to ${KEY_REAL}.`)
    expect(readMsg).not.toContain('no way to ask')
    const writeMsg = await messageOf(h.suite.write.execute('s12w', { path: 'key', content: 'x' }))
    expect(writeMsg).toContain(`Not written: key is a symbolic link to ${KEY_REAL}.`)
    expect(writeMsg).not.toContain('no way to ask')
    expect(getSessionDecisions(SID)).toEqual([])
  })

  it('SYM-13 调用已中止：三个工具都抛注入的 abortError，连 readLink 都不问（中止先于这一步）', async () => {
    const h = makeSuite({ links: keyLink(), abortError: 'TOOL_ABORTED', respond: allowed })
    const ac = new AbortController()
    ac.abort()

    const calls: Array<() => Promise<unknown>> = [
      () => h.suite.read.execute('s13r', { path: 'key' }, ac.signal),
      () => h.suite.write.execute('s13w', { path: 'key', content: 'x' }, ac.signal),
      () => h.suite.edit.execute('s13e', { path: 'key', oldText: 'a', newText: 'b' }, ac.signal)
    ]
    for (const call of calls) expect(await messageOf(call())).toBe('TOOL_ABORTED')
    expect(h.readLink).not.toHaveBeenCalled()
  })

  it('SYM-14 每次调用现问、不记上一次的答复：同一个工具实例，链接换成同名真文件就照常读到，再换回链接又被拒', async () => {
    const h = makeSuite({
      files: { [KEY_REAL]: 'PRIVATE KEY\n', '/ws/key': 'plain\n' },
      links: keyLink(),
      respond: allowed
    })
    const read = h.suite.read

    expect(await messageOf(read.execute('s14a', { path: 'key' }))).toContain('is a symbolic link')
    // 链接被换成了同名的真文件（区内读：不弹卡）
    delete h.links['/ws/key']
    expect(textOf(await read.execute('s14b', { path: 'key' }))).toContain('plain')
    // 又换回链接
    h.links['/ws/key'] = { target: KEY_REAL, resolved: KEY_REAL }
    expect(await messageOf(read.execute('s14c', { path: 'key' }))).toContain('is a symbolic link')

    expect(h.readLink).toHaveBeenCalledTimes(3)
    expect(h.requestUserInput).not.toHaveBeenCalled()
  })
})
