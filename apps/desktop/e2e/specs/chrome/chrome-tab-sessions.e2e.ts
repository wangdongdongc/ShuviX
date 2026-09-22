/**
 * Chrome 标签页会话与侧边栏的对话接口 —— 真的桌面、真的本地组件，假 Chrome 扮演扩展的 SW。
 *
 * 一个标签页会话就是一条普通会话 + `settings.chromeTab`（哪个浏览器、这一轮运行、哪个标签页）。
 * 本文件证明它在真实接线下的一生，以及侧边栏能碰什么：
 *   - **开**（CTS-1..3）：`tabSession.open` 找现成的、没有就建；标题带页面标题；不进侧栏列表；根档案由
 *     形态推出基座 `tab`，工具就是 `mcp:chrome` 那 20 个 + ask + skill —— 而桌面自己的会话勾了
 *     `mcp:chrome` 也拿不到用户的 Chrome（CTS-1b）；
 *   - **侧边栏的边界**（CTS-4..6）：桥不是 `window.api` 的远程版 —— 只接白名单里的路径，每个带会话的
 *     调用都核对「这条会话是不是这条连接的标签页会话」：别的浏览器的、桌面自己的、不存在的一律拒绝，
 *     被拒的 prompt 一个字都到不了模型；自己的那条照常可用；
 *   - **关与清**（CTS-7 / CTS-8）：扩展报 `tabs.removed` 只删那个浏览器那一轮的那一条；握手时清掉上一轮
 *     运行留下的、以及标签页已经不在的会话（「浏览器重启」= 同一个 installId 换一个 runId）；
 *   - **应用事件**（CTS-9 / CTS-10）：设置变化转给每个侧边栏；会话级的变化只转给这条会话的主人。
 *
 * 会话存在与否、设置长什么样，一律经主窗口的 IPC 或库里的行断；侧边栏看到什么，经假 Chrome 收到的帧断。
 */
import { existsSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sleep, until } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import { startFakeProvider, type FakeProvider } from '../../harness/fakeProvider'
import { listSessionIds, seedFakeProvider, sqliteJson, waitRendererReady } from '../../harness/seed'
import {
  CHROME_TOOL_NAMES,
  chromeTool,
  startFakeChrome,
  type FakeChrome
} from '../../harness/chromeFixtures'

const MODEL = 'e2e-model'
/** 基座 `tab` 的显示名（`declaredBy`）的三语候选 */
const TAB_PROFILE_LABELS = ['Chrome Tab', 'Chrome 标签页', 'Chrome タブ']
const NOT_YOURS = 'This session does not belong to this Chrome tab.'

interface SessionRow {
  id: string
  title: string
  projectId: string | null
  parentId: string | null
  settings: Record<string, unknown>
  workingDirectory: string
}

interface RuntimeInfo {
  systemPrompt: string
  tools: Array<{ name: string; description: string }>
}

interface ListedTool {
  name: string
  declaredBy?: string
}

let app: E2EApp
let provider: FakeProvider
let chromeA: FakeChrome
let chromeB: FakeChrome
/** 桌面自己的一条普通会话（侧边栏不许碰它） */
let desktopSid = ''
let sidA5 = ''
let sidA6 = ''
let sidA7 = ''
let sidB5 = ''
let sidB8 = ''
const retired: FakeChrome[] = []

const getById = (sid: string): Promise<SessionRow | null> =>
  app.main.eval<SessionRow | null>(
    `window.api.session.getById(${JSON.stringify(sid)}).then((s) => s ?? null)`
  )
const ensureRuntime = (sid: string): Promise<RuntimeInfo> =>
  app.main.eval<RuntimeInfo>(`window.api.agent.getInfo(${JSON.stringify(sid)}, { ensure: true })`)
const tabRows = (installId: string, tabId: number): Array<{ id: string }> =>
  sqliteJson<{ id: string }>(
    app.home,
    `SELECT id FROM sessions
      WHERE json_extract(settings, '$.chromeTab.installId') = '${installId}'
        AND json_extract(settings, '$.chromeTab.tabId') = ${tabId}`
  )
const waitDeleted = (sid: string, what: string): Promise<true> =>
  until(async () => (await getById(sid)) === null || undefined, what)

async function connect(chrome: FakeChrome): Promise<FakeChrome> {
  await chrome.waitHost('connected')
  const welcome = await chrome.hello()
  expect(welcome.ok).toBe(true)
  return chrome
}

beforeAll(async () => {
  app = await launchApp()
  provider = await startFakeProvider()
  await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  await waitRendererReady(app.main)
  chromeA = await connect(
    startFakeChrome({
      home: app.home,
      installId: 'inst-ts-a',
      runId: 'run-1',
      browser: 'E2E Chrome A',
      tabs: [
        { id: 5, title: 'Inbox — E2E', url: 'https://mail.example/inbox', active: true },
        { id: 6, title: 'Docs', url: 'https://docs.example/' },
        { id: 7, title: 'News', url: 'https://news.example/' }
      ]
    })
  )
  chromeB = await connect(
    startFakeChrome({
      home: app.home,
      installId: 'inst-ts-b',
      runId: 'run-b',
      browser: 'E2E Chrome B',
      tabs: [
        { id: 5, title: 'B Five', url: 'https://b.example/five', active: true },
        { id: 8, title: 'B Eight', url: 'https://b.example/eight' }
      ]
    })
  )
  desktopSid = await app.main.eval<string>(
    `window.api.session.create({ title: 'Desktop only' }).then((s) => s.id)`
  )
}, 120_000)

afterAll(async () => {
  for (const c of [chromeA, chromeB, ...retired]) await c?.close()
  await provider?.close()
  await app?.stop()
})

describe('开一条标签页会话', () => {
  it('CTS-1 tabSession.open 开出一条普通会话：挂着那个标签页、不进侧栏列表、根档案是基座 tab', async () => {
    sidA5 = await chromeA.openTabSession(5)
    const row = await getById(sidA5)
    expect(row).toMatchObject({
      id: sidA5,
      title: 'Chrome · Inbox — E2E',
      projectId: null,
      parentId: null
    })
    // 无项目、不继承任何扩展能力勾选：工具全由基座档案声明
    expect(row!.settings).toEqual({
      chromeTab: { installId: 'inst-ts-a', runId: 'run-1', tabId: 5 },
      enabledTools: []
    })
    expect(await listSessionIds(app.main)).not.toContain(sidA5)
    expect(await listSessionIds(app.main)).toContain(desktopSid)

    // 根 Agent：工具就是 chrome 能力的 20 个 + ask + skill（没有 bash / 读写文件 / 应用内浏览器）
    const info = await ensureRuntime(sidA5)
    const names = info.tools.map((t) => t.name).sort()
    expect(names).toEqual([...CHROME_TOOL_NAMES.map(chromeTool), 'ask', 'skill'].sort())
    // 接的是 `chrome` 这台（用户真实的 Chrome），不是应用内浏览器面板
    const listTabs = info.tools.find((t) => t.name === chromeTool('list_tabs'))
    expect(listTabs?.description).toContain("These are the user's real Chrome tabs")
    // 系统提示词是 tab 档案（与界面语言无关的两处特征）
    expect(info.systemPrompt).toContain('mcp__chrome__*')
    expect(info.systemPrompt).toContain('[Chrome tab <id>:')
  }, 120_000)

  it('CTS-1b 桌面自己的会话拿不到用户的 Chrome：选择器里没有它，硬写进勾选也不上架', async () => {
    const listed = await app.main.eval<ListedTool[]>(
      `window.api.tools.list(${JSON.stringify(desktopSid)})`
    )
    expect(listed.map((t) => t.name)).not.toContain('mcp:chrome')
    expect(listed.map((t) => t.name)).toContain('mcp:browser')

    const other = await app.main.eval<string>(
      `window.api.session.create({ title: 'Desktop with chrome ticked' }).then((s) => s.id)`
    )
    await app.main.eval(
      `window.api.session.updateEnabledTools(${JSON.stringify({ id: other, enabledTools: ['mcp:chrome'] })})`
    )
    const info = await ensureRuntime(other)
    expect(info.tools.map((t) => t.name).filter((n) => n.startsWith('mcp__chrome__'))).toEqual([])
  }, 120_000)

  it('CTS-2 再开一次拿回同一条；同一个标签页并发开两次也只建一条', async () => {
    expect(await chromeA.openTabSession(5)).toBe(sidA5)
    const [x, y] = await Promise.all([chromeA.openTabSession(6), chromeA.openTabSession(6)])
    expect(x).toBe(y)
    sidA6 = x
    expect(tabRows('inst-ts-a', 6)).toEqual([{ id: sidA6 }])
    expect(tabRows('inst-ts-a', 5)).toEqual([{ id: sidA5 }])
  }, 120_000)

  it('CTS-3 别的标签页、别的浏览器里同号的标签页，各是各的会话', async () => {
    sidA7 = await chromeA.openTabSession(7)
    sidB5 = await chromeB.openTabSession(5)
    expect(new Set([sidA5, sidA6, sidA7, sidB5]).size).toBe(4)
    const b = await getById(sidB5)
    expect(b).toMatchObject({ title: 'Chrome · B Five' })
    expect(b!.settings.chromeTab).toEqual({ installId: 'inst-ts-b', runId: 'run-b', tabId: 5 })
    // getById 顺带落下了临时工作区 —— CTS-7 看删会话时它被一并清掉
    expect(existsSync((await getById(sidA7))!.workingDirectory)).toBe(true)
  }, 120_000)
})

describe('侧边栏能碰什么', () => {
  it('CTS-4 白名单之外的路径一律拒绝，什么也没发生；白名单里不带会话的照常可用', async () => {
    const fontSizeBefore = await app.main.eval<string | null>(
      `window.api.settings.get('general.fontSize').then((v) => v ?? null)`
    )
    const refused: Array<[string, unknown[]]> = [
      ['session.list', []],
      ['session.create', [{ title: 'made by the side panel' }]],
      ['session.delete', [desktopSid]],
      ['agent.setModel', [{ sessionId: sidA5, provider: 'x', model: 'y' }]],
      ['settings.set', [{ key: 'general.fontSize', value: '30' }]],
      ['files.scan', [{ sessionId: sidA5 }]],
      ['bgTask.readLog', [{ sessionId: sidA5, toolCallId: 'x' }]],
      ['command.list', [sidA5]],
      ['__proto__', []],
      ['constructor', []]
    ]
    for (const [path, args] of refused) {
      const r = await chromeA.channel(path, ...args)
      expect(r, path).toMatchObject({
        ok: false,
        error: `"${path}" is not available from the Chrome side panel.`
      })
    }
    expect(await getById(desktopSid)).not.toBeNull()
    expect(
      await app.main.eval<string | null>(
        `window.api.settings.get('general.fontSize').then((v) => v ?? null)`
      )
    ).toBe(fontSizeBefore)
    const titles = await app.main.eval<string[]>(
      `window.api.session.list().then((ss) => ss.map((s) => s.title))`
    )
    expect(titles).not.toContain('made by the side panel')

    // 不带会话的白名单路径：不需要归属
    expect((await chromeA.channel('tools.presentations')).ok).toBe(true)
    expect((await chromeA.channel('tools.definitions')).ok).toBe(true)
    const validated = await chromeA.channel('shuvixMd.validate', {
      type: 'agent',
      text: '---\nshuvix: agent v1\nname: e2e-probe\n---\n\nBody.'
    })
    expect(validated.ok).toBe(true)
  }, 120_000)

  it('CTS-5 只能碰自己标签页的会话：别的浏览器的、桌面自己的、不存在的一律拒绝；被拒的 prompt 到不了模型', async () => {
    provider.reset()
    const cases: Array<[FakeChrome, string, unknown[]]> = [
      [chromeA, 'message.list', [desktopSid]],
      [chromeA, 'session.getById', [sidB5]],
      [chromeB, 'message.list', [sidA5]],
      [chromeB, 'tools.list', [sidA5]],
      [chromeA, 'agent.abort', ['no-such-session']],
      [chromeA, 'runtime.statuses', []],
      [chromeA, 'agent.prompt', [{ sessionId: desktopSid, text: 'hijack the desktop session' }]],
      [chromeB, 'agent.prompt', [{ sessionId: sidA5, text: 'hijack another browser' }]],
      [
        chromeB,
        'agent.respondToInput',
        [{ sessionId: sidA5, requestId: 'x', response: { kind: 'ask', allowed: true } }]
      ],
      [chromeA, 'bgTask.list', [{ sessionId: desktopSid }]]
    ]
    for (const [chrome, path, args] of cases) {
      const r = await chrome.channel(path, ...args)
      expect(r, `${chrome.installId} ${path}`).toMatchObject({ ok: false, error: NOT_YOURS })
    }
    // 被拒的两条 prompt 一个字都没到模型，也没落进任何一条会话
    await sleep(500)
    expect(provider.chatRequestCount()).toBe(0)
    expect(await app.main.eval(`window.api.message.list(${JSON.stringify(desktopSid)})`)).toEqual(
      []
    )
  }, 120_000)

  it('CTS-6 自己标签页的会话照常可用：侧边栏打开时那几步都拿得到', async () => {
    const init = await chromeA.channelCall<{ success: boolean }>('agent.init', {
      sessionId: sidA5
    })
    expect(init).toMatchObject({ success: true })
    expect(await chromeA.channelCall('session.getById', sidA5)).toMatchObject({
      id: sidA5,
      title: 'Chrome · Inbox — E2E'
    })
    expect(await chromeA.channelCall('message.list', sidA5)).toEqual([])
    // 运行时状态条（id → 状态）：tab 会话没有数据库连接，一条都没有
    expect(await chromeA.channelCall('runtime.statuses', sidA5)).toEqual({})
    expect(await chromeA.channelCall('bgTask.list', { sessionId: sidA5 })).toEqual([])
    // 扩展能力：mcp:chrome 由基座 tab 声明（锁定勾选，署档案名）
    const listed = await chromeA.channelCall<ListedTool[]>('tools.list', sidA5)
    const chrome = listed.find((t) => t.name === 'mcp:chrome')
    expect(chrome, JSON.stringify(listed)).toBeDefined()
    expect(TAB_PROFILE_LABELS).toContain(chrome!.declaredBy)
    // 另一个浏览器用自己的会话同样可以
    expect(await chromeB.channelCall('message.list', sidB5)).toEqual([])
  }, 120_000)
})

describe('标签页关了、浏览器重启了', () => {
  it('CTS-7 扩展报 tabs.removed：只删那个浏览器那一轮的那一条（临时工作区一并清掉）', async () => {
    const workspace7 = (await getById(sidA7))!.workingDirectory
    chromeA.closeTab(7)
    await waitDeleted(sidA7, 'tab 7 session deleted')
    expect(existsSync(workspace7)).toBe(false)
    for (const sid of [sidA5, sidA6, sidB5]) expect(await getById(sid), sid).not.toBeNull()

    // 另一个浏览器关掉同号的 5 号标签页：删的是它自己的那条，A 的 5 号不受影响
    chromeB.closeTab(5)
    await waitDeleted(sidB5, 'browser B tab 5 session deleted')
    expect(await getById(sidA5)).not.toBeNull()
    sidB8 = await chromeB.openTabSession(8)
  }, 120_000)

  it('CTS-8 重新握手时清孤儿：标签页已经不在的会话、上一轮浏览器运行留下的会话', async () => {
    // 扩展重载（同一轮浏览器运行）：6 号在断开期间关掉了，握手时的 openTabIds 里没有它
    await chromeA.close()
    retired.push(chromeA)
    const reloaded = await connect(
      startFakeChrome({
        home: app.home,
        installId: 'inst-ts-a',
        runId: 'run-1',
        tabs: [{ id: 5, title: 'Inbox — E2E', url: 'https://mail.example/inbox', active: true }]
      })
    )
    retired.push(reloaded)
    await waitDeleted(sidA6, 'tab 6 session swept at the handshake')
    expect(await getById(sidA5)).not.toBeNull()
    expect(await reloaded.openTabSession(5)).toBe(sidA5)

    // 浏览器重启：runId 换了（标签页 id 碰巧又是 5 也不算同一个）—— 上一轮的一条不留
    await reloaded.close()
    chromeA = await connect(
      startFakeChrome({
        home: app.home,
        installId: 'inst-ts-a',
        runId: 'run-2',
        tabs: [{ id: 5, title: 'Inbox — E2E', url: 'https://mail.example/inbox', active: true }]
      })
    )
    await waitDeleted(sidA5, 'previous-run session swept at the handshake')
    const fresh = await chromeA.openTabSession(5)
    expect(fresh).not.toBe(sidA5)
    expect((await getById(fresh))!.settings.chromeTab).toEqual({
      installId: 'inst-ts-a',
      runId: 'run-2',
      tabId: 5
    })
    sidA5 = fresh
    // 别的浏览器的会话从头到尾没被碰
    expect(await getById(sidB8)).not.toBeNull()
  }, 120_000)
})

describe('应用事件', () => {
  it('CTS-9 设置变化转给每个侧边栏；侧边栏的外观跟着桌面走', async () => {
    const sinceA = chromeA.mark()
    const sinceB = chromeB.mark()
    await app.main.eval(`window.api.settings.set({ key: 'general.fontSize', value: '17' })`)
    const isFontChange = (e: { event: { type: string; keys?: unknown } }): boolean =>
      e.event.type === 'settings.changed' &&
      Array.isArray(e.event.keys) &&
      e.event.keys.includes('general.fontSize')
    await until(
      () => chromeA.appEvents({ since: sinceA }).some(isFontChange),
      'A got settings.changed'
    )
    await until(
      () => chromeB.appEvents({ since: sinceB }).some(isFontChange),
      'B got settings.changed'
    )
    expect(await chromeA.call('panel.appearance', {})).toMatchObject({ fontSize: 17 })
  }, 120_000)

  it('CTS-10 会话级的变化只转给这条会话的主人；桌面会话的变化谁也不转', async () => {
    const sinceA = chromeA.mark()
    const sinceB = chromeB.mark()
    const configChanged = (sid: string) => (e: { event: { type: string; sessionId?: unknown } }) =>
      e.event.type === 'session.configChanged' && e.event.sessionId === sid

    await app.main.eval(
      `window.api.session.updateKnowledgeBases(${JSON.stringify({ id: sidA5, knowledgeBases: [] })})`
    )
    await app.main.eval(
      `window.api.session.updateKnowledgeBases(${JSON.stringify({ id: desktopSid, knowledgeBases: [] })})`
    )
    await until(
      () => chromeA.appEvents({ since: sinceA }).some(configChanged(sidA5)),
      'the owning side panel got session.configChanged for its session'
    )
    // 给上面那一条留出同样的路程，再看另外几处确实没收到
    await sleep(500)
    expect(chromeB.appEvents({ since: sinceB }).some(configChanged(sidA5))).toBe(false)
    for (const c of [chromeA, chromeB]) {
      const since = c === chromeA ? sinceA : sinceB
      expect(c.appEvents({ since }).some(configChanged(desktopSid)), c.installId).toBe(false)
    }
  }, 120_000)
})
