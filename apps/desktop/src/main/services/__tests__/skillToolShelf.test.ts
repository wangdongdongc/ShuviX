/**
 * STS —— SkillTool 这一次**装配出的货架**：谁进索引、工具挂不挂、按名加载能拿到谁。
 *
 * 两种货架（构造函数的第一个参数，2026-10-28 起按 Claude Code / Codex 的用法）：
 *   - `'enabled'`（创建 agent 时）：侧栏里启用着的**全部**技能，内置的与用户的一视同仁、带上根会话
 *     项目的 `.claude/skills`，去掉 SKILL.md 写了 `disable-model-invocation: true` 的。档案不逐个点名，
 *     会话也不勾选；
 *   - `{ known }`（按锁重建时）：锁记着的照收，停用与否不论；磁盘上已经没了的掉出去，锁之外的一个不加。
 *
 * 这一组用**真 skillService** 扫 tmpdir 里现造的技能目录（`../../utils/paths` 打桩，与
 * `skillServiceBuiltin.test.ts` 同惯例）：「停用」「只许用户调用」在 skillService 里怎么算是它那边
 * 的事，这里钉的是工具层看到的样子 —— 两层之间不另抄一份过滤谓词。
 *
 * `../i18n`（顶层 import electron）与 ripgrep（真二进制）只为让模块能加载、让 execute 跑完 ——
 * 目录采样本身刻意不测。
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { executeTool } from '@shuvix/agent-runtime/tools/testing/invokeTool'

/** 路径字符串在 hoist 期就要定下来（桩工厂先于一切 import 求值）；目录本身 beforeEach 现造 */
const DIRS = vi.hoisted(() => {
  const base = process.env.TMPDIR || process.env.TMP || process.env.TEMP || '/tmp'
  const root = `${base.replace(/\/+$/, '')}/shuvix-skill-shelf-${process.pid}-${Date.now()}`
  return {
    root,
    builtin: `${root}/builtin`,
    user: `${root}/user`,
    project: `${root}/proj`
  }
})

vi.mock('../../utils/paths', () => ({
  getBuiltinSkillsDir: () => DIRS.builtin,
  getDefaultSkillsDir: () => DIRS.user,
  getSharedSkillsDirs: () => ({
    claude: `${DIRS.root}/home/.claude/skills`,
    agents: `${DIRS.root}/home/.agents/skills`
  })
}))
vi.mock('../../i18n', () => ({ t: (key: string) => key }))
vi.mock('../../utils/toolUtils/ripgrep', () => ({
  rgFiles: async function* () {
    /* 目录采样不在本组射程内：真 rg 二进制不进单测 */
  }
}))

import { skillService } from '../skillService'
import { SkillTool } from '../skillTool'

const writeSkill = (
  dir: string,
  name: string,
  body: string,
  extraFrontmatter: string[] = []
): void => {
  mkdirSync(join(dir, name), { recursive: true })
  writeFileSync(
    join(dir, name, 'SKILL.md'),
    [
      '---',
      `name: ${name}`,
      `description: "${name} description"`,
      ...extraFrontmatter,
      '---',
      '',
      body,
      ''
    ].join('\n'),
    'utf8'
  )
}

const writeConfig = (config: Record<string, unknown>): void =>
  writeFileSync(join(DIRS.user, '.config.json'), JSON.stringify(config), 'utf8')

const PROJECT_SKILLS = (): string => join(DIRS.project, '.claude', 'skills')

/** 索引里出现的技能名（从 description 的 `<name>` 行取，不抄过滤谓词） */
const indexed = (tool: SkillTool): string[] =>
  [...tool.description.matchAll(/<name>([^<]+)<\/name>/g)].map((m) => m[1]).sort()

const textOf = (result: { content: { type: string; text?: string }[] }): string =>
  result.content.map((c) => c.text ?? '').join('\n')

/** 那句「没有可用技能」—— 空货架的全部描述 */
const EMPTY_DESCRIPTION =
  'Load a specialized skill that provides domain-specific instructions and workflows. No skills are currently available.'

type ExecResult = { content: { type: string; text?: string }[]; details?: { error?: boolean } }

beforeEach(() => {
  rmSync(DIRS.root, { recursive: true, force: true })
  mkdirSync(DIRS.builtin, { recursive: true })
  mkdirSync(DIRS.user, { recursive: true })
  // 内置一本（扫出来是 builtin:drawing）+ 默认目录两本
  writeSkill(DIRS.builtin, 'drawing', 'BUILTIN DRAWING BODY')
  writeSkill(DIRS.user, 'foo', 'USER FOO BODY')
  writeSkill(DIRS.user, 'bar', 'USER BAR BODY')
})

afterAll(() => {
  rmSync(DIRS.root, { recursive: true, force: true })
})

describe("STS 'enabled' 货架：启用着、模型可调用的全部", () => {
  it('STS-1 不点名也全在架：内置与用户 skill 一视同仁；skillNames 与索引同一份', () => {
    const tool = new SkillTool('enabled')
    expect(tool.hasSkills).toBe(true)
    expect(tool.description).toContain('<available_skills>')
    expect(indexed(tool)).toEqual(['bar', 'builtin:drawing', 'foo'])
    expect([...tool.skillNames].sort()).toEqual(['bar', 'builtin:drawing', 'foo'])
  })

  it('STS-2 一本技能都没有 → hasSkills=false，description 就是那句「没有可用技能」', () => {
    // 注入点据此决定不挂这个工具：空手的工具只是噪音
    rmSync(DIRS.root, { recursive: true, force: true })
    mkdirSync(DIRS.builtin, { recursive: true })
    mkdirSync(DIRS.user, { recursive: true })
    const tool = new SkillTool('enabled')
    expect(tool.hasSkills).toBe(false)
    expect(tool.skillNames).toEqual([])
    expect(tool.description).toBe(EMPTY_DESCRIPTION)
    expect(tool.description).not.toContain('<available_skills>')
  })

  it('STS-3 侧栏停用的不在架：单本停用（内置的也一样）、整组停用；全停时货架是空的', () => {
    writeConfig({ disabled: ['builtin:drawing'] })
    const noBuiltin = new SkillTool('enabled')
    expect(indexed(noBuiltin)).toEqual(['bar', 'foo'])
    expect(noBuiltin.description).not.toContain('builtin:drawing')

    writeConfig({ disabled: ['foo'], disabledDirs: ['builtin'] })
    expect(indexed(new SkillTool('enabled'))).toEqual(['bar'])

    writeConfig({ disabled: ['foo', 'bar'], disabledDirs: ['builtin'] })
    const none = new SkillTool('enabled')
    expect(none.hasSkills).toBe(false)
    expect(none.description).toBe(EMPTY_DESCRIPTION)
  })

  it('STS-4 SKILL.md 写了 `disable-model-invocation: true` → 不在架（它仍是启用着的，只是只许用户调用）', () => {
    writeSkill(DIRS.user, 'deploy', 'USER DEPLOY BODY', ['disable-model-invocation: true'])
    // 对照：它没被停用 —— 掉下货架的原因是「只许用户调用」，不是开关
    expect(skillService.findEnabled().map((s) => s.name)).toContain('deploy')

    const tool = new SkillTool('enabled')
    expect(indexed(tool)).toEqual(['bar', 'builtin:drawing', 'foo'])
    expect(tool.description).not.toContain('deploy')
  })

  it('STS-5 带 projectPath 时项目级 .claude/skills 也在架；不带时不在', () => {
    writeSkill(PROJECT_SKILLS(), 'proj-only', 'PROJECT BODY')
    expect(indexed(new SkillTool('enabled', DIRS.project))).toEqual([
      'bar',
      'builtin:drawing',
      'foo',
      'proj-only'
    ])
    expect(indexed(new SkillTool('enabled'))).not.toContain('proj-only')
  })

  it('STS-6 同名用户 skill `drawing` 与内置 `builtin:drawing` 互不顶替：两本并存、各占一行', () => {
    // 内置恒带 `builtin:` 命名空间，用户全局目录的没有 —— 不是 md 家族那套「用户覆盖内置」
    writeSkill(DIRS.user, 'drawing', 'USER DRAWING BODY')
    expect(indexed(new SkillTool('enabled'))).toEqual(['bar', 'builtin:drawing', 'drawing', 'foo'])
  })
})

describe('STS { known } 货架：按锁重建', () => {
  it('STS-K1 锁记着的照收，此刻停用了也不掉；锁之外启用着的一个不加', () => {
    writeConfig({ disabled: ['builtin:drawing'], disabledDirs: [] })
    const tool = new SkillTool({ known: ['builtin:drawing', 'foo'] })
    expect(tool.hasSkills).toBe(true)
    expect(indexed(tool)).toEqual(['builtin:drawing', 'foo'])
    expect(tool.description).not.toContain('<name>bar</name>')
  })

  it('STS-K2 磁盘上已经没了的从索引里掉出去；全没了 → 空货架那句', () => {
    rmSync(join(DIRS.user, 'foo'), { recursive: true, force: true })
    const tool = new SkillTool({ known: ['builtin:drawing', 'foo'] })
    expect(indexed(tool)).toEqual(['builtin:drawing'])

    const gone = new SkillTool({ known: ['ghost'] })
    expect(gone.hasSkills).toBe(false)
    expect(gone.description).toBe(EMPTY_DESCRIPTION)
    expect(new SkillTool({ known: [] }).hasSkills).toBe(false)
  })

  it('STS-K3 项目级 skill 按 projectPath 找：锁里记着它、带上项目路径才重建得出来', () => {
    writeSkill(PROJECT_SKILLS(), 'proj-only', 'PROJECT BODY')
    expect(indexed(new SkillTool({ known: ['proj-only'] }, DIRS.project))).toEqual(['proj-only'])
    expect(new SkillTool({ known: ['proj-only'] }).hasSkills).toBe(false)
  })
})

describe('STS 按名加载', () => {
  it('STS-7 只给得出**在架**的那些：停用的、只许用户调用的、锁之外的，都回 not found，正文一个字都不给', async () => {
    writeConfig({ disabled: ['bar'] })
    writeSkill(DIRS.user, 'deploy', 'USER DEPLOY BODY SHOULD NEVER APPEAR', [
      'disable-model-invocation: true'
    ])
    const tool = new SkillTool('enabled')

    const hit = (await executeTool(tool, 'call-1', { name: 'builtin:drawing' })) as ExecResult
    expect(textOf(hit)).toContain('BUILTIN DRAWING BODY')
    expect(hit.details?.error).toBeUndefined()

    // bar 停用着（findAll 仍看得见它）：货架之外的一律按不存在处理
    const disabled = (await executeTool(tool, 'call-2', { name: 'bar' })) as ExecResult
    expect(textOf(disabled)).not.toContain('USER BAR BODY')
    expect(textOf(disabled)).toContain('not found')
    expect(disabled.details?.error).toBe(true)

    const userOnly = (await executeTool(tool, 'call-3', { name: 'deploy' })) as ExecResult
    expect(textOf(userOnly)).not.toContain('SHOULD NEVER APPEAR')
    expect(textOf(userOnly)).toContain('not found')
    expect(userOnly.details?.error).toBe(true)

    // 按锁重建的货架同理：锁之外的启用着也拿不到
    const known = new SkillTool({ known: ['foo'] })
    const outside = (await executeTool(known, 'call-4', {
      name: 'builtin:drawing'
    })) as ExecResult
    expect(textOf(outside)).not.toContain('BUILTIN DRAWING BODY')
    expect(textOf(outside)).toContain('not found')
    expect(outside.details?.error).toBe(true)
  })
})
