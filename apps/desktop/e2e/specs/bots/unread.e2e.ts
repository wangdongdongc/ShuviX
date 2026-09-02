/**
 * A4 · 未读账本 —— bot 回复的会话侧账：落库 +1（updateSettings 顺带 touch updatedAt，
 * 上浮与未读同一笔账）、打开即读（useSessionInit）、看着即读（useAgentEvents 活跃分支）、
 * markRead 幂等短路（已 0 不写库 —— updatedAt 不动是它唯一的外显）。
 *
 * 两条建会话路径都要走到：IPC 直建（16-18）与侧栏对话框全流程（19）—— 打开即读挂在
 * 渲染端 useSessionInit 上，只测 IPC 建法等于没测「UI 建出来就已激活」那半边。
 *
 * 回复语料全程零 LLM：greeting 播种（16/19）与 `a4-unread-probe` 参数化管线（20/21，
 * preSayMs 撑出「发出去、人走了」的窗口）。
 *
 * 双断纪律：先 IPC（session.getById 的 settings.unreadCount / updatedAt）后 DOM
 * （sidebarPane.rowUnread 的 data-unread 徽标 + 标题加粗）。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchApp, type E2EApp } from '../../harness/launch'
import { sleep, until } from '../../harness/cdp'
import { createBotSession, waitRendererReady, writeBotMd } from '../../harness/seed'
import {
  botDialogPane,
  chatPane,
  sidebarPane,
  type BotDialogPane,
  type ChatPane,
  type SidebarPane
} from '../../harness/pages'

let app: E2EApp
let sidebar: SidebarPane
let chat: ChatPane
let dialog: BotDialogPane

const PROBE = 'a4-unread-probe'

/** 只 say 一句的最小管线；说话前的窗口由各 bot md 的 shuvix-bot-input 撑开 */
const PROBE_MD = [
  '---',
  'shuvix: workflow v1',
  `name: ${PROBE}`,
  'description: A4 unread e2e probe — say one line; pre-say window from shuvix-bot-input.',
  'shuvix-workflow-concurrency: parallel',
  '---',
  '',
  'A4 未读探针：可选延时窗 → say，零 LLM。v2 的脚本 API 只有 `say` / `turn`。',
  '',
  '```js workflow',
  'if (input.preSayMs) {',
  '  await sleep(input.preSayMs)',
  '}',
  "await say(input.sayLine || 'ok')",
  "return { outcome: 'reply' }",
  '```',
  ''
].join('\n')

interface SessionShot {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  settings: { bots?: string[]; unreadCount?: number | null }
}

const getSession = (sid: string): Promise<SessionShot> =>
  app.main.eval(`window.api.session.getById(${JSON.stringify(sid)})`)

const unreadOf = async (sid: string): Promise<number> =>
  (await getSession(sid)).settings.unreadCount ?? 0

const assistantCount = (sid: string): Promise<number> =>
  app.main.eval(
    `window.api.message.list(${JSON.stringify(sid)})
      .then((ms) => ms.filter((m) => m.role === 'assistant').length)`
  )

/** session.list 的 id 序 —— dao 按 updatedAt 降序，头部即「最新」 */
const sessionIds = (): Promise<string[]> =>
  app.main.eval<string[]>(`window.api.session.list().then((ss) => ss.map((s) => s.id))`)

const prompt = (sid: string, text: string): Promise<void> =>
  app.main.eval(
    `window.api.agent.prompt({ sessionId: ${JSON.stringify(sid)}, text: ${JSON.stringify(text)} })`
  )

const promptDetached = (sid: string, text: string): Promise<string> =>
  app.main.eval(
    `(window.api.agent.prompt({ sessionId: ${JSON.stringify(sid)}, text: ${JSON.stringify(text)} }).catch(() => undefined), 'sent')`
  )

async function newSessionsAfter(act: () => Promise<void>): Promise<string[]> {
  const before = await sessionIds()
  await act()
  const after = await sessionIds()
  return after.filter((id) => !before.includes(id))
}

let sid16: string

beforeAll(async () => {
  app = await launchApp()
  await waitRendererReady(app.main)
  sidebar = sidebarPane(app.main)
  chat = chatPane(app.main)
  dialog = botDialogPane(app.main)

  const wfDir = join(app.home, '.shuvix', 'workflows')
  mkdirSync(wfDir, { recursive: true })
  writeFileSync(join(wfDir, `${PROBE}.md`), PROBE_MD)

  writeBotMd(app, 'u-g1', { description: 'greeter one', displayName: 'G1', greeting: 'g1 报到' })
  writeBotMd(app, 'u-g2', { description: 'greeter two', displayName: 'G2', greeting: 'g2 报到' })
  writeBotMd(app, 'u-quick', {
    description: 'instant replier',
    displayName: 'Quick',
    pipeline: PROBE,
    botInput: { sayLine: '快答一句' }
  })
  writeBotMd(app, 'u-slow', {
    description: 'slow replier',
    displayName: 'Slow',
    pipeline: PROBE,
    // 「发出去、人切走」的观察窗：说话之前先睡，回复必然落在切走之后
    botInput: { sayLine: '迟到的回答', preSayMs: 4000 }
  })
}, 120_000)

afterAll(async () => {
  await app?.stop()
})

describe('未读账本（IPC 直建路径）', () => {
  // A4-16
  it('IPC 直建双 greeting 会话（不激活）：未读=2、行徽标 + 标题加粗、updatedAt 被同一笔账触碰', async () => {
    sid16 = await createBotSession(app.main, { bots: ['u-g1', 'u-g2'], title: 'A4-U16' })

    // IPC 先行：两条开场白各记一笔
    const s = await getSession(sid16)
    expect(s.settings.unreadCount).toBe(2)
    // 上浮与未读同一笔账：+1 走 updateSettings，dao 顺带 touch updatedAt。严格 `>` 会
    // 撞时钟毫秒分辨率（insert 与两笔账可落在同一毫秒），真正的「浮上来」在 A4-21 里
    // 以「收到回复的旧会话越过更新的会话」按列表次序断
    expect(s.updatedAt).toBeGreaterThanOrEqual(s.createdAt)

    // DOM：徽标 data-unread="2" + 标题加粗。不激活它 —— 点开即读会立刻清零
    await until(async () => (await sidebar.rowUnread('A4-U16'))?.badge === '2', 'unread badge 2')
    expect(await sidebar.rowUnread('A4-U16')).toEqual({ badge: '2', bold: true })
  })

  // A4-17
  it('openSession 点开 → 打开即读：unreadCount 归 0、徽标消失', async () => {
    expect(await sidebar.openSession('A4-U16')).toBe(true)

    await until(async () => (await unreadOf(sid16)) === 0, 'unread cleared on open')
    await until(async () => (await sidebar.rowUnread('A4-U16'))?.badge === null, 'badge gone')
    expect(await sidebar.rowUnread('A4-U16')).toEqual({ badge: null, bold: false })
  })

  // A4-18
  it('已读后再 markRead：success 且 updatedAt 不变（幂等不写库的外显）', async () => {
    expect(await unreadOf(sid16)).toBe(0)
    const before = (await getSession(sid16)).updatedAt
    // 幂等若失守（白写一遍 0），updateSettings 会 touch updatedAt —— 先让时钟确实前进，
    // 「不变」才分得出「没写」与「同毫秒里写了」
    await sleep(20)

    const res = await app.main.eval<{ success: boolean }>(
      `window.api.session.markRead(${JSON.stringify(sid16)})`
    )
    expect(res).toEqual({ success: true })
    expect((await getSession(sid16)).updatedAt).toBe(before)
    expect(await unreadOf(sid16)).toBe(0)
  })
})

describe('未读账本（侧栏 UI 全流程）', () => {
  // A4-19（含 A4-32 的一半：有 greeting 的聊天会话不出空态 —— 断在 members spec 的 24 号）
  it('对话框勾选两个 greeting 成员创建：激活后未读归 0、行无徽标', async () => {
    // 16 号用例的会话住在临时组 —— 组头已存在
    await sidebar.clickNewBotChat('temp')
    await dialog.waitOpen()
    expect(await dialog.toggle('u-g1')).toBe(true)
    expect(await dialog.toggle('u-g2')).toBe(true)

    const created = await newSessionsAfter(async () => {
      await dialog.create()
      await dialog.waitClosed()
    })
    expect(created).toHaveLength(1)
    const sid = created[0]

    // 开场白确实落了两条（未读账本的 +2 来源），随后创建即激活 → 打开即读清零
    await until(async () => (await assistantCount(sid)) === 2, 'greetings landed')
    await until(async () => (await unreadOf(sid)) === 0, 'unread cleared after activation')
    const title = (await getSession(sid)).title
    expect((await sidebar.rowUnread(title))?.badge).toBeNull()
  })
})

describe('未读账本（管线回复路径）', () => {
  // A4-20
  it('活跃即到即读：开着的 probe 会话说一句，回复落库后未读归 0（全程不切会话）', async () => {
    const sid = await createBotSession(app.main, { bots: ['u-quick'], title: 'A4-U20' })
    await until(async () => (await sidebar.titles()).includes('A4-U20'), 'row listed')
    expect(await sidebar.openSession('A4-U20')).toBe(true)
    await chat.ready()

    // 发出去之后不做任何会话切换 —— 「看着即读」只该由活跃分支触发
    await prompt(sid, '来一条')

    // 先断回复真的落了树，再断归 0：直接断 0 会在「还没 +1」的空窗里假绿
    await until(async () => (await assistantCount(sid)) >= 1, 'reply landed')
    await until(async () => (await unreadOf(sid)) === 0, 'watched session auto-read')
    expect((await sidebar.rowUnread('A4-U20'))?.badge).toBeNull()
  })

  // A4-21
  it('发消息趁 preSay 窗切走：say 后原会话长徽标并浮到切走目的地之上；切回清零', async () => {
    const sid = await createBotSession(app.main, { bots: ['u-slow'], title: 'A4-U21' })
    await until(async () => (await sidebar.titles()).includes('A4-U21'), 'row listed')
    expect(await sidebar.openSession('A4-U21')).toBe(true)
    await chat.ready()

    // 切走目的地建在发消息之前 —— 此刻它比 A4-U21 新（updatedAt 更大、列表更靠前）
    const awayId = await app.main.eval<string>(
      `window.api.session.create({ title: 'A4-U21-away' }).then((s) => s.id)`
    )
    await until(async () => (await sidebar.titles()).includes('A4-U21-away'), 'away listed')

    // 发出去（probe 先睡 4000ms 再说话），趁窗口切走
    await promptDetached(sid, '我先走了')
    expect(await sidebar.openSession('A4-U21-away')).toBe(true)

    // 回复落在「人不在」的会话上：+1 且不被任何人清
    await until(async () => (await assistantCount(sid)) >= 1, 'reply landed while away')
    await until(async () => (await unreadOf(sid)) === 1, 'unread bumped to 1')
    // 上浮与未读同一笔账：收到回复的旧会话越过更新的切走目的地
    const order = await sessionIds()
    expect(order.indexOf(sid)).toBeLessThan(order.indexOf(awayId))
    // DOM 徽标（IPC 已断实账，这里断呈现）
    await until(async () => (await sidebar.rowUnread('A4-U21'))?.badge === '1', 'badge on old row')

    // 切回 → 打开即读
    expect(await sidebar.openSession('A4-U21')).toBe(true)
    await until(async () => (await unreadOf(sid)) === 0, 'cleared on return')
    await until(async () => (await sidebar.rowUnread('A4-U21'))?.badge === null, 'badge gone')
  })
})
