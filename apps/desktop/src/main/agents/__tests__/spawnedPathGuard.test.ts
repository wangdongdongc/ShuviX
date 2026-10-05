/**
 * P2-05-51（PIN-18）：派发不再经旧的派生创建管线。源码扫描（产品代码，排除 __tests__）。旧管线
 *（`agentFactory` / `createAgentFactory`，agentProfile/createAgent.ts）已由 P2-13 删掉，关于它们的前两条随之去掉：
 *
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

  it('subagent/manager.ts carries no TODO(pi-durable p2); agentHost.ts has no dispatchModelConfig', () => {
    expect(readFileSync(join(RUNTIME, 'subagent/manager.ts'), 'utf8')).not.toContain(
      'TODO(pi-durable p2)'
    )
    expect(readFileSync(join(MAIN, 'agents/agentHost.ts'), 'utf8')).not.toContain(
      'dispatchModelConfig'
    )
  })

  it('P2-08-52 the Q16 debt is paid: permissionReview.ts and the hook runner carry no p2 marker; nothing throws PhasePendingError for host dispatch', () => {
    for (const path of [
      join(MAIN, 'services/permissionReview.ts'),
      join(RUNTIME, 'hook/hookRunner.ts'),
      join(RUNTIME, 'durable/spawn.ts')
    ]) {
      expect(readFileSync(path, 'utf8')).not.toContain('TODO(pi-durable p2)')
    }
    expect(filesContaining("'host-dispatched agents'")).toEqual([])
  })
})
