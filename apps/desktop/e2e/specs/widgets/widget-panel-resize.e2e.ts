/**
 * 右侧面板开着一个组件时拖面板左缘的分割线（2026-10-28 的报告）：往右拖一卡一卡，在组件上松开鼠标后分割线还粘着
 * 指针走。原因是组件开在跨源 iframe 里（WidgetFrame），分割线只在 document 上听 mousemove / mouseup，指针一进
 * iframe 事件就归了它。修法是 app-shell common/panelDrag.ts 的 startPanelDrag：拖动期间整窗一层遮罩，iframe 吞不走事件；
 * 左键已松开的 mousemove 也算结束。单测里没有的是真的跨源 iframe、浏览器自己的命中与事件路由 —— 所以这条走 CDP 可信
 * 鼠标输入，在真的组件 iframe 上拖。
 *
 *   E-1 种一个组件，开在 Widget 面板里，等它的 iframe target 加载完；面板不到 440px 就先往左拖宽（在对话列上，没有 iframe）。
 *       y = iframe 的竖直中点，x0 = 分割线左缘 + 2，dx = 40；前提：(x0 + i·dx, y) 在 i = 1..3 时都落在组件 iframe 上。
 *       在 (x0, y) 按下；i = 1..3 按着左键移到 (x0 + i·dx, y)，各等两帧（固定的等），记下宽度 W_i；在 (x0 + 3dx, y)
 *       松开；不按键移到 (x0 + 3dx + 40, y)、再到 (x0 − 150, y)，记下 A1、A2。整条轨迹 ±1px 等于
 *       [W0−40, W0−80, W0−120, W0−120, W0−120]，最后没有遮罩、body 的 cursor / user-select 都是 ''。
 *
 * 组件页面在跨源 iframe 里，自己有一个 CDP target（`iframe`）；页面里的 DOM 是这个 spec 自己写的组件，读它不经 pages.ts
 * （与 widget-theme.e2e.ts 同一种做法）。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { connect, listTargets, until, type CdpClient } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import { panelDividerPane, rightPanelPane, widgetPanelPane } from '../../harness/pages'

const WIDGET = 'resize-probe'
const DX = 40
/** 面板宽度下限是 320：W0 − 3·dx 不能被它钳住 */
const MIN_START_WIDTH = 440

/** 组件界面：铺满整个 iframe 的一块（命中只看 iframe 元素本身，内容只为让页面真的挂上） */
const SCREEN_TSX = `const root = document.getElementById('root')
if (root) {
  root.setAttribute('data-resize-probe', '')
  root.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center'
  root.textContent = 'resize probe'
}
`

let app: E2EApp
let frame: CdpClient | null = null

function seedWidget(home: string): void {
  const dir = join(home, '.shuvix', 'widgets', WIDGET)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'widget.json'),
    JSON.stringify(
      {
        id: WIDGET,
        name: 'Resize probe',
        description: '',
        entryFile: 'index.tsx',
        createdAt: 1000
      },
      null,
      2
    ) + '\n'
  )
  writeFileSync(join(dir, 'index.tsx'), SCREEN_TSX)
}

beforeAll(async () => {
  app = await launchApp()
  seedWidget(app.home)

  await until(
    () => app.main.eval<boolean>(`!!document.querySelector('button[data-side="right"]')`),
    'the right panel toggle'
  )
  const right = rightPanelPane(app.main)
  await right.open()
  await right.activateWidgetTab()
  const panel = widgetPanelPane(app.main)
  await panel.reload()
  await until(async () => (await panel.cardIds()).includes(WIDGET) || null, 'the widget card')
}, 120_000)

afterAll(async () => {
  frame?.close()
  await app?.stop()
})

describe('dragging the right panel divider over a widget', () => {
  it('E-1 the panel follows the pointer over the widget iframe and lets go on release', async () => {
    const panel = widgetPanelPane(app.main)
    await panel.clickCard(WIDGET)
    await until(async () => (await panel.foregroundApp()) === WIDGET || null, 'opened in panel')
    await until(() => panel.frameReady(WIDGET), 'the widget iframe')
    const target = await until(
      async () =>
        (await listTargets(app.port)).find(
          (t) => t.type === 'iframe' && t.url.includes(`/w/${WIDGET}/`)
        ),
      'the widget iframe target',
      30_000
    )
    frame = await connect(target.webSocketDebuggerUrl)
    await until(
      () =>
        frame!.eval<boolean>(
          `document.readyState === 'complete' && !!document.querySelector('[data-resize-probe]')`
        ),
      'the widget screen loaded',
      30_000
    )

    const divider = panelDividerPane(app.main)
    const frameRect = (await until(() => divider.widgetFrameRect(WIDGET), 'the iframe rect'))!
    const y = frameRect.top + frameRect.height / 2

    // 面板不够宽就先往左拖宽（指针在对话列上，那里没有 iframe）
    if ((await divider.panelWidth()) < MIN_START_WIDTH) {
      const d = (await divider.dividerRect())!
      const from = d.left + 2
      const to = from - (MIN_START_WIDTH + 20 - (await divider.panelWidth()))
      await divider.move(from, y, false)
      await divider.press(from, y)
      for (let i = 1; i <= 4; i++) {
        await divider.move(from + ((to - from) * i) / 4, y, true)
        await divider.frames(2)
      }
      await divider.release(to, y)
      await until(
        async () => (await divider.panelWidth()) >= MIN_START_WIDTH || null,
        `right panel widened to ${MIN_START_WIDTH}px`
      )
    }

    const d = (await divider.dividerRect())!
    const w0 = await divider.panelWidth()
    expect(w0).toBeGreaterThanOrEqual(MIN_START_WIDTH)
    const x0 = d.left + 2
    const rect = (await divider.widgetFrameRect(WIDGET))!
    const yMid = rect.top + rect.height / 2

    // 前提：拖动经过的三个点都在组件 iframe 上（不然测的就不是报告里的场景）
    const hits: string[] = []
    for (let i = 1; i <= 3; i++) hits.push(await divider.hitAt(x0 + i * DX, yMid))
    expect(hits).toEqual(['widget-iframe', 'widget-iframe', 'widget-iframe'])

    const trace: number[] = []
    await divider.move(x0, yMid, false)
    await divider.press(x0, yMid)
    for (let i = 1; i <= 3; i++) {
      await divider.move(x0 + i * DX, yMid, true)
      await divider.frames(2)
      trace.push(await divider.panelWidth())
    }
    await divider.release(x0 + 3 * DX, yMid)
    await divider.move(x0 + 3 * DX + 40, yMid, false)
    await divider.frames(2)
    trace.push(await divider.panelWidth())
    await divider.move(x0 - 150, yMid, false)
    await divider.frames(2)
    trace.push(await divider.panelWidth())

    const expected = [w0 - 40, w0 - 80, w0 - 120, w0 - 120, w0 - 120]
    const body = await divider.bodyStyle()
    expect({
      w0,
      trace: trace.map((w, i) => (Math.abs(w - expected[i]) <= 1 ? expected[i] : w)),
      overlays: await divider.overlayCount(),
      cursor: body.cursor,
      userSelect: body.userSelect
    }).toEqual({ w0, trace: expected, overlays: 0, cursor: '', userSelect: '' })
  })
})
