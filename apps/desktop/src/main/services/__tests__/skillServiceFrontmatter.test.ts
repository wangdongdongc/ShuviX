/**
 * SFM —— `skillService.parseSkillMarkdown` 读 SKILL.md 的 frontmatter。
 *
 * 读法仍是**按行**的（`key: value`，第一个冒号切开，首尾一层引号剥掉）；YAML 只为 `description`
 * 补一种按行读不出来的情形 —— 写成多行：
 *   (a) 按行读到的只是一个块标量的头（`>` / `|`，可带缩进数字与 `+` / `-`）；
 *   (b) YAML 读出的字符串**严格延长**了按行读到的值（以它开头且更长）—— 折到下一行的续行、跨行的引号。
 * 别的一律留按行读的值：合法 YAML 会把 `#42` 读成注释、把 `''` 读成转义，而今天读得出来的每一份都
 * 不该因此变样。`name` **从不**取 YAML 的 —— 它是技能标识，`.config.json` 的开关与会话勾选都按它记。
 * frontmatter 整体不是合法 YAML 时，一切留按行读的值（SFM-11 钉住的已知局限也出在这里）。
 *
 * `skillService` 是模块级单例、构造时就建默认目录 —— paths 必须打桩到夹具根（同 SSG / SSS）。
 * 解析本身是纯函数，只有 SFM-10 / SFM-12 走一遍 findAll / 命令池，确认解析结果真的流到了那里。
 *
 * SFM-13..17 是两个调用开关（`disable-model-invocation` / `user-invocable`）：取值矩阵按纯解析钉，
 * SFM-15..17 再经 findModelInvocable（货架）/ findEnabledAsCommands（命令池）与侧栏开关、项目级、
 * 共用目录、内置目录各走一遍。
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const DIRS = vi.hoisted(() => {
  const base = process.env.TMPDIR || process.env.TMP || process.env.TEMP || '/tmp'
  const root = `${base.replace(/\/+$/, '')}/shuvix-skill-frontmatter-${process.pid}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}`
  return { root, builtin: `${root}/builtin`, user: `${root}/user` }
})

vi.mock('../../utils/paths', () => ({
  getBuiltinSkillsDir: () => DIRS.builtin,
  getDefaultSkillsDir: () => DIRS.user,
  // 不存在的假 home：这一组不碰共用目录，也绝不读跑测试那台机器的家目录
  getSharedSkillsDirs: () => ({
    claude: `${DIRS.root}/home/.claude/skills`,
    agents: `${DIRS.root}/home/.agents/skills`
  })
}))

import { skillService } from '../skillService'

const parse = (text: string): ReturnType<typeof skillService.parseSkillMarkdown> =>
  skillService.parseSkillMarkdown(text)

/** 拼一份 SKILL.md：frontmatter 行 + 正文 */
const md = (frontmatter: string[], body = 'Body text.'): string =>
  ['---', ...frontmatter, '---', '', body, ''].join('\n')

const FOLDED = 'Use when the user works with PDFs.'

beforeEach(() => {
  rmSync(DIRS.root, { recursive: true, force: true })
  for (const dir of [DIRS.builtin, DIRS.user]) mkdirSync(dir, { recursive: true })
})

afterAll(() => {
  rmSync(DIRS.root, { recursive: true, force: true })
})

describe('SFM 多行 description 走 YAML', () => {
  it.each(['>', '>-', '>2', '>+'])(
    'SFM-1 折叠块标量 `description: %s` → 一行字，没有结尾换行',
    (header) => {
      const parsed = parse(
        md(['name: pdf', `description: ${header}`, '  Use when the user', '  works with PDFs.'])
      )
      expect(parsed).toEqual({ name: 'pdf', description: FOLDED, content: 'Body text.' })
    }
  )

  it.each(['|', '|-'])('SFM-2 字面块标量 `description: %s` → 保留行内换行', (header) => {
    const parsed = parse(md(['name: lit', `description: ${header}`, '  Line one', '  Line two']))
    expect(parsed?.description).toBe('Line one\nLine two')
    expect(parsed?.name).toBe('lit')
  })

  it('SFM-6 续行：普通值折到下一行、引号跨行 —— YAML 那份严格延长了按行读的值，取 YAML 的', () => {
    expect(parse(md(['name: a', 'description: first', '  continued']))?.description).toBe(
      'first continued'
    )
    expect(parse(md(['name: a', 'description: "first', '  second"']))?.description).toBe(
      'first second'
    )
  })
})

describe('SFM 别的一律留按行读的值', () => {
  it('SFM-3 frontmatter 不是合法 YAML（`Use when: …` 里第二个冒号）：两个值都按行读', () => {
    expect(parse(md(['name: helper', 'description: Use when: the user asks for X']))).toEqual({
      name: 'helper',
      description: 'Use when: the user asks for X',
      content: 'Body text.'
    })
  })

  it.each([
    ['name: 123', 'description: d', { name: '123', description: 'd' }],
    ['name: true', 'description: d', { name: 'true', description: 'd' }],
    ['name: n', 'description: 42', { name: 'n', description: '42' }],
    ['name: n', 'description: [a, b]', { name: 'n', description: '[a, b]' }],
    ['name: n', 'description:', { name: 'n', description: '' }]
  ])('SFM-4 YAML 读出来不是字符串（%s / %s）：留按行读的字符串', (nameLine, descLine, expected) => {
    expect(parse(md([nameLine, descLine]))).toMatchObject(expected)
  })

  it.each([
    ['普通值', ['name: plain', 'description: Plain words'], 'plain', 'Plain words'],
    [
      '双引号里带冒号',
      ['name: q', 'description: "Quoted, with: colon"'],
      'q',
      'Quoted, with: colon'
    ],
    ['单引号', ['name: s', "description: 'single'"], 's', 'single'],
    [
      '别的键（license / allowed-tools）',
      ['name: k', 'description: d', 'license: MIT', 'allowed-tools: Read, Grep'],
      'k',
      'd'
    ],
    ['name 里带冒号', ['name: ns:tool', 'description: d'], 'ns:tool', 'd'],
    [
      '重复的 description（YAML 报错，按行读最后一个）',
      ['name: dup', 'description: first', 'description: second'],
      'dup',
      'second'
    ],
    [
      'tab 缩进的行（YAML 报错）',
      ['name: tab', '\tdescription: Tab indented'],
      'tab',
      'Tab indented'
    ]
  ])('SFM-5 与按行读一致的写法照旧（%s）', (_label, lines, name, description) => {
    expect(parse(md(lines))).toEqual({ name, description, content: 'Body text.' })
  })

  it('SFM-7 YAML 会读成另一个样子的写法：刻意留按行读的值', () => {
    // `#` 前有空格在 YAML 里是注释：YAML 那份只有 `Fix issue`，不是延长 → 留整句
    expect(parse(md(['name: fix', 'description: Fix issue #42']))?.description).toBe(
      'Fix issue #42'
    )
    // name 从不取 YAML 的：它是技能标识，开关与会话勾选都按它记 —— 一个字都不能因为换了读法而变
    expect(parse(md(['name: foo # x', 'description: d']))?.name).toBe('foo # x')
    // YAML 会把 `''` 读成一个单引号（it's）；按行读只剥最外一层引号
    expect(parse(md(["name: 'it''s'", 'description: d']))?.name).toBe("it''s")
    // 嵌套映射里的 `name:` 也被按行读到，最后一行赢 —— 这是旧行为，照旧（name 不走 YAML）
    expect(parse(md(['name: a', 'metadata:', '  name: nested', 'description: d']))?.name).toBe(
      'nested'
    )
  })

  it('SFM-11 已知局限：`description: >` 但 frontmatter 别处让 YAML 整体读不了 → description 就是 `>`', () => {
    const parsed = parse(
      md(['name: pdf', 'description: >', '  Use when the user', '  works with PDFs.', 'note: a: b'])
    )
    expect(parsed?.name).toBe('pdf')
    expect(parsed?.description).toBe('>')
  })
})

describe('SFM 文件层面的细节', () => {
  it('SFM-8 CRLF 换行：折叠出来的 description 与 name 都没有 \\r；带 BOM 的文件照样解析', () => {
    const crlf = md([
      'name: pdf',
      'description: >',
      '  Use when the user',
      '  works with PDFs.'
    ]).replace(/\n/g, '\r\n')
    const parsed = parse(crlf)!
    expect(parsed.name).toBe('pdf')
    expect(parsed.description).toBe(FOLDED)
    expect(parsed.name).not.toContain('\r')
    expect(parsed.description).not.toContain('\r')

    const bom = parse(`\uFEFF${md(['name: bom', 'description: >', '  Folded', '  text.'])}`)
    expect(bom).toEqual({ name: 'bom', description: 'Folded text.', content: 'Body text.' })
  })

  it('SFM-9 块标量的续行不漏进正文', () => {
    const body = '# Heading\n\nFirst paragraph.\n\n- item'
    const parsed = parse(
      md(['name: pdf', 'description: >', '  Use when the user', '  works with PDFs.'], body)
    )!
    expect(parsed.content).toBe(body)
    expect(parsed.content).not.toContain('works with PDFs')
  })

  it('SFM-10 没有 name：解析回 null；经 findAll 时用目录名作标识', () => {
    const text = md(['description: >', '  Folded', '  text.'], 'Nameless body.')
    expect(parse(text)).toBe(null)

    const dir = join(DIRS.user, 'nameless')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), text, 'utf8')
    const skill = skillService.findAll().find((s) => s.basePath === dir)!
    expect(skill.name).toBe('nameless')
    // 解析失败那条路：description 空、全文作 content（旧行为）
    expect(skill.description).toBe('')
    expect(skill.content).toBe(text.trim())
  })

  it('SFM-12 端到端：默认目录里一个 `description: >` 的技能，findAll 与命令池都拿到折叠后的那句', () => {
    const dir = join(DIRS.user, 'pdf')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'SKILL.md'),
      md(['name: pdf', 'description: >', '  Use when the user', '  works with PDFs.'], 'PDF body.'),
      'utf8'
    )

    expect(skillService.findAll().find((s) => s.name === 'pdf')?.description).toBe(FOLDED)
    const command = skillService.findEnabledAsCommands().find((c) => c.commandId === 'pdf')!
    expect(command.description).toBe(FOLDED)
    // 正文仍是剥过 frontmatter 的那一段
    expect(command.template).toBe(`Base directory for this skill: ${dir}\n\nPDF body.`)
  })
})

/**
 * 两个调用开关（2026-10-28，Claude Code 定的字段）：`disable-model-invocation: true` → 不上 agent 的货架
 * （`findModelInvocable`），仍是 `/名字` 命令；`user-invocable: false` → 不进命令池（`findEnabledAsCommands`），
 * 仍在货架上。按行读：剥一层引号、首尾空白（CRLF 的 `\r` 随之去掉）之后不分大小写地比；别的写法一律是缺省，
 * 解析结果里干脆没有这个键。
 */
describe('SFM 调用开关（disable-model-invocation / user-invocable）', () => {
  /** 一份带一行开关的 SKILL.md（line 为 null = 不写这一行） */
  const flagged = (line: string | null, crlf = false): string => {
    const text = md(['name: flag', 'description: d', ...(line === null ? [] : [line])])
    return crlf ? text.replace(/\n/g, '\r\n') : text
  }

  /** 在 dir 下写一个技能目录（frontmatter 的 name = 目录名） */
  const writeSkill = (dir: string, name: string, extra: string[] = []): string => {
    const base = join(dir, name)
    mkdirSync(base, { recursive: true })
    writeFileSync(
      join(base, 'SKILL.md'),
      md([`name: ${name}`, `description: ${name} skill`, ...extra], `${name.toUpperCase()} BODY`),
      'utf8'
    )
    return base
  }
  const writeConfig = (config: Record<string, unknown>): void =>
    writeFileSync(join(DIRS.user, '.config.json'), JSON.stringify(config), 'utf8')
  const namesOf = (skills: { name: string }[]): string[] => skills.map((s) => s.name).sort()
  const commandIds = (projectPath?: string): string[] =>
    skillService
      .findEnabledAsCommands(projectPath)
      .map((c) => c.commandId)
      .sort()

  const DMI = 'disable-model-invocation'
  const UI = 'user-invocable'

  it.each<[string, string]>([
    ['true', flagged(`${DMI}: true`)],
    ['True', flagged(`${DMI}: True`)],
    ['TRUE', flagged(`${DMI}: TRUE`)],
    ['"true"', flagged(`${DMI}: "true"`)],
    ["'true'", flagged(`${DMI}: 'true'`)],
    ['"True"', flagged(`${DMI}: "True"`)],
    ['true（CRLF）', flagged(`${DMI}: true`, true)]
  ])('SFM-13 `disable-model-invocation: %s` → disableModelInvocation: true', (_label, text) => {
    const parsed = parse(text)!
    expect(parsed).not.toBeNull()
    expect(parsed.name).toBe('flag')
    expect(parsed.disableModelInvocation).toBe(true)
    // 另一个开关不受牵连
    expect('userInvocable' in parsed).toBe(false)
  })

  it.each<[string, string]>([
    ['不写', flagged(null)],
    ['false', flagged(`${DMI}: false`)],
    ['"false"', flagged(`${DMI}: "false"`)],
    ['yes', flagged(`${DMI}: yes`)],
    ['1', flagged(`${DMI}: 1`)],
    ['on', flagged(`${DMI}: on`)],
    ['空值', flagged(`${DMI}:`)],
    ['truee', flagged(`${DMI}: truee`)]
  ])('SFM-13 `disable-model-invocation` 写成 %s → 缺省（结果里没有这个键）', (_label, text) => {
    const parsed = parse(text)!
    expect(parsed).not.toBeNull()
    expect('disableModelInvocation' in parsed).toBe(false)
    expect('userInvocable' in parsed).toBe(false)
    expect(parsed).toEqual({ name: 'flag', description: 'd', content: 'Body text.' })
  })

  it.each<[string, string]>([
    ['false', flagged(`${UI}: false`)],
    ['False', flagged(`${UI}: False`)],
    ['"false"', flagged(`${UI}: "false"`)],
    ["'FALSE'", flagged(`${UI}: 'FALSE'`)],
    ['false（CRLF）', flagged(`${UI}: false`, true)]
  ])('SFM-14 `user-invocable: %s` → userInvocable: false', (_label, text) => {
    const parsed = parse(text)!
    expect(parsed).not.toBeNull()
    expect(parsed.name).toBe('flag')
    expect(parsed.userInvocable).toBe(false)
    expect('disableModelInvocation' in parsed).toBe(false)
  })

  it.each<[string, string]>([
    ['不写', flagged(null)],
    ['true', flagged(`${UI}: true`)],
    ['no', flagged(`${UI}: no`)],
    ['0', flagged(`${UI}: 0`)],
    ['off', flagged(`${UI}: off`)],
    ['空值', flagged(`${UI}:`)]
  ])('SFM-14 `user-invocable` 写成 %s → 缺省（结果里没有这个键）', (_label, text) => {
    const parsed = parse(text)!
    expect(parsed).not.toBeNull()
    expect('userInvocable' in parsed).toBe(false)
    expect('disableModelInvocation' in parsed).toBe(false)
    expect(parsed).toEqual({ name: 'flag', description: 'd', content: 'Body text.' })
  })

  it('SFM-15 四本启用着的默认技能：货架去掉只许用户调用的，命令池去掉只许模型调用的；findEnabled / findAll 四本都在', () => {
    writeSkill(DIRS.user, 'plain')
    writeSkill(DIRS.user, 'uonly', [`${DMI}: true`])
    writeSkill(DIRS.user, 'monly', [`${UI}: false`])
    writeSkill(DIRS.user, 'both', [`${DMI}: true`, `${UI}: false`])

    expect(namesOf(skillService.findModelInvocable())).toEqual(['monly', 'plain'])
    expect(commandIds()).toEqual(['plain', 'uonly'])
    // 两个开关都不是「停用」：四本照样启用着、照样列得出来
    expect(namesOf(skillService.findEnabled())).toEqual(['both', 'monly', 'plain', 'uonly'])
    expect(namesOf(skillService.findAll())).toEqual(['both', 'monly', 'plain', 'uonly'])

    // 解析结果流到了 Skill 上：只在写了非缺省值时有这两个键
    const byName = new Map(skillService.findAll().map((s) => [s.name, s]))
    expect(byName.get('both')).toMatchObject({ disableModelInvocation: true, userInvocable: false })
    expect(byName.get('uonly')!.disableModelInvocation).toBe(true)
    expect('userInvocable' in byName.get('uonly')!).toBe(false)
    expect(byName.get('monly')!.userInvocable).toBe(false)
    expect('disableModelInvocation' in byName.get('monly')!).toBe(false)
    expect('disableModelInvocation' in byName.get('plain')!).toBe(false)
    expect('userInvocable' in byName.get('plain')!).toBe(false)
  })

  it('SFM-16a 侧栏停用压过开关：只许用户调用的 uonly 一停用就不是命令了（货架上本来就没有它）', () => {
    writeSkill(DIRS.user, 'plain')
    writeSkill(DIRS.user, 'uonly', [`${DMI}: true`])
    expect(commandIds()).toEqual(['plain', 'uonly'])

    writeConfig({ disabled: ['uonly'] })
    expect(commandIds()).toEqual(['plain'])
    expect(namesOf(skillService.findModelInvocable())).toEqual(['plain'])
  })

  it('SFM-16b 项目级技能（恒启用）写了 disable-model-invocation：带 projectPath 时是命令、不在货架上', () => {
    const project = join(DIRS.root, 'proj')
    writeSkill(join(project, '.claude', 'skills'), 'deploy', [`${DMI}: true`])

    expect(namesOf(skillService.findEnabled(project))).toContain('deploy')
    expect(commandIds(project)).toContain('deploy')
    expect(namesOf(skillService.findModelInvocable(project))).not.toContain('deploy')
    // 不带项目路径时项目级技能根本不在场
    expect(commandIds()).not.toContain('deploy')
  })

  it('SFM-16c 共用目录（~/.claude/skills）里 user-invocable: false 的技能：整组没打开时哪边都没有；打开后只在货架上', () => {
    writeSkill(join(DIRS.root, 'home', '.claude', 'skills'), 'helper', [`${UI}: false`])

    // 列得出来（找得到），但这一组缺省关着
    expect(namesOf(skillService.findAll())).toContain('claude:helper')
    expect(namesOf(skillService.findModelInvocable())).not.toContain('claude:helper')
    expect(commandIds()).not.toContain('claude:helper')

    writeConfig({ enabledDirs: ['claude'] })
    expect(namesOf(skillService.findModelInvocable())).toContain('claude:helper')
    expect(commandIds()).not.toContain('claude:helper')
  })

  it('SFM-17 内置技能写了 disable-model-invocation：builtin:<名> 启用着、仍是命令，但不在货架上', () => {
    writeSkill(DIRS.builtin, 'secret', [`${DMI}: true`])
    writeSkill(DIRS.builtin, 'open')

    expect(namesOf(skillService.findEnabled())).toEqual(['builtin:open', 'builtin:secret'])
    expect(namesOf(skillService.findModelInvocable())).toEqual(['builtin:open'])
    expect(commandIds()).toEqual(['builtin:open', 'builtin:secret'])
  })
})
