/**
 * 随应用提供的日报 bot + 跟踪项（实验）—— 真实例上走一遍：
 *
 *   DT-E1 全新实例：`~/.shuvix/bots/daily.md` 按界面语言写好（`shuvix-id: bot:builtin:daily`），`.builtin-seeded` 记下它，bot.list 认它
 *   DT-E2 设置 → 触发源：不再列订阅者（触发源与 bot 解绑，2026-10-24）—— 日报 bot 的文件还在、bot.list 认它，
 *         但页里既没有订阅者列表，也没有它的显示名与 when；全新实例上它没命中过，触发日志是空态
 *   DT-E3 删掉 daily.md、停机、同一个 HOME 再起：不补写，记录不变
 *   DT-E4 侧栏 Library 的「跟踪项」分组：带实验标签、缺省折叠；目录还没有时展开是空态，展开也不建目录
 *   DT-E5 目录里放几样东西 → 组头菜单「刷新」：只列可见的 .md 文件（新的在前），行字是一级标题 / 文件名
 *   DT-E6 点一行 → 那份文件的笔记本会话（隐藏项目 `__tracking__`）：不进项目列表、侧栏会话列表、日历；再点复用同一条；
 *         属性卡是「Tracked item」，对象 id 是卡上不渲染的已知键
 *   DT-E7 在笔记本里改一级标题 → 自动保存 → 行字跟着变（`tracking.changed`，不用手动刷新）
 *   DT-E8 `tracking.openNote` 只认目录里真实存在的可见 .md：越界 / 非 md / 隐藏 / 不存在 / 子目录都拒，不建会话
 *   DT-E9 行菜单删掉一份正开着、改过且从没提交过的跟踪项：菜单 = [reveal, copy-path, delete]，确认框写着它的标题；
 *         确认后文件没了、跨过自动保存窗口也不被写回，它的笔记本会话删掉、主区离开它，行消失；
 *         目录成了 git 仓库，历史 = [Deleted …, Before deleting …]，父提交里是删前最后那一版
 *
 * 一个 HOME、两次启动（DT-E3 起换成第二个实例）。`launchApp({ builtinBots: true })`：不放「已经写过」的记录，让产品自己写。
 * 「打开文件夹」不点（它开的是 OS 文件管理器）。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import ja from '@shuvix/chat-protocol/i18n/locales/ja.json'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import { sleep, until } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import {
  appEventRecorder,
  listSessionIds,
  registryNoteSessions,
  waitFileWritten,
  waitRendererReady
} from '../../harness/seed'
import {
  confirmPane,
  fmCardRowKeys,
  notebookEditorPane,
  registryNotePane,
  sidebarPane,
  trackingPane,
  triggerSettingsPane
} from '../../harness/pages'

const DAILY_ID = 'bot:builtin:daily'
const DAILY_WHEN = "event.local.time == '18:00' && activeSessions(event.local.date) > 0"
const DAILY_DISPLAY: Record<'zh' | 'en' | 'ja', string> = {
  zh: '日记助手',
  en: 'Diary',
  ja: '日記'
}
const TIMER_ID = 'timer:builtin:minute'
const TRACKING_PROJECT = '__tracking__'
const ALPHA_ID = '0192f0a0-7c1e-7a10-8b2c-3d4e5f6a7b8c'
const CONTROL_TITLE = 'dt6-visible-session'

const LOCALES = [en, zh, ja]
const GROUP_LABELS = LOCALES.map((l) => l.sidebar.trackingGroup)
const LOG_EMPTY = LOCALES.map((l) => l.settings.triggerLogEmpty)
const EMPTY_HINTS = LOCALES.map((l) => l.sidebar.trackingEmpty)

let app: E2EApp
let home = ''
/** 界面语言（渲染端按 navigator.language 取，主进程按 app.getLocale() —— 同一个 Chromium 区域设置） */
let language: 'zh' | 'en' | 'ja' = 'en'
let alphaSessionId = ''

const dailyPath = (): string => join(app.botsDir, 'daily.md')
const markerPath = (): string => join(app.botsDir, '.builtin-seeded')
const trackingDir = (): string => join(app.home, '.shuvix', 'tracking')

const pad = (n: number): string => String(n).padStart(2, '0')
const today = (): string => {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function botList(): Promise<{
  bots: Array<{ name: string }>
  invalid: Array<{ fileName: string }>
}> {
  return app.main.eval(`window.api.bot.list()`)
}

beforeAll(async () => {
  app = await launchApp({ builtinBots: true })
  home = app.home
  await waitRendererReady(app.main)
  const base = (await app.main.eval<string>('navigator.language')).split('-')[0].toLowerCase()
  language = base === 'zh' || base === 'ja' ? base : 'en'
}, 120_000)

afterAll(async () => {
  await app?.stop()
})

describe('随应用提供的日报 bot', () => {
  it('DT-E1 全新实例：daily.md 按界面语言写好，带 shuvix-id；.builtin-seeded 记下它；bot.list 认它', async () => {
    // 写入在 main 启动、开主窗口之前（index.ts 的 seedBuiltinBots），实例交到手上时已经落盘
    expect(existsSync(dailyPath())).toBe(true)
    const content = readFileSync(dailyPath(), 'utf8')
    expect(content.startsWith('---\nshuvix: bot v2\n')).toBe(true)
    expect(content).toMatch(new RegExp(`^shuvix-id: ${DAILY_ID}$`, 'm'))
    expect(content).toMatch(/^name: daily$/m)
    expect(content).toContain(`\nshuvix-displayName: ${DAILY_DISPLAY[language]}\n`)
    expect(content).toContain(`\n    when: ${DAILY_WHEN}\n`)

    expect(readFileSync(markerPath(), 'utf8').split('\n')).toContain('daily')

    const list = await botList()
    expect(list.bots.map((b) => b.name)).toContain('daily')
    expect(list.invalid.map((f) => f.fileName)).not.toContain('daily.md')
  })

  it('DT-E2 设置 → 触发源：不列订阅者（日报 bot 的文件还在）；页里没有它的显示名与 when；触发日志是空态', async () => {
    expect(existsSync(dailyPath())).toBe(true)
    expect((await botList()).bots.map((b) => b.name)).toContain('daily')

    const settings = await app.openSettings('triggers')
    try {
      const triggers = triggerSettingsPane(settings)
      await triggers.waitSource(TIMER_ID)
      const shot = (await triggers.source(TIMER_ID))!
      expect(shot.subscriberList).toBe(false)
      expect(await triggers.anySubscriberList()).toBe(false)

      // 日志拉到了（全新实例：日报只在 18:00 且当天有人写过消息时命中，此刻一条都没有）
      const empty = await until(() => triggers.logEmpty(), 'trigger log empty state')
      expect(LOG_EMPTY).toContain(empty)
      expect(await triggers.logRows()).toEqual([])

      const page = await triggers.pageText()
      expect(page).not.toContain(DAILY_DISPLAY[language])
      expect(page).not.toContain(DAILY_WHEN)
    } finally {
      settings.close()
    }
  })

  it('DT-E3 删掉 daily.md、停机、同一个 HOME 再起：不补写，记录不变', async () => {
    const markerBefore = readFileSync(markerPath(), 'utf8')
    rmSync(dailyPath())
    await app.stop({ keepHome: true })
    app = await launchApp({ home, builtinBots: true })
    await waitRendererReady(app.main)

    // 补写会发生在开主窗口之前：此刻还没有，就不会再有
    expect(existsSync(dailyPath())).toBe(false)
    expect(readFileSync(markerPath(), 'utf8')).toBe(markerBefore)
    expect((await botList()).bots.map((b) => b.name)).not.toContain('daily')
  }, 120_000)
})

describe('侧栏「跟踪项」分组', () => {
  it('DT-E4 带实验标签、缺省折叠；目录还没有时展开是空态，展开也不建目录', async () => {
    const tracking = trackingPane(app.main)
    await until(async () => (await tracking.label()) !== '', 'tracking group header')
    expect(GROUP_LABELS).toContain(await tracking.label())
    expect(await tracking.experimental()).toBe(true)
    expect(await tracking.expanded()).toBe(false)

    await tracking.expand()
    expect(EMPTY_HINTS).toContain(await tracking.emptyHint())
    expect(await tracking.rows()).toEqual([])
    expect(existsSync(trackingDir())).toBe(false)
  })

  it('DT-E5 目录里放几样东西 → 组头菜单「刷新」：只列可见的 .md 文件（新的在前），行字是一级标题 / 文件名', async () => {
    const dir = trackingDir()
    mkdirSync(dir, { recursive: true })
    // 一级标题是最后一行、文件不以换行结尾：DT-E7 在行尾打字改的就是它
    writeFileSync(
      join(dir, 'a.md'),
      `---\nshuvix: track v1\nshuvix-id: ${ALPHA_ID}\n---\n\n# Alpha bug`
    )
    writeFileSync(join(dir, 'b.md'), 'Just a note without a heading.\n')
    writeFileSync(join(dir, '.h.md'), '# Hidden\n')
    writeFileSync(join(dir, 'n.txt'), '# Not markdown\n')
    mkdirSync(join(dir, 'x.md'))
    // 修改时间拉开：b 比 a 新（列表按它倒序）
    const now = Date.now() / 1000
    utimesSync(join(dir, 'a.md'), now - 120, now - 120)
    utimesSync(join(dir, 'b.md'), now - 10, now - 10)

    const tracking = trackingPane(app.main)
    await tracking.expand()
    await tracking.refresh()
    const rows = await until(async () => {
      const r = await tracking.rows()
      return r.length > 0 ? r : null
    }, 'tracking rows after refresh')
    expect(rows).toEqual([
      { fileName: 'b.md', title: 'b' },
      { fileName: 'a.md', title: 'Alpha bug' }
    ])
    expect(await tracking.emptyHint()).toBeNull()
  })

  it('DT-E6 点一行 → __tracking__ 下那份文件的笔记本会话：不进项目列表 / 侧栏会话列表 / 日历；再点复用同一条；卡片是 Tracked item', async () => {
    // 对照组：一条普通会话 —— 侧栏与日历都该有它，免得「列表里没有」的否定断言空转
    const controlId = await app.main.eval<string>(
      `window.api.session.create({ title: ${JSON.stringify(CONTROL_TITLE)} }).then((s) => s.id)`
    )
    const sidebar = sidebarPane(app.main)
    await until(
      async () => (await sidebar.titles()).includes(CONTROL_TITLE),
      'control session listed in the sidebar'
    )

    const tracking = trackingPane(app.main)
    await tracking.expand()
    await tracking.selectRow('a.md')
    expect(await tracking.activeRow()).toBe('a.md')

    const notes = await registryNoteSessions(app.main, TRACKING_PROJECT)
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatchObject({ notebookPath: 'a.md', title: 'Alpha bug' })
    alphaSessionId = notes[0].id

    // 载体项目：path = 跟踪项目录本身，项目列表过滤掉它
    const projectIds = await app.main.eval<string[]>(
      `window.api.project.list().then((ps) => ps.map((p) => p.id))`
    )
    expect(projectIds).not.toContain(TRACKING_PROJECT)
    const carrier = await app.main.eval<{ path: string } | null>(
      `window.api.project.getById(${JSON.stringify(TRACKING_PROJECT)})`
    )
    expect(carrier?.path).toBe(trackingDir())

    expect(await sidebar.titles()).toContain(CONTROL_TITLE)
    expect(await sidebar.titles()).not.toContain('Alpha bug')

    const onDay = await app.main.eval<string[]>(
      `window.api.calendar.sessionsOnDay(${JSON.stringify({ day: today() })}).then((ss) => ss.map((s) => s.id))`
    )
    expect(onDay).toContain(controlId)
    expect(onDay).not.toContain(alphaSessionId)

    // 属性卡：track 描述符的徽标（带标记里的版本，同 bot 卡的 'ShuviX bot · v2'）；对象 id 是已知键 ——
    // 卡上不渲染，也不落通用行
    const note = registryNotePane(app.main)
    await note.waitBody('Alpha bug')
    await note.waitCard()
    expect(await note.cardBadge()).toBe('Tracked item · v1')
    expect((await fmCardRowKeys(app.main)).map((r) => r.key)).not.toContain('shuvix-id')

    // 再点：别的行、再回来、点已是活动行的那一行 —— 都是同一条会话
    await tracking.selectRow('b.md')
    await tracking.selectRow('a.md')
    await tracking.selectRow('a.md')
    const again = await registryNoteSessions(app.main, TRACKING_PROJECT)
    expect(again.filter((n) => n.notebookPath === 'a.md').map((n) => n.id)).toEqual([
      alphaSessionId
    ])
    expect(again).toHaveLength(2)
  })

  it('DT-E7 在笔记本里改一级标题 → 自动保存 → 行字跟着变（tracking.changed，不用手动刷新）', async () => {
    const tracking = trackingPane(app.main)
    await tracking.selectRow('a.md')
    const note = registryNotePane(app.main)
    await note.waitBody('Alpha bug')

    const events = appEventRecorder(app.main)
    await events.install()
    await events.clear()
    const file = join(trackingDir(), 'a.md')
    const before = readFileSync(file, 'utf8')

    await notebookEditorPane(app.main).typeAtEnd(' renamed')
    const written = await waitFileWritten(file, before)
    expect(written).toMatch(/^# Alpha bug renamed$/m)

    await until(
      async () =>
        (await tracking.rows()).some(
          (r) => r.fileName === 'a.md' && r.title === 'Alpha bug renamed'
        ),
      'tracking row title follows the heading'
    )
    expect(await events.count('tracking.changed')).toBeGreaterThan(0)
  })

  it('DT-E8 tracking.openNote 只认目录里真实存在的可见 .md：越界 / 非 md / 隐藏 / 不存在 / 子目录都拒，不建会话', async () => {
    const before = (await listSessionIds(app.main)).length
    const outcomes = await app.main.eval<Record<string, string>>(
      `(async () => {
        const out = {}
        for (const fileName of ['../bots/daily.md', 'a.txt', '.h.md', 'missing.md', 'sub/a.md']) {
          out[fileName] = await window.api.tracking.openNote({ fileName }).then(
            () => 'resolved',
            (e) => 'rejected: ' + String(e && e.message ? e.message : e)
          )
        }
        return out
      })()`
    )
    for (const fileName of ['../bots/daily.md', 'a.txt', '.h.md', 'sub/a.md']) {
      expect(outcomes[fileName]).toMatch(/^rejected: .*Not a tracking file/)
    }
    expect(outcomes['missing.md']).toMatch(/^rejected: .*Tracking file not found/)
    expect((await listSessionIds(app.main)).length).toBe(before)
  })

  it('DT-E9 行菜单删掉一份开着、改过没提交过的跟踪项：文件没了且不被写回，会话删掉、主区离开它，行消失；删掉的那一版在 git 历史里', async () => {
    const dir = trackingDir()
    const file = join(dir, 'c.md')
    writeFileSync(file, '---\nshuvix: track v1\n---\n\n# Gamma to delete')
    // bot 从没跑过：目录还不是仓库，下面的改动因此从没被提交过
    expect(existsSync(join(dir, '.git'))).toBe(false)

    const tracking = trackingPane(app.main)
    await tracking.expand()
    await tracking.refresh()
    await until(
      async () => (await tracking.rows()).some((r) => r.fileName === 'c.md'),
      'c.md row listed'
    )
    await tracking.selectRow('c.md')
    const note = registryNotePane(app.main)
    await note.waitBody('Gamma to delete')
    const session = (await registryNoteSessions(app.main, TRACKING_PROJECT)).find(
      (n) => n.notebookPath === 'c.md'
    )
    expect(session).toBeDefined()

    // 在笔记本里改一笔，等自动保存落盘
    const before = readFileSync(file, 'utf8')
    await notebookEditorPane(app.main).typeAtEnd(' edited')
    expect(await waitFileWritten(file, before)).toMatch(/^# Gamma to delete edited$/m)

    expect(await tracking.rowMenuIds('c.md')).toEqual(['reveal', 'copy-path', 'delete'])
    await tracking.pickRowMenu('c.md', 'delete')
    const confirm = confirmPane(app.main)
    await confirm.waitOpen()
    // 行字跟着标题走（tracking.changed），确认框里写的可能是改前或改后的标题
    expect((await confirm.snapshot()).description).toContain('Gamma to delete')
    // 弹框还没确认：什么都没删
    expect(existsSync(file)).toBe(true)
    await confirm.confirm()
    await confirm.waitClosed()

    await until(() => !existsSync(file), 'c.md deleted')
    await until(
      async () => !(await tracking.rows()).some((r) => r.fileName === 'c.md'),
      'c.md row gone'
    )
    await until(async () => (await tracking.activeRow()) === null, 'no active tracking row')
    expect(await note.bodyText()).not.toContain('Gamma to delete')
    const remaining = await registryNoteSessions(app.main, TRACKING_PROJECT)
    expect(remaining.map((n) => n.id)).not.toContain(session!.id)
    expect(remaining.map((n) => n.notebookPath)).not.toContain('c.md')
    // 跨过自动保存的防抖窗口（200ms）与卸载 flush：笔记本没把文件写回来
    await sleep(700)
    expect(existsSync(file)).toBe(false)
    // 别的跟踪项还在
    expect((await tracking.rows()).map((r) => r.fileName)).toEqual(
      expect.arrayContaining(['a.md', 'b.md'])
    )

    const gitOut = (...args: string[]): string =>
      execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
    expect(gitOut('log', '--format=%s').trim().split('\n')).toEqual([
      'Deleted c.md (by the user)',
      'Before deleting c.md'
    ])
    expect(gitOut('show', 'HEAD~1:c.md')).toMatch(/^# Gamma to delete edited$/m)
    const headFiles = gitOut('ls-tree', '--name-only', 'HEAD').trim().split('\n')
    expect(headFiles).not.toContain('c.md')
    expect(headFiles).toEqual(expect.arrayContaining(['a.md', 'b.md']))
  })
})
