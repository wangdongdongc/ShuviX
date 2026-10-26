/**
 * 对话里的 ```mermaid 图（渲染器是 pele）—— 单测（chat-ui 的 mermaidBlock.dom.test.tsx：jsdom 里跑
 * 真 pele）结构上够不着的那几件：
 *
 *   1. **接线**。单测直接挂 MermaidBlock、自己包 MarkdownStreamingContext；「流式标志与围栏闭合与否
 *      从消息状态经 AssistantBubble → ReactMarkdown → CodeBlock 一路传到图」这条链没有任何单测覆盖。
 *      E-2 / E-3 / E-5 的「流式中逐帧画、写完才出错、写完才给导出」只有这条链真的接上才成立；
 *   2. **真级联里的颜色**：pele 的产物把颜色写成 `var(--pele-*)`，themes.css 的 `.pele` 那段把它们接到
 *      主题 token 上，卡片的 `data-figure-surface="card"` 再告诉它坐在哪层底上 —— 节点面 =
 *      `--theme-bg-primary`（比卡片凸一级）、标签字色 = `--theme-text-primary`、边标签衬底 = 卡片那层
 *      底（`--figure-surface`）；切主题只换色、不重渲（同一个 `<svg>` 元素）。jsdom 不做级联；
 *   3. **真 Chromium 的布局与滚动**：长竖图按栏宽截断 —— 框高封顶、图按原宽画（不是整张压扁）、底部
 *      渐隐；就地「展开」后不限高、整张按原宽摆在对话里（同一个 <svg>），切走会话再回来仍是展开的；
 *      从图底下那条「收起」时卡片一下子矮了一千多像素，组件把它拉回视野，而不是让视野落进后面的
 *      内容里（E-4）。展开了还被栏宽缩着的宽图（pele 重排也收不进）才给「Full size」弹窗：按原宽、
 *      可滚动，关掉后仍是展开的（E-7）。自然宽度放不下这一栏的横排图由 pele 按栏宽重排，而不是整张
 *      缩小（E-6）。jsdom 的几何全是 0，也不会滚。
 *
 * 模型侧由 `harness/fakeProvider` 脚本化（隔离实例没有 API Key）；流式过程靠它的 chunkDelayMs /
 * holdMs / release() 摆出来。一次 launchApp，**每条用例一个会话**：对话列表是 react-virtuoso，
 * 新消息到来时不自动跟到底部 —— 同一会话里叠了几张高图之后，新一轮的气泡落在渲染窗口之外，
 * 根本不在 DOM 里。选择器全部走 `harness/pages.ts` 的 `mermaidPane` / `mermaidWatch`。
 *
 * pele/lazy 按图类型分包：E-1 是本文件第一张 flowchart（首次要等 `load`，waitFigure 兜住），之后的
 * 用例里这个类型已经注册过，流式第一帧就能同步画。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import ja from '@shuvix/chat-protocol/i18n/locales/ja.json'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import { sleep, until } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import { startFakeProvider, type FakeProvider } from '../../harness/fakeProvider'
import { createProject, seedFakeProvider, waitRendererReady } from '../../harness/seed'
import {
  chatPane,
  mermaidPane,
  mermaidWatch,
  sidebarPane,
  type ChatPane,
  type MermaidPane,
  type MermaidUnfoldButton,
  type MermaidWatch,
  type SidebarPane
} from '../../harness/pages'

const MODEL = 'e2e-model'
/** 每条用例一个会话（标题即侧栏行文字） */
const SESSIONS = [
  'mermaid-E1',
  'mermaid-E2',
  'mermaid-E3',
  'mermaid-E4',
  'mermaid-E5',
  'mermaid-E6',
  'mermaid-E7'
]
const USAGE = { prompt: 90, completion: 20 }

/** 界面语言跟着系统走：「展开 / 收起」上的字是三语之一（文案本身钉在 chat-protocol 的 locales.test） */
const LOCALES = [en, ja, zh]
const UNFOLD_TEXTS = LOCALES.map((l) => l.message.diagramUnfold)
const FOLD_TEXTS = LOCALES.map((l) => l.message.diagramFold)
const expectButton = (
  button: MermaidUnfoldButton | null | undefined,
  texts: string[],
  expanded: boolean,
  what: string
): void => {
  expect(button, what).toBeTruthy()
  expect(texts, `${what}: ${JSON.stringify(button)}`).toContain(button!.text)
  expect(button!.expanded, what).toBe(expanded)
}

/** 块之间必须留空行，否则 markdown 把它们并成一段 */
const doc = (...blocks: string[]): string => blocks.join('\n\n')
const fence = (code: string): string => `\`\`\`mermaid\n${code}\n\`\`\``

let app: E2EApp
let provider: FakeProvider
let chat: ChatPane
let sidebar: SidebarPane
let watch: MermaidWatch
/** 每一轮各有一个开头标记；卡片按它认（见 pages.ts 的 assistantBodyWith） */
const cardOf = (marker: string): MermaidPane => mermaidPane(app.main, marker)

beforeAll(async () => {
  app = await launchApp()
  provider = await startFakeProvider()
  await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  await waitRendererReady(app.main)

  const project = await createProject(app.main, { name: 'MermaidProj', path: app.home })
  for (const title of SESSIONS) {
    await app.main.eval(
      `window.api.session.create(${JSON.stringify({ title, projectId: project.id })})
        .then((s) => s.id)`
    )
  }

  chat = chatPane(app.main)
  watch = mermaidWatch(app.main)
  sidebar = sidebarPane(app.main)
  // IPC 建的会话没有广播：点一次「新对话」让侧栏拉全量列表
  await sidebar.clickNewChat()
  await until(async () => {
    const titles = await sidebar.titles()
    return SESSIONS.every((t) => titles.includes(t))
  }, 'sidebar lists the mermaid sessions')
}, 120_000)

/** 切到这条用例自己的会话 */
const openSession = async (title: string): Promise<void> => {
  expect(await sidebar.openSession(title)).toBe(true)
  await chat.ready()
}

afterAll(async () => {
  await watch?.stop()
  await provider.close()
  await app.stop()
})

describe('对话里的 mermaid 图', () => {
  it('E-1 写完的图缺省显示图：节点面 = bg-primary、标签 = text-primary、边标签衬底 = 卡片底；切主题只换色不重渲，切回来复原', async () => {
    await openSession('mermaid-E1')
    provider.reset()
    provider.script({
      text: doc('MARK-E1 one small graph:', fence('graph TD\n  e1a[Plan] -->|go| e1b[Ship]')),
      usage: USAGE
    })
    await chat.typeAndSend('draw E1')
    await chat.waitIdle()
    const mermaid = cardOf('MARK-E1')
    await mermaid.waitFigure()

    const shot = await mermaid.shot()
    expect(shot?.figure).toBeTruthy()
    expect(shot?.error).toBeNull()
    // 缺省是图不是源码：正文里一个 <pre> 都没有
    expect(shot?.pres).toBe(0)

    const original = await mermaid.theme()
    const before = await mermaid.colors()
    // 卡片里的图：节点比卡片凸一级（--figure-raised = bg-primary），边标签衬底与卡片同色
    expect(before.nodeFill, `节点面 ${JSON.stringify(before)}`).toBe(before.bgPrimary)
    expect(before.labelColor, '标签字色').toBe(before.textPrimary)
    expect(before.edgeLabelFill, '边标签衬底').not.toBe('')
    expect(before.edgeLabelFill, '边标签衬底').toBe(before.figureSurface)
    // 图直接坐在卡片底色上 —— 没有另垫一块底
    expect(before.figureBackground).toBe('rgba(0, 0, 0, 0)')
    const tag = await mermaid.svgTag()
    expect(tag).toBeGreaterThan(0)

    // 换到另一种明暗（两套 GitHub 主题的 bg-primary 必然不同），等颜色跟上
    const other = original === 'github-light' ? 'github-dark' : 'github-light'
    await mermaid.setTheme(other)
    const after = await until(async () => {
      const c = await mermaid.colors()
      return c.nodeFill === c.bgPrimary && c.nodeFill !== before.nodeFill ? c : null
    }, `mermaid node fill follows ${other}`)
    expect(after.labelColor, '切主题后的标签字色').toBe(after.textPrimary)
    expect(after.labelColor).not.toBe(before.labelColor)
    expect(after.edgeLabelFill, '切主题后的边标签衬底').toBe(after.figureSurface)
    expect(after.edgeLabelFill).not.toBe(before.edgeLabelFill)
    // 换色靠级联：屏幕上还是同一个 <svg> 元素，没有重渲
    expect(await mermaid.svgTag()).toBe(tag)
    expect((await mermaid.shot())?.error).toBeNull()

    await mermaid.setTheme(original)
    await until(
      async () => (await mermaid.colors()).nodeFill === before.nodeFill,
      `mermaid node fill back to ${original}`
    )
    const back = await mermaid.colors()
    expect(back.labelColor).toBe(before.labelColor)
    expect(back.edgeLabelFill).toBe(before.edgeLabelFill)
    expect(await mermaid.svgTag()).toBe(tag)
  }, 120_000)

  it('E-2 流式中逐帧画：一行写完就多画一点、节点只增不减、不出错；没写完不给导出，写完落定后给', async () => {
    await openSession('mermaid-E2')
    provider.reset()
    provider.script({
      text: [
        'MARK-E2 plan:\n\n',
        '```mermaid\ngraph TD\n',
        '  e2a[Plan] --> e2b[Build]\n',
        '  e2b --> e2c[Ship]\n',
        '  e2c --> e2d[Done]\n',
        '```\n\nMARK-E2-TAIL done.'
      ],
      chunkDelayMs: 1200,
      holdMs: 6000,
      usage: USAGE
    })
    await watch.start('MARK-E2', 'MARK-E2-TAIL')
    await chat.typeAndSend('draw E2')
    const mermaid = cardOf('MARK-E2')

    // 最后一片上屏（围栏闭合 + 尾部标记），消息还挂在 holdMs 里
    await until(
      async () => ((await watch.frames()).some((f) => f.tail) ? true : null),
      'the last chunk of the E2 reply on screen',
      20_000
    )
    expect(await chat.isBusy()).toBe(true)

    const frames = await watch.frames()
    const dump = JSON.stringify(frames)
    // 围栏还开着、消息还在写的时候图就出来了
    expect(
      frames.some((f) => f.figure && !f.tail && f.busy),
      dump
    ).toBe(true)
    const firstFigure = frames.findIndex((f) => f.figure)
    expect(firstFigure, dump).toBeGreaterThan(0)
    // 出图之前的占位行带着行数；出图之后再没有退回占位
    const pendingBefore = frames.slice(0, firstFigure).filter((f) => f.pending !== null)
    expect(pendingBefore.length, dump).toBeGreaterThan(0)
    expect(
      pendingBefore.every((f) => /\d/.test(f.pending!)),
      dump
    ).toBe(true)
    expect(
      frames.slice(firstFigure).some((f) => f.pending !== null),
      dump
    ).toBe(false)
    // 流式期间一次错误卡都没出过
    expect(
      frames.some((f) => f.error),
      dump
    ).toBe(false)

    // 尾部到来之前：节点数只增不减，而且至少画过两种不同的（每写完一行就重画一帧）
    const tailAt = frames.findIndex((f) => f.tail)
    const beforeTail = frames.slice(0, tailAt)
    const nodes = beforeTail.map((f) => f.nodes)
    expect(
      nodes.every((n, i) => i === 0 || n >= nodes[i - 1]),
      JSON.stringify(nodes)
    ).toBe(true)
    expect(new Set(nodes.filter((n) => n > 0)).size, JSON.stringify(nodes)).toBeGreaterThanOrEqual(
      2
    )
    // 半截源码画出的一帧不给导出
    expect(
      beforeTail.some((f) => f.exportable),
      dump
    ).toBe(false)

    provider.release()
    await chat.waitIdle()
    const settled = await until(async () => {
      const fs = await watch.frames()
      const last = fs[fs.length - 1]
      return last && last.exportable ? last : null
    }, 'export button on the settled E2 figure')
    await watch.stop()
    expect(settled.figure).toBe(true)
    expect(settled.nodes).toBe(4)
    expect(settled.error).toBe(false)
    const shot = await mermaid.shot()
    expect(shot?.figure).toBeTruthy()
    expect(shot?.error).toBeNull()
  }, 120_000)

  it('E-3 写坏的图（围栏没闭合）：流式中只有占位、不出错；写完之后才出错误卡（带源码）', async () => {
    await openSession('mermaid-E3')
    provider.reset()
    // 没闭合、而且缺了箭头的目标：pele 解析不了
    const code = 'graph TD\n  e3a -->'
    provider.script({
      text: ['MARK-E3 a broken one:\n\n', `\`\`\`mermaid\n${code}`],
      chunkDelayMs: 200,
      holdMs: 4000,
      usage: USAGE
    })
    await chat.typeAndSend('draw E3')
    const mermaid = cardOf('MARK-E3')

    // 围栏那一片（也是最后一片）上屏：占位行带着行数
    await until(async () => {
      const s = await mermaid.shot()
      return s?.pending && /\d/.test(s.pending) ? s : null
    }, 'streaming placeholder for the broken fence')
    await sleep(1800)
    expect(await chat.isBusy()).toBe(true)
    const mid = await mermaid.shot()
    expect(mid?.pending).toBeTruthy()
    expect(mid?.error).toBeNull()
    expect(mid?.figure).toBeNull()

    provider.release()
    await chat.waitIdle()
    const card = await until(async () => {
      const s = await mermaid.shot()
      return s && s.error !== null ? s : null
    }, 'mermaid error card once the reply settled')
    expect(card.error).toBe(code)
    expect(card.figure).toBeNull()
    expect(card.pending).toBeNull()
  }, 120_000)

  it('E-4 长竖图按栏宽截断（框高封顶、图不压缩、底部渐隐）；就地展开后按原宽整张摆、同一个 <svg>，换会话回来仍展开；从底条收起时卡片被拉回视野', async () => {
    await openSession('mermaid-E4')
    provider.reset()
    const chain = Array.from(
      { length: 19 },
      (_, i) => `  e4n${i + 1}[Step ${i + 1}] --> e4n${i + 2}[Step ${i + 2}]`
    )
    // 卡片底下要有远超一屏的内容：从底条收起时，视野才有地方「落进后面的内容里」
    const filler = Array.from(
      { length: 40 },
      (_, i) =>
        `E4 filler paragraph ${i + 1}: ${'the quick brown fox jumps over the lazy dog '.repeat(5).trim()}.`
    )
    provider.script({
      text: doc('MARK-E4 a long chain:', fence(['graph TD', ...chain].join('\n')), ...filler),
      usage: USAGE
    })
    await chat.typeAndSend('draw E4')
    await chat.waitIdle()
    const mermaid = cardOf('MARK-E4')
    await mermaid.waitFigure()

    // (1) 收起：按栏宽截断 —— 框高封顶、图按原宽画（下半截被框切掉）、底部渐隐
    const geo = await mermaid.geometry()
    const g = JSON.stringify(geo)
    expect(geo.mode, g).toBe('clip')
    expect(geo.box.height, g).toBeLessThanOrEqual(geo.capHeight + 0.5)
    expect(Math.abs(geo.svg.width - geo.viewBox.width), g).toBeLessThanOrEqual(1)
    expect(geo.svg.height, g).toBeGreaterThan(geo.box.height)
    expect(geo.masked, g).toBe(true)
    expect(geo.unfolded, g).toBe(false)
    const collapsed = await mermaid.shot()
    expectButton(collapsed?.unfold, UNFOLD_TEXTS, false, 'collapsed toolbar')
    expectButton(collapsed?.bar, UNFOLD_TEXTS, false, 'collapsed bar')
    expect(collapsed?.bar?.text).toBe(collapsed?.unfold?.text)
    // 竖链比这一栏窄：展开就是全貌，没有 Full size
    expect(geo.viewBox.width, g).toBeLessThanOrEqual(geo.contentWidth)
    expect(collapsed?.fullSize).toBe(false)
    const tag = await mermaid.svgTag()
    expect(tag).toBeGreaterThan(0)
    const collapsedCardHeight = (await mermaid.viewport()).card.height

    // (2) 卡片上沿在视野里：从工具栏展开不挪动它（往下长）；收起后它仍在视野里
    await mermaid.revealCard()
    const atTop = await mermaid.viewport()
    expect(atTop.card.top, JSON.stringify(atTop)).toBeGreaterThanOrEqual(atTop.view.top - 1)
    expect(atTop.card.top, JSON.stringify(atTop)).toBeLessThan(atTop.view.bottom)
    await mermaid.unfold('toolbar')
    const grown = await mermaid.viewport()
    expect(Math.abs(grown.card.top - atTop.card.top), JSON.stringify(grown)).toBeLessThanOrEqual(1)
    expect(grown.card.height).toBeGreaterThan(atTop.card.height)
    await mermaid.fold('toolbar')
    const back = await mermaid.viewport()
    expect(back.card.top, JSON.stringify(back)).toBeGreaterThanOrEqual(back.view.top - 1)
    expect(back.card.top, JSON.stringify(back)).toBeLessThan(back.view.bottom)

    // (3) 从底条展开：不限高、整张按原宽摆、没有渐隐；同一个 <svg>
    await mermaid.unfold('bar')
    const open = await mermaid.geometry()
    const o = JSON.stringify(open)
    expect(open.mode, o).toBe('fit')
    expect(open.unfolded, o).toBe(true)
    expect(open.masked, o).toBe(false)
    expect(Math.abs(open.svg.width - open.viewBox.width), o).toBeLessThanOrEqual(1)
    expect(Math.abs(open.svg.height - open.viewBox.height), o).toBeLessThanOrEqual(1)
    expect(open.svg.bottom, o).toBeLessThanOrEqual(open.box.bottom + 0.5)
    expect(open.box.height, o).toBeGreaterThanOrEqual(open.svg.height)
    expect(open.box.height, o).toBeGreaterThan(open.capHeight)
    const opened = await mermaid.shot()
    expectButton(opened?.bar, FOLD_TEXTS, true, 'expanded bar')
    expectButton(opened?.unfold, FOLD_TEXTS, true, 'expanded toolbar')
    expect(opened?.fullSize).toBe(false)
    expect(await mermaid.svgTag()).toBe(tag)

    // (4) 换个会话再回来（卡片重挂）：仍是展开的
    await openSession('mermaid-E1')
    await openSession('mermaid-E4')
    await mermaid.waitFigure()
    expect((await mermaid.shot())?.unfolded).toBe(true)
    // 落地后列表跟着底部 3s（Conversation 的 PIN_TO_BOTTOM_MS）：等它放手，下面的滚动才不被拉回去
    await sleep(3300)
    const expandedCardHeight = (await mermaid.viewport()).card.height

    // (5) 读到图的末尾：底条在视野中间，卡片上沿早已滚出视野，后面还有两屏多的内容；而且底条离视野
    // 上沿比卡片要缩掉的高度还近 —— 不拉回来的话，收起后整张卡片都在视野上面
    await mermaid.revealBar()
    const reading = await mermaid.viewport()
    const r = JSON.stringify({ reading, collapsedCardHeight, expandedCardHeight })
    expect(reading.bar, r).not.toBeNull()
    expect(reading.card.top, r).toBeLessThan(reading.view.top)
    expect(reading.belowCard, r).toBeGreaterThan(2 * reading.clientHeight)
    expect(reading.bar!.bottom - reading.view.top, r).toBeLessThan(
      expandedCardHeight - collapsedCardHeight
    )

    // (6) 从底条收起：回到截断，卡片被拉回视野
    await mermaid.fold('bar')
    const folded = await mermaid.geometry()
    const f = JSON.stringify(folded)
    expect(folded.mode, f).toBe('clip')
    expect(folded.box.height, f).toBeLessThanOrEqual(folded.capHeight + 0.5)
    expect(folded.masked, f).toBe(true)
    expectButton((await mermaid.shot())?.bar, UNFOLD_TEXTS, false, 'bar after folding')
    await until(async () => {
      const v = await mermaid.viewport()
      return v.card.bottom > v.view.top && v.card.top < v.view.bottom ? v : null
    }, 'the mermaid card scrolled back into view after folding from the bar')
  }, 120_000)

  it('E-5 围栏已闭合、消息还在写，而源码画不出来：流式中留着能画的那一部分、不出错；写完之后才出错误卡', async () => {
    await openSession('mermaid-E5')
    provider.reset()
    const code = 'graph TD\n  e5a --> e5b\n  e5b -->'
    provider.script({
      text: `MARK-E5\n\n\`\`\`mermaid\n${code}\n\`\`\`\n\n`,
      holdMs: 6000,
      usage: USAGE
    })
    await chat.typeAndSend('draw E5')
    const mermaid = cardOf('MARK-E5')

    // 闭合了的围栏、消息挂在 holdMs 里：画的是退回去的那一帧（前两行），不是错误卡
    await mermaid.waitFigure()
    expect(await chat.isBusy()).toBe(true)
    const mid = await mermaid.shot()
    expect(mid?.error).toBeNull()
    expect(mid?.figure).toBeTruthy()
    const nodes = await app.main.eval<number>(
      `document.querySelectorAll('[data-mermaid-figure] .pele-node').length`
    )
    expect(nodes).toBeGreaterThanOrEqual(2)

    provider.release()
    await chat.waitIdle()
    const card = await until(async () => {
      const s = await mermaid.shot()
      return s && s.error !== null ? s : null
    }, 'mermaid error card once the E5 reply settled')
    expect(card.error).toBe(code)
    expect(card.figure).toBeNull()
  }, 120_000)

  it('E-6 自然宽度放不下一栏窄于 640 的横排图：pele 按栏宽重排（viewBox 宽 ≤ 栏宽），按原宽画、不是整张缩小', async () => {
    await openSession('mermaid-E6')
    provider.reset()
    const nodes = Array.from(
      { length: 10 },
      (_, i) => `  e6n${i + 1}[Long step label number ${i + 1}]`
    )
    const edges = Array.from({ length: 9 }, (_, i) => `  e6n${i + 1} --> e6n${i + 2}`)
    provider.script({
      text: doc('MARK-E6 a wide chain:', fence(['graph LR', ...nodes, ...edges].join('\n'))),
      usage: USAGE
    })
    await chat.typeAndSend('draw E6')
    await chat.waitIdle()
    const mermaid = cardOf('MARK-E6')
    await mermaid.waitFigure()

    // pele 只在 maxWidth < 640 时把横排改竖排；栏宽 ≥ 640 时它几乎不重排（实测 664 宽的栏里这条
    // 链仍是 2243 宽，只能整张缩小）。所以把视口模拟窄，让这一栏落到 640 以下 —— 用模拟视口而不是
    // 真去缩窗口：结果不该取决于跑测试的那块屏幕。模拟随 main 这条 CDP 会话存在，finally 里撤掉
    await app.main.send('Emulation.setDeviceMetricsOverride', {
      width: 820,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false
    })
    try {
      const narrow = await until(async () => {
        const g = await mermaid.geometry()
        return g.contentWidth > 0 && g.contentWidth < 620 ? g : null
      }, 'mermaid figure cell narrower than 620px under the emulated viewport')
      const geo = await until(
        async () => {
          const g = await mermaid.geometry()
          return g.viewBox.width <= g.contentWidth + 1 ? g : null
        },
        `mermaid figure re-laid out to the column (was ${JSON.stringify(narrow)})`,
        10_000
      )
      expect(geo.viewBox.width, JSON.stringify(geo)).toBeLessThanOrEqual(geo.contentWidth + 1)
      // 重排过的图按 viewBox 原宽画：没有再被整张压扁
      expect(Math.abs(geo.svg.width - geo.viewBox.width), JSON.stringify(geo)).toBeLessThanOrEqual(
        1
      )
    } finally {
      await app.main.send('Emulation.clearDeviceMetricsOverride')
    }
  }, 120_000)

  it('E-7 展开了也还被栏宽缩着的宽图：给 Full size；从工具栏展开后按栏宽摆、比限高高；弹窗按原宽、可滚动，Esc / 遮罩 / 关闭按钮都能关，关掉后仍是展开的', async () => {
    await openSession('mermaid-E7')
    provider.reset()
    // 一个 200 个 W 的不断行标签：pele 按栏宽也收不窄，于是展开后也只能按栏宽缩着
    const chain = Array.from(
      { length: 28 },
      (_, i) => `  e7n${i + 1}[Step ${i + 1}] --> e7n${i + 2}[Step ${i + 2}]`
    )
    provider.script({
      text: doc(
        'MARK-E7 a wide and tall chain:',
        fence(['graph TD', `  e7n0["${'W'.repeat(200)}"] --> e7n1[Step 1]`, ...chain].join('\n'))
      ),
      usage: USAGE
    })
    await chat.typeAndSend('draw E7')
    await chat.waitIdle()
    const mermaid = cardOf('MARK-E7')
    await mermaid.waitFigure()
    await until(
      async () => ((await mermaid.shot())?.fullSize ? true : null),
      'full-size button on the E7 figure'
    )

    // 收起：限高（截断或整张缩，两种都守住 480），有展开
    const geo = await mermaid.geometry()
    const g = JSON.stringify(geo)
    expect(geo.viewBox.width, g).toBeGreaterThan(geo.contentWidth + 1)
    expectButton((await mermaid.shot())?.unfold, UNFOLD_TEXTS, false, 'collapsed toolbar')
    if (geo.mode === 'clip') expect(geo.box.height, g).toBeLessThanOrEqual(geo.capHeight + 0.5)
    else expect(geo.svg.height, g).toBeLessThanOrEqual(480.5)

    // 从工具栏展开：按栏宽整张摆（比原宽窄）、比限高高，Full size 还在
    await mermaid.unfold('toolbar')
    const open = await mermaid.geometry()
    const o = JSON.stringify(open)
    expect(open.mode, o).toBe('fit')
    expect(Math.abs(open.svg.width - open.contentWidth), o).toBeLessThanOrEqual(1)
    expect(open.svg.width, o).toBeLessThan(open.viewBox.width - 1)
    expect(open.svg.height, o).toBeGreaterThan(480)
    expect(open.box.height, o).toBeGreaterThanOrEqual(open.svg.height)
    expect((await mermaid.shot())?.fullSize).toBe(true)

    for (const via of ['escape', 'backdrop', 'button'] as const) {
      await mermaid.openDialog()
      const shown = await mermaid.dialog()
      const d = JSON.stringify(shown)
      expect(shown.open, d).toBe(true)
      expect(shown.closing, d).toBe(false)
      // 原尺寸：按 viewBox 的原宽摆，比窗口高就竖着滚；比窗口宽就横着滚
      expect(Math.abs(shown.svgWidth - shown.viewBoxWidth), d).toBeLessThanOrEqual(1)
      expect(shown.scrollHeight, d).toBeGreaterThan(shown.clientHeight)
      if (shown.viewBoxWidth + 56 > 0.92 * shown.innerWidth) {
        expect(shown.scrollWidth, d).toBeGreaterThan(shown.clientWidth)
      }
      await mermaid.closeDialog(via)
      expect((await mermaid.dialog()).open, via).toBe(false)
      expect((await mermaid.shot())?.unfolded, via).toBe(true)
    }
  }, 120_000)
})
