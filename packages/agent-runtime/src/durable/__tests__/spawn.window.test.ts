/**
 * SpawnCoordinator · 压缩窗口取最小（P2-03，M 段 72–73）：在跑的派生 agent 的模型窗口也算进压缩余量
 * （faux-2 = 8000 → 2000）；跑完 / 闲着不算；查不到的模型按未知；重开之后照样算（被中断的子 agent）。
 */
import { fauxProvider } from '@earendil-works/pi-ai'
import { describe, expect, it } from 'vitest'
import type { DurableSession } from '../durableSession'
import { answer, held, stalled } from './support/faux'
import { registerHostCleanup } from './support/host'
import { callAgent, firstChild, hostD } from './support/spawn'
import { withTimeout } from './support/wait'

registerHostCleanup()

function window(session: DurableSession): { reserve?: number; background?: number; keep?: number } {
  const compaction = session.effectiveSettings.compaction
  return {
    reserve: compaction?.reserveTokens,
    background: compaction?.backgroundTokens,
    keep: compaction?.keepRecentTokens
  }
}

const SMALL = { reserve: 2000, background: 2000, keep: 2000 }
const ROOT = { reserve: 10000, background: 10000, keep: 10000 }

describe('SpawnCoordinator · min-window settings', () => {
  it('P2-03-72 a live faux-2 child shrinks the window; it ends → back to the root window', async () => {
    const d = await hostD()
    expect(window(d.session)).toEqual(ROOT)
    const step = held(answer('found'))
    d.t.kit.queue(callAgent('modeled', 'find X'), step.step, answer('done'))
    const sent = d.session.submitUser('go')
    await step.reached
    expect(window(d.session)).toEqual(SMALL)
    // faux-2 从注册表里没了：按未知，不抛
    const original = d.t.kit.models.getProvider('faux')!
    d.t.kit.models.setProvider(
      fauxProvider({ models: [{ id: 'faux-1', contextWindow: 40000 }] }).provider
    )
    expect(window(d.session)).toEqual(ROOT)
    d.t.kit.models.setProvider(original)
    step.release()
    expect(await withTimeout(sent, 3000, 'root')).toEqual({})
    // 闲着的子 agent 不算
    expect(window(d.session)).toEqual(ROOT)
  })

  it('P2-03-73 after a restart: an interrupted faux-2 child counts right after open, without a model call', async () => {
    const first = await hostD()
    const stall = stalled()
    first.t.kit.queue(callAgent('modeled', 'find X'), stall.step)
    void first.session.submitUser('go')
    await stall.reached
    await firstChild(first.session)
    const d = await first.reopen()
    expect(window(d.session)).toEqual(SMALL)
    expect(d.t.kit.callCount).toBe(0)
  }, 15000)
})
