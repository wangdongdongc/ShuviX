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
 * 模型侧：假提供商只喂两类脚本 —— 普通会话对照用例的一条文本回复、
 * 永不锁用例的四次 `next` 门控裁决（全 ignore，管线不产出任何可见回复）。
 * 开场白与署名本身全程无 LLM。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { botColorFor, botInitial } from '@shuvix/chat-protocol/utils/botIdentity'
import { sleep, until } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import { startFakeProvider, type FakeProvider, type FakeRequest } from '../../harness/fakeProvider'
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
const CN = { name: 'ui-cn', display: '小助手' }
const EMOJI = { name: 'ui-emoji', display: '😀 Bot' }

/** 合并头部用的探针管线：一次 run 里连说两句，零 LLM */
const TWICE_PIPELINE = 'a0-twice-probe'
const TWICE_MD = [
  '---',
  'shuvix: workflow v1',
  `name: ${TWICE_PIPELINE}`,
  'description: A0 e2e probe — say two lines in a row so the merged header has something to merge.',
  'shuvix-workflow-concurrency: parallel',
  '---',
  '',
  '连说两句的探针：合并头部要有连续同署名的消息才看得见。',
  '',
  '```js workflow',
  "await say('第二句')",
  "await say('第三句')",
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

/** 一次门控裁决脚本：按提示词里出现的 displayName 认领（双 bot 并发下必须按内容认） */
const ignoreGate = (displayName: string): Parameters<FakeProvider['script']>[0] => ({
  toolCalls: [
    {
      id: 'call_next',
      name: 'next',
      args: JSON.stringify({ decision: 'ignore', reason: 'e2e 永不锁用例' })
    }
  ],
  usage: { prompt: 150, completion: 10 },
  when: (r: FakeRequest) => !r.isTitle && r.raw.includes(displayName)
})

beforeAll(async () => {
  app = await launchApp()
  provider = await startFakeProvider()
  await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  await waitRendererReady(app.main)
  events = eventRecorder(app.main)
  await events.install()
  chat = chatPane(app.main)
  sidebar = sidebarPane(app.main)

  writeBotMd(app, CN.name, {
    description: 'cjk display bot',
    displayName: CN.display,
    greeting: '大家好，我是小助手'
  })
  writeBotMd(app, EMOJI.name, {
    description: 'emoji display bot',
    displayName: EMOJI.display,
    greeting: 'emoji bot 打个招呼'
  })
  const wfDir = join(app.home, '.shuvix', 'workflows')
  mkdirSync(wfDir, { recursive: true })
  writeFileSync(join(wfDir, `${TWICE_PIPELINE}.md`), TWICE_MD)
  writeBotMd(app, 'ui-twice', {
    description: 'says three lines in a row',
    displayName: 'Twice',
    pipeline: TWICE_PIPELINE,
    greeting: '第一句'
  })

  // 双成员带开场白的聊天会话 + 普通会话对照；显式标题 —— 既是侧栏定位锚，
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
  it('每条开场白气泡带 [data-bot-sender]，document 序 = 名单序，头部文本 = displayName', async () => {
    expect(await sidebar.openSession('C-bots')).toBe(true)
    await chat.ready()
    await chat.waitItems(2)

    const senders = await chat.botSenders()
    expect(senders.map((s) => s.name)).toEqual([CN.name, EMOJI.name])
    expect(senders.map((s) => s.display)).toEqual([CN.display, EMOJI.display])
    // 两条来自不同 bot，谁也不合并头部
    expect(senders.map((s) => s.merged)).toEqual([false, false])

    // 与 message.list 的 metadata.sender 逐条对照（DOM 只是那份数据的呈现）
    const listed = await listMessages(sidBots)
    expect(listed.map((m) => m.metadata?.sender?.name)).toEqual(senders.map((s) => s.name))
    expect(listed.map((m) => m.metadata?.sender?.displayName)).toEqual(
      senders.map((s) => s.display)
    )
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

    // 会话此刻只有开场白「第一句」。发一条用户消息后探针再连说两句 ——
    // 于是消息序是：第一句(bot) → 说两句(user) → 第二句(bot) → 第三句(bot)
    await app.main.eval(
      `window.api.agent.prompt({ sessionId: ${JSON.stringify(sid)}, text: '说两句' })`
    )
    await until(async () => (await chat.botSenders()).length >= 3, 'three bubbles from one bot')

    const senders = await chat.botSenders()
    expect(senders.every((s) => s.name === 'ui-twice')).toBe(true)
    // 第一句：本来就是头一条，带头部
    expect(senders[0]).toMatchObject({ merged: false, display: 'Twice' })
    expect(senders[0].avatarInitial).toBe(botInitial('Twice'))
    // 第二句：与第一句之间隔着用户消息 —— **不合并**，头部照常出
    expect(senders[1]).toMatchObject({ merged: false, display: 'Twice' })
    // 第三句：紧接着第二句，合并 —— 头像与显示名整块消失，只剩气泡
    expect(senders[2].merged).toBe(true)
    expect(senders[2].display).toBe('')
    expect(senders[2].avatarInitial).toBe('')
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
    // v2 新增的一道门：ToolPicker 也隐藏 —— 任务段的 agent 就是 bot 自己，工具来自它 md 里的
    // `shuvix-tools`，会话级的工具勾选在这里不表达任何东西。三个选择器只剩一个 = 两个都没了
    expect(await chat.pickerCount()).toBe(1)
  })
})

describe('永不锁输入', () => {
  // A0-24 —— 两次发送背靠背，中间不等事件、不加 waitIdle
  it('背靠背发两条：每发后即不忙、输入清空；落定后两条 user 在库、无错误行、无流式占位卡', async () => {
    provider.reset()
    await events.clear()
    // 2 条消息 × 2 个成员 = 至多 4 次门控，全部 ignore（管线安静收场，不产出可见回复）
    provider.script(
      ignoreGate(CN.display),
      ignoreGate(CN.display),
      ignoreGate(EMOJI.display),
      ignoreGate(EMOJI.display)
    )

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

    // 落定（门控跑完）后复查：依旧不忙、两条 user 都在库里、没有错误行
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
