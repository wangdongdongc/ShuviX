/**
 * 协作编辑工具 doc_read / doc_edit / doc_insert —— 参数面、结果排版、与主进程桥的接线。
 *
 * 契约（tools/doc.ts 文件头 + chat-protocol liveDocument.ts）：
 *   - 目标文档恒取 ToolContext.sessionId 挂着的窗口，工具不收路径参数；
 *   - doc_read 的结果：带行号的全文（`<document lines="N">`，行号按总行数补齐宽度，末尾换行多出一个空行），
 *     一句「用户在哪」（光标行与所在标题、选区 JSON 引起来、屏幕上的行 `a–b`、距上次打字多久 / 没打过），
 *     有用户改动时再附一段 diff；超长截断并说明；
 *   - doc_edit / doc_insert 把 toolCallId、会话、signal 交给桥；没给的锚点（含空串）不发；结果说「在第几行」，
 *     等过用户就说等了多久（不到一秒说 under a second）；
 *   - 参数本身不成立的（空 find、两个锚点、空 text）在交给桥之前就抛；窗口答 `{ok:false}` → 以它的 error
 *     抛出（步骤行红）；答非所问 → 「Unexpected answer」；
 *   - 三个工具都注册在 general 组；折叠行摘要取定位原文 / 插入文字的第一行非空文字，过长截断。
 *
 * 桥换成可捕获的假件（requestLiveDocument）；i18n 原样回 key；工具类直接 new 出来经 BaseTool.execute 驱动。
 *
 *   T1 schema：doc_read 无属性；doc_edit 必填 find + replace；doc_insert 键序 after, before, text，只 text 必填
 *   T2 doc_read 的结果排版（行号、末尾空行、用户那句话的各分支、diff 块、截断）
 *   T3 doc_edit / doc_insert 交给桥的东西与结果排版（等待时长）
 *   T4 交给桥之前就抛的；{ok:false} → 抛；答非所问 → 抛
 *   T5 注册在 general 组；折叠行摘要
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  LiveDocOp,
  LiveDocResult,
  LiveDocUserContext
} from '@shuvix/chat-protocol/liveDocument'
import { BUILTIN_TOOL_PRESENTATIONS } from '@shuvix/chat-protocol/builtinToolPresentations'
import type { ToolContext } from '../../services/toolContext'

const mocks = vi.hoisted(() => ({
  request:
    vi.fn<(sessionId: string, op: LiveDocOp, signal?: AbortSignal) => Promise<LiveDocResult>>()
}))

vi.mock('../../services/liveDocumentBridge', () => ({ requestLiveDocument: mocks.request }))
vi.mock('../../i18n', () => ({ t: (key: string) => key }))

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

/** 工具结果的全文（只有一个文本块） */
async function run(
  tool: { execute: (id: string, params: never, signal?: AbortSignal) => Promise<unknown> },
  params: Record<string, unknown>,
  signal?: AbortSignal
): Promise<string> {
  const result = (await tool.execute('tc-1', params as never, signal)) as {
    content: Array<{ type: string; text: string }>
  }
  expect(result.content).toHaveLength(1)
  expect(result.content[0].type).toBe('text')
  return result.content[0].text
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
    expect(mocks.request.mock.calls[0]).toEqual([SID, { kind: 'read' }, ac.signal])
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
      waitedMs: 0
    })
    const out = await run(editTool(), { find: 'old', replace: 'NEW' }, ac.signal)
    expect(mocks.request.mock.calls[0]).toEqual([
      SID,
      { kind: 'edit', toolCallId: 'tc-1', find: 'old', replace: 'NEW' },
      ac.signal
    ])
    expect(out).toBe('Replaced at line 5. The text there now:\n4│before\n5│NEW\n6│after')
  })

  it('doc_edit：replace 为空串照样发（= 删掉那一段）', async () => {
    mocks.request.mockResolvedValueOnce({
      ok: true,
      kind: 'edit',
      line: 2,
      context: '2│',
      waitedMs: 0
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
      waitedMs: 0
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
      waitedMs
    })
    const out = await run(editTool(), { find: 'a', replace: 'x' })
    expect(out.split('\n')[0]).toBe(`Replaced at line 3${waited}. The text there now:`)
  })
})

describe('T4 失败', () => {
  it('doc_edit 空 find → 交给桥之前就抛，错误点名 doc_insert', async () => {
    await expect(run(editTool(), { find: '', replace: 'x' })).rejects.toThrow(/doc_insert/)
    expect(mocks.request).not.toHaveBeenCalled()
  })

  it('doc_insert 两个锚点都给 → 抛，没交给桥', async () => {
    await expect(run(insertTool(), { after: 'a', before: 'b', text: 'x' })).rejects.toThrow(
      'Give `after` or `before`, not both.'
    )
    expect(mocks.request).not.toHaveBeenCalled()
  })

  it('doc_insert 空 text → 抛，没交给桥', async () => {
    await expect(run(insertTool(), { text: '' })).rejects.toThrow('`text` is empty.')
    expect(mocks.request).not.toHaveBeenCalled()
  })

  it.each([
    ['doc_read', () => readTool(), {}],
    ['doc_edit', () => editTool(), { find: 'a', replace: 'b' }],
    ['doc_insert', () => insertTool(), { text: 'x' }]
  ])('%s：窗口答 {ok:false} → 以它的 error 抛出', async (_label, make, params) => {
    const error = '`find` does not match the current document.'
    mocks.request.mockResolvedValueOnce({ ok: false, error })
    await expect(run(make(), params)).rejects.toThrow(error)
  })

  it('桥本身失败（没有窗口 / 超时）→ 原样抛', async () => {
    mocks.request.mockRejectedValueOnce(new Error('No document window is open for this session.'))
    await expect(run(readTool(), {})).rejects.toThrow('No document window is open')
  })

  it('答非所问 → 「Unexpected answer」', async () => {
    mocks.request.mockResolvedValueOnce({
      ok: true,
      kind: 'edit',
      line: 1,
      context: '',
      waitedMs: 0
    })
    await expect(run(readTool(), {})).rejects.toThrow(/Unexpected answer/)

    mocks.request.mockResolvedValueOnce(readResult('x'))
    await expect(run(editTool(), { find: 'a', replace: 'b' })).rejects.toThrow(/Unexpected answer/)

    mocks.request.mockResolvedValueOnce(readResult('x'))
    await expect(run(insertTool(), { text: 'x' })).rejects.toThrow(/Unexpected answer/)
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
