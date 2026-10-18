/**
 * web 客户端的手机布局（MobileShell）—— 浏览器里的 web 客户端开在窄屏（< 640px）或触屏的矮屏（< 500px 高）上时，
 * 换成底部四个标签 + 整屏对话页 + 底部抽屉 + 长按 = 右键；桌面应用的窗口永远是桌面布局。
 *
 * 判定（web 客户端 / 桌面窗口）：
 *   W-1 1280×800、没有触屏：没有 [data-mobile-shell]；侧栏设置栏与六个注册表分组都在
 *   W-2 拉到 390 宽：不重载就换成手机布局；拉回 1280 就换回来
 *   W-3 844×390 + 触屏 → 手机布局；同样大小关掉触屏 → 桌面布局
 *   W-4 `/` 的 HTML 带 viewport meta（width=device-width、viewport-fit=cover、interactive-widget=resizes-content）
 *   D-1 桌面主窗口在 390 宽的模拟下：没有手机布局，侧栏设置栏在，没有 viewport meta
 *   D-2 桌面设置窗口在 390 宽的模拟下：不是叠放布局，设置行 flex-wrap: nowrap
 *
 * 手机布局（390×844、dsf 2、mobile、触屏模拟，重载之后）：
 *   M-1 四个标签 Chats / Widgets / Library / Settings，只有会话标签 aria-current；只挂了会话页
 *   M-2 点标签：aria-current 跟着走、第一次点才挂载；去过的留着（display none）；展开的项目组转一圈回来还展开着
 *   M-3 会话页的分组只有 section / project / temp；没有设置栏、没有拖拽带
 *   M-4 资料库页的分组恰是 bots, agents, policies, hooks, skills, knowledge
 *   M-5 真点一行 → 对话页：标题对、预置的回复在、标签层 aria-hidden、历史压了一条带标记的（长度 +1）；
 *       对话横幅里没有 agent 胶囊（桌面布局里同一会话有）
 *   M-6 返回键收起对话页并退掉那条历史；history.back() 也收起（窗口上的标记证明没有重载）
 *   M-7 再点一次正活跃的那一行 → 重新推入
 *   M-8 日历开关：aria-label 换；点当天的会话 → 对话页；返回；再点那条（已是活跃的）→ 又推入；
 *       列表 ⇄ 日历来回切，日历选中的日子与列表的展开状态都还在
 *   M-9 新建会话抽屉：临时会话 + 各项目；点遮罩什么都不建；选一个项目 → 恰建一条该项目的会话并推入
 *   M-10 资料库里的 bot 行 → 对话页里是笔记本（.cm-editor）；返回落在资料库；再点那一行（此刻是活跃会话）又推入
 *   M-11 对话页没有桌面顶栏的按钮（内置浏览器窗口、侧栏 / 面板开关）；点标题 → 会话设置
 *   M-12 文件抽屉列出 hello.txt，点遮罩收起；任务抽屉是空态（mobile.noTasks）
 *   M-13 在会话设置里删掉这条会话 → 对话页收起、列表里没了这一行、那条历史标记退掉
 *   M-14 真点小组件卡片 → 新标签页 #widget-window?widgetId=…，页面里不开面板；真长按卡片 → DOM 菜单恰是
 *        「在独立窗口打开 / 导出 / 归档 / 删除」（运行中多一个「停止」），没有「在面板中打开」
 *   M-14b 真点卡片右上角（桌面上悬浮按钮所在的地方）→ 与点中间一样开新标签页：没有归档、没有删除确认框、没有停掉
 *   M-15 设置：分区列表 general … about + agents（voice / telegramBots 带 Beta）；进「通用」→ 返回键、头部名、
 *        设置行 flex-wrap: wrap 且标题栏 min-width 9em；回列表；「智能体」分区头部是 Agents
 *   M-16 #settings/general 在手机宽度直接进分区、返回是列表；#settings 是列表；1280 宽不是叠放
 *   M-17 真触摸：按住 800ms → DOM 菜单、不推入对话页、页面里的 contextmenu 恰一次（window 捕获阶段数：菜单处理
 *        函数会 stopPropagation，冒泡到 window 的那一程走不到）；轻点 100ms → 推入；
 *        挪 30px 没有菜单、挪 5px 照样有；关掉菜单之后的下一次轻点照常推入；资料库里内置智能体行按住 →
 *        菜单里有「创建覆盖副本」
 *   M-18 专注模式缺省开着：手机布局里打开再返回，壳里没有 .opacity-30；1280 宽的桌面布局里至少一处
 *   M-19 手机布局里对话输入框 16px；1280 宽时不是 16px。会话行与项目组头、「项目知识库」文件夹行同高（±2px，
 *        不再有 40px 的下限：行 < 30px），且与桌面侧栏里同一条会话行同高（±1px）
 *   M-20 popstate 只在落到不带标记的那一条时收起对话页；重载时留下的那条带标记的历史在挂载时被摘掉
 *   M-21 360 宽的卡片（英文、模型名很长）：空闲时发送键在卡片里、模型名截断；运行中（两个选择器都上了锁）两个
 *        队列出口只剩图标（字那格 display none，aria-label 仍是字）、队列 / 停止 / 用量环都在卡片里、环不缩、
 *        扩展选择器不压到环上、模型触发器不压到扩展选择器上、模型名 < 120px 且截断、页面与壳没有横向溢出；
 *        跑完发送键又在卡片里。1280 宽：模型名恰 120px（封顶、不缩），运行中队列出口带字
 *   M-22 很长的多段思考折叠成一行：块高与一句话的思考相同（±1）、到终答正文的间距也相同（±1，回归点：之前外层
 *        按里面整段换行的高度留位，折叠的思考块下面空出一大块）、内容盒 nowrap + ellipsis 且确实溢出；点开 →
 *        高 > 3 倍、文字从第一段开头到最后一段结尾（首尾空行去掉）、段落空行留着；再点 → 回到一行高
 *
 * 约定同 web-fallbacks.e2e.ts：界面语言先设成 en；从不在缺省端口 7766 上打开；会话只经主进程 IPC 带明确标题创建
 * （不跑 titler）；预置回复经主进程的 agent.prompt 跑完一轮。设备模拟走 CDP（`Emulation.setDeviceMetricsOverride`
 * + `setTouchEmulationEnabled`），切到手机布局后重载一次（M-1 要一个刚挂上的壳）；点击 / 长按都是
 * `Input.dispatchTouchEvent` 的真触摸（webMobilePane）。M-17 的长按 / 挪动靠真实时长（800ms、按下 100ms 后挪动），
 * 在很慢的机器上偶发失败的话先看这一条。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import { connectTabPage } from '../../harness/browserFixtures'
import { sleep, until, type CdpClient } from '../../harness/cdp'
import { startFakeProvider, type FakeProvider } from '../../harness/fakeProvider'
import { freePort, launchApp, type E2EApp } from '../../harness/launch'
import {
  browserTabs,
  closeBrowserTab,
  httpProbe,
  openWebClient,
  waitBrowserTab,
  type NetworkStatus,
  type WebClientHandle
} from '../../harness/networkFixtures'
import {
  agentsSidebarPane,
  botsPane,
  chatPane,
  sessionConfigPane,
  sidebarPane,
  webClientPane,
  webMobilePane,
  confirmPane,
  widgetPanelPane,
  type BoxShot,
  type ComposerLayoutShot,
  type ThinkingBlockShot,
  type WebMobileTab
} from '../../harness/pages'
import {
  createProject,
  newSessionsAfter,
  seedFakeProvider,
  waitRendererReady,
  writeBotMd
} from '../../harness/seed'

const MODEL = 'e2e-model'
const USAGE = { prompt: 90, completion: 10 }
const WIDGET_ID = 'mob-widget'
const BOT = 'mobbot'
const REGISTRY_GROUPS = ['bots', 'agents', 'policies', 'hooks', 'skills', 'knowledge']
const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }
const DESKTOP = { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }
/** M-21：最窄的常见手机 */
const NARROW = { width: 360, height: 780, deviceScaleFactor: 2, mobile: true }
/** M-21 的会话用的模型：名字长到在 360 宽的卡片里一定放不下 */
const LONG = 'e2e-model-with-an-unusually-long-identifier-for-phones'
/** M-22：一句话的思考（参照）与五段、首尾带空行的长思考 */
const THINK_SHORT = 'Short thought.'
const THINK_PARAS = [1, 2, 3, 4, 5].map(
  (n) =>
    `Paragraph ${n} opens here and keeps going ` +
    'with a long run of ordinary words that wraps several times on a phone '.repeat(2) +
    `until paragraph ${n} closes.`
)
const THINK_LONG = '\n\n' + THINK_PARAS.join('\n\n') + '\n\n\n'

let app: E2EApp
let provider: FakeProvider
let web: WebClientHandle | undefined
let P = 0
const projects = { main: { id: '', name: 'MobProj' }, other: { id: '', name: 'MobProj2' } }
const sids = { chat: '', temp: '', doomed: '', narrow: '', think: '' }
/** 用例里开的浏览器 tab（失败时 afterAll 兜底关） */
const openedTabs = new Set<string>()

const page = (): CdpClient => web!.page
const mobile = (): ReturnType<typeof webMobilePane> => webMobilePane(page())

const setPort = (port: unknown): Promise<NetworkStatus> =>
  app.main.eval<NetworkStatus>(`window.api.network.setPort(${JSON.stringify(port)})`)
const setEnabled = (on: boolean): Promise<NetworkStatus> =>
  app.main.eval<NetworkStatus>(`window.api.network.setEnabled(${JSON.stringify(on)})`)

const sessionsInMain = (): Promise<
  Array<{ id: string; title: string; projectId: string | null }>
> =>
  app.main.eval(
    `window.api.session.list().then((ss) => ss.map((s) => ({ id: s.id, title: s.title, projectId: s.projectId ?? null })))`
  )

/** 主进程里跑完一轮（脚本化的回复，可带思考）—— 会话有了消息、有了今天的日历记录、也有了运行时 */
async function seedReply(
  sid: string,
  prompt: string,
  reply: string,
  thinking?: string
): Promise<void> {
  provider.script({ text: reply, thinking, usage: USAGE })
  await app.main.eval(
    `window.api.agent.prompt(${JSON.stringify({ sessionId: sid, text: prompt })}).then(() => true)`
  )
  await until(
    async () =>
      (
        await app.main.eval<Array<{ role: string; content: string }>>(
          `window.api.message.list(${JSON.stringify(sid)})`
        )
      ).some((m) => m.role === 'assistant' && m.content === reply),
    `the seeded reply in ${sid}`
  )
}

async function emulate(
  client: CdpClient,
  metrics: typeof PHONE | typeof DESKTOP | null,
  touch: boolean
): Promise<void> {
  if (metrics) await client.send('Emulation.setDeviceMetricsOverride', metrics)
  else await client.send('Emulation.clearDeviceMetricsOverride')
  await client.send('Emulation.setTouchEmulationEnabled', { enabled: touch, maxTouchPoints: 5 })
}

/** 重载页面并等 web 客户端重新连上、React 重新挂上（重载前打的标记消失 = 真的换了一个文档） */
async function reload(client: CdpClient): Promise<void> {
  await client.eval(`(window.__mobBeforeReload = true)`)
  await client.send('Page.reload', {})
  await until(
    () =>
      client.eval<boolean>(
        `!window.__mobBeforeReload && window.api?.app?.platform === 'web' && document.readyState === 'complete'`
      ),
    'the web client reloaded'
  )
  await client.eval('window.api.app.getVersion()')
  await waitRendererReady(client)
}

/** 手机：390×844 + 触屏，重载，等壳与会话列表上屏 */
async function phone(): Promise<void> {
  await emulate(page(), PHONE, true)
  await reload(page())
  expect(
    await page().eval<boolean>(`matchMedia('(pointer: coarse)').matches`),
    'precondition: touch emulation makes the pointer coarse'
  ).toBe(true)
  await until(() => mobile().shellPresent(), 'the phone shell mounted')
  await listSettled()
}

/**
 * 会话列表落定：行都在、项目到货后的那一次「项目组缺省收起」也已经发生（之前点下去的行会在按下与松开之间挪位）
 */
async function listSettled(): Promise<void> {
  await until(async () => {
    const rows = await mobile().listRows()
    if (!rows.includes('MOB-temp')) return false
    return (
      (await mobile().listGroupExpanded(projects.main.name)) === false &&
      (await mobile().listGroupExpanded(projects.other.name)) === false
    )
  }, 'the phone session list settled')
}

/** 回到桌面大小（不重载：布局跟着媒体查询切） */
async function desktopView(): Promise<void> {
  await emulate(page(), null, false)
  await until(async () => !(await mobile().shellPresent()), 'back to the desktop layout')
}

/** 切到某个标签（已经是它就不点） */
async function toTab(key: WebMobileTab): Promise<void> {
  if ((await mobile().activeTab()) === key) return
  await mobile().tap({ tab: key })
  await until(async () => (await mobile().activeTab()) === key, `the ${key} tab`)
}

/** 推入对话页（真点会话列表里的一行）并等它上屏 */
async function openFromList(title: string): Promise<void> {
  await toTab('sessions')
  await mobile().tap({ sessionRow: title })
  await until(
    async () => (await mobile().chatOpen()) && (await mobile().chatTitle()) === title,
    `the chat page for ${title}`
  )
}

async function backToList(): Promise<void> {
  await mobile().tap({ chat: 'back' })
  await until(async () => !(await mobile().chatOpen()), 'the chat page closed')
}

beforeAll(async () => {
  app = await launchApp()
  await app.main.eval(`window.api.settings.set({ key: 'general.language', value: 'en' })`)
  provider = await startFakeProvider()
  const { providerId } = await seedFakeProvider(app.main, {
    baseUrl: provider.baseUrl,
    modelId: MODEL
  })
  await waitRendererReady(app.main)
  // M-21 的长名字模型（带上下文上限，用量环才画）—— 在打开 web 客户端之前加，它载入的模型目录里就有
  await app.main.eval(
    `(async () => {
      const args = ${JSON.stringify({ providerId, modelId: LONG })}
      await window.api.provider.addModel(args)
      const row = (await window.api.provider.listModels(args.providerId)).find((m) => m.modelId === args.modelId)
      if (!row) throw new Error('the long model row was not added')
      await window.api.provider.updateModelCapabilities({
        id: row.id,
        capabilities: { maxInputTokens: 200000, maxOutputTokens: 4096 }
      })
      return true
    })()`
  )

  const mainDir = join(app.home, 'mob-proj')
  mkdirSync(mainDir, { recursive: true })
  writeFileSync(join(mainDir, 'hello.txt'), 'hello from the phone\n')
  projects.main.id = (await createProject(app.main, { name: projects.main.name, path: mainDir })).id
  const otherDir = join(app.home, 'mob-proj2')
  mkdirSync(otherDir, { recursive: true })
  projects.other.id = (
    await createProject(app.main, { name: projects.other.name, path: otherDir })
  ).id

  const create = (title: string, projectId: string | null): Promise<string> =>
    app.main.eval<string>(
      `window.api.session.create(${JSON.stringify({ title, projectId })}).then((s) => s.id)`
    )
  sids.chat = await create('MOB-chat', projects.main.id)
  sids.temp = await create('MOB-temp', null)
  sids.doomed = await create('MOB-doomed', null)
  sids.narrow = await create('MOB-narrow', null)
  sids.think = await create('MOB-think', null)
  await seedReply(sids.chat, 'hello phone', 'MOB-REPLY')
  await seedReply(sids.temp, 'hello temp', 'MOB-TEMP-REPLY')
  // M-21：还没有运行时，选模型照常写得进去
  expect(
    await app.main.eval<{ success: boolean }>(
      `window.api.agent.setModel(${JSON.stringify({ sessionId: sids.narrow, provider: providerId, model: LONG })})`
    )
  ).toMatchObject({ success: true })
  // M-22：一轮一句话的思考、一轮五段的长思考
  await seedReply(sids.think, 'think briefly', 'MOB-THINK-1', THINK_SHORT)
  await seedReply(sids.think, 'think at length', 'MOB-THINK-2', THINK_LONG)

  writeBotMd(app, BOT, { displayName: 'Mob Bot' })

  // 一个最小的 widget（不引任何包）
  const widgetDir = join(app.home, '.shuvix', 'widgets', WIDGET_ID)
  mkdirSync(widgetDir, { recursive: true })
  writeFileSync(
    join(widgetDir, 'widget.json'),
    JSON.stringify(
      {
        id: WIDGET_ID,
        name: 'Mob Widget',
        description: 'phone layout e2e widget',
        entryFile: 'index.tsx',
        createdAt: Date.now()
      },
      null,
      2
    ) + '\n'
  )
  writeFileSync(
    join(widgetDir, 'index.tsx'),
    "const root = document.getElementById('root')\nif (root) root.textContent = 'MOB-WIDGET'\n"
  )

  do {
    P = await freePort()
  } while (P === 7766)
  expect(await setPort(P)).toMatchObject({ enabled: false, port: P, listening: false })
  expect(await setEnabled(true)).toMatchObject({ enabled: true, port: P, listening: true })

  web = await openWebClient(app, P)
  await until(async () => {
    const titles = await sidebarPane(page()).titles()
    return titles.includes('MOB-temp') && titles.includes('MOB-doomed')
  }, 'web sidebar lists the seeded sessions')
}, 180_000)

afterAll(async () => {
  if (app) for (const id of [...openedTabs]) await closeBrowserTab(app, id)
  if (web) await web.close().catch(() => undefined)
  await provider?.close().catch(() => undefined)
  await app?.stop()
})

describe('phone layout: which windows get it', () => {
  it('W-1 at 1280×800 without touch the web client is the desktop layout', async () => {
    expect(await mobile().shellPresent()).toBe(false)
    expect(await mobile().sidebarSettingsRow()).toBe(true)
    expect(await mobile().documentGroups()).toEqual(expect.arrayContaining(REGISTRY_GROUPS))
    // 后面 M-5 断「手机的对话横幅里没有 agent 胶囊」：同一条会话在桌面布局里是有的
    expect(await sidebarPane(page()).openSession('MOB-chat')).toBe(true)
    await until(() => mobile().agentChipAnywhere(), 'the agent chip in the desktop banner')
  })

  it('W-2 narrowing to 390 brings the shell without a reload; widening to 1280 takes it away', async () => {
    try {
      await page().eval(`(window.__mobNoReload = 'w2')`)
      await emulate(page(), { ...PHONE, mobile: false, deviceScaleFactor: 1 }, false)
      await until(() => mobile().shellPresent(), 'the shell at 390')
      await emulate(page(), DESKTOP, false)
      await until(async () => !(await mobile().shellPresent()), 'the desktop layout at 1280')
      expect(await mobile().sidebarSettingsRow()).toBe(true)
      expect(await page().eval<string>(`window.__mobNoReload ?? ''`)).toBe('w2')
    } finally {
      await emulate(page(), null, false)
    }
  })

  it('W-3 a short landscape screen is a phone only with touch', async () => {
    try {
      const landscape = { width: 844, height: 390, deviceScaleFactor: 2, mobile: true }
      await emulate(page(), landscape, true)
      await until(() => mobile().shellPresent(), 'the shell at 844×390 with touch')
      await emulate(page(), landscape, false)
      await until(async () => !(await mobile().shellPresent()), 'the desktop layout without touch')
      expect(await mobile().sidebarSettingsRow()).toBe(true)
    } finally {
      await emulate(page(), null, false)
    }
  })

  it('W-4 the web page carries the viewport meta', async () => {
    const res = await httpProbe({ port: P, path: '/', host: `127.0.0.1:${P}` })
    expect(res.status).toBe(200)
    const html = res.body?.toString('utf8') ?? ''
    const meta = /<meta\s+name="viewport"\s+content="([^"]*)"/.exec(html)
    expect(meta, 'a viewport meta in the HTML').not.toBeNull()
    const tokens = meta![1].split(',').map((t) => t.trim())
    expect(tokens).toEqual(
      expect.arrayContaining([
        'width=device-width',
        'viewport-fit=cover',
        'interactive-widget=resizes-content'
      ])
    )
    expect(await mobile().viewportMeta()).toBe(meta![1])
  })

  it('D-1 the desktop main window stays desktop under a 390-wide emulation', async () => {
    const desk = webMobilePane(app.main)
    try {
      // mobile: false —— 主窗口没有 viewport meta，移动模式会按 980px 的缺省布局视口排，就不窄了
      await emulate(app.main, { ...PHONE, mobile: false }, true)
      expect(await app.main.eval<number>('innerWidth')).toBe(390)
      // 媒体查询有一拍才变：留一小段让「本不该发生的切换」有机会发生
      await sleep(500)
      expect(await desk.shellPresent()).toBe(false)
      expect(await desk.sidebarSettingsRow()).toBe(true)
      expect(await desk.viewportMeta()).toBeNull()
    } finally {
      await emulate(app.main, null, false)
    }
  })

  it('D-2 the desktop settings window stays the side-nav layout under a 390-wide emulation', async () => {
    const settings = await app.openSettings('general')
    try {
      await waitRendererReady(settings)
      await emulate(settings, { ...PHONE, mobile: false }, true)
      expect(await settings.eval<number>('innerWidth')).toBe(390)
      const pane = webMobilePane(settings)
      const style = await until(() => pane.settingsRowStyle(), 'a settings row in the window')
      await sleep(500)
      expect(await pane.settingsStacked()).toBe(false)
      expect((await pane.settingsRowStyle())?.flexWrap ?? style.flexWrap).toBe('nowrap')
    } finally {
      await emulate(settings, null, false).catch(() => undefined)
      settings.close()
    }
  })
})

/**
 * 一条用例失败在半路时把壳收拾回「会话页、什么都没开」—— 不然它留下的抽屉 / 菜单 / 对话页会把后面每一条都盖住，
 * 失败点离真因很远。每一步都是「开着才收」，用例正常走完时什么都不做
 */
async function resetShell(): Promise<void> {
  if (!(await mobile().shellPresent())) return
  if (await webClientPane(page()).domMenu()) await mobile().pressEscape()
  const config = sessionConfigPane(page())
  if (await config.isOpen()) await config.close()
  if (await mobile().sheet()) {
    await mobile().tap({ sheetBackdrop: true })
    await until(async () => (await mobile().sheet()) === null, 'reset: the sheet closed')
  }
  if (await mobile().chatOpen()) await backToList()
  await toTab('sessions')
}

describe('phone layout: the shell', () => {
  beforeAll(async () => {
    await phone()
  }, 120_000)

  afterEach(async () => {
    await resetShell().catch(() => undefined)
  }, 60_000)

  it('M-1 four tabs, the sessions tab current, only the sessions page mounted', async () => {
    expect(await mobile().tabs()).toEqual([
      { key: 'sessions', label: en.mobile.tabSessions, current: true },
      { key: 'widgets', label: en.mobile.tabWidgets, current: false },
      { key: 'library', label: en.mobile.tabLibrary, current: false },
      { key: 'settings', label: en.mobile.tabSettings, current: false }
    ])
    expect(en.mobile.tabSessions).toBe('Chats')
    expect(await mobile().mountedPages()).toEqual(['sessions'])
    expect(await mobile().chatOpen()).toBe(false)
  })

  it('M-2 tabs mount lazily, visited ones stay mounted, an expanded project group survives a round trip', async () => {
    expect(await mobile().listGroupExpanded(projects.main.name)).toBe(false)
    await mobile().tap({ listGroupToggle: projects.main.name })
    await until(
      async () => (await mobile().listGroupExpanded(projects.main.name)) === true,
      'MobProj expanded'
    )
    const order = ['widgets', 'library', 'settings', 'sessions'] as const
    const seen = new Set<string>(['sessions'])
    for (const key of order) {
      await mobile().tap({ tab: key })
      await until(async () => (await mobile().activeTab()) === key, `tab ${key} current`)
      seen.add(key)
      const tabs = await mobile().tabs()
      expect(
        tabs.filter((t) => t.current).map((t) => t.key),
        key
      ).toEqual([key])
      const mounted = await mobile().mountedPages()
      expect([...mounted].sort(), key).toEqual([...seen].sort())
      const displays = await mobile().pageDisplays()
      for (const [k, display] of Object.entries(displays)) {
        expect(display === 'none', `${k} while ${key} is current`).toBe(k !== key)
      }
    }
    expect(await mobile().mountedPages()).toEqual(['sessions', 'widgets', 'library', 'settings'])
    expect(await mobile().listGroupExpanded(projects.main.name)).toBe(true)
  })

  it('M-3 the sessions page has only the session groups and no desktop chrome', async () => {
    const groups = await mobile().groupsIn('sessions')
    expect(new Set(groups)).toEqual(new Set(['section', 'project', 'temp']))
    expect(await mobile().desktopChromeIn('sessions')).toEqual({
      settingsRow: false,
      dragStrip: false
    })
  })

  it('M-4 the library page has exactly the six registry groups', async () => {
    expect(await mobile().groupsIn('library')).toEqual(REGISTRY_GROUPS)
  })

  it('M-5 a real tap on a row pushes the chat page and a marked history entry; no agent chip in its banner', async () => {
    const before = await mobile().history()
    expect(before.mark).toBe(false)
    await openFromList('MOB-chat')
    const chat = chatPane(page())
    await chat.ready()
    await until(async () => {
      const items = await chat.settledItems()
      return items.some((i) => i.role === 'assistant' && i.text === 'MOB-REPLY')
    }, 'the seeded reply on the chat page')
    expect(await mobile().tabsLayer()).toEqual({ ariaHidden: 'true', visibility: 'hidden' })
    expect(await mobile().history()).toEqual({ mark: true, length: before.length + 1 })
    expect(await mobile().chatAgentChip()).toBe(false)
    expect(await mobile().agentChipAnywhere()).toBe(false)
  })

  it('M-6 the back button pops the entry; history.back() closes the chat too, without a reload', async () => {
    await page().eval(`(window.__mobNoReload = 'm6')`)
    await openFromList('MOB-chat')
    expect((await mobile().history()).mark).toBe(true)
    await backToList()
    expect((await mobile().history()).mark).toBe(false)
    expect(await mobile().tabsLayer()).toEqual({ ariaHidden: 'false', visibility: 'visible' })

    await openFromList('MOB-chat')
    expect((await mobile().history()).mark).toBe(true)
    await page().eval(`(history.back(), true)`)
    await until(async () => !(await mobile().chatOpen()), 'history.back() closed the chat page')
    expect((await mobile().history()).mark).toBe(false)
    expect(await page().eval<string>(`window.__mobNoReload ?? ''`)).toBe('m6')
  })

  it('M-7 tapping the row of the already active session opens it again', async () => {
    await openFromList('MOB-chat')
    expect((await mobile().history()).mark).toBe(true)
    await backToList()
  })

  it('M-8 the calendar opens sessions (the active one too) and keeps its day and the list state across toggles', async () => {
    expect(await mobile().calendarToggleLabel()).toBe(en.mobile.calendar)
    expect(await mobile().calendarState()).toEqual({ mounted: false, visible: false })
    await mobile().tap({ sessions: 'calendarToggle' })
    await until(async () => (await mobile().calendarState()).visible, 'the calendar shown')
    expect(await mobile().calendarToggleLabel()).toBe(en.mobile.list)
    await until(async () => {
      const rows = await mobile().calendarRows()
      return rows.includes('MOB-temp') && rows.includes('MOB-chat')
    }, "today's sessions in the calendar")

    // 当天的另一条会话（不是活跃的）：点开
    await mobile().tap({ calendarRow: 'MOB-temp' })
    await until(
      async () => (await mobile().chatOpen()) && (await mobile().chatTitle()) === 'MOB-temp',
      'the chat page for MOB-temp from the calendar'
    )
    await backToList()
    expect((await mobile().calendarState()).visible).toBe(true)
    // 再点同一条（此刻它就是活跃会话）：照样推入
    await mobile().tap({ calendarRow: 'MOB-temp' })
    await until(
      async () => (await mobile().chatOpen()) && (await mobile().chatTitle()) === 'MOB-temp',
      'the active session reopened from the calendar'
    )
    await backToList()

    // 选另一天 → 切回列表 → 再切回日历：选中的日子还在；列表的展开状态也还在
    const today = await mobile().calendarSelectedDay()
    expect(today).not.toBeNull()
    const other = (await mobile().calendarDays()).find((d) => d !== today)
    expect(other, 'another day in this month').toBeDefined()
    await mobile().tap({ calendarDay: other! })
    await until(async () => (await mobile().calendarSelectedDay()) === other, `${other} selected`)
    await mobile().tap({ sessions: 'calendarToggle' })
    await until(async () => !(await mobile().calendarState()).visible, 'back to the list')
    expect(await mobile().calendarToggleLabel()).toBe(en.mobile.calendar)
    expect((await mobile().calendarState()).mounted).toBe(true)
    expect(await mobile().listGroupExpanded(projects.main.name)).toBe(true)
    await mobile().tap({ sessions: 'calendarToggle' })
    await until(async () => (await mobile().calendarState()).visible, 'the calendar again')
    expect(await mobile().calendarSelectedDay()).toBe(other)
    await mobile().tap({ sessions: 'calendarToggle' })
    await until(async () => !(await mobile().calendarState()).visible, 'the list again')
  })

  it('M-9 the new-chat sheet: temporary + every project; the backdrop creates nothing; a project creates one session there', async () => {
    await mobile().tap({ sessions: 'newChat' })
    const sheet = await until(() => mobile().sheet(), 'the new-chat sheet')
    expect(sheet.title).toBe(en.mobile.newChatIn)
    const targets = await mobile().newChatTargets()
    expect(targets[0]).toEqual({ id: '', label: en.mobile.tempChat })
    expect(new Set(targets.slice(1).map((t) => `${t.id}=${t.label}`))).toEqual(
      new Set([
        `${projects.main.id}=${projects.main.name}`,
        `${projects.other.id}=${projects.other.name}`
      ])
    )

    const countBefore = (await sessionsInMain()).length
    await mobile().tap({ sheetBackdrop: true })
    await until(async () => (await mobile().sheet()) === null, 'the sheet closed by its backdrop')
    // 关掉之后不该再有任何动作：留一小段让「本不该发生的创建」有机会发生
    await sleep(800)
    expect((await sessionsInMain()).length).toBe(countBefore)
    expect(await mobile().chatOpen()).toBe(false)

    await mobile().tap({ sessions: 'newChat' })
    await until(() => mobile().sheet(), 'the new-chat sheet again')
    const added = await newSessionsAfter(app.main, () =>
      mobile().tap({ newChatTarget: projects.other.id })
    )
    await until(() => mobile().chatOpen(), 'the new session pushed')
    await sleep(800)
    const after = await sessionsInMain()
    expect(after.length).toBe(countBefore + 1)
    expect(added).toHaveLength(1)
    expect(after.find((s) => s.id === added[0])?.projectId).toBe(projects.other.id)
    expect(await mobile().sheet()).toBeNull()
    await backToList()
  })

  it('M-10 a bot row in the library opens its notebook on the chat page; back lands on the library; re-tapping it reopens', async () => {
    await mobile().tap({ tab: 'library' })
    await until(async () => (await mobile().activeTab()) === 'library', 'the library tab')
    await botsPane(page()).expand()
    await until(async () => (await botsPane(page()).rows()).includes(BOT), 'the bot row')
    await mobile().tap({ botRow: BOT })
    await until(
      async () => (await mobile().chatOpen()) && (await mobile().chatNotebook()),
      'the bot notebook on the chat page'
    )
    await backToList()
    expect(await mobile().activeTab()).toBe('library')
    expect((await mobile().pageDisplays()).library).not.toBe('none')
    // 此刻它正是活跃会话：再点一次照样推回对话页
    await mobile().tap({ botRow: BOT })
    await until(
      async () => (await mobile().chatOpen()) && (await mobile().chatNotebook()),
      'the bot notebook again after re-tapping the active row'
    )
    await backToList()
    await mobile().tap({ tab: 'sessions' })
    await until(async () => (await mobile().activeTab()) === 'sessions', 'the sessions tab')
  })

  it('M-11 the chat page has none of the desktop header buttons; the title opens the session config', async () => {
    await openFromList('MOB-chat')
    expect(await mobile().desktopHeaderControls()).toEqual({
      openBrowserWindow: false,
      sideToggles: 0
    })
    const config = sessionConfigPane(page())
    expect(await config.isOpen()).toBe(false)
    await mobile().tap({ chat: 'title' })
    await config.waitOpen()
    expect(await config.titleValue()).toBe('MOB-chat')
    await config.close()
  })

  it('M-12 the files sheet lists hello.txt and closes on its backdrop; the tasks sheet is the empty state', async () => {
    await openFromList('MOB-chat')
    await mobile().tap({ chat: 'files' })
    const listed = await until(async () => {
      const paths = await mobile().sheetFiles()
      return paths.some((p) => p === 'hello.txt' || p.endsWith('/hello.txt')) ? paths : null
    }, 'hello.txt in the files sheet')
    expect(listed.filter((p) => p.endsWith('hello.txt'))).toHaveLength(1)
    expect((await mobile().sheet())?.title).toBe(en.mobile.files)
    await mobile().tap({ sheetBackdrop: true })
    await until(async () => (await mobile().sheet()) === null, 'the files sheet closed')

    await mobile().tap({ chat: 'tasks' })
    const tasks = await until(() => mobile().sheet(), 'the tasks sheet')
    expect(tasks.title).toBe(en.mobile.tasks)
    expect(await until(() => mobile().tasksEmpty(), 'the empty tasks state')).toBe(
      en.mobile.noTasks
    )
    await mobile().tap({ sheetBackdrop: true })
    await until(async () => (await mobile().sheet()) === null, 'the tasks sheet closed')
    expect(await mobile().chatOpen()).toBe(true)
    await backToList()
  })

  it('M-13 deleting the session from its config closes the chat, drops the row and pops the history mark', async () => {
    await openFromList('MOB-doomed')
    expect((await mobile().history()).mark).toBe(true)
    await mobile().tap({ chat: 'title' })
    const config = sessionConfigPane(page())
    await config.waitOpen()
    expect(await config.titleValue()).toBe('MOB-doomed')
    await config.clickDelete()
    await until(async () => !(await mobile().chatOpen()), 'the chat page closed after the delete')
    await until(
      async () => !(await mobile().listRows()).includes('MOB-doomed'),
      'the row gone from the list'
    )
    expect((await sessionsInMain()).some((s) => s.id === sids.doomed)).toBe(false)
    expect((await mobile().history()).mark).toBe(false)
    expect(await config.isOpen()).toBe(false)
  })

  it('M-14 a widget card opens in a new tab on a tap; a long press shows the card menu', async () => {
    const cards = widgetPanelPane(page())
    await mobile().tap({ tab: 'widgets' })
    await until(async () => (await cards.cardIds()).includes(WIDGET_ID), 'the widget card')
    const tabUrl = `http://127.0.0.1:${P}/#widget-window?widgetId=${WIDGET_ID}`
    await mobile().tap({ widgetCard: WIDGET_ID })
    const tab = await waitBrowserTab(app, (u) => u === tabUrl, 'the #widget-window tab')
    openedTabs.add(tab.id)
    expect(await cards.panelApps()).toEqual([])
    expect(await cards.foregroundApp()).toBeNull()
    await closeBrowserTab(app, tab.id)
    openedTabs.delete(tab.id)

    const tabsBefore = (await browserTabs(app)).map((t) => t.id).sort()
    await mobile().longPress({ widgetCard: WIDGET_ID }, 800)
    const menu = await until(() => webClientPane(page()).domMenu(), 'the card menu')
    const labels = menu.map((m) => m.label)
    expect(labels).not.toContain(en.widgets.openInPanel)
    // 「停止」在不在取决于那个标签页把它注册上了没有；除此之外恰是这四项（也就没有整理图标）
    expect(labels.filter((l) => l !== en.widgets.stop)).toEqual([
      en.widgets.openInWindow,
      en.widgets.exportAsVite,
      en.widgets.archive,
      en.widgets.delete
    ])
    await sleep(500)
    expect((await browserTabs(app)).map((t) => t.id).sort()).toEqual(tabsBefore)
    expect(await cards.panelApps()).toEqual([])
    await mobile().pressEscape()
    await until(async () => (await webClientPane(page()).domMenu()) === null, 'the menu closed')
  })

  it('M-14b a tap on the top-right corner of a card opens it like a tap in the middle (no hidden hover buttons)', async () => {
    const cards = widgetPanelPane(page())
    const registered = async (): Promise<string[]> =>
      (await app.main.eval<{ registeredIds?: string[] }>('window.api.widget.getServerStatus()'))
        .registeredIds ?? []
    // afterEach 的 resetShell 把壳放回了会话页
    await toTab('widgets')
    await until(async () => (await cards.cardIds()).includes(WIDGET_ID), 'the widget card')
    const tabUrl = `http://127.0.0.1:${P}/#widget-window?widgetId=${WIDGET_ID}`
    // 那一点正是悬浮按钮（删除）所在的地方：按钮在触屏上不接点击，点下去的是卡片
    expect(await cards.cornerButton(WIDGET_ID)).not.toBeNull()
    const tabsBefore = (await browserTabs(app)).map((t) => t.id)
    await mobile().tap({ widgetCardCorner: WIDGET_ID })
    const tab = await waitBrowserTab(
      app,
      (u) => u === tabUrl,
      'the #widget-window tab from the corner'
    )
    openedTabs.add(tab.id)
    expect(tabsBefore).not.toContain(tab.id)
    // 那个标签页把它注册上了，之后没有被停掉
    await until(async () => (await registered()).includes(WIDGET_ID), 'the widget registered')
    await sleep(300)
    expect((await confirmPane(page()).snapshot()).open).toBe(false)
    expect(
      await app.main.eval<string[]>(
        'window.api.widget.listArchived().then((l) => l.map((w) => w.id))'
      )
    ).not.toContain(WIDGET_ID)
    expect(
      await app.main.eval<string[]>('window.api.widget.list().then((l) => l.map((w) => w.id))')
    ).toContain(WIDGET_ID)
    expect(await registered()).toContain(WIDGET_ID)
    expect(await cards.panelApps()).toEqual([])
    await closeBrowserTab(app, tab.id)
    openedTabs.delete(tab.id)
  })

  it('M-15 settings: the section list, a section with a back button and wrapping rows, the agents monitor section', async () => {
    await mobile().tap({ tab: 'settings' })
    const list = await until(async () => {
      const tabs = await mobile().settingsTabs()
      return tabs.length > 0 ? tabs : null
    }, 'the settings section list')
    expect(list.map((t) => t.id)).toEqual([
      'general',
      'providers',
      'tools',
      'mcp',
      'voice',
      'telegramBots',
      'monitor',
      'archived',
      'about',
      'agents'
    ])
    expect(en.experimental.tag).toBe('Beta')
    expect(Object.fromEntries(list.map((t) => [t.id, t.experimental]))).toMatchObject({
      general: null,
      voice: en.experimental.tag,
      telegramBots: en.experimental.tag,
      agents: null
    })
    expect(list.filter((t) => t.experimental).map((t) => t.id)).toEqual(['voice', 'telegramBots'])
    expect(list.find((t) => t.id === 'general')?.label).toBe(en.settings.tabGeneral)
    expect(await mobile().settingsBackButton()).toBeNull()

    await mobile().tap({ settingsTab: 'general' })
    await until(
      async () => (await mobile().settingsHeader()) === en.settings.tabGeneral,
      'the General section'
    )
    expect(await mobile().settingsBackButton()).toEqual({
      text: en.settings.title,
      ariaLabel: en.settings.title
    })
    expect(await mobile().settingsTabs()).toEqual([])
    const row = await until(() => mobile().settingsRowStyle(), 'a settings row in General')
    expect(row.flexWrap).toBe('wrap')
    expect(parseFloat(row.titleMinWidth)).toBeCloseTo(9 * parseFloat(row.titleFontSize), 1)

    await mobile().tap({ settingsBack: true })
    await until(async () => (await mobile().settingsTabs()).length === 10, 'the list again')
    expect(await mobile().settingsHeader()).toBeNull()

    await mobile().tap({ settingsTab: 'agents' })
    await until(async () => (await mobile().settingsHeader()) === en.panel.agents, 'Agents')
    expect(en.panel.agents).toBe('Agents')
    await mobile().tap({ settingsBack: true })
    await until(async () => (await mobile().settingsTabs()).length === 10, 'the list again')
    await mobile().tap({ tab: 'sessions' })
    await until(async () => (await mobile().activeTab()) === 'sessions', 'the sessions tab')
  })

  it('M-16 #settings/general on a phone opens the section directly; #settings is the list; 1280 is not stacked', async () => {
    const url = `http://127.0.0.1:${P}/#settings/general`
    const tabId = await app.main.eval<string>(
      `window.api.browserView.createTab(${JSON.stringify(url)})`
    )
    openedTabs.add(tabId)
    const settings = await until(
      () => connectTabPage(app.port, (u) => u === url),
      'the #settings/general tab'
    )
    try {
      await until(
        () => settings.eval<boolean>(`window.api?.app?.platform === 'web'`),
        'the settings tab is the web client'
      )
      await waitRendererReady(settings)
      const pane = webMobilePane(settings)
      await emulate(settings, PHONE, true)
      await reload(settings)
      await until(
        async () => (await pane.settingsHeader()) === en.settings.tabGeneral,
        'straight into General'
      )
      expect(await pane.settingsBackButton()).not.toBeNull()
      expect(await pane.shellPresent()).toBe(false)
      await pane.tap({ settingsBack: true })
      const list = await until(async () => {
        const tabs = await pane.settingsTabs()
        return tabs.length > 0 ? tabs : null
      }, 'the section list after Back')
      expect(list[0].id).toBe('general')
      expect(list.some((t) => t.id === 'agents')).toBe(false)

      await settings.eval(`(location.hash = '#settings', true)`)
      await reload(settings)
      await until(async () => (await pane.settingsTabs()).length > 0, '#settings opens the list')
      expect(await pane.settingsBackButton()).toBeNull()

      await emulate(settings, null, false)
      await until(async () => !(await pane.settingsStacked()), 'not stacked at 1280')
    } finally {
      settings.close()
      await closeBrowserTab(app, tabId)
      openedTabs.delete(tabId)
    }
  })

  it('M-17 real touches: a hold is a menu (once), a tap opens, a 30px move cancels, a 5px move does not; library agents too', async () => {
    const pane = mobile()
    const dom = webClientPane(page())
    expect(await pane.activeTab()).toBe('sessions')
    await pane.installContextMenuCounter()

    await pane.longPress({ sessionRow: 'MOB-temp' }, 800)
    await until(() => dom.domMenu(), 'the row menu after a hold')
    await sleep(300)
    expect(await pane.chatOpen()).toBe(false)
    expect(await pane.contextMenuCount()).toBe(1)
    await pane.pressEscape()
    await until(async () => (await dom.domMenu()) === null, 'the menu closed')

    // 关掉菜单之后的下一次轻点照常推入
    await pane.tap({ sessionRow: 'MOB-temp' }, { holdMs: 100 })
    await until(() => pane.chatOpen(), 'a 100ms tap opens the chat')
    await backToList()

    await pane.installContextMenuCounter()
    await pane.longPress({ sessionRow: 'MOB-temp' }, 800, { dx: 30, dy: 0 })
    await sleep(500)
    expect(await dom.domMenu()).toBeNull()
    expect(await pane.contextMenuCount()).toBe(0)

    await pane.longPress({ sessionRow: 'MOB-temp' }, 800, { dx: 5, dy: 0 })
    await until(() => dom.domMenu(), 'the row menu after a 5px wobble')
    expect(await pane.contextMenuCount()).toBe(1)
    expect(await pane.chatOpen()).toBe(false)
    await pane.pressEscape()
    await until(async () => (await dom.domMenu()) === null, 'the menu closed again')
    await pane.tap({ sessionRow: 'MOB-temp' })
    await until(() => pane.chatOpen(), 'the next tap opens the chat')
    await backToList()

    // 资料库里内置智能体的行：按住 → 它的菜单（创建覆盖副本）
    await pane.tap({ tab: 'library' })
    await until(async () => (await pane.activeTab()) === 'library', 'the library tab')
    const agents = agentsSidebarPane(page())
    await agents.expand()
    const builtin = await until(async () => {
      const rows = await agents.builtinRows()
      return rows.length > 0 ? rows[0] : null
    }, 'a builtin agent row')
    await pane.longPress({ agentBuiltinRow: builtin.name }, 800)
    const menu = await until(() => dom.domMenu(), 'the builtin agent row menu')
    expect(menu.map((m) => m.label)).toContain(en.tool.subAgentCreateOverride)
    expect(await pane.chatOpen()).toBe(false)
    await pane.pressEscape()
    await until(async () => (await dom.domMenu()) === null, 'the agent menu closed')
    await pane.tap({ tab: 'sessions' })
    await until(async () => (await pane.activeTab()) === 'sessions', 'the sessions tab')
  })

  it('M-18 focus mode (on by default) dims nothing in the shell; the desktop layout dims', async () => {
    await openFromList('MOB-chat')
    await backToList()
    expect(await mobile().dimmedCount('shell')).toBe(0)
    try {
      await desktopView()
      await until(
        async () => (await mobile().dimmedCount('document')) > 0,
        'focus mode dims the desktop sidebar'
      )
    } finally {
      await phone()
    }
  })

  it('M-19 16px composer in the shell (not at 1280); session rows keep the sidebar rhythm', async () => {
    // M-18 重载过：项目组又是收起的，输入框这一半用临时组里的那一条
    await openFromList('MOB-temp')
    await chatPane(page()).ready()
    expect(await mobile().composerFontSize()).toBe('16px')
    await backToList()

    // 会话行、项目组头、「项目知识库」文件夹行同一个高度（手机上不再单独加高会话行）
    await mobile().tap({ listGroupToggle: projects.main.name })
    await until(
      async () => (await mobile().listGroupExpanded(projects.main.name)) === true,
      'MobProj expanded'
    )
    // 展开动画走完、三行都上屏且连着两次量到同样的数
    let prev = ''
    const rhythm = await until(async () => {
      const r = await mobile().listGroupRhythm(projects.main, 'MOB-chat')
      if (r.header === null || r.knowledge === null || r.row === null) return null
      const key = JSON.stringify(r)
      if (key !== prev) {
        prev = key
        return null
      }
      return { header: r.header, knowledge: r.knowledge, row: r.row }
    }, 'the MobProj header, its knowledge folder and the MOB-chat row measured')
    expect(Math.abs(rhythm.row - rhythm.header), JSON.stringify(rhythm)).toBeLessThanOrEqual(2)
    expect(Math.abs(rhythm.row - rhythm.knowledge), JSON.stringify(rhythm)).toBeLessThanOrEqual(2)
    expect(Math.abs(rhythm.header - rhythm.knowledge), JSON.stringify(rhythm)).toBeLessThanOrEqual(
      2
    )
    expect(rhythm.row).toBeLessThan(30)
    const phoneTemp = await mobile().sessionRowHeight('MOB-temp', 'list')
    expect(phoneTemp).not.toBeNull()

    await desktopView()
    await chatPane(page()).ready()
    const desktopFont = await mobile().composerFontSize()
    expect(desktopFont).not.toBeNull()
    expect(desktopFont).not.toBe('16px')
    // 桌面侧栏里同一条会话行：与手机上一样高
    const desktopTemp = await until(
      () => mobile().sessionRowHeight('MOB-temp', 'document'),
      'the MOB-temp row in the desktop sidebar'
    )
    expect(Math.abs(desktopTemp - phoneTemp!)).toBeLessThanOrEqual(1)
  })

  it('M-20 popstate closes the chat only onto an unmarked entry; a mark left behind by a reload is cleared', async () => {
    await phone()
    await openFromList('MOB-temp')
    // 退回到的那一条还带着标记（页面里的前进 / 后退）：对话页还该开着
    await page().eval(`(history.pushState({ shuvixMobileChat: true }, ''), true)`)
    await page().eval(`(history.back(), true)`)
    await until(async () => (await mobile().history()).mark, 'back on the marked entry')
    await sleep(500)
    expect(await mobile().chatOpen()).toBe(true)
    await backToList()
    expect((await mobile().history()).mark).toBe(false)

    // 对话页开着时重载：那条带标记的历史还在、对话页已经不在 —— 标记摘掉，之后不用多退一次
    await openFromList('MOB-temp')
    expect((await mobile().history()).mark).toBe(true)
    await reload(page())
    await until(() => mobile().shellPresent(), 'the shell after the reload')
    expect(await mobile().chatOpen()).toBe(false)
    expect((await mobile().history()).mark).toBe(false)
    await listSettled()
    await openFromList('MOB-temp')
    await backToList()
    expect((await mobile().history()).mark).toBe(false)
  })

  it('M-21 a 360-wide card keeps send / queue / stop inside; the model name gives way', async () => {
    const chat = chatPane(page())
    const layout = (): Promise<ComposerLayoutShot | null> => mobile().composerLayout(LONG)
    try {
      await emulate(page(), NARROW, true)
      await until(
        async () => (await page().eval<number>('innerWidth')) === NARROW.width,
        'the page at 360 wide'
      )
      expect(await mobile().shellPresent()).toBe(true)
      await openFromList('MOB-narrow')
      await chat.ready()

      // 空闲（还没有运行时：两个选择器都没上锁）
      const idle = await until(async () => {
        const s = await layout()
        return s?.modelName && s.send && s.ring ? s : null
      }, 'the idle composer showing the long model')
      expect(idle.locks).toEqual({ model: false, tools: false })
      expectInside(idle.send, idle.card, 'send (idle)')
      expectTruncated(idle.modelName, 'the model name (idle)')

      // 运行中：等到两个队列出口、停止键都在，且两个选择器都上了锁（最挤的样子）
      provider.script({ text: 'MOB-NARROW-REPLY', holdMs: 20_000, usage: USAGE })
      await chat.typeAndSend('narrow ask')
      const running = await until(async () => {
        if (!(await chat.isBusy())) return null
        const s = await layout()
        return s && s.queue.length === 2 && s.stop && s.locks.model && s.locks.tools ? s : null
      }, 'the running composer: two queue tiers, stop, both pickers locked')
      const what = JSON.stringify(widthsOf(running))
      // 工具行窄于 26rem：两个出口只剩图标，字还在 aria-label / title 上
      expect(running.toolbarWidth, what).toBeLessThan(26 * 16)
      expect(running.queue.map((q) => q.tier)).toEqual(['steer', 'followUp'])
      for (const q of running.queue) {
        const tier = q.tier as 'steer' | 'followUp'
        expect(q.labelDisplay, `${tier} label`).toBe('none')
        expect(q.ariaLabel).toBe(en.queue[tier])
        expect(q.title).toBe(en.queue[`${tier}Hint`])
        expectInside(q.box, running.card, `queue ${tier}`)
        expect(q.scrollWidth, `queue ${tier} not clipped`).toBeLessThanOrEqual(q.clientWidth)
      }
      expectInside(running.stop, running.card, 'stop')
      expect(running.stop!.width).toBeGreaterThanOrEqual(20)
      expectInside(running.ring, running.card, 'the context ring')
      expect(running.ring!.width).toBeCloseTo(15, 0)
      // 谁都不压到谁身上：扩展选择器在用量环那一格左边，模型触发器在扩展选择器左边
      expect(running.toolPicker, what).not.toBeNull()
      expect(running.modelTrigger, what).not.toBeNull()
      const ringLeft = (running.ringItem ?? running.ring)!.left
      expect(running.toolPicker!.right, what).toBeLessThanOrEqual(ringLeft + 0.5)
      expect(running.modelTrigger!.right, what).toBeLessThanOrEqual(running.toolPicker!.left + 0.5)
      expectInside(running.modelTrigger, running.card, 'the model trigger')
      expect(running.modelName!.box.width, what).toBeLessThan(120)
      expectTruncated(running.modelName, 'the model name (running)')
      expect(running.page.docScrollWidth).toBeLessThanOrEqual(running.page.innerWidth)
      expect(running.page.shellScrollWidth).not.toBeNull()
      expect(running.page.shellScrollWidth!).toBeLessThanOrEqual(running.page.shellClientWidth!)

      // 跑完：发送键回来，仍在卡片里（这时两个锁都在，是更挤的空闲态）
      provider.release()
      await chat.waitIdle()
      const after = await until(async () => {
        const s = await layout()
        return s?.send && s.locks.model && s.locks.tools ? s : null
      }, 'the idle composer after the run, both pickers locked')
      expectInside(after.send, after.card, 'send (after the run)')
      expectInside(after.ring, after.card, 'the context ring (after the run)')
      expect(after.toolPicker!.right).toBeLessThanOrEqual(
        (after.ringItem ?? after.ring)!.left + 0.5
      )
      expect(after.modelTrigger!.right).toBeLessThanOrEqual(after.toolPicker!.left + 0.5)
      expectTruncated(after.modelName, 'the model name (after the run)')

      // 1280 宽：模型名封顶 120px、不缩；运行中队列出口带字
      await desktopView()
      await chat.ready()
      const wide = await until(async () => {
        const s = await layout()
        return s?.modelName && s.send ? s : null
      }, 'the desktop composer showing the long model')
      expect(wide.modelName!.box.width).toBeCloseTo(120, 0)
      provider.script({ text: 'MOB-WIDE-REPLY', holdMs: 20_000, usage: USAGE })
      await chat.typeAndSend('wide ask')
      const wideRunning = await until(async () => {
        if (!(await chat.isBusy())) return null
        const s = await layout()
        return s && s.queue.length === 2 ? s : null
      }, 'the desktop composer running')
      expect(wideRunning.toolbarWidth).toBeGreaterThanOrEqual(26 * 16)
      for (const q of wideRunning.queue) {
        const tier = q.tier as 'steer' | 'followUp'
        expect(q.labelDisplay, `${tier} label at 1280`).not.toBe('none')
        expect(q.labelText).toBe(en.queue[tier])
        expectInside(q.box, wideRunning.card, `queue ${tier} at 1280`)
      }
      provider.release()
      await chat.waitIdle()
    } finally {
      provider.release()
      await phone()
    }
  })

  it('M-22 a long multi-paragraph thought collapses to one line and reserves nothing below it', async () => {
    const chat = chatPane(page())
    await openFromList('MOB-think')
    await chat.ready()
    await until(async () => {
      const replies = (await chat.settledItems())
        .filter((i) => i.role === 'assistant')
        .map((i) => i.text)
      return (
        replies.includes('MOB-THINK-1') &&
        replies.includes('MOB-THINK-2') &&
        (await chat.thinkingBlocks()) === 2
      )
    }, 'both thinking cards on the chat page')
    const shotOf = async (reply: string): Promise<ThinkingBlockShot | null> =>
      (await mobile().thinkingShots()).find((t) => t.reply === reply) ?? null

    // 连着两次量到同样的数（列表落位、字体载入之后）
    let prev = ''
    const [short, long] = await until(async () => {
      const a = await shotOf('MOB-THINK-1')
      const b = await shotOf('MOB-THINK-2')
      // Virtuoso 把列表藏着（visibility: hidden）直到落到初始位置：落位之前量的不是用户看到的
      if (!a?.visible || !b?.visible) return null
      const key = JSON.stringify([a, b])
      if (key !== prev) {
        prev = key
        return null
      }
      return [a, b] as const
    }, 'both thinking blocks on screen and measured')
    const what = JSON.stringify({
      short,
      long: { ...long, innerText: long.innerText.slice(0, 40) }
    })
    expect(short.expanded).toBe(false)
    expect(long.expanded).toBe(false)
    expect(Math.abs(long.height - short.height), what).toBeLessThanOrEqual(1)
    expect(long.height, what).toBeLessThanOrEqual(30)
    expect(short.gap, what).not.toBeNull()
    expect(long.gap, what).not.toBeNull()
    // 回归点：折叠的长思考下面不留位
    expect(Math.abs(long.gap! - short.gap!), what).toBeLessThanOrEqual(1)
    expect(long.whiteSpace).toBe('nowrap')
    expect(long.textOverflow).toBe('ellipsis')
    expect(long.scrollWidth, what).toBeGreaterThan(long.clientWidth)

    await mobile().clickThinking('MOB-THINK-2')
    const open = await until(async () => {
      const t = await shotOf('MOB-THINK-2')
      return t?.expanded && t.visible ? t : null
    }, 'the long thought expanded')
    expect(open.height).toBeGreaterThan(3 * short.height)
    expect(open.innerText.startsWith('Paragraph 1 opens here'), open.innerText.slice(0, 60)).toBe(
      true
    )
    expect(open.innerText.endsWith('until paragraph 5 closes.'), open.innerText.slice(-60)).toBe(
      true
    )
    expect(open.innerText).toContain('\n\n')

    await mobile().clickThinking('MOB-THINK-2')
    const closed = await until(async () => {
      const t = await shotOf('MOB-THINK-2')
      return t && !t.expanded && t.visible ? t : null
    }, 'the long thought collapsed again')
    expect(Math.abs(closed.height - short.height)).toBeLessThanOrEqual(1)
  })
})

/** b 整个落在 card 里（±0.5px） */
function expectInside(b: BoxShot | null, card: BoxShot, what: string): void {
  expect(b, `${what} on screen`).not.toBeNull()
  const msg = `${what} ${JSON.stringify(b)} inside the card ${JSON.stringify(card)}`
  expect(b!.left, msg).toBeGreaterThanOrEqual(card.left - 0.5)
  expect(b!.right, msg).toBeLessThanOrEqual(card.right + 0.5)
  expect(b!.top, msg).toBeGreaterThanOrEqual(card.top - 0.5)
  expect(b!.bottom, msg).toBeLessThanOrEqual(card.bottom + 0.5)
}

function expectTruncated(name: ComposerLayoutShot['modelName'], what: string): void {
  expect(name, `${what} on screen`).not.toBeNull()
  expect(name!.scrollWidth, `${what} is truncated`).toBeGreaterThan(name!.clientWidth)
}

/** 失败信息里带上的宽度（取整到 0.1px） */
function widthsOf(s: ComposerLayoutShot): Record<string, number | null> {
  const w = (b: BoxShot | null): number | null => (b ? Math.round(b.width * 10) / 10 : null)
  return {
    card: w(s.card),
    toolbar: Math.round(s.toolbarWidth * 10) / 10,
    modelTrigger: w(s.modelTrigger),
    modelName: s.modelName ? w(s.modelName.box) : null,
    toolPicker: w(s.toolPicker),
    ringItem: w(s.ringItem),
    queueSteer: s.queue[0] ? w(s.queue[0].box) : null,
    queueFollowUp: s.queue[1] ? w(s.queue[1].box) : null,
    stop: w(s.stop)
  }
}
