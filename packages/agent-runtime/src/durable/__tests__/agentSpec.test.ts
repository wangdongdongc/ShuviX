/**
 * agent 规格的纯派生（durable/agentSpec.ts）：思考档位与工具名单的 root·spawned 决策表。
 *
 * 断言直接落在 `resolveThinkingLevel` / `normalizeToolNames` 上（锁与协调器各取这两个函数）。初始模型那一行
 *（`shuvix-model` 的解析、不可用回落、告警、没有 seam 时静默回落、与思考一行互不牵连）随旧的
 * `deriveAgentSpec` 一起退场（P2-13），由协调器的 `spawn.model.test.ts`（P2-03-17..23）在真实派生路径上钉。
 * 系统提示词的注入规则由 `promptSections.test.ts` / `persona.test.ts` 钉。
 */
import { describe, it, expect } from 'vitest'
import type { ThinkingLevel } from '@shuvix/chat-protocol/types/thinking'
import { normalizeToolNames, resolveThinkingLevel } from '../agentSpec'
import type { InProcessAgentType } from '../../subagent/types'
import { buildBuiltinProfile, PERMISSION_REVIEWER_SPEC } from '../../subagent/builtinAgents'
import { createInlineMdReader } from '../../subagent/builtinAgents/inlineSources'
import { toInProcessAgentType } from '../../subagent/dispatchTool'

// ── fakes ──
const PROFILE: InProcessAgentType = {
  name: 'default',
  displayName: 'Default',
  description: '',
  tools: ['read', 'grep', 'agent'],
  systemPrompt: 'BASE {{shuvix:persona}}',
  instructionFiles: ['AGENTS.md', 'CLAUDE.md']
}

describe('resolveThinkingLevel / normalizeToolNames — root 决策列', () => {
  it('root：思考档位就是传入值（会话设置）', () => {
    expect(resolveThinkingLevel('root', PROFILE, 'medium')).toBe('medium')
  })

  it('归一名单保序去重、root overlay 只收 mcp:/skill:', () => {
    // bash 不在档案白名单里：勾选里混进的内置名不能借 overlay 越过档案
    expect(
      normalizeToolNames('root', PROFILE.tools, ['mcp:ctx', 'bash', 'skill:pdf', 'mcp:ctx'])
    ).toEqual(['read', 'grep', 'agent', 'mcp:ctx', 'skill:pdf'])
  })
})

/**
 * 决策表的思考一行（`shuvix-thinking`）：
 *   - spawned：档案声明压过派发方传入的档位 —— 派生 agent 没有思考选择器，档案是唯一能说话的地方；
 *     没声明 → 随派发方；
 *   - root：以传入值为准（会话设置）。档案的声明只在钉档案时作为种子写进去 —— 每次重建都按档案覆盖，
 *     会把用户在会话里手选的档位默默还原。
 */
describe('resolveThinkingLevel — 档案思考档位（shuvix-thinking）', () => {
  it.each<[string, ThinkingLevel, ThinkingLevel]>([
    ['声明 off / 派发方 high', 'off', 'high'],
    ['声明 xhigh / 派发方 off', 'xhigh', 'off']
  ])('TH-1 spawned 且档案声明（%s）：运行时档位 = 声明值，压过派发方', (_label, declared, dispatcher) => {
    // 两个方向都要：只测「往低压」的话，一个「取两者较低者」的实现也能蒙混过去
    expect(resolveThinkingLevel('spawned', { ...PROFILE, thinkingLevel: declared }, dispatcher)).toBe(
      declared
    )
  })

  it('TH-2 spawned 且未声明：运行时档位 = 派发方传入的', () => {
    expect(resolveThinkingLevel('spawned', PROFILE, 'low')).toBe('low')
  })

  it('TH-3 root：档案声明 off、会话传入 high → high（会话设置为准，档案不在重建时覆盖用户的选择）', () => {
    expect(resolveThinkingLevel('root', { ...PROFILE, thinkingLevel: 'off' }, 'high')).toBe('high')
  })
})

/**
 * 工具名单归一（TN）—— 档案 `shuvix-tools` 声明的一切（内置名 / mcp: / skill:）对 root 与 spawned
 * **恒生效**；root 会话的勾选（overlay，只收 mcp:/skill:）只能往上**加**：既去不掉档案声明的
 * 项，也带不进一个内置工具名。同一份名单喂给人设冻结时的变量表（`promptVars` 的 `toolNames`）与工具解析
 *（都在锁里，见 lock.create.test.ts）。
 */
describe('normalizeToolNames —— 工具名单归一（TN）', () => {
  /** P：内置名、mcp、skill、派发四类各一 */
  const P = ['read', 'mcp:prof', 'skill:prof', 'agent']

  it('TN-1 root 带勾选：档案声明的 mcp:/skill: 原位留着，勾选的接在末尾', () => {
    expect(normalizeToolNames('root', P, ['skill:sel'])).toEqual([
      'read',
      'mcp:prof',
      'skill:prof',
      'agent',
      'skill:sel'
    ])
  })

  it('TN-2 root 不带勾选 / 勾选为空：档案全量照样生效 —— 勾选去不掉档案声明的项', () => {
    for (const overlay of [undefined, []]) {
      expect(normalizeToolNames('root', P, overlay), JSON.stringify(overlay)).toEqual(P)
    }
  })

  it('TN-3 root 勾选里的脏数据：声明项保位、重复塌缩、内置名（bash / write / read）一个都进不来', () => {
    const names = normalizeToolNames('root', P, [
      'skill:prof',
      'bash',
      'mcp:new',
      'write',
      'read',
      'mcp:prof',
      'mcp:new'
    ])
    expect(names).toEqual(['read', 'mcp:prof', 'skill:prof', 'agent', 'mcp:new'])
    // 勾选混进内置名（手改的设置、被新会话继承的项目配置）不能借 overlay 越过档案
    expect(names).not.toContain('bash')
    expect(names).not.toContain('write')
    expect(names.filter((n) => n === 'read')).toHaveLength(1)
  })

  it('TN-4 spawned 没有勾选：名单恰为档案全量、保持档案顺序；root 不带勾选时与之逐项相同', () => {
    const spawned = normalizeToolNames('spawned', P, undefined)
    expect(spawned).toEqual(P)
    // 同一条规则：档案写了什么，这个 agent 就带什么 —— 不再分 root / spawned 两套
    expect(normalizeToolNames('root', P, undefined)).toEqual(spawned)
  })
})

/**
 * 内置权限审查员（permission-reviewer）走同一张决策表 —— 它的「什么都不要」全由档案表达，这里验的是
 * 决策表照办：工具名单为空、档位按档案压到 low。
 */
describe('决策表 —— 内置权限审查员（permission-reviewer）', () => {
  it('PRV-C1 内置 md → toInProcessAgentType → spawned：名单为空；派发方 high → 运行时 low', () => {
    const built = buildBuiltinProfile(PERMISSION_REVIEWER_SPEC, { readMd: createInlineMdReader() })
    expect(built).not.toBeNull()
    const profile = toInProcessAgentType(built!)

    expect(normalizeToolNames('spawned', profile.tools, undefined)).toEqual([])
    // 档案的 shuvix-thinking: low 压过派发方的 high
    expect(resolveThinkingLevel('spawned', profile, 'high')).toBe('low')
  })
})
