/**
 * STS —— SkillTool 这一次**装配出的货架**：谁进索引、工具挂不挂、按名加载能拿到谁。
 *
 * 两条分工（与 `skillServiceBuiltin.test.ts` 的接缝就是 `findEnabled` 的返回值契约，两边各测
 * 一半、中间不重复）：
 *   - 「关得掉」是 skillService 那边的事（`.config.json` → findEnabled 的返回值）；
 *   - 「关掉之后工具层也看不见」在这里，用**桩出来的 findEnabled 返回值**表达 ——
 *     这一组不写 `.config.json`，也不该写。
 *
 * `skillService` 整个打桩；`../i18n`（顶层 import electron）与 ripgrep（真二进制）只为让模块
 * 能加载、让 execute 跑完 —— 目录采样本身刻意不测。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Skill } from '../../types/skill'

const mocks = vi.hoisted(() => ({ findEnabled: vi.fn(), findByName: vi.fn() }))

vi.mock('../skillService', () => ({
  skillService: { findEnabled: mocks.findEnabled, findByName: mocks.findByName }
}))
vi.mock('../../i18n', () => ({ t: (key: string) => key }))
vi.mock('../../utils/toolUtils/ripgrep', () => ({
  rgFiles: async function* () {
    /* 目录采样不在本组射程内：真 rg 二进制不进单测 */
  }
}))

import { SkillTool } from '../skillTool'

const skill = (name: string, source: Skill['source'], body: string): Skill => ({
  name,
  description: `${name} description`,
  content: body,
  basePath: `/fixture/${name.replace(':', '-')}`,
  isEnabled: true,
  source,
  dirName: source === 'builtin' ? 'builtin' : undefined
})

const BUILTIN = skill('builtin:drawing', 'builtin', 'BUILTIN DRAWING BODY')
const USER_FOO = skill('foo', 'default', 'USER FOO BODY')
const USER_BAR = skill('bar', 'default', 'USER BAR BODY')

/** 索引里出现的技能名（从 description 的 `<name>` 行取，不抄过滤谓词） */
const indexed = (tool: SkillTool): string[] =>
  [...tool.description.matchAll(/<name>([^<]+)<\/name>/g)].map((m) => m[1]).sort()

const textOf = (result: { content: { type: string; text?: string }[] }): string =>
  result.content.map((c) => c.text ?? '').join('\n')

beforeEach(() => {
  vi.clearAllMocks()
})

describe('STS 货架的构成', () => {
  it('STS-1 内置**不勾也在架**：一个都没勾，索引里仍有 builtin:drawing', () => {
    mocks.findEnabled.mockReturnValue([BUILTIN])
    const tool = new SkillTool([], undefined, { includeBuiltin: true })
    expect(tool.hasSkills).toBe(true)
    expect(tool.description).toContain('<available_skills>')
    expect(indexed(tool)).toEqual(['builtin:drawing'])
  })

  it('STS-2 用户 skill 仍要勾：未勾选的不进索引', () => {
    mocks.findEnabled.mockReturnValue([BUILTIN, USER_FOO])
    expect(indexed(new SkillTool([], undefined, { includeBuiltin: true }))).toEqual([
      'builtin:drawing'
    ])
  })

  it('STS-3 勾选的用户 skill 与内置并存', () => {
    mocks.findEnabled.mockReturnValue([BUILTIN, USER_FOO, USER_BAR])
    expect(indexed(new SkillTool(['foo'], undefined, { includeBuiltin: true }))).toEqual([
      'builtin:drawing',
      'foo'
    ])
  })

  it('STS-4 一个都没有 → hasSkills=false，description 是那句「没有可用技能」', () => {
    // 注入点据此决定不挂这个工具：空手的工具只是噪音。
    mocks.findEnabled.mockReturnValue([])
    const tool = new SkillTool(['foo'], undefined, { includeBuiltin: true })
    expect(tool.hasSkills).toBe(false)
    expect(tool.description).toBe(
      'Load a specialized skill that provides domain-specific instructions and workflows. No skills are currently available.'
    )
    expect(tool.description).not.toContain('<available_skills>')
  })

  it('STS-5 内置被关掉（findEnabled 不再返回它）→ 货架上只剩勾选的用户 skill', () => {
    // 「关得掉」在 skillService 那边钉（SSB-3/4）；这里钉的是关掉之后工具层的样子。
    mocks.findEnabled.mockReturnValue([USER_FOO])
    const tool = new SkillTool(['foo'], undefined, { includeBuiltin: true })
    expect(tool.hasSkills).toBe(true)
    expect(indexed(tool)).toEqual(['foo'])
    expect(tool.description).not.toContain('builtin:drawing')
  })

  it.each([
    ['不传 options', undefined],
    ['includeBuiltin: false', { includeBuiltin: false }]
  ])('STS-6 %s → 内置不上架，只有勾选的（派生 agent 不顺带收下整架内置）', (_label, options) => {
    mocks.findEnabled.mockReturnValue([BUILTIN, USER_FOO])
    const tool = new SkillTool(['foo'], undefined, options)
    expect(indexed(tool)).toEqual(['foo'])
    expect(tool.description).not.toContain('builtin:drawing')
  })
})

describe('STS 按名加载', () => {
  it('STS-7 只给得出**在架**的那些：不在架的返回 not found，正文一个字都不给', async () => {
    // 旧实现走 skillService.findByName（它走 findAll，不看 .config.json 的 disabled /
    // disabledDirs），于是「关掉」只是把它从索引里摘掉，模型按名调用照样拿到全文 ——
    // 而 builtin:drawing 的名字写在每个 root agent 的常驻提示里，那条路径是默认可达的。
    const HIDDEN = skill('builtin:hidden', 'builtin', 'HIDDEN BODY SHOULD NEVER APPEAR')
    mocks.findEnabled.mockReturnValue([BUILTIN])
    // findAll 一路（findByName）仍然「有」这个技能 —— 它不该被 executeInternal 够到
    mocks.findByName.mockReturnValue(HIDDEN)

    const tool = new SkillTool([], undefined, { includeBuiltin: true })

    const hit = (await tool.execute('call-1', { name: 'builtin:drawing' })) as {
      content: { type: string; text?: string }[]
      details?: { error?: boolean }
    }
    expect(textOf(hit)).toContain('BUILTIN DRAWING BODY')
    expect(hit.details?.error).toBeUndefined()

    const miss = (await tool.execute('call-2', { name: 'builtin:hidden' })) as {
      content: { type: string; text?: string }[]
      details?: { error?: boolean }
    }
    expect(textOf(miss)).not.toContain('HIDDEN BODY SHOULD NEVER APPEAR')
    expect(textOf(miss)).toContain('not found')
    expect(miss.details?.error).toBe(true)
  })
})

describe('STS 与 skillService 的接缝', () => {
  it('STS-8 装配时按 projectPath 问一次 findEnabled（项目级 .claude/skills 因此可见）', () => {
    mocks.findEnabled.mockReturnValue([BUILTIN])
    new SkillTool([], '/w/proj', { includeBuiltin: true })
    expect(mocks.findEnabled).toHaveBeenCalledTimes(1)
    expect(mocks.findEnabled).toHaveBeenCalledWith('/w/proj')
  })
})
