/**
 * Widget 面板主屏的「整理图标」（2026-10-16）—— 长按或菜单进入，图标抖动；拖动重排、拖到边缘停一下翻页，松手即落盘
 * （`~/.shuvix/widgets/.config.json` 的 homeOrder，之后 widget.list 按它排）；「完成」、Esc、点空白处退出。
 *
 * 真的 isolated 实例，种 40 个最小 widget（面板 360px 宽时至少两页），经主窗右侧面板的 widget tab 操作。手势全走 CDP 的
 * 可信输入（pages.ts 的 widgetHomePane.press / moveTo / release …）—— 合成事件拿不到 pointer capture。断言先看 IPC 与磁盘
 * 上的账目，再看 DOM。
 *
 *   AR-1 菜单「整理图标」→ 进入整理；「完成」、Esc、点空白处各自退出；整理时点图标什么都不打开
 *   AR-2 按住 600ms 原地松手 → 进入整理，松手之后仍在整理（松手那下 click 不算点空白处）；只按 200ms → 打开应用
 *   AR-3 整理时把第 1 格拖到第 3 格中心：松手前 DOM 里它已在第 3 格；松手后 widget.list 与 homeOrder 是新顺序；仍在整理
 *   AR-4 拖出去又拖回原处再松手 → 不写 homeOrder（账目文件一字不变）
 *   AR-5 拖着停在右边缘（x > 宽 − 22）约 800ms → 翻到下一页；放到那页第一格 → 它在 widget.list 里的下标 = 每页格数
 *   AR-6 不在整理时，一个手势里长按再拖 → 进入整理并重排
 *   AR-8 拖到一半按 Esc → 拖动作废（widget.list 与账目都不变），退出整理，什么都没打开
 *   AR-7 重启（同一个 HOME）后顺序还在；之后种一个最新的 widget → 排在最后；经 IPC 删掉一个 → 它从 homeOrder 里没了
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchApp, type E2EApp } from '../../harness/launch'
import { rightPanelPane, widgetHomePane } from '../../harness/pages'
import { sleep, until } from '../../harness/cdp'

const COUNT = 40
const ids = Array.from({ length: COUNT }, (_, i) => `arr-${String(i + 1).padStart(2, '0')}`)

let app: E2EApp

function seedWidget(home: string, id: string, createdAt: number): void {
  const dir = join(home, '.shuvix', 'widgets', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'widget.json'),
    JSON.stringify(
      { id, name: `Arr ${id.slice(4)}`, description: '', entryFile: 'index.tsx', createdAt },
      null,
      2
    ) + '\n'
  )
  writeFileSync(
    join(dir, 'index.tsx'),
    `const root = document.getElementById('root')\nif (root) root.textContent = 'WIDGET ${id}'\n`
  )
}

const configPath = (): string => join(app.home, '.shuvix', 'widgets', '.config.json')
const configBytes = (): string =>
  existsSync(configPath()) ? readFileSync(configPath(), 'utf8') : ''
const homeOrder = (): string[] | undefined =>
  (JSON.parse(configBytes() || '{}') as { homeOrder?: string[] }).homeOrder
const listIds = (): Promise<string[]> =>
  app.main.eval<string[]>('window.api.widget.list().then((l) => l.map((w) => w.id))')

async function openPanel(): Promise<void> {
  // 顶栏的右侧面板开关晚于 window.api 就绪才上屏：点之前先等它在
  await until(
    () => app.main.eval<boolean>(`!!document.querySelector('button[data-side="right"]')`),
    'the right panel toggle'
  )
  const panel = rightPanelPane(app.main)
  await panel.open()
  await panel.activateWidgetTab()
  await panel.setPanelWidth(360)
}

async function pageSettled(page: number): Promise<void> {
  const home = widgetHomePane(app.main)
  await until(
    async () =>
      ((await home.currentPage()) === page && Math.abs(await home.pageOffset(page)) < 1) || null,
    `page ${page} settled`
  )
}

async function editingIs(value: boolean): Promise<void> {
  const home = widgetHomePane(app.main)
  await until(async () => (await home.editing()) === value || null, `editing = ${value}`)
}

async function enterArrange(): Promise<void> {
  const home = widgetHomePane(app.main)
  if (await home.editing()) return
  await home.pickMenu((await home.slotsOnPage(0))[0], 'arrange')
  await editingIs(true)
}

async function leaveArrange(): Promise<void> {
  const home = widgetHomePane(app.main)
  if (!(await home.editing())) return
  await home.clickDone()
  await editingIs(false)
}

async function centerOfSlot(page: number, index: number): Promise<{ x: number; y: number }> {
  const home = widgetHomePane(app.main)
  const id = (await home.slotsOnPage(page))[index]
  const c = id ? await home.slotCenter(id) : null
  if (!c) throw new Error(`no slot ${index} on page ${page}`)
  return c
}

beforeAll(async () => {
  app = await launchApp()
  ids.forEach((id, i) => seedWidget(app.home, id, 1000 + i))
  await openPanel()
  const home = widgetHomePane(app.main)
  await home.reload()
  await until(async () => (await home.slotIds()).length === COUNT || null, 'all icons')
  expect(await home.pageCount()).toBeGreaterThan(1)
}, 120_000)

afterAll(async () => {
  await app?.stop()
})

describe('arranging the widget home screen', () => {
  it('AR-1 the menu enters arrange mode; Done, Escape and a click on blank space each leave it; tapping an icon opens nothing', async () => {
    const home = widgetHomePane(app.main)
    expect(await home.editing()).toBe(false)

    await enterArrange()
    await home.clickDone()
    await editingIs(false)

    await enterArrange()
    await home.pressEscape()
    await editingIs(false)

    // 最后一页有空白处可点
    const last = (await home.pageCount()) - 1
    await home.clickDot(last)
    await pageSettled(last)
    await enterArrange()
    // 整理时点图标：不打开（合成的点一下与真的按下松开都试）
    const icon = (await home.slotsOnPage(last))[0]
    await home.tap(icon)
    await home.longPress(icon, 60)
    await sleep(300)
    expect(await home.foregroundApp()).toBeNull()
    expect(await home.panelApps()).toEqual([])
    expect(await home.editing()).toBe(true)
    await home.clickBlank()
    await editingIs(false)
    expect(await home.foregroundApp()).toBeNull()

    await home.clickDot(0)
    await pageSettled(0)
    expect(homeOrder()).toBeUndefined()
  })

  it('AR-2 a long press enters arrange mode and stays there after release; a short press opens the app', async () => {
    const home = widgetHomePane(app.main)
    const id = (await home.slotsOnPage(0))[1]
    await home.longPress(id, 600)
    await editingIs(true)
    await sleep(400)
    expect(await home.editing()).toBe(true)
    expect(await home.foregroundApp()).toBeNull()
    await leaveArrange()

    await home.longPress(id, 200)
    await until(async () => (await home.foregroundApp()) === id || null, 'the app opened')
    expect(await home.editing()).toBe(false)
    await until(
      async () => (await home.openAnimation(id)).panelPointerEvents === '' || null,
      'open settled'
    )
    await home.back()
    await until(async () => (await home.foregroundApp()) === null || null, 'home')
    await until(
      async () => (await home.openAnimation(id)).panelPointerEvents === '' || null,
      'close settled'
    )
    // 收尾：停掉它，后面的用例从空面板开始
    await until(() => home.running(id), 'running')
    await home.pickMenu(id, 'stop')
    await until(async () => (await home.panelApps()).length === 0 || null, 'stopped')
  })

  it('AR-3 dragging the first icon onto the third slot reorders live, then persists on release', async () => {
    const home = widgetHomePane(app.main)
    await enterArrange()
    const before = await listIds()
    const a = before[0]
    const target = await centerOfSlot(0, 2)
    await home.dragIcon(a, target, { release: false })
    await until(async () => (await home.slotIds())[2] === a || null, 'A shown on slot 3 while held')
    expect(homeOrder()).toBeUndefined()
    await home.release()

    const expected = [before[1], before[2], a, ...before.slice(3)]
    await until(async () => (await listIds()).join() === expected.join() || null, 'new order')
    expect(homeOrder()).toEqual(expected)
    expect(await home.slotIds()).toEqual(expected)
    await sleep(300)
    expect(await home.editing()).toBe(true)
  })

  it('AR-4 dropping an icon back where it started writes nothing', async () => {
    const home = widgetHomePane(app.main)
    await enterArrange()
    const before = await listIds()
    const bytes = configBytes()
    const a = before[2]
    const start = (await home.slotCenter(a))!
    await home.dragIcon(a, await centerOfSlot(0, 0), { release: false })
    await until(async () => (await home.slotIds())[0] === a || null, 'A moved to slot 1')
    await home.moveTo(start, { steps: 12, ms: 240 })
    await until(async () => (await home.slotIds())[2] === a || null, 'A back on slot 3')
    await home.release()
    await sleep(600)
    expect(configBytes()).toBe(bytes)
    expect(await listIds()).toEqual(before)
    expect(await home.editing()).toBe(true)
  })

  it('AR-5 holding a dragged icon at the right edge flips to the next page, and it can be dropped there', async () => {
    const home = widgetHomePane(app.main)
    await enterArrange()
    await pageSettled(0)
    const perPage = (await home.slotsOnPage(0)).length
    const a = (await listIds())[0]
    const rect = (await home.homeRect())!
    const start = (await home.slotCenter(a))!
    await home.dragIcon(a, { x: rect.x + rect.width - 8, y: start.y }, { release: false })
    await sleep(800)
    await pageSettled(1)
    await home.moveTo(await centerOfSlot(1, 0), { steps: 12, ms: 240 })
    await home.release()

    await until(async () => (await listIds())[perPage] === a || null, `A at index ${perPage}`)
    expect(homeOrder()?.[perPage]).toBe(a)
    expect((await home.slotsOnPage(1))[0]).toBe(a)
    await leaveArrange()
    await home.clickDot(0)
    await pageSettled(0)
  })

  it('AR-6 a long press that keeps moving enters arrange mode and reorders in one gesture', async () => {
    const home = widgetHomePane(app.main)
    expect(await home.editing()).toBe(false)
    const before = await listIds()
    const b = before[0]
    await home.dragIcon(b, await centerOfSlot(0, 2), { holdMs: 600 })
    const expected = [before[1], before[2], b, ...before.slice(3)]
    await until(async () => (await listIds()).join() === expected.join() || null, 'reordered')
    expect(homeOrder()).toEqual(expected)
    expect(await home.editing()).toBe(true)
    await leaveArrange()
  })

  it('AR-8 Escape during a drag cancels it and leaves arrange mode', async () => {
    const home = widgetHomePane(app.main)
    await enterArrange()
    const before = await listIds()
    const bytes = configBytes()
    const c = before[0]
    await home.dragIcon(c, await centerOfSlot(0, 2), { release: false })
    await until(async () => (await home.slotIds())[2] === c || null, 'C shown on slot 3 while held')
    await home.pressEscape()
    await editingIs(false)
    await home.release()
    await sleep(600)
    expect(await listIds()).toEqual(before)
    expect(configBytes()).toBe(bytes)
    expect(await home.slotIds()).toEqual(before)
    expect(await home.foregroundApp()).toBeNull()
    expect(await home.panelApps()).toEqual([])
  })

  it('AR-7 the order survives a restart; a newer widget lands last; deleting one takes it out of homeOrder', async () => {
    const order = await listIds()
    expect(homeOrder()).toEqual(order)
    const home0 = app.home
    await app.stop({ keepHome: true })
    app = await launchApp({ home: home0 })
    await openPanel()
    const home = widgetHomePane(app.main)
    await until(async () => (await home.slotIds()).join() === order.join() || null, 'order kept')
    expect(await listIds()).toEqual(order)

    const fresh = 'arr-zz-newest'
    seedWidget(app.home, fresh, Date.now())
    await home.reload()
    await until(async () => (await home.slotIds()).at(-1) === fresh || null, 'newest is last')
    expect((await listIds()).at(-1)).toBe(fresh)
    expect(homeOrder()).toEqual(order)

    const gone = order[0]
    await app.main.eval(`window.api.widget.delete(${JSON.stringify(gone)}).then(() => true)`)
    await until(async () => !(await listIds()).includes(gone) || null, 'deleted')
    expect(homeOrder()).toEqual(order.slice(1))
    await until(async () => !(await home.slotIds()).includes(gone) || null, 'icon gone')
  })
})
