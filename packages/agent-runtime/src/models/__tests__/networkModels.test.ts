/**
 * withNetwork — the Models decorator carrying ShuviX's RuntimeNetwork seam (ported from the
 * phase-0 modelsAdapter tests, then extended to the full Models surface).
 *
 * What is pinned:
 *  1. **No network = no interference.** Streams, events and results pass by reference; only
 *     the `timeoutMs` default is still filled in (A1).
 *  2. **The scope covers the whole request.** The host records fetch failures in an
 *     AsyncLocalStorage; auth resolution, the provider implementation, and the moment an
 *     error is annotated must all run inside `runInRequestScope`. A seam that throws when read
 *     out of scope holds this.
 *  3. **Annotation rules.** Provider-answered errors are not polluted, nothing is appended
 *     twice, pi's objects are never mutated, and the final `result()` — what pi-durable
 *     classifies — carries the annotation too.
 *  4. **Delegation.** Every other Models method reaches the inner collection unchanged.
 *
 * `createAssistantMessageEventStream` stays real throughout: several cases assert pi's own
 * EventStream semantics (a terminal push settles `result()`, pushes after it are dropped).
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { describe, expect, it, vi } from 'vitest'
import {
  createAssistantMessageEventStream,
  createModels,
  createProvider,
  fauxAssistantMessage,
  fauxProvider,
  isRetryableAssistantError,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type Models,
  type ProviderStreams
} from '@earendil-works/pi-ai'
import { AssistantMessageEventStream as EventStreamClass } from '@earendil-works/pi-ai/utils/event-stream'
import type { RuntimeNetwork } from '../../types'
import { DEFAULT_REQUEST_TIMEOUT_MS, withNetwork } from '../networkModels'

// ─────────────────────────── fakes ───────────────────────────

const MODEL = { provider: 'p1', id: 'm1', api: 'test-api' } as unknown as Model<Api>
const CONTEXT: Context = { messages: [] }

function fakeAssistant(text: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    stopReason: 'stop',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
    timestamp: 1
  } as unknown as AssistantMessage
}

function textDelta(delta: string): AssistantMessageEvent {
  return {
    type: 'text_delta',
    contentIndex: 0,
    delta,
    partial: fakeAssistant(delta)
  } as AssistantMessageEvent
}

function doneEvent(text = 'done'): AssistantMessageEvent {
  return { type: 'done', reason: 'stop', message: fakeAssistant(text) } as AssistantMessageEvent
}

/** A provider-side error event (what pi's catch leaves behind: just errorMessage). */
function errorEvent(
  errorMessage: string | undefined,
  opts: { reason?: 'error' | 'aborted'; extra?: Record<string, unknown> } = {}
): AssistantMessageEvent {
  return {
    type: 'error',
    reason: opts.reason ?? 'error',
    error: { role: 'assistant', content: [], stopReason: 'error', errorMessage, ...opts.extra }
  } as unknown as AssistantMessageEvent
}

/** Events queued into a real EventStream (the last one must be terminal). */
function queued(events: AssistantMessageEvent[]): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream()
  for (const event of events) stream.push(event)
  return stream
}

async function collect(
  stream: AsyncIterable<AssistantMessageEvent>
): Promise<AssistantMessageEvent[]> {
  const out: AssistantMessageEvent[] = []
  for await (const event of stream) out.push(event)
  return out
}

function errorTextOf(event: AssistantMessageEvent): string | undefined {
  if (event.type !== 'error') throw new Error(`expected an error event, got ${event.type}`)
  return event.error.errorMessage
}

type FakeModels = Models & { [K in keyof Models]: ReturnType<typeof vi.fn> }

/** Every Models method a spy; stream methods answer with an empty done stream by default. */
function fakeInner(): FakeModels {
  const keys: Array<keyof Models> = [
    'getProviders',
    'getProvider',
    'getModels',
    'getModel',
    'getModelsOfType',
    'getModelOfType',
    'getAllModels',
    'refresh',
    'checkAuth',
    'getAvailable',
    'getAvailableOfType',
    'getAllAvailable',
    'getAuth',
    'login',
    'logout',
    'stream',
    'complete',
    'streamSimple',
    'completeSimple',
    'streamDeferred',
    'fetchDeferred',
    'cancelDeferred',
    'generateImages',
    'classify'
  ]
  const inner = {} as Record<string, ReturnType<typeof vi.fn>>
  for (const key of keys) inner[key] = vi.fn()
  inner.stream.mockImplementation(() => queued([doneEvent()]))
  inner.streamSimple.mockImplementation(() => queued([doneEvent()]))
  return inner as unknown as FakeModels
}

// ─────────────────────────── seams ───────────────────────────

/** No real scope; a fixed detail; counts reads. */
function detailSeam(detail?: string): { network: RuntimeNetwork; reads: () => number } {
  let reads = 0
  return {
    network: {
      runInRequestScope: (fn) => fn(),
      describeLastFailure: () => {
        reads++
        return detail
      }
    },
    reads: () => reads
  }
}

/** A real AsyncLocalStorage seam — the same shape as the desktop's llmNetwork. */
function alsSeam(): {
  network: RuntimeNetwork
  scopeRuns: () => number
  inScope: () => boolean
  recordFailure: (detail: string) => void
} {
  const als = new AsyncLocalStorage<{ failure?: string }>()
  let runs = 0
  return {
    network: {
      runInRequestScope: (fn) => {
        runs++
        return als.run({}, fn)
      },
      describeLastFailure: () => als.getStore()?.failure
    },
    scopeRuns: () => runs,
    inScope: () => als.getStore() !== undefined,
    recordFailure: (detail) => {
      const scope = als.getStore()
      if (!scope) throw new Error('recordFailure outside a request scope — the test is wrong')
      scope.failure = detail
    }
  }
}

/** A seam that throws when its detail is read outside a scope. */
function strictSeam(detail: string): RuntimeNetwork {
  const als = new AsyncLocalStorage<object>()
  return {
    runInRequestScope: (fn) => als.run({}, fn),
    describeLastFailure: () => {
      if (!als.getStore()) throw new Error('detail read outside the request scope')
      return detail
    }
  }
}

/** A real pi provider whose auth and implementation report whether they ran in scope. */
function probeModels(probe: {
  resolve?: () => Promise<unknown>
  stream?: () => AssistantMessageEventStream
}): { models: ReturnType<typeof createModels>; model: Model<Api> } {
  const model = {
    id: 'probe-1',
    name: 'probe-1',
    api: 'probe-api',
    provider: 'probe',
    baseUrl: 'http://probe.test',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 100
  } as Model<Api>
  const impl: ProviderStreams = {
    stream: () => probe.stream?.() ?? queued([doneEvent()]),
    streamSimple: () => probe.stream?.() ?? queued([doneEvent()])
  }
  const provider = createProvider({
    id: 'probe',
    auth: {
      apiKey: {
        name: 'probe key',
        resolve: async () => {
          await probe.resolve?.()
          return { auth: { apiKey: 'k' } }
        }
      }
    },
    models: [model],
    api: impl
  })
  const models = createModels()
  models.setProvider(provider)
  return { models, model }
}

// ─────────────────────────── A: no network ───────────────────────────

describe('A — no network', () => {
  it('NET-01 events are forwarded by reference, error events included', async () => {
    const inner = fakeInner()
    const deltaA = textDelta('a')
    const deltaB = textDelta('b')
    const failed = errorEvent('Connection error.')
    inner.streamSimple.mockReturnValue(queued([deltaA, deltaB, failed]))

    const events = await collect(withNetwork(inner).streamSimple(MODEL, CONTEXT))

    expect(events).toHaveLength(3)
    expect(events[0]).toBe(deltaA)
    expect(events[1]).toBe(deltaB)
    expect(events[2]).toBe(failed)
  })

  it('NET-02 result() is the inner result object (the inner stream itself is returned)', async () => {
    const inner = fakeInner()
    const done = doneEvent('x')
    const innerStream = queued([done])
    inner.streamSimple.mockReturnValue(innerStream)

    const stream = withNetwork(inner).streamSimple(MODEL, CONTEXT)

    expect(stream).toBe(innerStream)
    expect(await stream.result()).toBe(done.type === 'done' ? done.message : undefined)
  })

  it('NET-03 a real Models whose auth throws: pi’s error event passes untouched', async () => {
    const { models, model } = probeModels({
      resolve: async () => {
        throw new Error('no key')
      }
    })
    const spy = vi.spyOn(models, 'streamSimple')

    const stream = withNetwork(models).streamSimple(model, CONTEXT)
    const events = await collect(stream)

    expect(stream).toBe(spy.mock.results[0].value)
    expect(events).toHaveLength(1)
    expect(errorTextOf(events[0])).toBe('API key auth failed for provider probe: no key')
  })

  it('NET-04 the timeoutMs default is still filled in (A1)', async () => {
    const inner = fakeInner()
    await collect(withNetwork(inner).streamSimple(MODEL, CONTEXT, { reasoning: 'high' }))
    expect(inner.streamSimple.mock.calls[0][2]).toEqual({ reasoning: 'high', timeoutMs: 600000 })
  })
})

// ─────────────────────────── B: scope ───────────────────────────

describe('B — request scope', () => {
  it('NET-05 auth resolution and the provider implementation both run in one scope', async () => {
    const seam = alsSeam()
    const seen: Record<string, boolean> = {}
    const { models, model } = probeModels({
      resolve: async () => {
        seen.auth = seam.inScope()
      },
      stream: () => {
        seen.impl = seam.inScope()
        return queued([doneEvent()])
      }
    })

    await collect(withNetwork(models, seam.network).streamSimple(model, CONTEXT))

    expect(seam.scopeRuns()).toBe(1)
    expect(seen).toEqual({ auth: true, impl: true })
  })

  it('NET-06 the same through completeSimple', async () => {
    const seam = alsSeam()
    const seen: Record<string, boolean> = {}
    const { models, model } = probeModels({
      resolve: async () => {
        seen.auth = seam.inScope()
      },
      stream: () => {
        seen.impl = seam.inScope()
        return queued([doneEvent()])
      }
    })

    await withNetwork(models, seam.network).completeSimple(model, CONTEXT)

    expect(seam.scopeRuns()).toBe(1)
    expect(seen).toEqual({ auth: true, impl: true })
  })

  it('NET-07 the detail is read inside the scope (a seam that throws outside it still annotates)', async () => {
    const inner = fakeInner()
    inner.streamSimple.mockReturnValue(queued([errorEvent('Connection error.')]))

    const events = await collect(
      withNetwork(inner, strictSeam('ECONNRESET')).streamSimple(MODEL, CONTEXT)
    )

    expect(errorTextOf(events[0])).toBe('Connection error. (ECONNRESET)')
  })

  it('NET-08 an error arriving after several awaits and a macrotask is still annotated', async () => {
    const seam = alsSeam()
    const inner = fakeInner()
    inner.streamSimple.mockImplementation(() => {
      const stream = createAssistantMessageEventStream()
      void (async () => {
        seam.recordFailure('UND_ERR_HEADERS_TIMEOUT')
        await Promise.resolve()
        await Promise.resolve()
        await new Promise((resolve) => setTimeout(resolve, 0))
        stream.push(errorEvent('Connection error.'))
      })()
      return stream
    })

    const events = await collect(withNetwork(inner, seam.network).streamSimple(MODEL, CONTEXT))

    expect(errorTextOf(events[0])).toBe('Connection error. (UND_ERR_HEADERS_TIMEOUT)')
  })

  it('NET-09 stream / streamSimple / complete / completeSimple each open one scope', async () => {
    const seam = alsSeam()
    const decorated = withNetwork(fakeInner(), seam.network)

    await collect(decorated.stream(MODEL, CONTEXT))
    await collect(decorated.streamSimple(MODEL, CONTEXT))
    await decorated.complete(MODEL, CONTEXT)
    await decorated.completeSimple(MODEL, CONTEXT)

    expect(seam.scopeRuns()).toBe(4)
  })

  it('NET-10 streamSimple returns an AssistantMessageEventStream synchronously', () => {
    const inner = fakeInner()
    inner.streamSimple.mockReturnValue(createAssistantMessageEventStream()) // never settles
    const stream = withNetwork(inner, alsSeam().network).streamSimple(MODEL, CONTEXT)
    expect(stream).toBeInstanceOf(EventStreamClass)
  })
})

// ─────────────────────────── C: annotation ───────────────────────────

describe('C — annotating error events', () => {
  it('NET-11 a recorded fetch failure is appended in parentheses', async () => {
    const inner = fakeInner()
    inner.streamSimple.mockReturnValue(queued([errorEvent('Connection error.')]))
    const seam = detailSeam('TypeError: fetch failed <- SocketError: other side closed')

    const events = await collect(withNetwork(inner, seam.network).streamSimple(MODEL, CONTEXT))

    expect(errorTextOf(events[0])).toBe(
      'Connection error. (TypeError: fetch failed <- SocketError: other side closed)'
    )
  })

  it('NET-12 pi’s objects are not mutated: new event and message, other fields kept', async () => {
    const original = errorEvent('Connection error.', {
      extra: { usage: { input: 3, output: 0 }, requestId: 'req-7' }
    })
    const originalError = original.type === 'error' ? original.error : undefined
    const inner = fakeInner()
    inner.streamSimple.mockReturnValue(queued([original]))

    const [forwarded] = await collect(
      withNetwork(inner, detailSeam('ECONNRESET').network).streamSimple(MODEL, CONTEXT)
    )

    expect(errorTextOf(original)).toBe('Connection error.')
    expect(forwarded).not.toBe(original)
    if (forwarded.type !== 'error') throw new Error('expected an error event')
    expect(forwarded.error).not.toBe(originalError)
    expect(forwarded.reason).toBe('error')
    const carried = forwarded.error as unknown as Record<string, unknown>
    expect(carried.requestId).toBe('req-7')
    expect(carried.usage).toEqual({ input: 3, output: 0 })
    expect(carried.stopReason).toBe('error')
  })

  it('NET-13 no recorded failure → the provider’s status-code error passes by reference', async () => {
    const rateLimited = errorEvent('429 rate_limit')
    const inner = fakeInner()
    inner.streamSimple.mockReturnValue(queued([rateLimited]))

    const events = await collect(
      withNetwork(inner, detailSeam(undefined).network).streamSimple(MODEL, CONTEXT)
    )

    expect(events[0]).toBe(rateLimited)
  })

  it('NET-14 a text that already contains the detail is not annotated twice', async () => {
    const already = errorEvent('Connection error. (TypeError: fetch failed)')
    const inner = fakeInner()
    inner.streamSimple.mockReturnValue(queued([already]))

    const events = await collect(
      withNetwork(inner, detailSeam('TypeError: fetch failed').network).streamSimple(MODEL, CONTEXT)
    )

    expect(events[0]).toBe(already)
  })

  it('NET-15 an undefined errorMessage becomes exactly the detail', async () => {
    const inner = fakeInner()
    inner.streamSimple.mockReturnValue(queued([errorEvent(undefined)]))

    const events = await collect(
      withNetwork(inner, detailSeam('ECONNRESET').network).streamSimple(MODEL, CONTEXT)
    )

    expect(errorTextOf(events[0])).toBe('ECONNRESET')
  })

  it('NET-16 a clean stream never reads the detail', async () => {
    const seam = detailSeam('ECONNRESET')
    const inner = fakeInner()
    inner.streamSimple.mockReturnValue(
      queued([textDelta('a'), textDelta('b'), textDelta('c'), doneEvent()])
    )

    await collect(withNetwork(inner, seam.network).streamSimple(MODEL, CONTEXT))

    expect(seam.reads()).toBe(0)
  })

  it('NET-17 surrounding whitespace is trimmed before appending', async () => {
    const inner = fakeInner()
    inner.streamSimple.mockReturnValue(queued([errorEvent('  Connection error.  ')]))

    const events = await collect(
      withNetwork(inner, detailSeam('ECONNRESET').network).streamSimple(MODEL, CONTEXT)
    )

    expect(errorTextOf(events[0])).toBe('Connection error. (ECONNRESET)')
  })

  it('NET-18 reason "aborted" is kept; only the text is annotated', async () => {
    const inner = fakeInner()
    inner.streamSimple.mockReturnValue(queued([errorEvent('Aborted.', { reason: 'aborted' })]))

    const [forwarded] = await collect(
      withNetwork(inner, detailSeam('ECONNRESET').network).streamSimple(MODEL, CONTEXT)
    )

    if (forwarded.type !== 'error') throw new Error('expected an error event')
    expect(forwarded.reason).toBe('aborted')
    expect(errorTextOf(forwarded)).toBe('Aborted. (ECONNRESET)')
  })

  it('NET-19 order and count are preserved; non-error events by reference', async () => {
    const deltas = [textDelta('a'), textDelta('b')]
    const inner = fakeInner()
    inner.streamSimple.mockReturnValue(queued([...deltas, errorEvent('Connection error.')]))

    const events = await collect(
      withNetwork(inner, detailSeam('ECONNRESET').network).streamSimple(MODEL, CONTEXT)
    )

    expect(events).toHaveLength(3)
    expect(events[0]).toBe(deltas[0])
    expect(events[1]).toBe(deltas[1])
    expect(errorTextOf(events[2])).toBe('Connection error. (ECONNRESET)')
  })
})

// ─────────────────────────── D: result() ───────────────────────────

describe('D — the final result()', () => {
  it('NET-20 result() is the annotated message — the very object the error event carried', async () => {
    const inner = fakeInner()
    inner.streamSimple.mockReturnValue(queued([errorEvent('Connection error.')]))

    const stream = withNetwork(inner, detailSeam('ECONNRESET').network).streamSimple(MODEL, CONTEXT)
    const [event] = await collect(stream)
    const result = await stream.result()

    expect(result.errorMessage).toBe('Connection error. (ECONNRESET)')
    expect(event.type === 'error' ? event.error : undefined).toBe(result)
  })

  it('NET-21 never iterated, only result() awaited → annotated, no hang', async () => {
    const inner = fakeInner()
    inner.streamSimple.mockReturnValue(queued([textDelta('a'), errorEvent('Connection error.')]))

    const result = await withNetwork(inner, detailSeam('ECONNRESET').network)
      .streamSimple(MODEL, CONTEXT)
      .result()

    expect(result.errorMessage).toBe('Connection error. (ECONNRESET)')
  })

  it('NET-22 an inner stream ending via end(errorMessage) without an error event → annotated result', async () => {
    const inner = fakeInner()
    const innerStream = createAssistantMessageEventStream()
    innerStream.push(textDelta('a'))
    innerStream.end({
      ...fakeAssistant(''),
      stopReason: 'error',
      errorMessage: 'Connection error.'
    })
    inner.streamSimple.mockReturnValue(innerStream)

    const result = await withNetwork(inner, detailSeam('ECONNRESET').network)
      .streamSimple(MODEL, CONTEXT)
      .result()

    expect(result.errorMessage).toBe('Connection error. (ECONNRESET)')
  })

  it('NET-23 a done stream: result() by reference, detail never read', async () => {
    const seam = detailSeam('ECONNRESET')
    const done = doneEvent('ok')
    const inner = fakeInner()
    inner.streamSimple.mockReturnValue(queued([done]))

    const result = await withNetwork(inner, seam.network).streamSimple(MODEL, CONTEXT).result()

    expect(result).toBe(done.type === 'done' ? done.message : undefined)
    expect(seam.reads()).toBe(0)
  })
})

// ─────────────────────────── E: setup failures ───────────────────────────

describe('E — failures before any event', () => {
  it('NET-24 the inner call throwing synchronously → one annotated error event, result settles', async () => {
    const inner = fakeInner()
    inner.streamSimple.mockImplementation(() => {
      throw new Error('Mismatched api: openai expected anthropic')
    })

    let stream: AssistantMessageEventStream | undefined
    expect(() => {
      stream = withNetwork(inner, detailSeam('ECONNRESET').network).streamSimple(MODEL, CONTEXT)
    }).not.toThrow()
    const events = await collect(stream!)

    expect(events).toHaveLength(1)
    expect(errorTextOf(events[0])).toBe('Mismatched api: openai expected anthropic (ECONNRESET)')
    expect((await stream!.result()).stopReason).toBe('error')
  })

  it('NET-25 a non-Error throw ("boom") → the text is String(err)', async () => {
    const inner = fakeInner()
    inner.streamSimple.mockImplementation(() => {
      throw 'boom'
    })

    const events = await collect(
      withNetwork(inner, detailSeam(undefined).network).streamSimple(MODEL, CONTEXT)
    )

    expect(errorTextOf(events[0])).toBe('boom')
  })

  it('NET-26 the synthesized message mirrors pi’s createSetupErrorMessage', async () => {
    const inner = fakeInner()
    inner.streamSimple.mockImplementation(() => {
      throw new Error('Connection error.')
    })

    const events = await collect(
      withNetwork(inner, detailSeam('UND_ERR_HEADERS_TIMEOUT').network).streamSimple(MODEL, CONTEXT)
    )

    expect(events).toEqual([
      {
        type: 'error',
        reason: 'error',
        error: {
          role: 'assistant',
          content: [],
          api: 'test-api',
          provider: 'p1',
          model: 'm1',
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
          },
          stopReason: 'error',
          errorMessage: 'Connection error. (UND_ERR_HEADERS_TIMEOUT)',
          timestamp: expect.any(Number)
        }
      }
    ])
  })

  it('NET-27 a source that yields done and then throws: only done is seen, result is it', async () => {
    const message = fakeAssistant('finished')
    const settled = { type: 'done', reason: 'stop', message } as AssistantMessageEvent
    async function* lateBoom(): AsyncGenerator<AssistantMessageEvent> {
      yield settled
      throw new Error('late boom')
    }
    const inner = fakeInner()
    inner.streamSimple.mockReturnValue(lateBoom())

    const stream = withNetwork(inner, detailSeam('ECONNRESET').network).streamSimple(MODEL, CONTEXT)

    expect(await collect(stream)).toEqual([settled])
    expect(await stream.result()).toBe(message)
  })
})

// ─────────────────────────── F: complete ───────────────────────────

describe('F — complete / completeSimple', () => {
  it('NET-28 a faux "Connection error." with a recorded failure resolves annotated', async () => {
    const seam = alsSeam()
    const faux = fauxProvider({ provider: 'faux-net' })
    const models = createModels()
    models.setProvider(faux.provider)
    faux.setResponses([
      () => {
        seam.recordFailure('UND_ERR_SOCKET')
        return fauxAssistantMessage([], { stopReason: 'error', errorMessage: 'Connection error.' })
      }
    ])

    const result = await withNetwork(models, seam.network).completeSimple(faux.getModel(), CONTEXT)

    expect(result.stopReason).toBe('error')
    expect(result.errorMessage).toBe('Connection error. (UND_ERR_SOCKET)')
  })

  it('NET-29 success: the message by reference, detail never read', async () => {
    const seam = detailSeam('ECONNRESET')
    const done = doneEvent('summary')
    const inner = fakeInner()
    inner.streamSimple.mockReturnValue(queued([done]))

    const got = await withNetwork(inner, seam.network).completeSimple(MODEL, CONTEXT)

    expect(got).toBe(done.type === 'done' ? done.message : undefined)
    expect(seam.reads()).toBe(0)
  })

  it('NET-30 (pinned) complete* resolve the decorated stream: inner.complete* is never called', async () => {
    const inner = fakeInner()
    const decorated = withNetwork(inner, detailSeam(undefined).network)
    await decorated.complete(MODEL, CONTEXT)
    await decorated.completeSimple(MODEL, CONTEXT)
    expect(inner.complete).not.toHaveBeenCalled()
    expect(inner.completeSimple).not.toHaveBeenCalled()
    expect(inner.stream).toHaveBeenCalledTimes(1)
    expect(inner.streamSimple).toHaveBeenCalledTimes(1)
  })
})

// ─────────────────────────── G: isolation ───────────────────────────

describe('G — scope isolation', () => {
  /**
   * Two streams in flight at once; A's fetch failed, B's did not (or failed differently). A
   * shared scope (a module-level variable, say) would hand B A's detail.
   */
  async function overlapping(
    seam: ReturnType<typeof alsSeam>,
    details: { a: string; b?: string }
  ): Promise<{ a: AssistantMessageEvent; b: AssistantMessageEvent }> {
    const gates: Record<string, { opened: Promise<void>; open: () => void }> = {}
    for (const provider of ['A', 'B']) {
      let open = (): void => {}
      const opened = new Promise<void>((resolve) => {
        open = resolve
      })
      gates[provider] = { opened, open }
    }
    const inner = fakeInner()
    inner.streamSimple.mockImplementation((model: Model<Api>) => {
      const stream = createAssistantMessageEventStream()
      void (async () => {
        await gates[model.provider].opened
        const detail = model.provider === 'A' ? details.a : details.b
        if (detail) seam.recordFailure(detail)
        stream.push(errorEvent('Connection error.'))
      })()
      return stream
    })
    const decorated = withNetwork(inner, seam.network)

    const collectedA = collect(
      decorated.streamSimple({ ...MODEL, provider: 'A' } as Model<Api>, CONTEXT)
    )
    const collectedB = collect(
      decorated.streamSimple({ ...MODEL, provider: 'B' } as Model<Api>, CONTEXT)
    )

    gates.B.open()
    const b = (await collectedB)[0]
    gates.A.open()
    const a = (await collectedA)[0]
    return { a, b }
  }

  it('NET-33 overlapping streams: only the failed one is annotated', async () => {
    const seam = alsSeam()
    const { a, b } = await overlapping(seam, { a: 'ECONNRESET' })

    expect(errorTextOf(a)).toBe('Connection error. (ECONNRESET)')
    expect(errorTextOf(b)).toBe('Connection error.')
    expect(seam.scopeRuns()).toBe(2)
  })

  it('NET-34 overlapping streams with different failures each get their own', async () => {
    const seam = alsSeam()
    const { a, b } = await overlapping(seam, { a: 'UND_ERR_HEADERS_TIMEOUT', b: 'UND_ERR_SOCKET' })

    expect(errorTextOf(a)).toBe('Connection error. (UND_ERR_HEADERS_TIMEOUT)')
    expect(errorTextOf(b)).toBe('Connection error. (UND_ERR_SOCKET)')
  })

  it('NET-35 sequential calls read their own detail, not the previous one’s', async () => {
    const seam = alsSeam()
    const details = ['detail X', 'detail Y']
    let call = 0
    const inner = fakeInner()
    inner.streamSimple.mockImplementation(() => {
      seam.recordFailure(details[call++])
      return queued([errorEvent('Connection error.')])
    })
    const decorated = withNetwork(inner, seam.network)

    const first = await collect(decorated.streamSimple(MODEL, CONTEXT))
    const second = await collect(decorated.streamSimple(MODEL, CONTEXT))

    expect(errorTextOf(first[0])).toBe('Connection error. (detail X)')
    expect(errorTextOf(second[0])).toBe('Connection error. (detail Y)')
  })
})

// ─────────────────────────── H: options ───────────────────────────

describe('H — options forwarded to the inner call', () => {
  it('NET-36 caller options are copied with the default added; the caller’s object is untouched', async () => {
    const inner = fakeInner()
    const callerOptions: { reasoning: 'high' } = { reasoning: 'high' }

    await collect(
      withNetwork(inner, detailSeam().network).streamSimple(MODEL, CONTEXT, callerOptions)
    )

    const forwarded = inner.streamSimple.mock.calls[0][2]
    expect(forwarded).not.toBe(callerOptions)
    expect(forwarded).toEqual({ reasoning: 'high', timeoutMs: 600000 })
    expect(callerOptions).toEqual({ reasoning: 'high' })
  })

  it('NET-37 no options → {timeoutMs: 600000}', async () => {
    const inner = fakeInner()
    await collect(withNetwork(inner, detailSeam().network).streamSimple(MODEL, CONTEXT))
    expect(inner.streamSimple.mock.calls[0][2]).toEqual({ timeoutMs: 600000 })
    expect(DEFAULT_REQUEST_TIMEOUT_MS).toBe(600000)
  })

  it('NET-38 a caller timeout of 5000 is kept', async () => {
    const inner = fakeInner()
    await collect(
      withNetwork(inner, detailSeam().network).streamSimple(MODEL, CONTEXT, { timeoutMs: 5000 })
    )
    expect(inner.streamSimple.mock.calls[0][2]).toEqual({ timeoutMs: 5000 })
  })

  it('NET-39 withNetwork(…, {timeoutMs: 1234}) changes the default', async () => {
    const inner = fakeInner()
    await collect(
      withNetwork(inner, detailSeam().network, { timeoutMs: 1234 }).streamSimple(MODEL, CONTEXT)
    )
    expect(inner.streamSimple.mock.calls[0][2]).toEqual({ timeoutMs: 1234 })
  })

  it('NET-40 a caller timeout of 0 is kept (not treated as missing)', async () => {
    const inner = fakeInner()
    await collect(
      withNetwork(inner, detailSeam().network).streamSimple(MODEL, CONTEXT, { timeoutMs: 0 })
    )
    expect(inner.streamSimple.mock.calls[0][2]).toEqual({ timeoutMs: 0 })
  })

  it('NET-41 the same default on all four entry points; model and context by reference', async () => {
    const inner = fakeInner()
    const decorated = withNetwork(inner, detailSeam().network)

    await collect(decorated.stream(MODEL, CONTEXT))
    await collect(decorated.streamSimple(MODEL, CONTEXT))
    await decorated.complete(MODEL, CONTEXT)
    await decorated.completeSimple(MODEL, CONTEXT)

    const calls = [...inner.stream.mock.calls, ...inner.streamSimple.mock.calls]
    expect(calls).toHaveLength(4)
    for (const [model, context, options] of calls) {
      expect(model).toBe(MODEL)
      expect(context).toBe(CONTEXT)
      expect(options).toEqual({ timeoutMs: 600000 })
    }
  })
})

// ─────────────────────────── I: delegation ───────────────────────────

type MethodSpec =
  | { kind: 'delegated'; args: unknown[] }
  | { kind: 'scoped'; args: unknown[] }
  | { kind: 'stream' }

const signal = new AbortController().signal
const handle = { provider: 'p1', modelId: 'm1', api: 'test-api', id: 'h1' }
const interaction = { prompt: async () => '', notify: () => {} }

/** Every Models method, classified. A method added by pi makes this table fail the typecheck. */
const METHODS = {
  getProviders: { kind: 'delegated', args: [] },
  getProvider: { kind: 'delegated', args: ['xai'] },
  getModels: { kind: 'delegated', args: ['xai'] },
  getModel: { kind: 'delegated', args: ['xai', 'm1'] },
  getModelsOfType: { kind: 'delegated', args: ['chat', 'xai'] },
  getModelOfType: { kind: 'delegated', args: ['chat', 'xai', 'm1'] },
  getAllModels: { kind: 'delegated', args: ['xai'] },
  refresh: { kind: 'delegated', args: [{ allowNetwork: false, signal }] },
  checkAuth: { kind: 'delegated', args: ['xai', { signal }] },
  getAvailable: { kind: 'delegated', args: ['xai', { signal }] },
  getAvailableOfType: { kind: 'delegated', args: ['chat', 'xai', { signal }] },
  getAllAvailable: { kind: 'delegated', args: ['xai', { signal }] },
  getAuth: { kind: 'delegated', args: ['xai', { apiKey: 'k', signal }] },
  login: { kind: 'delegated', args: ['xai', 'oauth', interaction, { getDeviceId: () => 'd' }] },
  logout: { kind: 'delegated', args: ['xai', { signal }] },
  streamDeferred: { kind: 'scoped', args: [MODEL, handle, { wait: 5 }] },
  fetchDeferred: { kind: 'scoped', args: [MODEL, handle, { wait: 5 }] },
  cancelDeferred: { kind: 'scoped', args: [MODEL, handle, { signal }] },
  generateImages: { kind: 'scoped', args: [MODEL, { prompt: 'p' }, { signal }] },
  classify: { kind: 'scoped', args: [MODEL, { input: 'x' }, { signal }] },
  stream: { kind: 'stream' },
  complete: { kind: 'stream' },
  streamSimple: { kind: 'stream' },
  completeSimple: { kind: 'stream' }
} satisfies Record<keyof Models, MethodSpec>

function entriesOf(kind: MethodSpec['kind']): Array<[keyof Models, unknown[]]> {
  return (Object.entries(METHODS) as Array<[keyof Models, MethodSpec]>)
    .filter(([, spec]) => spec.kind === kind)
    .map(([name, spec]) => [name, 'args' in spec ? spec.args : []])
}

describe('I — delegation', () => {
  it.each(entriesOf('delegated'))(
    'NET-42 %s is delegated with identical arguments and return value, outside any scope',
    (name, args) => {
      const seam = alsSeam()
      const inner = fakeInner()
      const sentinel = { returnedBy: name }
      let inScope: boolean | undefined
      inner[name].mockImplementation(() => {
        inScope = seam.inScope()
        return sentinel
      })

      const returned = (withNetwork(inner, seam.network)[name] as (...a: unknown[]) => unknown)(
        ...args
      )

      expect(returned).toBe(sentinel)
      expect(inner[name]).toHaveBeenCalledTimes(1)
      expect(inner[name].mock.calls[0]).toEqual(args)
      args.forEach((arg, index) => expect(inner[name].mock.calls[0][index]).toBe(arg))
      expect(inScope).toBe(false)
      expect(seam.scopeRuns()).toBe(0)
    }
  )

  it('NET-42b getAuth with a model argument is delegated as such', async () => {
    const inner = fakeInner()
    inner.getAuth.mockResolvedValue({ auth: { apiKey: 'k' } })
    const overrides = { signal }
    expect(await withNetwork(inner).getAuth(MODEL, overrides)).toEqual({ auth: { apiKey: 'k' } })
    expect(inner.getAuth.mock.calls[0][0]).toBe(MODEL)
    expect(inner.getAuth.mock.calls[0][1]).toBe(overrides)
  })

  it.each(entriesOf('scoped'))(
    'NET-43 %s is delegated unchanged (no timeout default) inside one request scope (A7)',
    (name, args) => {
      const seam = alsSeam()
      const inner = fakeInner()
      const sentinel = { returnedBy: name }
      let inScope: boolean | undefined
      inner[name].mockImplementation(() => {
        inScope = seam.inScope()
        return sentinel
      })

      const returned = (withNetwork(inner, seam.network)[name] as (...a: unknown[]) => unknown)(
        ...args
      )

      expect(returned).toBe(sentinel)
      expect(inner[name].mock.calls[0]).toEqual(args)
      args.forEach((arg, index) => expect(inner[name].mock.calls[0][index]).toBe(arg))
      expect(inScope).toBe(true)
      expect(seam.scopeRuns()).toBe(1)
    }
  )

  it('NET-44 behind the decorator a real Models works, and later providers are visible', async () => {
    const inner = createModels()
    const decorated = withNetwork(inner, alsSeam().network)
    const faux = fauxProvider({ provider: 'faux-late' })

    expect(decorated.getProviders()).toEqual([])
    inner.setProvider(faux.provider)

    expect(decorated.getProviders().map((p) => p.id)).toEqual(['faux-late'])
    expect(decorated.getModels('faux-late').map((m) => m.id)).toEqual(['faux-1'])
    expect(decorated.getModel('faux-late', 'faux-1')?.id).toBe('faux-1')
    expect(await decorated.checkAuth('faux-late')).toMatchObject({ type: 'api_key' })
    expect((await decorated.getAvailable()).map((m) => m.id)).toEqual(['faux-1'])
  })
})

// ─────────────────────────── J: retry classification ───────────────────────────

describe('J — what pi-durable’s retry classifier sees', () => {
  function fauxWithFailure(
    seam: ReturnType<typeof alsSeam>,
    errorMessage: string,
    detail?: string
  ): { decorated: Models; model: Model<Api> } {
    const faux = fauxProvider({ provider: 'faux-retry' })
    const models = createModels()
    models.setProvider(faux.provider)
    faux.setResponses([
      () => {
        if (detail) seam.recordFailure(detail)
        return fauxAssistantMessage([], { stopReason: 'error', errorMessage })
      }
    ])
    return { decorated: withNetwork(models, seam.network), model: faux.getModel() }
  }

  it('NET-45 completeSimple: "Connection error." + socket cause → exact text, retryable', async () => {
    const seam = alsSeam()
    const detail = 'TypeError: fetch failed <- SocketError: other side closed (UND_ERR_SOCKET)'
    const { decorated, model } = fauxWithFailure(seam, 'Connection error.', detail)

    const result = await decorated.completeSimple(model, CONTEXT)

    expect(result.errorMessage).toBe(`Connection error. (${detail})`)
    expect(isRetryableAssistantError(result)).toBe(true)
  })

  it('NET-46 the same through streamSimple().result()', async () => {
    const seam = alsSeam()
    const detail = 'TypeError: fetch failed <- SocketError: other side closed (UND_ERR_SOCKET)'
    const { decorated, model } = fauxWithFailure(seam, 'Connection error.', detail)

    const result = await decorated.streamSimple(model, CONTEXT).result()

    expect(result.errorMessage).toBe(`Connection error. (${detail})`)
    expect(isRetryableAssistantError(result)).toBe(true)
  })

  it('NET-47 "Request timed out." + headers timeout → retryable', async () => {
    const seam = alsSeam()
    const { decorated, model } = fauxWithFailure(
      seam,
      'Request timed out.',
      'UND_ERR_HEADERS_TIMEOUT'
    )

    const result = await decorated.completeSimple(model, CONTEXT)

    expect(result.errorMessage).toBe('Request timed out. (UND_ERR_HEADERS_TIMEOUT)')
    expect(isRetryableAssistantError(result)).toBe(true)
  })

  it('NET-48 provider-answered errors stay non-retryable (no detail; quota beats "fetch failed")', async () => {
    const seam = alsSeam()
    const invalid = fauxWithFailure(seam, '400 invalid_request_error')
    const invalidResult = await invalid.decorated.completeSimple(invalid.model, CONTEXT)
    expect(invalidResult.errorMessage).toBe('400 invalid_request_error')
    expect(isRetryableAssistantError(invalidResult)).toBe(false)

    const quota = fauxWithFailure(seam, 'insufficient_quota', 'TypeError: fetch failed')
    const quotaResult = await quota.decorated.completeSimple(quota.model, CONTEXT)
    expect(quotaResult.errorMessage).toBe('insufficient_quota (TypeError: fetch failed)')
    expect(isRetryableAssistantError(quotaResult)).toBe(false)
  })
})
