/**
 * 挂起的用户询问：应答 / 取消 / 摘要 / 恰好一次的钩子 / 关闭受理窗口 / 全部取消 / 能力闸门 /
 * 重复 id 顶替（裁决 R12）。
 *
 * 关闭窗口这一条是会话关停链路的命门：宿主按「当前绑定的运行时」路由用户应答，正在关停的运行时
 * 已不在绑定表里；中止之后若还接受新询问，那条挂起就再也没人应答 —— 双方互等，会话卡死。
 */
import { describe, expect, it } from 'vitest'
import type { InputRequest, InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import { PendingInputRequests } from '../inputRequests'

function makeInputs(capability = true): {
  inputs: PendingInputRequests
  events: string[]
  requested: string[]
  resolved: [string, InputResponse][]
} {
  const events: string[] = []
  const requested: string[] = []
  const resolved: [string, InputResponse][] = []
  const inputs = new PendingInputRequests(
    's1',
    {
      broadcast: (event) =>
        events.push(
          event.type === 'input_request'
            ? `request:${event.request.id}`
            : event.type === 'input_request_resolved'
              ? `resolved:${event.requestId}`
              : event.type
        ),
      hasUserInputCapability: () => capability
    },
    {
      onRequest: (request) => requested.push(request.id),
      onResolved: (id, response) => resolved.push([id, response])
    }
  )
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
      allowMultiple: false,
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

  it('IR-08 no front end can show the panel → immediate cancel, no event', async () => {
    const { inputs, events, requested } = makeInputs(false)
    await expect(inputs.request(ask('r1'))).resolves.toEqual({ kind: 'cancel', reason: 'aborted' })
    expect(inputs.count).toBe(0)
    expect(events).toEqual([])
    expect(requested).toEqual([])
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
      { broadcast: () => {}, hasUserInputCapability: () => true },
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
})
