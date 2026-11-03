/**
 * 询问等人，不看此刻有没有前端（2026-11-02，根 CLAUDE.md「Tool execution flow」）：macOS 关了主窗口进程还在，会话照跑，
 * 这时候发起的询问照样挂着，窗口回来之后看得到、答得了。之前这种询问当场变成工具报错 `Aborted`，紧接着又一次模型请求。
 *
 *   AW-E1 两条会话（A 用 ask 工具，B 读家目录里的文件 = 权限卡）的回复都挂着时关掉主窗口，再放行：提供商看到那次带工具调用
 *         的请求之后，3 秒内没有下一次请求
 *   AW-E2 第二个实例把窗口建回来：askCounts 是 {A:1,B:1}，两行都有徽标；打开 A、答它：工具结果是成功，A 的徽标没了，B 的还在；
 *         再允许 B：B 也跑完
 *   AW-E3 约两次触发：一个无条件的 bot 绑定，整分钟之前关掉窗口，第一次触发的运行停在询问上。窗口回来：最新一条日志是
 *         started、带会话，lastFired 还是空的；下一次触发 skipped，没有第二条会话；答了之后 completed，lastFired 等于第一次
 *         围栏里的 firedAt。bot 的行在收起的组里：断言走 askCounts
 *
 * 只有 macOS 关窗不退出；别的平台关掉主窗口进程就退了，没有这个场景（无头的同一件事见 network/web-ask-reconnect）。
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sleep, until, type CdpClient } from '../../harness/cdp'
import {
  startFakeProvider,
  type FakeProvider,
  type FakeRequest,
  type FakeTurn
} from '../../harness/fakeProvider'
import { launchApp, spawnSecondInstance, type E2EApp } from '../../harness/launch'
import { chatPane, sidebarPane } from '../../harness/pages'
import { seedFakeProvider, sqliteJson, waitRendererReady, writeBotMd } from '../../harness/seed'

const MODEL = 'e2e-model'
const FILE_TEXT = 'SECRET-NOTES-AW'
const LONG = 280_000
/** 下一个整分钟最多这么久（再加一点余量） */
const NEXT_FIRE_MS = 80_000

interface ToolMessage {
  role: string
  tool_call_id?: string
  content?: unknown
}
const toolMessages = (req: FakeRequest): ToolMessage[] =>
  ((req.body.messages ?? []) as ToolMessage[]).filter((m) => m.role === 'tool')
const contentText = (message: ToolMessage): string =>
  typeof message.content === 'string' ? message.content : JSON.stringify(message.content)

const askCall = (id: string): NonNullable<FakeTurn['toolCalls']> => [
  {
    id,
    name: 'ask',
    args: JSON.stringify({
      question: 'Which one?',
      options: [
        { label: 'A', description: 'first' },
        { label: 'B', description: 'second' }
      ]
    })
  }
]

/** 第 n 步（已有 n 条工具结果）的、带这个标记的请求 */
const stepOf =
  (mark: string, n: number) =>
  (req: FakeRequest): boolean =>
    req.raw.includes(mark) && toolMessages(req).length === n
const requestsOf = (p: FakeProvider, mark: string): FakeRequest[] =>
  p.requests().filter((r) => r.raw.includes(mark))

const askCounts = (page: CdpClient): Promise<Record<string, number>> =>
  page.eval<Record<string, number>>('window.api.agent.askCounts()')

const respond = (
  page: CdpClient,
  sessionId: string,
  requestId: string,
  response: unknown
): Promise<unknown> =>
  page.eval(
    `window.api.agent.respondToInput(${JSON.stringify({ sessionId, requestId, response })})`
  )

/** 关掉主窗口（macOS 上进程还在） */
async function closeMainWindow(app: E2EApp, page: CdpClient): Promise<void> {
  await page.eval('window.close()').catch(() => undefined)
  await until(async () => (await app.mainWindow()) === null, 'main window gone', 20_000)
}

/** 第二个实例（再点一次图标）把主窗口建回来 */
async function reopenMainWindow(app: E2EApp): Promise<CdpClient> {
  const second = await spawnSecondInstance(app)
  expect(second.code).toBe(0)
  const page = await until(() => app.mainWindow(), 'main window back', 60_000)
  await waitRendererReady(page)
  return page
}

describe.skipIf(process.platform !== 'darwin')('an ask raised with no frontend waits', () => {
  let app: E2EApp
  let provider: FakeProvider
  /** 现在的主窗口（关了再开之后不是 app.main 了） */
  let main: CdpClient | undefined
  let A = ''
  let B = ''
  let file = ''

  const MARK_A = 'AW-MARK-A please ask me'
  const MARK_B = 'AW-MARK-B please read it'

  beforeAll(async () => {
    app = await launchApp()
    provider = await startFakeProvider()
    await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
    await waitRendererReady(app.main)
    const outside = join(app.home, 'outside')
    mkdirSync(outside, { recursive: true })
    file = join(outside, 'notes.txt')
    writeFileSync(file, FILE_TEXT)
    const create = (title: string): Promise<string> =>
      app.main.eval<string>(
        `window.api.session.create(${JSON.stringify({ title })}).then((s) => s.id)`
      )
    A = await create('Ask A')
    B = await create('Ask B')
  })

  afterAll(async () => {
    if (app) rmSync(join(app.botsDir, 'asker.md'), { force: true })
    main?.close()
    await provider?.close()
    await app?.stop()
  })

  it('AW-E1 asks raised after the window closed: no follow-up request', async () => {
    provider.script(
      {
        toolCalls: askCall('call_a'),
        holdMs: 60_000,
        holdKey: 'A',
        when: stepOf(MARK_A, 0),
        usage: { prompt: 80, completion: 6 }
      },
      {
        toolCalls: [{ id: 'call_b', name: 'read', args: JSON.stringify({ path: file }) }],
        holdMs: 60_000,
        holdKey: 'B',
        when: stepOf(MARK_B, 0),
        usage: { prompt: 80, completion: 6 }
      },
      { text: 'A finished', when: stepOf(MARK_A, 1), usage: { prompt: 90, completion: 4 } },
      { text: 'B finished', when: stepOf(MARK_B, 1), usage: { prompt: 90, completion: 4 } }
    )
    for (const [sessionId, text] of [
      [A, MARK_A],
      [B, MARK_B]
    ]) {
      await app.main.eval(
        `(window.api.agent.prompt(${JSON.stringify({ sessionId, text })}).catch(() => undefined), true)`
      )
    }
    await until(() => provider.holding('A') && provider.holding('B'), 'both replies held', 20_000)

    await closeMainWindow(app, app.main)
    provider.release('A')
    provider.release('B')
    await sleep(3000)

    // 恰一次请求：带工具调用的那次；没有带工具结果的下一次
    expect(requestsOf(provider, MARK_A)).toHaveLength(1)
    expect(requestsOf(provider, MARK_B)).toHaveLength(1)
  }, 90_000)

  it('AW-E2 the window comes back: counts and badges; answering one leaves the other waiting', async () => {
    main = await reopenMainWindow(app)
    const page = main
    await until(
      async () => {
        const counts = await askCounts(page)
        return counts[A] === 1 && counts[B] === 1
      },
      'both asks counted',
      20_000
    )
    expect(await askCounts(page)).toEqual({ [A]: 1, [B]: 1 })

    const sidebar = sidebarPane(page)
    await until(async () => (await sidebar.pendingAsks('Ask A')) === 1, 'badge on A', 20_000)
    await until(async () => (await sidebar.pendingAsks('Ask B')) === 1, 'badge on B', 20_000)

    // 打开 A：卡片在，答它
    expect(await sidebar.openSession('Ask A')).toBe(true)
    const chat = chatPane(page)
    await chat.ready()
    await until(async () => (await chat.pendingPanel()).open, 'the card shows in A', 20_000)
    await respond(page, A, 'call_a', { kind: 'choice', selections: ['A'] })

    await until(
      () => requestsOf(provider, MARK_A).some((r) => toolMessages(r).length === 1),
      'the answer reached the model',
      20_000
    )
    const answered = toolMessages(requestsOf(provider, MARK_A).at(-1)!)
    expect(answered.map((m) => m.tool_call_id)).toEqual(['call_a'])
    expect(contentText(answered[0]!)).toContain('User selected: A')
    expect(JSON.stringify(answered)).not.toContain('Aborted')

    await until(async () => (await sidebar.pendingAsks('Ask A')) === null, 'A badge gone', 20_000)
    expect(await sidebar.pendingAsks('Ask B')).toBe(1)
    expect(await askCounts(page)).toEqual({ [B]: 1 })

    // 再允许 B：真的读到文件
    await respond(page, B, 'call_b', { kind: 'ask', allowed: true })
    await until(
      () => requestsOf(provider, MARK_B).some((r) => toolMessages(r).length === 1),
      'B reached the model',
      20_000
    )
    const read = toolMessages(requestsOf(provider, MARK_B).at(-1)!)
    expect(contentText(read[0]!)).toContain(FILE_TEXT)
    await until(async () => (await sidebar.pendingAsks('Ask B')) === null, 'B badge gone', 20_000)
    await until(
      async () => Object.keys(await askCounts(page)).length === 0,
      'nothing is waiting',
      20_000
    )
  }, 150_000)

  it(
    'AW-E3 a scheduled run stops on its ask; the next firing is skipped; answering completes it',
    async () => {
      const MESSAGE = 'AW-E3 asker check-in.'
      const firstStep = stepOf(MESSAGE, 0)
      const page0 = main!
      interface LogRow {
        outcome: string
        sessionId: string
      }
      const logs = (): LogRow[] =>
        sqliteJson<LogRow>(
          app.home,
          `SELECT outcome, sessionId FROM trigger_logs WHERE bot = 'asker' ORDER BY createdAt, rowid`
        )
      const lastFired = (): string | null =>
        sqliteJson<{ value: string }>(
          app.home,
          `SELECT value FROM settings WHERE key = 'triggers.bot.lastFired'`
        )[0]?.value ?? null

      provider.script(
        { toolCalls: askCall('call_bot'), when: firstStep, usage: { prompt: 80, completion: 6 } },
        { text: 'Run finished', when: stepOf(MESSAGE, 1), usage: { prompt: 90, completion: 4 } }
      )
      await closeMainWindow(app, page0)
      main = undefined
      writeBotMd(app, 'asker', {
        displayName: 'Asker',
        rawLines: ['shuvix-bot-on:', '  - trigger: timer.fired', `    message: ${MESSAGE}`]
      })

      const first = await until(
        () => requestsOf(provider, MESSAGE)[0],
        'the first firing reached the model',
        NEXT_FIRE_MS
      )
      await sleep(2000)
      expect(requestsOf(provider, MESSAGE)).toHaveLength(1)

      const page = await reopenMainWindow(app)
      main = page
      const started = logs().at(-1)!
      expect(started.outcome).toBe('started')
      expect(started.sessionId).not.toBe('')
      expect(lastFired()).toBeNull()
      await until(
        async () => (await askCounts(page))[started.sessionId] === 1,
        'the run is waiting on its ask',
        20_000
      )

      await until(
        () => logs().some((row) => row.outcome === 'skipped'),
        'the next firing is skipped',
        NEXT_FIRE_MS
      )
      const skipped = logs().find((row) => row.outcome === 'skipped')!
      expect(skipped.sessionId).toBe('')
      const bound = await page.eval<string[]>(
        `window.api.session.list().then((ss) => ss.filter((s) => s.settings && s.settings.bot === 'asker').map((s) => s.id))`
      )
      expect(bound).toEqual([started.sessionId])
      expect(requestsOf(provider, MESSAGE)).toHaveLength(1)

      await respond(page, started.sessionId, 'call_bot', { kind: 'choice', selections: ['B'] })
      await until(
        () => logs().some((row) => row.outcome === 'completed'),
        'the run completed',
        20_000
      )
      // 别让下一分钟再起一次
      rmSync(join(app.botsDir, 'asker.md'), { force: true })

      const firedAt = /firedAt: (\S+)/.exec(first.raw.replaceAll('\\n', '\n'))?.[1]
      expect(firedAt).toBeTruthy()
      const recorded = JSON.parse(lastFired()!) as Record<string, string>
      expect(Object.values(recorded)).toEqual([firedAt!.replace(/^['"]|['"]$/g, '')])
      const followUp = requestsOf(provider, MESSAGE).find((r) => toolMessages(r).length === 1)!
      expect(contentText(toolMessages(followUp)[0]!)).toContain('User selected: B')
      expect(JSON.stringify(toolMessages(followUp))).not.toContain('Aborted')
    },
    LONG
  )
})
