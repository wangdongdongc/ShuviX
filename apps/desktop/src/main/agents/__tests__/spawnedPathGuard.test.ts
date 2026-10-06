/**
 * P2-05-51（PIN-18）：派发不再经旧的派生创建管线。源码扫描（产品代码，排除 __tests__）。旧管线
 *（`agentFactory` / `createAgentFactory`，agentProfile/createAgent.ts）已由 P2-13 删掉，关于它们的前两条随之去掉：
 *
 *  - subagent/manager.ts 里没有 phase 2 的 TODO 标签；
 *  - agentHost.ts 里没有 `dispatchModelConfig`（派发工具的调用方从 api 读，PIN-16）。
 *
 * P2-13 的清扫另加一条：两棵树（含 __tests__）里一个 phase 2 的 TODO 标签都没有。标签字面量由片段拼出来，
 * 好让对这个标签的 grep 清扫在本文件上也是零命中。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/** phase 2 的 TODO 标签（拼出来的，见文件头） */
const P2_MARKER = ['TODO(pi-durable', 'p2)'].join(' ')

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

  it('subagent/manager.ts carries no phase-2 TODO; agentHost.ts has no dispatchModelConfig', () => {
    expect(readFileSync(join(RUNTIME, 'subagent/manager.ts'), 'utf8')).not.toContain(P2_MARKER)
    expect(readFileSync(join(MAIN, 'agents/agentHost.ts'), 'utf8')).not.toContain(
      'dispatchModelConfig'
    )
  })

  it('P2-08-52 the Q16 debt is paid: permissionReview.ts and the hook runner carry no p2 marker; host dispatch is never refused as unimplemented', () => {
    for (const path of [
      join(MAIN, 'services/permissionReview.ts'),
      join(RUNTIME, 'hook/hookRunner.ts'),
      join(RUNTIME, 'durable/spawn.ts')
    ]) {
      expect(readFileSync(path, 'utf8')).not.toContain(P2_MARKER)
    }
    expect(filesContaining("'host-dispatched agents'")).toEqual([])
  })
})

describe('P2-13 the phase-2 debt sweep', () => {
  it('no phase-2 TODO anywhere in src/main, e2e or agent-runtime, tests included', () => {
    const roots = [MAIN, join(MAIN, '../../e2e'), RUNTIME]
    const carrying: string[] = []
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) {
          if (name !== 'node_modules') walk(path)
        } else if (/\.tsx?$/.test(name) && readFileSync(path, 'utf8').includes(P2_MARKER)) {
          carrying.push(path)
        }
      }
    }
    for (const root of roots) walk(root)
    expect(carrying).toEqual([])
  })
})
