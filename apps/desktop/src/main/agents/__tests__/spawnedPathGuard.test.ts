/**
 * P2-05-51（PIN-18）：派发不再经旧的派生创建管线。源码扫描（产品代码，排除 __tests__），直到 P2-13 删掉
 * `agentFactory` / `createAgentFactory` —— 那时去掉第一、二条：
 *
 *  - `agentFactory` 只在 agents/agentHost.ts 里出现（定义它的地方；AgentManager 不再引它）；
 *  - `createAgentFactory(` 只在它的定义（agentProfile/createAgent.ts）与 agentHost.ts 里；
 *  - subagent/manager.ts 里没有 `TODO(pi-durable p2)`；
 *  - agentHost.ts 里没有 `dispatchModelConfig`（派发工具的调用方从 api 读，PIN-16）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const MAIN = join(HERE, '../..')
const RUNTIME = join(HERE, '../../../../../../packages/agent-runtime/src')

function sources(root: string): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) {
        if (name === '__tests__' || name === 'node_modules') continue
        walk(path)
      } else if (/\.tsx?$/.test(name)) found.push(path)
    }
  }
  walk(root)
  return found
}

function filesContaining(needle: string): string[] {
  return [...sources(MAIN), ...sources(RUNTIME)]
    .filter((path) => readFileSync(path, 'utf8').includes(needle))
    .map((path) =>
      path.startsWith(RUNTIME)
        ? `runtime/${relative(RUNTIME, path).split(sep).join('/')}`
        : `main/${relative(MAIN, path).split(sep).join('/')}`
    )
    .sort()
}

describe('P2-05-51 no callers of the old spawned path', () => {
  it('the scan sees both trees (control)', () => {
    expect(filesContaining('createSubAgentManager')).toEqual(
      expect.arrayContaining(['main/agents/AgentManager.ts', 'runtime/subagent/manager.ts'])
    )
  })

  it('agentFactory is referenced only in agents/agentHost.ts', () => {
    expect(filesContaining('agentFactory')).toEqual(['main/agents/agentHost.ts'])
  })

  it('createAgentFactory( appears only in its definition and agentHost.ts', () => {
    expect(filesContaining('createAgentFactory(')).toEqual([
      'main/agents/agentHost.ts',
      'runtime/agentProfile/createAgent.ts'
    ])
  })

  it('subagent/manager.ts carries no TODO(pi-durable p2); agentHost.ts has no dispatchModelConfig', () => {
    expect(readFileSync(join(RUNTIME, 'subagent/manager.ts'), 'utf8')).not.toContain(
      'TODO(pi-durable p2)'
    )
    expect(readFileSync(join(MAIN, 'agents/agentHost.ts'), 'utf8')).not.toContain(
      'dispatchModelConfig'
    )
  })
})
