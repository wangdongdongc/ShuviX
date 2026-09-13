/**
 * 「新建 Bot 会话」单选框（BD-1…4）—— 组头菜单 `new-bot-chat` → BotSessionDialog → 点一行即建。
 *
 * 断言口径：
 *   - 「建了几条、绑的是谁、归哪个项目」全走 IPC（session.list / getById）；DOM 只断呈现 ——
 *     单选框的行对得上 `bot.list()` 的合法 bot、头部胶囊出现、新行落在哪一组且是活动行。
 *   - 活动会话**没有 IPC** 可读：「新建的这条成了活动会话」由两半拼成 —— 头部胶囊绑的是这个
 *     bot，且 IPC 里绑这个 bot 的会话只有这一条。
 *   - picker 建出来的会话一律是本地化的默认标题（彼此同名）：标题只从 IPC 读、从不写死；按标题
 *     全局定位会串到别的组，故行一律按组取（`sidebarPane.groupRows`）。
 *
 * 顺序约束：BD-1 必须跑在任何合法 bot md 落盘之前（它要的是「目录里只有一份坏文件」），
 * 故 beforeAll 一个合法 bot 都不种，每条用例现种自己用的那一个。
 *
 * ⚠️ 空态里的「打开 Bots 文件夹」只做存在性断言，绝不点：它开的是 OS 文件管理器，e2e 关不掉。
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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
  botPickerPane,
  sidebarPane,
  type BotChipPane,
  type BotPickerPane,
  type SidebarPane
} from '../../harness/pages'

/** 让临时组出现的那条会话（临时组只在有临时会话时才渲染） */
const TEMP_SEED = 'BD-temp-seed'
/** 两个项目：名字与任何 bot 的 name / displayName / description 都不重叠（BD-3 要断框里有谁没谁） */
const ALPHA_PROJ = 'BD-Alpha-Proj'
const ZETA_PROJ = 'BD-Zeta-Proj'

/** getById 回来的、这里要断的那几个字段 */
interface SessionShot {
  id: string
  title: string
  projectId: string | null
  parentId: string | null
  settings: { bot?: string }
}

let app: E2EApp
let sidebar: SidebarPane
let picker: BotPickerPane
let chip: BotChipPane
const projectIds: Record<string, string> = {}

const getSession = (sid: string): Promise<SessionShot | null> =>
  app.main.eval<SessionShot | null>(`window.api.session.getById(${JSON.stringify(sid)})`)

/** `bot.list()` 里合法 bot 的名字（排序后） */
const validBotNames = async (): Promise<string[]> =>
  (
    await app.main.eval<string[]>(`window.api.bot.list().then((r) => r.bots.map((b) => b.name))`)
  ).sort()

/** 等单选框的候选行加载出来（加载占位也是零行，故「有行」才算落定），回排序后的名字 */
const loadedPickerRows = async (): Promise<string[]> => {
  const rows = await until(async () => {
    const names = await picker.rows()
    return names.length > 0 ? names : null
  }, 'bot picker rows loaded')
  return [...rows].sort()
}

/** 等头部胶囊绑到某个 bot（bot 名在属性上，查询回来之前就认得出） */
const waitChipBoundTo = (bot: string): Promise<boolean> =>
  until(async () => (await chip.snapshot()).bot === bot, `header chip bound to "${bot}"`)

beforeAll(async () => {
  app = await launchApp()
  await waitRendererReady(app.main)
  sidebar = sidebarPane(app.main)
  picker = botPickerPane(app.main)
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
  it('BD-1 目录里只有一份坏文件：单选框零行但带出路，Escape 关掉且什么都不建', async () => {
    writeBotMd(app, 'stray', { marker: 'agent v1' })
    const registry = await app.main.eval<{
      bots: Array<{ name: string }>
      invalid: Array<{ fileName: string }>
    }>(`window.api.bot.list()`)
    expect(registry.bots).toEqual([])
    expect(registry.invalid.map((f) => f.fileName)).toContain('stray.md')

    const before = await listSessionIds(app.main)
    await sidebar.pickGroupMenu('temp', 'new-bot-chat')
    await picker.waitOpen()
    // 加载占位同样是零行：「零行」只在空态的出路（打开文件夹按钮）上屏之后才算数
    await until(
      () => picker.emptyStateShown(),
      'bot picker empty state with the open-folder way out'
    )
    expect(await picker.rows()).toEqual([])

    await picker.pressEscape()
    await picker.waitClosed()
    // 取消不能有副作用：留一段落定窗口再比会话集合
    await sleep(500)
    expect([...(await listSessionIds(app.main))].sort()).toEqual([...before].sort())
  })
})

describe('选一个 bot 即建会话', () => {
  it('BD-2 从临时组选：恰好建一条、绑的是它、不属于任何项目也不是子会话，并成为活动会话', async () => {
    writeBotMd(app, 'alpha', { displayName: 'Alpha Prime', description: 'BD alpha bot' })
    expect((await chip.snapshot()).count).toBe(0)

    // 会话集合在打开菜单之前就记下：连「开框本身建了会话」也算进来
    const fresh = await newSessionsAfter(app.main, async () => {
      await sidebar.pickGroupMenu('temp', 'new-bot-chat')
      await picker.waitOpen()
      const candidates = await loadedPickerRows()
      // 候选行 = 合法 bot；坏文件进不来
      expect(candidates).toEqual(await validBotNames())
      expect(candidates).not.toContain('stray')
      expect(await picker.pick('alpha')).toBe(true)
      await picker.waitClosed()
    })
    expect(fresh).toHaveLength(1)
    const sid = fresh[0]
    const session = await getSession(sid)
    expect(session).not.toBeNull()
    expect(session!.settings.bot).toBe('alpha')
    expect(session!.projectId).toBeNull()
    expect(session!.parentId).toBeNull()

    // 活动会话没有 IPC：胶囊绑的是 alpha + 绑 alpha 的会话只有这一条 ⇒ 活动的正是新建的这条
    await waitChipBoundTo('alpha')
    expect(await sessionsBoundTo(app.main, 'alpha')).toEqual([sid])

    // 新行落在临时组、是活动行、行首是 bot 身份图标；标题取 IPC（本地化默认标题，不写死）
    const active = await until(
      async () => (await sidebar.groupRows('temp')).find((r) => r.active) ?? null,
      'active row in the temp group'
    )
    expect(active.title).toBe(session!.title)
    expect(active.icon).toBe('bot')
  })

  it('BD-3 从项目组选：会话归这个项目，折叠着的组随之展开', async () => {
    writeBotMd(app, 'beta', { displayName: 'Beta Prime' })
    // 「首次加载默认折叠」只作用于第一批非空项目列表 —— 两个项目未必同批到达，故显式折上
    await sidebar.setGroupExpanded({ project: ZETA_PROJ }, false)
    expect(await sidebar.groupExpanded({ project: ZETA_PROJ })).toBe(false)

    const fresh = await newSessionsAfter(app.main, async () => {
      await sidebar.pickGroupMenu({ project: ZETA_PROJ }, 'new-bot-chat')
      await picker.waitOpen()
      const candidates = await loadedPickerRows()
      // 归属行写的是发起分组的项目（项目名是种子数据；其余文案本地化，不断）
      const text = await picker.text()
      expect(text).toContain(ZETA_PROJ)
      expect(text).not.toContain(ALPHA_PROJ)
      expect(candidates).toEqual(await validBotNames())
      expect(await picker.pick('beta')).toBe(true)
      await picker.waitClosed()
    })
    expect(fresh).toHaveLength(1)
    const sid = fresh[0]
    const session = await getSession(sid)
    expect(session).not.toBeNull()
    expect(session!.projectId).toBe(projectIds[ZETA_PROJ])
    expect(session!.settings.bot).toBe('beta')

    await until(
      () => sidebar.groupExpanded({ project: ZETA_PROJ }),
      'Zeta group expanded after the pick'
    )
    // 与 BD-2 那条同为默认标题：只在 Zeta 组的正文里找，绝不按标题全局定位
    const rows = await until(async () => {
      const inGroup = await sidebar.groupRows({ project: ZETA_PROJ })
      return inGroup.length > 0 ? inGroup : null
    }, 'a row in the Zeta group')
    expect(rows).toEqual([{ title: session!.title, active: true, icon: 'bot' }])

    await waitChipBoundTo('beta')
    expect(await sessionsBoundTo(app.main, 'beta')).toEqual([sid])
  })

  it('BD-4 同一刻连点两下同一行：只建一条', async () => {
    writeBotMd(app, 'gamma', { displayName: 'Gamma Prime' })
    const before = await listSessionIds(app.main)

    await sidebar.pickGroupMenu('temp', 'new-bot-chat')
    await picker.waitOpen()
    await until(async () => (await picker.rows()).includes('gamma'), 'gamma row in the picker')
    // 两下在同一次 eval 里：分两次的话 React 已在其间把按钮置灰，第二下根本不派发，
    // 这条就会在没有防重入守卫时也通过
    const taps = await picker.pickTwiceSync('gamma')
    expect(taps.found).toBe(true)
    // 前提：第二下点出去时按钮还没置灰 —— 否则挡住它的是 disabled，测到的就不是防重入守卫
    expect(taps.secondClickLive).toBe(true)
    await picker.waitClosed()
    // 给迟到的第二条留出冒出来的时间
    await sleep(1000)

    const added = (await listSessionIds(app.main)).filter((id) => !before.includes(id))
    expect(added).toHaveLength(1)
    expect(await sessionsBoundTo(app.main, 'gamma')).toEqual(added)
    await waitChipBoundTo('gamma')
  })
})
