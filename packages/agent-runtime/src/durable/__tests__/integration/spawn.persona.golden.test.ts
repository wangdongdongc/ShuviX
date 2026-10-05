/**
 * P2-11 · J8：每个对话自己的人设黄金（PIN-08）。同一条会话里根 agent 按根 fixture、派出的 coding 子 agent 按
 * `coding-spawned-all-injections` 逐字节出系统提示词：人设在创建那一刻冻结（变量表按 `ctx.kind` 取各自的
 * fixture 值），活段落按根会话 id 现调宿主 seam（子 agent 的 cwd 为空）；bot 段落只给 bot 档案的根。
 */
import type { PromptVars, PromptVarsCtx } from '../../../agentProfile/promptVars'
import { afterEach, describe, expect, it } from 'vitest'
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
  releaseHolds,
  resultOf,
  spawnWorld,
  type SpawnWorld
} from './support/spawnWorld'
import { registerWorldCleanup } from './support/world'

registerHostCleanup()
registerWorldCleanup()
afterEach(() => releaseHolds())

const TIMEOUT = 15000
const RECOVERY_TIMEOUT = 20000
const SID = 'sess-golden-root'
const fixtures = new Map(loadGoldenFixtures().map((fixture) => [fixture.case, fixture]))
const SPAWNED = fixtures.get('coding-spawned-all-injections')!

const PART_KEY: Record<string, string> = {
  persona: PROMPT_SECTION_KEY.persona,
  instructionFile: PROMPT_SECTION_KEY.instructions,
  projectPrompt: PROMPT_SECTION_KEY.projectPrompt,
  knowledgeBases: PROMPT_SECTION_KEY.knowledge,
  projectMemory: PROMPT_SECTION_KEY.memory,
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
  /** 变量表收到的上下文（按次序） */
  contexts: PromptVarsCtx[]
  /** 每次宿主 seam 调用：[名字, 参数]（按次序，跨进程） */
  seamCalls: [string, unknown[]][]
  /** 派生变量表（可改：J8-03 改日期） */
  spawnedVars: { value: PromptVars }
}

/** 黄金世界（设计 §1.9）：会话 `sess-golden-root`，根与子共用 fixture 的 PromptHost，按 fixture 输出路由 */
async function goldenWorld(rootCase: string): Promise<GoldenWorld> {
  const root = fixtures.get(rootCase)!
  const contexts: PromptVarsCtx[] = []
  const seamCalls: [string, unknown[]][] = []
  const spawnedVars = { value: structuredClone(SPAWNED.inputs.promptVars) }
  const fixtureHost = fixturePromptHost(root, {}, {})
  const promptHost: PromptHost = {}
  for (const [name, seam] of Object.entries(fixtureHost)) {
    ;(promptHost as Record<string, unknown>)[name] = (...args: unknown[]) => {
      seamCalls.push([name, args.map((arg) => (Array.isArray(arg) ? [...arg] : arg))])
      return (seam as (...a: unknown[]) => unknown)(...args)
    }
  }
  const coding: AgentProfile = {
    ...structuredClone(SPAWNED.inputs.profile),
    source: 'builtin',
    basePath: ''
  }
  const sw = await spawnWorld({
    profileObjects: [coding],
    host: {
      promptHost,
      promptVars: (ctx) => {
        contexts.push(structuredClone(ctx))
        return ctx.kind === 'spawned' ? spawnedVars.value : root.inputs.promptVars
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
  return { sw, contexts, seamCalls, spawnedVars }
}

const CODING_CALL = callTool(
  'agent',
  { name: 'coding', prompt: 'build it', description: 'code' },
  'r-agent'
)

function childSeamCalls(seamCalls: [string, unknown[]][]): Record<string, unknown[]> {
  const found: Record<string, unknown[]> = {}
  for (const [name, args] of seamCalls) {
    if (name === 'resolveInstruction' && args[1] !== '') continue
    if (name !== 'resolveBotContext') found[name] = args
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
        { ...SPAWNED.observed.promptVarsCtx, sessionId: A }
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
      expect(seamCalls.filter(([name]) => name === 'resolveBotContext')).toHaveLength(
        rootRequests.length
      )
      expect((await resultOf(session, 1, 'r-agent')).text).toBe('built')
    },
    TIMEOUT
  )

  it(
    'J8-03 [SQLite] the child persona stays frozen across a crash even when the spawned vars change',
    async () => {
      const { sw, contexts, seamCalls, spawnedVars } = await goldenWorld(
        'coding-root-all-injections'
      )
      const { world } = sw
      const session = await sw.open(SID)
      const stall = stalled()
      world.model.chatIn('golden-root', CODING_CALL)
      world.model.chatIn('golden-child', stall.step)
      void session.submitUser('go')
      await withTimeout(stall.reached, 3000, 'child request')
      spawnedVars.value = { ...spawnedVars.value, date: '2030-01-01' }
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
      const after = seamCalls.slice(seamsBefore)
      expect(after.length).toBeGreaterThan(0)
      for (const [, args] of after) expect(args[0]).toBe(SID)
      expect((await resultOf(reopened, 1, 'r-agent')).text).toBe('built')
    },
    RECOVERY_TIMEOUT
  )
})
