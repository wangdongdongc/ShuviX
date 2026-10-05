/**
 * P1-12 · 场景 4：重试，走真模型注册表（`createModelRegistry`）+ 真 `withNetwork` 装饰器 + 锁的模型解析
 * （K5）。faux 挂在自定义 provider 行 U 的 id 下（PIN-3）；选择 `{provider: U, modelId: 'faux-1'}`。
 *
 * 覆盖 `{retry: {baseDelayMs: 5}, compaction: {enabled: false}}` —— 逐段合并，重试仍开、maxRetries 仍是 10。
 * 瞬时的重试窗口（`pi.live.generation.retry`）从提交记录器断言，不靠事后轮询。
 */
import { LiveDoc, UsageDoc, type EntryRecord, type LiveState } from '@earendil-works/pi-durable'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { backgroundContext as BG } from '../../context'
import type { DurableSession } from '../../durableSession'
import type { ShuviXSettingsOverrides } from '../../settings'
import { answer, modelError } from '../support/faux'
import { registerHostCleanup } from '../support/host'
import { allEntries } from '../support/transcript'
import { sleep, waitFor, withTimeout } from '../support/wait'
import { C, registryModels, U } from './support/registryWorld'
import { textOf } from './support/scriptedModel'
import { makeWorld, registerWorldCleanup, type SessionSpec, type World } from './support/world'

registerHostCleanup()
registerWorldCleanup()

afterEach(() => {
  vi.unstubAllGlobals()
})

const TIMEOUT = 10000
const RECOVERY_TIMEOUT = 20000

const E1 = '503 Service Unavailable'
const E2 = 'overloaded_error: Overloaded'
const BAD = '400 invalid_request_error: bad schema'
const SOCKET = 'TypeError: fetch failed <- SocketError: other side closed (UND_ERR_SOCKET)'

function retrySettings(baseDelayMs = 5): ShuviXSettingsOverrides {
  return { retry: { baseDelayMs }, compaction: { enabled: false } }
}

async function registryWorld(
  baseDelayMs = 5,
  sessions: Record<string, SessionSpec> = {}
): Promise<{ world: World; models: ReturnType<typeof registryModels> }> {
  const models = registryModels()
  const world = await makeWorld({
    settings: retrySettings(baseDelayMs),
    provider: U,
    modelId: 'faux-1',
    tools: [],
    overlay: [],
    sessions,
    makeModels: models.make
  })
  return { world, models }
}

function generations(world: World, sessionId = 's1'): NonNullable<LiveState['generation']>[] {
  return world
    .recorder(sessionId)
    .livesOf()
    .flatMap((live) => (live.generation === undefined ? [] : [live.generation]))
}

function retries(world: World, sessionId = 's1'): { at: number; error: string }[] {
  const seen: { at: number; error: string }[] = []
  for (const generation of generations(world, sessionId)) {
    const retry = generation.retry
    if (retry === undefined) continue
    if (seen.some((known) => known.at === retry.at && known.error === retry.error)) continue
    seen.push(retry)
  }
  return seen
}

async function assistants(session: DurableSession): Promise<EntryRecord[]> {
  return (await allEntries(await session.currentConversation())).filter(
    (entry) => entry.kind === 'pi.assistant'
  )
}

function assistantSummary(entry: EntryRecord): string {
  const message = entry.model?.[0]
  if (message?.role !== 'assistant') return '?'
  return message.stopReason === 'error' ? `error:${message.errorMessage ?? ''}` : textOf(message)
}

function inputSum(list: readonly EntryRecord[]): number {
  return list.reduce((sum, entry) => {
    const message = entry.model?.[0]
    return sum + (message?.role === 'assistant' ? message.usage.input : 0)
  }, 0)
}

describe('P1-12 · retries', () => {
  it(
    'I4-01 two retryable errors, then success: attempts 1-2-3, the same request three times, errors stay out of later context',
    async () => {
      const { world } = await registryWorld()
      const session = await world.open()
      world.chat(modelError(E1), modelError(E2), answer('ok'))
      expect(await withTimeout(session.submitUser('hi'), 5000, 'send')).toEqual({})

      expect([...new Set(generations(world).map((generation) => generation.attempt))]).toEqual([
        1, 2, 3
      ])
      const seen = retries(world)
      expect(seen.map((retry) => retry.error)).toEqual([E1, E2])
      expect(seen[1]!.at).toBeGreaterThan(seen[0]!.at)
      expect(world.model.chats).toHaveLength(3)
      expect(world.model.chats[1]!.messages).toEqual(world.model.chats[0]!.messages)
      expect(world.model.chats[2]!.messages).toEqual(world.model.chats[0]!.messages)
      expect(world.model.chats[0]!.modelId).toBe('faux-1')
      expect(session.lock!.model).toEqual({ provider: U, modelId: 'faux-1' })

      const list = await assistants(session)
      expect(list.map(assistantSummary)).toEqual([`error:${E1}`, `error:${E2}`, 'ok'])
      await waitFor(() => world.t.statesOf('s1').length >= 3, 1000, 'run states')
      expect(world.t.statesOf('s1')).toEqual(['idle', 'busy', 'idle'])

      // 用量：两次报错的请求都记了账（F7），而且就等于各条目之和
      const conversation = await session.currentConversation()
      const usage = await session.harness.snapshot(UsageDoc, conversation.id, BG)
      const errors = list.slice(0, 2)
      expect(inputSum(errors)).toBeGreaterThan(0)
      expect(usage?.models[`${U}/faux-1`]?.input).toBe(inputSum(list))

      world.chat(answer('again'))
      expect(await session.submitUser('next')).toEqual({})
      const next = world.model.chats.at(-1)!
      expect(
        next.messages.some(
          (message) => message.role === 'assistant' && message.stopReason === 'error'
        )
      ).toBe(false)
    },
    TIMEOUT
  )

  it(
    'I4-02 retryable, then non-retryable: model_error after two requests, no generation left, the next send works',
    async () => {
      const { world } = await registryWorld()
      const session = await world.open()
      world.chat(modelError(E1), modelError(BAD))
      expect(await withTimeout(session.submitUser('hi'), 5000, 'send')).toEqual({
        error: BAD,
        code: 'model_error'
      })
      expect(world.model.chats).toHaveLength(2)
      const conversation = await session.currentConversation()
      expect(
        (await session.harness.snapshot(LiveDoc, conversation.id, BG))?.generation
      ).toBeUndefined()
      await waitFor(() => session.runState === 'idle', 1000, 'idle')

      world.chat(answer('fine'))
      expect(await session.submitUser('again')).toEqual({})
    },
    TIMEOUT
  )

  it(
    'I4-03 the decorator’s annotation decides the classification: a recorded socket failure makes "The provider failed" retryable',
    async () => {
      const { world, models } = await registryWorld()
      const session = await world.open()
      world.chat(() => {
        models.current().seam.recordFailure(SOCKET)
        return modelError('The provider failed')
      }, answer('recovered'))
      expect(await withTimeout(session.submitUser('hi'), 5000, 'send')).toEqual({})

      const annotated = `The provider failed (${SOCKET})`
      expect(world.model.chats).toHaveLength(2)
      expect(retries(world).map((retry) => retry.error)).toEqual([annotated])
      expect((await assistants(session)).map(assistantSummary)).toEqual([
        `error:${annotated}`,
        'recovered'
      ])
    },
    TIMEOUT
  )

  it(
    'I4-04 a crash during the backoff: reopen keeps the persisted retry window and waits; continue resends no earlier than it',
    async () => {
      const { world } = await registryWorld(300)
      const session = await world.open()
      world.chat(modelError(E1))
      void session.submitUser('hi')
      await waitFor(() => retries(world).length === 1, 3000, 'retry window')
      const window = retries(world)[0]!

      await withTimeout(world.restart(), 10000, 'restart')
      const reopened = await world.open()
      expect(reopened.isInterrupted()).toBe(true)
      const conversation = await reopened.currentConversation()
      const live = await reopened.harness.snapshot(LiveDoc, conversation.id, BG)
      expect(live?.generation?.retry).toEqual(window)
      await sleep(150)
      expect(world.model.requests).toEqual([])

      world.chat(answer('after the crash'))
      expect(await withTimeout(reopened.continue(), 5000, 'continue')).toEqual({})
      expect(world.model.chats).toHaveLength(1)
      expect(world.model.chats[0]!.at).toBeGreaterThanOrEqual(window.at)
      expect((await assistants(reopened)).map(assistantSummary)).toEqual([
        `error:${E1}`,
        'after the crash'
      ])
    },
    RECOVERY_TIMEOUT
  )

  it(
    'I4-05 M4: a keyless custom provider whose uuid contains 503 fails once with its label, never retried, never fetched',
    async () => {
      const fetchSpy = vi.fn(async () => {
        throw new Error('fetch must not be called')
      })
      vi.stubGlobal('fetch', fetchSpy)
      const { world } = await registryWorld(5, { s5: { provider: C, modelId: 'alpha' } })
      const session = await world.open('s5')
      const result = await withTimeout(session.submitUser('hi'), 5000, 'send')
      expect(result.code).toBe('model_error')
      expect(result.error).toContain('"My Proxy"')
      expect(result.error).not.toContain(C)
      expect(session.lock!.model).toEqual({ provider: C, modelId: 'alpha' })
      expect(retries(world, 's5')).toEqual([])
      const list = await assistants(session)
      expect(list.map(assistantSummary)).toEqual([`error:${result.error}`])
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(world.model.requests).toEqual([])
    },
    TIMEOUT
  )

  it(
    'I4-06 abort during the backoff: resolves quickly, nothing more is sent, no generation is left',
    async () => {
      const { world } = await registryWorld(300)
      const session = await world.open()
      world.chat(modelError(E1))
      const sending = session.submitUser('hi')
      await waitFor(() => retries(world).length === 1, 3000, 'retry window')
      await withTimeout(session.abort(), 1000, 'abort')
      expect(await withTimeout(sending, 1000, 'send')).toEqual({})
      await sleep(400)
      expect(world.model.chats).toHaveLength(1)
      const conversation = await session.currentConversation()
      expect(
        (await session.harness.snapshot(LiveDoc, conversation.id, BG))?.generation
      ).toBeUndefined()
    },
    TIMEOUT
  )
})
