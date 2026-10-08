/**
 * 宿主派发 · hook agent 用完即卸（P2-08 D 段：55–62）。宿主派发的子 agent（`dispatch: 'hook'`）在那次派发 /
 * 面板追问落定之后卸掉它的 `shuvix.agent.<对话>` 扩展（spawn.ts 的 `unloadHosted`）：监控面板（「此刻装着的」）
 * 只在它干活时列它；记录、转写、身份照留，任务登记里那一行**不**被清掉（面板「任务」页照常）。工具派发的不受影响。
 *
 *  55 审查员交卷之后卸掉（转写、任务行 done）· 56 每一种收场都卸掉（模型报错 / 不交卷 / 超时 / 外部 signal /
 *  根的中止级联 / 任务页软停止）· 57 混批捕获、协调器自己中止子对话之后也卸掉 · 58 面板追问装回来、落定再卸
 *  （titler 与审查员）· 59 忙着被拒的追问不卸在跑的 hook agent · 60 两个 hook agent 同时在跑，各卸各的 ·
 *  61 工具派发的子 agent 里发起的审查只卸审查员 · 62 卸载失败只记警告、不改结果；会话关在半路不挂住、不记警告
 *
 * 断言的时机是固定的同步点，不是长 `waitFor`：没人会「过一会儿」再卸 —— 漏卸就永远列着。观察型在 `ends()`
 * 那一刻（runner 等 runTask，spawn 的 finally 已经跑过）；判定型正常交卷在 `decide` / askOp 返回那一刻；
 * 判定型超时 / 中止时 `decide` 先于协调器收尾返回，等 `runner.runningCount() === 0`（坑位留到收尾结束）。
 */
import type { ConversationId } from '@earendil-works/pi-durable'
import type { PermissionDecision } from '@shuvix/chat-protocol/types/permissionReview'
import type { TaskStatus } from '@shuvix/chat-protocol/types/task'
import { describe, expect, it, vi } from 'vitest'
import { spawnedAgentRecordOf, type SpawnedAgentRecord } from '../agentRecord'
import { backgroundContext as BG } from '../context'
import type { DurableSession } from '../durableSession'
import { agentExtensionName } from '../lock'
import type { AgentMonitorRow } from '../monitorSnapshot'
import { answer, callTool, callTools, held, modelError, stalled } from './support/faux'
import { registerHostCleanup } from './support/host'
import {
  ASKER,
  HOOK_PROFILES,
  hookRig,
  promptPayload,
  queueRoles,
  REVIEWER,
  requestsOfRole,
  type HookRig,
  type RoleScript
} from './support/hookRig'
import { extensionTools } from './support/scenario'
import { callAgent, liveTasks } from './support/spawn'
import { allEntries, transcript } from './support/transcript'
import { waitFor, withTimeout } from './support/wait'

registerHostCleanup()

const TITLER = 'titler'
const REVIEWER_NAME = 'permission-reviewer'

/** 审查员交卷：一次 `next` */
function next(decision: PermissionDecision = 'allow'): ReturnType<typeof callTool> {
  return callTool(
    'next',
    { decision, risk: 'low', summary: `${decision} it`, reason: `because ${decision}` },
    'call-next'
  )
}

/** 起一次标题（观察型 fire） */
function fireTitle(rig: HookRig): void {
  rig.runner.fire('session.prompt-accepted', promptPayload())
}

/** 某档案的 hook agent 记录（恰一个） */
function hookAgent(rig: HookRig, profileName: string): SpawnedAgentRecord {
  const found = rig.session
    .spawnedRecords()
    .filter((record) => record.dispatch === 'hook' && record.profileName === profileName)
  expect(found).toHaveLength(1)
  return found[0]!
}

/** 监控快照里这一行（没有 → undefined） */
async function rowOf(
  session: DurableSession,
  agentId: string
): Promise<AgentMonitorRow | undefined> {
  return (await session.monitorSnapshot()).find((row) => row.agentId === agentId)
}

/** 转写的条目种类（跳过 pi.system） */
async function kindsOf(session: DurableSession, id: ConversationId): Promise<string[]> {
  const conversation = (await session.harness.conversation(id, BG))!
  return (await allEntries(conversation))
    .filter((entry) => entry.kind !== 'pi.system')
    .map((entry) => entry.kind)
}

/**
 * 「卸掉了」：扩展没了、快照里没这一行；记录与身份照留、子对话上没有活任务；任务行还在（已落定，没被清掉）。
 */
async function expectUnloaded(rig: HookRig, record: SpawnedAgentRecord): Promise<void> {
  const { session } = rig
  const conv = record.conversationId
  expect(extensionTools(rig.t, agentExtensionName(conv))).toBeUndefined()
  expect((await session.monitorSnapshot()).map((row) => row.agentId)).not.toContain(record.agentId)
  expect(session.spawnedRecords().map((r) => r.agentId)).toContain(record.agentId)
  expect(session.agentIdentity(conv)?.kind).toBe('spawned')
  expect(await liveTasks(session, conv)).toEqual([])
  const task = rig.router.task(record.agentId)
  expect(task).toBeDefined()
  expect(task!.endedAt).not.toBeNull()
}

describe('P2-08 D · hook agents are unloaded once their dispatch settles', () => {
  it('P2-08-55 a reviewer capture, then unloaded: verdict:allow; transcript and record stay; the task row is done, not dismissed', async () => {
    const rig = await hookRig()
    queueRoles(rig.kit, {
      root: [callTool('askOp'), answer('root done')],
      reviewer: [next('allow')]
    })
    expect(await rig.session.submitUser('clean the build directory')).toEqual({})
    expect(rig.askCalls.at(-1)!.result).toBe('verdict:allow')
    const R = hookAgent(rig, REVIEWER_NAME)
    await expectUnloaded(rig, R)
    expect(await kindsOf(rig.session, R.conversationId)).toEqual([
      'pi.user',
      'pi.assistant',
      'pi.tool-result'
    ])
    expect(rig.router.task(R.agentId)).toMatchObject({
      kind: 'agent',
      sessionId: 's1',
      status: 'done'
    })
  })

  /** 一种收场：建 rig 并跑到同步点（断言这一行的结局）、哪个档案、任务行的终态 */
  interface Ending {
    row: string
    title: string
    profile: string
    status: TaskStatus
    run(): Promise<HookRig>
  }

  /** 根发一次 askOp（审查员按 `reviewer` 应答）：根返回 asked-human 之后等 runner 收尾 */
  const askOnce = async (rig: HookRig, reviewer: RoleScript['reviewer']): Promise<HookRig> => {
    queueRoles(rig.kit, { root: [callTool('askOp'), answer('root done')], reviewer })
    expect(await withTimeout(rig.session.submitUser('go'), 5000, 'root send')).toEqual({})
    expect(rig.askCalls.at(-1)!.result).toBe('asked-human')
    await waitFor(() => rig.runner.runningCount() === 0, 3000, 'decide drained')
    return rig
  }

  const endings: Ending[] = [
    {
      row: 'a',
      title: 'titler model error',
      profile: TITLER,
      status: 'error',
      run: async () => {
        const rig = await hookRig()
        queueRoles(rig.kit, { titler: [modelError('boom')] })
        fireTitle(rig)
        await waitFor(() => rig.ends().length === 1)
        expect(rig.ends()[0]).toMatchObject({ ok: false, error: 'boom' })
        return rig
      }
    },
    {
      row: 'b',
      title: 'reviewer model error',
      profile: REVIEWER_NAME,
      status: 'error',
      run: async () => {
        const rig = await askOnce(await hookRig(), [modelError('boom')])
        expect(rig.ends()[0]).toMatchObject({ ok: false, error: 'boom' })
        return rig
      }
    },
    {
      row: 'c',
      title: 'reviewer never hands in (prose, nudged, prose again)',
      profile: REVIEWER_NAME,
      status: 'done',
      run: async () => {
        const rig = await askOnce(await hookRig(), [answer('looks fine'), answer('still fine')])
        expect(requestsOfRole(rig.kit, 'reviewer')).toHaveLength(2)
        const R = hookAgent(rig, REVIEWER_NAME)
        const kinds = await kindsOf(rig.session, R.conversationId)
        expect(kinds.filter((kind) => kind === 'pi.user')).toHaveLength(2)
        expect(rig.ends()[0]).toMatchObject({ ok: false, error: 'no valid result' })
        return rig
      }
    },
    {
      row: 'd',
      title: 'observe timeout',
      profile: TITLER,
      status: 'killed',
      run: async () => {
        const rig = await hookRig({ timeoutMs: 50 })
        const stall = stalled()
        queueRoles(rig.kit, { titler: [stall.step] })
        fireTitle(rig)
        await stall.reached
        await waitFor(() => rig.ends().length === 1, 2000)
        expect(rig.ends()[0]).toMatchObject({ ok: false, error: 'timed out after 50ms' })
        return rig
      }
    },
    {
      row: 'e',
      title: 'decide timeout',
      profile: REVIEWER_NAME,
      status: 'killed',
      run: async () => askOnce(await hookRig({ decideTimeoutMs: 50 }), [stalled().step])
    },
    {
      row: 'f',
      title: 'outer signal',
      profile: REVIEWER_NAME,
      status: 'killed',
      run: async () => {
        const controller = new AbortController()
        const rig = await hookRig({ askSignal: () => controller.signal })
        const review = held(next('allow'))
        queueRoles(rig.kit, {
          root: [callTool('askOp'), answer('root done')],
          reviewer: [review.step]
        })
        const sent = rig.session.submitUser('go')
        await review.reached
        controller.abort()
        expect(await withTimeout(sent, 5000, 'root send')).toEqual({})
        expect(rig.askCalls.at(-1)!.result).toBe('asked-human')
        await waitFor(() => rig.runner.runningCount() === 0, 3000, 'decide drained')
        return rig
      }
    },
    {
      row: 'g',
      title: 'root abort cascades to the reviewer',
      profile: REVIEWER_NAME,
      status: 'killed',
      run: async () => {
        const rig = await hookRig()
        const review = held(next('allow'))
        queueRoles(rig.kit, { root: [callTool('askOp')], reviewer: [review.step] })
        const sent = rig.session.submitUser('go')
        await review.reached
        await withTimeout(rig.session.abort(), 5000, 'abort')
        expect(await withTimeout(sent, 5000, 'root send')).toEqual({})
        await waitFor(() => rig.askCalls.length === 1)
        expect(rig.askCalls[0]!.result).toBe('asked-human')
        await waitFor(() => rig.runner.runningCount() === 0, 3000, 'decide drained')
        return rig
      }
    },
    {
      row: 'h',
      title: 'Tasks-page stop (soft)',
      profile: TITLER,
      status: 'done',
      run: async () => {
        const rig = await hookRig()
        const gate = held(answer('never'))
        queueRoles(rig.kit, { titler: [gate.step] })
        fireTitle(rig)
        await gate.reached
        const H = hookAgent(rig, TITLER)
        await withTimeout(rig.manager.interrupt(H.agentId), 3000, 'interrupt')
        await waitFor(() => rig.ends().length === 1)
        // 软停止不算失败
        expect(rig.ends()[0]).toMatchObject({ ok: true })
        return rig
      }
    }
  ]

  it.each(endings)(
    'P2-08-56($row) every way a hosted dispatch ends leaves the agent unloaded: $title',
    async (ending) => {
      const rig = await ending.run()
      const record = hookAgent(rig, ending.profile)
      await expectUnloaded(rig, record)
      expect(rig.router.task(record.agentId)!.status).toBe(ending.status)
    }
  )

  it('P2-08-57 a mixed-batch capture: the coordinator aborts the child itself; verdict:allow, one reviewer request, unloaded', async () => {
    const rig = await hookRig({
      profiles: { ...HOOK_PROFILES, [REVIEWER_NAME]: { ...REVIEWER, tools: ['probe'] } }
    })
    queueRoles(rig.kit, {
      root: [callTool('askOp'), answer('root done')],
      reviewer: [
        callTools([
          ['next', { decision: 'allow', risk: 'low', summary: 's', reason: 'r' }, 'c1'],
          ['probe', {}, 'c2']
        ])
      ]
    })
    expect(await rig.session.submitUser('go')).toEqual({})
    expect(rig.askCalls.at(-1)!.result).toBe('verdict:allow')
    expect(requestsOfRole(rig.kit, 'reviewer')).toHaveLength(1)
    await expectUnloaded(rig, hookAgent(rig, REVIEWER_NAME))
  })

  /** 跑一次 hook（titler 经 fire、审查员经锚拥有的 decide），交回它的记录 */
  const runOnce: Record<'titler' | 'reviewer', (rig: HookRig) => Promise<SpawnedAgentRecord>> = {
    titler: async (rig) => {
      queueRoles(rig.kit, { titler: [answer('A Title')] })
      fireTitle(rig)
      await waitFor(() => rig.ends().length === 1)
      return hookAgent(rig, TITLER)
    },
    reviewer: async (rig) => {
      queueRoles(rig.kit, { reviewer: [next('allow')] })
      expect((await rig.decide())?.result.decision).toBe('allow')
      return hookAgent(rig, REVIEWER_NAME)
    }
  }

  it.each([
    { role: 'titler' as const, tool: 'titleProbe' },
    { role: 'reviewer' as const, tool: 'next' }
  ])(
    'P2-08-58($role) a panel follow-up re-installs it, lists it while it works, then unloads it again',
    async ({ role, tool }) => {
      const rig = await hookRig()
      const H = await runOnce[role](rig)
      await expectUnloaded(rig, H)
      const rebuilds = rig.t.toolHost.rebuildCalls.length

      const gate = held(answer('Better'))
      queueRoles(rig.kit, { [role]: [gate.step] })
      const p = rig.manager.continueTask({ subSessionId: H.agentId, text: 'more' })
      await gate.reached
      const installed = extensionTools(rig.t, agentExtensionName(H.conversationId))
      if (role === 'titler') expect(installed).toEqual(['titleProbe'])
      else expect(installed).toContain('next')
      expect(await rowOf(rig.session, H.agentId)).toMatchObject({ dispatch: 'hook', phase: 'turn' })
      expect(rig.router.task(H.agentId)!.status).toBe('running')

      gate.release()
      await withTimeout(p, 5000, 'continueTask')
      await expectUnloaded(rig, H)
      expect(rig.t.toolHost.rebuildCalls).toHaveLength(rebuilds + 1)
      expect(rig.t.toolHost.rebuildCalls.at(-1)).toEqual(
        await spawnedAgentRecordOf(rig.session.harness, H.conversationId, BG)
      )
      expect(
        requestsOfRole(rig.kit, role)
          .at(-1)!
          .tools.map((t) => t.name)
      ).toContain(tool)
      const conversation = (await rig.session.harness.conversation(H.conversationId, BG))!
      expect((await transcript(conversation)).slice(-2)).toEqual([
        'pi.user:more',
        'pi.assistant:Better'
      ])
      expect(rig.router.statuses(H.agentId).slice(-2)).toEqual(['running', 'done'])
      expect(rig.router.ends().at(-1)).toMatchObject({ sessionId: H.agentId, isError: false })
    }
  )

  it('P2-08-59(a) a follow-up rejected as busy while the original dispatch runs does not unload it', async () => {
    const rig = await hookRig()
    const gate = held(answer('A Title'))
    queueRoles(rig.kit, { titler: [gate.step] })
    fireTitle(rig)
    await gate.reached
    const H = hookAgent(rig, TITLER)
    const name = agentExtensionName(H.conversationId)

    const outcome = await rig.session.agents.continue(H.conversationId, 'x')
    expect(outcome.error).toMatch(/busy/)
    expect(extensionTools(rig.t, name)).toEqual(['titleProbe'])
    expect(await rowOf(rig.session, H.agentId)).toMatchObject({ phase: 'turn' })
    const kinds = await kindsOf(rig.session, H.conversationId)
    expect(kinds.filter((kind) => kind === 'pi.user')).toHaveLength(1)
    // 任务页的追问：路由层就拒了
    await expect(rig.manager.continueTask({ subSessionId: H.agentId, text: 'x' })).rejects.toThrow(
      /busy/
    )
    expect(extensionTools(rig.t, name)).toEqual(['titleProbe'])

    gate.release()
    await waitFor(() => rig.ends().length === 1)
    expect(rig.ends()[0]!.ok).toBe(true)
    await expectUnloaded(rig, H)
  })

  it('P2-08-59(b) a follow-up rejected as busy while another follow-up runs does not unload it; the running one does when it settles', async () => {
    const rig = await hookRig()
    const H = await runOnce.titler(rig)
    await expectUnloaded(rig, H)
    const name = agentExtensionName(H.conversationId)

    const gate = held(answer('one done'))
    queueRoles(rig.kit, { titler: [gate.step] })
    const first = rig.session.agents.continue(H.conversationId, 'one')
    await gate.reached
    const second = await rig.session.agents.continue(H.conversationId, 'two')
    expect(second.error).toMatch(/busy/)
    expect(extensionTools(rig.t, name)).toEqual(['titleProbe'])
    expect(await rowOf(rig.session, H.agentId)).toMatchObject({ phase: 'turn' })

    gate.release()
    const settled = await withTimeout(first, 5000, 'first follow-up')
    expect(settled).toMatchObject({ result: 'one done', conversationId: H.conversationId })
    expect('error' in settled).toBe(false)
    await expectUnloaded(rig, H)
  })

  it('P2-08-60 two hook agents at once: the reviewer is unloaded when its decide resolves while the held titler stays listed; both gone after the titler ends', async () => {
    const rig = await hookRig()
    const gate = held(answer('A Title'))
    queueRoles(rig.kit, { titler: [gate.step], reviewer: [next('allow')] })
    fireTitle(rig)
    await gate.reached
    const H = hookAgent(rig, TITLER)

    expect((await rig.decide())?.result.decision).toBe('allow')
    const R = hookAgent(rig, REVIEWER_NAME)
    await expectUnloaded(rig, R)
    expect(extensionTools(rig.t, agentExtensionName(H.conversationId))).toEqual(['titleProbe'])
    expect(await rowOf(rig.session, H.agentId)).toMatchObject({ dispatch: 'hook', phase: 'turn' })

    gate.release()
    await waitFor(() => rig.ends().length === 2)
    await expectUnloaded(rig, H)
    await expectUnloaded(rig, R)
  })

  it('P2-08-61 a review asked from a tool-dispatched child: only the reviewer is unloaded; the asker stays listed, idle', async () => {
    const rig = await hookRig({ dispatchProfiles: { asker: ASKER } })
    queueRoles(rig.kit, {
      root: [callAgent('asker', 'p'), callTool('askOp'), answer('child done'), answer('root done')],
      reviewer: [next('allow')]
    })
    expect(await rig.session.submitUser('delegate it')).toEqual({})
    expect(rig.askCalls.at(-1)!.result).toBe('verdict:allow')
    const A = rig.session.spawnedRecords().find((record) => record.profileName === 'asker')!
    const R = hookAgent(rig, REVIEWER_NAME)
    expect(R.parentConversationId).toBe(A.conversationId)
    await expectUnloaded(rig, R)
    expect(extensionTools(rig.t, agentExtensionName(A.conversationId))).toEqual(['askOp'])
    expect(await rowOf(rig.session, A.agentId)).toMatchObject({
      dispatch: 'tool',
      phase: 'idle',
      parentAgentId: 's1'
    })
  })

  it('P2-08-62(a) an uninstall that throws only logs a warning: the titler and the reviewer outcomes are unchanged; the agents stay listed', async () => {
    const rig = await hookRig()
    const registry = rig.t.registryOf('s1')!
    const uninstall = registry.uninstall.bind(registry)
    vi.spyOn(registry, 'uninstall').mockImplementation((extension) => {
      if (extension.name.startsWith('shuvix.agent.')) throw new Error('boom')
      return uninstall(extension)
    })
    queueRoles(rig.kit, {
      titler: [answer('A Title')],
      root: [callTool('askOp'), answer('root done')],
      reviewer: [next('allow')]
    })
    fireTitle(rig)
    await waitFor(() => rig.ends().length === 1)
    expect(rig.ends()[0]!.ok).toBe(true)
    expect(rig.router.ends().at(-1)).toMatchObject({ isError: false, result: 'A Title' })
    expect(await rig.session.submitUser('go')).toEqual({})
    expect(rig.askCalls.at(-1)!.result).toBe('verdict:allow')

    for (const record of [hookAgent(rig, TITLER), hookAgent(rig, REVIEWER_NAME)]) {
      const conv = record.conversationId
      expect(rig.t.warnings).toContainEqual(
        expect.stringContaining(`unloading hook agent conversation ${conv} failed: boom`)
      )
      // 收尾失败的代价：它还装着，所以还列着
      expect(extensionTools(rig.t, agentExtensionName(conv))).toBeDefined()
      expect(await rowOf(rig.session, record.agentId)).toMatchObject({ phase: 'idle' })
    }
  })

  it('P2-08-62(b) the session closed mid-run: exactly one end arrives, nothing hangs, no unload warning', async () => {
    const rig = await hookRig()
    const gate = held(answer('A Title'))
    queueRoles(rig.kit, { titler: [gate.step] })
    fireTitle(rig)
    await gate.reached
    // 关停中止那一轮生成（held 观察 signal），不必放行
    await withTimeout(rig.t.host.close('s1'), 5000, 'close')
    await waitFor(() => rig.ends().length === 1, 3000, 'the titler end')
    await waitFor(() => rig.runner.runningCount() === 0)
    expect(rig.ends()).toHaveLength(1)
    expect(rig.t.warnings.filter((line) => /unloading hook agent/.test(line))).toEqual([])
  })
})
