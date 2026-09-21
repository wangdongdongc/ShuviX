/**
 * 内置能力服务器 `browser` 在会话里 —— 工具从哪来、跑起来是什么样、实例归谁（假提供商脚本化）。
 *
 * 浏览器不再是每个 agent 都带的内置工具，而是按会话勾选的 `mcp:browser`：一条会话勾了它，
 * 创建根 Agent 的那一刻才起一台进程内 server（会话级实例），工具名是 `mcp__browser__<tool>`，
 * 一共 22 个。本 spec 分四段：
 *
 *   - **工具从哪来**（BRT）：五种会话形态缺省都没有；输入框的选择器里勾上、项目默认、
 *     agent 文件声明，三条路任一条都给全 22 个，而且发给模型的就是这 22 个；
 *   - **主流程**（BRF，一条勾了浏览器的项目会话，开在界面上）：打开 → 快照 → 填 / 点 / 读 →
 *     读整页与截图 → 关掉最后一个 tab。每一步都对着夹具网站那一侧的请求记录、
 *     决策日志与界面上的工具行断言；
 *   - **呈现**（BRR）：退役的旧 `browser` 工具在新旧两种状态下仍有浏览器的图标与标签；
 *     内置 ssh 走同一张兜底呈现表（标签、图标、「主机 · 说明」、终端形态的详情）；
 *   - **实例归谁**（BRL）：两条会话两台实例、各自的相对路径、各自的快照基线；清空消息不重连，
 *     删会话只放掉自己那一台。
 *
 * 纪律：每条会话都给显式标题（缺省标题会让自动起标题的 hook 抢走脚本里的轮次）；tab 短号是
 * 全 app 共用的计数器，一律从 open_tab 的结果里读；元素 uid 从上一次快照的结果里读，所以
 * 「快照 → 点击」是两次运行。询问一律手工应答（不装 installAutoAllow：它一页只装一次）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { until } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import { startFakeProvider, type FakeProvider } from '../../harness/fakeProvider'
import {
  createAgentSession,
  createPinnedChildSession,
  createProject,
  eventRecorder,
  securityDecisions,
  seedFakeProvider,
  waitRendererReady,
  writeAgentMd,
  writeBotMd,
  type EventRecorder,
  type RecordedEvent
} from '../../harness/seed'
import {
  chatPane,
  rightPanelPane,
  sidebarPane,
  toolPickerPane,
  type ChatPane,
  type RightPanelPane,
  type SidebarPane,
  type ToolPickerPane
} from '../../harness/pages'
import {
  BROWSER_TOOL_NAMES,
  browserDriver,
  browserTool,
  startFixtureServer,
  tabIdOf,
  uidOf,
  type BrowserDriver,
  type FixtureServer
} from '../../harness/browserFixtures'

const MODEL = 'e2e-model'
const BROWSER_ID = 'builtin-mcp-browser'
const ALL_BROWSER_TOOLS = BROWSER_TOOL_NAMES.map(browserTool).sort()
/** 工具显示名（`tool.browserLabel`）的三语候选 */
const BROWSER_LABELS = ['Browser', '浏览器', 'ブラウザ']
/** 一次会话级实例连上时 MCP 模块写下的那一行 */
const CONNECTED_LINE = `connected: browser (${BROWSER_TOOL_NAMES.length} tools)`

interface RuntimeInfo {
  tools: Array<{ name: string; description?: string }>
}

interface ListedTool {
  name: string
  isBuiltin?: boolean
  declaredBy?: string
}

interface ListedMessage {
  id: string
  role: string
  blocks?: Array<{
    type: string
    toolCallId?: string
    toolName?: string
    result?: string
    isError?: boolean
  }>
}

interface TabRow {
  id: string
  url: string
  active: boolean
  cdpAttached: boolean
}

/** 发给模型的一个工具（openai-completions 请求体里的 `tools[]`） */
interface RequestTool {
  function: { name: string; description?: string; parameters?: { required?: string[] } }
}

let app: E2EApp
let provider: FakeProvider
let events: EventRecorder
let fixture: FixtureServer
let driver: BrowserDriver
let chat: ChatPane
let sidebar: SidebarPane
let picker: ToolPickerPane
let right: RightPanelPane
let projDir = ''
let projectId = ''
/** 凡是连起过浏览器实例的会话 —— BRL-4 要先把它们都删掉，才能看见「最后一台放掉之后未启动」 */
const browserSids = new Set<string>()

// ─── IPC 助手 ───

const createSession = (opts: { title: string; projectId?: string }): Promise<string> =>
  app.main.eval<string>(`window.api.session.create(${JSON.stringify(opts)}).then((s) => s.id)`)
const storedTools = (sid: string): Promise<unknown> =>
  app.main.eval(
    `window.api.session.getById(${JSON.stringify(sid)}).then((s) => (s && s.settings ? s.settings.enabledTools : undefined))`
  )
const writeTools = (sid: string, enabledTools: string[]): Promise<{ success: boolean }> =>
  app.main.eval(
    `window.api.session.updateEnabledTools(${JSON.stringify({ id: sid, enabledTools })})`
  )
const ensureRuntime = async (sid: string): Promise<string[]> => {
  const info = await app.main.eval<RuntimeInfo | null>(
    `window.api.agent.getInfo(${JSON.stringify(sid)}, { ensure: true })`
  )
  return (info?.tools ?? []).map((t) => t.name)
}
const browserToolsOf = (names: string[]): string[] =>
  names.filter((n) => n.startsWith('mcp__browser__')).sort()
const toolsList = (sid: string): Promise<ListedTool[]> =>
  app.main.eval<ListedTool[]>(`window.api.tools.list(${JSON.stringify(sid)})`)
const listMessages = (sid: string): Promise<ListedMessage[]> =>
  app.main.eval<ListedMessage[]>(`window.api.message.list(${JSON.stringify(sid)})`)
const listTabs = (): Promise<TabRow[]> =>
  app.main.eval<TabRow[]>(`window.api.browserView.listTabs()`)
const mcpRow = async (): Promise<{ status: string }> =>
  (await app.main.eval<Array<{ id: string; status: string }>>(`window.api.mcp.list()`)).find(
    (r) => r.id === BROWSER_ID
  )!
const deleteSession = async (sid: string): Promise<void> => {
  await app.main.eval(`window.api.session.delete(${JSON.stringify(sid)})`)
  browserSids.delete(sid)
}
/** 建一条勾了 mcp:browser 的会话（可选挂在项目下），让运行时起来，回会话 id */
const tickedSession = async (title: string, inProject = false): Promise<string> => {
  const sid = await createSession({ title, ...(inProject ? { projectId } : {}) })
  expect((await writeTools(sid, ['mcp:browser'])).success).toBe(true)
  expect(browserToolsOf(await ensureRuntime(sid))).toEqual(ALL_BROWSER_TOOLS)
  browserSids.add(sid)
  return sid
}

const countInLog = (needle: string): number => app.mainLog().split(needle).length - 1

/** 最近一次发给模型的请求里的工具 */
const lastRequestTools = (): RequestTool[] => {
  const reqs = provider.chatRequests()
  return (reqs[reqs.length - 1]?.body.tools ?? []) as RequestTool[]
}

const waitSidebarRow = (title: string): Promise<boolean> =>
  until(async () => (await sidebar.titles()).includes(title), `sidebar row "${title}"`)
const openInUi = async (title: string): Promise<void> => {
  await waitSidebarRow(title)
  expect(await sidebar.openSession(title)).toBe(true)
  await chat.ready()
}

beforeAll(async () => {
  app = await launchApp()
  provider = await startFakeProvider()
  await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  await waitRendererReady(app.main)
  events = eventRecorder(app.main)
  await events.install()
  fixture = await startFixtureServer()
  driver = browserDriver({ main: app.main, provider, events })
  chat = chatPane(app.main)
  sidebar = sidebarPane(app.main)
  picker = toolPickerPane(app.main)
  right = rightPanelPane(app.main)

  projDir = join(app.home, 'br-session-proj')
  mkdirSync(join(projDir, 'notes'), { recursive: true })
  writeFileSync(join(projDir, 'notes', 'br-note.md'), '# BR note\n')
  projectId = (await createProject(app.main, { name: 'BR-Session-Proj', path: projDir })).id
}, 120_000)

afterAll(async () => {
  await provider?.close()
  await fixture?.close()
  await app?.stop()
})

// ═══════════════════════════════════════════════════════════════════════
// 工具从哪来
// ═══════════════════════════════════════════════════════════════════════

describe('工具从哪来（BRT）', () => {
  let chatSid = ''

  it('BRT-1 缺省一个都没有：work / chat / notebook / bot / 钉成 coding 的子会话', async () => {
    const mark = await events.mark()
    writeBotMd(app, 'br-bot', { displayName: 'BR Bot' })

    const work = await createAgentSession(app.main, { projectId, title: 'BRT-1 work' })
    const chatRes = await createAgentSession(app.main, { title: 'BRT-1 chat' })
    chatSid = chatRes.sid
    const notebook = await createAgentSession(app.main, {
      projectId,
      title: 'BRT-1 notebook',
      notebookPath: 'notes/br-note.md'
    })
    const bot = await createAgentSession(app.main, { bot: 'br-bot', title: 'BRT-1 bot' })
    const child = await createPinnedChildSession(app, {
      parentSid: work.sid,
      agentProfile: 'coding',
      title: 'BRT-1 coding child'
    })

    for (const [form, sid] of [
      ['work', work.sid],
      ['chat', chatSid],
      ['notebook', notebook.sid],
      ['bot', bot.sid],
      ['coding child', child]
    ] as const) {
      const names = await ensureRuntime(sid)
      expect(browserToolsOf(names), form).toEqual([])
      // 退役的 multiplex 工具也不在了（没有别名）
      expect(names, form).not.toContain('browser')
      // 没有哪个基座档案声明它：选择器里它只是一个没勾的普通条目
      const item = (await toolsList(sid)).find((t) => t.name === 'mcp:browser')
      expect(item, form).toBeDefined()
      expect(item?.declaredBy, form).toBeUndefined()
      expect(await storedTools(sid), form).toEqual([])
    }

    // 没有谁用到它，所以谁都没连它
    expect(countInLog('connected: browser')).toBe(0)
    const connecting = (await events.allSince<RecordedEvent>(mark)).filter(
      (e) => e.type === 'mcp_connecting' && e.server === 'browser'
    )
    expect(connecting).toEqual([])
  }, 120_000)

  it('BRT-2 发给模型的请求里也没有：既没有 mcp__browser__*，也没有旧的 browser', async () => {
    provider.reset()
    await driver.run(chatSid, [], 'hello')
    const names = lastRequestTools().map((t) => t.function.name)
    expect(names.length).toBeGreaterThan(0)
    expect(names.filter((n) => n.startsWith('mcp__browser__'))).toEqual([])
    expect(names).not.toContain('browser')
  }, 120_000)

  it('BRT-3 输入框的选择器里勾上：存成 [mcp:browser]；下一次请求恰好多出 22 个工具', async () => {
    provider.reset()
    const title = 'BRT-3 picker'
    const sid = await createSession({ title })
    await openInUi(title)

    await picker.open()
    const item = await until(
      async () => (await picker.items()).find((i) => i.name === 'mcp:browser'),
      'mcp:browser listed in the picker'
    )
    expect(item).toMatchObject({ checked: false, disabled: false, declared: false })
    expect(await picker.toggle('mcp:browser')).toBe(true)
    await until(
      async () => JSON.stringify(await storedTools(sid)) === JSON.stringify(['mcp:browser']),
      'selection stored'
    )
    await picker.close()

    const mark = await events.mark()
    await driver.run(sid, [], 'hello with a browser')
    browserSids.add(sid)

    const tools = lastRequestTools()
    const browserTools = tools.filter((t) => t.function.name.startsWith('mcp__browser__'))
    expect(browserTools.map((t) => t.function.name).sort()).toEqual(ALL_BROWSER_TOOLS)
    const listTabsTool = browserTools.find((t) => t.function.name === browserTool('list_tabs'))
    expect(listTabsTool?.function.description).toContain("ShuviX's own browser")
    const upload = browserTools.find((t) => t.function.name === browserTool('upload_file'))
    expect(upload?.function.parameters?.required).toContain('paths')

    // 惰性连接的可见过程：转圈 → 停 → Agent 建好，中间没有错误
    const lifecycle = (await events.allSince<RecordedEvent>(mark))
      .filter(
        (e) =>
          e.sessionId === sid &&
          (e.type === 'mcp_connecting' || e.type === 'agent_created' || e.type === 'error')
      )
      .map((e) => (e.type === 'mcp_connecting' ? `mcp_connecting:${String(e.connecting)}` : e.type))
    expect(lifecycle).toEqual(['mcp_connecting:true', 'mcp_connecting:false', 'agent_created'])
    const connecting = (await events.allSince<RecordedEvent>(mark)).find(
      (e) => e.type === 'mcp_connecting'
    )
    expect(connecting?.server).toBe('browser')
  }, 120_000)

  it('BRT-4 项目默认勾了它：新会话继承这份勾选，运行时拿到工具', async () => {
    const dir = join(app.home, 'br-default-proj')
    mkdirSync(dir, { recursive: true })
    const project = await app.main.eval<{ id: string }>(
      `window.api.project.create(${JSON.stringify({
        name: 'BR-Default-Proj',
        path: dir,
        enabledTools: ['mcp:browser']
      })})`
    )
    const sid = await createSession({ title: 'BRT-4 inherits', projectId: project.id })
    expect(await storedTools(sid)).toEqual(['mcp:browser'])
    expect(browserToolsOf(await ensureRuntime(sid))).toEqual(ALL_BROWSER_TOOLS)
    browserSids.add(sid)
  }, 120_000)

  it('BRT-5 agent 文件声明它：钉了这份档案的子会话不勾也有，勾选里也不会多出它', async () => {
    writeAgentMd(app, 'browsey', { tools: 'read, mcp:browser', displayName: 'Browsey' })
    const parent = await createSession({ title: 'BRT-5 parent' })
    const child = await createPinnedChildSession(app, {
      parentSid: parent,
      agentProfile: 'browsey',
      title: 'BRT-5 browsey child'
    })

    const names = await ensureRuntime(child)
    expect(browserToolsOf(names)).toEqual(ALL_BROWSER_TOOLS)
    expect(names).toContain('read')
    browserSids.add(child)

    const item = (await toolsList(child)).find((t) => t.name === 'mcp:browser')
    expect(item?.declaredBy).toBe('Browsey')
    expect(await storedTools(child)).not.toContain('mcp:browser')
  }, 120_000)
})

// ═══════════════════════════════════════════════════════════════════════
// 主流程
// ═══════════════════════════════════════════════════════════════════════

describe('主流程（BRF：一条勾了浏览器的项目会话，开在界面上）', () => {
  const TITLE = 'BRF main flow'
  let sid = ''
  let tabId = ''
  let nameUid = ''
  let submitUid = ''

  beforeAll(async () => {
    sid = await tickedSession(TITLE, true)
    await openInUi(TITLE)
    await right.close()
  })

  it('BRF-1 open_tab：页面真的被请求、面板在浏览器 tab 上打开、url 门放行并记账、没有询问', async () => {
    provider.reset()
    const url = fixture.url('/form.html')
    const { ends, since } = await driver.run(sid, [
      { id: 'brf1_open', tool: 'open_tab', args: { url } }
    ])

    const end = ends.brf1_open
    expect(end.isError).toBe(false)
    expect(end.result).toMatch(
      /^Opened http:\/\/127\.0\.0\.1:\d+\/form\.html in new tab t\d+\. Use snapshot\/read_page with this tab id\.$/
    )
    tabId = tabIdOf(end.result)
    expect(fixture.hits('/form.html')).toBe(1)

    // 面板跟着 agent 打开，停在浏览器 tab 上
    const opens = await driver.eventsSince(since, 'browser_event')
    expect(opens.map((e) => [e.sessionId, e.action])).toEqual([[sid, 'open']])
    await until(() => right.isOpen(), 'right panel opened by browser_event')
    expect(await right.activeTabIcon()).toBe('lucide-monitor')
    const tab = (await listTabs()).find((t) => t.url === url)
    expect(tab?.active).toBe(true)

    // http 目标上报 url 客体：出厂没有 url 策略，放行 —— 但决策照样记下，带着这次调用的 id
    const decision = securityDecisions(app).find((d) => d.toolCallId === 'brf1_open')
    expect(decision).toMatchObject({
      sessionId: sid,
      toolName: browserTool('open_tab'),
      objectKind: 'url',
      action: 'navigate',
      effect: 'allow',
      objectSummary: url
    })
    expect(await driver.eventsSince(since, 'input_request')).toEqual([])

    // 工具行：浏览器的标签与图标，摘要 = 动作 + 地址
    const row = await until(async () => {
      const rows = await chat.toolRowShots()
      const r = rows.find((x) => x.name === browserTool('open_tab'))
      return r?.status === 'done' ? r : null
    }, 'open_tab row settled')
    expect(BROWSER_LABELS).toContain(row.label)
    expect(row.icon).toBe('lucide-globe')
    expect(row.detail).toBe(`open_tab ${url}`)
  }, 120_000)

  it('BRF-2 snapshot：可访问性快照带 uid，tab 上挂上了 CDP', async () => {
    provider.reset()
    const { ends } = await driver.run(sid, [{ id: 'brf2_snap', tool: 'snapshot', args: { tabId } }])
    const snap = ends.brf2_snap.result
    expect(snap.startsWith('[snapshot] Page: ')).toBe(true)
    expect(snap).toContain('textbox "Name"')
    expect(snap).toContain('button "Submit"')
    expect(snap).toContain('"Attachment"')
    nameUid = uidOf(snap, 'textbox', 'Name')
    submitUid = uidOf(snap, 'button', 'Submit')

    const tab = (await listTabs()).find((t) => t.url === fixture.url('/form.html'))
    expect(tab?.cdpAttached).toBe(true)
  }, 120_000)

  it('BRF-3 fill → click → evaluate（一次运行三轮）：服务器收到提交；界面上合成一行 ×3', async () => {
    provider.reset()
    const { ends, since } = await driver.run(sid, [
      { id: 'brf3_fill', tool: 'fill', args: { tabId, uid: nameUid, text: 'alice' } },
      { id: 'brf3_click', tool: 'click', args: { tabId, uid: submitUid } },
      {
        id: 'brf3_eval',
        tool: 'evaluate',
        args: { tabId, expression: "document.querySelector('#out').textContent" }
      }
    ])
    for (const id of ['brf3_fill', 'brf3_click', 'brf3_eval']) {
      expect(ends[id]?.isError, id).toBe(false)
    }
    // 点击真的发生了：按服务器那一侧的记录断，不信工具自己的回报
    await until(() => fixture.hits('/submit?name=alice') === 1, 'form submitted to the server')
    expect(ends.brf3_eval.result).toContain('"hello alice"')
    expect(await driver.eventsSince(since, 'input_request')).toEqual([])

    // 三个不同的浏览器工具连成一段：混合段不出图标，标签是「浏览器 ×3」
    const expectGroup = async (): Promise<void> => {
      const groups = await until(async () => {
        const g = await chat.stepGroupShots()
        return g.length === 1 ? g : null
      }, 'one step group')
      expect(groups[0].size).toBe(3)
      expect(groups[0].count).toBe(3)
      expect(groups[0].icon).toBe('')
      expect(BROWSER_LABELS.map((l) => `${l} ×3`)).toContain(groups[0].label)
      expect(groups[0].detail).toContain('fill alice')
      expect(groups[0].detail).toContain(`click ${submitUid}`)
    }
    await expectGroup()
    await chat.expandGroups()
    const inGroup = (await chat.toolRowShots()).filter((r) => r.inGroup)
    expect(inGroup.map((r) => [r.name, r.status])).toEqual([
      [browserTool('fill'), 'done'],
      [browserTool('click'), 'done'],
      [browserTool('evaluate'), 'done']
    ])

    // 切走再切回：重投影之后是同一副样子（合并行回到折叠态）
    expect(await sidebar.openSession('BRT-3 picker')).toBe(true)
    await openInUi(TITLE)
    await expectGroup()
    expect((await chat.stepGroupShots())[0].state).toBe('collapsed')
  }, 120_000)

  it('BRF-4 read_page 读得到标题；screenshot 落成会话 tool_results 下的一张 PNG', async () => {
    provider.reset()
    const { ends } = await driver.run(sid, [
      { id: 'brf4_read', tool: 'read_page', args: { tabId } },
      { id: 'brf4_shot', tool: 'screenshot', args: { tabId } }
    ])
    expect(ends.brf4_read.result).toContain('E2E Form Heading')

    const m = /saved to (\S+\.png)/.exec(ends.brf4_shot.result)
    expect(m, ends.brf4_shot.result).not.toBeNull()
    const png = m![1]
    expect(png.startsWith(join(app.home, 'userdata', 'tool_results', sid))).toBe(true)
    expect(existsSync(png)).toBe(true)
    expect(readFileSync(png).subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    )
  }, 120_000)

  it('BRF-5 关掉最后一个 tab：广播 close、面板收起、tab 真的没了', async () => {
    // 先经 IPC 关掉别的 tab —— 「最后一个」才会收起面板
    const mine = (await listTabs()).find((t) => t.url === fixture.url('/form.html'))!
    for (const t of await listTabs()) {
      if (t.id !== mine.id) {
        await app.main.eval(`window.api.browserView.closeTab(${JSON.stringify(t.id)})`)
      }
    }
    await until(async () => (await listTabs()).length === 1, 'only our tab left')

    provider.reset()
    const { ends, since } = await driver.run(sid, [
      { id: 'brf5_close', tool: 'close_tab', args: { tabId } }
    ])
    expect(ends.brf5_close.isError).toBe(false)
    const closes = await driver.eventsSince(since, 'browser_event')
    expect(closes.map((e) => [e.sessionId, e.action])).toEqual([[sid, 'close']])
    await until(async () => !(await right.isOpen()), 'right panel closed with the last tab')
    expect(await listTabs()).toEqual([])
  }, 120_000)
})

// ═══════════════════════════════════════════════════════════════════════
// 呈现：退役的旧 browser 工具，与同一张兜底呈现表上的内置 ssh
// ═══════════════════════════════════════════════════════════════════════

describe('兜底呈现：退役的旧 browser 工具与内置 ssh（BRR）', () => {
  it('BRR-2 模型还在叫旧的 browser：找不到工具的错误行，仍有浏览器的标签与摘要', async () => {
    const title = 'BRR-2 legacy call'
    const sid = await createSession({ title })
    await openInUi(title)
    provider.reset()
    const url = fixture.url('/form.html')
    const { ends } = await driver.run(sid, [
      { id: 'brr2_legacy', tool: 'browser', args: { action: 'open_tab', url } }
    ])
    expect(ends.brr2_legacy.isError).toBe(true)
    expect(ends.brr2_legacy.result).toContain('Tool browser not found')

    const block = (await listMessages(sid))
      .flatMap((m) => m.blocks ?? [])
      .find((b) => b.toolCallId === 'brr2_legacy')
    expect(block?.isError).toBe(true)

    const row = await until(async () => {
      const r = (await chat.toolRowShots()).find((x) => x.name === 'browser')
      return r?.status === 'error' ? r : null
    }, 'legacy browser row settled as an error')
    expect(BROWSER_LABELS).toContain(row.label)
    expect(row.detail).toBe(`open_tab ${url}`)
    // 出错标记顶掉了类型图标
    expect(row.icon).toBe('lucide-x')
  }, 120_000)

  it('BRR-3 旧 browser 的已完成调用（改写自真实转写）：同一工具的合并行，浏览器图标，计数 2', async () => {
    // 先在一条勾了浏览器的会话里真跑两次 list_tabs，拿到一份真实的转写
    const src = await tickedSession('BRR-3 source')
    provider.reset()
    const { ends } = await driver.run(src, [
      [
        { id: 'brr3_a', tool: 'list_tabs', args: {} },
        { id: 'brr3_b', tool: 'list_tabs', args: {} }
      ]
    ])
    expect(ends.brr3_a?.isError).toBe(false)
    expect(ends.brr3_b?.isError).toBe(false)

    // 目标会话**建了但从没打开过**：会话树缓存不记「文件不存在」，文件放好之后第一次打开就读它
    const title = 'BRR-3 legacy transcript'
    const dst = await createSession({ title })
    const sessionsDir = join(app.home, 'userdata', 'data', 'sessions')
    const srcFile = join(sessionsDir, `${src}.jsonl`)
    const raw = await until(() => {
      const text = existsSync(srcFile) ? readFileSync(srcFile, 'utf8') : ''
      return text.includes('brr3_b') && text.includes('"done"') ? text : null
    }, 'source transcript flushed')
    writeFileSync(join(sessionsDir, `${dst}.jsonl`), asLegacyTranscript(raw, src, dst))

    await openInUi(title)
    const group = await until(async () => {
      const g = await chat.stepGroupShots()
      return g.length === 1 ? g[0] : null
    }, 'legacy calls folded into one group')
    expect(group).toMatchObject({ size: 2, count: 2, icon: 'lucide-globe', detail: 'list_tabs' })
    expect(BROWSER_LABELS).toContain(group.label)

    await chat.expandGroups()
    const rows = (await chat.toolRowShots()).filter((r) => r.inGroup)
    expect(rows.map((r) => [r.name, r.status, r.icon, r.detail])).toEqual([
      ['browser', 'done', 'lucide-globe', 'list_tabs'],
      ['browser', 'done', 'lucide-globe', 'list_tabs']
    ])
  }, 120_000)

  it('BRR-4 内置 ssh 同一张兜底呈现表：SSH 的标签与图标；exec 的卡写明主机，行上是「主机 · 说明」，展开是终端', async () => {
    mkdirSync(join(app.home, '.ssh'), { recursive: true })
    writeFileSync(
      join(app.home, '.ssh', 'config'),
      ['Host e2e-box', '  HostName 127.0.0.1', '  Port 9', ''].join('\n')
    )
    const title = 'BRR-4 ssh rows'
    const sid = await createSession({ title })
    expect((await writeTools(sid, ['mcp:ssh'])).success).toBe(true)
    await openInUi(title)

    provider.reset()
    const listed = await driver.run(sid, [
      { id: 'brr4_hosts', tool: 'mcp__ssh__list-hosts', args: {} }
    ])
    expect(listed.ends.brr4_hosts.result).toContain('e2e-box')
    const hosts = await until(async () => {
      const r = (await chat.toolRowShots()).find((x) => x.name === 'mcp__ssh__list-hosts')
      return r?.status === 'done' ? r : null
    }, 'list-hosts row settled')
    expect(hosts.label).toBe('SSH')
    expect(hosts.icon).toBe('lucide-square-terminal')

    // 每条远端命令都问，卡片把目标主机写在命令前面。这里**拒掉**：放行会起一个真的 ssh 进程，
    // 而桌面接线不传 -F，OpenSSH 读的是用户真实的 ~/.ssh/config（它的 ~ 走 getpwuid，不看 $HOME）
    provider.reset()
    const since = await driver.start(sid, [
      {
        id: 'brr4_exec',
        tool: 'mcp__ssh__exec',
        args: { host: 'e2e-box', command: 'echo hi', description: 'say hi' }
      }
    ])
    const ask = await driver.waitAsk(sid, since)
    expect(ask.command).toBe('ssh e2e-box: echo hi')
    await driver.answer(sid, ask.id, false)
    const { ends } = await driver.finish(sid, since)
    expect(ends.brr4_exec.result).toContain('User denied execution of this command')

    expect(ends.brr4_exec.isError).toBe(true)

    // 被拒的命令是一次失败的调用：行出错（出错标记顶掉了类型图标），标签与摘要照旧
    await until(
      async () =>
        (await chat.toolRowShots()).some(
          (x) => x.name === 'mcp__ssh__exec' && x.status === 'error'
        ),
      'exec row settled as an error'
    )
    const execIndex = (await chat.toolRowShots()).findIndex((x) => x.name === 'mcp__ssh__exec')
    const exec = (await chat.toolRowShots())[execIndex]
    expect(exec.label).toBe('SSH')
    expect(exec.detail).toBe('e2e-box · say hi')
    expect(exec.terminal).toBeNull()

    await chat.setToolRowExpanded(execIndex, true)
    const terminal = (await chat.toolRowShots())[execIndex].terminal
    expect(terminal).toContain('e2e-box')
    expect(terminal).toContain('echo hi')
  }, 120_000)
})

/**
 * 把一份真实转写改写成「旧 multiplex browser 工具」时代的样子：`mcp__browser__<tool>` 的调用
 * 改名 `browser`、参数换成 `{action: <tool>}`，结果的 toolName 跟着改；头行的会话 id 换成目标会话。
 */
function asLegacyTranscript(raw: string, srcId: string, dstId: string): string {
  const PREFIX = 'mcp__browser__'
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(walk)
      return
    }
    if (!value || typeof value !== 'object') return
    const o = value as Record<string, unknown>
    if (o.type === 'toolCall' && typeof o.name === 'string' && o.name.startsWith(PREFIX)) {
      o.arguments = { action: o.name.slice(PREFIX.length) }
      o.name = 'browser'
    }
    if (typeof o.toolName === 'string' && o.toolName.startsWith(PREFIX)) o.toolName = 'browser'
    for (const child of Object.values(o)) walk(child)
  }
  const lines = raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const entry = JSON.parse(line) as Record<string, unknown>
      if (entry.type === 'session') {
        for (const [k, v] of Object.entries(entry)) if (v === srcId) entry[k] = dstId
      }
      walk(entry)
      return JSON.stringify(entry)
    })
  return lines.join('\n') + '\n'
}

// ═══════════════════════════════════════════════════════════════════════
// 实例归谁
// ═══════════════════════════════════════════════════════════════════════

describe('实例归谁（BRL：A 在项目里，B 不在任何项目里，两条都勾了浏览器）', () => {
  let a = ''
  let b = ''
  let formTab = ''
  let counterTab = ''

  it('BRL-1 两条会话两台实例；事件与决策各记各的会话；tab 是全 app 共用的', async () => {
    const before = countInLog(CONNECTED_LINE)
    a = await tickedSession('BRL A', true)
    b = await tickedSession('BRL B')
    expect(countInLog(CONNECTED_LINE)).toBe(before + 2)

    provider.reset()
    const url = fixture.url('/form.html')
    const opened = await driver.run(a, [{ id: 'brl1_a_open', tool: 'open_tab', args: { url } }])
    formTab = tabIdOf(opened.ends.brl1_a_open.result)
    expect(
      (await driver.eventsSince(opened.since, 'browser_event')).map((e) => [e.sessionId, e.action])
    ).toEqual([[a, 'open']])
    expect(securityDecisions(app).find((d) => d.toolCallId === 'brl1_a_open')?.sessionId).toBe(a)

    // B 自己的实例看得见 A 开的 tab：tab 属于整个面板，不属于会话
    provider.reset()
    const listed = await driver.run(b, [{ id: 'brl1_b_list', tool: 'list_tabs', args: {} }])
    expect(listed.ends.brl1_b_list.result).toContain(`[${formTab}]`)
    expect(listed.ends.brl1_b_list.result).toContain(url)
    expect(await driver.eventsSince(listed.since, 'browser_event')).toEqual([])
  }, 120_000)

  it('BRL-5 快照的差异基线按调用方分开：B 点了之后，A 的下一张快照相对的是 A 自己的上一张', async () => {
    const DIFF = '(diff vs your previous snapshot'
    provider.reset()
    const opened = await driver.run(a, [
      { id: 'brl5_a_open', tool: 'open_tab', args: { url: fixture.url('/counter.html') } }
    ])
    counterTab = tabIdOf(opened.ends.brl5_a_open.result)

    provider.reset()
    const a1 = (
      await driver.run(a, [{ id: 'brl5_a_snap1', tool: 'snapshot', args: { tabId: counterTab } }])
    ).ends.brl5_a_snap1.result
    expect(a1).not.toContain(DIFF)
    expect(a1).not.toContain('item 1')

    // B 第一次看这一页：全量（它手上没有 A 的那一份）
    provider.reset()
    const b1 = (
      await driver.run(b, [{ id: 'brl5_b_snap1', tool: 'snapshot', args: { tabId: counterTab } }])
    ).ends.brl5_b_snap1.result
    expect(b1).not.toContain(DIFF)
    const addUid = uidOf(b1, 'button', 'Add')

    provider.reset()
    const bRun = await driver.run(b, [
      { id: 'brl5_b_click', tool: 'click', args: { tabId: counterTab, uid: addUid } },
      { id: 'brl5_b_snap2', tool: 'snapshot', args: { tabId: counterTab } }
    ])
    expect(bRun.ends.brl5_b_click.isError).toBe(false)
    const b2 = bRun.ends.brl5_b_snap2.result
    expect(b2).toContain(DIFF)
    expect(b2).toMatch(/^\+.*item 1/m)

    // A 的基线还是它自己那一张（没有 item 1）：差异里必须有这一行新增。共用一份基线、
    // 或调用方身份没传到 server，A 看到的都会是「0 changed」
    provider.reset()
    const a2 = (
      await driver.run(a, [{ id: 'brl5_a_snap2', tool: 'snapshot', args: { tabId: counterTab } }])
    ).ends.brl5_a_snap2.result
    expect(a2).toContain(DIFF)
    expect(a2).toMatch(/^\+.*item 1/m)
  }, 120_000)

  it('BRL-2 pdf 的相对路径按各自的工作目录解析：A 落进项目，B 落进它自己的临时工作区', async () => {
    const cases = [
      { sid: a, id: 'brl2_a_pdf', out: 'brl-a.pdf', abs: join(projDir, 'brl-a.pdf') },
      {
        sid: b,
        id: 'brl2_b_pdf',
        out: 'brl-b.pdf',
        abs: join(app.home, 'userdata', 'temp_workspace', b, 'brl-b.pdf')
      }
    ]
    for (const c of cases) {
      provider.reset()
      const since = await driver.start(c.sid, [
        { id: c.id, tool: 'pdf', args: { tabId: counterTab, outputPath: c.out } }
      ])
      // 出厂的 ask-on-write 对每一次写都问 —— 包括工作区里的
      const ask = await driver.waitAsk(c.sid, since)
      expect(ask.command, c.id).toBe(`Write(${c.abs})`)
      await driver.answer(c.sid, ask.id, true)
      const { ends } = await driver.finish(c.sid, since)
      expect(ends[c.id].isError, c.id).toBe(false)
      expect(ends[c.id].result, c.id).toContain(c.abs)
      expect(readFileSync(c.abs).subarray(0, 5).toString(), c.id).toBe('%PDF-')
    }
  }, 120_000)

  it('BRL-3 清空 A 的消息（运行时重建）不重连：没有新的 connected 行、不转圈，工具照常能用', async () => {
    const before = countInLog(CONNECTED_LINE)
    const mark = await events.mark()
    await app.main.eval(`window.api.message.clear(${JSON.stringify(a)})`)
    expect(browserToolsOf(await ensureRuntime(a))).toEqual(ALL_BROWSER_TOOLS)

    provider.reset()
    const { ends } = await driver.run(a, [{ id: 'brl3_list', tool: 'list_tabs', args: {} }])
    expect(ends.brl3_list.result).toContain(`[${counterTab}]`)
    expect(countInLog(CONNECTED_LINE)).toBe(before)
    const connecting = (await events.allSince<RecordedEvent>(mark)).filter(
      (e) => e.type === 'mcp_connecting'
    )
    expect(connecting).toEqual([])
  }, 120_000)

  it('BRL-4 删 A 只放掉 A 那一台：B 照常能用、行还连着、A 开的 tab 还在；B 也删掉才回到未启动', async () => {
    // 行的状态是所有会话实例的聚合 —— 先放掉前面各段留下的实例
    for (const sid of [...browserSids]) if (sid !== a && sid !== b) await deleteSession(sid)

    const closeLine = `closeSession ${a}: 1 builtin server(s) closed`
    await deleteSession(a)
    await until(() => app.mainLog().includes(closeLine), 'A released its own instance')
    expect(countInLog(closeLine)).toBe(1)

    provider.reset()
    const { ends } = await driver.run(b, [{ id: 'brl4_b_list', tool: 'list_tabs', args: {} }])
    expect(ends.brl4_b_list.isError).toBe(false)
    expect(ends.brl4_b_list.result).toContain(`[${formTab}]`)
    expect(ends.brl4_b_list.result).toContain(`[${counterTab}]`)
    expect((await mcpRow()).status).toBe('connected')

    await deleteSession(b)
    await until(
      async () => (await mcpRow()).status === 'disconnected',
      'browser row not started once the last instance is gone'
    )
    // tab 属于面板：会话都删了，tab 还开着
    const urls = (await listTabs()).map((t) => t.url)
    expect(urls).toContain(fixture.url('/form.html'))
  }, 120_000)
})
