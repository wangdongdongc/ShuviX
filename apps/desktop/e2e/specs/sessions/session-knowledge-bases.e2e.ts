/**
 * 会话用哪几个知识库（`settings.knowledgeBases`）—— 与并排的扩展能力勾选
 * （session-extensions.e2e.ts）**处处相反**，所以这份 spec 处处拿它作对照：
 *
 *   - 扩展能力在 `create` 时**恒写键**（快照）；知识库**恒不写键** —— 它是一条活的回落链
 *     （会话 → 父会话 → 项目 → **缺省一个都不启用**），写键就等于替用户做了选择。
 *   - 项目库（`project`）**不归选择管**：项目会话里它隐式启用（接替退役的项目记忆），所以它从不是
 *     候选项、配置卡与项目对话框里都没有这个 chip；存量选择里残留的 `project` 读时剔掉（KB-E-10）。
 *   - 扩展能力在运行时存在期间改了要**重配**那个 agent（2026-10-26 起当场生效，此前只读）；知识库
 *     连重配都不用 —— 它不进 pi 的工具表，是 `knowledge` 工具每次调用时由宿主现查的。两者是同一张
 *     扩展能力卡里的不同行，有运行时都可点（KB-E-4）；输入框的工具选择器列的是同样几组、同一份数据
 *     （KB-E-11）。
 *   - 已接受的边界：工具面改完立刻生效，而 `<knowledge_bases>` 围栏住在系统提示词里、在创建
 *     Agent 那一刻定型 —— 已存在的运行时里那段不变（KB-E-3 钉住现状；围栏内容本身在
 *     agents/context-injection.e2e.ts 的 KBF-E-* 里）。
 *
 * 隔离实例默认没有用户库：库用 `knowledge.createBase` 现建（它顺带广播 `knowledge.changed`，
 * KB-E-4 的「面板开着也长得出来」正是靠这一条）。全程无 LLM：运行时靠
 * `agent.getInfo(sid, { ensure: true })` 懒建。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import ja from '@shuvix/chat-protocol/i18n/locales/ja.json'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import { until } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import { createProject, ensureDefaultModel, waitRendererReady } from '../../harness/seed'
import {
  projectEditPane,
  sessionConfigPane,
  sidebarPane,
  toolPickerPane,
  type ExtItemShot,
  type KnowledgeItemShot,
  type ProjectEditPane,
  type SessionConfigPane,
  type SidebarPane,
  type ToolPickerPane
} from '../../harness/pages'

/** 用户库（用例之间共享；KB-E-3 / 4 各自再现建一个） */
const BASE_A = 'kb-alpha'
const BASE_B = 'kb-beta'
/** 项目组头按名字认（pages.ts 的 GroupTarget），名字须全局唯一 */
const P1_NAME = 'KB-项目一'
const P2_NAME = 'KB-项目二'
/** 留给 KB-E-9 的「从没保存过知识库」的项目 —— P1 / P2 被 KB-E-5 / KB-E-6 写过了 */
const P3_NAME = 'KB-项目三'

/**
 * 卡片说明气泡里的两句话（三语全收）—— 隔离实例跟系统语言走，断言比的是「是哪一句」而不是哪门语言。
 * `sessionConfig.knowledgeDefault` = 还没选过（一个都没勾）；`knowledgeDesc` = 已明确设过。
 * 2026-09-17 起这两句只在悬浮 / 聚焦标题旁的问号时才在 DOM 里（见 pages.ts 的 SECTION_HINT）。
 */
const HINT_DEFAULT = [en, zh, ja].map((l) => l.sessionConfig.knowledgeDefault)
const HINT_EXPLICIT = [en, zh, ja].map((l) => l.sessionConfig.knowledgeDesc)

/** 内置库的人读名（同上，三语全收）—— 侧栏行、候选项的 label 与配置卡 / 选择器上的名字读的是同一个键 */
const BUILTIN_NAMES = [en, zh, ja].map((l) => l.knowledge.builtinBaseName)
/**
 * 内置库的那行说明（三语全收）—— 配置卡与选择器里它与内置 MCP / 技能同一个画法：内置记号 + 界面语言的
 * 名字（标识名 `shuvix` 小字并排），说明也走界面语言（chat-protocol builtinKnowledgeCopy）
 */
const BUILTIN_HINTS = [en, zh, ja].map((l) => l.knowledge.builtinBase)

interface InitResult {
  success: boolean
  created: boolean
}

interface BaseOptions {
  options: { name: string; label: string }[]
  selected: string[]
  explicit: boolean
}

let app: E2EApp
let sidebar: SidebarPane
let sessionConfig: SessionConfigPane
let projectEdit: ProjectEditPane
let picker: ToolPickerPane
let p1 = ''
let p2 = ''
let p3 = ''

// ─── IPC 助手 ───

const createSession = (opts: {
  title: string
  projectId?: string
  parentId?: string
}): Promise<string> =>
  app.main.eval<string>(`window.api.session.create(${JSON.stringify(opts)}).then((s) => s.id)`)

/** 会话设置里的知识库原值（键不在时为 undefined —— 「恒不写键」断的正是这一点） */
const storedBases = (sid: string): Promise<unknown> =>
  app.main.eval(
    `window.api.session.getById(${JSON.stringify(sid)}).then((s) => (s && s.settings ? s.settings.knowledgeBases : undefined))`
  )

const baseOptions = (sid?: string): Promise<BaseOptions> =>
  app.main.eval<BaseOptions>(
    `window.api.knowledge.baseOptions(${JSON.stringify(sid ? { sessionId: sid } : {})})`
  )

const createBase = (name: string): Promise<{ success: boolean; error?: string }> =>
  app.main.eval(`window.api.knowledge.createBase(${JSON.stringify({ name })})`)

const writeBases = (sid: string, knowledgeBases: string[]): Promise<{ success: boolean }> =>
  app.main.eval(
    `window.api.session.updateKnowledgeBases(${JSON.stringify({ id: sid, knowledgeBases })})`
  )

const writeTools = (sid: string, enabledTools: string[]): Promise<{ success: boolean }> =>
  app.main.eval(
    `window.api.session.updateEnabledTools(${JSON.stringify({ id: sid, enabledTools })})`
  )

/** 会话设置里的扩展能力勾选原值 */
const storedTools = (sid: string): Promise<unknown> =>
  app.main.eval(
    `window.api.session.getById(${JSON.stringify(sid)}).then((s) => (s && s.settings ? s.settings.enabledTools : undefined))`
  )

const init = (sid: string): Promise<InitResult> =>
  app.main.eval<InitResult>(`window.api.agent.init({ sessionId: ${JSON.stringify(sid)} })`)

/** 懒建运行时（不请求 LLM）并回快照 */
const ensureRuntime = (sid: string): Promise<{ systemPrompt: string } | null> =>
  app.main.eval(`window.api.agent.getInfo(${JSON.stringify(sid)}, { ensure: true })`)

/** 只读此刻运行时的快照，不创建（没有运行时为 null） */
const runtimeInfo = (sid: string): Promise<{ systemPrompt: string } | null> =>
  app.main.eval(`window.api.agent.getInfo(${JSON.stringify(sid)})`)

/** 项目保存过的知识库（从没保存过为 undefined） */
const projectBases = (id: string): Promise<unknown> =>
  app.main.eval(
    `window.api.project.getById(${JSON.stringify(id)}).then((p) => (p && p.settings ? p.settings.knowledgeBases : undefined))`
  )

const saveProjectBases = (id: string, knowledgeBases: string[]): Promise<unknown> =>
  app.main.eval(`window.api.project.update(${JSON.stringify({ id, knowledgeBases })})`)

const sameList = (actual: unknown, expected: string[]): boolean =>
  JSON.stringify(actual) === JSON.stringify(expected)

const waitRow = (title: string): Promise<boolean> =>
  until(async () => (await sidebar.titles()).includes(title), `sidebar row "${title}"`)

const kbItem = (items: KnowledgeItemShot[], name: string): KnowledgeItemShot | undefined =>
  items.find((it) => it.name === name)

function projectDir(name: string): string {
  const dir = join(app.home, name)
  mkdirSync(dir, { recursive: true })
  return dir
}

beforeAll(async () => {
  app = await launchApp()
  await ensureDefaultModel(app.main)
  await waitRendererReady(app.main)
  sidebar = sidebarPane(app.main)
  sessionConfig = sessionConfigPane(app.main)
  projectEdit = projectEditPane(app.main)
  picker = toolPickerPane(app.main)

  // 隔离实例默认一个用户库都没有 —— 库就是 ~/.shuvix/knowledge 下的一个目录
  expect(await createBase(BASE_A)).toMatchObject({ success: true })
  mkdirSync(join(app.home, '.shuvix', 'knowledge', BASE_B), { recursive: true })

  p1 = (await createProject(app.main, { name: P1_NAME, path: projectDir('kb-p1') })).id
  p2 = (await createProject(app.main, { name: P2_NAME, path: projectDir('kb-p2') })).id
  p3 = (await createProject(app.main, { name: P3_NAME, path: projectDir('kb-p3') })).id
  // 前置自检：三个项目都从没保存过知识库
  expect(await projectBases(p1)).toBeUndefined()
  expect(await projectBases(p2)).toBeUndefined()
  expect(await projectBases(p3)).toBeUndefined()
}, 120_000)

afterAll(async () => {
  await app?.stop()
})

describe('恒不写键、缺省一个都不勾（IPC）', () => {
  it('KB-E-1 无项目 / 项目 / 子会话三种会话都不写键；baseOptions 候选照列、一个没勾、explicit 为假', async () => {
    const parent = await createSession({ title: 'KB-E1-父', projectId: p1 })
    const cases: Array<[string, string]> = [
      ['无项目', await createSession({ title: 'KB-E1-无项目' })],
      ['项目会话', await createSession({ title: 'KB-E1-项目', projectId: p1 })],
      ['子会话', await createSession({ title: 'KB-E1-子', parentId: parent })]
    ]

    for (const [label, sid] of cases) {
      // 与扩展能力「恒写键」正面对照：这里写了键，缺省就被冻成快照
      expect(await storedBases(sid), label).toBeUndefined()
    }

    // 候选与选择里都没有 `project`（项目会话里它隐式启用，不归选择管）；
    // 随应用发布的内置库 `shuvix` 垫底 —— 它总在（开发期就是仓库里的 resources/knowledge）
    const [, noProject] = cases[0]
    const opts0 = await baseOptions(noProject)
    expect(opts0.options.map((o) => o.name)).toEqual([BASE_A, BASE_B, 'shuvix'])
    expect(opts0.options.slice(0, 2)).toEqual([
      { name: BASE_A, label: BASE_A },
      { name: BASE_B, label: BASE_B }
    ])
    // 内置库的人读名按界面语言取（隔离实例跟系统语言走），名字本身在三语里各一份
    expect(BUILTIN_NAMES).toContain(opts0.options[2].label)
    // 缺省一个都不启用：库都在、候选都列，但范围得用户自己圈（内置的说明书也不例外）
    expect(opts0.selected).toEqual([])
    expect(opts0.explicit).toBe(false)

    // 项目会话与子会话：候选一模一样 —— 不多出项目库那一项，同样一个都没勾
    for (const [label, sid] of cases.slice(1)) {
      const opts = await baseOptions(sid)
      expect(
        opts.options.map((o) => o.name),
        label
      ).toEqual([BASE_A, BASE_B, 'shuvix'])
      expect(opts.selected, label).toEqual([])
      expect(opts.explicit, label).toBe(false)
    }
    // 不传会话（项目对话框口径）同样没有它
    expect((await baseOptions()).options.map((o) => o.name)).toEqual([BASE_A, BASE_B, 'shuvix'])
  })
})

describe('不上锁（IPC）', () => {
  it('KB-E-2 运行时存在时知识库照样写得进去，同一时刻扩展能力也写得进去（后者当场重配运行时）', async () => {
    const sid = await createSession({ title: 'KB-E2', projectId: p1 })
    await ensureRuntime(sid)
    expect((await init(sid)).created).toBe(true)

    // 知识库不进工具表 —— 运行时存在也接受，下一次 knowledge 调用就作数
    expect(await writeBases(sid, [BASE_A])).toEqual({ success: true })
    expect(await storedBases(sid)).toEqual([BASE_A])
    // 同一时刻的对照：扩展能力烤进了 pi 的工具表，写入口当场重配运行时（2026-10-26 起；此前直接拒）。
    // 查无此服务器也照收：勾选是原值，可用性只在解析时过滤（技能不在勾选里，2026-10-28 起写 `skill:` 会被滤掉）
    expect(await writeTools(sid, ['mcp:nope'])).toEqual({ success: true })
    expect(await storedTools(sid)).toEqual(['mcp:nope'])
    expect((await init(sid)).created).toBe(true)
  })
})

describe('新建的库立刻进候选，围栏随运行时定型（IPC）', () => {
  it('KB-E-3 没设过的会话立刻多出这一项候选（但不自动勾上）；已存在运行时的系统提示词逐字节不变', async () => {
    const fresh = 'kb-live-ipc'
    const sid = await createSession({ title: 'KB-E3', projectId: p1 })
    const before = await ensureRuntime(sid)
    expect(before).not.toBeNull()
    expect(await storedBases(sid)).toBeUndefined()

    expect(await createBase(fresh)).toMatchObject({ success: true })

    // 候选每次现查：新建的库立刻在候选里（不用重开面板、不用重建会话）
    const opts = await baseOptions(sid)
    expect(opts.options.map((o) => o.name)).toContain(fresh)
    // 但**不自动勾上** —— 缺省是空的，新库进来只是多一个可勾的，不是多一个在用的
    expect(opts.selected).toEqual([])
    expect(opts.explicit).toBe(false)

    // 已接受的边界：围栏住在系统提示词里、创建 Agent 那一刻定型 —— 改选择刻意不失效运行时
    expect((await init(sid)).created).toBe(true)
    expect((await runtimeInfo(sid))!.systemPrompt).toBe(before!.systemPrompt)
  })
})

describe('会话设置卡与项目对话框（DOM）', () => {
  // 会话设置与项目编辑两个弹窗共用同一个形状锚点（都是「有 input 的 .dialog-panel」），
  // 一条用例失败时留在屏上的那一块会被下一条读成自己的 —— 失败点因此跑到隔壁用例去。
  // 每条之后收干净，让失败只连累它自己。
  afterEach(async () => {
    for (let i = 0; i < 3 && (await sessionConfig.isOpen()); i += 1) {
      await sessionConfig.close()
    }
  })

  it('KB-E-4 没设过时一个都没勾、说明是缺省那一句；有运行时也点得动（扩展能力那两行同样可点）；面板开着新建的库跟着长出来', async () => {
    const title = 'KB-E4-卡片'
    const live = 'kb-live-dom'
    const sid = await createSession({ title, projectId: p2 })
    // 先把运行时建出来：知识库一行与 MCP / Skills 两行都在同一张卡上，有运行时都可点
    await ensureRuntime(sid)
    expect((await init(sid)).created).toBe(true)

    await waitRow(title)
    expect(await sidebar.openSession(title)).toBe(true)
    await sidebar.pickRowMenu(title, 'session-config')
    await sessionConfig.waitOpen()
    expect(await sessionConfig.titleValue()).toBe(title)

    // ① 没设过：候选一个都没勾，但这张卡**不随运行时上锁**（可点，只是没勾）
    const items = await until(async () => {
      const shot = await sessionConfig.knowledgeItems()
      return shot.length >= 3 ? shot : null
    }, 'knowledge bases listed')
    for (const name of [BASE_A, BASE_B]) {
      expect(kbItem(items, name), name).toMatchObject({ checked: false, disabled: false })
    }
    // 项目会话也没有项目库那个 chip：它隐式启用，不是勾不勾的事
    expect(kbItem(items, 'project')).toBeUndefined()
    expect(HINT_DEFAULT).toContain(await sessionConfig.knowledgeHint())

    // 同一张卡上的 MCP / Skills 两行：有运行时也可点（改了当场重配，2026-10-26 起不再只读）
    const ext = await until(async () => {
      const shot = await sessionConfig.extItems()
      return shot.length > 0 ? shot : null
    }, 'extension items listed')
    expect(ext.every((it: ExtItemShot) => !it.disabled)).toBe(true)

    // ② 点一下某个 chip：立刻落库（没有锁、不用等关停），说明换成「已明确设过」那一句。
    // 一个都没勾，所以这一下是**勾上**，写下的就是这一个
    await sessionConfig.toggleKnowledgeBase(BASE_B)
    await until(
      async () => sameList(await storedBases(sid), [BASE_B]),
      `the card wrote the session selection ${JSON.stringify([BASE_B])}`
    )
    await until(
      async () => HINT_EXPLICIT.includes(await sessionConfig.knowledgeHint()),
      'the hint switched to the explicit sentence'
    )

    // ③ 面板开着的时候就地建一个库（侧栏的「新建知识库」走同一条路）→ 候选跟着长出来
    expect(await createBase(live)).toMatchObject({ success: true })
    await until(
      async () => !!kbItem(await sessionConfig.knowledgeItems(), live),
      'the new base showed up without reopening the panel'
    )
    // 已经明确设过了，新库只进候选、不自动勾上
    expect(kbItem(await sessionConfig.knowledgeItems(), live)).toMatchObject({ checked: false })
    await sessionConfig.close()
  })

  it('KB-E-5 项目对话框：从没保存过就一个都不勾；直接保存不写键；动过一下再保存写下整份', async () => {
    const openProject = async (name: string): Promise<KnowledgeItemShot[]> => {
      await sidebar.pickGroupMenu({ project: name }, 'edit-project')
      await projectEdit.waitOpen()
      expect(await projectEdit.nameValue()).toBe(name)
      return until(async () => {
        const items = await projectEdit.knowledgeItems()
        return items.length >= 3 ? items : null
      }, `project "${name}": knowledge bases listed`)
    }

    // ① 从没保存过 → 卡里一个都不勾（缺省本身就是空的，不是「还没读到」）；没有项目库那个 chip
    const items = await openProject(P1_NAME)
    for (const it of items) expect(it, it.name).toMatchObject({ checked: false, disabled: false })
    expect(kbItem(items, 'project')).toBeUndefined()

    // ② 不动知识库直接保存：这个键不写 —— 「打开看看就关掉」不该替这个项目做选择
    await projectEdit.save()
    expect(await projectBases(p1)).toBeUndefined()

    // ③ 再打开、动一下再保存：写下的是动过之后的整份（这里就是刚勾上的那一个）
    const again = await openProject(P1_NAME)
    const picked = again[0].name
    await projectEdit.toggleKnowledgeBase(picked)
    await projectEdit.save()
    await until(async () => Array.isArray(await projectBases(p1)), 'P1 saved its knowledge bases')
    expect(await projectBases(p1)).toEqual([picked])
  })

  it('KB-E-6 项目缺省流向新会话：会话卡勾的正是项目留下的那一个，脚注是「已明确设过」', async () => {
    await saveProjectBases(p2, [BASE_A])
    expect(await projectBases(p2)).toEqual([BASE_A])

    const title = 'KB-E6-继承'
    const sid = await createSession({ title, projectId: p2 })
    // 继承不是复制：会话行里仍然没有这个键，读的时候才回落到项目那份
    expect(await storedBases(sid)).toBeUndefined()
    expect(await baseOptions(sid)).toMatchObject({ selected: [BASE_A], explicit: true })

    await waitRow(title)
    expect(await sidebar.openSession(title)).toBe(true)
    await sidebar.pickRowMenu(title, 'session-config')
    await sessionConfig.waitOpen()
    expect(await sessionConfig.titleValue()).toBe(title)

    const items = await until(async () => {
      const shot = await sessionConfig.knowledgeItems()
      return shot.length >= 3 ? shot : null
    }, 'knowledge bases listed')
    expect(kbItem(items, BASE_A)).toMatchObject({ checked: true })
    for (const it of items.filter((i) => i.name !== BASE_A)) {
      expect(it, it.name).toMatchObject({ checked: false })
    }
    // 项目设过 = 有人明确设过：界面上不该再说「还没选过」
    expect(HINT_EXPLICIT).toContain(await sessionConfig.knowledgeHint())
    await sessionConfig.close()
  })

  it('KB-E-7 内置库的 chip 与内置 MCP / 技能同一个画法（内置记号 + 界面语言的名字、标识名 `shuvix` 并排，悬停是界面语言的说明）；有运行时也点得动', async () => {
    const title = 'KB-E7-内置'
    const sid = await createSession({ title, projectId: p1 })
    // 先把运行时建出来 —— 这张卡刻意不随运行时上锁，内置库这一项也不例外
    await ensureRuntime(sid)
    expect((await init(sid)).created).toBe(true)

    await waitRow(title)
    expect(await sidebar.openSession(title)).toBe(true)
    await sidebar.pickRowMenu(title, 'session-config')
    await sessionConfig.waitOpen()

    const items = await until(async () => {
      const shot = await sessionConfig.knowledgeItems()
      return kbItem(shot, 'shuvix') ? shot : null
    }, 'the builtin base chip is listed')
    const builtin = kbItem(items, 'shuvix')!

    // 存的名字是保留名（写回去的就是它）；chip 上是内置记号 + 界面语言的名字（与侧栏那一行同一个
    // 键），保留名小字并排；说明是界面语言的那一句
    expect(builtin).toMatchObject({ name: 'shuvix', identifier: 'shuvix', builtin: true })
    expect(BUILTIN_NAMES).toContain(builtin.label)
    expect(BUILTIN_HINTS).toContain(builtin.hint)
    expect(kbItem(items, BASE_A)).toMatchObject({ label: BASE_A, identifier: '', builtin: false })
    // 可点：只读的是**库的内容**，不是「这条会话用不用它」
    expect(builtin).toMatchObject({ disabled: false })
    // 垫底：它是说明书，不是用户的内容
    expect(items[items.length - 1].name).toBe('shuvix')
    await sessionConfig.close()
  })

  it('KB-E-8 勾上 `shuvix` 并落库；再取消恢复成空', async () => {
    const title = 'KB-E8-取消内置'
    const sid = await createSession({ title, projectId: p1 })
    expect(await storedBases(sid)).toBeUndefined()

    await waitRow(title)
    expect(await sidebar.openSession(title)).toBe(true)
    await sidebar.pickRowMenu(title, 'session-config')
    await sessionConfig.waitOpen()

    const items = await until(async () => {
      const shot = await sessionConfig.knowledgeItems()
      return kbItem(shot, 'shuvix') ? shot : null
    }, 'the builtin base chip is listed')
    expect(kbItem(items, 'shuvix')).toMatchObject({ checked: false })

    // 期望值从**此刻生效的选择**推，不从 chip 的 DOM 顺序推：卡片写的是「selected 去掉/追加一个」。
    // 这条会话所在的项目可能被前面的用例保存过一份，所以 before 未必是空的
    const before = (await baseOptions(sid)).selected
    expect(before).not.toContain('shuvix')
    const withBuiltin = [...before, 'shuvix']

    await sessionConfig.toggleKnowledgeBase('shuvix')
    await until(
      async () => sameList(await storedBases(sid), withBuiltin),
      `the card wrote ${JSON.stringify(withBuiltin)}`
    )
    // 工具面跟着变宽：勾上之后它就是这条会话的库
    expect((await baseOptions(sid)).selected).toContain('shuvix')

    // 再取消：回到勾之前那一份（这时候是这条会话自己的明确选择，不再回落）
    await sessionConfig.toggleKnowledgeBase('shuvix')
    await until(
      async () => sameList(await storedBases(sid), before),
      `the card restored ${JSON.stringify(before)}`
    )
    expect((await baseOptions(sid)).selected).not.toContain('shuvix')
    await sessionConfig.close()
  })

  it('KB-E-9 项目对话框：从没保存过时 `shuvix` 在候选里、没勾且垫底；勾上再保存，写下的整份里有它', async () => {
    // 前置自检：P3 是唯一一个从没保存过知识库的项目（P1 / P2 被 KB-E-5 / KB-E-6 写过了）
    expect(await projectBases(p3)).toBeUndefined()

    await sidebar.pickGroupMenu({ project: P3_NAME }, 'edit-project')
    await projectEdit.waitOpen()
    expect(await projectEdit.nameValue()).toBe(P3_NAME)

    const items = await until(async () => {
      const shot = await projectEdit.knowledgeItems()
      return kbItem(shot, 'shuvix') ? shot : null
    }, 'project dialog: the builtin base chip is listed')

    // 项目对话框配的是「这个项目的新会话用哪些」—— 内置库是候选里的最后一项，缺省同样不勾
    expect(kbItem(items, 'shuvix')).toMatchObject({ checked: false, disabled: false })
    expect(items[items.length - 1].name).toBe('shuvix')
    expect(kbItem(items, 'project')).toBeUndefined()

    // 勾上它再保存：写下的是动过之后的**整份**（不是只写差集）
    await projectEdit.toggleKnowledgeBase('shuvix')
    await projectEdit.save()
    await until(async () => Array.isArray(await projectBases(p3)), 'P3 saved its knowledge bases')
    expect(await projectBases(p3)).toEqual(['shuvix'])
  })

  it('KB-E-10 存量选择里残留的 `project`：读时剔掉（explicit 照算）、卡上没有那个 chip；再勾一个，写回去的整份里也没有它', async () => {
    const title = 'KB-E10-存量'
    const sid = await createSession({ title, projectId: p1 })
    // 隐式项目库之前写下的那种选择：project 夹在用户库前面
    expect(await writeBases(sid, ['project', BASE_A])).toEqual({ success: true })
    expect(await storedBases(sid)).toEqual(['project', BASE_A])
    expect(await baseOptions(sid)).toMatchObject({ selected: [BASE_A], explicit: true })

    await waitRow(title)
    expect(await sidebar.openSession(title)).toBe(true)
    await sidebar.pickRowMenu(title, 'session-config')
    await sessionConfig.waitOpen()
    expect(await sessionConfig.titleValue()).toBe(title)

    const items = await until(async () => {
      const shot = await sessionConfig.knowledgeItems()
      return kbItem(shot, BASE_B) ? shot : null
    }, 'knowledge bases listed')
    expect(kbItem(items, 'project')).toBeUndefined()
    expect(kbItem(items, BASE_A)).toMatchObject({ checked: true })
    expect(kbItem(items, BASE_B)).toMatchObject({ checked: false })

    // 卡片写的是「此刻生效的选择 + 刚勾的那一个」—— 残留的 project 不会被写回去
    await sessionConfig.toggleKnowledgeBase(BASE_B)
    await until(
      async () => sameList(await storedBases(sid), [BASE_A, BASE_B]),
      `the card wrote ${JSON.stringify([BASE_A, BASE_B])}`
    )
    await sessionConfig.close()
  })
})

describe('输入框的工具选择器（DOM）', () => {
  afterEach(async () => {
    await picker.close()
    for (let i = 0; i < 3 && (await sessionConfig.isOpen()); i += 1) {
      await sessionConfig.close()
    }
  })

  it('KB-E-11 知识库一组与配置卡同一份数据：有运行时也点得动、立刻落库；别处改了计数跟着变，配置卡看到的是同一份', async () => {
    const title = 'KB-E11-选择器'
    const sid = await createSession({ title })
    // 运行时先建出来：MCP / Skill 行与知识库一组都照样可点
    await ensureRuntime(sid)
    expect((await init(sid)).created).toBe(true)

    await waitRow(title)
    expect(await sidebar.openSession(title)).toBe(true)
    await until(async () => (await picker.knowledgeCount()) === 0, 'picker present, no base ticked')

    await picker.open()
    const items = await until(async () => {
      const shot = await picker.knowledgeItems()
      return kbItem(shot, BASE_B) ? shot : null
    }, 'knowledge bases listed in the picker')
    for (const name of [BASE_A, BASE_B, 'shuvix']) {
      expect(kbItem(items, name), name).toMatchObject({ checked: false, disabled: false })
    }
    expect(kbItem(items, 'shuvix')).toMatchObject({ identifier: 'shuvix', builtin: true })
    expect(BUILTIN_NAMES).toContain(kbItem(items, 'shuvix')?.label)
    expect(BUILTIN_HINTS).toContain(kbItem(items, 'shuvix')?.hint)
    expect(kbItem(items, BASE_A)).toMatchObject({ builtin: false, hint: '' })
    expect((await picker.items()).every((it) => !it.disabled)).toBe(true)

    // 勾一下：立刻落库（没有锁），触发钮上的计数跟着变
    await picker.toggleKnowledgeBase(BASE_A)
    await until(
      async () => sameList(await storedBases(sid), [BASE_A]),
      'the picker wrote the selection'
    )
    await until(async () => (await picker.knowledgeCount()) === 1, 'picker count 1')
    await picker.close()

    // 别处改了（同一个写入口）→ 选择器重取，计数跟着变
    expect(await writeBases(sid, [BASE_A, BASE_B])).toEqual({ success: true })
    await until(
      async () => (await picker.knowledgeCount()) === 2,
      'picker followed an outside change'
    )

    // 配置卡读到的是同一份；在卡上取消一个，选择器也跟着变
    await sidebar.pickRowMenu(title, 'session-config')
    await sessionConfig.waitOpen()
    const card = await until(async () => {
      const shot = await sessionConfig.knowledgeItems()
      return kbItem(shot, BASE_B) ? shot : null
    }, 'knowledge bases listed in the card')
    expect(kbItem(card, BASE_A)).toMatchObject({ checked: true })
    expect(kbItem(card, BASE_B)).toMatchObject({ checked: true })
    await sessionConfig.toggleKnowledgeBase(BASE_B)
    await until(
      async () => sameList(await storedBases(sid), [BASE_A]),
      'the card wrote the selection'
    )
    await sessionConfig.close()
    await until(async () => (await picker.knowledgeCount()) === 1, 'picker followed the card')
  })
})
