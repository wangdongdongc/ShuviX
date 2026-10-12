/**
 * SSS —— skillService 眼里的**共用目录**：`~/.claude/skills`（组键 `claude`）与 `~/.agents/skills`
 * （组键 `agents`）。它们是别的工具的目录，宿主固定列出、不用用户添加：
 *
 *   - 组与技能的形状：`isShared: true`、`label` 是路径写法、技能标识 `<组键>:<skill>`、来源 `shared`；
 *   - **整组缺省关着**，记的是「打开了」（`enabledDirs`）—— 没写过配置、配置坏了、删掉配置，都是关着；
 *     别的分组照旧记「关掉了」（`disabledDirs`），两边互不串；
 *   - 一个技能都没有就不给这一组（它们移不掉）；读不了只让这一组空着，整份清单不抛；
 *   - **早先的外部目录照旧归它**：用户自己把同一个目录（按真实路径比）或同名的目录加成过外部目录的，
 *     那一条保持原样（开着、标识不变），共用那一组不列；移除了那条之后共用那一组才出现、而且是关着的；
 *   - 准入：外部目录取不了 `claude` / `agents`，也加不了一个在列的共用目录；`removeExternalDir` 对
 *     不在 `dirs` 里的名字（包括共用目录的组键）一律不动、回 false；
 *   - 可写根：共用目录下的笔记本落盘同样广播 `skill.changed`（侧栏跟得上改名）。
 *
 * 与 `skillServiceGroups.test.ts`（SSG）的接缝：SSG 测分组这一层对内置 / 默认 / 外部三族的形状与开关，
 * 它的共用目录指向不存在的位置；这一组只测共用目录，凡是 SSG 钉过的（排序、两级开关的「与」关系、
 * 外部目录的增删准入）都不重复。
 *
 * 目录全是 tmpdir 里现造的 fixture：`getSharedSkillsDirs` 打桩到夹具根下的假 home —— **绝不读跑测试
 * 那台机器的家目录**。`skillService` 是模块级单例、构造时就记下默认根，根路径必须在 hoist 期定死；
 * 每个用例 beforeEach 把整棵树删掉重建（只建 builtin / user / ext —— 假 home 由用例自己按需造，
 * 「目录不存在」本身就是 SSS-1 的被测情形）。
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { join, resolve } from 'node:path'

const DIRS = vi.hoisted(() => {
  const base = process.env.TMPDIR || process.env.TMP || process.env.TEMP || '/tmp'
  const root = `${base.replace(/\/+$/, '')}/shuvix-skill-shared-${process.pid}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}`
  const home = `${root}/home`
  return {
    root,
    builtin: `${root}/builtin`,
    user: `${root}/user`,
    ext: `${root}/ext`,
    ext2: `${root}/ext2`,
    home,
    claude: `${home}/.claude/skills`,
    agents: `${home}/.agents/skills`
  }
})

vi.mock('../../utils/paths', () => ({
  getBuiltinSkillsDir: () => DIRS.builtin,
  getDefaultSkillsDir: () => DIRS.user,
  getSharedSkillsDirs: () => ({ claude: DIRS.claude, agents: DIRS.agents })
}))

import { appEventBus } from '../../utils/appEventBus'
import { skillService } from '../skillService'

const publish = vi.spyOn(appEventBus, 'publish')

const CONFIG_PATH = join(DIRS.user, '.config.json')

/** 写一个技能目录（frontmatter 的 name 缺省 = 目录名） */
const writeSkill = (dir: string, dirEntry: string, name = dirEntry, description = 'd'): string => {
  const base = join(dir, dirEntry)
  mkdirSync(base, { recursive: true })
  writeFileSync(
    join(base, 'SKILL.md'),
    `---\nname: ${name}\ndescription: "${description}"\n---\n\n${dirEntry.toUpperCase()} BODY\n`,
    'utf8'
  )
  return base
}

const readConfig = (): string => (existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, 'utf8') : '')
const configJson = (): {
  disabled: string[]
  disabledDirs: string[]
  enabledDirs: string[]
  dirs: Array<{ name: string; path: string }>
} => JSON.parse(readConfig())
/** 手写一份配置（模拟早先版本写下的、或用户手改的 .config.json） */
const writeConfig = (config: unknown): void =>
  writeFileSync(CONFIG_PATH, typeof config === 'string' ? config : JSON.stringify(config), 'utf8')

const namesOf = (skills: { name: string }[]): string[] => skills.map((s) => s.name).sort()

type Group = ReturnType<typeof skillService.findAllGrouped>[number]
const groupNames = (): string[] => skillService.findAllGrouped().map((g) => g.dirName)
const groupOf = (dirName: string): Group | undefined =>
  skillService.findAllGrouped().find((g) => g.dirName === dirName)

/** 一个路径的真实位置（解析不了就 resolve 之后的字面）—— 比「是不是同一个目录」用 */
const real = (p: string): string => {
  try {
    return realpathSync.native(p)
  } catch {
    return resolve(p)
  }
}

beforeEach(() => {
  rmSync(DIRS.root, { recursive: true, force: true })
  for (const dir of [DIRS.builtin, DIRS.user, DIRS.ext]) mkdirSync(dir, { recursive: true })
  publish.mockClear()
})

afterAll(() => {
  rmSync(DIRS.root, { recursive: true, force: true })
})

describe('SSS 共用目录不存在', () => {
  it('SSS-1 两个共用目录都不存在：没有 claude / agents 组，也没有 shared 技能；整个过程不建家目录', () => {
    writeSkill(DIRS.user, 'mine')
    const noShared = (): void => {
      const groups = skillService.findAllGrouped()
      expect(groups.map((g) => g.dirName)).not.toContain('claude')
      expect(groups.map((g) => g.dirName)).not.toContain('agents')
      expect(groups.some((g) => g.isShared)).toBe(false)
      expect(skillService.findAll().some((s) => s.source === 'shared')).toBe(false)
    }

    noShared()
    expect(namesOf(skillService.findAll())).toEqual(['mine'])
    expect(namesOf(skillService.findEnabled())).toEqual(['mine'])
    expect(skillService.enabledSkillRoots()).toEqual([DIRS.user])
    // 打开一个不存在的共用目录：只是一条配置，不该把目录建出来
    skillService.setGroupEnabled('agents', true)
    noShared()
    expect(namesOf(skillService.findEnabled())).toEqual(['mine'])
    // 只给路径、不建目录 —— 没用过那些工具的人，这两个目录不该凭空出现
    expect(existsSync(DIRS.home)).toBe(false)
  })
})

describe('SSS 组与技能的形状', () => {
  it('SSS-2 共用组：isShared + 路径写法的 label，缺省关着；技能 = <组键>:<name>、来源 shared、自己那一级开着', () => {
    writeSkill(DIRS.builtin, 'drawing')
    writeSkill(DIRS.user, 'mine')
    skillService.addExternalDir({ name: 'ext', path: DIRS.ext })
    writeSkill(DIRS.ext, 'tool')
    const pdf = writeSkill(DIRS.agents, 'pdf')
    const review = writeSkill(DIRS.claude, 'review')

    const agents = groupOf('agents')!
    expect(agents).toMatchObject({
      dirName: 'agents',
      dirPath: DIRS.agents,
      isDefault: false,
      isShared: true,
      label: '~/.agents/skills',
      isEnabled: false
    })
    expect(agents.skills).toHaveLength(1)
    expect(agents.skills[0]).toMatchObject({
      name: 'agents:pdf',
      source: 'shared',
      dirName: 'agents',
      basePath: pdf,
      isEnabled: true
    })

    const claude = groupOf('claude')!
    expect(claude).toMatchObject({
      dirName: 'claude',
      dirPath: DIRS.claude,
      isDefault: false,
      isShared: true,
      label: '~/.claude/skills',
      isEnabled: false
    })
    expect(claude.skills).toHaveLength(1)
    expect(claude.skills[0]).toMatchObject({
      name: 'claude:review',
      source: 'shared',
      dirName: 'claude',
      basePath: review,
      isEnabled: true
    })

    // 别的分组都不是共用的，也不带 label（侧栏缺省显示 dirName / 本地化的「内置」）
    const others = skillService
      .findAllGrouped()
      .filter((g) => !['claude', 'agents'].includes(g.dirName))
    expect(others.map((g) => g.dirName)).toEqual(['builtin', 'default', 'ext'])
    for (const g of others) {
      expect(g.isShared, g.dirName).toBe(false)
      expect(g.label, g.dirName).toBeUndefined()
    }

    // 按名字查到的是同一份
    expect(skillService.findByName('agents:pdf')).toEqual(agents.skills[0])
    expect(skillService.findByName('claude:review')).toEqual(claude.skills[0])
  })
})

describe('SSS 整组缺省关着（enabledDirs 是 opt-in）', () => {
  const CONFIGS: Array<[string, string | null]> = [
    ['没有配置文件', null],
    ['空的完整配置', JSON.stringify({ disabled: [], disabledDirs: [], dirs: [] })],
    ['只有 disabledDirs', JSON.stringify({ disabledDirs: [] })],
    ['写坏了的配置', '{']
  ]

  it.each(CONFIGS)(
    'SSS-3 %s：两个共用技能在 findAll 里，但 findEnabled / 命令池 / 技能根都只有默认目录的',
    (_label, raw) => {
      writeSkill(DIRS.user, 'mine')
      writeSkill(DIRS.agents, 'pdf')
      writeSkill(DIRS.claude, 'review')
      if (raw !== null) writeConfig(raw)

      expect(namesOf(skillService.findAll())).toEqual(['agents:pdf', 'claude:review', 'mine'])
      expect(namesOf(skillService.findEnabled())).toEqual(['mine'])
      expect(skillService.findEnabledAsCommands().map((c) => c.commandId)).toEqual(['mine'])
      // 技能根决定 agent 读 references/*.md 免不免询问 —— 关着的共用目录不该在里面
      expect(skillService.enabledSkillRoots()).toEqual([DIRS.user])
      expect(groupOf('agents')?.isEnabled).toBe(false)
      expect(groupOf('claude')?.isEnabled).toBe(false)
    }
  )

  it('SSS-4 打开 agents（两次）再关：enabledDirs 不重复、disabledDirs 从不出现它；每次恰一条 skill.changed；claude 不受牵连', () => {
    writeSkill(DIRS.user, 'mine')
    writeSkill(DIRS.agents, 'pdf')
    writeSkill(DIRS.claude, 'review')

    for (let i = 0; i < 2; i++) {
      publish.mockClear()
      skillService.setGroupEnabled('agents', true)
      expect(publish.mock.calls, `on #${i + 1}`).toEqual([[{ type: 'skill.changed' }]])
      expect(configJson().enabledDirs).toEqual(['agents'])
      expect(configJson().disabledDirs).not.toContain('agents')
    }

    expect(groupOf('agents')?.isEnabled).toBe(true)
    expect(groupOf('claude')?.isEnabled).toBe(false)
    const enabled = namesOf(skillService.findEnabled())
    expect(enabled).toContain('agents:pdf')
    expect(enabled).not.toContain('claude:review')
    expect(enabled).toEqual(['agents:pdf', 'mine'])

    const command = skillService.findEnabledAsCommands().find((c) => c.commandId === 'agents:pdf')!
    expect(command.template.startsWith(`Base directory for this skill: ${DIRS.agents}/pdf`)).toBe(
      true
    )
    expect(skillService.enabledSkillRoots()).toEqual([DIRS.user, DIRS.agents])

    publish.mockClear()
    skillService.setGroupEnabled('agents', false)
    expect(publish.mock.calls).toEqual([[{ type: 'skill.changed' }]])
    expect(configJson().enabledDirs).toEqual([])
    expect(configJson().disabledDirs).not.toContain('agents')
    expect(groupOf('agents')?.isEnabled).toBe(false)
    expect(groupOf('claude')?.isEnabled).toBe(false)
    expect(namesOf(skillService.findEnabled())).toEqual(['mine'])
    expect(skillService.enabledSkillRoots()).toEqual([DIRS.user])
  })

  it('SSS-5 打开之后删掉 .config.json：回到关着（不是「没写过就全开」）', () => {
    // 这正是共用目录记 opt-in 而不是预塞一条 disabledDirs 的理由
    writeSkill(DIRS.agents, 'pdf')
    skillService.setGroupEnabled('agents', true)
    expect(namesOf(skillService.findEnabled())).toEqual(['agents:pdf'])

    rmSync(CONFIG_PATH)
    expect(groupOf('agents')?.isEnabled).toBe(false)
    expect(skillService.findEnabled()).toEqual([])
    expect(skillService.enabledSkillRoots()).toEqual([DIRS.user])
  })

  it('SSS-6 别的写配置路径都不吞掉 enabledDirs', () => {
    // 每个写配置的地方都是「读整份 → 改一处 → 写整份」：哪一处漏抄了 enabledDirs，
    // 用户点一下别的开关，共用目录就悄悄关回去
    mkdirSync(DIRS.ext2, { recursive: true })
    writeSkill(DIRS.user, 'mine')
    writeSkill(DIRS.agents, 'pdf')
    skillService.setGroupEnabled('agents', true)

    const steps: Array<[string, () => void]> = [
      ['update(mine, false)', () => skillService.update({ name: 'mine', isEnabled: false })],
      ['setGroupEnabled(default, false)', () => skillService.setGroupEnabled('default', false)],
      ['addExternalDir(ext)', () => skillService.addExternalDir({ name: 'ext', path: DIRS.ext })],
      ['setGroupEnabled(ext, false)', () => skillService.setGroupEnabled('ext', false)],
      [
        'addExternalDir(ext2)',
        () => skillService.addExternalDir({ name: 'ext2', path: DIRS.ext2 })
      ],
      ['removeExternalDir(ext2)', () => void skillService.removeExternalDir('ext2')],
      ['deleteDefaultSkill(mine)', () => skillService.deleteDefaultSkill('mine')]
    ]
    for (const [what, act] of steps) {
      act()
      expect(configJson().enabledDirs, what).toEqual(['agents'])
      expect(groupOf('agents')?.isEnabled, what).toBe(true)
      expect(namesOf(skillService.findEnabled()), what).toContain('agents:pdf')
    }
  })

  it('SSS-7 共用组里单个技能的开关缺省开着，与整组开关正交', () => {
    writeSkill(DIRS.agents, 'pdf')
    writeSkill(DIRS.agents, 'docx')

    // 组关着：两个技能自己那一级都是开着的（行变淡来自组这一级）
    expect(groupOf('agents')?.skills.map((s) => [s.name, s.isEnabled])).toEqual([
      ['agents:docx', true],
      ['agents:pdf', true]
    ])
    expect(skillService.findEnabled()).toEqual([])

    skillService.update({ name: 'agents:pdf', isEnabled: false })
    // 组仍关着：一个都不在架
    expect(skillService.findEnabled()).toEqual([])
    expect(configJson().disabled).toEqual(['agents:pdf'])

    skillService.setGroupEnabled('agents', true)
    expect(namesOf(skillService.findEnabled())).toEqual(['agents:docx'])
    // 组开关不改写单个技能的那一级
    expect(groupOf('agents')?.skills.map((s) => [s.name, s.isEnabled])).toEqual([
      ['agents:docx', true],
      ['agents:pdf', false]
    ])

    skillService.setGroupEnabled('agents', false)
    expect(skillService.findEnabled()).toEqual([])
    expect(configJson().disabled).toEqual(['agents:pdf'])

    skillService.setGroupEnabled('agents', true)
    skillService.update({ name: 'agents:pdf', isEnabled: true })
    expect(namesOf(skillService.findEnabled())).toEqual(['agents:docx', 'agents:pdf'])
  })
})

describe('SSS 什么时候列这一组', () => {
  it('SSS-8 一个技能都没有就不给这一组（空目录 / 没有 SKILL.md 的子目录 / 只有 .git 与 .DS_Store）；空的外部目录照样列', () => {
    // 共用目录移不掉：没用过那些工具的人不该天天看着两行空文件夹。外部目录相反 —— 移除入口只长在
    // 文件夹行上，空的也得列（SSG 那边的契约，这里只当对照组）
    skillService.addExternalDir({ name: 'ext', path: DIRS.ext })
    const check = (what: string, listed: boolean): void => {
      const names = groupNames()
      expect(names.includes('agents'), what).toBe(listed)
      expect(names, what).toContain('ext')
      expect(names, what).not.toContain('claude')
    }

    mkdirSync(DIRS.agents, { recursive: true })
    check('empty dir', false)

    mkdirSync(join(DIRS.agents, 'not-a-skill', 'references'), { recursive: true })
    writeFileSync(join(DIRS.agents, 'not-a-skill', 'README.md'), '# nope\n')
    check('subdir without SKILL.md', false)

    rmSync(join(DIRS.agents, 'not-a-skill'), { recursive: true, force: true })
    mkdirSync(join(DIRS.agents, '.git'), { recursive: true })
    writeFileSync(join(DIRS.agents, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    writeFileSync(join(DIRS.agents, '.DS_Store'), '')
    check('only .git/ + .DS_Store', false)

    writeSkill(DIRS.agents, 'pdf')
    check('one real skill', true)
    expect(groupOf('agents')?.skills.map((s) => s.name)).toEqual(['agents:pdf'])
  })

  describe('SSS-9 读不了的共用目录只让这一组空着，整份清单不抛', () => {
    const exercise = (): void => {
      let groups: Group[] = []
      expect(() => (groups = skillService.findAllGrouped())).not.toThrow()
      expect(() => skillService.findAll()).not.toThrow()
      expect(() => skillService.findEnabled()).not.toThrow()
      expect(() => skillService.findEnabledAsCommands()).not.toThrow()
      expect(() => skillService.enabledSkillRoots()).not.toThrow()
      expect(() => skillService.listSharedDirs()).not.toThrow()
      expect(groups.map((g) => g.dirName)).toEqual(['builtin', 'default', 'claude'])
      expect(namesOf(skillService.findEnabled())).toEqual(['builtin:drawing', 'claude:review'])
    }

    beforeEach(() => {
      writeSkill(DIRS.builtin, 'drawing')
      writeSkill(DIRS.claude, 'review')
      // 两组都打开：findEnabled 那条路也要真的走到 agents
      skillService.setGroupEnabled('claude', true)
      skillService.setGroupEnabled('agents', true)
    })

    it('(a) ~/.agents/skills 是一个普通文件', () => {
      mkdirSync(join(DIRS.home, '.agents'), { recursive: true })
      writeFileSync(DIRS.agents, 'not a directory\n')
      exercise()
    })

    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
      '(b) ~/.agents/skills 权限是 000',
      () => {
        writeSkill(DIRS.agents, 'pdf')
        chmodSync(DIRS.agents, 0o000)
        try {
          exercise()
        } finally {
          // 不还原的话 beforeEach / afterAll 的 rmSync 删不掉它
          chmodSync(DIRS.agents, 0o755)
        }
      }
    )
  })
})

describe.skipIf(process.platform === 'win32')('SSS 共用目录里的符号链接', () => {
  it('SSS-10 claude 里只有指向 agents 技能的链接 + 一条悬空链接：不给 claude 组，那个技能只列一次（agents 那份）', () => {
    // `npx skills add -g` 的符号链接模式：真目录在 ~/.agents/skills，别的工具目录里放链接
    const pdf = writeSkill(DIRS.agents, 'pdf')
    mkdirSync(DIRS.claude, { recursive: true })
    symlinkSync(pdf, join(DIRS.claude, 'pdf'))
    symlinkSync(join(DIRS.root, 'gone'), join(DIRS.claude, 'dangling'))

    let groups: Group[] = []
    expect(() => (groups = skillService.findAllGrouped())).not.toThrow()
    expect(groups.map((g) => g.dirName)).not.toContain('claude')
    expect(groups.find((g) => g.dirName === 'agents')?.skills.map((s) => s.name)).toEqual([
      'agents:pdf'
    ])
    expect(skillService.findByName('claude:pdf')).toBe(null)
    expect(skillService.findAll().filter((s) => s.basePath === pdf)).toHaveLength(1)

    // 对照组：claude 里再放一个真技能 → 组出现，但只列真的那一个
    writeSkill(DIRS.claude, 'review')
    expect(groupOf('claude')?.skills.map((s) => s.name)).toEqual(['claude:review'])
    expect(skillService.findByName('claude:pdf')).toBe(null)
  })

  it('SSS-11 ~/.claude/skills 本身是一条链接（dotfiles 仓库）：跟过去列，dirPath 仍是链接那个路径', () => {
    const target = join(DIRS.root, 'dotfiles', 'cs')
    writeSkill(target, 'review')
    mkdirSync(join(DIRS.home, '.claude'), { recursive: true })
    symlinkSync(target, DIRS.claude)

    const claude = groupOf('claude')!
    expect(claude.dirPath).toBe(DIRS.claude)
    expect(claude.skills.map((s) => s.name)).toEqual(['claude:review'])
    expect(claude.skills[0].basePath).toBe(join(DIRS.claude, 'review'))
    expect(skillService.isInsideWritableRoot(join(DIRS.claude, 'review', 'SKILL.md'))).toBe(true)
  })
})

describe('SSS 两个共用目录里的同名技能', () => {
  it('SSS-12 两份真拷贝同名：两个标识各算各的；只打开 agents 只上架 agents 那份', () => {
    const inAgents = writeSkill(DIRS.agents, 'x')
    const inClaude = writeSkill(DIRS.claude, 'x')

    expect(namesOf(skillService.findAll())).toEqual(['agents:x', 'claude:x'])
    expect(skillService.findByName('agents:x')?.basePath).toBe(inAgents)
    expect(skillService.findByName('claude:x')?.basePath).toBe(inClaude)

    skillService.setGroupEnabled('agents', true)
    expect(namesOf(skillService.findEnabled())).toEqual(['agents:x'])
    expect(skillService.findEnabledAsCommands().map((c) => c.commandId)).toEqual(['agents:x'])
  })
})

describe('SSS 早先的外部目录照旧归它', () => {
  // 外部目录加的是同一个 ~/.agents/skills，只是写法不同：按真实路径比，统统算撞
  const variants: Array<[string, () => string]> = [
    ['逐字相同', () => DIRS.agents],
    ['尾斜杠', () => `${DIRS.agents}/`],
    ['带 ..', () => `${DIRS.home}/.agents/../.agents/skills`]
  ]
  if (process.platform !== 'win32') {
    variants.push([
      '一条指向它的链接',
      () => {
        const link = join(DIRS.root, 'link-to-agents')
        symlinkSync(DIRS.agents, link)
        return link
      }
    ])
  }

  it.each(variants)(
    'SSS-13 外部目录 mine-agents 的路径 = ~/.agents/skills（%s）：不给 agents 组，它的技能照旧以 mine-agents:* 开着',
    (_label, pathOf) => {
      writeSkill(DIRS.agents, 'pdf')
      const legacyPath = pathOf()
      // 手写的配置：早先版本里用户自己加的；enabledDirs 里有 agents —— 即使如此也不该再列一份
      writeConfig({
        disabled: [],
        disabledDirs: [],
        enabledDirs: ['agents'],
        dirs: [{ name: 'mine-agents', path: legacyPath }]
      })

      const groups = skillService.findAllGrouped()
      expect(groups.map((g) => g.dirName)).not.toContain('agents')
      expect(groups.some((g) => g.isShared)).toBe(false)
      const legacy = groups.find((g) => g.dirName === 'mine-agents')!
      expect(legacy.isShared).toBe(false)
      expect(legacy.isEnabled).toBe(true)
      expect(legacy.skills.map((s) => [s.name, s.source, s.isEnabled])).toEqual([
        ['mine-agents:pdf', 'external', true]
      ])

      const enabled = namesOf(skillService.findEnabled())
      expect(enabled).toEqual(['mine-agents:pdf'])
      expect(enabled).not.toContain('agents:pdf')
      expect(skillService.findAll().some((s) => s.source === 'shared')).toBe(false)

      expect(skillService.listSharedDirs()).toEqual([{ name: 'claude', path: DIRS.claude }])
      // 同一个目录在技能根里只出现一次（它是 mine-agents 那一条）
      const roots = skillService.enabledSkillRoots()
      expect(roots.filter((r) => real(r) === real(DIRS.agents))).toHaveLength(1)
    }
  )

  /** 早先的外部目录叫 `claude`，指向别处；真的 ~/.claude/skills 里也有技能 */
  const seedLegacyClaude = (): string => {
    const legacy = join(DIRS.root, 'legacy')
    writeSkill(legacy, 'old')
    writeSkill(DIRS.claude, 'review')
    writeConfig({ disabled: [], disabledDirs: [], dirs: [{ name: 'claude', path: legacy }] })
    return legacy
  }

  it('SSS-14 外部目录名叫 claude（指向别处）：只有一个 claude 组，就是它；~/.claude/skills 下什么都不列；组开关记 disabledDirs', () => {
    const legacy = seedLegacyClaude()

    const claudeGroups = skillService.findAllGrouped().filter((g) => g.dirName === 'claude')
    expect(claudeGroups).toHaveLength(1)
    const [claude] = claudeGroups
    expect(claude.isShared).toBe(false)
    expect(claude.label).toBeUndefined()
    expect(claude.dirPath).toBe(legacy)
    expect(claude.isEnabled).toBe(true)
    expect(claude.skills.map((s) => [s.name, s.source, s.isEnabled])).toEqual([
      ['claude:old', 'external', true]
    ])
    expect(namesOf(skillService.findEnabled())).toEqual(['claude:old'])
    // 真的 ~/.claude/skills 一个技能都不出现
    expect(skillService.findAll().some((s) => s.basePath.startsWith(DIRS.claude))).toBe(false)
    expect(skillService.findByName('claude:review')).toBe(null)

    // 它是外部目录：开关照外部目录的口径（opt-out）
    skillService.setGroupEnabled('claude', false)
    expect(configJson().disabledDirs).toEqual(['claude'])
    expect(configJson().enabledDirs).toEqual([])
    expect(groupOf('claude')?.isEnabled).toBe(false)
  })

  it('SSS-15 接上一条：移除那个外部 claude（回 true）→ 共用的 claude 组出现，且是关着的', () => {
    seedLegacyClaude()
    skillService.setGroupEnabled('claude', false)

    expect(skillService.removeExternalDir('claude')).toBe(true)
    expect(skillService.listExternalDirs()).toEqual([])
    expect(configJson().disabledDirs).not.toContain('claude')

    const claude = groupOf('claude')!
    expect(claude.isShared).toBe(true)
    expect(claude.dirPath).toBe(DIRS.claude)
    expect(claude.label).toBe('~/.claude/skills')
    expect(claude.skills.map((s) => s.name)).toEqual(['claude:review'])
    expect(claude.isEnabled).toBe(false)
    expect(namesOf(skillService.findEnabled())).not.toContain('claude:review')
  })
})

describe('SSS 准入', () => {
  it.each(['claude', 'agents', '  agents  '])(
    'SSS-16 外部目录取不了共用目录的组键 %j：reserved，配置不动',
    (name) => {
      const before = readConfig()
      expect(() => skillService.addExternalDir({ name, path: DIRS.ext })).toThrow(/reserved/)
      expect(readConfig()).toBe(before)
      expect(skillService.listExternalDirs()).toEqual([])
      expect(publish).not.toHaveBeenCalled()
    }
  )

  const SHARED_REFUSAL = /a shared skills directory that ShuviX lists by itself/
  const sharedPathVariants: Array<[string, () => string]> = [
    ['逐字相同', () => DIRS.agents],
    ['尾斜杠', () => `${DIRS.agents}/`],
    ['带 ./', () => `${DIRS.home}/.agents/./skills`]
  ]
  if (process.platform !== 'win32') {
    sharedPathVariants.push([
      '一条指向它的链接',
      () => {
        const link = join(DIRS.root, 'agents-link')
        symlinkSync(DIRS.agents, link)
        return link
      }
    ])
  }

  it.each(sharedPathVariants)(
    'SSS-17 加一个在列的共用目录（%s）：拒，配置逐字不变；目录里没有技能也一样拒',
    (_label, pathOf) => {
      mkdirSync(DIRS.agents, { recursive: true })
      // 先让配置文件存在，才比得出「逐字不变」
      skillService.setGroupEnabled('claude', true)
      const path = pathOf()

      // 目录是空的（共用组此时不列）：照样拒 —— 判的是「在不在列」，不是「列没列出来」
      const before = readConfig()
      publish.mockClear()
      expect(() => skillService.addExternalDir({ name: 'my-agents', path })).toThrow(SHARED_REFUSAL)
      expect(() => skillService.addExternalDir({ name: 'my-agents', path })).toThrow(
        /~\/\.agents\/skills/
      )
      expect(readConfig()).toBe(before)
      expect(publish).not.toHaveBeenCalled()

      writeSkill(DIRS.agents, 'pdf')
      expect(() => skillService.addExternalDir({ name: 'my-agents', path })).toThrow(SHARED_REFUSAL)
      expect(readConfig()).toBe(before)
      expect(skillService.listExternalDirs()).toEqual([])
    }
  )

  it('SSS-17 边界：claude 已被同名的外部目录占着（不在列）时，~/.claude/skills 可以作为另一个外部目录加进来', () => {
    const legacy = join(DIRS.root, 'legacy')
    writeSkill(legacy, 'old')
    writeSkill(DIRS.claude, 'review')
    writeConfig({ disabled: [], disabledDirs: [], dirs: [{ name: 'claude', path: legacy }] })

    expect(() => skillService.addExternalDir({ name: 'cc', path: DIRS.claude })).not.toThrow()
    expect(skillService.listExternalDirs().map((d) => d.name)).toEqual(['claude', 'cc'])
    expect(groupOf('cc')?.skills.map((s) => [s.name, s.source])).toEqual([
      ['cc:review', 'external']
    ])
  })

  it('SSS-18 共用组移不掉：removeExternalDir(组键) 回 false，配置逐字不变、不广播，组仍在；不在 dirs 里的名字同样 no-op', () => {
    writeSkill(DIRS.agents, 'pdf')
    skillService.setGroupEnabled('agents', true)
    skillService.update({ name: 'agents:pdf', isEnabled: false })
    const before = readConfig()

    for (const name of ['agents', ' agents ', 'claude']) {
      publish.mockClear()
      expect(skillService.removeExternalDir(name), name).toBe(false)
      expect(readConfig(), name).toBe(before)
      expect(publish, name).not.toHaveBeenCalled()
    }
    // 那一组的两级开关记录都还在
    expect(configJson().enabledDirs).toEqual(['agents'])
    expect(configJson().disabled).toEqual(['agents:pdf'])
    expect(groupOf('agents')?.isShared).toBe(true)

    // 没写过配置时：也不建出配置文件
    rmSync(CONFIG_PATH)
    publish.mockClear()
    expect(skillService.removeExternalDir('nope')).toBe(false)
    expect(existsSync(CONFIG_PATH)).toBe(false)
    expect(publish).not.toHaveBeenCalled()
  })

  it('SSS-19 listSharedDirs：claude 在前、agents 在后，与开关无关，目录不存在也列', () => {
    const expected = [
      { name: 'claude', path: DIRS.claude },
      { name: 'agents', path: DIRS.agents }
    ]
    expect(existsSync(DIRS.home)).toBe(false)
    expect(skillService.listSharedDirs()).toEqual(expected)

    skillService.setGroupEnabled('agents', true)
    expect(skillService.listSharedDirs()).toEqual(expected)
    skillService.setGroupEnabled('claude', true)
    skillService.setGroupEnabled('agents', false)
    expect(skillService.listSharedDirs()).toEqual(expected)
  })
})

describe('SSS 可写根与写入回执', () => {
  it('SSS-20 共用目录下的文件算可写根（与开关无关）；兄弟前缀与根本身不算；落盘后合并窗口里恰一条 skill.changed', () => {
    const underAgents = join(DIRS.agents, 'pdf', 'SKILL.md')
    const underClaude = join(DIRS.claude, 'review', 'SKILL.md')

    expect(skillService.isInsideWritableRoot(underAgents)).toBe(true)
    expect(skillService.isInsideWritableRoot(underClaude)).toBe(true)
    skillService.setGroupEnabled('agents', true)
    expect(skillService.isInsideWritableRoot(underAgents)).toBe(true)
    expect(skillService.isInsideWritableRoot(underClaude)).toBe(true)

    expect(skillService.isInsideWritableRoot(`${DIRS.agents}-old/pdf/SKILL.md`)).toBe(false)
    expect(skillService.isInsideWritableRoot(DIRS.agents)).toBe(false)
    expect(skillService.isInsideWritableRoot(DIRS.claude)).toBe(false)

    vi.useFakeTimers()
    try {
      publish.mockClear()
      skillService.noteFileWritten(underAgents)
      expect(publish).not.toHaveBeenCalled()
      vi.advanceTimersByTime(300)
      expect(publish.mock.calls).toEqual([[{ type: 'skill.changed' }]])
    } finally {
      vi.useRealTimers()
    }
  })

  it('SSS-20 被同名外部目录占着的 ~/.claude/skills 不是可写根（它不在列）', () => {
    const legacy = join(DIRS.root, 'legacy')
    writeSkill(legacy, 'old')
    writeSkill(DIRS.claude, 'review')
    writeConfig({ disabled: [], disabledDirs: [], dirs: [{ name: 'claude', path: legacy }] })

    expect(skillService.isInsideWritableRoot(join(DIRS.claude, 'review', 'SKILL.md'))).toBe(false)
    // 那个外部目录自己是可写根
    expect(skillService.isInsideWritableRoot(join(legacy, 'old', 'SKILL.md'))).toBe(true)
  })
})

describe('SSS 分组顺序', () => {
  it('SSS-21 服务给的顺序：builtin → default → claude → agents → 外部目录；isShared 恰为那两个', () => {
    // 侧栏宿主再重排成 内置 → 共用 → 外部 → 默认（renderer Sidebar），这里钉的是服务那一侧
    writeSkill(DIRS.builtin, 'drawing')
    writeSkill(DIRS.user, 'mine')
    skillService.addExternalDir({ name: 'ext', path: DIRS.ext })
    writeSkill(DIRS.ext, 'tool')
    writeSkill(DIRS.agents, 'pdf')
    writeSkill(DIRS.claude, 'review')

    const groups = skillService.findAllGrouped()
    expect(groups.map((g) => g.dirName)).toEqual(['builtin', 'default', 'claude', 'agents', 'ext'])
    expect(groups.filter((g) => g.isShared).map((g) => g.dirName)).toEqual(['claude', 'agents'])
  })
})
