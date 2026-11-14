/**
 * 会话配置（`resolveAgentConfig`）与人设提示词块的测试桩，外加 faux 的模型目录、场景 W 的完整配置。
 *
 * 配置是一份可变对象（相当于 DB 里的会话设置 —— 重启之后还是那份）：用例改它，下一次创建就读到新值；
 * 调用次数由测试宿主按进程记（`TestHost.configCalls`）。人设正文 `You are` 后面跟宿主渲染的
 * `environment` 块，块正文是一个可变的 marker（{@link markerPersona}），用来看人设是不是在创建那一刻冻结的。
 */
import type { PromptBlockTexts } from '../../../agentProfile/promptBlocks'
import type { InProcessAgentType } from '../../../subagent/types'
import type { McpToolDeclaration } from '../../../mcpManager'
import { piProviderIdOf } from '../../../models/port'
import type { AgentConfig, ModelCatalog } from '../../seams'
import { builtinRow, fakePort, type FakePort } from '../../../models/__tests__/fakePort'
import type { FauxKit } from './faux'
import { mcpDecl } from './mcpFake'
import type { TestToolHostOptions } from './toolHost'

/** 档案（只给要的字段，其余补缺省） */
export function testProfile(overrides: Partial<InProcessAgentType> = {}): InProcessAgentType {
  return {
    name: 'test',
    displayName: 'Test',
    description: '',
    tools: [],
    systemPrompt: '',
    ...overrides
  }
}

/** K15 的缺省测试配置：空档案（人设为空 → 没有 system 段落）、faux/faux-1 */
export function defaultAgentConfig(): AgentConfig {
  return {
    profile: testProfile(),
    model: { provider: 'faux', modelId: 'faux-1' }
  }
}

/** marker 人设的档案正文（块在它后面） */
export const MARKER_BODY = 'You are'

/** 人设 = 正文 + `environment` 块（块正文是 marker）—— `composePersona` 的口径，手写一份作对照 */
export function markerPersona(marker = 'M1', body = MARKER_BODY): string {
  return `${body}\n\n<environment>\n${marker}\n</environment>`
}

/** 可变的人设提示词块：`promptBlocks` 现读 `state.marker` 作 `environment` 块；`state.fail` 给了就抛它；`calls` 记调用次数 */
export interface MarkerVars {
  readonly state: { marker: string; fail?: string; calls: number }
  promptBlocks: () => PromptBlockTexts
}

export function markerVars(marker = 'M1'): MarkerVars {
  const state: MarkerVars['state'] = { marker, calls: 0 }
  return {
    state,
    promptBlocks: () => {
      state.calls++
      if (state.fail !== undefined) throw new Error(state.fail)
      return { environment: state.marker }
    }
  }
}

/** faux 的模型目录：provider 行来自 `port`（缺省一条内置行 `faux`），模型来自套件 */
export function fauxCatalog(kit: FauxKit, port: FakePort): ModelCatalog {
  return {
    registry: {
      models: kit.models,
      modelRefOf: (rowId, modelId) => {
        const row = port.rows.find((candidate) => candidate.id === rowId)
        const provider = row ? piProviderIdOf(row) : undefined
        return provider ? { provider, id: modelId } : undefined
      }
    },
    port
  }
}

export function fauxPort(): FakePort {
  return fakePort([builtinRow('faux')])
}

// ─────────────────────────── 场景 W ───────────────────────────

export const W_PROFILE_TOOLS = [
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
  'skill'
]

export const W_CWD = '/work/acme'

export const DECL_RESOLVE: McpToolDeclaration = mcpDecl('resolve', 'Resolve a library id')
export const DECL_DOCS: McpToolDeclaration = mcpDecl('docs', 'Fetch library docs')

/** E_W：场景 W 里提供给模型的工具，按次序 */
export const E_W = [
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
  'mcp__ctx__resolve',
  'mcp__ctx__docs'
]

/** 场景 W 的会话配置（新对象，可随意改） */
export function scenarioConfig(): AgentConfig {
  return {
    profile: testProfile({
      name: 'work',
      displayName: 'Work',
      tools: [...W_PROFILE_TOOLS],
      systemPrompt: MARKER_BODY,
      promptBlocks: ['environment', 'agents_md', 'project_prompt']
    }),
    toolOverlay: ['mcp:ctx'],
    model: { provider: 'faux', modelId: 'faux-1' },
    thinkingLevel: 'low',
    cwd: W_CWD
  }
}

/** 场景 W 的 ToolHost 选项（内置集、技能、假 MCP 服务器 ctx / ssh / broken、沙箱开） */
export function scenarioToolHost(
  overrides: Partial<TestToolHostOptions> = {}
): TestToolHostOptions {
  return {
    scenario: 'w',
    platform: 'darwin',
    skills: ['builtin:drawing', 'pdf'],
    mcp: {
      ctx: [DECL_RESOLVE, DECL_DOCS],
      ssh: [mcpDecl('exec', 'Run a remote command')],
      broken: [mcpDecl('noop')],
      other: [mcpDecl('unused')],
      new: [mcpDecl('fresh')]
    },
    sandbox: true,
    ...overrides
  }
}
