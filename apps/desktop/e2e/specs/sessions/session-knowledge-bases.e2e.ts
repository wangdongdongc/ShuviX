/**
 * 会话用哪几个知识库（`settings.knowledgeBases`）—— 与并排的扩展能力勾选
 * （session-extensions.e2e.ts）**处处相反**，所以这份 spec 处处拿它作对照：
 *
 *   - 扩展能力在 `create` 时**恒写键**（快照）；知识库**恒不写键** —— 它是一条活的回落链
 *     （会话 → 父会话 → 项目 → 缺省「全部用户库 +（属于项目时）项目库」），写键就等于把此刻的
 *     缺省冻住，以后新建的库再也进不来。
 *   - 扩展能力在运行时存在期间只读；知识库**不上锁** —— 它不进 pi 的工具表，是 `knowledge`
 *     工具每次调用时由宿主现查的。两张卡在同一个弹窗里，KB-E-4 一次断完这个对照。
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
import { createProject, waitRendererReady } from '../../harness/seed'
import {
  projectEditPane,
  sessionConfigPane,
  sidebarPane,
  type ExtItemShot,
  type KnowledgeItemShot,
  type ProjectEditPane,
  type SessionConfigPane,
  type SidebarPane
} from '../../harness/pages'

/** 用户库（用例之间共享；KB-E-3 / 4 各自再现建一个） */
const BASE_A = 'kb-alpha'
const BASE_B = 'kb-beta'
/** 项目组头按名字认（pages.ts 的 GroupTarget），名字须全局唯一 */
const P1_NAME = 'KB-项目一'
const P2_NAME = 'KB-项目二'

/**
 * 卡片脚注的两句话（三语全收）—— 隔离实例跟系统语言走，断言比的是「是哪一句」而不是哪门语言。
 * `sessionConfig.knowledgeDefault` = 还没选过（勾的是回落出来的缺省）；`knowledgeDesc` = 已明确设过。
 */
const FOOTER_DEFAULT = [en, zh, ja].map((l) => l.sessionConfig.knowledgeDefault)
const FOOTER_EXPLICIT = [en, zh, ja].map((l) => l.sessionConfig.knowledgeDesc)

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
let p1 = ''
let p2 = ''

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
  await waitRendererReady(app.main)
  sidebar = sidebarPane(app.main)
  sessionConfig = sessionConfigPane(app.main)
  projectEdit = projectEditPane(app.main)

  // 隔离实例默认一个用户库都没有 —— 库就是 ~/.shuvix/knowledge 下的一个目录
  expect(await createBase(BASE_A)).toMatchObject({ success: true })
  mkdirSync(join(app.home, '.shuvix', 'knowledge', BASE_B), { recursive: true })

  p1 = (await createProject(app.main, { name: P1_NAME, path: projectDir('kb-p1') })).id
  p2 = (await createProject(app.main, { name: P2_NAME, path: projectDir('kb-p2') })).id
  // 前置自检：两个项目都从没保存过知识库
  expect(await projectBases(p1)).toBeUndefined()
  expect(await projectBases(p2)).toBeUndefined()
}, 120_000)

afterAll(async () => {
  await app?.stop()
})

describe('恒不写键、缺省全勾（IPC）', () => {
  it('KB-E-1 无项目 / 项目 / 子会话三种会话都不写键；baseOptions 回缺省全勾、explicit 为假', async () => {
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

    // 不属于项目的会话：候选与选择里都没有 `project`（那是一个它解析不出来的名字）
    const [, noProject] = cases[0]
    expect(await baseOptions(noProject)).toEqual({
      options: [
        { name: BASE_A, label: BASE_A },
        { name: BASE_B, label: BASE_B }
      ],
      selected: [BASE_A, BASE_B],
      explicit: false
    })

    // 项目会话与子会话：缺省 = 全部用户库 + 项目库（项目库排在后面）
    for (const [label, sid] of cases.slice(1)) {
      const opts = await baseOptions(sid)
      expect(opts.selected, label).toEqual([BASE_A, BASE_B, 'project'])
      expect(opts.explicit, label).toBe(false)
      expect(opts.options.find((o) => o.name === 'project')?.label, label).toBe(P1_NAME)
    }
  })
})

describe('不上锁（IPC）', () => {
  it('KB-E-2 运行时存在时知识库照样写得进去，同一时刻扩展能力被拒', async () => {
    const sid = await createSession({ title: 'KB-E2', projectId: p1 })
    await ensureRuntime(sid)
    expect((await init(sid)).created).toBe(true)

    // 知识库不进工具表 —— 运行时存在也接受，下一次 knowledge 调用就作数
    expect(await writeBases(sid, [BASE_A])).toEqual({ success: true })
    expect(await storedBases(sid)).toEqual([BASE_A])
    // 同一时刻的对照：扩展能力烤进了 pi 的工具表，运行期换不了，所以写入口直接拒
    expect(await writeTools(sid, ['skill:nope'])).toEqual({ success: false })
  })
})

describe('新建的库立刻可见，围栏随运行时定型（IPC）', () => {
  it('KB-E-3 没设过的会话立刻多出这一项；已存在运行时的系统提示词逐字节不变', async () => {
    const fresh = 'kb-live-ipc'
    const sid = await createSession({ title: 'KB-E3', projectId: p1 })
    const before = await ensureRuntime(sid)
    expect(before).not.toBeNull()
    expect(await storedBases(sid)).toBeUndefined()

    expect(await createBase(fresh)).toMatchObject({ success: true })

    // 工具面每次调用现查：没设过的会话跟着缺省走，新库立刻在里面
    const opts = await baseOptions(sid)
    expect(opts.selected).toContain(fresh)
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

  it('KB-E-4 没设过时全勾、脚注是缺省那一句；有运行时也点得动（扩展能力卡同时只读）；面板开着新建的库跟着长出来', async () => {
    const title = 'KB-E4-卡片'
    const live = 'kb-live-dom'
    const sid = await createSession({ title, projectId: p2 })
    // 先把运行时建出来：这条会话的扩展能力卡因此只读，两张卡的对照就在同一个弹窗里
    await ensureRuntime(sid)
    expect((await init(sid)).created).toBe(true)

    await waitRow(title)
    expect(await sidebar.openSession(title)).toBe(true)
    await sidebar.pickRowMenu(title, 'session-config')
    await sessionConfig.waitOpen()
    expect(await sessionConfig.titleValue()).toBe(title)

    // ① 没设过：候选全勾，且这张卡**不随运行时上锁**
    const items = await until(async () => {
      const shot = await sessionConfig.knowledgeItems()
      return shot.length >= 3 ? shot : null
    }, 'knowledge bases listed')
    for (const name of [BASE_A, BASE_B, 'project']) {
      expect(kbItem(items, name), name).toMatchObject({ checked: true, disabled: false })
    }
    expect(FOOTER_DEFAULT).toContain(await sessionConfig.knowledgeFooter())

    // 同一个弹窗里的扩展能力卡：有运行时 → 只读（两者的语义差别就在这一屏上）
    const ext = await until(async () => {
      const shot = await sessionConfig.extItems()
      return shot.length > 0 ? shot : null
    }, 'extension items listed')
    expect(ext.every((it: ExtItemShot) => it.disabled)).toBe(true)

    // ② 点一下某个 chip：立刻落库（没有锁、不用等关停），脚注换成「已明确设过」那一句
    // 写下的是「界面此刻勾着的那一份减去这一个」—— 缺省是活的，前面的用例可能已经建过别的库
    const afterToggle = items.filter((it) => it.name !== BASE_B).map((it) => it.name)
    await sessionConfig.toggleKnowledgeBase(BASE_B)
    await until(
      async () => sameList(await storedBases(sid), afterToggle),
      `the card wrote the session selection ${JSON.stringify(afterToggle)}`
    )
    await until(
      async () => FOOTER_EXPLICIT.includes(await sessionConfig.knowledgeFooter()),
      'footer switched to the explicit sentence'
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

  it('KB-E-5 项目对话框：从没保存过就全勾；直接保存不写键；动过一下再保存写下整份', async () => {
    const openProject = async (name: string): Promise<KnowledgeItemShot[]> => {
      await sidebar.pickGroupMenu({ project: name }, 'edit-project')
      await projectEdit.waitOpen()
      expect(await projectEdit.nameValue()).toBe(name)
      return until(async () => {
        const items = await projectEdit.knowledgeItems()
        return items.length >= 3 ? items : null
      }, `project "${name}": knowledge bases listed`)
    }

    // ① 从没保存过 → 卡里全勾（勾的是缺省，不是保存过的东西）
    const items = await openProject(P1_NAME)
    for (const it of items) expect(it, it.name).toMatchObject({ checked: true, disabled: false })

    // ② 不动知识库直接保存：这个键不写 —— 「打开看看就关掉」不该把缺省冻成快照
    await projectEdit.save()
    expect(await projectBases(p1)).toBeUndefined()

    // ③ 再打开、动一下再保存：写下的是动过之后的整份
    const again = await openProject(P1_NAME)
    const dropped = again[0].name
    await projectEdit.toggleKnowledgeBase(dropped)
    await projectEdit.save()
    await until(async () => Array.isArray(await projectBases(p1)), 'P1 saved its knowledge bases')
    expect(await projectBases(p1)).toEqual(again.slice(1).map((it) => it.name))
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
    expect(FOOTER_EXPLICIT).toContain(await sessionConfig.knowledgeFooter())
    await sessionConfig.close()
  })
})
