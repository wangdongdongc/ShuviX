/**
 * dailyNotes —— 日历上「那一天的日报」：哪些天写了、那天的摘录、打开那天（第一次打开才按模板建）。
 *
 * dao / sessionService 是替身；**fs 是真的** —— 「是不是那一天的日报文件」「目录还没有」
 * 「用户的模板在不在」都只有真目录测得出来。日报目录挂在每个用例各自的随机临时根下，默认不存在。
 * 日期一律用过去的日子：未来的日子不能写（DS-6），而测试不能依赖今天是哪天。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DAILY_PROJECT_ID, localDayKey } from '@shuvix/chat-protocol/dailyNotes'
import type { Project, Session } from '../../types'

const tmp = vi.hoisted(() => ({ base: '' }))
const dailyDir = (): string => join(tmp.base, 'daily')

vi.mock('../../utils/paths', () => ({
  getDefaultDailyDir: () => `${tmp.base}/daily`
}))
vi.mock('../../i18n', () => ({
  t: (key: string, opts?: { day?: string }) => (opts?.day ? `${key}:${opts.day}` : key)
}))
vi.mock('../../dao/projectDao', () => ({
  projectDao: { findById: vi.fn(), insert: vi.fn(), update: vi.fn() }
}))
vi.mock('../../dao/sessionDao', () => ({
  sessionDao: { findByProjectAndNotebookPath: vi.fn() }
}))
vi.mock('../sessionService', () => ({
  sessionService: {
    create: vi.fn((p: Record<string, unknown> | undefined) => ({ id: 's-daily', ...p }))
  }
}))

import { projectDao } from '../../dao/projectDao'
import { sessionDao } from '../../dao/sessionDao'
import { appEventBus } from '../../utils/appEventBus'
import { sessionService } from '../sessionService'
import { ensureDailyProject, openReport, reportDaysInMonth, reportOnDay } from '../dailyNotes'

const publish = vi.spyOn(appEventBus, 'publish')

const DAY = '2025-03-14'
const fileOf = (day: string): string => join(dailyDir(), `${day}.md`)
const put = (name: string, text: string): void => {
  mkdirSync(dailyDir(), { recursive: true })
  writeFileSync(join(dailyDir(), name), text)
}
const dailyRow = (over: Partial<Project> = {}): Project => ({
  id: DAILY_PROJECT_ID,
  name: 'Daily',
  path: dailyDir(),
  systemPrompt: '',
  settings: {},
  archivedAt: 0,
  createdAt: 1,
  updatedAt: 1,
  ...over
})
const sessionRow = (over: Partial<Session> = {}): Session =>
  ({
    id: 'sess-1',
    title: '修日历',
    projectId: null,
    parentId: null,
    settings: {},
    createdAt: 1,
    updatedAt: 1,
    lastActiveAt: 1,
    ...over
  }) as Session

beforeEach(() => {
  vi.clearAllMocks()
  tmp.base = join(tmpdir(), `shuvix-daily-${process.pid}-${Math.random().toString(36).slice(2)}`)
  vi.mocked(projectDao.findById).mockReturnValue(undefined)
  vi.mocked(sessionDao.findByProjectAndNotebookPath).mockReturnValue(undefined)
})

afterEach(() => {
  rmSync(tmp.base, { recursive: true, force: true })
})

describe('哪些天写了 / 那天写了什么', () => {
  it('DS-1 目录还没有：一天也没有；查询不建目录', () => {
    expect(reportDaysInMonth(2025, 3)).toEqual([])
    expect(reportOnDay(DAY)).toBeNull()
    expect(existsSync(dailyDir())).toBe(false)
  })

  it('DS-2 reportDaysInMonth 只认这个月的 `YYYY-MM-DD.md` 普通文件，按日期排好', () => {
    put('2025-03-14.md', '')
    put('2025-03-02.md', '')
    put('2025-04-01.md', '')
    put('_template.md', '')
    put('2025-03-20.md.partial', '')
    mkdirSync(join(dailyDir(), '2025-03-05.md'))
    expect(reportDaysInMonth(2025, 3)).toEqual(['2025-03-02', '2025-03-14'])
    expect(reportDaysInMonth(2025, 4)).toEqual(['2025-04-01'])
  })

  it('DS-3 reportOnDay：只有模板时摘录为空串；写了就回摘录；都带文件路径；不是日子的入参回 null', () => {
    put(`${DAY}.md`, '---\nshuvix: daily v1\n---\n\n## 完成\n\n- \n')
    expect(reportOnDay(DAY)).toEqual({ excerpt: '', path: fileOf(DAY) })
    put(`${DAY}.md`, '## 完成\n\n- 修好了圆点\n')
    expect(reportOnDay(DAY)).toEqual({ excerpt: '修好了圆点', path: fileOf(DAY) })
    expect(reportOnDay('../x')).toBeNull()
  })
})

describe('打开那一天', () => {
  it('DS-4 第一次打开：按内置模板建文件（目录一并建）、插隐藏项目行、建笔记本会话（文件名 / 标题），广播一次 daily.changed', () => {
    const session = openReport(DAY)

    const text = readFileSync(fileOf(DAY), 'utf8')
    expect(text.startsWith('---\nshuvix: daily v1\n---\n')).toBe(true)
    expect(text).toContain('## daily.template.done')
    expect(text.match(/^## /gm)).toHaveLength(1)

    expect(vi.mocked(projectDao.insert).mock.calls[0][0]).toMatchObject({
      id: DAILY_PROJECT_ID,
      path: dailyDir()
    })
    expect(sessionService.create).toHaveBeenCalledWith({
      projectId: DAILY_PROJECT_ID,
      notebookPath: `${DAY}.md`,
      title: `daily.title:${DAY}`
    })
    expect(session).toMatchObject({ id: 's-daily', workingDirectory: dailyDir() })
    expect(publish.mock.calls).toEqual([[{ type: 'daily.changed' }]])
  })

  it('DS-5 再次打开：复用那条会话；文件已在就不重写、不广播', () => {
    put(`${DAY}.md`, '我自己写的\n')
    vi.mocked(projectDao.findById).mockReturnValue(dailyRow())
    vi.mocked(sessionDao.findByProjectAndNotebookPath).mockReturnValue(
      sessionRow({ id: 'existing', projectId: DAILY_PROJECT_ID })
    )

    expect(openReport(DAY).id).toBe('existing')
    expect(sessionDao.findByProjectAndNotebookPath).toHaveBeenCalledWith(
      DAILY_PROJECT_ID,
      `${DAY}.md`
    )
    expect(sessionService.create).not.toHaveBeenCalled()
    expect(projectDao.insert).not.toHaveBeenCalled()
    expect(readFileSync(fileOf(DAY), 'utf8')).toBe('我自己写的\n')
    expect(publish).not.toHaveBeenCalled()
  })

  it('DS-6 未来的日子与不是日子的入参：拒绝，什么都不建', () => {
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    for (const day of [localDayKey(tomorrow), '2025-02-30', '../../etc/passwd', '']) {
      expect(() => openReport(day), day).toThrow()
    }
    expect(existsSync(dailyDir())).toBe(false)
    expect(sessionService.create).not.toHaveBeenCalled()
  })

  it('DS-7 今天可以写（「未来」从明天算起）', () => {
    const today = localDayKey(new Date())
    openReport(today)
    expect(existsSync(fileOf(today))).toBe(true)
  })

  it('DS-8 目录里有用户的 `_template.md`：照它建', () => {
    put('_template.md', '## 今天\n\n- \n')
    openReport(DAY)
    expect(readFileSync(fileOf(DAY), 'utf8')).toBe('## 今天\n\n- \n')
  })

  it('DS-9 隐藏项目行的 path 漂移（home 迁移）：补 path，不重插', () => {
    vi.mocked(projectDao.findById).mockReturnValue(dailyRow({ path: '/old/home/.shuvix/daily' }))
    expect(ensureDailyProject().path).toBe(dailyDir())
    expect(projectDao.update).toHaveBeenCalledWith(DAILY_PROJECT_ID, { path: dailyDir() })
    expect(projectDao.insert).not.toHaveBeenCalled()
  })
})
