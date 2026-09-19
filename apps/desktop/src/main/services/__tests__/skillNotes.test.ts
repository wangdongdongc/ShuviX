/**
 * skillNotes —— 侧栏「技能」分组点一行时的后端：那份 `SKILL.md` 该挂在哪个承载项目下、
 * 按什么键复用会话、以及一个外部目录被移除时要连带清掉什么。
 *
 * 与 registryNotes / knowledgeNotes 同一条路，测法也照它们；技能比它们多的那一层麻烦是
 * **承载项目不是一张写死的表**：默认目录与内置目录各一个固定 id，外部目录数量不定、名字由
 * 用户取，id 只能按目录名现拼（`__skills:<name>__`）。于是这一组盯三件事：
 *
 *   ① 三种来源各进各的承载项目（根决定 notebookPath 相对谁解析，混了就是把存量会话指到别处）；
 *   ② notebookPath 取自 **basePath 的最后一段**而不是 `skill.name` —— 技能的 name 来自 SKILL.md
 *      的 frontmatter，与磁盘目录名并不总是相等（SKN-7）；
 *   ③ 移除外部目录的级联**只删那一个载体**（SKN-9/10）：删多了就是把别的目录的笔记一起抹掉。
 *
 * dao / sessionService / skillService 是替身；**fs 是真的** —— 「存在且是普通文件」只有真目录
 * 测得出来（一个叫 `SKILL.md` 的目录就是这么漏过去的，SKN-6）。dao 替身背后挂一份内存表而不是
 * 逐条 mockReturnValue：这一组要断的正是「插了行之后再打开会复用」「级联删了哪几条」这类跨调用
 * 的状态，逐条钉返回值只会把用例写成把答案抄两遍。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SKILL_BUILTIN_PROJECT_ID,
  SKILL_DEFAULT_PROJECT_ID,
  skillExternalProjectId
} from '@shuvix/chat-protocol/skillNotes'
import type { Project, Session, Skill, SkillDir } from '../../types'

/**
 * 临时根 + 三个技能根。paths 替身与用例共用这一份，两边拼出的路径逐字相同。
 * `builtinLang` 可变：内置目录随界面语言换一版（`skills/<lang>/`），SKN-13 靠改它来模拟切语言。
 */
const tmp = vi.hoisted(() => {
  const state = { base: '', builtinLang: 'en' }
  return {
    state,
    defaultDir: (): string => `${state.base}/skills`,
    builtinDir: (): string => `${state.base}/builtin-skills/${state.builtinLang}`,
    externalDir: (name: string): string => `${state.base}/external/${name}`
  }
})

vi.mock('../../utils/paths', () => ({
  getDefaultSkillsDir: () => tmp.defaultDir(),
  getBuiltinSkillsDir: () => tmp.builtinDir()
}))
vi.mock('../../dao/projectDao', () => ({
  projectDao: { findById: vi.fn(), insert: vi.fn(), update: vi.fn(), deleteById: vi.fn() }
}))
vi.mock('../../dao/sessionDao', () => ({
  sessionDao: { findByProjectAndNotebookPath: vi.fn(), findByProjectId: vi.fn() }
}))
vi.mock('../sessionService', () => ({
  sessionService: { create: vi.fn(), delete: vi.fn() }
}))
vi.mock('../skillService', () => ({
  skillService: { findByName: vi.fn(), listExternalDirs: vi.fn() }
}))

import { projectDao } from '../../dao/projectDao'
import { sessionDao } from '../../dao/sessionDao'
import { sessionService } from '../sessionService'
import { skillService } from '../skillService'
import { dropExternalSkillCarrier, openSkillNote, syncSkillBuiltinProject } from '../skillNotes'

/** 内存表（单线程 + 同步 SQLite 的等价物）—— dao 替身背后就是它 */
interface NoteRow {
  id: string
  projectId: string
  notebookPath: string
  title: string
}
const db = {
  projects: new Map<string, Project>(),
  sessions: [] as NoteRow[],
  seq: 0
}

/** 注册表替身：按名字查得到的技能 + 当前配置里的外部目录 */
const registry = { skills: [] as Skill[], dirs: [] as SkillDir[] }

/** 放一份 SKILL.md 并把对应的技能登记进注册表替身，返回它 */
const putSkill = (
  root: string,
  dirEntry: string,
  over: Partial<Skill> & Pick<Skill, 'source'>
): Skill => {
  const base = join(root, dirEntry)
  mkdirSync(base, { recursive: true })
  writeFileSync(join(base, 'SKILL.md'), `---\nname: ${over.name ?? dirEntry}\n---\n\nBODY.\n`)
  const skill: Skill = {
    name: dirEntry,
    description: '',
    content: 'BODY.',
    basePath: base,
    isEnabled: true,
    ...over
  }
  registry.skills.push(skill)
  return skill
}

/** 登记一个外部目录（配置里的那张表） */
const addExternalDir = (name: string): SkillDir => {
  const dir: SkillDir = { name, path: tmp.externalDir(name) }
  mkdirSync(dir.path, { recursive: true })
  registry.dirs.push(dir)
  return dir
}

/** 直接往内存表里塞一条已有的笔记会话（级联用例的夹具） */
const putNote = (projectId: string, notebookPath: string): NoteRow => {
  const row = { id: `s-seed-${++db.seq}`, projectId, notebookPath, title: notebookPath }
  db.sessions.push(row)
  return row
}

/** 直接往内存表里塞一行承载项目 */
const putCarrier = (id: string, over: Partial<Project> = {}): Project => {
  const project: Project = {
    id,
    name: 'Skills',
    path: tmp.defaultDir(),
    systemPrompt: '',
    settings: {},
    archivedAt: 0,
    createdAt: 100,
    updatedAt: 200,
    ...over
  }
  db.projects.set(id, project)
  return project
}

/** 某个替身第一次被调用的全局序号（比先后用） */
const firstCall = (fn: { mock: { invocationCallOrder: number[] } }): number =>
  fn.mock.invocationCallOrder[0]

/** 一个目录树的递归快照（「没顺手建目录 / 没写任何文件」的判据） */
const treeOf = (dir: string): string[] => {
  const out: string[] = []
  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      out.push(entry.isDirectory() ? `${rel}/` : rel)
      if (entry.isDirectory()) walk(join(current, entry.name), rel)
    }
  }
  walk(dir, '')
  return out
}

beforeEach(() => {
  vi.clearAllMocks()
  db.projects.clear()
  db.sessions = []
  db.seq = 0
  registry.skills = []
  registry.dirs = []
  tmp.state.builtinLang = 'en'
  tmp.state.base = join(
    tmpdir(),
    `shuvix-skill-notes-${process.pid}-${Math.random().toString(36).slice(2)}`
  )
  mkdirSync(tmp.state.base, { recursive: true })

  vi.mocked(projectDao.findById).mockImplementation((id: string) => db.projects.get(id))
  vi.mocked(projectDao.insert).mockImplementation((p: Project) => {
    db.projects.set(p.id, p)
  })
  vi.mocked(projectDao.update).mockImplementation((id: string, patch: Partial<Project>) => {
    const row = db.projects.get(id)
    if (row) db.projects.set(id, { ...row, ...patch })
  })
  vi.mocked(projectDao.deleteById).mockImplementation((id: string) => {
    db.projects.delete(id)
  })
  vi.mocked(sessionDao.findByProjectAndNotebookPath).mockImplementation(
    (projectId: string, notebookPath: string) =>
      db.sessions.find((s) => s.projectId === projectId && s.notebookPath === notebookPath) as
        | Session
        | undefined
  )
  vi.mocked(sessionDao.findByProjectId).mockImplementation(
    (projectId: string) =>
      db.sessions.filter((s) => s.projectId === projectId) as unknown as Session[]
  )
  vi.mocked(sessionService.create).mockImplementation((params) => {
    const row = {
      id: `s-${++db.seq}`,
      projectId: params?.projectId ?? '',
      notebookPath: params?.notebookPath ?? '',
      title: params?.title ?? ''
    }
    db.sessions.push(row)
    return row as unknown as Session
  })
  vi.mocked(sessionService.delete).mockImplementation(async (id: string) => {
    db.sessions = db.sessions.filter((s) => s.id !== id)
  })
  vi.mocked(skillService.findByName).mockImplementation(
    (name: string) => registry.skills.find((s) => s.name === name) ?? null
  )
  vi.mocked(skillService.listExternalDirs).mockImplementation(() => registry.dirs)
})

afterEach(() => {
  rmSync(tmp.state.base, { recursive: true, force: true })
})

describe('openSkillNote —— 三种来源、三种承载项目', () => {
  it('SKN-1 默认 / 内置 / 外部各进各的承载项目：固定 id 对固定根，三个根两两不等', () => {
    // 承载项目的 path 决定 notebookPath 相对哪个根解析 —— 三种来源共用一行，就是把存量
    // 会话的落点在几个根之间来回改写
    putSkill(tmp.defaultDir(), 'mine', { source: 'default' })
    putSkill(tmp.builtinDir(), 'drawing', { name: 'builtin:drawing', source: 'builtin' })
    const ext = addExternalDir('ext')
    putSkill(ext.path, 'tool', { name: 'ext:tool', source: 'external', dirName: 'ext' })

    const cases = [
      { name: 'mine', id: SKILL_DEFAULT_PROJECT_ID, root: tmp.defaultDir(), carrier: 'Skills' },
      {
        name: 'builtin:drawing',
        id: SKILL_BUILTIN_PROJECT_ID,
        root: tmp.builtinDir(),
        carrier: 'Builtin Skills'
      },
      {
        name: 'ext:tool',
        id: skillExternalProjectId('ext'),
        root: ext.path,
        carrier: 'Skills: ext'
      }
    ]
    for (const c of cases) {
      const session = openSkillNote(c.name)
      expect(session.projectId, c.name).toBe(c.id)
      expect(session.workingDirectory, c.name).toBe(c.root)
      expect(db.projects.get(c.id)).toMatchObject({ id: c.id, name: c.carrier, path: c.root })
    }
    // notebookPath 带一层子路径（技能是目录不是单文件），三条各是自己的目录名
    expect(db.sessions.map((s) => `${s.projectId}|${s.notebookPath}`)).toEqual([
      `${SKILL_DEFAULT_PROJECT_ID}|mine/SKILL.md`,
      `${SKILL_BUILTIN_PROJECT_ID}|drawing/SKILL.md`,
      `${skillExternalProjectId('ext')}|tool/SKILL.md`
    ])
    expect(new Set(cases.map((c) => c.root)).size).toBe(3)
    expect(new Set(cases.map((c) => c.id)).size).toBe(3)
  })

  it('SKN-2 幂等：第二次打开复用同一条会话，create 仍只调一次；返回值带工作目录 = 承载项目的 path', () => {
    // 一份文件至多一条笔记本会话 —— 每点一次开一条，自动保存就有好几条会话在往同一个文件写
    putSkill(tmp.defaultDir(), 'mine', { source: 'default' })

    const first = openSkillNote('mine')
    const second = openSkillNote('mine', ' Custom Title ')

    expect(sessionService.create).toHaveBeenCalledTimes(1)
    expect(sessionService.create).toHaveBeenCalledWith({
      projectId: SKILL_DEFAULT_PROJECT_ID,
      notebookPath: 'mine/SKILL.md',
      // 标题缺省回落**磁盘目录名**（同 notebookPath 那一段），不是 frontmatter 的 name
      title: 'mine'
    })
    expect(second.id).toBe(first.id)
    expect(second.workingDirectory).toBe(tmp.defaultDir())
    // 承载项目只插一行
    expect(projectDao.insert).toHaveBeenCalledTimes(1)
    expect(vi.mocked(sessionDao.findByProjectAndNotebookPath).mock.calls).toEqual([
      [SKILL_DEFAULT_PROJECT_ID, 'mine/SKILL.md'],
      [SKILL_DEFAULT_PROJECT_ID, 'mine/SKILL.md']
    ])
  })

  it('SKN-3 插项目行不动磁盘：打开前后目录树逐条相同，也不给不存在的内置语言目录建一个', () => {
    // 承载项目是数据库里的一行，与磁盘无关。ensureCarrier 里但凡补一句 mkdirSync，
    // 切一次语言就会在应用包旁边撒出一个空目录（而内置那份根本不该由我们创建）
    putSkill(tmp.defaultDir(), 'mine', { source: 'default' })
    const before = treeOf(tmp.state.base)

    openSkillNote('mine')
    expect(projectDao.insert).toHaveBeenCalledTimes(1)
    expect(treeOf(tmp.state.base)).toEqual(before)

    // 内置载体改指到一个盘上没有的语言目录：只改库里那一行，不把目录建出来
    putCarrier(SKILL_BUILTIN_PROJECT_ID, { name: 'Builtin Skills', path: tmp.builtinDir() })
    tmp.state.builtinLang = 'zh'
    syncSkillBuiltinProject()
    expect(db.projects.get(SKILL_BUILTIN_PROJECT_ID)?.path).toBe(tmp.builtinDir())
    expect(treeOf(tmp.state.base)).toEqual(before)
  })

  it('SKN-4 历史行漂移自愈：path / name 不符才 update；一致时一次都不写', () => {
    // home 迁移过、或内置目录随语言换了一版时，库里那一行还指着旧路径 —— 不纠正，
    // 打开的就是另一个根下的同名相对路径
    putSkill(tmp.defaultDir(), 'mine', { source: 'default' })
    putCarrier(SKILL_DEFAULT_PROJECT_ID, { name: 'Skills', path: '/old/home/.shuvix/skills' })

    openSkillNote('mine')
    expect(projectDao.update).toHaveBeenCalledTimes(1)
    expect(projectDao.update).toHaveBeenLastCalledWith(SKILL_DEFAULT_PROJECT_ID, {
      path: tmp.defaultDir()
    })

    // 名字也漂了：一次 update 带两个键
    db.projects.set(SKILL_DEFAULT_PROJECT_ID, {
      ...db.projects.get(SKILL_DEFAULT_PROJECT_ID)!,
      name: 'Old Name',
      path: '/old/home/.shuvix/skills'
    })
    openSkillNote('mine')
    expect(projectDao.update).toHaveBeenCalledTimes(2)
    expect(projectDao.update).toHaveBeenLastCalledWith(SKILL_DEFAULT_PROJECT_ID, {
      path: tmp.defaultDir(),
      name: 'Skills'
    })

    // 已经一致：这一次一个字都不写
    openSkillNote('mine')
    expect(projectDao.update).toHaveBeenCalledTimes(2)
    expect(projectDao.insert).not.toHaveBeenCalled()
  })

  it('SKN-5 注册表里没有这个名字：直接抛，dao 零调用', () => {
    // `name` 来自渲染进程，按不可信入参处理：清单是上一轮扫描的，技能目录可能刚被删掉
    expect(() => openSkillNote('nope')).toThrow(/Skill "nope" not found/)
    expect(projectDao.findById).not.toHaveBeenCalled()
    expect(projectDao.insert).not.toHaveBeenCalled()
    expect(sessionDao.findByProjectAndNotebookPath).not.toHaveBeenCalled()
    expect(sessionService.create).not.toHaveBeenCalled()
  })

  it('SKN-6 名字在、SKILL.md 不在盘上（含「一个叫 SKILL.md 的目录」）：抛且不留承载项目', () => {
    // 只查「注册表里有」会放行：建出一条打开就报错、却永远复用的笔记本会话
    const gone = join(tmp.defaultDir(), 'gone')
    mkdirSync(gone, { recursive: true })
    registry.skills.push({
      name: 'gone',
      description: '',
      content: '',
      basePath: gone,
      isEnabled: true,
      source: 'default'
    })
    // 同名目录：existsSync 为真、isFile 为假
    const decoy = join(tmp.defaultDir(), 'decoy')
    mkdirSync(join(decoy, 'SKILL.md'), { recursive: true })
    registry.skills.push({
      name: 'decoy',
      description: '',
      content: '',
      basePath: decoy,
      isEnabled: true,
      source: 'default'
    })

    expect(() => openSkillNote('gone')).toThrow(/Skill file not found: gone\/SKILL\.md/)
    expect(() => openSkillNote('decoy')).toThrow(/Skill file not found: decoy\/SKILL\.md/)
    expect(projectDao.insert).not.toHaveBeenCalled()
    expect(sessionService.create).not.toHaveBeenCalled()
  })

  it('SKN-7 目录名与 frontmatter name 不同：按 basePath 的最后一段拼路径，照样打得开', () => {
    // 技能的 name 来自 SKILL.md 的 frontmatter（解析不出才回落目录名），所以 `my-dir` 里
    // 写 `name: other` 时两者不等。按名字拼路径会拼出一个不存在的文件 —— 点开毫无反应
    putSkill(tmp.defaultDir(), 'my-dir', { name: 'other', source: 'default' })

    const session = openSkillNote('other')
    expect(session.projectId).toBe(SKILL_DEFAULT_PROJECT_ID)
    expect(sessionService.create).toHaveBeenCalledWith({
      projectId: SKILL_DEFAULT_PROJECT_ID,
      notebookPath: 'my-dir/SKILL.md',
      title: 'my-dir'
    })
  })

  it('SKN-8 项目级技能没有承载项目：抛 has no notebook carrier，不插项目行', () => {
    // 项目级技能随当前会话的项目变，而侧栏那一组是全局的 —— 它根本不在清单里，
    // 这条守的是「有人绕过 UI 直接按名字调」的那条路
    const dir = join(tmp.state.base, 'proj', '.claude', 'skills', 'local')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: local\n---\n\nBODY.\n')
    registry.skills.push({
      name: 'local',
      description: '',
      content: '',
      basePath: dir,
      isEnabled: true,
      source: 'project'
    })

    expect(() => openSkillNote('local')).toThrow(/Skill "local" has no notebook carrier/)
    expect(projectDao.insert).not.toHaveBeenCalled()
    expect(sessionService.create).not.toHaveBeenCalled()
  })

  it('SKN-8b 外部技能的目录已从配置里移除：同样答「没有承载项目」，不插项目行', () => {
    // carrierOf 按 dirName 回配置里找那一行 —— 找不到就没有根，拼不出 notebookPath 该相对谁
    const ext = addExternalDir('ext')
    putSkill(ext.path, 'tool', { name: 'ext:tool', source: 'external', dirName: 'ext' })
    registry.dirs = []

    expect(() => openSkillNote('ext:tool')).toThrow(/has no notebook carrier/)
    expect(projectDao.insert).not.toHaveBeenCalled()
  })
})

describe('dropExternalSkillCarrier —— 移除外部目录的级联', () => {
  it('SKN-9 先删会话再删项目行：会话按 id 集合断，项目行恰删一次且在其后', () => {
    // 顺序反了就会留下一批指向已删项目的孤儿会话（项目没了，工作目录解析不出来）
    const id = skillExternalProjectId('ext')
    putCarrier(id, { name: 'Skills: ext', path: tmp.externalDir('ext') })
    const notes = [putNote(id, 'a/SKILL.md'), putNote(id, 'b/SKILL.md'), putNote(id, 'c/SKILL.md')]

    return dropExternalSkillCarrier('ext').then(() => {
      // 断集合而不是次数：删几条由夹具决定，删对了哪几条才是契约
      const deleted = vi.mocked(sessionService.delete).mock.calls.map(([sid]) => sid)
      expect(new Set(deleted)).toEqual(new Set(notes.map((n) => n.id)))
      expect(projectDao.deleteById).toHaveBeenCalledTimes(1)
      expect(projectDao.deleteById).toHaveBeenCalledWith(id)
      const lastDelete = Math.max(...vi.mocked(sessionService.delete).mock.invocationCallOrder)
      expect(firstCall(vi.mocked(projectDao.deleteById))).toBeGreaterThan(lastDelete)
      expect(db.projects.has(id)).toBe(false)
    })
  })

  it('SKN-10 只删这一个载体：同时存在的另一个外部目录与默认目录的笔记原封不动', () => {
    // 级联若按前缀匹配（`__skills:` 开头一律算）或干脆清空，别的目录的笔记会一起没
    const ext = skillExternalProjectId('ext')
    const other = skillExternalProjectId('other')
    putCarrier(ext, { path: tmp.externalDir('ext') })
    putCarrier(other, { path: tmp.externalDir('other') })
    putCarrier(SKILL_DEFAULT_PROJECT_ID, { path: tmp.defaultDir() })
    const mine = putNote(ext, 'a/SKILL.md')
    const kept = [putNote(other, 'b/SKILL.md'), putNote(SKILL_DEFAULT_PROJECT_ID, 'c/SKILL.md')]

    return dropExternalSkillCarrier('ext').then(() => {
      expect(vi.mocked(sessionService.delete).mock.calls).toEqual([[mine.id]])
      expect(db.sessions.map((s) => s.id)).toEqual(kept.map((n) => n.id))
      expect(vi.mocked(projectDao.deleteById).mock.calls).toEqual([[ext]])
      expect(db.projects.has(other)).toBe(true)
      expect(db.projects.has(SKILL_DEFAULT_PROJECT_ID)).toBe(true)
    })
  })

  it('SKN-11 承载项目不存在：no-op、不抛、不查会话', async () => {
    // 一个从没被点开过的外部目录就是这样（承载项目按需插入）——移除它不该炸
    await expect(dropExternalSkillCarrier('never-opened')).resolves.toBeUndefined()
    expect(sessionDao.findByProjectId).not.toHaveBeenCalled()
    expect(sessionService.delete).not.toHaveBeenCalled()
    expect(projectDao.deleteById).not.toHaveBeenCalled()
  })
})

describe('syncSkillBuiltinProject —— 内置目录随界面语言换一版', () => {
  it('SKN-12 没有承载行时什么都不做：insert / update 零调用', () => {
    // 内置载体按需插入（点开一份内置技能才有）。切语言时凭空插一行，项目表里就会多出
    // 一行没人打开过的隐藏项目
    syncSkillBuiltinProject()
    expect(projectDao.insert).not.toHaveBeenCalled()
    expect(projectDao.update).not.toHaveBeenCalled()
  })

  it('SKN-13 有承载行则改指到当前语言目录，name 不变', () => {
    // 技能目录名各语言相同，所以已经开着的笔记 notebookPath 不变，读到的就是新语言那份文件
    // （与内置知识库同策，与按文件后缀分语言的 agent 档案刻意不同）
    putCarrier(SKILL_BUILTIN_PROJECT_ID, { name: 'Builtin Skills', path: tmp.builtinDir() })
    const enDir = tmp.builtinDir()

    tmp.state.builtinLang = 'zh'
    syncSkillBuiltinProject()

    expect(projectDao.update).toHaveBeenCalledTimes(1)
    expect(projectDao.update).toHaveBeenCalledWith(SKILL_BUILTIN_PROJECT_ID, {
      path: tmp.builtinDir()
    })
    const row = db.projects.get(SKILL_BUILTIN_PROJECT_ID)!
    expect(row.path).not.toBe(enDir)
    expect(row.name).toBe('Builtin Skills')
    expect(projectDao.insert).not.toHaveBeenCalled()
  })
})
