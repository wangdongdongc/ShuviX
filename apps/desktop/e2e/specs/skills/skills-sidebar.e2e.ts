/**
 * 侧栏「技能」分组的 UI 呈现（薄 DOM 层，经 harness/pages）—— 原「设置 → 技能」tab 搬到前台
 * 之后的同一批用例。
 *
 * 这一组比智能体那组**多一层**，因为技能是**目录**而不是单文件（`SKILL.md` 旁边还有
 * `references/`）：内置目录置顶（文件夹行、带锁、只读）→ 用户添加的外部目录（文件夹行，按添加
 * 顺序）→ **默认目录的技能平铺，不占文件夹行**（它是「你自己的技能」那一摞，多包一层只是多一次
 * 点击）。项目级技能刻意不列 —— 它随当前会话的项目变，而这一组是全局的。点任一行打开的是那个
 * 技能 `SKILL.md` 的**笔记本会话**（承载项目见 chat-protocol/skillNotes：默认 / 内置 / 每个外部
 * 目录各一个），与 Bots、智能体档案、知识库条目同一条路。技能比它们多一样东西：**两级启用开关**
 * （单个技能 + 整个目录），收在右键 / ⋮ 菜单里，禁用的行变淡。移除一个外部目录会连同它的承载
 * 项目与那些笔记会话一并清掉。
 *
 * ⚠️ **内置技能目录是本仓的真目录**：隔离实例只换了 HOME，`getBuiltinSkillsDir()` 的未打包分支
 * 指的仍是 `apps/desktop/resources/skills/<lang>`。所以这份 spec **只读它，绝不写**，也绝不写
 * 「试着往内置技能里写、断言被拒」这类用例 —— 闸门若回归，那种用例会改掉产品源码本身。
 * SK-4 里那条「字节与 mtime 都没变」既是断言也是护栏：任何一次意外的自动保存都在那里现形。
 *
 * ⚠️ 界面语言**显式钉死**（beforeAll 钉 en，SK-13 再切 zh），不跟系统语言走：内置技能按语言
 * 分**目录**（`skills/<lang>/`），正文与描述三语各一份，不钉死就只能断「是三语里的某一句」。
 *
 * 外部目录的「选目录」那一步是 OS 级模态（`dialog.showOpenDialog`），CDP 驱动不了 ——
 * bootstrap.cjs 把 `skill:pickExternalDir` 换成了读 `window.__E2E_SKILL_DIR_PICK` 的桩，
 * 于是「选目录 → 取名框 → 落地」整条流程仍走产品代码（刻意不在 e2e 里直接调 addExternalDir）。
 *
 * 分组是懒扫的：经宿主落盘的写入（开关 / 增删目录 / 删除技能 / 笔记本自动保存）广播
 * `skill.changed` 自动重扫；绕过宿主直接写盘的（SK-15 的 writeFileSync 种子）要走组头菜单的
 * 「刷新」。两级开关的语义本身在 skillServiceGroups.test.ts 走 IPC/文件系统断言，这里不重复。
 *
 * 用例间有顺序依赖：同一个主窗口一路点下去。
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import {
  SKILL_BUILTIN_PROJECT_ID,
  SKILL_DEFAULT_PROJECT_ID,
  skillExternalProjectId
} from '@shuvix/chat-protocol/skillNotes'
import { sleep, until } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import {
  confirmPane,
  registryNotePane,
  sidebarPane,
  skillsSidebarPane,
  type RegistryNotePane,
  type SkillsSidebarPane
} from '../../harness/pages'
import {
  createProject,
  registryNoteSessions,
  seedExternalSkillDir,
  seedSkillIn,
  waitRendererReady
} from '../../harness/seed'

/** 内置那份技能（本仓真目录里唯一的一个）—— 只读它 */
const BUILTIN_SKILL = 'builtin:drawing'

interface SkillNote {
  id: string
  projectId: string | null
  notebookPath: string
  workingDirectory: string
}

interface SkillShot {
  name: string
  source: string
  basePath: string
  isEnabled: boolean
}

interface GroupShot {
  dirName: string
  dirPath: string
  isDefault: boolean
  isEnabled: boolean
  skills: SkillShot[]
}

let app: E2EApp
let pane: SkillsSidebarPane
let note: RegistryNotePane
/** `~/.shuvix/skills` —— 默认目录（可写） */
let skillsDir = ''
/** 外部目录的绝对路径 */
const extDirs: Record<string, string> = {}

/** IPC 直问宿主：这个技能的笔记本是哪一条会话（幂等，已开则复用） */
const openNote = (name: string): Promise<SkillNote> =>
  app.main.eval<SkillNote>(
    `window.api.skill.openNote(${JSON.stringify({ name })}).then((s) => ({
      id: s.id,
      projectId: s.projectId,
      notebookPath: (s.settings && s.settings.notebookPath) || '',
      workingDirectory: s.workingDirectory || ''
    }))`
  )

const listSkills = (): Promise<SkillShot[]> =>
  app.main.eval<SkillShot[]>(
    `window.api.skill.list().then((ss) => ss.map((s) => ({
      name: s.name, source: s.source, basePath: s.basePath, isEnabled: s.isEnabled
    })))`
  )

const listGroups = (): Promise<GroupShot[]> =>
  app.main.eval<GroupShot[]>(
    `window.api.skill.listGrouped().then((gs) => gs.map((g) => ({
      dirName: g.dirName, dirPath: g.dirPath, isDefault: g.isDefault, isEnabled: g.isEnabled,
      skills: g.skills.map((s) => ({
        name: s.name, source: s.source, basePath: s.basePath, isEnabled: s.isEnabled
      }))
    })))`
  )

const sessionIds = (): Promise<string[]> =>
  app.main.eval<string[]>(`window.api.session.list().then((ss) => ss.map((s) => s.id))`)

/**
 * 一份 md 正文里第一行**纯散文** —— 拿它当「读到的是盘上这一份」的特征串。
 * 标题 / 列表 / 引用的行首标记与行内的 `code`、**bold** 在 live-preview 里都会被吃掉，
 * 所以带任何 markdown 记号的行都不能拿来比对 `.cm-content` 的文字。
 */
const bodyMarkerOf = (filePath: string): string => {
  const body = readFileSync(filePath, 'utf8').split(/^---$/m).slice(2).join('---')
  const line = body
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '' && !/^[#>\-*\d|]/.test(l) && !/[`*_[\]<>|]/.test(l))
  if (!line) throw new Error(`no plain-prose body line in ${filePath}`)
  return line.slice(0, 60)
}

/** 组头标签 —— 渲染进程 `t()` 出来的字，拿它当「界面语言换过去了」的判据 */
const GROUP_LABEL: Record<'en' | 'zh', string> = {
  en: en.sidebar.skillsGroup,
  zh: zh.sidebar.skillsGroup
}

/**
 * 钉住界面语言。主进程的 i18n 在这次 IPC 里就换好了（getBuiltinSkillsDir 每次现读），渲染进程
 * 要等 `settings.changed` 回来才换 —— 组标签是它的判据。切语言同时广播 `skill.changed`，
 * 这一组会自己重扫，不必手动刷新。
 */
const setLanguage = async (lang: 'en' | 'zh'): Promise<void> => {
  await app.main.eval(
    `window.api.settings.set({ key: 'general.language', value: ${JSON.stringify(lang)} })`
  )
  await until(
    async () => (await pane.label()) === GROUP_LABEL[lang],
    `skills group label in ${lang}`
  )
}

/** 钉好「OS 选择器会选中哪个目录」（桩取走即清；没钉 = 用户按了取消） */
const armDirPicker = (path: string): Promise<unknown> =>
  app.main.eval(`window.__E2E_SKILL_DIR_PICK = ${JSON.stringify(path)}`)

beforeAll(async () => {
  app = await launchApp()
  skillsDir = join(app.home, '.shuvix', 'skills')
  mkdirSync(skillsDir, { recursive: true })

  // 默认目录的两个技能（平铺在最后那一摞）
  seedSkillIn(skillsDir, 'alpha', { description: 'alpha trigger', body: 'Alpha skill prose.' })
  seedSkillIn(skillsDir, 'beta', { description: 'beta trigger', body: 'Beta skill prose.' })

  // 两个**已在配置里**的外部目录：SK-1 要断「外部按添加顺序」，而 UI 添加那条路归 SK-8。
  // 直接写 .config.json 是种子（这个文件就是配置的唯一落点），不绕过任何被测逻辑
  extDirs['ext-a'] = seedExternalSkillDir(app, 'ext-a')
  extDirs['ext-b'] = seedExternalSkillDir(app, 'ext-b')
  writeFileSync(
    join(skillsDir, '.config.json'),
    JSON.stringify({
      disabled: [],
      disabledDirs: [],
      dirs: [
        { name: 'ext-a', path: extDirs['ext-a'] },
        { name: 'ext-b', path: extDirs['ext-b'] }
      ]
    })
  )

  // 项目级技能（SK-2 的否定断言对象）：它在盘上真的存在，只是不该进这一组
  const projectPath = join(app.home, 'proj')
  seedSkillIn(join(projectPath, '.claude', 'skills'), 'proj-only', {
    description: 'project-level skill'
  })
  await waitRendererReady(app.main)
  await createProject(app.main, { name: 'sk-project', path: projectPath })

  pane = skillsSidebarPane(app.main)
  note = registryNotePane(app.main)
  await pane.expand()
  // 隔离实例默认跟系统语言走 —— 本地化文案与「读哪一版内置技能」都得先钉死
  await setLanguage('en')
})

afterAll(async () => {
  await app.stop()
})

describe('侧栏技能分组', () => {
  it('SK-1 两层结构与顺序：内置置顶带锁 → 外部按添加顺序；默认目录不画文件夹行，它的技能不缩进', async () => {
    const folders = await pane.folders()
    expect(folders.map((f) => f.dirName)).toEqual(['builtin', 'ext-a', 'ext-b'])
    // 锁是「内置」的标记（只读，不能移除、里面的技能不能删）
    expect(folders.map((f) => f.locked)).toEqual([true, false, false])
    expect(folders.every((f) => !f.off)).toBe(true)
    // 内置那行显示的是本地化的「内置」，外部行就是用户取的目录名
    expect(folders[0].label).toBe(en.settings.skillDirBuiltin)
    expect(folders.slice(1).map((f) => f.label)).toEqual(['ext-a', 'ext-b'])
    // 默认目录**没有**文件夹行 —— 它是这一组与智能体那组长得一样的那一半
    expect(folders.map((f) => f.dirName)).not.toContain('default')

    // 目录下的行缩进，默认目录那一摞不缩进
    const under = await pane.rowsUnder('ext-a')
    expect(under.map((r) => r.name)).toEqual(['ext-a:ext-a-one', 'ext-a:ext-a-two'])
    expect(under.every((r) => r.indented)).toBe(true)

    const flat = await pane.flatRows()
    expect(flat.map((r) => r.name)).toEqual(['alpha', 'beta'])
    expect(flat.every((r) => !r.indented)).toBe(true)
    // 平铺行排在最后：DOM 序 = 展示序
    const all = (await pane.rows()).map((r) => r.name)
    expect(all.slice(-2)).toEqual(['alpha', 'beta'])
    expect(all[0]).toBe(BUILTIN_SKILL)
  })

  it('SK-2 项目级技能不列：盘上有、这一组里没有，宿主的分组清单里也没有 project 组', async () => {
    // 项目级技能随当前会话的项目变，混进这一组就看不出「当前生不生效」
    expect(existsSync(join(app.home, 'proj', '.claude', 'skills', 'proj-only', 'SKILL.md'))).toBe(
      true
    )
    expect((await pane.rows()).some((r) => r.name.includes('proj-only'))).toBe(false)
    const groups = await listGroups()
    expect(groups.map((g) => g.dirName)).not.toContain('project')
    expect((await listSkills()).some((s) => s.source === 'project')).toBe(false)
  })

  it('SK-3 默认目录的技能：点行开这份 SKILL.md 的笔记本（可编辑），再点复用同一条会话', async () => {
    await pane.openSkill('alpha')
    expect(await pane.activeRow()).toBe('alpha')

    // ① IPC 先行：会话挂在默认目录的载体下，notebookPath 带一层目录名
    const opened = await openNote('alpha')
    expect(opened.projectId).toBe(SKILL_DEFAULT_PROJECT_ID)
    expect(opened.notebookPath).toBe('alpha/SKILL.md')
    expect(opened.workingDirectory).toBe(skillsDir)

    // ② 属性卡：SKILL.md 没有 `shuvix:` 自述行，靠笔记本传 fallbackType 兜底才有这张卡
    await note.waitCard()
    expect(await note.cardBadge()).toBe('Skill')

    // ③ 正文来自盘上同一路径
    await note.waitBody(bodyMarkerOf(join(skillsDir, 'alpha', 'SKILL.md')))

    // ④ 可写：有悬浮输入卡、编辑器可编辑（SK-4 只读那条的对照组）
    expect(await note.hasInputCard()).toBe(true)
    expect(await note.editorEditable()).toBe(true)

    // ⑤ 一份文件至多一条会话：再点一次复用，不另开
    const before = await registryNoteSessions(app.main, SKILL_DEFAULT_PROJECT_ID)
    expect(before.filter((n) => n.notebookPath === 'alpha/SKILL.md').map((n) => n.id)).toEqual([
      opened.id
    ])
    await pane.openSkill('alpha')
    expect(await registryNoteSessions(app.main, SKILL_DEFAULT_PROJECT_ID)).toEqual(before)
  })

  /**
   * 内置技能目录是**本仓的真目录**（隔离实例只换 HOME）。这条只读它、绝不写它，也绝不写
   * 「试着往里写、断言被拒」那类用例 —— 闸门若回归，那种用例会改掉产品源码本身。
   * 挡住按键的是 `contenteditable="false"`；这一条守的是另一半：**挂载 / 失焦都不触发自动保存**。
   */
  it('SK-4 内置技能：另一个载体项目、只读（无输入卡、不可编辑），且一个字节都不写盘', async () => {
    const builtin = (await listSkills()).find((s) => s.name === BUILTIN_SKILL)!
    const filePath = join(builtin.basePath, 'SKILL.md')
    const bytesBefore = readFileSync(filePath)
    const mtimeBefore = statSync(filePath).mtimeMs

    await pane.openSkill(BUILTIN_SKILL)
    expect(await pane.activeRow()).toBe(BUILTIN_SKILL)

    const opened = await openNote(BUILTIN_SKILL)
    expect(opened.projectId).toBe(SKILL_BUILTIN_PROJECT_ID)
    // 内置与默认是两个载体：承载项目的 path 决定 notebookPath 相对哪个根解析
    expect(opened.projectId).not.toBe(SKILL_DEFAULT_PROJECT_ID)
    expect(opened.notebookPath).toBe('drawing/SKILL.md')
    expect(opened.workingDirectory).not.toBe(skillsDir)
    expect(builtin.basePath.startsWith(opened.workingDirectory)).toBe(true)

    await note.waitCard()
    expect(await note.cardBadge()).toBe('Skill')
    await note.waitBody(bodyMarkerOf(filePath))

    expect(await note.hasInputCard()).toBe(false)
    expect(await note.editorEditable()).toBe(false)

    // 笔记本按 200ms 防抖落盘，失焦是它的另一条提交时机 —— 两条都走一遍再等过窗口
    await app.main.eval(`(() => {
      document.querySelector('.cm-content')?.dispatchEvent(new Event('blur', { bubbles: true }))
      window.dispatchEvent(new Event('blur'))
      return true
    })()`)
    await sleep(700)
    expect(readFileSync(filePath).equals(bytesBefore)).toBe(true)
    expect(statSync(filePath).mtimeMs).toBe(mtimeBefore)
  })

  it('SK-5 技能行菜单：默认目录给删除，外部 / 内置只给开关；关掉后行变淡且 IPC 对账', async () => {
    // 删除只对默认目录开放：外部目录是用户自己的文件夹（移除来源即可），内置随包发布
    expect(await pane.skillMenuIds('beta')).toEqual(['toggle', 'delete'])
    expect(await pane.skillMenuIds('ext-a:ext-a-one')).toEqual(['toggle'])
    expect(await pane.skillMenuIds(BUILTIN_SKILL)).toEqual(['toggle'])

    await pane.pickSkillMenu('ext-a:ext-a-one', 'toggle')
    await until(
      async () =>
        (await pane.rowsUnder('ext-a')).find((r) => r.name === 'ext-a:ext-a-one')?.off === true,
      'ext-a:ext-a-one dimmed'
    )
    // 行变淡不只是样式：宿主那边真的关了
    expect((await listSkills()).find((s) => s.name === 'ext-a:ext-a-one')?.isEnabled).toBe(false)
    // 同组的另一行不受牵连
    expect((await pane.rowsUnder('ext-a')).find((r) => r.name === 'ext-a:ext-a-two')?.off).toBe(
      false
    )

    await pane.pickSkillMenu('ext-a:ext-a-one', 'toggle')
    await until(
      async () =>
        (await pane.rowsUnder('ext-a')).find((r) => r.name === 'ext-a:ext-a-one')?.off === false,
      'ext-a:ext-a-one back on'
    )
    expect((await listSkills()).find((s) => s.name === 'ext-a:ext-a-one')?.isEnabled).toBe(true)
  })

  it('SK-6 目录开关关掉 → 组内每一行都变淡，即使它们自己的 isEnabled 仍为 true', async () => {
    // 这正是渲染端 `off = !skill.isEnabled || !folder.isEnabled` 存在的理由：组关掉时
    // 单个技能的 isEnabled **不被改写**，行上要看得出来，否则「我明明开着」是个谜
    expect(await pane.folderMenuIds('ext-a')).toEqual(['toggle', 'open', 'remove'])
    // 内置目录不给「移除」（它随包发布）
    expect(await pane.folderMenuIds('builtin')).toEqual(['toggle', 'open'])

    await pane.pickFolderMenu('ext-a', 'toggle')
    await until(
      async () => (await pane.folders()).find((f) => f.dirName === 'ext-a')?.off === true,
      'ext-a folder dimmed'
    )
    const rows = await pane.rowsUnder('ext-a')
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.off)).toBe(true)

    const group = (await listGroups()).find((g) => g.dirName === 'ext-a')!
    expect(group.isEnabled).toBe(false)
    // 每个技能自己那一级仍然是开着的 —— 变淡来自组这一级
    expect(group.skills.map((s) => s.isEnabled)).toEqual([true, true])
    // 别的组不受影响
    expect((await pane.flatRows()).every((r) => !r.off)).toBe(true)

    await pane.pickFolderMenu('ext-a', 'toggle')
    await until(
      async () => (await pane.rowsUnder('ext-a')).every((r) => !r.off),
      'ext-a folder back on'
    )
  })

  it('SK-7 默认目录的组开关在组头菜单里：切换后最后那批平铺行全部变淡', async () => {
    // 默认目录没有文件夹行，它的开关只能收在组头 —— 少了这一项，那一摞就没有关法
    expect(await pane.groupMenuIds()).toEqual([
      'add-folder',
      'open-default',
      'toggle-default',
      'refresh'
    ])

    await pane.pickGroupMenu('toggle-default')
    await until(async () => (await pane.flatRows()).every((r) => r.off), 'default skills dimmed')
    const flat = await pane.flatRows()
    expect(flat).toHaveLength(2)
    // 目录那两组不受影响
    expect((await pane.rowsUnder('ext-a')).every((r) => !r.off)).toBe(true)
    expect((await listGroups()).find((g) => g.isDefault)?.isEnabled).toBe(false)

    await pane.pickGroupMenu('toggle-default')
    await until(async () => (await pane.flatRows()).every((r) => !r.off), 'default skills back on')
  })

  it('SK-8 添加外部目录两步走：桩选择器 → 取名框预填目录名 → 落地成一行文件夹（排在已有的之后）', async () => {
    extDirs['ext-c'] = seedExternalSkillDir(app, 'ext-c')
    await armDirPicker(extDirs['ext-c'])
    await pane.pickGroupMenu('add-folder')

    const dialog = pane.skillDirDialog()
    await dialog.waitOpen()
    // 框头上是已选好的绝对路径，输入框缺省填目录自己的名字（多数情况直接回车）
    expect(await dialog.path()).toBe(extDirs['ext-c'])
    expect(await dialog.name()).toBe('ext-c')
    await dialog.submit()
    await dialog.waitClosed()

    await until(
      async () => (await pane.folders()).some((f) => f.dirName === 'ext-c'),
      'ext-c folder listed'
    )
    // 新目录排在已有外部目录之后（配置里的顺序就是展示顺序）
    expect((await pane.folders()).map((f) => f.dirName)).toEqual([
      'builtin',
      'ext-a',
      'ext-b',
      'ext-c'
    ])
    // 标识带目录前缀，行上只显示后半截
    const rows = await pane.rowsUnder('ext-c')
    expect(rows.map((r) => r.name)).toEqual(['ext-c:ext-c-one', 'ext-c:ext-c-two'])
    expect(rows.map((r) => r.label)).toEqual(['ext-c-one', 'ext-c-two'])
  })

  it('SK-9 重名被拒：原因原样显示在框里，对话框停留不关', async () => {
    // 目录名是组内技能标识的前缀、分组的键、承载项目 id 的一段 —— 重名会让两个目录互相顶掉
    const dupDir = seedExternalSkillDir(app, 'ext-dup')
    await armDirPicker(dupDir)
    await pane.pickGroupMenu('add-folder')

    const dialog = pane.skillDirDialog()
    await dialog.waitOpen()
    await dialog.setName('ext-a')
    await dialog.submit()

    // 原因来自主进程、没有本地化，原样显示
    await until(async () => (await dialog.error()) !== '', 'rejection reason shown')
    expect(await dialog.error()).toBe('Directory name "ext-a" already exists')
    expect(await dialog.isOpen()).toBe(true)
    // 配置一个字没动
    expect((await pane.folders()).map((f) => f.dirName)).toEqual([
      'builtin',
      'ext-a',
      'ext-b',
      'ext-c'
    ])

    await dialog.cancel()
    await dialog.waitClosed()
  })

  it('SK-10 移除外部目录：它的笔记会话一并消失，别处的笔记还在；同名换个路径加回来是新的会话', async () => {
    const extNote = await openNote('ext-c:ext-c-one')
    expect(extNote.projectId).toBe(skillExternalProjectId('ext-c'))
    expect(extNote.workingDirectory).toBe(extDirs['ext-c'])
    const alphaNote = await openNote('alpha')
    expect(await sessionIds()).toEqual(expect.arrayContaining([extNote.id, alphaNote.id]))

    await pane.pickFolderMenu('ext-c', 'remove')
    const confirm = confirmPane(app.main)
    await confirm.waitOpen()
    await confirm.confirm()

    await until(
      async () => !(await pane.folders()).some((f) => f.dirName === 'ext-c'),
      'ext-c folder gone'
    )
    // 级联按会话 id 断：目录都不在了，那些会话指向的文件已经与本应用无关
    await until(async () => !(await sessionIds()).includes(extNote.id), 'ext-c note session gone')
    // 只清这一个载体 —— 默认目录那条笔记原封不动
    expect(await sessionIds()).toContain(alphaNote.id)

    // 同名换个路径加回来：是**新的**承载会话，工作目录是新路径
    const moved = seedExternalSkillDir(app, 'ext-c-moved')
    extDirs['ext-c'] = moved
    await armDirPicker(moved)
    await pane.pickGroupMenu('add-folder')
    const dialog = pane.skillDirDialog()
    await dialog.waitOpen()
    await dialog.setName('ext-c')
    await dialog.submit()
    await dialog.waitClosed()
    await until(
      async () => (await pane.rowsUnder('ext-c')).length > 0,
      'ext-c re-added with its skills'
    )

    const reopened = await openNote('ext-c:ext-c-moved-one')
    expect(reopened.id).not.toBe(extNote.id)
    expect(reopened.projectId).toBe(skillExternalProjectId('ext-c'))
    expect(reopened.workingDirectory).toBe(moved)
  })

  it('SK-11 删除技能只对默认目录开放：删完离开那条笔记，跨过防抖窗口后文件没被写回', async () => {
    await pane.openSkill('beta')
    expect(await pane.activeRow()).toBe('beta')
    const betaDir = join(skillsDir, 'beta')
    expect(existsSync(betaDir)).toBe(true)

    await pane.pickSkillMenu('beta', 'delete')
    const confirm = confirmPane(app.main)
    await confirm.waitOpen()
    await confirm.confirm()

    await until(() => !existsSync(betaDir), 'beta skill directory removed')
    await until(async () => !(await pane.rows()).some((r) => r.name === 'beta'), 'beta row gone')
    // 删掉的正是主区开着的那份笔记 —— 留着接着打字，自动保存会把它写回来
    expect(await pane.activeRow()).toBe(null)
    await sleep(700)
    expect(existsSync(betaDir)).toBe(false)
  })

  it('SK-12 笔记里改 name：行标签跟着变（不必手动刷新），再点这一行仍是同一条笔记', async () => {
    await pane.openSkill('alpha')
    const before = await openNote('alpha')
    await note.waitCard()
    await note.commitField('name', 'alpha-renamed')

    // 经宿主落盘 → skillService.noteFileWritten → 合并窗口后 skill.changed → 自动重扫
    await until(
      async () => (await pane.flatRows()).some((r) => r.name === 'alpha-renamed'),
      'row label follows the rename'
    )
    const row = (await pane.flatRows()).find((r) => r.name === 'alpha-renamed')!
    expect(row.label).toBe('alpha-renamed')

    // 身份是**磁盘目录名**（frontmatter 的 name 只是显示与标识）：改名不换文件、更不换会话。
    // 按 name 切路径的写法会拼出 `alpha-renamed/SKILL.md` —— 那个文件根本不存在，点开毫无反应
    const after = await openNote('alpha-renamed')
    expect(after.id).toBe(before.id)
    expect(after.notebookPath).toBe('alpha/SKILL.md')
    expect(existsSync(join(skillsDir, 'alpha', 'SKILL.md'))).toBe(true)
    await pane.openSkill('alpha-renamed')
    expect(await pane.activeRow()).toBe('alpha-renamed')
  })

  it('SK-13 切界面语言：内置那条笔记的 notebookPath 与会话 id 都不变，工作目录与正文换到 zh 那一版', async () => {
    // 与智能体那组刻意相反：档案按语言分**文件后缀**（work.zh.md），于是切语言 = 另一条会话；
    // 技能按语言分**目录**，目录名各语言相同 —— notebookPath 不变，会话跟着走
    await pane.openSkill(BUILTIN_SKILL)
    const enNote = await openNote(BUILTIN_SKILL)
    const enFile = join(enNote.workingDirectory, 'drawing', 'SKILL.md')
    await note.waitBody(bodyMarkerOf(enFile))

    await setLanguage('zh')

    const zhNote = await openNote(BUILTIN_SKILL)
    expect(zhNote.id).toBe(enNote.id)
    expect(zhNote.notebookPath).toBe('drawing/SKILL.md')
    expect(zhNote.workingDirectory).not.toBe(enNote.workingDirectory)
    expect(zhNote.workingDirectory.endsWith('/zh')).toBe(true)
    const zhFile = join(zhNote.workingDirectory, 'drawing', 'SKILL.md')
    expect(existsSync(zhFile)).toBe(true)

    // 换个笔记再回来（笔记本按 sessionId + path 缓存，而这两样都没变）——
    // 用户那一侧就是「回头再看一眼」
    await pane.openSkill('alpha-renamed')
    await pane.openSkill(BUILTIN_SKILL)
    await note.waitBody(bodyMarkerOf(zhFile))
    expect(await note.bodyText()).not.toContain(bodyMarkerOf(enFile))
    // 仍然只读
    expect(await note.hasInputCard()).toBe(false)
  })

  it('SK-14 三类承载项目都不进项目列表，技能笔记也不进侧栏会话列表', async () => {
    // 先把外部目录那一类载体也开出来，三类齐了再断
    const extNote = await openNote('ext-a:ext-a-one')
    expect(extNote.projectId).toBe(skillExternalProjectId('ext-a'))

    const carriers = [
      SKILL_DEFAULT_PROJECT_ID,
      SKILL_BUILTIN_PROJECT_ID,
      skillExternalProjectId('ext-a'),
      skillExternalProjectId('ext-c')
    ]
    const projectIds = await app.main.eval<string[]>(
      `window.api.project.list().then((ps) => ps.map((p) => p.id))`
    )
    for (const id of carriers) expect(projectIds, id).not.toContain(id)

    // 会话本身在（session.list 看得见）—— 隐身是列表层的过滤
    const notes = (
      await Promise.all(carriers.map((id) => registryNoteSessions(app.main, id)))
    ).flat()
    expect(notes.length).toBeGreaterThan(0)

    // 先让一条普通会话上屏作对照，免得「列表为空」让否定断言空转
    await app.main.eval(`window.api.session.create({ title: 'sk14-visible-session' })`)
    const sidebar = sidebarPane(app.main)
    await until(
      async () => (await sidebar.titles()).includes('sk14-visible-session'),
      'control session listed in the sidebar'
    )
    const titles = await sidebar.titles()
    for (const n of notes) expect(titles, n.notebookPath).not.toContain(n.title)
  })

  it('SK-16 空的外部目录照样有一行：否则加错一个目录就再也移不掉（移除只长在文件夹行的菜单上）', async () => {
    // 造一个一个技能都没有的目录，走 UI 那两步加进来
    const empty = join(app.home, 'external-skills', 'ext-empty')
    mkdirSync(empty, { recursive: true })
    await armDirPicker(empty)
    await pane.pickGroupMenu('add-folder')
    const dialog = pane.skillDirDialog()
    await dialog.waitOpen()
    await dialog.submit()
    await dialog.waitClosed()

    // 行在（空目录不是「不存在」），展开之后组内确实一条技能都没有
    await until(
      async () => (await pane.folders()).some((f) => f.dirName === 'ext-empty'),
      'empty external folder listed'
    )
    await pane.toggleFolder('ext-empty')
    expect(await pane.rowsUnder('ext-empty')).toEqual([])

    // 有行才有菜单，有菜单才移得掉 —— 这就是这条用例的全部理由
    expect(await pane.folderMenuIds('ext-empty')).toContain('remove')
    await pane.pickFolderMenu('ext-empty', 'remove')
    const confirm = confirmPane(app.main)
    await confirm.waitOpen()
    await confirm.confirm()
    await until(
      async () => !(await pane.folders()).some((f) => f.dirName === 'ext-empty'),
      'empty external folder removed'
    )
  })

  it('SK-15 组头「刷新」兜住绕过宿主的直接写盘', async () => {
    // 经宿主落盘的写入会广播 skill.changed；外部编辑器 / 这里的 writeFileSync 不会，
    // 组头那一项就是为它准备的（同智能体那组）
    seedSkillIn(skillsDir, 'sk15-direct', { description: 'written straight to disk' })
    expect((await pane.flatRows()).some((r) => r.name === 'sk15-direct')).toBe(false)

    await pane.refresh()
    await until(
      async () => (await pane.flatRows()).some((r) => r.name === 'sk15-direct'),
      'directly written skill listed after refresh'
    )
    expect((await pane.flatRows()).find((r) => r.name === 'sk15-direct')?.indented).toBe(false)
  })
})
