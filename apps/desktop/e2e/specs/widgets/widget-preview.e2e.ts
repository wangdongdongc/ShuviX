/**
 * `widget` 工具的 `preview`（2026-10-17 起；2026-10-27 从 `shuvix widget preview` 搬进工具）—— agent 自查排版：在从不显示、
 * 不可聚焦的窗口里按面板 380×760 / 独立窗口 1280×800 / 手机 390×780（触屏 + 移动视口）渲染一个小组件，各截一张 CSS 像素的 PNG
 * 写进会话的 `tool_results/<sid>/widget-preview/<id>-<size>.png`，图片直接放进工具结果（模型看得到），页面报的错误放在
 * `<errors>` 里。不弹窗、不抢焦点、不计打开。
 *
 * 一个真的 isolated 实例 + 脚本化的假提供商：每一步是一轮「模型调 `widget` 工具 → 收尾正文」（按这一轮的提示词认领）。
 * 会话第一次碰一个组件时 ask-on-widget-access 会问（预览要读、构建要读写）：spec 替用户点「允许，并记住：可以读写这个组件」，
 * 记下问了哪些（PV-E12 核对）。「从没显示过、从没聚焦过」看 bootstrap.cjs 记的窗口事件（e2e-windows.log）；窗口在不在看 CDP 的
 * /json；像素经 figureFixtures 的 rasterFacts 在主窗里画回画布读（按主色判，不比精确值：P3 / 高分屏上的截图会略有偏色）。
 * 弹框、打印、下载、mailto、定位一律不进 e2e（守卫一旦回退，那些会在开发者屏幕上弹出系统界面）—— 由单测覆盖。
 *
 *   PV-E9  参数不对：认不得的尺寸 / 主题被工具的参数表拒（那一轮的工具结果是错误）、没有 id / 找不到 / 非法 id 各一句；
 *          都没问、没注册、没截图、没开窗
 *   PV-E1  缺省三种尺寸：结果里三段「<size> (<w>×<h>, app theme):」+ 图、没有 errors；模型那边收到的恰是这三张图；PNG 尺寸 =
 *          视口（右下角的块正落在图的角上）、路径在会话目录、不计打开、窗口都没了、三扇窗从没显示 / 聚焦过且都关了；
 *          第一次碰这个组件问了一次（读，操作 preview）
 *   PV-E2  手机是触屏 + 移动视口（pointer: coarse、hover: none、maxTouchPoints > 0），面板与窗口是鼠标；dpr 都是 1
 *   PV-E3  `theme` 强制颜色方案、缺省跟应用的主题；同一尺寸覆盖同一个文件；重复的尺寸只截一次
 *   PV-E5  运行时异常与 console.error 带回 errors（每个尺寸一份、不重复），照样截图
 *   PV-E6  没注册、构建不过 → 没有图、一句「先 build」、没开窗、不计打开
 *   PV-E4  已注册的预览的是上一次构建，不是源码；工具的 `build` 之后才变
 *   PV-E7  已注册但上一次构建失败（B2）→ `build` 的结果是错误、预览没有图、一句「先 build」
 *   PV-E8  页面出不去：弹窗被拒、导航到别处被拦、通知权限被拒；夹具服务器一个请求都没收到；只建了一扇窗
 *   PV-E11 两条会话同时预览：各自的结果、互不串
 *   PV-E12 应用活着、没有未捕获异常、没留下窗口、所有预览窗都没显示过、没弹原生框、没交给系统打开任何东西；问过的恰是每条会话
 *          第一次碰的那几个组件
 *
 * 搬进工具时去掉的：CLI 的 PV-E10（没有会话 → 系统临时目录里新建的目录）—— 工具总在一条会话里跑，那条路走不到了；PV-E3 里
 * 「尺寸名大小写不论」—— 参数表只收小写的尺寸名，大写的到不了工具（PV-E9 的拒绝就是这一条）。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  launchApp,
  uncaughtExceptions,
  windowEvents,
  windowsOf,
  type E2EApp,
  type WindowEvent,
  type WindowHistory
} from '../../harness/launch'
import { listTargets, until } from '../../harness/cdp'
import { startFixtureServer, type FixtureServer } from '../../harness/browserFixtures'
import { pngSize, rasterFacts } from '../../harness/figureFixtures'
import { externalOpens } from '../../harness/providerOAuthFixtures'
import { nativeDialogRequests } from '../../harness/networkFixtures'
import {
  startFakeProvider,
  userTextsOf,
  type FakeProvider,
  type FakeRequest
} from '../../harness/fakeProvider'
import { seedFakeProvider, waitRendererReady } from '../../harness/seed'
import { syncProbe, toolResultsIn, type SyncProbe, type ToolResult } from '../../harness/sync'

type Size = 'panel' | 'window' | 'phone'
const ALL: Size[] = ['panel', 'window', 'phone']
const DIMS: Record<Size, { width: number; height: number }> = {
  panel: { width: 380, height: 760 },
  window: { width: 1280, height: 800 },
  phone: { width: 390, height: 780 }
}

interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

const MODEL = 'e2e-model'
const USAGE = { prompt: 120, completion: 8 }
const IT_TIMEOUT = 180_000
/** 一轮（含第一次碰组件时那张卡、三种尺寸的截图）的上限 */
const RUN_TIMEOUT = 120_000
/** 预览窗口导航到的地址：widget 服务器上某个 pv-* 小组件自己的地址（给了 theme 的预览带 shuvix-scheme，页面骨架照它强制明暗） */
const PREVIEW_URL =
  /^http:\/\/127\.0\.0\.1:\d+\/w\/(pv-[a-z0-9-]+)\/(?:\?shuvix-scheme=(?:light|dark))?$/
/** 「先 build」那一句（widgetPreviewService） */
const DOES_NOT_BUILD = 'the widget does not build: build it and fix buildErrors first'
/** pi-ai 把工具结果里的图另起一条用户消息发给模型，开头是这一句（它不是用户说的话） */
const ATTACHED = 'Attached image(s) from tool result:'

let app: E2EApp
let fx: FixtureServer
let provider: FakeProvider
let probe: SyncProbe
let sid = ''
let sid2 = ''
let seq = 0
let themeBefore: unknown = null
/** 起来之后的页面 target（主窗口等）：每次预览之后都要回到这一份 */
let baseline: string[] = []

/** spec 替用户答过的组件询问（每条会话第一次碰一个组件时那一张） */
const asked: Array<{ session: string; widgetId: string; access: string; operation: string }> = []
/** 冒出来的、不是组件询问的卡（不该有）：轮询里不能抛（until 吞错误），记下来在外面抛 */
const strayAsks: string[] = []

// ─── 小组件夹具（纯 DOM，不用 React） ─────────────────────────────

const RED_BLOCK =
  '<div style="position:fixed;left:0;top:0;width:100px;height:40px;background:rgb(255,0,0)"></div>'
const GREEN_CORNER =
  '<div style="position:fixed;right:0;bottom:0;width:20px;height:20px;background:rgb(0,255,0)"></div>'

/**
 * 红块在左上、绿块钉在视口右下角、一行字。字用 padding 不用 margin：margin 会穿过 #root 折叠出去，页面比视口高一截，
 * 鼠标尺寸上就多出一条经典滚动条，把右下角的绿块往左挤 15px（「视口 = 图」就断不了了）
 */
const plainSource = (block = RED_BLOCK): string =>
  `const root = document.getElementById('root')\n` +
  `if (root) root.innerHTML = ${JSON.stringify(block + GREEN_CORNER + '<p style="margin:0;padding:60px 8px 0">plain v1</p>')}\n`

const PROBE_SOURCE = `const root = document.getElementById('root')
console.error('PROBE ' + JSON.stringify({
  w: innerWidth,
  h: innerHeight,
  dpr: devicePixelRatio,
  coarse: matchMedia('(pointer: coarse)').matches,
  hoverNone: matchMedia('(hover: none)').matches,
  touch: navigator.maxTouchPoints,
  dark: matchMedia('(prefers-color-scheme: dark)').matches
}))
if (root) root.innerHTML = '<p style="margin:0">probe</p>'
`

const BOOM_SOURCE = `const root = document.getElementById('root')
if (root) root.textContent = 'boom'
console.error('explicit-console-error')
throw new Error('boom-preview')
`

const BROKEN_SOURCE = 'const x = ;\n'

const escapeSource = (): string => `const root = document.getElementById('root')
if (root) root.innerHTML = ${JSON.stringify(RED_BLOCK)}
window.open(${JSON.stringify(fx.url('/popup'))})
Notification.requestPermission().then((p) => console.error('PERM ' + p))
setTimeout(() => { location.href = ${JSON.stringify(fx.url('/nav'))} }, 0)
`

const widgetDir = (id: string): string => join(app.home, '.shuvix', 'widgets', id)

function seedWidget(id: string, source: string, i: number): void {
  const dir = widgetDir(id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'widget.json'),
    JSON.stringify(
      { id, name: id, description: '', entryFile: 'index.tsx', createdAt: 1000 + i },
      null,
      2
    ) + '\n'
  )
  writeSource(id, source)
}

const writeSource = (id: string, source: string): void =>
  writeFileSync(join(widgetDir(id), 'index.tsx'), source)

// ─── 读应用的状态 ──────────────────────────────────────────────

const pageTargets = async (): Promise<Array<{ ws: string; url: string }>> =>
  (await listTargets(app.port))
    .filter((t) => t.type === 'page')
    .map((t) => ({ ws: t.webSocketDebuggerUrl, url: t.url }))

/** 页面 target 回到起来时那一份（target 列表可能比 win.destroy() 晚一点） */
async function backToBaseline(): Promise<void> {
  await until(async () => {
    const now = (await pageTargets()).map((t) => t.ws).sort()
    return now.join('\n') === baseline.join('\n') || null
  }, 'page targets back to the baseline')
  const urls = (await pageTargets()).map((t) => t.url)
  expect(urls.filter((u) => u.includes('/w/pv-'))).toEqual([])
}

const registered = async (): Promise<string[]> =>
  (await app.main.eval<{ registeredIds?: string[] }>('window.api.widget.getServerStatus()'))
    .registeredIds ?? []

const lastOpenedAt = (id: string): Promise<number | undefined> =>
  app.main.eval<number | undefined>(
    `window.api.widget.list().then((l) => l.find((w) => w.id === ${JSON.stringify(id)})?.lastOpenedAt)`
  )

const setTheme = (value: string): Promise<unknown> =>
  app.main.eval(
    `window.api.settings.set({ key: 'general.theme', value: ${JSON.stringify(value)} })`
  )

const sessionDir = (session = sid): string =>
  join(app.userData, 'tool_results', session, 'widget-preview')
const filesOf = (id: string, session = sid): string[] =>
  existsSync(sessionDir(session))
    ? readdirSync(sessionDir(session))
        .filter((f) => f.startsWith(`${id}-`))
        .sort()
    : []

const createdSince = (since: number): WindowEvent[] =>
  windowEvents(app)
    .slice(since)
    .filter((e) => e.event === 'created')

// ─── 窗口事件 ─────────────────────────────────────────────────

interface PreviewWindow extends WindowHistory {
  widget: string
}

function previewWindows(events: WindowEvent[]): PreviewWindow[] {
  return windowsOf(events).flatMap((w) => {
    const hit = w.urls.map((u) => PREVIEW_URL.exec(u)).find((m) => m)
    return hit ? [{ ...w, widget: hit[1] }] : []
  })
}

/** 这些预览窗都是隐着、不可聚焦地建出来的，从没显示、从没聚焦，最后都关了 */
async function expectUnseenAndClosed(since: number, widget?: string): Promise<PreviewWindow[]> {
  const wins = await until(() => {
    const list = previewWindows(windowEvents(app).slice(since)).filter(
      (w) => !widget || w.widget === widget
    )
    return list.every((w) => w.closed) ? list : null
  }, 'every preview window closed')
  for (const w of wins) {
    expect(w.created, `window ${w.id}`).toBeDefined()
    expect(w.created?.visible, `window ${w.id} created visible`).toBe(false)
    expect(w.created?.focusable, `window ${w.id} created focusable`).toBe(false)
    expect(w.shown, `window ${w.id} shown`).toBe(false)
    expect(w.focused, `window ${w.id} focused`).toBe(false)
  }
  return wins
}

// ─── 一轮工具调用 ──────────────────────────────────────────────

/** 这次请求属于哪一轮：最后一条真正的用户消息（工具结果里的图另起的那条不算） */
const lastPrompt = (r: FakeRequest): string =>
  userTextsOf(r)
    .filter((t) => !t.startsWith(ATTACHED))
    .at(-1) ?? ''

interface WidgetRun {
  /** 落盘的工具块（带结果） */
  tool: ToolResult
  /** 把工具结果交回模型的那一次请求 */
  followUp: FakeRequest
}

/**
 * 在一条会话里跑一轮：模型调 `widget` 工具（`args`），拿到结果后收尾。会话第一次碰这个组件时的询问由这里替用户答
 * （允许并记住读写），记进 `asked`；等工具块落盘、这一轮落定
 */
async function runWidget(session: string, args: Record<string, unknown>): Promise<WidgetRun> {
  const n = ++seq
  const marker = `PV-RUN-${n}: widget ${String(args.action)} ${String(args.widget ?? '')}`
  const callId = `call_pv_${n}`
  const done = `PV-DONE-${n}`
  const mine = (r: FakeRequest): boolean => lastPrompt(r) === marker
  provider.script(
    {
      toolCalls: [{ id: callId, name: 'widget', args: JSON.stringify(args) }],
      when: mine,
      usage: USAGE
    },
    { text: done, when: mine, usage: USAGE }
  )
  await app.main.eval(
    `(window.api.agent.prompt(${JSON.stringify({ sessionId: session, text: marker })}).catch(() => undefined), true)`
  )
  const answered = new Set<string>()
  const tool = await until(
    async () => {
      const view = await probe.viewOf(session)
      if (!view) return null
      for (const ask of view.asks) {
        if (answered.has(ask.id)) continue
        answered.add(ask.id)
        const widget = (ask as { widget?: { widgetId: string; access: string; operation: string } })
          .widget
        if (ask.kind !== 'ask' || !widget) {
          strayAsks.push(JSON.stringify(ask))
          await app.main.eval(
            `window.api.agent.respondToInput(${JSON.stringify({
              sessionId: session,
              requestId: ask.id,
              response: { kind: ask.kind, allowed: false, selections: [] }
            })})`
          )
          continue
        }
        asked.push({
          session,
          widgetId: widget.widgetId,
          access: widget.access,
          operation: widget.operation
        })
        // 卡片上的「允许，并记住：可以读写这个组件」（读的卡多出来的那一行；写的卡上同名那一行等价）
        await app.main.eval(
          `window.api.agent.respondToInput(${JSON.stringify({
            sessionId: session,
            requestId: ask.id,
            response: {
              kind: 'ask',
              allowed: true,
              extra: { remember: true, rememberAccess: 'write' }
            }
          })})`
        )
      }
      const result = toolResultsIn(view.messages).find((t) => t.toolCallId === callId)
      const settled =
        view.run.state !== 'busy' &&
        view.messages.some((m) => m.role === 'assistant' && m.content.includes(done))
      return result && settled ? result : null
    },
    `widget ${String(args.action)} (${marker}) settled in ${session}`,
    RUN_TIMEOUT
  )
  expect(strayAsks, 'only widget asks').toEqual([])
  const followUp = provider
    .requests()
    .find((r) => mine(r) && r.raw.includes(`"tool_call_id":"${callId}"`))
  expect(followUp, `the request that carried ${callId} back`).toBeDefined()
  return { tool, followUp: followUp! }
}

const preview = (
  id: string,
  opts: { sizes?: string[]; theme?: string; session?: string } = {}
): Promise<WidgetRun> =>
  runWidget(opts.session ?? sid, {
    action: 'preview',
    widget: id,
    ...(opts.sizes ? { sizes: opts.sizes } : {}),
    ...(opts.theme ? { theme: opts.theme } : {})
  })

const build = (id: string): Promise<WidgetRun> => runWidget(sid, { action: 'build', widget: id })

/** 结果里每张图前面那一行：`<size> (<w>×<h>, <theme> theme):` */
const headers = (text: string): string[] =>
  text.split('\n').filter((l) => /^\w+ \(\d+×\d+, \w+ theme\):$/.test(l))

/** 结果里 `<errors>` 那一段的各行（没有 → []） */
function errorsOf(text: string): string[] {
  const m = /<errors>\n([\s\S]*?)\n<\/errors>/.exec(text)
  return m ? m[1].split('\n') : []
}

/** 一个尺寸的截图在会话目录里的路径 */
const shotPath = (id: string, size: Size, session = sid): string =>
  join(sessionDir(session), `${id}-${size}.png`)

/** 一次正常的预览：没有报错、图都在 */
function ok(run: WidgetRun): string {
  expect(run.tool.isError, run.tool.result).toBe(false)
  expect(run.tool.details).toMatchObject({ action: 'preview', widget: run.tool.args?.widget })
  return run.tool.result
}

// ─── 像素 ─────────────────────────────────────────────────────

async function pixelsOf(path: string, points: Array<[number, number]>): Promise<Rgba[]> {
  const facts = await rasterFacts(
    app.main,
    { mime: 'image/png', data: readFileSync(path) },
    { points }
  )
  return facts.pixels
}
const isRed = (p: Rgba): boolean => p.r > 180 && p.g < 80 && p.b < 80
const isGreen = (p: Rgba): boolean => p.g > 180 && p.r < 80 && p.b < 80
const isBlue = (p: Rgba): boolean => p.b > 180 && p.r < 80 && p.g < 80
const isLight = (p: Rgba): boolean => Math.min(p.r, p.g, p.b) >= 230
const isDark = (p: Rgba): boolean => Math.max(p.r, p.g, p.b) <= 50

/** 面板截图正中那一点（宿主页面的 body 底色：浅色 #ffffff、深色 #0d1117） */
const bodyPixel = async (path: string): Promise<Rgba> => (await pixelsOf(path, [[190, 400]]))[0]

/** errors 里 PROBE 那几行（按出现顺序：尺寸 + 解析出来的事实） */
function probes(errors: string[]): Array<{ size: string; facts: Record<string, unknown> }> {
  return errors.flatMap((line) => {
    const m = /^\[(\w+)\] PROBE (.*)$/.exec(line)
    return m ? [{ size: m[1], facts: JSON.parse(m[2]) as Record<string, unknown> }] : []
  })
}

beforeAll(async () => {
  fx = await startFixtureServer()
  provider = await startFakeProvider()
  app = await launchApp()
  await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  await waitRendererReady(app.main)
  // 产品缺省的 system 跟着系统走，不确定：钉成浅色（结束时还原）
  themeBefore = await app.main.eval(`window.api.settings.get('general.theme')`)
  await setTheme('light')
  // 不是缺省标题：自动起标题不出场，请求只有这里脚本化的那些
  sid = await app.main.eval<string>(
    `window.api.session.create({ title: 'widget preview' }).then((s) => s.id)`
  )
  sid2 = await app.main.eval<string>(
    `window.api.session.create({ title: 'widget preview 2' }).then((s) => s.id)`
  )
  expect(sid).toBeTruthy()
  expect(sid2).toBeTruthy()
  ;[
    ['pv-plain', plainSource()],
    ['pv-probe', PROBE_SOURCE],
    ['pv-boom', BOOM_SOURCE],
    ['pv-broken', BROKEN_SOURCE],
    ['pv-regress', plainSource()],
    ['pv-escape', escapeSource()],
    ['pv-unused', plainSource()]
  ].forEach(([id, source], i) => seedWidget(id, source, i))
  probe = syncProbe(app.main)
  await probe.install()
  baseline = (await pageTargets()).map((t) => t.ws).sort()
}, 150_000)

afterAll(async () => {
  try {
    if (app) await setTheme(typeof themeBefore === 'string' ? themeBefore : 'system')
  } catch {
    /* 实例已经没了：照样往下收 */
  }
  await fx?.close()
  await provider?.close()
  await app?.stop()
})

describe('widget tool: preview', () => {
  it(
    'PV-E9 bad arguments are refused before anything is asked, built or opened',
    async () => {
      const since = windowEvents(app).length

      // 参数表只收这三个尺寸名、两种主题：认不得的连工具都到不了
      const tablet = await runWidget(sid, {
        action: 'preview',
        widget: 'pv-unused',
        sizes: ['tablet']
      })
      expect(tablet.tool.isError).toBe(true)
      expect(tablet.tool.result).toContain('tablet')

      const upper = await runWidget(sid, {
        action: 'preview',
        widget: 'pv-unused',
        sizes: ['phone', 'Tablet']
      })
      expect(upper.tool.isError).toBe(true)
      expect(upper.tool.result).toContain('Tablet')

      const sepia = await runWidget(sid, { action: 'preview', widget: 'pv-unused', theme: 'sepia' })
      expect(sepia.tool.isError).toBe(true)
      expect(sepia.tool.result).toContain('sepia')

      // 校验在授权、注册与构建之前
      expect(await registered()).not.toContain('pv-unused')
      expect(filesOf('pv-unused')).toEqual([])

      const noId = await runWidget(sid, { action: 'preview' })
      expect(noId.tool.isError).toBe(true)
      expect(noId.tool.result).toContain('`widget` is required: the widget id (see "list").')

      const missing = await runWidget(sid, { action: 'preview', widget: 'no-such-widget' })
      expect(missing.tool.isError).toBe(true)
      expect(missing.tool.result).toContain(
        'There is no widget "no-such-widget". Call "list" to see the widgets.'
      )

      const bad = await runWidget(sid, { action: 'preview', widget: 'Bad_Id' })
      expect(bad.tool.isError).toBe(true)
      expect(bad.tool.result).toContain(
        '"Bad_Id" is not a widget id (kebab-case with at least one dash).'
      )

      // 一张卡都没有：参数不对的调用到不了授权
      expect(asked).toEqual([])
      expect(createdSince(since)).toEqual([])
      await backToBaseline()
    },
    IT_TIMEOUT
  )

  it(
    'PV-E1 all three sizes: images in the result and to the model, CSS-pixel PNGs in the session folder, not an open, no window left',
    async () => {
      expect(await lastOpenedAt('pv-plain')).toBe(0)
      expect(await registered()).not.toContain('pv-plain')
      const since = windowEvents(app).length

      const run = await preview('pv-plain')
      const text = ok(run)
      // 第一次碰这个组件：问了一次（读，操作 preview）
      expect(asked).toEqual([
        { session: sid, widgetId: 'pv-plain', access: 'read', operation: 'preview' }
      ])
      expect(headers(text)).toEqual([
        'panel (380×760, app theme):',
        'window (1280×800, app theme):',
        'phone (390×780, app theme):'
      ])
      // 干净的小组件什么都不报：宿主页面自己也不能有噪音
      expect(text).not.toContain('<errors>')

      for (const size of ALL) {
        const path = shotPath('pv-plain', size)
        const { width, height } = DIMS[size]
        expect(existsSync(path), path).toBe(true)
        // 高分屏上也是 CSS 像素
        const png = readFileSync(path)
        expect(pngSize(png), size).toEqual({ width, height })
        // 模型收到的就是这张图
        expect(run.followUp.raw, `${size} image sent to the model`).toContain(
          `data:image/png;base64,${png.toString('base64')}`
        )
        const [topLeft, corner] = await pixelsOf(path, [
          [50, 20],
          [width - 10, height - 10]
        ])
        expect(isRed(topLeft), `${size} (50,20) = ${JSON.stringify(topLeft)}`).toBe(true)
        // 右下角固定的块正落在图的角上：视口就是图的大小
        expect(isGreen(corner), `${size} corner = ${JSON.stringify(corner)}`).toBe(true)
      }
      expect(userTextsOf(run.followUp).filter((t) => t.startsWith(ATTACHED))).toHaveLength(1)
      expect(filesOf('pv-plain')).toEqual([
        'pv-plain-panel.png',
        'pv-plain-phone.png',
        'pv-plain-window.png'
      ])

      // 不计打开、不开小组件自己的窗口；注册上了（按需构建，与 build 一样）
      expect(await lastOpenedAt('pv-plain')).toBe(0)
      expect(
        await app.main.eval(`window.api.widgetWindow.status(${JSON.stringify(['pv-plain'])})`)
      ).toStrictEqual({ open: [], preferWindow: [] })
      expect(await registered()).toContain('pv-plain')
      await backToBaseline()

      const wins = await expectUnseenAndClosed(since)
      expect(wins.map((w) => w.widget)).toEqual(['pv-plain', 'pv-plain', 'pv-plain'])
    },
    IT_TIMEOUT
  )

  it(
    'PV-E2 phone is touch with a mobile viewport; panel and window are mouse; dpr 1 everywhere',
    async () => {
      const text = ok(await preview('pv-probe'))
      expect(headers(text)).toHaveLength(3)
      // 只有那三行 PROBE，没有别的
      const errors = errorsOf(text)
      expect(errors).toHaveLength(3)
      const lines = probes(errors)
      expect(lines.map((l) => l.size)).toEqual(ALL)
      const [panel, window, phone] = lines.map((l) => l.facts)
      expect(panel).toMatchObject({
        w: 380,
        h: 760,
        dpr: 1,
        coarse: false,
        hoverNone: false,
        touch: 0
      })
      expect(window).toMatchObject({
        w: 1280,
        h: 800,
        dpr: 1,
        coarse: false,
        hoverNone: false,
        touch: 0
      })
      // 技能的 pointer-coarse: 建议靠这一条
      expect(phone).toMatchObject({ w: 390, h: 780, dpr: 1, coarse: true, hoverNone: true })
      expect(phone.touch as number).toBeGreaterThan(0)
    },
    IT_TIMEOUT
  )

  it(
    'PV-E3 theme forces the colour scheme, no theme follows the app; one file per size, overwritten',
    async () => {
      // 1. 重复的尺寸只截一次；强制浅色
      const light = ok(await preview('pv-plain', { sizes: ['panel', 'panel'], theme: 'light' }))
      expect(headers(light)).toEqual(['panel (380×760, light theme):'])
      const path = shotPath('pv-plain', 'panel')
      expect(isLight(await bodyPixel(path)), 'forced light').toBe(true)
      const lightBytes = readFileSync(path)

      // 2. 强制深色：同一个文件被覆盖
      const dark = ok(await preview('pv-plain', { sizes: ['panel'], theme: 'dark' }))
      expect(headers(dark)).toEqual(['panel (380×760, dark theme):'])
      expect(isDark(await bodyPixel(path)), 'forced dark').toBe(true)
      expect(readFileSync(path).equals(lightBytes)).toBe(false)
      expect(filesOf('pv-plain').filter((f) => f.startsWith('pv-plain-panel'))).toEqual([
        'pv-plain-panel.png'
      ])

      // 3. 不给 theme：跟应用当前的主题
      await setTheme('dark')
      const appDark = ok(await preview('pv-plain', { sizes: ['panel'] }))
      expect(headers(appDark)).toEqual(['panel (380×760, app theme):'])
      expect(isDark(await bodyPixel(path)), 'app theme dark').toBe(true)
      await setTheme('light')
      const appLight = ok(await preview('pv-plain', { sizes: ['panel'] }))
      expect(headers(appLight)).toEqual(['panel (380×760, app theme):'])
      expect(isLight(await bodyPixel(path)), 'app theme light').toBe(true)

      // 4. 页面里 prefers-color-scheme 也跟着变
      const probeDark = ok(await preview('pv-probe', { sizes: ['phone'], theme: 'dark' }))
      expect(probes(errorsOf(probeDark)).map((l) => l.facts.dark)).toEqual([true])
      const probeLight = ok(await preview('pv-probe', { sizes: ['phone'], theme: 'light' }))
      expect(probes(errorsOf(probeLight)).map((l) => l.facts.dark)).toEqual([false])
    },
    IT_TIMEOUT
  )

  it(
    'PV-E5 runtime errors and console errors come back per size, and the page is still captured',
    async () => {
      const text = ok(await preview('pv-boom'))
      // 宿主的 window.onerror 把 #root 换成 Runtime Error 的诊断：那也照截
      expect(headers(text)).toHaveLength(3)
      const errors = errorsOf(text)
      for (const size of ALL) {
        const mine = errors.filter((e) => e.startsWith(`[${size}] `))
        expect(
          mine.some((e) => e.includes('boom-preview')),
          `${size}: ${JSON.stringify(errors)}`
        ).toBe(true)
        expect(mine, size).toContain(`[${size}] explicit-console-error`)
      }
      expect(new Set(errors).size).toBe(errors.length)
      expect(errors.length).toBeLessThanOrEqual(12)
    },
    IT_TIMEOUT
  )

  it(
    'PV-E6 an unregistered widget that does not build: no images, one line to build first, no window',
    async () => {
      const since = windowEvents(app).length
      const first = ok(await preview('pv-broken'))
      expect(first).toBe(`<errors>\n${DOES_NOT_BUILD}\n</errors>`)
      expect(filesOf('pv-broken')).toEqual([])
      expect(createdSince(since)).toEqual([])
      expect(await lastOpenedAt('pv-broken')).toBe(0)

      // 再来一次：这时它已注册（上一次构建失败），答案不变（B2）
      const again = ok(await preview('pv-broken', { sizes: ['phone'] }))
      expect(again).toBe(first)
      expect(createdSince(since)).toEqual([])
    },
    IT_TIMEOUT
  )

  it(
    'PV-E4 a registered widget previews its last build, not its source',
    async () => {
      const blue =
        '<div style="position:fixed;left:0;top:0;width:100px;height:40px;background:rgb(0,0,255)"></div>'
      writeSource('pv-plain', plainSource(blue))
      const path = shotPath('pv-plain', 'panel')

      // 没 build：仍是上一次构建的红块
      ok(await preview('pv-plain', { sizes: ['panel'] }))
      const [stale] = await pixelsOf(path, [[50, 20]])
      expect(isRed(stale), `before build (50,20) = ${JSON.stringify(stale)}`).toBe(true)

      // 第一次碰它时记下的是读写：build 不再问
      const built = await build('pv-plain')
      expect(built.tool.isError, built.tool.result).toBe(false)
      expect(built.tool.result).toMatch(/^Built "pv-plain"\./)
      ok(await preview('pv-plain', { sizes: ['panel'] }))
      const [fresh] = await pixelsOf(path, [[50, 20]])
      expect(isBlue(fresh), `after build (50,20) = ${JSON.stringify(fresh)}`).toBe(true)
      expect(asked.filter((a) => a.widgetId === 'pv-plain')).toHaveLength(1)
    },
    IT_TIMEOUT
  )

  it(
    'PV-E7 (B2) a registered widget whose last build failed: no images, one line to build first',
    async () => {
      const first = await build('pv-regress')
      expect(first.tool.isError, first.tool.result).toBe(false)
      // 第一次碰它是 build：问的是读写
      expect(asked.at(-1)).toEqual({
        session: sid,
        widgetId: 'pv-regress',
        access: 'write',
        operation: 'build'
      })
      expect(headers(ok(await preview('pv-regress', { sizes: ['panel'] })))).toHaveLength(1)

      writeSource('pv-regress', BROKEN_SOURCE)
      const red = await build('pv-regress')
      expect(red.tool.isError).toBe(true)
      expect(red.tool.result).toContain('The build of "pv-regress" failed:')

      const since = windowEvents(app).length
      const out = ok(await preview('pv-regress', { sizes: ['panel'] }))
      expect(out).toBe(`<errors>\n${DOES_NOT_BUILD}\n</errors>`)
      expect(createdSince(since)).toEqual([])
    },
    IT_TIMEOUT
  )

  it(
    'PV-E8 the page cannot leave its address: popup denied, navigation blocked, permission denied',
    async () => {
      const since = windowEvents(app).length
      const text = ok(await preview('pv-escape', { sizes: ['panel'] }))
      expect(headers(text)).toEqual(['panel (380×760, app theme):'])
      // 还在小组件自己的页面上
      const [topLeft] = await pixelsOf(shotPath('pv-escape', 'panel'), [[50, 20]])
      expect(isRed(topLeft), `(50,20) = ${JSON.stringify(topLeft)}`).toBe(true)
      expect(errorsOf(text)).toContain('[panel] PERM denied')

      // 弹窗与导航都没到夹具服务器
      expect(fx.requests()).toEqual([])
      // 只建了预览那一扇（弹窗被拒，没有多出来的 BrowserWindow）
      expect(createdSince(since)).toHaveLength(1)
      const wins = await expectUnseenAndClosed(since)
      expect(wins.map((w) => w.widget)).toEqual(['pv-escape'])
      expect(wins[0].urls.filter((u) => u.startsWith(fx.origin))).toEqual([])
      expect(externalOpens(app)).toEqual([])
      await backToBaseline()
    },
    IT_TIMEOUT
  )

  it(
    'PV-E11 two sessions previewing at once each get their own result',
    async () => {
      const [a, b] = await Promise.all([
        preview('pv-plain', { sizes: ['phone'] }),
        preview('pv-probe', { sizes: ['panel'], session: sid2 })
      ])
      const plain = ok(a)
      const probed = ok(b)
      expect(headers(plain)).toEqual(['phone (390×780, app theme):'])
      expect(plain).not.toContain('<errors>')
      expect(headers(probed)).toEqual(['panel (380×760, app theme):'])
      expect(probes(errorsOf(probed)).map((l) => l.size)).toEqual(['panel'])
      expect(errorsOf(probed)).toHaveLength(1)
      // 各自的会话目录
      expect(existsSync(shotPath('pv-probe', 'panel', sid2))).toBe(true)
      expect(filesOf('pv-plain', sid2)).toEqual([])
      expect(await app.main.eval('1 + 1')).toBe(2)
    },
    IT_TIMEOUT
  )

  it(
    'PV-E12 the app is alive and nothing leaked, nothing was shown, nothing was handed to the system',
    async () => {
      expect(() => process.kill(app.pid, 0)).not.toThrow()
      expect(await app.main.eval('1 + 1')).toBe(2)
      expect(uncaughtExceptions(app)).toBe('')
      await backToBaseline()

      const wins = await expectUnseenAndClosed(0)
      // 每次预览每个尺寸恰一扇：E1 3 + E2 3 + E3 6 + E5 3 + E4 2 + E7 1 + E8 1 + E11 2
      expect(wins).toHaveLength(21)
      expect(nativeDialogRequests(app)).toEqual([])
      expect(externalOpens(app)).toEqual([])
      // 每条会话第一次碰的那几个组件各问了一次，别的没问
      expect(asked).toEqual([
        { session: sid, widgetId: 'pv-plain', access: 'read', operation: 'preview' },
        { session: sid, widgetId: 'pv-probe', access: 'read', operation: 'preview' },
        { session: sid, widgetId: 'pv-boom', access: 'read', operation: 'preview' },
        { session: sid, widgetId: 'pv-broken', access: 'read', operation: 'preview' },
        { session: sid, widgetId: 'pv-regress', access: 'write', operation: 'build' },
        { session: sid, widgetId: 'pv-escape', access: 'read', operation: 'preview' },
        { session: sid2, widgetId: 'pv-probe', access: 'read', operation: 'preview' }
      ])
    },
    IT_TIMEOUT
  )
})
