/**
 * 压缩前的历史往上翻就能看（2026-11-23）：真的自动压缩 → 视图第一条是压缩分隔线 → 翻到顶，压缩掉的那一段经
 * `message.listCompacted` 接在上面（chat-ui useCompactedHistory + MessageList 的 firstItemIndex）。
 *
 *   E-1 一次压缩：打开（切走再切回）落在真底，第一条是分隔线，U1 不在 DOM 里；IPC 交回的那一段以 U1 开头、
 *       不以摘要开头；滚到顶 → 那一段接上来；再到顶 U1 出现在分隔线之上；
 *       所有 data-msg-id 唯一；旧用户气泡没有回退、旧卡没有分支，当前的照旧都有；切走再切回 → 接上的没了，
 *       要再翻到顶才回来
 *   E-3 翻到最顶时屏上不动：接上那一段的前后，分隔线逐帧 ≤ 2px（一次压缩的会话，两次压缩的会话的第一次）
 *   E-2 两次压缩接成链：第一次到顶接上以 SUMMARY-1 分隔线开头的那一段，再到顶接上 U1…，第三次什么都
 *       不添；整份列表恰两条分隔线、id 唯一、U1 在最前；主进程没有未捕获异常、没有 listCompacted 的错误行
 *
 * 怎么拿到真的自动压缩：模型的上下文窗口设成 40k（`maxInputTokens`），于是保留窗口 = 10k token、阻塞阈值 =
 * 40k − 10k = 30k。pi 在**下一次请求准备时**判阈值（看最新一条助手消息上报的用量）：倒数第二轮回答上报 35k
 * 的用量，下一轮一发就先压缩（摘要请求的系统提示带「context summarization assistant」，按内容认领，回
 * `SUMMARY-n`），再发这一轮。保留窗口按字符 / 4 估：每轮回答约 12KB（≈3k token），五轮大回答之后切点落在
 * 第二轮里，U1 R1 U2 被压缩掉。会话标题显式给出，自动标题不发请求。
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sleep, until } from '../../harness/cdp'
import { launchApp, uncaughtExceptions, type E2EApp } from '../../harness/launch'
import { startFakeProvider, type FakeProvider, type FakeRequest } from '../../harness/fakeProvider'
import { createProject, seedFakeProvider, waitRendererReady } from '../../harness/seed'
import {
  chatPane,
  compactedHistoryPane,
  conversationScrollPane,
  sidebarPane,
  type ChatPane,
  type CompactedHistoryPane,
  type ConversationScrollPane,
  type SidebarPane
} from '../../harness/pages'

const MODEL = 'e2e-model'
const CONTEXT_WINDOW = 40_000
const SMALL = { prompt: 300, completion: 50 }
/** 超过阻塞阈值（40k − 10k）的用量：下一次请求之前先压缩 */
const HIGH = { prompt: 35_000, completion: 50 }
/** Virtuoso 的 firstItemIndex 起点（chat-ui Conversation 的 FIRST_ITEM_BASE，按值钉） */
const BASE = 1_000_000

const TITLES = { once: 'CH-once', twice: 'CH-twice', other: 'CH-other' } as const

let app: E2EApp
let provider: FakeProvider
let chat: ChatPane
let sidebar: SidebarPane
let scroll: ConversationScrollPane
let pane: CompactedHistoryPane
const sids: Record<keyof typeof TITLES, string> = { once: '', twice: '', other: '' }

const isSummarizer = (req: FakeRequest): boolean =>
  req.raw.includes('context summarization assistant')
const notSummarizer = (req: FakeRequest): boolean => !isSummarizer(req)

/** 约 12KB 的回答（≈3k token），每段带着标记，好在 DOM 里认出它 */
const bulk = (marker: string): string =>
  Array.from(
    { length: 60 },
    (_, i) =>
      `${marker} paragraph ${i + 1}: the quick brown fox jumps over the lazy dog, ` +
      `and the lazy dog keeps on sleeping in the warm afternoon sun, again and again and again.`
  ).join('\n\n')

interface Msg {
  id: string
  role: string
  content: string
  metadata?: { isCompactionSummary?: boolean } | null
}

const list = (sid: string): Promise<Msg[]> =>
  app.main.eval<Msg[]>(
    `window.api.message.list(${JSON.stringify(sid)}).then((l) => l.map((m) => ({ id: m.id, role: m.role, content: m.content, metadata: m.metadata ?? null })))`
  )
const listCompacted = (sid: string, compactionId: string): Promise<Msg[]> =>
  app.main.eval<Msg[]>(
    `window.api.message.listCompacted(${JSON.stringify({ sessionId: sid, compactionId })}).then((l) => l.map((m) => ({ id: m.id, role: m.role, content: m.content, metadata: m.metadata ?? null })))`
  )
const isSummary = (m: Msg | undefined): boolean => m?.metadata?.isCompactionSummary === true

async function prompt(sid: string, text: string): Promise<void> {
  await app.main.eval(
    `window.api.agent.prompt(${JSON.stringify({ sessionId: sid, text })}).then(() => true)`
  )
}

/** 第 from..to 轮：U<n>-<tag> 问、R<n>-<tag> 答（大）；`high` 那一轮回答短、上报超阈值的用量 */
async function turns(
  sid: string,
  tag: string,
  from: number,
  to: number,
  high?: number
): Promise<void> {
  for (let n = from; n <= to; n++) {
    const isHigh = n === high
    provider.script({
      text: isHigh ? `R${n}-${tag} short answer` : bulk(`R${n}-${tag}`),
      usage: isHigh ? HIGH : SMALL,
      when: notSummarizer
    })
    await prompt(sid, `U${n}-${tag} question`)
  }
}

/** 下一轮一发就先压缩：摘要回 `summary`，再答这一轮；等视图第一条成了这次的摘要 */
async function triggerCompaction(
  sid: string,
  tag: string,
  n: number,
  summary: string
): Promise<void> {
  const requests = provider.requests().filter(isSummarizer).length
  provider.script({ text: summary, usage: SMALL, when: isSummarizer })
  provider.script({ text: `R${n}-${tag} after compaction`, usage: SMALL, when: notSummarizer })
  await prompt(sid, `U${n}-${tag} question`)
  await until(
    async () => {
      const first = (await list(sid))[0]
      return isSummary(first) && first!.content.includes(summary) ? true : null
    },
    `${tag}: ${summary} heads the view`,
    30_000
  )
  expect(provider.requests().filter(isSummarizer).length).toBe(requests + 1)
}

async function openAndLand(title: string): Promise<void> {
  expect(await sidebar.openSession(title)).toBe(true)
  await chat.ready()
  await scroll.waitAtBottom()
}

/**
 * 滚到最顶并逐帧记下分隔线 `msgId` 的 top，以及此刻有没有 `data-item-index` 小于起点的项（= 上面接上了东西），
 * 接上之后再看 `afterMs`；交回接上之前最后一帧的 top 与之后每一帧的 top（分隔线不在 DOM 里的帧记 null）
 */
async function scrollTopAndWatch(
  msgId: string,
  afterMs = 500
): Promise<{ before: number; after: Array<number | null> }> {
  const frames = await app.main.eval<
    Array<{ top: number | null; prepended: boolean }>
  >(`new Promise((resolve) => {
    const id = ${JSON.stringify(msgId)}
    const el = document.querySelector('.conversation-scroller')
    const read = () => {
      const host = el.querySelector('[data-msg-id="' + CSS.escape(id) + '"]')
      const line = host?.querySelector('[data-compaction-divider]')
      const prepended = [...el.querySelectorAll('[data-item-index]')].some(
        (w) => Number(w.getAttribute('data-item-index')) < ${BASE}
      )
      return { top: line ? line.getBoundingClientRect().top : null, prepended }
    }
    const out = []
    let start = null
    let prependedAt = null
    // 读的是画出来的那一帧：rAF 里排一个 setTimeout(0)，它在这一帧的 rAF 回调、尺寸观察与绘制都过去之后才跑。
    // 直接在 rAF 里读，读到的可能是同一帧里别的回调（列表摆回位置的那一个）还没跑时的半成品 —— 那一帧从没画出来过
    const tick = (now) => {
      setTimeout(() => {
        if (start === null) start = now
        const f = read()
        out.push(f)
        if (prependedAt === null && f.prepended) prependedAt = now
        if ((prependedAt !== null && now - prependedAt >= ${afterMs}) || now - start > 8000) resolve(out)
        else requestAnimationFrame(tick)
      }, 0)
    }
    el.scrollTop = 0
    requestAnimationFrame(tick)
  })`)
  const cut = frames.findIndex((f) => f.prepended)
  expect(cut, 'the older stretch got prepended').toBeGreaterThan(0)
  const pre = frames.slice(0, cut).filter((f) => f.top !== null)
  expect(pre.length, 'a frame with the divider at the top before the prepend').toBeGreaterThan(0)
  return { before: pre.at(-1)!.top!, after: frames.slice(cut).map((f) => f.top) }
}

/** 翻到顶，等 `ok`；没等到再翻一次（最多五次） */
async function reachTopUntil(ok: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await pane.scrollToTop()
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      if (await ok()) return
      await sleep(100)
    }
  }
  throw new Error(`timeout: ${what}`)
}

function expectNoJump(watch: { before: number; after: Array<number | null> }): void {
  expect(watch.after.length).toBeGreaterThan(3)
  const trace = `before ${watch.before}, after ${JSON.stringify(watch.after.slice(0, 12))}`
  for (const top of watch.after) {
    expect(top, `the divider stays rendered (${trace})`).not.toBeNull()
    expect(Math.abs(top! - watch.before), trace).toBeLessThanOrEqual(2)
  }
}

beforeAll(async () => {
  app = await launchApp()
  provider = await startFakeProvider()
  await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  await app.main.eval(`(async () => {
    const p = (await window.api.provider.listAll()).find((x) => x.name === 'E2E Fake')
    const row = (await window.api.provider.listModels(p.id)).find((m) => m.modelId === ${JSON.stringify(MODEL)})
    await window.api.provider.updateModelCapabilities({
      id: row.id,
      capabilities: { maxInputTokens: ${CONTEXT_WINDOW}, maxOutputTokens: 4096, vision: true }
    })
    return true
  })()`)
  await waitRendererReady(app.main)

  const projDir = join(app.home, 'proj-compacted')
  mkdirSync(projDir, { recursive: true })
  const project = await createProject(app.main, { name: 'CompactedProj', path: projDir })
  const create = (title: string): Promise<string> =>
    app.main.eval<string>(
      `window.api.session.create(${JSON.stringify({ title, projectId: project.id })}).then((s) => s.id)`
    )
  sids.other = await create(TITLES.other)
  sids.once = await create(TITLES.once)
  sids.twice = await create(TITLES.twice)

  provider.script({ text: 'other answer', usage: SMALL, when: notSummarizer })
  await prompt(sids.other, 'other question')

  // once：五轮大回答 + 一轮短回答（超阈值用量）+ 触发压缩的一轮
  await turns(sids.once, 'A', 1, 6, 6)
  await triggerCompaction(sids.once, 'A', 7, 'SUMMARY-1')

  // twice：同样压缩一次，再四轮大回答 + 一轮超阈值 + 触发第二次压缩
  await turns(sids.twice, 'C', 1, 6, 6)
  await triggerCompaction(sids.twice, 'C', 7, 'SUMMARY-1')
  await turns(sids.twice, 'C', 8, 12, 12)
  await triggerCompaction(sids.twice, 'C', 13, 'SUMMARY-2')

  chat = chatPane(app.main)
  sidebar = sidebarPane(app.main)
  scroll = conversationScrollPane(app.main)
  pane = compactedHistoryPane(app.main)
  await until(
    async () => (await sidebar.titles()).includes(TITLES.twice) || null,
    'sidebar lists the sessions'
  )
}, 300_000)

afterAll(async () => {
  await provider?.close()
  await app?.stop()
})

describe('压缩前的历史', () => {
  it('E-1 one compaction: lands at the bottom, scrolling to the top prepends the stretch; old items are read-only; switching away and back discards it', async () => {
    const view = await list(sids.once)
    const head = view[0]!
    expect(isSummary(head)).toBe(true)
    expect(view.some((m) => m.content.startsWith('U1-A'))).toBe(false)

    // IPC：那一段以 U1 开头、不以摘要开头，与当前视图不重叠
    const segment = await listCompacted(sids.once, head.id)
    expect(segment[0]!.content).toBe('U1-A question')
    expect(isSummary(segment[0])).toBe(false)
    const currentIds = new Set(view.map((m) => m.id))
    expect(segment.some((m) => currentIds.has(m.id))).toBe(false)
    const u1 = segment[0]!.id
    const r1 = segment.find((m) => m.role === 'assistant')!.id

    await openAndLand(TITLES.other)
    await openAndLand(TITLES.once)
    expect((await pane.items()).some((i) => i.text.includes('U1-A'))).toBe(false)
    // 当前的照旧：最后一个用户气泡能回退，最后一张卡能分支
    const lastUser = view.filter((m) => m.role === 'user').at(-1)!.id
    const lastAnswer = view.at(-1)!.id
    expect(await pane.hasRollback(lastUser)).toBe(true)
    expect(await pane.hasFork(lastAnswer)).toBe(true)

    // 滚到顶：那一段接上来（不跳是 E-3 的事）
    await pane.scrollToTop()
    await until(
      async () => ((await pane.items()).some((i) => i.itemIndex < BASE) ? true : null),
      'the compacted stretch prepended'
    )

    // 再到顶：U1 在分隔线之上
    await pane.scrollToTop()
    await until(
      async () => ((await pane.items()).some((i) => i.msgId === u1) ? true : null),
      'U1 rendered at the top'
    )
    const items = await pane.items()
    const u1Item = items.find((i) => i.msgId === u1)!
    expect(u1Item.text).toContain('U1-A question')
    const divider = (await pane.scan()).find((i) => i.msgId === head.id && i.divider)!
    expect(u1Item.itemIndex).toBeLessThan(divider.itemIndex)
    await pane.scrollToTop()
    await until(
      async () => ((await pane.items()).some((i) => i.msgId === u1) ? true : null),
      'U1 back on screen'
    )
    // 旧的只读
    expect(await pane.hasRollback(u1)).toBe(false)
    await until(
      async () => ((await pane.items()).some((i) => i.msgId === r1) ? true : null),
      'R1 rendered'
    )
    expect(await pane.hasFork(r1)).toBe(false)

    // 整份列表：id 唯一，只有一条分隔线
    const all = await pane.scan()
    const ids = all.map((i) => i.msgId)
    expect(new Set(ids).size).toBe(ids.length)
    expect(all.filter((i) => i.divider).map((i) => i.msgId)).toEqual([head.id])
    expect(all[0]!.msgId).toBe(u1)

    // 切走再切回：接上的没了（firstItemIndex 回到起点），要再翻到顶才回来
    await openAndLand(TITLES.other)
    await openAndLand(TITLES.once)
    const back = await pane.items()
    expect(back.some((i) => i.text.includes('U1-A'))).toBe(false)
    expect(Math.min(...back.map((i) => i.itemIndex))).toBeGreaterThanOrEqual(BASE)
    await sleep(800)
    expect((await pane.items()).some((i) => i.itemIndex < BASE)).toBe(false)
    await pane.scrollToTop()
    await until(
      async () => ((await pane.items()).some((i) => i.itemIndex < BASE) ? true : null),
      'the stretch comes back after reaching the top again'
    )
  }, 120_000)

  it('E-2 two compactions chain: the first top-reach adds the SUMMARY-1 stretch, the second U1…, the third nothing; two dividers, unique ids, no errors', async () => {
    const view = await list(sids.twice)
    const h2 = view[0]!
    expect(h2.content).toContain('SUMMARY-2')
    const seg2 = await listCompacted(sids.twice, h2.id)
    expect(isSummary(seg2[0])).toBe(true)
    expect(seg2[0]!.content).toContain('SUMMARY-1')
    const h1 = seg2[0]!.id
    const seg1 = await listCompacted(sids.twice, h1)
    expect(seg1[0]!.content).toBe('U1-C question')
    expect(isSummary(seg1[0])).toBe(false)
    const u1 = seg1[0]!.id

    await openAndLand(TITLES.other)
    await openAndLand(TITLES.twice)

    // 第一次到顶：接上以 SUMMARY-1 分隔线开头的那一段（不跳是 E-3 的事）
    await pane.scrollToTop()
    await until(
      async () => ((await pane.items()).some((i) => i.itemIndex < BASE) ? true : null),
      'the SUMMARY-1 stretch prepended'
    )

    // 再到顶（必要时几次）：接上 U1…
    await reachTopUntil(async () => (await pane.items()).some((i) => i.msgId === u1), 'U1 rendered')

    // 第三次到顶：什么都不添
    const minIndex = async (): Promise<number> =>
      Math.min(...(await pane.items()).map((i) => i.itemIndex))
    const top = await minIndex()
    await pane.scrollToTop()
    await sleep(1500)
    await pane.scrollToTop()
    await sleep(300)
    expect(await minIndex()).toBe(top)

    const all = await pane.scan()
    const ids = all.map((i) => i.msgId)
    expect(new Set(ids).size).toBe(ids.length)
    expect(all.filter((i) => i.divider).map((i) => i.msgId)).toEqual([h1, h2.id])
    expect(all[0]!.msgId).toBe(u1)
    // 下标连续：没有漏项、没有重叠
    all.forEach((item, i) => expect(item.itemIndex).toBe(all[0]!.itemIndex + i))

    expect(uncaughtExceptions(app)).toBe('')
    const bad = app
      .mainLog()
      .split('\n')
      .filter((line) => line.includes('listCompacted') && /error|fail/i.test(line))
    expect(bad).toEqual([])
  }, 120_000)

  it('E-3 reaching the very top does not move what is on screen: the divider stays put while the older stretch is prepended (one compaction, then the first of two)', async () => {
    const once = (await list(sids.once))[0]!
    await openAndLand(TITLES.other)
    await openAndLand(TITLES.once)
    expectNoJump(await scrollTopAndWatch(once.id))

    const twice = (await list(sids.twice))[0]!
    await openAndLand(TITLES.other)
    await openAndLand(TITLES.twice)
    expectNoJump(await scrollTopAndWatch(twice.id))
  }, 60_000)
})
