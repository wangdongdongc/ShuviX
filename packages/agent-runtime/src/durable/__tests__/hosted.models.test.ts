/**
 * 宿主派发 · hook 的模型（P2-08 D 段，36–42；PIN-06，Q-P2-18）：生产的锁优先解析（`resolveHookRunModel`）+
 * 协调器。锁定了 = 锁的模型原样（之后改选择、停用 provider 都不动它，Q9）；没锁 = 会话选择经
 * `resolveLockModel` 译成 pi provider id —— 没有选择跳过 `no-model`，被拒是一次失败的 run（start → end
 * ok:false，error 即那句拒绝的话，`failed:`），都不派发、什么都不建。档案的 `shuvix-model` / `shuvix-thinking`
 * 优先；思考档位的基准在锁定时是根对话此刻的档位。
 */
import type { ConversationId } from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import { builtinRow, fakePort } from '../../models/__tests__/fakePort'
import { resolveLockModel } from '../../models/lockModel'
import { spawnedAgentRecordOf } from '../agentRecord'
import { backgroundContext as BG } from '../context'
import type { DurableSession } from '../durableSession'
import { fauxCatalog, testProfile } from './support/agentConfig'
import { answer, callTool } from './support/faux'
import { registerHostCleanup } from './support/host'
import {
  anchors,
  HOOK_PROFILES,
  hookRig,
  promptPayload,
  queueRoles,
  requestsOfRole,
  reviewerOf,
  rigConfig,
  TITLER
} from './support/hookRig'
import { liveTasks } from './support/spawn'
import { waitFor } from './support/wait'

registerHostCleanup()

function nextAllow(): ReturnType<typeof callTool> {
  return callTool(
    'next',
    { decision: 'allow', risk: 'low', summary: 'ok', reason: 'fine' },
    'call-next'
  )
}

/** 所有 hook 派出的对话（锚拥有的 + 给定任务拥有的） */
async function hookConversations(session: DurableSession): Promise<ConversationId[]> {
  const found: ConversationId[] = []
  for (const anchor of await anchors(session)) found.push(...(await reviewerOf(session, anchor.id)))
  return found
}

async function conversationCount(session: DurableSession): Promise<number> {
  return session.harness.commit(
    async (tx) => (await tx.scanConversations({}, 256)).items.length,
    BG
  )
}

describe('P2-08 D · hook models (PIN-06)', () => {
  it('P2-08-36 locked: the lock model wins over a later selection change — titler and reviewer use faux-1, records hold it', async () => {
    const config = rigConfig()
    const rig = await hookRig({ config })
    config.model = { provider: 'faux', modelId: 'faux-2' }
    queueRoles(rig.kit, { titler: [answer('Hooked title')], reviewer: [nextAllow()] })
    rig.runner.fire('session.prompt-accepted', promptPayload())
    expect(await rig.decide()).not.toBeNull()
    await waitFor(() => rig.ends().length === 2)
    expect(requestsOfRole(rig.kit, 'titler').map((r) => r.modelId)).toEqual(['faux-1'])
    expect(requestsOfRole(rig.kit, 'reviewer').map((r) => r.modelId)).toEqual(['faux-1'])
    for (const id of await hookConversations(rig.session)) {
      expect((await spawnedAgentRecordOf(rig.session.harness, id, BG))?.model).toEqual({
        provider: 'faux',
        modelId: 'faux-1'
      })
    }
  })

  it('P2-08-37 unlocked: the selection goes through resolveLockModel — row id → pi provider id; the request uses faux-2', async () => {
    // 内置行的 id 不是 pi provider id（`row-faux` → `faux`）：记录里存的是翻译过的那个
    const port = fakePort([builtinRow('faux', { id: 'row-faux' })])
    const rig = await hookRig({
      noPrime: true,
      host: { port },
      selection: () => ({ model: { provider: 'row-faux', modelId: 'faux-2' } })
    })
    expect(rig.session.lock).toBeUndefined()
    queueRoles(rig.kit, { titler: [answer('Hooked title')] })
    rig.runner.fire('session.prompt-accepted', promptPayload())
    await waitFor(() => rig.ends().length === 1)
    expect(rig.ends()[0]!.ok).toBe(true)
    const [T] = await hookConversations(rig.session)
    expect((await spawnedAgentRecordOf(rig.session.harness, T!, BG))?.model).toEqual({
      provider: 'faux',
      modelId: 'faux-2'
    })
    expect(requestsOfRole(rig.kit, 'titler').map((r) => r.modelId)).toEqual(['faux-2'])
  })

  it('P2-08-38 no model → skip no-model: no start, nothing committed; decide null', async () => {
    const rig = await hookRig({ noPrime: true, selection: () => ({ model: null }) })
    const before = await conversationCount(rig.session)
    rig.runner.fire('session.prompt-accepted', promptPayload())
    expect(await rig.decide()).toBeNull()
    await waitFor(() => rig.skips().length === 2)
    expect(rig.skips().map((skip) => [skip.hook, skip.reason])).toEqual([
      ['auto-title', 'no-model'],
      ['auto-review', 'no-model']
    ])
    expect(rig.starts()).toEqual([])
    expect(await conversationCount(rig.session)).toBe(before)
    expect(await anchors(rig.session)).toEqual([])
    expect(rig.kit.callCount).toBe(0)
  })

  it.each([
    ['provider_disabled', () => fakePort([builtinRow('faux', { isEnabled: false })]), 'faux-1'],
    ['provider_unknown', () => fakePort([builtinRow('other')]), 'faux-1'],
    ['model_unknown', () => fakePort([builtinRow('faux')]), 'nope']
  ] as const)(
    'P2-08-39 refusal (%s, unlocked) → a failed run: start, end ok:false with the exact resolveLockModel text, failed: warning; nothing dispatched or committed; decide null',
    async (kind, makePort, modelId) => {
      const port = makePort()
      const rig = await hookRig({
        noPrime: true,
        host: { port },
        selection: () => ({ model: { provider: 'faux', modelId } })
      })
      const expected = resolveLockModel(fauxCatalog(rig.kit, port).registry, port, {
        provider: 'faux',
        modelId
      })
      expect(expected.ok === false && expected.kind).toBe(kind)
      const message = expected.ok ? '' : expected.message
      const before = await conversationCount(rig.session)
      rig.runner.fire('session.prompt-accepted', promptPayload())
      expect(await rig.decide()).toBeNull()
      await waitFor(() => rig.ends().length === 2)
      expect(rig.starts()).toHaveLength(2)
      expect(rig.ends().map((end) => [end.run.hook, end.ok, end.error])).toEqual(
        expect.arrayContaining([
          ['auto-title', false, message],
          ['auto-review', false, message]
        ])
      )
      expect(
        rig.warns().filter((line) => line.includes(`failed: ${message}`) && /run=hkr-/.test(line))
      ).toHaveLength(2)
      expect(rig.router.events).toEqual([])
      expect(await conversationCount(rig.session)).toBe(before)
      expect(rig.kit.callCount).toBe(0)
    }
  )

  it('P2-08-40 locked, provider disabled later: the lock model is used as-is (Q9) and the run succeeds', async () => {
    const rig = await hookRig()
    rig.t.port.rows[0]!.isEnabled = false
    queueRoles(rig.kit, { titler: [answer('Hooked title')] })
    rig.runner.fire('session.prompt-accepted', promptPayload())
    await waitFor(() => rig.ends().length === 1)
    expect(rig.ends()[0]!.ok).toBe(true)
    expect(requestsOfRole(rig.kit, 'titler').map((r) => r.modelId)).toEqual(['faux-1'])
  })

  it("P2-08-41 shuvix-model override: 'spec:faux-2' → fakeRPM once, record and request use faux-2; 'spec:nope' → the lock model, one warning naming the titler and the spec", async () => {
    const profiles = { ...HOOK_PROFILES, titler: { ...TITLER, model: 'spec:faux-2' } }
    const rig = await hookRig({ profiles })
    queueRoles(rig.kit, { titler: [answer('one')] })
    rig.runner.fire('session.prompt-accepted', promptPayload())
    await waitFor(() => rig.ends().length === 1)
    expect(rig.rpm.calls).toEqual(['spec:faux-2'])
    const [T1] = await hookConversations(rig.session)
    expect((await spawnedAgentRecordOf(rig.session.harness, T1!, BG))?.model.modelId).toBe('faux-2')
    expect(requestsOfRole(rig.kit, 'titler').map((r) => r.modelId)).toEqual(['faux-2'])

    profiles.titler = { ...TITLER, model: 'spec:nope' }
    queueRoles(rig.kit, { titler: [answer('two')] })
    rig.runner.fire('session.prompt-accepted', promptPayload())
    await waitFor(() => rig.ends().length === 2)
    expect(rig.ends()[1]!.ok).toBe(true)
    expect(requestsOfRole(rig.kit, 'titler').map((r) => r.modelId)).toEqual(['faux-2', 'faux-1'])
    const warnings = rig.t.warnings.filter((w) => w.includes('spec:nope'))
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('"titler"')
  })

  it('P2-08-42 thinking: titler (off) → no reasoning; reviewer (low) → low; a profile without shuvix-thinking follows the live root level (high over a low lock)', async () => {
    const plain = testProfile({ name: 'plain', displayName: 'Plain', tools: [] })
    const rig = await hookRig({
      profiles: { ...HOOK_PROFILES, plain },
      hooks: [
        {
          name: 'auto-title',
          displayName: 'Titles',
          description: '',
          agent: 'titler',
          bindings: [{ trigger: 'session.prompt-accepted' }],
          prompt: 'Title it.'
        },
        {
          name: 'auto-review',
          displayName: 'Review',
          description: '',
          agent: 'permission-reviewer',
          bindings: [{ trigger: 'permission.request' }],
          prompt: 'Judge it.'
        }
      ]
    })
    queueRoles(rig.kit, { titler: [answer('Hooked title')], reviewer: [nextAllow()] })
    rig.runner.fire('session.prompt-accepted', promptPayload())
    expect(await rig.decide()).not.toBeNull()
    await waitFor(() => rig.ends().length === 2)
    expect(requestsOfRole(rig.kit, 'titler')[0]!.options?.reasoning).toBeUndefined()
    expect(requestsOfRole(rig.kit, 'reviewer')[0]!.options?.reasoning).toBe('low')

    // 没声明思考档位的档案：跟着根对话此刻的档位走
    await rig.session.setThinkingLevel('high')
    expect(rig.session.lock?.thinkingLevel).toBe('low')
    rig.profiles['permission-reviewer'] = plain
    queueRoles(rig.kit, { reviewer: [nextAllow()] })
    expect(await rig.decide()).not.toBeNull()
    const last = requestsOfRole(rig.kit, 'reviewer').at(-1)!
    expect(last.options?.reasoning).toBe('high')
    await waitFor(async () => (await liveTasks(rig.session)).length === 0)
  })
})
