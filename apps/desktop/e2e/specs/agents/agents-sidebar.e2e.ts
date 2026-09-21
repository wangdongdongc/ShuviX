/**
 * 侧栏「智能体」分组的 UI 呈现（薄 DOM 层，经 harness/pages）—— 原「设置 → 智能体」tab 搬到前台
 * 之后的同一批用例（旧 ST-1..ST-8 一一对应）。
 *
 * 用户档案点一行**就是打开这份 md 的笔记本会话**（隐藏项目 `__agents__`，自动保存，没有保存按钮），
 * 主区就是普通笔记本；内置档案的 md **随包发布成真实文件**（运行时按当前语言现读的就是它），
 * 点行开的是那份文件的**只读**笔记本（另一个载体项目 `__agents_builtin__`：没有输入卡片、编辑器
 * 不可编辑）—— 跑的和看的是同一份文件，这正是这一版改制的全部意义。「创建覆盖副本」收在
 * **内置行的右键 / ⋮ 菜单**里（设置页那颗按钮的新家），落一份同名用户文件再打开它的笔记。
 * 列表的行按**文件名**认：改名、写坏、修好，开着的都是同一份笔记
 * （按会话 id 断 —— 主窗的 CM6 编辑器本就随外部写入重挂载，钉不住）。写到一半解析不过的档案不进注册表（同名内置照常
 * 生效），列在末尾的琥珀行里 —— 分组里没有另起的原因框，解析器的判定由笔记里属性卡的横幅给出。
 *
 * 分组是懒扫的：经宿主落盘的写入（笔记本自动保存 / 新建 / 删除）广播 `agent.changed` 自动重扫，
 * 绕过宿主直接写盘的（这里的 writeFileSync 种子）与**切换界面语言**都要走组头菜单的「刷新」。
 * 运行时语义（覆盖生效 / 删除效果等）在 agents-registry.e2e.ts 走 IPC 断言。
 *
 * ⚠️ **内置 md 是本仓的真目录**：隔离实例只换了 HOME，`getBuiltinAgentsDir()` 的未打包分支指的
 * 仍是 `packages/agent-runtime/src/subagent/builtinAgents/md`。所以这份 spec **只读它，绝不写**，
 * 也绝不写「试着往内置档案里写、断言被拒」这类用例 —— 闸门若回归，那种用例会改掉产品源码本身。
 * AS-2b 里那条「字节与 mtime 都没变」既是断言也是护栏：任何一次意外的自动保存都在那里现形。
 *
 * ⚠️ 界面语言**显式钉死**（beforeAll 钉 en，AS-10 再切 zh），不跟系统语言走：内置档案的显示名
 * 与「读哪一份文件」三语各一份，不钉死就只能断「是三语里的某一句」。
 *
 * 用例间有顺序依赖：同一个主窗口一路点下去。
 */
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import { sleep, until } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import {
  agentsSidebarPane,
  confirmPane,
  registryNotePane,
  sidebarPane,
  type AgentsSidebarPane,
  type RegistryNotePane
} from '../../harness/pages'
import {
  REGISTRY_NOTE_PROJECT_IDS,
  noteWrite,
  registryNoteSessions,
  waitRendererReady,
  writeAgentMd
} from '../../harness/seed'

const AGENTS_PROJECT = REGISTRY_NOTE_PROJECT_IDS.agent
/** 内置档案（随包发布的 md）的只读载体 —— 与用户档案分属两个项目 */
const BUILTIN_PROJECT = REGISTRY_NOTE_PROJECT_IDS.agentBuiltin
/** AS-2 系列点开的那份内置档案：整份 spec 里没人覆盖它（explore 归 AS-5~7、knowledge-writer 归 AS-12） */
const BUILTIN_SAMPLE = 'titler'

interface AgentRow {
  name: string
  displayName: string
  source: 'builtin' | 'user'
  /** 这份档案的 md 文件：用户的在 ~/.shuvix/agents，内置的在应用包/仓库里（当前语言那一版） */
  basePath: string
  overridden?: boolean
}

/** 只读笔记本开出来的会话要素（IPC 直问宿主，UI 之外的事实源） */
interface BuiltinNote {
  id: string
  projectId: string | null
  notebookPath: string
  workingDirectory: string
}

let app: E2EApp
let pane: AgentsSidebarPane
let note: RegistryNotePane
/** 内置 explore 的显示名（随界面语言本地化，经 IPC 取） */
let exploreLabel = ''
/** 内置 explore 的等价 md（覆盖副本的初值） */
let exploreSource = ''

const agentPath = (fileName: string): string => join(app.agentsDir, fileName)
const listAgents = (): Promise<AgentRow[]> => app.main.eval('window.api.subAgent.list()')

/** 注入开关写成非布尔 → 解析器判整份非法（人读原因带键名 + rejected） */
const invalidAgent = (name: string): string =>
  [
    '---',
    'shuvix: agent v1',
    `name: ${name}`,
    'shuvix-project-awareness: yes please',
    '---',
    '',
    'Invalid body.',
    ''
  ].join('\n')

/** 最小合法用户档案（文件名与 frontmatter name 可以不同 —— 同名裁决要的正是这一点） */
const validAgent = (name: string): string =>
  [
    '---',
    'shuvix: agent v1',
    `name: ${name}`,
    `description: ${name} fixture`,
    '---',
    '',
    `Body of ${name}.`,
    ''
  ].join('\n')

/** 某份内置档案当前生效的那一行（随包 md 的路径就在它的 basePath 上） */
const builtinRow = async (name: string): Promise<AgentRow> =>
  (await listAgents()).find((a) => a.name === name && a.source === 'builtin')!

/** IPC 直问宿主：这份内置档案的只读笔记本是哪一条会话（幂等，已开则复用） */
const openBuiltinNote = (name: string): Promise<BuiltinNote> =>
  app.main.eval<BuiltinNote>(
    `window.api.subAgent.openBuiltinNote(${JSON.stringify({ name })}).then((s) => ({
      id: s.id,
      projectId: s.projectId,
      notebookPath: (s.settings && s.settings.notebookPath) || '',
      workingDirectory: s.workingDirectory || ''
    }))`
  )

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
  en: en.sidebar.agentsGroup,
  zh: zh.sidebar.agentsGroup
}

/**
 * 钉住界面语言。主进程的 i18n 在这次 IPC 里就换好了（agentService 每次 list 现读），渲染进程
 * 要等 `settings.changed` 回来才换 —— 组标签是它的判据；而语言变更**不广播 agent.changed**，
 * 所以分组要手动刷新一次才会重扫。
 */
const setLanguage = async (lang: 'en' | 'zh'): Promise<void> => {
  await app.main.eval(
    `window.api.settings.set({ key: 'general.language', value: ${JSON.stringify(lang)} })`
  )
  await until(
    async () => (await pane.label()) === GROUP_LABEL[lang],
    `agents group label in ${lang}`
  )
  // 刻意不手动刷新：切语言时宿主会广播 agent.changed，这一组自己重扫 —— 行标签跟上是
  // AS-10 要断的东西之一，这里兜一下底就把它盖住了
}

beforeAll(async () => {
  app = await launchApp()
  writeAgentMd(app, 'my-agent', { description: 'user agent', tools: 'read' })
  await waitRendererReady(app.main)
  pane = agentsSidebarPane(app.main)
  note = registryNotePane(app.main)
  await pane.expand()
  // 隔离实例默认跟系统语言走 —— 本地化文案与「读哪一份 md」都得先钉死
  await setLanguage('en')
})
afterAll(async () => {
  await app.stop()
})

describe('侧栏智能体分组', () => {
  it('AS-1 列表：内置行与用户档案行并列、无覆盖徽标；解析不过的文件重扫后进琥珀行而不混进正常行', async () => {
    const builtin = await pane.builtinRows()
    expect(builtin.length).toBeGreaterThanOrEqual(5)
    expect(builtin.every((r) => !r.badge && !r.struck)).toBe(true)
    // 行首那把锁是「内置」的标记（生效与否都只能看）；用户档案行首没有任何字形
    expect(builtin.every((r) => r.locked)).toBe(true)
    const users = await pane.userRows()
    expect(users.map((r) => r.fileName)).toEqual(['my-agent.md'])
    expect(users.every((r) => !r.locked)).toBe(true)
    expect(await pane.invalidRows()).toEqual([])

    // 绕过宿主直接写盘：不广播 agent.changed，靠组头菜单的「刷新」
    writeFileSync(agentPath('as1-broken.md'), invalidAgent('as1-broken'))
    await pane.refresh()
    expect(await pane.invalidRows()).toContain('as1-broken.md')
    expect((await pane.userRows()).some((r) => r.fileName === 'as1-broken.md')).toBe(false)
  })

  it('AS-2 内置行：点它开的是**随包那份 md** 的只读笔记本（另一个载体项目、正文来自盘上同一路径、没有输入卡片、编辑器不可编辑）', async () => {
    // 刻意点 titler：explore 留给 AS-5~AS-7（那里会被覆盖），knowledge-writer 留给 AS-12。
    // 也刻意不用 builtinRows()[0] —— 名单一变，这条测的就是另一个 agent 了
    const listed = await builtinRow(BUILTIN_SAMPLE)
    const fileName = basename(listed.basePath)
    expect(fileName, '内置行的 basePath 是空的').not.toBe('')

    await pane.openBuiltin(BUILTIN_SAMPLE)
    expect(await pane.activeRow()).toEqual({ builtinRow: BUILTIN_SAMPLE })

    // ① IPC 先行：会话挂在只读载体下，notebookPath 正是运行时挑中的那份文件
    const opened = await openBuiltinNote(BUILTIN_SAMPLE)
    expect(opened.projectId).toBe(BUILTIN_PROJECT)
    expect(opened.notebookPath).toBe(fileName)
    // ② 载体的工作目录是内置目录本身，与用户档案那一份泾渭分明 —— 两个根共用一行项目，
    // path 自愈就会在两个目录之间来回改写存量会话的落点
    expect(opened.workingDirectory).toBe(dirname(listed.basePath))
    expect(opened.workingDirectory).not.toBe(app.agentsDir)

    // ③ 属性卡与用户档案那张是同一张（只是不可编辑）
    await note.waitCard()
    expect(await note.cardBadge()).toBe('ShuviX agent · v1')
    const fieldKeys = await app.main.eval<string[]>(
      `[...document.querySelectorAll('.cm-shuvix-fmcard-row')].map((r) => r.dataset.key)`
    )
    expect(fieldKeys).toContain('description')
    expect(fieldKeys).toContain('shuvix-instruction-files')
    expect(fieldKeys).toContain('shuvix-project-awareness')

    // ④ 正文来自盘上同一路径 —— 这条就是「跑的和看的是同一份文件」的全部内容
    await note.waitBody(bodyMarkerOf(listed.basePath))

    // ⑤ 只读：没有悬浮输入卡、编辑器 contenteditable 为 false（对照组在 AS-3）
    expect(await note.hasInputCard()).toBe(false)
    expect(await note.editorEditable()).toBe(false)

    // ⑥ 一份文件至多一条会话：再点一次复用，不另开
    const before = await registryNoteSessions(app.main, BUILTIN_PROJECT)
    expect(before.filter((n) => n.notebookPath === fileName).map((n) => n.id)).toEqual([opened.id])
    await pane.openBuiltin(BUILTIN_SAMPLE)
    expect(await registryNoteSessions(app.main, BUILTIN_PROJECT)).toEqual(before)
  })

  /**
   * 内置 md 是**本仓的真目录**（隔离实例只换 HOME）。这条只读它、绝不写它，也绝不写
   * 「试着往里写、断言被拒」那类用例 —— 闸门若回归，那种用例会改掉产品源码本身。
   * 挡住按键的是 `contenteditable="false"`（AS-2 ⑤ 断的就是那个开关，并在 AS-3 自带可写对照组）；
   * 这一条守的是另一半：**挂载 / 失焦都不会触发一次自动保存**。
   */
  it('AS-2b 只读笔记一个字节都不写盘：跨过自动保存的防抖窗口后，字节与 mtime 都没变', async () => {
    const filePath = (await builtinRow(BUILTIN_SAMPLE)).basePath
    const before = readFileSync(filePath)
    const mtimeBefore = statSync(filePath).mtimeMs

    // 笔记本按 200ms 防抖落盘，失焦是它的另一条提交时机 —— 两条都走一遍再等过窗口
    await app.main.eval(`(() => {
      document.querySelector('.cm-content')?.dispatchEvent(new Event('blur', { bubbles: true }))
      window.dispatchEvent(new Event('blur'))
      return true
    })()`)
    await sleep(700)

    expect(readFileSync(filePath).equals(before)).toBe(true)
    expect(statSync(filePath).mtimeMs).toBe(mtimeBefore)
  })

  it('AS-2c 内置行菜单只有「创建覆盖副本」一项，未被覆盖时可用', async () => {
    // 「查看内置原文」那一项随只读笔记本一并退役 —— 点行本身就是查看
    const items = await pane.builtinRowMenu(BUILTIN_SAMPLE)
    expect(items?.map((i) => i.id)).toEqual(['create-override'])
    expect(items?.find((i) => i.id === 'create-override')?.enabled).not.toBe(false)
  })

  it('AS-3 用户档案行：点它打开这份文件的笔记本（可编辑：三个槽位、开关可用），一份文件只一条会话，菜单给删除', async () => {
    await pane.selectUserRow('my-agent.md')
    expect(await pane.activeRow()).toEqual({ row: 'my-agent.md' })
    await note.waitCard()
    expect(await note.cardBadge()).toBe('ShuviX agent · v1')

    const editable = await app.main.eval<{
      slots: number
      toggles: number
      disabled: boolean
    }>(`(() => {
      const toggles = [...document.querySelectorAll('.cm-shuvix-fmcard-toggle')]
      return {
        slots: document.querySelectorAll('.cm-shuvix-fmcard-slot').length,
        toggles: toggles.length,
        disabled: toggles.some((b) => b.disabled)
      }
    })()`)
    expect(editable.slots).toBe(3) // model + tools + instruction-files 各挂一个真控件
    expect(editable.toggles).toBeGreaterThan(0)
    expect(editable.disabled).toBe(false)

    // AS-2 ⑤ 的对照组：同两个读数在可写笔记本上必须回 true，否则那两条就是空转
    expect(await note.hasInputCard()).toBe(true)
    expect(await note.editorEditable()).toBe(true)

    const notes = await registryNoteSessions(app.main, AGENTS_PROJECT)
    expect(notes.filter((n) => n.notebookPath === 'my-agent.md')).toHaveLength(1)

    expect(await pane.userRowMenuIds('my-agent.md')).toEqual(['delete-agent'])
  })

  it('AS-4 组头菜单「新建智能体」：按模板落一份 my-agent-2.md（名字避开已有的 my-agent），打开它的笔记并成为活动行', async () => {
    expect(await pane.groupMenuIds()).toEqual(['new-agent', 'open-folder', 'refresh'])

    await pane.newAgent()
    await until(() => existsSync(agentPath('my-agent-2.md')), 'my-agent-2.md written')
    expect((await listAgents()).find((a) => a.name === 'my-agent-2')?.source).toBe('user')
    // 落盘广播 agent.changed —— 不必手动刷新
    await until(
      async () => (await pane.userRows()).some((r) => r.fileName === 'my-agent-2.md'),
      'new agent row listed'
    )
    await until(
      async () => (await pane.activeRow())?.row === 'my-agent-2.md',
      'new agent note active'
    )
  })

  it('AS-5 内置行菜单「创建覆盖副本」：同名用户文件逐字节等于内置等价 md 并打开它的笔记；内置行划线带覆盖徽标、覆盖入口置灰', async () => {
    const builtin = (await listAgents()).find(
      (a) => a.name === 'explore' && a.source === 'builtin'
    )!
    exploreLabel = builtin.displayName
    const source = await app.main.eval<{ text?: string; error?: string }>(
      `window.api.subAgent.getSource({ name: 'explore', source: 'builtin' })`
    )
    expect(source.error).toBeUndefined()
    exploreSource = source.text!

    await pane.pickBuiltinRowMenu('explore', 'create-override')
    await until(() => existsSync(agentPath('explore.md')), 'explore.md written')
    expect(readFileSync(agentPath('explore.md'), 'utf8')).toBe(exploreSource)

    await until(async () => (await pane.activeRow())?.row === 'explore.md', 'override note active')
    await until(async () => {
      const row = (await pane.builtinRows()).find((r) => r.name === 'explore')
      // 锁照挂（它还是内置），划线与右侧徽标才是「这份当前不生效」
      return !!row && row.struck && row.badge && row.locked
    }, 'builtin explore row struck + badged')
    expect((await pane.builtinRows()).find((r) => r.name === 'explore')?.label).toBe(exploreLabel)

    // 被遮蔽的内置不再给覆盖入口（再落一份同名文件会被主进程拒绝）—— 菜单项置灰而不是消失
    const items = await pane.builtinRowMenu('explore')
    expect(items?.find((i) => i.id === 'create-override')?.enabled).toBe(false)
  })

  it('AS-6 覆盖副本写坏（写路径 IPC）：那一行翻成琥珀的「无法解析」行、笔记不换会话、卡片横幅给原因、内置恢复生效；写回合法版再翻回来', async () => {
    await pane.selectUserRow('explore.md')
    // 「没被卸载重开」在主窗按**会话 id** 断：笔记本下面的 CM6 编辑器本就按设计随外部写入
    // 重挂载（NotebookView 的 reloadNonce），钉不住；一份文件至多一条会话才是这里的契约
    const noteSessionOf = async (): Promise<string[]> =>
      (await registryNoteSessions(app.main, AGENTS_PROJECT))
        .filter((n) => n.notebookPath === 'explore.md')
        .map((n) => n.id)
    const before = await noteSessionOf()
    expect(before).toHaveLength(1)

    expect(await noteWrite(app.main, 'agent', 'explore.md', invalidAgent('explore'))).toEqual({
      ok: true
    })
    // 经宿主落盘 → agent.changed → 自动重扫（这里不刷新）
    await until(
      async () => (await pane.invalidRows()).includes('explore.md'),
      'explore.md listed as invalid'
    )
    expect((await pane.userRows()).some((r) => r.fileName === 'explore.md')).toBe(false)
    expect(await pane.activeRow()).toEqual({ invalidRow: 'explore.md' })
    // 原因在笔记里属性卡的横幅上 —— 分组里不另起原因框
    await until(
      async () => (await note.bannerText()).includes('must be a boolean'),
      'card banner shows the parser verdict'
    )
    // 非法文件不遮蔽内置
    const shadowed = (await listAgents()).filter((a) => a.name === 'explore')
    expect(shadowed).toHaveLength(1)
    expect(shadowed[0].source).toBe('builtin')
    expect(shadowed[0].overridden).toBeFalsy()
    expect(await noteSessionOf()).toEqual(before)

    expect(await noteWrite(app.main, 'agent', 'explore.md', exploreSource)).toEqual({ ok: true })
    await until(
      async () => (await pane.userRows()).some((r) => r.fileName === 'explore.md'),
      'explore.md listed as a user agent again'
    )
    expect(
      (await listAgents()).find((a) => a.name === 'explore' && a.source === 'builtin')?.overridden
    ).toBe(true)
    expect(await noteSessionOf()).toEqual(before)
  })

  it('AS-7 行菜单删除 → 确认后文件没了：内置 explore 恢复生效（无划线无徽标、锁回来了），开着的那条笔记被离开，文件不被写回', async () => {
    await pane.pickUserRowMenu('explore.md', 'delete-agent')
    const confirm = confirmPane(app.main)
    await confirm.waitOpen()
    await confirm.confirm()

    await until(() => !existsSync(agentPath('explore.md')), 'explore.md deleted')
    await until(async () => {
      const row = (await pane.builtinRows()).find((r) => r.name === 'explore')
      return !!row && !row.struck && !row.badge && row.locked
    }, 'builtin explore restored')
    expect((await pane.userRows()).some((r) => r.fileName === 'explore.md')).toBe(false)
    // 删掉的正是主区开着的那份笔记 —— 留着接着打字，自动保存会把它写回来
    expect(await pane.activeRow()).toBe(null)
    await sleep(700)
    expect(existsSync(agentPath('explore.md'))).toBe(false)
  })

  it('AS-8 两种笔记会话在主窗里都隐身：项目列表没有 __agents__ 也没有 __agents_builtin__，侧栏会话列表里两种笔记都看不见', async () => {
    const notes = await registryNoteSessions(app.main, AGENTS_PROJECT)
    // 会话本身在（session.list 看得见，删文件也不级联）—— 隐身是列表层的过滤
    expect(notes.map((n) => n.notebookPath)).toEqual(
      expect.arrayContaining(['my-agent.md', 'my-agent-2.md', 'explore.md'])
    )
    // 只读那一边同理：AS-2 开出来的那条还在
    const builtinNotes = await registryNoteSessions(app.main, BUILTIN_PROJECT)
    expect(builtinNotes.length).toBeGreaterThan(0)

    const projectIds = await app.main.eval<string[]>(
      `window.api.project.list().then((ps) => ps.map((p) => p.id))`
    )
    expect(projectIds).not.toContain(AGENTS_PROJECT)
    // 第二个载体项目是这一版新加的 —— 漏认它，一个没人认得的项目就会冒进项目列表与日历
    expect(projectIds).not.toContain(BUILTIN_PROJECT)

    // 先让一条普通会话上屏作对照，免得「列表为空」让否定断言空转
    await app.main.eval(`window.api.session.create({ title: 'as8-visible-session' })`)
    const sidebar = sidebarPane(app.main)
    await until(
      async () => (await sidebar.titles()).includes('as8-visible-session'),
      'control session listed in the sidebar'
    )
    const titles = await sidebar.titles()
    for (const n of [...notes, ...builtinNotes]) {
      expect(titles, n.notebookPath).not.toContain(n.title)
    }
  })

  it('AS-9 笔记里改名：行标签跟着变，且不必等切窗口（经宿主落盘的写入广播 agent.changed）', async () => {
    await pane.selectUserRow('my-agent.md')
    await note.waitCard()
    await note.commitField('name', 'my-agent-renamed')

    await until(
      async () =>
        (await pane.userRows()).find((r) => r.fileName === 'my-agent.md')?.label ===
        'my-agent-renamed',
      'row label follows the rename'
    )
    // 身份是文件名：改名不换文件、更不换会话
    expect(existsSync(agentPath('my-agent.md'))).toBe(true)
    expect(await pane.activeRow()).toEqual({ row: 'my-agent.md' })
  })

  it('AS-12 被遮蔽的两种行：内置那份说「被同名自定义档案覆盖」，输掉的用户文件点名胜者；两种都划线带徽标，输的那份只能按文件名删', async () => {
    // 两种遮蔽长得一样（划线 + 徽标），但**原因不同**，提示因此也是两句不同的话
    writeFileSync(agentPath('knowledge-writer.md'), validAgent('knowledge-writer'))
    writeFileSync(agentPath('twin.md'), validAgent('twin'))
    // `aa.md` 更短、码点序也靠前 —— 只有「文件名就是名字」这一条能让 twin.md 胜出
    writeFileSync(agentPath('aa.md'), validAgent('twin'))
    await pane.refresh()

    // ① 被覆盖的内置
    await until(async () => {
      const row = (await pane.builtinRows()).find((r) => r.name === 'knowledge-writer')
      return !!row && row.struck && row.badge
    }, 'builtin knowledge-writer row struck + badged')
    const shadowedBuiltin = (await pane.builtinRows()).find((r) => r.name === 'knowledge-writer')!
    expect(shadowedBuiltin.locked).toBe(true)
    // 内置那句说「有个同名的自定义档案压着它」—— 与用户那句是两个不同的原因
    expect(shadowedBuiltin.title).toBe(en.tool.subAgentOverriddenHint)

    // ② / ④ 同名里输掉的用户文件
    const rows = await pane.userRows()
    const loser = rows.find((r) => r.fileName === 'aa.md')!
    const winner = rows.find((r) => r.fileName === 'twin.md')!
    expect([loser.struck, loser.badge]).toEqual([true, true])
    expect([winner.struck, winner.badge]).toEqual([false, false])
    // 用户那句要说清是被哪一个文件压过 —— 说不清就没法动手去修
    expect(loser.title).toBe(en.settings.shadowedByFileHint.replace('{{file}}', 'twin.md'))
    expect(loser.title).not.toBe(shadowedBuiltin.title)
    expect(loser.locked).toBe(false)

    // ③ 按名删会删到生效的那份 —— 输掉的那份只有按文件名这一条路
    expect(await pane.userRowMenuIds('aa.md')).toEqual(['delete-agent-file'])
    expect(await pane.userRowMenuIds('twin.md')).toEqual(['delete-agent'])
  })

  it('AS-10 切界面语言后点开的仍是运行时读的那一份：basePath / 行标签 / 笔记全换到 .zh.md，英文那条笔记原封不动', async () => {
    // 与内置知识库刻意不同：知识库按语言分**目录**，所以 notebookPath 不变、会话跟着走；
    // 档案按语言分**文件后缀**，于是切语言 = 映射到另一个文件、另一条会话
    const enRow = await builtinRow('work')
    expect(basename(enRow.basePath)).toBe('work.md')
    await pane.openBuiltin('work')
    const enNote = await openBuiltinNote('work')
    expect(enNote.notebookPath).toBe('work.md')
    expect(await note.bodyText()).toContain(bodyMarkerOf(enRow.basePath))

    await setLanguage('zh')

    // ① 运行时挑中的是 .zh.md 那一份
    const zhRow = await builtinRow('work')
    expect(basename(zhRow.basePath)).toBe('work.zh.md')
    expect(dirname(zhRow.basePath)).toBe(dirname(enRow.basePath))
    // ② 行显示名换成中文那一版（取自盘上那份 md，不在用例里抄一遍）
    const zhDisplayName = readFileSync(zhRow.basePath, 'utf8')
      .split('\n')
      .find((l) => l.startsWith('shuvix-displayName:'))!
      .slice('shuvix-displayName:'.length)
      .trim()
    expect(zhDisplayName).not.toBe(enRow.displayName)
    await until(
      async () =>
        (await pane.builtinRows()).find((r) => r.name === 'work')?.label === zhDisplayName,
      'builtin work row relabelled in Chinese'
    )

    // ③ 点行开出的是**另一条**会话，绑的是 work.zh.md
    await pane.openBuiltin('work')
    const zhNote = await openBuiltinNote('work')
    expect(zhNote.notebookPath).toBe('work.zh.md')
    expect(zhNote.id).not.toBe(enNote.id)
    // 英文那条还在、一字未改（切语言不该把存量会话改指到别的文件上）
    const sessions = await registryNoteSessions(app.main, BUILTIN_PROJECT)
    expect(sessions.find((s) => s.id === enNote.id)?.notebookPath).toBe('work.md')

    // ④ 正文与 zh 那份文件相符，且不再是英文那一份
    await note.waitBody(bodyMarkerOf(zhRow.basePath))
    expect(await note.bodyText()).not.toContain(bodyMarkerOf(enRow.basePath))
  })
})
