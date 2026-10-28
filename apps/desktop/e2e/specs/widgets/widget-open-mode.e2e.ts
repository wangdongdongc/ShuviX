/**
 * Widget 面板的两种打开方式（2026-10-16）—— 一个小组件同一时间只开在一处：面板里，或独立窗口。用户在面板里选的方式
 * （↗ / 菜单「在独立窗口打开」→ 窗口，菜单「在面板中打开」→ 面板）记在主进程（widgetWindow:setPreferWindow），下次点卡片
 * 照它来；开着的窗口（不论谁开的）点卡片就聚焦它，但 agent 经 `widget` 工具（`open`）开的窗口不算用户的选择。另有菜单的停止 / 归档 / 删除。
 *
 * 真的 isolated 实例，种 4 个最小 widget（A、B、C 走打开方式，D 只看菜单），经主窗右侧面板的 widget tab 操作。窗口在不在
 * 看 CDP 的 /json（`#widget-window?widgetId=<id>` 的 page target）与 `widgetWindow.status`；注册看 `widget.getServerStatus()`。
 *
 *   OM-1  A 在面板里开着，点 ↗ → A 离开面板、回卡片列表；status([A]) = {open:[A], preferWindow:[A]}；有 A 的窗口；
 *         窗口标题栏是扳手 + 名字，没有 v0.2.16 的图标
 *   OM-2  A 的窗口开着时点 A → 不进面板，A 的窗口仍恰一个
 *   OM-3  经 IPC 关掉 A 的窗口 → open 空、preferWindow 仍是 [A]；再点 A → 窗口又开了
 *   OM-4  A 的窗口开着时菜单「在面板中打开」→ preferWindow 空、A 的窗口没了；A 在面板前台、iframe 在；2s 后 A 仍注册着
 *   OM-5  再点 A → 面板
 *   OM-6  B 的菜单「在独立窗口打开」→ preferWindow [B]，B 的窗口开了
 *   OM-7  C 在面板里时经 IPC（`widget` 工具的 `open` 走的那条服务调用）开 C 的窗口 → C 离开面板、preferWindow 里没有 C；点 C → 用那个窗口、
 *         preferWindow 仍没有 C；关掉它再点 C → 面板
 *   OM-8  A 在面板里时菜单「停止」→ 面板里没了、没有运行中的点、不再注册
 *   OM-9  面板里开着时菜单「归档」→ 应用与卡片都没了、在 listArchived 里；菜单「删除」：取消 → 还在；确认 → 列表与面板里
 *         都没了、目录删了
 *   OM-10 B 在面板后台时经 IPC 删掉 → 面板里那一层没了
 *   OM-11 菜单项：没在运行 = [openPanel, openWindow, sep1, export, archive, sep2, delete]；运行中多一个 stop（在 openWindow 之后）
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchApp, type E2EApp } from '../../harness/launch'
import { confirmPane, rightPanelPane, widgetPanelPane, widgetWindowPane } from '../../harness/pages'
import { connect, listTargets, sleep, until } from '../../harness/cdp'

const A = 'om-aa'
const B = 'om-bb'
const C = 'om-cc'
const D = 'om-dd'
const ALL = [A, B, C, D]
const NAMES: Record<string, string> = { [A]: 'Alpha', [B]: 'Bravo', [C]: 'Charlie', [D]: 'Delta' }

let app: E2EApp

interface WindowStatus {
  open: string[]
  preferWindow: string[]
}

function seedWidget(home: string, id: string, i: number): void {
  const dir = join(home, '.shuvix', 'widgets', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'widget.json'),
    JSON.stringify(
      { id, name: NAMES[id], description: '', entryFile: 'index.tsx', createdAt: 1000 + i },
      null,
      2
    ) + '\n'
  )
  writeFileSync(
    join(dir, 'index.tsx'),
    `const root = document.getElementById('root')\nif (root) root.textContent = 'WIDGET ${id}'\n`
  )
}

const status = (list: string[] = ALL): Promise<WindowStatus> =>
  app.main.eval<WindowStatus>(`window.api.widgetWindow.status(${JSON.stringify(list)})`)
const registered = async (): Promise<string[]> =>
  (await app.main.eval<{ registeredIds?: string[] }>('window.api.widget.getServerStatus()'))
    .registeredIds ?? []
const listIds = (): Promise<string[]> =>
  app.main.eval<string[]>('window.api.widget.list().then((l) => l.map((w) => w.id))')
/** 这个 widget 的独立窗口（CDP page target）有几个 */
const windowCount = async (id: string): Promise<number> =>
  (await listTargets(app.port)).filter(
    (t) => t.type === 'page' && t.url.includes(`#widget-window?widgetId=${encodeURIComponent(id)}`)
  ).length

async function foregroundIs(id: string | null): Promise<void> {
  const home = widgetPanelPane(app.main)
  await until(async () => (await home.foregroundApp()) === id || null, `foreground = ${id}`)
}

async function goBack(): Promise<void> {
  await widgetPanelPane(app.main).back()
  await foregroundIs(null)
}

async function windowCountIs(id: string, n: number): Promise<void> {
  await until(async () => (await windowCount(id)) === n || null, `${n} window(s) of ${id}`)
}

beforeAll(async () => {
  app = await launchApp()
  ALL.forEach((id, i) => seedWidget(app.home, id, i))
  await until(
    () => app.main.eval<boolean>(`!!document.querySelector('button[data-side="right"]')`),
    'the right panel toggle'
  )
  const panel = rightPanelPane(app.main)
  await panel.open()
  await panel.activateWidgetTab()
  await panel.setPanelWidth(360)
  const home = widgetPanelPane(app.main)
  await home.reload()
  // 都没打开过：按创建时间倒序
  const newestFirst = [D, C, B, A]
  await until(async () => (await home.cardIds()).join() === newestFirst.join() || null, 'all cards')
}, 120_000)

afterAll(async () => {
  await app?.stop()
})

describe('where a widget opens: panel or window', () => {
  it('OM-1 ↗ moves the app from the panel into its own window and remembers the choice', async () => {
    const home = widgetPanelPane(app.main)
    await home.clickCard(A)
    await foregroundIs(A)
    await until(() => home.frameReady(A), 'A iframe')
    await home.popout()
    await until(async () => !(await home.panelApps()).includes(A) || null, 'A left the panel')
    expect(await home.foregroundApp()).toBeNull()
    await windowCountIs(A, 1)
    expect(await status([A])).toStrictEqual({ open: [A], preferWindow: [A] })

    // 窗口的标题栏：扳手 + 名字，没有 v0.2.16 的图标
    const target = (await listTargets(app.port)).find(
      (t) => t.type === 'page' && t.url.includes(`#widget-window?widgetId=${encodeURIComponent(A)}`)
    )!
    const win = await connect(target.webSocketDebuggerUrl)
    try {
      const shell = widgetWindowPane(win)
      await until(async () => (await shell.titleText()) === NAMES[A] || null, 'A window title')
      expect(await shell.titleGlyph()).toBe('lucide-wrench')
      expect(await shell.legacyIcon()).toBe(false)
    } finally {
      win.close()
    }
  })

  it('OM-2 clicking A while its window is open focuses that window instead of the panel', async () => {
    const home = widgetPanelPane(app.main)
    await home.clickCard(A)
    await sleep(600)
    expect(await home.panelApps()).toEqual([])
    expect(await home.foregroundApp()).toBeNull()
    expect(await windowCount(A)).toBe(1)
    expect(await status([A])).toStrictEqual({ open: [A], preferWindow: [A] })
  })

  it('OM-3 the preference outlives the window: closed, a click opens a window again', async () => {
    const home = widgetPanelPane(app.main)
    await app.main.eval(`window.api.widgetWindow.close(${JSON.stringify(A)}).then(() => true)`)
    await until(async () => (await status([A])).open.length === 0 || null, 'A window closed')
    expect(await status([A])).toStrictEqual({ open: [], preferWindow: [A] })
    await windowCountIs(A, 0)

    await home.clickCard(A)
    await windowCountIs(A, 1)
    expect(await home.panelApps()).toEqual([])
    expect(await status([A])).toStrictEqual({ open: [A], preferWindow: [A] })
  })

  it('OM-4 "Open in panel" closes the window, forgets the preference and keeps the app registered', async () => {
    const home = widgetPanelPane(app.main)
    await home.pickMenu(A, 'openPanel')
    await foregroundIs(A)
    await windowCountIs(A, 0)
    expect(await status([A])).toStrictEqual({ open: [], preferWindow: [] })
    await until(() => home.frameReady(A), 'A iframe in the panel')
    // 关窗的注销是异步的：晚到的那一下不能把面板刚注册的撤掉
    await sleep(2000)
    expect(await registered()).toContain(A)
    expect(await home.frameReady(A)).toBe(true)
  })

  it('OM-5 clicking A again opens it in the panel', async () => {
    const home = widgetPanelPane(app.main)
    await goBack()
    await home.clickCard(A)
    await foregroundIs(A)
    expect(await windowCount(A)).toBe(0)
    await goBack()
    expect(await home.panelApps()).toEqual([A])
  })

  it('OM-6 "Open in window" from the menu opens B in a window and remembers it', async () => {
    const home = widgetPanelPane(app.main)
    await home.pickMenu(B, 'openWindow')
    await windowCountIs(B, 1)
    expect((await status()).preferWindow).toEqual([B])
    expect(await home.panelApps()).toEqual([A])
  })

  it('OM-7 a window opened over IPC (the widget tool’s open path) takes the app out of the panel without becoming the preference', async () => {
    const home = widgetPanelPane(app.main)
    await home.clickCard(C)
    await foregroundIs(C)
    await until(() => home.frameReady(C), 'C iframe')

    await app.main.eval(`window.api.widgetWindow.open(${JSON.stringify(C)}).then(() => true)`)
    await windowCountIs(C, 1)
    await until(async () => !(await home.panelApps()).includes(C) || null, 'C left the panel')
    expect(await home.foregroundApp()).toBeNull()
    expect((await status([C])).preferWindow).toEqual([])

    await home.clickCard(C)
    await sleep(600)
    expect(await windowCount(C)).toBe(1)
    expect(await home.panelApps()).not.toContain(C)
    expect((await status([C])).preferWindow).toEqual([])

    await until(() => home.running(C), 'C running (in its window)')
    await app.main.eval(`window.api.widgetWindow.close(${JSON.stringify(C)}).then(() => true)`)
    await windowCountIs(C, 0)
    // 关窗 → 注销 → widget.changed → 面板重取（运行中的点与「开着的窗口」是同一次重取）
    await until(async () => !(await home.running(C)) || null, 'the panel saw the window close')
    await home.clickCard(C)
    await foregroundIs(C)
    expect(await windowCount(C)).toBe(0)
    expect((await status([C])).preferWindow).toEqual([])
    await goBack()
  })

  it('OM-8 Stop from the menu takes the app out of the panel and unregisters it', async () => {
    const home = widgetPanelPane(app.main)
    expect(await home.panelApps()).toContain(A)
    await until(() => home.running(A), 'A running')
    await home.pickMenu(A, 'stop')
    await until(async () => !(await home.panelApps()).includes(A) || null, 'A left the panel')
    await until(async () => !(await home.running(A)) || null, 'no running dot')
    expect(await registered()).not.toContain(A)
  })

  it('OM-9 Archive and Delete from the menu', async () => {
    const home = widgetPanelPane(app.main)
    await home.clickCard(A)
    await foregroundIs(A)
    await goBack()
    await home.pickMenu(A, 'archive')
    await until(async () => !(await home.cardIds()).includes(A) || null, 'A card gone')
    expect(await home.panelApps()).not.toContain(A)
    expect(
      await app.main.eval<string[]>(
        'window.api.widget.listArchived().then((l) => l.map((w) => w.id))'
      )
    ).toEqual([A])

    // 删除：C 在面板后台
    expect(await home.panelApps()).toContain(C)
    const confirm = confirmPane(app.main)
    await home.pickMenu(C, 'delete')
    await confirm.waitOpen()
    expect((await confirm.snapshot()).description).toContain(NAMES[C])
    await confirm.cancel()
    await confirm.waitClosed()
    expect(await listIds()).toContain(C)
    expect(await home.panelApps()).toContain(C)

    await home.pickMenu(C, 'delete')
    await confirm.waitOpen()
    await confirm.confirm()
    await confirm.waitClosed()
    await until(async () => !(await listIds()).includes(C) || null, 'C deleted')
    await until(async () => !(await home.panelApps()).includes(C) || null, 'C left the panel')
    expect(await home.cardIds()).not.toContain(C)
    expect(existsSync(join(app.home, '.shuvix', 'widgets', C))).toBe(false)
  })

  it('OM-10 deleting a backgrounded panel app over IPC removes its layer', async () => {
    const home = widgetPanelPane(app.main)
    await home.pickMenu(B, 'openPanel')
    await foregroundIs(B)
    await windowCountIs(B, 0)
    await goBack()
    expect(await home.panelApps()).toEqual([B])
    await app.main.eval(`window.api.widget.delete(${JSON.stringify(B)}).then(() => true)`)
    await until(async () => (await home.panelApps()).length === 0 || null, 'B layer gone')
    expect(await home.cardIds()).toEqual([D])
  })

  it('OM-11 the menu items, with Stop only while the widget runs', async () => {
    const home = widgetPanelPane(app.main)
    expect(await home.running(D)).toBe(false)
    expect(await home.menuItemIds(D)).toEqual([
      'openPanel',
      'openWindow',
      'sep1',
      'export',
      'archive',
      'sep2',
      'delete'
    ])
    await home.clickCard(D)
    await foregroundIs(D)
    await goBack()
    await until(() => home.running(D), 'D running')
    expect(await home.menuItemIds(D)).toEqual([
      'openPanel',
      'openWindow',
      'stop',
      'sep1',
      'export',
      'archive',
      'sep2',
      'delete'
    ])
  })
})
