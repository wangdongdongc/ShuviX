/**
 * 随应用提供的日报 bot + 跟踪项（实验）—— 真实例上走一遍：
 *
 *   DT-E1 全新实例：`~/.shuvix/bots/daily.md` 按界面语言写好（`shuvix-id: bot:builtin:daily`），`.builtin-seeded` 记下它，bot.list 认它
 *   DT-E2 设置 → 触发源：不再列订阅者（触发源与 bot 解绑，2026-10-24）—— 日报 bot 的文件还在、bot.list 认它，
 *         但页里既没有订阅者列表，也没有它的显示名与 when；全新实例上它没命中过，触发日志是空态
 *   DT-E3 删掉 daily.md、停机、同一个 HOME 再起：不补写，记录不变
 *   DT-E4 跟踪项在收件箱页（2026-11-10 起桌面侧栏没有「跟踪项」分组了）：目录还没有时收件箱里没有「跟踪中」一节，
 *         打开收件箱也不建目录
 *   DT-E5 目录里放几样东西 → 节头菜单「刷新」：只列可见的 .md 文件（新的在前，已归档的折在归档图标 + 数字后面），行字是
 *         一级标题 / 文件名，`status: waiting` 的圆圈是等待中的样子，预览是最后一条进展（链接只留文字）；侧栏收件箱一行的
 *         数字不算跟踪项
 *   DT-E6 点一行 → 那份文件的笔记本会话（隐藏项目 `__tracking__`），收件箱随之关上：不进项目列表、侧栏会话列表、日历；
 *         再点复用同一条；属性卡是「Tracked item」，状态是卡上的一行，对象 id 是卡上不渲染的已知键
 *   DT-E7 在笔记本里改一级标题 → 自动保存 → 广播 `tracking.changed`，收件箱里的行字跟着变
 *   DT-E8 `tracking.openNote` 只认目录里真实存在的可见 .md：越界 / 非 md / 隐藏 / 不存在 / 子目录都拒，不建会话
 *   DT-E9 右键菜单删掉一份改过且从没提交过的跟踪项：菜单 = [archive, waiting, reveal, copy-path, delete]，确认框写着它的标题；
 *         确认后文件没了、跨过自动保存窗口也不被写回，它的笔记本会话删掉，行消失；
 *         目录成了 git 仓库，历史 = [Deleted …, Before deleting …]，父提交里是删前最后那一版
 *   DT-E10 状态：点圆圈归档 → 文件里 `status: archived`、行进「已归档 N」、底部「已归档「…」· 撤销」；撤销 → 回到原来的
 *         状态；右键「不再等待」/「标为等待中」改 `status`（没有这一行就补进 frontmatter，别的行不动）；「恢复」把已归档的
 *         改回 active；每一次都是一个宿主提交 `track: <status> <文件>`；收件箱数字始终不算跟踪项；`tracking.setStatus`
 *         只认目录里的跟踪项文件与三个状态值
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
  inboxTrackingPane,
  sidebarPane,
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
const LOCALE = { en, zh, ja }
const LOG_EMPTY = LOCALES.map((l) => l.settings.triggerLogEmpty)

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

describe('收件箱的「跟踪中」一节', () => {
  it('DT-E4 桌面侧栏没有「跟踪项」分组；目录还没有时收件箱里没有这一节，打开收件箱也不建目录', async () => {
    const tracking = inboxTrackingPane(app.main)
    await until(
      () => app.main.eval<boolean>(`!!document.querySelector('[data-inbox-row]')`),
      'sidebar inbox row'
    )
    expect(await tracking.sidebarGroupPresent()).toBe(false)
    await tracking.open()
    expect(await tracking.present()).toBe(false)
    expect(await tracking.inboxCount()).toBe(0)
    expect(existsSync(trackingDir())).toBe(false)
  })

  it('DT-E5 目录里放几样东西 → 刷新：只列可见的 .md（新的在前，已归档的折着），等待中带标签，下面一行是最后一条进展；收件箱数字不算它们', async () => {
    const dir = trackingDir()
    mkdirSync(dir, { recursive: true })
    // 一级标题是最后一行、文件不以换行结尾：DT-E7 在行尾打字改的就是它
    writeFileSync(
      join(dir, 'a.md'),
      `---\nshuvix: track v1\nshuvix-id: ${ALPHA_ID}\n---\n\n# Alpha bug`
    )
    writeFileSync(join(dir, 'b.md'), 'Just a note without a heading.\n')
    writeFileSync(
      join(dir, 'w.md'),
      '---\nshuvix: track v1\nstatus: waiting\n---\n\n# Waiting on Li\n\n## Progress\n\n' +
        '- 11-07: asked Li in [review](shuvix://session/x)\n' +
        '- 11-08: Li will answer by **Wednesday**\n'
    )
    writeFileSync(
      join(dir, 'z.md'),
      '---\nshuvix: track v1\nstatus: archived\n---\n\n# Release notes\n\nNotes went into the tag.\n'
    )
    writeFileSync(join(dir, '.h.md'), '# Hidden\n')
    writeFileSync(join(dir, 'n.txt'), '# Not markdown\n')
    mkdirSync(join(dir, 'x.md'))
    // 修改时间拉开：w 最新，然后 b、a；z（已归档）不在主列表里
    const now = Date.now() / 1000
    utimesSync(join(dir, 'a.md'), now - 120, now - 120)
    utimesSync(join(dir, 'b.md'), now - 10, now - 10)
    utimesSync(join(dir, 'w.md'), now - 5, now - 5)
    utimesSync(join(dir, 'z.md'), now - 300, now - 300)

    const tracking = inboxTrackingPane(app.main)
    await tracking.open()
    // 收件箱开着时它没扫到这些（磁盘外写入不广播）：这一节还不在，节头菜单够不着 —— 走窗口聚焦那条重扫
    await tracking.rescan()
    const rows = await until(async () => {
      const r = await tracking.rows()
      return r.length >= 3 ? r : null
    }, 'tracking rows')
    expect(rows).toEqual([
      {
        fileName: 'w.md',
        title: 'Waiting on Li',
        status: 'waiting',
        latest: '11-08: Li will answer by Wednesday',
        waitingTag: true
      },
      { fileName: 'b.md', title: 'b', status: 'active', latest: '', waitingTag: false },
      { fileName: 'a.md', title: 'Alpha bug', status: 'active', latest: '', waitingTag: false }
    ])
    expect(await tracking.archivedToggle()).toBe('1')
    await tracking.expandArchived()
    const archived = (await tracking.rows()).filter((r) => r.status === 'archived')
    expect(archived).toEqual([
      {
        fileName: 'z.md',
        title: 'Release notes',
        status: 'archived',
        latest: 'Notes went into the tag.',
        waitingTag: false
      }
    ])
    // 侧栏收件箱一行的数字不算跟踪项
    expect(await tracking.inboxCount()).toBe(0)
    expect(await tracking.menuIds()).toEqual(['open-folder', 'refresh'])
  })

  it('DT-E6 点一行 → __tracking__ 下那份文件的笔记本会话（收件箱关上）：不进项目列表 / 侧栏会话列表 / 日历；再点复用同一条；卡片是 Tracked item，状态是一行', async () => {
    // 对照组：一条普通会话 —— 侧栏与日历都该有它，免得「列表里没有」的否定断言空转
    const controlId = await app.main.eval<string>(
      `window.api.session.create({ title: ${JSON.stringify(CONTROL_TITLE)} }).then((s) => s.id)`
    )
    const sidebar = sidebarPane(app.main)
    await until(
      async () => (await sidebar.titles()).includes(CONTROL_TITLE),
      'control session listed in the sidebar'
    )

    const tracking = inboxTrackingPane(app.main)
    await tracking.open()
    await tracking.openRow('a.md')
    const note = registryNotePane(app.main)
    await note.waitBody('Alpha bug')

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

    // 属性卡：track 描述符的徽标（带标记里的版本，同 bot 卡的 'ShuviX bot · v2'）；状态是描述符里的一行（文件没写也画），
    // 对象 id 是已知键 —— 卡上不渲染，也不落通用行
    await note.waitCard()
    expect(await note.cardBadge()).toBe('Tracked item · v1')
    expect(await fmCardRowKeys(app.main)).toEqual([{ key: 'status', generic: false }])

    // 再点：别的行、再回来、再点一次同一行 —— 都是同一条会话
    for (const fileName of ['b.md', 'a.md', 'a.md']) {
      await tracking.open()
      await tracking.openRow(fileName)
    }
    await note.waitBody('Alpha bug')
    const again = await registryNoteSessions(app.main, TRACKING_PROJECT)
    expect(again.filter((n) => n.notebookPath === 'a.md').map((n) => n.id)).toEqual([
      alphaSessionId
    ])
    expect(again).toHaveLength(2)
  })

  it('DT-E7 在笔记本里改一级标题 → 自动保存 → tracking.changed，收件箱里的行字跟着变', async () => {
    const tracking = inboxTrackingPane(app.main)
    await tracking.open()
    await tracking.openRow('a.md')
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
    await until(async () => (await events.count('tracking.changed')) > 0, 'tracking.changed')

    await tracking.open()
    await until(
      async () =>
        (await tracking.rows()).some(
          (r) => r.fileName === 'a.md' && r.title === 'Alpha bug renamed'
        ),
      'tracking row title follows the heading'
    )
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

  it('DT-E9 右键菜单删掉一份改过没提交过的跟踪项：文件没了且不被写回，会话删掉，行消失；删掉的那一版在 git 历史里', async () => {
    const dir = trackingDir()
    const file = join(dir, 'c.md')
    writeFileSync(file, '---\nshuvix: track v1\n---\n\n# Gamma to delete')
    // 从没提交过：目录还不是仓库，下面的改动因此从没被提交过
    expect(existsSync(join(dir, '.git'))).toBe(false)

    const tracking = inboxTrackingPane(app.main)
    await tracking.open()
    await tracking.refresh()
    await until(
      async () => (await tracking.rows()).some((r) => r.fileName === 'c.md'),
      'c.md row listed'
    )
    await tracking.openRow('c.md')
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

    await tracking.open()
    expect(await tracking.rowMenuIds('c.md')).toEqual([
      'archive',
      'waiting',
      'reveal',
      'copy-path',
      'delete'
    ])
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
    const remaining = await registryNoteSessions(app.main, TRACKING_PROJECT)
    expect(remaining.map((n) => n.id)).not.toContain(session!.id)
    expect(remaining.map((n) => n.notebookPath)).not.toContain('c.md')
    // 跨过自动保存的防抖窗口（200ms）与卸载 flush：笔记本没把文件写回来
    await sleep(700)
    expect(existsSync(file)).toBe(false)
    // 别的跟踪项还在
    expect((await tracking.rows()).map((r) => r.fileName)).toEqual(
      expect.arrayContaining(['a.md', 'b.md', 'w.md'])
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

  it('DT-E10 归档 / 撤销 / 等待中 / 恢复都写进文件的 status 一行，每次一个宿主提交；收件箱数字不算跟踪项', async () => {
    const dir = trackingDir()
    const read = (name: string): string => readFileSync(join(dir, name), 'utf8')
    const statusLine = (name: string): string | null =>
      /^status:[ \t]*(.*)$/m.exec(read(name))?.[1]?.trim() ?? null
    const strings = LOCALE[language].inbox
    const tracking = inboxTrackingPane(app.main)
    await tracking.open()
    await until(async () => (await tracking.rows()).some((r) => r.fileName === 'w.md'), 'w.md row')

    // 圆圈 = 归档：文件里改成 archived，行进「已归档」，底部一句带撤销
    await tracking.archive('w.md')
    expect(await until(() => tracking.archivedToast(), 'archived toast')).toBe(
      strings.trackingArchived.replace('{{title}}', 'Waiting on Li')
    )
    await until(() => statusLine('w.md') === 'archived', 'w.md archived on disk')
    // 主列表里没有它了；已归档的行要展开「已归档 N」才画（重开收件箱后它是折着的）
    await until(
      async () => !(await tracking.rows()).some((r) => r.fileName === 'w.md'),
      'w.md left the main list'
    )
    expect(await tracking.archivedToggle()).toBe('2')
    await tracking.expandArchived()
    await until(
      async () =>
        (await tracking.rows()).some((r) => r.fileName === 'w.md' && r.status === 'archived'),
      'w.md row archived'
    )

    // 撤销：回到原来的状态（waiting，不是 active）
    await tracking.undo()
    await until(() => statusLine('w.md') === 'waiting', 'w.md back to waiting on disk')
    await until(
      async () =>
        (await tracking.rows()).some(
          (r) => r.fileName === 'w.md' && r.status === 'waiting' && r.waitingTag
        ),
      'w.md row waiting again'
    )

    // 右键「不再等待」：active
    await tracking.pickRowMenu('w.md', 'active')
    await until(() => statusLine('w.md') === 'active', 'w.md active on disk')

    // 右键「标为等待中」：a.md 原来没有 status 行 —— 补进 frontmatter，对象 id 与正文不动
    const aBefore = read('a.md')
    await tracking.pickRowMenu('a.md', 'waiting')
    await until(() => statusLine('a.md') === 'waiting', 'a.md waiting on disk')
    const aAfter = read('a.md')
    expect(aAfter).toContain(`shuvix-id: ${ALPHA_ID}`)
    expect(aAfter.split('---').slice(2).join('---')).toBe(aBefore.split('---').slice(2).join('---'))
    await until(
      async () => (await tracking.rows()).some((r) => r.fileName === 'a.md' && r.waitingTag),
      'a.md row carries the waiting tag'
    )

    // 「恢复」：已归档的 z.md 回到 active，回到主列表
    await tracking.restore('z.md')
    await until(() => statusLine('z.md') === 'active', 'z.md restored on disk')
    await until(
      async () =>
        (await tracking.rows()).some((r) => r.fileName === 'z.md' && r.status === 'active'),
      'z.md row back in the list'
    )

    expect(await tracking.inboxCount()).toBe(0)

    // 提交在写盘之后（宿主排队一次一个）：等最后一次也进了历史
    const subjects = (): string[] =>
      execFileSync('git', ['-C', dir, 'log', '--format=%s'], { encoding: 'utf8' })
        .trim()
        .split('\n')
    await until(() => subjects()[0] === 'track: active z.md', 'last status commit')
    expect(subjects().slice(0, 5)).toEqual([
      'track: active z.md',
      'track: waiting a.md',
      'track: active w.md',
      'track: waiting w.md',
      'track: archived w.md'
    ])

    // 写入口只认目录里的跟踪项文件与三个状态值
    const outcomes = await app.main.eval<Record<string, string>>(
      `(async () => {
        const out = {}
        const tries = [
          ['../bots/x.md', 'archived'],
          ['missing.md', 'archived'],
          ['b.md', 'done']
        ]
        for (const [fileName, status] of tries) {
          out[fileName + ' ' + status] = await window.api.tracking.setStatus({ fileName, status }).then(
            () => 'resolved',
            (e) => 'rejected: ' + String(e && e.message ? e.message : e)
          )
        }
        return out
      })()`
    )
    expect(outcomes['../bots/x.md archived']).toMatch(/^rejected: .*Not a tracking file/)
    expect(outcomes['missing.md archived']).toMatch(/^rejected: .*Tracking file not found/)
    expect(outcomes['b.md done']).toMatch(/^rejected: .*Not a tracking status/)
    expect(read('b.md')).toBe('Just a note without a heading.\n')
  })
})
