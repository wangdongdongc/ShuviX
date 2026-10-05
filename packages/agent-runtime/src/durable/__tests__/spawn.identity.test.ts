/**
 * SpawnCoordinator · 与 P2-01 身份的衔接（P2-03，N 段 74–75）：每次调用按调用方对话的记录认人
 * （callerId = 该派生 agent 的 agentId，模型配置跟着记录走）；派发出来的子 agent 从不算辅助工作。
 */
import { describe, expect, it } from 'vitest'
import type { AgentIdentity } from '../agentRecord'
import { testProfile } from './support/agentConfig'
import { answer, callTool, held, stalled } from './support/faux'
import { registerHostCleanup } from './support/host'
import { callAgent, firstChild, hostD, identityProbe, liveTasks, PROFILES } from './support/spawn'
import { withTimeout } from './support/wait'

registerHostCleanup()

describe('SpawnCoordinator · identity', () => {
  it('P2-03-74 per call: root, C and G each act as themselves; models follow the records', async () => {
    const seen: (AgentIdentity | undefined)[] = []
    const d = await hostD({
      tools: (getSession) => [identityProbe(getSession, seen, 'whoami')],
      dispatch: {
        profiles: {
          ...PROFILES,
          fallback: testProfile({
            name: 'fallback',
            displayName: 'Fallback',
            tools: ['probe'],
            model: 'spec:nope'
          })
        }
      }
    })
    d.t.kit.queue(
      callTool('whoami', {}, 'w-root'),
      callAgent('modeled', 'mid'),
      callTool('whoami', {}, 'w-c'),
      callAgent('fallback', 'leaf', { id: 'call-g' }),
      callTool('whoami', {}, 'w-g'),
      answer('leaf done'),
      answer('mid done'),
      answer('done')
    )
    expect(await d.session.submitUser('go')).toEqual({})
    const [gOutcome, cOutcome] = d.outcomes
    const [root, c, g] = seen
    expect(root).toMatchObject({ kind: 'root', profileName: 'work' })
    expect(root!.callerId).toBeUndefined()
    expect(root!.getModelConfig!()).toEqual({ provider: 'faux', model: 'faux-1', capabilities: {} })
    expect(c).toMatchObject({
      kind: 'spawned',
      profileName: 'modeled',
      callerId: cOutcome!.agentId
    })
    expect(c!.getModelConfig!()).toEqual({ provider: 'faux', model: 'faux-2', capabilities: {} })
    expect(g).toMatchObject({
      kind: 'spawned',
      profileName: 'fallback',
      callerId: gOutcome!.agentId
    })
    expect(g!.callerId).not.toBe(c!.callerId)
    // fallback 的档案模型不可用 → 回落调用方（C）的 faux-2
    expect(g!.getModelConfig!()).toEqual({ provider: 'faux', model: 'faux-2', capabilities: {} })
  })

  it('P2-03-75 a dispatch child is never auxiliary: the session is busy while it runs', async () => {
    const d = await hostD()
    const step = held(answer('found'))
    d.t.kit.queue(callAgent('explore', 'find X'), step.step, answer('done'))
    const sent = d.session.submitUser('go')
    await step.reached
    expect(d.session.runState).toBe('busy')
    // 根自己的 run 还在（在等派发工具），所以当前对话也忙
    expect(d.session.isBusy()).toBe(true)
    step.release()
    expect(await withTimeout(sent, 3000, 'root')).toEqual({})
  })

  it('P2-03-75 after a crash the session is interrupted and no child task is marked at open', async () => {
    const first = await hostD()
    const stall = stalled()
    first.t.kit.queue(callAgent('explore', 'find X'), stall.step)
    void first.session.submitUser('go')
    await stall.reached
    const C = await firstChild(first.session)
    const d = await first.reopen()
    expect(d.session.runState).toBe('interrupted')
    const live = await liveTasks(d.session, C)
    expect(live.length).toBeGreaterThan(0)
    expect(live.some((task) => task.abortRequested)).toBe(false)
  }, 15000)
})
