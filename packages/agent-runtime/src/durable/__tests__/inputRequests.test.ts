/**
 * 挂起的用户询问：应答 / 取消 / 摘要 / 恰好一次的钩子 / 关闭受理窗口 / 全部取消 / 没有前端也等（AW-U1） /
 * 重复 id 顶替（裁决 R12） / 只中止几个对话（SCOPE-U1..3）。P3-08 起询问不再广播（`events` 改由一份 `subscribe` 钩子记），
 * 应答可带答题方（PIN-20）。
 *
 * 关闭窗口这一条是会话关停链路的命门：宿主按「当前绑定的运行时」路由用户应答，正在关停的运行时
 * 已不在绑定表里；中止之后若还接受新询问，那条挂起就再也没人应答 —— 双方互等，会话卡死。
 */
import { describe, expect, it } from 'vitest'
import type {
  InputRequest,
  InputResponse,
  DrivingSessionRef
} from '@shuvix/chat-protocol/types/inputRequest'
import { PendingInputRequests } from '../inputRequests'

function makeInputs(): {
  inputs: PendingInputRequests
  events: string[]
  requested: string[]
  resolved: [string, InputResponse][]
} {
  const events: string[] = []
  const requested: string[] = []
  const resolved: [string, InputResponse][] = []
  const inputs = new PendingInputRequests('s1', {
    onRequest: (request) => requested.push(request.id),
    onResolved: (id, response) => resolved.push([id, response])
  })
  inputs.subscribe({
    onRequest: (request) => events.push(`request:${request.id}`),
    onResolved: (id) => events.push(`resolved:${id}`)
  })
  return { inputs, events, requested, resolved }
}

const ask = (id: string, command = 'ls'): InputRequest => ({
  id,
  kind: 'ask',
  toolName: 'bash',
  command,
  createdAt: 0
})

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('PendingInputRequests', () => {
  it('IR-01 request pends; respond resolves it and clears the count', async () => {
    const { inputs } = makeInputs()
    let settled: InputResponse | undefined
    void inputs.request(ask('r1')).then((response) => (settled = response))
    await flush()
    expect(settled).toBeUndefined()
    expect(inputs.count).toBe(1)
    const response: InputResponse = { kind: 'ask', allowed: true }
    expect(inputs.respond('r1', response)).toBe(true)
    await flush()
    expect(settled).toEqual(response)
    expect(inputs.count).toBe(0)
  })

  it('IR-02 respond to an unknown id → false; the first respond wins', async () => {
    const { inputs } = makeInputs()
    expect(inputs.respond('nope', { kind: 'ask', allowed: true })).toBe(false)
    const pending = inputs.request(ask('r1'))
    expect(inputs.respond('r1', { kind: 'ask', allowed: true })).toBe(true)
    expect(inputs.respond('r1', { kind: 'ask', allowed: false })).toBe(false)
    await expect(pending).resolves.toEqual({ kind: 'ask', allowed: true })
  })

  it('IR-03 cancel resolves {kind:cancel, reason}; unknown → false', async () => {
    const { inputs } = makeInputs()
    const pending = inputs.request(ask('r1'))
    expect(inputs.cancel('r1', 'closed')).toBe(true)
    await expect(pending).resolves.toEqual({ kind: 'cancel', reason: 'closed' })
    expect(inputs.cancel('r1')).toBe(false)
    const second = inputs.request(ask('r2'))
    expect(inputs.cancel('r2')).toBe(true)
    await expect(second).resolves.toEqual({ kind: 'cancel', reason: 'aborted' })
  })

  it('IR-04 summaries are `${toolName}: ${command ?? question ?? kind}` with empty parts dropped', () => {
    const { inputs } = makeInputs()
    void inputs.request(ask('r1', 'rm -rf build'))
    void inputs.request({
      id: 'r2',
      kind: 'choice',
      toolName: 'ask',
      question: 'Which one?',
      options: [],
      createdAt: 0
    })
    void inputs.request({ id: 'r3', kind: 'ask', toolName: 'write', createdAt: 0 } as InputRequest)
    void inputs.request({ id: 'r4', kind: 'ask', toolName: '', command: 'pwd', createdAt: 0 })
    expect(inputs.summaries).toEqual(['bash: rm -rf build', 'ask: Which one?', 'write: ask', 'pwd'])
  })

  it('IR-05 onRequest / onResolved fire exactly once per id; none for gate-refused asks', async () => {
    const { inputs, requested, resolved, events } = makeInputs()
    void inputs.request(ask('a'))
    void inputs.request(ask('b'))
    void inputs.request(ask('c'))
    inputs.respond('a', { kind: 'ask', allowed: true })
    inputs.respond('a', { kind: 'ask', allowed: true })
    inputs.cancel('b', 'aborted')
    inputs.cancel('b', 'aborted')
    inputs.closeInputs()
    inputs.cancelAll('aborted')
    await inputs.request(ask('refused'))
    expect(requested).toEqual(['a', 'b', 'c'])
    expect(resolved.map(([id]) => id)).toEqual(['a', 'b', 'c'])
    expect(events).toEqual([
      'request:a',
      'request:b',
      'request:c',
      'resolved:a',
      'resolved:b',
      'resolved:c'
    ])
  })

  it('IR-06 closeInputs: new asks resolve cancelled at once, uncounted, no event; reopenInputs restores', async () => {
    const { inputs, events, requested } = makeInputs()
    inputs.closeInputs()
    expect(inputs.inputsClosed).toBe(true)
    await expect(inputs.request(ask('r1'))).resolves.toEqual({ kind: 'cancel', reason: 'aborted' })
    expect(inputs.count).toBe(0)
    expect(events).toEqual([])
    expect(requested).toEqual([])
    inputs.reopenInputs()
    let settled: InputResponse | undefined
    void inputs.request(ask('r2')).then((response) => (settled = response))
    await flush()
    expect(settled).toBeUndefined()
    expect(inputs.count).toBe(1)
  })

  it('IR-06 a window closed by a session close stays closed (reason closed)', async () => {
    const { inputs } = makeInputs()
    inputs.closeInputs('closed')
    inputs.reopenInputs()
    await expect(inputs.request(ask('r1'))).resolves.toEqual({ kind: 'cancel', reason: 'closed' })
  })

  it('IR-07 cancelAll(reason) resolves all, clears, emits each; the window stays open', async () => {
    const { inputs, events } = makeInputs()
    const a = inputs.request(ask('a'))
    const b = inputs.request(ask('b'))
    inputs.cancelAll('closed')
    await expect(a).resolves.toEqual({ kind: 'cancel', reason: 'closed' })
    await expect(b).resolves.toEqual({ kind: 'cancel', reason: 'closed' })
    expect(inputs.count).toBe(0)
    expect(events.filter((event) => event.startsWith('resolved:'))).toEqual([
      'resolved:a',
      'resolved:b'
    ])
    expect(inputs.inputsClosed).toBe(false)
  })

  it('AW-U1 no subscriber at all: the ask stays pending past a macrotask, is listed, and only respond settles it', async () => {
    // 没有 subscribe、没有构造钩子 = 没有任何前端在看。询问不看有没有前端（2026-11-02）
    const inputs = new PendingInputRequests('s1')
    const request = ask('r1')
    let settled: InputResponse | undefined
    void inputs.request(request).then((response) => (settled = response))
    await flush()
    expect(settled).toBeUndefined()
    expect(inputs.count).toBe(1)
    expect(inputs.list()).toEqual([request])
    const response: InputResponse = { kind: 'ask', allowed: true }
    expect(inputs.respond('r1', response)).toBe(true)
    await flush()
    expect(settled).toEqual(response)
    expect(inputs.count).toBe(0)
    expect(inputs.list()).toEqual([])
  })

  it('IR-09 a duplicate pending id supersedes the earlier request (R12)', async () => {
    const { inputs, resolved } = makeInputs()
    const first = inputs.request(ask('r1', 'first'))
    const second = inputs.request(ask('r1', 'second'))
    await expect(first).resolves.toEqual({ kind: 'cancel', reason: 'superseded' })
    expect(inputs.count).toBe(1)
    expect(inputs.summaries).toEqual(['bash: second'])
    expect(inputs.respond('r1', { kind: 'ask', allowed: true })).toBe(true)
    await expect(second).resolves.toEqual({ kind: 'ask', allowed: true })
    expect(resolved.map(([id, response]) => [id, response.kind])).toEqual([
      ['r1', 'cancel'],
      ['r1', 'ask']
    ])
  })

  it('IR-10 list(): the pending requests in arrival order; a superseding request moves to the end (P3-03 PIN-02)', async () => {
    const { inputs } = makeInputs()
    const a = inputs.request(ask('a'))
    void inputs.request(ask('b'))
    expect(inputs.list().map((r) => r.id)).toEqual(['a', 'b'])
    void inputs.request(ask('a', 'again'))
    await a
    expect(inputs.list().map((r) => [r.id, (r as { command?: string }).command])).toEqual([
      ['b', 'ls'],
      ['a', 'again']
    ])
    inputs.cancelAll()
    expect(inputs.list()).toEqual([])
  })

  it('IR-11 subscribe(): every hook set sees each request / resolution once, in order; a throwing one is logged and isolated; unsubscribe is idempotent', async () => {
    const warnings: string[] = []
    const inputs = new PendingInputRequests(
      's1',
      {},
      { info: () => {}, warn: (m) => warnings.push(m), error: () => {} }
    )
    const seen: string[] = []
    const stopThrowing = inputs.subscribe({
      onRequest: () => {
        throw new Error('hook boom')
      },
      onResolved: () => {
        throw new Error('hook boom')
      }
    })
    const stop = inputs.subscribe({
      onRequest: (request) => seen.push(`request:${request.id}:${inputs.list().length}`),
      onResolved: (id) => seen.push(`resolved:${id}:${inputs.list().length}`)
    })
    const pending = inputs.request(ask('r1'))
    expect(inputs.respond('r1', { kind: 'ask', allowed: true })).toBe(true)
    await expect(pending).resolves.toEqual({ kind: 'ask', allowed: true })
    expect(seen).toEqual(['request:r1:1', 'resolved:r1:0'])
    expect(warnings.filter((w) => w.includes('hook boom'))).toHaveLength(2)
    stop()
    stop()
    stopThrowing()
    void inputs.request(ask('r2'))
    expect(seen).toHaveLength(2)
    inputs.cancelAll()
  })

  it('P3-08-45 the constructor hooks and each subscriber fire once per request / settle', async () => {
    const { inputs, events, requested, resolved } = makeInputs()
    const pending = inputs.request(ask('r1'))
    expect(inputs.respond('r1', { kind: 'ask', allowed: true })).toBe(true)
    await pending
    void inputs.request(ask('r2'))
    inputs.cancelAll()
    expect(requested).toEqual(['r1', 'r2'])
    expect(resolved.map(([id]) => id)).toEqual(['r1', 'r2'])
    expect(events).toEqual(['request:r1', 'resolved:r1', 'request:r2', 'resolved:r2'])
  })

  it('P3-08-60 respond(…, {clientId}) hands the answerer to every onResolved as a third argument; cancels carry none', async () => {
    const seen: unknown[][] = []
    const inputs = new PendingInputRequests('s1', {
      onResolved: (...args) => seen.push(['ctor', ...args])
    })
    inputs.subscribe({ onResolved: (...args) => seen.push(['sub', ...args]) })
    void inputs.request(ask('r1'))
    void inputs.request(ask('r2'))
    const allow: InputResponse = { kind: 'ask', allowed: true }
    expect(inputs.respond('r1', allow, { clientId: 'ipc:7' })).toBe(true)
    // 先到者胜：第二个答题方拿到 false，钩子不再响
    expect(inputs.respond('r1', allow, { clientId: 'chrome:c1' })).toBe(false)
    inputs.cancel('r2')
    expect(seen).toEqual([
      ['ctor', 'r1', allow, 'ipc:7'],
      ['sub', 'r1', allow, 'ipc:7'],
      ['ctor', 'r2', { kind: 'cancel', reason: 'aborted' }],
      ['sub', 'r2', { kind: 'cancel', reason: 'aborted' }]
    ])
  })
})

/**
 * WP2（docs/sub-session-design.md §19.5）：答题方 `answeredBy` 只取宿主给的 `meta`，载荷里自带的那一项来自
 * 前端，一律剥掉；带 `meta.answeredBy` 的应答只落在选择题上 —— 「父会话代答不能当成用户授权」的协议层守卫。
 */
describe('PendingInputRequests · 答题方（WP2）', () => {
  const PARENT = { kind: 'parent-session', sessionId: 'P1', title: '重构 parser' } as const
  const FORGED = { kind: 'parent-session', sessionId: 'EVIL', title: 'forged' } as const

  const choice = (id: string): InputRequest => ({
    id,
    kind: 'choice',
    toolName: 'ask',
    question: 'Which one?',
    options: [
      { label: 'A', description: 'first' },
      { label: 'B', description: 'second' }
    ],
    createdAt: 0
  })

  /** 构造时钩子 + 一份 subscribe 钩子都记下 onResolved 的完整参数 */
  function recorded(): { inputs: PendingInputRequests; seen: unknown[][] } {
    const seen: unknown[][] = []
    const inputs = new PendingInputRequests('s1', {
      onResolved: (...args) => seen.push(['ctor', ...args])
    })
    inputs.subscribe({ onResolved: (...args) => seen.push(['sub', ...args]) })
    return { inputs, seen }
  }

  it('WP2-01 meta.answeredBy is handed to the asker as an own copy (later edits to meta do not leak)', async () => {
    const { inputs } = makeInputs()
    const pending = inputs.request(choice('c1'))
    const answeredBy: DrivingSessionRef = { ...PARENT }
    expect(
      inputs.respond(
        'c1',
        { kind: 'choice', selections: ['A'] },
        { clientId: 'parent:P1', answeredBy }
      )
    ).toBe(true)
    const delivered = await pending
    expect(delivered).toStrictEqual({ kind: 'choice', selections: ['A'], answeredBy: PARENT })
    expect(delivered.answeredBy).not.toBe(answeredBy)
    answeredBy.title = 'mutated'
    expect(delivered.answeredBy).toStrictEqual(PARENT)
  })

  it.each([
    ['choice', { kind: 'choice', selections: ['A'] }],
    ['other', { kind: 'other', text: 'neither' }],
    ['ask', { kind: 'ask', allowed: true }]
  ] as const)(
    'WP2-02 [guard] a forged answeredBy in the payload (no meta) is stripped: %s',
    async (_label, base) => {
      const { inputs } = makeInputs()
      const pending = inputs.request(choice('c1'))
      expect(inputs.respond('c1', { ...base, answeredBy: FORGED } as InputResponse)).toBe(true)
      const delivered = await pending
      expect(delivered).not.toHaveProperty('answeredBy')
      expect(delivered).toStrictEqual(base)
    }
  )

  it('WP2-03 [guard] the whole answeredBy comes from meta: nothing (not even the title) is merged from a forged payload', async () => {
    const { inputs } = makeInputs()
    const pending = inputs.request(choice('c1'))
    expect(
      inputs.respond(
        'c1',
        { kind: 'choice', selections: ['A'], answeredBy: FORGED },
        { answeredBy: { kind: 'parent-session', sessionId: 'P1' } }
      )
    ).toBe(true)
    expect((await pending).answeredBy).toStrictEqual({ kind: 'parent-session', sessionId: 'P1' })
  })

  it('WP2-04 an ordinary front-end answer (meta has only clientId) drops a forged answeredBy; onResolved still gets the clientId', async () => {
    const { inputs, seen } = recorded()
    const pending = inputs.request(choice('c1'))
    expect(
      inputs.respond(
        'c1',
        { kind: 'choice', selections: ['B'], answeredBy: FORGED },
        { clientId: 'ipc:7' }
      )
    ).toBe(true)
    const delivered = await pending
    expect(delivered).toStrictEqual({ kind: 'choice', selections: ['B'] })
    expect(seen).toEqual([
      ['ctor', 'c1', { kind: 'choice', selections: ['B'] }, 'ipc:7'],
      ['sub', 'c1', { kind: 'choice', selections: ['B'] }, 'ipc:7']
    ])
  })

  it('WP2-05 every onResolved hook sees exactly what the asker got; the forged answerer never reaches a hook', async () => {
    const { inputs, seen } = recorded()
    const byParent = inputs.request(choice('c1'))
    const byUser = inputs.request(choice('c2'))
    inputs.respond(
      'c1',
      { kind: 'choice', selections: ['A'] },
      { clientId: 'parent:P1', answeredBy: PARENT }
    )
    inputs.respond('c2', { kind: 'choice', selections: ['B'], answeredBy: FORGED })
    const first = await byParent
    const second = await byUser
    expect(seen).toStrictEqual([
      ['ctor', 'c1', first, 'parent:P1'],
      ['sub', 'c1', first, 'parent:P1'],
      ['ctor', 'c2', second],
      ['sub', 'c2', second]
    ])
    expect(first.answeredBy).toStrictEqual(PARENT)
    expect(second).not.toHaveProperty('answeredBy')
    expect(JSON.stringify(seen)).not.toContain('EVIL')
  })

  it('WP2-06 stripping copies: the caller’s payload object keeps its forged answeredBy untouched', async () => {
    const { inputs } = makeInputs()
    const pending = inputs.request(choice('c1'))
    const resp: InputResponse = { kind: 'choice', selections: ['A'], answeredBy: { ...FORGED } }
    inputs.respond('c1', resp, { answeredBy: PARENT })
    expect((await pending).answeredBy).toStrictEqual(PARENT)
    expect(resp).toStrictEqual({ kind: 'choice', selections: ['A'], answeredBy: FORGED })
  })

  it.each([
    ['meta {}', {}],
    ['meta {answeredBy: undefined}', { answeredBy: undefined }],
    ['no meta', undefined]
  ] as const)('WP2-07 %s → no answeredBy key at all', async (_label, meta) => {
    const { inputs } = makeInputs()
    const pending = inputs.request(choice('c1'))
    const response: InputResponse = { kind: 'choice', selections: ['A'], answeredBy: FORGED }
    expect(
      meta === undefined ? inputs.respond('c1', response) : inputs.respond('c1', response, meta)
    ).toBe(true)
    expect(Object.keys(await pending).sort()).toEqual(['kind', 'selections'])
  })

  it('WP2-08 first answer wins in both orders: the late one returns false and changes nothing; onResolved fires once', async () => {
    const userAnswer: InputResponse = { kind: 'choice', selections: ['A'] }
    const parentAnswer: InputResponse = { kind: 'choice', selections: ['B'] }

    const human = recorded()
    const humanFirst = human.inputs.request(choice('c1'))
    expect(human.inputs.respond('c1', userAnswer)).toBe(true)
    expect(human.inputs.respond('c1', parentAnswer, { answeredBy: PARENT })).toBe(false)
    expect(await humanFirst).toStrictEqual(userAnswer)
    expect(human.seen.filter(([who]) => who === 'ctor')).toHaveLength(1)

    const parent = recorded()
    const parentFirst = parent.inputs.request(choice('c1'))
    expect(parent.inputs.respond('c1', parentAnswer, { answeredBy: PARENT })).toBe(true)
    expect(parent.inputs.respond('c1', userAnswer)).toBe(false)
    expect(await parentFirst).toStrictEqual({ ...parentAnswer, answeredBy: PARENT })
    expect(parent.seen.filter(([who]) => who === 'ctor')).toHaveLength(1)
  })

  it('WP2-09 cancellations never carry answeredBy and onResolved gets no third argument', async () => {
    const { inputs, seen } = recorded()
    const c1 = inputs.request(choice('c1'))
    const c2 = inputs.request(choice('c2'))
    const c3 = inputs.request(choice('c3'))
    inputs.cancel('c1', 'aborted')
    const c2again = inputs.request(choice('c2'))
    inputs.cancelAll('closed')
    inputs.closeInputs()
    const c4 = inputs.request(choice('c4'))
    expect(await c1).toStrictEqual({ kind: 'cancel', reason: 'aborted' })
    expect(await c2).toStrictEqual({ kind: 'cancel', reason: 'superseded' })
    expect(await c3).toStrictEqual({ kind: 'cancel', reason: 'closed' })
    expect(await c2again).toStrictEqual({ kind: 'cancel', reason: 'closed' })
    expect(await c4).toStrictEqual({ kind: 'cancel', reason: 'aborted' })
    for (const call of seen) {
      expect(call).toHaveLength(3)
      expect(call[2]).not.toHaveProperty('answeredBy')
    }
  })

  it('WP2-10 [guard] a stand-in answer only lands on a choice: a permission card (kind ask) refuses it and stays pending for the user', async () => {
    const { inputs, seen } = recorded()
    let settled: InputResponse | undefined
    void inputs.request(ask('a1')).then((response) => (settled = response))
    expect(inputs.respond('a1', { kind: 'ask', allowed: true }, { answeredBy: PARENT })).toBe(false)
    // 连 clientId 一起给也一样：判据是有没有 answeredBy，不是谁来的
    expect(
      inputs.respond(
        'a1',
        { kind: 'ask', allowed: true },
        { clientId: 'parent:P1', answeredBy: PARENT }
      )
    ).toBe(false)
    await flush()
    expect(settled).toBeUndefined()
    expect(inputs.count).toBe(1)
    expect(seen).toEqual([])
    // 用户本人照样能答，且交出的应答里没有答题方
    expect(inputs.respond('a1', { kind: 'ask', allowed: false, answeredBy: FORGED })).toBe(true)
    await flush()
    expect(settled).toStrictEqual({ kind: 'ask', allowed: false })
  })

  it('WP2-10b [guard] a stand-in answer for an id that is not pending returns false (no request to judge by)', () => {
    const { inputs, seen } = recorded()
    expect(
      inputs.respond('nope', { kind: 'choice', selections: ['A'] }, { answeredBy: PARENT })
    ).toBe(false)
    expect(seen).toEqual([])
  })
})

describe('PendingInputRequests · stopping some conversations', () => {
  const card = (id: string, conversationId?: number): InputRequest => ({
    ...ask(id),
    ...(conversationId === undefined ? {} : { conversationId })
  })
  const ABORTED: InputResponse = { kind: 'cancel', reason: 'aborted' }
  const ALLOW: InputResponse = { kind: 'ask', allowed: true }

  it('SCOPE-U1 cancels the named conversations and the unnamed card, once each; the other card stays and can be answered', async () => {
    const { inputs, resolved } = makeInputs()
    const c1 = inputs.request(card('c1', 1))
    const c2 = inputs.request(card('c2', 2))
    const c3 = inputs.request(card('c3', 3))
    const none = inputs.request(card('none'))

    inputs.cancelConversations(new Set([1, 2]))

    expect(await c1).toStrictEqual(ABORTED)
    expect(await c2).toStrictEqual(ABORTED)
    expect(await none).toStrictEqual(ABORTED)
    expect(resolved.map(([id]) => id).sort()).toEqual(['c1', 'c2', 'none'])
    expect(inputs.list().map((request) => request.id)).toEqual(['c3'])
    expect(inputs.respond('c1', ALLOW)).toBe(false)
    expect(inputs.respond('c3', ALLOW)).toBe(true)
    expect(await c3).toStrictEqual(ALLOW)
    expect(resolved.map(([id]) => id).sort()).toEqual(['c1', 'c2', 'c3', 'none'])
  })

  it('SCOPE-U1 a set matching nothing cancels only the unnamed card', async () => {
    const { inputs, resolved } = makeInputs()
    void inputs.request(card('c1', 1))
    const none = inputs.request(card('none'))
    inputs.cancelConversations(new Set([99]))
    expect(await none).toStrictEqual(ABORTED)
    expect(resolved.map(([id]) => id)).toEqual(['none'])
    expect(inputs.list().map((request) => request.id)).toEqual(['c1'])
  })

  it('SCOPE-U2 during a stop, a card from that conversation or an unnamed one is refused with no hooks and no count; another conversation is accepted', async () => {
    const { inputs, requested, resolved } = makeInputs()
    const release = inputs.cancelConversations(new Set([1]))

    expect(await inputs.request(card('late-1', 1))).toStrictEqual(ABORTED)
    expect(await inputs.request(card('late-none'))).toStrictEqual(ABORTED)
    expect(requested).toEqual([])
    expect(resolved).toEqual([])
    expect(inputs.count).toBe(0)

    const other = inputs.request(card('other', 2))
    expect(requested).toEqual(['other'])
    expect(inputs.count).toBe(1)

    release()
    expect(inputs.respond('other', ALLOW)).toBe(true)
    expect(await other).toStrictEqual(ALLOW)
  })

  it("SCOPE-U2 a late card from the stopped conversation does not supersede another conversation's card with the same id", async () => {
    const { inputs, resolved } = makeInputs()
    const release = inputs.cancelConversations(new Set([1]))
    let settled: InputResponse | undefined
    void inputs.request(card('same', 2)).then((response) => (settled = response))

    expect(await inputs.request(card('same', 1))).toStrictEqual(ABORTED)
    await flush()
    expect(settled).toBeUndefined()
    expect(resolved).toEqual([])
    expect(inputs.list()).toEqual([card('same', 2)])

    release()
    expect(inputs.respond('same', ALLOW)).toBe(true)
    await flush()
    expect(settled).toStrictEqual(ALLOW)
  })

  it('SCOPE-U2 after release the conversation and an unnamed card are accepted again', async () => {
    const { inputs, requested } = makeInputs()
    const release = inputs.cancelConversations(new Set([1]))
    release()
    const named = inputs.request(card('n', 1))
    const unnamed = inputs.request(card('u'))
    expect(requested).toEqual(['n', 'u'])
    expect(inputs.count).toBe(2)
    expect(inputs.respond('n', ALLOW)).toBe(true)
    expect(inputs.respond('u', ALLOW)).toBe(true)
    expect(await named).toStrictEqual(ALLOW)
    expect(await unnamed).toStrictEqual(ALLOW)
  })

  it('SCOPE-U3 two overlapping stops with equal-content sets: refused until both are released; a double release is a no-op', async () => {
    const { inputs } = makeInputs()
    const first = inputs.cancelConversations(new Set([1]))
    const second = inputs.cancelConversations(new Set([1]))

    first()
    expect(await inputs.request(card('a', 1))).toStrictEqual(ABORTED)
    first()
    expect(await inputs.request(card('b', 1))).toStrictEqual(ABORTED)
    expect(inputs.count).toBe(0)

    second()
    void inputs.request(card('c', 1))
    expect(inputs.count).toBe(1)
    second()
    expect(inputs.count).toBe(1)
  })

  it('SCOPE-U3 closeInputs then release leaves the window closed', async () => {
    const { inputs } = makeInputs()
    const release = inputs.cancelConversations(new Set([1]))
    inputs.closeInputs('aborted')
    release()
    expect(inputs.inputsClosed).toBe(true)
    expect(await inputs.request(card('n', 2))).toStrictEqual(ABORTED)
    expect(inputs.count).toBe(0)
  })

  it('SCOPE-U3 closeInputs + cancelAll still takes every card, whichever conversation raised it and whichever stop is in force', async () => {
    const { inputs, resolved } = makeInputs()
    const stop = inputs.cancelConversations(new Set([1]))
    const c2 = inputs.request(card('c2', 2))
    const c3 = inputs.request(card('c3', 3))
    inputs.closeInputs('aborted')
    inputs.cancelAll('aborted')
    expect(await c2).toStrictEqual(ABORTED)
    expect(await c3).toStrictEqual(ABORTED)
    expect(resolved.map(([id]) => id)).toEqual(['c2', 'c3'])
    expect(inputs.count).toBe(0)
    expect(await inputs.request(card('c4', 4))).toStrictEqual(ABORTED)
    stop()
  })
})
