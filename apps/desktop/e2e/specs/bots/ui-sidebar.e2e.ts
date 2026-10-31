/**
 * 侧栏「Bots」分节（UI 冒烟）。
 *
 * 分节读 `~/.shuvix/bots/`：一个合法 bot 一组（2026-10-31 起 bot 会话只归属 bot，收在各自的组里），解析不过的
 * 文件以琥珀行呈现、排在所有组之后；组头菜单「编辑 bot」（与点琥珀行一样）打开 / 复用那份文件的**笔记本会话**
 * （隐藏项目 `__bots__`，一份文件至多一条）—— 主区就是普通笔记本，没有专门的档案页。资料库里不再有 Bots 分组：
 * UI-1 钉的就是「侧栏里只有一个 Bots 分节，标签里也没有『旧 / legacy』残留」—— 而且一条会话、一个项目都还没有的
 * 侧栏里它也在（资料库里那一组以前恒在；bot 文件落了盘，就该有地方开它）。经笔记本改名 / 写入回执 / 新建归档
 * 见 bot-notes.e2e.ts。
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { sleep, until } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import {
  REGISTRY_NOTE_PROJECT_IDS,
  registryNoteSessions,
  writeBotMd,
  waitRendererReady
} from '../../harness/seed'
import {
  botsPane,
  registryNotePane,
  sidebarOutline,
  sidebarPane,
  type BotsPane,
  type RegistryNotePane
} from '../../harness/pages'

const BOTS_PROJECT = REGISTRY_NOTE_PROJECT_IDS.bot

let app: E2EApp
let bots: BotsPane
let note: RegistryNotePane
/** UI-3 打开的 scout.md 笔记本会话 —— UI-5 钉「反复点开复用的是同一条」 */
let scoutNoteId = ''

beforeAll(async () => {
  app = await launchApp()
  await waitRendererReady(app.main)
  writeBotMd(app, 'scout', { displayName: 'Scout', body: 'I am Scout.' })
  bots = botsPane(app.main)
  note = registryNotePane(app.main)
}, 120_000)

afterAll(async () => {
  await app?.stop()
})

describe('还没有任何会话与项目', () => {
  it('UI-1 侧栏只有一个 Bots 分节（资料库里没有 Bots 分组），标签不带「旧 / legacy」；空侧栏里它照样在、scout 一组', async () => {
    await until(
      async () => (await bots.sectionCount()) === 1,
      'a Bots section in a sidebar with no session and no project',
      10_000
    )
    // 分节一挂上就扫了 —— 那时 scout.md 还没落盘：刷新一次
    await bots.refresh()
    await bots.waitScanned()
    expect(await bots.sectionCount()).toBe(1)
    const label = await bots.sectionLabel()
    expect(label).toBeTruthy()
    expect(label).not.toMatch(/旧|legacy/i)
    const outline = await sidebarOutline(app.main)
    expect(outline).not.toContain('bots')
    expect(outline.filter((g) => g === 'bots-section')).toHaveLength(1)
    await bots.waitGroup('scout')
  })
})

describe('分节', () => {
  beforeAll(async () => {
    // 之后的用例不靠「空侧栏」：一条普通会话 + 一个项目让会话列表照常渲染（UI-1 失败时它们照样跑）
    const projDir = join(app.home, 'proj-ui-sidebar')
    mkdirSync(projDir, { recursive: true })
    await app.main.eval(
      `window.api.project.create(${JSON.stringify({ name: 'UI-Proj', path: projDir })})`
    )
    await app.main.eval(`window.api.session.create({ title: 'ui-control-session' })`)
    const sidebar = sidebarPane(app.main)
    await until(
      async () => (await sidebar.titles()).includes('ui-control-session'),
      'control session listed in the sidebar'
    )
    await bots.refresh()
  })

  it('UI-2 读 ~/.shuvix/bots：一个合法 bot 一组，组头是显示名、缺省折叠；分节菜单是新建 bot / 打开文件夹 / 刷新', async () => {
    await bots.waitGroup('scout')
    expect(await bots.groups()).toEqual(['scout'])
    expect(await bots.groupLabel('scout')).toBe('Scout')
    expect(await bots.groupExpanded('scout')).toBe(false)
    expect(await bots.sectionMenuIds()).toEqual(['new-bot', 'open-folder', 'refresh'])
  })
})

describe('编辑 bot 开笔记本', () => {
  it('UI-3 组头菜单「编辑 bot」→ 那份文件的笔记本会话（隐藏项目 __bots__，不进项目列表也不进侧栏会话列表）', async () => {
    await bots.pickGroupMenu('scout', 'edit-bot')

    // 主区就是笔记本：正文 + bot 属性卡
    await note.waitBody('I am Scout.')
    await note.waitCard()
    expect(await note.cardBadge()).toBe('ShuviX bot · v2')

    // 一份文件一条会话：挂在隐藏项目下，notebookPath 是文件名，标题取显示名
    const notes = await registryNoteSessions(app.main, BOTS_PROJECT)
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatchObject({ notebookPath: 'scout.md', title: 'Scout' })
    scoutNoteId = notes[0].id

    // 载体项目：path = bots 目录本身，项目列表过滤掉它
    const projectIds = await app.main.eval<string[]>(
      `window.api.project.list().then((ps) => ps.map((p) => p.id))`
    )
    expect(projectIds).not.toContain(BOTS_PROJECT)
    const carrier = await app.main.eval<{ path: string } | null>(
      `window.api.project.getById(${JSON.stringify(BOTS_PROJECT)})`
    )
    expect(carrier?.path).toBe(app.botsDir)

    // 侧栏会话列表里没有它（对照会话 ui-control-session 在列表里，「列表为空」不会让否定断言空转）
    const sidebar = sidebarPane(app.main)
    expect(await sidebar.titles()).toContain('ui-control-session')
    expect(await sidebar.titles()).not.toContain('Scout')
    // bot 组里也没有它：笔记本不是和 bot 的对话
    expect(await bots.groupSessions('scout')).toEqual([])
  })

  it('UI-4 解析不过的文件以琥珀行呈现（排在所有组之后）；点它照样打开自己的笔记本（按文件名建会话）', async () => {
    // 一份 agent md 掉进 bots 目录 —— 标记类型不符，整份拒绝
    writeBotMd(app, 'stray', { marker: 'agent v1' })
    await bots.refresh()
    await until(async () => (await bots.invalidRows()).includes('stray.md'), 'amber stray row')
    expect(await bots.groups()).not.toContain('stray')

    await bots.selectInvalidRow('stray.md')
    await note.waitBody('BOT BODY.')
    expect(await bots.activeFileRow()).toEqual({ invalidRow: 'stray.md' })

    const notes = await registryNoteSessions(app.main, BOTS_PROJECT)
    expect(notes).toHaveLength(2)
    // 解析不出显示名：标题退回文件名去后缀
    expect(notes.find((n) => n.notebookPath === 'stray.md')).toMatchObject({ title: 'stray' })
  })

  it('UI-5 同一份文件反复打开复用同一条会话；正开着时再「编辑 bot」也不新建', async () => {
    await bots.pickGroupMenu('scout', 'edit-bot')
    await note.waitBody('I am Scout.')
    await bots.selectInvalidRow('stray.md')
    await note.waitBody('BOT BODY.')
    await bots.pickGroupMenu('scout', 'edit-bot')
    await note.waitBody('I am Scout.')

    const notes = await registryNoteSessions(app.main, BOTS_PROJECT)
    expect(notes.filter((n) => n.notebookPath === 'scout.md').map((n) => n.id)).toEqual([
      scoutNoteId
    ])
    // 琥珀行不再是活动行：活动的是 scout.md 的笔记本
    expect(await bots.activeFileRow()).toBeNull()

    // 正开着它：再来一次（main 侧按文件名去重）
    await bots.pickGroupMenu('scout', 'edit-bot')
    await sleep(500)
    expect(await registryNoteSessions(app.main, BOTS_PROJECT)).toHaveLength(notes.length)
    expect(await note.bodyText()).toContain('I am Scout.')
  })
})
