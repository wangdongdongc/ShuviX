/**
 * 场景 W（锁的用例共用）：会话 s1；faux 两个模型 faux-1（窗口 40000）/ faux-2（8000）；可拨的时钟；
 * 场景 W 的会话配置、ToolHost（darwin 内置集、技能 builtin:drawing / pdf、假 MCP ctx [resolve, docs]、
 * 沙箱开）与人设变量表（marker M1）。重启（`t.restart()`）沿用配置 / 变量表 / 时钟，换新的 faux 套件
 * 与 ToolHost。
 */
import { AgentDoc, ROOT_CONVERSATION_ID, type ConversationId } from '@earendil-works/pi-durable'
import { backgroundContext as BG } from '../../context'
import { AgentStateDoc, SessionStateDoc } from '../../docs'
import type { DurableSession } from '../../durableSession'
import type { LockRecord } from '../../lock'
import { PROMPT_EXTENSION } from '../../prompt/sections'
import type { AgentConfig } from '../../seams'
import {
  DECL_DOCS,
  DECL_RESOLVE,
  E_W,
  markerVars,
  scenarioConfig,
  scenarioToolHost,
  type MarkerVars
} from './agentConfig'
import { fauxKit, type FauxKit } from './faux'
import { makeHost, type TestHost, type TestHostOptions } from './host'

/** 场景 W 的「现在」 */
export const W_NOW = 1_760_000_000_000

export function wKit(): FauxKit {
  return fauxKit({
    models: [
      { id: 'faux-1', contextWindow: 40000 },
      { id: 'faux-2', contextWindow: 8000 }
    ]
  })
}

export interface Scenario {
  readonly t: TestHost
  readonly config: AgentConfig
  readonly vars: MarkerVars
  readonly clock: { now: number }
}

export async function scenarioW(
  overrides: Partial<TestHostOptions> & { config?: AgentConfig } = {}
): Promise<Scenario> {
  const { config: givenConfig, ...hostOverrides } = overrides
  const config = givenConfig ?? scenarioConfig()
  const vars = markerVars('M1')
  const clock = { now: W_NOW }
  const t = await makeHost({
    makeKit: wKit,
    toolHost: scenarioToolHost(),
    agentConfig: config,
    promptVars: vars.promptVars,
    now: () => clock.now,
    ...hostOverrides
  })
  return { t, config, vars, clock }
}

/** 场景 W 的扩展清单（`shuvix.agent.<id>` 结尾） */
export function wExtensions(conversationId: ConversationId = ROOT_CONVERSATION_ID): string[] {
  return [
    'shuvix.builtin',
    PROMPT_EXTENSION.persona,
    PROMPT_EXTENSION.instructions,
    PROMPT_EXTENSION.projectPrompt,
    PROMPT_EXTENSION.knowledge,
    PROMPT_EXTENSION.memory,
    `shuvix.agent.${conversationId}`
  ]
}

/** L_W：场景 W 第一次创建的锁记录 */
export function lockW(overrides: Partial<LockRecord> = {}): LockRecord {
  return {
    conversationId: ROOT_CONVERSATION_ID,
    profileName: 'work',
    kind: 'root',
    model: { provider: 'faux', modelId: 'faux-1' },
    thinkingLevel: 'low',
    toolNames: [...E_W],
    extensions: wExtensions(),
    sandboxed: true,
    mcp: { ctx: [DECL_RESOLVE, DECL_DOCS] },
    skills: ['builtin:drawing', 'pdf'],
    selection: ['mcp:ctx', 'skill:pdf'],
    createdAt: W_NOW,
    ...overrides
  }
}

export async function storedLock(session: DurableSession): Promise<unknown> {
  return (await session.harness.snapshot(SessionStateDoc, BG))?.lock
}

export async function piAgent(
  session: DurableSession,
  conversationId: ConversationId = ROOT_CONVERSATION_ID
): Promise<unknown> {
  return session.harness.snapshot(AgentDoc, conversationId, BG)
}

export async function agentState(
  session: DurableSession,
  conversationId: ConversationId = ROOT_CONVERSATION_ID
): Promise<unknown> {
  return session.harness.snapshot(AgentStateDoc, conversationId, BG)
}

/** 某会话注册表里某扩展的工具名（没装 → undefined） */
export function extensionTools(t: TestHost, name: string, sessionId = 's1'): string[] | undefined {
  const extension = t.registryOf(sessionId)?.snapshot().extension(name)
  return extension === undefined ? undefined : (extension.tools ?? []).map((tool) => tool.name)
}

/** 某会话注册表里某工具的描述（按扩展名） */
export function toolDescription(
  t: TestHost,
  extensionName: string,
  toolName: string,
  sessionId = 's1'
): string | undefined {
  return t
    .registryOf(sessionId)
    ?.snapshot()
    .extension(extensionName)
    ?.tools?.find((tool) => tool.name === toolName)?.description
}
