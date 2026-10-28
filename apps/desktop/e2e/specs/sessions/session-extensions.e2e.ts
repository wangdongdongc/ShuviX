/**
 * 会话的扩展能力勾选（`settings.enabledTools`：`mcp:` 加一台，`-mcp:` 取消档案声明的一台）—— 新建会话时
 * 定下、创建根 Agent 时读，**运行时存在期间改了当场重配那个 agent**（2026-10-26，取代 2026-10-02 的
 * 「运行期只读」）：同一个运行时（没有 agent_created / agent_closing），MCP 工具从下一次请求起换掉。
 *
 * **技能不按会话勾选**（2026-10-28，按 Claude Code / Codex 的主流用法）：侧栏里启用着的技能全部上每个带
 * `skill` 工具的 agent 的货架，货架与跟着它的人设（作图说明）在创建 agent 时定下、之后侧栏的开关不跟；
 * tools.list、选择器、会话设置卡、项目设置里都没有技能条目，写入口与项目继承都把旧的 `skill:` /
 * `-skill:` 条目滤掉（EXT-E-6 ④ / 8 / 9 / 10）。
 *
 * 链路：sessionService.create（继承）→ agent.init（原值 + created）→ 运行时的锁建出 agent →
 * 写入口 `session.updateEnabledTools` → `sessionService.reconfigureAgent` → 锁的重配；界面改之前先问
 * `agent.previewChange`，缓存保不住才弹确认框（cacheBreakPane）。这份 spec 全程没有模型回复，预判恒为
 * `none`（没有可失去的缓存）—— 所以两处入口有 agent 也一个确认框都不弹；弹框那条路在
 * session-live-reconfigure.e2e.ts。
 *
 * 断言优先走 IPC：`session.getById` 的原值、`agent.init`、`agent.getInfo` 里的工具表（`mcp__<server>__*`）、
 * skill 工具的描述与系统提示词（那是真正发给模型的东西）。DOM 只断两件事：有运行时两处入口照样可点、
 * 两处入口是同一份数据。
 *
 * 夹具：勾选的样本是两台进程内的内置 MCP（a = `mcp:database`、b = `mcp:browser`：配置里启用着，用到时
 * 在进程内连上，不碰网络）；两个真实可用的全局 skill（只用来断「启用着就在架」）；P1 从没保存过扩展能力，
 * P2 保存过 [a]。隔离实例里恒有一个内置、离线的 `mcp:tavily` —— 它也是「离线项不被抹掉」那条回归的现成
 * 样本。全程无 LLM：运行时靠 `agent.getInfo(sid, { ensure: true })` 懒建；需要消息的那条走
 * promptAndListMessages（容忍隔离实例无 API key 的失败）。
 *
 * 档案声明的项（缺省勾上、可以取消）不在这里断：内置档案里没有哪个声明了可勾的 MCP（`tab` 的 `mcp:chrome`
 * 不收会话勾选）。用户档案声明 MCP 的那条链由 database-session / browser-session 钉着，界面上的画法与取消
 * 记号由 chat-ui ToolPicker / app-shell ExtensionsSection 的 DOM 单测钉着。
 *
 * ⚠️ 不用 `location.reload()`：主进程的 will-navigate 守卫会取消它（见 seed.waitRendererReady）。
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { until } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import {
  createProject,
  ensureDefaultModel,
  eventRecorder,
  promptAndListMessages,
  seedSkill,
  waitRendererReady,
  type EventRecorder,
  type RecordedEvent
} from '../../harness/seed'
import {
  cacheBreakPane,
  projectEditPane,
  sessionConfigPane,
  sidebarPane,
  toolPickerPane,
  type CacheBreakPane,
  type ExtItemShot,
  type ProjectEditPane,
  type SessionConfigPane,
  type SidebarPane,
  type ToolPickerItem,
  type ToolPickerPane
} from '../../harness/pages'

/** 两个全局 skill：启用着就在每个带 skill 工具的 agent 的货架上，不用勾 */
const SKILL_A = 'e2e-ext-a'
const SKILL_B = 'e2e-ext-b'
/** 勾选的样本：两台进程内的内置 MCP（运行时里是 `mcp__database__*` / `mcp__browser__*`） */
const A = 'mcp:database'
const B = 'mcp:browser'
/** 内置、离线（隔离实例没有它的 API key）的 MCP —— 恒在工具列表里 */
const TAVILY = 'mcp:tavily'
/** 内置作图技能的全局名（skill 工具描述里是 `<name>builtin:drawing</name>`） */
const DRAWING_SKILL = 'builtin:drawing'
/** 旧的技能勾选 / 取消作图技能的记号：2026-10-28 起写入口与项目继承都不收 */
const OLD_SKILL_TICK = `skill:${SKILL_A}`
const OLD_NO_DRAWING = '-skill:builtin:drawing'
/** 系统提示里「先加载作图技能」那句指路的记号（三语一字不差） */
const DRAWING_POINTER = 'builtin:drawing'
/** 手艺段的范例围栏（技能不在架时整段手艺常驻，它就在提示里） */
const DRAWING_EXAMPLE = '```svg\n<svg'
/** 交互块那一段的记号（作图技能在架才教） */
const INTERACTIVE = '```interactive'
/** 项目组头按名字认（pages.ts 的 GroupTarget），名字须全局唯一 */
const P1_NAME = 'EXT-项目一'
const P2_NAME = 'EXT-项目二'
const P3_NAME = 'EXT-项目三'
/** EXT-E-6 ④ 的新项目：保存里混着旧的技能条目 */
const P4_NAME = 'EXT-项目四'

interface InitResult {
  success: boolean
  created: boolean
  enabledTools: string[]
}

interface RuntimeInfo {
  systemPrompt: string
  tools: Array<{ name: string; description: string }>
}

/** `tools.list(sid)` 里条目的形状（只取这一组断言要的字段） */
interface ListedTool {
  name: string
  group?: string
  declaredBy?: string
}

let app: E2EApp
let recorder: EventRecorder
let sidebar: SidebarPane
let picker: ToolPickerPane
let sessionConfig: SessionConfigPane
let projectEdit: ProjectEditPane
let cacheBreak: CacheBreakPane
let p1 = ''
let p2 = ''

// ─── IPC 助手 ───

const createSession = (opts: { title: string; projectId?: string }): Promise<string> =>
  app.main.eval<string>(`window.api.session.create(${JSON.stringify(opts)}).then((s) => s.id)`)

/** 会话设置里的勾选原值（键不在时为 undefined —— 「恒写键」断的正是这一点） */
const storedTools = (sid: string): Promise<unknown> =>
  app.main.eval(
    `window.api.session.getById(${JSON.stringify(sid)}).then((s) => (s && s.settings ? s.settings.enabledTools : undefined))`
  )

const init = (sid: string): Promise<InitResult> =>
  app.main.eval<InitResult>(`window.api.agent.init({ sessionId: ${JSON.stringify(sid)} })`)

const writeTools = (sid: string, enabledTools: string[]): Promise<{ success: boolean }> =>
  app.main.eval(
    `window.api.session.updateEnabledTools(${JSON.stringify({ id: sid, enabledTools })})`
  )

const saveProjectTools = (id: string, enabledTools: string[]): Promise<unknown> =>
  app.main.eval(`window.api.project.update(${JSON.stringify({ id, enabledTools })})`)

/** 项目保存过的扩展能力（从没保存过为 undefined） */
const projectTools = (id: string): Promise<unknown> =>
  app.main.eval(
    `window.api.project.getById(${JSON.stringify(id)}).then((p) => (p && p.settings ? p.settings.enabledTools : undefined))`
  )

/** 懒建运行时（不请求 LLM）并回快照 */
const ensureRuntime = (sid: string): Promise<RuntimeInfo | null> =>
  app.main.eval(`window.api.agent.getInfo(${JSON.stringify(sid)}, { ensure: true })`)

/** 只读此刻运行时的快照，不创建（没有运行时为 null） */
const runtimeInfo = (sid: string): Promise<RuntimeInfo | null> =>
  app.main.eval(`window.api.agent.getInfo(${JSON.stringify(sid)})`)

/** skill 工具发给模型的描述 —— 其中的 `<name>…</name>` 就是这一次创建真正带上的 skill */
const skillDescription = (info: RuntimeInfo | null): string =>
  info?.tools.find((t) => t.name === 'skill')?.description ?? ''

/** 运行时手里有没有某台 MCP（`mcp:<server>`）的工具（`mcp__<server>__*`） */
const carries = (info: RuntimeInfo | null, key: string): boolean =>
  (info?.tools ?? []).some((t) => t.name.startsWith(`mcp__${key.slice('mcp:'.length)}__`))

/** 选择器 / 会话设置的数据源：这条会话能勾的条目（内置工具 + MCP），档案声明的带 declaredBy */
const toolsList = (sid: string): Promise<ListedTool[]> =>
  app.main.eval<ListedTool[]>(`window.api.tools.list(${JSON.stringify(sid)})`)

/** 全局启用 / 停用一个技能（写 `~/.shuvix/skills/.config.json` 的 disabled） */
const setSkillEnabled = (name: string, isEnabled: boolean): Promise<unknown> =>
  app.main.eval(`window.api.skill.update(${JSON.stringify({ name, isEnabled })})`)

const sameList = (actual: unknown, expected: string[]): boolean =>
  JSON.stringify(actual) === JSON.stringify(expected)

const waitRow = (title: string): Promise<boolean> =>
  until(async () => (await sidebar.titles()).includes(title), `sidebar row "${title}"`)

/** 等本会话在 since 之后的 `agent_closing{closing:false}`（运行时关停完毕） */
async function waitClosed(sid: string, since: number): Promise<void> {
  let ev = await recorder.waitFor<RecordedEvent>('agent_closing', { sessionId: sid, since })
  while (ev.closing !== false) {
    ev = await recorder.waitFor<RecordedEvent>('agent_closing', { sessionId: sid })
  }
}

/** 本会话在 since 之后的运行时生灭事件 —— 重配不该有任何一条 */
async function lifecycleEventsSince(sid: string, since: number): Promise<string[]> {
  return (await recorder.allSince<RecordedEvent>(since))
    .filter(
      (e) => e.sessionId === sid && (e.type === 'agent_created' || e.type === 'agent_closing')
    )
    .map((e) => e.type)
}

const pickerItem = async (name: string): Promise<ToolPickerItem | undefined> =>
  (await picker.items()).find((it) => it.name === name)

const extItem = (items: ExtItemShot[], key: string): ExtItemShot | undefined =>
  items.find((it) => it.key === key)

function projectDir(name: string): string {
  const dir = join(app.home, name)
  mkdirSync(dir, { recursive: true })
  return dir
}

beforeAll(async () => {
  app = await launchApp()
  await ensureDefaultModel(app.main)
  await waitRendererReady(app.main)
  recorder = eventRecorder(app.main)
  await recorder.install()
  sidebar = sidebarPane(app.main)
  picker = toolPickerPane(app.main)
  sessionConfig = sessionConfigPane(app.main)
  projectEdit = projectEditPane(app.main)
  cacheBreak = cacheBreakPane(app.main)

  // 真实可用的 skill：启用着就在架（EXT-E-8 / 9 断它们不用勾也在 skill 工具的描述里）
  seedSkill(app, SKILL_A)
  seedSkill(app, SKILL_B)

  p1 = (await createProject(app.main, { name: P1_NAME, path: projectDir('ext-p1') })).id
  p2 = (await createProject(app.main, { name: P2_NAME, path: projectDir('ext-p2') })).id
  await saveProjectTools(p2, [A])
  // 前置自检：P1 真的从没保存过，P2 保存的就是 [a]
  expect(await projectTools(p1)).toBeUndefined()
  expect(await projectTools(p2)).toEqual([A])
}, 120_000)

afterAll(async () => {
  await app?.stop()
})

describe('勾选从哪来、运行期当场生效（IPC）', () => {
  it('EXT-E-1 新建时定下：无项目为 []；项目会话继承项目保存过的那份且是快照；继承不按可用性过滤', async () => {
    const s0 = await createSession({ title: 'EXT-E1-无项目' })
    const stored0 = await storedTools(s0)
    // 恒写键：空也是数组。缺键专指改制前的旧会话，会在首次解析时按项目「那时」的配置补上
    expect(Array.isArray(stored0)).toBe(true)
    expect(stored0).toEqual([])

    const s2 = await createSession({ title: 'EXT-E1-项目二', projectId: p2 })
    expect(await storedTools(s2)).toEqual([A])
    try {
      await saveProjectTools(p2, [B])
      // 已建的会话是快照：项目后来改了不波及它
      expect(await storedTools(s2)).toEqual([A])
      const s3 = await createSession({ title: 'EXT-E1-项目二-后建', projectId: p2 })
      expect(await storedTools(s3)).toEqual([B])
      const initS2 = await init(s2)
      expect(initS2.created).toBe(false)
      expect(initS2.enabledTools).toEqual([A])
    } finally {
      // 后面的用例（EXT-E-4 / 6）要的是 P2 = [a]
      await saveProjectTools(p2, [A])
    }

    // 继承不过滤的回归：tavily 此刻离线（MCP 的「可用」= 已连接），过滤后落库就是永久丢项
    const p3 = (await createProject(app.main, { name: P3_NAME, path: projectDir('ext-p3') })).id
    await saveProjectTools(p3, [TAVILY])
    const s4 = await createSession({ title: 'EXT-E1-项目三', projectId: p3 })
    expect(await storedTools(s4)).toEqual([TAVILY])
    expect((await init(s4)).enabledTools).toEqual([TAVILY])
  })
  it('EXT-E-2 运行时存在期间改勾选：写入照收（等重配落定才答）、同一个运行时当场换成新勾选；没有关停、没有重建', async () => {
    const s = await createSession({ title: 'EXT-E2', projectId: p1 })
    expect((await writeTools(s, [A])).success).toBe(true)

    // ① 建运行时：工具表里带的就是此刻的勾选
    const first = await ensureRuntime(s)
    expect(carries(first, A)).toBe(true)
    expect(carries(first, B)).toBe(false)
    expect((await init(s)).created).toBe(true)

    // ② 运行时存在：写入照收，答复之前重配已经落定（新勾的那台当场连上）—— 同一个运行时的工具表立刻换成 b
    const since = await recorder.mark()
    expect(await writeTools(s, [B])).toEqual({ success: true })
    expect(await storedTools(s)).toEqual([B])
    const now = await runtimeInfo(s)
    expect(carries(now, B)).toBe(true)
    expect(carries(now, A)).toBe(false)
    // init 锁着时报锁里记的勾选：就是刚写的那份
    const after = await init(s)
    expect(after.created).toBe(true)
    expect(after.enabledTools).toEqual([B])
    expect(await lifecycleEventsSince(s, since)).toEqual([])
  })
})

describe('输入框工具选择器与会话设置卡（DOM）', () => {
  it('EXT-E-3 输入框工具选择器：有运行时也照样可勾，不弹确认框（还没有模型回复，没有可失去的缓存），勾了就当场重配', async () => {
    const title = 'EXT-E3-选择器'
    const s = await createSession({ title, projectId: p1 })
    await waitRow(title)
    expect(await sidebar.openSession(title)).toBe(true)

    // ① 没有运行时：可勾，勾了就落库
    await until(() => picker.present(), 'tool picker present')
    await picker.open()
    await until(async () => (await pickerItem(A))?.disabled === false, 'mcp a listed, editable')
    expect(await picker.toggle(A)).toBe(true)
    await until(async () => sameList(await storedTools(s), [A]), 'picker wrote [a]')
    // 选择器里没有技能行（技能不按会话勾选）
    expect((await picker.items()).filter((it) => it.name.startsWith('skill'))).toEqual([])
    await picker.close()

    // ② 运行时建出来：整排照样可点，没有只读态
    await ensureRuntime(s)
    expect((await init(s)).created).toBe(true)
    const since = await recorder.mark()
    await picker.open()
    await until(async () => (await pickerItem(B))?.checked === false, 'mcp b listed, unticked')
    expect(await pickerItem(A)).toMatchObject({ checked: true, disabled: false })
    expect(await pickerItem(B)).toMatchObject({ checked: false, disabled: false })

    // ③ 勾 b：落库，同一个运行时当场带上 b；一个确认框都没弹（弹了的话不答就不会落库）
    expect(await picker.toggle(B)).toBe(true)
    await until(async () => sameList(await storedTools(s), [A, B]), 'picker wrote [a, b]')
    await until(async () => carries(await runtimeInfo(s), B), 'the running agent carries b')
    expect(carries(await runtimeInfo(s), A)).toBe(true)
    expect(await cacheBreak.count()).toBe(0)
    await until(async () => (await pickerItem(B))?.checked === true, 'picker shows b checked')
    expect((await init(s)).created).toBe(true)
    expect(await lifecycleEventsSince(s, since)).toEqual([])
    await picker.close()
  })

  it('EXT-E-4 会话设置弹窗：开在一条有运行时的非当前会话上也可勾、当场重配那一条；当前会话勾完，输入框选择器跟着变', async () => {
    const ACT = 'EXT-E4-当前'
    const OTH = 'EXT-E4-另一条'
    const sAct = await createSession({ title: ACT, projectId: p2 })
    const sOth = await createSession({ title: OTH, projectId: p2 })
    await waitRow(ACT)
    await waitRow(OTH)
    expect(await sidebar.openSession(ACT)).toBe(true)

    // ① 另一条会话有运行时：它的弹窗照样可勾，勾了落库、那一条的运行时当场带上
    await ensureRuntime(sOth)
    const since = await recorder.mark()
    await sidebar.pickRowMenu(OTH, 'session-config')
    await sessionConfig.waitOpen()
    expect(await sessionConfig.titleValue()).toBe(OTH)
    const other = await until(async () => {
      const items = await sessionConfig.extItems()
      return extItem(items, A) && extItem(items, B) ? items : null
    }, 'other session: extension items listed')
    expect(extItem(other, A)).toMatchObject({ checked: true, disabled: false, lockedLook: false })
    expect(extItem(other, B)).toMatchObject({ checked: false, disabled: false, lockedLook: false })
    expect(await sessionConfig.lockIndicatorCount()).toBe(0)
    await sessionConfig.toggleExt(B)
    await until(
      async () => sameList(await storedTools(sOth), [A, B]),
      'dialog wrote [a, b] for the other session'
    )
    await until(
      async () => carries(await runtimeInfo(sOth), B),
      "the other session's running agent carries b"
    )
    expect(await cacheBreak.count()).toBe(0)
    expect((await init(sOth)).created).toBe(true)
    expect(await lifecycleEventsSince(sOth, since)).toEqual([])
    await sessionConfig.close()

    // ② 当前会话没有运行时：可勾
    await sidebar.pickRowMenu(ACT, 'session-config')
    await sessionConfig.waitOpen()
    expect(await sessionConfig.titleValue()).toBe(ACT)
    const editable = await until(async () => {
      const items = await sessionConfig.extItems()
      const a = extItem(items, A)
      const b = extItem(items, B)
      return a && b && !a.disabled && !b.disabled ? items : null
    }, 'active session: extension items editable')
    expect(extItem(editable, A)).toMatchObject({ checked: true })
    expect(extItem(editable, B)).toMatchObject({ checked: false })
    await sessionConfig.toggleExt(B)
    await until(async () => sameList(await storedTools(sAct), [A, B]), 'dialog wrote [a, b]')
    await sessionConfig.close()

    // 两处同一份数据：弹窗里勾上的，输入框的选择器里也是勾着的
    await picker.open()
    await until(async () => (await pickerItem(B))?.checked === true, 'picker shows b checked')
    expect(await pickerItem(A)).toMatchObject({ checked: true })
    await picker.close()
  })

  it('EXT-E-5 回退仍会关停运行时：回退之前（有运行时）与之后（没有）勾选都写得进去', async () => {
    const title = 'EXT-E5-回退'
    const s = await createSession({ title, projectId: p1 })
    expect((await writeTools(s, [A])).success).toBe(true)
    await waitRow(title)
    expect(await sidebar.openSession(title)).toBe(true)

    // 发一条消息把运行时建出来（没有 API key，LLM 失败无妨 —— 用户条目已落树）
    const messages = (await promptAndListMessages(
      app.main,
      s,
      'EXT-E5 回退用的一句话'
    )) as unknown as Array<{ id: string; role: string }>
    const firstUser = messages.find((m) => m.role === 'user')
    expect(firstUser, 'the user message landed on the tree').toBeDefined()
    expect((await init(s)).created).toBe(true)

    // 有运行时：写得进去
    expect(await writeTools(s, [A, B])).toEqual({ success: true })
    expect(await storedTools(s)).toEqual([A, B])

    // 回退：运行时照旧关停
    const since = await recorder.mark()
    await app.main.eval(
      `window.api.message.rollback(${JSON.stringify({ sessionId: s, messageId: firstUser!.id })})`
    )
    await waitClosed(s, since)
    await until(async () => !(await init(s)).created, 'no runtime after rollback')

    // 没有运行时：同样写得进去，选择器跟着变、照样可点
    expect(await writeTools(s, [B])).toEqual({ success: true })
    expect(await storedTools(s)).toEqual([B])
    await picker.open()
    await until(
      async () =>
        (await pickerItem(B))?.checked === true && (await pickerItem(A))?.checked === false,
      'picker shows [b] after the rollback'
    )
    expect(await pickerItem(A)).toMatchObject({ disabled: false })
    await picker.close()
  })
})

describe('项目编辑弹窗的扩展能力（DOM）', () => {
  it('EXT-E-6 从没保存过就一个都不勾、保存过的照原样，全都可改（会话有没有运行时与它无关）；没有技能条目；原样保存写下 []；项目保存里残留的技能条目不被新会话继承', async () => {
    // 先让 P2 下一条会话的运行时建出来 —— 会话的运行时与项目弹窗无关，它照样全都可改
    const bystander = await createSession({ title: 'EXT-E6-有运行时', projectId: p2 })
    await ensureRuntime(bystander)
    expect((await init(bystander)).created).toBe(true)

    const openProject = async (name: string): Promise<ExtItemShot[]> => {
      await sidebar.pickGroupMenu({ project: name }, 'edit-project')
      await projectEdit.waitOpen()
      expect(await projectEdit.nameValue()).toBe(name)
      return until(async () => {
        const items = await projectEdit.extItems()
        return [A, B, TAVILY].every((key) => extItem(items, key)) ? items : null
      }, `project "${name}": extension items listed`)
    }

    // ① P1 从没保存过：一个都不勾（没有「默认全开」），这些全部可改；技能不在这张卡上
    const p1Items = await openProject(P1_NAME)
    for (const key of [A, B, TAVILY]) {
      expect(extItem(p1Items, key), key).toMatchObject({
        checked: false,
        disabled: false,
        declared: false
      })
    }
    expect(p1Items.filter((it) => it.key.startsWith('skill'))).toEqual([])
    await projectEdit.close()

    // ② P2 保存过 [a]
    const p2Items = await openProject(P2_NAME)
    expect(extItem(p2Items, A)).toMatchObject({ checked: true, disabled: false })
    expect(extItem(p2Items, B)).toMatchObject({ checked: false, disabled: false })
    expect(extItem(p2Items, TAVILY)).toMatchObject({ checked: false, disabled: false })
    await projectEdit.close()

    // ③ P1 不动扩展能力直接保存：写下的就是弹窗展示的那个空默认，之后新建的会话同样为空
    expect(await projectTools(p1)).toBeUndefined()
    await openProject(P1_NAME)
    await projectEdit.save()
    await until(async () => Array.isArray(await projectTools(p1)), 'P1 saved its extensions')
    expect(await projectTools(p1)).toEqual([])
    const fresh = await createSession({ title: 'EXT-E6-保存后新建', projectId: p1 })
    expect(await storedTools(fresh)).toEqual([])

    // ④ 新项目 P4 的保存里混着旧的技能条目（技能勾选与取消作图技能的记号）：新会话只继承 mcp: 那部分
    const p4 = (await createProject(app.main, { name: P4_NAME, path: projectDir('ext-p4') })).id
    await saveProjectTools(p4, [A, OLD_SKILL_TICK, OLD_NO_DRAWING])
    const p4Session = await createSession({ title: 'EXT-E6-项目四新建', projectId: p4 })
    expect(await storedTools(p4Session)).toEqual([A])
    expect((await toolsList(p4Session)).some((r) => r.name.startsWith('skill:'))).toBe(false)
  })
})

describe('离线的 MCP 不被抹掉（DOM + IPC）', () => {
  it('EXT-E-7 原值回显为已勾，经 UI 整份替换写入后仍在，建运行时也不动设置', async () => {
    const title = 'EXT-E7-离线'
    const s = await createSession({ title, projectId: p1 })
    expect((await writeTools(s, [TAVILY, A])).success).toBe(true)
    // init 回的是原值：离线的 tavily 还在（滤掉它的那份只给创建 Agent 用）
    expect((await init(s)).enabledTools).toEqual([TAVILY, A])

    await waitRow(title)
    expect(await sidebar.openSession(title)).toBe(true)

    // 输入框选择器：tavily 显示为已勾
    await picker.open()
    await until(
      async () => (await pickerItem(TAVILY))?.checked === true,
      'picker shows offline tavily checked'
    )
    expect(await pickerItem(A)).toMatchObject({ checked: true })
    await picker.close()

    // 会话设置卡（弹窗面板内 —— 空会话内联的那一张不算）：同样已勾
    await sidebar.pickRowMenu(title, 'session-config')
    await sessionConfig.waitOpen()
    await until(
      async () => extItem(await sessionConfig.extItems(), TAVILY)?.checked === true,
      'config dialog shows offline tavily checked'
    )
    await sessionConfig.close()

    // 经 UI 勾上 b：整份替换以 UI 手里的原值为基准 —— 离线的 tavily 若显示成没勾，这一下就抹掉了
    expect(await picker.toggle(B)).toBe(true)
    await until(
      async () => sameList(await storedTools(s), [TAVILY, A, B]),
      'UI write keeps offline tavily'
    )
    await picker.close()

    // 建运行时（此刻才滤掉离线的 tavily）不回写设置
    const info = await ensureRuntime(s)
    expect(info).not.toBeNull()
    expect(await storedTools(s)).toEqual([TAVILY, A, B])
  })
})
describe('技能：启用着就在架，不按会话勾选（IPC + DOM）', () => {
  it('EXT-E-8 空勾选的 work 会话：tools.list 与选择器里没有技能条目（skill 工具本身在内置工具里）；运行时的 skill 工具带着全部启用着的技能，提示里指路并教 adopt', async () => {
    const title = 'EXT-E8-技能在架'
    const s = await createSession({ title, projectId: p1 })
    expect(await storedTools(s)).toEqual([])

    // ① 数据源：没有任何 skill: 条目；skill 工具本身是 general 组里的一个内置工具
    const rows = await toolsList(s)
    expect(rows.filter((r) => r.name.startsWith('skill:'))).toEqual([])
    expect(rows.find((r) => r.name === 'skill')?.group).toBe('general')

    // ② 选择器：只有 MCP（与知识库）的行，没有技能行
    await waitRow(title)
    expect(await sidebar.openSession(title)).toBe(true)
    await until(() => picker.present(), 'tool picker present')
    await picker.open()
    await until(async () => (await pickerItem(A)) !== undefined, 'mcp a listed')
    expect((await picker.items()).filter((it) => !it.name.startsWith('mcp:'))).toEqual([])
    await picker.close()

    // ③ 运行时：内置作图技能与两个种下的用户技能都在架 —— 一个都没勾；提示里指了路、也教了 adopt
    const info = await ensureRuntime(s)
    expect(info).not.toBeNull()
    expect(skillDescription(info)).toContain(`<name>${DRAWING_SKILL}</name>`)
    expect(skillDescription(info)).toContain(`<name>${SKILL_A}</name>`)
    expect(skillDescription(info)).toContain(`<name>${SKILL_B}</name>`)
    expect(info!.systemPrompt).toContain(DRAWING_POINTER)
    expect(info!.systemPrompt).toContain('adopt')
    expect(await storedTools(s)).toEqual([])
  })

  it('EXT-E-9 在侧栏停用内置作图技能与一个用户技能后新建的会话：skill 工具里没有它们、提示里整份作图说明都不出', async () => {
    await setSkillEnabled(DRAWING_SKILL, false)
    await setSkillEnabled(SKILL_B, false)
    try {
      const s = await createSession({ title: 'EXT-E9-停用技能', projectId: p1 })
      expect(await storedTools(s)).toEqual([])

      // 停用的技能不在架；工具本身还在 —— 别的启用着的技能（内置的 widget、用户的 a）照样上架
      const info = await ensureRuntime(s)
      expect(info).not.toBeNull()
      expect(skillDescription(info)).not.toContain(`<name>${DRAWING_SKILL}</name>`)
      expect(skillDescription(info)).not.toContain(`<name>${SKILL_B}</name>`)
      expect(skillDescription(info)).toContain('<name>builtin:widget</name>')
      expect(skillDescription(info)).toContain(`<name>${SKILL_A}</name>`)
      // 契约与手艺只在技能里（2026-09-24 起）：技能加载不到，就整份作图说明都不出 —— 不指路，
      // 也没有一份常驻的手艺或范例图可以兜底（指一个拿不到的技能是死路）
      expect(info!.systemPrompt).not.toContain(DRAWING_POINTER)
      expect(info!.systemPrompt).not.toContain(DRAWING_EXAMPLE)
      expect(info!.systemPrompt).not.toContain('```svg')
    } finally {
      await setSkillEnabled(DRAWING_SKILL, true)
      await setSkillEnabled(SKILL_B, true)
    }
  })

  it('EXT-E-10 旧的技能记号不再被收：写入口滤掉 skill: / -skill:、只留 mcp:；作图技能照样在架；有运行时时在侧栏停用它，那个运行时的货架与人设都不跟（创建时定下）', async () => {
    const s = await createSession({ title: 'EXT-E10-旧记号', projectId: p1 })

    // ① 写入口：取消作图技能的旧记号与旧的技能勾选都被滤掉
    expect(await writeTools(s, [OLD_NO_DRAWING, OLD_SKILL_TICK, A])).toEqual({ success: true })
    expect(await storedTools(s)).toEqual([A])
    expect((await init(s)).enabledTools).toEqual([A])

    // ② 运行时：作图技能在架，提示里指路、教交互块
    const before = await ensureRuntime(s)
    expect(before).not.toBeNull()
    expect(skillDescription(before)).toContain(`<name>${DRAWING_SKILL}</name>`)
    expect(before!.systemPrompt).toContain(DRAWING_POINTER)
    expect(before!.systemPrompt).toContain(INTERACTIVE)
    expect(carries(before, A)).toBe(true)

    // ③ 侧栏停用作图技能：同一个运行时不重配、不重建 —— 货架与人设原样（之后新建的才不带它，见 EXT-E-9）
    const since = await recorder.mark()
    await setSkillEnabled(DRAWING_SKILL, false)
    try {
      const still = await runtimeInfo(s)
      expect(skillDescription(still)).toContain(`<name>${DRAWING_SKILL}</name>`)
      expect(still!.systemPrompt).toBe(before!.systemPrompt)
      expect((await init(s)).created).toBe(true)
      expect(await lifecycleEventsSince(s, since)).toEqual([])
    } finally {
      await setSkillEnabled(DRAWING_SKILL, true)
    }
  })
})

describe('有运行时的外观（DOM）', () => {
  it('UIF-E-1 会话设置扩展能力卡：有没有运行时都整排可改、组名旁没有锁、没有技能条目；悬停提示是条目自己的说明，说明文字两态相同', async () => {
    const title = 'UIF-E1-外观'
    const s = await createSession({ title, projectId: p1 })
    expect((await writeTools(s, [A])).success).toBe(true)
    await waitRow(title)

    /** 等条目上屏（随 tools.list 异步到）并回整排快照 */
    const openAndRead = async (what: string): Promise<ExtItemShot[]> => {
      await sidebar.pickRowMenu(title, 'session-config')
      await sessionConfig.waitOpen()
      expect(await sessionConfig.titleValue()).toBe(title)
      return until(async () => {
        const items = await sessionConfig.extItems()
        return extItem(items, A) && extItem(items, B) ? items : null
      }, what)
    }

    // ① 没有运行时：整排可改，组名旁一把锁都没有，悬停提示是条目自己的说明（内置 database 的界面文案）；
    // 卡上没有技能条目
    const editable = await openAndRead('extensions listed before the runtime exists')
    expect(extItem(editable, A)).toMatchObject({
      checked: true,
      disabled: false,
      lockedLook: false,
      declared: false
    })
    const titleA = extItem(editable, A)?.title ?? ''
    expect(titleA).not.toBe('')
    expect(editable.filter((it) => it.key.startsWith('skill'))).toEqual([])
    expect(await sessionConfig.lockIndicatorCount()).toBe(0)
    // 说明文字比对的是**两态下的同一句**（读两次比字符串），不钉具体本地化文案。
    // 2026-09-17 起它只在悬浮 / 聚焦标题旁的问号时才在 DOM 里（pages.ts 的 SECTION_HINT 负责展开）
    const hint = await sessionConfig.hintText()
    expect(hint).not.toBe('')
    await sessionConfig.close()

    // ② 运行时建出来：外观一模一样 —— 整排可改、没有锁，悬停提示还是条目自己的
    await ensureRuntime(s)
    expect((await init(s)).created).toBe(true)
    const withRuntime = await openAndRead('extensions listed once the runtime exists')
    expect(withRuntime.length).toBeGreaterThan(0)
    for (const item of withRuntime) {
      expect(item, item.key).toMatchObject({ disabled: false, lockedLook: false })
    }
    expect(await sessionConfig.lockIndicatorCount()).toBe(0)
    expect(extItem(withRuntime, A)).toMatchObject({ checked: true, title: titleA })
    expect(await sessionConfig.hintText()).toBe(hint)
    await sessionConfig.close()
  })

  it('UIF-E-2 有运行时勾上一台连不上的 MCP：错误行落在会话里，勾选留着、画成离线但不禁用；运行时里没有它的工具', async () => {
    expect(
      await app.main.eval(
        `window.api.mcp.update(${JSON.stringify({ id: 'builtin-mcp-tavily', isEnabled: true })})`
      )
    ).toEqual({ success: true })

    const title = 'UIF-E2-离线'
    const s = await createSession({ title, projectId: p1 })
    expect((await writeTools(s, [A])).success).toBe(true)
    await waitRow(title)
    expect(await sidebar.openSession(title)).toBe(true)
    await ensureRuntime(s)
    expect((await init(s)).created).toBe(true)

    // 有运行时勾上 tavily：重配走与创建同一条惰性连接的路 —— 缺 env，造 transport 之前就断，落一条错误
    const since = await recorder.mark()
    await picker.open()
    await until(
      async () => (await pickerItem(TAVILY))?.checked === false,
      'tavily listed, unticked'
    )
    expect(await picker.toggle(TAVILY)).toBe(true)
    await recorder.waitFor<RecordedEvent>('error', { sessionId: s, since })
    await until(async () => sameList(await storedTools(s), [A, TAVILY]), 'picker wrote [a, tavily]')
    await picker.close()

    // 重开面板（打开时重拉连接状态）：tavily 仍勾着、画成离线，但照样可点；没失败过的那条不离线
    await picker.open()
    await until(
      async () => (await pickerItem(TAVILY))?.offline === true,
      'the failed server is painted offline'
    )
    expect(await pickerItem(TAVILY)).toMatchObject({
      checked: true,
      disabled: false,
      offline: true
    })
    expect(await pickerItem(A)).toMatchObject({ checked: true, disabled: false, offline: false })
    await picker.close()

    // 运行时：没有 tavily 的工具（连不上就不交回），勾选原样留着（init 报锁里记的那份）
    const info = await runtimeInfo(s)
    expect(info).not.toBeNull()
    expect(info!.tools.some((t) => t.name.startsWith('mcp__tavily__'))).toBe(false)
    expect((await init(s)).enabledTools).toEqual([A, TAVILY])
    expect(await lifecycleEventsSince(s, since)).toEqual([])

    // 会话设置卡里的同一条：同样勾着、离线、可点
    await sidebar.pickRowMenu(title, 'session-config')
    await sessionConfig.waitOpen()
    const items = await until(async () => {
      const shot = await sessionConfig.extItems()
      return extItem(shot, TAVILY)?.offline ? shot : null
    }, 'config dialog paints tavily offline')
    expect(extItem(items, TAVILY)).toMatchObject({
      checked: true,
      disabled: false,
      lockedLook: false,
      offline: true
    })
    expect(extItem(items, A)).toMatchObject({ lockedLook: false, offline: false })
    await sessionConfig.close()
  })
})
