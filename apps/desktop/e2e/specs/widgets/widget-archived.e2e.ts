/**
 * 设置 → 已归档 → 小组件（2026-10-16）—— 归档的小组件不在 Widget 面板里，都在这里：恢复（回到面板里按上次打开的时间
 * 该在的位置 —— 归档不动 lastOpenedAt）或删除。桌面经 `extraTabs` 把「小组件」子 tab 交给共享的 ArchivedSettings。
 *
 * 真的 isolated 实例，种 4 个最小 widget（A 在账目里一分钟前打开过，其余没打开过）；归档经 IPC 摆好，恢复 / 删除在设置窗口里点。
 * 面板顺序看主窗右侧面板的卡片。三语取串照抄 archived-projects.e2e.ts：隔离实例跟系统语言走，断的是「是哪一句」。
 *
 *   AW-1 已归档页的子 tab 是「项目」「小组件」「Bots」；小组件 tab：没有归档的 → widgets.noArchived；归档三个 → 按归档时间倒序列出；
 *        每行行首是归档图标，没有 v0.2.16 的小组件图标
 *   AW-1b 没有悬停的设备（触屏模拟让 `(hover: none)` 成立）上行尾的恢复 / 删除一直显示；有悬停、鼠标不在行上时透明
 *   AW-2 恢复 → 那一行没了；面板里它排在最前（它打开过，别的没有），不是末尾
 *   AW-3 删除：确认框点名这个小组件；取消 → 还在；确认 → listArchived 里没了、目录删了
 *   AW-4 切回「项目」→ 项目的空态
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import ja from '@shuvix/chat-protocol/i18n/locales/ja.json'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import { sleep, until, type CdpClient } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import {
  archivedSettingsPane,
  confirmPane,
  rightPanelPane,
  widgetPanelPane,
  type ArchivedSettingsPane
} from '../../harness/pages'
import { waitRendererReady } from '../../harness/seed'

const L = [en, zh, ja]
const SUB_TAB_PROJECTS = L.map((l) => l.settings.archivedSubTabProjects)
const SUB_TAB_WIDGETS = L.map((l) => l.settings.archivedSubTabWidgets)
const SUB_TAB_BOTS = L.map((l) => l.settings.archivedSubTabBots)
const NO_ARCHIVED_WIDGETS = L.map((l) => l.widgets.noArchived)
const NO_ARCHIVED_PROJECTS = L.map((l) => l.settings.projectsNoArchived)
const RESTORE = L.map((l) => l.widgets.restore)
const DELETE = L.map((l) => l.widgets.delete)

const ids = ['aw-aa', 'aw-bb', 'aw-cc', 'aw-dd']
const NAMES: Record<string, string> = {
  'aw-aa': 'Archive Alpha',
  'aw-bb': 'Archive Bravo',
  'aw-cc': 'Archive Charlie',
  'aw-dd': 'Archive Delta'
}

let app: E2EApp
let settings: CdpClient
let archived: ArchivedSettingsPane

function seedWidget(home: string, id: string, i: number): void {
  const dir = join(home, '.shuvix', 'widgets', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'widget.json'),
    JSON.stringify(
      {
        id,
        name: NAMES[id],
        description: 'archived e2e',
        entryFile: 'index.tsx',
        createdAt: 1000 + i
      },
      null,
      2
    ) + '\n'
  )
  writeFileSync(join(dir, 'index.tsx'), `document.getElementById('root')!.textContent = '${id}'\n`)
}

const archivedIds = (): Promise<string[]> =>
  app.main.eval<string[]>('window.api.widget.listArchived().then((l) => l.map((w) => w.id))')
const activeIds = (): Promise<string[]> =>
  app.main.eval<string[]>('window.api.widget.list().then((l) => l.map((w) => w.id))')
const setArchived = (id: string, value: boolean): Promise<unknown> =>
  app.main.eval(
    `window.api.widget.setArchived(${JSON.stringify({ id, archived: value })}).then(() => true)`
  )

beforeAll(async () => {
  app = await launchApp()
  ids.forEach((id, i) => seedWidget(app.home, id, i))
  await waitRendererReady(app.main)
  await until(
    () => app.main.eval<boolean>(`!!document.querySelector('button[data-side="right"]')`),
    'the right panel toggle'
  )
  const panel = rightPanelPane(app.main)
  await panel.open()
  await panel.activateWidgetTab()
  await panel.setPanelWidth(360)
  // A 一分钟前打开过（第一次刷新之前写好账目）：它排最前，其余按创建时间倒序
  writeFileSync(
    join(app.home, '.shuvix', 'widgets', '.config.json'),
    JSON.stringify({ state: { 'aw-aa': { lastOpenedAt: Date.now() - 60_000 } } }, null, 2) + '\n'
  )
  const home = widgetPanelPane(app.main)
  await home.reload()
  const order = ['aw-aa', 'aw-dd', 'aw-cc', 'aw-bb']
  await until(async () => (await home.cardIds()).join() === order.join() || null, 'all cards')

  settings = await app.openSettings('archived')
  archived = archivedSettingsPane(settings)
  await until(() => archived.tabBar(), 'the archived page tab bar')
}, 120_000)

afterAll(async () => {
  await app?.stop()
})

describe('archived widgets in settings', () => {
  it('AW-1 Projects and Widgets sub tabs; the widgets tab lists archived widgets newest first', async () => {
    const bar = (await archived.tabBar())!
    // 第三个是 Bots（2026-10-31，归档的 bot 在那里）
    expect(bar.tabs).toHaveLength(3)
    expect(SUB_TAB_PROJECTS).toContain(bar.tabs[0].text)
    expect(SUB_TAB_WIDGETS).toContain(bar.tabs[1].text)
    expect(SUB_TAB_BOTS).toContain(bar.tabs[2].text)

    await archived.selectSubTab(SUB_TAB_WIDGETS)
    const empty = await archived.waitEmpty()
    expect(NO_ARCHIVED_WIDGETS).toContain(empty)
    expect(await archived.archivedWidgetIds()).toEqual([])
    const tabs = (await archived.tabBar())!.tabs
    expect(tabs[1].underline).toBe(true)
    expect(tabs[0].underline).toBe(false)

    for (const id of ids.slice(0, 3)) {
      await setArchived(id, true)
      await sleep(20) // 归档时间分得开
    }
    const newestFirst = ['aw-cc', 'aw-bb', 'aw-aa']
    await until(
      async () => (await archived.archivedWidgetIds()).join() === newestFirst.join() || null,
      'archived widgets listed newest first'
    )
    expect(await archivedIds()).toEqual(newestFirst)
    for (const id of newestFirst) {
      const row = (await archived.archivedWidgetRow(id))!
      expect(row.glyph, id).toBe('lucide-archive')
      expect(row.legacyIcon, id).toBe(false)
    }
  })

  it('AW-1b on a device without hover the Restore / Delete buttons are always shown', async () => {
    // CDP 的鼠标挪到窗口左上角：之后真鼠标不动，行就不在 :hover 里
    await settings.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 })
    expect(await settings.eval<boolean>(`matchMedia('(hover: none)').matches`)).toBe(false)
    await until(
      async () => (await archived.archivedWidgetRow('aw-aa'))?.actionsOpacity === 0 || null,
      'the row buttons hidden without hover'
    )
    await settings.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
    try {
      expect(
        await settings.eval<boolean>(`matchMedia('(hover: none)').matches`),
        'precondition: touch emulation makes hover none'
      ).toBe(true)
      await until(
        async () => (await archived.archivedWidgetRow('aw-aa'))?.actionsOpacity === 1 || null,
        'the row buttons shown without hover'
      )
    } finally {
      await settings.send('Emulation.setTouchEmulationEnabled', { enabled: false })
    }
    await until(
      async () => (await archived.archivedWidgetRow('aw-aa'))?.actionsOpacity === 0 || null,
      'the row buttons hidden again with hover'
    )
  })

  it('AW-2 Restore puts the widget back where its last open places it (first), not at the end', async () => {
    const home = widgetPanelPane(app.main)
    await until(
      async () => (await home.cardIds()).join() === 'aw-dd' || null,
      'only D in the panel'
    )
    await archived.clickArchivedWidget('aw-aa', RESTORE)
    await until(
      async () => !(await archived.archivedWidgetIds()).includes('aw-aa') || null,
      'the restored row gone'
    )
    expect(await activeIds()).toEqual(['aw-aa', 'aw-dd'])
    await until(
      async () => (await home.cardIds()).join() === 'aw-aa,aw-dd' || null,
      'A first in the panel'
    )
  })

  it('AW-3 Delete asks first, naming the widget; Cancel keeps it, Confirm removes it and its folder', async () => {
    const confirm = confirmPane(settings)
    await archived.clickArchivedWidget('aw-bb', DELETE)
    await confirm.waitOpen()
    expect((await confirm.snapshot()).description).toContain(NAMES['aw-bb'])
    await confirm.cancel()
    await confirm.waitClosed()
    expect(await archived.archivedWidgetIds()).toEqual(['aw-cc', 'aw-bb'])
    expect(await archivedIds()).toContain('aw-bb')

    await archived.clickArchivedWidget('aw-bb', DELETE)
    await confirm.waitOpen()
    await confirm.confirm()
    await confirm.waitClosed()
    await until(
      async () => (await archived.archivedWidgetIds()).join() === 'aw-cc' || null,
      'the deleted row gone'
    )
    expect(await archivedIds()).toEqual(['aw-cc'])
    expect(existsSync(join(app.home, '.shuvix', 'widgets', 'aw-bb'))).toBe(false)
  })

  it('AW-4 back on Projects: the archived projects empty state', async () => {
    await archived.selectSubTab(SUB_TAB_PROJECTS)
    const text = await until(async () => {
      const t = await archived.emptyText()
      return t && NO_ARCHIVED_PROJECTS.includes(t) ? t : null
    }, 'the projects empty state')
    expect(NO_ARCHIVED_PROJECTS).toContain(text)
    expect(await archived.archivedWidgetIds()).toEqual([])
    expect((await archived.tabBar())!.tabs[0].underline).toBe(true)
  })
})
