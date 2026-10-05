/**
 * DurableSession · agentInfo（P3-06 A / B 段：01–17）—— 一个对话上 agent 的运行时快照。
 *
 *  A  01 黄金 fixture：请求前后的快照 = fixture 输出 = 第一次请求的系统提示词 · 02 真 createAgent 路径（快照不重算
 *     人设、不重读配置）· 03 活段落变了：快照只读、给的是下一次请求那份（PIN-07）· 04 段落抛错：保留已显示的、
 *     记一条警告、从不拒绝 · 05 工具（K6 次序、描述逐字节、参数名、label）· 06 模型（注册表现查、input 是副本）·
 *     07 模型从注册表里没了（PIN-05）· 08 思考档位是活的 · 09 messageCount（PIN-04）· 10 isStreaming ·
 *     11 被中断的会话 · 12 JSON 形状 · 13 什么都不跑 · 14 没 agent / 不认识 / 已关（PIN-02）
 *  B  15 派生 agent 的快照 · 16 两个对话同时在跑 · 17 宿主派发的 hook agent
 *
 * 系统提示词逐字节的对照来自 faux 的请求记录（`FauxRequest.systemPrompt` = pi-ai `getCurrentSystemPrompt`）。
 */
import { Type } from '@earendil-works/pi-ai'
import {
  defineTool,
  ROOT_CONVERSATION_ID,
  type Conversation,
  type ConversationId,
  type ToolRegistration
} from '@earendil-works/pi-durable'
import type { AgentRuntimeInfo } from '@shuvix/chat-protocol/chatApi'
import { describe, expect, it } from 'vitest'
import { backgroundContext as BG } from '../context'
import { SessionClosedError, type DurableSession } from '../durableSession'
import { normalizeToolNames } from '../agentSpec'
import { fenceProjectPrompt } from '../prompt/fences'
import { computeFrozenAgentPrompt } from '../prompt/persona'
import { createPromptExtensions, PROMPT_EXTENSION, promptExtensionsFor } from '../prompt/sections'
import type { ResultContract } from '../../subagent/nextTool'
import { markerVars, scenarioToolHost, testProfile } from './support/agentConfig'
import { recordPublications } from './support/commits'
import { crashWith } from './support/crash'
import { answer, callTool, fauxKit, held } from './support/faux'
import {
  anchors,
  hookRig,
  promptPayload,
  queueRoles,
  requestsOfRole,
  reviewerOf
} from './support/hookRig'
import { makeHost, registerHostCleanup, TEST_SETTINGS_OVERRIDES } from './support/host'
import {
  fixturePromptHost,
  loadGoldenFixtures,
  lockPrompt,
  systemMessages,
  type SeamCalls
} from './support/prompt'
import { scenarioW } from './support/scenario'
import { callAgent, firstChild, hostD, TITLE_SCHEMA } from './support/spawn'
import { askingTool } from './support/tools'
import { allEntries } from './support/transcript'
import { waitFor, withTimeout } from './support/wait'

registerHostCleanup()

const ROOT = ROOT_CONVERSATION_ID
const names = (tools: readonly { name: string }[]): string[] => tools.map((tool) => tool.name)
const nonSystem = (messages: readonly { role: string }[]): number =>
  messages.filter((message) => message.role !== 'system').length

/** 快照里与时机无关的那几项（运行中 / 消息数之外） */
function stable(info: AgentRuntimeInfo | undefined): Partial<AgentRuntimeInfo> {
  const { systemPrompt, model, thinkingLevel, tools } = info!
  return { systemPrompt, model, thinkingLevel, tools }
}

/** agentInfo 自己记的那条段落警告 */
const sectionWarnings = (warnings: readonly string[]): string[] =>
  warnings.filter((warning) => warning.includes('rendering system prompt section'))

async function rootOf(session: DurableSession): Promise<Conversation> {
  return (await session.harness.conversation(ROOT, BG))!
}

const fixtures = loadGoldenFixtures()

describe('P3-06 A · agentInfo content', () => {
  it.each(fixtures.map((fixture) => [fixture.case, fixture] as const))(
    'P3-06-01 %s: the prompt before and after the first request is the fixture output, byte for byte',
    async (_name, fixture) => {
      const { inputs } = fixture
      const calls: SeamCalls = {}
      const promptHost = fixturePromptHost(fixture, calls)
      const t = await makeHost({ ephemeral: [inputs.rootSessionId], promptHost })
      const prompt = createPromptExtensions(promptHost)
      const toolNames = normalizeToolNames(inputs.kind, inputs.profile.tools, inputs.toolOverlay)
      const frozen = await computeFrozenAgentPrompt(
        { promptVars: () => inputs.promptVars },
        {
          kind: inputs.kind,
          sessionId: inputs.sessionId,
          rootSessionId: inputs.rootSessionId,
          cwd: inputs.cwd,
          toolNames,
          profile: inputs.profile
        }
      )
      const selected = promptExtensionsFor({
        kind: inputs.kind,
        profile: inputs.profile,
        toolNames
      })
      // 调用方上下文块只有 bot 段落承载（与 G-01 同样补选）
      if (inputs.systemContext.length > 0 && !selected.includes(PROMPT_EXTENSION.bot)) {
        selected.push(PROMPT_EXTENSION.bot)
      }
      const session = await t.open(inputs.rootSessionId)
      const conversation = await session.currentConversation()
      await lockPrompt(conversation, t.kit, frozen, selected.map(prompt.get), inputs.cwd)

      const before = await session.agentInfo(conversation.id)
      t.kit.queue(answer('ok'))
      expect(await session.submitUser('hi')).toEqual({})
      const after = await session.agentInfo(conversation.id)

      expect(before!.systemPrompt).toBe(fixture.output)
      expect(after!.systemPrompt).toBe(fixture.output)
      expect(t.kit.requests[0]!.systemPrompt).toBe(fixture.output)
      expect(t.warnings).toEqual([])
    }
  )

  it('P3-06-02 the real createAgent path: the snapshot equals the first request; it re-computes nothing', async () => {
    const vars = markerVars('M1')
    const t = await makeHost({
      agentConfig: {
        profile: testProfile({ systemPrompt: 'You are {{shuvix:marker}}' }),
        model: { provider: 'faux', modelId: 'faux-1' }
      },
      promptVars: vars.promptVars
    })
    const session = await t.open()
    await session.createAgent()
    const info = await session.agentInfo(session.lock!.conversationId)
    t.kit.queue(answer('ok'))
    expect(await session.submitUser('hi')).toEqual({})
    expect(info!.systemPrompt).toBe('You are M1')
    expect(info!.systemPrompt).toBe(t.kit.requests[0]!.systemPrompt)
    expect(t.configCalls).toHaveLength(1)
    expect(vars.state.calls).toBe(1)
  })

  it('P3-06-03 a live section change: reading is read-only, and the snapshot is what the next request carries', async () => {
    const seam = { text: 'A' }
    const t = await makeHost({
      agentConfig: {
        profile: testProfile({ systemPrompt: 'Persona', projectAwareness: true }),
        model: { provider: 'faux', modelId: 'faux-1' }
      },
      promptHost: { resolveProjectPrompt: () => seam.text }
    })
    const session = await t.open()
    t.kit.queue(answer('one'), answer('two'), answer('three'))
    expect(await session.submitUser('first')).toEqual({})
    const conversation = await rootOf(session)
    const entriesBefore = (await allEntries(conversation)).length

    const infos = [
      await session.agentInfo(ROOT),
      await session.agentInfo(ROOT),
      await session.agentInfo(ROOT)
    ]
    expect(infos[1]).toEqual(infos[0])
    expect(infos[2]).toEqual(infos[0])
    expect(infos[0]!.systemPrompt).toBe(`Persona\n\n${fenceProjectPrompt('A')}`)
    expect((await allEntries(conversation)).length).toBe(entriesBefore)

    expect(await session.submitUser('second')).toEqual({})
    // G-02 的不变式：第二次请求没有新的 pi.system
    expect(systemMessages(t.kit.requests[1]!.messages)).toHaveLength(1)

    seam.text = 'B'
    const entriesMid = (await allEntries(conversation)).length
    const switched = await session.agentInfo(ROOT)
    expect((await allEntries(conversation)).length).toBe(entriesMid)
    expect(switched!.systemPrompt).toContain(fenceProjectPrompt('B'))
    expect(await session.submitUser('third')).toEqual({})
    expect(switched!.systemPrompt).toBe(t.kit.requests[2]!.systemPrompt)
  })

  it('P3-06-04 a throwing section: never rejects; omitted before any request, kept after one; one warning per read', async () => {
    const seam: { text: string; fail: boolean } = { text: 'A', fail: true }
    const t = await makeHost({
      agentConfig: {
        profile: testProfile({ systemPrompt: 'Persona', projectAwareness: true }),
        model: { provider: 'faux', modelId: 'faux-1' }
      },
      promptHost: {
        resolveProjectPrompt: () => {
          if (seam.fail) throw new Error('project prompt unavailable')
          return seam.text
        }
      }
    })
    const session = await t.open()
    await session.createAgent()
    const fresh = await session.agentInfo(ROOT)
    expect(fresh!.systemPrompt).toBe('Persona')
    expect(sectionWarnings(t.warnings)).toHaveLength(1)
    expect(sectionWarnings(t.warnings)[0]).toContain('project_prompt')
    expect(sectionWarnings(t.warnings)[0]).toContain('project prompt unavailable')

    seam.fail = false
    t.kit.queue(answer('one'), answer('two'))
    expect(await session.submitUser('first')).toEqual({})
    seam.fail = true
    const kept = await session.agentInfo(ROOT)
    expect(kept!.systemPrompt).toBe(`Persona\n\n${fenceProjectPrompt('A')}`)
    expect(sectionWarnings(t.warnings)).toHaveLength(2)
    expect(await session.submitUser('second')).toEqual({})
    expect(t.kit.requests[1]!.systemPrompt).toBe(kept!.systemPrompt)
  })

  it('P3-06-05 tools: lock order, byte-equal descriptions, parameter names, label or name', async () => {
    const labeled = {
      ...defineTool({
        name: 'labeled',
        description: 'labeled: a host tool with a label',
        parameters: Type.Object({ path: Type.String(), depth: Type.Number() }),
        execute: async () => ({ content: [{ type: 'text' as const, text: 'ok' }] })
      }),
      label: 'Labeled Tool'
    } as ToolRegistration
    const schemaless: ToolRegistration = {
      name: 'schemaless',
      description: 'schemaless: no properties at all',
      parameters: Type.Unsafe<Record<string, unknown>>({ type: 'object' }),
      execute: async () => ({ content: [{ type: 'text', text: 'ok' }] })
    }
    const { t } = await scenarioW({
      toolHost: scenarioToolHost({ agentTools: [labeled, schemaless] })
    })
    const session = await t.open()
    t.kit.queue(answer('ok'))
    expect(await session.submitUser('hi')).toEqual({})
    const info = (await session.agentInfo(ROOT))!
    const request = t.kit.requests[0]!

    expect(names(info.tools)).toEqual(session.lock!.toolNames)
    expect(names(info.tools)).toEqual(names(request.tools))
    expect(names(info.tools)).toEqual(
      expect.arrayContaining(['agent', 'skill', 'mcp__ctx__resolve'])
    )
    expect(names(info.tools).slice(-2)).toEqual(['labeled', 'schemaless'])
    for (const [index, tool] of info.tools.entries()) {
      const offered = request.tools[index]!
      expect(tool.description).toBe(offered.description)
      const properties = (offered.parameters as { properties?: Record<string, unknown> }).properties
      expect(tool.parameters).toEqual(Object.keys(properties ?? {}))
      expect(tool.label).toBe(tool.name === 'labeled' ? 'Labeled Tool' : tool.name)
    }
    expect(info.tools.find((tool) => tool.name === 'labeled')!.parameters).toEqual([
      'path',
      'depth'
    ])
    expect(info.tools.find((tool) => tool.name === 'schemaless')!.parameters).toEqual([])
    expect(info.tools.find((tool) => tool.name === 'mcp__ctx__resolve')!.parameters).toEqual(['q'])
  })

  it('P3-06-06 model: read from the registry; input is a copy; the request used it', async () => {
    const kit = fauxKit({ models: [{ id: 'faux-1', contextWindow: 3000, maxTokens: 1000 }] })
    const t = await makeHost({ kit })
    const session = await t.open()
    await session.createAgent()
    const info = (await session.agentInfo(ROOT))!
    const registered = kit.models.getModel('faux', 'faux-1')!
    expect(info.model).toEqual({
      provider: 'faux',
      id: 'faux-1',
      name: registered.name,
      api: registered.api,
      contextWindow: 3000,
      maxTokens: 1000,
      reasoning: registered.reasoning,
      input: [...registered.input]
    })
    const before = [...registered.input]
    info.model.input.push('mutated')
    expect(kit.models.getModel('faux', 'faux-1')!.input).toEqual(before)
    kit.queue(answer('ok'))
    expect(await session.submitUser('hi')).toEqual({})
    expect(kit.requests[0]!.modelId).toBe(info.model.id)
  })

  it('P3-06-07 the locked model left the registry: resolves with the lock ref and zero values (PIN-05)', async () => {
    const t = await makeHost()
    const session = await t.open()
    await session.createAgent()
    t.kit.models.deleteProvider('faux')
    const info = await session.agentInfo(ROOT)
    expect(info!.model).toEqual({
      provider: 'faux',
      id: 'faux-1',
      name: 'faux-1',
      api: '',
      contextWindow: 0,
      maxTokens: 0,
      reasoning: false,
      input: []
    })
  })

  it('P3-06-08 the thinking level is live: setThinkingLevel shows at once; the lock keeps its own; only the configure commits', async () => {
    const t = await makeHost({
      agentConfig: {
        profile: testProfile(),
        model: { provider: 'faux', modelId: 'faux-1' },
        thinkingLevel: 'low'
      }
    })
    const session = await t.open()
    await session.createAgent()
    expect((await session.agentInfo(ROOT))!.thinkingLevel).toBe('low')
    const commits = recordPublications(session.harness)
    await session.setThinkingLevel('high')
    const info = await session.agentInfo(ROOT)
    commits.stop()
    expect(info!.thinkingLevel).toBe('high')
    expect(session.lock!.thinkingLevel).toBe('low')
    expect(commits.publications).toHaveLength(1)
    expect(commits.publications[0]!.docs).toContain('pi.agent#1')
    expect(t.kit.callCount).toBe(0)
  })

  it('P3-06-09 messageCount: non-system context messages (fresh 0, text turn 2, tool round 4, compaction = the context)', async () => {
    const t = await makeHost({
      settingsOverrides: {
        ...TEST_SETTINGS_OVERRIDES,
        compaction: { enabled: false, keepRecentTokens: 200 }
      }
    })
    const session = await t.open()
    await session.createAgent()
    expect((await session.agentInfo(ROOT))!.messageCount).toBe(0)
    t.kit.queue(answer('a1'))
    expect(await session.submitUser('u1')).toEqual({})
    expect((await session.agentInfo(ROOT))!.messageCount).toBe(2)

    // 一轮工具：user, assistant(toolCall), toolResult, assistant
    const probe = defineTool({
      name: 'probe',
      description: 'probe: probes',
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: 'text' as const, text: 'probe done' }] })
    })
    const tools = await makeHost({ tools: [probe] })
    const other = await tools.open('s2')
    await other.createAgent()
    tools.kit.queue(callTool('probe'), answer('done'))
    expect(await other.submitUser('go')).toEqual({})
    expect((await other.agentInfo(ROOT))!.messageCount).toBe(4)

    // 压缩之后：摘要 + 保留的尾巴；head 之前的条目不算
    t.kit.queue(answer('a2'))
    expect(await session.submitUser('u2')).toEqual({})
    t.kit.queue(answer('a3'))
    expect(await session.submitUser(`u3 ${'details '.repeat(150)}`)).toEqual({})
    expect((await session.agentInfo(ROOT))!.messageCount).toBe(6)
    t.kit.queue(answer('SUMMARY'))
    const conversation = await rootOf(session)
    const task = await conversation.compact(undefined, BG)
    await withTimeout(session.harness.waitForTask(task, BG), 5000, 'compaction')
    const view = await conversation.context(BG)
    const info = (await session.agentInfo(ROOT))!
    expect(info.messageCount).toBe(nonSystem(view.messages))
    expect(info.messageCount).toBeLessThan(6)
    expect(view.head).toBeDefined()
  })

  it('P3-06-10 isStreaming: idle false; mid-stream true (and busy); waiting on an ask true; settled false', async () => {
    const ref: { session?: DurableSession } = {}
    const t = await makeHost({ tools: [askingTool('askme', () => ref.session!)] })
    const session = (ref.session = await t.open())
    await session.createAgent()
    expect((await session.agentInfo(ROOT))!.isStreaming).toBe(false)

    const gate = held(answer('streamed'))
    t.kit.queue(gate.step)
    const first = session.submitUser('go')
    await gate.reached
    expect((await session.agentInfo(ROOT))!.isStreaming).toBe(true)
    expect(session.isBusy()).toBe(true)
    gate.release()
    expect(await first).toEqual({})
    expect((await session.agentInfo(ROOT))!.isStreaming).toBe(false)

    t.kit.queue(callTool('askme'), answer('done'))
    const second = session.submitUser('ask')
    await waitFor(() => session.pendingInputCount === 1, 3000, 'ask pending')
    expect((await session.agentInfo(ROOT))!.isStreaming).toBe(true)
    expect(session.respondToInput('call-askme', { kind: 'ask', allowed: true })).toBe(true)
    expect(await second).toEqual({})
    expect((await session.agentInfo(ROOT))!.isStreaming).toBe(false)
  })

  it('P3-06-11 an interrupted session: not streaming, persisted messages counted; reading resumes nothing', async () => {
    const { t } = await crashWith()
    const session = await t.open()
    expect(session.isInterrupted()).toBe(true)
    const runState = session.runState
    const info = (await session.agentInfo(ROOT))!
    expect(info.isStreaming).toBe(false)
    expect(info.messageCount).toBe(1)
    expect(session.isInterrupted()).toBe(true)
    expect(session.runState).toBe(runState)
    expect((await session.harness.inspect(BG)).scheduling).toBe('paused')
    expect(t.kit.callCount).toBe(0)
  })

  it('P3-06-12 the JSON shape: six keys, eight model keys, four keys per tool; plain data', async () => {
    const { t } = await scenarioW()
    const session = await t.open()
    await session.createAgent()
    const info = (await session.agentInfo(ROOT))!
    expect(Object.keys(info).sort()).toEqual(
      ['isStreaming', 'messageCount', 'model', 'systemPrompt', 'thinkingLevel', 'tools'].sort()
    )
    expect(Object.keys(info.model).sort()).toEqual(
      ['api', 'contextWindow', 'id', 'input', 'maxTokens', 'name', 'provider', 'reasoning'].sort()
    )
    expect(info.tools.length).toBeGreaterThan(0)
    for (const tool of info.tools) {
      expect(Object.keys(tool).sort()).toEqual(['description', 'label', 'name', 'parameters'])
    }
    expect(structuredClone(info)).toEqual(info)
    expect(JSON.parse(JSON.stringify(info))).toEqual(info)
  })

  it('P3-06-13 reading runs nothing: no commit, the scheduler stays paused, no creation seam, no broadcast', async () => {
    const { t, vars } = await scenarioW()
    const session = await t.open()
    await session.createAgent()
    const config = t.configCalls.length
    const resolves = t.toolHost.resolveCalls.length
    const builtins = t.toolHost.builtinCalls.length
    const varCalls = vars.state.calls
    const broadcasts = t.broadcasts.length
    const commits = recordPublications(session.harness)
    for (let index = 0; index < 5; index++) await session.agentInfo(ROOT)
    commits.stop()
    expect(commits.publications).toEqual([])
    expect((await session.harness.inspect(BG)).scheduling).toBe('paused')
    expect(t.configCalls).toHaveLength(config)
    expect(t.toolHost.resolveCalls).toHaveLength(resolves)
    expect(t.toolHost.builtinCalls).toHaveLength(builtins)
    expect(vars.state.calls).toBe(varCalls)
    expect(t.broadcasts).toHaveLength(broadcasts)
    expect(t.kit.callCount).toBe(0)
  })

  it('P3-06-14 no agent / unknown / closed (PIN-02): undefined, undefined, SessionClosedError; nothing created or committed', async () => {
    const t = await makeHost()
    const session = await t.open()
    const commits = recordPublications(session.harness)
    expect(await session.agentInfo(ROOT)).toBeUndefined()
    expect(await session.agentInfo(99)).toBeUndefined()
    commits.stop()
    expect(commits.publications).toEqual([])
    expect(session.lock).toBeUndefined()
    expect(t.configCalls).toEqual([])

    await t.host.close('s1')
    await expect(session.agentInfo(ROOT)).rejects.toBeInstanceOf(SessionClosedError)
    expect(t.configCalls).toEqual([])
    expect(t.broadcastsOf('agent_created')).toEqual([])
  })
})

// ─────────────────────────── B · 根与派生 ───────────────────────────

const CONTRACT: ResultContract = { schema: structuredClone(TITLE_SCHEMA) }

/** 派生一个 modeled（faux-2、自己的人设、名单 probe + agent，深度上限 1 拿掉 agent、契约带来 next），子对话第一次请求扣住 */
async function spawnHeld(): Promise<{
  d: Awaited<ReturnType<typeof hostD>>
  child: ConversationId
  release: () => void
  sent: Promise<unknown>
  rootBefore: AgentRuntimeInfo
}> {
  const d = await hostD({ host: { maxAgentDepth: 1 }, dispatch: { contract: CONTRACT } })
  const rootBefore = (await d.session.agentInfo(ROOT))!
  const gate = held(callTool('next', { title: 'A' }))
  d.t.kit.queue(callAgent('modeled', 'p'), gate.step, answer('done'))
  const sent = d.session.submitUser('go')
  await gate.reached
  const child = await firstChild(d.session)
  return { d, child, release: gate.release, sent, rootBefore }
}

describe('P3-06 B · root vs spawned', () => {
  it("P3-06-15 a spawned agent's snapshot is its own request: prompt, tools (next yes, agent no), model; the root's is unchanged", async () => {
    const { d, child, release, sent, rootBefore } = await spawnHeld()
    const childRequest = d.t.kit.requests[1]!
    const info = (await d.session.agentInfo(child))!
    expect(info.systemPrompt).toBe(childRequest.systemPrompt)
    expect(info.systemPrompt).toBe('You are modeled')
    expect(names(info.tools)).toEqual(names(childRequest.tools))
    expect(names(info.tools)).toContain('next')
    expect(names(info.tools)).not.toContain('agent')
    expect(info.model.id).toBe('faux-2')
    expect(childRequest.modelId).toBe('faux-2')

    const root = (await d.session.agentInfo(ROOT))!
    expect(stable(root)).toEqual(stable(rootBefore))
    expect(stable(root)).not.toEqual(stable(info))
    release()
    expect(await withTimeout(sent, 5000, 'root send')).toEqual({})
  })

  it('P3-06-16 both conversations streaming: child and root true; counts are per conversation; both false after settling', async () => {
    const { d, child, release, sent } = await spawnHeld()
    const childInfo = (await d.session.agentInfo(child))!
    const rootInfo = (await d.session.agentInfo(ROOT))!
    expect(childInfo.isStreaming).toBe(true)
    expect(rootInfo.isStreaming).toBe(true)
    const childConversation = (await d.session.harness.conversation(child, BG))!
    expect(childInfo.messageCount).toBe(nonSystem((await childConversation.context(BG)).messages))
    expect(childInfo.messageCount).toBe(1)
    // 根的上下文：user、assistant(派发调用)，外加 durable 给在途调用补的那条 toolResult —— 子对话的不算
    const rootContext = (await (await rootOf(d.session)).context(BG)).messages
    expect(rootContext.map((message) => message.role)).toEqual([
      'user',
      'system',
      'assistant',
      'toolResult'
    ])
    expect(rootInfo.messageCount).toBe(3)
    release()
    expect(await withTimeout(sent, 5000, 'root send')).toEqual({})
    expect((await d.session.agentInfo(child))!.isStreaming).toBe(false)
    expect((await d.session.agentInfo(ROOT))!.isStreaming).toBe(false)
  })

  it('P3-06-17 a hook agent (dispatch hook): its narrowed tools, own model and prompt; reading is not busy and leaves runState alone', async () => {
    const rig = await hookRig()
    const session = rig.session
    const gate = held(answer('A Title'))
    queueRoles(rig.kit, { titler: [gate.step] })
    rig.runner.fire('session.prompt-accepted', promptPayload())
    await gate.reached
    let hookConversation: ConversationId | undefined
    await waitFor(async () => {
      const [anchor] = await anchors(session)
      if (anchor === undefined) return false
      hookConversation = (await reviewerOf(session, anchor.id))[0]
      return hookConversation !== undefined
    })
    const request = requestsOfRole(rig.kit, 'titler')[0]!
    const runState = session.runState
    const info = (await session.agentInfo(hookConversation!))!
    expect(names(info.tools)).toEqual(names(request.tools))
    expect(names(info.tools)).toContain('titleProbe')
    expect(names(info.tools)).not.toContain('probe')
    expect(names(info.tools)).not.toContain('agent')
    expect(info.systemPrompt).toBe(request.systemPrompt)
    expect(info.systemPrompt).toBe('You name sessions')
    expect(info.model.id).toBe(request.modelId)
    expect(info.thinkingLevel).toBe('off')
    expect(info.isStreaming).toBe(true)
    expect(session.isBusy()).toBe(false)
    expect(session.runState).toBe(runState)
    expect(runState).toBe('idle')
    gate.release()
    await waitFor(() => rig.ends().length === 1, 5000, 'titler ended')
  })
})
