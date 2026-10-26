/**
 * 会话模型与扩展能力的**当场重配**（2026-10-26，取代 2026-10-02 的「运行期只读」）与提示词缓存的确认。
 *
 *   - 欢迎页（还没有会话）上的模型 / 思考档位 / 扩展能力是**新会话的草稿**：直接发送时
 *     `createSessionForSend` 在 `agent.init` 之前把它们写进新会话，第一轮就跑在选的模型上；
 *     欢迎页的工具选择器按新会话将用的档案（无项目 → chat）画声明项（RE-1）；
 *   - 会话有 Agent 时两个选择器照常可改：`agent.setModel` / `session.updateEnabledTools` 写设置并当场
 *     重配那个 agent（同一个运行时，没有 agent_created / agent_closing），从下一次请求起生效 —— 运行中
 *     也是（RE-2 / RE-3 / RE-4）；
 *   - 缓存规则：界面改之前先问 `agent.previewChange`（只读）。这里的模型是自定义的 openai-completions
 *     提供商（没有兼容位 → `none`）：换模型、改工具都打穿缓存 → 弹一个确认框（`[data-cache-break-confirm]`），
 *     取消什么都不写；输入框与会话设置弹窗各挂一个宿主，同一时刻只画一个，压在弹窗上面（RE-4）；
 *   - 会话横幅 agent 胶囊上的 X（`agent.destroy`）仍是「整个重建」的出口：运行中销毁会中止这一轮（RE-5）。
 *
 * 断言优先走 IPC（session.getById / agent.init / agent.getInfo / agent.previewChange / message.list）与
 * 假提供商记下的请求（`body.model` 就是那一轮真正用的模型，`body.tools` 是那一轮真正提供的工具）；DOM 只
 * 断两个选择器可点、确认框的生灭与位置、胶囊在不在（pages.ts 的 modelPickerPane / toolPickerPane /
 * cacheBreakPane / sessionConfigPane / statusBannerPane）。请求按 `lastUserText` 认领：自动标题的 titler
 * 也会打到假提供商上，按下标取会取错。
 *
 * 夹具：假提供商的模型 A（种成默认）与 B（之后加进同一个提供商，同样 200k 上下文）；全局 skill X、Y。
 * 提供商是在实例启动之后才种的，欢迎页起初显示「选择模型」—— 用例在界面里显式选一次。
 * 五个用例共用一个实例、按顺序接力：RE-1 从欢迎页建出会话，之后的接着用它。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import ja from '@shuvix/chat-protocol/i18n/locales/ja.json'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
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
  cacheBreakPane,
  chatPane,
  modelPickerPane,
  sessionConfigPane,
  sidebarPane,
  statusBannerPane,
  toolPickerPane,
  type CacheBreakPane,
  type ChatPane,
  type ModelPickerPane,
  type SessionConfigPane,
  type SidebarPane,
  type StatusBannerPane,
  type ToolPickerPane
} from '../../harness/pages'

const MODEL_A = 'e2e-model-a'
const MODEL_B = 'e2e-model-b'
const SKILL_X = 'e2e-lr-x'
const SKILL_Y = 'e2e-lr-y'
const X = `skill:${SKILL_X}`
const Y = `skill:${SKILL_Y}`
/** 内置作图技能：chat 与 work 的 shuvix-tools 都声明了它（恒生效，不写进会话勾选） */
const DRAWING = 'skill:builtin:drawing'
/** RE-1 那一轮报的用量：预判里的 promptTokens 就是它（openai-completions：prompt 含缓存部分） */
const E1_PROMPT_TOKENS = 1234

const E1_TEXT = 'LR-E1 hello from the welcome page'
const E2_TEXT = 'LR-E2 after switching to A'
const E3_TEXT = 'LR-E3 a run that switches model half way'
const E4_TEXT = 'LR-E4 after ticking Y'
const E5_TEXT = 'LR-E5 held turn'

const LOCALES = [en, zh, ja]

interface InitResult {
  success: boolean
  created: boolean
  provider: string
  model: string
  enabledTools: string[]
  modelMetadata: { thinkingLevel?: string }
}

interface RuntimeInfo {
  model: { provider: string; id: string }
  thinkingLevel: string
  tools: Array<{ name: string; description: string }>
}

interface ChangePreview {
  locked: boolean
  cache: 'kept' | 'lost' | 'none'
  reasons: string[]
  promptTokens: number
}

interface StoredSettings {
  enabledTools?: string[]
  model?: { provider: string; modelId: string }
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
let cacheBreak: CacheBreakPane
let sessionConfig: SessionConfigPane
let sidebar: SidebarPane
let banner: StatusBannerPane
let providerId = ''
/** RE-1 从欢迎页建出来的会话（之后的用例接着用） */
let sid = ''

// ─── IPC 助手 ───

const sessionIds = (): Promise<string[]> =>
  app.main.eval<string[]>(`window.api.session.list().then((rows) => rows.map((r) => r.id))`)

const storedSettings = (id: string): Promise<StoredSettings> =>
  app.main.eval<StoredSettings>(
    `window.api.session.getById(${JSON.stringify(id)}).then((s) => (s && s.settings) || {})`
  )

const init = (id: string): Promise<InitResult> =>
  app.main.eval<InitResult>(`window.api.agent.init({ sessionId: ${JSON.stringify(id)} })`)

const runtimeInfo = (id: string): Promise<RuntimeInfo | null> =>
  app.main.eval(`window.api.agent.getInfo(${JSON.stringify(id)})`)

const previewChange = (
  id: string,
  change: { enabledTools?: string[]; provider?: string; model?: string } = {}
): Promise<ChangePreview> =>
  app.main.eval<ChangePreview>(
    `window.api.agent.previewChange(${JSON.stringify({ sessionId: id, ...change })})`
  )

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

/** skill 工具发给模型的描述 —— 其中的 `<name>…</name>` 就是这个 agent 此刻带着的 skill */
const skillDescription = (info: RuntimeInfo | null): string =>
  info?.tools.find((t) => t.name === 'skill')?.description ?? ''

/** 一次请求里 skill 工具的描述（OpenAI 形状：`{ type: 'function', function: { name, description } }`） */
const requestSkillDescription = (req: FakeRequest): string => {
  const tool = (req.body.tools ?? []).find(
    (t) => (t as { function?: { name?: string } }).function?.name === 'skill'
  ) as { function?: { description?: string } } | undefined
  return tool?.function?.description ?? ''
}

/**
 * 最后一条用户消息之后有没有工具结果 —— 同一轮的后续请求 lastUserText 不变，靠它区分这一轮的第一次请求
 * 与之后的（只看最后一条用户消息之后：更早几轮的工具结果也在历史里）
 */
const hasToolResult = (req: FakeRequest): boolean => {
  const messages = req.body.messages ?? []
  const lastUser = messages.map((m) => m.role).lastIndexOf('user')
  return messages.slice(lastUser + 1).some((m) => m.role === 'tool')
}

/** 主对话发出的那一条请求（最后一条用户消息就是这句，且是这一轮的第一次请求） */
const requestFor = (text: string): Promise<FakeRequest> =>
  until(
    () => provider.chatRequests().find((r) => r.lastUserText === text && !hasToolResult(r)) ?? null,
    `request for "${text}"`
  )

/** 本会话在 since 之后有没有运行时生灭的事件（重配不该有） */
async function lifecycleEventsSince(id: string, since: number): Promise<string[]> {
  return (await recorder.allSince<RecordedEvent>(since))
    .filter((e) => e.sessionId === id && (e.type === 'agent_created' || e.type === 'agent_closing'))
    .map((e) => e.type)
}

/** 等本会话在 since 之后的 `agent_closing{closing:false}` */
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

/** 确认框的说明以某个原因开头（三语之一；不钉界面语言） */
const startsWithReason = (
  description: string,
  key: 'reasonModel' | 'reasonTools' | 'reasonPrompt'
): boolean => LOCALES.some((l) => description.startsWith(l.cacheBreak[key]))

const isCacheBreakTitle = (title: string): boolean =>
  LOCALES.some((l) => title === l.cacheBreak.title)

beforeAll(async () => {
  app = await launchApp()
  await waitRendererReady(app.main)
  recorder = eventRecorder(app.main)
  await recorder.install()
  chat = chatPane(app.main)
  models = modelPickerPane(app.main)
  tools = toolPickerPane(app.main)
  cacheBreak = cacheBreakPane(app.main)
  sessionConfig = sessionConfigPane(app.main)
  sidebar = sidebarPane(app.main)
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
  seedSkill(app, SKILL_X, 'lr-x seeded skill')
  seedSkill(app, SKILL_Y, 'lr-y seeded skill')
}, 120_000)

afterAll(async () => {
  await app?.stop()
  await provider?.close()
})

describe('会话模型与扩展能力：欢迎页草稿 → 运行期当场重配 → 缓存确认 → 销毁', () => {
  it('RE-1 欢迎页选 B / low / 勾 X 再发送：新会话第一轮就跑在 B 上，勾选与档位都落进去；有了 agent 两个选择器照常可改', async () => {
    // ── 前置：停在欢迎页，一条会话都没有；两个选择器都在 ──
    expect(await sessionIds()).toEqual([])
    await chat.ready()
    await until(models.present, 'model picker shows the seeded provider')
    await until(tools.present, 'tool picker on the welcome page')

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

    // ── 界面里选 B、档位 low、勾 X：都只是草稿，一条会话也没建，也没有确认框 ──
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
    expect(await cacheBreak.count()).toBe(0)

    // ── 发送：新会话出现、这一轮跑完（这一轮报的用量就是之后预判里的「约 N tokens」） ──
    provider.script({
      text: 'LR-E1 answered',
      usage: { prompt: E1_PROMPT_TOKENS, completion: 8 },
      when: (r) => r.lastUserText === E1_TEXT
    })
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
    expect((await storedSettings(sid)).enabledTools).toEqual([X])
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

    // ── 界面：胶囊属 chat；两个选择器有了 agent 也照常可改（没有只读态） ──
    const chip = await until(banner.chip, 'agent chip on the session banner')
    expect(chip.profile).toBe('chat')
    await until(async () => (await models.currentModel()) === MODEL_B, 'trigger still shows B')
    await models.open()
    const rows = await models.items()
    expect(rows.map((r) => r.modelId).sort()).toEqual([MODEL_A, MODEL_B])
    for (const row of rows) expect(row.disabled, row.key).toBe(false)
    await models.close()
    await tools.open()
    const toolRows = await until(async () => {
      const items = await tools.items()
      return items.some((it) => it.name === Y) ? items : null
    }, 'tool picker rows listed with an agent')
    for (const row of toolRows) expect(row.disabled, row.name).toBe(false)
    expect(toolRows.find((it) => it.name === X)).toMatchObject({ checked: true })
    await tools.close()
  })

  it('RE-2 预判：不改 → kept（带上一轮的用量），换 A → lost[model]；界面换 A 先问，取消什么都不写，确认后当场换过去、下一条就跑在 A 上', async () => {
    expect(sid, 'RE-1 created the session').not.toBe('')

    // ── 预判（只读）：同样的配置保得住缓存；换模型一定保不住 ──
    expect(await previewChange(sid)).toEqual({
      locked: true,
      cache: 'kept',
      reasons: [],
      promptTokens: E1_PROMPT_TOKENS
    })
    expect(await previewChange(sid, { provider: providerId, model: MODEL_A })).toEqual({
      locked: true,
      cache: 'lost',
      reasons: ['model'],
      promptTokens: E1_PROMPT_TOKENS
    })
    // 预判什么都不写
    expect((await storedSettings(sid)).model?.modelId).toBe(MODEL_B)
    expect((await init(sid)).model).toBe(MODEL_B)

    // ── 思考档位不经确认，照常现场交给 agent ──
    expect((await setThinking(sid, 'high')).success).toBe(true)
    expect((await runtimeInfo(sid))?.thinkingLevel).toBe('high')
    expect((await init(sid)).modelMetadata.thinkingLevel).toBe('high')
    expect(await cacheBreak.count()).toBe(0)

    const since = await recorder.mark()

    // ── 界面里选 A：先弹确认框（原因 = 换模型，说明里带着上一轮的规模）；取消 → 什么都不写 ──
    expect(await models.pick(MODEL_A)).toBe(true)
    await cacheBreak.waitOpen()
    expect(await cacheBreak.count()).toBe(1)
    const shot = await cacheBreak.text()
    expect(isCacheBreakTitle(shot!.title), shot!.title).toBe(true)
    expect(startsWithReason(shot!.description, 'reasonModel'), shot!.description).toBe(true)
    // 「约 N tokens」按界面语言的千分位排版：只比数字
    expect(shot!.description.replace(/\D/g, '')).toContain(String(E1_PROMPT_TOKENS))
    await cacheBreak.cancel()
    expect((await storedSettings(sid)).model?.modelId).toBe(MODEL_B)
    expect((await init(sid)).model).toBe(MODEL_B)
    expect((await runtimeInfo(sid))?.model.id).toBe(MODEL_B)
    expect(await models.currentModel()).toBe(MODEL_B)

    // ── 再选 A、确认：同一个运行时当场换过去（不销毁、不重建），胶囊还在 ──
    expect(await models.pick(MODEL_A)).toBe(true)
    await cacheBreak.waitOpen()
    await cacheBreak.confirm()
    await until(async () => (await init(sid)).model === MODEL_A, 'session model switched to A')
    expect((await storedSettings(sid)).model).toEqual({ provider: providerId, modelId: MODEL_A })
    await until(
      async () => (await runtimeInfo(sid))?.model.id === MODEL_A,
      'the running agent switched to A'
    )
    await until(async () => (await models.currentModel()) === MODEL_A, 'trigger shows model A')
    expect((await init(sid)).created).toBe(true)
    expect(await banner.chip()).not.toBeNull()
    expect(await lifecycleEventsSince(sid, since)).toEqual([])

    // ── 下一条消息就跑在 A 上，仍是同一个运行时 ──
    await sendAndWait(sid, E2_TEXT)
    expect((await requestFor(E2_TEXT)).body.model).toBe(MODEL_A)
    expect(await lifecycleEventsSince(sid, since)).toEqual([])
    expect(await cacheBreak.count()).toBe(0)
  })

  it('RE-3 运行中换模型：挂着的这一次请求照旧用 A，写入在这一轮跑完之前就答 success，同一轮的下一次请求起用 B', async () => {
    expect(sid, 'RE-1 created the session').not.toBe('')
    // 第一次请求发一个 ls 调用后挂住；拿到工具结果的那一次（同一轮的第二次请求）正常作答
    provider.script(
      {
        toolCalls: [{ id: 'call_lr_e3_ls', name: 'ls', args: '{}' }],
        holdMs: 30_000,
        when: (r) => r.lastUserText === E3_TEXT && !hasToolResult(r)
      },
      { text: 'LR-E3 done', when: (r) => r.lastUserText === E3_TEXT && hasToolResult(r) }
    )

    const since = await recorder.mark()
    await chat.typeAndSend(E3_TEXT)
    const first = await requestFor(E3_TEXT)
    await until(() => provider.holding() || null, 'the first LR-E3 request is held')
    expect(first.body.model).toBe(MODEL_A)

    // 运行中改：不等这一轮，当场答 success（请求还挂着）
    expect(await setModel(sid, MODEL_B)).toEqual({ success: true })
    expect(provider.holding()).toBe(true)
    expect((await storedSettings(sid)).model?.modelId).toBe(MODEL_B)
    expect((await init(sid)).model).toBe(MODEL_B)

    provider.release()
    await recorder.waitFor('agent_end', { sessionId: sid, since })
    await chat.waitIdle()
    const followUp = await until(
      () =>
        provider.chatRequests().find((r) => r.lastUserText === E3_TEXT && hasToolResult(r)) ?? null,
      'the follow-up LR-E3 request with the ls result'
    )
    expect(first.aborted).toBe(false)
    expect(followUp.body.model).toBe(MODEL_B)
    expect(await lifecycleEventsSince(sid, since)).toEqual([])
    expect((await runtimeInfo(sid))?.model.id).toBe(MODEL_B)
  })

  it('RE-4 会话设置弹窗开在对话上：勾 Y 只弹一个确认框且压在弹窗上面；取消什么都不写，确认后当场带上 Y、下一条请求就有它', async () => {
    expect(sid, 'RE-1 created the session').not.toBe('')
    // 改工具在这个模型上（没有兼容位）一定打穿缓存
    expect(await previewChange(sid, { enabledTools: [X, Y] })).toMatchObject({
      locked: true,
      cache: 'lost',
      reasons: ['tools']
    })

    // 实例里只有这一条会话：侧栏上唯一的那一行就是它（标题由自动标题定，不钉）
    const title = await until(async () => {
      const titles = await sidebar.titles()
      return titles.length === 1 ? titles[0] : null
    }, 'the only sidebar row')
    await sidebar.pickRowMenu(title, 'session-config')
    await sessionConfig.waitOpen()
    expect(await sessionConfig.titleValue()).toBe(title)
    const items = await until(async () => {
      const shot = await sessionConfig.extItems()
      return shot.some((it) => it.key === Y) ? shot : null
    }, 'extension items listed in the dialog')
    // 有 agent 也整排可改，没有锁
    for (const item of items) {
      expect(item, item.key).toMatchObject({ disabled: false, lockedLook: false })
    }
    expect(await sessionConfig.lockIndicatorCount()).toBe(0)

    const since = await recorder.mark()

    // ── 勾 Y：两个宿主（输入框的、弹窗里的）同时挂着，只画一个框，而且点得到（不在弹窗下面） ──
    await sessionConfig.toggleExt(Y)
    await cacheBreak.waitOpen()
    expect(await cacheBreak.count()).toBe(1)
    expect(await cacheBreak.topmost()).toBe(true)
    const shot = await cacheBreak.text()
    expect(startsWithReason(shot!.description, 'reasonTools'), shot!.description).toBe(true)

    // ── 取消：设置不动、弹窗还开着、Y 仍未勾 ──
    await cacheBreak.cancel()
    expect(await sessionConfig.isOpen()).toBe(true)
    expect((await storedSettings(sid)).enabledTools).toEqual([X])
    await until(
      async () =>
        (await sessionConfig.extItems()).find((it) => it.key === Y)?.checked === false || null,
      'Y still unticked after cancel'
    )
    expect(skillDescription(await runtimeInfo(sid))).not.toContain(`<name>${SKILL_Y}</name>`)

    // ── 再勾、确认：落库，运行中的 agent 当场带上 Y（不销毁、不重建） ──
    await sessionConfig.toggleExt(Y)
    await cacheBreak.waitOpen()
    await cacheBreak.confirm()
    await until(
      async () =>
        JSON.stringify((await storedSettings(sid)).enabledTools) === JSON.stringify([X, Y]),
      'the dialog wrote [X, Y]'
    )
    await until(
      async () => skillDescription(await runtimeInfo(sid)).includes(`<name>${SKILL_Y}</name>`),
      'the running agent carries Y'
    )
    expect(skillDescription(await runtimeInfo(sid))).toContain(`<name>${SKILL_X}</name>`)
    expect((await init(sid)).enabledTools).toEqual([X, Y])
    expect(await lifecycleEventsSince(sid, since)).toEqual([])
    expect(await banner.chip()).not.toBeNull()
    await sessionConfig.close()
    expect(await cacheBreak.count()).toBe(0)

    // ── 下一条请求提供给模型的 skill 工具里就有 Y ──
    await sendAndWait(sid, E4_TEXT)
    const req = await requestFor(E4_TEXT)
    expect(requestSkillDescription(req)).toContain(`<name>${SKILL_Y}</name>`)
    expect(requestSkillDescription(req)).toContain(`<name>${SKILL_X}</name>`)
    expect(req.body.model).toBe(MODEL_B)
    expect(await lifecycleEventsSince(sid, since)).toEqual([])
  })

  it('RE-5 胶囊的 X 是「整个重建」的出口：运行中销毁 → 挂着的请求被中止、agent_closing 落定、对话回到空闲；用户消息已落库', async () => {
    expect(sid, 'RE-1 created the session').not.toBe('')
    // X 的悬停说明换成了新的那句（换模型 / 扩展能力用不着它）
    const chip = await until(banner.chip, 'agent chip on the session banner')
    expect(LOCALES.map((l) => l.panel.agentChipDestroy)).toContain(chip.destroyTitle)

    provider.script({
      text: ['LR-E5 partial '],
      holdMs: 30_000,
      when: (r) => r.lastUserText === E5_TEXT
    })

    const since = await recorder.mark()
    await chat.typeAndSend(E5_TEXT)
    const held = await requestFor(E5_TEXT)
    await until(() => provider.holding() || null, 'the LR-E5 turn is held at the provider')

    expect(await destroyAgent(sid)).toEqual({ success: true })
    await until(() => held.aborted || null, 'the held request was aborted by the destroy')
    await waitClosed(sid, since)
    await chat.waitIdle()
    expect((await init(sid)).created).toBe(false)
    await until(async () => (await banner.chip()) === null, 'agent chip gone after destroy')
    const messages = await listMessages(sid)
    expect(messages.some((m) => m.role === 'user' && m.content === E5_TEXT)).toBe(true)
    // 设置原样留着，下一次创建按它建
    expect(await storedSettings(sid)).toMatchObject({
      enabledTools: [X, Y],
      model: { provider: providerId, modelId: MODEL_B }
    })
  })
})
