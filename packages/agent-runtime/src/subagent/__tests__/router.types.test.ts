/**
 * 派生 agent 路由 · 类型契约与删掉的东西（P2-05 G 段，46 / 49 / 50；48 在 baseTool.test.ts RT-1b，51 的源码扫描在
 * 桌面 spawnedPathGuard.test.ts）：RunTaskParams 恰九个键、旧字段一个不剩；路由没有 abortAll / destroyAll /
 * registry；依赖里没有 createAgent / requestUserInput；包入口不再导出旧的血缘登记簿与 spawn 类型。
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, expectTypeOf, it } from 'vitest'
import * as runtime from '../../index'
import type { ToolCallScope } from '../../tools/toolCall'
import type {
  RunTaskOutcome,
  RunTaskOwner,
  RunTaskParams,
  SubAgentManager,
  SubAgentManagerDeps
} from '../manager'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '../..')

describe('router · type contract', () => {
  it('P2-05-49 RunTaskParams has exactly the nine keys; the owner is tool | task | anchor', () => {
    expectTypeOf<keyof RunTaskParams>().toEqualTypeOf<
      | 'sessionId'
      | 'owner'
      | 'agentType'
      | 'prompt'
      | 'description'
      | 'modelConfig'
      | 'resultContract'
      | 'parentToolCallId'
      | 'signal'
    >()
    expectTypeOf<RunTaskOwner>().toEqualTypeOf<
      { readonly tool: ToolCallScope } | { readonly task: number } | { readonly anchor: true }
    >()
    expectTypeOf<keyof RunTaskOutcome>().toEqualTypeOf<
      'result' | 'structured' | 'error' | 'conversationId' | 'agentId'
    >()
  })

  it('P2-05-49 / -46 the dead RunTaskParams fields are gone', () => {
    const base: RunTaskParams = {
      sessionId: 's1',
      owner: { anchor: true },
      agentType: { name: 'x', displayName: 'X', description: '', tools: [], systemPrompt: '' },
      prompt: 'p',
      description: 'd'
    }
    // @ts-expect-error -- parentSessionId → sessionId (P2-05)
    const a: RunTaskParams = { ...base, parentSessionId: 's1' }
    // @ts-expect-error -- parentAbortSignal → signal (P2-05)
    const b: RunTaskParams = { ...base, parentAbortSignal: new AbortController().signal }
    // @ts-expect-error -- contextMessages had no production caller (Q-P2-16)
    const c: RunTaskParams = { ...base, contextMessages: [] }
    // @ts-expect-error -- promptInlineTokens had no production caller (Q-P2-16, PIN-07)
    const d: RunTaskParams = { ...base, promptInlineTokens: {} }
    // @ts-expect-error -- systemContext had no production caller (Q-P2-16; managerSystemContext deleted)
    const e: RunTaskParams = { ...base, systemContext: [] }
    expect([a, b, c, d, e]).toHaveLength(5)
  })

  it('P2-05-49 SubAgentManager has no abortAll / destroyAll / registry; deps have no createAgent / requestUserInput', () => {
    expectTypeOf<SubAgentManager>().not.toHaveProperty('abortAll')
    expectTypeOf<SubAgentManager>().not.toHaveProperty('destroyAll')
    expectTypeOf<SubAgentManager>().not.toHaveProperty('registry')
    expectTypeOf<SubAgentManager>().toHaveProperty('locate')
    expectTypeOf<SubAgentManagerDeps>().not.toHaveProperty('createAgent')
    expectTypeOf<SubAgentManagerDeps>().not.toHaveProperty('requestUserInput')
    expectTypeOf<SubAgentManagerDeps>().not.toHaveProperty('maxAgentDepth')
    expectTypeOf<keyof SubAgentManagerDeps>().toEqualTypeOf<
      'sessions' | 'broadcast' | 'tasks' | 'logger' | 'getAbortedNote'
    >()
  })

  it('P2-05-46 managerSystemContext.test.ts is deleted (MS-5 is superseded by P2-03-20)', () => {
    expect(existsSync(join(SRC, 'subagent/__tests__/managerSystemContext.test.ts'))).toBe(false)
  })
})

describe('router · removed exports (P2-05-50)', () => {
  it('the package index no longer exports the lineage registry or the old depth constant', () => {
    const keys = Object.keys(runtime)
    for (const gone of ['AgentRegistry', 'agentIdOf', 'DEFAULT_MAX_AGENT_DEPTH']) {
      expect(keys, gone).not.toContain(gone)
    }
    expect(runtime.MAX_AGENT_DEPTH).toBe(2)
    expect(runtime.createSubAgentManager).toBeTypeOf('function')
  })

  it('the spawn types are not exported from the index; they live in agentProfile/createAgent until P2-13 (PIN-13)', () => {
    // @ts-expect-error -- SpawnContext moved to agentProfile/createAgent
    type A = runtime.SpawnContext
    // @ts-expect-error -- SpawnedRuntime moved to agentProfile/createAgent
    type B = runtime.SpawnedRuntime
    expectTypeOf<A | B>().toBeAny()
  })

  it('agentRegistry.ts does not exist', () => {
    expect(existsSync(join(SRC, 'agentRegistry.ts'))).toBe(false)
  })
})
