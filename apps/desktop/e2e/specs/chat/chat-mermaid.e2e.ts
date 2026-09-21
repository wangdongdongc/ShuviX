/**
 * 对话里的 ```mermaid 图 —— 单测（chat-ui 的 mermaidBlock.dom.test.tsx：jsdom + 桩出来的 mermaid）
 * 结构上够不着的那几件：
 *
 *   1. **接线**。单测直接挂 MermaidBlock、自己包 MarkdownStreamingContext；「流式标志从消息状态
 *      经 AssistantBubble → ReactMarkdown → CodeBlock 一路传到图」这条链没有任何单测覆盖。
 *      E-2 / E-3 的「流式中只占位、写完才出错」只有这条链真的接上才成立；
 *   2. **真 mermaid 吃下了解析好的主题色**：节点面 = `--theme-bg-tertiary` 的解析值、标签字色 =
 *      `--theme-text-primary` 的解析值，切主题真的换色（jsdom 不做级联，单测里颜色是桩拼出来的）；
 *   3. **真 Chromium 的布局**：长竖图按栏宽截断 —— 框高封顶、图按原宽画（不是整张压扁），放大后
 *      原宽、可滚动（jsdom 的几何全是 0）。
 *
 * 模型侧由 `harness/fakeProvider` 脚本化（隔离实例没有 API Key）；流式过程靠它的 chunkDelayMs /
 * holdMs / release() 摆出来。一次 launchApp，**每条用例一个会话**：对话列表是 react-virtuoso，
 * 新消息到来时不自动跟到底部 —— 同一会话里叠了几张高图之后，新一轮的气泡落在渲染窗口之外，
 * 根本不在 DOM 里。选择器全部走 `harness/pages.ts` 的 `mermaidPane` / `mermaidWatch`。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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
  type MermaidWatch,
  type SidebarPane
} from '../../harness/pages'

const MODEL = 'e2e-model'
/** 每条用例一个会话（标题即侧栏行文字） */
const SESSIONS = ['mermaid-E1', 'mermaid-E2', 'mermaid-E3', 'mermaid-E4']
const USAGE = { prompt: 90, completion: 20 }

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
  it('E-1 写完的图缺省显示图：节点面与标签字色是主题令牌的解析值；切主题换色，切回来复原', async () => {
    await openSession('mermaid-E1')
    provider.reset()
    provider.script({
      text: doc('MARK-E1 one small graph:', fence('graph TD\n  e1a[Plan] --> e1b[Ship]')),
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
    expect(before.nodeFill, '节点面').toBe(before.bgTertiary)
    expect(before.labelColor, '标签字色').toBe(before.textPrimary)
    // 图直接坐在卡片底色上 —— 从前那块写死的白底在深色主题下是一块白板
    expect(before.figureBackground).toBe('rgba(0, 0, 0, 0)')

    // 换到另一种明暗（两套 GitHub 主题的节点面必然不同），等重渲完成
    const other = original === 'github-light' ? 'github-dark' : 'github-light'
    await mermaid.setTheme(other)
    const after = await until(async () => {
      const c = await mermaid.colors()
      return c.nodeFill === c.bgTertiary && c.nodeFill !== before.nodeFill ? c : null
    }, `mermaid node fill follows ${other}`)
    expect(after.labelColor, '切主题后的标签字色').toBe(after.textPrimary)
    expect((await mermaid.shot())?.error).toBeNull()

    await mermaid.setTheme(original)
    await until(
      async () => (await mermaid.colors()).nodeFill === before.nodeFill,
      `mermaid node fill back to ${original}`
    )
    expect((await mermaid.colors()).labelColor).toBe(before.labelColor)
  }, 120_000)

  it('E-2 流式中：占位跟着源码行数走、一次都不出错；围栏写完后不等整条消息结束就出图', async () => {
    await openSession('mermaid-E2')
    provider.reset()
    provider.script({
      text: [
        'MARK-E2 here is the plan:\n\n',
        '```mermaid\ngraph TD\n',
        '  e2a[Plan] --> e2b[Build]\n',
        '  e2b --> e2c[Ship]\n```\n\n',
        'MARK-E2-TAIL and that is all.'
      ],
      chunkDelayMs: 200,
      holdMs: 6000,
      usage: USAGE
    })
    await watch.start('MARK-E2', 'MARK-E2-TAIL')
    await chat.typeAndSend('draw E2')
    const mermaid = cardOf('MARK-E2')

    await until(
      async () => ((await mermaid.shot())?.figure ? true : null),
      'mermaid figure while the reply is still streaming',
      8000
    )
    // 这一刻消息还挂在 holdMs 里：图是在流式期间出来的，不是等整条消息写完
    expect(await chat.isBusy()).toBe(true)

    const frames = await watch.frames()
    const firstFigure = frames.findIndex((f) => f.figure)
    expect(firstFigure, JSON.stringify(frames)).toBeGreaterThan(0)
    expect(frames[firstFigure].busy).toBe(true)
    // 最后一片上屏之后 ~2s 内出图（源码停 800ms 就渲，不等 holdMs）
    const tail = frames.find((f) => f.tail)
    expect(tail, JSON.stringify(frames)).toBeDefined()
    expect(frames[firstFigure].t - tail!.t).toBeLessThanOrEqual(2000)

    // 写围栏期间：占位行里的行数跟着源码长（不减、最后是 3），而且至少变过一次
    const counts = frames
      .slice(0, firstFigure)
      .filter((f) => f.pending !== null)
      .map((f) => Number(/\d+/.exec(f.pending!)?.[0] ?? NaN))
    expect(counts.length, JSON.stringify(frames)).toBeGreaterThan(0)
    expect(counts.every(Number.isFinite), JSON.stringify(frames)).toBe(true)
    expect(
      counts.every((n, i) => i === 0 || n >= counts[i - 1]),
      JSON.stringify(counts)
    ).toBe(true)
    expect(Math.max(...counts)).toBe(3)
    expect(new Set(counts).size, JSON.stringify(counts)).toBeGreaterThan(1)
    // 流式期间一次错误卡都没出过
    expect(frames.some((f) => f.error)).toBe(false)

    provider.release()
    await chat.waitIdle()
    await watch.stop()
    const settled = await mermaid.shot()
    expect(settled?.figure).toBeTruthy()
    expect(settled?.error).toBeNull()
  }, 120_000)

  it('E-3 写坏的图：流式中只有占位、不出错；写完之后才出错误卡（带源码），页面里不留 mermaid 的残渣', async () => {
    await openSession('mermaid-E3')
    provider.reset()
    // 没闭合、而且缺了箭头的目标：真 mermaid 解析不了
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
    // 源码停满 800ms 早就渲过一次、失败了 —— 流式中那不是错误
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
    // suppressErrorRendering：mermaid 自己的临时容器与「Syntax error」炸弹图都不该留在页面上
    expect(await mermaid.leftovers()).toEqual({ tempNodes: 0, syntaxError: false })
  }, 120_000)

  it('E-4 长竖图按栏宽截断（框高封顶、图不压缩）；放大后原宽、可滚动；Esc / 遮罩 / 关闭按钮都能关', async () => {
    await openSession('mermaid-E4')
    provider.reset()
    const chain = Array.from(
      { length: 19 },
      (_, i) => `  e4n${i + 1}[Step ${i + 1}] --> e4n${i + 2}[Step ${i + 2}]`
    )
    provider.script({
      text: doc('MARK-E4 a long chain:', fence(['graph TD', ...chain].join('\n'))),
      usage: USAGE
    })
    await chat.typeAndSend('draw E4')
    await chat.waitIdle()
    const mermaid = cardOf('MARK-E4')
    await mermaid.waitFigure()

    const geo = await mermaid.geometry()
    expect(geo.mode, JSON.stringify(geo)).toBe('clip')
    expect(geo.box.height, JSON.stringify(geo)).toBeLessThanOrEqual(geo.capHeight + 0.5)
    // 截断不是缩放：图按原宽画，下半截被框切掉
    expect(Math.abs(geo.svg.width - geo.viewBox.width), JSON.stringify(geo)).toBeLessThanOrEqual(1)
    expect(geo.svg.height, JSON.stringify(geo)).toBeGreaterThan(geo.box.height)
    expect((await mermaid.shot())?.expandable).toBe(true)

    for (const via of ['escape', 'backdrop', 'button'] as const) {
      await mermaid.openDialog()
      const shown = await mermaid.dialog()
      expect(shown.open).toBe(true)
      expect(shown.closing).toBe(false)
      // 原尺寸：按 viewBox 的原宽摆，比窗口高就在弹窗里滚
      expect(
        Math.abs(shown.svgWidth - shown.viewBoxWidth),
        JSON.stringify(shown)
      ).toBeLessThanOrEqual(1)
      expect(shown.scrollHeight, JSON.stringify(shown)).toBeGreaterThan(shown.clientHeight)
      await mermaid.closeDialog(via)
      expect((await mermaid.dialog()).open, via).toBe(false)
    }
  }, 120_000)
})
