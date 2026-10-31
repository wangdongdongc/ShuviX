/**
 * SpawnCoordinator · 面板：软停止 / 销毁 / 追问（P2-03，H 段 42–49、76）。软停止 = 中止子对话、保留部分结果；
 * 销毁 = 硬中止 + 卸掉扩展（转写、记录、身份都留着，PIN-03）；追问 = 不带来源时没有 requestId、忙就拒绝（PIN-12），
 * 落定之后照样装着（用完即卸只管 hook agent 与一次性的工具派发，见 hosted.unload.test.ts 与本文件末段）；带来源
 * （宿主按连接盖的章，2026-10-21）的追问按一个新生成的 requestId 记进子对话的 SourceDoc（P2-03-76）。
 *
 * 一次性的工具派发（`oneShot`，知识库写手的形状）：OS-P1 落定即卸、缺省派发照样装着 · OS-P2 面板追问装回来、
 * 干活时列着、落定再卸（两次都是）· OS-P4 带结果契约时每一种收场都卸（捕获 / 追问后捕获 / 模型报错 / 软停止 / 混批）
 */
import { fauxText, fauxToolCall } from '@earendil-works/pi-ai'
import type { ConversationId, SubmissionRecord } from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import { backgroundContext as BG } from '../context'
import { spawnedAgentRecordOf } from '../agentRecord'
import { AgentStateDoc, SourceDoc } from '../docs'
import type { AgentMonitorRow } from '../monitorSnapshot'
import { freshAgentMount } from '../projection/__tests__/projectorSupport'
import {
  buildResultContractNote,
  NEXT_NUDGE_TEXT,
  type ResultContract
} from '../../subagent/nextTool'
import {
  answer,
  assistantWith,
  callTool,
  callTools,
  held,
  modelError,
  stalled
} from './support/faux'
import { registerHostCleanup } from './support/host'
import { extensionTools } from './support/scenario'
import {
  callAgent,
  dispatchTask,
  expectUnloadedTool,
  firstChild,
  hostD,
  liveTasks,
  queueRouted,
  requestsOf,
  submissionByRequest,
  tasksOf,
  TITLE_SCHEMA,
  type HostD
} from './support/spawn'
import { allEntries } from './support/transcript'
import { askingTool } from './support/tools'
import { transcript } from './support/transcript'
import { deferred, waitFor, withTimeout } from './support/wait'

registerHostCleanup()

/** 一次派发跑完（-01 的形状），返回子对话 */
async function headline(d: HostD): Promise<ConversationId> {
  d.t.kit.queue(callAgent('explore', 'find X'), answer('found'), answer('done'))
  expect(await d.session.submitUser('go')).toEqual({})
  return d.outcomes[0]!.conversationId!
}

/** 这段期间有没有提交摸到某对话的任务 */
function taskChanges(
  d: HostD,
  conversationId: ConversationId
): { count: number; stop: () => void } {
  const seen = { count: 0, stop: () => {} }
  seen.stop = d.session.harness.subscribeCommits((publication) => {
    for (const change of publication.changes) {
      if (change.type === 'task' && change.value.conversationId === conversationId) seen.count++
    }
  })
  return seen
}

async function childLines(d: HostD, C: ConversationId): Promise<string[]> {
  return transcript((await d.session.harness.conversation(C, BG))!)
}

/**
 * 缺省（非一次性）的工具派发子 agent 落定之后：扩展还装着、监控面板还列着它（闲着）—— 用完即卸只管 hook agent
 * 与一次性的工具派发
 */
async function expectStillLoaded(d: HostD, C: ConversationId): Promise<void> {
  expect(extensionTools(d.t, `shuvix.agent.${C}`)).toEqual(['probe'])
  const row = (await d.session.monitorSnapshot()).find((r) => r.conversationId === C)
  expect(row).toMatchObject({ kind: 'spawned', dispatch: 'tool', phase: 'idle' })
}

describe('SpawnCoordinator · interrupt', () => {
  it('P2-03-42 on an idle child: resolves; nothing touches its tasks', async () => {
    const d = await hostD()
    const C = await headline(d)
    const changes = taskChanges(d, C)
    await withTimeout(d.session.agents.interrupt(C), 3000, 'interrupt')
    changes.stop()
    expect(changes.count).toBe(0)
  })

  it.each([999, 1])('P2-03-42 on a non-agent id (%i): resolves without effect', async (id) => {
    const d = await hostD()
    await headline(d)
    const states = d.t.statesOf('s1').length
    await withTimeout(d.session.agents.interrupt(id), 3000, 'interrupt')
    expect(d.t.statesOf('s1')).toHaveLength(states)
    expect(d.session.runState).toBe('idle')
  })

  it('P2-03-42 on a running child: resolves only once it is idle', async () => {
    const step = stalled()
    const d = await hostD()
    d.t.kit.queue(callAgent('explore', 'find X'), step.step, answer('done'))
    const sent = d.session.submitUser('go')
    await step.reached
    const C = await firstChild(d.session)
    await withTimeout(d.session.agents.interrupt(C), 3000, 'interrupt')
    expect(await liveTasks(d.session, C)).toEqual([])
    expect(await withTimeout(sent, 3000, 'root')).toEqual({})
  })

  it('P2-03-43 interrupt cascades: C waiting on G → G aborted, C inner dispatch aborted; the outer outcome is soft', async () => {
    const step = stalled()
    const d = await hostD()
    d.t.kit.queue(
      callAgent('nester', 'mid'),
      assistantWith(
        [
          fauxText('C partial'),
          fauxToolCall(
            'agent',
            { name: 'explore', prompt: 'leaf', description: 'g' },
            { id: 'call-g' }
          )
        ],
        { stopReason: 'toolUse' }
      ),
      step.step,
      answer('done')
    )
    const sent = d.session.submitUser('go')
    await step.reached
    const C = await firstChild(d.session)
    const G = await firstChild(d.session, C)
    await withTimeout(d.session.agents.interrupt(C), 3000, 'interrupt')
    expect(await withTimeout(sent, 3000, 'root')).toEqual({})
    expect((await tasksOf(d.session, G)).at(-1)!.state).toMatchObject({
      outcome: { status: 'aborted' }
    })
    const inner = (await tasksOf(d.session, C, 'pi.tool')).at(-1)!
    expect(inner.state).toMatchObject({ status: 'terminal', outcome: { status: 'aborted' } })
    const [gOutcome, cOutcome] = d.outcomes
    expect(gOutcome!.error).toBe('aborted')
    expect(cOutcome).toMatchObject({ result: 'C partial\n\n[Note] stopReason=toolUse' })
    expect('error' in cOutcome!).toBe(false)
    expect((await transcript(await d.session.currentConversation())).at(-1)).toBe(
      'pi.assistant:done'
    )
  })
})

describe('SpawnCoordinator · destroy', () => {
  it('P2-03-44 destroy during a wait: error aborted; the extension is gone; history and identity stay', async () => {
    const step = stalled()
    const d = await hostD()
    d.t.kit.queue(callAgent('explore', 'find X'), step.step, answer('done'))
    const sent = d.session.submitUser('go')
    await step.reached
    const C = await firstChild(d.session)
    const stateBefore = await d.session.harness.snapshot(AgentStateDoc, C, BG)
    await withTimeout(d.session.agents.destroy(C), 3000, 'destroy')
    expect(await withTimeout(sent, 3000, 'root')).toEqual({})
    expect(d.outcomes[0]!.error).toBe('aborted')
    expect(extensionTools(d.t, `shuvix.agent.${C}`)).toBeUndefined()
    expect(await childLines(d, C)).toContain('pi.user:find X')
    expect(await d.session.harness.snapshot(AgentStateDoc, C, BG)).toEqual(stateBefore)
    expect(d.session.agentIdentity(C)?.kind).toBe('spawned')
    expect((await transcript(await d.session.currentConversation())).at(-1)).toBe(
      'pi.assistant:done'
    )
  })

  it('P2-03-45 destroy when idle (no abort commit), then continue rebuilds on demand', async () => {
    const d = await hostD()
    const C = await headline(d)
    const changes = taskChanges(d, C)
    await d.session.agents.destroy(C)
    changes.stop()
    expect(changes.count).toBe(0)
    expect(extensionTools(d.t, `shuvix.agent.${C}`)).toBeUndefined()
    d.t.kit.queue(answer('more ok'))
    const outcome = await withTimeout(d.session.agents.continue(C, 'more'), 3000, 'continue')
    expect(outcome).toMatchObject({ result: 'more ok', conversationId: C })
    expect(d.t.toolHost.rebuildCalls.at(-1)).toEqual(
      await spawnedAgentRecordOf(d.session.harness, C, BG)
    )
    expect(d.t.toolHost.rebuildContexts.at(-1)).toEqual({ sessionId: 's1', extraTools: [] })
    expect(d.t.kit.requests.at(-1)!.tools.map((tool) => tool.name)).toEqual(['probe'])
    await expectStillLoaded(d, C)
  })
})

describe('SpawnCoordinator · continue', () => {
  it('P2-03-46 continue after done: appends one turn, no agent: requestId; root untouched; runState busy → idle', async () => {
    const d = await hostD()
    const C = await headline(d)
    const rootBefore = await transcript(await d.session.currentConversation())
    const submissions: SubmissionRecord[] = []
    const stop = d.session.harness.subscribeCommits((publication) => {
      for (const change of publication.changes) {
        if (change.type === 'submission' && change.value.conversationId === C) {
          submissions.push(change.value)
        }
      }
    })
    const busy: boolean[] = []
    const gate = held(answer('more ok'))
    d.t.kit.queue(gate.step)
    const states = d.t.statesOf('s1').length
    const continued = d.session.agents.continue(C, 'more')
    await gate.reached
    busy.push(d.session.isBusy())
    gate.release()
    expect(await withTimeout(continued, 3000, 'continue')).toMatchObject({ result: 'more ok' })
    stop()
    expect(busy).toEqual([false])
    expect((await childLines(d, C)).slice(-2)).toEqual(['pi.user:more', 'pi.assistant:more ok'])
    expect(submissions.length).toBeGreaterThan(0)
    expect(submissions.every((record) => record.requestId === undefined)).toBe(true)
    expect(await transcript(await d.session.currentConversation())).toEqual(rootBefore)
    await waitFor(() => d.t.statesOf('s1').length >= states + 2, 3000, 'states')
    expect(d.t.statesOf('s1').slice(states)).toEqual(['busy', 'idle'])
    await expectStillLoaded(d, C)
  })

  it('P2-03-47 continue while busy: error with the busy detail; no second pi.user', async () => {
    const step = stalled()
    const d = await hostD()
    d.t.kit.queue(callAgent('explore', 'find X'), step.step, answer('done'))
    const sent = d.session.submitUser('go')
    await step.reached
    const C = await firstChild(d.session)
    const outcome = await d.session.agents.continue(C, 'more')
    expect(outcome.error).toMatch(/busy/i)
    expect((await childLines(d, C)).filter((line) => line.startsWith('pi.user:'))).toHaveLength(1)
    await d.session.abort()
    await withTimeout(sent, 3000, 'root')
  })

  it('P2-03-48 continue after an interrupt reopens inputs: the new ask is accepted and answered', async () => {
    let reopened = 0
    const asked = deferred()
    const d = await hostD({
      host: { onInputsReopened: () => void reopened++ },
      tools: (getSession) => [askingTool('ask', getSession, { onStart: () => asked.resolve() })]
    })
    d.t.kit.queue(callAgent('explore', 'find X'), callTool('ask'), answer('done'))
    const sent = d.session.submitUser('go')
    await asked.promise
    await waitFor(() => d.session.pendingInputCount === 1, 3000, 'first ask')
    const C = await firstChild(d.session)
    await withTimeout(d.session.agents.interrupt(C), 3000, 'interrupt')
    expect(await withTimeout(sent, 3000, 'root')).toEqual({})
    expect(d.session.pendingInputCount).toBe(0)
    const reopenedBefore = reopened
    d.t.kit.queue(callTool('ask', {}, 'ask-2'), answer('asked ok'))
    const continued = d.session.agents.continue(C, 'go on')
    await waitFor(() => d.session.pendingInputCount === 1, 3000, 'second ask')
    expect(d.session.respondToInput('ask-2', { kind: 'ask', allowed: true })).toBe(true)
    const outcome = await withTimeout(continued, 3000, 'continue')
    expect(outcome).toMatchObject({ result: 'asked ok' })
    expect('error' in outcome).toBe(false)
    expect(reopened).toBeGreaterThan(reopenedBefore)
  })

  it('P2-03-76 continue with an origin: exactly one item in the child’s SourceDoc under a fresh requestId that resolves to the new pi.user; the root has none; the agent view shows it on that message only', async () => {
    const LOCAL = { kind: 'local' } as const
    const d = await hostD()
    const C = await headline(d)
    const root = await d.session.currentConversation()
    expect(await d.session.harness.snapshot(SourceDoc, C, BG)).toBeUndefined()
    d.t.kit.queue(answer('more ok'))
    const outcome = await withTimeout(d.session.agents.continue(C, 'more', LOCAL), 3000, 'continue')
    expect(outcome).toMatchObject({ result: 'more ok', conversationId: C })
    expect((await childLines(d, C)).slice(-2)).toEqual(['pi.user:more', 'pi.assistant:more ok'])

    const items = (await d.session.harness.snapshot(SourceDoc, C, BG))!.items
    expect(Object.values(items)).toStrictEqual([LOCAL])
    const [key] = Object.keys(items)
    expect(key).not.toBe('')
    const conversation = (await d.session.harness.conversation(C, BG))!
    const users = (await allEntries(conversation)).filter((entry) => entry.kind === 'pi.user')
    expect((await submissionByRequest(d.session, C, key!))?.entry).toBe(users.at(-1)!.id)
    expect(await d.session.harness.snapshot(SourceDoc, root.id, BG)).toBeUndefined()

    const view = await freshAgentMount(d.session, d.session.agentIdentity(C)!.callerId!, C)
    const messages = view.messages.filter((message) => message.role === 'user')
    expect(messages.map((message) => message.content)).toEqual(['find X', 'more'])
    expect(messages.map((message) => message.metadata)).toStrictEqual([{}, { origin: LOCAL }])
    await expectStillLoaded(d, C)
  })

  it('P2-03-49 invalid continue targets: root, an ownerless plain conversation, unknown', async () => {
    const d = await hostD()
    const plain = await d.session.harness.createConversation(
      { ownership: { kind: 'ownerless' } },
      BG
    )
    const calls = d.t.kit.callCount
    for (const id of [1, plain.id, 999]) {
      const outcome = await d.session.agents.continue(id, 'x')
      expect(outcome.error).toMatch(/not a spawned agent/)
    }
    expect(d.t.kit.callCount).toBe(calls)
    expect(await transcript(plain)).toEqual([])
  })
})

/** 监控快照里某对话那一行（没有 → undefined） */
async function rowOfConversation(
  d: HostD,
  C: ConversationId
): Promise<AgentMonitorRow | undefined> {
  return (await d.session.monitorSnapshot()).find((row) => row.conversationId === C)
}

/** 一次性派发 A 跑完（子 agent 答 found、根答 done），交回子对话与 agentId */
async function oneShotHeadline(d: HostD): Promise<{ C: ConversationId; agentId: string }> {
  d.t.kit.queue(callAgent('explore', 'find X', { oneShot: true }), answer('found'), answer('done'))
  expect(await d.session.submitUser('go')).toEqual({})
  const outcome = d.outcomes.at(-1)!
  return { C: outcome.conversationId!, agentId: outcome.agentId! }
}

describe('SpawnCoordinator · one-shot tool dispatch', () => {
  it('OS-P1 listed while it works, unloaded once it settles; a default dispatch beside it stays loaded', async () => {
    const d = await hostD()
    const gate = held(answer('found'))
    d.t.kit.queue(callAgent('explore', 'find X', { oneShot: true }), gate.step, answer('done'))
    const sent = d.session.submitUser('go')
    await gate.reached
    const A = await firstChild(d.session)
    expect(extensionTools(d.t, `shuvix.agent.${A}`)).toEqual(['probe'])
    expect(await rowOfConversation(d, A)).toMatchObject({
      kind: 'spawned',
      dispatch: 'tool',
      phase: 'turn'
    })
    gate.release()
    expect(await withTimeout(sent, 3000, 'root')).toEqual({})
    const agentId = d.outcomes[0]!.agentId!

    d.t.kit.queue(
      callAgent('explore', 'find Y', { id: 'call-b' }),
      answer('found Y'),
      answer('done B')
    )
    expect(await d.session.submitUser('go B')).toEqual({})
    const B = d.outcomes[1]!.conversationId!
    expect(B).not.toBe(A)

    await expectUnloadedTool(d, A, agentId, ['pi.user:find X', 'pi.assistant:found'])
    expect(d.outcomes[0]).toEqual({ result: 'found', conversationId: A, agentId })
    await expectStillLoaded(d, B)
  })

  it('OS-P2 a panel follow-up re-installs it from the record, lists it while it works, then unloads it again — every time', async () => {
    const d = await hostD()
    const { C, agentId } = await oneShotHeadline(d)
    await expectUnloadedTool(d, C, agentId)
    const rebuilds = d.t.toolHost.rebuildCalls.length

    const gate = held(answer('more ok'))
    d.t.kit.queue(gate.step)
    const continued = d.session.agents.continue(C, 'more')
    await gate.reached
    expect(extensionTools(d.t, `shuvix.agent.${C}`)).toEqual(['probe'])
    expect(await rowOfConversation(d, C)).toMatchObject({ dispatch: 'tool', phase: 'turn' })
    expect(d.t.toolHost.rebuildCalls).toHaveLength(rebuilds + 1)
    const stored = await spawnedAgentRecordOf(d.session.harness, C, BG)
    expect(stored?.oneShot).toBe(true)
    expect(d.t.toolHost.rebuildCalls.at(-1)).toEqual(stored)
    gate.release()
    const outcome = await withTimeout(continued, 3000, 'continue')
    expect(outcome).toMatchObject({ result: 'more ok', conversationId: C, agentId })
    expect('error' in outcome).toBe(false)
    expect((await childLines(d, C)).slice(-2)).toEqual(['pi.user:more', 'pi.assistant:more ok'])
    await expectUnloadedTool(d, C, agentId, ['pi.user:more', 'pi.assistant:more ok'])

    d.t.kit.queue(answer('again ok'))
    const again = await withTimeout(d.session.agents.continue(C, 'again'), 3000, 'continue 2')
    expect(again).toMatchObject({ result: 'again ok', conversationId: C })
    expect(d.t.toolHost.rebuildCalls).toHaveLength(rebuilds + 2)
    await expectUnloadedTool(d, C, agentId, ['pi.user:again', 'pi.assistant:again ok'])
  })

  /** 带结果契约的一次性派发（knowledge 工具派写手的形状）：每一种收场都卸 */
  const CONTRACT: ResultContract = { schema: structuredClone(TITLE_SCHEMA) }
  const CHILD_PROMPT = `p\n\n${buildResultContractNote(CONTRACT)}`

  interface ContractEnding {
    row: string
    title: string
    /** 子对话转写里还得在的那几行 */
    kept: string[]
    /** 跑到根落定，交回子对话 */
    run(d: HostD): Promise<ConversationId>
    check(d: HostD, C: ConversationId): Promise<void>
  }

  const contractEndings: ContractEnding[] = [
    {
      row: 'a',
      title: 'next captured',
      kept: [`pi.user:${CHILD_PROMPT}`, 'pi.assistant:[tool:next]'],
      run: async (d) => {
        d.t.kit.queue(callAgent('explore', 'p'), callTool('next', { title: 'A' }), answer('done'))
        expect(await d.session.submitUser('go')).toEqual({})
        return d.outcomes[0]!.conversationId!
      },
      check: async (d) => {
        expect(d.outcomes[0]!.structured).toEqual({ title: 'A' })
        expect('error' in d.outcomes[0]!).toBe(false)
      }
    },
    {
      row: 'b',
      title: 'prose, nudged, then next',
      kept: [
        `pi.user:${CHILD_PROMPT}`,
        'pi.assistant:prose',
        `pi.user:${NEXT_NUDGE_TEXT}`,
        'pi.assistant:[tool:next]'
      ],
      run: async (d) => {
        d.t.kit.queue(
          callAgent('explore', 'p'),
          answer('prose'),
          callTool('next', { title: 'B' }),
          answer('done')
        )
        expect(await d.session.submitUser('go')).toEqual({})
        return d.outcomes[0]!.conversationId!
      },
      check: async (d, C) => {
        expect(d.outcomes[0]!.structured).toEqual({ title: 'B' })
        const task = await dispatchTask(d.session)
        expect(await submissionByRequest(d.session, C, `agent:${task}:nudge:1`)).toBeDefined()
      }
    },
    {
      row: 'c',
      title: 'model error',
      kept: [`pi.user:${CHILD_PROMPT}`, 'pi.assistant:'],
      run: async (d) => {
        d.t.kit.queue(callAgent('explore', 'p'), modelError('boom'), answer('done'))
        expect(await d.session.submitUser('go')).toEqual({})
        return d.outcomes[0]!.conversationId!
      },
      check: async (d) => {
        expect(d.outcomes[0]!.error).toBe('boom')
      }
    },
    {
      row: 'd',
      title: 'panel interrupt while held (soft)',
      // 被扣住的那一轮没有落下回答
      kept: [`pi.user:${CHILD_PROMPT}`],
      run: async (d) => {
        const gate = held(answer('never'))
        d.t.kit.queue(callAgent('explore', 'p'), gate.step, answer('done'))
        const sent = d.session.submitUser('go')
        await gate.reached
        const C = await firstChild(d.session)
        await withTimeout(d.session.agents.interrupt(C), 3000, 'interrupt')
        expect(await withTimeout(sent, 3000, 'root')).toEqual({})
        return C
      },
      check: async (d) => {
        expect('error' in d.outcomes[0]!).toBe(false)
        expect('structured' in d.outcomes[0]!).toBe(false)
      }
    },
    {
      row: 'e',
      title: 'mixed batch [next, probe]',
      kept: [`pi.user:${CHILD_PROMPT}`, 'pi.assistant:[tool:next][tool:probe]'],
      run: async (d) => {
        queueRouted(d.t.kit, {
          go: [callAgent('explore', 'p'), answer('done')],
          [CHILD_PROMPT]: [
            callTools([
              ['next', { title: 'E' }, 'c1'],
              ['probe', {}, 'c2']
            ]),
            modelError('should not be asked')
          ]
        })
        expect(await withTimeout(d.session.submitUser('go'), 3000, 'root')).toEqual({})
        return d.outcomes[0]!.conversationId!
      },
      check: async (d) => {
        expect(d.outcomes[0]!.structured).toEqual({ title: 'E' })
        expect('error' in d.outcomes[0]!).toBe(false)
        expect(requestsOf(d.t.kit, 'explorer')).toHaveLength(1)
      }
    }
  ]

  it.each(contractEndings)(
    'OS-P4($row) a one-shot dispatch with a result contract is unloaded however it ends: $title',
    async (ending) => {
      const d = await hostD({ dispatch: { contract: CONTRACT, oneShot: true } })
      const C = await ending.run(d)
      await ending.check(d, C)
      await expectUnloadedTool(d, C, d.outcomes[0]!.agentId!, ending.kept)
    }
  )
})
