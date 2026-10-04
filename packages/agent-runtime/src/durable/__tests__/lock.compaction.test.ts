/**
 * 锁 · 压缩窗口（裁决 Q2 / K14 / PIN-1）：压缩余量（reserve = background = min(32768, ⌊窗口/4⌋)）与保留的
 * 近期上下文（min(20000, ⌊窗口/4⌋)）按**锁定模型**的上下文窗口现算；没锁 / 查不到模型 → 32768 / 20000。
 * 读的是会话实际交给 Harness 的那份 settings（`session.effectiveSettings`），不 mock settings 模块。
 */
import { fauxAssistantMessage, type FauxResponseStep } from '@earendil-works/pi-ai'
import { CompactionEntry } from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import { scenarioConfig, testProfile } from './support/agentConfig'
import { fauxKit } from './support/faux'
import { registerHostCleanup } from './support/host'
import { scenarioW } from './support/scenario'
import { allEntries } from './support/transcript'
import { waitFor } from './support/wait'
import type { DurableSession } from '../durableSession'

registerHostCleanup()

function window(session: DurableSession): { reserve?: number; background?: number; keep?: number } {
  const compaction = session.effectiveSettings.compaction
  return {
    reserve: compaction?.reserveTokens,
    background: compaction?.backgroundTokens,
    keep: compaction?.keepRecentTokens
  }
}

describe('lock · compaction window', () => {
  it('LW-01 unlocked: reserve = background = 32768, keepRecent 20000', async () => {
    const { t } = await scenarioW()
    const session = await t.open()
    expect(window(session)).toEqual({ reserve: 32768, background: 32768, keep: 20000 })
  })

  it("LW-02 locked to faux-1 (40000): 10000; editing the session's model while locked changes nothing", async () => {
    const config = scenarioConfig()
    const { t } = await scenarioW({ config })
    const session = await t.open()
    await session.createAgent()
    expect(window(session)).toEqual({ reserve: 10000, background: 10000, keep: 10000 })
    config.model = { provider: 'faux', modelId: 'faux-2' }
    expect(window(session)).toEqual({ reserve: 10000, background: 10000, keep: 10000 })
  })

  it('LW-03 a 200000 window caps at 32768 / 20000', async () => {
    const { t } = await scenarioW({
      makeKit: () => fauxKit({ models: [{ id: 'faux-1', contextWindow: 200000 }] })
    })
    const session = await t.open()
    await session.createAgent()
    expect(window(session)).toEqual({ reserve: 32768, background: 32768, keep: 20000 })
  })

  it('LW-04 destroying the agent drops back to 32768; recreating on faux-2 (8000) gives 2000', async () => {
    const config = scenarioConfig()
    const { t } = await scenarioW({ config })
    const session = await t.open()
    await session.createAgent()
    await session.destroyAgent()
    expect(window(session)).toEqual({ reserve: 32768, background: 32768, keep: 20000 })
    config.model = { provider: 'faux', modelId: 'faux-2' }
    await session.createAgent()
    expect(window(session)).toEqual({ reserve: 2000, background: 2000, keep: 2000 })
  })

  it('LW-05 after a restart the window comes from the cached lock before any send (synchronous getter)', async () => {
    const { t } = await scenarioW()
    const session = await t.open()
    await session.createAgent()
    const t2 = await t.restart()
    const reopened = await t2.open()
    expect(window(reopened)).toEqual({ reserve: 10000, background: 10000, keep: 10000 })
    expect(t2.kit.callCount).toBe(0)
  })

  it('LW-06 a locked model that vanished from the registry counts as unknown (no throw)', async () => {
    const { t } = await scenarioW()
    const session = await t.open()
    await session.createAgent()
    t.kit.models.deleteProvider('faux')
    expect(() => session.effectiveSettings.compaction).not.toThrow()
    expect(window(session)).toEqual({ reserve: 32768, background: 32768, keep: 20000 })
  })

  it('LW-07 behaviour: a 3000-window locked model compacts in the background after two long answers', async () => {
    const { t } = await scenarioW({
      config: { profile: testProfile(), model: { provider: 'faux', modelId: 'faux-1' } },
      makeKit: () => fauxKit({ models: [{ id: 'faux-1', contextWindow: 3000 }] }),
      // reserve = background = 750 → 背景压缩从约 1500 tokens 开始；保留 100 tokens 才找得到切点
      settingsOverrides: { retry: { enabled: false }, compaction: { keepRecentTokens: 100 } }
    })
    const respond: FauxResponseStep = async (context) => {
      const first = context.messages[0]
      if (
        first?.role === 'system' &&
        typeof first.content === 'string' &&
        first.content.includes('summar')
      ) {
        return fauxAssistantMessage('## Goal\nsummary')
      }
      return fauxAssistantMessage(`answer ${'details '.repeat(800)}`)
    }
    for (let i = 0; i < 6; i++) t.kit.queue(respond)
    const session = await t.open()
    expect(await session.submitUser('first question')).toEqual({})
    expect(window(session)).toEqual({ reserve: 750, background: 750, keep: 100 })
    expect(await session.submitUser('second question')).toEqual({})
    const conversation = await session.currentConversation()
    await waitFor(
      async () => (await allEntries(conversation)).some((entry) => CompactionEntry.is(entry)),
      5000,
      'compaction summary'
    )
  })
})
