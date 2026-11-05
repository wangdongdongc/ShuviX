/**
 * 询问卡片搬进对话流、答完留下记录（chat-ui PendingInputsCard / AnswerRecords，host wrapToolOutput）的整条链路：
 * 真应用 + 假模型 + 真布局。数字键、滚轮、点提示都是 CDP 可信输入 —— 把关量的是真位置。
 *
 *   E-1  人在底部时来一张审批：卡片在列表 Footer（不在输入卡片里），整张露着（真位置），输入卡片没有语义色、没被撑高
 *   E-2  真滚轮翻上去之后才来卡片：滚动位置 600ms 不动；提示真的露着（aria-hidden + opacity），在输入卡片上方
 *   E-3  卡片不在屏幕上：可信的 1 不答、不进输入框、不发请求
 *   E-4  真点提示：卡片整张露出来，提示藏回去
 *   E-5  卡片露着：可信的 1 答了，发下一个请求，工具行上留下 allowed
 *   E-6  焦点在输入框里打 1：是打字，卡片还等着
 *   E-7  草稿长到卡片放不下（输入卡片封顶 480px）：卡片被压住，可信的 1 不答
 *   E-8  选择题：选 + 确认 → [data-ask-record]；展开看全部选项，对勾只在选中的；模型收到 `User selected: X`
 *   E-9  在卡片最后一行写字、回车：反馈记录；提示语在那一行，输入框是 steer 的提示语；message.list 没有多一条用户消息；
 *        工具行没有行首红叉
 *   E-10 拒绝：denied 那行；status error；没有行首红叉。对照：同一轮另一个 read 自己失败（没有卡片）照旧红叉
 *   E-11 允许并记住：remembered + 路径；再读同一路径不问、没有记录
 *   E-12 步骤组：人答过的调用与 ask 不进合并行，普通 read 照旧并
 *   E-13 模型隔离：所有请求里没有 shuvixAnswers / 记录文字 / selections 键；反馈只在工具结果里
 *   E-14 重载：记录与实时一模一样，开关照样好用
 *   E-15 从记录所在的回复分支：分支里记录一样；分支的下一次请求同样不带记录
 *   E-16 回退：退到那一轮之前记录没了；两轮的会话退到后一轮，前一轮的记录还在
 *   E-17 卡片等着时中止：卡片没了，那一行没有记录；重载之后也没有
 *   E-18 脱敏：模型用占位符路径 read、人选记住：那行只有文字没有路径；message.list 与会话存储里都没有真值
 *   E-19 respondToInput 带非空 secrets（卡片那一行不再有胶囊，这条保住宿主那条路）：那行是占位符标记；存储与请求里都没有真值
 *   E-20 手机（web 客户端 390×844 + 触屏）：审批在列表里；1 不答；提示在宽度内、输入卡片上方；点提示露出卡片；点选项答了；
 *        记录在；开关 ≥ 32px 高
 *   E-21 卡片挂着时切走再切回，两次：卡片露着，提示藏着
 *   E-26 选择题又勾又写：这一行没有自己的键，底部发送；模型收到两样，记录两样都在；带要藏的值：存储与请求里都没有真值
 *   E-22 卡片挂着时在输入框回车：进队列（队列面板有它），卡片还在且整张露着、提示藏着（队列细条把输入卡片撑高，列表跟着让），
 *        请求数不动；允许之后模型收到这条消息
 *   E-23 焦点在卡片那一行按可信的 1：是打字，卡片还等着
 *   E-24 卡片那一行写八行：高度封顶 120，这一行的底不被输入卡片压住
 *   E-25 卡片露着时输入框长高：列表跟着让、卡片还整张露着；清空（变矮）列表不动，还在底；人翻上去、卡片没露全时输入框长高：
 *        滚动位置不动
 *
 * 前置：读 `app.home/outside/` 里的文件走 ask-on-external-path#0（家目录里、会话目录外）。读 /private/tmp 下的文件不问。
 * 自动审查在 harness 里是关的。一条长会话贯穿 E-1..E-14，用例之间有先后，不能单独跑。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sleep, until } from '../../harness/cdp'
import { syncProbe, type SyncProbe } from '../../harness/sync'
import { startFakeProvider, type FakeProvider, type FakeRequest } from '../../harness/fakeProvider'
import { freePort, launchApp, type E2EApp } from '../../harness/launch'
import { openWebClient, type WebClientHandle } from '../../harness/networkFixtures'
import {
  chatPane,
  conversationScrollPane,
  inlineAskPane,
  sidebarPane,
  webMobilePane,
  type ChatPane,
  type ConversationScrollPane,
  type InlineAskPane,
  type SidebarPane
} from '../../harness/pages'
import { durableStoragePathOf, seedFakeProvider, waitRendererReady } from '../../harness/seed'

const MODEL = 'e2e-model'
const USAGE = { prompt: 90, completion: 10 }
const MAIN = 'Inline main'
const QUESTION = 'Which package?'
const OPTIONS = [
  { label: 'arm64 only', description: 'The fastest' },
  { label: 'Both', description: 'Takes twice as long' },
  { label: 'Everything', description: '' }
]
const FEEDBACK_WORDS = 'open a branch before deploying'
const LONG = Array.from(
  { length: 40 },
  (_, i) => `Paragraph ${i + 1}: a long reply so the conversation has to scroll.`
).join('\n\n')

let app: E2EApp
let provider: FakeProvider
let chat: ChatPane
let sidebar: SidebarPane
let ask: InlineAskPane
let scroll: ConversationScrollPane
let probe: SyncProbe
let web: WebClientHandle | undefined
let outside = ''
let freeDir = ''
const sids: Record<string, string> = {}

const inOutside = (name: string): string => {
  const path = join(outside, name)
  writeFileSync(path, `content of ${name}`)
  return path
}
const readCall = (id: string, path: string): { id: string; name: string; args: string } => ({
  id,
  name: 'read',
  args: JSON.stringify({ path })
})
const askCall = (id: string): { id: string; name: string; args: string } => ({
  id,
  name: 'ask',
  args: JSON.stringify({ question: QUESTION, options: OPTIONS })
})

const createSession = (title: string): Promise<string> =>
  app.main.eval<string>(`window.api.session.create(${JSON.stringify({ title })}).then((s) => s.id)`)
/** 发一轮，不等它落定（卡片挂着时 prompt 不会答） */
const startTurn = (sid: string, text: string): Promise<unknown> =>
  app.main.eval(
    `(window.api.agent.prompt(${JSON.stringify({ sessionId: sid, text })}).catch(() => {}), true)`
  )
const listed = (sid: string): Promise<Array<{ role: string; id: string; content?: string }>> =>
  app.main.eval(`window.api.message.list(${JSON.stringify(sid)})`)
const listedText = async (sid: string): Promise<string> => JSON.stringify(await listed(sid))
const waitCard = (kind: 'ask' | 'choice' = 'ask'): Promise<boolean> =>
  until(async () => (await ask.cardKind()) === kind, `${kind} card in the list`, 20_000)
const waitNoCard = (): Promise<boolean> =>
  until(async () => (await ask.cardKind()) === null, 'no pending card', 20_000)
/** 卡片的表单隔一拍才画、跟随要 400ms 才松开：等卡片真的露着、位置也不动了 */
const waitCardResting = async (): Promise<void> => {
  await until(() => ask.cardOnScreen(), 'pending card fully on screen', 10_000)
  await sleep(500)
}
const outcomes = async (): Promise<string[]> => (await ask.answers()).map((a) => a.outcome)
/** 会话存储（durable sqlite + WAL）里有没有这段文字：按字节找，不经产品代码 */
const storeContains = (sid: string, needle: string): boolean => {
  const base = durableStoragePathOf(app.home, sid)
  return ['', '-wal', '-shm'].some((suffix) => {
    try {
      return readFileSync(base + suffix).includes(needle)
    } catch {
      return false
    }
  })
}
const toolResults = (req: FakeRequest): string[] =>
  (req.body.messages ?? [])
    .filter((m) => m.role === 'tool')
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))

beforeAll(async () => {
  provider = await startFakeProvider()
  app = await launchApp()
  await app.main.eval(`window.api.settings.set({ key: 'general.language', value: 'en' })`)
  await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  await waitRendererReady(app.main)
  outside = join(app.home, 'outside')
  mkdirSync(outside, { recursive: true })
  freeDir = mkdtempSync(join(tmpdir(), 'shuvix-e2e-inline-'))
  chat = chatPane(app.main)
  sidebar = sidebarPane(app.main)
  ask = inlineAskPane(app.main)
  scroll = conversationScrollPane(app.main)
  probe = syncProbe(app.main)

  sids.main = await createSession(MAIN)
  provider.script({ text: LONG, usage: USAGE })
  await app.main.eval(
    `window.api.agent.prompt(${JSON.stringify({ sessionId: sids.main, text: 'introduce the release flow' })}).then(() => true)`
  )
  await sidebar.clickNewChat()
  await until(() => sidebar.openSession(MAIN), 'open the long session')
  await chat.ready()
  await scroll.waitAtBottom()
})

afterAll(async () => {
  web?.page.close()
  await provider?.close()
  await app?.stop()
  if (freeDir) rmSync(freeDir, { recursive: true, force: true })
})

describe('询问卡片在对话流里（桌面）', () => {
  it('E-1 人在底部：卡片在 Footer，整张露着，输入卡片没有语义色', async () => {
    provider.script(
      { toolCalls: [readCall('c1', inOutside('one.log'))], usage: USAGE },
      { text: 'read it', usage: USAGE }
    )
    await startTurn(sids.main, 'turn one')
    await waitCard()
    await waitCardResting()

    expect(await chat.pendingPanel()).toEqual({ open: true, inConversation: true })
    const at = (await ask.layout())!
    expect(at.panelInComposer).toBe(false)
    expect(at.card.bottom).toBeLessThanOrEqual(at.composer.top + 1)
    expect(at.card.top).toBeGreaterThanOrEqual(at.scroller.top - 1)
    expect(at.composer.height).toBeLessThan(150)
    expect(at.composerClass).not.toContain('border-warning')
    expect(at.composerClass).not.toContain('ring-warning')

    // 卡片露着：提示藏着（它在 DOM 里，不算数）
    const j = await ask.waitJump(false)
    expect(j.tabIndex).toBe(-1)
  })

  it('E-6 焦点在输入框里打 1：是打字，卡片还等着', async () => {
    const before = provider.chatRequestCount()
    await chat.typeTrusted('1')
    await sleep(300)
    expect(await chat.composerFocused()).toBe(true)
    expect(await chat.inputValue()).toBe('1')
    expect((await ask.otherRow())!.value).toBe('')
    expect(await ask.cardKind()).toBe('ask')
    expect(provider.chatRequestCount()).toBe(before)
    await chat.type('')
    await until(async () => (await chat.inputValue()) === '', 'composer cleared')
  })

  it('E-7 草稿长到卡片放不下：卡片被压住，可信的 1 不答', async () => {
    const before = provider.chatRequestCount()
    // 打开会话之后 3 秒内列表还在跟随（总高一变就贴底，输入卡片长高也算）：过了它，卡片才会被压住
    await sleep(3_200)
    // 列表会跟着让卡片，所以要长到两样加起来放不下；输入框封顶 480px，窗口要够矮
    await chat.type(Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n'))
    await until(async () => !(await ask.cardOnScreen()), 'composer grew over the card', 5_000)
    await ask.pressDigit('1')
    await sleep(500)
    expect(await ask.cardKind()).toBe('ask')
    expect(provider.chatRequestCount()).toBe(before)

    await chat.type('')
    await until(async () => (await chat.inputValue()) === '', 'composer cleared')
    await ask.scrollToEnd()
    await until(() => ask.cardOnScreen(), 'card back on screen', 5_000)
    await ask.pickOption('allow')
    await waitNoCard()
    await chat.waitIdle()
    await ask.scrollToEnd()
    expect(await outcomes()).toEqual(['allowed'])
  })

  it('E-2 真滚轮翻上去之后才来卡片：位置不动，提示真的露着，在输入卡片上方', async () => {
    provider.script(
      { text: 'looking', holdMs: 20_000, toolCalls: [readCall('c2', inOutside('two.log'))] },
      { text: 'second done', usage: USAGE }
    )
    await startTurn(sids.main, 'turn two')
    await until(() => provider.holding(), 'first reply held')
    await sleep(300)

    for (let i = 0; i < 4; i++) {
      await ask.wheel(-400)
      await sleep(50)
    }
    await until(
      async () => (await scroll.shot())!.distToBottom > 600,
      'scrolled up by real wheel',
      5_000
    )
    await sleep(200)
    const top = (await scroll.shot())!.scrollTop

    provider.release()
    await waitCard()
    await sleep(600)
    expect((await scroll.shot())!.scrollTop).toBe(top)

    const j = await ask.waitJump(true)
    expect(j.kind).toBe('ask')
    expect(j.text).toBe('Waiting for your approval')
    expect(j.tabIndex).toBe(0)
    const composerTop = (await ask.layout())!.composer.top
    expect(j.rect!.bottom).toBeLessThan(composerTop)
  })

  it('E-3 卡片不在屏幕上：可信的 1 不答、不进输入框、不发请求', async () => {
    const before = provider.chatRequestCount()
    await ask.pressDigit('1')
    await sleep(500)
    expect(await ask.cardKind()).toBe('ask')
    expect(provider.chatRequestCount()).toBe(before)
    expect(await chat.inputValue()).toBe('')
  })

  it('E-4 真点提示：卡片整张露出来，提示藏回去', async () => {
    await ask.clickJump()
    await until(() => ask.cardOnScreen(), 'card revealed by the pill', 10_000)
    await ask.waitJump(false)
  })

  it('E-5 卡片露着：可信的 1 答了，发下一个请求，工具行留下 allowed', async () => {
    const before = provider.chatRequestCount()
    await waitCardResting()
    await ask.pressDigit('1')
    await waitNoCard()
    await until(() => provider.chatRequestCount() > before, 'next request sent')
    await chat.waitIdle()
    await ask.scrollToEnd()
    await until(async () => (await outcomes()).includes('allowed'), 'allowed line on the row')
  })

  it('E-8 选择题：记录有问题与答案；展开看全部，对勾只在选中的；模型收到选择', async () => {
    provider.script(
      { toolCalls: [askCall('c3')], usage: USAGE },
      { text: 'going with arm64', usage: USAGE }
    )
    await startTurn(sids.main, 'turn three')
    await waitCard('choice')
    await ask.pickChoice('arm64 only')
    await sleep(100)
    await ask.confirmChoice()
    await waitNoCard()
    await chat.waitIdle()
    await ask.scrollToEnd()

    const [record] = await until(async () => {
      const r = await ask.records()
      return r.length === 1 ? r : null
    }, 'ask record')
    expect(record!.text).toContain(QUESTION)
    expect(record!.selections).toEqual(['arm64 only'])
    expect(record!.toggle).toBe('Show all 3 options')
    expect(record!.other).toBeNull()

    await ask.toggleRecord(0)
    const [open] = await ask.records()
    expect(open!.toggle).toBe('Hide options')
    expect(open!.options.map((o) => o.checked)).toEqual([true, false, false])
    expect(open!.options[0]!.text).toContain('The fastest')
    await ask.toggleRecord(0)

    const last = provider.requests().at(-1)!
    expect(toolResults(last).join('\n')).toContain('User selected: arm64 only')
  })

  it('E-9 在卡片那一行写字回车：反馈记录，没有多一条用户消息，没有行首红叉', async () => {
    const usersBefore = (await listed(sids.main)).filter((m) => m.role === 'user').length
    provider.script(
      { toolCalls: [readCall('c4', inOutside('three.log'))], usage: USAGE },
      { text: 'ok, branching first', usage: USAGE }
    )
    await startTurn(sids.main, 'turn four')
    await waitCard()
    await waitCardResting()
    const other = (await ask.otherRow())!
    expect(other.placeholder).toBe('Or tell the AI what to do instead')
    expect(other.submit).toBe(false)
    expect((await chat.composer()).placeholder).toBe('Type a message to guide the agent...')

    await ask.typeOtherTrusted(FEEDBACK_WORDS)
    await until(async () => (await ask.otherRow())!.submit, 'send button in the row')
    await ask.pressOtherEnter()
    await waitNoCard()
    await chat.waitIdle()
    await ask.scrollToEnd()

    const line = await until(async () => {
      const all = await ask.answers()
      return all.find((a) => a.outcome === 'feedback') ?? null
    }, 'feedback line')
    expect(line.text).toContain(FEEDBACK_WORDS)
    expect(line.tool).toBe('read')
    // 这一轮只有 turn four 那一条用户消息，反馈没有变成消息
    const users = (await listed(sids.main)).filter((m) => m.role === 'user')
    expect(users).toHaveLength(usersBefore + 1)
    const row = (await chat.toolRowShots()).filter((r) => r.name === 'read').at(-1)!
    expect(row.status).toBe('error')
    expect(row.icon).not.toBe('lucide-x')
    expect(toolResults(provider.requests().at(-1)!).join('\n')).toContain(FEEDBACK_WORDS)
  })

  it('E-22 卡片挂着时在输入框回车：进队列，卡片还整张露着，请求数不动；允许之后模型收到', async () => {
    const STEER_WORDS = 'also keep the changelog short'
    provider.script(
      { toolCalls: [readCall('c22', inOutside('steer.log'))], usage: USAGE },
      { text: 'noted the steer', usage: USAGE }
    )
    await startTurn(sids.main, 'turn steer')
    await waitCard()
    await waitCardResting()
    const before = provider.chatRequestCount()

    await chat.typeAndSend(STEER_WORDS)
    await until(async () => (await chat.inputValue()) === '', 'composer cleared')
    await until(
      () => app.main.eval<boolean>(`!!document.querySelector('[data-queue-panel]')`),
      'queue bar'
    )
    await sleep(500)
    // 队列细条把输入卡片撑高了：列表跟着让，卡片没被压住，提示没有盖在卡片上
    expect(await ask.cardKind()).toBe('ask')
    expect(await ask.cardOnScreen()).toBe(true)
    await ask.waitJump(false)
    expect((await ask.otherRow())!.row.bottom).toBeLessThanOrEqual(
      (await ask.layout())!.composer.top + 1
    )

    const rows = await chat.queueRows()
    expect(rows.map((r) => [r.mode, r.text])).toEqual([['steer', STEER_WORDS]])
    await sleep(300)
    expect(await ask.cardOnScreen()).toBe(true)
    expect(provider.chatRequestCount()).toBe(before)
    expect(await listedText(sids.main)).not.toContain(STEER_WORDS)

    await ask.pickOption('allow')
    await waitNoCard()
    await until(() => provider.chatRequestCount() > before, 'next request sent')
    await chat.waitIdle()
    await ask.scrollToEnd()
    const sent = provider.requests().slice(before)
    const carrying = sent.filter((r) => r.raw.includes(STEER_WORDS))
    expect(carrying.length).toBeGreaterThan(0)
    for (const req of carrying) {
      const roles = (req.body.messages ?? [])
        .filter((m) => JSON.stringify(m).includes(STEER_WORDS))
        .map((m) => m.role)
      expect(roles).toEqual(['user'])
    }
    expect((await ask.answers()).at(-1)!.outcome).toBe('allowed')
  })

  it('E-23 焦点在卡片那一行按可信的 1：是打字，卡片还等着', async () => {
    provider.script(
      { toolCalls: [readCall('c23', inOutside('row.log'))], usage: USAGE },
      { text: 'row done', usage: USAGE }
    )
    await startTurn(sids.main, 'turn row')
    await waitCard()
    await waitCardResting()
    const before = provider.chatRequestCount()

    await ask.pressOtherDigit('1')
    await sleep(400)
    const other = (await ask.otherRow())!
    expect(other.focused).toBe(true)
    expect(other.value).toBe('1')
    expect(other.submit).toBe(true)
    expect(await chat.inputValue()).toBe('')
    expect(await ask.cardKind()).toBe('ask')
    expect(provider.chatRequestCount()).toBe(before)
    await ask.setOther('')
  })

  it('E-24 卡片那一行写八行：高度封顶 120，这一行的底不被输入卡片压住', async () => {
    const lines = Array.from({ length: 8 }, (_, i) => `row line ${i}`).join('\n')
    const oneLine = (await ask.otherRow())!.inputHeight
    expect(oneLine).toBeLessThan(40)

    await ask.typeOtherTrusted(lines)
    try {
      const tall = await until(async () => {
        const r = await ask.otherRow()
        return r && r.value === lines ? r : null
      }, 'eight lines in the row')
      await sleep(300)
      const at = (await ask.otherRow())!
      expect(at.inputHeight, JSON.stringify(tall)).toBeLessThanOrEqual(120.5)
      expect(at.inputHeight).toBeGreaterThan(oneLine)
      expect(at.inputScrollHeight).toBeGreaterThan(at.inputHeight)
      const layout = (await ask.layout())!
      expect(at.row.bottom, JSON.stringify({ at, layout })).toBeLessThanOrEqual(
        layout.composer.top + 1
      )
      expect(at.row.top).toBeGreaterThanOrEqual(layout.scroller.top - 1)
    } finally {
      // 后面的用例接着用这张卡片
      await ask.setOther('')
      await until(
        async () => (await ask.otherRow())!.inputHeight < 40,
        'the row back to one line',
        5_000
      )
    }
  })

  it('E-25 卡片露着时输入框长高：列表让、卡片还露着；变矮不动；卡片没露全时长高：滚动位置不动', async () => {
    const DRAFT = Array.from({ length: 8 }, (_, i) => `draft ${i}`).join('\n')
    const composerHeight = async (): Promise<number> => (await ask.layout())!.composer.height
    await ask.scrollToEnd()
    await waitCardResting()
    const small = await composerHeight()
    expect((await scroll.shot())!.distToBottom).toBeLessThanOrEqual(2)

    // 露着：跟着让
    await chat.type(DRAFT)
    await until(async () => (await composerHeight()) > small + 80, 'composer grew', 5_000)
    await sleep(300)
    expect(await ask.cardOnScreen()).toBe(true)
    await ask.waitJump(false)

    // 变矮：不往回挪，还在底（列表多跟一程的话会离底一截）
    await chat.type('')
    await until(async () => (await composerHeight()) <= small + 1, 'composer back', 5_000)
    await sleep(300)
    expect(await ask.cardOnScreen()).toBe(true)
    expect((await scroll.shot())!.distToBottom).toBeLessThanOrEqual(2)

    // 人翻上去，卡片的底压在输入卡片下面：不替他挪
    for (let i = 0; i < 3; i++) {
      await ask.wheel(-120)
      await sleep(50)
    }
    await until(async () => !(await ask.cardOnScreen()), 'scrolled the card off', 5_000)
    await sleep(500)
    const top = (await scroll.shot())!.scrollTop
    await chat.type(DRAFT)
    await until(async () => (await composerHeight()) > small + 80, 'composer grew again', 5_000)
    await sleep(500)
    expect((await scroll.shot())!.scrollTop).toBe(top)
    expect(await ask.cardOnScreen()).toBe(false)

    await chat.type('')
    await until(async () => (await composerHeight()) <= small + 1, 'composer back again', 5_000)
    await ask.scrollToEnd()
    await until(() => ask.cardOnScreen(), 'card back on screen', 5_000)
    await ask.pickOption('allow')
    await waitNoCard()
    await chat.waitIdle()
    await ask.scrollToEnd()
  })

  it('E-10 拒绝：denied 那行、status error、没有行首红叉；对照：自己失败的 read 照旧红叉', async () => {
    const missing = join(freeDir, 'missing.txt')
    provider.script(
      {
        toolCalls: [readCall('c5', inOutside('four.log')), readCall('c5b', missing)],
        usage: USAGE
      },
      { text: 'fine', usage: USAGE }
    )
    await startTurn(sids.main, 'turn five')
    await waitCard()
    await waitCardResting()
    await ask.pickOption('deny')
    await waitNoCard()
    await chat.waitIdle()
    await ask.scrollToEnd()

    await until(async () => (await outcomes()).includes('denied'), 'denied line')
    const rows = (await chat.toolRowShots()).filter((r) => r.name === 'read')
    const denied = rows.find((r) => r.detail.includes('four.log'))!
    expect(denied.status).toBe('error')
    expect(denied.icon).not.toBe('lucide-x')
    const failed = rows.find((r) => r.detail.includes('missing.txt'))!
    expect(failed.status).toBe('error')
    expect(failed.icon).toBe('lucide-x')
  })

  it('E-11 允许并记住：remembered + 路径；再读同一路径不问、没有记录', async () => {
    const path = inOutside('five.log')
    provider.script(
      { toolCalls: [readCall('c6', path)], usage: USAGE },
      { toolCalls: [readCall('c6b', path)], usage: USAGE },
      { text: 'read twice', usage: USAGE }
    )
    await startTurn(sids.main, 'turn six')
    await waitCard()
    await waitCardResting()
    await ask.pickOption('remember-path')
    await waitNoCard()
    await chat.waitIdle()
    await ask.scrollToEnd()

    const line = await until(async () => {
      const all = await ask.answers()
      return all.find((a) => a.outcome === 'remembered') ?? null
    }, 'remembered line')
    expect(line.text).toContain('You allowed this and remembered')
    expect(line.target).toBe(path)
    expect((await ask.answers()).filter((a) => a.target === path)).toHaveLength(1)
  })

  it('E-12 步骤组：人答过的调用不进合并行，两边的普通 read 照旧并', async () => {
    const free = (name: string): string => {
      const path = join(freeDir, name)
      writeFileSync(path, name)
      return path
    }
    provider.script(
      { toolCalls: [readCall('g1', free('a.txt'))], usage: USAGE },
      { toolCalls: [readCall('g2', free('b.txt'))], usage: USAGE },
      { toolCalls: [readCall('g3', inOutside('six.log'))], usage: USAGE },
      { toolCalls: [readCall('g4', free('c.txt'))], usage: USAGE },
      { toolCalls: [readCall('g5', free('d.txt'))], usage: USAGE },
      { toolCalls: [askCall('g6')], usage: USAGE },
      { text: 'grouped', usage: USAGE }
    )
    await startTurn(sids.main, 'turn seven')
    await waitCard()
    await waitCardResting()
    await ask.pickOption('allow')
    await waitCard('choice')
    await ask.pickChoice('Both')
    await sleep(100)
    await ask.confirmChoice()
    await waitNoCard()
    await chat.waitIdle()
    await ask.scrollToEnd()

    // 这一轮：两组各两个 read，中间那个人答过的不在组里
    await until(async () => (await ask.records()).some((r) => r.selections[0] === 'Both'), 'ask')
    const groups = await chat.stepGroupShots()
    expect(groups.filter((g) => g.size === 2).length).toBeGreaterThanOrEqual(2)
    const rows = await chat.toolRowShots()
    const answered = rows.find((r) => r.detail.includes('six.log'))!
    expect(answered.inGroup).toBe(false)
    const askRow = rows.filter((r) => r.name === 'ask').at(-1)!
    expect(askRow.inGroup).toBe(false)
  })

  it('E-13 模型隔离：所有请求里都没有记录的内容；反馈只在工具结果里', async () => {
    const raws = provider.requests()
    expect(raws.length).toBeGreaterThan(5)
    for (const req of raws) {
      const sent = JSON.stringify(req.body.messages)
      expect(sent).not.toContain('shuvixAnswers')
      expect(sent).not.toContain('You allowed')
      expect(sent).not.toContain('"remembered"')
      expect(sent).not.toContain('\\"selections\\"')
      expect(sent).not.toContain('"selections"')
    }
    const withFeedback = raws.filter((r) => r.raw.includes(FEEDBACK_WORDS))
    expect(withFeedback.length).toBeGreaterThan(0)
    for (const req of withFeedback) {
      const notInTools = (req.body.messages ?? []).filter(
        (m) => m.role !== 'tool' && JSON.stringify(m).includes(FEEDBACK_WORDS)
      )
      expect(notInTools).toEqual([])
      expect(toolResults(req).join('\n')).toContain(FEEDBACK_WORDS)
    }
  })

  it('E-14 重载：记录与实时一模一样，开关照样好用', async () => {
    await ask.scrollToEnd()
    const liveAnswers = await ask.allAnswers()
    const liveRecords = await ask.allRecords()
    expect(liveAnswers.map((a) => a.outcome)).toEqual(
      expect.arrayContaining(['allowed', 'feedback', 'denied', 'remembered'])
    )
    expect(liveRecords).toHaveLength(2)

    await app.main.eval('location.reload()')
    await sleep(1000)
    await waitRendererReady(app.main)
    await until(() => sidebar.openSession(MAIN), 'reopen after reload')
    await chat.ready()
    await scroll.waitAtBottom()

    expect(await ask.allAnswers()).toEqual(liveAnswers)
    const reloaded = await ask.allRecords()
    expect(reloaded).toEqual(liveRecords)

    await ask.scrollToEnd()
    await until(async () => (await ask.records()).length > 0, 'a record in the DOM')
    await ask.toggleRecord(0)
    expect((await ask.records())[0]!.options).toHaveLength(3)
    await ask.toggleRecord(0)
  })

  it('E-15 从记录所在的回复分支：记录一样；分支的下一次请求同样不带记录', async () => {
    const messages = await listed(sids.main)
    const lastAssistant = messages.filter((m) => m.role === 'assistant').at(-1)!
    const forked = await app.main.eval<{ success: boolean; sessionId?: string }>(
      `window.api.session.fork(${JSON.stringify({ sessionId: sids.main, messageId: lastAssistant.id })})`
    )
    expect(forked.success).toBe(true)
    const sid = forked.sessionId!
    const sourceText = await listedText(sids.main)
    expect(sourceText).toContain('shuvixAnswers')
    await until(
      async () => (await listedText(sid)).includes('shuvixAnswers'),
      'fork carries the records'
    )
    expect(await listedText(sid)).toContain(FEEDBACK_WORDS)

    const since = provider.chatRequestCount()
    provider.script({ text: 'in the fork', usage: USAGE })
    await app.main.eval(
      `window.api.agent.prompt(${JSON.stringify({ sessionId: sid, text: 'fork turn' })}).then(() => true)`
    )
    const sent = JSON.stringify(provider.requests()[since]!.body.messages)
    expect(sent).toContain(FEEDBACK_WORDS)
    expect(sent).not.toContain('shuvixAnswers')
    expect(sent).not.toContain('You allowed')
    expect(sent).not.toContain('"selections"')
  })

  it('E-16 回退：两轮的会话退到后一轮，前一轮的记录还在；再退到前一轮之前，都没了', async () => {
    const title = 'Inline rollback'
    const sid = await createSession(title)
    await until(async () => (await sidebar.titles()).includes(title), 'row listed')
    await until(() => sidebar.openSession(title), 'open rollback session')
    await chat.ready()

    provider.script(
      { toolCalls: [readCall('r1', inOutside('r1.log'))], usage: USAGE },
      { text: 'first', usage: USAGE },
      { toolCalls: [readCall('r2', inOutside('r2.log'))], usage: USAGE },
      { text: 'second', usage: USAGE }
    )
    await startTurn(sid, 'rollback one')
    await waitCard()
    await ask.pickOption('allow')
    await waitNoCard()
    await chat.waitIdle()
    await startTurn(sid, 'rollback two')
    await waitCard()
    await ask.pickOption('deny')
    await waitNoCard()
    await chat.waitIdle()
    await until(async () => (await outcomes()).length === 2, 'two records')

    const users = async (): Promise<Array<{ id: string }>> =>
      (await listed(sid)).filter((m) => m.role === 'user')
    await chat.clickRollback((await users())[1]!.id)
    await chat.confirmAccept()
    await until(async () => (await outcomes()).join() === 'allowed', 'second turn records gone')
    expect(await listedText(sid)).not.toContain('"denied"')

    await chat.clickRollback((await users())[0]!.id)
    await chat.confirmAccept()
    await until(async () => (await outcomes()).length === 0, 'all records gone')
    expect(await listedText(sid)).not.toContain('shuvixAnswers')
    await chat.type('')
  })

  it('E-17 卡片等着时中止：卡片没了，那一行没有记录；重载之后也没有', async () => {
    const title = 'Inline abort'
    const sid = await createSession(title)
    await until(async () => (await sidebar.titles()).includes(title), 'row listed')
    await until(() => sidebar.openSession(title), 'open abort session')
    await chat.ready()

    provider.script({ toolCalls: [readCall('a1', inOutside('abort.log'))], usage: USAGE })
    await startTurn(sid, 'abort me')
    await waitCard()
    await app.main.eval(`window.api.agent.abort(${JSON.stringify(sid)})`)
    await waitNoCard()
    await chat.waitIdle()
    expect(await outcomes()).toEqual([])
    expect(await listedText(sid)).not.toContain('shuvixAnswers')

    await app.main.eval('location.reload()')
    await sleep(1000)
    await waitRendererReady(app.main)
    await until(() => sidebar.openSession(title), 'reopen after reload')
    await chat.ready()
    await sleep(500)
    expect(await ask.answers()).toEqual([])
  })

  /** + → 添加敏感信息（同 chat-redaction 的 addSecret） */
  const addSecret = async (value: string, category: string): Promise<void> => {
    await app.main.eval(`document.querySelector('[data-attach-button]').click()`)
    await until(
      () => app.main.eval<boolean>(`!!document.querySelector('[data-plus-secret]')`),
      'the + menu'
    )
    await app.main.eval(`document.querySelector('[data-plus-secret]').click()`)
    await until(
      () => app.main.eval<boolean>(`!!document.querySelector('[data-secret-input]')`),
      'the secret form'
    )
    await app.main.eval(`(() => {
      const input = document.querySelector('[data-secret-input]')
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      set.call(input, ${JSON.stringify(value)})
      input.dispatchEvent(new Event('input', { bubbles: true }))
      document.querySelector('[data-secret-category=${JSON.stringify(category)}]').click()
    })()`)
    await sleep(50)
    await app.main.eval(`document.querySelector('[data-secret-add]').click()`)
    await until(
      () => app.main.eval<boolean>(`!document.querySelector('[data-secret-form]')`),
      'the secret form closed'
    )
  }
  const PLACEHOLDER = /\{\{REDACTED_API_KEY_[a-z2-7]{8}\}\}/

  it('E-18 脱敏：占位符路径、人选记住：那行没有路径；message.list 与会话存储里都没有真值', async () => {
    provider.reset()
    const secret = 'sk-proj-' + 'R1b2C3d4E5f6G7h8I9j0K1l2'
    const title = 'Inline redacted'
    const sid = await createSession(title)
    await until(async () => (await sidebar.titles()).includes(title), 'row listed')
    await until(() => sidebar.openSession(title), 'open redaction session')
    await chat.ready()

    const dir = join(outside, secret)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'a.txt'), 'plain content')
    provider.script(
      {
        build: (req) => {
          const hit = PLACEHOLDER.exec(req.lastUserText)
          if (!hit) throw new Error(`no placeholder in: ${req.lastUserText}`)
          return { toolCalls: [readCall('s1', join(outside, hit[0], 'a.txt'))] }
        },
        usage: USAGE
      },
      { text: 'done', usage: USAGE }
    )
    await addSecret(secret, 'API_KEY')
    await chat.type(`${await chat.inputValue()} read that folder`)
    await chat.pressEnter()
    await waitCard()
    await ask.pickOption('remember-path')
    await waitNoCard()
    await chat.waitIdle()

    const [line] = await until(async () => {
      const all = await ask.answers()
      return all.length === 1 ? all : null
    }, 'remembered line')
    expect(line!.outcome).toBe('remembered')
    expect(line!.target).toBeNull()
    expect(line!.text).toBe('You allowed this and remembered')

    expect(await listedText(sid)).not.toContain(secret)
    expect(storeContains(sid, secret)).toBe(false)
    for (const req of provider.requests()) expect(req.raw).not.toContain(secret)
  })

  it('E-19 respondToInput 带非空 secrets：那行是占位符标记；存储与请求里都没有真值', async () => {
    provider.reset()
    const secret = 'sk-proj-' + 'F9e8D7c6B5a4Z3y2X1w0V9u8'
    const title = 'Inline feedback secret'
    const sid = await createSession(title)
    await until(async () => (await sidebar.titles()).includes(title), 'row listed')
    await until(() => sidebar.openSession(title), 'open feedback session')
    await chat.ready()

    provider.script(
      { toolCalls: [readCall('f1', inOutside('feedback.log'))], usage: USAGE },
      { text: 'noted', usage: USAGE }
    )
    await startTurn(sid, 'read the log')
    const request = await probe.nextAsk(sid)
    await waitCard()
    await app.main.eval(
      `window.api.agent.respondToInput(${JSON.stringify({
        sessionId: sid,
        requestId: request.id,
        response: {
          kind: 'other',
          text: `use this key ${secret}`,
          secrets: [{ value: secret, category: 'API_KEY' }]
        }
      })})`
    )
    await waitNoCard()
    await chat.waitIdle()

    const line = await until(async () => {
      const all = await ask.answers()
      return all.find((a) => a.outcome === 'feedback') ?? null
    }, 'feedback line')
    expect(line.marks).toBe(1)
    expect(line.text).not.toContain(secret)
    expect(await listedText(sid)).not.toContain(secret)
    expect(storeContains(sid, secret)).toBe(false)
    for (const req of provider.requests()) expect(req.raw).not.toContain(secret)
  })

  it('E-26 选择题又勾又写：一个发送键，模型收到两样，记录两样都在；要藏的值不落盘', async () => {
    provider.reset()
    const secret = 'sk-proj-' + 'A1b2C3d4E5f6G7h8I9j0K1l2'
    const title = 'Inline choice note'
    const sid = await createSession(title)
    await until(async () => (await sidebar.titles()).includes(title), 'row listed')
    await until(() => sidebar.openSession(title), 'open choice note session')
    await chat.ready()

    provider.script(
      { toolCalls: [askCall('n1')], usage: USAGE },
      { text: 'noted both', usage: USAGE },
      { toolCalls: [askCall('n2')], usage: USAGE },
      { text: 'noted the key', usage: USAGE }
    )
    await startTurn(sid, 'first question')
    await waitCard('choice')
    await waitCardResting()
    await ask.pickChoice('arm64 only')
    await ask.typeOtherTrusted('only the release build')
    expect((await ask.otherRow())!.submit).toBe(false)
    await ask.confirmChoice()
    await waitNoCard()
    await chat.waitIdle()
    await ask.scrollToEnd()

    const [first] = await until(async () => {
      const r = await ask.records()
      return r.length === 1 ? r : null
    }, 'choice note record')
    expect(first!.selections).toEqual(['arm64 only'])
    expect(first!.other).toContain('only the release build')
    const sent = provider.requests().at(-1)!.raw
    expect(sent).toContain('User selected: arm64 only')
    expect(sent).toContain('User also wrote:')
    expect(sent).toContain('only the release build')

    await startTurn(sid, 'second question')
    const request = await probe.nextAsk(sid)
    await waitCard('choice')
    await app.main.eval(
      `window.api.agent.respondToInput(${JSON.stringify({
        sessionId: sid,
        requestId: request.id,
        response: {
          kind: 'choice',
          selections: ['arm64 only'],
          note: `use this key ${secret}`,
          secrets: [{ value: secret, category: 'API_KEY' }]
        }
      })})`
    )
    await waitNoCard()
    await chat.waitIdle()
    expect(await listedText(sid)).not.toContain(secret)
    expect(storeContains(sid, secret)).toBe(false)
    for (const req of provider.requests()) expect(req.raw).not.toContain(secret)
    expect(provider.requests().at(-1)!.raw).toContain('use this key')
  })

  it('E-21 卡片挂着时切走再切回，两次：卡片露着，提示藏着', async () => {
    provider.reset()
    const title = 'Inline reopen'
    const sid = await createSession(title)
    await until(async () => (await sidebar.titles()).includes(title), 'row listed')
    await until(() => sidebar.openSession(title), 'open reopen session')
    await chat.ready()
    provider.script({ text: LONG, usage: USAGE })
    await app.main.eval(
      `window.api.agent.prompt(${JSON.stringify({ sessionId: sid, text: 'long one' })}).then(() => true)`
    )
    await chat.waitIdle()
    provider.script(
      { toolCalls: [readCall('o1', inOutside('reopen.log'))], usage: USAGE },
      { text: 'reopened', usage: USAGE }
    )
    await startTurn(sid, 'read it')
    await waitCard()

    for (let i = 0; i < 2; i++) {
      await until(() => sidebar.openSession(MAIN), 'switch away')
      await until(async () => (await ask.cardKind()) === null, 'other session has no card')
      await until(() => sidebar.openSession(title), 'switch back')
      await waitCard()
      await waitCardResting()
      await ask.waitJump(false)
    }
    await ask.pickOption('allow')
    await waitNoCard()
    await chat.waitIdle()
  })
})

describe('询问卡片在对话流里（手机）', () => {
  const PHONE_TITLE = 'Inline phone'
  let phoneSid = ''

  it('E-20 390×844 + 触屏：卡片在列表里；1 不答；提示在宽度内、输入卡片上方；点提示露出卡片；答了；记录在；开关够高', async () => {
    provider.reset()
    phoneSid = await createSession(PHONE_TITLE)
    provider.script({ text: LONG, usage: USAGE })
    await app.main.eval(
      `window.api.agent.prompt(${JSON.stringify({ sessionId: phoneSid, text: 'long intro' })}).then(() => true)`
    )

    const port = await freePort()
    await app.main.eval(`window.api.network.setPort(${port})`)
    await app.main.eval(`window.api.network.setEnabled(true)`)
    web = await openWebClient(app, port)
    const page = web.page
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true
    })
    await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
    await page.eval('(window.__mark = 1)')
    await page.send('Page.reload', {})
    await until(
      () =>
        page.eval<boolean>(
          `!window.__mark && window.api?.app?.platform === 'web' && document.readyState === 'complete'`
        ),
      'reloaded'
    )
    await waitRendererReady(page)
    const mobile = webMobilePane(page)
    await until(() => mobile.shellPresent(), 'phone shell')
    await sleep(800)
    await mobile.tap({ sessionRow: PHONE_TITLE })
    await until(
      async () => (await mobile.chatOpen()) && (await mobile.chatTitle()) === PHONE_TITLE,
      'chat page'
    )
    const phoneChat = chatPane(page)
    await phoneChat.ready()
    const phoneAsk = inlineAskPane(page)
    await sleep(600)

    provider.script(
      { toolCalls: [readCall('p1', inOutside('phone.log'))], usage: USAGE },
      { toolCalls: [askCall('p2')], usage: USAGE },
      { text: 'done on the phone', usage: USAGE }
    )
    await startTurn(phoneSid, 'read on the phone')
    await until(async () => (await phoneAsk.cardKind()) === 'ask', 'phone card', 20_000)
    await until(() => phoneAsk.cardOnScreen(), 'phone card on screen', 10_000)
    await sleep(500)
    expect(await phoneChat.pendingPanel()).toEqual({ open: true, inConversation: true })

    // 触屏档没有数字键
    const before = provider.chatRequestCount()
    await phoneAsk.pressDigit('1')
    await sleep(400)
    expect(await phoneAsk.cardKind()).toBe('ask')
    expect(provider.chatRequestCount()).toBe(before)

    // 翻上去：提示在宽度内、输入卡片上方
    await page.eval(
      `(() => { const s = document.querySelector('.conversation-scroller'); s.scrollTop = 0; return true })()`
    )
    const j = await phoneAsk.waitJump(true)
    expect(j.rect!.left).toBeGreaterThanOrEqual(0)
    expect(j.rect!.right).toBeLessThanOrEqual(390)
    expect(j.rect!.bottom).toBeLessThan((await phoneAsk.layout())!.composer.top)

    // 点提示露出卡片，点选项答
    await phoneAsk.clickJump()
    await until(() => phoneAsk.cardOnScreen(), 'phone card revealed', 10_000)
    await phoneAsk.waitJump(false)
    await sleep(300)
    await mobile.tap({ pendingOption: 'allow' })
    await until(async () => (await phoneAsk.cardKind()) === 'choice', 'phone choice', 20_000)
    await sleep(400)
    await phoneAsk.pickChoice('Both')
    await sleep(100)
    await phoneAsk.confirmChoice()
    await until(async () => (await phoneAsk.cardKind()) === null, 'phone answered', 20_000)
    await until(async () => (await phoneAsk.records()).length === 1, 'phone record', 20_000)
    await sleep(500)
    await phoneAsk.scrollToEnd()
    const [record] = await phoneAsk.records()
    expect(record!.selections).toEqual(['Both'])
    expect(record!.toggleHeight).toBeGreaterThanOrEqual(32)
    expect((await phoneAsk.answers()).map((a) => a.outcome)).toEqual(['allowed'])
  }, 120_000)
})
