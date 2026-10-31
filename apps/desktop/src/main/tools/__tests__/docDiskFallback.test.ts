/**
 * doc_read / doc_edit / doc_insert 的**磁盘回落** —— 没有编辑器显示这条笔记本会话的文档时，同一组工具直接改
 * 磁盘上的那份文件（tools/doc.ts 的 onDisk）。真实临时文件 + 真实 liveDocumentBridge（什么都没挂）+ 真实
 * fileTime + **真实安全模块**（同 writeAskWiring.test 的 provider 桩，requestUserInput 可编程）+ 真实的
 * 写后处理；只把会话的文档（resolveSessionDocument）、知识库的三个根和变更管线换成替身。
 *
 * 契约（tools/doc.ts 文件头 + CLAUDE.md「Co-editing — every notebook」）：
 *   - 读：去掉 BOM、行尾统一成 LF（模型照抄的原文才对得上），没有光标可报，说「没开着、这是存盘的文件」；
 *   - 改：与编辑器同一套定位规则（planDocChange）与落点描述（describeDocChange），写回时恢复 BOM 与原来的行尾；
 *     写入走 write 工具同一条流程（writeFileContent）—— 读后被改守卫、带 diff 预览的写前询问（卡上写的是
 *     doc_edit / doc_insert 与这次调用的 id）、契约 md 的回执与补字段、知识库盖章与提交、files.changed；
 *   - 定位失败（对不上 / 不唯一）不碰文件、不问、不广播；会话没有文档 / 文件读不到 → 抛、什么都不建。
 *
 *   DF-1  doc_read 的输出逐字：带行号的全文 + 「没开着」那句，没有「The user:」
 *   DF-2  BOM + CRLF 的文件：读出来没有 \r、没有 BOM
 *   DF-3  doc_edit（会话权限表里授予了写的目录）：落盘字节、输出逐字；不弹卡；files.changed 恰一次
 *   DF-4  CRLF + BOM 往返：只换那一处，BOM 与 CRLF 原样；find 里带 \r 对不上
 *   DF-5  doc_insert：after / before / 文末，空文件、末尾没有换行的文件
 *   DF-6  定位失败（0 处 / 2 处 / 锚点不在）：planDocChange 的原话；字节与 mtime 不变，不问、不广播、不进变更管线
 *   DF-7  写前询问：一张带 diff 预览的卡（doc_edit、这次调用的 id、-body / +BODY）；拒绝 → 不变；允许 → 落盘
 *   DF-8  询问期间文件被改 → 「has been modified since it was last read」，外部内容留着
 *   DF-9  契约 md：写坏的 agent md → 回执「The file was written, but it is INVALID」、坏文本照样落盘；
 *         合法的记忆 md → 盘上补了 shuvix-memory-updated，回执「Filled in for you」
 *   DF-10 用户知识库里的条目：盖 generated、回执 [OKF] Stamped generated、变更管线收到 write；没有覆盖保护那句
 *   DF-11 会话没有文档 → 三个工具都失败（NO_DOC），什么都没建
 *   DF-12 文件不存在 → 「Could not read the document file <doc>:」，什么都没建、不问
 *   DF-13 回落读完、写之前文件被别人改了 → 「has been modified since it was last read」，外部内容留着，不广播
 *   DF-14 doc_edit 与 doc_insert 同时来 → 逐个执行，两处都落下
 *   DF-15 询问挂着时中止 → 不变、不广播
 *   DF-16 已中止的 signal → 什么都没写、不问
 *   RC-6  策略载体（sessionDocumentKind 替身给 policy）里没写标记的策略，改坏了 → 回执是按载体判的
 *         `Parse check: … cannot parse … as a policy file`，不是写后处理那段（它只认文件自己的标记）；
 *         随后的 doc_read 把同一句判定接在「没开着」之后
 *   DF-SC bot 文档的排期回执（磁盘这一侧；编辑器那侧在 doc.test 的 SC）：时钟只假 Date、定在将来（读后被改守卫拿
 *         真实 mtime 比假的读取时刻），与 doc.test 的 SC 同一刻 —— 两边的 SCHEDULE 逐字相同
 *     DF-SC1 doc_read 合法 bot（载体 bot）→ 「没开着」+ `Parse check: … valid bot file.` + 排期
 *     DF-SC2 bots 目录里 doc_edit / doc_insert（带标记）→ 恰一段排期（写后处理的 writtenNote 给的）
 *     DF-SC3 载体 bot、没写标记 → 恰一段（按载体改判时换掉、不叠两段）；载体不是 ShuviX 文件、没写标记 →
 *            bots 目录里恰一段（只有写盘那段的目录规则认得出）、目录外没有
 *     DF-SC4 载体不是 ShuviX 文件、bots 目录外、bot 标记 → 恰一段，与编辑器那侧同一段
 *     DF-SC5 20:00 改成 21:00 → 回执里是 21:00
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InputRequest, InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import type { AppEvent } from '@shuvix/chat-protocol/appEvents'
import {
  executeTool,
  failureText,
  resultText,
  type InvokedToolResult
} from '@shuvix/agent-runtime/tools/testing/invokeTool'

const SID = 'doc-disk-session'

const state = vi.hoisted(() => ({
  dir: '',
  kb: '',
  /** bots 目录替身（getDefaultBotsDir）：没有它，写盘回执里的排期（botScheduleHint）会悄悄缺席 */
  bots: '',
  /** resolveSessionDocument 的答复（null = 这条会话没有文档） */
  doc: null as string | null,
  /** sessionDocumentKind 的答复（会话的承载项目是哪种 ShuviX 文件；null = 不是）；每条用例复位成 null */
  kind: null as string | null,
  /** 会话权限表里可写的目录（缺省：整个临时目录「允许并记住」了写 → 不弹卡；空 = 写哪儿都问） */
  aclWrite: [] as string[],
  requests: [] as InputRequest[],
  respond: (() => ({ kind: 'ask', allowed: true })) as (
    req: InputRequest
  ) => InputResponse | Promise<InputResponse>,
  notify: vi.fn()
}))

vi.mock('../../services/toolContext', async () => {
  const { createSecurityContext } = await import('@shuvix/agent-runtime')
  const { sep: pathSep, join: joinPath, resolve: resolvePath } = await import('node:path')
  const makeContext = (): unknown =>
    createSecurityContext(
      { kind: 'agent', sessionId: 'doc-disk-session', agentKind: 'root' },
      { host: 'desktop' },
      {
        host: 'desktop',
        pathSep,
        getVars: () => ({
          workspace: state.dir,
          toolResultsBase: joinPath(state.dir, '.nonexistent-tool-results'),
          skillsDirs: [],
          home: joinPath(state.dir, '.nonexistent-home'),
          systemDirs: [],
          // 会话权限表只有授予的那几条（工作目录、会话目录刻意不给）：写哪儿都问，除非授权盖着。
          // 写隐含读，可写的也在可读表里
          aclRead: state.aclWrite,
          aclWrite: state.aclWrite
        }),
        readBuiltinPolicyMd: INLINE_POLICY_MD,
        isDirectory: () => false,
        persistGrant: () => {},
        requestUserInput: async (req: InputRequest) => {
          state.requests.push(req)
          return state.respond(req)
        }
      }
    )
  return {
    resolveProjectConfig: () => ({ workingDirectory: state.dir }),
    getDesktopSecurityContext: makeContext,
    resolveSessionDocument: () => state.doc,
    sessionDocumentKind: () => state.kind,
    isSessionDocument: (_sid: string, p: string) =>
      state.doc !== null && resolvePath(p) === resolvePath(state.doc),
    TOOL_ABORTED: 'Aborted'
  }
})
vi.mock('../../services/toolRegistry', () => ({ registerBuiltinTool: () => {} }))
vi.mock('../../i18n', () => ({ t: (k: string) => k }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))
vi.mock('../../utils/paths', () => ({
  getShuvixKnowledgeRootDir: () => state.kb,
  getUserKnowledgeRootDir: () => `${state.kb}-user`,
  getBuiltinKnowledgeDir: () => `${state.kb}-builtin`,
  getToolResultsDir: () => join(state.dir, 'tool_results'),
  getDefaultBotsDir: () => state.bots
}))
// 内置库的语言目录从 i18next 现读：钉成 en（同 fileToolDepsKnowledge.test）
vi.mock('i18next', () => ({ default: { language: 'en', t: (key: string) => `i18n(${key})` } }))
vi.mock('../../services/knowledge', () => ({ notifyKnowledgeFileChanged: state.notify }))

import { DocEditTool, DocInsertTool, DocReadTool } from '../doc'
import { _resetAll } from '../../utils/toolUtils/fileTime'
import { nodeFileSystemPort } from '../../utils/toolUtils/nodeFileSystemPort'
import { appEventBus } from '../../utils/appEventBus'
import type { ToolContext } from '../../services/toolContext'
import { createInlinePolicyMdReader } from '@shuvix/agent-runtime/security/builtinPolicies/inlineSources'
import type { AskDiffPreview } from '@shuvix/chat-protocol/types/inputRequest'

/** 内置策略 md 的构建期内联读取口（真实装配链要它；测试进程，不进桌面 bundle） */
const INLINE_POLICY_MD = createInlinePolicyMdReader()

const NOT_OPEN =
  'The document is not open in an editor right now: this is the saved file, and your changes are written to it directly.'
const NO_DOC = 'This session has no document to read or change.'
const NO_MATCH = (what: string): string =>
  `${what} does not match the current document. The user may have just changed that passage — call doc_read and use the text as it is now.`

const ctx: ToolContext = {
  sessionId: SID,
  agent: {
    profileName: 'notebook',
    kind: 'root',
    getModelConfig: () => ({ provider: 'p', model: 'gpt-5', capabilities: {} })
  }
}

const publish = vi.spyOn(appEventBus, 'publish')
const filesChanged = (): AppEvent[] =>
  publish.mock.calls.map(([e]) => e).filter((e) => e.type === 'files.changed')

const readTool = (): DocReadTool => new DocReadTool(ctx)
const editTool = (): DocEditTool => new DocEditTool(ctx)
const insertTool = (): DocInsertTool => new DocInsertTool(ctx)

/** 一份新的文档文件（同名覆盖），并把它设成这条会话的文档 */
let seq = 0
function seedDoc(content: string, name = `doc-${++seq}.md`): string {
  const p = join(state.dir, 'notes', name)
  mkdirSync(join(state.dir, 'notes'), { recursive: true })
  writeFileSync(p, content)
  state.doc = p
  return p
}

const bytes = (p: string): string => readFileSync(p, 'utf-8')

/** 成功调用的输出文字 */
async function ok(work: Promise<InvokedToolResult>): Promise<string> {
  const res = await work
  expect(res.isError, resultText(res)).toBeFalsy()
  return resultText(res)
}

/** 被拒的调用：isError 的文字，或（调用本身被取消时）抛出的消息 */
async function refusal(work: Promise<InvokedToolResult>): Promise<string> {
  let res: InvokedToolResult
  try {
    res = await work
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
  if (res.isError) return resultText(res)
  throw new Error(`expected the call to fail, got: ${resultText(res).slice(0, 200)}`)
}

/** 把文件的 mtime 推到未来（读后被改守卫的容差是 50ms） */
function pushMtime(p: string): void {
  const future = new Date(Date.now() + 10_000)
  utimesSync(p, future, future)
}

beforeAll(() => {
  state.dir = mkdtempSync(join(tmpdir(), 'shuvix-doc-disk-'))
  state.kb = join(state.dir, 'kb')
  mkdirSync(join(`${state.kb}-user`, 'notes'), { recursive: true })
  state.bots = join(state.dir, 'bots')
  mkdirSync(state.bots, { recursive: true })
})
afterAll(() => rmSync(state.dir, { recursive: true, force: true }))
beforeEach(() => {
  _resetAll()
  state.doc = null
  state.kind = null
  state.aclWrite = [state.dir]
  state.requests = []
  state.respond = () => ({ kind: 'ask', allowed: true })
  state.notify.mockClear()
  publish.mockClear()
})

describe('doc_read 的磁盘回落', () => {
  it('DF-1 输出逐字：带行号的全文 + 「没开着」那句，没有用户那句', async () => {
    seedDoc('# T\n\nbody\n')
    const out = await ok(executeTool(readTool(), 'df1', {}))
    expect(out).toBe(`<document lines="4">\n1│# T\n2│\n3│body\n4│\n</document>\n\n${NOT_OPEN}`)
    expect(out).not.toContain('The user:')
  })

  it('DF-2 BOM + CRLF 的文件：读出来没有 \\r、没有 BOM', async () => {
    seedDoc('﻿# T\r\n\r\nbody\r\n')
    const out = await ok(executeTool(readTool(), 'df2', {}))
    expect(out).toBe(`<document lines="4">\n1│# T\n2│\n3│body\n4│\n</document>\n\n${NOT_OPEN}`)
    expect(out).not.toContain('\r')
    expect(out).not.toContain('﻿')
  })
})

describe('doc_edit / doc_insert 的磁盘回落', () => {
  it('DF-3 doc_edit：落盘字节与输出逐字；授权盖着不弹卡；files.changed 恰一次', async () => {
    const p = seedDoc('# T\n\nbody\n')
    const out = await ok(executeTool(editTool(), 'df3', { find: 'body', replace: 'BODY' }))
    expect(bytes(p)).toBe('# T\n\nBODY\n')
    expect(out).toBe('Replaced at line 3. The text there now:\n2│\n3│BODY\n4│')
    expect(state.requests).toEqual([])
    expect(filesChanged()).toEqual([
      { type: 'files.changed', root: state.dir, paths: [p], kind: 'write' }
    ])
  })

  it('DF-4 CRLF + BOM 往返：只换那一处，BOM 与 CRLF 原样；find 里带 \\r 对不上', async () => {
    const p = seedDoc('﻿# T\r\n\r\nbody\r\n')
    await ok(executeTool(editTool(), 'df4', { find: 'body', replace: 'BODY' }))
    expect(bytes(p)).toBe('﻿# T\r\n\r\nBODY\r\n')

    expect(
      await failureText(executeTool(editTool(), 'df4b', { find: '\r\nBODY', replace: 'x' }))
    ).toBe(NO_MATCH('`find`'))
    expect(bytes(p)).toBe('﻿# T\r\n\r\nBODY\r\n')
  })

  it.each([
    [
      'after',
      'A\nB\n',
      { after: 'A', text: '\nX' },
      'A\nX\nB\n',
      'Inserted at line 2. The text there now:\n1│A\n2│X\n3│B'
    ],
    [
      'before',
      'A\nB\n',
      { before: 'B', text: 'X\n' },
      'A\nX\nB\n',
      'Inserted at line 2. The text there now:\n1│A\n2│X\n3│B\n4│'
    ],
    [
      '文末',
      'A\nB\n',
      { text: 'C\n' },
      'A\nB\nC\n',
      'Inserted at line 3. The text there now:\n2│B\n3│C\n4│'
    ],
    ['空文件', '', { text: 'hello' }, 'hello', 'Inserted at line 1. The text there now:\n1│hello'],
    [
      '末尾没有换行',
      'A\nB',
      { text: '\nC' },
      'A\nB\nC',
      'Inserted at line 3. The text there now:\n1│A\n2│B\n3│C'
    ]
  ])('DF-5 doc_insert（%s）', async (_label, before, params, expected, output) => {
    const p = seedDoc(before)
    const out = await ok(executeTool(insertTool(), 'df5', params))
    expect(bytes(p)).toBe(expected)
    expect(out).toBe(output)
  })

  it.each([
    [
      '0 处',
      'one\ntwo\n',
      (): DocEditTool | DocInsertTool => editTool(),
      { find: 'nope', replace: 'x' },
      NO_MATCH('`find`')
    ],
    [
      '2 处',
      'dup\ndup\n',
      (): DocEditTool | DocInsertTool => editTool(),
      { find: 'dup', replace: 'x' },
      '`find` matches 2 places in the current document; include more of the surrounding text so it matches exactly one.'
    ],
    [
      '锚点不在',
      'one\ntwo\n',
      (): DocEditTool | DocInsertTool => insertTool(),
      { after: 'nope', text: 'x' },
      NO_MATCH('`after`')
    ]
  ])(
    'DF-6 定位失败（%s）→ 原话；字节与 mtime 不变，不问、不广播、不进变更管线',
    async (_label, content, make, params, message) => {
      // 不给授权：要是走到了写入就会弹卡
      state.aclWrite = []
      const p = seedDoc(content)
      const before = statSync(p).mtimeMs
      expect(await failureText(executeTool(make(), 'df6', params as never))).toBe(message)
      expect(bytes(p)).toBe(content)
      expect(statSync(p).mtimeMs).toBe(before)
      expect(state.requests).toEqual([])
      expect(filesChanged()).toEqual([])
      await new Promise((r) => setTimeout(r, 20))
      expect(state.notify).not.toHaveBeenCalled()
    }
  )

  it('DF-7 写前询问：一张带 diff 预览的卡（doc_edit、这次调用的 id）；拒绝 → 不变；允许 → 落盘', async () => {
    state.aclWrite = []
    const p = seedDoc('# T\n\nbody\n')
    state.respond = () => ({ kind: 'ask', allowed: false })
    expect(
      await failureText(executeTool(editTool(), 'df7-deny', { find: 'body', replace: 'BODY' }))
    ).toMatch(/denied/i)
    expect(bytes(p)).toBe('# T\n\nbody\n')
    expect(filesChanged()).toEqual([])
    expect(state.requests).toHaveLength(1)
    const req = state.requests[0]
    if (req.kind !== 'ask') throw new Error('expected an ask request')
    expect(req.toolName).toBe('doc_edit')
    expect(req.id).toBe('df7-deny')
    expect(req.preview).toMatchObject({ kind: 'diff', path: p })
    const diff = (req.preview as AskDiffPreview | undefined)?.diff ?? ''
    expect(diff.split('\n').filter((l) => l.startsWith('-'))).toEqual(['-3 body'])
    expect(diff.split('\n').filter((l) => l.startsWith('+'))).toEqual(['+3 BODY'])

    state.requests = []
    state.respond = () => ({ kind: 'ask', allowed: true })
    await ok(executeTool(insertTool(), 'df7-allow', { after: 'body', text: '\nmore' }))
    expect(bytes(p)).toBe('# T\n\nbody\nmore\n')
    expect(state.requests).toHaveLength(1)
    expect(state.requests[0].toolName).toBe('doc_insert')
    expect(state.requests[0].id).toBe('df7-allow')
    expect(filesChanged()).toHaveLength(1)
  })

  it('DF-8 询问期间文件被改 → 读后被改守卫拒绝；外部内容留着、不广播', async () => {
    state.aclWrite = []
    const p = seedDoc('# T\n\nbody\n')
    state.respond = () => {
      writeFileSync(p, '# T\n\nexternal\n')
      pushMtime(p)
      return { kind: 'ask', allowed: true }
    }
    expect(
      await failureText(executeTool(editTool(), 'df8', { find: 'body', replace: 'BODY' }))
    ).toContain('has been modified since it was last read')
    expect(bytes(p)).toBe('# T\n\nexternal\n')
    expect(filesChanged()).toEqual([])
  })

  it('DF-9 契约 md：写坏的 agent md 照样落盘、回执说 INVALID；合法的记忆 md 补上 shuvix-memory-updated', async () => {
    const agent = seedDoc(
      '---\nshuvix: agent v1\nname: a1\ndescription: d\n---\n\nBody.\n',
      'a1.md'
    )
    const out = await ok(
      executeTool(editTool(), 'df9a', { find: 'name: a1', replace: 'name: [unclosed' })
    )
    const at = out.indexOf('\n\n[shuvix agent v1]')
    expect(at).toBeGreaterThan(0)
    expect(out.startsWith('Replaced at line 3. The text there now:\n')).toBe(true)
    expect(
      out
        .slice(at + 2)
        .startsWith(
          '[shuvix agent v1] The file was written, but it is INVALID and will be ignored until fixed:\n- '
        )
    ).toBe(true)
    expect(bytes(agent)).toBe(
      '---\nshuvix: agent v1\nname: [unclosed\ndescription: d\n---\n\nBody.\n'
    )

    const memory = seedDoc(
      '---\nshuvix: memory v1\nname: x\ndescription: d\nshuvix-memory-recall: r\n---\nbody\n',
      'mem.md'
    )
    const memOut = await ok(executeTool(editTool(), 'df9b', { find: 'body', replace: 'body two' }))
    expect(bytes(memory)).toContain('shuvix-memory-updated: ')
    expect(bytes(memory)).toContain(`shuvix-memory-session: ${SID}`)
    expect(bytes(memory)).toContain('\nbody two\n')
    expect(memOut).toContain('\n\n[shuvix memory v1] Filled in for you: shuvix-memory-updated: ')
  })

  it('DF-10 用户知识库里的条目：盖 generated、回执 [OKF] Stamped generated、变更管线收到 write；没有覆盖保护那句', async () => {
    const p = join(`${state.kb}-user`, 'notes', 'entry.md')
    writeFileSync(
      p,
      [
        '---',
        'shuvix: okf v0.2',
        'type: Memory',
        'title: T',
        'description: d',
        'status: draft',
        '---',
        '',
        'body',
        ''
      ].join('\n')
    )
    state.doc = p
    const out = await ok(executeTool(editTool(), 'df10', { find: 'body', replace: 'body two' }))
    expect(out).not.toContain('already exists in the knowledge base')
    expect(out).toContain('\n\n[OKF] Stamped generated: { by: shuvix-notebook/gpt-5, at: ')
    expect(bytes(p)).toContain('generated: { by: "shuvix-notebook/gpt-5", at: "')
    expect(bytes(p)).toContain('\nbody two\n')
    await vi.waitFor(() => expect(state.notify).toHaveBeenCalledTimes(1))
    expect(state.notify).toHaveBeenCalledWith(p, {
      kind: 'write',
      actor: 'shuvix-notebook/gpt-5'
    })
  })

  it('DF-11 会话没有文档 → 三个工具都失败（NO_DOC），什么都没建', async () => {
    state.doc = null
    const before = readdirSync(state.dir).sort()
    expect(await failureText(executeTool(readTool(), 'df11r', {}))).toBe(NO_DOC)
    expect(await failureText(executeTool(editTool(), 'df11e', { find: 'a', replace: 'b' }))).toBe(
      NO_DOC
    )
    expect(await failureText(executeTool(insertTool(), 'df11i', { text: 'x' }))).toBe(NO_DOC)
    expect(readdirSync(state.dir).sort()).toEqual(before)
    expect(state.requests).toEqual([])
    expect(filesChanged()).toEqual([])
  })

  it('DF-12 文件不存在 → 「Could not read the document file <doc>:」，什么都没建、不问', async () => {
    state.aclWrite = []
    const p = join(state.dir, 'notes', 'missing.md')
    state.doc = p
    for (const [tool, params] of [
      [readTool(), {}],
      [editTool(), { find: 'a', replace: 'b' }],
      [insertTool(), { text: 'x' }]
    ] as const) {
      const msg = await failureText(executeTool(tool, 'df12', params as never))
      expect(msg.startsWith(`Could not read the document file ${p}:`), msg).toBe(true)
    }
    expect(existsSync(p)).toBe(false)
    expect(state.requests).toEqual([])
    expect(filesChanged()).toEqual([])
  })

  it('DF-13 回落读完、写之前文件被别人改了 → 读后被改守卫拒绝；外部内容留着、不广播', async () => {
    const p = seedDoc('# T\n\nbody\n')
    const realRead = nodeFileSystemPort.readFile.bind(nodeFileSystemPort)
    const spy = vi.spyOn(nodeFileSystemPort, 'readFile').mockImplementationOnce(async (path) => {
      const text = await realRead(path)
      writeFileSync(path, '# T\n\nexternal\n')
      pushMtime(path)
      return text
    })
    try {
      expect(
        await failureText(executeTool(editTool(), 'df13', { find: 'body', replace: 'BODY' }))
      ).toContain('has been modified since it was last read')
    } finally {
      spy.mockRestore()
    }
    expect(bytes(p)).toBe('# T\n\nexternal\n')
    expect(filesChanged()).toEqual([])
  })

  it('DF-14 doc_edit 与 doc_insert 同时来 → 逐个执行，两处都落下', async () => {
    const p = seedDoc('# T\n\nalpha\n\nbeta\n')
    const [a, b] = await Promise.all([
      executeTool(editTool(), 'df14e', { find: 'alpha', replace: 'ALPHA' }),
      executeTool(insertTool(), 'df14i', { after: 'beta', text: '\ngamma' })
    ])
    expect(a.isError, resultText(a)).toBeFalsy()
    expect(b.isError, resultText(b)).toBeFalsy()
    expect(bytes(p)).toBe('# T\n\nALPHA\n\nbeta\ngamma\n')
    expect(filesChanged()).toHaveLength(2)
  })

  it('DF-15 询问挂着时中止 → 文件不变、不广播', async () => {
    state.aclWrite = []
    const p = seedDoc('# T\n\nbody\n')
    const ac = new AbortController()
    let entered!: () => void
    const asked = new Promise<void>((r) => (entered = r))
    // 宿主在调用被中止时把挂着的卡收成 cancel
    state.respond = () =>
      new Promise<InputResponse>((resolve) => {
        entered()
        ac.signal.addEventListener('abort', () => resolve({ kind: 'cancel', reason: 'aborted' }))
      })
    const work = refusal(
      executeTool(editTool(), 'df15', { find: 'body', replace: 'BODY' }, ac.signal)
    )
    await asked
    ac.abort()
    expect(await work).toMatch(/Aborted/)
    expect(bytes(p)).toBe('# T\n\nbody\n')
    expect(filesChanged()).toEqual([])
  })

  it('DF-16 已中止的 signal → 什么都没写、不问', async () => {
    state.aclWrite = []
    const p = seedDoc('# T\n\nbody\n')
    const before = statSync(p).mtimeMs
    const ac = new AbortController()
    ac.abort()
    expect(
      await refusal(executeTool(editTool(), 'df16', { find: 'body', replace: 'BODY' }, ac.signal))
    ).toMatch(/Aborted/)
    expect(await refusal(executeTool(insertTool(), 'df16i', { text: 'x' }, ac.signal))).toMatch(
      /Aborted/
    )
    expect(bytes(p)).toBe('# T\n\nbody\n')
    expect(statSync(p).mtimeMs).toBe(before)
    expect(state.requests).toEqual([])
    expect(filesChanged()).toEqual([])
  })
})

describe('RC-6 磁盘回落的编辑回执按承载项目校正', () => {
  /** 内置策略原样（合法），去掉 `shuvix:` 自述行 —— 策略目录里的手写文件可以没有它 */
  const POLICY = (INLINE_POLICY_MD('ask-on-widget-access.md') ?? '').replace(/^shuvix: .*\n/m, '')

  it('RC-6 策略载体里没写标记的策略，改坏了 → 回执是 Parse check（按策略判），不是写后处理那段；doc_read 同一句接在「没开着」之后', async () => {
    // 样本自检：确实没有自述行、确实有 name 那一行可改
    expect(POLICY).not.toMatch(/^shuvix: /m)
    expect(POLICY).toContain('\nname: ask-on-widget-access\n')
    state.kind = 'policy'
    const p = seedDoc(POLICY, 'mine.md')

    const out = await ok(
      executeTool(editTool(), 'rc6', {
        find: 'name: ask-on-widget-access',
        replace: 'name: [unclosed'
      })
    )
    const head =
      'Parse check: ShuviX cannot parse this document as a policy file, so it is ignored until it is fixed:\n- '
    expect(out.startsWith('Replaced at line ')).toBe(true)
    expect(out).toContain(`\n\n${head}`)
    expect(out).not.toContain('[shuvix')
    expect(out).not.toContain('The file was written')
    // 坏文本照样落盘（回执只是附言）
    expect(bytes(p)).toContain('\nname: [unclosed\n')

    const read = await ok(executeTool(readTool(), 'rc6-read', {}))
    expect(read).toContain(`\n\n${NOT_OPEN}\n\n${head}`)
  })
})

describe('DF-SC 磁盘回落的排期回执', () => {
  const savedTz = process.env.TZ
  beforeEach(() => {
    process.env.TZ = 'Asia/Shanghai'
    // 定在将来：读后被改守卫拿文件真实的 mtime 比读取时记下的（假的）时刻；与 doc.test 的 SC 同一刻
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2030, 10, 2, 12, 0, 30))
  })
  afterEach(() => {
    vi.useRealTimers()
    if (savedTz === undefined) delete process.env.TZ
    else process.env.TZ = savedTz
  })

  /** 每天 20:00（或给定时刻）一条定时绑定的 bot（与 doc.test 的 SC 那份同形） */
  const BOT = (time = '20:00', marker: string | null = 'shuvix: bot v2'): string =>
    [
      '---',
      ...(marker === null ? [] : [marker]),
      'name: buddy',
      'shuvix-bot-on:',
      '  - trigger: timer.fired',
      `    when: "event.local.time == '${time}'"`,
      '    message: Evening check-in.',
      '---',
      '',
      'Persona.',
      ''
    ].join('\n')
  /** 与 doc.test 的 SC 那份逐字相同 */
  const SCHEDULE = (time = '20:00'): string =>
    'Schedule check (local time, the next 14 days):\n' +
    `- binding #0 (timer.fired): next at Sat 2030-11-02 ${time}, Sun 2030-11-03 ${time}, Mon 2030-11-04 ${time}.`
  const schedules = (out: string): number => out.split('Schedule check').length - 1

  /** bots 目录里的一份文档，设成这条会话的文档 */
  function seedBot(content: string, name: string): string {
    const p = join(state.bots, name)
    writeFileSync(p, content)
    state.doc = p
    return p
  }

  it('DF-SC1 doc_read 合法 bot（载体 bot）→ 「没开着」+ Parse check + 排期，各一次', async () => {
    state.kind = 'bot'
    seedBot(BOT(), 'sc1.md')
    const out = await ok(executeTool(readTool(), 'sc1', {}))
    expect(
      out.endsWith(
        `\n\n${NOT_OPEN}\n\nParse check: ShuviX parses this document as a valid bot file.\n\n${SCHEDULE()}`
      )
    ).toBe(true)
    expect(schedules(out)).toBe(1)
  })

  it.each([
    ['载体 bot', 'bot'],
    ['载体不是 ShuviX 文件', null]
  ])('DF-SC2 bots 目录里 doc_edit / doc_insert（带标记，%s）→ 恰一段排期', async (_label, kind) => {
    state.kind = kind
    const p = seedBot(BOT(), `sc2-${kind}.md`)
    const edited = await ok(
      executeTool(editTool(), 'sc2e', { find: 'Persona.', replace: 'Persona, kinder.' })
    )
    expect(edited.startsWith('Replaced at line ')).toBe(true)
    expect(edited.endsWith(`\n\n${SCHEDULE()}`)).toBe(true)
    expect(schedules(edited)).toBe(1)
    expect(edited).not.toContain('Parse check')

    const inserted = await ok(executeTool(insertTool(), 'sc2i', { text: 'More persona.\n' }))
    expect(inserted.startsWith('Inserted at line ')).toBe(true)
    expect(inserted.endsWith(`\n\n${SCHEDULE()}`)).toBe(true)
    expect(schedules(inserted)).toBe(1)
    expect(bytes(p)).toContain('Persona, kinder.\nMore persona.\n')
  })

  it('DF-SC3 载体 bot、没写标记 → 恰一段（按载体改判时换掉写盘那段，不叠两段）', async () => {
    state.kind = 'bot'
    seedBot(BOT('20:00', null), 'sc3.md')
    const out = await ok(
      executeTool(editTool(), 'sc3', { find: 'Persona.', replace: 'Persona, kinder.' })
    )
    expect(out.endsWith(`\n\n${SCHEDULE()}`)).toBe(true)
    expect(schedules(out)).toBe(1)
    expect(out).not.toContain('Parse check')
  })

  it('DF-SC3 载体不是 ShuviX 文件、没写标记、在 bots 目录里 → 恰一段（只有写盘那段认得出：靠 getDefaultBotsDir）', async () => {
    state.kind = null
    seedBot(BOT('20:00', null), 'sc3b.md')
    const out = await ok(
      executeTool(editTool(), 'sc3b', { find: 'Persona.', replace: 'Persona, kinder.' })
    )
    expect(out.endsWith(`\n\n${SCHEDULE()}`)).toBe(true)
    expect(schedules(out)).toBe(1)

    // 对照：同一份文本放在 bots 目录外 → 没有排期
    seedDoc(BOT('20:00', null), 'sc3c.md')
    const elsewhere = await ok(
      executeTool(editTool(), 'sc3c', { find: 'Persona.', replace: 'Persona, kinder.' })
    )
    expect(schedules(elsewhere)).toBe(0)
  })

  it('DF-SC4 载体不是 ShuviX 文件、bots 目录外（notes/）、bot 标记 → 恰一段，与编辑器那侧（doc.test SC）同一段', async () => {
    state.kind = null
    const p = seedDoc(BOT(), 'sc4.md')
    expect(p.startsWith(state.bots)).toBe(false)
    const out = await ok(
      executeTool(editTool(), 'sc4', { find: 'Persona.', replace: 'Persona, kinder.' })
    )
    expect(out.endsWith(`\n\n${SCHEDULE()}`)).toBe(true)
    expect(schedules(out)).toBe(1)
  })

  it('DF-SC5 20:00 改成 21:00 → 回执里是 21:00', async () => {
    state.kind = 'bot'
    const p = seedBot(BOT('20:00'), 'sc5.md')
    const out = await ok(
      executeTool(editTool(), 'sc5', {
        find: "event.local.time == '20:00'",
        replace: "event.local.time == '21:00'"
      })
    )
    expect(bytes(p)).toBe(BOT('21:00'))
    expect(out.endsWith(`\n\n${SCHEDULE('21:00')}`)).toBe(true)
    expect(schedules(out)).toBe(1)
  })
})
