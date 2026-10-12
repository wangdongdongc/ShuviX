/**
 * SSG —— skillService 眼里的**分组**：`findAllGrouped` 的形状与顺序、两级启用开关（单个技能 +
 * 整个目录）、外部目录的增删准入，以及笔记本落盘之后的写入回执（`skill.changed`）。
 *
 * 与 `skillServiceBuiltin.test.ts`（SSB）的接缝：SSB 测的是**内置那一族**——名字空间
 * `builtin:<name>`、缺省在架、与同名用户技能并存；这一组测的是**分组这一层**，凡是 SSB 已经
 * 钉过的（内置的 dirName / basePath / 并存关系）都不重复。唯一的交叉是「整组关掉」：SSB-4 只走了
 * builtin 一条分支，SSG-3 把三个组键（`default` / `builtin` / 外部目录名）各走一遍，因为侧栏那一组
 * 的行变淡判据是 `!skill.isEnabled || !folder.isEnabled` —— 组开关得真的对每一族都生效。
 *
 * 目录用 tmpdir 里现造的 fixture（`../../utils/paths` 打桩，同 SSB / toolContext.test.ts 惯例）。
 * `skillService` 是模块级单例、构造时就记下默认根，所以根路径必须在 hoist 期定死；每个用例
 * beforeEach 把整棵树删掉重建，互不串味。
 *
 * ⚠️ SSG-15 会让产品代码走到 `rmSync(recursive)` 的那条路：夹具根是本文件独有的一次性目录，
 * 哨兵是它的**子目录**，任何断言都不把路径算到这个根之外。
 *
 * SSG-17 在各个技能根里放符号链接条目（真技能目录放在各根之外、同一个夹具根之下）：beforeEach 的
 * rmSync(recursive) 删的是链接本身、不跟过去，整棵树照样一次清干净。
 *
 * 共用目录（`~/.claude/skills` / `~/.agents/skills`，组键 `claude` / `agents`）归
 * `skillServiceShared.test.ts`（SSS）。这里的 paths 桩把它们指到夹具根下的假 home，平时不存在；
 * 只有 SSG-15b 往 agents 那一个里放了一个技能（删除只对默认目录开放，共用目录也不例外）。
 *
 * SSG-18..26 是「同一个目录换个写法」：末尾 `/`、`//`、`.` / `..` 段、符号链接（叶子或祖先）、真实位置
 * 那种写法（夹具根在 macOS 的 TMPDIR 下时是 `/private/var/…`）、不分大小写磁盘上的大小写变体 —— 加外部
 * 目录时都算同一个；落库的是 resolve 过的写法；`<链接>/..` 这种两边说的不是同一个目录的路径一律不收；
 * 早先版本写下的带尾斜杠的旧条目照旧认、不改写。符号链接的用例 Windows 上跳过（同 SSS）。
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, join } from 'node:path'

/**
 * 路径字符串在 hoist 期就要定下来（桩工厂先于一切 import 求值，而 skillService 构造时
 * 就调 getDefaultSkillsDir）。目录本身 beforeEach 现造 —— 名字带 pid + 时间 + 随机段，
 * 与并行跑的别的文件、以及上一次运行的残留都不会撞
 */
const DIRS = vi.hoisted(() => {
  const base = process.env.TMPDIR || process.env.TMP || process.env.TEMP || '/tmp'
  const root = `${base.replace(/\/+$/, '')}/shuvix-skill-groups-${process.pid}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}`
  return {
    root,
    builtin: `${root}/builtin`,
    user: `${root}/user`,
    ext: `${root}/ext`,
    ext2: `${root}/ext2`,
    extMoved: `${root}/ext-moved`,
    /** 越界删除的哨兵：默认根的**兄弟**，`<user>/../sentinel` 正好落在它身上 */
    sentinel: `${root}/sentinel`,
    /** 共用目录（假 home 下）：beforeEach 不建，SSG-15b 现造 */
    sharedClaude: `${root}/home/.claude/skills`,
    sharedAgents: `${root}/home/.agents/skills`
  }
})

vi.mock('../../utils/paths', () => ({
  // 内置那一层：产线上是 `skills/<lang>/`，这里就是一个放技能目录的普通目录
  getBuiltinSkillsDir: () => DIRS.builtin,
  getDefaultSkillsDir: () => DIRS.user,
  // 共用目录指向夹具根下（平时不存在）的假 home：这一组只在 SSG-15b 用到 agents 那一个，
  // 绝不能读到跑测试那台机器的家目录
  getSharedSkillsDirs: () => ({ claude: DIRS.sharedClaude, agents: DIRS.sharedAgents })
}))

import { appEventBus } from '../../utils/appEventBus'
import { skillService } from '../skillService'

const publish = vi.spyOn(appEventBus, 'publish')

const CONFIG_PATH = join(DIRS.user, '.config.json')

/** 写一个技能目录（frontmatter 的 name 可与目录名不同 —— SSG-14 要的正是这一点） */
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

/** 手写一份原样的配置文本（模拟早先版本写下的 .config.json —— 产品代码今天不会再这么写） */
const writeRawConfig = (text: string): void => writeFileSync(CONFIG_PATH, text, 'utf8')

const namesOf = (skills: { name: string }[]): string[] => skills.map((s) => s.name).sort()

const groupNames = (): string[] => skillService.findAllGrouped().map((g) => g.dirName)

const groupOf = (dirName: string): ReturnType<typeof skillService.findAllGrouped>[number] =>
  skillService.findAllGrouped().find((g) => g.dirName === dirName)!

beforeEach(() => {
  rmSync(DIRS.root, { recursive: true, force: true })
  for (const dir of [DIRS.builtin, DIRS.user, DIRS.ext, DIRS.ext2, DIRS.sentinel]) {
    mkdirSync(dir, { recursive: true })
  }
  publish.mockClear()
})

afterAll(() => {
  rmSync(DIRS.root, { recursive: true, force: true })
})

describe('SSG 分组的形状与顺序', () => {
  it('SSG-1 内置置顶 → 外部（按配置顺序）→ 默认组恒在；内置目录空时没有 builtin 组', () => {
    // 顺序是渲染顺序的唯一来源（侧栏那一组只按 isDefault 决定画不画文件夹行，不重排）。
    // 默认组恒在：它没有文件夹行，技能平铺在最后 —— 组没了，那一摞就整片消失
    expect(groupNames()).toEqual(['default'])
    expect(groupOf('default').skills).toEqual([])
    expect(groupOf('default').isDefault).toBe(true)

    writeSkill(DIRS.builtin, 'drawing')
    writeSkill(DIRS.user, 'mine')
    skillService.addExternalDir({ name: 'ext', path: DIRS.ext })
    skillService.addExternalDir({ name: 'ext2', path: DIRS.ext2 })
    writeSkill(DIRS.ext, 'tool')
    writeSkill(DIRS.ext2, 'other')

    expect(groupNames()).toEqual(['builtin', 'default', 'ext', 'ext2'])
    // 宿主重排成展示顺序（内置 → 外部 → 默认）时，两个外部目录的相对次序就是配置里的次序
    const dirs = skillService.listExternalDirs().map((d) => d.name)
    expect(dirs).toEqual(['ext', 'ext2'])

    // 内置目录里一个技能都没有 → 整组不出现（否则侧栏顶上挂一个永远空的文件夹行）
    rmSync(join(DIRS.builtin, 'drawing'), { recursive: true, force: true })
    expect(groupNames()).not.toContain('builtin')
    expect(groupNames()).toEqual(['default', 'ext', 'ext2'])
  })

  it('SSG-2 组内按 name 排序；每个技能的 basePath 都落在本组 dirPath 之下', () => {
    // basePath 是「点这一行打开哪份 SKILL.md」的唯一依据（skillNotes 取它的最后一段）——
    // 归错组就是点开另一个根下的同名文件
    writeSkill(DIRS.builtin, 'zebra')
    writeSkill(DIRS.builtin, 'alpha')
    writeSkill(DIRS.user, 'yak')
    writeSkill(DIRS.user, 'bee')
    skillService.addExternalDir({ name: 'ext', path: DIRS.ext })
    writeSkill(DIRS.ext, 'omega')
    writeSkill(DIRS.ext, 'delta')

    for (const group of skillService.findAllGrouped()) {
      const names = group.skills.map((s) => s.name)
      expect(names, group.dirName).toEqual([...names].sort((a, b) => a.localeCompare(b)))
      for (const skill of group.skills) {
        expect(
          skill.basePath.startsWith(group.dirPath + '/'),
          `${group.dirName}/${skill.name}`
        ).toBe(true)
      }
    }
    expect(groupOf('builtin').skills.map((s) => s.name)).toEqual(['builtin:alpha', 'builtin:zebra'])
    expect(groupOf('ext').skills.map((s) => s.name)).toEqual(['ext:delta', 'ext:omega'])
  })
})

describe('SSG 两级开关', () => {
  beforeEach(() => {
    writeSkill(DIRS.builtin, 'drawing')
    writeSkill(DIRS.user, 'mine')
    skillService.addExternalDir({ name: 'ext', path: DIRS.ext })
    writeSkill(DIRS.ext, 'tool')
    publish.mockClear()
  })

  it('SSG-3 三个组键各自生效于 findEnabled，另两组不受影响；findAll 仍全含', () => {
    // SSB-4 只走了 builtin 一条分支。默认组的键是字面量 `default`（不是 dirName），
    // 外部组的键是用户取的目录名 —— 三条各有各的拼法，漏哪一条都表现为「关了没反应」
    const ALL = ['builtin:drawing', 'ext:tool', 'mine']
    expect(namesOf(skillService.findEnabled())).toEqual(ALL)

    const cases = [
      { key: 'builtin', gone: 'builtin:drawing' },
      { key: 'default', gone: 'mine' },
      { key: 'ext', gone: 'ext:tool' }
    ]
    for (const c of cases) {
      skillService.setGroupEnabled(c.key, false)
      expect(namesOf(skillService.findEnabled()), c.key).toEqual(ALL.filter((n) => n !== c.gone))
      // 关闭是隐藏，不是删除
      expect(namesOf(skillService.findAll()), c.key).toEqual(ALL)
      skillService.setGroupEnabled(c.key, true)
      expect(namesOf(skillService.findEnabled()), `${c.key} back on`).toEqual(ALL)
    }
  })

  it('SSG-4 组关掉时单个技能的 isEnabled 不被改写（渲染端据两者相或才判定变淡）', () => {
    // 组开关若顺手把组内技能写进 disabled，再开回组就会发现「原本就关着的那个」被打开了；
    // 侧栏那一行的 `off = !skill.isEnabled || !folder.isEnabled` 也就没有存在的理由了
    skillService.setGroupEnabled('ext', false)

    const group = groupOf('ext')
    expect(group.isEnabled).toBe(false)
    expect(group.skills.map((s) => s.isEnabled)).toEqual([true])
    expect(skillService.findAll().find((s) => s.name === 'ext:tool')?.isEnabled).toBe(true)
    // 落库的只有组键，没有技能名
    expect(JSON.parse(readConfig())).toMatchObject({ disabled: [], disabledDirs: ['ext'] })
  })

  it('SSG-5 两级正交：组开+技能关、组关+技能开都不在架；都关之后只开回组仍不在', () => {
    // 两级是「与」关系。任何一级被另一级顶掉，用户就会遇到「我明明开着」或「我明明关了」
    skillService.update({ name: 'ext:tool', isEnabled: false })
    expect(namesOf(skillService.findEnabled())).not.toContain('ext:tool')

    skillService.update({ name: 'ext:tool', isEnabled: true })
    skillService.setGroupEnabled('ext', false)
    expect(namesOf(skillService.findEnabled())).not.toContain('ext:tool')

    // 两级都关 → 只开回组：技能自己那一级还关着
    skillService.update({ name: 'ext:tool', isEnabled: false })
    skillService.setGroupEnabled('ext', true)
    expect(namesOf(skillService.findEnabled())).not.toContain('ext:tool')
    // 再开回技能这一级才回到架上
    skillService.update({ name: 'ext:tool', isEnabled: true })
    expect(namesOf(skillService.findEnabled())).toContain('ext:tool')
  })

  it('SSG-6 findEnabledAsCommands 跟随两级开关（关掉之后模型的命令池里也没有）', () => {
    // 「关掉」最终要落到这里才算数：命令池是 commandService 合入的那一份
    const ids = (): string[] =>
      skillService
        .findEnabledAsCommands()
        .map((c) => c.commandId)
        .sort()
    expect(ids()).toEqual(['builtin:drawing', 'ext:tool', 'mine'])

    skillService.update({ name: 'mine', isEnabled: false })
    expect(ids()).toEqual(['builtin:drawing', 'ext:tool'])

    skillService.setGroupEnabled('ext', false)
    expect(ids()).toEqual(['builtin:drawing'])
  })
})

describe('SSG 外部目录的准入与移除', () => {
  it('SSG-7 目录名的三条准入：空 / 纯空白 / 含冒号 / 三个保留组键一律拒', () => {
    // 目录名不是装饰：它是组内技能标识的前缀（`<dirName>:<skillName>`）、分组的键、以及
    // 笔记本承载项目 id 的一段（`__skills:<dirName>__`）。空名拼出的 id 不被 isSkillProjectId
    // 认作技能项目（见 SN-3），那一行隐藏载体会就此冒进项目列表与日历；含冒号会让「哪一半是
    // 目录」整个错位；占用保留键则会把这个外部目录当成内置 / 默认 / 项目级
    const bad: Array<[string, RegExp]> = [
      ['', /Directory name is required/],
      ['   ', /Directory name is required/],
      ['\t\n ', /Directory name is required/],
      ['a:b', /cannot contain ":"/],
      [':', /cannot contain ":"/],
      ['default', /reserved/],
      ['builtin', /reserved/],
      ['project', /reserved/]
    ]
    for (const [name, reason] of bad) {
      expect(
        () => skillService.addExternalDir({ name, path: DIRS.ext }),
        JSON.stringify(name)
      ).toThrow(reason)
    }
    expect(skillService.listExternalDirs()).toEqual([])
    // 一条都没写进去 → 连配置文件都不该被建出来
    expect(existsSync(CONFIG_PATH)).toBe(false)

    // 正控制组：同一个路径换个合法名字就加得进去（上面的拒绝不是因为路径有问题）
    skillService.addExternalDir({ name: ' ext ', path: DIRS.ext })
    // 落库的是 trim 过的名字 —— 重名判定与之后的一切（标识前缀、承载 id）都按它算
    expect(skillService.listExternalDirs()).toEqual([{ name: 'ext', path: DIRS.ext }])
  })

  it('SSG-8 既有四条门各自抛，且失败后配置逐字不变、仍可解析', () => {
    skillService.addExternalDir({ name: 'ext', path: DIRS.ext })
    const before = readConfig()
    expect(before).not.toBe('')

    const bad: Array<[{ name: string; path: string }, RegExp]> = [
      [{ name: 'nope', path: join(DIRS.root, 'does-not-exist') }, /Directory does not exist/],
      [{ name: 'same', path: DIRS.user }, /Cannot add the default skills directory/],
      [{ name: 'ext', path: DIRS.ext2 }, /already exists/],
      [{ name: 'other', path: DIRS.ext }, /already added/]
    ]
    for (const [dir, reason] of bad) {
      expect(() => skillService.addExternalDir(dir), dir.name).toThrow(reason)
      // 半途写坏比抛错本身更糟：下次启动读不出配置，所有外部目录与开关一起消失
      expect(readConfig(), dir.name).toBe(before)
      expect(() => JSON.parse(readConfig()), dir.name).not.toThrow()
    }
    expect(skillService.listExternalDirs()).toEqual([{ name: 'ext', path: DIRS.ext }])
  })

  it('SSG-9 移除清掉 dirs / 该目录的 disabled 前缀项 / disabledDirs，但不误伤 ext2', () => {
    // `ext:` 前缀匹配的陷阱就是 `ext2:` —— 它不以 `ext:` 开头，却以 `ext` 开头
    skillService.addExternalDir({ name: 'ext', path: DIRS.ext })
    skillService.addExternalDir({ name: 'ext2', path: DIRS.ext2 })
    writeSkill(DIRS.ext, 'tool')
    writeSkill(DIRS.ext2, 'other')
    writeSkill(DIRS.user, 'mine')
    skillService.update({ name: 'ext:tool', isEnabled: false })
    skillService.update({ name: 'ext2:other', isEnabled: false })
    skillService.update({ name: 'mine', isEnabled: false })
    skillService.setGroupEnabled('ext', false)
    skillService.setGroupEnabled('ext2', false)

    skillService.removeExternalDir('ext')

    const config = JSON.parse(readConfig())
    expect(config.dirs).toEqual([{ name: 'ext2', path: DIRS.ext2 }])
    expect(config.disabled.sort()).toEqual(['ext2:other', 'mine'])
    expect(config.disabledDirs).toEqual(['ext2'])
  })

  it('SSG-10 移除后同名加回另一个路径：组与组内技能都是启用态，dirPath 是新路径', () => {
    // 移除时顺手清掉了这个名字下的两级 disabled 记录 —— 不清的话，换个文件夹重新加回来，
    // 用户会撞见一组「从没关过却是关着的」技能
    mkdirSync(DIRS.extMoved, { recursive: true })
    skillService.addExternalDir({ name: 'ext', path: DIRS.ext })
    writeSkill(DIRS.ext, 'tool')
    skillService.update({ name: 'ext:tool', isEnabled: false })
    skillService.setGroupEnabled('ext', false)

    skillService.removeExternalDir('ext')
    writeSkill(DIRS.extMoved, 'tool')
    skillService.addExternalDir({ name: 'ext', path: DIRS.extMoved })

    const group = groupOf('ext')
    expect(group.dirPath).toBe(DIRS.extMoved)
    expect(group.isEnabled).toBe(true)
    expect(group.skills.map((s) => [s.name, s.isEnabled])).toEqual([['ext:tool', true]])
    expect(namesOf(skillService.findEnabled())).toContain('ext:tool')
  })
})

describe('SSG 同一目录的别种写法', () => {
  const POSIX = process.platform !== 'win32'
  const ALREADY_ADDED = /already added/
  const DEFAULT_DIR = /Cannot add the default skills directory/
  const AFTER_LINK = /has "\.\." after a symbolic link/

  /**
   * 一次被拒的添加：抛出的原因匹配 `reason`；配置逐字不变（没有配置文件的，仍然没有）、仍可解析；
   * 不广播；外部目录清单与分组都不变。返回抛出的原因原文，供调用方再看它带没带调用方的写法
   */
  const expectRefused = (dir: { name: string; path: string }, reason: RegExp): string => {
    const label = `${dir.name} ← ${dir.path}`
    const before = readConfig()
    const dirsBefore = skillService.listExternalDirs()
    const groupsBefore = groupNames()
    publish.mockClear()

    let message = ''
    try {
      skillService.addExternalDir(dir)
    } catch (e) {
      message = e instanceof Error ? e.message : String(e)
    }
    expect(message, label).toMatch(reason)

    expect(readConfig(), label).toBe(before)
    if (before === '') expect(existsSync(CONFIG_PATH), label).toBe(false)
    else expect(() => JSON.parse(readConfig()), label).not.toThrow()
    expect(publish, label).not.toHaveBeenCalled()
    expect(skillService.listExternalDirs(), label).toEqual(dirsBefore)
    expect(groupNames(), label).toEqual(groupsBefore)
    return message
  }

  it('SSG-18 加过 ext 之后，ext 的别种写法（尾斜杠 / 双斜杠 / . 段 / 经兄弟目录的 ..）一律 already added，原因带着调用方的写法；只有一个 ext 组', () => {
    // 不拒的话，同一批技能会以两个名字各列一遍（ext:tool 与 other:tool），两个开关各管一份
    writeSkill(DIRS.ext, 'tool')
    skillService.addExternalDir({ name: 'ext', path: DIRS.ext })

    for (const path of [
      `${DIRS.ext}/`,
      `${DIRS.ext}//`,
      `${DIRS.ext}/.`,
      `${DIRS.ext}/./`,
      `${DIRS.root}/./ext`,
      `${DIRS.ext2}/../ext`
    ]) {
      const message = expectRefused({ name: 'other', path }, ALREADY_ADDED)
      // 用户在渲染端看到的原因说的是他自己填的那个路径，而不是落库的那个
      expect(message, path).toContain(`"${path}"`)
    }

    expect(skillService.listExternalDirs()).toEqual([{ name: 'ext', path: DIRS.ext }])
    expect(groupNames()).toEqual(['default', 'ext'])
    expect(namesOf(skillService.findAll())).toEqual(['ext:tool'])
  })

  it.skipIf(!POSIX)(
    'SSG-19 符号链接与真实位置：叶子链接 / 祖先链接 / realpath 写法都算 ext；反过来先经链接加进来，再加 ext 本身同样拒',
    () => {
      writeSkill(DIRS.ext, 'tool')
      const extLink = join(DIRS.root, 'ext-link')
      symlinkSync(DIRS.ext, extLink)
      const rootLink = join(DIRS.root, 'root-link')
      symlinkSync(DIRS.root, rootLink)

      skillService.addExternalDir({ name: 'ext', path: DIRS.ext })
      // 真实位置那种写法：TMPDIR 在 /var/folders 下时，它是 /private/var/folders/…
      for (const path of [extLink, join(rootLink, 'ext'), realpathSync.native(DIRS.ext)]) {
        const message = expectRefused({ name: 'other', path }, ALREADY_ADDED)
        expect(message, path).toContain(`"${path}"`)
      }
      expect(namesOf(skillService.findAll())).toEqual(['ext:tool'])

      // 反过来：一份新的配置里先经链接加，记下的是链接那条路（不跟过去）；ext 本身与其尾斜杠写法都拒
      rmSync(CONFIG_PATH, { force: true })
      skillService.addExternalDir({ name: 'via-link', path: extLink })
      expect(skillService.listExternalDirs()).toEqual([{ name: 'via-link', path: extLink }])
      for (const path of [DIRS.ext, `${DIRS.ext}/`]) {
        expectRefused({ name: 'ext', path }, ALREADY_ADDED)
      }
      expect(namesOf(skillService.findAll())).toEqual(['via-link:tool'])
    }
  )

  it('SSG-20 默认目录的别种写法一律 Cannot add the default skills directory —— 没有配置文件时（之后仍没有），与加过 ext 之后（配置逐字不变）', () => {
    // 默认目录不是外部目录：加进来它的技能就以 `<名字>:<skill>` 再列一遍，开关也分成两份
    writeSkill(DIRS.user, 'mine')
    const spellings = [`${DIRS.user}/`, `${DIRS.user}/.`, `${DIRS.ext}/../user`]
    if (POSIX) {
      const userLink = join(DIRS.root, 'user-link')
      symlinkSync(DIRS.user, userLink)
      const rootLink = join(DIRS.root, 'root-link')
      symlinkSync(DIRS.root, rootLink)
      spellings.push(userLink, join(rootLink, 'user'))
    }
    spellings.push(realpathSync.native(DIRS.user))

    expect(existsSync(CONFIG_PATH)).toBe(false)
    for (const path of spellings) expectRefused({ name: 'again', path }, DEFAULT_DIR)
    expect(existsSync(CONFIG_PATH)).toBe(false)

    skillService.addExternalDir({ name: 'ext', path: DIRS.ext })
    for (const path of spellings) expectRefused({ name: 'again', path }, DEFAULT_DIR)
    expect(skillService.listExternalDirs()).toEqual([{ name: 'ext', path: DIRS.ext }])
    expect(namesOf(skillService.findAll())).toEqual(['mine'])
  })

  it('SSG-21 落库的是 resolve 过的写法：去掉尾斜杠、. 与 ..，不跟符号链接也不换成真实位置；之后按路径的判断都认它', () => {
    mkdirSync(DIRS.extMoved, { recursive: true })
    const link = join(DIRS.root, 'link-to-moved')
    const added = [
      { name: 'a', path: `${DIRS.ext}/` },
      { name: 'b', path: `${DIRS.ext}/../ext2/./` }
    ]
    const expected = [
      { name: 'a', path: DIRS.ext },
      { name: 'b', path: DIRS.ext2 }
    ]
    if (POSIX) {
      symlinkSync(DIRS.extMoved, link)
      added.push({ name: 'c', path: `${link}/` })
      expected.push({ name: 'c', path: link })
    }
    for (const dir of added) skillService.addExternalDir(dir)

    expect(skillService.listExternalDirs()).toEqual(expected)
    const raw = readConfig()
    expect(JSON.parse(raw).dirs).toEqual(expected)
    expect(raw).not.toContain('/"')
    expect(raw).not.toContain('/./')
    expect(raw).not.toContain('/../')
    // 不换成真实位置（夹具根在 /var/folders 下时，真实位置是 /private/var/…）
    const realExt = realpathSync.native(DIRS.ext)
    if (realExt !== DIRS.ext) expect(raw).not.toContain(realExt)
    if (POSIX) {
      // 链接那条路就是用户挑的那条：不跟到 ext-moved
      expect(raw).not.toContain(DIRS.extMoved)
      expect(skillService.listExternalDirs()[2].path).not.toBe(realpathSync.native(DIRS.extMoved))
    }

    // 落库的写法一路传下去：分组的 dirPath、技能的 basePath、可写根、会话的只读技能根
    writeSkill(DIRS.ext2, 'tool')
    const b = groupOf('b')
    expect(b.dirPath).toBe(DIRS.ext2)
    expect(b.skills.map((s) => [s.name, s.basePath])).toEqual([['b:tool', join(DIRS.ext2, 'tool')]])
    expect(groupOf('a').dirPath).toBe(DIRS.ext)
    expect(skillService.isInsideWritableRoot(join(DIRS.ext2, 'tool', 'SKILL.md'))).toBe(true)
    expect(skillService.enabledSkillRoots()).toContain(DIRS.ext2)
  })

  const legacySpellings: Array<[string, () => string]> = [
    ['尾斜杠', () => `${DIRS.ext}/`],
    ['双斜杠', () => `${DIRS.ext}//`],
    ['经兄弟目录的 ..', () => `${DIRS.ext2}/../ext`]
  ]

  it.each(legacySpellings)(
    'SSG-22 早先版本记下的 ext 写法（%s）：再加干净的 ext 拒、文件逐字不变；别的目录照常加得进，旧条目照旧列它的技能、写法不被改写',
    (_label, spell) => {
      writeSkill(DIRS.ext, 'tool')
      const legacy = spell()
      writeRawConfig(
        JSON.stringify({ disabled: [], disabledDirs: [], dirs: [{ name: 'old', path: legacy }] })
      )

      const message = expectRefused({ name: 'new', path: DIRS.ext }, ALREADY_ADDED)
      expect(message).toContain(`"${DIRS.ext}"`)

      // 拒的是同一个目录，不是「配置里有怪写法就什么都加不进」
      skillService.addExternalDir({ name: 'fresh', path: DIRS.ext2 })
      expect(JSON.parse(readConfig()).dirs).toEqual([
        { name: 'old', path: legacy },
        { name: 'fresh', path: DIRS.ext2 }
      ])
      expect(groupOf('old').skills.map((s) => s.name)).toEqual(['old:tool'])
      expect(namesOf(skillService.findEnabled())).toEqual(['old:tool'])
    }
  )

  it('SSG-23 通不到任何地方的旧条目（目录不在了 / 悬空链接）不挡别的目录；那个位置后来真的有了，再加它就拒', () => {
    const legacy = [{ name: 'gone', path: `${DIRS.root}/gone/` }]
    if (POSIX) {
      // 悬空：指向一个还不存在的 missing
      symlinkSync(join(DIRS.root, 'missing'), join(DIRS.root, 'dangling'))
      legacy.push({ name: 'dang', path: join(DIRS.root, 'dangling') })
    }
    writeRawConfig(JSON.stringify({ disabled: [], disabledDirs: [], dirs: legacy }))

    // 解析不了的旧路径按 resolve 之后的字面比 —— 它们不是 ext
    skillService.addExternalDir({ name: 'ext', path: DIRS.ext })
    const after = [...legacy, { name: 'ext', path: DIRS.ext }]
    expect(JSON.parse(readConfig()).dirs).toEqual(after)
    expect(groupNames()).toEqual(['default', ...after.map((d) => d.name)])

    // 目录回来了：`gone/` 与 `gone` 是同一个
    mkdirSync(join(DIRS.root, 'gone'))
    expectRefused({ name: 'gone-again', path: join(DIRS.root, 'gone') }, ALREADY_ADDED)

    if (POSIX) {
      // 链接的目标有了：dangling 与 missing 现在通到同一个真实位置
      mkdirSync(join(DIRS.root, 'missing'))
      expectRefused({ name: 'missing', path: join(DIRS.root, 'missing') }, ALREADY_ADDED)
    }
    // 旧条目照写的样子留着
    expect(JSON.parse(readConfig()).dirs).toEqual(after)
  })

  it('SSG-24 不多拒：ext 的子目录、名字以 ext 开头的别的目录（经一条链接）、名字以 user 开头的兄弟目录，各自成组', () => {
    skillService.addExternalDir({ name: 'ext', path: DIRS.ext })
    const sub = join(DIRS.ext, 'sub')
    mkdirSync(sub)
    const user2 = `${DIRS.root}/user-2`
    mkdirSync(user2)
    const accepted = [
      { name: 'sub', path: sub },
      { name: 'user-2', path: user2 }
    ]
    if (POSIX) {
      mkdirSync(DIRS.extMoved, { recursive: true })
      const link = join(DIRS.root, 'moved-link')
      symlinkSync(DIRS.extMoved, link)
      accepted.push({ name: 'moved', path: link })
    }

    for (const dir of accepted) {
      expect(() => skillService.addExternalDir(dir), dir.name).not.toThrow()
    }
    expect(skillService.listExternalDirs()).toEqual([{ name: 'ext', path: DIRS.ext }, ...accepted])
    expect(groupNames()).toEqual(['default', 'ext', ...accepted.map((d) => d.name)])
    for (const dir of accepted) expect(groupOf(dir.name).dirPath, dir.name).toBe(dir.path)
  })

  it('SSG-25 不分大小写的磁盘上，大小写变体是同一个目录：EXT 已加过、USER 是默认目录（分大小写的磁盘上跳过）', (ctx) => {
    // 探针：这块盘上 EXT 找得到，且它的真实位置写作 ext —— 两条都成立才是「不分大小写、真实位置保留原大小写」
    const upper = `${DIRS.root}/EXT`
    ctx.skip(
      !existsSync(upper) || basename(realpathSync.native(upper)) !== 'ext',
      'case-sensitive disk'
    )

    skillService.addExternalDir({ name: 'ext', path: DIRS.ext })
    const message = expectRefused({ name: 'other', path: upper }, ALREADY_ADDED)
    expect(message).toContain(`"${upper}"`)
    expectRefused({ name: 'again', path: `${DIRS.root}/USER` }, DEFAULT_DIR)
    expect(skillService.listExternalDirs()).toEqual([{ name: 'ext', path: DIRS.ext }])
  })

  it.skipIf(!POSIX)(
    'SSG-26 链接后面跟 ..（resolve 的字面与系统走到的不是一个目录）：一律拒、从不落库 —— 空配置时也拒',
    () => {
      // deep → a/b，所以 `deep/../ext` 系统走到的是 a/ext，resolve 折出来的却是根下的 ext
      mkdirSync(join(DIRS.root, 'a', 'b'), { recursive: true })
      mkdirSync(join(DIRS.root, 'a', 'ext'))
      symlinkSync(join(DIRS.root, 'a', 'b'), join(DIRS.root, 'deep'))
      const elink = join(DIRS.root, 'elink')
      symlinkSync(DIRS.ext, elink)
      symlinkSync(DIRS.user, join(DIRS.root, 'a', 'ulink'))
      const twisted = `${DIRS.root}/deep/../ext`
      const twistedUser = `${DIRS.root}/deep/../ulink`

      // 空配置：前面没有任何条目可撞，照样拒（否则记下的是根下的 ext，用户挑的却是 a/ext）
      const first = expectRefused({ name: 'dup', path: twisted }, AFTER_LINK)
      expect(first).toContain(`"${twisted}"`)

      skillService.addExternalDir({ name: 'e', path: elink })
      expectRefused({ name: 'dup', path: twisted }, AFTER_LINK)
      // 系统走到的是默认目录、字面却是一个不存在的 ulink：两道闸看的不是同一个目录，不收
      expectRefused({ name: 'u', path: twistedUser }, AFTER_LINK)

      expect(skillService.listExternalDirs()).toEqual([{ name: 'e', path: elink }])
      expect(readConfig()).not.toContain('ulink')
      expect(readConfig()).not.toContain('/../')
    }
  )
})

describe('SSG 写入回执', () => {
  it('SSG-11 每个写配置的路径恰好广播一次 skill.changed', () => {
    // 配置是两级开关与外部目录的唯一落点，侧栏那一组靠这条事件重扫。少发一次 → 界面停在
    // 旧状态；多发一次 → 每次点开关都白扫两遍
    writeSkill(DIRS.user, 'mine')
    const once = (what: string, act: () => void): void => {
      publish.mockClear()
      act()
      expect(publish.mock.calls, what).toEqual([[{ type: 'skill.changed' }]])
    }

    once('setGroupEnabled', () => skillService.setGroupEnabled('default', false))
    once('update(isEnabled)', () => skillService.update({ name: 'mine', isEnabled: false }))
    once('addExternalDir', () => skillService.addExternalDir({ name: 'ext', path: DIRS.ext }))
    once('removeExternalDir', () => skillService.removeExternalDir('ext'))
    once('deleteDefaultSkill', () => skillService.deleteDefaultSkill('mine'))
  })

  it('SSG-12 isInsideWritableRoot：默认根 / 外部目录下为真；内置根下为假；兄弟前缀与根本身为假', () => {
    // 内置目录只读，那儿本就不该有写入；兄弟目录前缀陷阱（`<root>/user` vs `<root>/user-other`）
    // 是 startsWith 写法的经典漏法 —— 漏了就会为完全无关的写入重扫整个分组
    skillService.addExternalDir({ name: 'ext', path: DIRS.ext })

    expect(skillService.isInsideWritableRoot(join(DIRS.user, 'mine', 'SKILL.md'))).toBe(true)
    expect(skillService.isInsideWritableRoot(join(DIRS.ext, 'tool', 'SKILL.md'))).toBe(true)

    expect(skillService.isInsideWritableRoot(join(DIRS.builtin, 'drawing', 'SKILL.md'))).toBe(false)
    expect(skillService.isInsideWritableRoot(`${DIRS.user}-other/mine/SKILL.md`)).toBe(false)
    expect(skillService.isInsideWritableRoot(`${DIRS.ext}-other/tool/SKILL.md`)).toBe(false)
    // 根本身不是「根之下」
    expect(skillService.isInsideWritableRoot(DIRS.user)).toBe(false)
    expect(skillService.isInsideWritableRoot(DIRS.ext)).toBe(false)
  })

  it('SSG-13 noteFileWritten 合并窗口：300ms 内连写三次只广播一次；可写根之外一次不发', () => {
    // 笔记本自动保存每 200ms 落一次盘，连续打字不该让分组一直重扫（同 bot / agent 的窗口）
    vi.useFakeTimers()
    try {
      const file = join(DIRS.user, 'mine', 'SKILL.md')
      publish.mockClear()
      skillService.noteFileWritten(file)
      vi.advanceTimersByTime(100)
      skillService.noteFileWritten(file)
      vi.advanceTimersByTime(100)
      skillService.noteFileWritten(file)
      // 窗口未到：一笔都还没广播
      expect(publish).not.toHaveBeenCalled()
      vi.advanceTimersByTime(300)
      expect(publish.mock.calls).toEqual([[{ type: 'skill.changed' }]])

      // 可写根之外：内置目录、兄弟前缀、相对路径 —— 走完整个窗口也一声不吭
      publish.mockClear()
      skillService.noteFileWritten(join(DIRS.builtin, 'drawing', 'SKILL.md'))
      skillService.noteFileWritten(`${DIRS.user}-other/mine/SKILL.md`)
      skillService.noteFileWritten('mine/SKILL.md')
      vi.advanceTimersByTime(1000)
      expect(publish).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('SSG 删除默认目录里的技能', () => {
  it('SSG-14 目录名与 frontmatter name 不同：按注册表定位，删掉的是真目录', () => {
    // 拿 name 去拼路径会拼出一个不存在的目录：配置清了、事件发了、目录纹丝不动 —— 静默失败
    const base = writeSkill(DIRS.user, 'my-dir', 'other')
    expect(skillService.findByName('other')?.basePath).toBe(base)

    skillService.deleteDefaultSkill('other')

    expect(existsSync(base)).toBe(false)
    expect(skillService.findByName('other')).toBe(null)
  })

  it('SSG-15 越界名一律抛，哨兵目录仍在', () => {
    // `rmSync(recursive)` 不可逆，而 name 来自渲染进程。今天注册表定位已经挡在前面
    // （查不到这个名字就抛），路径白名单是第二道 —— 这条断的是**结果**：不管哪一道拦下的，
    // 默认根之外的东西一个都不能少
    writeSkill(DIRS.user, 'mine')
    writeSkill(DIRS.sentinel, 'precious')
    const sentinelFile = join(DIRS.sentinel, 'precious', 'SKILL.md')

    for (const name of [
      '../sentinel',
      '..',
      '../../',
      DIRS.sentinel,
      join(DIRS.sentinel, 'precious'),
      'sub/dir',
      'sub\\dir'
    ]) {
      expect(() => skillService.deleteDefaultSkill(name), JSON.stringify(name)).toThrow()
      expect(existsSync(DIRS.sentinel), JSON.stringify(name)).toBe(true)
      expect(existsSync(sentinelFile), JSON.stringify(name)).toBe(true)
    }
    // 正控制组：合法的那个照样删得掉（上面的拒绝不是因为删除整个坏掉了）
    expect(existsSync(join(DIRS.user, 'mine'))).toBe(true)
    skillService.deleteDefaultSkill('mine')
    expect(existsSync(join(DIRS.user, 'mine'))).toBe(false)
    expect(existsSync(DIRS.sentinel)).toBe(true)
  })

  it('SSG-15c 名字里带 `../` 的技能真的存在时：删的仍是它自己的目录，名字一步都没进路径运算', () => {
    // 这是「越界名」唯一能真的进到注册表的形态 —— frontmatter 的 name 是用户写的自由文本。
    // 定位若回到 `join(skillsDir, name)`，这一下删掉的就是哨兵而不是 `evil/`
    const evil = writeSkill(DIRS.user, 'evil', '../sentinel')
    writeSkill(DIRS.sentinel, 'precious')
    expect(skillService.findByName('../sentinel')?.basePath).toBe(evil)

    skillService.deleteDefaultSkill('../sentinel')

    expect(existsSync(evil)).toBe(false)
    expect(existsSync(join(DIRS.sentinel, 'precious', 'SKILL.md'))).toBe(true)
  })

  it('SSG-15b 不是默认目录的技能删不得：内置、外部、共用各抛一次，目录仍在', () => {
    // 外部目录是用户自己的文件夹（移除来源即可），内置随包发布，共用目录是别的工具的 ——
    // 删除只对默认目录开放
    writeSkill(DIRS.builtin, 'drawing')
    skillService.addExternalDir({ name: 'ext', path: DIRS.ext })
    const tool = writeSkill(DIRS.ext, 'tool')
    const pdf = writeSkill(DIRS.sharedAgents, 'pdf')
    // 打开那一组也一样：开关管「上不上架」，不管「删不删得」
    skillService.setGroupEnabled('agents', true)
    expect(skillService.findByName('agents:pdf')?.basePath).toBe(pdf)

    expect(() => skillService.deleteDefaultSkill('builtin:drawing')).toThrow(
      /not found in the default skills directory/
    )
    expect(() => skillService.deleteDefaultSkill('ext:tool')).toThrow(
      /not found in the default skills directory/
    )
    expect(() => skillService.deleteDefaultSkill('agents:pdf')).toThrow(
      /not found in the default skills directory/
    )
    expect(existsSync(join(DIRS.builtin, 'drawing'))).toBe(true)
    expect(existsSync(tool)).toBe(true)
    expect(existsSync(join(pdf, 'SKILL.md'))).toBe(true)
  })
})

describe.skipIf(process.platform === 'win32')('SSG 技能根里的符号链接条目', () => {
  it('SSG-17 链接条目一律不算技能：内置 / 默认 / 外部目录里指向真技能目录的链接、悬空链接都不列，只有真的 mine 在；内置目录里只剩链接 → 没有 builtin 组；项目级 .claude/skills 里的链接同样不列；整个过程不抛', () => {
    // 被链接的真技能目录放在所有根之外（它自己在哪个根里都不该出现）
    const realSkill = writeSkill(join(DIRS.root, 'elsewhere'), 'linked')
    writeSkill(DIRS.user, 'mine')
    symlinkSync(realSkill, join(DIRS.builtin, 'linked'))
    symlinkSync(realSkill, join(DIRS.user, 'linked'))
    symlinkSync(join(DIRS.root, 'gone'), join(DIRS.user, 'dangling'))
    skillService.addExternalDir({ name: 'ext', path: DIRS.ext })
    symlinkSync(realSkill, join(DIRS.ext, 'linked'))
    const project = join(DIRS.root, 'project')
    mkdirSync(join(project, '.claude', 'skills'), { recursive: true })
    symlinkSync(realSkill, join(project, '.claude', 'skills', 'linked'))

    let groups: ReturnType<typeof skillService.findAllGrouped> = []
    expect(() => (groups = skillService.findAllGrouped(project))).not.toThrow()
    // 内置目录里只有一条链接 → 整组不出现；项目级只有链接 → 也没有 project 组
    expect(groups.map((g) => g.dirName)).toEqual(['default', 'ext'])
    expect(groups.map((g) => [g.dirName, g.skills.map((s) => s.name)])).toEqual([
      ['default', ['mine']],
      ['ext', []]
    ])

    expect(namesOf(skillService.findAll(project))).toEqual(['mine'])
    expect(namesOf(skillService.findEnabled(project))).toEqual(['mine'])
    expect(skillService.findEnabledAsCommands(project).map((c) => c.commandId)).toEqual(['mine'])
    expect(skillService.findByName('linked')).toBe(null)
  })
})
