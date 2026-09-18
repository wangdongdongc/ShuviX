/**
 * SSB —— skillService 眼里的**内置技能**：名字空间 `builtin:<name>`、缺省在架、关得掉，
 * 以及与同名用户 skill 的**并存**关系。
 *
 * 目录用 tmpdir 里现造的 fixture（`../../utils/paths` 打桩，与 toolContext.test.ts 同惯例）——
 * 这一组钉的是宿主逻辑（扫描 / 名字空间 / `.config.json`），不是仓库里那批 md 齐不齐
 * （那是 `builtinSkillsResources.test.ts`），也不是语言目录怎么选
 * （那是 `utils/__tests__/builtinSkillsDir.test.ts`）。
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 路径字符串在 hoist 期就要定下来（桩工厂先于一切 import 求值）；目录本身 beforeEach 现造 */
const DIRS = vi.hoisted(() => {
  const base = process.env.TMPDIR || process.env.TMP || process.env.TEMP || '/tmp'
  const root = `${base.replace(/\/+$/, '')}/shuvix-skill-service-${process.pid}-${Date.now()}`
  return { root, builtin: `${root}/builtin`, user: `${root}/user` }
})

vi.mock('../../utils/paths', () => ({
  // 内置那一层：产线上是 `skills/<lang>/`，这里就是一个放技能目录的普通目录
  getBuiltinSkillsDir: () => DIRS.builtin,
  getDefaultSkillsDir: () => DIRS.user
}))

import { skillService } from '../skillService'

const writeSkill = (dir: string, name: string, description: string, body: string): void => {
  mkdirSync(join(dir, name), { recursive: true })
  writeFileSync(
    join(dir, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: "${description}"\n---\n\n${body}\n`,
    'utf8'
  )
}

const writeConfig = (config: Record<string, unknown>): void =>
  writeFileSync(join(DIRS.user, '.config.json'), JSON.stringify(config), 'utf8')

const namesOf = (skills: { name: string }[]): string[] => skills.map((s) => s.name).sort()

beforeEach(() => {
  rmSync(DIRS.root, { recursive: true, force: true })
  mkdirSync(DIRS.builtin, { recursive: true })
  mkdirSync(DIRS.user, { recursive: true })
  writeSkill(DIRS.builtin, 'drawing', 'builtin drawing craft', 'BUILTIN BODY')
})

afterAll(() => {
  rmSync(DIRS.root, { recursive: true, force: true })
})

describe('SSB 内置技能的名字空间', () => {
  it('SSB-1 扫出来就是 builtin:<name>：source=builtin、dirName=builtin', () => {
    const skill = skillService.findAll().find((s) => s.name === 'builtin:drawing')
    expect(skill, 'findAll 里没有 builtin:drawing').toBeDefined()
    expect(skill!.source).toBe('builtin')
    expect(skill!.dirName).toBe('builtin')
    expect(skill!.basePath).toBe(join(DIRS.builtin, 'drawing'))
    expect(skill!.description).toBe('builtin drawing craft')
  })
})

describe('SSB 缺省在架 / 关得掉', () => {
  it('SSB-2 没有 .config.json 时内置就在 findEnabled 里（不需要谁去勾它）', () => {
    expect(namesOf(skillService.findEnabled())).toContain('builtin:drawing')
  })

  it('SSB-3 disabled 里点名 → findEnabled 不含，findAll 仍含（关闭是隐藏，不是删除）', () => {
    writeConfig({ disabled: ['builtin:drawing'] })
    expect(namesOf(skillService.findEnabled())).not.toContain('builtin:drawing')

    const still = skillService.findAll().find((s) => s.name === 'builtin:drawing')
    expect(still, 'findAll 不看 .config.json —— 关掉的技能在这里仍应看得见').toBeDefined()
    expect(still!.isEnabled).toBe(false)
  })

  it('SSB-4 disabledDirs 关掉 builtin 这一组 → 整组失效', () => {
    writeSkill(DIRS.builtin, 'second', 'another builtin', 'SECOND BODY')
    expect(namesOf(skillService.findEnabled())).toEqual(['builtin:drawing', 'builtin:second'])

    writeConfig({ disabledDirs: ['builtin'] })
    expect(skillService.findEnabled().filter((s) => s.source === 'builtin')).toEqual([])
    // 整组关掉不该波及用户自己的那一组
    writeSkill(DIRS.user, 'mine', 'user skill', 'USER BODY')
    expect(namesOf(skillService.findEnabled())).toEqual(['mine'])
  })
})

describe('SSB 同名用户 skill 与内置的关系', () => {
  it('SSB-5 **并存，不覆盖** —— 与 agent/policy/hook/bot 那套 md 家族不同', () => {
    // 别照那套直觉读这里：那边同名是「用户文件覆盖内置」（resolveShadowing 裁决谁在效）。
    // 这里内置恒带 dirName='builtin'，globalName 因此恒为 `builtin:<name>`，而用户全局目录
    // 的就是 `<name>` —— 两者**永远不同名**，于是并存、各占索引一行。
    // 要让内置那份失效，路径是 .config.json 的 disabled（SSB-3）或整组 disabledDirs（SSB-4），
    // 放一个同名文件什么也不会发生。
    writeSkill(DIRS.user, 'drawing', 'my own drawing notes', 'USER BODY')

    const all = skillService.findAll()
    const builtin = all.find((s) => s.name === 'builtin:drawing')
    const user = all.find((s) => s.name === 'drawing')
    expect(builtin, '内置那份被同名用户 skill 顶掉了').toBeDefined()
    expect(user, '用户那份被内置顶掉了').toBeDefined()
    expect(builtin!.source).toBe('builtin')
    expect(user!.source).toBe('default')
    expect(builtin!.basePath).not.toBe(user!.basePath)
    expect(builtin!.content).toBe('BUILTIN BODY')
    expect(user!.content).toBe('USER BODY')

    // 两份都在架：模型的索引里是两行，不是一行
    expect(namesOf(skillService.findEnabled())).toEqual(['builtin:drawing', 'drawing'])
  })

  it('SSB-6 关掉内置那份不影响同名用户 skill（disabled 按全名匹配）', () => {
    writeSkill(DIRS.user, 'drawing', 'my own drawing notes', 'USER BODY')
    writeConfig({ disabled: ['builtin:drawing'] })
    expect(namesOf(skillService.findEnabled())).toEqual(['drawing'])
  })
})
