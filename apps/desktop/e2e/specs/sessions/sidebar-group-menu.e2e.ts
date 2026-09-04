/**
 * 侧栏分组头的动作入口（GM）—— 组头同样只剩悬停浮现的那颗 ⋮，新建对话 / 新建 Bot 会话 /
 * 项目配置 / 知识库刷新全在它与右键的同一份菜单里。
 *
 * 这里补的是既有 bots/ui-sidebar 那一批（A0-11…）没覆盖的三处装配缝：
 *   - **临时组**走的是 `openGroupMenu(..., isTemp=true)` 分支：它没有项目配置。那半个
 *     分支此前无人碰过，而它恰好是「临时组头点了项目配置会怎样」的唯一防线。
 *   - **知识库组**是另一个装配点（WikiGroup 自己拼 items，不经 ProjectSessionGroups）。
 *     pages.ts 的 ACTION_HEADER 一直靠「跳过 wiki 组头」这个假设活着，这里把它验了。
 *   - `SessionGroup` 把 `onMenu` **直接**当 onContextMenu 用，而 `SessionItem` 外面包了
 *     一层带 id 的 lambda —— 两处接法不同，故「⋮ 与右键同源」两边各断一次。
 *
 * 全程无 LLM。知识库刷新那一条**必须排在本文件任何其它 wiki 交互之前**：wiki 项目行是
 * 首次扫描时懒建的，一旦被别的用例先扫出来，「之前没有」这半条就永远为真不了
 * （只打开菜单再取消不会扫 —— 那条路根本不调 onAction）。
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WIKI_PROJECT_ID } from '@shuvix/chat-protocol/wiki'
import { until } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import { createProject, waitRendererReady } from '../../harness/seed'
import {
  projectEditPane,
  sidebarPane,
  type MenuItemShot,
  type ProjectEditPane,
  type SidebarPane
} from '../../harness/pages'

const PROJECT_NAME = 'GMProj'
/** 让临时组出现的那条会话（临时组只在有临时会话时才渲染） */
const TEMP_SESSION = 'GM-临时会话'

let app: E2EApp
let sidebar: SidebarPane
let projectEdit: ProjectEditPane
let projectId = ''

const listSessionIds = (): Promise<string[]> =>
  app.main.eval<string[]>(`window.api.session.list().then((ss) => ss.map((s) => s.id))`)

const projectIdOf = (sid: string): Promise<string | null> =>
  app.main.eval<string | null>(
    `window.api.session.getById(${JSON.stringify(sid)}).then((s) => s.projectId)`
  )

/** 隐藏的 wiki 项目行是否已落库 —— `project.list` 会把它滤掉，只能按 id 取 */
const wikiProjectExists = (): Promise<boolean> =>
  app.main.eval<boolean>(
    `window.api.project.getById(${JSON.stringify(WIKI_PROJECT_ID)}).then((p) => !!p)`
  )

/** items → 便于逐项比对的序列（分隔符记成 'sep'；分组菜单目前没有分隔符） */
const idsOf = (items: MenuItemShot[] | null): string[] => (items ?? []).map((it) => it.id ?? 'sep')

/** 记录当前会话 id 集，执行 act 后等到列表真的长出新条目，返回新增的那些 id */
async function newSessionsAfter(act: () => Promise<void>): Promise<string[]> {
  const before = await listSessionIds()
  await act()
  const after = await until(async () => {
    const ids = await listSessionIds()
    return ids.length > before.length ? ids : null
  }, 'a new session created')
  return after.filter((id) => !before.includes(id))
}

beforeAll(async () => {
  app = await launchApp()
  await waitRendererReady(app.main)
  sidebar = sidebarPane(app.main)
  projectEdit = projectEditPane(app.main)

  const projDir = join(app.home, 'proj-gm')
  mkdirSync(projDir, { recursive: true })
  projectId = (await createProject(app.main, { name: PROJECT_NAME, path: projDir })).id

  await app.main.eval(`window.api.session.create({ title: ${JSON.stringify(TEMP_SESSION)} })`)
  await until(
    async () => (await sidebar.titles()).includes(TEMP_SESSION),
    'temp session listed (temp group rendered)'
  )
}, 120_000)

afterAll(async () => {
  await app?.stop()
})

describe('三种组头各给什么菜单', () => {
  // GM-01
  it('项目组有项目配置、临时组没有（临时组不属于任何项目，那一项无处可去）', async () => {
    expect(idsOf(await sidebar.groupMenuShots({ project: PROJECT_NAME }))).toEqual([
      'new-chat',
      'new-bot-chat',
      'edit-project'
    ])
    expect(idsOf(await sidebar.groupMenuShots('temp'))).toEqual(['new-chat', 'new-bot-chat'])
  })

  // GM-02 —— 只开菜单再取消，不选任何项：这一步**不会**触发扫描，故排在 GM-03 之前无害
  it('知识库组头只有「刷新」一项', async () => {
    expect(idsOf(await sidebar.groupMenuShots('wiki'))).toEqual(['refresh'])
  })

  // GM-03 —— 必须排在本文件任何会触发扫描的 wiki 交互之前（见文件头）
  it('选中「刷新」真的会扫：隐藏的 wiki 项目此刻才被懒建出来', async () => {
    expect(await wikiProjectExists()).toBe(false)

    await sidebar.pickGroupMenu('wiki', 'refresh')

    await until(wikiProjectExists, 'wiki project row lazily created by the scan')
  })
})

describe('菜单动作落在「它属于的那个组」', () => {
  // GM-04
  it('新建对话的项目归属随组：项目组下带 projectId，临时组下为 null', async () => {
    const inProject = await newSessionsAfter(() =>
      sidebar.pickGroupMenu({ project: PROJECT_NAME }, 'new-chat')
    )
    expect(inProject).toHaveLength(1)
    expect(await projectIdOf(inProject[0])).toBe(projectId)

    const inTemp = await newSessionsAfter(() => sidebar.pickGroupMenu('temp', 'new-chat'))
    expect(inTemp).toHaveLength(1)
    expect(await projectIdOf(inTemp[0])).toBeNull()
  })

  // GM-05 —— ⚠️ 弹窗里的「更换文件夹」绝不点：它走 dialog:openDirectory，
  // 弹的是 OS 目录面板，e2e 关不掉
  it('项目配置打开的是这个项目的编辑弹窗（名称字段就是种子项目名）', async () => {
    await sidebar.pickGroupMenu({ project: PROJECT_NAME }, 'edit-project')
    await projectEdit.waitOpen()
    expect(await projectEdit.nameValue()).toBe(PROJECT_NAME)

    await projectEdit.close()
    expect(await projectEdit.isOpen()).toBe(false)
  })
})

describe('⋮ 与右键同源（组头这一侧的接法与会话行不同）', () => {
  // GM-06
  it('点组头的 ⋮ 与右键组头弹的是同一份菜单（连 label 与顺序都一样）', async () => {
    const viaButton = await sidebar.groupMenuShots({ project: PROJECT_NAME })
    const viaContextMenu = await sidebar.groupMenuShots({ project: PROJECT_NAME }, 'contextmenu')
    expect(viaButton).not.toBeNull()
    expect(viaContextMenu).toEqual(viaButton)
  })

  // GM-07
  it('组头也只剩一颗 ⋮：临时组 {⋮}、项目组与知识库组 {折叠钮, ⋮}，旧的一排小图标一个不剩', async () => {
    const temp = await sidebar.groupAffordances('temp')
    expect(temp).not.toBeNull()
    // 临时组是摊开的纯分节：标题行是 div 不是按钮，故连折叠钮都没有
    expect(temp!.buttons).toEqual(['menu'])
    expect(temp!.legacyActionIcons).toEqual([])
    expect(temp!.menuOpacity).toBe('0')

    for (const target of [{ project: PROJECT_NAME }, 'wiki'] as const) {
      const header = await sidebar.groupAffordances(target)
      expect(header, JSON.stringify(target)).not.toBeNull()
      expect(header!.buttons, JSON.stringify(target)).toEqual(['toggle', 'menu'])
      expect(header!.legacyActionIcons, JSON.stringify(target)).toEqual([])
    }
  })
})
