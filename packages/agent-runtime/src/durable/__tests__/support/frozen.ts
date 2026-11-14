/**
 * 系统提示词冻结（2026-11-06）用例的共用夹具：场景 W 换上带日期 / 版本 / 系统的 `environment` 块与一个可变来源的
 * PromptHost（`support/prompt.ts` 的 `sourceHost`），外加第一次上锁时的期望文本。lock.persona / lock.promptStatus /
 * durableSession.rebuildSystemPrompt 共用。
 */
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { expect } from 'vitest'
import type { PromptBlockTexts } from '../../../agentProfile/promptBlocks'
import { normalizeToolNames } from '../../agentSpec'
import { backgroundContext as BG } from '../../context'
import { AgentStateDoc, type AgentStateRecord } from '../../docs'
import type { DurableSession } from '../../durableSession'
import { fenceInstructionFile, fenceKnowledgeBases, fenceProjectPrompt } from '../../prompt/fences'
import { personaKeyOf } from '../../prompt/persona'
import type { AgentConfig } from '../../seams'
import { scenarioConfig, W_CWD } from './agentConfig'
import { answer } from './faux'
import type { TestHost, TestHostOptions } from './host'
import { sourceHost, type SourceHost } from './prompt'
import { scenarioW } from './scenario'
import { allEntries } from './transcript'
import { withTimeout } from './wait'

export const REUSED_LOG = 'reusing the frozen system prompt'

/** `environment` 块里会随环境变的那几项（日期、版本、系统），外加调用次数 */
export interface EnvVars {
  readonly state: { date: string; appVersion: string; os: string; calls: number }
  promptBlocks: () => PromptBlockTexts
}

/** 这几项渲染成的 `environment` 块正文 */
export function environmentText(state: { date: string; appVersion: string; os: string }): string {
  return `- OS: ${state.os}\n- Current date: ${state.date}\n- ShuviX version: ShuviX ${state.appVersion}`
}

export function envVars(): EnvVars {
  const state = { date: '2026-11-05', appVersion: '0.2.56', os: 'Darwin 25.0.0', calls: 0 }
  return {
    state,
    promptBlocks: () => {
      state.calls++
      return { environment: environmentText(state) }
    }
  }
}

/** 换一天、升一次级、换一次系统 */
export function driftEnvironment(vars: EnvVars, day: string): void {
  vars.state.date = day
  vars.state.appVersion = `0.2.${day.slice(-2)}`
  vars.state.os = `Darwin 25.${day.slice(-2)}.0`
}

export const BODY = 'You are M1.'
/** 第一次上锁时的人设：正文 + 那一刻的 `environment` 块 */
export const PERSONA_1 = `${BODY}\n\n<environment>\n${environmentText({
  date: '2026-11-05',
  appVersion: '0.2.56',
  os: 'Darwin 25.0.0'
})}\n</environment>`

/** 场景 W 的三段（指令文件 AGENTS.md、项目提示词、知识库）按 sourceHost 的初始值 */
export const SECTIONS_A = {
  agents_md: fenceInstructionFile('AGENTS.md', 'Use pnpm.'),
  project_prompt: fenceProjectPrompt('Acme billing.'),
  knowledge_bases: fenceKnowledgeBases('Bases: notes.')
}
/** 第一次上锁时三段 seam 各一次（场景 W：清单 AGENTS.md、工作目录 /work/acme） */
export const RENDER_CALLS_A = [`instructions:s1:${W_CWD}:AGENTS.md`, 'project:s1', 'knowledge:s1']

/** 人设 + 段落（固定次序，null 跳过）拼成的系统提示词 */
export function promptOf(persona: string, sections: Record<string, string | null>): string {
  const order = [
    'placeholders',
    'agents_md',
    'claude_md',
    'project_prompt',
    'knowledge_bases',
    'bot_profile'
  ]
  return [persona, ...order.map((key) => sections[key]).filter((text) => typeof text === 'string')]
    .filter((text) => text !== '')
    .join('\n\n')
}

/** 三个来源全改 */
export function changeAllSources(sources: SourceHost): void {
  sources.values.files = { 'AGENTS.md': 'Use npm.' }
  sources.values.projectPrompt = 'Acme billing, v2.'
  sources.values.knowledge = 'Bases: recipes.'
}

/** 这份配置此刻的人设摘要（与锁里同一算法） */
export function keyOf(config: AgentConfig): string {
  return personaKeyOf({
    kind: 'root',
    cwd: config.cwd ?? '',
    profile: config.profile,
    toolNames: normalizeToolNames('root', config.profile.tools, config.toolOverlay)
  })
}

export interface FrozenScenario {
  t: TestHost
  vars: EnvVars
  config: AgentConfig
  sources: SourceHost
}

/** 场景 W：人设带一个写着日期 / 版本 / 系统的 `environment` 块，段落来自一个可变来源的宿主 */
export async function envScenario(
  options: {
    edit?: (config: AgentConfig) => void
    sources?: SourceHost
    host?: Partial<TestHostOptions>
  } = {}
): Promise<FrozenScenario> {
  const config = scenarioConfig()
  config.profile = { ...config.profile, systemPrompt: BODY }
  options.edit?.(config)
  const vars = envVars()
  const sources = options.sources ?? sourceHost()
  const { t } = await scenarioW({
    config,
    promptBlocks: vars.promptBlocks,
    promptHost: sources.host,
    ...options.host
  })
  return { t, vars, config, sources }
}

export async function stateOf(
  session: DurableSession,
  conversationId: number = ROOT_CONVERSATION_ID
): Promise<AgentStateRecord | undefined> {
  return session.harness.snapshot(AgentStateDoc, conversationId as never, BG)
}

export async function send(t: TestHost, session: DurableSession, text: string): Promise<void> {
  t.kit.queue(answer(`re:${text}`))
  expect(await withTimeout(session.submitUser(text), 5000, `send ${text}`)).toEqual({})
}

/** 当前对话里看得见的用户条目 id，最旧在前 */
export async function userEntryIds(session: DurableSession): Promise<number[]> {
  return (await allEntries(await session.currentConversation()))
    .filter((entry) => entry.kind === 'pi.user')
    .map((entry) => entry.id as number)
}
