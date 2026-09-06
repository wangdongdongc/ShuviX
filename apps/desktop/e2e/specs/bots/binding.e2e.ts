/**
 * B · 绑定 —— 头部绑定胶囊（BotBindingChip）/ 遗留未绑定会话的 bind 对话框
 * （BotSessionDialog 的 bind 场合 → `session.setBot`）/ md 已删的绑定 / 一对一空态。
 *
 * 契约要点：
 *   - 一个聊天会话恰绑一个 bot（`settings.bot`）。群聊时代遗留的会话（只有 `settings.bots`
 *     名单、没有 `bot`）**没有做迁移**：仍是聊天会话（侧栏 bot 图标、无根、不可切档案），
 *     但视为未绑定 —— 发消息只落一条 system 行（`bot.noBotBound`，投影成 error_event 细行：
 *     不派发、不记未读、不建 .runs、不发 bot_activity），头部胶囊换成「选择 bot」按钮，
 *     走 bind 场合的对话框 → `session.setBot`。绑定写 `bot`，遗留的 `bots` 只读不动；
 *   - 绑定的 md 被删：胶囊灰显（data-bot-bound-missing、显示名回落身份键），发消息落一条
 *     署名的错误气泡（`bot.botGone`，botFailure），同样不派发；
 *   - 空态：至多一张介绍卡（显示名 + 一句话描述）+ 一行含显示名的提示；md 已删只剩提示行；
 *     有消息之后不出空态；普通会话没有 data-bot-empty。
 *
 * 零 LLM：需要 bot 回复的用例让 bot 指向只 `say` 一句的 `a4-members-probe`。
 * 双断纪律：IPC（message.list / session.getById / 事件录制器 / .runs 目录）先行，
 * DOM 只经 pages.ts 的 botSessionPane / botDialogPane / botFlowPane 断「屏幕上长出来了什么」。
 */
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchApp, type E2EApp } from '../../harness/launch'
import { until } from '../../harness/cdp'
import {
  createBotSession,
  createLegacyBotSession,
  eventRecorder,
  promptBotSession,
  waitRendererReady,
  writeBotMd,
  type EventRecorder,
  type RecordedEvent
} from '../../harness/seed'
import {
  botDialogPane,
  botFlowPane,
  botSessionPane,
  chatPane,
  sidebarPane,
  type BotDialogPane,
  type BotFlowPane,
  type BotSessionPane,
  type ChatPane,
  type SidebarPane
} from '../../harness/pages'

let app: E2EApp
let events: EventRecorder
let sidebar: SidebarPane
let chat: ChatPane
let dialog: BotDialogPane
let pane: BotSessionPane
let flow: BotFlowPane

/** 只 say 一句的探针管线（零 LLM） */
const PROBE = 'a4-members-probe'
const PROBE_MD = [
  '---',
  'shuvix: workflow v1',
  `name: ${PROBE}`,
  'description: binding e2e probe — say one line, zero LLM.',
  'shuvix-workflow-concurrency: parallel',
  '---',
  '',
  '绑定探针：只 say 一句。',
  '',
  '```js workflow',
  "await say(input.sayLine || 'ok')",
  "return { outcome: 'reply' }",
  '```',
  ''
].join('\n')

interface Msg {
  id: string
  role?: string
  type?: string
  content?: unknown
  metadata?: {
    sender?: { kind: string; name: string; displayName: string }
    botFailure?: unknown
  } | null
}

const listMessages = (sid: string): Promise<Msg[]> =>
  app.main.eval(`window.api.message.list(${JSON.stringify(sid)})`)

const getSettings = (sid: string): Promise<Record<string, unknown> | undefined> =>
  app.main.eval(`window.api.session.getById(${JSON.stringify(sid)}).then((s) => s && s.settings)`)

const unreadOf = async (sid: string): Promise<number> =>
  Number((await getSettings(sid))?.unreadCount ?? 0)

const getInfo = (sid: string): Promise<unknown> =>
  app.main.eval(`window.api.agent.getInfo(${JSON.stringify(sid)})`)

/** 该会话上录到的事件类型序列 */
async function typesFor(sid: string): Promise<string[]> {
  const all = await events.all<RecordedEvent>()
  return all.filter((e) => e.sessionId === sid).map((e) => e.type)
}

/** 该 bot 的 .runs 目录（决策记录 / run journal 都在这里；没派发过就没有这个目录） */
const runsDir = (bot: string): string => join(app.home, '.shuvix', 'bots', '.runs', bot)

/** 打开一个已存在的会话并等对话区就绪 */
async function open(title: string): Promise<void> {
  await until(async () => (await sidebar.titles()).includes(title), `session ${title} listed`)
  expect(await sidebar.openSession(title)).toBe(true)
  await chat.ready()
}

let sidLegacy: string // B2
let sidGone: string // B3
let sidEmpty: string // B5

beforeAll(async () => {
  app = await launchApp()
  await waitRendererReady(app.main)
  events = eventRecorder(app.main)
  await events.install()
  sidebar = sidebarPane(app.main)
  chat = chatPane(app.main)
  dialog = botDialogPane(app.main)
  pane = botSessionPane(app.main)
  flow = botFlowPane(app.main)

  const wfDir = join(app.home, '.shuvix', 'workflows')
  mkdirSync(wfDir, { recursive: true })
  writeFileSync(join(wfDir, `${PROBE}.md`), PROBE_MD)

  writeBotMd(app, 'legacy-x', {
    description: 'rebound after the group-chat era',
    displayName: 'LegacyX',
    pipeline: PROBE,
    botInput: { sayLine: 'legacy 报到' }
  })
  writeBotMd(app, 'gone', { description: 'md will be deleted', displayName: 'Gone' })
  // 空态语料：displayName ≠ name（B5 要证提示行与介绍卡显示的是 displayName）
  writeBotMd(app, 's-nova', {
    description: 'nova knows the repo',
    displayName: 'Nova星',
    pipeline: PROBE,
    botInput: { sayLine: 'nova 报到' }
  })
  writeBotMd(app, 'm-alpha', { description: 'member a', displayName: 'MemA' })

  sidLegacy = await createLegacyBotSession(app, { bots: ['legacy-x'], title: 'B2-legacy' })
  sidGone = await createBotSession(app.main, { bot: 'gone', title: 'B3-gone' })
  sidEmpty = await createBotSession(app.main, { bot: 's-nova', title: 'B5-empty' })
  await app.main.eval(`window.api.session.create({ title: 'B5-plain' })`)
  await createBotSession(app.main, { bot: 'm-alpha', title: 'B6-bound' })
  await app.main.eval(`window.api.session.create({ title: 'B6-plain' })`)
  await until(async () => (await sidebar.titles()).includes('B6-plain'), 'sessions listed')
}, 120_000)

afterAll(async () => {
  await app?.stop()
})

describe('遗留未绑定会话（B2）', () => {
  it('B2 发消息只落一条 system 行（不派发）；头部「选择 bot」→ bind 对话框 → setBot 写 bot、bots 不动；再发即由它应答', async () => {
    // ── 1. IPC，会话还没打开：未绑定 → 一条 system 行说明去头部选，其余什么都不发生
    await events.clear()
    const msgs = await promptBotSession(app.main, sidLegacy, 'hello?')
    expect(msgs).toHaveLength(2)
    expect(msgs[0]).toMatchObject({ role: 'user', content: 'hello?' })
    expect(msgs[1]).toMatchObject({ role: 'system_notify', type: 'error_event', metadata: null })
    expect(String(msgs[1].content)).toContain('no bot bound')

    // 事件：user_message 在前，随后那条 system 行以 assistant_message 广播（投影 type 是
    // error_event）；没有 bot_activity / bot_mailbox —— 根本没派发
    const types = await typesFor(sidLegacy)
    expect(types[0]).toBe('user_message')
    expect(types[1]).toBe('assistant_message')
    const broadcast = (await events.all<RecordedEvent & { message: string }>()).find(
      (e) => e.type === 'assistant_message' && e.sessionId === sidLegacy
    )!
    expect((JSON.parse(broadcast.message) as { type: string }).type).toBe('error_event')
    expect(types).not.toContain('bot_activity')
    expect(types).not.toContain('bot_mailbox')
    // 不派发 = 不建 .runs；system 行不是 bot 的回复 = 不记未读；仍然无根
    expect(existsSync(runsDir('legacy-x'))).toBe(false)
    expect(await unreadOf(sidLegacy)).toBe(0)
    expect(await getInfo(sidLegacy)).toBeNull()

    // ── 2. UI：仍是聊天会话（bot 图标），胶囊是未绑定形态，那条 system 行是细行，无空态
    await open('B2-legacy')
    expect(await sidebar.rowIsBot('B2-legacy')).toBe(true)
    await until(async () => (await pane.bindingChip()).present, 'binding chip mounted')
    expect(await pane.bindingChip()).toMatchObject({ unbound: true, bound: null })
    await until(async () => (await chat.errorRows()) === 1, 'system row rendered as error row')
    expect((await pane.emptyState()).present).toBe(false)

    // ── 3. 头部「选择 bot」→ bind 场合：不渲染项目区（会话归属早已定死）→ 点行即绑定
    expect(await pane.clickBind()).toBe(true)
    await dialog.waitOpen()
    expect(await dialog.mode()).toBe('bind')
    expect(await dialog.projectLabelText()).toBe('')
    expect(await dialog.noProjectHintShown()).toBe(false)
    expect(await dialog.pick('legacy-x')).toBe(true)
    await dialog.waitClosed()

    const settings = (await getSettings(sidLegacy))!
    expect(settings.bot).toBe('legacy-x')
    // 遗留键只读：绑定写 `bot`，`bots` 原样留着
    expect(settings.bots).toEqual(['legacy-x'])
    // 胶囊即时换成绑定形态，注册表落定后显示 displayName
    await until(async () => (await pane.bindingChip()).display === 'LegacyX', 'chip resolved')
    expect(await pane.bindingChip()).toMatchObject({
      bound: 'legacy-x',
      unbound: false,
      missing: false,
      display: 'LegacyX'
    })

    // ── 4. 绑定之后再发：这回真的派发，署名回复落库；老的 system 行还在（历史不改写）
    await events.clear()
    await promptBotSession(app.main, sidLegacy, 'again')
    // 走本地的带类型读法：署名要逐字段断，promptBotSession 的返回类型只到 metadata
    const reply = (await listMessages(sidLegacy)).find((m) => m.role === 'assistant')!
    expect(reply.metadata?.sender?.name).toBe('legacy-x')
    expect(reply.content).toBe('legacy 报到')
    expect(await typesFor(sidLegacy)).toContain('bot_activity')
    expect(await chat.errorRows()).toBe(1)
  })
})

describe('绑定的 md 已删（B3）', () => {
  it('B3 空态只剩提示行、胶囊带缺失标注；发消息落一条署名的错误气泡（botGone），不派发', async () => {
    // 在打开会话之前删：胶囊与空态都在挂载时拉一次注册表
    unlinkSync(join(app.botsDir, 'gone.md'))
    await open('B3-gone')

    // B3b：空态先于消息 —— md 已删就没有介绍卡，提示行回落身份键
    await until(async () => (await pane.emptyState()).present, 'empty state mounted')
    await until(async () => (await pane.emptyState()).card === null, 'no intro card')
    const empty = await pane.emptyState()
    expect(empty).toMatchObject({ present: true, unbound: false, card: null })
    expect(empty.hint).toContain('gone')

    // 胶囊：仍显示绑定，但带缺失标注、显示名回落身份键
    await until(async () => (await pane.bindingChip()).missing, 'missing badge on chip')
    expect(await pane.bindingChip()).toMatchObject({
      bound: 'gone',
      missing: true,
      display: 'gone'
    })

    await events.clear()
    const msgs = await promptBotSession(app.main, sidGone, 'anyone?')
    const replies = msgs.filter((m) => m.role === 'assistant')
    expect(replies).toHaveLength(1)
    // 可见结局纪律（设计 §9）：消息已经落库了，不能就这么没有下文 —— 署名给绑定的那个名字
    expect(replies[0].metadata?.botFailure).toBe(true)
    expect(replies[0].metadata?.sender).toEqual({ kind: 'bot', name: 'gone', displayName: 'gone' })
    expect(String(replies[0].content)).toContain('no longer in the bots folder')
    expect(String(replies[0].content)).toContain('gone')

    // DOM 只断视觉物，且与 IPC 断的是同一条消息（按 id 对齐）
    await until(async () => (await flow.messageFlags(replies[0].id)).failureBadge, 'failure badge')
    expect((await flow.messageFlags(replies[0].id)).bubbleClassName).toContain('border-error')

    // 根本没派发：没有活动事件、没有 .runs；有消息之后空态退场
    const types = await typesFor(sidGone)
    expect(types).not.toContain('bot_activity')
    expect(types).not.toContain('bot_mailbox')
    expect(existsSync(runsDir('gone'))).toBe(false)
    await until(async () => !(await pane.emptyState()).present, 'empty state gone')
  })
})

describe('一对一空态（B5）', () => {
  it('B5 绑定 bot 的介绍卡（displayName + 描述）与含显示名的提示；普通会话没有；发过消息后不出空态、看着即读', async () => {
    await open('B5-empty')
    await until(async () => (await pane.emptyState()).card?.display === 'Nova星', 'card resolved')
    const empty = await pane.emptyState()
    expect(empty).toMatchObject({
      present: true,
      unbound: false,
      card: { name: 's-nova', display: 'Nova星', description: 'nova knows the repo' }
    })
    // 提示行说的是显示名，不是身份键
    expect(empty.hint).toContain('Nova星')
    expect(empty.hint).not.toContain('s-nova')

    // 对照：普通空会话的空态没有 data-bot-empty（走通用引导）
    await open('B5-plain')
    expect((await pane.emptyState()).present).toBe(false)

    // 有消息之后不出空态；会话开着且被看着：回复到即读
    await open('B5-empty')
    await promptBotSession(app.main, sidEmpty, 'hi')
    await until(async () => !(await pane.emptyState()).present, 'empty state gone')
    await until(async () => (await unreadOf(sidEmpty)) === 0, 'watched session auto-read')
  })
})

describe('头部绑定胶囊（B6）', () => {
  it('B6 绑定会话：胶囊显示 displayName、无缺失标注、无「选择 bot」；普通会话没有胶囊', async () => {
    await open('B6-bound')
    // 注册表落定后胶囊显示 displayName（落定前是身份键）
    await until(async () => (await pane.bindingChip()).display === 'MemA', 'chip resolved')
    expect(await pane.bindingChip()).toEqual({
      present: true,
      bound: 'm-alpha',
      unbound: false,
      missing: false,
      display: 'MemA'
    })
    // 绑定之后胶囊是静态的：一对一会话不换人，没有「选择 bot」入口
    expect(await pane.clickBind()).toBe(false)

    await open('B6-plain')
    expect((await pane.bindingChip()).present).toBe(false)
  })
})
