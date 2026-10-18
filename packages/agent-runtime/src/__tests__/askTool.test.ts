/**
 * ask 工具（askTool.ts）—— pi-durable 原生注册项。
 *
 * 契约（文件头 + 裁定 Q12）：
 *   ASK-1 注册项形状：name 'ask'、`replay: 'safe'`（问一句不改任何东西，中断后重跑 = 再问一遍）、
 *         schema / 描述、label 缺省 'Ask' 可由宿主换、durable 兜底截断取 2× 缺省
 *   ASK-2 询问 id = `api.callId`；请求的其余字段（choice / ask / question / options）；单选多选不由模型定，
 *         它多传的 `allowMultiple` 不进请求
 *   ASK-3 应答 → 结果文字与 details（选了 / 没选 / 写了反馈 / 意外的应答种类）
 *   ASK-4 用户取消卡片（调用没被取消）→ isError 结果，文字是 abortError（缺省 'Aborted'），不抛
 *   ASK-5 询问通道出错（requestUserInput 抛 / reject）→ isError 结果，文字即那条错误
 *   ASK-6 context 已取消 → 调用拒绝（取消照旧抛），根本不发起询问
 *   ASK-7 等待中被取消 → 立刻拒绝，哪怕询问永远没人应答
 *   ASK-8 应答到了、但此时调用已被取消 → 拒绝（不交回结果）
 *   WP2-11..20 答题方（docs/sub-session-design.md §19.5）：应答带 `answeredBy` → 按父会话代答写结果文字，
 *         details 带答题方的拷贝；没有 → 与用户本人答的一字不差；取消照旧；`PARENT_ANSWERED` 固定英文
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type {
  InputRequest,
  InputResponse,
  ParentSessionRef
} from '@shuvix/chat-protocol/types/inputRequest'
import * as runtime from '../index'
import { AskParamsSchema, ASK_DESCRIPTION, PARENT_ANSWERED, createAskTool } from '../askTool'
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from '../fileTools/truncate'
import { invokeTool, resultText } from '../tools/testing/invokeTool'

const ARGS = {
  question: 'Which style?',
  options: [
    { label: 'Terse', description: 'Short answers' },
    { label: 'Verbose', description: 'Long answers' }
  ]
}

/** 记下每一次询问、按给定应答作答的通道 */
function channel(answer: (req: InputRequest) => InputResponse | Promise<InputResponse>): {
  requestUserInput: ReturnType<typeof vi.fn<(req: InputRequest) => Promise<InputResponse>>>
} {
  return { requestUserInput: vi.fn(async (req: InputRequest) => answer(req)) }
}

describe('ASK 注册项形状', () => {
  it('ASK-1 name / replay safe / schema / 描述 / label（缺省与宿主给的）/ 兜底截断', () => {
    const tool = createAskTool({ requestUserInput: vi.fn() })
    expect(tool).toMatchObject({
      name: 'ask',
      label: 'Ask',
      replay: 'safe',
      description: ASK_DESCRIPTION,
      outputLimits: {
        maxBytes: 2 * DEFAULT_MAX_BYTES,
        maxLines: 2 * DEFAULT_MAX_LINES,
        retain: 'head'
      }
    })
    expect(tool.parameters).toBe(AskParamsSchema)
    expect(createAskTool({ requestUserInput: vi.fn(), label: '询问' }).label).toBe('询问')
  })
})

describe('ASK 询问与应答', () => {
  it('ASK-2 询问 id 就是 api.callId；其余字段照参数填，模型多传的 allowMultiple 不进请求', async () => {
    const { requestUserInput } = channel(() => ({ kind: 'choice', selections: ['Terse'] }))
    const tool = createAskTool({ requestUserInput })

    await invokeTool(tool, ARGS, { callId: 'call-ask-1', taskId: 7 })
    // 旧参数已不在 schema 里，但多出的键过得了校验 —— 模型照旧传也不会被拒
    const withStrayFlag = { ...ARGS, allowMultiple: true }
    await invokeTool(tool, withStrayFlag, { callId: 'call-ask-2' })

    expect(requestUserInput).toHaveBeenCalledTimes(2)
    expect(requestUserInput.mock.calls[0][0]).toStrictEqual({
      id: 'call-ask-1',
      kind: 'choice',
      toolName: 'ask',
      question: 'Which style?',
      options: ARGS.options,
      createdAt: expect.any(Number)
    })
    expect(requestUserInput.mock.calls[1][0]).toMatchObject({ id: 'call-ask-2' })
    expect(requestUserInput.mock.calls[1][0]).not.toHaveProperty('allowMultiple')
  })

  it.each([
    [
      '选了两项',
      { kind: 'choice', selections: ['Terse', 'Verbose'] },
      'User selected: Terse, Verbose',
      ['Terse', 'Verbose']
    ],
    ['一项没选', { kind: 'choice', selections: [] }, 'User made no selection', []],
    [
      '写了反馈',
      { kind: 'other', text: 'neither, be funny' },
      'User did not select any option and responded with feedback instead:\nneither, be funny',
      []
    ],
    [
      '意外的应答种类',
      { kind: 'ask', allowed: true },
      'User input error: unexpected response kind',
      []
    ]
  ])('ASK-3 %s → 文字与 details', async (_label, response, text, selections) => {
    const { requestUserInput } = channel(() => response as InputResponse)
    const { result } = await invokeTool(createAskTool({ requestUserInput }), ARGS)

    expect(result).toStrictEqual({
      content: [{ type: 'text', text }],
      details: { type: 'ask', question: 'Which style?', selections }
    })
    // WP2-13 用户本人答的：结果一字不变，details 里根本没有答题方
    expect(result.details).not.toHaveProperty('answeredBy')
  })
})

describe('ASK 失败与取消', () => {
  it('ASK-4 用户取消卡片（调用本身没被取消）→ isError，文字是 abortError；不抛', async () => {
    const cancel = (): InputResponse => ({ kind: 'cancel', reason: 'aborted' })

    const byDefault = await invokeTool(createAskTool(channel(cancel)), ARGS)
    expect(byDefault.result).toStrictEqual({
      isError: true,
      content: [{ type: 'text', text: 'Aborted' }]
    })

    const custom = await invokeTool(
      createAskTool({ ...channel(cancel), abortError: 'TOOL_ABORTED' }),
      ARGS
    )
    expect(custom.result.isError).toBe(true)
    expect(resultText(custom.result)).toBe('TOOL_ABORTED')
  })

  it('ASK-5 询问通道出错 → isError，文字即那条错误（同步抛与 reject 一样）', async () => {
    const throwing = createAskTool({
      requestUserInput: () => {
        throw new Error('requestUserInput callback not available')
      }
    })
    const { result } = await invokeTool(throwing, ARGS)
    expect(result).toStrictEqual({
      isError: true,
      content: [{ type: 'text', text: 'requestUserInput callback not available' }]
    })

    const rejecting = createAskTool({
      requestUserInput: () => Promise.reject(new Error('frontend gone'))
    })
    expect(resultText((await invokeTool(rejecting, ARGS)).result)).toBe('frontend gone')
  })

  it('ASK-6 context 已取消 → 调用拒绝，根本不发起询问', async () => {
    const { requestUserInput } = channel(() => ({ kind: 'choice', selections: [] }))
    const ac = new AbortController()
    ac.abort()

    await expect(
      invokeTool(createAskTool({ requestUserInput }), ARGS, { signal: ac.signal })
    ).rejects.toThrow('Aborted')
    expect(requestUserInput).not.toHaveBeenCalled()
  })

  it('ASK-7 等待中被取消 → 立刻拒绝，哪怕询问永远没人应答', async () => {
    const requestUserInput = vi.fn(() => new Promise<InputResponse>(() => {}))
    const ac = new AbortController()

    const call = invokeTool(createAskTool({ requestUserInput }), ARGS, { signal: ac.signal })
    await vi.waitFor(() => expect(requestUserInput).toHaveBeenCalledTimes(1))
    ac.abort()

    await expect(call).rejects.toBeDefined()
    expect(ac.signal.aborted).toBe(true)
  })

  it('ASK-8 应答到了、但调用已在这之前被取消 → 拒绝，不交回结果', async () => {
    const ac = new AbortController()
    const requestUserInput = vi.fn(async (): Promise<InputResponse> => {
      // 会话中止的顺序：先撤询问（这里以「选了」作答模拟应答抢先到达），同一刻取消调用
      ac.abort()
      return { kind: 'choice', selections: ['Terse'] }
    })

    await expect(
      invokeTool(createAskTool({ requestUserInput }), ARGS, { signal: ac.signal })
    ).rejects.toBeDefined()
  })
})

describe('ASK 答题方（WP2，§19.5）', () => {
  const PARENT = { kind: 'parent-session', sessionId: 'P1', title: '重构 parser' } as const

  it('WP2-11 父会话代答（选了两项）→ 以 PARENT_ANSWERED 开头，details 带答题方', async () => {
    const { requestUserInput } = channel(() => ({
      kind: 'choice',
      selections: ['Terse', 'Verbose'],
      answeredBy: PARENT
    }))
    const { result } = await invokeTool(createAskTool({ requestUserInput }), ARGS)

    expect(result).toStrictEqual({
      content: [{ type: 'text', text: `${PARENT_ANSWERED} Selected: Terse, Verbose` }],
      details: {
        type: 'ask',
        question: 'Which style?',
        selections: ['Terse', 'Verbose'],
        answeredBy: PARENT
      }
    })
    const text = resultText(result)
    expect(text.startsWith(PARENT_ANSWERED)).toBe(true)
    expect(text).not.toContain('User selected')
  })

  it('WP2-12 父会话用自己的话答 → 写明它写了什么，selections 为空，details 带答题方', async () => {
    const { requestUserInput } = channel(() => ({
      kind: 'other',
      text: 'neither, be funny',
      answeredBy: PARENT
    }))
    const { result } = await invokeTool(createAskTool({ requestUserInput }), ARGS)

    expect(resultText(result)).toBe(
      `${PARENT_ANSWERED} Instead of picking an option, it wrote:\nneither, be funny`
    )
    expect(resultText(result)).not.toContain('User did not select')
    expect(result.details).toStrictEqual({
      type: 'ask',
      question: 'Which style?',
      selections: [],
      answeredBy: PARENT
    })
  })

  it('WP2-14 答题方没有 title → details.answeredBy 也没有 title 键', async () => {
    const { requestUserInput } = channel(() => ({
      kind: 'choice',
      selections: ['Terse'],
      answeredBy: { kind: 'parent-session', sessionId: 'P1' }
    }))
    const { result } = await invokeTool(createAskTool({ requestUserInput }), ARGS)
    expect((result.details as { answeredBy?: unknown }).answeredBy).toStrictEqual({
      kind: 'parent-session',
      sessionId: 'P1'
    })
  })

  it('WP2-15 有答题方就不是用户本人（失败闭合）：kind 不认识的答题方也按父会话代答写', async () => {
    // 宿主只在父会话代答时写 answeredBy；形状不对的那一项宁可算「不是用户」，也不当成用户本人的回答
    const odd = { kind: 'user', sessionId: 'x' }
    const { requestUserInput } = channel(
      () => ({ kind: 'choice', selections: ['Terse'], answeredBy: odd }) as never
    )
    const { result } = await invokeTool(createAskTool({ requestUserInput }), ARGS)
    expect(resultText(result)).toBe(`${PARENT_ANSWERED} Selected: Terse`)
    expect(resultText(result)).not.toContain('User selected')
    expect((result.details as { answeredBy?: unknown }).answeredBy).toStrictEqual(odd)
  })

  it('WP2-16 父会话代答却一项没选 → 「It made no selection.」', async () => {
    const { requestUserInput } = channel(() => ({
      kind: 'choice',
      selections: [],
      answeredBy: PARENT
    }))
    const { result } = await invokeTool(createAskTool({ requestUserInput }), ARGS)
    expect(result).toStrictEqual({
      content: [{ type: 'text', text: `${PARENT_ANSWERED} It made no selection.` }],
      details: { type: 'ask', question: 'Which style?', selections: [], answeredBy: PARENT }
    })
  })

  it('WP2-17 取消不受答题方影响：照旧 isError「Aborted」，不出现 PARENT_ANSWERED', async () => {
    const { requestUserInput } = channel(() => ({
      kind: 'cancel',
      reason: 'aborted',
      answeredBy: PARENT
    }))
    const { result } = await invokeTool(createAskTool({ requestUserInput }), ARGS)
    expect(result).toStrictEqual({ isError: true, content: [{ type: 'text', text: 'Aborted' }] })
    expect(JSON.stringify(result)).not.toContain(PARENT_ANSWERED)
  })

  it('WP2-18 意外的应答种类（ask）带答题方：文字照旧是输入错误，details 现状带上答题方', async () => {
    // 现状记录：ask 型应答本不该交到 ask 工具手里（PendingInputRequests 拒收带答题方的非选择题，WP2-10）
    const { requestUserInput } = channel(() => ({ kind: 'ask', allowed: true, answeredBy: PARENT }))
    const { result } = await invokeTool(createAskTool({ requestUserInput }), ARGS)
    expect(result).toStrictEqual({
      content: [{ type: 'text', text: 'User input error: unexpected response kind' }],
      details: { type: 'ask', question: 'Which style?', selections: [], answeredBy: PARENT }
    })
  })

  it('WP2-19 details.answeredBy 是拷贝：之后改应答里的那一项不影响已交回的结果', async () => {
    const answeredBy: ParentSessionRef = { ...PARENT }
    const { requestUserInput } = channel(() => ({
      kind: 'choice',
      selections: ['Terse'],
      answeredBy
    }))
    const { result } = await invokeTool(createAskTool({ requestUserInput }), ARGS)
    const details = result.details as { answeredBy?: unknown }
    expect(details.answeredBy).not.toBe(answeredBy)
    answeredBy.title = 'changed later'
    expect(details.answeredBy).toStrictEqual(PARENT)
  })

  it('WP2-20 PARENT_ANSWERED 从包入口导出，是固定英文串；ask 工具不经 i18n（进模型上下文的字不随界面语言变）', () => {
    expect(runtime.PARENT_ANSWERED).toBe(PARENT_ANSWERED)
    expect(PARENT_ANSWERED).toBe(
      'The user did not answer this — the session that assigned you this task answered on their behalf.'
    )
    // agent-runtime 本身不依赖 i18next：源码里没有任何 i18n 入口，文字就不可能随语言变
    const here = dirname(fileURLToPath(import.meta.url))
    const source = readFileSync(resolve(here, '../askTool.ts'), 'utf8')
    const specifiers = [...source.matchAll(/(?:from|import)\s+'([^']+)'/g)].map((m) => m[1]!)
    expect(specifiers.length).toBeGreaterThan(0)
    for (const specifier of specifiers) expect(specifier).not.toMatch(/i18n/)
  })
})
