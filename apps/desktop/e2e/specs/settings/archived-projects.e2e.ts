/**
 * 设置一级导航「已归档」页（ARC）—— 「项目」一级入口改名「已归档」（id `projects` → `archived`，
 * FolderClosed → Archive 图标），页内由「左侧 220px 子导航列 + 唯一子项」改为「顶部 PanelTabBar
 * 横向标签条（唯一子 tab『项目』）+ 内容区」；归档列表 / 恢复 / 删除 / 空态行为不变。
 * 这份 spec 钉的是**那次整改的边界**，不是列表好不好用：
 *
 *   - 左栏只剩一个入口（ARC-E-1）：旧一级「项目」与页内子 tab 同名，断言不限定左栏作用域，
 *     裸查 document 会把内容区的子 tab 误认成「旧入口还在」—— 两头都得断。
 *   - hash 直达（ARC-E-2）与文案非裸键（ARC-E-3 / ARC-E-5）：`#settings/archived` 是新 id，
 *     旧书签 `#settings/projects` 落空后回 general 而不是猜一个（ARC-E-12 的另一半）。
 *   - 页内结构（ARC-E-4）：横向 PanelTabBar + 唯一子 tab + 选中下划线在，竖向子导航列不在。
 *     行按钮只钉结构与 title（ARC-E-8）：`group-hover` 是 CSS 伪类，合成事件触发不了，
 *     「悬停才浮现」的像素级表现不可测。
 *   - 恢复 / 删除的行为面（ARC-E-9 / ARC-E-10）走 IPC 与主窗侧栏断「分桶换边」，
 *     设置窗内的行消失只是它的一半。
 *
 * 一个隔离实例、**一个设置窗口一路点下去**（`openSettings` 对已存在的窗口只聚焦、不切 tab），
 * 所以用例之间有顺序依赖：空态断言（ARC-E-6）必须抢在种数据之前（种下去就回不来，
 * ARC-E-11 复用这一次空态），ARC-E-12 毁窗重开必须放最后。
 * 三语取串照抄 settings-hints.e2e.ts：隔离实例跟系统语言走，断的是「是哪一句」。
 */
import { mkdirSync } from 'node:fs'
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
  sidebarPane,
  type ArchivedSettingsPane,
  type ConfirmPane,
  type SidebarPane
} from '../../harness/pages'
import { createProject, waitRendererReady } from '../../harness/seed'

const L = [en, zh, ja]

/** 一级导航「已归档」/ 页内子 tab「项目」/ 空态 / 通用 tab 的三语候选 */
const TAB_ARCHIVED = L.map((l) => l.settings.tabArchived)
const SUB_TAB_PROJECTS = L.map((l) => l.settings.archivedSubTabProjects)
const NO_ARCHIVED = L.map((l) => l.settings.projectsNoArchived)
const TAB_GENERAL = L.map((l) => l.settings.tabGeneral)
/** 行按钮与确认弹窗的三语候选（复用侧栏同名动作的键） */
const RESTORE_PROJECT = L.map((l) => l.sidebar.restoreProject)
const DELETE_PROJECT = L.map((l) => l.sidebar.deleteProject)
const CONFIRM_DELETE_PROJECT = L.map((l) => l.sidebar.confirmDeleteProject)

/** 两个归档项目（ARC-E-7 才种下 —— 空态断言必须抢在它们前面） */
const PROJECT_A = 'ARC-归档甲'
const PROJECT_B = 'ARC-归档乙'

let app: E2EApp
let settings: CdpClient
let archived: ArchivedSettingsPane
let confirm: ConfirmPane
let sidebar: SidebarPane
let projectAId = ''
let projectBId = ''

const namesOf = (list: Array<{ name: string }>): string[] => list.map((p) => p.name)
const activeProjects = (): Promise<Array<{ name: string }>> =>
  app.main.eval('window.api.project.list()')
const archivedProjects = (): Promise<Array<{ name: string }>> =>
  app.main.eval('window.api.project.listArchived()')

beforeAll(async () => {
  app = await launchApp()
  await waitRendererReady(app.main)
  settings = await app.openSettings('archived')
  archived = archivedSettingsPane(settings)
  confirm = confirmPane(settings)
  sidebar = sidebarPane(app.main)
  // 设置窗口是另开的一扇窗，React 挂完才有一级导航可读
  await until(() => archived.navButton(TAB_ARCHIVED), 'archived nav button')
}, 120_000)

afterAll(async () => {
  await app?.stop()
})

describe('一级导航与 hash 直达', () => {
  it('ARC-E-1 一级项是「已归档」（active + Archive 图标），左栏不再有第二个「项目」入口', async () => {
    const btn = await archived.navButton(TAB_ARCHIVED)
    expect(btn).not.toBeNull()
    expect(btn!.active).toBe(true)
    expect(btn!.archiveIcon).toBe(true)
    // 必须限定左栏作用域：内容区的子 tab 也叫「项目」，裸查 document 会误命中
    expect(await archived.navHasButton(SUB_TAB_PROJECTS)).toBe(false)
  })

  it('ARC-E-2 #settings/archived hash 直达：不点任何东西就落在已归档 tab', async () => {
    expect(await settings.eval('window.location.hash')).toBe('#settings/archived')
    expect((await archived.navButton(TAB_ARCHIVED))!.active).toBe(true)
    // 落在已归档 tab = 内容区挂着这页的 PanelTabBar（别的一级 tab 没有它）
    expect(await archived.tabBar()).not.toBeNull()
  })

  it('ARC-E-3 一级项文本 ∈ 三语候选且不是裸键', async () => {
    // 候选恰为这三句 —— 语言包改了文案这里同步改
    expect([...TAB_ARCHIVED].sort()).toEqual(['Archived', 'アーカイブ', '已归档'].sort())
    const btn = (await archived.navButton(TAB_ARCHIVED))!
    expect(TAB_ARCHIVED).toContain(btn.text)
    // 裸键（settings.tabArchived）也算失败：语言包缺键不上屏，肉眼看不出来
    expect(btn.text).not.toBe('settings.tabArchived')
  })
})

describe('页内结构（PanelTabBar）', () => {
  it('ARC-E-4 内容区顶部是 PanelTabBar：横向条 + 唯一子 tab + 选中下划线，没有第二条竖向子导航列', async () => {
    const bar = await archived.tabBar()
    expect(bar).not.toBeNull()
    expect(bar!.className).toContain('flex')
    expect(bar!.className).toContain('h-8')
    expect(bar!.className).toContain('border-b')
    expect(bar!.tabs).toHaveLength(1)
    expect(bar!.tabs[0].folderIcon).toBe(true)
    expect(SUB_TAB_PROJECTS).toContain(bar!.tabs[0].text)
    expect(bar!.tabs[0].underline).toBe(true)
    // 整改拆掉的旧结构：除一级 180px 列外，内容区不得再有 w-[220px] / border-r 的竖向子导航列
    expect(await archived.verticalSubNavs()).toBe(0)
  })

  it('ARC-E-5 子 tab 文字 ∈ 三语候选且不是裸键', async () => {
    expect([...SUB_TAB_PROJECTS].sort()).toEqual(['Projects', 'プロジェクト', '项目'].sort())
    const bar = (await archived.tabBar())!
    expect(SUB_TAB_PROJECTS).toContain(bar.tabs[0].text)
    expect(bar.tabs[0].text).not.toBe('settings.archivedSubTabProjects')
  })
})

describe('空态与归档项目的进出场', () => {
  it('ARC-E-6 初始空态：空态文案在屏、列表 0 行', async () => {
    expect(NO_ARCHIVED).toContain(await archived.emptyText())
    expect(await archived.rows()).toEqual([])
  })

  it('ARC-E-7 种两个项目并归档：设置窗列表两行，IPC 分桶正确，主窗侧栏不再有项目组头', async () => {
    const dirA = join(app.home, 'arc-proj-a')
    const dirB = join(app.home, 'arc-proj-b')
    mkdirSync(dirA, { recursive: true })
    mkdirSync(dirB, { recursive: true })
    projectAId = (await createProject(app.main, { name: PROJECT_A, path: dirA })).id
    projectBId = (await createProject(app.main, { name: PROJECT_B, path: dirB })).id
    await app.main.eval(
      `window.api.project.update(${JSON.stringify({ id: projectAId, archived: true })})`
    )
    await app.main.eval(
      `window.api.project.update(${JSON.stringify({ id: projectBId, archived: true })})`
    )

    // 设置窗经 useProjects() 订阅 project.changed 自动刷新（不经手动重载）
    await archived.waitRows([PROJECT_A, PROJECT_B])
    expect(namesOf(await activeProjects())).not.toContain(PROJECT_A)
    expect(namesOf(await activeProjects())).not.toContain(PROJECT_B)
    expect(namesOf(await archivedProjects())).toEqual(
      expect.arrayContaining([PROJECT_A, PROJECT_B])
    )
    // 归档项目不再出现在主窗侧栏（等广播落定再断）。「组头消失」只能用 groupHeaderPresent
    // 断：groupMenuShots 内部会先等组头出现，拿它断「不在」会把用例挂死而不是返回 null
    await until(
      async () => !(await sidebar.groupHeaderPresent({ project: PROJECT_A })) || null,
      'project A group gone from sidebar'
    )
    expect(await sidebar.groupHeaderPresent({ project: PROJECT_B })).toBe(false)
  })

  it('ARC-E-8 行按钮结构：恢复 / 删除两个按钮，容器 opacity-0 group-hover:opacity-100', async () => {
    const rows = await archived.rows()
    expect(rows.map((r) => r.name)).toEqual(expect.arrayContaining([PROJECT_A, PROJECT_B]))
    for (const row of rows) {
      expect(row.buttonTitles).toHaveLength(2)
      expect(RESTORE_PROJECT).toContain(row.buttonTitles[0])
      expect(DELETE_PROJECT).toContain(row.buttonTitles[1])
      // 结构断言到此为止：group-hover 是 CSS 伪类，合成事件触发不了，
      // 「悬停才浮现」的像素级表现不可测，只能钉住类名还在
      expect(row.actionsClass).toContain('opacity-0')
      expect(row.actionsClass).toContain('group-hover:opacity-100')
    }
  })

  it('ARC-E-9 恢复：行消失、主窗侧栏项目组头回来、IPC 分桶换边', async () => {
    await archived.clickRowButton(PROJECT_A, RESTORE_PROJECT)
    await archived.waitRowGone(PROJECT_A)
    // 跨窗口：主窗侧栏同样订阅 project.changed，组头回来（且菜单照常可弹）即同步落定
    await until(
      () => sidebar.groupHeaderPresent({ project: PROJECT_A }),
      'project A group back in sidebar'
    )
    expect(await sidebar.groupMenuShots({ project: PROJECT_A })).not.toBeNull()
    expect(namesOf(await activeProjects())).toContain(PROJECT_A)
    expect(namesOf(await archivedProjects())).not.toContain(PROJECT_A)
  })

  it('ARC-E-10 删除：ConfirmDialog 取消行仍在，确认才行消失', async () => {
    await archived.clickRowButton(PROJECT_B, DELETE_PROJECT)
    await confirm.waitOpen()
    expect(CONFIRM_DELETE_PROJECT).toContain((await confirm.snapshot()).title)
    await confirm.cancel()
    await confirm.waitClosed()
    // 取消 = 什么都没发生：行在、归档分桶也在
    expect((await archived.rows()).map((r) => r.name)).toContain(PROJECT_B)
    expect(namesOf(await archivedProjects())).toContain(PROJECT_B)

    await archived.clickRowButton(PROJECT_B, DELETE_PROJECT)
    await confirm.waitOpen()
    await confirm.confirm()
    await confirm.waitClosed()
    await archived.waitRowGone(PROJECT_B)
    expect(namesOf(await archivedProjects())).not.toContain(PROJECT_B)
  })

  it('ARC-E-11 空态回归：最后一个归档项目离场后空态文案即时重现（不经刷新）', async () => {
    expect(NO_ARCHIVED).toContain(await archived.waitEmpty())
    expect(await archived.rows()).toEqual([])
  })
})

describe('毁窗重开', () => {
  it("ARC-E-12 毁窗后 openSettings('projects') 重连：落在 general，「已归档」不 active", async () => {
    // 旧窗必须死透再重开：openSettings 对已存在窗口只聚焦，旧窗没毁就成了「聚焦不切 tab」。
    // cdp 客户端对断连的 pending eval 不拒绝（会一直挂着），所以用 race 探活而不是裸 await
    await settings.eval('window.close()').catch(() => undefined)
    await until(async () => {
      const alive = await Promise.race([
        settings.eval('1 + 1').then(
          () => true,
          () => false
        ),
        sleep(800).then(() => false)
      ])
      return alive ? null : true
    }, 'settings window destroyed')

    settings = await app.openSettings('projects')
    archived = archivedSettingsPane(settings)
    confirm = confirmPane(settings)
    // 'projects' 已不在 VALID_TABS：hash 里的旧入口名落空，回默认 tab 而不是猜一个
    const general = await until(() => archived.navButton(TAB_GENERAL), 'general nav button')
    expect(general.active).toBe(true)
    const archivedBtn = await archived.navButton(TAB_ARCHIVED)
    expect(archivedBtn).not.toBeNull()
    expect(archivedBtn!.active).toBe(false)
  })
})
