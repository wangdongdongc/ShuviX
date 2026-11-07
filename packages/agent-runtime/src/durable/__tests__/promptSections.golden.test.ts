/**
 * 系统提示词分段 × P1-00 黄金 fixture：逐字节对照（P1-08 的验收标准）。
 *
 * 每份 fixture 走一遍真实的 durable 请求：人设经 `computeFrozenAgentPrompt`（变量表 = fixture 记录的
 * 原样值）冻结进 AgentStateDoc，段落扩展按 `promptExtensionsFor` 选中，宿主 seam 返回 fixture 记录的
 * 原样值；faux 截下请求里的 system 消息 ——
 *  - `getCurrentSystemPrompt(messages)` 逐字节等于 `output`；
 *  - 每个段落逐个等于 fixture 的 `parts`（多块 systemContext 在新形态里是同一个 bot 段落，块间空一行）；
 *  - 变量表的调用上下文、各 seam 的调用参数与 fixture 捕获时观察到的一致（未选中的段落不调 seam）。
 *
 * 有意的偏离都写进了 fixture 本身（见各自的 `amended`）：`work-root-trim-rules` 的指令文件内容现在也修剪；
 * 2026-10-28 起档案不再点技能的名，各 fixture 档案里的 `skill:<名>` 改成了 `skill`、变量表看到的名单随之
 * 重算（勾选里的 `skill:` 条目不再进名单），输出不变。
 * `coding-spawned-system-context-blocks` 是派生 agent 带调用方上下文块 —— 新形态里只有 bot 段落承载
 * 这类块，而 `promptExtensionsFor` 只给 bot 档案上的根 agent 选它；这里为这份 fixture 显式补选，
 * 以对照「每块修剪、空白块跳过」的口径（今天没有任何调用方给派生 agent 传上下文块）。
 *
 * G-02 走的是没有冻结段落的那条路（`lockPrompt` 只冻结人设：旧对话、派生 agent）—— 活段落每次请求现解析。
 *
 * G-03（2026-11-06 系统提示词冻结）：同一份 fixture 走真的 createAgent（锁），输出逐字节相同、记下了 personaKey、
 * 段落按 fixture 冻结进 `AgentStateDoc.sections`；销毁之后重建 → 逐字节相同，文档不变，变量表不再被调用。
 * SEC-3：每份 fixture 按选中的段落 `renderSections`（冻结 / 比对用的那条渲染）与 fixture 的段落逐字相同。
 */
import { getCurrentSystemPrompt, getSystemMessageText } from '@earendil-works/pi-ai'
import { describe, expect, it } from 'vitest'
import { normalizeToolNames } from '../agentSpec'
import { backgroundContext as BG } from '../context'
import { AgentStateDoc } from '../docs'
import { computeFrozenAgentPrompt } from '../prompt/persona'
import {
  createPromptExtensions,
  PROMPT_EXTENSION,
  PROMPT_SECTION_KEY,
  promptExtensionsFor,
  sectionKeyOf
} from '../prompt/sections'
import { answer } from './support/faux'
import { makeHost, registerHostCleanup } from './support/host'
import { mcpDecl } from './support/mcpFake'
import {
  fixturePromptHost,
  loadGoldenFixtures,
  lockPrompt,
  systemMessages,
  type GoldenFixture,
  type SeamCalls
} from './support/prompt'

registerHostCleanup()

/** fixture 段名 → 新段落 key */
const PART_KEY: Record<string, string> = {
  persona: PROMPT_SECTION_KEY.persona,
  instructionFile: PROMPT_SECTION_KEY.instructions,
  projectPrompt: PROMPT_SECTION_KEY.projectPrompt,
  knowledgeBases: PROMPT_SECTION_KEY.knowledge,
  systemContext: PROMPT_SECTION_KEY.bot
}

/** fixture 的 parts 折成新段落：相邻的 systemContext 块并成一段（块间空一行） */
function expectedSections(fixture: GoldenFixture): [string, string][] {
  const sections: [string, string][] = []
  for (const part of fixture.parts) {
    const key = PART_KEY[part.name]
    expect(key, `unknown part ${part.name}`).toBeDefined()
    const last = sections[sections.length - 1]
    if (last !== undefined && last[0] === key && part.name === 'systemContext') {
      last[1] = `${last[1]}\n\n${part.text}`
    } else sections.push([key!, part.text])
  }
  return sections
}

const fixtures = loadGoldenFixtures()

describe('system prompt sections reproduce the P1-00 golden fixtures', () => {
  it('G-00 every fixture is covered (the directory is not empty)', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(20)
  })

  it.each(fixtures.map((fixture) => [fixture.case, fixture] as const))(
    'G-01 %s: byte-identical through a real durable request',
    async (_name, fixture) => {
      const { inputs, observed } = fixture
      const calls: SeamCalls = {}
      const counts: Record<string, number> = {}
      const promptHost = fixturePromptHost(fixture, calls, counts)
      // 段落扩展由宿主装进会话自己的注册表（K1/K21）；这里的一份只用来按名选择
      const t = await makeHost({ ephemeral: [inputs.rootSessionId], promptHost })
      const prompt = createPromptExtensions(promptHost)

      // 名单与变量表上下文与捕获时一致
      const toolNames = normalizeToolNames(inputs.kind, inputs.profile.tools, inputs.toolOverlay)
      expect(toolNames).toEqual(observed.promptVarsCtx.toolNames)
      const contexts: unknown[] = []
      const frozen = await computeFrozenAgentPrompt(
        {
          promptVars: (ctx) => {
            contexts.push(ctx)
            return inputs.promptVars
          }
        },
        {
          kind: inputs.kind,
          sessionId: inputs.sessionId,
          rootSessionId: inputs.rootSessionId,
          cwd: inputs.cwd,
          toolNames,
          profile: inputs.profile
        }
      )
      // rootSessionId 是捕获之后才加进变量表上下文的（宿主据它给派生 agent 查根会话的工作目录 / 项目）
      expect(contexts).toEqual([{ ...observed.promptVarsCtx, rootSessionId: inputs.rootSessionId }])
      expect(frozen.persona).toBe(fixture.parts[0]!.text)

      const spec = { kind: inputs.kind, profile: inputs.profile, toolNames }
      const names = promptExtensionsFor(spec)
      // 调用方上下文块只有 bot 段落承载（见文件头）
      if (inputs.systemContext.length > 0 && !names.includes(PROMPT_EXTENSION.bot)) {
        expect(inputs.kind).toBe('spawned')
        names.push(PROMPT_EXTENSION.bot)
      }
      const session = await t.open(inputs.rootSessionId)
      const conversation = await session.currentConversation()
      await lockPrompt(conversation, t.kit, frozen, names.map(prompt.get), inputs.cwd)

      t.kit.queue(answer('ok'))
      expect(await session.submitUser('hi')).toEqual({})
      const request = t.kit.requests[0]!
      expect(getCurrentSystemPrompt(request.messages)).toBe(fixture.output)

      const system = systemMessages(request.messages)
      expect(system).toHaveLength(1)
      expect(getSystemMessageText(system[0]!)).toBe(fixture.output)
      expect(system[0]!.content).toBe('')
      expect(Object.entries(system[0]!.sections ?? {})).toEqual(expectedSections(fixture))

      // seam 的调用：与捕获时观察到的一致（bot 段落是新 seam，单独看）
      const { resolveBotContext, ...legacy } = calls
      expect(legacy).toEqual(observed.resolverCalls)
      for (const [name, count] of Object.entries(counts)) expect(count, name).toBe(1)
      if (names.includes(PROMPT_EXTENSION.bot)) {
        expect(resolveBotContext).toEqual([inputs.rootSessionId])
      } else expect(resolveBotContext).toBeUndefined()
      expect(t.warnings).toEqual([])
    }
  )

  it.each(['work-root-all-injections', 'bot-root-all-injections'])(
    'G-02 %s (no frozen sections, the legacy live path): a second request re-renders the live sections but sends no new pi.system',
    async (name) => {
      const fixture = fixtures.find((candidate) => candidate.case === name)!
      const { inputs } = fixture
      const calls: SeamCalls = {}
      const counts: Record<string, number> = {}
      const promptHost = fixturePromptHost(fixture, calls, counts)
      // 段落扩展由宿主装进会话自己的注册表（K1/K21）；这里的一份只用来按名选择
      const t = await makeHost({ ephemeral: [inputs.rootSessionId], promptHost })
      const prompt = createPromptExtensions(promptHost)
      const toolNames = normalizeToolNames(inputs.kind, inputs.profile.tools, inputs.toolOverlay)
      let promptVarsCalls = 0
      const frozen = await computeFrozenAgentPrompt(
        {
          promptVars: () => {
            promptVarsCalls++
            return inputs.promptVars
          }
        },
        { ...inputs, toolNames }
      )
      const session = await t.open(inputs.rootSessionId)
      const conversation = await session.currentConversation()
      const selected = prompt.select({ kind: inputs.kind, profile: inputs.profile, toolNames })
      await lockPrompt(conversation, t.kit, frozen, selected, inputs.cwd)
      t.kit.queue(answer('one'), answer('two'))
      expect(await session.submitUser('hi')).toEqual({})
      expect(await session.submitUser('again')).toEqual({})
      expect(getCurrentSystemPrompt(t.kit.requests[1]!.messages)).toBe(fixture.output)
      expect(systemMessages(t.kit.requests[1]!.messages)).toHaveLength(1)
      expect(Object.values(counts).every((count) => count === 2)).toBe(true)
      expect(Object.keys(counts).length).toBeGreaterThanOrEqual(3)
      expect(promptVarsCalls).toBe(1)
    }
  )

  it.each(['work-root-all-injections', 'chat-root-instruction-and-knowledge'])(
    'G-03 %s through the real lock: byte-identical with a personaKey stored; destroy + recreate with unchanged inputs gives the same bytes and key without asking promptVars',
    async (name) => {
      const fixture = fixtures.find((candidate) => candidate.case === name)!
      const { inputs } = fixture
      const promptHost = fixturePromptHost(fixture, {})
      let promptVarsCalls = 0
      const t = await makeHost({
        promptHost,
        promptVars: () => {
          promptVarsCalls++
          return inputs.promptVars
        },
        agentConfig: {
          profile: inputs.profile,
          toolOverlay: inputs.toolOverlay,
          model: { provider: 'faux', modelId: 'faux-1' },
          cwd: inputs.cwd
        },
        toolHost: { mcp: { ssh: [mcpDecl('exec')] }, skills: ['builtin:drawing', 'pdf'] }
      })
      const session = await t.open(inputs.rootSessionId)
      t.kit.queue(answer('one'))
      expect(await session.submitUser('hi')).toEqual({})
      expect(t.kit.requests[0]!.systemPrompt).toBe(fixture.output)
      const conversation = (await session.currentConversation()).id
      const stored = await session.harness.snapshot(AgentStateDoc, conversation, BG)
      expect(stored?.personaKey).toMatch(/^v1:/)
      // 选中的段落冻结成 fixture 的那几段（人设另存；选中却缺席的存成 null）
      const toolNames = normalizeToolNames(inputs.kind, inputs.profile.tools, inputs.toolOverlay)
      const present = new Map(expectedSections(fixture))
      expect(stored?.sections).toEqual(
        Object.fromEntries(
          promptExtensionsFor({ kind: inputs.kind, profile: inputs.profile, toolNames })
            .filter((extension) => extension !== PROMPT_EXTENSION.persona)
            .map(sectionKeyOf)
            .map((key) => [key, present.get(key) ?? null])
        )
      )
      expect(promptVarsCalls).toBe(1)

      await session.destroyAgent()
      t.kit.queue(answer('two'))
      expect(await session.submitUser('again')).toEqual({})
      expect(t.kit.requests[1]!.systemPrompt).toBe(fixture.output)
      expect(await session.harness.snapshot(AgentStateDoc, conversation, BG)).toEqual(stored)
      expect(promptVarsCalls).toBe(1)
    }
  )

  it.each(fixtures.map((fixture) => [fixture.case, fixture] as const))(
    'SEC-3 %s: renderSections of the selected sections (the freeze / compare render) equals the fixture, section by section',
    async (_name, fixture) => {
      const { inputs } = fixture
      const promptHost = fixturePromptHost(fixture, {})
      const prompt = createPromptExtensions(promptHost)
      const toolNames = normalizeToolNames(inputs.kind, inputs.profile.tools, inputs.toolOverlay)
      const names = promptExtensionsFor({ kind: inputs.kind, profile: inputs.profile, toolNames })
      if (inputs.systemContext.length > 0 && !names.includes(PROMPT_EXTENSION.bot)) {
        names.push(PROMPT_EXTENSION.bot)
      }
      const rendered = await prompt.renderSections({
        names,
        rootSessionId: inputs.rootSessionId,
        cwd: inputs.cwd,
        instructionFiles: inputs.profile.instructionFiles
      })
      const expected = expectedSections(fixture).filter(([key]) => key !== 'persona')
      // 选中却缺席的段落存成 null；人设不在里面
      expect(Object.keys(rendered).sort()).toEqual(
        names
          .filter((name) => name !== PROMPT_EXTENSION.persona)
          .map(sectionKeyOf)
          .sort()
      )
      expect(Object.entries(rendered).filter(([, text]) => text !== null)).toEqual(expected)
    }
  )
})
