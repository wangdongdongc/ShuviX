/**
 * Widget 面板的主屏（2026-10-16）—— 像手机主屏一样的分页图标网格；点图标在面板里打开应用、返回回主屏。
 *
 * 真的 isolated 实例，往假 HOME 的 `~/.shuvix/widgets` 里种 40 个最小 widget（几个带 icon.svg：干净的、带 script /
 * on* 的、超过 64 KB 的、清洗后什么都不剩的），经主窗右侧面板的 widget tab 操作。断言走 DOM（pages.ts 的
 * rightPanelPane / widgetHomePane）与 IPC；翻页 / 拖动走 CDP 的可信输入（合成事件拿不到 pointer capture）。截图只给人看
 * （`SHUVIX_E2E_SHOTS=<目录>` 时写出，平时不写）。
 *
 *   WH-16 还没有 widget：没有主屏、没有页码点，面板里是空态那句话（种 widget 之前）
 *   WH-16b 空面板里来了第一批 widget（面板不重新挂载）→ 网格按量到的尺寸排：页数 = ceil(40 / homeGrid(量到的宽高).perPage)
 *   WH-1  主屏按 widget.list 的顺序排图标，放不下就分页（有页码点）；有 icon.svg 的那个内联了清洗后的 svg
 *   WH-2  点图标 → 应用在面板里打开（前台、iframe 跑起来）；返回 → 回主屏，应用留在后台（还在 DOM 里）
 *   WH-3  再点同一个图标 → 回到同一份（iframe 没有重建）
 *   WH-11 开着的应用图标下有「运行中」的点，别的没有；菜单「停止」之后点没了
 *   WH-4  页码点个数 = 页数；点第 2 个点 → 当前页 1，落在面板里的图标恰是第 2 页的；点回第 1 个
 *   WH-5  向左拖 60% 宽 → 下一页、向右 → 回来；慢慢拖不到 18% → 不翻；快速短甩 → 翻；从图标上起拖不打开应用
 *   WH-6  第一页向右拖 120 不松手 → 只跟手一小段（回弹阻尼，20–60px）；松手弹回；最后一页向左同样
 *   WH-7  滚轮 deltaX 60 → 下一页；deltaY 也翻；一口气五下 → 只翻一页（翻完锁一会儿）
 *   WH-8  主屏不滚动（scrollHeight == clientHeight）；页数 = ceil(40 / homeGrid(量到的宽高).perPage)；面板改到 240 → 3 列、
 *         每页更少（页数随之重切）、顺序不变
 *   WH-9  没有 svg 的图标是名字首字 + `var(--viz-N-tint)` 底（N = iconSlot(id)）；带 script / onload 的 svg 内联时两者都没了；
 *         超过 64 KB 的、清洗后什么都不剩的 → 回落到字
 *   WH-10 改写 icon.svg 后非破坏性地刷新 → 新标记、iconMtime 变了；删掉 icon.svg → 回落到字
 *   WH-12 经 IPC 归档一个 → 它的格子没了（再恢复回来）
 *   WH-13 点图标的那一刻：应用那层 clip-path 的首帧 = 图标的方块（±2px），主屏在动，面板根 pointer-events: none；停稳后
 *         pointer events 回来；返回时末帧 = 图标的方块；从第 2 页打开的应用关回第 2 页
 *   WH-14 开 A、回、开 B、回 → 面板里 [A, B] 两个 iframe 都在、都不可见；再开 A → 同一个 iframe，B 不变
 *   WH-15 「重新加载」→ 新的 iframe、仍在前台；重新加载与点回后台应用都不改 lastOpenedAt
 */
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import ja from '@shuvix/chat-protocol/i18n/locales/ja.json'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import { launchApp, type E2EApp } from '../../harness/launch'
import { rightPanelPane, widgetHomePane, type WidgetIconBox } from '../../harness/pages'
import { sleep, until } from '../../harness/cdp'
import { homeGrid, iconSlot } from '../../../src/renderer/src/components/widget/homeLayout'

const COUNT = 40
const ids = Array.from({ length: COUNT }, (_, i) => `demo-${String(i + 1).padStart(2, '0')}`)
const ICON_ID = ids[1]
/** icon.svg 里有 <script> 与 onload —— 内联前得被清洗掉 */
const DIRTY_ICON_ID = ids[2]
/** icon.svg 超过 64 KB —— 不读 */
const HUGE_ICON_ID = ids[3]
/** icon.svg 里没有 <svg> —— 清洗后什么都不剩 */
const EMPTY_ICON_ID = ids[4]
const SHOTS = process.env.SHUVIX_E2E_SHOTS
const EMPTY_HINTS = [en, zh, ja].map((l) => l.widgets.panelEmptyHint)

let app: E2EApp

interface ListedWidget {
  id: string
  iconMtime: number
  lastOpenedAt: number
}

const CLEAN_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="icon">\n<rect width="64" height="64" fill="var(--viz-3)"/>\n<circle cx="32" cy="32" r="14" fill="var(--theme-bg-primary)"/>\n</svg>\n'

function iconPath(id: string): string {
  return join(app.home, '.shuvix', 'widgets', id, 'icon.svg')
}

function seedWidget(home: string, id: string, i: number): void {
  const dir = join(home, '.shuvix', 'widgets', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'widget.json'),
    JSON.stringify(
      {
        id,
        name: `Demo ${i + 1}`,
        description: `e2e widget ${i + 1}`,
        entryFile: 'index.tsx',
        createdAt: 1000 + i
      },
      null,
      2
    ) + '\n'
  )
  writeFileSync(
    join(dir, 'index.tsx'),
    `const root = document.getElementById('root')\nif (root) root.innerHTML = '<div style="padding:16px;font:14px sans-serif">WIDGET ${id}</div>'\n`
  )
  if (id === ICON_ID) writeFileSync(join(dir, 'icon.svg'), CLEAN_ICON)
  if (id === DIRTY_ICON_ID) {
    writeFileSync(
      join(dir, 'icon.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" aria-label="dirty-icon" onload="window.__wh9 = 1">\n<script>window.__wh9 = 2</script>\n<rect width="64" height="64" fill="var(--viz-5)" onclick="window.__wh9 = 3"/>\n</svg>\n'
    )
  }
  if (id === HUGE_ICON_ID) {
    writeFileSync(
      join(dir, 'icon.svg'),
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><!-- ${'x'.repeat(70 * 1024)} --><rect width="64" height="64"/></svg>\n`
    )
  }
  if (id === EMPTY_ICON_ID) {
    writeFileSync(join(dir, 'icon.svg'), '<div>not an svg at all</div>\n')
  }
}

const listWidgets = (): Promise<ListedWidget[]> =>
  app.main.eval<ListedWidget[]>(
    'window.api.widget.list().then((l) => l.map((w) => ({ id: w.id, iconMtime: w.iconMtime, lastOpenedAt: w.lastOpenedAt })))'
  )

async function shot(name: string): Promise<void> {
  if (!SHOTS) return
  mkdirSync(SHOTS, { recursive: true })
  await widgetHomePane(app.main).screenshot(join(SHOTS, `${name}.png`))
}

/** 面板没有在做打开 / 关回动效（面板根的 pointer-events 回来了） */
async function settled(): Promise<void> {
  const home = widgetHomePane(app.main)
  await until(
    async () => (await home.openAnimation('__none__')).panelPointerEvents === '' || null,
    'the panel transition finished'
  )
}

/** 当前页停稳（页的左缘贴着主屏左缘） */
async function pageSettled(page: number): Promise<void> {
  const home = widgetHomePane(app.main)
  await until(
    async () =>
      ((await home.currentPage()) === page && Math.abs(await home.pageOffset(page)) < 1) || null,
    `page ${page} settled`
  )
}

async function openApp(id: string): Promise<void> {
  const home = widgetHomePane(app.main)
  await home.tap(id)
  await until(async () => (await home.foregroundApp()) === id || null, `${id} in the foreground`)
  await settled()
}

async function goBack(): Promise<void> {
  const home = widgetHomePane(app.main)
  await home.back()
  await until(async () => (await home.foregroundApp()) === null || null, 'back on the home screen')
  await settled()
}

/** `inset(T [R [B [L]]] [round r])` → [T, R, B, L]（浏览器会把四个相同的值缩写成一个） */
function insetOf(clip: string): number[] {
  const m = /^inset\(([^)]*?)(?:\s+round\s[^)]*)?\)$/.exec(clip.trim())
  if (!m) throw new Error(`not an inset() clip-path: ${clip}`)
  const v = m[1]
    .trim()
    .split(/\s+/)
    .map((x) => Number.parseFloat(x))
  if (v.length === 0 || v.length > 4 || v.some((n) => Number.isNaN(n))) {
    throw new Error(`not an inset() clip-path: ${clip}`)
  }
  const [t, r = t, b = t, l = r] = v
  return [t, r, b, l]
}

function expectClipMatches(clip: string, box: WidgetIconBox): void {
  const [top, right, bottom, left] = insetOf(clip)
  expect(Math.abs(top - box.top), `top ${top} vs ${box.top}`).toBeLessThanOrEqual(2)
  expect(Math.abs(left - box.left), `left ${left} vs ${box.left}`).toBeLessThanOrEqual(2)
  const wantRight = box.panelWidth - box.left - box.width
  const wantBottom = box.panelHeight - box.top - box.height
  expect(Math.abs(right - wantRight), `right ${right} vs ${wantRight}`).toBeLessThanOrEqual(2)
  expect(Math.abs(bottom - wantBottom), `bottom ${bottom} vs ${wantBottom}`).toBeLessThanOrEqual(2)
}

beforeAll(async () => {
  app = await launchApp()
  // 顶栏的右侧面板开关晚于 window.api 就绪才上屏：点之前先等它在
  await until(
    () => app.main.eval<boolean>(`!!document.querySelector('button[data-side="right"]')`),
    'the right panel toggle'
  )
  const panel = rightPanelPane(app.main)
  await panel.open()
  await panel.activateWidgetTab()
  await panel.setPanelWidth(360)
}, 120_000)

afterAll(async () => {
  await app?.stop()
})

describe('widget home screen with no widgets', () => {
  it('WH-16 no home grid, no page dots, the empty hint instead', async () => {
    const home = widgetHomePane(app.main)
    const hint = await until(() => home.emptyHint(), 'the empty hint')
    expect(EMPTY_HINTS).toContain(hint)
    expect(await home.homeRect()).toBeNull()
    expect(await home.dotCount()).toBe(0)
    expect(await home.slotIds()).toEqual([])
  })
})

describe('widget home screen', () => {
  beforeAll(async () => {
    ids.forEach((id, i) => seedWidget(app.home, id, i))
    const home = widgetHomePane(app.main)
    await home.reload()
    await until(
      async () => (await home.slotIds()).length === COUNT || null,
      'all seeded icons on the home screen'
    )
  }, 60_000)

  // 主屏第一次挂载时是空态（WH-16），widget 是之后种进来的、面板没有重新挂载：网格得按此刻量到的尺寸排。
  // 修之前只在挂载那一刻量一次，size 停在 0×0 → 3 列 × 1 行（40 个分 14 页），翻页比例按宽度 1 算
  it('WH-16b the first widgets arriving on an empty panel are laid out on the measured grid', async () => {
    const home = widgetHomePane(app.main)
    const rect = await until(() => home.homeRect(), 'the home grid measured')
    const grid = homeGrid(rect.clientWidth, rect.clientHeight)
    expect(grid.cols).toBeGreaterThan(3)
    expect(await home.pageCount()).toBe(Math.ceil(COUNT / grid.perPage))
  })

  it('WH-1 lays the icons out in widget.list order, pages them, and inlines icon.svg', async () => {
    const home = widgetHomePane(app.main)
    const slots = await home.slotIds()
    expect(slots).toEqual(ids)
    expect((await listWidgets()).map((w) => w.id)).toEqual(ids)
    expect(await home.pageCount()).toBeGreaterThan(1)
    expect(await until(() => home.hasInlineSvg(ICON_ID), 'icon.svg inlined')).toBe(true)
    expect(await home.hasInlineSvg(ids[0])).toBe(false)
    await shot('01-home')
  })

  it('WH-2 opens an app inside the panel, and the back button returns home leaving it alive', async () => {
    const home = widgetHomePane(app.main)
    await home.tap(ids[0])
    await sleep(60)
    await shot('02a-opening')
    await sleep(90)
    await shot('02b-opening')
    await sleep(120)
    await shot('02c-opening')
    await until(() => home.foregroundApp(), 'the app is in the foreground')
    expect(await home.foregroundApp()).toBe(ids[0])
    await until(() => home.frameReady(ids[0]), 'the widget iframe loaded')
    await sleep(500)
    await shot('03-open')
    await home.back()
    await sleep(80)
    await shot('04a-closing')
    await sleep(120)
    await shot('04b-closing')
    await until(
      async () => (await home.foregroundApp()) === null || null,
      'back on the home screen'
    )
    expect(await home.panelApps()).toEqual([ids[0]])
    await sleep(400)
    await shot('05-home-again')
  })

  it('WH-3 tapping the same icon again returns to the same app instance', async () => {
    const home = widgetHomePane(app.main)
    const before = await home.frameStamp(ids[0])
    await home.tap(ids[0])
    await until(async () => (await home.foregroundApp()) === ids[0] || null, 'foreground again')
    expect(await home.frameStamp(ids[0])).toBe(before)
    await settled()
    await goBack()
  })

  it('WH-11 the running dot marks the open app only, and goes away after Stop', async () => {
    const home = widgetHomePane(app.main)
    await until(() => home.running(ids[0]), 'running dot on the open app')
    const others = await Promise.all(ids.slice(1).map((id) => home.running(id)))
    expect(others.every((r) => !r)).toBe(true)

    await home.pickMenu(ids[0], 'stop')
    await until(async () => !(await home.running(ids[0])) || null, 'running dot gone')
    expect(await home.panelApps()).toEqual([])
    const status = await app.main.eval<{ registeredIds: string[] }>(
      'window.api.widget.getServerStatus()'
    )
    expect(status.registeredIds).not.toContain(ids[0])
  })

  it('WH-4 page dots: one per page, and clicking one shows that page', async () => {
    const home = widgetHomePane(app.main)
    const pages = await home.pageCount()
    expect(await home.dotCount()).toBe(pages)
    await pageSettled(0)
    expect(await home.visibleSlotIds()).toEqual(await home.slotsOnPage(0))

    await home.clickDot(1)
    await pageSettled(1)
    const visible = await home.visibleSlotIds()
    expect(visible.length).toBeGreaterThan(0)
    expect(visible).toEqual(await home.slotsOnPage(1))

    await home.clickDot(0)
    await pageSettled(0)
    expect(await home.visibleSlotIds()).toEqual(await home.slotsOnPage(0))
  })

  it('WH-5 horizontal drags flip pages: far or fast flips, slow and short does not, and a drag from an icon opens nothing', async () => {
    const home = widgetHomePane(app.main)
    const width = (await home.homeRect())!.width
    await pageSettled(0)

    await home.swipe(-width * 0.6)
    await pageSettled(1)
    await home.swipe(width * 0.6)
    await pageSettled(0)

    // 慢慢拖、不到 18%：不翻，弹回
    await home.swipe(-width * 0.12, { steps: 12, ms: 900 })
    await sleep(500)
    await pageSettled(0)

    // 快速短甩（不到 18%，但够快）：翻。按下到松开之间不 sleep —— 门槛是 0.45px/ms，55px 要在 ~120ms 内甩完，
    // 机器忙时带 sleep 的分步移动会慢过它（实测过一次 4 步 × 10ms 没翻）
    await home.swipe(-55, { steps: 2, ms: 0 })
    await pageSettled(1)
    await home.clickDot(0)
    await pageSettled(0)

    // 从图标上起拖：翻页，不打开应用
    const first = (await home.slotsOnPage(0))[0]
    await home.swipe(-width * 0.6, { fromId: first })
    await pageSettled(1)
    await sleep(300)
    expect(await home.foregroundApp()).toBeNull()
    expect(await home.panelApps()).toEqual([])
    await home.clickDot(0)
    await pageSettled(0)
  })

  it('WH-6 the first and the last page only give a little (rubber band) and spring back', async () => {
    const home = widgetHomePane(app.main)
    await pageSettled(0)
    await home.swipe(120, { hold: true })
    const offset = await home.pageOffset(0)
    expect(offset).toBeGreaterThan(20)
    expect(offset).toBeLessThan(60)
    await home.release()
    await pageSettled(0)

    const last = (await home.pageCount()) - 1
    await home.clickDot(last)
    await pageSettled(last)
    await home.swipe(-120, { hold: true })
    const back = await home.pageOffset(last)
    expect(back).toBeLessThan(-20)
    expect(back).toBeGreaterThan(-60)
    await home.release()
    await pageSettled(last)

    await home.clickDot(0)
    await pageSettled(0)
  })

  it('WH-7 the wheel flips pages on either axis, one page per burst', async () => {
    const home = widgetHomePane(app.main)
    await pageSettled(0)
    await home.wheel(60, 0)
    await pageSettled(1)
    await sleep(500) // 过了翻页锁、累计也清零
    await home.wheel(0, -60)
    await pageSettled(0)
    await sleep(500)
    await home.wheel(0, 60)
    await pageSettled(1)
    await sleep(500)
    await home.clickDot(0)
    await pageSettled(0)

    // 一口气五下：只翻一页
    await home.wheel(0, 60, 5)
    await pageSettled(1)
    await sleep(600)
    expect(await home.currentPage()).toBe(1)
    await home.clickDot(0)
    await pageSettled(0)
  })

  it('WH-8 the grid never scrolls, pages follow homeGrid of the measured size, and a narrower panel reflows in the same order', async () => {
    const home = widgetHomePane(app.main)
    const panel = rightPanelPane(app.main)
    const rect = (await home.homeRect())!
    expect(rect.scrollHeight).toBe(rect.clientHeight)
    const grid = homeGrid(rect.clientWidth, rect.clientHeight)
    expect(grid.cols).toBe(4)
    expect(await home.pageCount()).toBe(Math.ceil(COUNT / grid.perPage))
    expect(await home.slotsOnPage(0)).toHaveLength(grid.perPage)

    try {
      await panel.setPanelWidth(240)
      const narrow = await until(async () => {
        const r = await home.homeRect()
        return r && r.clientWidth < rect.clientWidth - 60 ? r : null
      }, 'the home screen at the narrower width')
      const narrowGrid = homeGrid(narrow.clientWidth, narrow.clientHeight)
      expect(narrowGrid.cols).toBe(3)
      await until(
        async () => (await home.slotsOnPage(0)).length === narrowGrid.perPage || null,
        'pages re-cut at 3 columns'
      )
      const pages = await home.pageCount()
      expect(pages).toBe(Math.ceil(COUNT / narrowGrid.perPage))
      expect(narrowGrid.perPage).toBeLessThan(grid.perPage)
      expect(pages).toBeGreaterThanOrEqual(Math.ceil(COUNT / grid.perPage))
      expect(await home.slotsOnPage(0)).toHaveLength(narrowGrid.perPage)
      expect(await home.slotIds()).toEqual(ids)
    } finally {
      await panel.setPanelWidth(360)
    }
    await until(
      async () => (await home.pageCount()) === Math.ceil(COUNT / grid.perPage) || null,
      'back to 4 columns'
    )
  })

  it('WH-9 monogram on a theme tint without svg; script / on* stripped; oversized and empty-after-sanitize icons fall back', async () => {
    const home = widgetHomePane(app.main)
    const plain = (await home.iconInfo(ids[0]))!
    expect(plain.svg).toBeNull()
    expect(plain.text).toBe('D')
    expect(plain.background).toBe(`var(--viz-${iconSlot(ids[0])}-tint)`)

    const dirty = await until(async () => {
      const info = await home.iconInfo(DIRTY_ICON_ID)
      return info?.svg ? info : null
    }, 'the dirty icon inlined')
    expect(dirty.svg).toContain('dirty-icon')
    expect(dirty.svg).toContain('<rect')
    expect(dirty.hasScript).toBe(false)
    expect(dirty.hasOnAttr).toBe(false)
    expect(await app.main.eval('window.__wh9 ?? null')).toBeNull()

    const list = await listWidgets()
    for (const id of [HUGE_ICON_ID, EMPTY_ICON_ID]) {
      expect(list.find((w) => w.id === id)!.iconMtime, id).toBeGreaterThan(0)
    }
    // 两者的 getIcon 与 DIRTY_ICON_ID 的同时发出；再等一下让慢的那个也回来
    await sleep(400)
    for (const id of [HUGE_ICON_ID, EMPTY_ICON_ID]) {
      const info = (await home.iconInfo(id))!
      expect(info.svg, id).toBeNull()
      expect(info.text, id).toBe('D')
      expect(info.background, id).toBe(`var(--viz-${iconSlot(id)}-tint)`)
    }
  })

  it('WH-10 a rewritten icon.svg shows after a refresh; a deleted one falls back to the monogram', async () => {
    const home = widgetHomePane(app.main)
    const before = (await listWidgets()).find((w) => w.id === ICON_ID)!.iconMtime
    expect(before).toBeGreaterThan(0)
    expect((await home.iconInfo(ICON_ID))!.svg).toContain('aria-label="icon"')

    writeFileSync(
      iconPath(ICON_ID),
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="icon-v2">\n<rect width="64" height="64" fill="var(--viz-6)"/>\n</svg>\n'
    )
    const later = new Date(Date.now() + 10_000)
    utimesSync(iconPath(ICON_ID), later, later)
    await home.reload()
    await until(
      async () => ((await home.iconInfo(ICON_ID))?.svg ?? '').includes('icon-v2') || null,
      'the rewritten icon inlined'
    )
    const after = (await listWidgets()).find((w) => w.id === ICON_ID)!.iconMtime
    expect(after).not.toBe(before)

    rmSync(iconPath(ICON_ID))
    await home.reload()
    const gone = await until(async () => {
      const info = await home.iconInfo(ICON_ID)
      return info && info.svg === null ? info : null
    }, 'the deleted icon falls back')
    expect(gone.text).toBe('D')
    expect((await listWidgets()).find((w) => w.id === ICON_ID)!.iconMtime).toBe(0)
  })

  it('WH-12 archiving a widget over IPC takes its icon off the home screen', async () => {
    const home = widgetHomePane(app.main)
    const id = ids[COUNT - 1]
    await app.main.eval(
      `window.api.widget.setArchived({ id: ${JSON.stringify(id)}, archived: true }).then(() => true)`
    )
    await until(async () => !(await home.slotIds()).includes(id) || null, 'the archived icon gone')
    expect(await home.slotIds()).toEqual(ids.slice(0, COUNT - 1))

    await app.main.eval(
      `window.api.widget.setArchived({ id: ${JSON.stringify(id)}, archived: false }).then(() => true)`
    )
    await until(
      async () => (await home.slotIds()).length === COUNT || null,
      'the restored icon back'
    )
    expect(await home.slotIds()).toEqual(ids)
  })

  it('WH-13 the app grows out of its icon and shrinks back into it; the page it was opened from comes back', async () => {
    const home = widgetHomePane(app.main)
    await pageSettled(0)
    const id = ids[5]
    const box = (await home.iconBox(id))!
    await home.tap(id)
    const opening = await home.openAnimation(id)
    expect(opening.clip, 'an open animation is running').not.toBeNull()
    expectClipMatches(opening.clip!.first, box)
    expect(insetOf(opening.clip!.last)).toEqual([0, 0, 0, 0])
    expect(opening.homeAnimating).toBe(true)
    expect(opening.panelPointerEvents).toBe('none')

    await until(async () => (await home.foregroundApp()) === id || null, 'foreground')
    await settled()
    const open = await home.openAnimation(id)
    expect(open.clip).toBeNull()
    expect(open.panelPointerEvents).toBe('')

    await home.back()
    const closing = await until(async () => {
      const a = await home.openAnimation(id)
      return a.clip && insetOf(a.clip.first).every((n) => n === 0) ? a : null
    }, 'the close animation running')
    // 与点之前量的那个方块比（此刻主屏还在缩放动效里，现量的位置差着几 px）
    expectClipMatches(closing.clip!.last, box)
    await until(async () => (await home.foregroundApp()) === null || null, 'home')
    await settled()

    // 从第 2 页打开的应用，关回第 2 页
    await home.clickDot(1)
    await pageSettled(1)
    const second = (await home.slotsOnPage(1))[0]
    await openApp(second)
    await goBack()
    await pageSettled(1)
    await home.clickDot(0)
    await pageSettled(0)

    // 收尾：两个都停掉，下一条从空面板开始
    for (const x of [id, second]) {
      await until(() => home.running(x), `${x} running`)
      await home.pickMenu(x, 'stop')
    }
    await until(async () => (await home.panelApps()).length === 0 || null, 'panel apps stopped')
  })

  it('WH-14 several apps stay alive in the panel, only the foreground one visible, each reopening its own iframe', async () => {
    const home = widgetHomePane(app.main)
    const [a, b] = [ids[6], ids[7]]
    expect(await home.panelApps()).toEqual([])
    await openApp(a)
    await until(() => home.frameReady(a), `${a} iframe`)
    await goBack()
    await openApp(b)
    await until(() => home.frameReady(b), `${b} iframe`)
    await goBack()

    expect(await home.panelApps()).toEqual([a, b])
    expect(await home.frameReady(a)).toBe(true)
    expect(await home.frameReady(b)).toBe(true)
    expect(await home.appVisible(a)).toBe(false)
    expect(await home.appVisible(b)).toBe(false)
    const stampA = await home.frameStamp(a)
    const stampB = await home.frameStamp(b)

    await openApp(a)
    expect(await home.appVisible(a)).toBe(true)
    expect(await home.appVisible(b)).toBe(false)
    expect(await home.frameStamp(a)).toBe(stampA)
    expect(await home.frameStamp(b)).toBe(stampB)
    await goBack()
  })

  it('WH-15 Reload remounts the iframe in the foreground; neither it nor tapping a background app counts as an open', async () => {
    const home = widgetHomePane(app.main)
    const [a, b] = [ids[6], ids[7]]
    const opened = async (): Promise<Record<string, number>> =>
      Object.fromEntries((await listWidgets()).map((w) => [w.id, w.lastOpenedAt]))
    const before = await opened()
    expect(before[a]).toBeGreaterThan(0)
    expect(before[b]).toBeGreaterThan(0)

    await openApp(a)
    const stamp = await home.frameStamp(a)
    expect(stamp).not.toBeNull()
    await home.reloadApp()
    await until(
      async () => {
        const s = await home.frameStamp(a)
        return s !== null && s !== stamp ? s : null
      },
      'a new iframe after Reload',
      30_000
    )
    expect(await home.foregroundApp()).toBe(a)
    await goBack()
    await openApp(b)
    await goBack()

    const after = await opened()
    expect(after[a]).toBe(before[a])
    expect(after[b]).toBe(before[b])
  })
})
