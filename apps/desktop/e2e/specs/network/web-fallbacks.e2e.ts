/**
 * 网络访问 phase D —— 浏览器里的 web 客户端拿不到桌面的那几样（自定义协议、只绑 127.0.0.1 的 widget 服务、原生
 * 对话框、Finder、开新窗口），网络服务与页面各补一半：
 *
 * WF-1 从外面打路由（widget 服务还没起）：/files/media、/files/preview、Range、/lib、/w/ 的 503，以及门与错误码
 * WF-2 聊天里的图片经 HTTP 渲染，点开是一个预览标签页（md 也在预览标签页里只读渲染）；服务端那台电脑上不开窗
 * WF-3 交互图里的 Chart.js / D3 经 /lib/ 加载（沙箱 CSP 放行的是这个地址，不是 shuvix-lib:）
 * WF-4 页面里的目录浏览器代替原生「选择文件夹」框（项目配置换文件夹、打开文件夹的取消、外部技能目录）
 * WF-5 widget 经 /w/ 转发，在新标签页里的沙箱 iframe 里跑
 * WF-6 widget 导出 = 主屏图标右键（页面里的 DOM 菜单，两种打开方式都在）→ 导到服务端的临时目录 + 经 /files/download 下载
 * WF-7「在文件管理器中打开 / 显示」换成显示路径的卡片，路径与桌面打开的是同一个
 * WF-8 web 客户端不跟桌面的悬浮窗：桌面悬浮了的会话在页面里照常显示；右侧面板也在
 * WF-9 web 客户端不认桌面的「在独立窗口打开」偏好：桌面记着偏好、窗口也开着，页面里点图标仍在页面的面板里打开、不开新标签页；
 *      ↗ 开一个 #widget-window 标签页；之后桌面的偏好不变（页面里的选择不往回记）
 *
 * 约定同 web-client.e2e.ts：界面语言先设成 en；**从不在缺省端口 7766 上打开**，一律先 setPort(空闲端口) 再
 * setEnabled(true)；会话只经主进程 IPC 带明确标题创建（不跑 titler，假提供商的 FIFO 干净）；HTTP 探测一律连
 * 127.0.0.1、只伪造 Host 头。页面里开新标签页（`window.open`）的调用都带用户手势（evalWithGesture）。
 * 浏览器里的下载会被应用取消（浏览器窗口不在前台），所以下载断的是页面点下去的那个链接与它的应答，不看磁盘。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import { connectTabPage } from '../../harness/browserFixtures'
import { connect, listTargets, sleep, until, type CdpClient } from '../../harness/cdp'
import { startFakeProvider, type FakeProvider } from '../../harness/fakeProvider'
import { freePort, launchApp, type E2EApp } from '../../harness/launch'
import {
  browserTabs,
  closeBrowserTab,
  evalWithGesture,
  httpProbe,
  httpStreamProbe,
  nativeDialogRequests,
  openWebClient,
  shellOpens,
  waitBrowserTab,
  type NetworkStatus,
  type WebClientHandle
} from '../../harness/networkFixtures'
import {
  chatPane,
  filePreviewWindowImages,
  filePreviewWindowShot,
  interactivePane,
  projectEditPane,
  rightPanelPane,
  sidebarPane,
  webClientPane,
  widgetHomePane
} from '../../harness/pages'
import {
  createProject,
  eventRecorder,
  seedFakeProvider,
  waitRendererReady,
  writePng,
  type EventRecorder
} from '../../harness/seed'

const DESKTOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const MODEL = 'e2e-model'
const USAGE = { prompt: 90, completion: 10 }
const WIDGET_ID = 'demo-widget'
/** widget 服务没在跑时网络服务的应答（widgetProxy.ts） */
const WIDGET_NOT_RUNNING = 'The ShuviX widget server is not running. Open the widget again.'
/** 转发的 widget 页面（HTML）带的沙箱 CSP —— 与 web 客户端给 widget iframe 的 sandbox 属性同一组放行 */
const WIDGET_DOCUMENT_CSP =
  'sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads'
const WEB_WIDGET_SANDBOX = 'allow-scripts allow-forms allow-popups allow-modals allow-downloads'
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const ZIP_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04])

/** message.list 的一条（只声明本文件读的字段） */
interface ListedMessage {
  id: string
  role: string
  content: string
}

/** 页面里一次调用的结局（拒绝时带 code / message） */
interface Settled {
  ok: boolean
  value?: unknown
  code?: string
  message?: string
}

/** 页面里记下的一次 `<a>.click()`（widget 导出的下载） */
interface AnchorClick {
  href: string
  download: string
  rel: string
}

let app: E2EApp
let provider: FakeProvider
let web: WebClientHandle | undefined
let webEvents: EventRecorder
let P = 0
let projDir = ''
let smallPng = ''
let smallSvg = ''
let docMd = ''
let pickRoot = ''
let pickStart = ''
let knowledgeEntryAbs = ''
const sids = { chat: '', interactive: '' }
/** 用例里开的浏览器 tab（失败时 afterAll 兜底关） */
const openedTabs = new Map<string, CdpClient | null>()

const webPage = (): CdpClient => web!.page

const setPort = (port: unknown): Promise<NetworkStatus> =>
  app.main.eval<NetworkStatus>(`window.api.network.setPort(${JSON.stringify(port)})`)

const setEnabled = (on: boolean): Promise<NetworkStatus> =>
  app.main.eval<NetworkStatus>(`window.api.network.setEnabled(${JSON.stringify(on)})`)

const listMessages = (sid: string): Promise<ListedMessage[]> =>
  app.main.eval<ListedMessage[]>(`window.api.message.list(${JSON.stringify(sid)})`)

const projectsInMain = (): Promise<Array<{ id: string; name: string; path: string }>> =>
  app.main.eval(
    `window.api.project.list().then((ps) => ps.map((p) => ({ id: p.id, name: p.name, path: p.path })))`
  )

/** 在 web 页面里调一次 `window.api.<expr>`，回它的结局 */
const settleInWeb = (expr: string): Promise<Settled> =>
  webPage().eval(
    `Promise.resolve().then(() => window.api.${expr}).then(
      (value) => ({ ok: true, value }),
      (e) => ({ ok: false, code: e?.code, message: e?.message })
    )`
  )

/** 同源相对地址的探测（Host 头 = 127.0.0.1:P，与页面自己发的一样） */
const probe = (
  path: string,
  extra: { host?: string; headers?: Record<string, string>; method?: string } = {}
): ReturnType<typeof httpProbe> =>
  httpProbe({
    port: P,
    path,
    host: extra.host ?? `127.0.0.1:${P}`,
    headers: extra.headers,
    method: extra.method
  })

/** 一个页面地址的 hash 里 `?` 之后的参数（`#file-preview?sessionId=…&path=…`） */
const hashParams = (url: string): URLSearchParams => {
  const hash = url.slice(url.indexOf('#') + 1)
  return new URLSearchParams(hash.slice(hash.indexOf('?') + 1))
}

/** 等 web 客户端开出的一个新标签页（按地址认）并连上它的页面 */
async function openedTab(
  match: (url: string) => boolean,
  what: string
): Promise<{ id: string; url: string; page: CdpClient }> {
  const tab = await waitBrowserTab(app, match, what)
  openedTabs.set(tab.id, null)
  const page = await until(
    () => connectTabPage(app.port, (u) => u === tab.url),
    `${what} (page target)`
  )
  openedTabs.set(tab.id, page)
  return { ...tab, page }
}

/** 关掉一个用例开的 tab（不抛） */
async function closeTab(id: string): Promise<void> {
  try {
    openedTabs.get(id)?.close()
  } catch {
    /* 已经关了 */
  }
  openedTabs.delete(id)
  await closeBrowserTab(app, id)
}

beforeAll(async () => {
  app = await launchApp()
  await app.main.eval(`window.api.settings.set({ key: 'general.language', value: 'en' })`)
  provider = await startFakeProvider()
  await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  await waitRendererReady(app.main)

  // 项目：一张 40×24 的图、一份内嵌它的 md、一张 svg
  projDir = join(app.home, 'proj-wf')
  mkdirSync(projDir, { recursive: true })
  smallPng = writePng(join(projDir, 'small.png'), { width: 40, height: 24 })
  docMd = join(projDir, 'doc.md')
  writeFileSync(docMd, '# Doc\n\nWF-MD-BODY\n\n![[small.png]]\n')
  smallSvg = join(projDir, 'small.svg')
  writeFileSync(
    smallSvg,
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>\n'
  )
  const project = await createProject(app.main, { name: 'WfProj', path: projDir })
  for (const [key, title] of [
    ['chat', 'WF-chat'],
    ['interactive', 'WF-interactive']
  ] as const) {
    sids[key] = await app.main.eval<string>(
      `window.api.session.create(${JSON.stringify({ title, projectId: project.id })}).then((s) => s.id)`
    )
  }

  // WF-4：目录浏览器要逛的树，和一个用来换文件夹的项目
  pickRoot = join(app.home, 'wf-pick')
  mkdirSync(join(pickRoot, 'alpha', 'beta'), { recursive: true })
  mkdirSync(join(pickRoot, '.hidden-dir'), { recursive: true })
  writeFileSync(join(pickRoot, 'file.txt'), 'not a folder\n')
  pickStart = join(app.home, 'wf-pick-start')
  mkdirSync(pickStart, { recursive: true })
  await createProject(app.main, { name: 'WfPickProj', path: pickStart })

  // WF-5 / WF-6：一个最小的 widget（不引任何包，直接往 #root 里写一句）
  const widgetDir = join(app.home, '.shuvix', 'widgets', WIDGET_ID)
  mkdirSync(widgetDir, { recursive: true })
  writeFileSync(
    join(widgetDir, 'widget.json'),
    JSON.stringify(
      {
        id: WIDGET_ID,
        name: 'Demo Widget',
        description: 'phase D e2e widget',
        entryFile: 'index.tsx',
        createdAt: Date.now()
      },
      null,
      2
    ) + '\n'
  )
  writeFileSync(
    join(widgetDir, 'index.tsx'),
    "const root = document.getElementById('root')\nif (root) root.textContent = 'WF-WIDGET-OK'\n"
  )

  // WF-7：用户知识库里一条条目（knowledge.revealFile 要它真的落进一个库）
  knowledgeEntryAbs = join(app.home, '.shuvix', 'knowledge', 'notes', 'a.md')
  mkdirSync(dirname(knowledgeEntryAbs), { recursive: true })
  writeFileSync(knowledgeEntryAbs, '---\ntitle: A\n---\n\nA note.\n')

  do {
    P = await freePort()
  } while (P === 7766)
  expect(await setPort(P)).toMatchObject({ enabled: false, port: P, listening: false })
  expect(await setEnabled(true)).toMatchObject({ enabled: true, port: P, listening: true })

  web = await openWebClient(app, P)
  webEvents = eventRecorder(webPage())
  await webEvents.install()
  await until(async () => {
    const titles = await sidebarPane(webPage()).titles()
    return titles.includes('WF-chat') && titles.includes('WF-interactive')
  }, 'web sidebar lists the seeded sessions')
}, 120_000)

afterAll(async () => {
  if (app) {
    for (const id of [...openedTabs.keys()]) await closeTab(id)
    if (sids.chat) {
      await app.main
        .eval(`window.api.pinChat.unpin(${JSON.stringify(sids.chat)}).then(() => true)`)
        .catch(() => undefined)
    }
  }
  if (web) await web.close().catch(() => undefined)
  await provider?.close().catch(() => undefined)
  await app?.stop()
})

describe('network access phase D: what the web client does instead of the desktop-only things', () => {
  it('WF-1 the file, lib and widget routes from outside (the widget server has not started yet)', async () => {
    const png = readFileSync(smallPng)

    // widget 服务是懒启动的：还没人打开过 widget
    const notRunning = await probe(`/w/${WIDGET_ID}/`)
    expect(notRunning.status).toBe(503)
    expect(notRunning.body?.toString('utf8')).toBe(WIDGET_NOT_RUNNING)
    expect(notRunning.headers?.['cache-control']).toBe('no-store')

    // /files/media：绝对路径，流式、按扩展名给 MIME
    const media = await probe(`/files/media?path=${encodeURIComponent(smallPng)}`)
    expect(media.status).toBe(200)
    expect(media.headers?.['content-type']).toBe('image/png')
    expect(media.headers?.['accept-ranges']).toBe('bytes')
    expect(media.headers?.['content-length']).toBe(String(png.length))
    expect(media.headers?.['content-security-policy']).toBeUndefined()
    expect(media.body?.equals(png)).toBe(true)

    // /files/preview：相对路径按会话的工作目录（项目目录）解析
    const preview = await probe(
      `/files/preview?session=${encodeURIComponent(sids.chat)}&path=small.png`
    )
    expect(preview.status).toBe(200)
    expect(preview.headers?.['content-type']).toBe('image/png')
    expect(preview.body?.equals(png)).toBe(true)

    // Range：一段 → 206；后缀范围按 RFC 读（最后 N 个字节）
    const head = await probe(`/files/media?path=${encodeURIComponent(smallPng)}`, {
      headers: { Range: 'bytes=0-7' }
    })
    expect(head.status).toBe(206)
    expect(head.headers?.['content-range']).toBe(`bytes 0-7/${png.length}`)
    expect(head.body?.equals(PNG_SIGNATURE)).toBe(true)
    const tail = await probe(`/files/media?path=${encodeURIComponent(smallPng)}`, {
      headers: { Range: 'bytes=-4' }
    })
    expect(tail.status).toBe(206)
    expect(tail.headers?.['content-range']).toBe(
      `bytes ${png.length - 4}-${png.length - 1}/${png.length}`
    )
    expect(tail.body?.equals(png.subarray(png.length - 4))).toBe(true)
    // 同源的页面自己发的 Range 请求也一样（浏览器的 fetch，不是 Node 的客户端）
    const fromPage = await webPage().eval<{ status: number; range: string | null; head: number[] }>(
      `fetch(${JSON.stringify(`/files/media?path=${encodeURIComponent(smallPng)}`)}, { headers: { Range: 'bytes=0-7' } })
        .then(async (r) => ({
          status: r.status,
          range: r.headers.get('content-range'),
          head: [...new Uint8Array(await r.arrayBuffer())]
        }))`
    )
    expect(fromPage).toStrictEqual({
      status: 206,
      range: `bytes 0-7/${png.length}`,
      head: [...PNG_SIGNATURE]
    })

    // svg 能当文档跑脚本：直接打开时是沙箱（不透明源）
    const svg = await probe(`/files/media?path=${encodeURIComponent(smallSvg)}`)
    expect(svg.status).toBe(200)
    expect(svg.headers?.['content-type']).toBe('image/svg+xml')
    expect(svg.headers?.['content-security-policy']).toBe('sandbox')

    // /lib/：与 shuvix-lib: 同一张白名单
    const chartFile = readFileSync(
      join(DESKTOP_ROOT, 'resources', 'sandbox-libs', 'chart.umd.min.js')
    )
    const chart = await probe('/lib/chart.js')
    expect(chart.status).toBe(200)
    expect(chart.headers?.['content-type']).toBe('text/javascript; charset=utf-8')
    expect(chart.body?.equals(chartFile)).toBe(true)
    for (const name of ['chart.umd.min.js', '__proto__']) {
      const miss = await probe(`/lib/${name}`)
      expect(miss.status, name).toBe(404)
      expect(miss.body?.toString('utf8'), name).toBe('Not found.')
    }

    // 门：别的 Host → 421，文件不发
    for (const path of [`/files/media?path=${encodeURIComponent(smallPng)}`, `/w/${WIDGET_ID}/`]) {
      const refused = await probe(path, { host: `evil.example:${P}` })
      expect(refused.status, path).toBe(421)
      expect(refused.body?.includes(png.subarray(0, 8)), path).toBe(false)
    }

    // 错误码：相对路径 → 400；文件不在 → 404
    const relative = await probe('/files/media?path=small.png')
    expect(relative.status).toBe(400)
    expect(relative.body?.toString('utf8')).toBe('Bad request.')
    const missing = await probe(
      `/files/media?path=${encodeURIComponent(join(projDir, 'missing.png'))}`
    )
    expect(missing.status).toBe(404)
    expect(missing.body?.toString('utf8')).toBe('Not found.')
    // 读不了的文件：先打开再写头，所以是干净的 403，而不是 200 之后断开（root 读得了一切，跳过）
    if (process.getuid?.() !== 0) {
      const locked = join(projDir, 'locked.png')
      writePng(locked, { width: 4, height: 4 })
      chmodSync(locked, 0o000)
      try {
        const forbidden = await probe(`/files/media?path=${encodeURIComponent(locked)}`)
        expect(forbidden.status).toBe(403)
        expect(forbidden.body?.toString('utf8')).toBe('Forbidden.')
      } finally {
        chmodSync(locked, 0o644)
      }
    }
  })

  it('WF-2 a chat image renders over HTTP and opens in a preview tab; doc.md opens read-only in a preview tab; no window opens on the server machine', async () => {
    provider.reset()
    provider.script(
      {
        toolCalls: [{ id: 'call_wf_img', name: 'read', args: JSON.stringify({ path: smallPng }) }],
        usage: USAGE
      },
      { text: 'seen WF image', usage: USAGE }
    )
    const chat = chatPane(webPage())
    expect(await sidebarPane(webPage()).openSession('WF-chat')).toBe(true)
    await chat.ready()
    await chat.typeAndSend('read the image')
    await webEvents.waitFor('agent_end', { sessionId: sids.chat })
    await chat.waitIdle()

    await chat.setToolRowExpanded(0, true)
    const [shot] = await chat.waitToolImages(1)
    expect(
      shot.src.startsWith(`/files/preview?session=${encodeURIComponent(sids.chat)}&path=`),
      shot.src
    ).toBe(true)
    expect(shot.path).toBe(smallPng)
    expect([shot.naturalWidth, shot.naturalHeight]).toEqual([40, 24])
    expect(shot.complete).toBe(true)

    // 点缩略图 → 新标签页里的预览（同一个页面，按 hash 渲染）
    const previewPrefix = `http://127.0.0.1:${P}/#file-preview?`
    await chat.clickToolImage(0)
    const imageTab = await openedTab(
      (u) => u.startsWith(previewPrefix) && hashParams(u).get('path') === smallPng,
      'a #file-preview tab for small.png'
    )
    const params = hashParams(imageTab.url)
    expect({
      sessionId: params.get('sessionId'),
      path: params.get('path'),
      openedBy: params.get('openedBy')
    }).toStrictEqual({ sessionId: sids.chat, path: smallPng, openedBy: 'user' })
    const imgs = await until(async () => {
      const list = await filePreviewWindowImages(imageTab.page)
      return list.some((i) => i.path === smallPng && i.naturalWidth === 40) ? list : null
    }, 'small.png decoded in the preview tab')
    expect(imgs.find((i) => i.path === smallPng)?.naturalHeight).toBe(24)
    // 服务端那台电脑上什么窗口都没开
    expect(await app.filePreviewWindows()).toEqual([])
    expect(await app.markdownWindows()).toEqual([])

    // md：在预览标签页里只读渲染（协作编辑窗口只在桌面）；里面嵌的图经 HTTP
    expect(
      await evalWithGesture(
        webPage(),
        `window.api.files.open(${JSON.stringify({ sessionId: sids.chat, path: docMd })})`
      )
    ).toBe(true)
    const mdTab = await openedTab(
      (u) => u.startsWith(previewPrefix) && hashParams(u).get('path') === docMd,
      'a #file-preview tab for doc.md'
    )
    expect(mdTab.url.includes('#markdown-window')).toBe(false)
    await until(
      async () => (await filePreviewWindowShot(mdTab.page)).text.includes('WF-MD-BODY'),
      'doc.md body in the preview tab'
    )
    const embedded = await until(async () => {
      const list = await filePreviewWindowImages(mdTab.page)
      const hit = list.find((i) => i.src.startsWith('/files/preview?session='))
      return hit && hit.complete && hit.naturalWidth > 0 ? hit : null
    }, 'the embedded image in doc.md decoded over /files/preview')
    expect(
      embedded.src.startsWith(`/files/preview?session=${encodeURIComponent(sids.chat)}&path=`)
    ).toBe(true)
    expect(embedded.naturalWidth).toBe(40)
    expect((await browserTabs(app)).some((t) => t.url.includes('#markdown-window'))).toBe(false)
    expect(await app.filePreviewWindows()).toEqual([])
    expect(await app.markdownWindows()).toEqual([])

    await closeTab(imageTab.id)
    await closeTab(mdTab.id)
  }, 120_000)

  it('WF-3 an interactive Chart.js block runs on the web with the libraries served from /lib/', async () => {
    const base = `http://127.0.0.1:${P}/lib/`
    const block = [
      '<canvas id="c"></canvas>',
      '<script src="shuvix-lib://chart.js"></script>',
      '<script src="shuvix-lib://d3.js"></script>',
      '<script>',
      "window.addEventListener('load', function () {",
      "  shuvix.sendPrompt('WF3 ' + JSON.stringify({ chart: typeof Chart, d3: typeof d3, origin: String(self.origin) }));",
      '});',
      '</script>'
    ].join('\n')
    provider.reset()
    provider.script({
      text: `MARK-WF3 libs:\n\n\`\`\`interactive\n${block}\n\`\`\``,
      usage: USAGE
    })
    const chat = chatPane(webPage())
    expect(await sidebarPane(webPage()).openSession('WF-interactive')).toBe(true)
    await chat.ready()
    await chat.typeAndSend('draw WF3')
    await webEvents.waitFor('agent_end', { sessionId: sids.interactive })
    await chat.waitIdle()

    const card = interactivePane(webPage(), 'MARK-WF3')
    const shot = await card.waitFrame()
    expect(shot.sandbox).toBe('allow-scripts')
    expect(shot.srcdocHead).toContain(`script-src 'unsafe-inline' ${base}`)
    expect(shot.srcdocHead).not.toContain('shuvix-lib:')
    const srcdoc = (await card.srcdoc()) ?? ''
    expect(srcdoc).toContain(`src="${base}chart.js"`)
    expect(srcdoc).toContain(`src="${base}d3.js"`)
    expect(srcdoc).not.toContain('shuvix-lib:')

    const line = await until(async () => {
      const value = await chat.inputValue()
      return value.split('\n').find((l) => l.startsWith('WF3 ')) ?? null
    }, 'the block reports through sendPrompt')
    expect(line).toBe('WF3 {"chart":"function","d3":"object","origin":"null"}')
  }, 90_000)

  it('WF-4 the in-page directory picker stands in for the native folder dialog', async () => {
    const pane = webClientPane(webPage())
    const sidebar = sidebarPane(webPage())
    expect(await pane.picker()).toBeNull()
    expect(nativeDialogRequests(app), 'precondition: no native dialog yet').toEqual([])
    const alpha = join(pickRoot, 'alpha')
    const beta = join(alpha, 'beta')

    // (a) 项目配置 → 更换文件夹 → 页面里的目录浏览器
    await sidebar.clickGroupMenuButton({ project: 'WfPickProj' })
    const menu = await until(() => pane.domMenu(), 'the DOM group menu of WfPickProj')
    expect(menu.map((m) => m.label)).toContain(en.sidebar.editProject)
    await pane.pickDomMenu(en.sidebar.editProject)
    const dialog = projectEditPane(webPage())
    await dialog.waitOpen()
    expect(await dialog.folder()).toStrictEqual({ name: 'wf-pick-start', path: pickStart })
    await dialog.clickChangeFolder()

    const atHome = await pane.waitPicker(
      (s) => s.path === app.home,
      'picker opens at the home folder'
    )
    expect(atHome.modal).toBe(true)
    expect(atHome.error).toBeNull()
    expect(atHome.entries).toEqual(expect.arrayContaining(['proj-wf', 'wf-pick', 'wf-pick-start']))

    await pane.pickerTypePath(pickRoot)
    await pane.pickerGo()
    const atRoot = await pane.waitPicker((s) => s.path === pickRoot, 'picker lists wf-pick')
    expect(atRoot.entries).toEqual(['alpha'])
    expect(atRoot.upDisabled).toBe(false)
    expect(atRoot.showHidden).toBe(false)

    await pane.pickerToggleHidden()
    const withHidden = await pane.waitPicker(
      (s) => s.path === pickRoot && s.showHidden && s.entries.includes('.hidden-dir'),
      'picker lists hidden folders'
    )
    expect([...withHidden.entries].sort()).toEqual(['.hidden-dir', 'alpha'])

    expect(await pane.pickerOpenEntry('alpha')).toBe(true)
    const inAlpha = await pane.waitPicker((s) => s.path === alpha, 'picker inside alpha')
    expect(inAlpha.entries).toEqual(['beta'])
    expect(inAlpha.showHidden).toBe(true)

    await pane.pickerUp()
    await pane.waitPicker((s) => s.path === pickRoot, 'picker back at wf-pick')

    await pane.pickerTypePath(join(pickRoot, 'nope'))
    await pane.pickerGo()
    const missing = await pane.waitPicker((s) => s.error !== null, 'picker shows the error row')
    expect(missing.error).toBe('ENOENT')
    expect(missing.chooseDisabled).toBe(true)
    expect(missing.entries).toEqual([])

    await pane.pickerTypePath(alpha)
    await pane.pickerGo()
    const ready = await pane.waitPicker(
      (s) => s.path === alpha && s.error === null,
      'picker back in alpha'
    )
    expect(ready.chooseDisabled).toBe(false)
    await pane.pickerChoose()
    await until(async () => (await pane.picker()) === null, 'picker closes after Choose')
    await until(
      async () => (await dialog.folder())?.path === alpha,
      'the project dialog shows the chosen folder'
    )
    expect(await dialog.folder()).toStrictEqual({ name: 'alpha', path: alpha })
    await dialog.save()
    await until(
      async () => (await projectsInMain()).find((p) => p.name === 'WfPickProj')?.path === alpha,
      'main lists WfPickProj at the chosen folder'
    )

    // (b) 打开文件夹 → Esc：什么都不建
    const projectsBefore = (await projectsInMain()).map((p) => p.id).sort()
    const sessionsBefore = await app.main.eval<number>(
      'window.api.session.list().then((ss) => ss.length)'
    )
    await sidebar.clickGroupMenuButton('section')
    await until(() => pane.domMenu(), 'the DOM menu of the projects section')
    await pane.pickDomMenu(en.sidebar.newProject)
    await pane.waitPicker((s) => s.path === app.home, 'picker opens for Open Folder')
    await pane.pickerEscape()
    await until(async () => (await pane.picker()) === null, 'picker closes on Escape')
    // 取消之后不该再有任何动作：留一小段让「本不该发生的创建」有机会发生
    await sleep(800)
    expect((await projectsInMain()).map((p) => p.id).sort()).toEqual(projectsBefore)
    expect(await app.main.eval<number>('window.api.session.list().then((ss) => ss.length)')).toBe(
      sessionsBefore
    )

    // (c) 外部技能目录的第一步：选中 → {success, path}；取消 → canceled
    const startSkillPick = (): Promise<unknown> =>
      webPage().eval(`(() => {
        window.__wfSkillPick = undefined
        window.api.skill.pickExternalDir().then((r) => { window.__wfSkillPick = r })
        return true
      })()`)
    const skillPickResult = (): Promise<unknown> =>
      until(
        () => webPage().eval<unknown>('window.__wfSkillPick ?? null'),
        'skill.pickExternalDir resolves'
      )
    await startSkillPick()
    await pane.waitPicker((s) => s.path === app.home, 'picker opens for the skill folder')
    await pane.pickerTypePath(beta)
    await pane.pickerGo()
    await pane.waitPicker((s) => s.path === beta && s.error === null, 'picker inside beta')
    await pane.pickerChoose()
    expect(await skillPickResult()).toStrictEqual({ success: true, path: beta })
    await until(async () => (await pane.picker()) === null, 'picker closed after the skill pick')

    await startSkillPick()
    await pane.waitPicker(undefined, 'picker opens again for the skill folder')
    await pane.pickerCancel()
    expect(await skillPickResult()).toStrictEqual({ success: false, reason: 'canceled' })
    await until(async () => (await pane.picker()) === null, 'picker closed after Cancel')

    // (d) 一个原生框都没请求过；也没有「只能在桌面上用」的提示
    expect(nativeDialogRequests(app)).toEqual([])
    expect(await pane.desktopOnlyNotice()).toBeNull()
  }, 120_000)

  it('WF-5 a widget runs through the /w/ proxy in a sandboxed iframe in a new tab', async () => {
    const tabUrl = `http://127.0.0.1:${P}/#widget-window?widgetId=${WIDGET_ID}`
    const frameSrc = `http://127.0.0.1:${P}/w/${WIDGET_ID}/`
    expect(
      await evalWithGesture(webPage(), `window.api.widgetWindow.open(${JSON.stringify(WIDGET_ID)})`)
    ).toStrictEqual({ success: true })
    const tab = await openedTab((u) => u === tabUrl, 'the #widget-window tab')

    const frameOf = (): Promise<{ src: string; sandbox: string | null } | null> =>
      tab.page.eval(`(() => {
        const f = document.querySelector('[data-widget-frame]')
        return f ? { src: f.getAttribute('src') ?? '', sandbox: f.getAttribute('sandbox') } : null
      })()`)
    const frame = await until(frameOf, 'the widget iframe mounted', 60_000)
    expect(frame).toStrictEqual({ src: frameSrc, sandbox: WEB_WIDGET_SANDBOX })
    // 浏览器标签页没有「始终置顶」
    expect(await tab.page.eval<boolean>(`!!document.querySelector('.lucide-pin')`)).toBe(false)

    // iframe 跑在自己的 target 里：widget 的输出在，源是不透明的，够不着父页面
    const target = await until(
      async () =>
        (await listTargets(app.port)).find((t) => t.type === 'iframe' && t.url === frameSrc),
      'the widget iframe target',
      30_000
    )
    const inside = await connect(target.webSocketDebuggerUrl)
    try {
      await until(
        () => inside.eval<boolean>(`(document.body?.textContent ?? '').includes('WF-WIDGET-OK')`),
        'the widget wrote WF-WIDGET-OK',
        30_000
      )
      expect(await inside.eval<string>('String(self.origin)')).toBe('null')
      const parentApi = await inside.eval<string>(`(() => {
        try { return 'reached:' + typeof parent.api } catch (e) { return 'threw:' + e.name }
      })()`)
      expect(parentApi.startsWith('threw:'), parentApi).toBe(true)
    } finally {
      inside.close()
    }

    // 从外面：bundle、入口 HTML（带 base 与沙箱 CSP）、没注册的 widget、事件流
    const bundle = await probe(`/w/${WIDGET_ID}/bundle.js`)
    expect(bundle.status).toBe(200)
    expect(String(bundle.headers?.['content-type'])).toMatch(/javascript/)
    expect(bundle.body?.toString('utf8')).toContain('WF-WIDGET-OK')
    const entry = await probe(`/w/${WIDGET_ID}/`)
    expect(entry.status).toBe(200)
    expect(String(entry.headers?.['content-type'])).toMatch(/^text\/html/)
    expect(entry.body?.toString('utf8')).toContain(`<base href="/w/${WIDGET_ID}/" />`)
    expect(entry.headers?.['content-security-policy']).toBe(WIDGET_DOCUMENT_CSP)
    expect(bundle.headers?.['content-security-policy']).toBeUndefined()
    const unknown = await probe('/w/nope-widget/')
    expect(unknown.status).toBe(404)
    expect(unknown.body?.toString('utf8')).toBe('Widget nope-widget not registered')
    const sse = await httpStreamProbe({
      port: P,
      path: `/w/${WIDGET_ID}/sse`,
      host: `127.0.0.1:${P}`,
      until: (body) => body.includes(':\n\n')
    })
    expect(sse.status).toBe(200)
    expect(String(sse.headers?.['content-type'])).toMatch(/^text\/event-stream/)
    expect(sse.body?.toString('utf8').startsWith(':\n\n')).toBe(true)
    expect(sse.ended).toBe(false)

    // 服务端那台电脑上没有开 widget 窗口
    expect(
      (await listTargets(app.port)).some(
        (t) => t.url.startsWith('file://') && t.url.includes('#widget-window')
      )
    ).toBe(false)

    // 重载：iframe 换了一个节点，地址不变
    await tab.page.eval(`document.querySelector('[data-widget-frame]').__wfMark = 'before-reload'`)
    const reloaded = await tab.page.eval<boolean>(`(() => {
      const button = [...document.querySelectorAll('button')].find(
        (b) => b.getAttribute('title') === ${JSON.stringify(en.widgets.windowReload)}
      )
      if (!button) return false
      button.click()
      return true
    })()`)
    expect(reloaded).toBe(true)
    await until(
      () =>
        tab.page.eval<boolean>(`(() => {
          const f = document.querySelector('[data-widget-frame]')
          return !!f && f.__wfMark === undefined
        })()`),
      'the widget iframe remounted after Reload',
      30_000
    )
    expect(await frameOf()).toStrictEqual({ src: frameSrc, sandbox: WEB_WIDGET_SANDBOX })

    await closeTab(tab.id)
  }, 150_000)

  it('WF-6 exporting a widget from the web client downloads a zip made on the server', async () => {
    const pane = webClientPane(webPage())
    const panel = rightPanelPane(webPage())
    const exportsRoot = join(app.userData, 'widget-exports')
    await panel.open()
    await panel.activateWidgetTab()
    await until(
      async () => (await panel.widgetCardIds()).includes(WIDGET_ID),
      'the widget card in the right panel'
    )
    await webPage().eval(`(() => {
      if (window.__wfAnchorClicks) return true
      window.__wfAnchorClicks = []
      const original = HTMLAnchorElement.prototype.click
      HTMLAnchorElement.prototype.click = function () {
        window.__wfAnchorClicks.push({
          href: this.getAttribute('href') ?? '',
          download: this.getAttribute('download') ?? '',
          rel: this.getAttribute('rel') ?? ''
        })
        return original.call(this)
      }
      return true
    })()`)
    const anchorClicks = (): Promise<AnchorClick[]> =>
      webPage().eval<AnchorClick[]>('window.__wfAnchorClicks ?? []')

    const exportOnce = async (n: number): Promise<{ click: AnchorClick; zip: string }> => {
      // 卡片的右键菜单：浏览器里没有原生菜单，弹的是页面里的 DOM 菜单（共享的 ContextMenuProvider）
      expect(await panel.contextMenuWidgetCard(WIDGET_ID)).toBe(true)
      const menu = await until(() => pane.domMenu(), `the widget card's DOM menu (#${n})`)
      const labels = menu.map((item) => item.label)
      expect(labels).toContain(en.widgets.exportAsVite)
      expect(labels).toContain(en.widgets.openInWindow)
      // 两种打开方式都在：面板里（主屏上的应用）与独立窗口（web 客户端里是新标签页）
      expect(labels).toContain(en.widgets.openInPanel)
      await pane.pickDomMenu(en.widgets.exportAsVite)
      const clicks = await until(async () => {
        const list = await anchorClicks()
        return list.length >= n ? list : null
      }, `download link clicked (#${n})`)
      expect(clicks).toHaveLength(n)
      const click = clicks[n - 1]
      const url = new URL(click.href, `http://127.0.0.1:${P}`)
      expect(url.pathname).toBe('/files/download')
      const zip = url.searchParams.get('path') ?? ''
      return { click, zip }
    }

    const exportAndDownload = async (): Promise<void> => {
      const first = await exportOnce(1)
      expect(first.click.download).toBe(`${WIDGET_ID}.zip`)
      expect(first.click.rel).toBe('noopener')
      expect(first.click.href).toBe(`/files/download?path=${encodeURIComponent(first.zip)}`)
      expect(dirname(dirname(first.zip))).toBe(exportsRoot)
      expect(dirname(first.zip).split('/').pop()).toMatch(/^export-/)
      expect(first.zip.endsWith(`/${WIDGET_ID}.zip`)).toBe(true)
      expect(existsSync(first.zip)).toBe(true)
      // 浏览器真的按下载去取了那个地址（应用浏览器的窗口不在前台：下载被应用取消、记一行日志，不弹保存框）
      await until(
        () =>
          app
            .mainLog()
            .includes(
              `Download while the browser window is not in front: cancelled http://127.0.0.1:${P}${first.click.href}`
            ),
        'the browser started (and the app cancelled) the download of that link'
      )

      const download = await probe(first.click.href)
      expect(download.status).toBe(200)
      expect(download.headers?.['content-type']).toBe('application/octet-stream')
      expect(download.headers?.['content-disposition']).toBe(
        `attachment; filename="${WIDGET_ID}.zip"; filename*=UTF-8''${WIDGET_ID}.zip`
      )
      expect(download.headers?.['cache-control']).toBe('no-store')
      expect(download.body?.subarray(0, 4).equals(ZIP_SIGNATURE)).toBe(true)
      expect(download.body?.length).toBe(statSync(first.zip).size)

      // 没有保存框、没有「只能在桌面上用」、面板里没有导出失败的框
      expect(nativeDialogRequests(app)).toEqual([])
      expect(await pane.desktopOnlyNotice()).toBeNull()
      expect(
        await webPage().eval<boolean>(
          `[...document.querySelectorAll('.dialog-panel')].some((p) => (p.textContent ?? '').includes(${JSON.stringify(en.widgets.exportFailedTitle)}))`
        )
      ).toBe(false)

      // 再导一次：另一个新目录
      const second = await exportOnce(2)
      expect(dirname(dirname(second.zip))).toBe(exportsRoot)
      expect(dirname(second.zip)).not.toBe(dirname(first.zip))
      expect(existsSync(second.zip)).toBe(true)
    }

    await exportAndDownload()
  }, 120_000)

  it('WF-9 the web panel ignores the desktop window preference: a tap opens in the web panel, ↗ opens a tab, the desktop choice stays', async () => {
    const tabUrl = `http://127.0.0.1:${P}/#widget-window?widgetId=${WIDGET_ID}`
    const desktopStatus = (): Promise<{ open: string[]; preferWindow: string[] }> =>
      app.main.eval(`window.api.widgetWindow.status(${JSON.stringify([WIDGET_ID])})`)
    const desktopWindowOpen = async (): Promise<boolean> =>
      (await listTargets(app.port)).some(
        (t) => t.url.startsWith('file://') && t.url.includes(`#widget-window?widgetId=${WIDGET_ID}`)
      )
    const home = widgetHomePane(webPage())
    const panel = rightPanelPane(webPage())
    try {
      // 桌面：上次选的是独立窗口，而且那个窗口此刻开着
      await app.main.eval(
        `window.api.widgetWindow.setPreferWindow(${JSON.stringify({ id: WIDGET_ID, value: true })}).then(() => true)`
      )
      await app.main.eval(
        `window.api.widgetWindow.open(${JSON.stringify(WIDGET_ID)}).then(() => true)`
      )
      await until(desktopWindowOpen, 'the desktop widget window')
      expect(await desktopStatus()).toStrictEqual({ open: [WIDGET_ID], preferWindow: [WIDGET_ID] })

      await panel.open()
      await panel.activateWidgetTab()
      await until(
        async () => (await home.slotIds()).includes(WIDGET_ID) || null,
        'the widget icon on the web home screen'
      )
      const tabsBefore = (await browserTabs(app)).map((t) => t.id).sort()

      // 页面里点图标：在页面的面板里打开，不开新标签页
      await home.tap(WIDGET_ID)
      await until(
        async () => (await home.foregroundApp()) === WIDGET_ID || null,
        'the widget in the web panel'
      )
      await until(() => home.frameReady(WIDGET_ID), 'the web panel iframe', 60_000)
      await until(
        async () => (await home.openAnimation(WIDGET_ID)).panelPointerEvents === '' || null,
        'the open transition finished'
      )
      expect((await browserTabs(app)).map((t) => t.id).sort()).toEqual(tabsBefore)

      // ↗：一个 #widget-window 标签页（web 客户端的「独立窗口」），面板里收走
      await home.popout()
      const tab = await openedTab((u) => u === tabUrl, 'the #widget-window tab from ↗')
      await until(
        async () => !(await home.panelApps()).includes(WIDGET_ID) || null,
        'the widget left the web panel'
      )
      await closeTab(tab.id)

      // 浏览器里的选择不往回记：桌面的偏好不变
      expect((await desktopStatus()).preferWindow).toEqual([WIDGET_ID])
    } finally {
      await app.main.eval(
        `window.api.widgetWindow.close(${JSON.stringify(WIDGET_ID)}).then(() => true)`
      )
      await app.main.eval(
        `window.api.widgetWindow.setPreferWindow(${JSON.stringify({ id: WIDGET_ID, value: false })}).then(() => true)`
      )
      await until(
        async () => !(await desktopWindowOpen()) || null,
        'the desktop widget window closed'
      )
    }
  }, 120_000)

  it('WF-7 the path card shows the same folder / file the desktop opens; web calls never reach the file manager', async () => {
    const pane = webClientPane(webPage())
    const folderChannels: Array<[string, string]> = [
      ['subAgent', 'subAgent:openFolder'],
      ['policy', 'policy:openFolder'],
      ['hook', 'hook:openFolder'],
      ['bot', 'bot:openFolder'],
      ['knowledge', 'knowledge:openFolder']
    ]
    for (const [ns, channel] of folderChannels) {
      const before = shellOpens(app).length
      expect(await app.main.eval(`window.api.${ns}.openFolder()`), channel).toStrictEqual({
        success: true
      })
      const added = await until(async () => {
        const lines = shellOpens(app).slice(before)
        return lines.length > 0 ? lines : null
      }, `main hands ${channel} to the file manager`)
      expect(added, channel).toHaveLength(1)
      const match = /^openPath (.+)$/.exec(added[0])
      expect(match, added[0]).not.toBeNull()
      const dir = match![1]

      const webBefore = shellOpens(app).length
      expect(await settleInWeb(`${ns}.openFolder()`), channel).toStrictEqual({
        ok: true,
        value: { success: true }
      })
      const notice = await until(async () => {
        const n = await pane.pathNotice()
        return n?.channel === channel ? n : null
      }, `path card for ${channel}`)
      expect(notice).toStrictEqual({ channel, path: dir, text: dir })
      expect(shellOpens(app).length, channel).toBe(webBefore)
    }

    // 条目「在文件夹中显示」：桌面 showItemInFolder 的那个文件 = 卡片上的文件
    const beforeReveal = shellOpens(app).length
    expect(
      await app.main.eval(`window.api.knowledge.revealFile({ path: 'knowledge/notes/a.md' })`)
    ).toStrictEqual({ success: true })
    expect(
      await until(async () => {
        const lines = shellOpens(app).slice(beforeReveal)
        return lines.length > 0 ? lines : null
      }, 'main reveals the knowledge entry')
    ).toEqual([`showItemInFolder ${knowledgeEntryAbs}`])
    const webBeforeReveal = shellOpens(app).length
    expect(
      await settleInWeb(`knowledge.revealFile({ path: 'knowledge/notes/a.md' })`)
    ).toStrictEqual({ ok: true, value: { success: true } })
    expect(
      await until(async () => {
        const n = await pane.pathNotice()
        return n?.channel === 'knowledge:revealFile' ? n : null
      }, 'path card for knowledge:revealFile')
    ).toStrictEqual({
      channel: 'knowledge:revealFile',
      path: knowledgeEntryAbs,
      text: knowledgeEntryAbs
    })

    // 落不进任何库的条目：失败，不出卡片
    expect(await pane.closePathNotice()).toBe(true)
    await until(async () => (await pane.pathNotice()) === null, 'path card closed')
    expect(await settleInWeb(`knowledge.revealFile({ path: 'bogus/x.md' })`)).toStrictEqual({
      ok: true,
      value: { success: false }
    })
    expect(await pane.pathNotice()).toBeNull()

    // 导出的 zip「在文件夹中显示」
    const zip = join(app.userData, 'widget-exports', 'export-wf7', `${WIDGET_ID}.zip`)
    expect(await settleInWeb(`widget.revealExport(${JSON.stringify(zip)})`)).toStrictEqual({
      ok: true,
      value: { success: true }
    })
    expect(
      await until(async () => {
        const n = await pane.pathNotice()
        return n?.channel === 'widget:revealExport' ? n : null
      }, 'path card for widget:revealExport')
    ).toStrictEqual({ channel: 'widget:revealExport', path: zip, text: zip })

    expect(shellOpens(app).length).toBe(webBeforeReveal)
    expect(await pane.closePathNotice()).toBe(true)
  })

  it('WF-8 the web client ignores the desktop floating windows; the right panel is there', async () => {
    const messages = await listMessages(sids.chat)
    expect(
      messages.map((m) => m.content).filter((c) => c),
      'precondition: WF-chat has the WF-2 turn'
    ).toEqual(['read the image', 'seen WF image'])
    try {
      expect(
        await app.main.eval(`window.api.pinChat.pin(${JSON.stringify(sids.chat)}).then(() => true)`)
      ).toBe(true)
      await until(
        async () => (await app.pinnedChatSessions()).includes(sids.chat),
        'the desktop floats WF-chat'
      )

      const sidebar = sidebarPane(webPage())
      const chat = chatPane(webPage())
      expect(await sidebar.openSession('WF-interactive')).toBe(true)
      expect(await sidebar.openSession('WF-chat')).toBe(true)
      await chat.ready()
      expect((await chat.composer()).present).toBe(true)
      // 消息：用户那句 + 一张卡（工具调用与最后的回答折进同一张卡）
      expect(
        (
          await until(async () => {
            const items = await chat.settledItems()
            return items.length === 2 ? items : null
          }, 'the web page shows WF-chat with its messages')
        ).map(({ role, text }) => ({ role, text }))
      ).toEqual([
        { role: 'user', text: 'read the image' },
        { role: 'assistant', text: 'seen WF image' }
      ])
      const facts = await webPage().eval<{
        placeholder: boolean
        focusFloating: boolean
        pinButton: boolean
        rightToggle: boolean
      }>(`(() => {
        const buttons = [...document.querySelectorAll('button')]
        return {
          placeholder: (document.body.textContent ?? '').includes(${JSON.stringify(en.pinChat.placeholderTitle)}),
          focusFloating: buttons.some((b) => (b.textContent ?? '').trim() === ${JSON.stringify(en.pinChat.focusFloating)}),
          pinButton: buttons.some((b) => b.getAttribute('title') === ${JSON.stringify(en.pinChat.pin)}),
          rightToggle: !!document.querySelector('button[data-side="right"]')
        }
      })()`)
      expect(facts).toStrictEqual({
        placeholder: false,
        focusFloating: false,
        pinButton: false,
        rightToggle: true
      })
      expect(await sidebar.rowIcon('WF-chat')).not.toBe('pinned')
    } finally {
      await app.main.eval(`window.api.pinChat.unpin(${JSON.stringify(sids.chat)}).then(() => true)`)
      await until(
        async () => !(await app.pinnedChatSessions()).includes(sids.chat),
        'the floating window of WF-chat is gone'
      )
    }
  })
})
