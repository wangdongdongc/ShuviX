/**
 * 对话列的滚动落点与「回到底部」按钮（chat-ui Conversation 的 MessageList + ScrollToBottomButton）。
 *
 *  - 打开 / 切回一条会话，列表落在**真底**：最后一项的底边在悬浮输入卡片之上，不是最后一轮的开头；
 *    运行中的会话切回来同样落在底部的流式卡上（视图到达之前不挂列表）；
 *  - 按钮只在离底部够远、且初始定位过了之后才出现：不在底部时显示、可点、居中压在输入卡片上方，
 *    点它回到底部；切会话不闪、状态不串到别的会话；运行中兼作运行指示；
 *  - 右侧面板分割线的命中区不再盖住对话列的滚动条（滚动条可点宽度 10px）；真鼠标能拖滑块、能拖分割线；
 *  - 日历点进某天仍落在当天第一条消息上，按钮随之出现；
 *  - 落点之后输入卡片更高（挂着询问）或末项自己长高（mermaid 图异步画出）：仍停在真底（SCR-10a/b，
 *    落地后的短暂跟随）。
 *
 * 列表是不带 followOutput 的 Virtuoso：经 IPC 发的消息不会把它滚走，所以每次断言落点之前都**重新打开**
 * 一次会话。滚动区的测量、按钮、命中测试、可信鼠标输入都在 pages.ts 的 `conversationScrollPane`。
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sleep, until } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import { startFakeProvider, type FakeProvider } from '../../harness/fakeProvider'
import { createProject, seedFakeProvider, waitRendererReady } from '../../harness/seed'
import {
  chatPane,
  conversationScrollPane,
  mermaidPane,
  rightPanelPane,
  sidebarPane,
  type ChatPane,
  type ConversationScrollPane,
  type ConversationScrollShot,
  type RightPanelPane,
  type SidebarPane
} from '../../harness/pages'

const MODEL = 'e2e-model'
const USAGE = { prompt: 200, completion: 50 }
/** 流式占位卡的固定 id（chat-ui 的 STREAMING_PLACEHOLDER_ID，跨进程的呈现契约，按值钉） */
const STREAMING_ID = 'streaming-live'
/** 按钮的宽限期是 800ms；「之后仍不显示」至少要看过这么久 */
const PAST_GRACE_MS = 950

let app: E2EApp
let provider: FakeProvider
let chat: ChatPane
let sidebar: SidebarPane
let scroll: ConversationScrollPane
let panel: RightPanelPane
const sids: Record<string, string> = {}

const TITLES = {
  l1: 'S-long-1',
  l2: 'S-long-2',
  running: 'S-running',
  empty: 'S-empty',
  ask: 'S-ask',
  figure: 'S-figure'
} as const

/** 一段约 50 段的长回答（每段一行多，整轮回答远高于一屏） */
const longAnswer = (tag: string, turn: number): string =>
  Array.from(
    { length: 50 },
    (_, i) =>
      `${tag} turn ${turn} paragraph ${i + 1}: the quick brown fox jumps over the lazy dog, ` +
      `and the lazy dog keeps on sleeping in the afternoon sun.`
  ).join('\n\n')

const listIds = (sid: string): Promise<string[]> =>
  app.main.eval<string[]>(
    `window.api.message.list(${JSON.stringify(sid)}).then((list) => list.map((m) => m.id))`
  )

/** 经 IPC 跑完 n 轮（agent.prompt 在这一轮落定时才返回） */
async function seedTurns(sid: string, tag: string, turns: number): Promise<void> {
  const before = (await listIds(sid)).length
  for (let t = 1; t <= turns; t++) {
    provider.script({ text: longAnswer(tag, t), usage: USAGE })
    await app.main.eval(
      `window.api.agent.prompt(${JSON.stringify({ sessionId: sid, text: `${tag} question ${t}` })}).then(() => true)`
    )
  }
  await until(
    async () => (await listIds(sid)).length === before + turns * 2,
    `${tag}: ${turns} turns persisted`
  )
}

/** 发一轮挂住的回复（不 await：它要等 release 才落定），等提供商真的挂上 */
async function startHeldTurn(sid: string, text: string): Promise<void> {
  provider.reset()
  provider.script({ text, holdMs: 60_000, usage: USAGE })
  await app.main.eval(
    `(window.api.agent.prompt(${JSON.stringify({ sessionId: sid, text: 'keep going' })}).catch(() => undefined), true)`
  )
  await until(() => provider.holding(), 'fake provider holding the turn')
}

/** 放掉挂住的那一轮并等它落定（会话须是当前会话 —— waitIdle 看的是对话区） */
async function finishHeldTurn(title: string): Promise<void> {
  provider.release()
  expect(await sidebar.openSession(title)).toBe(true)
  await chat.waitIdle()
}

/**
 * 打开一条会话、等列表停在真底，并核对落点：最后一项就是 `lastId`，底边在输入卡片之上且在视口里。
 * 返回打开的时刻与落点测量，供调用方再看按钮。
 */
async function openAndLand(
  title: string,
  lastId: string
): Promise<{ t0: number; shot: ConversationScrollShot }> {
  const t0 = Date.now()
  expect(await sidebar.openSession(title)).toBe(true)
  await chat.ready()
  const shot = await scroll.waitAtBottom()
  expect(shot.distToBottom).toBeLessThanOrEqual(4)
  expect(shot.lastItem?.id).toBe(lastId)
  const item = shot.lastItem!.rect
  const card = shot.inputCard!
  // 末项的底边不压在悬浮输入卡片下面，也确实在视口里（不是滚出去了的那种「底」）
  expect(item.bottom).toBeLessThanOrEqual(card.top + 1)
  expect(item.bottom).toBeGreaterThan(shot.rect.top)
  expect(item.bottom).toBeLessThanOrEqual(shot.rect.bottom)
  return { t0, shot }
}

/** 从 t0 起至少过了宽限期，按钮仍是隐藏态（从没显示过的话 opacity 一直是 0） */
async function expectButtonStillHidden(t0: number): Promise<void> {
  await sleep(Math.max(0, PAST_GRACE_MS - (Date.now() - t0)))
  const b = await scroll.button()
  expect(b.present).toBe(true)
  expect(b.shown).toBe(false)
  expect(b.opacity).toBeLessThanOrEqual(0.01)
}

const lastIdOf = async (sid: string): Promise<string> => (await listIds(sid)).at(-1)!

function localDayKey(date = new Date()): string {
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${mm}-${dd}`
}

beforeAll(async () => {
  app = await launchApp()
  provider = await startFakeProvider()
  await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  await waitRendererReady(app.main)

  const projDir = join(app.home, 'proj-scroll')
  mkdirSync(projDir, { recursive: true })
  const project = await createProject(app.main, { name: 'ScrollProj', path: projDir })
  // 标题显式给出：默认标题会触发自动标题，titler 的请求要从假提供商的队列里取一轮
  const create = (title: string): Promise<string> =>
    app.main.eval<string>(
      `window.api.session.create(${JSON.stringify({ title, projectId: project.id })}).then((s) => s.id)`
    )
  sids.l1 = await create(TITLES.l1)
  sids.l2 = await create(TITLES.l2)
  sids.running = await create(TITLES.running)
  sids.empty = await create(TITLES.empty)
  sids.ask = await create(TITLES.ask)
  sids.figure = await create(TITLES.figure)
  await seedTurns(sids.l1, 'L1', 6)
  await seedTurns(sids.l2, 'L2', 6)
  await seedTurns(sids.running, 'R', 4)

  chat = chatPane(app.main)
  sidebar = sidebarPane(app.main)
  scroll = conversationScrollPane(app.main)
  panel = rightPanelPane(app.main)
  await sidebar.clickNewChat()
  await until(async () => (await sidebar.titles()).includes(TITLES.figure), 'sidebar refreshed')
}, 240_000)

afterAll(async () => {
  provider?.release()
  await provider?.close()
  await app?.stop()
})

describe('落点', () => {
  it('SCR-1 首次打开、切去另一条长会话、再切回来：都落在真底，按钮不出现', async () => {
    const l1Last = await lastIdOf(sids.l1)
    const l2Last = await lastIdOf(sids.l2)

    const first = await openAndLand(TITLES.l1, l1Last)
    // 前提：最后一轮比一屏还高（「最后一项顶边贴顶」与「真底」在这里才分得开），整段远不止三屏
    expect(first.shot.lastItem!.rect.height).toBeGreaterThan(first.shot.clientHeight)
    expect(first.shot.scrollHeight).toBeGreaterThan(first.shot.clientHeight * 3)
    await expectButtonStillHidden(first.t0)

    const other = await openAndLand(TITLES.l2, l2Last)
    await expectButtonStillHidden(other.t0)

    const back = await openAndLand(TITLES.l1, l1Last)
    expect(back.shot.scrollTop).toBeGreaterThan(0)
    await expectButtonStillHidden(back.t0)
  })

  it('SCR-2 切回一条正在跑的会话：落在底部的流式卡上，按钮不出现', async () => {
    await startHeldTurn(sids.running, 'R live answer still streaming')
    try {
      await openAndLand(TITLES.l1, await lastIdOf(sids.l1))
      const back = await openAndLand(TITLES.running, STREAMING_ID)
      // 不是停在会话开头：历史有四轮长回答
      expect(back.shot.scrollTop).toBeGreaterThan(0)
      await expectButtonStillHidden(back.t0)
      expect((await scroll.button()).dots).toBe(0)
    } finally {
      await finishHeldTurn(TITLES.running)
    }
  })
})

describe('回到底部按钮', () => {
  it('SCR-4 在底部隐藏且点不到；略往上不出现；离底一屏半出现、居中压在输入卡片上方；真点一下回到底部', async () => {
    const { shot: atBottom } = await openAndLand(TITLES.l1, await lastIdOf(sids.l1))
    await sleep(PAST_GRACE_MS)

    const hidden = await scroll.button()
    expect(hidden).toMatchObject({
      present: true,
      shown: false,
      ariaHidden: 'true',
      tabIndex: -1,
      pointerEvents: 'none',
      hittable: false
    })
    expect(hidden.opacity).toBeLessThanOrEqual(0.01)

    // 末尾几行的距离（< 160px）不算「不在底部」
    await scroll.scrollToDistFromBottom(80)
    await sleep(400)
    expect((await scroll.button()).shown).toBe(false)

    await scroll.scrollToDistFromBottom(Math.round(atBottom.clientHeight * 1.5))
    const shown = await scroll.waitButton(true)
    expect(shown).toMatchObject({
      ariaHidden: 'false',
      tabIndex: 0,
      pointerEvents: 'auto',
      hittable: true,
      running: false,
      dots: 0
    })
    expect(shown.ariaLabel.length).toBeGreaterThan(0)
    const card = (await scroll.shot())!.inputCard!
    const btn = shown.rect!
    expect(Math.abs((btn.left + btn.right) / 2 - (card.left + card.right) / 2)).toBeLessThanOrEqual(
      2
    )
    expect(btn.bottom).toBeLessThanOrEqual(card.top)

    await scroll.clickButton()
    const landed = await scroll.waitAtBottom()
    expect(landed.lastItem!.rect.bottom).toBeLessThanOrEqual(landed.inputCard!.top + 1)
    await scroll.waitButton(false)

    // 远处（三屏开外）：直接跳回去，几秒内到底
    await scroll.scrollTo(0)
    const far = (await scroll.shot())!
    expect(far.distToBottom).toBeGreaterThan(far.clientHeight * 3)
    await scroll.waitButton(true)
    await scroll.clickButton()
    const back = await scroll.waitAtBottom(4, 5_000)
    expect(back.lastItem!.rect.bottom).toBeLessThanOrEqual(back.inputCard!.top + 1)
    await scroll.waitButton(false)
  })

  it('SCR-8 按钮状态只属于一条会话：滚上去的会话切走不带过去、切回来落在底；切换途中从不闪；空会话没有按钮', async () => {
    const l1Last = await lastIdOf(sids.l1)
    const l2Last = await lastIdOf(sids.l2)

    const { shot } = await openAndLand(TITLES.l1, l1Last)
    await scroll.scrollToDistFromBottom(Math.round(shot.clientHeight * 1.5))
    await scroll.waitButton(true)

    await openAndLand(TITLES.l2, l2Last)
    await sleep(1_000)
    expect((await scroll.button()).shown).toBe(false)

    const back = await openAndLand(TITLES.l1, l1Last)
    await expectButtonStillHidden(back.t0)

    // 两次切换的每一帧里按钮都没显示过（也没淡入一半）
    const watch = await scroll.watchButton()
    await openAndLand(TITLES.l2, l2Last)
    const last = await openAndLand(TITLES.l1, l1Last)
    await sleep(Math.max(0, PAST_GRACE_MS - (Date.now() - last.t0)))
    const frames = await watch.stop()
    expect(frames.frames).toBeGreaterThan(10)
    expect(frames.shownFrames).toBe(0)

    expect(await sidebar.openSession(TITLES.empty)).toBe(true)
    await until(() => scroll.emptyState(), 'empty-session hint on screen')
    expect((await scroll.button()).present).toBe(false)
  })

  it('SCR-11 运行中滚上去：按钮带运行指示；这一轮跑完（仍在上面）指示撤掉、箭头留下', async () => {
    await startHeldTurn(sids.running, 'R second live answer')
    try {
      await openAndLand(TITLES.l1, await lastIdOf(sids.l1))
      const { shot } = await openAndLand(TITLES.running, STREAMING_ID)
      await scroll.scrollToDistFromBottom(Math.round(shot.clientHeight * 1.5))
      const running = await scroll.waitButton(true)
      expect(running.running).toBe(true)
      expect(running.dots).toBe(3)
    } finally {
      provider.release()
    }
    await chat.waitIdle()
    const idle = await until(async () => {
      const b = await scroll.button()
      return !b.running ? b : null
    }, 'run indicator gone after the run settled')
    expect(idle.shown).toBe(true)
    expect(idle.dots).toBe(0)
    expect((await scroll.shot())!.distToBottom).toBeGreaterThan(160)
  })
})

describe('右侧面板分割线与滚动条', () => {
  it('SCR-6 面板开着：滚动条可点 10px，整条都归滚动区；分割线的命中区只在面板一侧', async () => {
    await openAndLand(TITLES.l1, await lastIdOf(sids.l1))
    await panel.open()
    // 等布局停稳（面板挂上后对话列变窄）
    const stable = await until(async () => {
      const a = await scroll.shot()
      const d = await scroll.dividerRect()
      if (!a || !d) return null
      await sleep(200)
      const b = await scroll.shot()
      return b && b.rect.right === a.rect.right ? { shot: b, divider: d } : null
    }, 'chat column laid out next to the right panel')
    const { shot, divider } = stable

    expect(shot.scrollbarWidth).toBe(10)
    expect(Math.abs(divider.left - shot.rect.right)).toBeLessThanOrEqual(1)

    const mid = shot.rect.top + shot.rect.height / 2
    for (const dx of [1, 2, 3, 4, 7, 9]) {
      const hit = await scroll.hitAt(shot.rect.right - dx, mid)
      expect({ dx, ...hit }).toMatchObject({ dx, scroller: true, divider: false })
    }
    expect((await scroll.hitAt(divider.left + 3, mid)).divider).toBe(true)
    expect((await scroll.hitAt(divider.left - 1, mid)).divider).toBe(false)
  })

  it('SCR-7 真鼠标拖滚动条滑块：列表滚动、面板宽度不变；拖分割线：面板变宽、列表不动', async () => {
    await openAndLand(TITLES.l1, await lastIdOf(sids.l1))
    await panel.open()

    for (const inset of [2, 8]) {
      await scroll.scrollTo(0)
      await sleep(300)
      const before = (await scroll.shot())!
      const width0 = await scroll.rightPanelWidth()
      // 滑块长度与位置按比例算（自定义滚动条没有两端的箭头按钮）
      const thumbLen = (before.clientHeight * before.clientHeight) / before.scrollHeight
      const thumbY =
        before.rect.top + (before.scrollTop / before.scrollHeight) * before.clientHeight
      const x = before.rect.right - inset
      const y = thumbY + thumbLen / 2
      await scroll.drag({ x, y }, { x, y: y + 120 })
      const after = (await scroll.shot())!
      expect({ inset, moved: after.scrollTop - before.scrollTop > 500 }).toEqual({
        inset,
        moved: true
      })
      expect(await scroll.rightPanelWidth()).toBe(width0)
    }

    const shot = (await scroll.shot())!
    const divider = (await scroll.dividerRect())!
    const width0 = await scroll.rightPanelWidth()
    const y = shot.rect.top + shot.rect.height / 2
    await scroll.drag({ x: divider.left + 3, y }, { x: divider.left + 3 - 80, y })
    await until(
      async () => Math.abs((await scroll.rightPanelWidth()) - (width0 + 80)) <= 2,
      'right panel widened by the divider drag'
    )
    expect(Math.abs((await scroll.shot())!.scrollTop - shot.scrollTop)).toBeLessThanOrEqual(1)
  })
})

describe('日历跳转', () => {
  it('SCR-9 日历点进某天：落在当天第一条消息上（不在底部），按钮随之出现，点它回到底部', async () => {
    const target = await app.main.eval<string | null>(
      `window.api.calendar.firstEntryOnDay(${JSON.stringify({ sessionId: sids.l1, day: localDayKey() })})`
    )
    expect(target).toBeTruthy()

    const expectAtTarget = async (): Promise<void> => {
      await until(async () => {
        const s = await scroll.shot()
        const r = await scroll.msgRect(target!)
        if (!s || !r) return false
        return r.top >= s.rect.top - 2 && r.top <= s.rect.top + 60
      }, 'calendar target message at the top of the list')
      expect((await scroll.shot())!.distToBottom).toBeGreaterThan(160)
    }

    // 从另一条会话点进来（请求与视图谁先到不定：两条路都得落在目标上）
    await openAndLand(TITLES.l2, await lastIdOf(sids.l2))
    await panel.open()
    await panel.activateCalendarTab()
    const t0 = Date.now()
    await panel.clickCalendarSession(TITLES.l1)
    await until(async () => (await sidebar.activeTitle()) === TITLES.l1, 'S-long-1 active')
    await expectAtTarget()
    await scroll.waitButton(true, Math.max(500, 2_000 - (Date.now() - t0)))
    await scroll.clickButton()
    await scroll.waitAtBottom()
    await scroll.waitButton(false)

    // 同一份列表上再在日历里点它一次：照样跳过去（初始位置若是从上一条日历请求来的，这一条不能被当成
    // 「已经用掉的那条」只清不滚 —— 单测 CAL-6 把这条路钉死，这里不论请求先到后到都得落在目标上）
    await panel.clickCalendarSession(TITLES.l1)
    await expectAtTarget()

    // 列表经侧栏正常打开（初始位置是底部）、初始定位早已落地之后，再在日历里点它：照样跳过去。
    // 先经侧栏切走再切回，让这份列表的初始位置是底部
    await openAndLand(TITLES.l2, await lastIdOf(sids.l2))
    const back = await openAndLand(TITLES.l1, await lastIdOf(sids.l1))
    await expectButtonStillHidden(back.t0)
    await panel.clickCalendarSession(TITLES.l1)
    await expectAtTarget()
    await scroll.waitButton(true, 2_000)
    await panel.close()
  })
})

/**
 * 落点之后末项或输入卡片才长高：列表落地后会短暂跟着底部（chat-ui Conversation 的 PIN_TO_BOTTOM_MS），
 * 否则会停在离真底约 29px 处（distToBottom 29 / 29.5 稳定不动），末项最后约 21px 压在输入卡片下面，按钮也
 * 不出（离底不到 160px）。没有跟随时实测：10b 整份跑约三次败两次、单跑 `-t SCR-10` 五次全败；10a 约二十次
 * 败两次（切回挂着询问的会话，流式卡底边 531 > 卡片顶 509.6）。
 */
describe('落点之后内容 / 输入卡片还在变', () => {
  it('SCR-10a 最后一轮停在询问卡片上（输入卡片因此高出一大截）：切回来末项仍在卡片之上', async () => {
    await seedTurns(sids.ask, 'A', 3)
    provider.reset()
    provider.script({
      toolCalls: [
        {
          id: 'scr10_ask',
          name: 'ask',
          args: JSON.stringify({
            question: 'Which tone?',
            options: [
              { label: 'Formal', description: 'Keep it formal' },
              { label: 'Casual', description: 'Loosen it up' },
              { label: 'Neutral', description: 'Somewhere in between' }
            ]
          })
        }
      ],
      usage: USAGE
    })
    await app.main.eval(
      `(window.api.agent.prompt(${JSON.stringify({ sessionId: sids.ask, text: 'ask me' })}).catch(() => undefined), true)`
    )
    try {
      expect(await sidebar.openSession(TITLES.ask)).toBe(true)
      await until(
        async () => (await chat.pendingPanel()).open,
        'ask card pending in the input card'
      )
      for (let round = 0; round < 2; round++) {
        await openAndLand(TITLES.l1, await lastIdOf(sids.l1))
        const { shot } = await openAndLand(TITLES.ask, STREAMING_ID)
        // 前提：询问卡片确实并进了输入卡片，卡片比平时高得多（平时一行输入约 86px）
        expect(await chat.pendingPanel()).toEqual({ open: true, firstInCard: true })
        expect(shot.inputCard!.height).toBeGreaterThan(150)
      }
    } finally {
      await app.main.eval(`window.api.agent.abort(${JSON.stringify(sids.ask)})`)
      await chat.waitIdle()
    }
  })

  it('SCR-10b 最后一条回答末尾是 mermaid 图（落点之后才异步画出来、把卡片撑高）：仍停在真底', async () => {
    await seedTurns(sids.figure, 'F', 3)
    const figure = [
      '```mermaid',
      'flowchart TD',
      '  A[Start] --> B{Check}',
      '  B -->|yes| C[Do one]',
      '  B -->|no| D[Do two]',
      '  C --> E[End]',
      '  D --> E',
      '```'
    ].join('\n')
    provider.reset()
    provider.script({
      text: `${longAnswer('FIG-MARK', 4)}\n\n${figure}`,
      usage: USAGE
    })
    await app.main.eval(
      `window.api.agent.prompt(${JSON.stringify({ sessionId: sids.figure, text: 'draw it' })}).then(() => true)`
    )
    const last = await lastIdOf(sids.figure)

    // 第一次打开：图还没画过（没有缓存），落点之后才长出来
    await openAndLand(TITLES.figure, last)
    await mermaidPane(app.main, 'FIG-MARK').waitFigure()
    const settled = await scroll.waitAtBottom()
    expect(settled.lastItem?.id).toBe(last)
    expect(settled.lastItem!.rect.bottom).toBeLessThanOrEqual(settled.inputCard!.top + 1)

    await openAndLand(TITLES.l1, await lastIdOf(sids.l1))
    await openAndLand(TITLES.figure, last)
  })
})
