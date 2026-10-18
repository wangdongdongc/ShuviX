/**
 * 笔记本里图的「导出」—— atomic-editor 在 ```svg / ```mermaid 预览上画的悬浮按钮，点开的是 chat-ui
 * 那同一个面板（LivePreviewEditor 接线）。单测（atomic-editor 的 figure-export.test.tsx、app-shell 的
 * notebookFigureSource.test.ts）够不着、只有真窗口里才成立的几件：
 *
 *   - **悬停才显形、真鼠标点得到、点它不揭示源码**（NB-1）：按钮吞掉自己的 mousedown，CM6 的选区
 *     一格不动、图还在 —— 合成事件证明不了这一条，走 CDP 的可信鼠标；
 *   - **底色取页面那一层、颜色是屏幕上的**（NB-2）：笔记本的图直接画在编辑器底色上，不像对话坐在卡里；
 *   - **mermaid 与手写图同一条烘焙路径**（NB-3）：pele 画的图颜色是 `var(--pele-*)`，在笔记本里直接坐
 *     在页面底上（没有白卡）、节点是 bg-tertiary；导出当前 / 浅色 / 深色都按那套主题把 token 解成
 *     具体色（浅 / 深 = 设定里的 solarized-light / nord），底色与边标签衬底都是页面底；文件名取
 *     frontmatter 的 title；
 *   - **面板跟着按钮走**（NB-4…6）：开着面板去点另一张图的按钮 → 换成那张图；再点同一颗 → 收起；
 *     光标进了那个围栏（widget 被换成源码、按钮没了）→ 收起；
 *   - **记住的选择与对话共用**（NB-7）。
 *
 * 选择器全部走 pages.ts 的 `notebookFigurePane` / `figureExportPanel` / `sidebarPane`；读产物在
 * harness/figureFixtures.ts。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { until } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import { createProject } from '../../harness/seed'
import {
  figureExportPanel,
  notebookFigurePane,
  sidebarPane,
  type FigureExportPanelPane,
  type NotebookFigurePane
} from '../../harness/pages'
import {
  PAGE_SURFACE_CSS,
  channelDelta,
  compositeStack,
  cssColorIn,
  hexRgb,
  mermaidFileFacts,
  parseComputedColor,
  rgbHex,
  svgFileFacts
} from '../../harness/figureFixtures'

const NOTE_FILE = 'figure-export-note.md'

const FIG = [
  '<svg viewBox="0 0 320 200" role="img" aria-label="Notebook probe">',
  '  <rect data-k="a" x="0" y="0" width="100" height="100" fill="var(--viz-1)"/>',
  '  <rect data-k="t" x="110" y="0" width="100" height="100" fill="var(--viz-1-tint)" stroke="var(--viz-1)"/>',
  '  <text data-k="x" x="230" y="140" font-size="11" fill="var(--viz-8)">label</text>',
  '</svg>'
].join('\n')

const FIG2 = [
  '<svg viewBox="0 0 200 100" role="img" aria-label="Second figure">',
  '  <rect data-k="b" x="10" y="10" width="80" height="80" fill="var(--viz-6)"/>',
  '</svg>'
].join('\n')

const MERMAID = ['---', 'title: Flow', '---', 'graph LR', '  nba[Plan] -->|go| nbb[Ship]'].join(
  '\n'
)

/** 导出「浅色 / 深色」用的两套主题（设定里写死，与界面当前的主题不同，按错主题取色立刻看得出来） */
const LIGHT = 'solarized-light'
const DARK = 'nord'

const NOTE = [
  '# Figure export note',
  '',
  'Intro paragraph.',
  '',
  '```svg',
  FIG,
  '```',
  '',
  'Between the figures.',
  '',
  '```svg',
  FIG2,
  '```',
  '',
  '```mermaid',
  MERMAID,
  '```',
  '',
  'tail.',
  ''
].join('\n')

/** 导出的文件里不该有的东西（与对话那边同一条） */
const NOT_STANDALONE = /var\(|light-dark\(|color-mix\(|color\(srgb|rgba?\(/

let app: E2EApp
let panel: FigureExportPanelPane
let first: NotebookFigurePane
let second: NotebookFigurePane
let flow: NotebookFigurePane

beforeAll(async () => {
  app = await launchApp()
  for (const [key, value] of [
    ['general.language', 'en'],
    ['general.lightTheme', LIGHT],
    ['general.darkTheme', DARK]
  ]) {
    await app.main.eval(`window.api.settings.set(${JSON.stringify({ key, value })})`)
  }
  const projDir = join(app.home, 'proj-figure-export')
  mkdirSync(projDir, { recursive: true })
  writeFileSync(join(projDir, NOTE_FILE), NOTE)
  const project = await createProject(app.main, { name: 'FigureExportNoteProj', path: projDir })
  await app.main.eval(
    `window.api.session.create(${JSON.stringify({
      projectId: project.id,
      notebookPath: join(projDir, NOTE_FILE)
    })})`
  )
  const sidebar = sidebarPane(app.main)
  await until(
    () => sidebar.titles().then((titles) => titles.includes(NOTE_FILE)),
    `sidebar row "${NOTE_FILE}"`
  )
  expect(await sidebar.openSession(NOTE_FILE)).toBe(true)

  panel = figureExportPanel(app.main)
  first = notebookFigurePane(app.main, 'svg', 'Notebook probe')
  second = notebookFigurePane(app.main, 'svg', 'Second figure')
  flow = notebookFigurePane(app.main, 'mermaid', 0)
  await first.waitFigure()
  await second.waitFigure()
  await flow.waitFigure(40_000)
}, 120_000)

afterAll(async () => {
  await app?.stop()
})

beforeEach(async () => {
  if (await panel.isOpen()) {
    await panel.pressEscape()
    await panel.waitClosed()
  }
  await panel.resetPrefs()
})

const near = (
  a: { r: number; g: number; b: number },
  b: { r: number; g: number; b: number },
  tol: number,
  what: string
): void => {
  expect(channelDelta(a, b), `${what}: ${rgbHex(a)} vs ${rgbHex(b)}`).toBeLessThanOrEqual(tol)
}

describe('笔记本里图的导出', () => {
  it('NB-1 按钮平时看不见、悬停显形；真鼠标点它：面板打开、图还在、CM6 选区不动', async () => {
    expect(await first.hasExport()).toBe(true)
    await first.mouseAway()
    await until(async () => (await first.exportOpacity()) === 0, 'export button hidden')
    await first.hover()
    await until(async () => (await first.exportOpacity()) === 1, 'export button shown on hover')

    const head = await first.selectionHead()
    await first.clickExport()
    const p = await panel.waitReady()
    expect(p.fileName).toBe('Notebook probe.png')
    expect(await first.stillRendered()).toBe(true)
    expect(await first.selectionHead()).toBe(head)
  }, 120_000)

  it('NB-2 SVG（当前主题 + 填充）：底色 = 图下面那层页面底（bg-primary），颜色 = 屏幕上的；没有 token', async () => {
    const screen = await first.svgFacts()
    const surface = compositeStack(await first.surfaceStack())
    near(surface, await cssColorIn(app.main, '', PAGE_SURFACE_CSS), 1, 'page surface is bg-primary')

    await first.hover()
    await first.clickExport()
    await panel.waitReady()
    await panel.choose('format', 'svg')
    const svg = await panel.previewSvg()
    expect(svg).not.toMatch(NOT_STANDALONE)
    const facts = await svgFileFacts(app.main, svg)
    expect(facts.parseError).toBe(false)
    expect(facts.first?.tag).toBe('rect')
    near(hexRgb(facts.first!.attrs.fill), surface, 1, 'background rect')
    near(hexRgb(facts.perK.a.fill!), parseComputedColor(screen.a.fill), 1, 'a')
    expect(facts.perK.t.fillOpacity).toBe('0.14')
    near(hexRgb(facts.perK.x.fill!), parseComputedColor(screen.x.fill), 1, 'x')
  }, 120_000)

  it('NB-3 mermaid（pele）：屏幕上坐在页面底上（没有白卡）、节点 = bg-tertiary；导出按当前 / 浅色 / 深色那套主题烘焙，底色与边标签衬底 = 页面底；文件名 Flow', async () => {
    const stack = await flow.surfaceStack()
    // 放图那一格自己透明：图直接画在编辑器底色上，不再垫一块白卡
    expect(parseComputedColor(stack[0]).a).toBe(0)
    const page = await cssColorIn(app.main, '', PAGE_SURFACE_CSS)
    near(compositeStack(stack), page, 1, 'notebook mermaid sits on the page surface')
    const screen = await flow.peleColors()
    near(
      parseComputedColor(screen.nodeFill),
      await cssColorIn(app.main, '', 'var(--theme-bg-tertiary)'),
      1,
      'on-screen node fill = bg-tertiary'
    )

    await flow.hover()
    await flow.clickExport()
    const p = await panel.waitReady()
    expect(p.fileName).toBe('Flow.png')

    // 当前主题 + 填充
    await panel.choose('format', 'svg')
    const current = await panel.previewSvg()
    expect(current).not.toMatch(NOT_STANDALONE)
    const cur = await svgFileFacts(app.main, current)
    expect(cur.parseError).toBe(false)
    expect(cur.first?.tag).toBe('rect')
    const curBg = hexRgb(cur.first!.attrs.fill)
    near(curBg, page, 1, 'current bg = page')
    const curFile = await mermaidFileFacts(app.main, current)
    near(
      parseComputedColor(curFile.nodeFill),
      parseComputedColor(screen.nodeFill),
      1,
      'current node fill = on screen'
    )
    near(parseComputedColor(curFile.edgeLabelFill), curBg, 1, 'current edge label backing = bg')

    // 浅色 / 深色：设定里的那两套主题
    const previews: Record<string, string> = {}
    for (const [scheme, theme] of [
      ['light', LIGHT],
      ['dark', DARK]
    ] as const) {
      await panel.choose('scheme', scheme)
      const svg = await panel.previewSvg()
      previews[scheme] = svg
      expect(svg, scheme).not.toMatch(NOT_STANDALONE)
      const facts = await svgFileFacts(app.main, svg)
      expect(facts.parseError).toBe(false)
      expect(facts.first?.tag).toBe('rect')
      const bg = await cssColorIn(app.main, theme, PAGE_SURFACE_CSS)
      near(hexRgb(facts.first!.attrs.fill), bg, 1, `${scheme} bg = ${theme} page`)
      const file = await mermaidFileFacts(app.main, svg)
      near(
        parseComputedColor(file.nodeFill),
        await cssColorIn(app.main, theme, 'var(--theme-bg-tertiary)'),
        1,
        `${scheme} node fill = ${theme} bg-tertiary`
      )
      near(parseComputedColor(file.edgeLabelFill), bg, 1, `${scheme} edge label backing`)
    }
    expect(previews.light).not.toBe(previews.dark)
    expect((await panel.shot())?.fileName).toBe('Flow.svg')
  }, 120_000)

  it('NB-4 开着面板去点另一张图的按钮：换成那张图（预览、文件名都是第二张的）', async () => {
    await first.hover()
    await first.clickExport()
    await panel.waitReady()
    expect(await panel.previewSvg()).toContain('Notebook probe')

    await second.hover()
    await second.clickExport()
    const p = await until(async () => {
      const s = await panel.shot()
      return s?.fileName === 'Second figure.png' && s.preview === 'ready' ? s : null
    }, 'panel switched to the second figure')
    expect(p.fileName).toBe('Second figure.png')
    const svg = await panel.previewSvg()
    expect(svg).toContain('Second figure')
    expect(svg).not.toContain('Notebook probe')
    expect(await first.stillRendered()).toBe(true)
    expect(await second.stillRendered()).toBe(true)
  }, 120_000)

  it('NB-5 再点同一颗按钮：收起', async () => {
    await second.hover()
    await second.clickExport()
    await panel.waitReady()
    await second.clickExport()
    await panel.waitClosed()
  }, 120_000)

  it('NB-6 开着面板时光标进了那个围栏（图换成源码、按钮没了）：面板收起', async () => {
    await first.hover()
    await first.clickExport()
    await panel.waitReady()
    await first.placeCaretInFence()
    await until(async () => !(await first.stillRendered()), 'figure revealed as source')
    await panel.waitClosed()
  }, 120_000)

  it('NB-7 记住的选择：一张图上选 SVG + 深色 + 透明，收起后另一张图打开就是这三项', async () => {
    // 上一条把光标留在了第一张图的围栏里：放回文末，图重新画出来
    await flow.placeCaretInFence()
    await first.waitFigure()
    await second.hover()
    await second.clickExport()
    await panel.waitReady()
    await panel.choose('format', 'svg')
    await panel.choose('scheme', 'dark')
    await panel.choose('background', 'none')
    await second.clickExport()
    await panel.waitClosed()

    await first.hover()
    await first.clickExport()
    const p = await panel.waitReady()
    expect(p.checked).toEqual({ format: 'svg', scheme: 'dark', background: 'none', scale: '2' })
    expect(p.fileName).toBe('Notebook probe.svg')
    expect(p.checkerboard).toBe(true)
  }, 120_000)
})
