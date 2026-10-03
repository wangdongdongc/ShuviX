/**
 * 会话模型的只读区间与「销毁运行时」—— 模型与扩展能力勾选同一条规矩：只在创建根 Agent 那一刻读一次。
 *
 *   - 欢迎页（还没有会话）上的模型 / 思考档位 / 扩展能力是**新会话的草稿**：直接发送时
 *     `createSessionForSend` 在 `agent.init` 之前把它们写进新会话，第一轮就跑在选的模型上；
 *     欢迎页的工具选择器按新会话将用的档案（无项目 → chat）画声明项；
 *   - 会话有运行时期间 `agent.setModel` 拒绝（success:false、什么也不写），思考档位照常可改；
 *     输入框的模型选择器锁住（面板照常能展开调档位，模型行禁用）；
 *   - 会话横幅 agent 胶囊上的 X（`agent.destroy`）销毁运行时：会话与历史都在，两个选择器解锁，
 *     下一条消息按那时选的模型重建；运行中销毁会中止这一轮。
 *
 * 断言优先走 IPC（session.getById / agent.init / agent.getInfo / message.list）与假提供商记下的请求
 * （`body.model` 就是那一轮真正用的模型）；DOM 只断两个选择器的锁与胶囊的生灭（pages.ts 的
 * modelPickerPane / toolPickerPane / statusBannerPane）。请求按 `lastUserText` 认领：自动标题的
 * titler 也会打到假提供商上，按下标取会取错。
 *
 * 夹具：假提供商的模型 A（种成默认）与 B（之后加进同一个提供商，同样 200k 上下文）；一个全局 skill X。
 * 提供商是在实例启动之后才种的，欢迎页起初显示「选择模型」—— 用例在界面里显式选一次。
 * 三个用例共用一个实例、按顺序接力：E-1 从欢迎页建出会话，E-2 / E-3 接着用它。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { until } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import { startFakeProvider, type FakeProvider, type FakeRequest } from '../../harness/fakeProvider'
import {
  eventRecorder,
  seedFakeProvider,
  seedSkill,
  waitRendererReady,
  type EventRecorder,
  type RecordedEvent
} from '../../harness/seed'
import {
  chatPane,
  modelPickerPane,
  statusBannerPane,
  toolPickerPane,
  type ChatPane,
  type ModelPickerPane,
  type StatusBannerPane,
  type ToolPickerPane
} from '../../harness/pages'

const MODEL_A = 'e2e-model-a'
const MODEL_B = 'e2e-model-b'
const SKILL_X = 'e2e-ml-x'
const X = `skill:${SKILL_X}`
/** 内置作图技能：chat 与 work 的 shuvix-tools 都声明了它（恒生效，不写进会话勾选） */
const DRAWING = 'skill:builtin:drawing'

const E1_TEXT = 'ML-E1 hello from the welcome page'
const E2_TEXT = 'ML-E2 after the rebuild'
const E3_TEXT = 'ML-E3 held turn'

interface InitResult {
  success: boolean
  created: boolean
  provider: string
  model: string
  modelMetadata: { thinkingLevel?: string }
}

interface RuntimeInfo {
  model: { provider: string; id: string }
  thinkingLevel: string
  tools: Array<{ name: string; description: string }>
}

interface ListedTool {
  name: string
  declaredBy?: string
}

interface AgentRow {
  name: string
  displayName: string
}

interface ListedMessage {
  id: string
  role: string
  content: string
}

let app: E2EApp
let provider: FakeProvider
let recorder: EventRecorder
let chat: ChatPane
let models: ModelPickerPane
let tools: ToolPickerPane
let banner: StatusBannerPane
let providerId = ''
/** E-1 从欢迎页建出来的会话（E-2 / E-3 接着用） */
let sid = ''

// ─── IPC 助手 ───

const sessionIds = (): Promise<string[]> =>
  app.main.eval<string[]>(`window.api.session.list().then((rows) => rows.map((r) => r.id))`)

const storedTools = (id: string): Promise<unknown> =>
  app.main.eval(
    `window.api.session.getById(${JSON.stringify(id)}).then((s) => (s && s.settings ? s.settings.enabledTools : undefined))`
  )

const init = (id: string): Promise<InitResult> =>
  app.main.eval<InitResult>(`window.api.agent.init({ sessionId: ${JSON.stringify(id)} })`)

const runtimeInfo = (id: string): Promise<RuntimeInfo | null> =>
  app.main.eval(`window.api.agent.getInfo(${JSON.stringify(id)})`)

const setModel = (id: string, model: string): Promise<{ success: boolean }> =>
  app.main.eval(
    `window.api.agent.setModel(${JSON.stringify({ sessionId: id, provider: providerId, model })})`
  )

const setThinking = (id: string, level: string): Promise<{ success: boolean }> =>
  app.main.eval(`window.api.agent.setThinkingLevel(${JSON.stringify({ sessionId: id, level })})`)

const destroyAgent = (id: string): Promise<{ success: boolean }> =>
  app.main.eval(`window.api.agent.destroy(${JSON.stringify(id)})`)

const toolsList = (id?: string, options?: { profile: string }): Promise<ListedTool[]> =>
  app.main.eval<ListedTool[]>(
    `window.api.tools.list(${id === undefined ? 'undefined' : JSON.stringify(id)}${
      options ? `, ${JSON.stringify(options)}` : ''
    })`
  )

const listMessages = (id: string): Promise<ListedMessage[]> =>
  app.main.eval<ListedMessage[]>(`window.api.message.list(${JSON.stringify(id)})`)

const displayNameOf = async (name: string): Promise<string> => {
  const rows = await app.main.eval<AgentRow[]>('window.api.subAgent.list()')
  const row = rows.find((r) => r.name === name)
  expect(row, `builtin profile ${name}`).toBeDefined()
  return row!.displayName
}

/** skill 工具发给模型的描述 —— 其中的 `<name>…</name>` 就是这一次创建真正带上的 skill */
const skillDescription = (info: RuntimeInfo | null): string =>
  info?.tools.find((t) => t.name === 'skill')?.description ?? ''

/** 主对话发出的那一条请求（最后一条用户消息就是这句） */
const requestFor = (text: string): Promise<FakeRequest> =>
  until(
    () => provider.chatRequests().find((r) => r.lastUserText === text) ?? null,
    `request for "${text}"`
  )

/** 等本会话在 since 之后的 `agent_closing{closing:false}`（前端据它解除只读） */
async function waitClosed(id: string, since: number): Promise<void> {
  let ev = await recorder.waitFor<RecordedEvent>('agent_closing', { sessionId: id, since })
  while (ev.closing !== false) {
    ev = await recorder.waitFor<RecordedEvent>('agent_closing', { sessionId: id })
  }
}

/** 在当前会话里发一句并等这一轮跑完 */
async function sendAndWait(id: string, text: string): Promise<void> {
  const since = await recorder.mark()
  await chat.typeAndSend(text)
  await recorder.waitFor('agent_end', { sessionId: id, since })
  await chat.waitIdle()
}

beforeAll(async () => {
  app = await launchApp()
  await waitRendererReady(app.main)
  recorder = eventRecorder(app.main)
  await recorder.install()
  chat = chatPane(app.main)
  models = modelPickerPane(app.main)
  tools = toolPickerPane(app.main)
  banner = statusBannerPane(app.main)

  provider = await startFakeProvider()
  ;({ providerId } = await seedFakeProvider(app.main, {
    baseUrl: provider.baseUrl,
    modelId: MODEL_A
  }))
  // B 进同一个提供商，上下文同样给足（自动压缩阈值按 contextWindow 算）
  await app.main.eval(`(async () => {
    const providerId = ${JSON.stringify(providerId)}
    await window.api.provider.addModel({ providerId, modelId: ${JSON.stringify(MODEL_B)} })
    const row = (await window.api.provider.listModels(providerId)).find(
      (m) => m.modelId === ${JSON.stringify(MODEL_B)}
    )
    await window.api.provider.updateModelCapabilities({
      id: row.id,
      capabilities: { maxInputTokens: 200000, maxOutputTokens: 4096, vision: true }
    })
    return true
  })()`)
  seedSkill(app, SKILL_X, 'ml-x seeded skill')
}, 120_000)

afterAll(async () => {
  await app?.stop()
  await provider?.close()
})

describe('会话模型：欢迎页草稿 → 运行期只读 → 销毁重建', () => {
  it('E-1 欢迎页选 B / low / 勾 X 再发送：新会话第一轮就跑在 B 上，勾选与档位都落进去；之后两个选择器锁住', async () => {
    // ── 前置：停在欢迎页，一条会话都没有；两个选择器都在、都不锁 ──
    expect(await sessionIds()).toEqual([])
    await chat.ready()
    await until(models.present, 'model picker shows the seeded provider')
    await until(tools.present, 'tool picker on the welcome page')
    expect(await models.locked()).toBe(false)
    expect(await models.lockIndicatorVisible()).toBe(false)
    expect(await tools.locked()).toBe(false)

    // ── 欢迎页的声明项按 chat 画（直接发送新建的是无项目会话），与项目编辑页（work）不同 ──
    const chatName = await displayNameOf('chat')
    const workName = await displayNameOf('work')
    expect(chatName).not.toBe(workName)
    const welcomeList = await toolsList(undefined, { profile: 'chat' })
    expect(welcomeList.find((t) => t.name === DRAWING)?.declaredBy).toBe(chatName)
    expect((await toolsList()).find((t) => t.name === DRAWING)?.declaredBy).toBe(workName)

    await tools.open()
    const drawingRow = await until(
      async () => (await tools.items()).find((it) => it.name === DRAWING) ?? null,
      'drawing row in the welcome tool picker'
    )
    expect(drawingRow.declared).toBe(true)
    expect(drawingRow.checked).toBe(true)
    expect(drawingRow.title).toContain(chatName)

    // ── 界面里选 B、档位 low、勾 X：都只是草稿，一条会话也没建 ──
    expect(await tools.toggle(X)).toBe(true)
    await until(
      async () => (await tools.items()).find((it) => it.name === X)?.checked === true,
      'X ticked in the welcome draft'
    )
    await tools.close()
    expect(await models.pick(MODEL_B)).toBe(true)
    await until(async () => (await models.currentModel()) === MODEL_B, 'trigger shows model B')
    await models.pickThinking('low')
    await models.close()
    expect(await sessionIds()).toEqual([])

    // ── 发送：新会话出现、这一轮跑完 ──
    const since = await recorder.mark()
    await chat.typeAndSend(E1_TEXT)
    const ids = await until(
      async () => ((await sessionIds()).length === 1 ? await sessionIds() : null),
      'the welcome send created a session'
    )
    sid = ids[0]
    await recorder.waitFor('agent_end', { sessionId: sid, since })
    await chat.waitIdle()

    // ── IPC：选择在 agent 创建之前就落进了新会话 ──
    expect(await storedTools(sid)).toEqual([X])
    const afterSend = await init(sid)
    expect(afterSend.success).toBe(true)
    expect(afterSend.model).toBe(MODEL_B)
    expect(afterSend.provider).toBe(providerId)
    expect(afterSend.modelMetadata.thinkingLevel).toBe('low')
    expect(afterSend.created).toBe(true)
    expect((await requestFor(E1_TEXT)).body.model).toBe(MODEL_B)
    const info = await runtimeInfo(sid)
    expect(info?.model.id).toBe(MODEL_B)
    expect(skillDescription(info)).toContain(`<name>${SKILL_X}</name>`)
    expect(skillDescription(info)).toContain('<name>builtin:drawing</name>')

    // ── 界面：模型选择器显示 B 且锁、工具选择器锁、胶囊属 chat ──
    await until(async () => (await models.currentModel()) === MODEL_B, 'trigger still shows B')
    await until(models.locked, 'model picker locked once the runtime exists')
    expect(await models.lockIndicatorVisible()).toBe(true)
    expect(await models.triggerTitle()).not.toBe('')
    await until(tools.locked, 'tool picker locked once the runtime exists')
    const chip = await until(banner.chip, 'agent chip on the session banner')
    expect(chip.profile).toBe('chat')
  })

  it('E-2 运行期改模型被拒、档位照改；胶囊 X 销毁运行时 → 解锁、历史还在；换成 A 再发，新运行时跑在 A 上', async () => {
    expect(sid, 'E-1 created the session').not.toBe('')

    // ── 运行时在：改模型被拒、什么也没写；思考档位照常可改，运行时与会话树立即跟上 ──
    expect(await setModel(sid, MODEL_A)).toEqual({ success: false })
    expect((await init(sid)).model).toBe(MODEL_B)
    expect((await setThinking(sid, 'high')).success).toBe(true)
    expect((await runtimeInfo(sid))?.thinkingLevel).toBe('high')
    expect((await init(sid)).modelMetadata.thinkingLevel).toBe('high')

    // ── 界面：面板照常能展开，模型行禁用；硬点 A 什么也不写 ──
    await models.open()
    const rows = await models.items()
    expect(rows.map((r) => r.modelId).sort()).toEqual([MODEL_A, MODEL_B])
    for (const row of rows) {
      expect(row.disabled, row.key).toBe(true)
      expect(row.lockedLook, row.key).toBe(true)
      expect(row.title, row.key).not.toBe('')
    }
    expect(await models.pick(MODEL_A, { force: true })).toBe(true)
    expect(await models.isOpen()).toBe(true)
    expect((await init(sid)).model).toBe(MODEL_B)
    await models.close()

    // ── 胶囊上的 X：运行时没了、会话与历史都在，两个选择器解锁 ──
    const idsBefore = (await listMessages(sid)).map((m) => m.id)
    expect(idsBefore.length).toBeGreaterThan(0)
    const since = await recorder.mark()
    expect(await banner.clickChipDestroy()).toBe(true)
    await waitClosed(sid, since)
    await until(async () => (await banner.chip()) === null, 'agent chip gone after destroy')
    expect((await init(sid)).created).toBe(false)
    await until(async () => !(await models.locked()), 'model picker unlocked')
    await until(async () => !(await tools.locked()), 'tool picker unlocked')
    expect(await models.lockIndicatorVisible()).toBe(false)
    expect((await listMessages(sid)).map((m) => m.id)).toEqual(idsBefore)
    expect((await init(sid)).model).toBe(MODEL_B)

    // ── 解锁之后在界面里换成 A：写进会话树 ──
    expect(await models.pick(MODEL_A)).toBe(true)
    await until(async () => (await init(sid)).model === MODEL_A, 'session model switched to A')

    // ── 下一条消息按 A 重建运行时 ──
    await sendAndWait(sid, E2_TEXT)
    expect((await requestFor(E2_TEXT)).body.model).toBe(MODEL_A)
    expect((await runtimeInfo(sid))?.model.id).toBe(MODEL_A)
    await until(banner.chip, 'agent chip back after the rebuild')
    await until(models.locked, 'model picker locked again')
    await until(tools.locked, 'tool picker locked again')
  })

  it('E-3 运行中销毁：挂着的请求被中止、agent_closing 落定、对话回到空闲；用户消息已落库', async () => {
    expect(sid, 'E-1 created the session').not.toBe('')
    provider.script({
      text: ['ML-E3 partial '],
      holdMs: 30_000,
      when: (r) => r.lastUserText === E3_TEXT
    })

    const since = await recorder.mark()
    await chat.typeAndSend(E3_TEXT)
    const held = await requestFor(E3_TEXT)
    await until(() => provider.holding() || null, 'the E-3 turn is held at the provider')

    expect(await destroyAgent(sid)).toEqual({ success: true })
    await until(() => held.aborted || null, 'the held request was aborted by the destroy')
    await waitClosed(sid, since)
    await chat.waitIdle()
    expect((await init(sid)).created).toBe(false)
    const messages = await listMessages(sid)
    expect(messages.some((m) => m.role === 'user' && m.content === E3_TEXT)).toBe(true)
  })
})
