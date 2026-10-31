/**
 * 协作编辑工具 doc_read / doc_edit / doc_insert —— 参数面、结果排版、与主进程桥的接线。
 *
 * 契约（tools/doc.ts 文件头 + chat-protocol liveDocument.ts）：
 *   - 目标文档恒取 ToolContext.sessionId 那条笔记本会话的文档，工具不收路径参数；交给桥时带上磁盘回落；
 *   - doc_read 的结果：带行号的全文（`<document lines="N">`，行号按总行数补齐宽度，末尾换行多出一个空行），
 *     一句「用户在哪」（光标行与所在标题、选区 JSON 引起来、屏幕上的行 `a–b`、距上次打字多久 / 没打过），
 *     有用户改动时再附一段 diff；超长截断并说明；
 *   - doc_edit / doc_insert 把 toolCallId、会话、signal、磁盘回落交给桥；没给的锚点（含空串）不发；结果说「在第几行」，
 *     等过用户就说等了多久（不到一秒说 under a second）；
 *   - 参数本身不成立的（空 find、两个锚点、空 text）在交给桥之前就抛；窗口答 `{ok:false}` → 以它的 error
 *     抛出（步骤行红）；答非所问 → 「Unexpected answer」；
 *   - 三个工具都注册在 general 组；折叠行摘要取定位原文 / 插入文字的第一行非空文字，过长截断。
 *
 * 桥换成可捕获的假件（requestLiveDocument）；i18n 原样回 key；工具类直接 new 出来经 BaseTool.execute 驱动
 * （durable 签名，经 invokeTool）。「抛」在 P1-04 起是 isError 结果，文字不变（裁定 Q12）。
 *
 *   T1 schema：doc_read 无属性；doc_edit 必填 find + replace；doc_insert 键序 after, before, text，只 text 必填
 *   T2 doc_read 的结果排版（行号、末尾空行、用户那句话的各分支、diff 块、截断）
 *   T3 doc_edit / doc_insert 交给桥的东西与结果排版（等待时长）
 *   T4 交给桥之前就抛的；{ok:false} → 抛；答非所问 → 抛
 *   T5 注册在 general 组；折叠行摘要
 *   T6 交给编辑器之前过会话权限表（桥的第五个参数）：doc_read 判读、doc_edit / doc_insert 判写，判的是这条会话的文档、
 *      带着工具名与 toolCallId；门不放行 → 抛出（桥那边就不发）
 *   LD 编辑器里落下的改动不经写盘钩子：工具拿编辑器交回的全文（`text`）做一遍契约 md 的校验，只要诊断
 *      （真的 reviewShuvixMdWrite，`diagnoseOnly`）—— 回执接在结果文字后面，开头说「文档改了」：
 *      LD-1 写坏的 agent md → `\n\n[shuvix agent v1] The document was changed, but it is INVALID …`；没走磁盘回落
 *      LD-2 普通 md → 没有回执
 *      LD-3 合法的记忆 md → 没有回执（不补字段）
 *      LD-4 知识库条目（bundleRelOf 有答）：合规的 → 没有回执（不盖章）；缺 description → 末尾是告警那段
 *      LD-5 文档不是 md → 没有回执
 *      LD-6 会话没有文档 → 没有回执、不抛
 *      LD-7 doc_read 从不带编辑回执（但带下面那句 Parse check）
 *   PV doc_read 附带「此刻能不能解析」（parseVerdictOf）：文档是宿主真解析的契约 md（agent / bot / policy / hook）时，
 *      最后一块是 `Parse check: …`。种类先看会话的承载项目（sessionDocumentKind，替身给），不是 ShuviX 文件的载体
 *      再看文件自己的 `shuvix:` 标记；校验的是全文（读回的正文可能被截断）；判定出错只是没有这句，读本身不失败。
 *      PV-1 合法 → 「as a valid policy file.」；排在用户那句 / diff 之后；磁盘回落的读排在「没开着」之后
 *      PV-2 载体说了算：策略载体里没写标记的策略照样合法
 *      PV-3 / PV-3b 非法 → 「cannot parse this document as a policy file / an agent file … :」+ 逐条 `- ` 原因
 *      PV-4 合法但有警告（未知埋点的 hook、带 v1 管线块的 bot）→ 「…, with warnings:」
 *      PV-5 解析器没给原因 → 「(the parser gave no reason)」
 *      PV-6 载体不是 ShuviX 文件 → 按标记兜底；PV-7 / PV-7b 不判（普通 md、记忆、okf、技能 / 知识库载体、非 md 文档）
 *      PV-8 载体胜过标记；PV-9 截断不影响判定；PV-10 种类查询 / 解析器抛错、会话没有文档 → 不失败、没有这句
 *      PV-11 解析器拿到的名字是去掉扩展名的文件名；PV-12 formatReadResult 的第二个参数；PV-13 守护：提示词说
 *      「doc_read 会说」的种类 = 真给判定的种类；PV-14 标记与载体一致时编辑回执不变
 *   RC 编辑回执按承载项目校正（receiptForCarrier）：载体是 agent / bot / policy / hook 而标记缺了或是别家的，
 *      回执换成按载体那一种判（没事不吭声，有事给 Parse check 那段）；标记一致 / 载体不是这四种 / 查询出错 → 原回执
 *   SC bot 文档的排期回执（botScheduleNoteFor，编辑器这一侧；磁盘回落那侧在 docDiskFallback.test 的 DF-SC）：
 *      按 bot 判的文档（载体是 bot，或载体不是 ShuviX 文件而标记是 bot）有定时绑定时，doc_read 的 Parse check 与
 *      doc_edit / doc_insert 的回执后面恰附一段 `Schedule check`；载体是 agent / policy 的从不附；解析不过的不附。
 *      SC-1 doc_read：`Parse check: … valid bot file.\n\nSchedule check (…)`（载体 bot / 标记兜底）
 *      SC-2 doc_read：解析不过 / 没有定时绑定 → 只有 Parse check
 *      SC-3 载体 policy / agent：带着 bot 标记与定时绑定也没有排期（doc_read、doc_edit）
 *      SC-4 doc_edit / doc_insert（载体 bot 或标记兜底，标记都在）→ 恰一段，没有 Parse check
 *      SC-5 载体 bot、没写标记 → 恰一段（干净时没有 Parse check）；带 v1 管线块 → 警告那段 + 排期，各一次
 *      SC-6 种类查询抛错 + bot 标记 → 写后处理那段照留（RC-7 那条）+ 排期一次
 *      SC-7 载体 bot、文本是 agent 标记 → 非法那段，没有排期
 *      SC-8 20:00 改成 21:00 → 回执里是 21:00；排期那段与磁盘回落的逐字相同（同一个 SCHEDULE）
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  LiveDocOp,
  LiveDocResult,
  LiveDocUserContext
} from '@shuvix/chat-protocol/liveDocument'
import { BUILTIN_TOOL_PRESENTATIONS } from '@shuvix/chat-protocol/builtinToolPresentations'
import type { ToolContext } from '../../services/toolContext'
import { renderDocumentKind, type AnyTool } from '@shuvix/agent-runtime'
import type { ShuvixFileKind } from '@shuvix/chat-protocol/shuvixFileNotes'
import { createInlinePolicyMdReader } from '@shuvix/agent-runtime/security/builtinPolicies/inlineSources'
import {
  executeTool,
  failureText,
  resultText
} from '@shuvix/agent-runtime/tools/testing/invokeTool'

const mocks = vi.hoisted(() => ({
  /** resolveSessionDocument 的答复（null = 会话没有文档）；每条用例复位成 null */
  doc: null as string | null,
  /** bundleRelOf 的答复（null = 不在任何可写 bundle 里） */
  rel: null as string | null,
  /** 磁盘回落才会装配的 deps —— 编辑器那条路从不碰它 */
  makeDeps: vi.fn(() => ({})),
  request:
    vi.fn<
      (
        sessionId: string,
        op: LiveDocOp,
        signal: AbortSignal | undefined,
        onDisk: () => Promise<LiveDocResult>,
        beforeLive?: () => Promise<void>
      ) => Promise<LiveDocResult>
    >(),
  /** 交给编辑器之前过的会话权限表门（enforcePath）：记下每一次 */
  gates: [] as Array<{ mode: string; path: string; opts: Record<string, unknown> }>,
  gateError: null as Error | null,
  /** sessionDocumentKind 的答复（会话的承载项目是哪种 ShuviX 文件；null = 不是）；每条用例复位成 null */
  kind: null as string | null,
  /** 为真时 sessionDocumentKind 抛错（会话行读不出来） */
  kindThrows: false,
  /** 换掉 validateShuvixMdText（null = 用真的）；PV-5 / PV-10 用 */
  validate: null as null | ((type: string, text: string, name?: string) => unknown)
}))

vi.mock('../../services/liveDocumentBridge', () => ({ requestLiveDocument: mocks.request }))
// 这里只测交给桥的那一面：磁盘回落那一面不经过（docDiskFallback.test 测它）。会话的文档与它在哪个
// bundle 里由用例给（缺省没有文档 —— 契约 md 的诊断不出声）；诊断本身是真的 reviewShuvixMdWrite
vi.mock('../../services/toolContext', () => ({
  resolveSessionDocument: () => mocks.doc,
  sessionDocumentKind: () => {
    if (mocks.kindThrows) throw new Error('session row unreadable')
    return mocks.kind
  },
  TOOL_ABORTED: 'Aborted',
  getDesktopSecurityContext: () => ({
    enforcePath: async (mode: string, path: string, opts: Record<string, unknown>) => {
      mocks.gates.push({ mode, path, opts })
      if (mocks.gateError) throw mocks.gateError
    }
  })
}))
vi.mock('../fileToolDeps', () => ({
  bundleRelOf: () => mocks.rel,
  makeDesktopFileToolDeps: mocks.makeDeps
}))
vi.mock('../../services/toolAgent', () => ({
  agentActorOf: () => 'actor',
  withCallAgent: <T>(c: T): T => c
}))
vi.mock('../../i18n', () => ({ t: (key: string) => key }))
// 解析器缺省是真的；PV-5 / PV-10 经 mocks.validate 换掉它（其余导出原样）
vi.mock('@shuvix/agent-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shuvix/agent-runtime')>()
  return {
    ...actual,
    validateShuvixMdText: (type: string, text: string, name?: string) =>
      mocks.validate
        ? mocks.validate(type, text, name)
        : actual.validateShuvixMdText(type, text, name)
  }
})

type DocModule = typeof import('../doc')
type Registry = typeof import('../../services/toolRegistry')
let mod: DocModule
let registry: Registry

const SID = 'sess-doc'
const ctx = { sessionId: SID } as ToolContext

beforeAll(async () => {
  mod = await import('../doc')
  registry = await import('../../services/toolRegistry')
})

beforeEach(() => {
  mocks.request.mockReset()
  mocks.makeDeps.mockClear()
  mocks.doc = null
  mocks.rel = null
  mocks.kind = null
  mocks.kindThrows = false
  mocks.validate = null
})

const user = (over: Partial<LiveDocUserContext> = {}): LiveDocUserContext => ({
  cursorLine: 1,
  visibleFromLine: 1,
  visibleToLine: 3,
  lastEditAgoMs: null,
  ...over
})

const readResult = (
  text: string,
  over: Partial<Extract<LiveDocResult, { kind: 'read' }>> = {}
): LiveDocResult => ({ ok: true, kind: 'read', text, user: user(), ...over })

/** 磁盘回落时 doc_read 的那句话（没有编辑器可报） */
const NOT_OPEN =
  'The document is not open in an editor right now: this is the saved file, and your changes are written to it directly.'

/** 工具结果的全文（只有一个文本块；必须是成功结果） */
async function run(
  tool: AnyTool,
  params: Record<string, unknown>,
  signal?: AbortSignal
): Promise<string> {
  const result = await executeTool(tool, 'tc-1', params as never, signal)
  expect(result.isError, resultText(result)).toBeUndefined()
  expect(result.content).toHaveLength(1)
  expect(result.content[0].type).toBe('text')
  return resultText(result)
}

/**
 * 失败调用交回的文字。P1-04 起工具抛错由 BaseTool 模板收成 isError 结果（裁定 Q12），
 * 模型看到的文字就是原先抛出的消息 —— 下面 T4 的「抛」都按这个口径断言。
 */
async function failure(tool: AnyTool, params: Record<string, unknown>): Promise<string> {
  const result = await executeTool(tool, 'tc-1', params as never)
  expect(result.content).toHaveLength(1)
  return failureText(Promise.resolve(result))
}

const readTool = (): InstanceType<DocModule['DocReadTool']> => new mod.DocReadTool(ctx)
const editTool = (): InstanceType<DocModule['DocEditTool']> => new mod.DocEditTool(ctx)
const insertTool = (): InstanceType<DocModule['DocInsertTool']> => new mod.DocInsertTool(ctx)

/** 读一次（桥答 result），回工具的输出 */
async function readWith(result: LiveDocResult): Promise<string> {
  mocks.request.mockResolvedValueOnce(result)
  return run(readTool(), {})
}

describe('T1 参数面', () => {
  const schema = (tool: {
    parameters: unknown
  }): {
    properties: Record<string, unknown>
    required?: string[]
  } => tool.parameters as never

  it('doc_read：没有任何参数（目标文档不由模型指）', () => {
    const s = schema(readTool())
    expect(Object.keys(s.properties)).toEqual([])
    expect(s.required ?? []).toEqual([])
  })

  it('doc_edit：find + replace 都必填，没有路径参数', () => {
    const s = schema(editTool())
    expect(Object.keys(s.properties).sort()).toEqual(['find', 'replace'])
    expect([...(s.required ?? [])].sort()).toEqual(['find', 'replace'])
  })

  it('doc_insert：键序 after, before, text（锚点先到），只 text 必填', () => {
    const s = schema(insertTool())
    expect(Object.keys(s.properties)).toEqual(['after', 'before', 'text'])
    expect(s.required ?? []).toEqual(['text'])
  })

  it('三个工具名', () => {
    expect([readTool().name, editTool().name, insertTool().name]).toEqual([
      'doc_read',
      'doc_edit',
      'doc_insert'
    ])
  })
})

describe('T2 doc_read 的结果', () => {
  it('交给桥的是 {kind: read}、本会话、signal', async () => {
    const ac = new AbortController()
    mocks.request.mockResolvedValueOnce(readResult('x'))
    await run(readTool(), {}, ac.signal)
    expect(mocks.request).toHaveBeenCalledTimes(1)
    expect(mocks.request.mock.calls[0]).toEqual([
      SID,
      { kind: 'read' },
      ac.signal,
      expect.any(Function),
      expect.any(Function)
    ])
  })

  it('带行号的全文：`<document lines="N">`，末尾换行多出一个空行', async () => {
    const out = await readWith(readResult('# Title\n\nbody\n'))
    const doc = out.slice(0, out.indexOf('</document>') + '</document>'.length)
    expect(doc).toBe('<document lines="4">\n1│# Title\n2│\n3│body\n4│\n</document>')
  })

  it('10 行以上：行号按总行数补齐宽度', async () => {
    const text = Array.from({ length: 12 }, (_, i) => `L${i + 1}`).join('\n')
    const out = await readWith(readResult(text))
    expect(out).toContain('<document lines="12">\n 1│L1\n 2│L2\n')
    expect(out).toContain('\n 9│L9\n10│L10\n11│L11\n12│L12\n</document>')
  })

  it('用户那句话：光标行 + 所在标题 + 选区（JSON 引起来）+ 屏幕上的行（en dash）', async () => {
    const out = await readWith(
      readResult('x', {
        user: user({
          cursorLine: 7,
          section: '## Two',
          selection: 'picked "words"\nhere',
          visibleFromLine: 3,
          visibleToLine: 40,
          lastEditAgoMs: 5_000
        })
      })
    )
    expect(out).toContain(
      'The user: cursor on line 7 (in section "## Two"); selected text: "picked \\"words\\"\\nhere"; on screen: lines 3–40; last typed 5 seconds ago.'
    )
  })

  it('没有标题 / 没有选区 / 没打过字', async () => {
    const out = await readWith(readResult('x', { user: user({ cursorLine: 2 }) }))
    expect(out).toContain(
      'The user: cursor on line 2; on screen: lines 1–3; has not typed since the document opened.'
    )
    expect(out).not.toContain('section')
    expect(out).not.toContain('selected text')
  })

  it.each([
    [0, 'under a second'],
    [999, 'under a second'],
    [1_000, '1 second'],
    [1_400, '1 second'],
    [2_000, '2 seconds'],
    [59_000, '59 seconds'],
    [60_000, '1 minute'],
    [90_000, '2 minutes'],
    [59 * 60_000, '59 minutes'],
    [60 * 60_000, '1 hour'],
    [2 * 3_600_000, '2 hours']
  ])('距上次打字 %i ms → 「last typed %s ago」', async (ms, words) => {
    const out = await readWith(readResult('x', { user: user({ lastEditAgoMs: ms }) }))
    expect(out).toContain(`last typed ${words} ago.`)
  })

  it('没有用户改动 → 没有 diff 块；有 → 附在最后', async () => {
    const plain = await readWith(readResult('x'))
    expect(plain).not.toContain('user_edits_since_your_last_read')

    const patch = '@@ -1,1 +1,1 @@\n-old\n+new'
    const withChanges = await readWith(readResult('x', { userChanges: patch }))
    expect(
      withChanges.endsWith(
        `\n\n<user_edits_since_your_last_read>\n${patch}\n</user_edits_since_your_last_read>`
      )
    ).toBe(true)
    // 顺序：全文 → 用户那句话 → diff
    expect(withChanges.indexOf('</document>')).toBeLessThan(withChanges.indexOf('The user:'))
    expect(withChanges.indexOf('The user:')).toBeLessThan(
      withChanges.indexOf('<user_edits_since_your_last_read>')
    )
  })

  it('超过 200000 字符 → 截断并说明', async () => {
    const text = 'a'.repeat(200_010)
    const out = await readWith(readResult(text))
    expect(out).toContain('<document lines="1">\n1│' + 'a'.repeat(200_000) + '\n(Truncated')
    expect(out).toContain('(Truncated after 200000 characters.)\n</document>')
    expect(out).not.toContain('a'.repeat(200_001))
  })
})

describe('T3 doc_edit / doc_insert 交给桥的东西与结果', () => {
  it('doc_edit：op 带 toolCallId / find / replace，本会话，signal', async () => {
    const ac = new AbortController()
    mocks.request.mockResolvedValueOnce({
      ok: true,
      kind: 'edit',
      line: 5,
      context: '4│before\n5│NEW\n6│after',
      waitedMs: 0,
      text: ''
    })
    const out = await run(editTool(), { find: 'old', replace: 'NEW' }, ac.signal)
    expect(mocks.request.mock.calls[0]).toEqual([
      SID,
      { kind: 'edit', toolCallId: 'tc-1', find: 'old', replace: 'NEW' },
      ac.signal,
      expect.any(Function),
      expect.any(Function)
    ])
    expect(out).toBe('Replaced at line 5. The text there now:\n4│before\n5│NEW\n6│after')
  })

  it('doc_edit：replace 为空串照样发（= 删掉那一段）', async () => {
    mocks.request.mockResolvedValueOnce({
      ok: true,
      kind: 'edit',
      line: 2,
      context: '2│',
      waitedMs: 0,
      text: ''
    })
    await run(editTool(), { find: 'gone', replace: '' })
    expect(mocks.request.mock.calls[0][1]).toEqual({
      kind: 'edit',
      toolCallId: 'tc-1',
      find: 'gone',
      replace: ''
    })
  })

  it.each([
    ['after', { after: 'anchor' }, { after: 'anchor' }],
    ['before', { before: 'anchor' }, { before: 'anchor' }],
    ['都不给', {}, {}],
    ['空串的 after = 没给', { after: '' }, {}],
    ['空串的 before = 没给', { before: '' }, {}],
    ['空串 before + 有值的 after', { after: 'x', before: '' }, { after: 'x' }]
  ])('doc_insert（%s）：没给的锚点不发', async (_label, anchors, sent) => {
    mocks.request.mockResolvedValueOnce({
      ok: true,
      kind: 'insert',
      line: 9,
      context: '9│hi',
      waitedMs: 0,
      text: ''
    })
    const out = await run(insertTool(), { ...anchors, text: 'hi' })
    const op = mocks.request.mock.calls[0][1]
    expect(op).toEqual({ kind: 'insert', toolCallId: 'tc-1', text: 'hi', ...sent })
    expect('after' in op && !('after' in sent)).toBe(false)
    expect('before' in op && !('before' in sent)).toBe(false)
    expect(out).toBe('Inserted at line 9. The text there now:\n9│hi')
  })

  it.each([
    [0, ''],
    [400, ' (waited under a second for the user to pause typing there)'],
    [2_000, ' (waited 2 seconds for the user to pause typing there)'],
    [1_000, ' (waited 1 second for the user to pause typing there)']
  ])('等了 %i ms → 「at line N%s.」', async (waitedMs, waited) => {
    mocks.request.mockResolvedValueOnce({
      ok: true,
      kind: 'edit',
      line: 3,
      context: '3│x',
      waitedMs,
      text: ''
    })
    const out = await run(editTool(), { find: 'a', replace: 'x' })
    expect(out.split('\n')[0]).toBe(`Replaced at line 3${waited}. The text there now:`)
  })
})

describe('T4 失败', () => {
  it('doc_edit 空 find → 交给桥之前就抛，错误点名 doc_insert', async () => {
    expect(await failure(editTool(), { find: '', replace: 'x' })).toMatch(/doc_insert/)
    expect(mocks.request).not.toHaveBeenCalled()
  })

  it('doc_insert 两个锚点都给 → 抛，没交给桥', async () => {
    expect(await failure(insertTool(), { after: 'a', before: 'b', text: 'x' })).toContain(
      'Give `after` or `before`, not both.'
    )
    expect(mocks.request).not.toHaveBeenCalled()
  })

  it('doc_insert 空 text → 抛，没交给桥', async () => {
    expect(await failure(insertTool(), { text: '' })).toContain('`text` is empty.')
    expect(mocks.request).not.toHaveBeenCalled()
  })

  it.each([
    ['doc_read', () => readTool(), {}],
    ['doc_edit', () => editTool(), { find: 'a', replace: 'b' }],
    ['doc_insert', () => insertTool(), { text: 'x' }]
  ])('%s：窗口答 {ok:false} → 以它的 error 抛出', async (_label, make, params) => {
    const error = '`find` does not match the current document.'
    mocks.request.mockResolvedValueOnce({ ok: false, error })
    expect(await failure(make(), params)).toContain(error)
  })

  it('桥本身失败（编辑器摘下 / 超时）→ 原样抛', async () => {
    mocks.request.mockRejectedValueOnce(
      new Error('The editor showing this document did not respond in time.')
    )
    expect(await failure(readTool(), {})).toContain('did not respond in time')
  })

  it('答非所问 → 「Unexpected answer」', async () => {
    mocks.request.mockResolvedValueOnce({
      ok: true,
      kind: 'edit',
      line: 1,
      context: '',
      waitedMs: 0,
      text: ''
    })
    expect(await failure(readTool(), {})).toMatch(/Unexpected answer/)

    mocks.request.mockResolvedValueOnce(readResult('x'))
    expect(await failure(editTool(), { find: 'a', replace: 'b' })).toMatch(/Unexpected answer/)

    mocks.request.mockResolvedValueOnce(readResult('x'))
    expect(await failure(insertTool(), { text: 'x' })).toMatch(/Unexpected answer/)
  })
})

describe('T5 注册与折叠行摘要', () => {
  it('三个都注册在 general 组，工厂造出对应的工具，describe 给出描述与 schema', () => {
    const entries = registry.getBuiltinToolEntries().filter((e) => e.name.startsWith('doc_'))
    expect(entries.map((e) => e.name).sort()).toEqual(['doc_edit', 'doc_insert', 'doc_read'])
    for (const e of entries) {
      expect(e.group).toBe('general')
      expect(e.hidden).toBeFalsy()
      const tool = e.factory!(ctx) as { name: string; parameters: unknown }
      expect(tool.name).toBe(e.name)
      const described = e.describe!()
      expect(described.description.length).toBeGreaterThan(0)
      expect(described.parameters).toBe(tool.parameters)
      expect(e.getLabel()).toBe(BUILTIN_TOOL_PRESENTATIONS[e.name].labelKey)
    }
  })

  it('doc_edit 的摘要：find 的第一行非空文字（去掉两边空白）', () => {
    const summary = BUILTIN_TOOL_PRESENTATIONS.doc_edit.buildSummary!
    expect(summary({ find: '\n\n   first real line  \nsecond' })).toBe('first real line')
    expect(summary({ find: '   \n  ' })).toBeUndefined()
    expect(summary({})).toBeUndefined()
  })

  it('doc_insert 的摘要：text 的第一行；48 字以内原样，更长截到 47 字 + …', () => {
    const summary = BUILTIN_TOOL_PRESENTATIONS.doc_insert.buildSummary!
    const exactly48 = 'x'.repeat(48)
    expect(summary({ text: `\n\n${exactly48}\nmore` })).toBe(exactly48)
    const long = 'y'.repeat(60)
    expect(summary({ text: long })).toBe(`${'y'.repeat(47)}…`)
  })

  it('doc_read 没有摘要', () => {
    expect(BUILTIN_TOOL_PRESENTATIONS.doc_read.buildSummary).toBeUndefined()
  })
})

describe('LD 编辑器里落下的改动：契约 md 的诊断回执', () => {
  const CONTEXT = '1│---\n2│shuvix: agent v1'
  /** 编辑器答一次 edit，交回改动后的全文 text */
  const editAnswer = (text: string): LiveDocResult => ({
    ok: true,
    kind: 'edit',
    line: 1,
    context: CONTEXT,
    waitedMs: 0,
    text
  })
  const HEAD = `Replaced at line 1. The text there now:\n${CONTEXT}`
  const INVALID_AGENT = ['---', 'shuvix: agent v1', 'name: [unclosed', '---', 'body'].join('\n')
  const entry = (lines: string[]): string =>
    ['---', 'shuvix: okf v0.2', ...lines, '---', '', 'body', ''].join('\n')

  /** 跑一次 doc_edit，编辑器交回 text；回工具输出 */
  async function editWith(text: string): Promise<string> {
    mocks.request.mockResolvedValueOnce(editAnswer(text))
    return run(editTool(), { find: 'a', replace: 'b' })
  }

  it('LD-1 写坏的 agent md → 结果文字 + 空行 + 「The document was changed, but it is INVALID」；没走磁盘回落', async () => {
    mocks.doc = '/proj/agents/a1.md'
    const out = await editWith(INVALID_AGENT)
    expect(
      out.startsWith(
        `${HEAD}\n\n[shuvix agent v1] The document was changed, but it is INVALID and will be ignored until fixed:\n- `
      )
    ).toBe(true)
    expect(out).not.toContain('The file was written')
    // 桥（假件）没调磁盘回落，工具自己也没去装配写盘的 deps
    expect(mocks.makeDeps).not.toHaveBeenCalled()
    expect(mocks.request.mock.calls[0][3]).toEqual(expect.any(Function))
  })

  it('LD-2 普通 md → 没有回执', async () => {
    mocks.doc = '/proj/notes/plain.md'
    expect(await editWith('# Plain\n\nbody\n')).toBe(HEAD)
  })

  it('LD-3 合法的记忆 md → 没有回执（不补字段：落盘归编辑器）', async () => {
    mocks.doc = '/proj/notes/mem.md'
    const memory =
      '---\nshuvix: memory v1\nname: x\ndescription: d\nshuvix-memory-recall: r\n---\nbody\n'
    expect(await editWith(memory)).toBe(HEAD)
  })

  it('LD-4 知识库条目：合规的 → 没有回执（不盖章）；缺 description → 末尾是告警那段', async () => {
    mocks.doc = '/kb/notes/x.md'
    mocks.rel = 'x.md'
    const valid = await editWith(
      entry(['type: Memory', 'title: T', 'description: d', 'status: draft'])
    )
    expect(valid).toBe(HEAD)
    expect(valid).not.toContain('[OKF] Stamped')

    const warned = await editWith(entry(['type: Memory', 'title: T', 'status: draft']))
    expect(
      warned.endsWith(
        "\n\n[OKF] Written with warnings:\n- 'description' (one line) is recommended — it is what list and search show"
      )
    ).toBe(true)
    expect(warned.startsWith(HEAD)).toBe(true)
  })

  it('LD-5 文档不是 md → 没有回执（哪怕内容像一份写坏的 agent md）', async () => {
    mocks.doc = '/proj/notes/a1.txt'
    expect(await editWith(INVALID_AGENT)).toBe(HEAD)
  })

  it('LD-6 会话没有文档 → 没有回执、不抛', async () => {
    mocks.doc = null
    expect(await editWith(INVALID_AGENT)).toBe(HEAD)
  })

  it('LD-7 doc_read 从不带编辑回执，但带此刻的 Parse check（PV-6：载体不是 ShuviX 文件，按标记兜底）', async () => {
    mocks.doc = '/proj/agents/a1.md'
    const out = await readWith(readResult(INVALID_AGENT))
    expect(out).not.toContain('[shuvix agent')
    expect(out).not.toContain('The document was changed')
    expect(out).toContain(
      '\n\nParse check: ShuviX cannot parse this document as an agent file, so it is ignored until it is fixed:\n- '
    )
  })
})

/** 契约 md 的样本（真解析器判）：合法策略 = 内置 ask-on-widget-access 原样 */
const VALID_POLICY = createInlinePolicyMdReader()('ask-on-widget-access.md') ?? ''
/** 去掉 `shuvix:` 自述行（策略 / agent / bot 目录里的手写文件可以没有它） */
const withoutMarker = (text: string): string => text.replace(/^shuvix: .*\n/m, '')
/** 非法策略：去掉整块 `shuvix-policy-rules`（一条规则都没有） */
const INVALID_POLICY = VALID_POLICY.replace(/shuvix-policy-rules:[\s\S]*?\n---\n/, '---\n')
const VALID_AGENT = '---\nshuvix: agent v1\nname: a1\ndescription: d\n---\n\nBody.\n'
/** YAML 写坏的 agent md（与 LD 那份同形） */
const BROKEN_AGENT = ['---', 'shuvix: agent v1', 'name: [unclosed', '---', 'body'].join('\n')
/** 合法但带警告的 hook：触发点在这个版本上不认识（绑定惰性化） */
const HOOK_UNKNOWN_TRIGGER = [
  '---',
  'shuvix: hook v1',
  'name: watcher',
  'description: d',
  'shuvix-hook-agent: titler',
  'shuvix-hook-on:',
  '  - trigger: no.such.trigger',
  '---',
  '',
  'Do it.',
  ''
].join('\n')
/** 合法但带警告的 bot：v1 时代残留的管线块 */
const BOT_V1_PIPELINE = [
  '---',
  'shuvix: bot v1',
  'name: buddy',
  'shuvix-bot-pipeline:',
  '  - step: chat',
  '---',
  '',
  'Persona.',
  ''
].join('\n')

const VALID_VERDICT = (kind: string): string =>
  `Parse check: ShuviX parses this document as a valid ${kind} file.`
const INVALID_HEAD = (file: string): string =>
  `Parse check: ShuviX cannot parse this document as ${file}, so it is ignored until it is fixed:\n- `
const WARNED_HEAD = (kind: string): string =>
  `Parse check: ShuviX parses this document as a valid ${kind} file, with warnings:\n- `

/** 输出里从 `Parse check:` 起的那一块（它总在最后）；没有就是 null */
const verdictIn = (out: string): string | null => {
  const at = out.indexOf('Parse check:')
  return at < 0 ? null : out.slice(at)
}

describe('PV doc_read 附带此刻的解析判定', () => {
  it('PV-0 样本自检：合法策略带自述行与规则，非法那份确实去掉了规则', () => {
    expect(VALID_POLICY).toContain('shuvix: policy v1')
    expect(VALID_POLICY).toContain('shuvix-policy-rules:')
    expect(INVALID_POLICY).not.toContain('shuvix-policy-rules:')
    expect(INVALID_POLICY.startsWith('---\nshuvix: policy v1\n')).toBe(true)
    expect(withoutMarker(VALID_POLICY)).not.toMatch(/^shuvix: /m)
    expect(withoutMarker(VALID_POLICY)).toContain('shuvix-id: ')
  })

  it('PV-1 合法策略（策略载体）：最后一块恰是「valid policy file.」，排在用户那句与 diff 之后；磁盘回落的读排在「没开着」之后', async () => {
    mocks.doc = '/x/policies/ask-on-widget-access.md'
    mocks.kind = 'policy'

    const out = await readWith(readResult(VALID_POLICY))
    expect(out.endsWith(`\n\n${VALID_VERDICT('policy')}`)).toBe(true)
    expect(out.indexOf('The user:')).toBeLessThan(out.indexOf('Parse check:'))
    expect(out.split('Parse check:')).toHaveLength(2)

    const patch = '@@ -1,1 +1,1 @@\n-old\n+new'
    const withChanges = await readWith(readResult(VALID_POLICY, { userChanges: patch }))
    expect(
      withChanges.endsWith(`\n</user_edits_since_your_last_read>\n\n${VALID_VERDICT('policy')}`)
    ).toBe(true)

    // 磁盘回落交回的读结果没有 user：判定接在「没开着」那句之后
    const disk = await readWith({ ok: true, kind: 'read', text: VALID_POLICY })
    expect(disk.endsWith(`\n\n${NOT_OPEN}\n\n${VALID_VERDICT('policy')}`)).toBe(true)
  })

  it('PV-2 载体说了算：策略载体里没写 `shuvix:` 自述行的策略照样是合法策略', async () => {
    mocks.doc = '/x/policies/mine.md'
    mocks.kind = 'policy'
    const out = await readWith(readResult(withoutMarker(VALID_POLICY)))
    expect(verdictIn(out)).toBe(VALID_VERDICT('policy'))
  })

  it('PV-3 非法策略：「cannot parse … as a policy file」+ 逐条 `- ` 原因', async () => {
    mocks.doc = '/x/policies/mine.md'
    mocks.kind = 'policy'
    const verdict = verdictIn(await readWith(readResult(INVALID_POLICY)))
    expect(verdict).not.toBeNull()
    expect(verdict!.startsWith(INVALID_HEAD('a policy file'))).toBe(true)
    const lines = verdict!.split('\n').slice(1)
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) expect(line.startsWith('- '), line).toBe(true)
    expect(verdict).not.toContain('(the parser gave no reason)')
  })

  it('PV-3b 非法 agent：冠词是 an —— 「as an agent file」，从不写成「a agent」', async () => {
    mocks.doc = '/x/agents/a1.md'
    mocks.kind = 'agent'
    const verdict = verdictIn(await readWith(readResult(BROKEN_AGENT)))
    expect(verdict!.startsWith(INVALID_HEAD('an agent file'))).toBe(true)
    expect(verdict).not.toContain('a agent')
  })

  it.each([
    ['hook', '/x/hooks/watcher.md', HOOK_UNKNOWN_TRIGGER, 'no.such.trigger'],
    ['bot', '/x/bots/buddy.md', BOT_V1_PIPELINE, 'shuvix-bot-pipeline']
  ])(
    'PV-4 合法但有警告（%s）→ 「valid … file, with warnings:」+ 解析器的原话',
    async (kind, doc, text, mention) => {
      mocks.doc = doc
      mocks.kind = kind
      const verdict = verdictIn(await readWith(readResult(text)))
      expect(verdict!.startsWith(WARNED_HEAD(kind))).toBe(true)
      expect(verdict).toContain(mention)
    }
  )

  it('PV-5 解析器判非法却没给原因 → 「- (the parser gave no reason)」', async () => {
    mocks.doc = '/x/policies/mine.md'
    mocks.kind = 'policy'
    mocks.validate = () => ({ status: 'invalid', messages: [] })
    const verdict = verdictIn(await readWith(readResult(VALID_POLICY)))
    expect(verdict).toBe(`${INVALID_HEAD('a policy file')}(the parser gave no reason)`)
  })

  it('PV-6 载体不是 ShuviX 文件（普通项目的笔记）→ 按文件自己的标记兜底：写坏的 agent md 判成非法 agent', async () => {
    mocks.doc = '/proj/notes/a1.md'
    mocks.kind = null
    const verdict = verdictIn(await readWith(readResult(BROKEN_AGENT)))
    expect(verdict!.startsWith(INVALID_HEAD('an agent file'))).toBe(true)
  })

  it.each([
    ['普通 md', null, '# Plain\n\nbody\n'],
    [
      '知识库条目（okf 标记）',
      null,
      '---\nshuvix: okf v0.2\ntype: Memory\ntitle: T\n---\n\nbody\n'
    ],
    [
      '记忆 md',
      null,
      '---\nshuvix: memory v1\nname: x\ndescription: d\nshuvix-memory-recall: r\n---\nbody\n'
    ],
    ['技能载体里的写坏 agent md', 'skill', BROKEN_AGENT],
    ['知识库载体里的写坏 agent md', 'knowledge', BROKEN_AGENT]
  ])('PV-7 不判：%s → 没有 Parse check', async (_label, kind, text) => {
    mocks.doc = '/x/docs/a.md'
    mocks.kind = kind
    const out = await readWith(readResult(text))
    expect(out).not.toContain('Parse check')
  })

  it.each([
    ['策略载体', 'policy', INVALID_POLICY],
    ['标记兜底', null, BROKEN_AGENT]
  ])('PV-7b 文档不是 md（%s）→ 没有 Parse check', async (_label, kind, text) => {
    mocks.doc = '/x/a.txt'
    mocks.kind = kind
    expect(await readWith(readResult(text))).not.toContain('Parse check')
  })

  it('PV-8 载体胜过标记：策略载体里的一份 agent md 按策略判 —— 非法，说的是 policy file', async () => {
    mocks.doc = '/x/policies/a1.md'
    mocks.kind = 'policy'
    const verdict = verdictIn(await readWith(readResult(VALID_AGENT)))
    expect(verdict!.startsWith(INVALID_HEAD('a policy file'))).toBe(true)
    expect(verdict!.split('\n')[0]).not.toContain('agent')
  })

  it('PV-9 判定按全文：frontmatter 越过 200000 字符的策略，读回被截断，判定照样是合法策略', async () => {
    mocks.doc = '/x/policies/big.md'
    mocks.kind = 'policy'
    const big = VALID_POLICY.replace(
      /^description: .*$/m,
      `description: ${'long description '.repeat(12_000).trim()}`
    )
    // 自检：frontmatter 的结束行确实在截断点之后
    expect(big.indexOf('\n---\n', 4)).toBeGreaterThan(200_000)
    const out = await readWith(readResult(big))
    expect(out).toContain('(Truncated after 200000 characters.)')
    expect(verdictIn(out)).toMatch(
      /^Parse check: ShuviX parses this document as a valid policy file/
    )
  })

  it.each([
    [
      '种类查询抛错',
      (): void => {
        mocks.doc = '/x/policies/mine.md'
        mocks.kindThrows = true
      }
    ],
    [
      '解析器抛错',
      (): void => {
        mocks.doc = '/x/policies/mine.md'
        mocks.kind = 'policy'
        mocks.validate = () => {
          throw new Error('parser crashed')
        }
      }
    ],
    [
      '会话没有文档（桥照样交回了全文）',
      (): void => {
        mocks.doc = null
      }
    ]
  ])('PV-10 判定出错只是没有这句（%s）：读本身成功', async (_label, arrange) => {
    arrange()
    // readWith → run() 断言了不是 isError
    const out = await readWith(readResult(BROKEN_AGENT))
    expect(out).toContain('</document>')
    expect(out).not.toContain('Parse check')
  })

  it("PV-11 解析器拿到的名字是去掉扩展名的文件名：原因里写 `agent 'my-agent'`", async () => {
    mocks.doc = '/x/agents/my-agent.md'
    mocks.kind = 'agent'
    const verdict = verdictIn(await readWith(readResult(BROKEN_AGENT)))
    expect(verdict).toContain("agent 'my-agent'")
    expect(verdict).not.toContain('my-agent.md')
  })

  it('PV-12 formatReadResult：判定为空（null / undefined / 空串）与不传一样；否则接在最后、隔一个空行', () => {
    const result = { ok: true as const, kind: 'read' as const, text: 'x', user: user() }
    const bare = mod.formatReadResult(result)
    for (const v of [null, undefined, '']) expect(mod.formatReadResult(result, v)).toBe(bare)
    expect(mod.formatReadResult(result, 'Parse check: X')).toBe(`${bare}\n\nParse check: X`)
    const disk = { ok: true as const, kind: 'read' as const, text: 'x' }
    expect(mod.formatReadResult(disk, 'V')).toBe(`${mod.formatReadResult(disk)}\n\nV`)
  })

  it('PV-13 守护：提示词说「doc_read 会说能不能解析」的种类 = parseVerdictOf 真给判定的种类', () => {
    const kinds = Object.keys({
      agent: true,
      bot: true,
      policy: true,
      hook: true,
      skill: true,
      knowledge: true
    } satisfies Record<ShuvixFileKind, true>) as ShuvixFileKind[]
    let promised = 0
    for (const kind of kinds) {
      mocks.kind = kind
      const promises = renderDocumentKind('en', { kind }).includes('doc_read')
      const verdict = mod.parseVerdictOf(SID, '/x/minimal.md', '# minimal\n')
      expect(verdict !== null, kind).toBe(promises)
      if (promises) promised++
    }
    // 正控制组：两个方向都走到了
    expect(promised).toBe(4)
  })
})

describe('RC 编辑回执按承载项目校正', () => {
  const CONTEXT = '1│---\n2│x'
  const HEAD = `Replaced at line 1. The text there now:\n${CONTEXT}`
  const INSERT_HEAD = `Inserted at line 1. The text there now:\n${CONTEXT}`
  /** 跑一次 doc_edit（或 doc_insert），编辑器交回改动后的全文 text；回工具输出 */
  async function changeWith(text: string, kind: 'edit' | 'insert' = 'edit'): Promise<string> {
    mocks.request.mockResolvedValueOnce({
      ok: true,
      kind,
      line: 1,
      context: CONTEXT,
      waitedMs: 0,
      text
    })
    return kind === 'edit'
      ? run(editTool(), { find: 'a', replace: 'b' })
      : run(insertTool(), { text: 'b' })
  }
  /** LD-1 那份原回执的开头（写后处理按 agent 标记判） */
  const AGENT_RECEIPT = `${HEAD}\n\n[shuvix agent v1] The document was changed, but it is INVALID and will be ignored until fixed:\n- `

  it('RC-1 策略载体里没写标记的策略，改坏了 → 回执是「cannot parse … as a policy file」', async () => {
    mocks.doc = '/x/policies/mine.md'
    mocks.kind = 'policy'
    const out = await changeWith(withoutMarker(INVALID_POLICY))
    expect(out.startsWith(`${HEAD}\n\n${INVALID_HEAD('a policy file')}`)).toBe(true)
    expect(out).not.toContain('[shuvix')
  })

  it('RC-2 同样没写标记，改完仍合法、没有警告 → 不附回执', async () => {
    mocks.doc = '/x/policies/mine.md'
    mocks.kind = 'policy'
    const out = await changeWith(withoutMarker(VALID_POLICY))
    expect(out).toBe(HEAD)
    expect(out).not.toContain('Parse check')
    expect(out).not.toContain('[shuvix')
  })

  it('RC-3 策略载体里的文本带着 agent 标记 → 按策略判（不是 agent 标记那份回执）', async () => {
    mocks.doc = '/x/policies/a1.md'
    mocks.kind = 'policy'
    const out = await changeWith(BROKEN_AGENT)
    expect(out.startsWith(`${HEAD}\n\n${INVALID_HEAD('a policy file')}`)).toBe(true)
    expect(out).not.toContain('[shuvix agent')
  })

  it('RC-4 标记与载体一致（policy v1），改坏了 → 原样是写后处理那份 `[shuvix policy v1] … INVALID` 回执', async () => {
    mocks.doc = '/x/policies/mine.md'
    mocks.kind = 'policy'
    const out = await changeWith(INVALID_POLICY)
    expect(
      out.startsWith(
        `${HEAD}\n\n[shuvix policy v1] The document was changed, but it is INVALID and will be ignored until fixed:\n- `
      )
    ).toBe(true)
    expect(out).not.toContain('Parse check')
  })

  it.each([
    ['载体不是 ShuviX 文件', null],
    ['技能载体（不归真解析）', 'skill']
  ])('RC-5 %s → 原回执（LD-1 那份）', async (_label, kind) => {
    mocks.doc = '/proj/agents/a1.md'
    mocks.kind = kind
    const out = await changeWith(BROKEN_AGENT)
    expect(out.startsWith(AGENT_RECEIPT)).toBe(true)
    expect(out).not.toContain('Parse check')
  })

  it('RC-7 种类查询抛错 → 原回执', async () => {
    mocks.doc = '/proj/agents/a1.md'
    mocks.kindThrows = true
    const out = await changeWith(BROKEN_AGENT)
    expect(out.startsWith(AGENT_RECEIPT)).toBe(true)
    expect(out).not.toContain('Parse check')
  })

  it.each([
    ['agent', '/x/agents/a1.md', VALID_AGENT],
    ['policy', '/x/policies/mine.md', VALID_POLICY]
  ])(
    'PV-14 标记与载体一致（%s）、改完合法：doc_edit / doc_insert 都不附回执，更不会出现「valid … file.」那句',
    async (kind, doc, text) => {
      mocks.doc = doc
      mocks.kind = kind
      const edited = await changeWith(text, 'edit')
      expect(edited).toBe(HEAD)
      const inserted = await changeWith(text, 'insert')
      expect(inserted).toBe(INSERT_HEAD)
      for (const out of [edited, inserted]) {
        expect(out).not.toContain('Parse check')
        expect(out).not.toContain(VALID_VERDICT(kind))
      }
    }
  )
})

describe('T6 交给编辑器之前过会话权限表', () => {
  it('T6 读判读、改判写；判的是这条会话的文档；门不放行就抛', async () => {
    mocks.doc = '/proj/notes/plan.md'
    mocks.gates.length = 0
    mocks.gateError = null
    mocks.request.mockImplementation(async (_sid, op, _signal, _onDisk, beforeLive) => {
      await beforeLive?.()
      return op.kind === 'read'
        ? readResult('x')
        : { ok: true, kind: op.kind, line: 1, context: '1│x', waitedMs: 0, text: 'x' }
    })

    await run(readTool(), {})
    await run(editTool(), { find: 'old', replace: 'NEW' })
    expect(mocks.gates.map((g) => [g.mode, g.path, g.opts.toolName])).toEqual([
      ['read', '/proj/notes/plan.md', 'doc_read'],
      ['write', '/proj/notes/plan.md', 'doc_edit']
    ])
    expect(mocks.gates[1].opts.toolCallId).toBe('tc-1')

    mocks.gateError = new Error('Blocked: this document is read-only for this session')
    const out = await failure(editTool(), { find: 'old', replace: 'NEW' })
    expect(out).toContain('read-only for this session')
    mocks.gateError = null
    mocks.request.mockReset()
  })
})

describe('SC bot 文档的排期回执（编辑器这一侧）', () => {
  const savedTz = process.env.TZ
  beforeEach(() => {
    process.env.TZ = 'Asia/Shanghai'
    // 与 docDiskFallback.test 的 DF-SC 同一刻（那边定在将来，读后被改守卫才不误判）：两边的排期逐字相同
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2030, 10, 2, 12, 0, 30))
  })
  afterEach(() => {
    vi.useRealTimers()
    if (savedTz === undefined) delete process.env.TZ
    else process.env.TZ = savedTz
  })

  const CONTEXT = '1│---\n2│x'
  const HEAD = `Replaced at line 1. The text there now:\n${CONTEXT}`
  const INSERT_HEAD = `Inserted at line 1. The text there now:\n${CONTEXT}`
  /** 每天 20:00（或给定时刻）一条定时绑定的 bot */
  const BOT = (
    time = '20:00',
    marker: string | null = 'shuvix: bot v2',
    extra: string[] = []
  ): string =>
    [
      '---',
      ...(marker === null ? [] : [marker]),
      'name: buddy',
      ...extra,
      'shuvix-bot-on:',
      '  - trigger: timer.fired',
      `    when: "event.local.time == '${time}'"`,
      '    message: Evening check-in.',
      '---',
      '',
      'Persona.',
      ''
    ].join('\n')
  /** 与 docDiskFallback.test 的 DF-SC 那份逐字相同 */
  const SCHEDULE = (time = '20:00'): string =>
    'Schedule check (local time, the next 14 days):\n' +
    `- binding #0 (timer.fired): next at Sat 2030-11-02 ${time}, Sun 2030-11-03 ${time}, Mon 2030-11-04 ${time}.`
  const schedules = (out: string): number => out.split('Schedule check').length - 1

  /** 跑一次 doc_edit（或 doc_insert），编辑器交回改动后的全文 text；回工具输出 */
  async function changeWith(text: string, kind: 'edit' | 'insert' = 'edit'): Promise<string> {
    mocks.request.mockResolvedValueOnce({
      ok: true,
      kind,
      line: 1,
      context: CONTEXT,
      waitedMs: 0,
      text
    })
    return kind === 'edit'
      ? run(editTool(), { find: 'a', replace: 'b' })
      : run(insertTool(), { text: 'b' })
  }

  it.each([
    ['载体 bot', 'bot'],
    ['载体不是 ShuviX 文件，按标记兜底', null]
  ])(
    'SC-1 doc_read 合法 bot（%s）→ 最后是 `Parse check: … valid bot file.` + 空行 + 排期，各一次',
    async (_label, kind) => {
      mocks.doc = '/x/bots/buddy.md'
      mocks.kind = kind
      const out = await readWith(readResult(BOT()))
      expect(out.endsWith(`\n\n${VALID_VERDICT('bot')}\n\n${SCHEDULE()}`)).toBe(true)
      expect(schedules(out)).toBe(1)
      expect(out.split('Parse check:')).toHaveLength(2)
    }
  )

  it('SC-2 doc_read：解析不过的 bot / 没有定时绑定 → 只有 Parse check', async () => {
    mocks.doc = '/x/bots/buddy.md'
    mocks.kind = 'bot'
    const broken = BOT().replace(
      'shuvix-bot-on:\n',
      'shuvix-bot-on:\n  - trigger: session.turn-completed\n    message: Hi.\n'
    )
    const invalid = await readWith(readResult(broken))
    expect(verdictIn(invalid)!.startsWith(INVALID_HEAD('a bot file'))).toBe(true)
    expect(schedules(invalid)).toBe(0)

    const plain = await readWith(readResult('---\nshuvix: bot v2\nname: buddy\n---\n\nPersona.\n'))
    expect(verdictIn(plain)).toBe(VALID_VERDICT('bot'))
    expect(schedules(plain)).toBe(0)
  })

  it.each([['policy'], ['agent']])(
    'SC-3 载体 %s：文本带着 bot 标记与定时绑定，doc_read 与 doc_edit 都没有排期',
    async (kind) => {
      mocks.doc = `/x/${kind}s/buddy.md`
      mocks.kind = kind
      const read = await readWith(readResult(BOT()))
      expect(verdictIn(read)).not.toBeNull()
      expect(schedules(read)).toBe(0)
      const edited = await changeWith(BOT())
      expect(schedules(edited)).toBe(0)
    }
  )

  it.each([
    ['载体 bot', 'bot'],
    ['载体不是 ShuviX 文件，按标记兜底', null]
  ])(
    'SC-4 doc_edit / doc_insert 合法 bot（%s，带标记）→ 恰一段排期，没有 Parse check',
    async (_label, kind) => {
      mocks.doc = '/x/bots/buddy.md'
      mocks.kind = kind
      expect(await changeWith(BOT(), 'edit')).toBe(`${HEAD}\n\n${SCHEDULE()}`)
      expect(await changeWith(BOT(), 'insert')).toBe(`${INSERT_HEAD}\n\n${SCHEDULE()}`)
    }
  )

  it('SC-5 载体 bot、没写标记：干净 → 恰一段排期、没有 Parse check；带 v1 管线块 → 警告那段 + 排期，各一次', async () => {
    mocks.doc = '/x/bots/buddy.md'
    mocks.kind = 'bot'
    expect(await changeWith(BOT('20:00', null))).toBe(`${HEAD}\n\n${SCHEDULE()}`)

    const warned = await changeWith(BOT('20:00', null, ['shuvix-bot-pipeline:', '  - step: chat']))
    expect(warned.startsWith(`${HEAD}\n\n${WARNED_HEAD('bot')}`)).toBe(true)
    expect(warned.endsWith(`\n\n${SCHEDULE()}`)).toBe(true)
    expect(warned.split('Parse check:')).toHaveLength(2)
    expect(schedules(warned)).toBe(1)
  })

  it('SC-6 种类查询抛错 + bot 标记 → 写后处理那段照留（RC-7）、排期一次', async () => {
    mocks.doc = '/x/bots/buddy.md'
    mocks.kindThrows = true
    const out = await changeWith(
      BOT('20:00', 'shuvix: bot v1', ['shuvix-bot-pipeline:', '  - step: chat'])
    )
    expect(out.startsWith(`${HEAD}\n\n[shuvix bot v1] Written with parser warnings:\n- `)).toBe(
      true
    )
    expect(out.endsWith(`\n\n${SCHEDULE()}`)).toBe(true)
    expect(schedules(out)).toBe(1)
    expect(out).not.toContain('Parse check')
  })

  it('SC-7 载体 bot、文本是 agent 标记（带着定时绑定）→ 非法那段，没有排期', async () => {
    mocks.doc = '/x/bots/buddy.md'
    mocks.kind = 'bot'
    const out = await changeWith(BOT('20:00', 'shuvix: agent v1'))
    expect(out.startsWith(`${HEAD}\n\n${INVALID_HEAD('a bot file')}`)).toBe(true)
    expect(schedules(out)).toBe(0)
  })

  it('SC-8 20:00 改成 21:00 → 回执里是 21:00（排期那段与磁盘回落 DF-SC 的逐字相同）', async () => {
    mocks.doc = '/x/bots/buddy.md'
    mocks.kind = 'bot'
    expect(await changeWith(BOT('20:00'))).toBe(`${HEAD}\n\n${SCHEDULE('20:00')}`)
    const later = await changeWith(BOT('21:00'))
    expect(later).toBe(`${HEAD}\n\n${SCHEDULE('21:00')}`)
    expect(later).not.toContain('20:00')
  })
})
