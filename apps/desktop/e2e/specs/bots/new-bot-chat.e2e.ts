/**
 * 和一个 bot 开新对话（BD-1…4）—— 2026-10-31 起 bot 会话只归属 bot：入口是侧栏「Bots」分节里那个 bot 组的「+」
 * （或组头 ⋮ →「新对话」），先弹「在哪里工作？」位置选择（原生菜单：项目、打开文件夹、临时），选了才建；关掉菜单
 * 什么都不建。选项目建出来的会话**不是**项目的成员（`projectId` 为 null）：项目记成引用 `settings.workProject`。
 *
 * 断言口径：
 *   - 「建了几条、绑的是谁、在哪干活」全走 IPC（session.list / getById）；DOM 只断呈现 —— 位置选择的菜单项（e2e 桩
 *     记下的 items）、新行落在 bot 组里且行尾标着位置、头部胶囊。
 *   - 活动会话**没有 IPC** 可读：「新建的这条成了活动会话」由两半拼成 —— 头部胶囊绑的是这个 bot，且 IPC 里绑这个
 *     bot 的会话只有这一条。
 *   - 新建的会话一律是本地化的默认标题（彼此同名）：标题只从 IPC 读、从不写死；行一律按组取。
 *
 * 顺序约束：BD-1 必须跑在任何合法 bot md 落盘之前（它要的是「目录里只有一份坏文件」），故 beforeAll 一个合法 bot
 * 都不种，每条用例现种自己用的那一个。
 *
 * ⚠️ 位置选择里的「打开文件夹…」绝不选：它弹的是 OS 目录面板，e2e 关不掉。
 */
import { mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import ja from '@shuvix/chat-protocol/i18n/locales/ja.json'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import { sleep, until } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import {
  createProject,
  listSessionIds,
  newSessionsAfter,
  sessionsBoundTo,
  waitRendererReady,
  writeBotMd
} from '../../harness/seed'
import {
  botChip,
  botsPane,
  sidebarPane,
  type BotChipPane,
  type BotChipSnapshot,
  type BotsPane,
  type MenuItemShot,
  type SidebarPane
} from '../../harness/pages'

/** 让临时组出现的那条会话（临时组只在有临时会话时才渲染） */
const TEMP_SEED = 'BD-temp-seed'
/** 两个项目：名字与任何 bot 的 name / displayName / description 都不重叠 */
const ALPHA_PROJ = 'BD-Alpha-Proj'
const ZETA_PROJ = 'BD-Zeta-Proj'
/** 「临时」的三语文案（行尾的位置标注；界面语言随系统，三种都认） */
const TEMP_LABELS = [en, zh, ja].map((l) => l.sidebar.botTempLocation)

/** getById 回来的、这里要断的那几个字段 */
interface SessionShot {
  id: string
  title: string
  projectId: string | null
  parentId: string | null
  workingDirectory?: string
  settings: { bot?: string; workProject?: string; workingDirectory?: string }
}

let app: E2EApp
let sidebar: SidebarPane
let bots: BotsPane
let chip: BotChipPane
const projectIds: Record<string, string> = {}
const projectDirs: Record<string, string> = {}

const getSession = (sid: string): Promise<SessionShot | null> =>
  app.main.eval<SessionShot | null>(`window.api.session.getById(${JSON.stringify(sid)})`)

/** 菜单项 → 便于逐项比对的序列（分隔符记成 'sep'） */
const idsOf = (items: MenuItemShot[]): string[] => items.map((it) => it.id ?? 'sep')

/** 等头部胶囊绑到某个 bot、位置胶囊落定到 `location` */
const waitChip = (bot: string, location: string): Promise<BotChipSnapshot> =>
  until(async () => {
    const shot = await chip.snapshot()
    return shot.bot === bot && shot.location === location ? shot : null
  }, `header chip bound to "${bot}" working in ${location}`)

/** 刷新一次清单并等某个 bot 的组出现（磁盘外写入不广播 bot.changed） */
const refreshUntilGroup = async (name: string): Promise<void> => {
  await bots.refresh()
  await bots.waitGroup(name)
}

beforeAll(async () => {
  app = await launchApp()
  await waitRendererReady(app.main)
  sidebar = sidebarPane(app.main)
  bots = botsPane(app.main)
  chip = botChip(app.main)

  await app.main.eval(`window.api.session.create({ title: ${JSON.stringify(TEMP_SEED)} })`)
  await until(
    async () => (await sidebar.titles()).includes(TEMP_SEED),
    'temp seed session listed (temp group rendered)'
  )

  for (const [name, dir] of [
    [ALPHA_PROJ, 'proj-bd-alpha'],
    [ZETA_PROJ, 'proj-bd-zeta']
  ] as const) {
    const path = join(app.home, dir)
    mkdirSync(path, { recursive: true })
    projectDirs[name] = path
    projectIds[name] = (await createProject(app.main, { name, path })).id
  }
  await until(
    async () =>
      (await sidebar.groupAffordances({ project: ALPHA_PROJ })) !== null &&
      (await sidebar.groupAffordances({ project: ZETA_PROJ })) !== null,
    'both project group headers rendered'
  )
}, 120_000)

afterAll(async () => {
  await app?.stop()
})

describe('空注册表', () => {
  // 必须是本文件第一条用例：此刻 bots 目录里还没有任何合法 bot（见文件头）
  it('BD-1 目录里只有一份坏文件：Bots 分节没有一个组（也就没有「+」），坏文件以琥珀行列出；项目 / 临时组的菜单里没有 bot 入口', async () => {
    writeBotMd(app, 'stray', { marker: 'agent v1' })
    const registry = await app.main.eval<{
      bots: Array<{ name: string }>
      invalid: Array<{ fileName: string }>
    }>(`window.api.bot.list()`)
    expect(registry.bots).toEqual([])
    expect(registry.invalid.map((f) => f.fileName)).toContain('stray.md')

    await bots.refresh()
    await until(async () => (await bots.invalidRows()).includes('stray.md'), 'amber stray row')
    expect(await bots.groups()).toEqual([])
    expect(await sidebar.groupMenuItems({ project: ZETA_PROJ })).not.toContain('new-bot-chat')
    expect(await sidebar.groupMenuItems('temp')).not.toContain('new-bot-chat')
  })
})

describe('先选位置再建', () => {
  it('BD-2 「+」→ 位置选择（标题项置灰、各项目、分隔、打开文件夹、临时）→ 选「临时」：恰好建一条、绑的是它、没有项目也没有引用，并成为活动会话', async () => {
    writeBotMd(app, 'alpha', { displayName: 'Alpha Prime', description: 'BD alpha bot' })
    await refreshUntilGroup('alpha')
    // bot 组缺省折叠；一条会话都没有时正文是一行「新对话」
    expect(await bots.groupExpanded('alpha')).toBe(false)
    expect(await bots.newChatRow('alpha')).toBe(true)
    expect((await chip.snapshot()).count).toBe(0)

    let items: MenuItemShot[] = []
    const fresh = await newSessionsAfter(app.main, async () => {
      items = await bots.openPicker('alpha', 'temp')
    })
    // 位置选择：标题项（置灰）→ 两个项目 → 分隔 → 打开文件夹 → 临时；项目都在第一层（不足 8 个，没有「更多项目」）
    expect(items[0]).toMatchObject({ id: 'where', enabled: false })
    expect(idsOf(items)).toEqual([
      'where',
      ...idsOf(items).slice(1, 3),
      'sep',
      'open-folder',
      'temp'
    ])
    expect(new Set(idsOf(items).slice(1, 3))).toEqual(
      new Set([`project:${projectIds[ALPHA_PROJ]}`, `project:${projectIds[ZETA_PROJ]}`])
    )
    expect(
      new Set(items.filter((it) => it.id?.startsWith('project:')).map((it) => it.label))
    ).toEqual(new Set([ALPHA_PROJ, ZETA_PROJ]))

    expect(fresh).toHaveLength(1)
    const sid = fresh[0]
    const session = await getSession(sid)
    expect(session).not.toBeNull()
    expect(session!.settings.bot).toBe('alpha')
    expect(session!.projectId).toBeNull()
    expect(session!.parentId).toBeNull()
    expect(session!.settings.workProject).toBeUndefined()

    // 活动会话没有 IPC：胶囊绑的是 alpha + 绑 alpha 的会话只有这一条 ⇒ 活动的正是新建的这条
    const shot = await waitChip('alpha', 'temp')
    expect(TEMP_LABELS).toContain(shot.locationText)
    expect(await sessionsBoundTo(app.main, 'alpha')).toEqual([sid])

    // 新行落在 alpha 组里（建会话时组随之展开）、是活动行、行尾标着「临时」；标题取 IPC（本地化默认标题，不写死）
    await until(() => bots.groupExpanded('alpha'), 'alpha group expanded after the pick')
    const rows = await until(async () => {
      const r = await bots.groupSessions('alpha')
      return r.length > 0 ? r : null
    }, 'a row in the alpha group')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ title: session!.title, active: true, sub: false })
    expect(TEMP_LABELS).toContain(rows[0].location)
    expect(await bots.newChatRow('alpha')).toBe(false)
    expect(await sidebar.rowIcon(session!.title)).toBe('bot')
  })

  it('BD-3 选一个项目：会话不是项目的成员（projectId 为 null），项目记成引用 workProject，工作目录是项目根；行在 bot 组里、行尾标项目名，不进项目组', async () => {
    writeBotMd(app, 'beta', { displayName: 'Beta Prime' })
    await refreshUntilGroup('beta')
    const zetaId = projectIds[ZETA_PROJ]

    let items: MenuItemShot[] = []
    const fresh = await newSessionsAfter(app.main, async () => {
      items = await bots.openPicker('beta', `project:${zetaId}`)
    })
    expect(idsOf(items)).toContain(`project:${zetaId}`)
    expect(fresh).toHaveLength(1)
    const sid = fresh[0]
    const session = await getSession(sid)
    expect(session).not.toBeNull()
    expect(session!.settings.bot).toBe('beta')
    expect(session!.projectId).toBeNull()
    expect(session!.settings.workProject).toBe(zetaId)
    expect(realpathSync(session!.workingDirectory!)).toBe(realpathSync(projectDirs[ZETA_PROJ]))

    const shot = await waitChip('beta', 'project')
    expect(shot.locationText).toBe(ZETA_PROJ)
    expect(await sessionsBoundTo(app.main, 'beta')).toEqual([sid])

    const rows = await until(async () => {
      const r = await bots.groupSessions('beta')
      return r.length > 0 ? r : null
    }, 'a row in the beta group')
    expect(rows).toEqual([{ title: session!.title, location: ZETA_PROJ, active: true, sub: false }])
    // 引用不是成员：Zeta 项目组里一行会话都没有
    await sidebar.setGroupExpanded({ project: ZETA_PROJ }, true)
    expect(await sidebar.groupRows({ project: ZETA_PROJ })).toEqual([])
  })

  it('BD-4 关掉位置选择什么都不建；组头 ⋮ →「新对话」弹的是同一份位置选择（第二层菜单），选了照样建在那里', async () => {
    writeBotMd(app, 'gamma', { displayName: 'Gamma Prime' })
    await refreshUntilGroup('gamma')

    const before = await listSessionIds(app.main)
    const cancelled = await bots.openPicker('gamma', null, 'new-chat-row')
    expect(idsOf(cancelled)).toContain('temp')
    // 取消不能有副作用：留一段落定窗口再比会话集合
    await sleep(500)
    expect([...(await listSessionIds(app.main))].sort()).toEqual([...before].sort())

    const alphaId = projectIds[ALPHA_PROJ]
    const picked: { menu: MenuItemShot[]; picker: MenuItemShot[] } = { menu: [], picker: [] }
    const fresh = await newSessionsAfter(app.main, async () => {
      Object.assign(picked, await bots.pickerViaMenu('gamma', `project:${alphaId}`))
    })
    expect(idsOf(picked.menu)).toEqual(['new-bot-chat', 'edit-bot', 'sep', 'archive-bot'])
    // 第二层与「+」弹的是同一份：逐项（含 label）都一样
    expect(picked.picker).toEqual(cancelled)
    await sleep(500)
    const added = (await listSessionIds(app.main)).filter((id) => !before.includes(id))
    expect(added).toEqual(fresh)
    expect(added).toHaveLength(1)
    const session = await getSession(added[0])
    expect(session).toMatchObject({
      projectId: null,
      settings: { bot: 'gamma', workProject: alphaId }
    })
    await waitChip('gamma', 'project')
  })
})
