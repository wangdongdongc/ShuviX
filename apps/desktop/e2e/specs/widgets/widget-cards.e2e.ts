/**
 * Widget 面板的卡片列表（2026-10-17，v0.2.16 的分页图标主屏退回卡片）—— 每个小组件一张卡（名字、描述、id、上次打开 /
 * 创建的相对时间、运行中的点），按最近打开倒序（没打开过的按创建时间倒序）；点卡片在面板里打开应用（顶栏返回 / 重新加载 /
 * 独立窗口，回列表后留在后台），卡片右上角悬停出停止 / 归档 / 删除。
 *
 * 真的 isolated 实例，往假 HOME 的 `~/.shuvix/widgets` 里种 6 个最小 widget（创建时间各差一天；一个三行描述、一个空描述、
 * 一个带 icon.svg），第一次刷新之前先写一份 v0.2.16 留下的 `.config.json`（`homeOrder` 升序 —— 恰与期望的顺序相反）。
 * 经主窗右侧面板的 widget tab 操作；断言走 IPC 与 pages.ts 的 widgetPanelPane。悬停是 CDP 的可信鼠标移动（`:hover` 只认它）。
 * 截图只给人看（`SHUVIX_E2E_SHOTS=<目录>` 时写出，平时不写）。
 *
 *   WC-1 还没有 widget：没有卡片，列表里是空态那句话；文档里没有一个 v0.2.16 主屏的标记
 *   WC-2 卡片按 widget.list 的顺序（createdAt 倒序，留下的 homeOrder 不管）；列表不写账目（homeOrder 还在）；
 *        卡片内容：名字、两行截断的描述、id、扳手图标、没在运行、时间 = 创建时间的相对时间（没打开过也不是「从未打开」）；
 *        空描述没有那一段；带 icon.svg 的照样是扳手、没有主屏标记；摘要里没有 iconMtime
 *   WC-3 点卡片 → 面板里打开，没有任何动效（应用那层、列表、面板根的 pointer-events 都是平的）；前台、iframe 在、列表藏起；
 *        顶栏 = 返回（chevron-left + 名字）/ 重新加载 / 独立窗口；返回 → 列表回来，应用留在后台
 *   WC-4 打开过的排到最前、时间是「刚刚」；第一次宿主写入把 homeOrder 去掉了；再开一个 → 它到最前
 *   WC-5 再点同一张卡片 → 回到同一份（iframe 没有重建）
 *   WC-6 开 A、回、开 B、回 → 面板里 [A, B] 两个 iframe 都在、都不可见；再开 A → 同一个 iframe，B 不变
 *   WC-7 「重新加载」→ 新的 iframe、仍在前台；重新加载与点回后台应用都不改 lastOpenedAt，列表顺序不变
 *   WC-8 运行中的卡片有点、有停止键，别的只有归档 / 删除；悬浮按钮平时透明、鼠标移上去才显示；卡片上的停止不打开卡片、
 *        从面板与服务上撤掉它；菜单的停止同样
 *   WC-9 卡片上的归档：不问、不打开，卡片与面板里那一层都没了、在 listArchived 里；经 IPC 恢复 → 按 lastOpenedAt 回到最前；
 *        卡片上的删除先问（点名这个小组件），取消 → 还在
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import ja from '@shuvix/chat-protocol/i18n/locales/ja.json'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import { launchApp, type E2EApp } from '../../harness/launch'
import { confirmPane, rightPanelPane, widgetPanelPane } from '../../harness/pages'
import { sleep, until } from '../../harness/cdp'

const L = [en, zh, ja]
const EMPTY_HINTS = L.map((l) => l.widgets.panelEmptyHint)
const JUST_NOW = L.map((l) => l.widgets.justNow)
const daysAgo = (n: number): string[] =>
  L.map((l) => l.widgets.daysAgo.replace('{{count}}', String(n)))

const DAY = 24 * 60 * 60_000
const ids = ['wc-01', 'wc-02', 'wc-03', 'wc-04', 'wc-05', 'wc-06']
/** 创建时间：wc-01 最早（6 天又半小时前），每个晚一天 —— 各不相同，排序不靠 id 兜底 */
const T0 = Date.now()
const createdAtOf = (i: number): number => T0 - (ids.length - i) * DAY - 30 * 60_000
const NAMES = Object.fromEntries(ids.map((id, i) => [id, `Card ${i + 1}`]))
const LONG_DESCRIPTION =
  'First line of a long description that goes on for a while.\nSecond line, still going, with more words than fit.\nThird line, which the card clamps away.'
const SHOTS = process.env.SHUVIX_E2E_SHOTS

let app: E2EApp

interface ListedWidget {
  id: string
  lastOpenedAt: number
  keys: string[]
}

const widgetsDir = (): string => join(app.home, '.shuvix', 'widgets')
const configPath = (): string => join(widgetsDir(), '.config.json')

function seedWidget(id: string, i: number): void {
  const dir = join(widgetsDir(), id)
  mkdirSync(dir, { recursive: true })
  const description = id === 'wc-01' ? LONG_DESCRIPTION : id === 'wc-04' ? '' : `e2e card ${i + 1}`
  writeFileSync(
    join(dir, 'widget.json'),
    JSON.stringify(
      {
        id,
        name: NAMES[id],
        description,
        entryFile: 'index.tsx',
        createdAt: createdAtOf(i)
      },
      null,
      2
    ) + '\n'
  )
  writeFileSync(
    join(dir, 'index.tsx'),
    `const root = document.getElementById('root')\nif (root) root.innerHTML = '<div style="padding:16px;font:14px sans-serif">WIDGET ${id}</div>'\n`
  )
  if (id === 'wc-03') {
    writeFileSync(
      join(dir, 'icon.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="icon">\n<rect width="64" height="64" fill="var(--viz-3)"/>\n</svg>\n'
    )
  }
}

const listWidgets = (): Promise<ListedWidget[]> =>
  app.main.eval<ListedWidget[]>(
    'window.api.widget.list().then((l) => l.map((w) => ({ id: w.id, lastOpenedAt: w.lastOpenedAt, keys: Object.keys(w) })))'
  )
const archivedIds = (): Promise<string[]> =>
  app.main.eval<string[]>('window.api.widget.listArchived().then((l) => l.map((w) => w.id))')
const registered = async (): Promise<string[]> =>
  (await app.main.eval<{ registeredIds?: string[] }>('window.api.widget.getServerStatus()'))
    .registeredIds ?? []
const readConfig = (): { state: Record<string, { lastOpenedAt?: number }>; homeOrder?: unknown } =>
  JSON.parse(readFileSync(configPath(), 'utf-8'))

async function shot(name: string): Promise<void> {
  if (!SHOTS) return
  mkdirSync(SHOTS, { recursive: true })
  await widgetPanelPane(app.main).screenshot(join(SHOTS, `${name}.png`))
}

async function cardsAre(expected: string[], what: string): Promise<void> {
  const panel = widgetPanelPane(app.main)
  await until(async () => (await panel.cardIds()).join() === expected.join() || null, what)
}

async function openApp(id: string): Promise<void> {
  const panel = widgetPanelPane(app.main)
  await panel.clickCard(id)
  await until(async () => (await panel.foregroundApp()) === id || null, `${id} in the foreground`)
}

async function goBack(): Promise<void> {
  const panel = widgetPanelPane(app.main)
  await panel.back()
  await until(async () => (await panel.foregroundApp()) === null || null, 'back on the cards')
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

describe('widget panel with no widgets', () => {
  it('WC-1 no cards, the empty hint, and no home screen markers', async () => {
    const panel = widgetPanelPane(app.main)
    const hint = await until(() => panel.emptyHint(), 'the empty hint')
    expect(EMPTY_HINTS).toContain(hint)
    expect(await panel.cardIds()).toEqual([])
    expect(await panel.legacyMarkers()).toBe(0)
  })
})

describe('widget cards', () => {
  /** WC-2 之前的账目字节（v0.2.16 留下的那一份） */
  let leftover: Buffer

  beforeAll(async () => {
    ids.forEach((id, i) => seedWidget(id, i))
    // v0.2.16 留下的主屏顺序：升序，与期望的顺序正相反
    writeFileSync(configPath(), JSON.stringify({ state: {}, homeOrder: ids }, null, 2) + '\n')
    leftover = readFileSync(configPath())
    const panel = widgetPanelPane(app.main)
    await panel.reload()
    await until(
      async () => (await panel.cardIds()).length === ids.length || null,
      'all seeded cards'
    )
  }, 60_000)

  it('WC-2 cards in widget.list order (createdAt descending), each with its name, description, id and creation time', async () => {
    const panel = widgetPanelPane(app.main)
    const newestFirst = [...ids].reverse()
    expect(await panel.cardIds()).toEqual(newestFirst)
    const listed = await listWidgets()
    expect(listed.map((w) => w.id)).toEqual(newestFirst)
    // 列表只读：留下的 homeOrder 原样
    expect(readFileSync(configPath()).equals(leftover)).toBe(true)
    expect(readConfig().homeOrder).toEqual(ids)

    const first = (await panel.card('wc-01'))!
    expect(first.name).toBe('Card 1')
    expect(first.description).toBe(LONG_DESCRIPTION)
    expect(first.descriptionClamped).toBe(true)
    expect(first.idText).toBe('wc-01')
    expect(first.glyph).toBe('lucide-wrench')
    expect(first.running).toBe(false)
    // 没打开过：显示创建时间（6 天前），不是「从未打开」
    expect(daysAgo(6)).toContain(first.time)
    expect(daysAgo(1)).toContain((await panel.card('wc-06'))!.time)

    expect((await panel.card('wc-04'))!.description).toBeNull()
    // icon.svg 没人看了：照样是扳手，文档里没有主屏的图标
    expect((await panel.card('wc-03'))!.glyph).toBe('lucide-wrench')
    expect(await panel.legacyMarkers()).toBe(0)
    for (const w of listed) expect(w.keys, w.id).not.toContain('iconMtime')
    await shot('01-cards')
  })

  it('WC-3 a click opens the app in the panel with no animation; back returns to the cards leaving it alive', async () => {
    const panel = widgetPanelPane(app.main)
    await panel.clickCard('wc-02')
    await until(async () => (await panel.foregroundApp()) === 'wc-02' || null, 'wc-02 in front')
    // 一出现就是整块：没有展开 / 缩放的动效，面板也不因动效锁住指针
    expect(await panel.motion('wc-02')).toStrictEqual({
      appAnimations: 0,
      listAnimations: 0,
      panelPointerEvents: ''
    })
    await until(() => panel.frameReady('wc-02'), 'the wc-02 iframe')
    expect(await panel.listVisible()).toBe(false)
    expect(await panel.appTopBar('wc-02')).toStrictEqual({
      title: 'Card 2',
      backGlyph: 'lucide-chevron-left',
      hasReload: true,
      hasPopout: true
    })
    await shot('02-open')

    await panel.back()
    await until(async () => (await panel.foregroundApp()) === null || null, 'back on the cards')
    expect(await panel.listVisible()).toBe(true)
    expect(await panel.panelApps()).toEqual(['wc-02'])
    expect(await panel.motion('wc-02')).toStrictEqual({
      appAnimations: 0,
      listAnimations: 0,
      panelPointerEvents: ''
    })
  })

  it('WC-4 an opened widget moves to the top and reads "just now"; the first host write dropped homeOrder', async () => {
    const panel = widgetPanelPane(app.main)
    await cardsAre(['wc-02', 'wc-06', 'wc-05', 'wc-04', 'wc-03', 'wc-01'], 'wc-02 on top')
    expect(JUST_NOW).toContain((await panel.card('wc-02'))!.time)
    const config = readConfig()
    expect('homeOrder' in config).toBe(false)
    expect(config.state['wc-02']?.lastOpenedAt ?? 0).toBeGreaterThan(0)

    await openApp('wc-05')
    await goBack()
    await cardsAre(['wc-05', 'wc-02', 'wc-06', 'wc-04', 'wc-03', 'wc-01'], 'wc-05 on top')
  })

  it('WC-5 clicking the same card again returns to the same app instance', async () => {
    const panel = widgetPanelPane(app.main)
    const before = await panel.frameStamp('wc-02')
    expect(before).not.toBeNull()
    await openApp('wc-02')
    expect(await panel.frameStamp('wc-02')).toBe(before)
    await goBack()
  })

  it('WC-6 several apps stay alive in the panel, only the foreground one visible, each reopening its own iframe', async () => {
    const panel = widgetPanelPane(app.main)
    expect(await panel.panelApps()).toEqual(['wc-02', 'wc-05'])
    expect(await panel.frameReady('wc-02')).toBe(true)
    expect(await panel.frameReady('wc-05')).toBe(true)
    expect(await panel.appVisible('wc-02')).toBe(false)
    expect(await panel.appVisible('wc-05')).toBe(false)
    const stampA = await panel.frameStamp('wc-02')
    const stampB = await panel.frameStamp('wc-05')

    await openApp('wc-02')
    expect(await panel.appVisible('wc-02')).toBe(true)
    expect(await panel.appVisible('wc-05')).toBe(false)
    expect(await panel.frameStamp('wc-02')).toBe(stampA)
    expect(await panel.frameStamp('wc-05')).toBe(stampB)
    await goBack()
  })

  it('WC-7 Reload remounts the iframe in the foreground; neither it nor clicking a background app counts as an open', async () => {
    const panel = widgetPanelPane(app.main)
    const opened = async (): Promise<Record<string, number>> =>
      Object.fromEntries((await listWidgets()).map((w) => [w.id, w.lastOpenedAt]))
    const before = await opened()
    const order = await panel.cardIds()
    expect(before['wc-02']).toBeGreaterThan(0)
    expect(before['wc-05']).toBeGreaterThan(0)

    await openApp('wc-02')
    const stamp = await panel.frameStamp('wc-02')
    expect(stamp).not.toBeNull()
    await panel.reloadApp()
    await until(
      async () => {
        const s = await panel.frameStamp('wc-02')
        return s !== null && s !== stamp ? s : null
      },
      'a new iframe after Reload',
      30_000
    )
    expect(await panel.foregroundApp()).toBe('wc-02')
    await goBack()
    await openApp('wc-05')
    await goBack()

    expect(await opened()).toEqual(before)
    expect(await panel.cardIds()).toEqual(order)
  })

  it('WC-8 running dots and the hover buttons: Stop on a card stops it without opening it; Stop in the menu too', async () => {
    const panel = widgetPanelPane(app.main)
    const running = ['wc-02', 'wc-05']
    for (const id of running) {
      await until(() => panel.running(id), `${id} running`)
      expect((await panel.card(id))!.buttons, id).toEqual(['stop', 'archive', 'delete'])
    }
    for (const id of ids.filter((x) => !running.includes(x))) {
      const c = (await panel.card(id))!
      expect(c.running, id).toBe(false)
      expect(c.buttons, id).toEqual(['archive', 'delete'])
    }

    // 悬浮按钮：平时透明，鼠标移上去才显示（transition 100ms）
    expect(await panel.cardButtonsOpacity('wc-01')).toBe(0)
    await panel.hoverCard('wc-01')
    await until(
      async () => (await panel.cardButtonsOpacity('wc-01')) === 1 || null,
      'the hover buttons shown on wc-01'
    )
    await panel.unhover()
    await until(
      async () => (await panel.cardButtonsOpacity('wc-01')) === 0 || null,
      'the hover buttons hidden again'
    )

    await panel.clickCardButton('wc-05', 'stop')
    await until(async () => !(await panel.panelApps()).includes('wc-05') || null, 'wc-05 stopped')
    await until(async () => !(await panel.running('wc-05')) || null, 'wc-05 dot gone')
    await sleep(300)
    expect(await panel.foregroundApp()).toBeNull()
    expect(await panel.panelApps()).toEqual(['wc-02'])
    expect(await registered()).not.toContain('wc-05')
    expect((await panel.card('wc-05'))!.buttons).toEqual(['archive', 'delete'])

    await panel.pickMenu('wc-02', 'stop')
    await until(async () => (await panel.panelApps()).length === 0 || null, 'wc-02 stopped')
    await until(async () => !(await panel.running('wc-02')) || null, 'wc-02 dot gone')
    expect(await panel.foregroundApp()).toBeNull()
    expect(await registered()).not.toContain('wc-02')
    expect((await panel.card('wc-02'))!.buttons).toEqual(['archive', 'delete'])
  })

  it('WC-9 Archive on a card asks nothing and opens nothing; restored, it is back on top; Delete asks first', async () => {
    const panel = widgetPanelPane(app.main)
    const confirm = confirmPane(app.main)
    await openApp('wc-06')
    await goBack()
    await until(async () => (await panel.cardIds())[0] === 'wc-06' || null, 'wc-06 on top')
    expect(await panel.panelApps()).toEqual(['wc-06'])
    const order = await panel.cardIds()

    await panel.clickCardButton('wc-06', 'archive')
    await until(async () => !(await panel.cardIds()).includes('wc-06') || null, 'wc-06 card gone')
    expect((await confirm.snapshot()).open).toBe(false)
    expect(await panel.foregroundApp()).toBeNull()
    expect(await panel.panelApps()).toEqual([])
    expect(await archivedIds()).toContain('wc-06')

    await app.main.eval(
      `window.api.widget.setArchived({ id: 'wc-06', archived: false }).then(() => true)`
    )
    await cardsAre(order, 'wc-06 restored on top')
    expect(await archivedIds()).not.toContain('wc-06')

    await panel.clickCardButton('wc-04', 'delete')
    await confirm.waitOpen()
    expect((await confirm.snapshot()).description).toContain(NAMES['wc-04'])
    expect(await panel.foregroundApp()).toBeNull()
    await confirm.cancel()
    await confirm.waitClosed()
    expect((await listWidgets()).map((w) => w.id)).toContain('wc-04')
    expect(await panel.cardIds()).toContain('wc-04')
  })
})
