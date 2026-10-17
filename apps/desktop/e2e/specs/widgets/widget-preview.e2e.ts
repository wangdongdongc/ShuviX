/**
 * `shuvix widget preview <id> [--size panel,window,phone] [--theme light|dark]`（2026-10-17）—— agent 自查排版：在从不
 * 显示、不可聚焦的窗口里按面板 380×760 / 独立窗口 1280×800 / 手机 390×780（触屏 + 移动视口）渲染一个小组件，各截一张
 * CSS 像素的 PNG 写进会话的 `tool_results/<sid>/widget-preview/<id>-<size>.png`（没有会话 → 系统临时目录里每次新建的
 * `shuvix-widget-preview-*`），打印 `{ id, theme, images: [{size,width,height,path}], errors }`。不弹窗、不抢焦点、不计打开。
 *
 * 一个真的 isolated 实例（TMPDIR 指到 spec 自己的临时目录，好断「没有会话」那条路径），经 harness 的 runCli 跑真的 CLI。
 * 「从没显示过、从没聚焦过」看 bootstrap.cjs 记的窗口事件（e2e-windows.log）；窗口在不在看 CDP 的 /json；像素经
 * figureFixtures 的 rasterFacts 在主窗里画回画布读（按主色判，不比精确值：P3 / 高分屏上的截图会略有偏色）。
 * 弹框、打印、下载、mailto、定位一律不进 e2e（守卫一旦回退，那些会在开发者屏幕上弹出系统界面）—— 由单测覆盖。
 *
 *   PV-E9  校验先于一切：认不得的尺寸 / 主题退出 1、没注册、没截图、没多窗；没有 id / 找不到 / 非法 id 退出 1
 *   PV-E1  缺省三种尺寸：PNG 尺寸 = JSON = 视口（右下角的块正落在图的角上）、路径在会话目录、不计打开、窗口都没了、
 *          三扇窗从没显示 / 聚焦过且都关了
 *   PV-E2  手机是触屏 + 移动视口（pointer: coarse、hover: none、maxTouchPoints > 0），面板与窗口是鼠标；dpr 都是 1
 *   PV-E3  --theme 强制颜色方案、缺省跟应用的主题；同一尺寸覆盖同一个文件；大小写与重复的尺寸
 *   PV-E5  运行时异常与 console.error 带回 errors（每个尺寸一份、不重复），照样截图
 *   PV-E6  没注册、构建不过 → 没有图、一句「先 build」、没开窗、不计打开
 *   PV-E4  已注册的预览的是上一次构建，不是源码；build 之后才变
 *   PV-E7  已注册但上一次构建失败（B2）→ 没有图、一句「先 build」
 *   PV-E8  页面出不去：弹窗被拒、导航到别处被拦、通知权限被拒；夹具服务器一个请求都没收到；只建了一扇窗
 *   PV-E10 没有会话 → TMPDIR 下新建的 shuvix-widget-preview-* 目录
 *   PV-E11 两个预览同时来：各自的结果、互不串
 *   PV-E12 应用活着、没有未捕获异常、没留下窗口、所有预览窗都没显示过、没弹原生框、没交给系统打开任何东西
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  launchApp,
  runCli,
  uncaughtExceptions,
  windowEvents,
  windowsOf,
  type CliResult,
  type E2EApp,
  type WindowEvent,
  type WindowHistory
} from '../../harness/launch'
import { listTargets, until } from '../../harness/cdp'
import { startFixtureServer, type FixtureServer } from '../../harness/browserFixtures'
import { pngSize, rasterFacts } from '../../harness/figureFixtures'
import { externalOpens } from '../../harness/providerOAuthFixtures'
import { nativeDialogRequests } from '../../harness/networkFixtures'

type Size = 'panel' | 'window' | 'phone'
const ALL: Size[] = ['panel', 'window', 'phone']
const DIMS: Record<Size, { width: number; height: number }> = {
  panel: { width: 380, height: 760 },
  window: { width: 1280, height: 800 },
  phone: { width: 390, height: 780 }
}

interface PreviewResult {
  id: string
  theme: 'light' | 'dark' | 'app'
  images: Array<{ size: Size; width: number; height: number; path: string }>
  errors: string[]
}

interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

const IT_TIMEOUT = 180_000
const CLI_TIMEOUT = 120_000
/** 预览窗口导航到的地址：widget 服务器上某个 pv-* 小组件自己的地址 */
const PREVIEW_URL = /^http:\/\/127\.0\.0\.1:\d+\/w\/(pv-[a-z0-9-]+)\/$/

let app: E2EApp
let fx: FixtureServer
let appTmp = ''
let sid = ''
let themeBefore: unknown = null
/** 起来之后的页面 target（主窗口等）：每次预览之后都要回到这一份 */
let baseline: string[] = []

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

const sessionDir = (): string => join(app.userData, 'tool_results', sid, 'widget-preview')
const filesOf = (id: string): string[] =>
  existsSync(sessionDir())
    ? readdirSync(sessionDir())
        .filter((f) => f.startsWith(`${id}-`))
        .sort()
    : []
/** 没有会话时新建在 TMPDIR 下的目录里，这个小组件的截图 */
const tmpFilesOf = (id: string): string[] =>
  readdirSync(appTmp)
    .filter((d) => d.startsWith('shuvix-widget-preview-'))
    .flatMap((d) =>
      readdirSync(join(appTmp, d))
        .filter((f) => f.startsWith(`${id}-`))
        .map((f) => join(d, f))
    )

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

// ─── CLI ─────────────────────────────────────────────────────

function preview(args: string[], opts: { session?: boolean } = {}): Promise<CliResult> {
  return runCli(app, ['widget', 'preview', ...args], {
    // 没有会话也显式给空串：不能从跑 e2e 的那个 shell 里继承一个
    env: { SHUVIX_SESSION_ID: opts.session === false ? '' : sid },
    timeoutMs: CLI_TIMEOUT
  })
}

function ok(r: CliResult): PreviewResult {
  expect(r.code, `exit code; stderr: ${r.stderr}`).toBe(0)
  return JSON.parse(r.stdout) as PreviewResult
}

async function build(id: string): Promise<{ buildSuccess: boolean; buildErrors?: string[] }> {
  const r = await runCli(app, ['widget', 'build', id], {
    env: { SHUVIX_SESSION_ID: sid },
    timeoutMs: CLI_TIMEOUT
  })
  expect(r.code, r.stderr).toBe(0)
  return JSON.parse(r.stdout) as { buildSuccess: boolean; buildErrors?: string[] }
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
  appTmp = mkdtempSync('/private/tmp/sxpv-')
  app = await launchApp({ env: { TMPDIR: appTmp } })
  // 产品缺省的 system 跟着系统走，不确定：钉成浅色（结束时还原）
  themeBefore = await app.main.eval(`window.api.settings.get('general.theme')`)
  await setTheme('light')
  sid = await app.main.eval<string>(
    `window.api.session.create({ title: 'widget preview' }).then((s) => s.id)`
  )
  expect(sid).toBeTruthy()
  ;[
    ['pv-plain', plainSource()],
    ['pv-probe', PROBE_SOURCE],
    ['pv-boom', BOOM_SOURCE],
    ['pv-broken', BROKEN_SOURCE],
    ['pv-regress', plainSource()],
    ['pv-escape', escapeSource()],
    ['pv-unused', plainSource()]
  ].forEach(([id, source], i) => seedWidget(id, source, i))
  baseline = (await pageTargets()).map((t) => t.ws).sort()
}, 150_000)

afterAll(async () => {
  try {
    if (app) await setTheme(typeof themeBefore === 'string' ? themeBefore : 'system')
  } catch {
    /* 实例已经没了：照样往下收 */
  }
  await fx?.close()
  await app?.stop()
  if (appTmp) rmSync(appTmp, { recursive: true, force: true })
})

describe('shuvix widget preview', () => {
  it(
    'PV-E9 bad arguments fail with exit 1 before anything is built or opened',
    async () => {
      const since = windowEvents(app).length

      const tablet = await preview(['pv-unused', '--size', 'tablet'])
      expect(tablet.code).toBe(1)
      expect(tablet.stderr).toContain('unknown size "tablet"')
      expect(tablet.stderr).toContain('panel, window, phone')

      const mixed = await preview(['pv-unused', '--size', 'phone,Tablet'])
      expect(mixed.code).toBe(1)
      expect(mixed.stderr).toContain('unknown size "Tablet"')

      const sepia = await preview(['pv-unused', '--theme', 'sepia'])
      expect(sepia.code).toBe(1)
      expect(sepia.stderr).toContain('unknown theme "sepia"')
      expect(sepia.stderr).toContain('light or dark')

      // 校验在注册与构建之前
      expect(await registered()).not.toContain('pv-unused')
      expect(filesOf('pv-unused')).toEqual([])
      expect(tmpFilesOf('pv-unused')).toEqual([])

      const noId = await preview([])
      expect(noId.code).toBe(1)
      expect(noId.stderr).toBe('widget preview: <id> is required\n')

      const missing = await preview(['no-such-widget'])
      expect(missing.code).toBe(1)
      expect(missing.stderr).toContain('Widget "no-such-widget" not found')

      const bad = await preview(['Bad_Id'])
      expect(bad.code).toBe(1)
      expect(bad.stderr).toContain('Invalid widget id')

      expect(
        windowEvents(app)
          .slice(since)
          .filter((e) => e.event === 'created')
      ).toEqual([])
      await backToBaseline()
    },
    IT_TIMEOUT
  )

  it(
    'PV-E1 all three sizes: CSS-pixel PNGs in the session folder, viewport = image, not an open, no window left',
    async () => {
      expect(await lastOpenedAt('pv-plain')).toBe(0)
      expect(await registered()).not.toContain('pv-plain')
      const since = windowEvents(app).length

      const out = ok(await preview(['pv-plain']))
      expect(out.id).toBe('pv-plain')
      expect(out.theme).toBe('app')
      // 干净的小组件什么都不报：宿主页面自己也不能有噪音
      expect(out.errors).toEqual([])
      expect(out.images.map((i) => i.size)).toEqual(ALL)

      for (const img of out.images) {
        const { width, height } = DIMS[img.size]
        expect([img.width, img.height], img.size).toEqual([width, height])
        expect(img.path).toBe(join(sessionDir(), `pv-plain-${img.size}.png`))
        expect(existsSync(img.path), img.path).toBe(true)
        // 高分屏上也是 CSS 像素
        expect(pngSize(readFileSync(img.path)), img.size).toEqual({ width, height })
        const [topLeft, corner] = await pixelsOf(img.path, [
          [50, 20],
          [width - 10, height - 10]
        ])
        expect(isRed(topLeft), `${img.size} (50,20) = ${JSON.stringify(topLeft)}`).toBe(true)
        // 右下角固定的块正落在图的角上：视口就是图的大小
        expect(isGreen(corner), `${img.size} corner = ${JSON.stringify(corner)}`).toBe(true)
      }
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
      const out = ok(await preview(['pv-probe']))
      expect(out.images.map((i) => i.size)).toEqual(ALL)
      // 只有那三行 PROBE，没有别的
      expect(out.errors).toHaveLength(3)
      const lines = probes(out.errors)
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
    'PV-E3 --theme forces the colour scheme, no flag follows the app; one file per size, overwritten',
    async () => {
      // 1. 大小写与重复的尺寸；强制浅色
      const light = ok(await preview(['pv-plain', '--size', 'PANEL,panel', '--theme', 'light']))
      expect(light.theme).toBe('light')
      expect(light.images.map((i) => i.size)).toEqual(['panel'])
      const path = light.images[0].path
      expect(isLight(await bodyPixel(path)), 'forced light').toBe(true)
      const lightBytes = readFileSync(path)

      // 2. 强制深色：同一个文件被覆盖
      const dark = ok(await preview(['pv-plain', '--size', 'panel', '--theme', 'dark']))
      expect(dark.theme).toBe('dark')
      expect(dark.images.map((i) => i.path)).toEqual([path])
      expect(isDark(await bodyPixel(path)), 'forced dark').toBe(true)
      expect(readFileSync(path).equals(lightBytes)).toBe(false)
      expect(filesOf('pv-plain').filter((f) => f.startsWith('pv-plain-panel'))).toEqual([
        'pv-plain-panel.png'
      ])

      // 3. 不给 --theme：跟应用当前的主题
      await setTheme('dark')
      const appDark = ok(await preview(['pv-plain', '--size', 'panel']))
      expect(appDark.theme).toBe('app')
      expect(isDark(await bodyPixel(appDark.images[0].path)), 'app theme dark').toBe(true)
      await setTheme('light')
      const appLight = ok(await preview(['pv-plain', '--size', 'panel']))
      expect(appLight.theme).toBe('app')
      expect(isLight(await bodyPixel(appLight.images[0].path)), 'app theme light').toBe(true)

      // 4. 页面里 prefers-color-scheme 也跟着变
      const probeDark = ok(await preview(['pv-probe', '--size', 'phone', '--theme', 'dark']))
      expect(probes(probeDark.errors).map((l) => l.facts.dark)).toEqual([true])
      const probeLight = ok(await preview(['pv-probe', '--size', 'phone', '--theme', 'light']))
      expect(probes(probeLight.errors).map((l) => l.facts.dark)).toEqual([false])
    },
    IT_TIMEOUT
  )

  it(
    'PV-E5 runtime errors and console errors come back per size, and the page is still captured',
    async () => {
      const out = ok(await preview(['pv-boom']))
      // 宿主的 window.onerror 把 #root 换成 Runtime Error 的诊断：那也照截
      expect(out.images.map((i) => i.size)).toEqual(ALL)
      for (const size of ALL) {
        const mine = out.errors.filter((e) => e.startsWith(`[${size}] `))
        expect(
          mine.some((e) => e.includes('boom-preview')),
          `${size}: ${JSON.stringify(out.errors)}`
        ).toBe(true)
        expect(mine, size).toContain(`[${size}] explicit-console-error`)
      }
      expect(new Set(out.errors).size).toBe(out.errors.length)
      expect(out.errors.length).toBeLessThanOrEqual(12)
    },
    IT_TIMEOUT
  )

  it(
    'PV-E6 an unregistered widget that does not build: no images, one line to build first, no window',
    async () => {
      const since = windowEvents(app).length
      const out = ok(await preview(['pv-broken']))
      expect(out).toStrictEqual({
        id: 'pv-broken',
        theme: 'app',
        images: [],
        errors: [
          'the widget does not build: run `shuvix widget build pv-broken` and fix buildErrors'
        ]
      })
      expect(filesOf('pv-broken')).toEqual([])
      expect(
        windowEvents(app)
          .slice(since)
          .filter((e) => e.event === 'created')
      ).toEqual([])
      expect(await lastOpenedAt('pv-broken')).toBe(0)

      // 再来一次：这时它已注册（上一次构建失败），答案不变（B2）
      const again = ok(await preview(['pv-broken', '--size', 'phone']))
      expect(again.images).toEqual([])
      expect(again.errors).toEqual(out.errors)
      expect(
        windowEvents(app)
          .slice(since)
          .filter((e) => e.event === 'created')
      ).toEqual([])
    },
    IT_TIMEOUT
  )

  it(
    'PV-E4 a registered widget previews its last build, not its source',
    async () => {
      const blue =
        '<div style="position:fixed;left:0;top:0;width:100px;height:40px;background:rgb(0,0,255)"></div>'
      writeSource('pv-plain', plainSource(blue))

      // 没 build：仍是上一次构建的红块
      const before = ok(await preview(['pv-plain', '--size', 'panel']))
      const path = before.images[0].path
      const [stale] = await pixelsOf(path, [[50, 20]])
      expect(isRed(stale), `before build (50,20) = ${JSON.stringify(stale)}`).toBe(true)

      expect((await build('pv-plain')).buildSuccess).toBe(true)
      const after = ok(await preview(['pv-plain', '--size', 'panel']))
      expect(after.images[0].path).toBe(path)
      const [fresh] = await pixelsOf(path, [[50, 20]])
      expect(isBlue(fresh), `after build (50,20) = ${JSON.stringify(fresh)}`).toBe(true)
    },
    IT_TIMEOUT
  )

  it(
    'PV-E7 (B2) a registered widget whose last build failed: no images, one line to build first',
    async () => {
      expect((await build('pv-regress')).buildSuccess).toBe(true)
      expect(ok(await preview(['pv-regress', '--size', 'panel'])).images).toHaveLength(1)

      writeSource('pv-regress', BROKEN_SOURCE)
      const red = await build('pv-regress')
      expect(red.buildSuccess).toBe(false)

      const since = windowEvents(app).length
      const out = ok(await preview(['pv-regress', '--size', 'panel']))
      expect(out).toStrictEqual({
        id: 'pv-regress',
        theme: 'app',
        images: [],
        errors: [
          'the widget does not build: run `shuvix widget build pv-regress` and fix buildErrors'
        ]
      })
      expect(
        windowEvents(app)
          .slice(since)
          .filter((e) => e.event === 'created')
      ).toEqual([])
    },
    IT_TIMEOUT
  )

  it(
    'PV-E8 the page cannot leave its address: popup denied, navigation blocked, permission denied',
    async () => {
      const since = windowEvents(app).length
      const out = ok(await preview(['pv-escape', '--size', 'panel']))
      expect(out.images.map((i) => i.size)).toEqual(['panel'])
      // 还在小组件自己的页面上
      const [topLeft] = await pixelsOf(out.images[0].path, [[50, 20]])
      expect(isRed(topLeft), `(50,20) = ${JSON.stringify(topLeft)}`).toBe(true)
      expect(out.errors).toContain('[panel] PERM denied')

      // 弹窗与导航都没到夹具服务器
      expect(fx.requests()).toEqual([])
      // 只建了预览那一扇（弹窗被拒，没有多出来的 BrowserWindow）
      expect(
        windowEvents(app)
          .slice(since)
          .filter((e) => e.event === 'created')
      ).toHaveLength(1)
      const wins = await expectUnseenAndClosed(since)
      expect(wins.map((w) => w.widget)).toEqual(['pv-escape'])
      expect(wins[0].urls.filter((u) => u.startsWith(fx.origin))).toEqual([])
      expect(externalOpens(app)).toEqual([])
      await backToBaseline()
    },
    IT_TIMEOUT
  )

  it(
    'PV-E10 (B6) no session: a fresh shuvix-widget-preview-* folder under the OS temp dir',
    async () => {
      const out = ok(await preview(['pv-plain', '--size', 'panel'], { session: false }))
      expect(out.images).toHaveLength(1)
      const { path, width, height } = out.images[0]
      const dir = dirname(path)
      expect(dirname(dir)).toBe(appTmp)
      expect(basename(dir)).toMatch(/^shuvix-widget-preview-.+/)
      expect(basename(path)).toBe('pv-plain-panel.png')
      expect([width, height]).toEqual([380, 760])
      expect(pngSize(readFileSync(path))).toEqual({ width: 380, height: 760 })
      expect(path.startsWith(join(app.userData, 'tool_results'))).toBe(false)

      // 每次新建一个目录（固定路径在多用户的机器上能被别人预先占住）
      const again = ok(await preview(['pv-plain', '--size', 'panel'], { session: false }))
      expect(dirname(again.images[0].path)).not.toBe(dir)
      expect(dirname(dirname(again.images[0].path))).toBe(appTmp)
    },
    IT_TIMEOUT
  )

  it(
    'PV-E11 two previews at once each get their own result',
    async () => {
      const [plain, probe] = await Promise.all([
        preview(['pv-plain', '--size', 'phone']),
        preview(['pv-probe', '--size', 'panel'])
      ])
      const a = ok(plain)
      const b = ok(probe)
      expect(a.id).toBe('pv-plain')
      expect(a.images.map((i) => [i.size, i.width, i.height])).toEqual([['phone', 390, 780]])
      expect(a.errors).toEqual([])
      expect(b.id).toBe('pv-probe')
      expect(b.images.map((i) => [i.size, i.width, i.height])).toEqual([['panel', 380, 760]])
      expect(b.errors).toHaveLength(1)
      expect(probes(b.errors).map((l) => l.size)).toEqual(['panel'])
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
      // 每次预览每个尺寸恰一扇：E1 3 + E2 3 + E3 6 + E5 3 + E4 2 + E7 1 + E8 1 + E10 2 + E11 2
      expect(wins).toHaveLength(23)
      expect(nativeDialogRequests(app)).toEqual([])
      expect(externalOpens(app)).toEqual([])
    },
    IT_TIMEOUT
  )
})
