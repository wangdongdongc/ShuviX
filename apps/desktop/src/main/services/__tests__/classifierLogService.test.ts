/**
 * classifierLogService —— 分类器调用的审计日志（classifier_logs，迁移 v32）与统一入口 classifyAndLog。
 *
 * record：
 *   CLS-1  一行的各字段：uuid v7 的 id、createdAt = 现在、request / response 是 JSON、缺省字段补 '' / 0
 *   CLS-2  内存会话与「删掉的内存会话」都不记：不 insert、不修剪、也不计入修剪的计数
 *   CLS-2b sessionId 为 '' 或缺省照记（不去问会话记录）
 *   CLS-3  对象摘要 500 字原样、501 字截到 500
 *   CLS-4  每计入 100 次 insert 修剪一次（prune(5000)）；跳过的、insert 失败的不计
 *   CLS-5  insert / prune 抛错：一条告警、不往外抛
 *   CLS-6  context 序列化不了（循环引用）→ request ''，照记
 *   CLS-7  list / getById / scenes / clear 透传给 DAO
 *
 * classifyAndLog（AbortSignal.timeout 被换成可控的 signal）：
 *   CAL-1  ok、没有 accept：交回结果，记一行 ok（答案、用量、耗时）
 *   CAL-2  ok、accept 认了：accept 拿到的就是那份结果
 *   CAL-3  accept 不认：交回结果 + incomplete，日志带答案与固定的错误文本
 *   CAL-4  stopReason error → failed，error = "error: <message>"（没有 message → 'error'），用量照记、不带答案
 *   CAL-5  classify reject：Error → 它的 message；非 Error → String()
 *   CAL-6  超时：timeout signal 落下 → timeout（reject 与 pi 回 aborted 两种都是）
 *   CAL-7  调用方取消 → aborted；两个都落下时算 aborted
 *   CAL-8  交给 pi 的 signal：只有超时 → 就是那个超时 signal；带调用方的 → 二者任一落下它就落下；调用方已取消 → 已落下
 *   CAL-9  每条分支恰记一行，透传的字段逐一相同（context 是同一个对象）
 *   CAL-10 没有 usage → 0 / 0；stopReason 不是 stop 时不调 accept
 *   CAL-11 pi 回 aborted 但两个 signal 都没落下 → failed（error 'aborted'）
 *   CAL-12 accept 抛错 → failed，日志不带答案
 *   CAL-13 自定义 record 抛错：一条告警、只调这一次，结果照常交回；不给 record 时写进 classifierLogService.record
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ClassifierApi,
  ClassifierContext,
  ClassifierModel,
  ClassifierResult
} from '@earendil-works/pi-ai'

const state = vi.hoisted(() => ({
  insert: vi.fn(),
  prune: vi.fn(),
  list: vi.fn(),
  getById: vi.fn(),
  scenes: vi.fn(),
  clear: vi.fn(),
  ephemeral: new Set<string>(),
  wasEphemeral: new Set<string>(),
  isEphemeralCalls: [] as string[],
  warn: vi.fn()
}))

vi.mock('../../dao/classifierLogDao', () => ({
  classifierLogDao: {
    insert: state.insert,
    prune: state.prune,
    list: state.list,
    getById: state.getById,
    scenes: state.scenes,
    clear: state.clear
  }
}))
vi.mock('../sessionRecords', () => ({
  sessionRecords: {
    isEphemeral: (id: string) => {
      state.isEphemeralCalls.push(id)
      return state.ephemeral.has(id)
    },
    wasEphemeral: (id: string) => state.wasEphemeral.has(id)
  }
}))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: state.warn, error: vi.fn(), debug: vi.fn() })
}))

import {
  ClassifierLogService,
  MAX_ROWS,
  classifierLogService,
  classifyAndLog,
  type ClassifierLogInput
} from '../classifierLogService'

const CONTEXT: ClassifierContext = {
  state: { command: 'ls -la', shell: 'bash' },
  questions: {
    category: {
      type: 'choice',
      instructions: 'Which one?',
      criteria: { read_only: 'reads', destructive: 'deletes' }
    }
  }
}

const ANSWERS: ClassifierResult['answers'] = {
  category: {
    type: 'choice',
    choice: 'read_only',
    probabilities: { read_only: 0.93, destructive: 0.07 },
    confidence: 0.93
  }
}

function input(over: Partial<ClassifierLogInput> = {}): ClassifierLogInput {
  return {
    scene: 'command-risk',
    sessionId: 's1',
    toolCallId: 'tc-1',
    subject: 'ls -la',
    provider: 'openrouter',
    model: '~typesafe/jev-latest',
    context: CONTEXT,
    answers: ANSWERS,
    status: 'ok',
    ms: 120,
    inputTokens: 42,
    cost: 0.0001,
    ...over
  }
}

const insertedRows = (): Array<Record<string, unknown>> =>
  state.insert.mock.calls.map((c) => c[0] as Record<string, unknown>)
const warnings = (): string[] => state.warn.mock.calls.map((c) => String(c[0]))

beforeEach(() => {
  for (const fn of [
    state.insert,
    state.prune,
    state.list,
    state.getById,
    state.scenes,
    state.clear,
    state.warn
  ]) {
    fn.mockReset()
  }
  state.ephemeral.clear()
  state.wasEphemeral.clear()
  state.isEphemeralCalls.length = 0
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('ClassifierLogService.record', () => {
  it('CLS-1 一行的各字段：uuid v7 id、createdAt = 现在、JSON 的 request / response、缺省补 "" / 0', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_760_000_000_000)
    const service = new ClassifierLogService()

    service.record(input())
    expect(state.insert).toHaveBeenCalledTimes(1)
    const row = insertedRows()[0]
    expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(row).toEqual({
      id: row.id,
      createdAt: 1_760_000_000_000,
      scene: 'command-risk',
      sessionId: 's1',
      toolCallId: 'tc-1',
      subject: 'ls -la',
      provider: 'openrouter',
      model: '~typesafe/jev-latest',
      request: JSON.stringify(CONTEXT),
      response: JSON.stringify(ANSWERS),
      status: 'ok',
      error: '',
      ms: 120,
      inputTokens: 42,
      cost: 0.0001
    })
    expect(JSON.parse(String(row.request))).toEqual(CONTEXT)

    // 缺省字段：sessionId / toolCallId → ''，answers → ''，error → ''，用量 → 0
    service.record({
      scene: 'command-risk',
      subject: 'pwd',
      provider: '',
      model: 'm',
      context: CONTEXT,
      status: 'misconfigured',
      ms: 0
    })
    const bare = insertedRows()[1]
    expect(bare).toMatchObject({
      sessionId: '',
      toolCallId: '',
      response: '',
      error: '',
      inputTokens: 0,
      cost: 0,
      status: 'misconfigured'
    })
    expect(bare.id).not.toBe(row.id)
  })

  it('CLS-2 内存会话与删掉的内存会话都不记：不 insert、不修剪、不计入修剪计数', () => {
    const service = new ClassifierLogService()
    state.ephemeral.add('eph')
    state.wasEphemeral.add('gone')

    for (let i = 0; i < 150; i++) {
      service.record(input({ sessionId: i % 2 === 0 ? 'eph' : 'gone' }))
    }
    expect(state.insert).not.toHaveBeenCalled()
    expect(state.prune).not.toHaveBeenCalled()

    // 跳过的那些不计：之后要再计满 100 次才修剪
    for (let i = 0; i < 99; i++) service.record(input())
    expect(state.prune).not.toHaveBeenCalled()
    service.record(input())
    expect(state.prune).toHaveBeenCalledTimes(1)
  })

  it.each<[string, string | undefined]>([
    ["''", ''],
    ['缺省', undefined]
  ])('CLS-2b sessionId 为 %s 照记，不去问会话记录', (_label, sessionId) => {
    const service = new ClassifierLogService()
    service.record(input({ sessionId }))
    expect(state.insert).toHaveBeenCalledTimes(1)
    expect(insertedRows()[0].sessionId).toBe('')
    expect(state.isEphemeralCalls).toEqual([])
  })

  it('CLS-3 对象摘要 500 字原样、501 字截到前 500 字', () => {
    const service = new ClassifierLogService()
    const exact = 'a'.repeat(500)
    const over = `${'b'.repeat(500)}c`
    service.record(input({ subject: exact }))
    service.record(input({ subject: over }))
    expect(insertedRows()[0].subject).toBe(exact)
    expect(insertedRows()[1].subject).toBe('b'.repeat(500))
  })

  it('CLS-4 每计入 100 次 insert 修剪一次（prune(MAX_ROWS = 5000)）；insert 失败的不计', () => {
    expect(MAX_ROWS).toBe(5000)
    const service = new ClassifierLogService()
    for (let i = 0; i < 99; i++) service.record(input())
    expect(state.prune).not.toHaveBeenCalled()
    service.record(input())
    expect(state.prune).toHaveBeenCalledTimes(1)
    expect(state.prune).toHaveBeenCalledWith(5000)

    // 失败的 insert 不计
    state.insert.mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    service.record(input())
    for (let i = 0; i < 99; i++) service.record(input())
    expect(state.prune).toHaveBeenCalledTimes(1)
    service.record(input())
    expect(state.prune).toHaveBeenCalledTimes(2)
    expect(state.insert).toHaveBeenCalledTimes(201)
  })

  it('CLS-5 insert / prune 抛错：一条告警、不往外抛', () => {
    const service = new ClassifierLogService()
    state.insert.mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    expect(() => service.record(input())).not.toThrow()
    expect(warnings()).toHaveLength(1)
    expect(warnings()[0]).toContain('disk full')

    state.prune.mockImplementationOnce(() => {
      throw new Error('locked')
    })
    for (let i = 0; i < 100; i++) expect(() => service.record(input())).not.toThrow()
    expect(state.prune).toHaveBeenCalledTimes(1)
    expect(warnings()).toHaveLength(2)
    expect(warnings()[1]).toContain('locked')
  })

  it("CLS-6 context 序列化不了（循环引用）→ request ''，照记", () => {
    const service = new ClassifierLogService()
    const circular = { state: {}, questions: {} } as unknown as ClassifierContext & {
      self?: unknown
    }
    circular.self = circular
    service.record(input({ context: circular }))
    expect(state.insert).toHaveBeenCalledTimes(1)
    expect(insertedRows()[0].request).toBe('')
    expect(warnings()).toEqual([])
  })

  it('CLS-7 list / getById / scenes / clear 透传给 DAO', () => {
    const service = new ClassifierLogService()
    const rows = [{ id: 'a' }]
    state.list.mockReturnValue(rows)
    const params = { scene: 'command-risk', limit: 5 }
    expect(service.list(params)).toBe(rows)
    expect(state.list.mock.calls[0][0]).toBe(params)

    const row = { id: 'a', request: '{}' }
    state.getById.mockReturnValue(row)
    expect(service.getById('a')).toBe(row)
    expect(state.getById).toHaveBeenCalledWith('a')

    state.scenes.mockReturnValue(['command-risk'])
    expect(service.scenes()).toEqual(['command-risk'])

    service.clear()
    expect(state.clear).toHaveBeenCalledTimes(1)
  })
})

// ─── classifyAndLog ────────────────────────────────────────────────────────────

const MODEL = {
  id: '~typesafe/jev-latest',
  provider: 'openrouter'
} as unknown as ClassifierModel<ClassifierApi>

function result(over: Partial<ClassifierResult> = {}): ClassifierResult {
  return {
    api: 'typesafe-system-one',
    provider: 'openrouter',
    model: '~typesafe/jev-latest',
    answers: ANSWERS,
    usage: {
      input: 57,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 57,
      cost: { input: 0.00002, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.00002 }
    },
    stopReason: 'stop',
    timestamp: 1,
    ...over
  }
}

/** 换掉 AbortSignal.timeout：交回一个由测试控制的 signal */
function controllableTimeout(): { controller: AbortController; spy: ReturnType<typeof vi.spyOn> } {
  const controller = new AbortController()
  const spy = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => controller.signal)
  return { controller, spy }
}

/** 等到 signal 落下就以 AbortError 拒绝的 classify */
type ClassifyFn = (
  model: unknown,
  context: unknown,
  opts?: { signal?: AbortSignal }
) => Promise<ClassifierResult>

function hangingClassify(): ClassifyFn {
  return vi.fn(
    (_model: unknown, _context: unknown, opts?: { signal?: AbortSignal }) =>
      new Promise<ClassifierResult>((_resolve, reject) => {
        opts?.signal?.addEventListener('abort', () =>
          reject(new DOMException('This operation was aborted', 'AbortError'))
        )
      })
  )
}

const BASE = {
  model: MODEL,
  providerId: 'openrouter',
  modelId: '~typesafe/jev-latest',
  context: CONTEXT,
  scene: 'command-risk',
  subject: 'ls -la',
  sessionId: 's1',
  toolCallId: 'tc-1',
  timeoutMs: 3000
}

/** 透传到日志里的字段 */
const PASS_THROUGH = {
  scene: 'command-risk',
  sessionId: 's1',
  toolCallId: 'tc-1',
  subject: 'ls -la',
  provider: 'openrouter',
  model: '~typesafe/jev-latest'
}

describe('classifyAndLog', () => {
  it('CAL-1 ok、没有 accept：交回结果与 ok，记一行（答案、用量、耗时）', async () => {
    const { spy } = controllableTimeout()
    const res = result()
    const classify = vi.fn(async () => res)
    const record = vi.fn<(input: ClassifierLogInput) => void>()
    const outcome = await classifyAndLog({ ...BASE, models: { classify }, record })

    expect(spy).toHaveBeenCalledWith(3000)
    expect(outcome.result).toBe(res)
    expect(outcome.status).toBe('ok')
    expect(outcome.error).toBeUndefined()
    expect(outcome.ms).toBeGreaterThanOrEqual(0)
    expect(classify).toHaveBeenCalledTimes(1)
    expect(classify.mock.calls[0]).toHaveLength(3)
    expect((classify.mock.calls[0] as unknown[])[0]).toBe(MODEL)
    expect((classify.mock.calls[0] as unknown[])[1]).toBe(CONTEXT)

    expect(record).toHaveBeenCalledTimes(1)
    const logged = record.mock.calls[0][0]
    expect(logged).toEqual({
      ...PASS_THROUGH,
      context: CONTEXT,
      answers: ANSWERS,
      status: 'ok',
      ms: outcome.ms,
      inputTokens: 57,
      cost: 0.00002
    })
    expect(logged.context).toBe(CONTEXT)
  })

  it('CAL-2 ok、accept 认了：accept 拿到的就是那份结果', async () => {
    controllableTimeout()
    const res = result()
    const accept = vi.fn(() => true)
    const record = vi.fn<(input: ClassifierLogInput) => void>()
    const outcome = await classifyAndLog({
      ...BASE,
      models: { classify: async () => res },
      accept,
      record
    })
    expect(accept).toHaveBeenCalledTimes(1)
    expect(accept.mock.calls[0]).toEqual([res])
    expect(outcome).toMatchObject({ result: res, status: 'ok' })
    expect(record.mock.calls[0][0]).toMatchObject({ status: 'ok', answers: ANSWERS })
  })

  it('CAL-3 accept 不认：交回结果 + incomplete，日志带答案与固定的错误文本', async () => {
    controllableTimeout()
    const res = result()
    const record = vi.fn<(input: ClassifierLogInput) => void>()
    const outcome = await classifyAndLog({
      ...BASE,
      models: { classify: async () => res },
      accept: () => false,
      record
    })
    expect(outcome).toMatchObject({
      result: res,
      status: 'incomplete',
      error: 'answers are incomplete or out of range'
    })
    expect(record).toHaveBeenCalledTimes(1)
    expect(record.mock.calls[0][0]).toEqual({
      ...PASS_THROUGH,
      context: CONTEXT,
      answers: ANSWERS,
      status: 'incomplete',
      error: 'answers are incomplete or out of range',
      ms: outcome.ms,
      inputTokens: 57,
      cost: 0.00002
    })
  })

  it.each<[string, string | undefined, string]>([
    [
      '带 message',
      'No API key for provider: openrouter',
      'error: No API key for provider: openrouter'
    ],
    ['没有 message', undefined, 'error']
  ])(
    'CAL-4 stopReason error（%s）→ failed，error 文本 %s；用量照记、不带答案',
    async (_label, errorMessage, expected) => {
      controllableTimeout()
      const record = vi.fn<(input: ClassifierLogInput) => void>()
      const accept = vi.fn(() => true)
      const outcome = await classifyAndLog({
        ...BASE,
        models: {
          classify: async () => result({ stopReason: 'error', errorMessage, answers: {} })
        },
        accept,
        record
      })
      expect(outcome).toEqual({ result: null, status: 'failed', ms: outcome.ms, error: expected })
      expect(accept).not.toHaveBeenCalled()
      expect(record).toHaveBeenCalledTimes(1)
      const logged = record.mock.calls[0][0]
      expect(logged).toEqual({
        ...PASS_THROUGH,
        context: CONTEXT,
        status: 'failed',
        error: expected,
        ms: outcome.ms,
        inputTokens: 57,
        cost: 0.00002
      })
      expect(logged).not.toHaveProperty('answers')
    }
  )

  it.each<[string, unknown, string]>([
    ['Error', new Error('socket hang up'), 'socket hang up'],
    ['非 Error（字符串）', 'plain failure', 'plain failure']
  ])('CAL-5 classify reject（%s）→ failed，error = %s', async (_label, thrown, expected) => {
    controllableTimeout()
    const record = vi.fn<(input: ClassifierLogInput) => void>()
    const outcome = await classifyAndLog({
      ...BASE,
      models: { classify: async () => Promise.reject(thrown) },
      record
    })
    expect(outcome).toEqual({ result: null, status: 'failed', ms: outcome.ms, error: expected })
    expect(record).toHaveBeenCalledTimes(1)
    expect(record.mock.calls[0][0]).toEqual({
      ...PASS_THROUGH,
      context: CONTEXT,
      status: 'failed',
      error: expected,
      ms: outcome.ms
    })
  })

  it('CAL-6 超时：timeout signal 落下 → timeout（pi reject 与 pi 回 aborted 两种都是）', async () => {
    const first = controllableTimeout()
    const record = vi.fn<(input: ClassifierLogInput) => void>()
    const pending = classifyAndLog({ ...BASE, models: { classify: hangingClassify() }, record })
    first.controller.abort()
    const outcome = await pending
    expect(outcome.status).toBe('timeout')
    expect(outcome.result).toBeNull()
    expect(record).toHaveBeenCalledTimes(1)
    expect(record.mock.calls[0][0]).toMatchObject({ ...PASS_THROUGH, status: 'timeout' })
    vi.restoreAllMocks()

    // pi 自己看着 signal、回 stopReason aborted 而不是抛
    const second = controllableTimeout()
    const record2 = vi.fn<(input: ClassifierLogInput) => void>()
    const outcome2 = await classifyAndLog({
      ...BASE,
      models: {
        classify: async () => {
          second.controller.abort()
          return result({ stopReason: 'aborted', answers: {} })
        }
      },
      record: record2
    })
    expect(outcome2).toMatchObject({ result: null, status: 'timeout', error: 'aborted' })
    expect(record2.mock.calls[0][0]).toMatchObject({ status: 'timeout', error: 'aborted' })
  })

  it('CAL-7 调用方取消 → aborted；超时与取消都落下时算 aborted', async () => {
    controllableTimeout()
    const caller = new AbortController()
    const record = vi.fn<(input: ClassifierLogInput) => void>()
    const pending = classifyAndLog({
      ...BASE,
      signal: caller.signal,
      models: { classify: hangingClassify() },
      record
    })
    caller.abort()
    const outcome = await pending
    expect(outcome.status).toBe('aborted')
    expect(record).toHaveBeenCalledTimes(1)
    expect(record.mock.calls[0][0]).toMatchObject({ ...PASS_THROUGH, status: 'aborted' })
    vi.restoreAllMocks()

    const both = controllableTimeout()
    const caller2 = new AbortController()
    const record2 = vi.fn<(input: ClassifierLogInput) => void>()
    const pending2 = classifyAndLog({
      ...BASE,
      signal: caller2.signal,
      models: { classify: hangingClassify() },
      record: record2
    })
    both.controller.abort()
    caller2.abort()
    const outcome2 = await pending2
    expect(outcome2.status).toBe('aborted')
    expect(record2.mock.calls[0][0].status).toBe('aborted')
  })

  it('CAL-8 交给 pi 的 signal：只有超时 → 就是那个超时 signal；带调用方的 → 任一落下它就落下；调用方已取消 → 进门就是落下的', async () => {
    // 只有超时
    const onlyTimeout = controllableTimeout()
    const seen: AbortSignal[] = []
    const capture = vi.fn(async (_m: unknown, _c: unknown, opts?: { signal?: AbortSignal }) => {
      seen.push(opts!.signal!)
      return result()
    })
    await classifyAndLog({ ...BASE, models: { classify: capture }, record: vi.fn() })
    expect(seen[0]).toBe(onlyTimeout.controller.signal)
    vi.restoreAllMocks()

    // 调用方的 signal 落下 → 交给 pi 的那个也落下
    controllableTimeout()
    const caller = new AbortController()
    await classifyAndLog({
      ...BASE,
      signal: caller.signal,
      models: { classify: capture },
      record: vi.fn()
    })
    const combined = seen[1]
    expect(combined).not.toBe(caller.signal)
    expect(combined.aborted).toBe(false)
    caller.abort()
    expect(combined.aborted).toBe(true)
    vi.restoreAllMocks()

    // 超时 signal 落下 → 交给 pi 的那个也落下
    const timeout = controllableTimeout()
    const caller2 = new AbortController()
    await classifyAndLog({
      ...BASE,
      signal: caller2.signal,
      models: { classify: capture },
      record: vi.fn()
    })
    expect(seen[2].aborted).toBe(false)
    timeout.controller.abort()
    expect(seen[2].aborted).toBe(true)
    vi.restoreAllMocks()

    // 调用方已取消
    controllableTimeout()
    const already = new AbortController()
    already.abort()
    const record = vi.fn<(input: ClassifierLogInput) => void>()
    const outcome = await classifyAndLog({
      ...BASE,
      signal: already.signal,
      models: { classify: capture },
      record
    })
    expect(seen[3].aborted).toBe(true)
    // pi 没理会落下的 signal、照常回了答案：照实记 ok（取消只在没拿到答案时才算）
    expect(outcome.status).toBe('ok')
  })

  it('CAL-9 每条分支恰记一行，透传字段逐一相同', async () => {
    const branches: Array<[string, () => Promise<unknown>]> = [
      ['ok', async () => result()],
      ['stop error', async () => result({ stopReason: 'error', errorMessage: 'x' })],
      ['reject', async () => Promise.reject(new Error('x'))]
    ]
    for (const [label, classify] of branches) {
      controllableTimeout()
      const record = vi.fn<(input: ClassifierLogInput) => void>()
      await classifyAndLog({
        ...BASE,
        models: { classify: classify as () => Promise<ClassifierResult> },
        record
      })
      expect(record, label).toHaveBeenCalledTimes(1)
      expect(record.mock.calls[0][0], label).toMatchObject(PASS_THROUGH)
      expect(record.mock.calls[0][0].context, label).toBe(CONTEXT)
      vi.restoreAllMocks()
    }
    // incomplete 分支
    controllableTimeout()
    const record = vi.fn<(input: ClassifierLogInput) => void>()
    await classifyAndLog({
      ...BASE,
      models: { classify: async () => result() },
      accept: () => false,
      record
    })
    expect(record).toHaveBeenCalledTimes(1)
    expect(record.mock.calls[0][0]).toMatchObject(PASS_THROUGH)

    // sessionId / toolCallId 缺省时照样透传 undefined（由 record 补 ''）
    controllableTimeout()
    const record2 = vi.fn<(input: ClassifierLogInput) => void>()
    await classifyAndLog({
      ...BASE,
      sessionId: undefined,
      toolCallId: undefined,
      models: { classify: async () => result() },
      record: record2
    })
    expect(record2.mock.calls[0][0].sessionId).toBeUndefined()
    expect(record2.mock.calls[0][0].toolCallId).toBeUndefined()
  })

  it('CAL-10 没有 usage → inputTokens 0 / cost 0；stopReason 不是 stop 时不调 accept', async () => {
    controllableTimeout()
    const record = vi.fn<(input: ClassifierLogInput) => void>()
    await classifyAndLog({
      ...BASE,
      models: { classify: async () => result({ usage: undefined }) },
      record
    })
    expect(record.mock.calls[0][0]).toMatchObject({ status: 'ok', inputTokens: 0, cost: 0 })

    const accept = vi.fn(() => true)
    const record2 = vi.fn<(input: ClassifierLogInput) => void>()
    await classifyAndLog({
      ...BASE,
      models: { classify: async () => result({ usage: undefined, stopReason: 'error' }) },
      accept,
      record: record2
    })
    expect(accept).not.toHaveBeenCalled()
    expect(record2.mock.calls[0][0]).toMatchObject({ status: 'failed', inputTokens: 0, cost: 0 })
  })

  it("CAL-11 pi 回 aborted 但两个 signal 都没落下 → failed（error 'aborted'）", async () => {
    controllableTimeout()
    const caller = new AbortController()
    const record = vi.fn<(input: ClassifierLogInput) => void>()
    const outcome = await classifyAndLog({
      ...BASE,
      signal: caller.signal,
      models: { classify: async () => result({ stopReason: 'aborted', answers: {} }) },
      record
    })
    expect(outcome).toMatchObject({ result: null, status: 'failed', error: 'aborted' })
    expect(record.mock.calls[0][0]).toMatchObject({ status: 'failed', error: 'aborted' })
  })

  it('CAL-12 accept 抛错 → failed，日志不带答案', async () => {
    controllableTimeout()
    const record = vi.fn<(input: ClassifierLogInput) => void>()
    const outcome = await classifyAndLog({
      ...BASE,
      models: { classify: async () => result() },
      accept: () => {
        throw new Error('bad mapping')
      },
      record
    })
    expect(outcome).toMatchObject({ result: null, status: 'failed', error: 'bad mapping' })
    expect(record).toHaveBeenCalledTimes(1)
    expect(record.mock.calls[0][0]).toMatchObject({ status: 'failed', error: 'bad mapping' })
    expect(record.mock.calls[0][0]).not.toHaveProperty('answers')
  })

  it('CAL-13 自定义 record 抛错：一条告警、只调这一次，结果照常交回；不给 record 时写进 classifierLogService.record', async () => {
    controllableTimeout()
    const res = result()
    const record = vi.fn<(input: ClassifierLogInput) => void>(() => {
      throw new Error('db gone')
    })
    const outcome = await classifyAndLog({ ...BASE, models: { classify: async () => res }, record })
    expect(outcome).toMatchObject({ result: res, status: 'ok' })
    expect(record).toHaveBeenCalledTimes(1)
    expect(warnings()).toHaveLength(1)
    expect(warnings()[0]).toContain('db gone')

    // 失败分支里的 record 抛错同样只调一次（不在 catch 里再记一遍）
    const record2 = vi.fn<(input: ClassifierLogInput) => void>(() => {
      throw new Error('db gone again')
    })
    const failed = await classifyAndLog({
      ...BASE,
      models: { classify: async () => Promise.reject(new Error('net')) },
      record: record2
    })
    expect(failed.status).toBe('failed')
    expect(record2).toHaveBeenCalledTimes(1)
    expect(warnings()).toHaveLength(2)

    // 缺省的 record：写进 classifierLogService.record
    const spy = vi.spyOn(classifierLogService, 'record')
    await classifyAndLog({ ...BASE, models: { classify: async () => res } })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0]).toMatchObject({ ...PASS_THROUGH, status: 'ok' })
    expect(state.insert).toHaveBeenCalledTimes(1)
  })
})
