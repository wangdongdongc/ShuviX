/**
 * 设置 → 已归档 → 小组件（2026-10-16）—— 归档的小组件不再占 Widget 面板主屏的位置，都在这里：恢复（回到主屏**末尾**，
 * 不回原来的位置 —— 归档时它已从 homeOrder 里拿掉）或删除。桌面经 `extraTabs` 把「小组件」子 tab 交给共享的 ArchivedSettings。
 *
 * 真的 isolated 实例，种 4 个最小 widget；归档 / 主屏顺序经 IPC 摆好，恢复 / 删除在设置窗口里点。主屏顺序看主窗右侧面板。
 * 三语取串照抄 archived-projects.e2e.ts：隔离实例跟系统语言走，断的是「是哪一句」。
 *
 *   AW-1 已归档页的子 tab 是「项目」「小组件」；小组件 tab：没有归档的 → widgets.noArchived；归档三个 → 按归档时间倒序列出
 *   AW-2 恢复 → 那一行没了；主窗主屏上它排在最后（尽管它创建得最早、归档前排第一）
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
  widgetHomePane,
  type ArchivedSettingsPane
} from '../../harness/pages'
import { waitRendererReady } from '../../harness/seed'

const L = [en, zh, ja]
const SUB_TAB_PROJECTS = L.map((l) => l.settings.archivedSubTabProjects)
const SUB_TAB_WIDGETS = L.map((l) => l.settings.archivedSubTabWidgets)
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
  const home = widgetHomePane(app.main)
  await home.reload()
  await until(async () => (await home.slotIds()).join() === ids.join() || null, 'all icons')

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
    expect(bar.tabs).toHaveLength(2)
    expect(SUB_TAB_PROJECTS).toContain(bar.tabs[0].text)
    expect(SUB_TAB_WIDGETS).toContain(bar.tabs[1].text)

    await archived.selectSubTab(SUB_TAB_WIDGETS)
    const empty = await archived.waitEmpty()
    expect(NO_ARCHIVED_WIDGETS).toContain(empty)
    expect(await archived.archivedWidgetIds()).toEqual([])
    const tabs = (await archived.tabBar())!.tabs
    expect(tabs[1].underline).toBe(true)
    expect(tabs[0].underline).toBe(false)

    // 主屏顺序先落一份（恢复时要看出「回到末尾」而不是「回到原位」）
    await app.main.eval(`window.api.widget.setHomeOrder(${JSON.stringify(ids)}).then(() => true)`)
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
  })

  it('AW-2 Restore puts the widget back at the end of the home screen', async () => {
    const home = widgetHomePane(app.main)
    await until(async () => (await home.slotIds()).join() === 'aw-dd' || null, 'only D on home')
    await archived.clickArchivedWidget('aw-aa', RESTORE)
    await until(
      async () => !(await archived.archivedWidgetIds()).includes('aw-aa') || null,
      'the restored row gone'
    )
    expect(await activeIds()).toEqual(['aw-dd', 'aw-aa'])
    await until(
      async () => (await home.slotIds()).join() === 'aw-dd,aw-aa' || null,
      'A last on the home screen'
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
