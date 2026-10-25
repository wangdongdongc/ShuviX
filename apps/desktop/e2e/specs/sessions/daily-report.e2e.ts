/**
 * 日历上的日报（`~/.shuvix/daily/<日期>.md`，见 main services/dailyNotes）—— 真窗口里走一遍：
 *
 *   DRE-1 今天还没有日报：当天列表头只有一颗新建图标；月历上今天只有会话点
 *   DRE-2 点新建图标：按模板建出今天的日报，主区开成它的笔记本；列表头多一行日报；月历上两个点并排
 *   DRE-3 会话行菜单「复制链接」：剪贴板里是指向这条会话今天第一条消息的 Markdown 链接；日报不动
 *   DRE-4 把它粘进日报笔记本：存盘、摘录跟着变；点那条链接，主区切到那条会话
 *   DRE-5 未来的日子：没有新建图标，openReport 被拒，也不建文件
 *
 * 一次冷启动。fake HOME 下的日报目录用 node fs 直接核对；剪贴板是页内替身（`navigator.clipboard.writeText`
 * 记下文字，不碰跑测试那台机器的剪贴板）。设了 `DAILY_E2E_SHOTS=<目录>` 时
 * 每一步存一张截图（日历面板 / 整个窗口），给人看样子用；不设就不截。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { until } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import { createAgentSession, promptAndListMessages } from '../../harness/seed'
import { notebookEditorPane, rightPanelPane, sidebarPane } from '../../harness/pages'

const TITLE = 'DRE 修日历圆点'

let app: E2EApp
let sid = ''

const dayKey = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const now = new Date()
const today = dayKey(now)
const reportFile = (): string => join(app.home, '.shuvix', 'daily', `${today}.md`)

/** 日历视图的根（CalendarView 最外层：月历容器的父级）；桌面只有右侧面板里这一份 */
const CAL = `document.querySelector('.calendar-container')?.parentElement`
/** 月历里今天那一格 */
const TODAY_CELL = `${CAL}?.querySelector('.rdp-today')`
/** 当天列表里按标题找会话行 */
const ROW = (title: string): string =>
  `[...(${CAL}?.querySelectorAll('[data-session-row]') ?? [])].find((r) => r.textContent?.includes(${JSON.stringify(title)}))`

const evalCal = <T>(expr: string): Promise<T> => app.main.eval<T>(expr)

async function shot(name: string, whole = false): Promise<void> {
  const dir = process.env.DAILY_E2E_SHOTS
  if (!dir) return
  mkdirSync(dir, { recursive: true })
  const clip = whole
    ? undefined
    : await evalCal<{ x: number; y: number; width: number; height: number }>(`(() => {
        const r = ${CAL}.getBoundingClientRect()
        return { x: r.left, y: r.top, width: r.width, height: Math.min(r.height, 560) }
      })()`)
  const res = await app.main.send<{ data: string }>('Page.captureScreenshot', {
    format: 'png',
    ...(clip ? { clip: { ...clip, scale: 2 } } : {})
  })
  writeFileSync(join(dir, `${name}.png`), Buffer.from(res.data, 'base64'))
}

beforeAll(async () => {
  app = await launchApp()
  sid = (await createAgentSession(app.main, { title: TITLE })).sid
  // 一条真的用户消息：插入的链接带上它的 entryId（隔离实例无 API key，prompt 失败也无妨，消息落树即可）
  await promptAndListMessages(app.main, sid, 'DRE 今天把日历的圆点修好')
  const panel = rightPanelPane(app.main)
  await panel.open()
  await panel.activateCalendarTab()
  await until(() => evalCal<boolean>(`!!${ROW(TITLE)}`), 'session row in today list')
}, 180_000)

afterAll(async () => {
  await app?.stop()
})

describe('日历上的日报', () => {
  it('DRE-1 今天还没有日报：列表头只有一颗新建图标；今天只有会话点', async () => {
    await until(
      () => evalCal<boolean>(`!!${CAL}?.querySelector('[data-daily-write]')`),
      'write icon'
    )
    expect(await evalCal<string>(`${CAL}.querySelector('[data-daily-write]').textContent`)).toBe('')
    expect(await evalCal<boolean>(`!!${CAL}.querySelector('[data-daily-report]')`)).toBe(false)
    const cls = await evalCal<string>(`${TODAY_CELL}.className`)
    expect(cls).toContain('rdp-has-sessions')
    expect(cls).not.toContain('rdp-has-report')
    expect(existsSync(reportFile())).toBe(false)
    await shot('1-no-report')
  })

  it('DRE-2 点新建图标：建出今天的日报并在主区打开；列表头多一行；月历上两个点并排', async () => {
    await evalCal(`${CAL}.querySelector('[data-daily-write]').click()`)
    await until(() => existsSync(reportFile()), 'daily file created')
    const text = readFileSync(reportFile(), 'utf8')
    expect(text.startsWith('---\nshuvix: daily v1\n---\n')).toBe(true)
    expect(text.match(/^## /gm)?.length).toBe(3)

    // 主区是这份日报的笔记本（编辑器里有模板的第一个标题）
    const firstHeading = text.match(/^## (.+)$/m)![1]
    await until(
      () =>
        app.main.eval<boolean>(
          `[...document.querySelectorAll('.cm-editor')].some((e) => e.textContent?.includes(${JSON.stringify(firstHeading)}))`
        ),
      'daily notebook open in the main area'
    )
    await until(
      () => evalCal<boolean>(`!!${CAL}.querySelector('[data-daily-report]')`),
      'report row'
    )
    expect(await evalCal<boolean>(`!!${CAL}.querySelector('[data-daily-write]')`)).toBe(false)

    await until(
      () => evalCal<boolean>(`${TODAY_CELL}.className.includes('rdp-has-report')`),
      'report dot'
    )
    const dots = await evalCal<{
      before: string
      after: string
      beforeBg: string
      afterBg: string
      accent: string
      selected: boolean
    }>(`(() => {
      const b = ${TODAY_CELL}.querySelector('.rdp-day_button')
      const s = (p) => getComputedStyle(b, p)
      const probe = document.createElement('div')
      probe.style.background = 'var(--theme-accent)'
      b.appendChild(probe)
      const accent = getComputedStyle(probe).backgroundColor
      probe.remove()
      return {
        before: s('::before').transform,
        after: s('::after').transform,
        beforeBg: s('::before').backgroundColor,
        afterBg: s('::after').backgroundColor,
        accent,
        selected: ${TODAY_CELL}.classList.contains('rdp-selected')
      }
    })()`)
    // 两个点都在、各自错开（会话在左、日报在右）：会话点是强调色、日报点是绿的 ——
    // 今天此刻正是选中日，选中也不换色（选中只是一圈框，换成底色就看不见了）
    expect(dots.selected).toBe(true)
    expect(dots.before).not.toBe('none')
    expect(dots.after).not.toBe('none')
    expect(dots.before).not.toBe(dots.after)
    expect(dots.beforeBg).toBe('rgb(34, 197, 94)')
    expect(dots.afterBg).toBe(dots.accent)
    expect(
      await app.main.eval<string[]>(
        `window.api.calendar.reportDaysInMonth(${JSON.stringify({ year: now.getFullYear(), month: now.getMonth() + 1 })})`
      )
    ).toEqual([today])
    await shot('2-report-created')
    await shot('2-window', true)
  })

  let copied = ''

  it('DRE-3 会话行菜单「复制链接」：剪贴板里是指向今天第一条消息的 Markdown 链接；日报不动', async () => {
    const before = readFileSync(reportFile(), 'utf8')
    await app.main.eval(`(() => {
      Object.defineProperty(navigator.clipboard, 'writeText', {
        configurable: true,
        value: async (text) => { window.__E2E_COPIED = text }
      })
      window.__E2E_COPIED = null
      window.__E2E_MENU_PICK = 'copy-link';
      window.__E2E_MENU_ITEMS = null;
      ${ROW(TITLE)}.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      return true
    })()`)
    await until(
      () => app.main.eval<boolean>(`Array.isArray(window.__E2E_MENU_ITEMS)`),
      'context menu popped'
    )
    const ids = await app.main.eval<string[]>(
      `window.__E2E_MENU_ITEMS.filter((it) => it.id).map((it) => it.id)`
    )
    expect(ids[0]).toBe('copy-link')

    await until(
      () => app.main.eval<boolean>(`typeof window.__E2E_COPIED === 'string'`),
      'link copied'
    )
    copied = await app.main.eval<string>(`window.__E2E_COPIED`)
    expect(copied).toMatch(new RegExp(`^\\[${TITLE}\\]\\(shuvix://session/${sid}#[^)]+\\)$`))
    expect(readFileSync(reportFile(), 'utf8')).toBe(before)
  })

  it('DRE-4 粘进日报笔记本：存盘、摘录跟着变；点那条链接，主区切到那条会话', async () => {
    // 主区还是 DRE-2 打开的那份日报（右键会话行不切会话）
    await notebookEditorPane(app.main).typeAtEnd(`\n${copied}\n`)
    await until(() => readFileSync(reportFile(), 'utf8').includes(copied), 'pasted link saved')
    await until(
      () =>
        evalCal<boolean>(
          `${CAL}.querySelector('[data-daily-report]').textContent.includes(${JSON.stringify(TITLE)})`
        ),
      'excerpt shows the session'
    )
    await shot('3-link-pasted')
    await until(
      () =>
        app.main.eval<boolean>(
          `[...document.querySelectorAll('.cm-atomic-link')].some((a) => a.textContent?.includes(${JSON.stringify(TITLE)}))`
        ),
      'session link rendered in the notebook'
    )
    await shot('4-notebook-link', true)
    await app.main.eval(`(() => {
      const a = [...document.querySelectorAll('.cm-atomic-link')].find((x) => x.textContent?.includes(${JSON.stringify(TITLE)}))
      a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
      return true
    })()`)
    const sidebar = sidebarPane(app.main)
    await until(async () => (await sidebar.activeTitle()) === TITLE, 'linked session active')
  })

  it('DRE-5 未来的日子：没有新建图标，openReport 被拒，不建文件', async () => {
    const tomorrow = new Date(now)
    tomorrow.setDate(tomorrow.getDate() + 1)
    const day = dayKey(tomorrow)
    const rejected = await app.main.eval<boolean>(
      `window.api.calendar.openReport(${JSON.stringify({ day })}).then(() => false, () => true)`
    )
    expect(rejected).toBe(true)
    expect(existsSync(join(app.home, '.shuvix', 'daily', `${day}.md`))).toBe(false)

    // 点月历上今天的下一格（跨月时下个月首日在 outside 格里，同样可点）
    await evalCal(`(() => {
      const cells = [...${CAL}.querySelectorAll('.rdp-day')]
      const i = cells.findIndex((c) => c.classList.contains('rdp-today'))
      cells[i + 1]?.querySelector('.rdp-day_button')?.click()
      return true
    })()`)
    await until(
      () =>
        evalCal<boolean>(
          `!${CAL}.querySelector('.rdp-today')?.classList.contains('rdp-selected') && !!${CAL}.querySelector('[data-day-report-header]')`
        ),
      'tomorrow selected'
    )
    expect(await evalCal<boolean>(`!!${CAL}.querySelector('[data-daily-write]')`)).toBe(false)
    await shot('5-tomorrow')
  })
})
