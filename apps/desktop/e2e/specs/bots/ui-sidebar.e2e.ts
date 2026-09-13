/**
 * 侧栏「Bots」分组（UI 冒烟）。
 *
 * 分组读 `~/.shuvix/bots/`：合法 bot 一行一个，解析不过的文件以琥珀行呈现；点任一行打开 / 复用
 * 那份文件的**笔记本会话**（隐藏项目 `__bots__`，一份文件至多一条）—— 主区就是普通笔记本，
 * 不再有专门的档案页。旧 Bots 拆除之后侧栏只剩这一个 Bots 分组 —— UI-1 钉的就是「没有第二个，
 * 标签里也没有「旧 / legacy」残留」。经笔记本改名 / 写入回执 / 新建删除见 bot-notes.e2e.ts。
 */
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

describe('分组', () => {
  it('UI-1 侧栏只有一个 Bots 分组，标签不带「旧 / legacy」', async () => {
    await bots.expand()
    expect(await bots.headerCount()).toBe(1)
    const label = await bots.label()
    expect(label).toBeTruthy()
    expect(label).not.toMatch(/旧|legacy/i)
  })

  it('UI-2 读 ~/.shuvix/bots：合法 bot 一行一个', async () => {
    await bots.expand()
    expect(await bots.rows()).toEqual(['scout'])
  })
})

describe('点一行开笔记本', () => {
  it('UI-3 点 bot 行 → 那份文件的笔记本会话（隐藏项目 __bots__，不进项目列表也不进侧栏会话列表）', async () => {
    await bots.expand()
    await bots.selectRow('scout')

    // 主区就是笔记本：正文 + bot 属性卡
    await note.waitBody('I am Scout.')
    await note.waitCard()
    expect(await note.cardBadge()).toBe('ShuviX bot · v2')
    expect(await bots.activeRow()).toEqual({ row: 'scout' })

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

    // 侧栏会话列表里没有它 —— 先让一条普通会话上屏作对照，免得「列表为空」让否定断言空转
    await app.main.eval(`window.api.session.create({ title: 'ui3-visible-session' })`)
    const sidebar = sidebarPane(app.main)
    await until(
      async () => (await sidebar.titles()).includes('ui3-visible-session'),
      'control session listed in the sidebar'
    )
    expect(await sidebar.titles()).not.toContain('Scout')
  })

  it('UI-4 解析不过的文件以琥珀行呈现；点它照样打开自己的笔记本（按文件名建会话）', async () => {
    // 一份 agent md 掉进 bots 目录 —— 标记类型不符，整份拒绝
    writeBotMd(app, 'stray', { marker: 'agent v1' })
    await bots.expand()
    await bots.refresh()
    expect(await bots.invalidRows()).toContain('stray.md')
    expect(await bots.rows()).not.toContain('stray')

    await bots.selectInvalidRow('stray.md')
    await note.waitBody('BOT BODY.')
    expect(await bots.activeRow()).toEqual({ invalidRow: 'stray.md' })

    const notes = await registryNoteSessions(app.main, BOTS_PROJECT)
    expect(notes).toHaveLength(2)
    // 解析不出显示名：标题退回文件名去后缀
    expect(notes.find((n) => n.notebookPath === 'stray.md')).toMatchObject({ title: 'stray' })
  })

  it('UI-5 同一份文件反复点开复用同一条会话；点已是活动行的那一行不新建', async () => {
    await bots.selectRow('scout')
    await note.waitBody('I am Scout.')
    await bots.selectInvalidRow('stray.md')
    await note.waitBody('BOT BODY.')
    await bots.selectRow('scout')
    await note.waitBody('I am Scout.')

    const notes = await registryNoteSessions(app.main, BOTS_PROJECT)
    expect(notes.filter((n) => n.notebookPath === 'scout.md').map((n) => n.id)).toEqual([
      scoutNoteId
    ])

    // 已是活动行：再点一次（分组直接早退，不去 openNote）
    await bots.selectRow('scout')
    await sleep(500)
    expect(await registryNoteSessions(app.main, BOTS_PROJECT)).toHaveLength(notes.length)
    expect(await bots.activeRow()).toEqual({ row: 'scout' })
  })
})
