/**
 * STS —— SkillTool 这一次**装配出的货架**：谁进索引、工具挂不挂、按名加载能拿到谁。
 *
 * 货架 = 名单点了名的 ∩ findEnabled 返回的（按全局名**精确**匹配）。名单来自 agent 的归一工具名单
 * （档案 `shuvix-tools` 声明的 + 会话勾选的，去掉 `skill:` 前缀）；内置技能**没有**「不点名也在架」
 * 的特例 —— 哪个 agent 带它，由它的档案点不点 `skill:builtin:<name>` 说了算。构造函数只收两个参数。
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

/** 那句「没有可用技能」—— 空货架的全部描述 */
const EMPTY_DESCRIPTION =
  'Load a specialized skill that provides domain-specific instructions and workflows. No skills are currently available.'

type ExecResult = { content: { type: string; text?: string }[]; details?: { error?: boolean } }

describe('STS 货架的构成', () => {
  it('STS-1 名单点了内置的名 → 在架：索引里只有它，没点名的用户 skill 不跟着上来', () => {
    mocks.findEnabled.mockReturnValue([BUILTIN, USER_FOO])
    const tool = new SkillTool(['builtin:drawing'])
    expect(tool.hasSkills).toBe(true)
    expect(tool.description).toContain('<available_skills>')
    expect(indexed(tool)).toEqual(['builtin:drawing'])
  })

  it('STS-2 名单为空 → 内置也不在架（没有「不点名也在架」的特例），描述就是那句「没有可用技能」', () => {
    mocks.findEnabled.mockReturnValue([BUILTIN, USER_FOO])
    const tool = new SkillTool([])
    expect(tool.hasSkills).toBe(false)
    expect(tool.description).toBe(EMPTY_DESCRIPTION)
  })

  it('STS-3 点了名的内置与用户 skill 并存，没点名的（bar）不进索引', () => {
    mocks.findEnabled.mockReturnValue([BUILTIN, USER_FOO, USER_BAR])
    expect(indexed(new SkillTool(['builtin:drawing', 'foo']))).toEqual(['builtin:drawing', 'foo'])
  })

  it('STS-4 一个都没有 → hasSkills=false，description 是那句「没有可用技能」', () => {
    // 注入点据此决定不挂这个工具：空手的工具只是噪音。
    mocks.findEnabled.mockReturnValue([])
    const tool = new SkillTool(['foo'])
    expect(tool.hasSkills).toBe(false)
    expect(tool.description).toBe(EMPTY_DESCRIPTION)
    expect(tool.description).not.toContain('<available_skills>')
  })

  it('STS-5 点了名但被全局停用（findEnabled 不再返回它）→ 不在架；只点了它时整个货架是空的', () => {
    // 「关得掉」在 skillService 那边钉（SSB-3/4）；这里钉的是关掉之后工具层的样子 ——
    // 档案点了名也救不回一个用户在侧栏关掉的技能
    mocks.findEnabled.mockReturnValue([USER_FOO])
    const both = new SkillTool(['builtin:drawing', 'foo'])
    expect(both.hasSkills).toBe(true)
    expect(indexed(both)).toEqual(['foo'])
    expect(both.description).not.toContain('builtin:drawing')

    const onlyBuiltin = new SkillTool(['builtin:drawing'])
    expect(onlyBuiltin.hasSkills).toBe(false)
    expect(onlyBuiltin.description).toBe(EMPTY_DESCRIPTION)
  })

  it('STS-6 按全局名精确匹配：同名用户 skill `drawing` 与内置 `builtin:drawing` 互不顶替', () => {
    // 内置恒带 `builtin:` 命名空间，用户全局目录的没有 —— 点哪个名就只拿哪一个
    const USER_DRAWING = skill('drawing', 'default', 'USER DRAWING BODY')
    mocks.findEnabled.mockReturnValue([BUILTIN, USER_DRAWING])
    expect(indexed(new SkillTool(['drawing']))).toEqual(['drawing'])
    expect(indexed(new SkillTool(['builtin:drawing']))).toEqual(['builtin:drawing'])
  })
})

describe('STS 按名加载', () => {
  it('STS-7 只给得出**在架**的那些：启用了但没点名的、findAll 才有的，都回 not found，正文一个字都不给', async () => {
    // 旧实现走 skillService.findByName（它走 findAll，不看 .config.json 的 disabled /
    // disabledDirs），于是「关掉」只是把它从索引里摘掉，模型按名调用照样拿到全文。
    const HIDDEN = skill('builtin:hidden', 'builtin', 'HIDDEN BODY SHOULD NEVER APPEAR')
    mocks.findEnabled.mockReturnValue([BUILTIN, USER_FOO])
    // findAll 一路（findByName）仍然「有」这个技能 —— 它不该被 executeInternal 够到
    mocks.findByName.mockReturnValue(HIDDEN)

    const tool = new SkillTool(['builtin:drawing'])

    const hit = (await tool.execute('call-1', { name: 'builtin:drawing' })) as ExecResult
    expect(textOf(hit)).toContain('BUILTIN DRAWING BODY')
    expect(hit.details?.error).toBeUndefined()

    // foo 启用着、但这个 agent 的名单没点它：货架之外的一律按不存在处理
    const notNamed = (await tool.execute('call-2', { name: 'foo' })) as ExecResult
    expect(textOf(notNamed)).not.toContain('USER FOO BODY')
    expect(textOf(notNamed)).toContain('not found')
    expect(notNamed.details?.error).toBe(true)

    const hidden = (await tool.execute('call-3', { name: 'builtin:hidden' })) as ExecResult
    expect(textOf(hidden)).not.toContain('HIDDEN BODY SHOULD NEVER APPEAR')
    expect(textOf(hidden)).toContain('not found')
    expect(hidden.details?.error).toBe(true)
  })
})

describe('STS 与 skillService 的接缝', () => {
  it('STS-8 装配时按 projectPath 问一次 findEnabled（项目级 .claude/skills 因此可见）', () => {
    mocks.findEnabled.mockReturnValue([BUILTIN])
    new SkillTool(['builtin:drawing'], '/w/proj')
    expect(mocks.findEnabled).toHaveBeenCalledTimes(1)
    expect(mocks.findEnabled).toHaveBeenCalledWith('/w/proj')
  })
})
