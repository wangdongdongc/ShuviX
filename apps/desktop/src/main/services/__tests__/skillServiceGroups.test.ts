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
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

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
    sentinel: `${root}/sentinel`
  }
})

vi.mock('../../utils/paths', () => ({
  // 内置那一层：产线上是 `skills/<lang>/`，这里就是一个放技能目录的普通目录
  getBuiltinSkillsDir: () => DIRS.builtin,
  getDefaultSkillsDir: () => DIRS.user
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

  it('SSG-15b 不是默认目录的技能删不得：内置与外部各抛一次，目录仍在', () => {
    // 外部目录是用户自己的文件夹（移除来源即可），内置随包发布 —— 删除只对默认目录开放
    writeSkill(DIRS.builtin, 'drawing')
    skillService.addExternalDir({ name: 'ext', path: DIRS.ext })
    const tool = writeSkill(DIRS.ext, 'tool')

    expect(() => skillService.deleteDefaultSkill('builtin:drawing')).toThrow(
      /not found in the default skills directory/
    )
    expect(() => skillService.deleteDefaultSkill('ext:tool')).toThrow(
      /not found in the default skills directory/
    )
    expect(existsSync(join(DIRS.builtin, 'drawing'))).toBe(true)
    expect(existsSync(tool)).toBe(true)
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
