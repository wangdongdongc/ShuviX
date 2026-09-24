/**
 * 会话的扩展能力勾选（`settings.enabledTools`：mcp:/skill:）—— 新建会话时定下、只在创建根 Agent
 * 时读一次、运行时存在（含创建中 / 关停中）期间只读。
 *
 * 链路：sessionService.create（继承）→ agent.init（原值 + created）→ SessionManager.onCreated →
 * `agent_created` / `agent_closing` → chat-ui 的 sessionAgentCreated → 输入框工具选择器与会话设置
 * 扩展能力卡的只读态；写入口 `session.updateEnabledTools` 在运行时存在期间拒绝。
 *
 * 断言优先走 IPC：`session.getById` 的原值、`agent.init`、`agent.getInfo` 里 skill 工具的描述（那是
 * 真正发给模型的东西）。DOM 只断两件事：只读态有没有跟上运行时的生灭，两处入口是不是同一份数据。
 *
 * 夹具：两个真实可用的全局 skill（a / b）；P1 从没保存过扩展能力，P2 保存过 [a]。隔离实例里恒有一个
 * 内置、离线的 `mcp:tavily` —— 选择器与扩展能力卡在桌面上因此永远不会因「没有条目」而隐藏，它也是
 * 「离线项不被抹掉」那条回归的现成样本。全程无 LLM：运行时靠 `agent.getInfo(sid, { ensure: true })`
 * 懒建；需要消息的那条走 promptAndListMessages（容忍隔离实例无 API key 的失败）。
 *
 * 档案声明的项：项目会话的根档案是 work，它的 `shuvix-tools` 点了内置作图技能 `skill:builtin:drawing`
 * —— 档案声明的 mcp:/skill: 恒生效，会话勾选只能在其上叠加。所以两处入口里它恒画成已勾、禁用、
 * `data-declared`（与「运行时已建」的只读是两回事），它既不在会话勾选里、也不会被写进去（EXT-E-8 / 9）。
 *
 * ⚠️ 不用 `location.reload()`：主进程的 will-navigate 守卫会取消它（见 seed.waitRendererReady）。
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sleep, until } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import {
  createProject,
  eventRecorder,
  promptAndListMessages,
  seedSkill,
  waitRendererReady,
  type EventRecorder,
  type RecordedEvent
} from '../../harness/seed'
import {
  projectEditPane,
  sessionConfigPane,
  sidebarPane,
  toolPickerPane,
  type ExtItemShot,
  type ProjectEditPane,
  type SessionConfigPane,
  type SidebarPane,
  type ToolPickerItem,
  type ToolPickerPane
} from '../../harness/pages'

const SKILL_A = 'e2e-ext-a'
const SKILL_B = 'e2e-ext-b'
/** A 的说明文案 —— 条目悬停提示的判据（只读时它要被「为什么改不了」顶掉） */
const SKILL_A_DESC = 'ext-a seeded skill description'
const A = `skill:${SKILL_A}`
const B = `skill:${SKILL_B}`
/** 内置、离线（隔离实例没有它的 API key）的 MCP —— 恒在工具列表里 */
const TAVILY = 'mcp:tavily'
/** 内置作图技能：work 档案在 shuvix-tools 里声明了它 —— 项目会话的两处入口里恒已勾、锁住 */
const DRAWING = 'skill:builtin:drawing'
/** 系统提示里「先加载作图技能」那句指路的记号（三语一字不差） */
const DRAWING_POINTER = 'builtin:drawing'
/** 手艺段的范例围栏（技能不在架时整段手艺常驻，它就在提示里） */
const DRAWING_EXAMPLE = '```svg\n<svg'
/** 项目组头按名字认（pages.ts 的 GroupTarget），名字须全局唯一 */
const P1_NAME = 'EXT-项目一'
const P2_NAME = 'EXT-项目二'
const P3_NAME = 'EXT-项目三'

interface InitResult {
  success: boolean
  created: boolean
  enabledTools: string[]
}

interface RuntimeInfo {
  systemPrompt: string
  tools: Array<{ name: string; description: string }>
}

/** `tools.list(sid)` 里 mcp / skill 条目的形状（只取这一组断言要的字段） */
interface ListedTool {
  name: string
  declaredBy?: string
}

let app: E2EApp
let recorder: EventRecorder
let sidebar: SidebarPane
let picker: ToolPickerPane
let sessionConfig: SessionConfigPane
let projectEdit: ProjectEditPane
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

/** 选择器 / 会话设置的数据源：这条会话能勾的条目，档案声明的带 declaredBy */
const toolsList = (sid: string): Promise<ListedTool[]> =>
  app.main.eval<ListedTool[]>(`window.api.tools.list(${JSON.stringify(sid)})`)

/** 全局启用 / 停用一个技能（写 `~/.shuvix/skills/.config.json` 的 disabled） */
const setSkillEnabled = (name: string, isEnabled: boolean): Promise<unknown> =>
  app.main.eval(`window.api.skill.update(${JSON.stringify({ name, isEnabled })})`)

const sameList = (actual: unknown, expected: string[]): boolean =>
  JSON.stringify(actual) === JSON.stringify(expected)

const waitRow = (title: string): Promise<boolean> =>
  until(async () => (await sidebar.titles()).includes(title), `sidebar row "${title}"`)

/** 等本会话在 since 之后的 `agent_closing{closing:false}`（前端据它解除只读） */
async function waitClosed(sid: string, since: number): Promise<void> {
  let ev = await recorder.waitFor<RecordedEvent>('agent_closing', { sessionId: sid, since })
  while (ev.closing !== false) {
    ev = await recorder.waitFor<RecordedEvent>('agent_closing', { sessionId: sid })
  }
}

/** 清空会话（先关停运行时）并等关停完毕的事件到达 */
async function clearAndWaitClosed(sid: string): Promise<void> {
  const since = await recorder.mark()
  await app.main.eval(`window.api.message.clear(${JSON.stringify(sid)})`)
  await waitClosed(sid, since)
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
  await waitRendererReady(app.main)
  recorder = eventRecorder(app.main)
  await recorder.install()
  sidebar = sidebarPane(app.main)
  picker = toolPickerPane(app.main)
  sessionConfig = sessionConfigPane(app.main)
  projectEdit = projectEditPane(app.main)

  // 真实可用的 skill：勾一个查无此人的名字，skill 工具的描述里是断不到的
  seedSkill(app, SKILL_A, SKILL_A_DESC)
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

describe('勾选从哪来、何时只读（IPC）', () => {
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

  it('EXT-E-2 只在创建运行时读一次：运行时存在期间写入被拒、运行时不变；清空（关停）后可改，下一个运行时读到新值', async () => {
    const s = await createSession({ title: 'EXT-E2', projectId: p1 })
    expect((await writeTools(s, [A])).success).toBe(true)

    // ① 建运行时：skill 工具描述里带的就是此刻的勾选
    const first = await ensureRuntime(s)
    expect(skillDescription(first)).toContain(`<name>${SKILL_A}</name>`)
    expect(skillDescription(first)).not.toContain(`<name>${SKILL_B}</name>`)
    expect((await init(s)).created).toBe(true)

    // ② 运行时存在：写入被拒、什么也没写，运行时手里的工具也没变
    expect((await writeTools(s, [B])).success).toBe(false)
    expect(await storedTools(s)).toEqual([A])
    const still = await runtimeInfo(s)
    expect(skillDescription(still)).toContain(`<name>${SKILL_A}</name>`)
    expect(skillDescription(still)).not.toContain(`<name>${SKILL_B}</name>`)

    // ③ 清空 = 关停运行时：关停完毕之后不再有运行时，勾选重新可写
    await clearAndWaitClosed(s)
    expect((await init(s)).created).toBe(false)
    expect((await writeTools(s, [B])).success).toBe(true)

    // ④ 下一个运行时读的是新勾选
    const second = await ensureRuntime(s)
    expect(skillDescription(second)).toContain(`<name>${SKILL_B}</name>`)
    expect(skillDescription(second)).not.toContain(`<name>${SKILL_A}</name>`)
  })
})

describe('输入框工具选择器与会话设置卡（DOM）', () => {
  it('EXT-E-3 输入框工具选择器：没有运行时可勾；运行时存在期间只读（绕过禁用也写不进去）；清空后解锁', async () => {
    const title = 'EXT-E3-选择器'
    const s = await createSession({ title, projectId: p1 })
    await waitRow(title)
    expect(await sidebar.openSession(title)).toBe(true)

    // ① 没有运行时：可勾，勾了就落库
    await until(() => picker.present(), 'tool picker present')
    expect(await picker.locked()).toBe(false)
    await picker.open()
    await until(async () => (await pickerItem(A))?.disabled === false, 'skill a listed, editable')
    expect(await picker.toggle(A)).toBe(true)
    await until(async () => sameList(await storedTools(s), [A]), 'picker wrote [a]')

    // ② 运行时建出来（agent_created）→ 只读
    await ensureRuntime(s)
    await until(() => picker.locked(), 'tool picker locked once the runtime exists')
    await picker.open()
    // 只读的可见性：触发钮挂锁 + 整排条目画成禁用态（面板里不再有一行文字说明）
    await until(() => picker.lockIndicatorVisible(), 'lock indicator shown on the trigger')
    await until(async () => (await pickerItem(B))?.disabled === true, 'items disabled while locked')
    expect(await pickerItem(A)).toMatchObject({ checked: true, disabled: true, lockedLook: true })
    expect(await pickerItem(B)).toMatchObject({ checked: false, disabled: true, lockedLook: true })
    // 绕过禁用态硬点 b：只读不能只靠 disabled 撑着 —— 组件与写入口自己得挡住
    expect(await picker.toggle(B, { force: true })).toBe(true)
    await sleep(600)
    expect(await storedTools(s)).toEqual([A])
    expect(await pickerItem(B)).toMatchObject({ checked: false })

    // ③ 清空（agent_closing{false}）→ 解锁
    await clearAndWaitClosed(s)
    await until(async () => !(await picker.locked()), 'tool picker unlocked after clear')
    await picker.open()
    await until(async () => (await pickerItem(B))?.disabled === false, 'items editable again')
    expect(await picker.lockIndicatorVisible()).toBe(false)
    expect(await pickerItem(B)).toMatchObject({ lockedLook: false })
    await picker.close()
  })

  it('EXT-E-4 会话设置弹窗：开在一条有运行时的非当前会话上是只读；当前会话可勾，勾完输入框选择器跟着变', async () => {
    const ACT = 'EXT-E4-当前'
    const OTH = 'EXT-E4-另一条'
    const sAct = await createSession({ title: ACT, projectId: p2 })
    const sOth = await createSession({ title: OTH, projectId: p2 })
    await waitRow(ACT)
    await waitRow(OTH)
    expect(await sidebar.openSession(ACT)).toBe(true)

    // ① 另一条会话有运行时：它的弹窗只读（锁态按 disabled 断，不比本地化文案）
    await ensureRuntime(sOth)
    await sidebar.pickRowMenu(OTH, 'session-config')
    await sessionConfig.waitOpen()
    expect(await sessionConfig.titleValue()).toBe(OTH)
    const locked = await until(async () => {
      const items = await sessionConfig.extItems()
      return extItem(items, A)?.disabled && extItem(items, B)?.disabled ? items : null
    }, 'other session: extension items read-only')
    expect(extItem(locked, A)).toMatchObject({ checked: true, disabled: true })
    expect(extItem(locked, B)).toMatchObject({ checked: false, disabled: true })
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

  it('EXT-E-5 回退同样关停运行时：回退之后选择器解锁、勾选重新可写', async () => {
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
    await until(() => picker.locked(), 'tool picker locked after the prompt created the runtime')

    const since = await recorder.mark()
    await app.main.eval(
      `window.api.message.rollback(${JSON.stringify({ sessionId: s, messageId: firstUser!.id })})`
    )
    await waitClosed(s, since)
    await until(async () => !(await init(s)).created, 'no runtime after rollback')
    await until(async () => !(await picker.locked()), 'tool picker unlocked after rollback')
    expect((await writeTools(s, [B])).success).toBe(true)
    expect(await storedTools(s)).toEqual([B])
  })
})

describe('项目编辑弹窗的扩展能力（DOM）', () => {
  it('EXT-E-6 从没保存过就一个都不勾（档案声明的那项除外：已勾、锁住）、保存过的照原样，其余全都可改（会话运行时锁不到它）；原样保存写下 []', async () => {
    // 先让 P2 下一条会话的运行时建出来 —— 只读是会话级的，不能漏到项目弹窗上
    const bystander = await createSession({ title: 'EXT-E6-有运行时', projectId: p2 })
    await ensureRuntime(bystander)
    expect((await init(bystander)).created).toBe(true)

    const openProject = async (name: string): Promise<ExtItemShot[]> => {
      await sidebar.pickGroupMenu({ project: name }, 'edit-project')
      await projectEdit.waitOpen()
      expect(await projectEdit.nameValue()).toBe(name)
      return until(async () => {
        const items = await projectEdit.extItems()
        return [A, B, TAVILY, DRAWING].every((key) => extItem(items, key)) ? items : null
      }, `project "${name}": extension items listed`)
    }

    // ① P1 从没保存过：自己的勾选一个都没有（没有「默认全开」），这些全部可改；
    // 唯一勾着的是 work 档案声明的作图技能 —— 已勾、禁用、带声明标记，它不属于项目的勾选
    const p1Items = await openProject(P1_NAME)
    for (const key of [A, B, TAVILY]) {
      expect(extItem(p1Items, key), key).toMatchObject({
        checked: false,
        disabled: false,
        declared: false
      })
    }
    expect(extItem(p1Items, DRAWING)).toMatchObject({
      checked: true,
      disabled: true,
      declared: true
    })
    await projectEdit.close()

    // ② P2 保存过 [a]
    const p2Items = await openProject(P2_NAME)
    expect(extItem(p2Items, A)).toMatchObject({ checked: true, disabled: false })
    expect(extItem(p2Items, B)).toMatchObject({ checked: false, disabled: false })
    expect(extItem(p2Items, TAVILY)).toMatchObject({ checked: false, disabled: false })
    await projectEdit.close()

    // ③ P1 不动扩展能力直接保存：写下的就是弹窗展示的那个空默认，之后新建的会话同样为空。
    // 画成已勾的作图技能也没被写进去 —— 声明项恒生效，从来不进项目默认 / 会话勾选
    expect(await projectTools(p1)).toBeUndefined()
    await openProject(P1_NAME)
    await projectEdit.save()
    await until(async () => Array.isArray(await projectTools(p1)), 'P1 saved its extensions')
    expect(await projectTools(p1)).toEqual([])
    const fresh = await createSession({ title: 'EXT-E6-保存后新建', projectId: p1 })
    expect(await storedTools(fresh)).toEqual([])
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

describe('档案声明的作图技能（IPC + DOM）', () => {
  it('EXT-E-8 空勾选的 work 会话：声明项标着 declaredBy、在选择器里已勾锁住；勾选只写会话自己的，运行时带齐两本、提示里指路并教 adopt', async () => {
    const title = 'EXT-E8-档案声明'
    const s = await createSession({ title, projectId: p1 })
    expect(await storedTools(s)).toEqual([])

    // ① 数据源：声明项带着档案的显示名，会话自己能勾的那些不带
    const rows = await toolsList(s)
    const declaredBy = rows.find((r) => r.name === DRAWING)?.declaredBy
    expect(declaredBy, 'work 声明的作图技能在 tools.list 里带 declaredBy').toBeTypeOf('string')
    expect(declaredBy!.length).toBeGreaterThan(0)
    expect(rows.find((r) => r.name === A)?.declaredBy).toBeUndefined()

    // ② 选择器：会话没有运行时（不是只读），声明项仍是已勾、禁用、带声明标记，悬停说是谁声明的
    await waitRow(title)
    expect(await sidebar.openSession(title)).toBe(true)
    await until(() => picker.present(), 'tool picker present')
    expect(await picker.locked()).toBe(false)
    await picker.open()
    const drawingRow = await until(
      async () => (await pickerItem(DRAWING)) ?? null,
      'drawing row listed'
    )
    expect(drawingRow).toMatchObject({ checked: true, disabled: true, declared: true })
    expect(drawingRow.title).toContain(declaredBy!)

    // ③ 勾上 a：写下的恰是 [a] —— 声明项不被带进会话勾选
    await until(async () => (await pickerItem(A))?.disabled === false, 'skill a listed, editable')
    expect(await picker.toggle(A)).toBe(true)
    await until(async () => sameList(await storedTools(s), [A]), 'picker wrote exactly [a]')

    // ④ 绕过禁用态硬点声明项：什么也不变（组件与写入口自己挡住，不只靠 disabled）
    expect(await picker.toggle(DRAWING, { force: true })).toBe(true)
    await sleep(600)
    expect(await storedTools(s)).toEqual([A])
    expect(await pickerItem(DRAWING)).toMatchObject({ checked: true, declared: true })
    await picker.close()

    // ⑤ 运行时：技能货架上两本都在（档案声明的 + 会话勾选的），提示里指了路、也教了 adopt
    const info = await ensureRuntime(s)
    expect(info).not.toBeNull()
    expect(skillDescription(info)).toContain('<name>builtin:drawing</name>')
    expect(skillDescription(info)).toContain(`<name>${SKILL_A}</name>`)
    expect(info!.systemPrompt).toContain(DRAWING_POINTER)
    expect(info!.systemPrompt).toContain('adopt')
  })

  it('EXT-E-9 在侧栏停用内置作图技能后新建的会话：没有这一条、没有 skill 工具、提示里整份作图说明都不出', async () => {
    await setSkillEnabled('builtin:drawing', false)
    try {
      const s = await createSession({ title: 'EXT-E9-停用作图技能', projectId: p1 })
      expect(await storedTools(s)).toEqual([])

      // 档案点了名也救不回一个被停用的技能：列表里不再有它，更谈不上锁
      const rows = await toolsList(s)
      expect(rows.map((r) => r.name)).not.toContain(DRAWING)

      // 名单里唯一的 skill 不在架、会话也没勾别的 → 空手的 skill 工具不挂
      const info = await ensureRuntime(s)
      expect(info).not.toBeNull()
      expect(info!.tools.map((t) => t.name)).not.toContain('skill')
      // 契约与手艺只在技能里（2026-09-24 起）：技能加载不到，就整份作图说明都不出 —— 不指路，
      // 也没有一份常驻的手艺或范例图可以兜底（指一个拿不到的技能是死路）
      expect(info!.systemPrompt).not.toContain(DRAWING_POINTER)
      expect(info!.systemPrompt).not.toContain(DRAWING_EXAMPLE)
      expect(info!.systemPrompt).not.toContain('```svg')
    } finally {
      await setSkillEnabled('builtin:drawing', true)
    }
  })
})

describe('只读态的外观（DOM）', () => {
  it('UIF-E-1 会话设置扩展能力卡：整排禁用态 + 组名旁挂锁；只读原因只在悬停提示里，说明文字不变', async () => {
    const title = 'UIF-E1-只读外观'
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

    // ① 没有运行时：整排可改，组名旁一把锁都没有，悬停提示是 skill 自己的说明
    await openAndRead('extensions listed before the runtime exists')
    const editable = await until(async () => {
      const items = await sessionConfig.extItems()
      return extItem(items, A)?.disabled === false ? items : null
    }, 'extension items editable before the runtime exists')
    expect(extItem(editable, A)).toMatchObject({
      checked: true,
      disabled: false,
      lockedLook: false,
      title: SKILL_A_DESC
    })
    expect(await sessionConfig.lockIndicatorCount()).toBe(0)
    // 说明文字比对的是**两态下的同一句**（读两次比字符串），不钉具体本地化文案。
    // 2026-09-17 起它只在悬浮 / 聚焦标题旁的问号时才在 DOM 里（pages.ts 的 SECTION_HINT 负责展开）
    const hint = await sessionConfig.hintText()
    expect(hint).not.toBe('')
    await sessionConfig.close()

    // ② 运行时建出来：整排按禁用态画，MCP / Skills 两个组名旁各挂一把锁
    // （弹窗挂载时自己向后端拉一次「有没有运行时」，所以开出来就是只读的）
    await ensureRuntime(s)
    await openAndRead('extensions listed once the runtime exists')
    const locked = await until(async () => {
      const items = await sessionConfig.extItems()
      return items.length > 0 && items.every((it) => it.disabled && it.lockedLook) ? items : null
    }, 'every extension item painted read-only')
    expect(await sessionConfig.lockIndicatorCount()).toBe(2)
    // 只读的原因改走悬停提示：不再是 skill 的说明，也不是空
    const lockedHint = extItem(locked, A)?.title ?? ''
    expect(lockedHint).not.toBe(SKILL_A_DESC)
    expect(lockedHint).not.toBe('')
    // 档案声明的作图技能此刻同样说「为什么改不了」—— 只读的原因盖过「谁声明的」
    expect(extItem(locked, DRAWING)).toMatchObject({
      checked: true,
      declared: true,
      title: lockedHint
    })
    // 说明气泡里那句话两态完全相同 —— 只读原因从这里搬走了，它不该再随状态变
    expect(await sessionConfig.hintText()).toBe(hint)
    await sessionConfig.close()

    // ③ 清空（关停运行时）：锁消失，会话自己能勾的那些整排重新可改。档案声明的作图技能不在
    // 「整排」里 —— 它恒开着、恒锁着（与有没有运行时无关），所以只看没被声明的那些
    await clearAndWaitClosed(s)
    await openAndRead('extensions listed after the runtime closed')
    const unlocked = await until(async () => {
      const items = await sessionConfig.extItems()
      const free = items.filter((it) => !it.declared)
      return free.length > 0 && free.every((it) => !it.disabled && !it.lockedLook) ? items : null
    }, 'undeclared extension items editable again after the runtime closed')
    expect(await sessionConfig.lockIndicatorCount()).toBe(0)
    expect(extItem(unlocked, A)).toMatchObject({ title: SKILL_A_DESC })
    const drawing = extItem(unlocked, DRAWING)
    expect(drawing).toMatchObject({ checked: true, disabled: true, declared: true })
    // 它的悬停说的是谁声明的，不是只读原因（运行时已经不在了）
    expect(drawing?.title).not.toBe(lockedHint)
    expect(drawing?.title).not.toBe('')
    await sessionConfig.close()
  })

  it('UIF-E-2 只读压暗与「离线」压暗互不掩盖：失败过的 MCP 两个标记同时在', async () => {
    // 只读态把 `opacity-50` 从失败行拿掉了（整排统一压暗），离线的判据因此改成 `data-offline`
    // —— 两种压暗若共用同一个判据，「锁住了」会把「这台连不上」整个盖掉
    expect(
      await app.main.eval(
        `window.api.mcp.update(${JSON.stringify({ id: 'builtin-mcp-tavily', isEnabled: true })})`
      )
    ).toEqual({ success: true })

    const title = 'UIF-E2-离线且只读'
    const s = await createSession({ title, projectId: p1 })
    expect((await writeTools(s, [TAVILY, A])).success).toBe(true)
    await waitRow(title)
    expect(await sidebar.openSession(title)).toBe(true)

    // 走一次必定失败的创建（缺 env，造 transport 之前就断）：tavily 落到 error 状态
    const since = await recorder.mark()
    await ensureRuntime(s)
    await recorder.waitFor<RecordedEvent>('error', { sessionId: s, since })

    await until(() => picker.locked(), 'tool picker locked once the runtime exists')
    await picker.open()
    await until(
      async () => (await pickerItem(TAVILY))?.offline === true,
      'the failed server is still painted offline while read-only'
    )
    expect(await pickerItem(TAVILY)).toMatchObject({
      checked: true,
      disabled: true,
      lockedLook: true,
      offline: true
    })
    // 同一面板里没失败过的那条：只读但不离线
    expect(await pickerItem(A)).toMatchObject({ lockedLook: true, offline: false })
    await picker.close()

    // 会话设置卡里的同一条：两个标记同样并存
    await sidebar.pickRowMenu(title, 'session-config')
    await sessionConfig.waitOpen()
    const items = await until(async () => {
      const shot = await sessionConfig.extItems()
      return extItem(shot, TAVILY)?.disabled ? shot : null
    }, 'config dialog read-only')
    expect(extItem(items, TAVILY)).toMatchObject({
      checked: true,
      disabled: true,
      lockedLook: true,
      offline: true
    })
    expect(extItem(items, A)).toMatchObject({ lockedLook: true, offline: false })
    await sessionConfig.close()
  })
})
