/**
 * P2-11 · J8：每个对话自己的人设黄金（PIN-08）。同一条会话里根 agent 按根 fixture、派出的 coding 子 agent 按
 * `coding-spawned-all-injections` 逐字节出系统提示词：人设在创建那一刻冻结（宿主的块按 `ctx.kind` 取各自的
 * fixture 值），子 agent 的活段落按根会话 id 现调宿主 seam（子 agent 的 cwd 为空）；bot 段落只给 bot 档案的根。
 * 根 agent 的段落在第一次上锁时冻结（2026-11-06）：之后的请求不再调 seam，只有重新上锁时为比对调一次。
 */
import type { PromptBlockTexts, PromptBlocksCtx } from '../../../agentProfile/promptBlocks'
import { describe, expect, it } from 'vitest'
import { PROMPT_SECTION_KEY } from '../../prompt/sections'
import type { PromptHost } from '../../seams'
import type { AgentProfile } from '../../../subagent/types'
import { answer, callTool, stalled } from '../support/faux'
import { registerHostCleanup } from '../support/host'
import {
  fixturePromptHost,
  loadGoldenFixtures,
  systemMessages,
  type GoldenFixture
} from '../support/prompt'
import { systemDeltas } from '../support/transcript'
import { withTimeout } from '../support/wait'
import {
  childOfCall,
  recordOf,
  registerSpawnCleanup,
  resultOf,
  spawnWorld,
  type SpawnWorld
} from './support/spawnWorld'
import { registerWorldCleanup } from './support/world'

registerHostCleanup()
registerWorldCleanup()
registerSpawnCleanup()

const TIMEOUT = 15000
const RECOVERY_TIMEOUT = 20000
const SID = 'sess-golden-root'
const fixtures = new Map(loadGoldenFixtures().map((fixture) => [fixture.case, fixture]))
const SPAWNED = fixtures.get('coding-spawned-all-injections')!

const PART_KEY: Record<string, string> = {
  persona: PROMPT_SECTION_KEY.persona,
  agentsMd: PROMPT_SECTION_KEY.agentsMd,
  claudeMd: PROMPT_SECTION_KEY.claudeMd,
  projectPrompt: PROMPT_SECTION_KEY.projectPrompt,
  knowledgeBases: PROMPT_SECTION_KEY.knowledge,
  systemContext: PROMPT_SECTION_KEY.bot
}

/** fixture 的 parts 折成新段落（与 promptSections.golden 同一口径） */
function expectedSections(fixture: GoldenFixture): [string, string][] {
  const sections: [string, string][] = []
  for (const part of fixture.parts) {
    const key = PART_KEY[part.name]!
    const last = sections[sections.length - 1]
    if (last !== undefined && last[0] === key && part.name === 'systemContext') {
      last[1] = `${last[1]}\n\n${part.text}`
    } else sections.push([key, part.text])
  }
  return sections
}

interface GoldenWorld {
  sw: SpawnWorld
  /** 渲染块时收到的上下文（按次序） */
  contexts: PromptBlocksCtx[]
  /** 每次宿主 seam 调用：[名字, 参数]（按次序，跨进程） */
  seamCalls: [string, unknown[]][]
  /** 派生 agent 的块（可改：J8-03 改日期） */
  spawnedBlocks: { value: PromptBlockTexts }
}

/** 黄金世界（设计 §1.9）：会话 `sess-golden-root`，根与子共用 fixture 的 PromptHost，按 fixture 输出路由 */
async function goldenWorld(rootCase: string): Promise<GoldenWorld> {
  const root = fixtures.get(rootCase)!
  const contexts: PromptBlocksCtx[] = []
  const seamCalls: [string, unknown[]][] = []
  const spawnedBlocks = { value: structuredClone(SPAWNED.inputs.promptBlocks) }
  const fixtureHost = fixturePromptHost(root, {}, {})
  const promptHost: PromptHost = {}
  for (const [name, seam] of Object.entries(fixtureHost)) {
    ;(promptHost as Record<string, unknown>)[name] = (...args: unknown[]) => {
      seamCalls.push([name, args.map((arg) => (Array.isArray(arg) ? [...arg] : arg))])
      return (seam as (...a: unknown[]) => unknown)(...args)
    }
  }
  const coding = {
    ...structuredClone(SPAWNED.inputs.profile),
    source: 'builtin',
    basePath: ''
  } as AgentProfile
  const sw = await spawnWorld({
    profileObjects: [coding],
    host: {
      promptHost,
      promptBlocks: (ctx) => {
        contexts.push(structuredClone(ctx))
        return ctx.kind === 'spawned' ? spawnedBlocks.value : root.inputs.promptBlocks
      }
    },
    lanes: (model) => {
      model.lane('golden-root', ({ systemPrompt }) => systemPrompt === root.output)
      model.lane('golden-child', ({ systemPrompt }) => systemPrompt === SPAWNED.output)
    }
  })
  sw.world.configs.set(SID, {
    profile: structuredClone(root.inputs.profile),
    toolOverlay: [...root.inputs.toolOverlay],
    model: { provider: 'faux', modelId: 'faux-1' },
    thinkingLevel: 'low',
    cwd: root.inputs.cwd
  })
  return { sw, contexts, seamCalls, spawnedBlocks }
}

const CODING_CALL = callTool(
  'agent',
  { name: 'coding', prompt: 'build it', description: 'code' },
  'r-agent'
)

/** 子 agent 的 seam 调用，折成 fixture 的形状：指令文件是问到的每一种参数（去重），其余是最近一次的参数 */
function childSeamCalls(seamCalls: [string, unknown[]][]): Record<string, unknown[]> {
  const found: Record<string, unknown[]> = {}
  for (const [name, args] of seamCalls) {
    if (name === 'resolveInstruction') {
      if (args[1] !== '') continue
      const seen = (found[name] ??= [])
      if (!seen.some((known) => JSON.stringify(known) === JSON.stringify(args))) seen.push(args)
    } else if (name !== 'resolveBotContext') found[name] = args
  }
  return found
}

describe('P2-11 · J8 per-conversation persona golden', () => {
  it(
    'J8-01 coding root → coding child: each conversation renders its own golden byte for byte',
    async () => {
      const root = fixtures.get('coding-root-all-injections')!
      const { sw, contexts, seamCalls } = await goldenWorld('coding-root-all-injections')
      const { world } = sw
      const session = await sw.open(SID)
      world.model.chatIn('golden-root', CODING_CALL, answer('done'))
      world.model.chatIn('golden-child', answer('built'))
      expect(await withTimeout(session.submitUser('go'), 8000, 'go')).toEqual({})
      world.model.chatIn('golden-root', answer('after'))
      expect(await session.submitUser('again')).toEqual({})

      const [child] = world.model.laneRequests('golden-child')
      expect(child!.systemPrompt).toBe(SPAWNED.output)
      const childSystem = systemMessages(child!.messages)
      expect(childSystem).toHaveLength(1)
      expect(Object.entries(childSystem[0]!.sections ?? {})).toEqual(expectedSections(SPAWNED))
      const C = await childOfCall(session, 'r-agent', 1)
      const A = (await recordOf(session, C))!.agentId
      expect(contexts.filter((ctx) => ctx.kind === 'spawned')).toEqual([
        { ...SPAWNED.observed.promptBlocksCtx, sessionId: A, rootSessionId: SID }
      ])
      expect(childSeamCalls(seamCalls)).toEqual(SPAWNED.observed.resolverCalls)
      expect(seamCalls.some(([name]) => name === 'resolveBotContext')).toBe(false)

      const rootRequests = world.model.laneRequests('golden-root')
      expect(rootRequests).toHaveLength(3)
      for (const request of rootRequests) expect(request.systemPrompt).toBe(root.output)
      expect(await systemDeltas(await session.currentConversation())).toHaveLength(1)
      expect((await resultOf(session, 1, 'r-agent')).text).toBe('built')
      expect(world.t.warnings).toEqual([])
    },
    TIMEOUT
  )

  it(
    'J8-02 bot root → coding child (AG-5): the bot section stays on the root; the child gets the plain spawned golden',
    async () => {
      const root = fixtures.get('bot-root-all-injections')!
      const { sw, seamCalls } = await goldenWorld('bot-root-all-injections')
      const { world } = sw
      const session = await sw.open(SID)
      world.model.chatIn('golden-root', CODING_CALL, answer('done'))
      world.model.chatIn('golden-child', answer('built'))
      expect(await withTimeout(session.submitUser('go'), 8000, 'go')).toEqual({})

      const rootRequests = world.model.laneRequests('golden-root')
      for (const request of rootRequests) expect(request.systemPrompt).toBe(root.output)
      const [child] = world.model.laneRequests('golden-child')
      expect(child!.systemPrompt).toBe(SPAWNED.output)
      const sections = systemMessages(child!.messages)[0]!.sections ?? {}
      expect(Object.keys(sections)).not.toContain(PROMPT_SECTION_KEY.bot)
      expect(child!.systemPrompt).not.toContain('<bot_profile')
      // bot 段落冻结在根上：上锁时渲染一次，之后的请求不再调（没有重新上锁，也就没有比对）
      expect(rootRequests.length).toBeGreaterThan(1)
      expect(seamCalls.filter(([name]) => name === 'resolveBotContext')).toEqual([
        ['resolveBotContext', [SID, undefined]]
      ])
      expect((await resultOf(session, 1, 'r-agent')).text).toBe('built')
    },
    TIMEOUT
  )

  it(
    'J8-03 [SQLite] the child persona stays frozen across a crash even when the spawned blocks change',
    async () => {
      const { sw, contexts, seamCalls, spawnedBlocks } = await goldenWorld(
        'coding-root-all-injections'
      )
      const { world } = sw
      const session = await sw.open(SID)
      const stall = stalled()
      world.model.chatIn('golden-root', CODING_CALL)
      world.model.chatIn('golden-child', stall.step)
      void session.submitUser('go')
      await withTimeout(stall.reached, 3000, 'child request')
      spawnedBlocks.value = {
        ...spawnedBlocks.value,
        environment: spawnedBlocks.value.environment!.replace('2026-10-04', '2030-01-01')
      }
      expect(spawnedBlocks.value.environment).toContain('2030-01-01')
      await withTimeout(sw.restart(), 10000, 'restart')

      const contextsBefore = contexts.length
      const seamsBefore = seamCalls.length
      const reopened = await sw.open(SID)
      world.model.chatIn('golden-child', answer('built'))
      world.model.chatIn('golden-root', answer('done'))
      expect(await withTimeout(reopened.continue(), 8000, 'continue')).toEqual({})

      const [child] = world.model.laneRequests('golden-child')
      expect(child!.systemPrompt).toBe(SPAWNED.output)
      expect(contexts.length).toBe(contextsBefore)
      // 根的段落冻结着、锁也留着（被中断的工作保住了锁，没有重新上锁）：重开之后根一次都不调 seam；子 agent 的
      // 活段落照旧按根会话 id 解析（cwd 为空）
      const after = seamCalls.slice(seamsBefore)
      for (const [name, args] of after) {
        expect(args[0]).toBe(SID)
        expect(name).not.toBe('resolveBotContext')
        if (name === 'resolveInstruction') expect(args[1]).toBe('')
      }
      const rootOutput = fixtures.get('coding-root-all-injections')!.output
      const rootRequests = world.model.laneRequests('golden-root')
      expect(rootRequests.length).toBeGreaterThan(0)
      for (const request of rootRequests) expect(request.systemPrompt).toBe(rootOutput)
      expect((await resultOf(reopened, 1, 'r-agent')).text).toBe('built')
    },
    RECOVERY_TIMEOUT
  )
})
