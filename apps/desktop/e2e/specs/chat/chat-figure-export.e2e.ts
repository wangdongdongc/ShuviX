/**
 * 对话图卡的「导出」—— 单测（chat-ui 的 figure/__tests__ 与 codeBlockFigureExport / mermaidBlock 的
 * EXP 组）结构上够不着的那几件，全都要真 Chromium：
 *
 *   1. **烘焙出来的颜色就是屏幕上的颜色**（FE-2/3/4）：级联、`light-dark()`、`color-mix()` 的计算值
 *      只有真浏览器给得出来 —— 导出文件里每个 data-k 元素的 `#rrggbb` + 不透明度，与屏幕上同一个
 *      元素的计算值逐分量比（±1），底色矩形与图卡在屏幕上合成出来的那层底比；再把导出的 SVG 当图片
 *      画到画布上读像素，与屏幕颜色比 —— 「文件在 ShuviX 之外长得一样」的最终证据；
 *   2. **浅 / 深按用户设定的那两套主题取色**（FE-4/9）：界面是 nord，导出浅色得是 solarized-light 的
 *      颜色 —— 包括 `--viz-wash` 这种在 themes.css 里由别的 token 派生的（只声明在 :root 上时它会
 *      顶着 nord 的文字色，这条就是那一改的回归护栏）；mermaid 在挂着那套主题的离屏容器里重渲；
 *   3. **真落盘 / 真位图**（FE-0/5/6/15）：`Page.setDownloadBehavior` 把「另存为」改成直接写进临时目录
 *      （**FE-0 先跑**：没生效的话后面每一条都会挂在一个关不掉的系统面板上），PNG 的 IHDR / JPEG 的
 *      SOF 尺寸、像素、透明；
 *   4. **剪贴板**（FE-7）：页内顶掉 navigator.clipboard.write、收下真的 ClipboardItem（真写会冲掉跑
 *      e2e 那台机器的剪贴板）；
 *   5. 接线：流式中的半张图不给导出（FE-11）、交互图没有（FE-13）、Esc / 点外面 / 再点按钮收起与焦点
 *      回到按钮（FE-12）、记住的选择跨卡片（FE-8）、产物与 mermaid 两个入口（FE-9/10）、语言（FE-14）、
 *      超大图的位图封顶（FE-15）。
 *
 * 一次 launchApp，**每条用例一个会话**（react-virtuoso 不跟到底，见 chat-mermaid）。界面主题钉成
 * 深色 nord、浅色设为 solarized-light，语言钉成 en。选择器全部在 pages.ts 的 figureCardPane /
 * figureExportPanel；落盘、剪贴板、读产物与像素在 harness/figureFixtures.ts。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { until } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import { startFakeProvider, type FakeProvider } from '../../harness/fakeProvider'
import { createProject, seedFakeProvider, waitRendererReady } from '../../harness/seed'
import {
  chatPane,
  figureCardPane,
  figureExportButtonsIn,
  figureExportPanel,
  interactivePane,
  sidebarPane,
  type ChatPane,
  type FigureCardKind,
  type FigureCardPane,
  type FigureExportPanelPane,
  type OnScreenPaint,
  type SidebarPane
} from '../../harness/pages'
import {
  CARD_SURFACE_CSS,
  armDownloads,
  channelDelta,
  clipboardCapture,
  compositeStack,
  cssColorIn,
  hexRgb,
  jpegSize,
  mermaidFileFacts,
  parseComputedColor,
  pngSize,
  rasterFacts,
  rgbHex,
  svgFileFacts,
  type ClipboardCapture,
  type DownloadDir,
  type ExportedPaint,
  type Rgba,
  type SvgFileFacts
} from '../../harness/figureFixtures'

const MODEL = 'e2e-model'
const USAGE = { prompt: 90, completion: 20 }
const DARK = 'nord'
const LIGHT = 'solarized-light'

/** 每条用例一个会话（标题即侧栏行文字） */
const CASES = [
  'FE-0',
  'FE-1',
  'FE-2',
  'FE-3',
  'FE-4',
  'FE-5',
  'FE-6',
  'FE-7',
  'FE-8',
  'FE-9',
  'FE-10',
  'FE-11',
  'FE-12',
  'FE-13',
  'FE-14',
  'FE-15'
] as const
const sessionTitle = (c: string): string => `figure-${c}`

/**
 * 探针图：每个元素带 data-k（净化器放行 data-*；id 会被加前缀）。
 *   a  实心 --viz-1            t  tint（半透明）+ 实心描边     w  --viz-wash（文字色 5%，派生 token）
 *   g  半透明 tint 写在 <g> 上：g1 照继承、g2 换成实心 --viz-3（导出时必须写明 fill-opacity=1）
 *   s1/s2 渐变色标，u 用 url(#grad) 填      x  属性与 style 打架（style 赢：--viz-8）
 */
const FIG = [
  '<svg viewBox="0 0 320 200" role="img" aria-label="Export probe">',
  ' <rect data-k="a" x="0" y="0" width="100" height="100" fill="var(--viz-1)"/>',
  ' <rect data-k="t" x="110" y="0" width="100" height="100" fill="var(--viz-1-tint)" stroke="var(--viz-1)"/>',
  ' <rect data-k="w" x="220" y="0" width="100" height="100" fill="var(--viz-wash)"/>',
  ' <g data-k="g" fill="var(--viz-2-tint)"><rect data-k="g1" x="0" y="110" width="100" height="80"/><rect data-k="g2" x="110" y="110" width="100" height="80" fill="var(--viz-3)"/></g>',
  ' <defs><linearGradient id="grad"><stop data-k="s1" offset="0" stop-color="var(--viz-4)"/><stop data-k="s2" offset="1" stop-color="var(--viz-5)"/></linearGradient></defs>',
  ' <rect data-k="u" x="220" y="160" width="100" height="40" fill="url(#grad)"/>',
  ' <text data-k="x" x="230" y="140" font-size="11" fill="var(--theme-text-primary)" style="fill: var(--viz-8)">label</text>',
  '</svg>'
].join('\n')

/** 第二张图（FE-8：另一张卡片） */
const FIG2 = [
  '<svg viewBox="0 0 200 100" role="img" aria-label="Second probe">',
  ' <rect data-k="b" x="10" y="10" width="80" height="80" fill="var(--viz-6)"/>',
  '</svg>'
].join('\n')

/** 导出的文件里不该有的东西：token、派生函数、PowerPoint 不认的颜色写法 */
const NOT_STANDALONE = /var\(|light-dark\(|color-mix\(|color\(srgb|rgba?\(/

/** 块之间留空行，否则 markdown 把它们并成一段 */
const doc = (...blocks: string[]): string => blocks.join('\n\n')
const fence = (lang: string, code: string): string => `\`\`\`${lang}\n${code}\n\`\`\``

let app: E2EApp
let provider: FakeProvider
let chat: ChatPane
let sidebar: SidebarPane
let panel: FigureExportPanelPane
let downloads: DownloadDir
let clipboard: ClipboardCapture
const sids: Record<string, string> = {}

beforeAll(async () => {
  app = await launchApp()
  provider = await startFakeProvider()
  await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  await waitRendererReady(app.main)
  // 文案按英文断；界面钉成深色 nord、浅色档设 solarized-light —— 「当前主题」与「浅色 / 深色」于是
  // 三套各不相同，按错主题取色立刻看得出来
  for (const [key, value] of [
    ['general.language', 'en'],
    ['general.theme', 'dark'],
    ['general.darkTheme', DARK],
    ['general.lightTheme', LIGHT]
  ]) {
    await app.main.eval(`window.api.settings.set(${JSON.stringify({ key, value })})`)
  }
  await until(
    () =>
      app.main.eval<boolean>(`document.documentElement.getAttribute('data-theme') === '${DARK}'`),
    `UI switched to ${DARK}`
  )

  const project = await createProject(app.main, { name: 'FigureExportProj', path: app.home })
  for (const c of CASES) {
    sids[c] = await app.main.eval<string>(
      `window.api.session.create(${JSON.stringify({ title: sessionTitle(c), projectId: project.id })})
        .then((s) => s.id)`
    )
  }

  chat = chatPane(app.main)
  sidebar = sidebarPane(app.main)
  panel = figureExportPanel(app.main)
  // IPC 建的会话没有广播：点一次「新对话」让侧栏拉全量列表
  await sidebar.clickNewChat()
  await until(async () => {
    const titles = await sidebar.titles()
    return CASES.every((c) => titles.includes(sessionTitle(c)))
  }, 'sidebar lists the figure-export sessions')

  downloads = await armDownloads(app.main)
  clipboard = clipboardCapture(app.main)
  await clipboard.install()
}, 120_000)

afterAll(async () => {
  downloads?.dispose()
  await provider?.close()
  await app?.stop()
})

beforeEach(async () => {
  downloads.clear()
  await clipboard.clear()
  await panel.resetPrefs()
})

// ─── 一轮回复 ────────────────────────────────────────────────

/** 切到这条用例的会话，让模型回一段（marker 开头），等这一轮落定 */
async function reply(c: (typeof CASES)[number], ...blocks: string[]): Promise<string> {
  const marker = `MARK-${c}`
  expect(await sidebar.openSession(sessionTitle(c))).toBe(true)
  await chat.ready()
  provider.reset()
  provider.script({ text: doc(`${marker} here:`, ...blocks), usage: USAGE })
  await chat.typeAndSend(`draw ${c}`)
  await chat.waitIdle()
  return marker
}

/** 回一张图，等它画出来，回卡片 */
async function figureCard(
  c: (typeof CASES)[number],
  kind: FigureCardKind,
  ...blocks: string[]
): Promise<FigureCardPane> {
  const marker = await reply(c, ...blocks)
  const card = figureCardPane(app.main, marker, kind)
  await card.waitFigure()
  return card
}

// ─── 比较 ──────────────────────────────────────────────────

/** 计算值串 / #hex → 分量 */
const rgbOf = (v: string): Rgba =>
  v.startsWith('#') ? { ...hexRgb(v), a: 1 } : parseComputedColor(v)

/** 导出文件里一个元素的「颜色 + 实际不透明度」与屏幕上同一个元素的计算值比 */
function expectSamePaint(k: string, exported: ExportedPaint, screen: OnScreenPaint): void {
  const pairs = [
    ['fill', exported.fill ?? '#000000', exported.fillOpacity, screen.fill, screen.fillOpacity],
    [
      'stroke',
      exported.stroke ?? 'none',
      exported.strokeOpacity,
      screen.stroke,
      screen.strokeOpacity
    ]
  ] as const
  for (const [what, ex, exOpacity, sc, scOpacity] of pairs) {
    const label = `${k}.${what}: exported ${ex} / ${exOpacity} vs screen ${sc} / ${scOpacity}`
    if (sc === 'none') {
      expect(ex, label).toBe('none')
      continue
    }
    if (sc.startsWith('url(')) {
      const id = /#([^)"']+)/.exec(sc)?.[1]
      expect(ex, label).toBe(`url(#${id})`)
      continue
    }
    expect(ex, label).toMatch(/^#[0-9a-f]{6}$/)
    const s = parseComputedColor(sc)
    expect(channelDelta(hexRgb(ex), s), label).toBeLessThanOrEqual(1)
    const want = s.a * Number(scOpacity)
    expect(Math.abs(Number(exOpacity ?? '1') - want), label).toBeLessThanOrEqual(0.005)
  }
}

/** 色标（stop-color / stop-opacity 不继承，只看自己） */
function expectSameStop(k: string, exported: ExportedPaint, screen: OnScreenPaint): void {
  const label = `${k}: exported ${exported.stopColor} / ${exported.stopOpacity} vs screen ${screen.stopColor} / ${screen.stopOpacity}`
  expect(exported.stopColor, label).toMatch(/^#[0-9a-f]{6}$/)
  const s = parseComputedColor(screen.stopColor)
  expect(channelDelta(hexRgb(exported.stopColor!), s), label).toBeLessThanOrEqual(1)
  expect(
    Math.abs(Number(exported.stopOpacity ?? '1') - s.a * Number(screen.stopOpacity)),
    label
  ).toBeLessThanOrEqual(0.005)
}

/** 导出文件「独立成立」的形状检查（FE-2 / FE-10 共用） */
function expectStandalone(text: string, facts: SvgFileFacts): void {
  expect(facts.parseError).toBe(false)
  expect(facts.rootTag).toBe('svg')
  expect(facts.ns).toBe('http://www.w3.org/2000/svg')
  expect(text).not.toMatch(NOT_STANDALONE)
  for (const p of facts.paints) {
    expect(p, `paint ${p}`).toMatch(/^(#[0-9a-f]{6}|none|url\(#[^)]+\))$/)
  }
}

const near = (
  a: { r: number; g: number; b: number },
  b: { r: number; g: number; b: number },
  tol: number,
  what: string
): void => {
  expect(channelDelta(a, b), `${what}: ${rgbHex(a)} vs ${rgbHex(b)}`).toBeLessThanOrEqual(tol)
}

// ═══════════════════════════════════════════════════════════════

describe('对话图卡的导出', () => {
  it('FE-0 冒烟：落盘真的被 setDownloadBehavior 接住了（导出 SVG → 文件出现在临时目录里）', async () => {
    const card = await figureCard('FE-0', 'svg', fence('svg', FIG))
    await card.openExport()
    await panel.choose('format', 'svg')
    await panel.download()
    const buf = await downloads.waitFile('Export probe.svg')
    expect(buf.toString('utf8').startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<svg')).toBe(
      true
    )
    await panel.waitClosed()
  }, 120_000)

  it('FE-1 写完的图有「Export」；缺省 PNG / 当前主题 / 填充 / 2x；文件名取 aria-label；640 × 400 px', async () => {
    const card = await figureCard('FE-1', 'svg', fence('svg', FIG))
    const shot = await card.shot()
    expect(shot?.hasExport).toBe(true)
    expect(shot?.exportText).toBe('Export')
    await card.openExport()
    const p = await panel.waitReady()
    expect(p.checked).toEqual({ format: 'png', scheme: 'current', background: 'fill', scale: '2' })
    expect(p.fileName).toBe('Export probe.png')
    expect(p.dims).toBe('640 × 400 px')
    expect(p.checkerboard).toBe(false)
    expect(p.downloadDisabled).toBe(false)
    expect(await panel.focus()).toBe('download')
  }, 120_000)

  it('FE-2 SVG（当前主题）：独立成立的 XML；每个元素的颜色与不透明度 = 屏幕上的计算值；底色 = 图卡在屏幕上那层底', async () => {
    const card = await figureCard('FE-2', 'svg', fence('svg', FIG))
    const screen = await card.svgFacts()
    const surface = compositeStack(await card.surfaceStack())
    await card.openExport()
    await panel.choose('format', 'svg')
    await panel.download()
    const text = (await downloads.waitFile('Export probe.svg')).toString('utf8')
    expect(text.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')).toBe(true)
    const facts = await svgFileFacts(app.main, text)
    expectStandalone(text, facts)
    expect([facts.width, facts.height, facts.viewBox]).toEqual(['320', '200', '0 0 320 200'])

    for (const k of ['a', 't', 'w', 'g', 'g1', 'g2', 'u', 'x']) {
      expect(facts.perK[k], `exported ${k}`).toBeDefined()
      expectSamePaint(k, facts.perK[k], screen[k])
    }
    for (const k of ['s1', 's2']) expectSameStop(k, facts.perK[k], screen[k])

    // 点名几处最容易错的
    const viz1 = rgbOf(screen.a.fill)
    expect(facts.perK.t.fill).toBe(rgbHex(viz1))
    expect(facts.perK.t.fillOpacity).toBe('0.14')
    expect(facts.perK.g2.fillOpacity).toBe('1')
    expect(facts.perK.x.fill).toBe(rgbHex(rgbOf(screen.x.fill)))
    expect(facts.perK.x.style).toBeNull()
    const gradId = /^url\(#(.+)\)$/.exec(facts.perK.u.fill ?? '')?.[1]
    expect(facts.ids).toContainEqual({ id: gradId, tag: 'linearGradient' })

    // 第一个子元素是底色矩形：盖住整个坐标框，颜色 = 图卡在屏幕上合成出来的那层底
    expect(facts.first?.tag).toBe('rect')
    const bg = facts.first!.attrs
    expect([bg.x, bg.y, bg.width, bg.height]).toEqual(['0', '0', '320', '200'])
    expect(bg['data-k']).toBeUndefined()
    expect(bg['fill-opacity']).toBeUndefined()
    near(hexRgb(bg.fill), surface, 1, 'background rect vs on-screen card surface')
  }, 120_000)

  it('FE-3 导出的 SVG 当图片画到画布上：像素 = 屏幕颜色（实心、半透明叠在底上、空隙是底）', async () => {
    const card = await figureCard('FE-3', 'svg', fence('svg', FIG))
    const screen = await card.svgFacts()
    const surface = compositeStack(await card.surfaceStack())
    await card.openExport()
    await panel.choose('format', 'svg')
    const svg = await panel.previewSvg()
    const raster = await rasterFacts(
      app.main,
      { mime: 'image/svg+xml', data: svg },
      {
        points: [
          [50, 50],
          [160, 50],
          [105, 105]
        ]
      }
    )
    expect([raster.width, raster.height]).toEqual([320, 200])
    const [a, t, gap] = raster.pixels
    const viz1 = rgbOf(screen.a.fill)
    near(a, viz1, 2, 'a')
    const tint = {
      r: 0.14 * viz1.r + 0.86 * surface.r,
      g: 0.14 * viz1.g + 0.86 * surface.g,
      b: 0.14 * viz1.b + 0.86 * surface.b
    }
    near(t, tint, 4, 't')
    near(gap, surface, 2, 'gap')
    expect(gap.a).toBe(255)
  }, 120_000)

  it('FE-4 浅 / 深按设定的两套主题取色（界面 nord）：浅色 = solarized-light 的 viz-1 / 文字色派生的 wash / 卡片底；深色 = nord 的', async () => {
    const card = await figureCard('FE-4', 'svg', fence('svg', FIG))
    await card.openExport()
    await panel.choose('format', 'svg')

    await panel.choose('scheme', 'light')
    const light = await svgFileFacts(app.main, await panel.previewSvg())
    expect(light.perK.a.fill).toBe('#2a78d6')
    const lightText = rgbHex(await cssColorIn(app.main, LIGHT, 'var(--theme-text-primary)'))
    const darkText = rgbHex(await cssColorIn(app.main, DARK, 'var(--theme-text-primary)'))
    expect(lightText).not.toBe(darkText)
    // --viz-wash = 文字色 5%：必须是**那套主题**的文字色（只声明在 :root 上时它顶着 nord 的）
    expect(light.perK.w.fill).toBe(lightText)
    expect(light.perK.w.fillOpacity).toBe('0.05')
    const lightCard = await cssColorIn(app.main, LIGHT, CARD_SURFACE_CSS)
    near(hexRgb(light.first!.attrs.fill), lightCard, 1, 'light background')

    await panel.choose('scheme', 'dark')
    const dark = await svgFileFacts(app.main, await panel.previewSvg())
    expect(dark.perK.a.fill).toBe('#3987e5')
    expect(dark.perK.w.fill).toBe(darkText)
    const darkCard = await cssColorIn(app.main, DARK, CARD_SURFACE_CSS)
    near(hexRgb(dark.first!.attrs.fill), darkCard, 1, 'dark background')
    expect(rgbHex(lightCard)).not.toBe(rgbHex(darkCard))

    // 界面本身没换主题；离屏容器用完即摘
    expect(await app.main.eval<string>(`document.documentElement.getAttribute('data-theme')`)).toBe(
      DARK
    )
    expect(
      await app.main.eval<number>(
        `document.querySelectorAll('body > div[aria-hidden="true"][data-theme]').length`
      )
    ).toBe(0)
  }, 120_000)

  it('FE-5 PNG 1x / 2x / 3x：PNG 文件头、IHDR 尺寸按倍率；像素是 viz-1；填充底不透明、透明底 α=0', async () => {
    const card = await figureCard('FE-5', 'svg', fence('svg', FIG))
    const screen = await card.svgFacts()
    const surface = compositeStack(await card.surfaceStack())
    const viz1 = rgbOf(screen.a.fill)
    for (const scale of [1, 2, 3]) {
      downloads.clear()
      await card.openExport()
      await panel.choose('scale', scale)
      await panel.download()
      const buf = await downloads.waitFile('Export probe.png')
      expect(pngSize(buf)).toEqual({ width: 320 * scale, height: 200 * scale })
      const r = await rasterFacts(
        app.main,
        { mime: 'image/png', data: buf },
        {
          points: [
            [50 * scale, 50 * scale],
            [105 * scale, 105 * scale]
          ]
        }
      )
      near(r.pixels[0], viz1, 2, `a @${scale}x`)
      near(r.pixels[1], surface, 2, `gap @${scale}x`)
      expect(r.pixels[1].a, `gap alpha @${scale}x`).toBe(255)
      await panel.waitClosed()
    }

    downloads.clear()
    await card.openExport()
    await panel.choose('background', 'none')
    await panel.download()
    const buf = await downloads.waitFile('Export probe.png')
    expect(pngSize(buf)).toEqual({ width: 960, height: 600 })
    const r = await rasterFacts(
      app.main,
      { mime: 'image/png', data: buf },
      {
        points: [
          [150, 150],
          [315, 315],
          [2, 597]
        ]
      }
    )
    near(r.pixels[0], viz1, 2, 'a (transparent)')
    expect(r.pixels[0].a).toBe(255)
    expect(r.pixels[1].a, 'gap alpha (transparent)').toBe(0)
    expect(r.pixels[2].a, 'bottom-left gap alpha (transparent)').toBe(0)
  }, 180_000)

  it('FE-6 JPG：记住的「透明」被顶成填充、透明那档不能选；JPEG 文件头 / SOF 尺寸；空隙是底色不是黑；切回 PNG 透明回来', async () => {
    const card = await figureCard('FE-6', 'svg', fence('svg', FIG))
    const surface = compositeStack(await card.surfaceStack())
    await card.openExport()
    await panel.choose('background', 'none')
    const jpg = await panel.choose('format', 'jpg')
    expect(jpg.checked.background).toBe('fill')
    expect(jpg.disabled).toContain('background:none')
    expect(jpg.fileName).toBe('Export probe.jpg')
    expect(jpg.text).toContain('JPG has no transparency')
    await panel.download()
    const buf = await downloads.waitFile('Export probe.jpg')
    expect(jpegSize(buf)).toEqual({ width: 640, height: 400 })
    const r = await rasterFacts(
      app.main,
      { mime: 'image/jpeg', data: buf },
      {
        points: [
          [210, 210],
          [4, 394]
        ]
      }
    )
    for (const [i, px] of r.pixels.entries()) {
      near(px, surface, 6, `jpg gap #${i}`)
      expect(px.r + px.g + px.b, `jpg gap #${i} is not black`).toBeGreaterThan(30)
    }

    await card.openExport()
    const png = await panel.choose('format', 'png')
    expect(png.checked.background).toBe('none')
    expect(png.disabled).not.toContain('background:none')
  }, 120_000)

  it('FE-7 复制（格式选着 SVG 也一样）：写进剪贴板的是一项 image/png，2x 解出来 640 × 400；按钮显示 Copied', async () => {
    const card = await figureCard('FE-7', 'svg', fence('svg', FIG))
    await card.openExport()
    await panel.choose('format', 'svg')
    await panel.copy()
    const clip = await clipboard.wait()
    expect(clip.types).toEqual(['image/png'])
    expect(clip.mime).toBe('image/png')
    expect([clip.width, clip.height]).toEqual([640, 400])
    expect(clip.size).toBeGreaterThan(0)
    await until(async () => (await panel.shot())?.copyLabel === 'Copied', 'copy button says Copied')
    expect((await panel.shot())?.actionError).toBeNull()
  }, 120_000)

  it('FE-8 记住的选择跨卡片：一张卡上选 SVG + 深色 + 透明，收起，另一张卡打开时就是这三项', async () => {
    const marker = await reply('FE-8', fence('svg', FIG), fence('svg', FIG2))
    const first = figureCardPane(app.main, marker, 'svg', 0)
    const second = figureCardPane(app.main, marker, 'svg', 1)
    await first.waitFigure()
    await second.waitFigure()
    await first.openExport()
    await panel.choose('format', 'svg')
    await panel.choose('scheme', 'dark')
    await panel.choose('background', 'none')
    await first.clickExport()
    await panel.waitClosed()
    expect(await panel.storedPrefs()).toEqual({
      format: 'svg',
      scheme: 'dark',
      background: false,
      scale: 2
    })

    await second.openExport()
    const p = await panel.waitReady()
    expect(p.checked).toEqual({ format: 'svg', scheme: 'dark', background: 'none', scale: '2' })
    expect(p.fileName).toBe('Second probe.svg')
    expect(p.checkerboard).toBe(true)
  }, 120_000)

  it('FE-9 mermaid：当前主题复用屏幕上那次渲染；文件名取 title；浅色按 solarized-light 重渲（节点面 / 底色）；PNG 里标签画出来了', async () => {
    const code = '---\ntitle: Flow chart\n---\ngraph LR\n  fe9a[Plan] --> fe9b[Ship it]'
    const card = await figureCard('FE-9', 'mermaid', fence('mermaid', code))
    const onScreenId = await card.figureId()
    expect(onScreenId).not.toBe('')
    await card.openExport()
    expect((await panel.waitReady()).fileName).toBe('Flow chart.png')

    await panel.choose('format', 'svg')
    const current = await panel.previewSvg()
    const cur = await svgFileFacts(app.main, current)
    expect(cur.parseError).toBe(false)
    expect(cur.id).toBe(onScreenId)
    expect(cur.rootStyle ?? '').not.toContain('max-width')
    expect(Number(cur.width)).toBeGreaterThan(0)

    const light = await panel.choose('scheme', 'light')
    expect(light.preview).toBe('ready')
    const lightSvg = await panel.previewSvg()
    const lf = await svgFileFacts(app.main, lightSvg)
    expect(lf.parseError).toBe(false)
    expect(lf.id).not.toBe(onScreenId)
    const node = await mermaidFileFacts(app.main, lightSvg)
    const lightTertiary = await cssColorIn(app.main, LIGHT, 'var(--theme-bg-tertiary)')
    near(rgbOf(node.nodeFill), lightTertiary, 1, 'light node fill')
    near(
      hexRgb(lf.first!.attrs.fill),
      await cssColorIn(app.main, LIGHT, CARD_SURFACE_CSS),
      1,
      'light bg'
    )
    expect(await app.main.eval<string>(`document.documentElement.getAttribute('data-theme')`)).toBe(
      DARK
    )

    await panel.choose('format', 'png')
    await panel.download()
    const buf = await downloads.waitFile('Flow chart.png')
    const size = pngSize(buf)
    expect(size.width).toBeGreaterThan(0)
    // 节点框里不是一片纯色：标签（foreignObject）画进了位图
    const k = 2
    const r = await rasterFacts(
      app.main,
      { mime: 'image/png', data: buf },
      {
        region: {
          x: node.nodeBox.x * k,
          y: node.nodeBox.y * k,
          width: node.nodeBox.width * k,
          height: node.nodeBox.height * k
        }
      }
    )
    expect(r.region!.maxDelta, JSON.stringify(node.nodeBox)).toBeGreaterThan(60)
  }, 120_000)

  it('FE-10 ```artifact 引用的 svg：有导出，文件名 = 产物标题；导出的 SVG 同样烘焙过；.md 产物没有导出', async () => {
    const dir = join(app.home, '.shuvix', 'artifacts', sids['FE-10'])
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'probe.svg'), FIG.replace('Export probe', 'Revenue split'))
    writeFileSync(join(dir, 'notes.md'), '# Notes\n\nplain text\n')
    const marker = await reply(
      'FE-10',
      fence('artifact', 'probe.svg'),
      fence('artifact', 'notes.md')
    )
    const card = figureCardPane(app.main, marker, 'artifact', 0)
    await card.waitFigure()
    expect((await card.shot())?.label).toBe('Revenue split')
    const notes = figureCardPane(app.main, marker, 'artifact', 1)
    await until(async () => (await notes.shot()) !== null, 'notes.md artifact card')
    expect((await notes.shot())?.hasExport).toBe(false)
    expect(await figureExportButtonsIn(app.main, marker)).toBe(1)

    await card.openExport()
    expect((await panel.waitReady()).fileName).toBe('Revenue split.png')
    await panel.choose('format', 'svg')
    await panel.download()
    const text = (await downloads.waitFile('Revenue split.svg')).toString('utf8')
    expectStandalone(text, await svgFileFacts(app.main, text))
  }, 120_000)

  it('FE-11 流式中的半张图（还没写到 </svg>）不给导出；写完、落定后有', async () => {
    expect(await sidebar.openSession(sessionTitle('FE-11'))).toBe(true)
    await chat.ready()
    provider.reset()
    const [open, ...rest] = FIG.split('\n')
    provider.script({
      text: [
        'MARK-FE-11 streaming:\n\n',
        `\`\`\`svg\n${open}\n${rest.slice(0, 2).join('\n')}\n`,
        `${rest.slice(2, -1).join('\n')}\n`,
        '</svg>\n```\n\nMARK-FE-11-TAIL done.'
      ],
      chunkDelayMs: 1500,
      holdMs: 3000,
      usage: USAGE
    })
    await chat.typeAndSend('draw FE-11')
    const card = figureCardPane(app.main, 'MARK-FE-11', 'svg')
    // 半张图已经画着（开标签闭合即出第一帧），这一刻还在流式、没有导出
    const partial = await until(async () => {
      const s = await card.shot()
      return s?.figure ? s : null
    }, 'partial svg frame on screen')
    expect(partial.hasExport).toBe(false)
    expect(await chat.isBusy()).toBe(true)

    provider.release()
    await chat.waitIdle()
    await until(
      async () => (await card.shot())?.hasExport === true,
      'export after the reply settled'
    )
  }, 120_000)

  it('FE-12 收起：Esc（焦点回到导出按钮）、在外面按下、再点导出按钮；点选项不收起', async () => {
    const card = await figureCard('FE-12', 'svg', fence('svg', FIG))
    await card.openExport()
    await panel.choose('format', 'jpg')
    await panel.choose('scheme', 'light')
    expect(await panel.isOpen()).toBe(true)
    await panel.pressEscape()
    await panel.waitClosed()
    expect(await card.exportFocused()).toBe(true)

    await card.openExport()
    await panel.mousedownOutside()
    await panel.waitClosed()

    await card.openExport()
    await card.clickExport()
    await panel.waitClosed()
  }, 120_000)

  it('FE-13 ```interactive 交互图没有导出', async () => {
    const marker = await reply(
      'FE-13',
      fence('interactive', '<div id="fe13">interactive block</div>'),
      fence('svg', FIG2)
    )
    // 前提：交互图真的挂成了沙箱 iframe（不是落成了普通代码块）
    await interactivePane(app.main, marker).waitFrame()
    // 对照：同一条消息里的 svg 卡有，所以这条消息里恰好一颗
    await figureCardPane(app.main, marker, 'svg').waitFigure()
    expect(await figureExportButtonsIn(app.main, marker)).toBe(1)
  }, 120_000)

  it('FE-14 中文界面：按钮「导出」、面板「复制图片」/「下载」，缺省文件名跟着走', async () => {
    try {
      await app.main.eval(`window.api.settings.set({ key: 'general.language', value: 'zh' })`)
      const card = await figureCard(
        'FE-14',
        'svg',
        fence('svg', FIG2.replace(' aria-label="Second probe"', ''))
      )
      await until(async () => (await card.shot())?.exportText === '导出', 'export button in zh')
      await card.openExport()
      const p = await panel.waitReady()
      expect(p.copyLabel).toBe('复制图片')
      expect(p.downloadLabel).toBe('下载')
      expect(p.fileName).toBe('图.png')
    } finally {
      await app.main.eval(`window.api.settings.set({ key: 'general.language', value: 'en' })`)
    }
  }, 120_000)

  it('FE-15 12000 × 12000 的图选 3x：位图封顶（尺寸说明与 IHDR 一致，单边 ≤ 16384、总像素 ≤ 4000 万）', async () => {
    const huge = [
      '<svg viewBox="0 0 12000 12000" role="img" aria-label="Huge probe">',
      ' <rect x="0" y="0" width="6000" height="6000" fill="var(--viz-1)"/>',
      '</svg>'
    ].join('\n')
    const card = await figureCard('FE-15', 'svg', fence('svg', huge))
    await card.openExport()
    const p = await panel.choose('scale', 3)
    expect(p.dims).toBe('6324 × 6324 px')
    await panel.download()
    const buf = await downloads.waitFile('Huge probe.png', 60_000)
    const size = pngSize(buf)
    expect(size).toEqual({ width: 6324, height: 6324 })
    expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(16384)
    expect(size.width * size.height).toBeLessThanOrEqual(40_000_000)
  }, 180_000)
})
