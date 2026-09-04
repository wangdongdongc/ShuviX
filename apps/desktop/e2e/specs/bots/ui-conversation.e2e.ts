/**
 * A0 · Bot 会话最小可聊面 —— 会话渲染 + 输入门控（C 组）。
 *
 * 被测面：群聊气泡的署名头部（BotBubble 的 [data-bot-sender] + BotAvatar，视觉身份来自
 * chat-protocol 的 botColorFor/botInitial，spec 直接 import 同一实现算期望）、连续同一
 * bot 的**合并头部**、InputArea 的 isBotSession 门（档案选择器 / 上下文用量环 /
 * 工具选择器隐藏，ModelPicker 保留）、以及「永不锁输入」（聊天会话没有根 Agent，
 * 发送不置流式态）。
 *
 * v2 起 bot 的发言由 `BotBubble` 渲染（左对齐气泡）而不是 `AssistantBubble`（助手卡）：
 * 判据是 `metadata.sender`，只有聊天会话的消息带它。`data-bot-sender` 这个锚点没变，
 * 但它现在挂在整个气泡的根节点上，而不是卡头那一条。
 *
 * v3 没有开场白：气泡语料全部来自 `a0-say-probe` —— 一份零 LLM 的参数化探针管线
 * （sayLine / secondLine / preSayMs 读自各 bot md 的 `shuvix-bot-pipeline.input`），发一条用户消息
 * 换回一两句署名回复。假提供商只给普通会话对照用例的那一条文本回复用。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { botColorFor, botInitial } from '@shuvix/chat-protocol/utils/botIdentity'
import { sleep, until } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import { startFakeProvider, type FakeProvider } from '../../harness/fakeProvider'
import {
  createBotSession,
  eventRecorder,
  seedFakeProvider,
  waitRendererReady,
  writeBotMd,
  type EventRecorder
} from '../../harness/seed'
import {
  chatPane,
  hexToRgb,
  sidebarPane,
  type ChatPane,
  type SidebarPane
} from '../../harness/pages'

const MODEL = 'e2e-model'

// 成员表：displayName 用 CJK / emoji 压码点切分（botInitial 按码点取首字）
const CN = { name: 'ui-cn', display: '小助手', line: '大家好，我是小助手' }
const EMOJI = { name: 'ui-emoji', display: '😀 Bot', line: 'emoji bot 报到' }

/** 参数化探针管线：可选延时 → say 一句 → 可选再 say 一句，零 LLM */
const PROBE = 'a0-say-probe'
const PROBE_MD = [
  '---',
  'shuvix: workflow v1',
  `name: ${PROBE}`,
  'description: A0 e2e probe — say one or two lines; knobs from shuvix-bot-pipeline.input.',
  'shuvix-workflow-concurrency: parallel',
  '---',
  '',
  'A0 探针：sayLine（必说）/ secondLine（连说第二句，合并头部要有连续同署名的消息才看得见）/',
  'preSayMs（说话前先睡，让两个成员的落库顺序可控）。',
  '',
  '```js workflow',
  'if (input.preSayMs) await sleep(input.preSayMs)',
  "await say(input.sayLine || 'ok')",
  'if (input.secondLine) await say(input.secondLine)',
  "return { outcome: 'reply' }",
  '```',
  ''
].join('\n')

let app: E2EApp
let provider: FakeProvider
let events: EventRecorder
let chat: ChatPane
let sidebar: SidebarPane
let sidBots = ''
let sidPlain = ''

interface Msg {
  id: string
  role?: string
  content?: unknown
  metadata?: { sender?: { kind: string; name: string; displayName: string } } | null
}

const listMessages = (sid: string): Promise<Msg[]> =>
  app.main.eval(`window.api.message.list(${JSON.stringify(sid)})`)

/** 经 IPC 发一条消息（聊天会话的 prompt 直到 cohort 收尾才 resolve —— 回复此刻已落库） */
const prompt = (sid: string, text: string): Promise<void> =>
  app.main.eval(
    `window.api.agent.prompt({ sessionId: ${JSON.stringify(sid)}, text: ${JSON.stringify(text)} })`
  )

beforeAll(async () => {
  app = await launchApp()
  provider = await startFakeProvider()
  await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  await waitRendererReady(app.main)
  events = eventRecorder(app.main)
  await events.install()
  chat = chatPane(app.main)
  sidebar = sidebarPane(app.main)

  const wfDir = join(app.home, '.shuvix', 'workflows')
  mkdirSync(wfDir, { recursive: true })
  writeFileSync(join(wfDir, `${PROBE}.md`), PROBE_MD)

  writeBotMd(app, CN.name, {
    description: 'cjk display bot',
    displayName: CN.display,
    pipeline: PROBE,
    botInput: { sayLine: CN.line }
  })
  writeBotMd(app, EMOJI.name, {
    description: 'emoji display bot',
    displayName: EMOJI.display,
    pipeline: PROBE,
    // 晚一拍说话：两条回复的落库序因此确定（CN 在前）
    botInput: { sayLine: EMOJI.line, preSayMs: 1200 }
  })
  writeBotMd(app, 'ui-twice', {
    description: 'says two lines in a row',
    displayName: 'Twice',
    pipeline: PROBE,
    botInput: { sayLine: '第二句', secondLine: '第三句' }
  })

  // 双成员聊天会话 + 普通会话对照；显式标题 —— 既是侧栏定位锚，
  // 也让 auto-title 的 isDefaultTitle 条件不成立（titler 不会来消费脚本队列）
  sidBots = await createBotSession(app.main, {
    bots: [CN.name, EMOJI.name],
    title: 'C-bots'
  })
  sidPlain = await app.main.eval<string>(
    `window.api.session.create({ title: 'C-plain' }).then((s) => s.id)`
  )
  // session.listChanged 广播会把两条会话带进侧栏
  await until(async () => {
    const titles = await sidebar.titles()
    return titles.includes('C-bots') && titles.includes('C-plain')
  }, 'seed sessions listed in sidebar')
}, 120_000)

afterAll(async () => {
  await app?.stop()
  await provider?.close()
})

describe('署名气泡与视觉身份', () => {
  // A0-20
  it('每条回复气泡带 [data-bot-sender]，document 序 = 落库序，头部文本 = displayName', async () => {
    expect(await sidebar.openSession('C-bots')).toBe(true)
    await chat.ready()
    // v3 没有开场白：会话此刻是空的，发一句换回两个成员各一句
    expect(await listMessages(sidBots)).toEqual([])
    await prompt(sidBots, '你们好')
    await chat.waitItems(3)

    const senders = await chat.botSenders()
    // CN 即答、EMOJI 晚一拍 —— 落库序即 document 序
    expect(senders.map((s) => s.name)).toEqual([CN.name, EMOJI.name])
    expect(senders.map((s) => s.display)).toEqual([CN.display, EMOJI.display])
    // 两条来自不同 bot，谁也不合并头部
    expect(senders.map((s) => s.merged)).toEqual([false, false])

    // 与 message.list 的 metadata.sender 逐条对照（DOM 只是那份数据的呈现）
    const listed = (await listMessages(sidBots)).filter((m) => m.role === 'assistant')
    expect(listed.map((m) => m.metadata?.sender?.name)).toEqual(senders.map((s) => s.name))
    expect(listed.map((m) => m.metadata?.sender?.displayName)).toEqual(
      senders.map((s) => s.display)
    )
    expect(listed.map((m) => m.content)).toEqual([CN.line, EMOJI.line])
  })

  // A0-21 —— 期望值 import 同一份 botIdentity 实现来算；颜色 hex→rgb 精确比较
  it('BotAvatar 背景色 === botColorFor(name)，头像字 === botInitial(displayName)', async () => {
    const senders = await chat.botSenders()
    expect(senders).toHaveLength(2)
    for (const s of senders) {
      expect(s.avatarBg).toBe(hexToRgb(botColorFor(s.name)))
      expect(s.avatarInitial).toBe(botInitial(s.display))
    }
    // 码点压轴：CJK 取整字，emoji 代理对不劈
    expect(senders.map((s) => s.avatarInitial)).toEqual(['小', '😀'])
  })

  /**
   * v2 新增：连续同一个 bot 的消息合并头部（IM 惯例）。
   *
   * 只有跑起来才测得到 —— 折叠规则本身是纯逻辑（`conversationItems` 有单测），但
   * 「合并之后屏幕上到底还剩什么」取决于 `BotBubble` 是否真的把头像与显示名整块略掉，
   * 而那一层只在真渲染里存在。
   *
   * 两半一起钉：**连续才合并**，中间夹一条用户消息就重新起头 —— 后半条是这条规则的
   * 全部意义所在（合并的是「同一个人接着说」，不是「同一个人说过」）。
   */
  it('A0-20b 连续同一 bot 合并头部；中间夹一条用户消息即重新起头', async () => {
    const sid = await createBotSession(app.main, { bots: ['ui-twice'], title: 'C-merge' })
    await until(async () => (await sidebar.titles()).includes('C-merge'), 'merge session listed')
    expect(await sidebar.openSession('C-merge')).toBe(true)
    await chat.ready()

    // 探针每次连说两句：第一轮 → 第二句(bot) 第三句(bot)；夹一条用户消息；第二轮再来两句 ——
    // 于是气泡序是：bot(头) bot(并) user bot(头) bot(并)
    await prompt(sid, '说两句')
    await until(async () => (await chat.botSenders()).length >= 2, 'two bubbles from one bot')
    await prompt(sid, '再说两句')
    await until(async () => (await chat.botSenders()).length >= 4, 'four bubbles from one bot')

    const senders = await chat.botSenders()
    expect(senders).toHaveLength(4)
    expect(senders.every((s) => s.name === 'ui-twice')).toBe(true)
    // 第二句：头一条，带头部
    expect(senders[0]).toMatchObject({ merged: false, display: 'Twice' })
    expect(senders[0].avatarInitial).toBe(botInitial('Twice'))
    // 第三句：紧接着第二句，合并 —— 头像与显示名整块消失，只剩气泡
    expect(senders[1].merged).toBe(true)
    expect(senders[1].display).toBe('')
    expect(senders[1].avatarInitial).toBe('')
    // 第二轮的第二句：与上一条 bot 消息之间隔着用户消息 —— **不合并**，头部照常出
    expect(senders[2]).toMatchObject({ merged: false, display: 'Twice' })
    // 第二轮的第三句：再次合并
    expect(senders[3].merged).toBe(true)
  })
})

describe('输入卡工具行的 isBotSession 门', () => {
  // A0-22
  it('普通会话对照：档案选择器与上下文环在屏；假回复的 assistant 卡无署名卡头', async () => {
    expect(await sidebar.openSession('C-plain')).toBe(true)
    await chat.ready()

    // 档案选择器（工具行内含 bot 图标的按钮）挂载即在；三个选择器齐活
    expect(await chat.profilePickerPresent()).toBe(true)
    expect(await chat.pickerCount()).toBe(3)
    // 上下文环等 useSessionInit 把模型能力（maxInputTokens=200000）同步进 store 后出现；
    // 环不出 = caps 前置没立起来，修前置而不是弱化断言
    await until(() => chat.ctxRingPresent(), 'context ring visible (caps synced)')

    provider.reset()
    await events.clear()
    provider.script({ text: '对照回答', usage: { prompt: 120, completion: 6 } })

    await chat.type('对照 ping')
    // 发送键亮起 = activeModel 已同步（handleSend 对无模型静默丢弃，不能抢跑）
    await until(async () => !(await chat.sendDisabled()), 'send enabled (model synced)')
    await chat.pressEnter()
    await events.waitFor('agent_end', { sessionId: sidPlain })
    await chat.waitIdle()

    const items = await chat.settledItems()
    expect(items.some((i) => i.role === 'assistant' && i.text === '对照回答')).toBe(true)
    // 普通会话的 assistant 卡没有署名（它走 AssistantBubble，不是群聊气泡）
    expect(await chat.botSenders()).toEqual([])
  })

  // A0-23
  it('切到 Bot 会话：档案选择器 / 环 / 工具选择器都消失，只剩 ModelPicker', async () => {
    expect(await sidebar.openSession('C-bots')).toBe(true)
    await chat.ready()

    expect(await chat.profilePickerPresent()).toBe(false)
    expect(await chat.ctxRingPresent()).toBe(false)
    expect(await chat.modelPickerPresent()).toBe(true)
    // v2 新增的一道门：ToolPicker 也隐藏 —— 任务段的工具来自 task 槽位那份 agent md，
    // 会话级的工具勾选在这里不表达任何东西。三个选择器只剩一个 = 两个都没了
    expect(await chat.pickerCount()).toBe(1)
  })
})

describe('永不锁输入', () => {
  // A0-24 —— 两次发送背靠背，中间不等事件、不加 waitIdle
  it('背靠背发两条：每发后即不忙、输入清空；落定后两条 user 在库、无错误行、无流式占位卡', async () => {
    provider.reset()
    await events.clear()

    // 两个成员都是零 LLM 的探针（各答一句）：回复来源与「锁不锁」无关，锁的判据只有
    // 「发送有没有置流式态」
    const sidLock = await createBotSession(app.main, {
      bots: [CN.name, EMOJI.name],
      title: 'C-lock'
    })
    await until(async () => (await sidebar.titles()).includes('C-lock'), 'lock session listed')
    expect(await sidebar.openSession('C-lock')).toBe(true)
    await chat.ready()

    // 第一条前等发送键亮起（模型同步是发送的前置，不是两次发送之间的间隔）
    await chat.type('lock probe one')
    await until(async () => !(await chat.sendDisabled()), 'send enabled (model synced)')
    await chat.pressEnter()
    expect(await chat.isBusy()).toBe(false)
    expect(await chat.inputValue()).toBe('')

    // 第二条紧跟着发 —— 不等任何事件、不 waitIdle
    await chat.typeAndSend('lock probe two')
    expect(await chat.isBusy()).toBe(false)
    expect(await chat.inputValue()).toBe('')

    // 落定（探针说完）后复查：依旧不忙、两条 user 都在库里、没有错误行
    await sleep(3000)
    expect(await chat.isBusy()).toBe(false)
    const users = (await listMessages(sidLock))
      .filter((m) => m.role === 'user')
      .map((m) => m.content)
    expect(users).toEqual(['lock probe one', 'lock probe two'])
    expect(await chat.errorRows()).toBe(0)
    // 流式合成占位卡从未出现（聊天会话不置流式态）
    const items = await chat.items()
    expect(items.some((i) => i.id === 'streaming-live')).toBe(false)
  })
})
