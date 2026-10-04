/**
 * P1-00 系统提示词 golden fixture 的常驻自检。
 *
 * fixture 由 `agentProfile/__tests__/systemPromptGolden.capture.test.ts` 在旧依赖（pi 0.80.10 的
 * AgentHarness 运行时）上捕获（捕获完成后那份捕获用例已在 P1-01 删除）：每份记录 createAgent 的输入、
 * 输出与按围栏拆开的 `parts`。pi-durable 之后系统提示词由若干 section 以 "\n\n" 拼接，section 渲染器
 * 要逐字节复现这些输出（P1-08）。
 *
 * 这里只验 fixture 自身的一致性，**刻意不 import createAgent / 任何 pi 包**：切换依赖之后它仍要能跑。
 *  - 目录不空（防止 fixture 被整目录误删而对照测试空转变绿）；
 *  - 每份 `parts` 以 "\n\n" 拼回去逐字节等于 `output`；
 *  - 第一段恒为 persona，追加块按 createAgent 的固定次序出现，没有空段、段首尾没有空白。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/system-prompts')

/** 捕获时的用例数；少于它说明有 fixture 丢了 */
const MIN_FIXTURES = 21

/** createAgent 的拼接次序（systemContext 可重复，恒在最后） */
const PART_ORDER = [
  'persona',
  'instructionFile',
  'projectPrompt',
  'knowledgeBases',
  'projectMemory',
  'systemContext'
] as const

interface GoldenFixture {
  case: string
  inputs: Record<string, unknown>
  output: string
  parts: Array<{ name: string; text: string }>
}

const files = readdirSync(FIXTURE_DIR)
  .filter((f) => f.endsWith('.json'))
  .sort()
const fixtures: Array<[string, GoldenFixture]> = files.map((file) => [
  file,
  JSON.parse(readFileSync(join(FIXTURE_DIR, file), 'utf-8')) as GoldenFixture
])

describe('system prompt golden fixtures (P1-00)', () => {
  it('the fixture directory is populated', () => {
    expect(files.length).toBeGreaterThanOrEqual(MIN_FIXTURES)
  })

  it.each(fixtures)('%s: parts joined with "\\n\\n" reproduce the output', (file, fixture) => {
    expect(`${fixture.case}.json`).toBe(file)
    expect(typeof fixture.output).toBe('string')
    expect(fixture.inputs).toBeTypeOf('object')
    expect(fixture.parts.length).toBeGreaterThan(0)
    expect(fixture.parts.map((p) => p.text).join('\n\n')).toBe(fixture.output)
  })

  it.each(fixtures)('%s: persona first, appended blocks in createAgent order', (_file, fixture) => {
    expect(fixture.parts[0].name).toBe('persona')
    const ranks = fixture.parts.map((p) =>
      PART_ORDER.indexOf(p.name as (typeof PART_ORDER)[number])
    )
    expect(ranks.every((r) => r >= 0)).toBe(true)
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks)
    // 除 systemContext 外每类至多一段
    const singles = fixture.parts.filter((p) => p.name !== 'systemContext').map((p) => p.name)
    expect(new Set(singles).size).toBe(singles.length)
    for (const part of fixture.parts) {
      expect(part.text.length).toBeGreaterThan(0)
      expect(part.text.trim()).toBe(part.text)
    }
  })
})
