/**
 * 打开一条有记录的会话：空态（会话设置面板）一次都不出现，等视图到了直接是消息（chat-ui Conversation 的空态门）。
 * 从前只看「消息是空的」，而视图到达之前消息本来就是空的，于是每次切会话都先闪一下设置面板。
 * 消息上屏得慢时画骨架（ConversationSkeleton）：过 200ms 才出现，出现了至少留 250ms，消息可见了才撤。
 *
 *   OPEN-1 两条有记录的会话来回切：每次 DOM 提交都没有空态，目标会话的消息最终上屏；不到 200ms 就上屏的那几次没有骨架
 *   OPEN-2 从欢迎页（没有当前会话）打开：同上
 *   OPEN-3 停在有记录的会话上重载窗口：同上（整个页面从头来，看守脚本在页面脚本之前装好）
 *   OPEN-4 真正的空会话：空态照常出现并留在那里
 *   OPEN-6 长会话：第一次可见时已经停在底部，之后不跳（列表在 Virtuoso 的定时器之前就揭开，见 ConversationList）
 *   OPEN-5 视图迟到（主进程停住 900ms，真的一个视图都到不了）：空白 → 骨架 → 消息，骨架铺满对话区、不压输入卡片
 *
 * 判据用 MutationObserver 而不是截帧：它看得到每一次提交，窗口在不在前台都一样，闪一帧也漏不掉。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sleep, until } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import { startFakeProvider, type FakeProvider } from '../../harness/fakeProvider'
import { seedFakeProvider, waitRendererReady } from '../../harness/seed'
import { chatPane, sidebarPane, type ChatPane, type SidebarPane } from '../../harness/pages'

const MODEL = 'e2e-model'
const USAGE = { prompt: 200, completion: 50 }
const TITLES = { a: 'OPEN-a', b: 'OPEN-b', empty: 'OPEN-empty', long: 'OPEN-long' } as const
/** 一段远高于一屏的回答 */
const LONG_ANSWER = Array.from(
  { length: 50 },
  (_, i) => `paragraph ${i + 1}: the quick brown fox jumps over the lazy dog in the afternoon sun.`
).join('\n\n')
const EMPTY = '[data-conversation-empty]'
const SKELETON = '[data-conversation-skeleton]'
/** 主进程停多久：远超骨架的 200ms + 250ms，骨架非出现不可 */
const STALL_MS = 900

let app: E2EApp
let provider: FakeProvider
let chat: ChatPane
let sidebar: SidebarPane
const sids: Record<string, string> = {}
const ids: Record<string, string[]> = {}

/** 在页面里记下每次 DOM 提交时空态在不在、目标消息第一次上屏的时刻（幂等：页面脚本之前装也行） */
const WATCH = `(() => {
  window.__openWatch = { emptyCommits: 0, targets: [], t0: 0, shownAt: 0, skeletonAt: 0, skeletonGoneAt: 0, fit: null, firstDist: 0, maxDist: 0 }
  const distToBottom = () => {
    const s = document.querySelector('[data-virtuoso-scroller]')
    return s ? s.scrollHeight - s.scrollTop - s.clientHeight : 0
  }
  const scan = () => {
    const w = window.__openWatch
    if (document.querySelector(${JSON.stringify(EMPTY)})) w.emptyCommits++
    const skeleton = document.querySelector(${JSON.stringify(SKELETON)})
    if (skeleton && !w.skeletonAt) {
      w.skeletonAt = performance.now()
      const area = skeleton.getBoundingClientRect()
      const inputHeight = parseFloat(getComputedStyle(skeleton).paddingBottom)
      const inner = skeleton.firstElementChild
      const column = inner.getBoundingClientRect()
      const bars = skeleton.querySelectorAll('.rounded')
      w.fit = {
        filled: column.top <= area.top,
        lastBarBottom: bars[bars.length - 1].getBoundingClientRect().bottom,
        inputTop: area.bottom - inputHeight,
        pulsing: getComputedStyle(inner).animationName !== 'none'
      }
    }
    if (!skeleton && w.skeletonAt && !w.skeletonGoneAt) w.skeletonGoneAt = performance.now()
    // 可见才算上屏：列表定位好之前 Virtuoso 把内容藏着（visibility: hidden）
    const visible = (id) => {
      const el = document.querySelector('[data-msg-id=' + JSON.stringify(id) + ']')
      return !!el && getComputedStyle(el).visibility === 'visible'
    }
    if (!w.shownAt && w.targets.some(visible)) {
      w.shownAt = performance.now()
      w.firstDist = distToBottom()
    }
    // 第一次可见之后离底部最远到过多少：大于 0 太多就是用户看见了一次跳动
    if (w.shownAt) w.maxDist = Math.max(w.maxDist, distToBottom())
  }
  new MutationObserver(scan).observe(document, { childList: true, subtree: true, attributes: true })
  document.addEventListener('scroll', scan, { capture: true, passive: true })
})()`

interface WatchShot {
  emptyCommits: number
  shownAt: number
  t0: number
  skeletonAt: number
  skeletonGoneAt: number
  fit: { filled: boolean; lastBarBottom: number; inputTop: number; pulsing: boolean } | null
  firstDist: number
  maxDist: number
}

/** 重新布防：清零计数，下一次打开要等的是这些消息 */
const arm = (targets: string[]): Promise<boolean> =>
  app.main.eval<boolean>(
    `(() => {
      Object.assign(window.__openWatch, {
        emptyCommits: 0,
        targets: ${JSON.stringify(targets)},
        t0: performance.now(),
        shownAt: 0,
        skeletonAt: 0,
        skeletonGoneAt: 0,
        fit: null,
        firstDist: 0,
        maxDist: 0
      })
      return true
    })()`
  )

const shot = (): Promise<WatchShot> =>
  app.main.eval<WatchShot>(`(() => {
    const { emptyCommits, shownAt, t0, skeletonAt, skeletonGoneAt, fit, firstDist, maxDist } = window.__openWatch
    return { emptyCommits, shownAt, t0, skeletonAt, skeletonGoneAt, fit, firstDist, maxDist }
  })()`)

const hasMessage = (targets: string[]): Promise<boolean> =>
  app.main.eval<boolean>(
    `${JSON.stringify(targets)}.some((id) => document.querySelector('[data-msg-id=' + JSON.stringify(id) + ']'))`
  )

/** 打开一条有记录的会话，等它的消息上屏，核对这一路没有空态 */
async function openWithHistory(title: string, sid: string): Promise<number> {
  await arm(ids[sid])
  expect(await sidebar.openSession(title)).toBe(true)
  await until(async () => (await shot()).shownAt > 0, `${title}: messages on screen`)
  const seen = await shot()
  expect(seen.emptyCommits).toBe(0)
  // 上屏得比骨架的 200ms 还早：骨架不能出现（这次慢不慢由机器定，只有快的那几次才能这么断言）
  if (seen.shownAt - seen.t0 < 190) expect(seen.skeletonAt).toBe(0)
  return seen.shownAt - seen.t0
}

beforeAll(async () => {
  app = await launchApp()
  provider = await startFakeProvider()
  await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  await waitRendererReady(app.main)

  // 标题显式给出：默认标题会触发自动标题，titler 的请求要从假提供商的队列里取一轮
  const create = (title: string): Promise<string> =>
    app.main.eval<string>(
      `window.api.session.create(${JSON.stringify({ title })}).then((s) => s.id)`
    )
  sids.a = await create(TITLES.a)
  sids.b = await create(TITLES.b)
  sids.empty = await create(TITLES.empty)
  sids.long = await create(TITLES.long)
  for (let turn = 1; turn <= 4; turn++) {
    provider.script({ text: LONG_ANSWER, usage: USAGE })
    await app.main.eval(
      `window.api.agent.prompt(${JSON.stringify({ sessionId: sids.long, text: `long question ${turn}` })}).then(() => true)`
    )
  }
  ids[sids.long] = (
    await app.main.eval<string[]>(
      `window.api.message.list(${JSON.stringify(sids.long)}).then((list) => list.map((m) => m.id))`
    )
  ).slice(-1)
  for (const key of ['a', 'b'] as const) {
    provider.script({ text: `${key} answer`, usage: USAGE })
    await app.main.eval(
      `window.api.agent.prompt(${JSON.stringify({ sessionId: sids[key], text: `${key} question` })}).then(() => true)`
    )
    ids[sids[key]] = await app.main.eval<string[]>(
      `window.api.message.list(${JSON.stringify(sids[key])}).then((list) => list.map((m) => m.id))`
    )
    expect(ids[sids[key]].length).toBe(2)
  }

  chat = chatPane(app.main)
  sidebar = sidebarPane(app.main)
  await sidebar.clickNewChat()
  await until(async () => (await sidebar.titles()).includes(TITLES.empty), 'sidebar refreshed')
  await app.main.eval(WATCH)
}, 180_000)

afterAll(async () => {
  await provider?.close()
  await app?.stop()
})

describe('打开有记录的会话不闪空态', () => {
  it('OPEN-1 两条会话来回切', async () => {
    const times: number[] = []
    for (let round = 0; round < 5; round++) {
      times.push(await openWithHistory(TITLES.a, sids.a))
      times.push(await openWithHistory(TITLES.b, sids.b))
    }
    console.log(`[OPEN-1] click → messages (ms): ${times.map((t) => t.toFixed(1)).join(' ')}`)
  })

  it('OPEN-2 从欢迎页打开', async () => {
    await sidebar.clickNewChat()
    await until(
      () => app.main.eval<boolean>(`!document.querySelector('[data-msg-id]')`),
      'welcome page is up'
    )
    await openWithHistory(TITLES.a, sids.a)
  })

  it('OPEN-3 停在有记录的会话上重载窗口', async () => {
    expect(await sidebar.openSession(TITLES.b)).toBe(true)
    await until(() => hasMessage(ids[sids.b]), 'b: messages on screen before reload')
    // 新文档脚本要 Page 域开着才生效
    await app.main.send('Page.enable')
    const install = await app.main.send<{ identifier: string }>(
      'Page.addScriptToEvaluateOnNewDocument',
      {
        source: `${WATCH}; window.__openWatch.targets = ${JSON.stringify(ids[sids.b])}`
      }
    )
    await app.main.eval('(window.__e2eBeforeReload = true)')
    await app.main.send('Page.reload')
    await until(
      () => app.main.eval<boolean>('window.__e2eBeforeReload === undefined').catch(() => false),
      'the page actually reloaded'
    )
    await waitRendererReady(app.main)
    await app.main.send('Page.removeScriptToEvaluateOnNewDocument', install)
    await until(async () => (await sidebar.titles()).includes(TITLES.b), 'sidebar after reload')
    expect(await sidebar.openSession(TITLES.b)).toBe(true)
    await until(async () => (await shot()).shownAt > 0, 'messages on screen after reload')
    expect((await shot()).emptyCommits).toBe(0)
  })
})

describe('长会话', () => {
  it('OPEN-6 第一次可见时已经停在底部，之后不跳', async () => {
    expect(await sidebar.openSession(TITLES.a)).toBe(true)
    await until(() => hasMessage(ids[sids.a]), 'a: messages on screen first')
    const times: number[] = []
    for (let round = 0; round < 3; round++) {
      times.push(await openWithHistory(TITLES.long, sids.long))
      const seen = await shot()
      // 输入卡片顶得高一点、末项多长一行都在这个范围内；跳到列表中间或开头都远超它
      expect(seen.firstDist).toBeLessThanOrEqual(4)
      await sleep(400)
      expect((await shot()).maxDist).toBeLessThanOrEqual(4)
      expect(await sidebar.openSession(TITLES.a)).toBe(true)
      await until(() => hasMessage(ids[sids.a]), 'a: messages on screen again')
    }
    console.log(`[OPEN-6] click → visible (ms): ${times.map((t) => t.toFixed(1)).join(' ')}`)
  })
})

describe('视图迟到', () => {
  it('OPEN-5 主进程停住：空白 → 骨架 → 消息；骨架铺满对话区、不压输入卡片、留够 250ms', async () => {
    expect(await sidebar.openSession(TITLES.b)).toBe(true)
    await until(() => hasMessage(ids[sids.b]), 'b: messages on screen first')
    await arm(ids[sids.a])
    expect(await sidebar.clickSessionAfter(TITLES.a, 30)).toBe(true)
    // 主进程停着 CDP 也不通：这段时间里的事全由页面里的看守记下，恢复之后再读
    process.kill(app.pid, 'SIGSTOP')
    try {
      await sleep(STALL_MS)
    } finally {
      process.kill(app.pid, 'SIGCONT')
    }
    await until(async () => (await shot()).shownAt > 0, 'messages on screen after the stall')
    const seen = await shot()
    console.log(
      `[OPEN-5] click → skeleton ${(seen.skeletonAt - seen.t0).toFixed(0)}ms, ` +
        `skeleton → gone ${(seen.skeletonGoneAt - seen.skeletonAt).toFixed(0)}ms, ` +
        `click → messages ${(seen.shownAt - seen.t0).toFixed(0)}ms`
    )
    expect(seen.emptyCommits).toBe(0)
    // 200ms 之前没有骨架（看守从布防算起，点击又晚 30ms）
    expect(seen.skeletonAt - seen.t0).toBeGreaterThanOrEqual(200)
    // 主进程停着的时候骨架已经在屏上了：不是恢复之后才画的
    expect(seen.skeletonAt - seen.t0).toBeLessThan(STALL_MS)
    expect(seen.skeletonGoneAt - seen.skeletonAt).toBeGreaterThanOrEqual(240)
    // 骨架撤的时候消息已经可见：没有「骨架 → 又一段空白 → 消息」
    expect(seen.shownAt).toBeLessThanOrEqual(seen.skeletonGoneAt)
    expect(seen.fit?.filled).toBe(true)
    expect(seen.fit?.pulsing).toBe(true)
    expect(seen.fit!.lastBarBottom).toBeLessThanOrEqual(seen.fit!.inputTop)
    expect(
      await app.main.eval<boolean>(`!document.querySelector(${JSON.stringify(SKELETON)})`)
    ).toBe(true)
  })
})

describe('真正的空会话', () => {
  it('OPEN-4 空态照常出现并留在那里', async () => {
    expect(await sidebar.openSession(TITLES.a)).toBe(true)
    await until(() => hasMessage(ids[sids.a]), 'a: messages on screen')
    expect(await sidebar.openSession(TITLES.empty)).toBe(true)
    await chat.ready()
    await until(
      () => app.main.eval<boolean>(`!!document.querySelector(${JSON.stringify(EMPTY)})`),
      'empty state on screen'
    )
    expect(await app.main.eval<boolean>(`!document.querySelector('[data-msg-id]')`)).toBe(true)
  })
})
