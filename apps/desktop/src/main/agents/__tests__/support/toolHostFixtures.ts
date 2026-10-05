/**
 * P1-11 用例的共享夹具（不是用例文件：`support/` 下没有 `.test.ts`）—— 设计稿的 Fx-REG / N_W / R_D /
 * L_D 与 MCP 声明。vi.mock 不能共享（按文件提升），各用例文件自己声明；这里只放纯数据与小工具。
 */
import { Type } from '@earendil-works/pi-ai'
import type { ToolRegistration } from '@earendil-works/pi-durable'
import {
  buildBuiltinProfiles,
  type AgentProfile,
  type AgentToolsRequest,
  type InProcessAgentType,
  type LockRecord,
  type McpToolDeclaration
} from '@shuvix/agent-runtime'
import { createInlineMdReader } from '@shuvix/agent-runtime/builtinAgents/inlineSources'
import type { ToolPlatform } from '@shuvix/chat-protocol/chatApi'
import type { ToolContext } from '../../../services/toolContext'
import { registerBuiltinTool, unregisterBuiltinTool } from '../../../services/toolRegistry'
import { BASH_PLATFORMS, POWERSHELL_PLATFORMS } from '../../../utils/toolUtils/shell'

// ─── Fx-REG：真注册表 + 与真注册项同名同平台的桩 ─────────────────────────

/** 真注册项的名字与平台声明（tools/allTools.ts 的导入次序）；`skill` / `agent` 只有元数据、没有工厂 */
export const REGISTERED: readonly { name: string; platforms?: readonly ToolPlatform[] }[] = [
  { name: 'bash', platforms: BASH_PLATFORMS },
  { name: 'powershell', platforms: POWERSHELL_PLATFORMS },
  { name: 'read' },
  { name: 'write' },
  { name: 'edit' },
  { name: 'ask' },
  { name: 'git' },
  { name: 'artifact' },
  { name: 'session' },
  { name: 'knowledge' },
  { name: 'doc_read' },
  { name: 'doc_edit' },
  { name: 'doc_insert' },
  { name: 'ls' },
  { name: 'grep' },
  { name: 'glob' }
]

/** 只读的那几个（桩工具的 replay 照真工具声明） */
const SAFE = new Set(['read', 'ls', 'grep', 'glob'])

/** 一个桩工具：durable 注册项的形状（名字、描述、空参数、replay、回一段文字） */
export function stubTool(name: string, extra: Record<string, unknown> = {}): ToolRegistration {
  return {
    name,
    description: `${name}: stub`,
    parameters: Type.Object({}),
    replay: SAFE.has(name) ? 'safe' : 'unsafe',
    execute: async () => ({ content: [{ type: 'text', text: `${name} ok` }] }),
    ...extra
  } as ToolRegistration
}

/** 工厂收到的 ctx（按构造次序），注册表桩共用 */
export const factoryCalls: { name: string; ctx: ToolContext }[] = []

/**
 * 往真注册表里注册 Fx-REG 的桩（+ 元数据-only 的 skill / agent）。`factoryFor` 可按名换掉工厂
 * （真 BashTool 之类）。交回反注册函数。
 */
export function registerStubBuiltins(
  factoryFor: Partial<Record<string, (ctx: ToolContext) => object>> = {}
): () => void {
  for (const r of REGISTERED) {
    registerBuiltinTool({
      name: r.name,
      group: 'general',
      platforms: r.platforms,
      getLabel: () => r.name,
      getHint: () => r.name,
      factory: (ctx) => {
        factoryCalls.push({ name: r.name, ctx })
        return factoryFor[r.name]?.(ctx) ?? stubTool(r.name)
      }
    })
  }
  for (const name of ['skill', 'agent']) {
    registerBuiltinTool({
      name,
      group: 'agent',
      hidden: true,
      getLabel: () => name,
      getHint: () => name
    })
  }
  return () => {
    for (const r of REGISTERED) unregisterBuiltinTool(r.name)
    unregisterBuiltinTool('skill')
    unregisterBuiltinTool('agent')
  }
}

// ─── 平台 ─────────────────────────────────────────────────────────────

const REAL_PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform')!

export function setPlatform(platform: string): void {
  Object.defineProperty(process, 'platform', { ...REAL_PLATFORM, value: platform })
}

export function restorePlatform(): void {
  Object.defineProperty(process, 'platform', REAL_PLATFORM)
}

// ─── 档案 ─────────────────────────────────────────────────────────────

export const PROFILES: readonly AgentProfile[] = buildBuiltinProfiles({
  language: 'en',
  widgetsRoot: '/w/widgets',
  readMd: createInlineMdReader()
})

export function profileOf(name: string): AgentProfile {
  const profile = PROFILES.find((p) => p.name === name)
  if (!profile) throw new Error(`builtin profile ${name} did not build`)
  return profile
}

export function inProcess(profile: AgentProfile): InProcessAgentType {
  return {
    name: profile.name,
    displayName: profile.displayName,
    description: profile.description,
    tools: [...profile.tools],
    systemPrompt: profile.systemPrompt,
    model: profile.model,
    thinkingLevel: profile.thinkingLevel,
    instructionFiles: [...profile.instructionFiles],
    projectAwareness: profile.projectAwareness
  }
}

// ─── MCP 声明（Fx-MCP） ───────────────────────────────────────────────

export function decl(name: string, trusted: boolean): McpToolDeclaration {
  return {
    name,
    description: `${name} tool`,
    inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
    annotations: trusted ? { readOnlyHint: true } : undefined,
    trusted
  }
}

export const D_C7: readonly McpToolDeclaration[] = [
  decl('resolve-library-id', false),
  decl('get-library-docs', false)
]

export const D_SSH: readonly McpToolDeclaration[] = [
  'list-hosts',
  'exec',
  'upload',
  'download',
  'sync'
].map((name) => decl(name, true))

/** Fx-MCP 的声明表（服务器名 → 声明）；不在表里的服务器没有工具 */
export const MCP_DECLS: Readonly<Record<string, readonly McpToolDeclaration[]>> = {
  context7: D_C7,
  ssh: D_SSH
}

/** registrationsFromDeclarations 的替身：每条声明一个 `mcp__<s>__<t>`（replay unsafe，带 mcpMeta） */
export function mcpRegistration(server: string, d: McpToolDeclaration): ToolRegistration {
  return {
    name: `mcp__${server}__${d.name}`,
    label: d.description ?? d.name,
    description: d.description ?? '',
    parameters: Type.Unsafe<Record<string, unknown>>(d.inputSchema as Record<string, unknown>),
    replay: 'unsafe',
    mcpMeta: { server, tool: d.name, trusted: d.trusted },
    execute: async () => ({ content: [{ type: 'text', text: `${d.name} ok` }] })
  } as unknown as ToolRegistration
}

// ─── N_W / R_D / L_D ──────────────────────────────────────────────────

/** work-root-darwin 那份 fixture 的归一名单 */
export const N_W: readonly string[] = [
  'bash',
  'powershell',
  'read',
  'write',
  'edit',
  'ask',
  'ls',
  'grep',
  'glob',
  'agent',
  'session',
  'knowledge',
  'artifact',
  'skill:builtin:drawing',
  'mcp:context7',
  'mcp:ssh',
  'skill:pdf'
]

export const MODEL = { provider: 'anthropic', modelId: 'claude-sonnet-4-5' } as const

/** R_D：根 agent 的创建请求（signal 每次新给） */
export function requestD(over: Partial<AgentToolsRequest> = {}): AgentToolsRequest {
  return {
    sessionId: 's1',
    conversationId: 1 as AgentToolsRequest['conversationId'],
    kind: 'root',
    rootSessionId: 's1',
    selfSessionId: 's1',
    profile: inProcess(profileOf('work')),
    names: [...N_W],
    model: { ...MODEL },
    thinkingLevel: 'low',
    cwd: '/w/proj',
    ...over
  }
}

/** L_D：与 R_D 配套的锁记录 */
export function lockD(over: Partial<LockRecord> = {}): LockRecord {
  return {
    conversationId: 1 as LockRecord['conversationId'],
    profileName: 'work',
    kind: 'root',
    model: { ...MODEL },
    thinkingLevel: 'low',
    toolNames: [
      'bash',
      'read',
      'write',
      'edit',
      'ask',
      'ls',
      'grep',
      'glob',
      'session',
      'knowledge',
      'artifact',
      'agent',
      'skill',
      'mcp__context7__resolve-library-id',
      'mcp__context7__get-library-docs'
    ],
    extensions: ['shuvix.builtin', 'shuvix.agent.1'],
    sandboxed: true,
    mcp: { context7: D_C7.map((d) => ({ ...d })) },
    skills: ['builtin:drawing', 'pdf'],
    createdAt: 1,
    ...over
  }
}

/** 一个可控的 deferred */
export interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** 让出几轮微任务（等 Promise.all 里的各路走到下一个 await） */
export async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}
