/**
 * P2-11 · J6：档案的 `shuvix-model` / `shuvix-thinking` 键，经桌面口径的模型解析（`resolveModelRef` 对着已启用
 * 的模型行）落到子 agent 的请求、记录、身份、用量与压缩余量上；点了停用模型的档案回落调用方的模型并警告一次。
 */
import { UsageDoc } from '@earendil-works/pi-durable'
import { afterEach, describe, expect, it } from 'vitest'
import { backgroundContext as BG } from '../../context'
import { answer, callTool, held } from '../support/faux'
import { registerHostCleanup } from '../support/host'
import { withTimeout } from '../support/wait'
import { childOfCall, recordOf, releaseHolds, resultOf, spawnWorld } from './support/spawnWorld'
import { registerWorldCleanup } from './support/world'

registerHostCleanup()
registerWorldCleanup()
afterEach(() => releaseHolds())

const TIMEOUT = 10000

describe('P2-11 · J6 model and thinking md keys', () => {
  it(
    'J6-01 tuned: the child runs faux-2 at high thinking; root stays faux-1 / low; usage and the reserve follow the live models',
    async () => {
      const sw = await spawnWorld()
      const { world } = sw
      const session = await sw.open()
      world.chat(answer('ready'))
      expect(await session.submitUser('hello')).toEqual({})
      const childAnswer = held(answer('tuned ok'))
      world.chat(
        callTool('agent', { name: 'tuned', prompt: 'tune', description: 't' }, 'r-agent'),
        answer('done')
      )
      world.model.chatIn('tuned', childAnswer.step)
      const sending = session.submitUser('go')
      await withTimeout(childAnswer.reached, 3000, 'child request')
      expect(session.effectiveSettings.compaction?.reserveTokens).toBe(2000)
      childAnswer.release()
      expect(await withTimeout(sending, 5000, 'send')).toEqual({})
      world.chat(answer('after'))
      expect(await session.submitUser('again')).toEqual({})

      const child = world.model.laneRequests('tuned')
      expect(child.map((request) => [request.modelId, request.reasoning])).toEqual([
        ['faux-2', 'high']
      ])
      const root = world.model.laneRequests('root')
      expect(root.length).toBeGreaterThanOrEqual(4)
      for (const request of root) expect([request.modelId, request.reasoning]).toEqual(['faux-1', 'low'])

      const C = await childOfCall(session, 'r-agent')
      expect(await recordOf(session, C)).toMatchObject({
        model: { provider: 'faux', modelId: 'faux-2' },
        thinkingLevel: 'high'
      })
      expect(session.agentIdentity(C)?.getModelConfig?.().model).toBe('faux-2')
      expect(Object.keys((await session.harness.snapshot(UsageDoc, C, BG))!.models)).toEqual([
        'faux/faux-2'
      ])
      expect(Object.keys((await session.harness.snapshot(UsageDoc, 1 as never, BG))!.models)).toEqual(
        ['faux/faux-1']
      )
      expect(session.effectiveSettings.compaction?.reserveTokens).toBe(10000)
      expect(world.t.warnings).toEqual([])
      expect((await resultOf(session, 1, 'r-agent')).text).toBe('tuned ok')
    },
    TIMEOUT
  )

  it(
    'J6-02 fallback: a disabled model falls back to the caller’s model with one warning; thinking off is kept',
    async () => {
      const sw = await spawnWorld()
      const { world } = sw
      const session = await sw.open()
      world.chat(
        callTool('agent', { name: 'fallback', prompt: 'fall', description: 'f' }, 'r-agent'),
        answer('done')
      )
      world.model.chatIn('fallback', answer('fell back'))
      expect(await withTimeout(session.submitUser('go'), 5000, 'send')).toEqual({})

      const [child] = world.model.laneRequests('fallback')
      expect(child!.modelId).toBe('faux-1')
      expect(child!.reasoning).toBeUndefined()
      const C = await childOfCall(session, 'r-agent')
      expect(await recordOf(session, C)).toMatchObject({
        model: { provider: 'faux', modelId: 'faux-1' },
        thinkingLevel: 'off'
      })
      expect(world.t.warnings).toHaveLength(1)
      expect(world.t.warnings[0]).toContain('fallback')
      expect(world.t.warnings[0]).toContain('faux/gone')
      expect((await resultOf(session, 1, 'r-agent')).text).toBe('fell back')
    },
    TIMEOUT
  )
})
