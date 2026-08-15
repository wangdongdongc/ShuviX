/**
 * createFileToolSuite 的审批接线单测 —— 内存 port + 可编程 ApprovalPolicy（requestUserInput 是 spy）。
 *
 * 关注点在「工具壳怎么问」：写类工具把审批推迟到 apply 层（一次调用只弹一张带 diff 预览的卡），
 * 放行短路（工作目录 / 免审批 / allowList）逐层生效，以及 InputResponse 判别联合的五个分支。
 */

import { describe, it, expect, vi, type Mock } from 'vitest'
import type { InputRequest, InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import type { FileSystemPort, FileGuards } from '../../fileTools/port'
import type { ApprovalPolicy, AccessMode } from '../../approval/policy'
import { createFileToolSuite, type FileToolDeps, type FileToolSuite } from '../fileToolSuite'

const ROOT = '/ws'
const INSIDE = 'notes.txt'
const INSIDE_ABS = '/ws/notes.txt'
const OUTSIDE_ABS = '/outside/secret.txt'

/** 桌面口径的允许清单条目文案（buildApprovalCommand 的期望形态） */
const allowEntry = (mode: AccessMode, p: string): string =>
  `${mode === 'write' ? 'Write' : 'Read'}(${p})`

interface SuiteOptions {
  files?: Record<string, string>
  autoApprove?: boolean
  /** allowList 命中判定（默认全不命中） */
  isInAllowList?: (mode: AccessMode, p: string) => boolean
  /** 不传 = 无审批通道（模拟无前端） */
  respond?: (req: InputRequest) => InputResponse | Promise<InputResponse>
  abortError?: string
}

interface SuiteHarness {
  suite: FileToolSuite
  files: Map<string, string>
  requests: InputRequest[]
  requestUserInput?: Mock<(req: InputRequest) => Promise<InputResponse>>
  persistAllow: Mock<(mode: AccessMode, p: string) => void>
  isInAllowList: Mock<(mode: AccessMode, p: string) => boolean>
  buildApprovalCommand: Mock<(mode: AccessMode, p: string) => string>
  onFileChange: Mock<(e: { portPath: string; kind: 'write' | 'edit' }) => void>
  readTimes: Set<string>
}

function makeSuite(opts: SuiteOptions = {}): SuiteHarness {
  const files = new Map(Object.entries(opts.files ?? {}))
  const readTimes = new Set<string>()
  const requests: InputRequest[] = []

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
    readdir: () => Promise.resolve([])
  }

  // 并发串行由 applyApproval.test.ts 覆盖；这里只关心审批接线
  const guards: FileGuards = {
    hasReadTime: (p) => readTimes.has(p),
    assertNotModifiedSinceRead: () => {},
    recordRead: (p) => void readTimes.add(p),
    withFileLock: (_p, fn) => fn()
  }

  const requestUserInput = opts.respond
    ? vi.fn(async (req: InputRequest): Promise<InputResponse> => {
        requests.push(req)
        return opts.respond!(req)
      })
    : undefined

  const persistAllow = vi.fn<(mode: AccessMode, p: string) => void>()
  const isInAllowList = vi.fn(opts.isInAllowList ?? (() => false))
  const buildApprovalCommand = vi.fn(allowEntry)
  const onFileChange = vi.fn<(e: { portPath: string; kind: 'write' | 'edit' }) => void>()

  const policy: ApprovalPolicy = {
    // 桌面口径：工作目录内只读放行，写入一律走审批链
    isAllowedWithoutPrompt: (mode, p) =>
      mode === 'read' && (p === ROOT || p.startsWith(ROOT + '/')),
    isAutoApprove: () => !!opts.autoApprove,
    isInAllowList,
    buildApprovalCommand,
    isDirectory: () => false,
    persistAllow,
    requestUserInput
  }

  const deps: FileToolDeps = {
    port,
    guards,
    resolvePath: (p) => (p.startsWith('/') ? p : `${ROOT}/${p}`),
    policy,
    abortError: opts.abortError,
    labels: { read: 'Read', write: 'Write', edit: 'Edit' },
    descriptions: { read: 'read', write: 'write', edit: 'edit' },
    onFileChange
  }

  return {
    suite: createFileToolSuite(deps),
    files,
    requests,
    requestUserInput,
    persistAllow,
    isInAllowList,
    buildApprovalCommand,
    onFileChange,
    readTimes
  }
}

const approved = (): InputResponse => ({ kind: 'approval', approved: true })

// ─── 组 1：一次写入只弹一张卡，且卡里带预览 ──────────────────────────────────

describe('文件工具套件 — 审批请求的次数与形状', () => {
  it('CONS-11: 一次 write 只触发一次 requestUserInput（不先弹路径卡再弹预览卡）', async () => {
    const h = makeSuite({ respond: approved })
    await h.suite.write.execute('call-1', { path: INSIDE, content: 'hello\n' })
    expect(h.requestUserInput).toHaveBeenCalledTimes(1)
  })

  it('CONS-11: 一次 edit 只触发一次 requestUserInput', async () => {
    const h = makeSuite({ files: { [INSIDE_ABS]: 'alpha\nbeta\n' }, respond: approved })
    await h.suite.edit.execute('call-2', { path: INSIDE, oldText: 'beta', newText: 'BETA' })
    expect(h.requestUserInput).toHaveBeenCalledTimes(1)
  })

  it('CONS-12: write 的审批请求形状（id/toolName/command/preview 全对齐）', async () => {
    const h = makeSuite({ respond: approved })
    const res = await h.suite.write.execute('call-3', { path: INSIDE, content: 'hello\n' })

    const req = h.requests[0]
    expect(req.kind).toBe('approval')
    expect(req.id).toBe('call-3')
    expect(req.toolName).toBe('write')
    if (req.kind !== 'approval') throw new Error('expected approval request')
    expect(req.command).toBe(allowEntry('write', INSIDE_ABS))
    expect(h.buildApprovalCommand).toHaveBeenCalledWith('write', INSIDE_ABS)
    expect(req.preview).toMatchObject({ kind: 'diff', path: INSIDE, isNewFile: true })
    // 卡片里的 diff 就是 tool result 里的那一份
    expect(req.preview?.diff).toBe(
      (res.details as { type: 'write'; diff: string; isNewFile: boolean }).diff
    )
  })

  it('CONS-12: edit 的审批请求形状（toolName=edit，预览路径取展示路径）', async () => {
    const h = makeSuite({ files: { [INSIDE_ABS]: 'alpha\nbeta\n' }, respond: approved })
    await h.suite.edit.execute('call-4', { path: INSIDE, oldText: 'beta', newText: 'BETA' })

    const req = h.requests[0]
    if (req.kind !== 'approval') throw new Error('expected approval request')
    expect(req.toolName).toBe('edit')
    expect(req.command).toBe(allowEntry('write', INSIDE_ABS))
    expect(req.preview).toMatchObject({ kind: 'diff', path: INSIDE })
    expect(req.preview?.isNewFile).toBeUndefined()
  })

  it('PERM-10: read 的审批请求不带 preview', async () => {
    const h = makeSuite({ files: { [OUTSIDE_ABS]: 'secret\n' }, respond: approved })
    await h.suite.read.execute('call-5', { path: OUTSIDE_ABS })

    const req = h.requests[0]
    if (req.kind !== 'approval') throw new Error('expected approval request')
    expect(req.toolName).toBe('read')
    expect(req.preview).toBeUndefined()
    expect(req.command).toBe(allowEntry('read', OUTSIDE_ABS))
  })
})

// ─── 组 2：工作目录写入收紧 + 放行短路 ───────────────────────────────────────

describe('文件工具套件 — 放行短路', () => {
  it('PERM-2: 工作目录内 write 会弹窗，同路径 read 不弹', async () => {
    const h = makeSuite({ files: { [INSIDE_ABS]: 'alpha\n' }, respond: approved })

    await h.suite.read.execute('r1', { path: INSIDE })
    expect(h.requestUserInput).not.toHaveBeenCalled()

    await h.suite.write.execute('w1', { path: INSIDE, content: 'beta\n' })
    expect(h.requestUserInput).toHaveBeenCalledTimes(1)
  })

  it('PERM-3: 会话免审批 → 不弹窗、照常写入、details.diff 仍完整', async () => {
    const h = makeSuite({ autoApprove: true, respond: approved })
    const res = await h.suite.write.execute('w2', { path: INSIDE, content: 'one\ntwo\n' })

    expect(h.requestUserInput).not.toHaveBeenCalled()
    expect(h.files.get(INSIDE_ABS)).toBe('one\ntwo\n')
    const details = res.details as { diff: string; isNewFile: boolean }
    expect(details.diff.split('\n')).toEqual(['+1 one', '+2 two'])
    expect(details.isNewFile).toBe(true)
  })

  it('PERM-4: allowList 命中 Write(abs) → 不弹窗', async () => {
    const h = makeSuite({ isInAllowList: (mode) => mode === 'write', respond: approved })
    await h.suite.write.execute('w3', { path: INSIDE, content: 'hi\n' })

    expect(h.requestUserInput).not.toHaveBeenCalled()
    expect(h.isInAllowList).toHaveBeenCalledWith('write', INSIDE_ABS)
    expect(h.files.get(INSIDE_ABS)).toBe('hi\n')
  })

  it('PERM-4: 只有 Read(abs) 条目时 write 仍弹窗（读权限不隐含写权限）', async () => {
    const h = makeSuite({ isInAllowList: (mode) => mode === 'read', respond: approved })
    await h.suite.write.execute('w4', { path: INSIDE, content: 'hi\n' })

    expect(h.requestUserInput).toHaveBeenCalledTimes(1)
    expect(h.isInAllowList).toHaveBeenCalledWith('write', INSIDE_ABS)
  })

  it('PERM-5: 批准 + rememberPath → persistAllow 一次；拒绝时不调用', async () => {
    const remember = makeSuite({
      respond: () => ({ kind: 'approval', approved: true, extra: { rememberPath: true } })
    })
    await remember.suite.write.execute('w5', { path: INSIDE, content: 'hi\n' })
    expect(remember.persistAllow).toHaveBeenCalledTimes(1)
    expect(remember.persistAllow).toHaveBeenCalledWith('write', INSIDE_ABS)

    const denied = makeSuite({
      respond: () => ({ kind: 'approval', approved: false, extra: { rememberPath: true } })
    })
    await expect(
      denied.suite.write.execute('w6', { path: INSIDE, content: 'hi\n' })
    ).rejects.toThrow()
    expect(denied.persistAllow).not.toHaveBeenCalled()
  })

  it('PERM-7: 无审批通道时目录内 write 被拒，read 仍放行', async () => {
    const h = makeSuite({ files: { [INSIDE_ABS]: 'alpha\n' } })

    await expect(h.suite.write.execute('w7', { path: INSIDE, content: 'x\n' })).rejects.toThrow(
      `Access denied: path outside workspace and no approval channel: ${INSIDE}`
    )
    expect(h.files.get(INSIDE_ABS)).toBe('alpha\n')

    const read = await h.suite.read.execute('r2', { path: INSIDE })
    expect((read.content[0] as { text: string }).text).toContain('alpha')
  })
})

// ─── 组 3：InputResponse 判别联合 ────────────────────────────────────────────

describe('文件工具套件 — InputResponse 分支', () => {
  it('RESP-1: approved:true → 写入发生', async () => {
    const h = makeSuite({ respond: approved })
    await h.suite.write.execute('resp1', { path: INSIDE, content: 'yes\n' })
    expect(h.files.get(INSIDE_ABS)).toBe('yes\n')
  })

  it('RESP-2: approved:false 无 reason → 抛 User denied access to <displayPath>，文件不变', async () => {
    const h = makeSuite({
      files: { [INSIDE_ABS]: 'old\n' },
      respond: () => ({ kind: 'approval', approved: false })
    })
    await expect(
      h.suite.write.execute('resp2', { path: INSIDE, content: 'new\n' })
    ).rejects.toThrow(`User denied access to ${INSIDE}`)
    expect(h.files.get(INSIDE_ABS)).toBe('old\n')
  })

  it('RESP-3: approved:false 带 reason → 抛该 reason', async () => {
    const h = makeSuite({
      respond: () => ({ kind: 'approval', approved: false, reason: '这个文件别动' })
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
    expect(h.persistAllow).not.toHaveBeenCalled()
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

  it('RESP-6: 非法 kind → 走未批准分支抛错，绝不放行', async () => {
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
    const h = makeSuite({ files: { [INSIDE_ABS]: 'alpha\nbeta\n' }, respond: approved })

    await h.suite.edit.execute('c1', { path: INSIDE, oldText: 'beta', newText: 'BETA' })
    expect(h.onFileChange).toHaveBeenCalledWith({ portPath: INSIDE_ABS, kind: 'edit' })

    await h.suite.write.execute('c2', { path: INSIDE, content: 'fresh\n' })
    expect(h.onFileChange).toHaveBeenCalledWith({ portPath: INSIDE_ABS, kind: 'write' })
    expect(h.onFileChange).toHaveBeenCalledTimes(2)
  })

  it('REG-4: 被拒 / 被中止时 onFileChange 不触发', async () => {
    const denied = makeSuite({ respond: () => ({ kind: 'approval', approved: false }) })
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
