/**
 * P1-00 工具名顺序 golden fixture 的常驻自检。
 *
 * fixture 由 `toolOrderGolden.capture.test.ts` 在旧依赖（pi 0.80.10 的 AgentHarness 运行时）上从当时的 agentHost
 * 捕获。这里**不 import agentHost / agent-runtime**（P1-11 会重写前者），只读 fixture：
 *  - 目录不空（防止整目录误删后对照测试空转变绿）；
 *  - 每份的 `output.toolNames` 能从它自己的 `inputs` 按今天的顺序规则重算出来 ——
 *    名单序的内置工具（只收本平台存在的）→ `agent`（root 恒有，spawned 看 canSpawn）→ `skill`
 *    （名单里有技能工具 `skill` 且这一次真有技能可给）→ 各 MCP 服务器的工具（名单序，连不上的跳过）→
 *    extraTools（同名先移除再追加）。这条规则就是迁移后两段工具扩展拼起来要复现的东西。
 *
 * 2026-10-28 起技能不再按名字进名单（档案写 `skill`，货架是启用着的全部技能）：每份 fixture 的 `names` /
 * `profileTools` 与 `observed.skillToolConstructed` 随之手工改过（见各份的 `revised`），`output.toolNames`
 * 一字未动。名单里不该再有 `skill:` 条目 —— 这里一并钉住。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/tool-order')

/** 捕获时的用例数；少于它说明有 fixture 丢了 */
const MIN_FIXTURES = 10

interface ToolOrderFixture {
  case: string
  inputs: {
    platform: string
    kind: 'root' | 'spawned'
    canSpawn: boolean | null
    names: string[]
    extraTools: string[]
    skillsAvailable: boolean
    mcpServers: Record<string, { tools?: string[]; fails?: string } | null>
    registeredBuiltins: Array<{ name: string; platforms: string[] | null }>
  }
  output: { toolNames: string[] }
}

const files = readdirSync(FIXTURE_DIR)
  .filter((f) => f.endsWith('.json'))
  .sort()
const fixtures: Array<[string, ToolOrderFixture]> = files.map((file) => [
  file,
  JSON.parse(readFileSync(join(FIXTURE_DIR, file), 'utf-8')) as ToolOrderFixture
])

function expectedOrder(inputs: ToolOrderFixture['inputs']): string[] {
  const onPlatform = new Set(
    inputs.registeredBuiltins
      .filter((r) => !r.platforms || r.platforms.includes(inputs.platform))
      .map((r) => r.name)
  )
  const names = inputs.names
  const order = names.filter(
    (n) => !n.startsWith('mcp:') && n !== 'skill' && n !== 'agent' && onPlatform.has(n)
  )
  if (names.includes('agent') && (inputs.kind === 'root' || inputs.canSpawn)) order.push('agent')
  if (names.includes('skill') && inputs.skillsAvailable) order.push('skill')
  for (const server of names.filter((n) => n.startsWith('mcp:')).map((n) => n.slice(4))) {
    const spec = inputs.mcpServers[server]
    if (!spec || spec.fails) continue
    order.push(...(spec.tools ?? []).map((t) => `mcp__${server}__${t}`))
  }
  if (inputs.extraTools.length === 0) return order
  const extra = new Set(inputs.extraTools)
  return [...order.filter((n) => !extra.has(n)), ...inputs.extraTools]
}

describe('tool-order golden fixtures (P1-00)', () => {
  it('the fixture directory is populated', () => {
    expect(files.length).toBeGreaterThanOrEqual(MIN_FIXTURES)
  })

  it.each(fixtures)('%s: output follows the ordering rule from its own inputs', (file, fixture) => {
    expect(`${fixture.case}.json`).toBe(file)
    const { toolNames } = fixture.output
    expect(toolNames.length).toBeGreaterThan(0)
    expect(new Set(toolNames).size).toBe(toolNames.length)
    expect(toolNames).toEqual(expectedOrder(fixture.inputs))
    expect(fixture.inputs.names.filter((n) => n.startsWith('skill:'))).toEqual([])
  })
})
