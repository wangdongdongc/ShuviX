/**
 * SpawnCoordinator · 创建提交与发布（P2-03，A 段 01–11 + onCreated）：一个提交里建子对话、配好
 * `pi.agent`、冻结人设、写记录；之后装扩展、发布 details、提交任务；提交之前失败什么都不留。
 */
import {
  AgentDoc,
  ROOT_CONVERSATION_ID,
  type ConversationId,
  type ToolExecutionApi
} from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import { backgroundContext as BG } from '../context'
import { parseSpawnedAgentRecord, spawnedAgentRecordOf } from '../agentRecord'
import { AgentStateDoc } from '../docs'
import { PROMPT_EXTENSION } from '../prompt/sections'
import type { SpawnCreatedInfo } from '../spawn'
import { testProfile } from './support/agentConfig'
import { summarize } from './support/commits'
import { answer, callTools } from './support/faux'
import { registerHostCleanup } from './support/host'
import { extensionTools, piAgent, W_NOW } from './support/scenario'
import {
  callAgent,
  childOf,
  configD,
  conversationIds,
  dispatchTask,
  hostD,
  PROFILES,
  queueRouted,
  requestsOf
} from './support/spawn'
import { allEntries, transcript } from './support/transcript'
import { withTimeout } from './support/wait'

registerHostCleanup()

const extensionsOf = (child: ConversationId): string[] => [
  'shuvix.builtin',
  PROMPT_EXTENSION.persona,
  `shuvix.agent.${child}`
]

describe('SpawnCoordinator · creation', () => {
  it('P2-03-01 headline: dispatch → child answers → root answers', async () => {
    const d = await hostD()
    d.t.kit.queue(callAgent('explore', 'find X'), answer('found'), answer('done'))
    expect(await withTimeout(d.session.submitUser('go'))).toEqual({})
    const task = await dispatchTask(d.session)
    const outcome = d.outcomes[0]!
    const C = outcome.conversationId!
    expect(outcome).toMatchObject({ result: 'found', conversationId: C })
    expect(C).not.toBe(ROOT_CONVERSATION_ID)
    expect(outcome.agentId).toMatch(/^sub-[0-9a-f-]{36}$/)
    expect('error' in outcome).toBe(false)
    expect(await childOf(d.session, task)).toEqual([C])
    const owner = await d.session.harness.commit((tx) => tx.conversation(C), BG)
    expect(owner?.owner).toEqual({ conversationId: ROOT_CONVERSATION_ID, taskId: task })
    const child = (await d.session.harness.conversation(C, BG))!
    expect(await transcript(child)).toEqual(['pi.user:find X', 'pi.assistant:found'])
    const root = await d.session.currentConversation()
    const lines = await transcript(root)
    expect(lines).toContain('pi.tool-result:found')
    expect(lines.at(-1)).toBe('pi.assistant:done')
    expect(d.t.kit.callCount).toBe(3)
  })

  it('P2-03-02 one commit: conversation + pi.agent + AgentStateDoc together; identity is spawned inside the listener', async () => {
    const d = await hostD()
    const publications: ReturnType<typeof summarize>[] = []
    const raw: { conversation: boolean; docs: string[]; state?: unknown }[] = []
    const kinds: (string | undefined)[] = []
    let C: ConversationId | undefined
    const stop = d.session.harness.subscribeCommits((publication) => {
      publications.push(summarize(publication))
      let conversation = false
      let state: unknown
      let created: ConversationId | undefined
      for (const change of publication.changes) {
        if (change.type === 'conversation' && change.value.owner !== undefined) {
          conversation = true
          created = change.value.id
          C = created
        }
      }
      for (const change of publication.changes) {
        if (
          change.type === 'document' &&
          change.conversationId === C &&
          change.record.kind === AgentStateDoc.definition.kind
        ) {
          state = change.value
        }
      }
      raw.push({ conversation, docs: summarize(publication).docs, state })
      if (created !== undefined) kinds.push(d.session.agentIdentity(created)?.kind)
    })
    d.t.kit.queue(callAgent('explore', 'find X'), answer('found'), answer('done'))
    expect(await d.session.submitUser('go')).toEqual({})
    stop()
    const creating = raw.filter((entry) => entry.conversation)
    expect(creating).toHaveLength(1)
    expect(creating[0]!.docs).toContain(`pi.agent#${C}`)
    expect(creating[0]!.docs).toContain(`shuvix.agent-state#${C}`)
    const state = creating[0]!.state as Record<string, unknown>
    expect(parseSpawnedAgentRecord(state)).toBeDefined()
    expect(state).toMatchObject({ persona: 'You are M1 explorer', rootSessionId: 's1' })
    expect(kinds).toEqual(['spawned'])
    // 之后没有发布再写子对话的记录键
    const later = raw.slice(raw.indexOf(creating[0]!) + 1).filter((entry) => entry.state)
    for (const entry of later) {
      expect(parseSpawnedAgentRecord(entry.state)).toEqual(parseSpawnedAgentRecord(state))
    }
    expect(d.t.warnings).toEqual([])
    expect(publications.length).toBeGreaterThan(0)
  })

  it('P2-03-03 pi.agent is fully configured (fact 1): model, thinking, explicit extensions and tools, no instructions / cwd', async () => {
    const d = await hostD({ config: configD({ cwd: '/work/acme' }) })
    const rootBefore = await piAgent(d.session)
    d.t.kit.queue(callAgent('explore', 'find X'), answer('found'), answer('done'))
    expect(await d.session.submitUser('go')).toEqual({})
    const C = d.outcomes[0]!.conversationId!
    const agent = (await d.session.harness.snapshot(AgentDoc, C, BG)) as Record<string, unknown>
    expect(agent).toEqual({
      model: { provider: 'faux', modelId: 'faux-1' },
      thinkingLevel: 'low',
      extensions: extensionsOf(C),
      tools: ['probe']
    })
    expect((rootBefore as { extensions: string[] }).extensions.at(-1)).toBe('shuvix.agent.1')
    expect((rootBefore as { cwd?: string }).cwd).toBe('/work/acme')
    expect(await piAgent(d.session)).toEqual(rootBefore)
  })

  it('P2-03-03 a spawned profile named bot gets no bot section', async () => {
    const d = await hostD({
      dispatch: {
        profiles: { bot: testProfile({ name: 'bot', displayName: 'Bot', tools: ['probe'] }) }
      }
    })
    d.t.kit.queue(callAgent('bot', 'hi'), answer('ok'), answer('done'))
    expect(await d.session.submitUser('go')).toEqual({})
    const C = d.outcomes[0]!.conversationId!
    const agent = (await d.session.harness.snapshot(AgentDoc, C, BG)) as { extensions: string[] }
    expect(agent.extensions).not.toContain(PROMPT_EXTENSION.bot)
  })

  it('P2-03-04 the record: lock fields + spawn fields; sandboxed = the root lock pin; no hook / contract keys', async () => {
    const d = await hostD()
    d.t.toolHost.sandbox = true // 解析报的钉子与根锁不同：记录取根锁的（P2-04 PIN-02）
    d.t.kit.queue(callAgent('explore', 'find X'), answer('found'), answer('done'))
    expect(await d.session.submitUser('go')).toEqual({})
    const C = d.outcomes[0]!.conversationId!
    const task = await dispatchTask(d.session)
    const record = await spawnedAgentRecordOf(d.session.harness, C, BG)
    expect(record).toEqual({
      conversationId: C,
      profileName: 'explore',
      kind: 'spawned',
      model: { provider: 'faux', modelId: 'faux-1' },
      thinkingLevel: 'low',
      toolNames: ['probe'],
      extensions: extensionsOf(C),
      sandboxed: d.session.lock!.sandboxed,
      mcp: {},
      skills: [],
      createdAt: W_NOW,
      agentId: d.outcomes[0]!.agentId,
      depth: 1,
      canSpawn: true,
      dispatch: 'tool',
      parentConversationId: ROOT_CONVERSATION_ID,
      ownerTaskId: task,
      ownerCallId: 'call-agent',
      displayName: 'Explorer',
      description: 'look'
    })
    expect(d.session.lock!.sandboxed).toBe(false)
    const state = (await d.session.harness.snapshot(AgentStateDoc, C, BG)) as Record<
      string,
      unknown
    >
    expect('hook' in state).toBe(false)
    expect('resultContract' in state).toBe(false)
  })

  it('P2-03-05 the resolve request: spawned, agentId, canSpawn, names, model, thinking, cwd ""', async () => {
    const d = await hostD()
    const builtinBefore = d.t.registryOf('s1')!.snapshot().extension('shuvix.builtin')
    const builtinCalls = d.t.toolHost.builtinCalls.length
    const signals: boolean[] = []
    d.t.toolHost.beforeResolve = (signal) => void signals.push(signal.aborted)
    d.t.kit.queue(callAgent('explore', 'find X'), answer('found'), answer('done'))
    expect(await d.session.submitUser('go')).toEqual({})
    const agentId = d.outcomes[0]!.agentId!
    const request = d.t.toolHost.resolveCalls.at(-1)!
    expect(request).toEqual({
      sessionId: 's1',
      kind: 'spawned',
      rootSessionId: 's1',
      selfSessionId: agentId,
      agentId,
      canSpawn: true,
      profile: PROFILES.explore,
      names: ['probe'],
      model: { provider: 'faux', modelId: 'faux-1' },
      thinkingLevel: 'low',
      cwd: ''
    })
    expect('conversationId' in request).toBe(false)
    expect('extraTools' in request).toBe(false)
    expect(signals).toEqual([false])
    expect(d.t.toolHost.builtinCalls).toHaveLength(builtinCalls)
    expect(d.t.registryOf('s1')!.snapshot().extension('shuvix.builtin')).toBe(builtinBefore)
  })

  it('P2-03-06 install, then submit: the child request offers exactly the profile tools on faux-1', async () => {
    const d = await hostD()
    const rootExtension = d.t.registryOf('s1')!.snapshot().extension('shuvix.agent.1')
    d.t.kit.queue(callAgent('explore', 'find X'), answer('found'), answer('done'))
    expect(await d.session.submitUser('go')).toEqual({})
    const C = d.outcomes[0]!.conversationId!
    expect(extensionTools(d.t, `shuvix.agent.${C}`)).toEqual(['probe'])
    const child = d.t.kit.requests[1]!
    expect(child.tools.map((tool) => tool.name)).toEqual(['probe'])
    expect(child.modelId).toBe('faux-1')
    expect(d.t.registryOf('s1')!.snapshot().extension('shuvix.agent.1')).toBe(rootExtension)
  })

  it('P2-03-07 details seam: the root tool-result carries {conversationId, agentId}', async () => {
    const d = await hostD()
    d.t.kit.queue(callAgent('explore', 'find X'), answer('found'), answer('done'))
    expect(await d.session.submitUser('go')).toEqual({})
    const C = d.outcomes[0]!.conversationId!
    const entries = await allEntries(await d.session.currentConversation())
    const result = entries.find((entry) => entry.kind === 'pi.tool-result')!
    expect((result.model![0] as { details?: unknown }).details).toEqual({
      conversationId: C,
      agentId: d.outcomes[0]!.agentId
    })
  })

  it('P2-03-08 agentId memo = record.agentId = outcome.agentId; a later dispatch gets a new id and conversation', async () => {
    // 任务终态后 memo 不再保留：在派发工具返回之前读
    const memos: unknown[] = []
    let api: ToolExecutionApi | undefined
    const d = await hostD({
      dispatch: {
        wrapApi: (given) => (api = given),
        afterSpawn: async () => void memos.push(await api!.memo('agentId', BG))
      }
    })
    d.t.kit.queue(
      callAgent('explore', 'find X'),
      answer('found'),
      callAgent('explore', 'find Y', { id: 'call-agent-2' }),
      answer('found Y'),
      answer('done')
    )
    expect(await d.session.submitUser('go')).toEqual({})
    const C = d.outcomes[0]!.conversationId!
    const record = await spawnedAgentRecordOf(d.session.harness, C, BG)
    expect(memos[0]).toBe(record!.agentId)
    expect(record!.agentId).toBe(d.outcomes[0]!.agentId)
    expect(memos[1]).toBe(d.outcomes[1]!.agentId)
    expect(d.outcomes[1]!.agentId).not.toBe(d.outcomes[0]!.agentId)
    expect(d.outcomes[1]!.conversationId).not.toBe(C)
  })

  it('P2-03-09 two dispatches in one round: two children, each owned by its own tool task', async () => {
    const d = await hostD()
    queueRouted(d.t.kit, {
      go: [
        callTools([
          ['agent', { name: 'explore', prompt: 'find A', description: 'a' }, 'call-a'],
          ['agent', { name: 'explore', prompt: 'find B', description: 'b' }, 'call-b']
        ]),
        answer('done')
      ],
      'find A': [answer('answer A')],
      'find B': [answer('answer B')]
    })
    expect(await d.session.submitUser('go')).toEqual({})
    const taskA = await dispatchTask(d.session, 'call-a')
    const taskB = await dispatchTask(d.session, 'call-b')
    const [childA] = await childOf(d.session, taskA)
    const [childB] = await childOf(d.session, taskB)
    expect(childA).toBeDefined()
    expect(childB).toBeDefined()
    expect(childA).not.toBe(childB)
    const ids = new Set(d.outcomes.map((outcome) => outcome.agentId))
    expect(ids.size).toBe(2)
    const lines = await transcript(await d.session.currentConversation())
    expect(lines).toContain('pi.tool-result:answer A')
    expect(lines).toContain('pi.tool-result:answer B')
    expect(lines.filter((line) => line.startsWith('pi.assistant:done'))).toHaveLength(1)
    expect(requestsOf(d.t.kit, 'explorer')).toHaveLength(2)
  })

  it.each([
    ['resolve', 'boom'],
    ['vars', 'vars']
  ])('P2-03-10 a pre-commit failure (%s) leaves nothing', async (row, text) => {
    const d = await hostD()
    if (row === 'resolve') d.t.toolHost.failResolve = new Error('boom')
    else d.vars.state.fail = 'vars'
    d.t.kit.queue(callAgent('explore', 'find X'), answer('done'))
    expect(await d.session.submitUser('go')).toEqual({})
    expect(d.outcomes[0]!.error).toContain(text)
    expect(await childOf(d.session, await dispatchTask(d.session))).toEqual([])
    expect(await conversationIds(d.session)).toEqual([ROOT_CONVERSATION_ID])
    const agents = d.t
      .registryOf('s1')!
      .snapshot()
      .installed()
      .map((extension) => extension.name)
      .filter((name) => name.startsWith('shuvix.agent.'))
    expect(agents).toEqual(['shuvix.agent.1'])
    expect((await transcript(await d.session.currentConversation())).at(-1)).toBe(
      'pi.assistant:done'
    )
  })

  it('P2-03-11 the commit is atomic: a non-JSON contract fails the whole commit after resolve', async () => {
    const d = await hostD({
      dispatch: {
        contract: { schema: { type: 'object', properties: { x: { default: 10n } } } }
      }
    })
    d.t.kit.queue(callAgent('explore', 'find X'), answer('done'))
    expect(await d.session.submitUser('go')).toEqual({})
    expect(d.outcomes[0]!.error).toBeDefined()
    expect(await conversationIds(d.session)).toEqual([ROOT_CONVERSATION_ID])
    const agents = d.t
      .registryOf('s1')!
      .snapshot()
      .installed()
      .filter((extension) => extension.name.startsWith('shuvix.agent.'))
    expect(agents.map((extension) => extension.name)).toEqual(['shuvix.agent.1'])
    expect(d.t.toolHost.resolveCalls.filter((call) => call.kind === 'spawned')).toHaveLength(1)
  })
})

describe('SpawnCoordinator · onCreated (P2-05 PIN-02)', () => {
  it('P2-03-OC1 fires once after the commit and install, before the child first request', async () => {
    const seen: { info: SpawnCreatedInfo; requests: number; installed: boolean }[] = []
    const d: Awaited<ReturnType<typeof hostD>> = await hostD({
      dispatch: {
        onCreated: (info) =>
          seen.push({
            info,
            requests: d.t.kit.requests.length,
            installed: extensionTools(d.t, `shuvix.agent.${info.conversationId}`) !== undefined
          })
      }
    })
    d.t.kit.queue(callAgent('explore', 'find X'), answer('found'), answer('done'))
    expect(await d.session.submitUser('go')).toEqual({})
    expect(seen).toEqual([
      {
        info: {
          agentId: d.outcomes[0]!.agentId,
          conversationId: d.outcomes[0]!.conversationId,
          depth: 1,
          displayName: 'Explorer',
          description: 'look',
          parentConversationId: ROOT_CONVERSATION_ID,
          reattached: false
        },
        requests: 1,
        installed: true
      }
    ])
  })

  it('P2-03-OC2 a throwing onCreated is logged and the spawn goes on', async () => {
    const d = await hostD({
      dispatch: {
        onCreated: () => {
          throw new Error('listener broke')
        }
      }
    })
    d.t.kit.queue(callAgent('explore', 'find X'), answer('found'), answer('done'))
    expect(await d.session.submitUser('go')).toEqual({})
    expect(d.outcomes[0]).toMatchObject({ result: 'found' })
    expect(d.t.warnings.filter((warning) => warning.includes('listener broke'))).toHaveLength(1)
  })

  it('P2-03-OC3 never fires on a refusal or a pre-commit failure', async () => {
    const seen: SpawnCreatedInfo[] = []
    const d = await hostD({
      host: { maxAgentDepth: 0 },
      dispatch: { onCreated: (i) => seen.push(i) }
    })
    d.t.kit.queue(callAgent('explore', 'find X'), answer('done'))
    expect(await d.session.submitUser('go')).toEqual({})
    expect(d.outcomes[0]!.error).toContain('Agent depth limit reached (max 0)')
    d.t.toolHost.failResolve = new Error('boom')
    d.t.kit.queue(callAgent('explore', 'find Y'), answer('done'))
    expect(await d.session.submitUser('again')).toEqual({})
    expect(seen).toEqual([])
  })
})
