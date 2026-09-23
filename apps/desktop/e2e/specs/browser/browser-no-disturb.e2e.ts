/**
 * agent 在后台 tab 里的活动绝不弹出原生 OS 界面 —— 文件选择框、打印框、下拉菜单（假提供商脚本化；
 * 夹具网站记下每一个请求）。整条 spec 一个实例，浏览器窗口**从不打开**（用户没在看它）：
 *
 *   NG-E1 文件输入框：先对一个没人听的端口 open_tab（失败，带 net::ERR_CONNECTION_REFUSED 与 tab 号）；
 *         再开 /upload.html，点单选 / 多选文件输入框 —— 回报里各带一句「one file / multiple files」的提示
 *         叫 agent 改用 upload_file；页面收到两次 click、零个文件、零次 change；upload_file 照常放进一个
 *         工作区文件；防护从没装失败过；
 *   NG-E2 页面在 agent 点击之后 1.5 秒**自己**打开文件框（宽限期里）：点击的回报里没有提示，主进程日志多
 *         一行「suppressed」，页面没收到文件；
 *   NG-E3 页面解析期就调 window.print()（主文档与它的 iframe 各一次）：open_tab 照常成功，两边看到的
 *         print 都已不是原生的、都调了，日志多两行「dropped」；agent 的 evaluate 再调一次 → 再多一行；
 *   NG-E5 agent 点 target=_blank 打开一个一加载就打印的「打印版」弹出页：弹出页看到的 print 已经换掉
 *         （报给服务器 native=false），日志多一行「dropped」，弹出页作为新 tab 列在 list_tabs 里；
 *   NG-E4 焦点在单选 <select> 上（本文档 / open shadow root / 同源 iframe）时 press_key ArrowDown 被拒、
 *         指向 fill，页面一个键都没收到、值没变；Tab 照常；多选 <select> 上的 ArrowDown 照常；type 带
 *         submitKey ArrowDown 同样被拒、一个字都没打；fill 按选项名选中照常。
 *
 * **保险**（这些页面会去碰原生界面，产品的防护万一回归，用例只能变红、不能在开发者屏幕上弹东西）：
 *   - 点文件输入框之前，spec 在那个 tab 上另开一条 DevTools 会话、打开它自己的文件框拦截
 *     （`interceptFileChoosers`）—— 两条会话都拦截时两边都收到事件、产品的判断照常，只剩这条时文件框
 *     同样不弹（2026-09-23 草稿探针实测）；它收到的事件也是「文件框真的打开了」的旁证；
 *   - 会打印的页面先检查 print 还是不是原生的，是原生的就不调（改标题 / 报 native=true），见 browserFixtures；
 *   - bootstrap.cjs 把主进程的 dialog.showOpenDialog 换成回「取消」并记账的桩，spec 断账本是空的。
 * 每一段开头与结尾都断：浏览器窗口没开、连 target 都没有；没有任何原生「打开文件」框请求。
 * 会话给显式标题（缺省标题会让自动起标题的 hook 抢走脚本里的轮次）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sleep, until } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import { startFakeProvider, type FakeProvider } from '../../harness/fakeProvider'
import {
  createProject,
  eventRecorder,
  seedFakeProvider,
  waitRendererReady,
  type EventRecorder
} from '../../harness/seed'
import { chatPane, sidebarPane } from '../../harness/pages'
import {
  browserDriver,
  closedPort,
  interceptFileChoosers,
  startFixtureServer,
  tabIdOf,
  type BrowserDriver,
  type FileChooserNet,
  type FixtureServer,
  type ScriptedCall,
  type ToolEndEvent
} from '../../harness/browserFixtures'

const MODEL = 'e2e-model'
const TITLE = 'NG no disturb'
const UPLOAD_MARK = 'NG-UPLOAD-CONTENT'

/** 主进程日志里的几行（agentGuards.ts） */
const SUPPRESSED = 'file chooser opened while the browser window is not in front: suppressed'
const DROPPED = 'window.print() while the browser window is not in front: dropped'
const INSTALL_FAILED = 'installing agent guards on tab'
const PRINT_FAILED = 'print failed'

/** 工具回报里的提示（agentGuards.fileChooserNote；注意 user’s 是 U+2019） */
const NOTE_ONE =
  "Note: this opened the page's file chooser (one file). ShuviX suppressed the native file dialog so it cannot pop up on the user’s screen. To attach files, call upload_file on the file input (take a snapshot to find its uid)."
const NOTE_MANY =
  "Note: this opened the page's file chooser (multiple files). ShuviX suppressed the native file dialog so it cannot pop up on the user’s screen. To attach files, call upload_file on the file input (take a snapshot to find its uid)."
/** press_key / type 在 <select> 上被拒时指向 fill（cdpOps.refuseKeyOnSelect） */
const SELECT_REFUSAL = (combo: string): string =>
  `Focus is on a <select>, and pressing ${combo} there would open its native dropdown. Choose an option with fill(uid, "<option label or value>") instead (Tab / Escape are still fine).`

interface TabRow {
  id: string
  url: string
}

let app: E2EApp
let provider: FakeProvider
let events: EventRecorder
let fixture: FixtureServer
let driver: BrowserDriver
let sid = ''
let projDir = ''
/** /upload.html 那个 tab 上的保险（NG-E1 装上，一直开到 afterAll） */
let net: FileChooserNet | null = null
let uploadTab = ''

// ─── 助手 ───

const isWindowOpen = (): Promise<boolean> =>
  app.main.eval<boolean>('window.api.browserView.isWindowOpen()')
const listTabs = (): Promise<TabRow[]> =>
  app.main.eval<TabRow[]>('window.api.browserView.listTabs()')
const countInLog = (needle: string): number => app.mainLog().split(needle).length - 1

/** bootstrap.cjs 的 dialog.showOpenDialog 桩记下的请求（每行一个） */
const nativeDialogRequests = (): string[] => {
  const file = join(app.home, 'userdata', 'e2e-native-dialogs.log')
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []
}

/** 浏览器窗口没开、连 target 都没有；没有任何原生「打开文件」框请求 */
const expectUndisturbed = async (when: string): Promise<void> => {
  expect(await isWindowOpen(), `${when}: browser window open`).toBe(false)
  const bw = await app.browserWindow()
  bw?.close()
  expect(bw, `${when}: #browser-window target exists`).toBeNull()
  expect(nativeDialogRequests(), `${when}: native open-file dialog requested`).toEqual([])
}

/** 一次不该有询问的运行：跑完，断言确实没有卡 */
const run = async (
  calls: Array<ScriptedCall | ScriptedCall[]>
): Promise<Record<string, ToolEndEvent>> => {
  provider.reset()
  const { ends, since } = await driver.run(sid, calls)
  expect(await driver.eventsSince(since, 'input_request', sid)).toEqual([])
  return ends
}

/** 这次调用的结果（没有就判红，带上已有的调用 id） */
const endOf = (ends: Record<string, ToolEndEvent>, id: string): ToolEndEvent => {
  const end = ends[id]
  expect(end, `${id} (have: ${Object.keys(ends).join(', ')})`).toBeDefined()
  return end
}

/** 成功的一次调用 */
const ok = (ends: Record<string, ToolEndEvent>, id: string): ToolEndEvent => {
  const end = endOf(ends, id)
  expect(end.isError, `${id}: ${end.result}`).toBe(false)
  return end
}

/** evaluate 的结果（JSON.stringify(value, null, 2)）还原成值 */
const valueOf = (ends: Record<string, ToolEndEvent>, id: string): unknown =>
  JSON.parse(ok(ends, id).result)

/** 快照里某个可访问名字的元素 uid（角色不限，`"<name>"` 精确匹配） */
const uidNamed = (snapshot: string, name: string): string => {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = new RegExp(`uid=(\\w+)(?: [\\w-]+)? "${escaped}"`).exec(snapshot)
  if (!m) throw new Error(`no element named "${name}" in snapshot:\n${snapshot}`)
  return m[1]
}

const evaluate = (id: string, tabId: string, expression: string): ScriptedCall => ({
  id,
  tool: 'evaluate',
  args: { tabId, expression }
})

beforeAll(async () => {
  app = await launchApp()
  provider = await startFakeProvider()
  await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  await waitRendererReady(app.main)
  events = eventRecorder(app.main)
  await events.install()
  fixture = await startFixtureServer()
  driver = browserDriver({ main: app.main, provider, events })

  projDir = join(app.home, 'no-disturb-proj')
  mkdirSync(join(projDir, 'fixtures'), { recursive: true })
  writeFileSync(join(projDir, 'fixtures', 'up.txt'), UPLOAD_MARK)
  const projectId = (await createProject(app.main, { name: 'NG-Proj', path: projDir })).id
  sid = await app.main.eval<string>(
    `window.api.session.create(${JSON.stringify({ title: TITLE, projectId })}).then((s) => s.id)`
  )
  const wrote = await app.main.eval<{ success: boolean }>(
    `window.api.session.updateEnabledTools(${JSON.stringify({ id: sid, enabledTools: ['mcp:browser'] })})`
  )
  expect(wrote.success).toBe(true)
  // 会话开在主窗界面上 —— 用户就在这里打字，什么都不该冒出来
  const sidebar = sidebarPane(app.main)
  await until(async () => (await sidebar.titles()).includes(TITLE), `sidebar row "${TITLE}"`)
  expect(await sidebar.openSession(TITLE)).toBe(true)
  await chatPane(app.main).ready()
}, 120_000)

afterAll(async () => {
  net?.close()
  await provider?.close()
  await fixture?.close()
  await app?.stop()
})

describe('文件选择框：agent 的动作打开的一律拦下，提示改用 upload_file（NG-E1 / NG-E2）', () => {
  it('NG-E1 连不上的地址 → 失败带原因与 tab 号；点单选 / 多选文件输入框 → 回报各带提示，页面零文件零 change；upload_file 照常', async () => {
    await expectUndisturbed('fresh instance')

    // ── 0. 连接被拒：失败，带原因与 tab 号（那个 tab 显示浏览器的错误页） ──
    const dead = `http://127.0.0.1:${await closedPort()}/`
    const e0 = await run([{ id: 'ng1_dead', tool: 'open_tab', args: { url: dead } }])
    expect(endOf(e0, 'ng1_dead').isError).toBe(true)
    expect(e0.ng1_dead.result).toContain(
      `${dead} failed to load (net::ERR_CONNECTION_REFUSED) — tab t`
    )

    // ── 1. 上传页；点文件输入框之前先装保险 ──
    const url = fixture.url('/upload.html')
    const opened = await run([{ id: 'ng1_open', tool: 'open_tab', args: { url } }])
    uploadTab = tabIdOf(ok(opened, 'ng1_open').result)
    net = await interceptFileChoosers(app.port, (u) => u === url)
    const snap = await run([{ id: 'ng1_snap', tool: 'snapshot', args: { tabId: uploadTab } }])
    const single = uidNamed(ok(snap, 'ng1_snap').result, 'Attachment')
    const multi = uidNamed(snap.ng1_snap.result, 'Attachments')

    const clicks = await run([
      { id: 'ng1_click_one', tool: 'click', args: { tabId: uploadTab, uid: single } },
      { id: 'ng1_click_many', tool: 'click', args: { tabId: uploadTab, uid: multi } },
      evaluate(
        'ng1_state',
        uploadTab,
        "({ clicks: window.__clicks, files: document.getElementById('f').files.length + document.getElementById('fm').files.length, changes: window.__changes })"
      )
    ])
    expect(ok(clicks, 'ng1_click_one').result).toContain(`\n${NOTE_ONE}`)
    expect(clicks.ng1_click_one.result).not.toContain('(multiple files)')
    expect(ok(clicks, 'ng1_click_many').result).toContain(`\n${NOTE_MANY}`)
    expect(valueOf(clicks, 'ng1_state')).toEqual({ clicks: 2, files: 0, changes: 0 })
    // 文件框真的打开过（保险那条会话也收到了），而产品把两次都拦下、记进了回报
    expect(net.opened()).toEqual(['selectSingle', 'selectMultiple'])
    expect(countInLog(SUPPRESSED)).toBe(0)

    // ── 2. 该走的路：upload_file 放进一个工作区里的文件 ──
    const up = await run([
      {
        id: 'ng1_upload',
        tool: 'upload_file',
        args: { tabId: uploadTab, uid: single, paths: ['fixtures/up.txt'] }
      },
      evaluate(
        'ng1_file',
        uploadTab,
        "(async () => { const f = document.getElementById('f').files[0]; return { count: document.getElementById('f').files.length, name: f.name, text: await f.text() } })()"
      )
    ])
    ok(up, 'ng1_upload')
    expect(valueOf(up, 'ng1_file')).toEqual({ count: 1, name: 'up.txt', text: UPLOAD_MARK })

    expect(countInLog(INSTALL_FAILED)).toBe(0)
    await expectUndisturbed('end of NG-E1')
  }, 120_000)

  it('NG-E2 页面在点击之后 1.5 秒自己打开文件框（宽限期里）：回报里没有提示；日志多一行 suppressed；页面没收到文件', async () => {
    expect(uploadTab, 'NG-E1 opened the upload tab').not.toBe('')
    expect(net, 'NG-E1 installed the safety net').not.toBeNull()
    // 全量快照：同一个 tab 上一次快照之后的这一张缺省是差异，只列变了的元素
    const snap = await run([
      { id: 'ng2_snap', tool: 'snapshot', args: { tabId: uploadTab, full: true } }
    ])
    const later = uidNamed(ok(snap, 'ng2_snap').result, 'Attach later')
    const before = await run([
      evaluate(
        'ng2_before',
        uploadTab,
        "({ clicks: window.__clicks, changes: window.__changes, files: document.getElementById('f').files.length })"
      )
    ])
    const was = valueOf(before, 'ng2_before') as { clicks: number; changes: number; files: number }
    const suppressedBefore = countInLog(SUPPRESSED)
    const netBefore = net!.opened().length

    const clicked = await run([
      { id: 'ng2_click', tool: 'click', args: { tabId: uploadTab, uid: later } }
    ])
    expect(ok(clicked, 'ng2_click').result).not.toContain('Note:')

    // 1.5 秒后页面自己点 #f：宽限期里、用户没在看 → 拦下丢弃，只留一行日志
    await until(
      () => countInLog(SUPPRESSED) >= suppressedBefore + 1,
      'the late file chooser logged as suppressed',
      15_000
    )
    await sleep(500)
    expect(countInLog(SUPPRESSED)).toBe(suppressedBefore + 1)
    expect(net!.opened().length).toBe(netBefore + 1)

    // 等日志出现之后再读页面（读页面的 evaluate 自己也是一次受防护的动作）
    const after = await run([
      evaluate(
        'ng2_after',
        uploadTab,
        "({ clicks: window.__clicks, changes: window.__changes, files: document.getElementById('f').files.length })"
      )
    ])
    expect(valueOf(after, 'ng2_after')).toEqual({
      clicks: was.clicks + 1,
      changes: was.changes,
      files: was.files
    })
    await expectUndisturbed('end of NG-E2')
  }, 120_000)
})

describe('打印：页面的 window.print() 在后台一律丢弃（NG-E3 / NG-E5）', () => {
  it('NG-E3 解析期就打印的页面（主文档 + iframe）：open_tab 成功，两边的 print 都已换掉，日志多两行 dropped；evaluate 再调一次 → 再多一行', async () => {
    const before = countInLog(DROPPED)
    const opened = await run([
      { id: 'ng3_open', tool: 'open_tab', args: { url: fixture.url('/print.html') } }
    ])
    const tab = tabIdOf(ok(opened, 'ng3_open').result)
    await until(() => countInLog(DROPPED) >= before + 2, 'two dropped print lines', 15_000)

    const st = await run([
      evaluate(
        'ng3_state',
        tab,
        '({ title: document.title, native: window.__native, printed: window.__printed === true, child: window.__child === undefined ? null : window.__child, source: String(window.print) })'
      )
    ])
    const v = valueOf(st, 'ng3_state') as {
      title: string
      native: boolean
      printed: boolean
      child: string | null
      source: string
    }
    expect(v.title).toBe('E2E Print')
    expect(v.native).toBe(false)
    expect(v.printed).toBe(true)
    expect(v.child).toBe('override')
    expect(v.source).not.toContain('[native code]')
    expect(v.source).toContain('globalThis[name]')
    expect(countInLog(DROPPED)).toBe(before + 2)

    const ev = await run([
      evaluate(
        'ng3_eval_print',
        tab,
        "(() => { if (Function.prototype.toString.call(window.print).includes('[native code]')) return 'NATIVE'; window.print(); return 'called' })()"
      )
    ])
    expect(valueOf(ev, 'ng3_eval_print')).toBe('called')
    await until(() => countInLog(DROPPED) >= before + 3, 'third dropped print line', 15_000)
    await sleep(300)
    expect(countInLog(DROPPED)).toBe(before + 3)
    expect(countInLog(PRINT_FAILED)).toBe(0)
    await expectUndisturbed('end of NG-E3')
  }, 120_000)

  it('NG-E5 agent 点 target=_blank 打开一加载就打印的弹出页：弹出页的 print 已换掉（native=false），日志多一行 dropped，弹出页是新 tab', async () => {
    const before = countInLog(DROPPED)
    const reportsBefore = fixture.hits('/report')
    const opened = await run([
      { id: 'ng5_open', tool: 'open_tab', args: { url: fixture.url('/opener.html') } }
    ])
    const tab = tabIdOf(ok(opened, 'ng5_open').result)
    const snap = await run([{ id: 'ng5_snap', tool: 'snapshot', args: { tabId: tab } }])
    const link = uidNamed(ok(snap, 'ng5_snap').result, 'Open print version')

    const clicked = await run([{ id: 'ng5_click', tool: 'click', args: { tabId: tab, uid: link } }])
    ok(clicked, 'ng5_click')

    await until(() => fixture.hits('/report') >= reportsBefore + 1, 'the popup reported', 15_000)
    const reports = fixture
      .requests()
      .filter((r) => r.path.startsWith('/report'))
      .slice(reportsBefore)
      .map((r) => r.path)
    expect(reports).toEqual(['/report?native=false'])
    await until(() => countInLog(DROPPED) >= before + 1, 'popup print dropped', 15_000)
    await sleep(300)
    expect(countInLog(DROPPED)).toBe(before + 1)

    const popupUrl = fixture.url('/autoprint.html')
    expect((await listTabs()).some((t) => t.url === popupUrl)).toBe(true)
    const listed = await run([{ id: 'ng5_list', tool: 'list_tabs', args: {} }])
    expect(ok(listed, 'ng5_list').result).toContain(popupUrl)
    await expectUndisturbed('end of NG-E5')
  }, 120_000)
})

describe('下拉菜单：焦点在单选 <select> 上时不按会弹出原生菜单的键（NG-E4）', () => {
  it('NG-E4 本文档 / shadow root / iframe 里的单选 <select> 上 ArrowDown 被拒、一个键都没到；Tab 照常；多选上 ArrowDown 照常；type 的 submitKey 同样被拒；fill 照常', async () => {
    const opened = await run([
      { id: 'ng4_open', tool: 'open_tab', args: { url: fixture.url('/select.html') } }
    ])
    const tab = tabIdOf(ok(opened, 'ng4_open').result)
    const snap = await run([{ id: 'ng4_snap', tool: 'snapshot', args: { tabId: tab } }])
    const fruit = uidNamed(ok(snap, 'ng4_snap').result, 'Fruit')

    /** 清空按键记录、把焦点放到某处，回「父文档焦点 > 内层焦点」 */
    const focus = (id: string, how: string): ScriptedCall =>
      evaluate(
        id,
        tab,
        `(() => { window.__keys.length = 0; ${how}; const host = document.getElementById('host').shadowRoot; const fr = document.getElementById('fr').contentDocument; const a = document.activeElement; const inner = a && a.id === 'host' ? host.activeElement : a && a.id === 'fr' ? fr.activeElement : null; return (a ? a.id : '') + (inner ? '>' + inner.id : '') })()`
      )
    const state = (id: string, value: string): ScriptedCall =>
      evaluate(id, tab, `({ keys: window.__keys.slice(), value: ${value} })`)
    const press = (id: string, key: string): ScriptedCall => ({
      id,
      tool: 'press_key',
      args: { tabId: tab, key }
    })
    const S = "document.getElementById('s').value"
    const SS = "document.getElementById('host').shadowRoot.getElementById('ss').value"
    const IS = "document.getElementById('fr').contentDocument.getElementById('is').value"
    const M =
      "Array.from(document.getElementById('m').selectedOptions).map((o) => o.value).join(',')"

    /**
     * 先把焦点放好并**核对**（不对就在按键之前判红 —— 焦点若不在我们以为的地方，按下去的键可能
     * 落到一个探针没认出来的 <select> 上），再跑后面的调用
     */
    const focusThen = async (
      label: string,
      how: string,
      expected: string,
      then: ScriptedCall[]
    ): Promise<Record<string, ToolEndEvent>> => {
      const f = await run([focus(`${label}_focus`, how)])
      expect(valueOf(f, `${label}_focus`), `${label}: focus`).toBe(expected)
      return run(then)
    }

    // 本文档 / open shadow root / 同源 iframe 里的单选：ArrowDown 被拒，一个键都没到，值没变
    const refusedCases: Array<[string, string, string, string, string]> = [
      ['s', "document.getElementById('s').focus()", 's', S, 'a'],
      [
        'ss',
        "document.getElementById('host').shadowRoot.getElementById('ss').focus()",
        'host>ss',
        SS,
        'p'
      ],
      [
        'is',
        "document.getElementById('fr').contentDocument.getElementById('is').focus()",
        'fr>is',
        IS,
        'x'
      ]
    ]
    for (const [label, how, expected, value, unchanged] of refusedCases) {
      const ends = await focusThen(label, how, expected, [
        press(`${label}_press`, 'ArrowDown'),
        state(`${label}_state`, value)
      ])
      const end = endOf(ends, `${label}_press`)
      expect(end.isError, `${label}: ${end.result}`).toBe(true)
      expect(end.result).toContain(SELECT_REFUSAL('ArrowDown'))
      expect(valueOf(ends, `${label}_state`), label).toEqual({ keys: [], value: unchanged })
    }

    // Tab 只挪焦点：照常
    const tabbed = await focusThen('tab', "document.getElementById('s').focus()", 's', [
      press('tab_press', 'Tab'),
      state('tab_state', S)
    ])
    expect(ok(tabbed, 'tab_press').result).toContain('Pressed Tab.')
    expect(valueOf(tabbed, 'tab_state')).toEqual({ keys: ['Tab'], value: 'a' })

    // 多选 <select> 不弹菜单：照常
    const multi = await focusThen('m', "document.getElementById('m').focus()", 'm', [
      press('m_press', 'ArrowDown'),
      state('m_state', M)
    ])
    expect(ok(multi, 'm_press').result).toContain('Pressed ArrowDown.')
    expect((valueOf(multi, 'm_state') as { keys: string[] }).keys).toEqual(['ArrowDown'])

    // type 的提交键同样被拒，一个字都不打
    const typedRun = await focusThen('type', "document.getElementById('s').focus()", 's', [
      { id: 'type_s', tool: 'type', args: { tabId: tab, text: 'M', submitKey: 'ArrowDown' } },
      state('type_state', S)
    ])
    const typed = endOf(typedRun, 'type_s')
    expect(typed.isError, typed.result).toBe(true)
    expect(typed.result).toContain(SELECT_REFUSAL('ArrowDown'))
    expect(valueOf(typedRun, 'type_state')).toEqual({ keys: [], value: 'a' })

    // 该走的路：fill 按选项名选中
    const filled = await run([
      { id: 'fill_s', tool: 'fill', args: { tabId: tab, uid: fruit, text: 'Banana' } },
      state('fill_state', S)
    ])
    ok(filled, 'fill_s')
    expect((valueOf(filled, 'fill_state') as { value: string }).value).toBe('b')

    await expectUndisturbed('end of NG-E4')
  }, 120_000)

  it('NG-E 收尾：整条 spec 下来浏览器窗口从没出现，防护从没装失败，没有打印失败，没有原生「打开文件」框请求', async () => {
    await expectUndisturbed('end of spec')
    expect(countInLog(INSTALL_FAILED)).toBe(0)
    expect(countInLog(PRINT_FAILED)).toBe(0)
  })
})
