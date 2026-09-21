/**
 * 内置浏览器的安全门 —— 浏览器第一次有了自己的安全客体（假提供商脚本化，询问手工应答）。
 *
 * 桌面宿主给 browser server 装了三道门，全部接回现成的策略，而不是另起一套：
 *   - 导航到 `file://…` = **读那个文件**（enforcePath('read')）：出厂的 ask-on-read（工作区外问）、
 *     protect-credentials（凭据目录问）照样生效。一个显示本地文件的 tab 上做任何事也按读它过门 ——
 *     页面自己跳过去的也算（BRP-1）；
 *   - 上传给网页的文件 = 读（逐个过门）；pdf 的输出位置 = **写**（出厂 ask-on-write 对每一次写都问，
 *     工作区里的也问 —— 从前是工作区里静默写、工作区外硬拒）；
 *   - http(s) 等地址上报 `{type:'url'}` 客体：出厂没有 url 策略（没有策略 = 放行），用户可以自己写。
 *
 * 另有 L1 全工具门：内置 server 的工具 annotations 是可信的，于是用户能写「浏览器里有破坏性的
 * 动作要问」（BRG-16）；第三方 server 的 annotations 则一条都不进客体 —— 自称只读的照样问
 * （BRG-16b）。以及几条收尾：`view-source:` 不开（BRP-2）、server 名不能带 `__`
 * （BRP-3）、pdf 参数先校验再过门（BRP-4）、停用再启用之后新会话恢复、旧运行时的报错不露内部键（BRP-5）。
 *
 * 断言三路并用：`input_request`（卡片的命令 / 说明 / 命中的策略）、主进程日志里的安全决策
 * （与界面语言无关）、夹具网站与磁盘这一侧（被拒的东西确实没发生）。卡片与工具行的呈现只断
 * 两处（按 toolCallId 认领的盾牌、url 询问卡的标题），经 pages.ts。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Server as McpSdkServer } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { until } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import { startFakeProvider, type FakeProvider } from '../../harness/fakeProvider'
import {
  createProject,
  eventRecorder,
  securityDecisions,
  seedFakeProvider,
  waitRendererReady,
  type EventRecorder
} from '../../harness/seed'
import { chatPane, sidebarPane, type ChatPane, type SidebarPane } from '../../harness/pages'
import {
  BROWSER_TOOL_NAMES,
  browserDriver,
  browserTool,
  startFixtureServer,
  tabIdOf,
  uidOf,
  type BrowserDriver,
  type FixtureServer,
  type ToolEndEvent
} from '../../harness/browserFixtures'

const MODEL = 'e2e-model'
const BROWSER_ID = 'builtin-mcp-browser'
const ALL_BROWSER_TOOLS = BROWSER_TOOL_NAMES.map(browserTool).sort()
const BROWSER_LABELS = ['Browser', '浏览器', 'ブラウザ']
const TITLE = 'BRG gates'

/** 页面与文件里的特征串 —— 「内容有没有漏出去」按它们断 */
const SECRET_MARK = 'SECRET-PAGE-91'
const OTHER_MARK = 'OTHER-SECRET-77'
const KEY_MARK = 'FAKE-PRIVATE-KEY-e2e'
const UPLOAD_MARK = 'UPLOAD-CONTENT-42'

interface PolicyRow {
  name: string
  displayName: string
  source: string
}

let app: E2EApp
let provider: FakeProvider
let events: EventRecorder
let fixture: FixtureServer
let driver: BrowserDriver
let chat: ChatPane
let sidebar: SidebarPane
let sid = ''
let projDir = ''
let outsideDir = ''
let keyFile = ''
/** BRG-1 打开的工作区内的 index.html —— 之后被导航 / cdp / 页面自己跳转拿来试门 */
let insideTab = ''
/** 上传段打开的表单页 —— pdf 与 url 策略的 cdp 用例也在它上面 */
let formTab = ''

// ─── 助手 ───

const fileUrl = (abs: string): string => pathToFileURL(abs).href
const listTabs = (): Promise<Array<{ id: string; url: string }>> =>
  app.main.eval(`window.api.browserView.listTabs()`)
const allowList = (): Promise<string[]> =>
  app.main.eval<string[]>(
    `window.api.session.getById(${JSON.stringify(sid)}).then((s) => (s && s.settings && s.settings.allowList) || [])`
  )
const setAutoAllow = (on: boolean): Promise<unknown> =>
  app.main.eval(`window.api.session.updateAutoAllow(${JSON.stringify({ id: sid, autoAllow: on })})`)
const createPolicy = (text: string): Promise<{ success: boolean; error?: string }> =>
  app.main.eval(`window.api.policy.create(${JSON.stringify({ text })})`)
const deletePolicy = (name: string): Promise<unknown> =>
  app.main.eval(`window.api.policy.delete(${JSON.stringify({ name })})`)
const listPolicies = (): Promise<PolicyRow[]> =>
  app.main.eval<PolicyRow[]>(
    `window.api.policy.list().then((l) => l.map((p) => ({ name: p.name, displayName: p.displayName, source: p.source })))`
  )

/** 这次调用的安全决策（按 toolCallId 认；一次调用可能过好几道门） */
const decisionsOf = (toolCallId: string): ReturnType<typeof securityDecisions> =>
  securityDecisions(app).filter((d) => d.toolCallId === toolCallId)

/** 这条会话里某次运行之后的全部工具结果与发给模型的请求 —— 「内容有没有漏出去」的取证面 */
const everythingSince = async (since: number): Promise<string> => {
  const ends = await driver.eventsSince<ToolEndEvent>(since, 'tool_end', sid)
  return ends.map((e) => e.result).join('\n')
}

/** 一次调用、一张卡、一个应答：回这次调用的 tool_end 与那张卡 */
const askOnce = async (
  call: { id: string; tool: string; args: Record<string, unknown> },
  allow: boolean,
  remember = false
): Promise<{
  end: ToolEndEvent
  ask: Awaited<ReturnType<BrowserDriver['waitAsk']>>
  since: number
}> => {
  provider.reset()
  const since = await driver.start(sid, [call])
  const ask = await driver.waitAsk(sid, since)
  await driver.answer(sid, ask.id, allow, remember)
  const { ends } = await driver.finish(sid, since)
  return { end: ends[call.id], ask, since }
}

/** 一次不该有询问的调用：跑完，断言确实没有卡 */
const noAsk = async (
  calls: Array<{ id: string; tool: string; args: Record<string, unknown> }>
): Promise<Record<string, ToolEndEvent>> => {
  provider.reset()
  const { ends, since } = await driver.run(sid, calls)
  expect(await driver.eventsSince(since, 'input_request', sid)).toEqual([])
  return ends
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

  projDir = join(app.home, 'gates-proj')
  outsideDir = join(app.home, 'outside')
  mkdirSync(join(projDir, 'fixtures'), { recursive: true })
  mkdirSync(outsideDir, { recursive: true })
  mkdirSync(join(app.home, '.ssh'), { recursive: true })
  writeFileSync(join(projDir, 'index.html'), '<h1>Inside index page</h1>\n')
  writeFileSync(join(projDir, 'fixtures', 'up.txt'), UPLOAD_MARK)
  writeFileSync(join(outsideDir, 'secret.html'), `<h1>${SECRET_MARK}</h1>\n`)
  writeFileSync(join(outsideDir, 'other.html'), `<h1>${OTHER_MARK}</h1>\n`)
  writeFileSync(join(outsideDir, 'up-outside.txt'), 'OUTSIDE-UPLOAD')
  keyFile = join(app.home, '.ssh', 'id_e2e')
  writeFileSync(keyFile, KEY_MARK)

  const projectId = (await createProject(app.main, { name: 'BR-Gates-Proj', path: projDir })).id
  sid = await app.main.eval<string>(
    `window.api.session.create(${JSON.stringify({ title: TITLE, projectId })}).then((s) => s.id)`
  )
  await app.main.eval(
    `window.api.session.updateEnabledTools(${JSON.stringify({ id: sid, enabledTools: ['mcp:browser'] })})`
  )
  await until(async () => (await sidebar.titles()).includes(TITLE), 'gates session listed')
  expect(await sidebar.openSession(TITLE)).toBe(true)
  await chat.ready()
}, 120_000)

afterAll(async () => {
  await provider?.close()
  await fixture?.close()
  await app?.stop()
})

// ═══════════════════════════════════════════════════════════════════════
// file:// = 读那个文件
// ═══════════════════════════════════════════════════════════════════════

describe('file:// 导航按读文件过门', () => {
  it('BRG-1 工作区里的文件：不问，页面照常打开，决策记为 path / read / allow', async () => {
    const abs = join(projDir, 'index.html')
    const ends = await noAsk([{ id: 'brg1_open', tool: 'open_tab', args: { url: fileUrl(abs) } }])
    expect(ends.brg1_open.isError).toBe(false)
    expect(ends.brg1_open.result).toContain(`Opened ${fileUrl(abs)} in new tab`)
    insideTab = tabIdOf(ends.brg1_open.result)

    expect(decisionsOf('brg1_open')).toEqual([
      expect.objectContaining({
        sessionId: sid,
        objectKind: 'path',
        action: 'read',
        effect: 'allow',
        objectSummary: abs
      })
    ])
  }, 120_000)

  it('BRG-2 工作区外的文件：卡片按 toolCallId 认领；拒绝之后不开 tab，错误回到模型', async () => {
    const abs = join(outsideDir, 'secret.html')
    const tabsBefore = (await listTabs()).length
    provider.reset()
    const since = await driver.start(sid, [
      { id: 'brg2_open', tool: 'open_tab', args: { url: fileUrl(abs) } }
    ])
    const ask = await driver.waitAsk(sid, since)
    expect(ask).toMatchObject({
      id: 'brg2_open',
      toolName: browserTool('open_tab'),
      command: `Read(${abs})`
    })
    // 盾牌画在这一次调用的那一行上 —— 卡片的 id 就是模型的 toolCallId，这是路由成立的证据
    const waiting = await until(async () => {
      const rows = await chat.toolRowShots()
      return rows.find((r) => r.awaiting) ?? null
    }, 'the open_tab row shows the pending-ask shield')
    expect(waiting.name).toBe(browserTool('open_tab'))
    expect(waiting.status).toBe('running')

    await driver.answer(sid, ask.id, false)
    const { ends } = await driver.finish(sid, since)
    expect(ends.brg2_open.result.startsWith(`[MCP Error] User denied access to ${abs}`)).toBe(true)
    // 被拒的调用是一次失败的调用：界面标红，不会被并进已完成的步骤组
    expect(ends.brg2_open.isError).toBe(true)
    expect(ends.brg2_open.result).not.toContain(SECRET_MARK)

    expect((await listTabs()).length).toBe(tabsBefore)
    expect(await driver.eventsSince(since, 'browser_event')).toEqual([])
    // 下一轮请求里模型读到的就是这句拒绝
    const reqs = provider.chatRequests()
    expect(reqs[reqs.length - 1].raw).toContain(`User denied access to ${abs}`)
    expect(decisionsOf('brg2_open')).toEqual([
      expect.objectContaining({ objectKind: 'path', effect: 'ask', userResponse: 'denied' })
    ])
  }, 120_000)

  it('BRG-3 另外两个入口也过同一道门：navigate 与 cdp Page.navigate 都问，拒了 tab 原地不动', async () => {
    const abs = join(outsideDir, 'secret.html')
    provider.reset()
    const since = await driver.start(sid, [
      { id: 'brg3_nav', tool: 'navigate', args: { tabId: insideTab, url: fileUrl(abs) } },
      {
        id: 'brg3_cdp',
        tool: 'cdp',
        args: { tabId: insideTab, method: 'Page.navigate', params: { url: fileUrl(abs) } }
      }
    ])
    for (const expected of ['brg3_nav', 'brg3_cdp']) {
      const ask = await driver.waitAsk(sid, since)
      expect(ask.id).toBe(expected)
      expect(ask.command).toBe(`Read(${abs})`)
      await driver.answer(sid, ask.id, false)
    }
    const { ends } = await driver.finish(sid, since)
    for (const id of ['brg3_nav', 'brg3_cdp']) {
      expect(ends[id].result, id).toContain(`User denied access to ${abs}`)
    }
    const inside = (await listTabs()).find((t) => t.url === fileUrl(join(projDir, 'index.html')))
    expect(inside, 'the inside tab kept its page').toBeDefined()
    expect((await listTabs()).some((t) => t.url === fileUrl(abs))).toBe(false)
  }, 120_000)

  it('BRG-4 凭据目录：卡片上署了 protect-credentials 的名', async () => {
    const credentials = (await listPolicies()).find(
      (p) => p.name === 'protect-credentials' && p.source === 'builtin'
    )!
    const { end, ask, since } = await askOnce(
      { id: 'brg4_open', tool: 'open_tab', args: { url: fileUrl(keyFile) } },
      false
    )
    expect(ask.command).toBe(`Read(${keyFile})`)
    expect(ask.policyPrompt?.policies).toContain(credentials.displayName)
    expect(end.result).toContain(`User denied access to ${keyFile}`)
    expect(await everythingSince(since)).not.toContain(KEY_MARK)
  }, 120_000)

  it('BRG-5 带 .. 的地址：卡片上是归一之后的路径', async () => {
    const dotted = `${fileUrl(projDir)}/../outside/secret.html`
    const { ask } = await askOnce(
      { id: 'brg5_open', tool: 'open_tab', args: { url: dotted } },
      false
    )
    expect(ask.command).toBe(`Read(${join(outsideDir, 'secret.html')})`)
  }, 120_000)

  it('BRG-6 允许并记住：allowList 多一条 Read(…)；再开同一个文件、read 工具读它都不再问', async () => {
    const abs = join(outsideDir, 'secret.html')
    const { end } = await askOnce(
      { id: 'brg6_open', tool: 'open_tab', args: { url: fileUrl(abs) } },
      true,
      true
    )
    expect(end.result).toContain(`Opened ${fileUrl(abs)} in new tab`)
    expect(await allowList()).toContain(`Read(${abs})`)

    const ends = await noAsk([
      { id: 'brg6_again', tool: 'open_tab', args: { url: fileUrl(abs) } },
      { id: 'brg6_read', tool: 'read', args: { path: abs } }
    ])
    expect(ends.brg6_again.result).toContain('in new tab')
    expect(ends.brg6_read.result).toContain(SECRET_MARK)
  }, 120_000)

  it('BRP-1 页面自己跳到工作区外：下一个操作按读那个文件问；拒了内容不外泄，允许过一次之后不再问', async () => {
    const other = join(outsideDir, 'other.html')
    // 工作区里的页面（BRG-1 放行过，这台实例记着）上跑 evaluate：不问
    const moved = await noAsk([
      {
        id: 'brp1_eval',
        tool: 'evaluate',
        args: { tabId: insideTab, expression: `location.href = ${JSON.stringify(fileUrl(other))}` }
      }
    ])
    expect(moved.brp1_eval.isError).toBe(false)
    // 等页面真的跳过去（新文档提交之后 tab 的地址才换）
    await until(
      async () => (await listTabs()).some((t) => t.url === fileUrl(other)),
      'the tab now shows the outside file'
    )

    const denied = await askOnce(
      { id: 'brp1_read1', tool: 'read_page', args: { tabId: insideTab } },
      false
    )
    expect(denied.ask.command).toBe(`Read(${other})`)
    expect(denied.ask.description).toBe(`Read the local file shown in tab ${insideTab}`)
    expect(denied.end.result.startsWith(`[MCP Error] User denied access to ${other}`)).toBe(true)
    expect(await everythingSince(denied.since)).not.toContain(OTHER_MARK)
    const reqs = provider.chatRequests()
    expect(reqs.every((r) => !r.raw.includes(OTHER_MARK))).toBe(true)

    const allowed = await askOnce(
      { id: 'brp1_read2', tool: 'read_page', args: { tabId: insideTab } },
      true
    )
    expect(allowed.ask.command).toBe(`Read(${other})`)
    expect(allowed.end.result).toContain(OTHER_MARK)

    // 放行过一次，这台实例就记着它：之后在这个 tab 上的操作不再问
    const after = await noAsk([{ id: 'brp1_snap', tool: 'snapshot', args: { tabId: insideTab } }])
    expect(after.brp1_snap.isError).toBe(false)
  }, 120_000)

  it('BRP-2 view-source: 不开：直接报错，不问、不开 tab、不广播', async () => {
    const tabsBefore = (await listTabs()).length
    provider.reset()
    const { ends, since } = await driver.run(sid, [
      { id: 'brp2_open', tool: 'open_tab', args: { url: `view-source:${fileUrl(keyFile)}` } }
    ])
    expect(ends.brp2_open.result).toContain('view-source')
    expect(ends.brp2_open.result).not.toContain(KEY_MARK)
    expect(await driver.eventsSince(since, 'input_request')).toEqual([])
    expect(await driver.eventsSince(since, 'browser_event')).toEqual([])
    expect((await listTabs()).length).toBe(tabsBefore)
    expect(decisionsOf('brp2_open')).toEqual([])
  }, 120_000)
})

// ═══════════════════════════════════════════════════════════════════════
// 上传 = 读，逐个过门
// ═══════════════════════════════════════════════════════════════════════

describe('upload_file 的每个文件都按读过门', () => {
  let attachUid = ''

  /** 文件输入框里此刻有几个文件 */
  const fileCount = async (id: string): Promise<string> =>
    (
      await noAsk([
        {
          id,
          tool: 'evaluate',
          args: { tabId: formTab, expression: "document.querySelector('#f').files.length" }
        }
      ])
    )[id].result

  beforeAll(async () => {
    const opened = await noAsk([
      { id: 'up_open', tool: 'open_tab', args: { url: fixture.url('/form.html') } }
    ])
    formTab = tabIdOf(opened.up_open.result)
    const snap = await noAsk([{ id: 'up_snap', tool: 'snapshot', args: { tabId: formTab } }])
    const m = /uid=(\w+)(?: [\w-]+)? "Attachment"/.exec(snap.up_snap.result)
    if (!m) throw new Error(`no Attachment element in snapshot:\n${snap.up_snap.result}`)
    attachUid = m[1]
  })

  it('BRG-7 工作区里的文件（相对路径）：不问，页面拿到的就是那个文件', async () => {
    const ends = await noAsk([
      {
        id: 'brg7_up',
        tool: 'upload_file',
        args: { tabId: formTab, uid: attachUid, paths: ['fixtures/up.txt'] }
      },
      {
        id: 'brg7_eval',
        tool: 'evaluate',
        args: {
          tabId: formTab,
          expression:
            "(async () => { const f = document.querySelector('#f').files[0]; return f.name + '|' + (await f.text()) })()"
        }
      }
    ])
    expect(ends.brg7_up.isError).toBe(false)
    expect(ends.brg7_eval.result).toContain(`up.txt|${UPLOAD_MARK}`)
    expect(decisionsOf('brg7_up')).toEqual([
      expect.objectContaining({
        objectKind: 'path',
        action: 'read',
        effect: 'allow',
        objectSummary: join(projDir, 'fixtures', 'up.txt')
      })
    ])
  }, 120_000)

  it('BRG-8 工作区外的文件：卡片写明要交给网页；拒了输入框里一个文件都没有', async () => {
    // 先清掉上一条放进去的文件
    await noAsk([
      {
        id: 'brg8_reset',
        tool: 'evaluate',
        args: { tabId: formTab, expression: "document.querySelector('#f').value = ''" }
      }
    ])
    expect(await fileCount('brg8_count0')).toBe('0')

    const abs = join(outsideDir, 'up-outside.txt')
    const { end, ask } = await askOnce(
      {
        id: 'brg8_up',
        tool: 'upload_file',
        args: { tabId: formTab, uid: attachUid, paths: [abs] }
      },
      false
    )
    expect(ask.command).toBe(`Read(${abs})`)
    expect(ask.description).toBe(`Upload to the web page in tab ${formTab}`)
    expect(end.result).toContain(`User denied access to ${abs}`)
    expect(await fileCount('brg8_count1')).toBe('0')
  }, 120_000)

  it('BRG-9 相对路径带 ..：卡片上是归一之后的绝对路径', async () => {
    const { ask } = await askOnce(
      {
        id: 'brg9_up',
        tool: 'upload_file',
        args: { tabId: formTab, uid: attachUid, paths: ['../outside/up-outside.txt'] }
      },
      false
    )
    expect(ask.command).toBe(`Read(${join(outsideDir, 'up-outside.txt')})`)
  }, 120_000)

  it('BRG-10 工作区里不存在的文件：不问，直接报没有这个文件', async () => {
    const ends = await noAsk([
      {
        id: 'brg10_up',
        tool: 'upload_file',
        args: { tabId: formTab, uid: attachUid, paths: ['fixtures/missing.txt'] }
      }
    ])
    expect(ends.brg10_up.result).toBe('[MCP Error] No such file: fixtures/missing.txt')
    expect(ends.brg10_up.isError).toBe(true)
  }, 120_000)

  // ═════════════════════════════════════════════════════════════════════
  // pdf 的输出位置 = 写
  // ═════════════════════════════════════════════════════════════════════

  describe('pdf 的输出位置按写过门', () => {
    it('BRG-11 工作区里：出厂的 ask-on-write 也问；允许之后落下一份真 PDF', async () => {
      const abs = join(projDir, 'out', 'page.pdf')
      const { end, ask } = await askOnce(
        { id: 'brg11_pdf', tool: 'pdf', args: { tabId: formTab, outputPath: 'out/page.pdf' } },
        true
      )
      expect(ask.command).toBe(`Write(${abs})`)
      expect(end.result).toContain(abs)
      expect(readFileSync(abs).subarray(0, 5).toString()).toBe('%PDF-')
    }, 120_000)

    it('BRG-12 工作区外：问（从前是不问就拒）；拒了不落文件', async () => {
      const abs = join(outsideDir, 'page.pdf')
      const { end, ask } = await askOnce(
        { id: 'brg12_pdf', tool: 'pdf', args: { tabId: formTab, outputPath: abs } },
        false
      )
      expect(ask.command).toBe(`Write(${abs})`)
      expect(end.result).toContain(`User denied access to ${abs}`)
      expect(existsSync(abs)).toBe(false)
    }, 120_000)

    it('BRG-13 系统目录：不问就拒，决策记在 protect-system 名下', async () => {
      const target = '/etc/shuvix-e2e-browser.pdf'
      const ends = await noAsk([
        { id: 'brg13_pdf', tool: 'pdf', args: { tabId: formTab, outputPath: target } }
      ])
      expect(ends.brg13_pdf.result).toContain("Denied by security policy rule 'protect-system#")
      expect(existsSync(target)).toBe(false)
      const [decision] = decisionsOf('brg13_pdf')
      expect(decision).toMatchObject({ objectKind: 'path', action: 'write', effect: 'deny' })
      expect(decision.winning.startsWith('protect-system#')).toBe(true)
    }, 120_000)

    it('BRP-4 不认识的纸张：过门之前就报错，列出能用的尺寸，一张卡都没有', async () => {
      const abs = join(projDir, 'out', 'b7.pdf')
      const ends = await noAsk([
        {
          id: 'brp4_pdf',
          tool: 'pdf',
          args: { tabId: formTab, outputPath: 'out/b7.pdf', pageSize: 'B7' }
        }
      ])
      expect(ends.brp4_pdf.result).toBe(
        '[MCP Error] "pageSize" must be one of A0, A1, A2, A3, A4, A5, A6, Legal, Letter, Tabloid, Ledger.'
      )
      expect(existsSync(abs)).toBe(false)
      expect(decisionsOf('brp4_pdf')).toEqual([])
    }, 120_000)

    it('BRG-14 会话开了免询问：工作区里直接写；凭据目录照旧拒绝', async () => {
      const inside = join(projDir, 'out', 'auto.pdf')
      const cred = join(app.home, '.ssh', 'x.pdf')
      await setAutoAllow(true)
      try {
        const ends = await noAsk([
          { id: 'brg14_in', tool: 'pdf', args: { tabId: formTab, outputPath: 'out/auto.pdf' } },
          { id: 'brg14_cred', tool: 'pdf', args: { tabId: formTab, outputPath: cred } }
        ])
        expect(readFileSync(inside).subarray(0, 5).toString()).toBe('%PDF-')
        expect(ends.brg14_cred.result).toContain(
          "Denied by security policy rule 'protect-credentials#"
        )
        expect(existsSync(cred)).toBe(false)
      } finally {
        await setAutoAllow(false)
      }
    }, 120_000)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// L1 全工具门：可信的 annotations
// ═══════════════════════════════════════════════════════════════════════

describe('工具 annotations 进得了策略（L1 全工具门）', () => {
  const POLICY = 'br-e2e-destructive'

  afterAll(async () => {
    await deletePolicy(POLICY)
  })

  it('BRG-16 「浏览器里有破坏性的动作要问」：打开与快照不问，点击问；拒了连 server 都没到', async () => {
    const created = await createPolicy(
      [
        '---',
        'shuvix: policy v1',
        `name: ${POLICY}`,
        'description: e2e ask before destructive built-in browser actions',
        'shuvix-policy-scope:',
        '  subject.kind: [agent]',
        '  object.type: [invocation]',
        'shuvix-policy-rules:',
        '  - effect: ask',
        "    match: has(object.mcpServer) && object.mcpServer == 'browser' && object.mcpTrusted && object.destructive",
        '---',
        'e2e policy body'
      ].join('\n')
    )
    expect(created.success, created.error).toBe(true)

    const opened = await noAsk([
      { id: 'brg16_open', tool: 'open_tab', args: { url: fixture.url('/form.html') } }
    ])
    const tab = tabIdOf(opened.brg16_open.result)
    const snap = await noAsk([{ id: 'brg16_snap', tool: 'snapshot', args: { tabId: tab } }])
    const submit = uidOf(snap.brg16_snap.result, 'button', 'Submit')

    const submitsBefore = fixture.hits('/submit')
    const { end, ask } = await askOnce(
      { id: 'brg16_click', tool: 'click', args: { tabId: tab, uid: submit } },
      false
    )
    expect(ask.toolName).toBe(browserTool('click'))
    expect(ask.command).toBe(browserTool('click'))
    // 宿主的包装层在 server 之前就挡下了：真正的工具错误，不带 [MCP Error] 前缀
    expect(end.isError).toBe(true)
    expect(end.result).toBe(`User denied ${browserTool('click')}`)
    expect(fixture.hits('/submit')).toBe(submitsBefore)
  }, 120_000)

  it('BRG-16b 第三方 server 自称只读不算数：它的工具照样问；内置浏览器的只读工具不问', async () => {
    const LIAR = 'e2e-liar'
    const UNTRUSTED = 'br-e2e-untrusted'
    const liar = await startLiarMcpServer()
    let liarId = ''
    try {
      const added = await app.main.eval<{ success: boolean; id: string }>(
        `window.api.mcp.add(${JSON.stringify({ name: LIAR, type: 'http', url: `http://127.0.0.1:${liar.port}/mcp` })})`
      )
      expect(added.success).toBe(true)
      liarId = added.id
      // 规范要求把不可信 server 的 annotations 当作不可信：宿主干脆不把它们放进客体，
      // 于是只有 fail-safe 的写法 ——「除非被可信 server 证明只读，否则就问」—— 写得出来
      const created = await createPolicy(
        [
          '---',
          'shuvix: policy v1',
          `name: ${UNTRUSTED}`,
          'description: e2e ask unless a trusted server proves the tool read-only',
          'shuvix-policy-scope:',
          '  subject.kind: [agent]',
          '  object.type: [invocation]',
          'shuvix-policy-rules:',
          '  - effect: ask',
          '    match: has(object.mcpServer) && !(object.mcpTrusted && object.readOnly)',
          '---',
          'e2e policy body'
        ].join('\n')
      )
      expect(created.success, created.error).toBe(true)

      const other = await app.main.eval<string>(
        `window.api.session.create(${JSON.stringify({ title: 'BRG-16b' })}).then((s) => s.id)`
      )
      await app.main.eval(
        `window.api.session.updateEnabledTools(${JSON.stringify({ id: other, enabledTools: ['mcp:browser', `mcp:${LIAR}`] })})`
      )
      const info = await app.main.eval<{ tools: Array<{ name: string }> }>(
        `window.api.agent.getInfo(${JSON.stringify(other)}, { ensure: true })`
      )
      expect(info.tools.map((t) => t.name)).toContain(`mcp__${LIAR}__peek`)

      // 内置浏览器的 list_tabs：可信且只读 → 不问
      provider.reset()
      const trusted = await driver.run(other, [{ id: 'brg16b_list', tool: 'list_tabs', args: {} }])
      expect(trusted.ends.brg16b_list.isError).toBe(false)
      expect(await driver.eventsSince(trusted.since, 'input_request', other)).toEqual([])

      // 第三方的 peek 自称只读：那句话不进客体 → 问；拒了连它的 server 都没被调到
      provider.reset()
      const since = await driver.start(other, [
        { id: 'brg16b_peek', tool: `mcp__${LIAR}__peek`, args: {} }
      ])
      const ask = await driver.waitAsk(other, since)
      expect(ask.command).toBe(`mcp__${LIAR}__peek`)
      await driver.answer(other, ask.id, false)
      const { ends } = await driver.finish(other, since)
      expect(ends.brg16b_peek.isError).toBe(true)
      expect(ends.brg16b_peek.result).toBe(`User denied mcp__${LIAR}__peek`)
      expect(liar.toolCalls()).toBe(0)
    } finally {
      await deletePolicy(UNTRUSTED)
      if (liarId) await app.main.eval(`window.api.mcp.delete(${JSON.stringify(liarId)})`)
      await liar.close()
    }
  }, 120_000)
})

/**
 * 一台「说谎」的第三方 MCP server：唯一的工具 peek 在 annotations 里自称只读。记下被调用的次数
 * （无状态 Streamable HTTP：每个请求一套 Server/Transport —— 写法同 sessions/mcp-lazy-connect）。
 */
async function startLiarMcpServer(): Promise<{
  port: number
  toolCalls(): number
  close(): Promise<void>
}> {
  let calls = 0
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      let body: unknown
      try {
        body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined
      } catch {
        body = undefined
      }
      const mcp = new McpSdkServer(
        { name: 'e2e-liar', version: '1.0.0' },
        { capabilities: { tools: {} } }
      )
      mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
          {
            name: 'peek',
            description: 'Claims to only look.',
            inputSchema: { type: 'object' as const, properties: {} },
            annotations: {
              readOnlyHint: true,
              destructiveHint: false,
              idempotentHint: true,
              openWorldHint: false
            }
          }
        ]
      }))
      mcp.setRequestHandler(CallToolRequestSchema, async () => {
        calls++
        return { content: [{ type: 'text' as const, text: 'peeked' }] }
      })
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      res.on('close', () => {
        void transport.close()
        void mcp.close()
      })
      void mcp
        .connect(transport)
        .then(() => transport.handleRequest(req as IncomingMessage, res, body))
        .catch(() => {
          if (!res.headersSent) {
            res.statusCode = 500
            res.end()
          }
        })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    port,
    toolCalls: () => calls,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}

// ═══════════════════════════════════════════════════════════════════════
// url 客体：用户自己写的策略
// ═══════════════════════════════════════════════════════════════════════

describe('http(s) 地址上报 url 客体（出厂没有 url 策略）', () => {
  const ASK = 'br-e2e-ask-me'
  const DENY = 'br-e2e-deny'

  const urlPolicy = (name: string, effect: 'ask' | 'deny', needle: string): string =>
    [
      '---',
      'shuvix: policy v1',
      `name: ${name}`,
      `description: e2e ${effect} on ${needle}`,
      'shuvix-policy-scope:',
      '  subject.kind: [agent]',
      '  object.type: [url]',
      'shuvix-policy-rules:',
      `  - effect: ${effect}`,
      '    action: [navigate]',
      `    match: object.host == '127.0.0.1' && object.url.contains('${needle}')`,
      '---',
      'e2e policy body'
    ].join('\n')

  afterAll(async () => {
    await deletePolicy(ASK)
    await deletePolicy(DENY)
  })

  it('BRG-15 用户的 ask：卡片命令是地址、标题是浏览器；拒了服务器一次都没被请求。deny：不问就拒，cdp 也一样', async () => {
    expect((await createPolicy(urlPolicy(ASK, 'ask', '/ask-me'))).success).toBe(true)
    expect((await createPolicy(urlPolicy(DENY, 'deny', '/deny'))).success).toBe(true)

    const askUrl = fixture.url('/ask-me.html')
    provider.reset()
    const since = await driver.start(sid, [
      { id: 'brg15_ask', tool: 'open_tab', args: { url: askUrl } }
    ])
    const ask = await driver.waitAsk(sid, since)
    expect(ask.command).toBe(askUrl)
    // 非路径类的卡片：标题是工具自己的显示名 + 图标（内置 MCP 工具走兜底呈现）
    const card = await until(() => chat.pendingAskShot(), 'url ask card on screen')
    expect(BROWSER_LABELS).toContain(card.title)
    expect(card.icon).toBe('lucide-globe')
    expect(card.preview).toBe(askUrl)
    await driver.answer(sid, ask.id, false)
    const asked = await driver.finish(sid, since)
    expect(asked.ends.brg15_ask.result).toBe(`[MCP Error] User denied opening ${askUrl}`)
    expect(fixture.hits('/ask-me.html')).toBe(0)

    const denyUrl = fixture.url('/deny.html')
    const opened = await noAsk([{ id: 'brg15_deny', tool: 'open_tab', args: { url: denyUrl } }])
    expect(opened.brg15_deny.result).toContain(`Denied by security policy rule '${DENY}#0'`)

    // 原生 cdp 的 Page.navigate 是同一道门：逃生口不是旁路（在上传段那个表单页上试）
    const viaCdp = await noAsk([
      {
        id: 'brg15_cdp',
        tool: 'cdp',
        args: { tabId: formTab, method: 'Page.navigate', params: { url: denyUrl } }
      },
      { id: 'brg15_where', tool: 'evaluate', args: { tabId: formTab, expression: 'location.href' } }
    ])
    expect(viaCdp.brg15_cdp.result).toContain(`Denied by security policy rule '${DENY}#0'`)
    expect(fixture.hits('/deny.html')).toBe(0)
    expect(viaCdp.brg15_where.result).toBe(JSON.stringify(fixture.url('/form.html')))
  }, 120_000)
})

// ═══════════════════════════════════════════════════════════════════════
// 收尾
// ═══════════════════════════════════════════════════════════════════════

describe('名字与开关', () => {
  it('BRP-3 server 名不能带 __：冒充内置浏览器的自定义 server 建不出来', async () => {
    const res = await app.main.eval<{ success: boolean; error?: string }>(
      `window.api.mcp.add(${JSON.stringify({
        name: 'browser__spoof',
        type: 'http',
        url: 'http://127.0.0.1:9/mcp'
      })})`
    )
    expect(res.success).toBe(false)
    expect(res.error).toContain('cannot contain "__"')
    const names = (await app.main.eval<Array<{ name: string }>>(`window.api.mcp.list()`)).map(
      (r) => r.name
    )
    expect(names).not.toContain('browser__spoof')
  }, 120_000)

  it('BRP-5 停用再启用：新会话拿回全部工具；跨过开关的旧运行时报「没连上」，不露内部连接键', async () => {
    // 这条会话的运行时是在开关之前建的
    const before = await noAsk([{ id: 'brp5_warm', tool: 'list_tabs', args: {} }])
    expect(before.brp5_warm.isError).toBe(false)

    for (const isEnabled of [false, true]) {
      await app.main.eval(`window.api.mcp.update(${JSON.stringify({ id: BROWSER_ID, isEnabled })})`)
    }

    const fresh = await app.main.eval<string>(
      `window.api.session.create(${JSON.stringify({ title: 'BRP-5 fresh' })}).then((s) => s.id)`
    )
    await app.main.eval(
      `window.api.session.updateEnabledTools(${JSON.stringify({ id: fresh, enabledTools: ['mcp:browser'] })})`
    )
    const info = await app.main.eval<{ tools: Array<{ name: string }> }>(
      `window.api.agent.getInfo(${JSON.stringify(fresh)}, { ensure: true })`
    )
    expect(
      info.tools
        .map((t) => t.name)
        .filter((n) => n.startsWith('mcp__browser__'))
        .sort()
    ).toEqual(ALL_BROWSER_TOOLS)

    const stale = await noAsk([{ id: 'brp5_stale', tool: 'list_tabs', args: {} }])
    const text = stale.brp5_stale.result
    expect(text).toContain('MCP server "browser" is not connected')
    expect(text).not.toContain(`${BROWSER_ID}#`)
    // MCP 的失败是抛出的（pi 记成失败）—— 行是出错的，而不是「完成」
    expect(stale.brp5_stale.isError).toBe(true)
  }, 120_000)
})
