/**
 * 派生 agent 的一轮以失败收尾时，SubAgentManager 在三处交出的结论 —— `sub_session_end.isError`、
 * 任务落定态、`runTask` 的 `outcome.error` —— 是同一个判定（manager 的 turnError）。
 *
 * 钉的是四条性质：
 *   - **模型调用报错也算失败**：provider 500 之类不经 `prompt()` 返回，只在会话树尾部落一条
 *     stopReason 为 error 的 assistant；交回的结果文本不因判定而改变；
 *   - **软停止（中断）不算失败，结果契约捕获恒为成功**；
 *   - **中止是失败**（任务落定 killed）；同一轮里既软停止又被中止时按中止判，文本仍按软停止抽取；
 *   - **出错的一轮不追问**：带结果契约的 run 这一轮已失败（含模型报错）就不再发补救 nudge。
 *
 * 通知规则（落定时还有人在等 → 不通知）在失败的轮次上同样成立，顺带钉住。
 *
 * fake 注入合并自 managerResultContract.test.ts（编排的 fake runtime、extraTools[0] 走 next）与
 * managerTasks.test.ts（真实 createTaskRegistry + deliver 记录 + 调小的合并窗口）。
 */
import { describe, expect, it, vi } from 'vitest'
import type { ChatEvent } from '@shuvix/chat-protocol/events'
import { createSubAgentManager, type RunTaskParams, type SubAgentManager } from '../manager'
import {
  createTaskRegistry,
  type TaskInfo,
  type TaskRegistry,
  type TaskStatus
} from '../../task/registry'
import type { AgentFactory, CreateAgentParams, CreatedAgent } from '../../agentProfile/createAgent'
import type { InProcessAgentType, SubAgentModelConfig } from '../types'
import { NEXT_NUDGE_TEXT, type ResultContract } from '../nextTool'

const TITLE_SCHEMA = {
  type: 'object',
  required: ['title'],
  properties: { title: { type: 'string' } }
}
const PROFILE: InProcessAgentType = {
  name: 'worker',
  displayName: 'Worker',
  description: '',
  tools: [],
  systemPrompt: 'S'
}
const MODEL: SubAgentModelConfig = { provider: 'p', model: 'm', capabilities: {} }
const CONTRACT: ResultContract = { schema: TITLE_SCHEMA, sourceLabel: 'wf-x' }

// ── 会话树素材：pi 落进内存树的消息形状（只含 extractResult / turnError 会读的字段） ──

type Msg = Record<string, unknown>
const E500 = '500 Internal Server Error'
const E503 = '503 Service Unavailable'
/** 带半截文本的报错 assistant */
const ERR_TEXT: Msg = {
  role: 'assistant',
  content: 'half an answer',
  stopReason: 'error',
  errorMessage: E500
}
/** 报错 assistant，只有一段空文本 */
const FAIL = (errorMessage: string): Msg => ({
  role: 'assistant',
  content: [{ type: 'text', text: '' }],
  stopReason: 'error',
  errorMessage
})
const OK = (text: string): Msg => ({ role: 'assistant', content: text, stopReason: 'stop' })
const USER = (text: string): Msg => ({ role: 'user', content: text })
const TOOL_USE: Msg = {
  role: 'assistant',
  content: [{ type: 'toolCall', id: 'c1', name: 'read', arguments: {} }],
  stopReason: 'toolUse'
}
/** 同 TOOL_USE，但调工具前先说了一句话 */
const TOOL_USE_WITH_TEXT: Msg = {
  role: 'assistant',
  content: [
    { type: 'text', text: 'Reading the file' },
    { type: 'toolCall', id: 'c1', name: 'read', arguments: {} }
  ],
  stopReason: 'toolUse'
}
const TOOL_RESULT: Msg = {
  role: 'toolResult',
  toolCallId: 'c1',
  toolName: 'read',
  content: [{ type: 'text', text: 'file body' }],
  isError: false
}
/** 报错却没带 errorMessage */
const ERR_BARE: Msg = { role: 'assistant', content: [], stopReason: 'error' }
/** stopReason 为 aborted 的中止痕迹 —— 但本协调器并没有中断 / 中止过它 */
const ABORTED_TAIL: Msg = {
  role: 'assistant',
  content: 'partial',
  stopReason: 'aborted',
  errorMessage: 'Request was aborted'
}
/** 早先报过错的一条（之后又恢复了） */
const EARLIER_ERROR: Msg = {
  role: 'assistant',
  content: 'first',
  stopReason: 'error',
  errorMessage: 'transient'
}

// ── 期望的结果文本：extractResult 的既有输出，原样钉住 ──

const ERR_TEXT_RESULT = 'half an answer\n\n[Note] stopReason=error; error=500 Internal Server Error'
const NO_TEXT_E500 =
  'Agent did not produce a final text response (1 assistant message(s), 0 tool call(s)). stopReason=error. Model errorMessage: 500 Internal Server Error.'
const NO_TEXT_BARE =
  'Agent did not produce a final text response (1 assistant message(s), 0 tool call(s)). stopReason=error.'
const CAPTURED_X = '{\n  "title": "X"\n}'
const ABORTED_NOTE = 'Aborted by user.'

type EndEvent = Extract<ChatEvent, { type: 'sub_session_end' }>
type UserMessageEvent = Extract<ChatEvent, { type: 'user_message' }>
type Reply = { error?: string }

interface Harness {
  manager: SubAgentManager
  /** 交给 manager 的任务枢纽（withFormatter 时即包过一层的那个） */
  tasks: TaskRegistry
  events: ChatEvent[]
  /** 任务枢纽的状态广播（快照，按顺序） */
  broadcasts: TaskInfo[]
  /** 通知投递记录：[sessionId, text] */
  delivered: Array<[string, string]>
  createCalls: CreateAgentParams[]
  promptTexts: string[]
  abort: ReturnType<typeof vi.fn>
  /** 内存会话树 —— buildContext 按引用交回，onPrompt 可在轮次之间往里 push */
  messages: unknown[]
  /** 「模型调 next」：取捕到的 extraTools[0] 走 BaseTool.execute */
  next: (value: Record<string, unknown>) => Promise<unknown>
  /** 这次派生的 agentId（= taskId = 事件频道） */
  agentId: () => string
  /** 全部 sub_session_end，按广播顺序 */
  ends: () => EndEvent[]
  /** 这个 agent 的任务快照 */
  task: () => TaskInfo | undefined
  /** 这个 agent 的任务广播状态序列 */
  statuses: () => TaskStatus[]
}

function makeHarness(
  o: {
    /** 每轮 prompt 的编排（round 从 1 起）；缺省 / 不返回 = 自然结束 */
    onPrompt?: (text: string, round: number, h: Harness) => Reply | void | Promise<Reply | void>
    /** 内存会话树的初始内容（按引用使用） */
    messages?: unknown[]
    /** 'withFormatter'：给登记的任务补上通知文案 —— 绊线，确认「不通知」不只是因为没有文案 */
    registry?: 'real' | 'withFormatter'
  } = {}
): Harness {
  const events: ChatEvent[] = []
  const broadcasts: TaskInfo[] = []
  const delivered: Array<[string, string]> = []
  const real = createTaskRegistry({
    broadcast: (t) => broadcasts.push(t),
    deliver: (sessionId, text) => delivered.push([sessionId, text]),
    coalesceMs: 5
  })
  const tasks: TaskRegistry =
    o.registry === 'withFormatter'
      ? { ...real, create: (p) => real.create({ ...p, formatNotice: () => 'NOTICE' }) }
      : real
  const createCalls: CreateAgentParams[] = []
  const promptTexts: string[] = []
  const messages = o.messages ?? []

  const runtime = {
    prompt: async (text: string): Promise<Reply> => {
      promptTexts.push(text)
      return (await o.onPrompt?.(text, promptTexts.length, h)) || {}
    },
    abort: vi.fn(async () => {}),
    session: {
      appendMessage: vi.fn(async () => {}),
      buildContext: async () => ({ messages })
    }
  }
  const createAgent = vi.fn(async (params: CreateAgentParams) => {
    createCalls.push(params)
    return { runtime, dispose: vi.fn() } as unknown as CreatedAgent
  })
  const manager = createSubAgentManager({
    createAgent: createAgent as unknown as AgentFactory['createAgent'],
    broadcast: (e) => events.push(e),
    tasks
  })

  const agentId = (): string => createCalls[0].sessionId
  const h: Harness = {
    manager,
    tasks,
    events,
    broadcasts,
    delivered,
    createCalls,
    promptTexts,
    abort: runtime.abort,
    messages,
    next: async (value) => {
      const tool = createCalls[0]?.extraTools?.[0] as unknown as {
        execute: (id: string, p: Record<string, unknown>) => Promise<unknown>
      }
      return tool.execute(`tc-${promptTexts.length}`, value)
    },
    agentId,
    ends: () => events.filter((e): e is EndEvent => e.type === 'sub_session_end'),
    task: () => tasks.get(agentId()),
    statuses: () => broadcasts.filter((b) => b.taskId === agentId()).map((b) => b.status)
  }
  return h
}

const task = (over: Partial<RunTaskParams> = {}): RunTaskParams => ({
  parentSessionId: 'root-1',
  agentType: PROFILE,
  prompt: 'Do the thing',
  description: 'task',
  modelConfig: MODEL,
  ...over
})

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 单轮用例：恰有一条 sub_session_end，交回它 */
const onlyEnd = (h: Harness): EndEvent => {
  const ends = h.ends()
  expect(ends).toHaveLength(1)
  return ends[0]
}

const isUserMessage = (e: ChatEvent): e is UserMessageEvent => e.type === 'user_message'

/** 首轮正常收尾；第二轮（追问）模型报错 */
const answerThenFail = (_t: string, round: number, hh: Harness): void => {
  if (round === 1) hh.messages.push(OK('first answer'))
  else hh.messages.push(USER('again'), FAIL(E503))
}

describe('首轮在 provider 处失败（runTask）', () => {
  it('ME-1 树尾是带半截文本的报错 assistant → outcome.error 取 errorMessage，sub_session_end isError:true 且 result 同文，任务落定 error', async () => {
    const h = makeHarness({ messages: [ERR_TEXT] })
    const outcome = await h.manager.runTask(task())

    expect(outcome).toStrictEqual({ result: ERR_TEXT_RESULT, error: E500 })
    expect(h.ends()).toEqual([
      {
        type: 'sub_session_end',
        sessionId: h.agentId(),
        parentSessionId: 'root-1',
        result: ERR_TEXT_RESULT,
        isError: true
      }
    ])
    expect(h.task()?.status).toBe('error')
    expect(h.task()?.endedAt).toEqual(expect.any(Number))
    expect(h.statuses()).toEqual(['running', 'error'])
    expect(h.promptTexts).toHaveLength(1)
  })

  it('ME-2 报错 assistant 只有空文本 → 「没有最终文本」说明带 stopReason 与 errorMessage，判失败', async () => {
    const h = makeHarness({ messages: [FAIL(E500)] })
    const outcome = await h.manager.runTask(task())

    expect(outcome).toStrictEqual({ result: NO_TEXT_E500, error: E500 })
    expect(onlyEnd(h)).toMatchObject({ result: NO_TEXT_E500, isError: true })
    expect(h.task()?.status).toBe('error')
  })

  it.each([
    { label: '(a) content 为空', tree: [ERR_BARE], result: NO_TEXT_BARE },
    {
      label: '(b) 带文本',
      tree: [{ role: 'assistant', content: 'partial', stopReason: 'error' }],
      result: 'partial\n\n[Note] stopReason=error'
    },
    {
      label: '(c) errorMessage 为空串',
      tree: [{ ...ERR_BARE, errorMessage: '' }],
      result: NO_TEXT_BARE
    }
  ])(
    'ME-3 报错消息没带 errorMessage $label → error 为通用原因，文本没有 error 注记，仍判失败',
    async ({ tree, result }) => {
      const h = makeHarness({ messages: tree })
      const outcome = await h.manager.runTask(task())

      expect(outcome).toStrictEqual({ result, error: 'model call failed (stopReason=error)' })
      expect(onlyEnd(h)).toMatchObject({ result, isError: true })
      expect(h.task()?.status).toBe('error')
    }
  )

  it.each([
    {
      label: '(a) 报错那条没有文本',
      tree: [TOOL_USE, TOOL_RESULT, FAIL(E500)],
      result:
        'Agent did not produce a final text response (2 assistant message(s), 1 tool call(s)). stopReason=error. Model errorMessage: 500 Internal Server Error.'
    },
    {
      label: '(b) 调工具那条说过一句话',
      tree: [TOOL_USE_WITH_TEXT, TOOL_RESULT, FAIL(E500)],
      result: 'Reading the file\n\n[Note] stopReason=error; error=500 Internal Server Error'
    }
  ])(
    'ME-4 干过工具活之后才报错 $label → 判失败，error 取 errorMessage',
    async ({ tree, result }) => {
      const h = makeHarness({ messages: tree })
      const outcome = await h.manager.runTask(task())

      expect(outcome).toStrictEqual({ result, error: E500 })
      expect(onlyEnd(h)).toMatchObject({ result, isError: true })
      expect(h.task()?.status).toBe('error')
    }
  )

  it('ME-5 报错 assistant 之后还跟着一条 user → 跳过非 assistant，仍以最后一条 assistant 判失败', async () => {
    const h = makeHarness({ messages: [ERR_TEXT, USER('late')] })
    const outcome = await h.manager.runTask(task())

    expect(outcome).toStrictEqual({ result: ERR_TEXT_RESULT, error: E500 })
    expect(onlyEnd(h)).toMatchObject({ result: ERR_TEXT_RESULT, isError: true })
    expect(h.task()?.status).toBe('error')
  })

  it('ME-6 模型报错且 prompt 又交回 execError → error 取 execError 原话，文本三条注记都在', async () => {
    const h = makeHarness({ messages: [ERR_TEXT], onPrompt: () => ({ error: 'busy' }) })
    const outcome = await h.manager.runTask(task())
    const result =
      'half an answer\n\n[Note] stopReason=error; error=500 Internal Server Error; execError=busy'

    expect(outcome).toStrictEqual({ result, error: 'busy' })
    expect(onlyEnd(h)).toMatchObject({ result, isError: true })
    expect(h.task()?.status).toBe('error')
  })

  it('ME-7 树尾 stopReason 为 aborted、但没有中断 / 中止标记 → 不算失败，文本照旧带注记', async () => {
    const h = makeHarness({ messages: [ABORTED_TAIL] })
    const outcome = await h.manager.runTask(task())
    const result = 'partial\n\n[Note] stopReason=aborted; error=Request was aborted'

    expect(outcome).toStrictEqual({ result })
    expect(onlyEnd(h)).toMatchObject({ result, isError: false })
    expect(h.task()?.status).toBe('done')
  })

  it('ME-8 先报过错、最后一条正常收尾 → 成功；文本里残留的 error 注记是既有行为，原样钉住', async () => {
    const h = makeHarness({ messages: [EARLIER_ERROR, OK('recovered')] })
    const outcome = await h.manager.runTask(task())
    const result = 'recovered\n\n[Note] error=transient'

    expect(outcome).toStrictEqual({ result })
    expect(onlyEnd(h)).toMatchObject({ result, isError: false })
    expect(h.task()?.status).toBe('done')
    expect(h.statuses()).toEqual(['running', 'done'])
  })
})

describe('软停止 — 不算失败', () => {
  it('ME-9 面板中断 + 树尾报错 → 无 error、isError:false、任务 done，runtime.abort 被调', async () => {
    const h = makeHarness({
      messages: [ERR_TEXT],
      onPrompt: (_t, _r, hh) => {
        hh.manager.interrupt(hh.agentId())
      }
    })
    const outcome = await h.manager.runTask(task())

    expect(outcome).toStrictEqual({ result: ERR_TEXT_RESULT })
    expect(onlyEnd(h)).toMatchObject({ result: ERR_TEXT_RESULT, isError: false })
    expect(h.task()?.status).toBe('done')
    expect(h.abort).toHaveBeenCalled()
  })

  it('ME-10 中断后 prompt 又交回 execError → 仍按软停止收尾：文本不带 execError 注记、无 error', async () => {
    const h = makeHarness({
      messages: [OK('partial')],
      onPrompt: (_t, _r, hh) => {
        hh.manager.interrupt(hh.agentId())
        return { error: 'busy' }
      }
    })
    const outcome = await h.manager.runTask(task())

    expect(outcome).toStrictEqual({ result: 'partial' })
    expect(onlyEnd(h)).toMatchObject({ result: 'partial', isError: false })
    expect(h.task()?.status).toBe('done')
  })

  it('ME-11 用户从任务面板停（tasks.stop by user）+ 树尾报错 → done、isError:false、无 error；同步等待者还在，不通知', async () => {
    const h = makeHarness({
      messages: [ERR_TEXT],
      onPrompt: (_t, _r, hh) => {
        expect(hh.tasks.stop(hh.agentId(), { by: 'user' })).toBe(true)
      }
    })
    const outcome = await h.manager.runTask(task())

    expect(h.task()?.status).toBe('done')
    expect(onlyEnd(h).isError).toBe(false)
    expect('error' in outcome).toBe(false)
    await sleep(20)
    expect(h.delivered).toEqual([])
  })

  it.each([
    { label: '(a) 首轮里中断', interruptIn: 'turn' as const },
    { label: '(b) 首轮跑完后才中断', interruptIn: 'after' as const }
  ])(
    'ME-12 中断标记不漏到下一轮 $label：追问那轮模型报错 → 照常判失败',
    async ({ interruptIn }) => {
      const h = makeHarness({
        messages: [],
        onPrompt: (_t, round, hh) => {
          if (round === 1) {
            hh.messages.push(OK('first answer'))
            if (interruptIn === 'turn') hh.manager.interrupt(hh.agentId())
          } else {
            hh.messages.push(USER('go on'), FAIL(E503))
          }
        }
      })
      await h.manager.runTask(task())
      const id = h.agentId()
      expect(h.ends()).toHaveLength(1)
      expect(h.ends()[0].isError).toBe(false)
      expect(h.task()?.status).toBe('done')
      if (interruptIn === 'after') h.manager.interrupt(id)

      await h.manager.continueTask({ subSessionId: id, text: 'go on' })

      expect(h.ends()).toHaveLength(2)
      expect(h.ends()[1]).toMatchObject({
        isError: true,
        result: 'first answer\n\n[Note] stopReason=error; error=503 Service Unavailable'
      })
      expect(h.task()?.status).toBe('error')
    }
  )
})

describe('中止 — 失败，且压过同一轮的软停止', () => {
  it.each([
    { label: '(a) parentAbortSignal 在轮内被中止', how: 'signal' as const },
    { label: '(b) 轮内 abortAll(根会话) 级联中止', how: 'abortAll' as const }
  ])(
    'ME-13 中止 + 树尾报错 $label → 结果为 abortedNote、error aborted、isError:true、任务 killed，不通知',
    async ({ how }) => {
      const controller = new AbortController()
      const h = makeHarness({
        messages: [ERR_TEXT],
        onPrompt: (_t, _r, hh) => {
          if (how === 'signal') controller.abort()
          else hh.manager.abortAll('root-1')
        }
      })
      const outcome = await h.manager.runTask(
        task(how === 'signal' ? { parentAbortSignal: controller.signal } : {})
      )

      expect(outcome).toStrictEqual({ result: ABORTED_NOTE, error: 'aborted' })
      expect(onlyEnd(h)).toMatchObject({ isError: true, result: ABORTED_NOTE })
      expect(h.task()?.status).toBe('killed')
      expect(h.statuses()).toEqual(['running', 'killed'])
      await sleep(20)
      expect(h.delivered).toEqual([])
    }
  )

  it('ME-14 中止过的 agent 不能再追问：continueTask reject，任务仍 killed，不多发任何东西', async () => {
    const controller = new AbortController()
    const h = makeHarness({
      messages: [ERR_TEXT],
      onPrompt: () => {
        controller.abort()
      }
    })
    await h.manager.runTask(task({ parentAbortSignal: controller.signal }))
    const counts = (): Record<string, number> => ({
      broadcasts: h.broadcasts.length,
      ends: h.ends().length,
      prompts: h.promptTexts.length,
      events: h.events.length
    })
    const before = counts()

    await expect(h.manager.continueTask({ subSessionId: h.agentId(), text: 'x' })).rejects.toThrow(
      /Sub-session already aborted/
    )

    expect(h.task()?.status).toBe('killed')
    expect(counts()).toEqual(before)
  })

  it('ME-25 同一轮先软停止、再被父级中止 → 结论按中止（killed / isError / aborted），文本按软停止抽取', async () => {
    const controller = new AbortController()
    const h = makeHarness({
      messages: [ERR_TEXT],
      onPrompt: (_t, _r, hh) => {
        hh.manager.interrupt(hh.agentId())
        controller.abort()
      }
    })
    const outcome = await h.manager.runTask(task({ parentAbortSignal: controller.signal }))

    expect(h.task()?.status).toBe('killed')
    const end = onlyEnd(h)
    expect(end.isError).toBe(true)
    expect(outcome).toStrictEqual({ result: ERR_TEXT_RESULT, error: 'aborted' })
    expect(end.result).toBe(outcome.result)
  })
})

describe('结果契约 — 捕获恒为成功，出错的一轮不追问', () => {
  it('ME-15 捕获 + 树尾报错 → 以捕获为准：structured 返回、无 error、isError:false、任务 done、只 prompt 一次', async () => {
    const h = makeHarness({
      messages: [ERR_TEXT],
      onPrompt: async (_t, round, hh) => {
        if (round === 1) await hh.next({ title: 'X' })
      }
    })
    const outcome = await h.manager.runTask(task({ resultContract: CONTRACT }))

    expect(outcome).toStrictEqual({ result: CAPTURED_X, structured: { title: 'X' } })
    expect(onlyEnd(h)).toMatchObject({ result: CAPTURED_X, isError: false })
    expect(h.task()?.status).toBe('done')
    expect(h.promptTexts).toHaveLength(1)
  })

  it('ME-16 首轮正常收尾没调 next → 追问；追问那轮模型报错 → 判失败，文本取首轮散文带报错注记，没有 structured', async () => {
    const h = makeHarness({
      messages: [],
      onPrompt: (_t, round, hh) => {
        if (round === 1) hh.messages.push(OK('prose without next'))
        else hh.messages.push(FAIL(E500))
      }
    })
    const outcome = await h.manager.runTask(task({ resultContract: CONTRACT }))

    expect(h.promptTexts).toHaveLength(2)
    expect(h.promptTexts[1]).toBe(NEXT_NUDGE_TEXT)
    expect(outcome).toStrictEqual({
      result: 'prose without next\n\n[Note] stopReason=error; error=500 Internal Server Error',
      error: E500
    })
    expect(onlyEnd(h).isError).toBe(true)
    expect(h.task()?.status).toBe('error')
  })

  it('ME-17 捕获之后父级又中止 → 捕获优先：structured 返回、无 error、isError:false、任务 done', async () => {
    const controller = new AbortController()
    const h = makeHarness({
      onPrompt: async (_t, round, hh) => {
        if (round !== 1) return
        await hh.next({ title: 'X' })
        controller.abort()
      }
    })
    const outcome = await h.manager.runTask(
      task({ resultContract: CONTRACT, parentAbortSignal: controller.signal })
    )

    expect(outcome).toStrictEqual({ result: CAPTURED_X, structured: { title: 'X' } })
    expect(onlyEnd(h).isError).toBe(false)
    expect(h.task()?.status).toBe('done')
  })

  it('ME-18 首轮模型报错且没调 next → 不追问：只 prompt 一次、不广播 nudge，判失败', async () => {
    const h = makeHarness({
      messages: [FAIL(E500)],
      onPrompt: async (_t, round, hh) => {
        // 绊线：真追问了的话，这一轮会捕获并把结论翻成成功
        if (round === 2) await hh.next({ title: 'X' })
      }
    })
    const outcome = await h.manager.runTask(task({ resultContract: CONTRACT }))

    expect(h.promptTexts).toHaveLength(1)
    const nudges = h.events
      .filter(isUserMessage)
      .filter((e) => JSON.parse(e.message).content === NEXT_NUDGE_TEXT)
    expect(nudges).toEqual([])
    expect(outcome).toStrictEqual({ result: NO_TEXT_E500, error: E500 })
    expect(onlyEnd(h).isError).toBe(true)
    expect(h.task()?.status).toBe('error')
  })
})

describe('追问 — 每一轮各判各的', () => {
  it('ME-19 跑完的 agent 被追问、那轮模型报错 → 任务 running→error、sub_session_end 判失败；再追问一轮正常收尾 → 回到 done；全程不通知', async () => {
    const h = makeHarness({
      messages: [],
      onPrompt: (_t, round, hh) => {
        if (round === 1) hh.messages.push(OK('first answer'))
        else if (round === 2) hh.messages.push(USER('again'), FAIL(E503))
        else hh.messages.push(USER('once more'), OK('second answer'))
      }
    })
    await h.manager.runTask(task())
    const id = h.agentId()
    expect(h.task()?.status).toBe('done')
    expect(h.ends()[0]).toMatchObject({ isError: false, result: 'first answer' })

    const p = h.manager.continueTask({ subSessionId: id, text: 'again' })
    expect(h.task()).toMatchObject({ status: 'running', endedAt: null })
    await expect(p).resolves.toBeUndefined()

    expect(h.task()?.status).toBe('error')
    expect(h.task()?.endedAt).toEqual(expect.any(Number))
    const end2 = h.ends()[1]
    expect(end2).toEqual({
      type: 'sub_session_end',
      sessionId: id,
      parentSessionId: 'root-1',
      result: 'first answer\n\n[Note] stopReason=error; error=503 Service Unavailable',
      isError: true
    })
    const againAt = h.events.findIndex(
      (e) => isUserMessage(e) && JSON.parse(e.message).content === 'again'
    )
    expect(againAt).toBeGreaterThan(h.events.indexOf(h.ends()[0]))
    expect(againAt).toBeLessThan(h.events.indexOf(end2))

    await h.manager.continueTask({ subSessionId: id, text: 'once more' })
    expect(h.task()?.status).toBe('done')
    expect(h.ends()[2]).toMatchObject({
      isError: false,
      result: 'second answer\n\n[Note] error=503 Service Unavailable'
    })

    expect(h.ends()).toHaveLength(3)
    expect(h.statuses()).toEqual(['running', 'done', 'running', 'error', 'running', 'done'])
    await sleep(20)
    expect(h.delivered).toEqual([])
  })
})

describe('通知 — 失败的轮次同样只看「落定时有没有人在等」', () => {
  it.each(['real', 'withFormatter'] as const)(
    'ME-20 首轮模型报错（任务枢纽 %s）→ 任务 error；runTask 还在等，不通知',
    async (registry) => {
      const h = makeHarness({ messages: [FAIL(E500)], registry })
      await h.manager.runTask(task())

      expect(h.task()?.status).toBe('error')
      await sleep(20)
      expect(h.delivered).toEqual([])
    }
  )

  it('ME-21 追问那轮模型报错（此时已没人在等）→ 仍不通知：派生 agent 登记任务时不给通知文案', async () => {
    const h = makeHarness({ messages: [], onPrompt: answerThenFail })
    const create = vi.spyOn(h.tasks, 'create')
    await h.manager.runTask(task())
    const id = h.agentId()
    await h.manager.continueTask({ subSessionId: id, text: 'again' })

    expect(create).toHaveBeenCalledTimes(1)
    const params = create.mock.calls[0][0]
    expect(params).toMatchObject({ taskId: id, kind: 'agent', sessionId: 'root-1' })
    expect('formatNotice' in params).toBe(false)
    expect(h.task()?.status).toBe('error')
    await sleep(20)
    expect(h.delivered).toEqual([])
  })

  it('ME-21 绊线：同一流程换成带通知文案的任务 → 追问那轮落定时确实会通知（上一条的「不通知」来自没有文案）', async () => {
    const h = makeHarness({ messages: [], onPrompt: answerThenFail, registry: 'withFormatter' })
    await h.manager.runTask(task())
    await h.manager.continueTask({ subSessionId: h.agentId(), text: 'again' })

    expect(h.task()?.status).toBe('error')
    await sleep(20)
    expect(h.delivered).toEqual([['root-1', 'NOTICE']])
  })
})

describe('一致性 — isError、任务落定态、outcome.error 是同一个结论', () => {
  interface MatrixRow {
    label: string
    expected: Exclude<TaskStatus, 'running' | 'waiting-input'>
    messages: unknown[]
    onPrompt?: (h: Harness, controller: AbortController) => Reply | void | Promise<Reply | void>
    /** 把 controller.signal 作为 parentAbortSignal 传入；'pre' = 派发前就已中止 */
    signal?: 'live' | 'pre'
    contract?: boolean
  }

  const interruptTurn = (h: Harness): void => h.manager.interrupt(h.agentId())
  const captureTurn = async (h: Harness): Promise<void> => {
    await h.next({ title: 'X' })
  }

  const MATRIX: MatrixRow[] = [
    { label: '干净收尾', messages: [OK('fine')], expected: 'done' },
    { label: '树尾报错（带文本）', messages: [ERR_TEXT], expected: 'error' },
    { label: '树尾报错（空文本）', messages: [FAIL(E500)], expected: 'error' },
    { label: '树尾报错（无 errorMessage）', messages: [ERR_BARE], expected: 'error' },
    {
      label: '执行抛错、树为空',
      messages: [],
      onPrompt: () => ({ error: 'boom' }),
      expected: 'error'
    },
    {
      label: '树尾报错 + 执行抛错',
      messages: [ERR_TEXT],
      onPrompt: () => ({ error: 'busy' }),
      expected: 'error'
    },
    { label: '先报错后恢复', messages: [EARLIER_ERROR, OK('recovered')], expected: 'done' },
    { label: '树尾 stopReason aborted、无人中止', messages: [ABORTED_TAIL], expected: 'done' },
    { label: '中断 + 树尾报错', messages: [ERR_TEXT], onPrompt: interruptTurn, expected: 'done' },
    {
      label: '中断 + 执行抛错',
      messages: [OK('partial')],
      onPrompt: (h) => {
        interruptTurn(h)
        return { error: 'busy' }
      },
      expected: 'done'
    },
    { label: '派发前父级已中止', messages: [], signal: 'pre', expected: 'killed' },
    {
      label: '轮内父级中止 + 树尾报错',
      messages: [ERR_TEXT],
      signal: 'live',
      onPrompt: (_h, controller) => {
        controller.abort()
      },
      expected: 'killed'
    },
    {
      label: '轮内 abortAll',
      messages: [OK('partial')],
      onPrompt: (h) => {
        h.manager.abortAll('root-1')
      },
      expected: 'killed'
    },
    {
      label: '轮内先中断再中止 + 树尾报错',
      messages: [ERR_TEXT],
      signal: 'live',
      onPrompt: (h, controller) => {
        interruptTurn(h)
        controller.abort()
      },
      expected: 'killed'
    },
    {
      label: '捕获、树干净',
      messages: [],
      contract: true,
      onPrompt: captureTurn,
      expected: 'done'
    },
    {
      label: '捕获 + 树尾报错',
      messages: [ERR_TEXT],
      contract: true,
      onPrompt: captureTurn,
      expected: 'done'
    }
  ]

  it.each(MATRIX)('ME-22 单轮：$label → $expected，三处结论一致', async (row) => {
    const controller = new AbortController()
    if (row.signal === 'pre') controller.abort()
    const rowPrompt = row.onPrompt
    const h = makeHarness({
      messages: [...row.messages],
      onPrompt: rowPrompt ? (_t, _r, hh) => rowPrompt(hh, controller) : undefined
    })
    const outcome = await h.manager.runTask(
      task({
        ...(row.signal ? { parentAbortSignal: controller.signal } : {}),
        ...(row.contract ? { resultContract: CONTRACT } : {})
      })
    )
    const failed = row.expected !== 'done'

    const end = onlyEnd(h)
    expect(end.result).toBe(outcome.result)
    expect(h.task()?.status).toBe(row.expected)
    expect(h.statuses().at(-1)).toBe(row.expected)
    expect(end.isError).toBe(failed)
    expect('error' in outcome).toBe(failed)
    expect(h.task()?.endedAt).toEqual(expect.any(Number))
  })

  it('ME-23 连续五轮（正常 / 模型报错 / 执行抛错 / 中断 + 报错 / 正常）→ 每轮 isError 与该轮落定态对得上', async () => {
    const h = makeHarness({
      messages: [],
      onPrompt: (_t, round, hh) => {
        switch (round) {
          case 1:
            hh.messages.push(OK('answer 1'))
            return {}
          case 2:
            hh.messages.push(USER('turn 2'), FAIL(E503))
            return {}
          case 3:
            // 什么也不落，只交回 execError
            return { error: 'busy' }
          case 4:
            hh.messages.push(USER('turn 4'), ERR_TEXT)
            hh.manager.interrupt(hh.agentId())
            return {}
          default:
            hh.messages.push(USER('turn 5'), OK('answer 5'))
            return {}
        }
      }
    })
    const settled: TaskStatus[] = []
    await h.manager.runTask(task())
    const id = h.agentId()
    settled.push(h.task()!.status)
    for (const text of ['turn 2', 'turn 3', 'turn 4', 'turn 5']) {
      await h.manager.continueTask({ subSessionId: id, text })
      settled.push(h.task()!.status)
    }

    const ends = h.ends()
    expect(settled).toEqual(['done', 'error', 'error', 'done', 'done'])
    expect(ends.map((e) => e.isError)).toEqual([false, true, true, false, false])
    // continueTask 不交回结论：逐轮拿 sub_session_end 与那一轮之后的任务态对账
    ends.forEach((e, i) => expect(e.isError).toBe(settled[i] !== 'done'))
    expect(ends.map((e) => [e.sessionId, e.parentSessionId])).toEqual(
      Array.from({ length: 5 }, () => [id, 'root-1'])
    )
    expect(h.statuses()).toEqual([
      'running',
      'done',
      'running',
      'error',
      'running',
      'error',
      'running',
      'done',
      'running',
      'done'
    ])
  })
})
