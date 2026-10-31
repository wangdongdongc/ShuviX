/**
 * bot 会话只归属 bot（2026-10-31）—— 工作位置是引用，不是成员；bot 的去留连着它的会话（E-1…3）。
 *
 *   E-1 位置选择 → 引用：bot 组的「+」弹「在哪里工作？」，选项目建出来的会话 `projectId` 为 null、
 *       `settings.workProject` = 项目 id、工作目录 = 项目根（`getById().workingDirectory` 与会话权限表的
 *       `workdir` 可写行都是它）；行在 bot 组里、行尾标项目名，不进项目组；头部位置胶囊 `project`。再选「临时」：
 *       没有引用、工作目录是自己的临时工作区，行尾标「临时」，胶囊 `temp`。
 *   E-2 删项目：成员会话连同它的对话文件（`sessions/<id>.sqlite`）与 `tool_results/<id>` 一起删掉；引用它的 bot 会话
 *       留着，工作目录退回建会话时记下的路径快照，行尾与胶囊都说「项目已删除」（胶囊 `gone`）；项目知识库目录不动。
 *   E-3 归档 → 藏起来 → 恢复 → 连同会话删除：归档的 bot 整组（连同会话、子会话）离开侧栏，也不当成「找不到文件」；
 *       设置 → 已归档 → Bots 列出它与它的会话数，恢复回到原样；再归档、在那里删（确认框）→ 文件与它名下的会话
 *       （含子会话）都没了。另一个 bot 的文件在 ShuviX 之外被删 → 它的会话成「找不到文件」的一组，组头菜单
 *       「删除这些会话」→ 确认 → 会话没了、组也没了。
 *
 * 迁移 v37（升级时把挂在项目里的 bot 会话挪成引用、标出触发器的运行会话）在 bot-workspace-migration.e2e.ts。
 *
 * 断言口径：数据走 IPC 与磁盘；DOM 只经 pages.ts（botsPane / sidebarPane / botChip / archivedSettingsPane /
 * confirmPane）。⚠️ 位置选择的「打开文件夹…」与位置胶囊（点它开访达）都绝不点。全程无 LLM（E-2 的那一轮提示词
 * 在隔离实例里没有提供商，用户条目落树之后就失败 —— 要的只是它的对话文件）。
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import ja from '@shuvix/chat-protocol/i18n/locales/ja.json'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import { sleep, until, type CdpClient } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import {
  createProject,
  durableStoragePathOf,
  newSessionsAfter,
  promptAndListMessages,
  seedProjectKnowledgeBase,
  sessionsBoundTo,
  waitRendererReady,
  writeBotMd
} from '../../harness/seed'
import {
  archivedSettingsPane,
  botChip,
  botsPane,
  confirmPane,
  sidebarPane,
  type BotChipSnapshot,
  type BotsPane,
  type MenuItemShot,
  type SidebarPane
} from '../../harness/pages'

const L = [en, zh, ja]
const TEMP_LABELS = L.map((l) => l.sidebar.botTempLocation)
const GONE_LABELS = L.map((l) => l.sidebar.botProjectGone)
const SUB_TAB_BOTS = L.map((l) => l.settings.archivedSubTabBots)

const WORK_PROJ = 'BW-Work-Proj'
const DOOMED_PROJ = 'BW-Doomed-Proj'

interface SessionShot {
  id: string
  title: string
  projectId: string | null
  parentId: string | null
  workingDirectory?: string | null
  settings: { bot?: string; workProject?: string; workingDirectory?: string; triggerRun?: boolean }
}

interface AclRow {
  kind: string
  source: string
  sourceKey: string
  target: string
  access: string
}

let app: E2EApp
let sidebar: SidebarPane
let bots: BotsPane
const projects: Record<string, { id: string; dir: string }> = {}

const getSession = (sid: string): Promise<SessionShot | null> =>
  app.main.eval<SessionShot | null>(`window.api.session.getById(${JSON.stringify(sid)})`)
const aclOf = (sid: string): Promise<AclRow[]> =>
  app.main.eval<AclRow[]>(`window.api.session.listAcl(${JSON.stringify(sid)})`)
const createSession = (params: Record<string, unknown>): Promise<string> =>
  app.main.eval<string>(`window.api.session.create(${JSON.stringify(params)}).then((s) => s.id)`)
const idsOf = (items: MenuItemShot[]): string[] => items.map((it) => it.id ?? 'sep')
const real = (p: string): string => realpathSync(p)

/** 等头部胶囊绑到 `bot`、位置胶囊落定到 `location` */
const waitChip = (bot: string, location: string): Promise<BotChipSnapshot> =>
  until(async () => {
    const shot = await botChip(app.main).snapshot()
    return shot.bot === bot && shot.location === location ? shot : null
  }, `header chip on "${bot}" working in ${location}`)

/** 某个 bot 组里标题为 title 的那一行 */
const rowIn = async (
  bot: string,
  title: string
): Promise<Awaited<ReturnType<BotsPane['groupSessions']>>[number] | undefined> =>
  (await bots.groupSessions(bot)).find((r) => r.title === title)

beforeAll(async () => {
  app = await launchApp()
  await waitRendererReady(app.main)
  sidebar = sidebarPane(app.main)
  bots = botsPane(app.main)

  for (const [name, dir] of [
    [WORK_PROJ, 'proj-bw-work'],
    [DOOMED_PROJ, 'proj-bw-doomed']
  ] as const) {
    const path = join(app.home, dir)
    mkdirSync(path, { recursive: true })
    projects[name] = { id: (await createProject(app.main, { name, path })).id, dir: path }
  }
  writeBotMd(app, 'worker', { displayName: 'Worker' })
  writeBotMd(app, 'keeper', { displayName: 'Keeper' })
  writeBotMd(app, 'orphan', { displayName: 'Orphan' })

  await until(
    async () => (await sidebar.groupAffordances({ project: WORK_PROJ })) !== null,
    'project group headers rendered'
  )
  // 分节一挂上就扫了（那时 md 都还没落盘）—— 磁盘外写入不广播 bot.changed，刷新一次
  await bots.refresh()
  for (const name of ['worker', 'keeper', 'orphan']) await bots.waitGroup(name)
}, 120_000)

afterAll(async () => {
  await app?.stop()
})

describe('E-1 位置选择 → 引用', () => {
  it('E-1 选项目：不是成员、引用 + 项目根工作目录（权限表 workdir 行同一个）、行在 bot 组里标项目名、胶囊 project；再选临时：没有引用、临时工作区、标「临时」、胶囊 temp', async () => {
    const work = projects[WORK_PROJ]
    let items: MenuItemShot[] = []
    const [sid] = await newSessionsAfter(app.main, async () => {
      items = await bots.openPicker('worker', `project:${work.id}`)
    })

    // 位置选择：置灰的标题项 → 两个项目（不足 8 个，都在第一层）→ 分隔 → 打开文件夹 → 临时
    expect(items[0]).toMatchObject({ id: 'where', enabled: false })
    expect(idsOf(items).slice(3)).toEqual(['sep', 'open-folder', 'temp'])
    expect(new Set(idsOf(items).slice(1, 3))).toEqual(
      new Set([`project:${work.id}`, `project:${projects[DOOMED_PROJ].id}`])
    )
    expect(idsOf(items)).not.toContain('more-projects')

    const session = (await getSession(sid))!
    expect(session).toMatchObject({ projectId: null, parentId: null })
    expect(session.settings.bot).toBe('worker')
    expect(session.settings.workProject).toBe(work.id)
    expect(real(session.workingDirectory!)).toBe(real(work.dir))
    const workdirRows = (await aclOf(sid)).filter((r) => r.source === 'workdir')
    expect(workdirRows).toHaveLength(1)
    expect(workdirRows[0]).toMatchObject({ kind: 'path', access: 'write' })
    expect(real(workdirRows[0].target)).toBe(real(work.dir))

    const row = await until(() => rowIn('worker', session.title), 'the new row in the worker group')
    expect(row).toMatchObject({ location: WORK_PROJ, active: true, sub: false })
    // 引用不是成员：项目组里没有它
    await sidebar.setGroupExpanded({ project: WORK_PROJ }, true)
    expect((await sidebar.groupRows({ project: WORK_PROJ })).map((r) => r.title)).not.toContain(
      session.title
    )
    const chip = await waitChip('worker', 'project')
    expect(chip.locationText).toBe(WORK_PROJ)

    // 再开一条「临时」的
    const [tempSid] = await newSessionsAfter(app.main, async () => {
      await bots.openPicker('worker', 'temp')
    })
    const temp = (await getSession(tempSid))!
    expect(temp.projectId).toBeNull()
    expect(temp.settings.workProject).toBeUndefined()
    expect(real(temp.workingDirectory!)).toBe(real(join(app.userData, 'temp_workspace', tempSid)))
    const tempChip = await waitChip('worker', 'temp')
    expect(TEMP_LABELS).toContain(tempChip.locationText)
    // 两条都是本地化的默认标题：按位置分辨 —— 一条标项目名、一条标「临时」，活动的是刚建的临时那条
    const rows = await until(async () => {
      const r = await bots.groupSessions('worker')
      return r.length === 2 ? r : null
    }, 'two rows in the worker group')
    expect(rows.filter((r) => r.location === WORK_PROJ)).toHaveLength(1)
    const tempRows = rows.filter((r) => TEMP_LABELS.includes(r.location))
    expect(tempRows).toHaveLength(1)
    expect(tempRows[0]).toMatchObject({ title: temp.title, active: true })
  })
})

describe('E-2 删项目', () => {
  it('E-2 成员会话连同对话文件与 tool_results 一起删；引用它的 bot 会话留下、退回路径快照、标「项目已删除」（胶囊 gone）；项目知识库目录不动', async () => {
    const doomed = projects[DOOMED_PROJ]
    const memberSid = await createSession({ title: 'BW-member', projectId: doomed.id })
    const messages = await promptAndListMessages(app.main, memberSid, 'BW member hello')
    expect(messages.length, 'precondition: the member session has its own storage').toBeGreaterThan(
      0
    )
    const storage = durableStoragePathOf(app.home, memberSid)
    await until(() => existsSync(storage), 'member storage file on disk')
    const toolResults = join(app.userData, 'tool_results', memberSid)
    mkdirSync(toolResults, { recursive: true })
    writeFileSync(join(toolResults, 'call_bw.txt'), 'spilled output\n')
    const kbDir = seedProjectKnowledgeBase(app, doomed.id, [
      { path: 'notes/keep.md', title: 'Keep me' }
    ])
    const kbFile = join(kbDir, 'notes', 'keep.md')
    const kbText = readFileSync(kbFile, 'utf8')

    const botSid = await createSession({
      title: 'BW-bot-doomed',
      bot: 'worker',
      workProject: doomed.id
    })
    expect((await getSession(botSid))!.settings.workProject).toBe(doomed.id)
    await until(
      async () => (await rowIn('worker', 'BW-bot-doomed'))?.location === DOOMED_PROJ,
      'the bot row labelled with the project name'
    )

    expect(
      await app.main.eval<{ success: boolean }>(
        `window.api.project.delete(${JSON.stringify({ id: doomed.id })})`
      )
    ).toEqual({ success: true })

    // 成员：行、对话文件、工具大结果目录都没了
    await until(async () => (await getSession(memberSid)) === null, 'member session deleted')
    await until(() => !existsSync(storage), 'member storage file removed')
    expect(existsSync(toolResults)).toBe(false)

    // 引用它的 bot 会话：留着，工作目录是路径快照
    const kept = (await getSession(botSid))!
    expect(kept).not.toBeNull()
    expect(kept.projectId).toBeNull()
    expect(kept.settings.bot).toBe('worker')
    expect(real(kept.workingDirectory!)).toBe(real(doomed.dir))
    await until(
      async () => GONE_LABELS.includes((await rowIn('worker', 'BW-bot-doomed'))?.location ?? ''),
      'the bot row labelled "project deleted"'
    )
    expect(await sidebar.openSession('BW-bot-doomed')).toBe(true)
    const chip = await waitChip('worker', 'gone')
    expect(GONE_LABELS.some((l) => chip.locationText.startsWith(l))).toBe(true)
    expect(chip.locationText).toContain(basename(doomed.dir))

    // 项目知识库是用户写下的条目：不删
    expect(readFileSync(kbFile, 'utf8')).toBe(kbText)
  })
})

describe('E-3 归档 / 恢复 / 删除', () => {
  let keeperSid = ''
  let keeperChildSid = ''
  let settings: CdpClient | null = null

  afterAll(() => {
    settings?.close()
  })

  it('E-3a 归档：keeper 整组（连同会话与子会话）离开侧栏，也不成「找不到文件」的组；文件挪进 archived/', async () => {
    keeperSid = await createSession({ title: 'BW-keeper', bot: 'keeper' })
    await until(async () => (await sidebar.titles()).includes('BW-keeper'), 'keeper session listed')
    keeperChildSid = await createSession({ title: 'BW-keeper-child', parentId: keeperSid })
    await until(
      async () => (await sidebar.subTitles()).includes('BW-keeper-child'),
      'keeper child listed under its parent'
    )
    expect((await bots.groupSessions('keeper')).map((r) => r.title)).toEqual([
      'BW-keeper',
      'BW-keeper-child'
    ])

    await bots.pickGroupMenu('keeper', 'archive-bot')
    await until(
      () => existsSync(join(app.botsDir, 'archived', 'keeper.md')),
      'keeper.md moved to archived/'
    )
    expect(existsSync(join(app.botsDir, 'keeper.md'))).toBe(false)
    await bots.waitGroupGone('keeper')
    await until(async () => {
      const titles = await sidebar.titles()
      return !titles.includes('BW-keeper') && !titles.includes('BW-keeper-child')
    }, 'keeper rows gone from the sidebar')
    expect(await bots.missingGroups()).not.toContain('keeper')
    // 会话本身还在（只是藏起来）
    expect(await getSession(keeperSid)).not.toBeNull()
    expect(await getSession(keeperChildSid)).not.toBeNull()
    expect(
      await app.main.eval<string[]>(`window.api.bot.list().then((r) => r.archived)`)
    ).toContain('keeper')
  })

  it('E-3b 设置 → 已归档 → Bots 列出 keeper 与它的会话数；恢复：组与会话回到侧栏，列表空了', async () => {
    settings = await app.openSettings('archived')
    const archived = archivedSettingsPane(settings)
    await until(() => archived.tabBar(), 'the archived page tab bar')
    await archived.selectSubTab(SUB_TAB_BOTS)
    const listed = await until(async () => {
      const rows = await archived.archivedBots()
      return rows.length > 0 ? rows : null
    }, 'archived bot rows')
    expect(listed.map((r) => r.fileName)).toEqual(['keeper.md'])
    expect(listed[0].displayName).toBe('Keeper')
    // 「N 个对话 · <文件名>」：只数顶层会话（子会话随父会话）
    expect(listed[0].detail).toContain('keeper.md')
    expect(listed[0].detail).toContain('1')
    expect(
      await app.main.eval<Array<{ fileName: string; sessionCount: number }>>(
        `window.api.bot.listArchived()`
      )
    ).toEqual([expect.objectContaining({ fileName: 'keeper.md', sessionCount: 1 })])

    await archived.clickArchivedBot('keeper.md', 'restore')
    await until(async () => (await archived.archivedBots()).length === 0, 'archived bots emptied')
    expect(existsSync(join(app.botsDir, 'keeper.md'))).toBe(true)
    await bots.waitGroup('keeper')
    await until(
      async () =>
        (await bots.groupSessions('keeper')).map((r) => r.title).join() ===
        'BW-keeper,BW-keeper-child',
      'keeper rows back in its group'
    )
  })

  it('E-3c 再归档、在已归档里删（确认框）：文件没了，keeper 名下的会话（含子会话）一条不剩', async () => {
    expect(
      await app.main.eval<{ success: boolean }>(`window.api.bot.archive({ name: 'keeper' })`)
    ).toEqual({ success: true })
    await bots.waitGroupGone('keeper')

    const archived = archivedSettingsPane(settings!)
    await until(
      async () => (await archived.archivedBots()).some((r) => r.fileName === 'keeper.md'),
      'keeper back in the archived list'
    )
    await archived.clickArchivedBot('keeper.md', 'delete')
    const confirm = confirmPane(settings!)
    await confirm.waitOpen()
    // 确认框说清会删几条（顶层会话数）
    expect((await confirm.snapshot()).description).toContain('1')
    await confirm.confirm()

    await until(async () => (await getSession(keeperSid)) === null, 'keeper session deleted')
    expect(await getSession(keeperChildSid)).toBeNull()
    expect(await sessionsBoundTo(app.main, 'keeper')).toEqual([])
    expect(existsSync(join(app.botsDir, 'archived', 'keeper.md'))).toBe(false)
    await until(async () => (await archived.archivedBots()).length === 0, 'archived list empty')
    expect(await bots.missingGroups()).not.toContain('keeper')
  })

  it('E-3d 文件在 ShuviX 之外被删：会话成「找不到文件」的一组（不是生效的组），组头菜单只有「删除这些会话」→ 确认 → 会话与组都没了', async () => {
    const orphanSid = await createSession({ title: 'BW-orphan', bot: 'orphan' })
    await until(async () => (await rowIn('orphan', 'BW-orphan')) !== undefined, 'orphan row')

    rmSync(join(app.botsDir, 'orphan.md'))
    await bots.refresh()
    await until(async () => (await bots.missingGroups()).includes('orphan'), 'orphan missing group')
    expect(await bots.groups()).not.toContain('orphan')
    expect((await bots.missingGroupSessions('orphan')).map((r) => r.title)).toEqual(['BW-orphan'])
    expect(await bots.missingGroupMenuIds('orphan')).toEqual(['delete-sessions'])

    await bots.pickMissingGroupMenu('orphan', 'delete-sessions')
    const confirm = confirmPane(app.main)
    await confirm.waitOpen()
    await confirm.confirm()

    await until(async () => (await getSession(orphanSid)) === null, 'orphan session deleted')
    await until(async () => !(await bots.missingGroups()).includes('orphan'), 'missing group gone')
    await sleep(300)
    expect(await sidebar.titles()).not.toContain('BW-orphan')
  })
})
