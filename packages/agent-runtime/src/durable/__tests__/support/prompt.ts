/**
 * 系统提示词分段的测试辅助：黄金 fixture 的读取、按 fixture 输入搭的 PromptHost（记下每个 seam 的
 * 调用参数），以及「冻结人设 + 选段落 + 配模型」一步到位的对话准备。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Message, SystemMessage } from '@earendil-works/pi-ai'
import type { Conversation, Extension } from '@earendil-works/pi-durable'
import { SessionStateDoc } from '../../docs'
import { lockRecordJson, type LockRecord } from '../../lock'
import type { AgentKind, PromptVars } from '../../../agentProfile/promptVars'
import type { InProcessAgentType } from '../../../subagent/types'
import { backgroundContext as BG } from '../../context'
import { freezePersona, type FrozenAgentPrompt } from '../../prompt/persona'
import type { BotContextBlocks, PromptHost } from '../../seams'
import type { FauxKit } from './faux'

export const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../fixtures/system-prompts'
)

type Resolver<T> = { implemented: false } | { implemented: true; returns: T }

export interface GoldenFixture {
  case: string
  description: string
  inputs: {
    kind: AgentKind
    sessionId: string
    rootSessionId: string
    cwd: string
    profile: InProcessAgentType & { instructionFiles: string[]; projectAwareness: boolean }
    toolOverlay: string[]
    promptVars: PromptVars
    resolvers: {
      resolveInstruction: Resolver<{ filename: string; content: string } | null>
      resolveProjectPrompt: Resolver<string | null>
      resolveKnowledgeBases: Resolver<string | null>
      resolveProjectMemory: Resolver<string | null>
    }
    systemContext: string[]
  }
  observed: {
    promptVarsCtx: { sessionId: string; kind: AgentKind; cwd: string; toolNames: string[] }
    resolverCalls: Record<string, unknown[]>
    warnings: string[]
  }
  output: string
  parts: { name: string; text: string }[]
}

export function loadGoldenFixtures(): GoldenFixture[] {
  return readdirSync(FIXTURE_DIR)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => JSON.parse(readFileSync(join(FIXTURE_DIR, file), 'utf-8')) as GoldenFixture)
}

/** seam 名 → 最近一次调用的参数（每个 seam 每次请求恰调一次时就是那一次） */
export type SeamCalls = Record<string, unknown[]>

/** 按 fixture 的 resolver 记录搭宿主：未实现 → 不提供 seam；bot 段落由 systemContext 喂 */
export function fixturePromptHost(
  fixture: GoldenFixture,
  calls: SeamCalls,
  counts: Record<string, number> = {}
): PromptHost {
  const { resolvers, systemContext } = fixture.inputs
  const note = (name: string, args: unknown[]): void => {
    calls[name] = args
    counts[name] = (counts[name] ?? 0) + 1
  }
  const host: PromptHost = {}
  if (resolvers.resolveInstruction.implemented) {
    const value = resolvers.resolveInstruction.returns
    host.resolveInstruction = (sessionId, cwd, candidates) => {
      note('resolveInstruction', [sessionId, cwd, [...candidates]])
      return value
    }
  }
  if (resolvers.resolveProjectPrompt.implemented) {
    const value = resolvers.resolveProjectPrompt.returns
    host.resolveProjectPrompt = (sessionId) => {
      note('resolveProjectPrompt', [sessionId])
      return value
    }
  }
  if (resolvers.resolveKnowledgeBases.implemented) {
    const value = resolvers.resolveKnowledgeBases.returns
    host.resolveKnowledgeBases = (sessionId) => {
      note('resolveKnowledgeBases', [sessionId])
      return value
    }
  }
  if (resolvers.resolveProjectMemory.implemented) {
    const value = resolvers.resolveProjectMemory.returns
    host.resolveProjectMemory = (sessionId) => {
      note('resolveProjectMemory', [sessionId])
      return value
    }
  }
  const blocks: BotContextBlocks = systemContext.length === 1 ? systemContext[0] : systemContext
  host.resolveBotContext = (sessionId) => {
    note('resolveBotContext', [sessionId])
    return blocks
  }
  return host
}

/**
 * 手写一条锁记录（不经 `createAgent`）：段落用例自己冻结人设、自己选扩展，再把会话标成「已锁」，
 * 好让下一次发送不再自动创建 agent（K3）把它们的配置整份覆盖掉。记录形状合法 —— 重开时照常重建。
 */
export async function markLocked(
  conversation: Conversation,
  kit: FauxKit,
  extensions: readonly { readonly name: string }[] = [],
  identity: Pick<FrozenAgentPrompt, 'kind' | 'profileName'> = { kind: 'root', profileName: 'test' }
): Promise<void> {
  const record: LockRecord = {
    conversationId: conversation.id,
    profileName: identity.profileName,
    kind: identity.kind,
    model: { ...kit.model },
    toolNames: [],
    extensions: extensions.map((extension) => extension.name),
    sandboxed: false,
    mcp: {},
    skills: [],
    createdAt: 0
  }
  await conversation.commit(async (tx) => {
    ;(await tx.doc(SessionStateDoc)).lock = lockRecordJson(record)
  }, BG)
}

/** 冻结人设 + 选择段落扩展 + 配 faux 模型 + 标成已锁（手工版的 P1-09 锁） */
export async function lockPrompt(
  conversation: Conversation,
  kit: FauxKit,
  frozen: FrozenAgentPrompt,
  extensions: readonly Extension[],
  cwd?: string
): Promise<void> {
  await conversation.commit((tx) => freezePersona(tx, conversation.id, frozen), BG)
  await conversation.configure({ model: kit.model, extensions, ...(cwd ? { cwd } : {}) }, BG)
  await markLocked(conversation, kit, extensions, frozen)
}

/** 一个最小的待冻结记录（不经变量表） */
export function frozenPrompt(overrides: Partial<FrozenAgentPrompt> = {}): FrozenAgentPrompt {
  return {
    kind: 'root',
    profileName: 'work',
    rootSessionId: 's1',
    persona: '## Persona\n\nYou are a test agent.',
    instructionFiles: ['AGENTS.md'],
    ...overrides
  }
}

/** 一次请求里的 system 消息 */
export function systemMessages(messages: readonly Message[]): SystemMessage[] {
  return messages.filter((message): message is SystemMessage => message.role === 'system')
}
