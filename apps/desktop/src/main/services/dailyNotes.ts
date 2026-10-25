/**
 * 日报 —— 日历上「那一天的日报」的后端：一天一份 `~/.shuvix/daily/YYYY-MM-DD.md`，打开即笔记本会话。
 *
 * 与注册表笔记（registryNotes）同一套做法：目录有一个隐藏项目（`__daily__`，path = 目录本身），一份
 * 文件至多一个笔记本会话，重复打开复用；编辑、自动保存、外部改动合并全归笔记本会话。这里只回答
 * 「那一天有没有日报、写了什么」「打开那一天」，外加日历里的「删除日报」。
 *
 * **第一次打开才建文件**：用户的 `_template.md` 在就照它，否则用内置的三段。未来的日子不能写 ——
 * 日报记的是已经发生的事；过去的日子可以补。身份是文件名（日期）：没有 `shuvix: daily v1` 自述行的
 * 同名文件照样算那一天的日报。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'
import {
  DAILY_PROJECT_ID,
  DAILY_TEMPLATE_FILE,
  dailyExcerpt,
  dailyFileName,
  dayOfDailyFile,
  defaultDailyTemplate,
  isDayKey,
  localDayKey
} from '@shuvix/chat-protocol/dailyNotes'
import { appEventBus } from '../utils/appEventBus'
import { writeFileAtomic } from '../utils/atomicWrite'
import { getDefaultDailyDir } from '../utils/paths'
import { t } from '../i18n'
import { projectDao } from '../dao/projectDao'
import { sessionRecords } from './sessionRecords'
import { sessionService } from './sessionService'
import type { Project, SessionInfo } from '../types'

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** 入参按不可信处理：只接受真实存在、且不晚于今天的本地日 */
function assertWritableDay(day: string): void {
  if (!isDayKey(day)) throw new Error(`Invalid day: ${day}`)
  if (day > localDayKey(new Date()))
    throw new Error(`Cannot write a daily report for a future day: ${day}`)
}

/** 确保日报目录的隐藏项目存在并返回（目录在第一次写入时才建）。不发 project.changed —— 列表不可见 */
export function ensureDailyProject(): Project {
  const root = getDefaultDailyDir()
  const existing = projectDao.findById(DAILY_PROJECT_ID)
  if (existing) {
    if (existing.path === root) return existing
    projectDao.update(DAILY_PROJECT_ID, { path: root })
    return { ...existing, path: root }
  }
  const now = Date.now()
  const project: Project = {
    id: DAILY_PROJECT_ID,
    name: 'Daily',
    path: root,
    systemPrompt: '',
    settings: {},
    archivedAt: 0,
    createdAt: now,
    updatedAt: now
  }
  projectDao.insert(project)
  return project
}

/** 可见月里写了日报的日子（YYYY-MM-DD[]）；`month` 为 1–12。目录还没有就是一天也没有 */
export function reportDaysInMonth(year: number, month: number): string[] {
  const prefix = `${year}-${String(month).padStart(2, '0')}-`
  let names: string[]
  try {
    names = readdirSync(getDefaultDailyDir())
  } catch {
    return []
  }
  const dir = getDefaultDailyDir()
  return names
    .map((name) => ({ name, day: dayOfDailyFile(name) }))
    .filter(
      (x): x is { name: string; day: string } =>
        !!x.day && x.day.startsWith(prefix) && isRegularFile(join(dir, x.name))
    )
    .map((x) => x.day)
    .sort()
}

/** 那一天的日报：没有返回 null；有则回摘录（只有模板、什么都没写时是空串）与文件的绝对路径（行菜单用） */
export function reportOnDay(day: string): { excerpt: string; path: string } | null {
  if (!isDayKey(day)) return null
  const path = join(getDefaultDailyDir(), dailyFileName(day))
  if (!isRegularFile(path)) return null
  try {
    return { excerpt: dailyExcerpt(readFileSync(path, 'utf8')), path }
  } catch {
    return null
  }
}

/** 新建日报的内容：用户模板优先，读不到就用内置的那一段 */
function templateSource(): string {
  const custom = join(getDefaultDailyDir(), DAILY_TEMPLATE_FILE)
  if (isRegularFile(custom)) {
    try {
      return readFileSync(custom, 'utf8')
    } catch {
      // 读不到就当没有
    }
  }
  return defaultDailyTemplate(t('daily.template.done'))
}

/** 那一天的日报文件在就返回路径，不在就按模板建出来（返回值第二项 = 这一次是不是新建的） */
function ensureReportFile(day: string): { path: string; created: boolean } {
  const dir = getDefaultDailyDir()
  const path = join(dir, dailyFileName(day))
  if (isRegularFile(path)) return { path, created: false }
  if (existsSync(path)) throw new Error(`Not a file: ${path}`)
  mkdirSync(dir, { recursive: true })
  writeFileAtomic(path, templateSource())
  return { path, created: true }
}

/** 打开 / 复用那一天日报的笔记本会话；文件不在就先按模板建（第一次打开才建） */
export function openReport(day: string): SessionInfo {
  assertWritableDay(day)
  const { created } = ensureReportFile(day)
  const project = ensureDailyProject()
  const fileName = dailyFileName(day)
  const session =
    sessionRecords.findByProjectAndNotebookPath(project.id, fileName) ??
    sessionService.create({
      projectId: project.id,
      notebookPath: fileName,
      title: t('daily.title', { day })
    })
  if (created) appEventBus.publish({ type: 'daily.changed' })
  return { ...session, workingDirectory: project.path }
}

/**
 * 日历里「删除日报」（界面先确认过）：删掉那一天的日报文件，连同它的笔记本会话。会话先删 —— 主区正开着这份
 * 笔记本时，它的自动保存会把文件写回来；会话没了，之后的写入就被拒了。文件直接删（与 bot / 智能体 md 的删除
 * 一样），不进废纸篓。未来的日子也能删（用户自己放进目录的文件）。回删掉的笔记本会话 id，界面据此把它从列表里拿掉
 */
export async function deleteReport(
  day: string
): Promise<{ deleted: boolean; sessionId: string | null }> {
  if (!isDayKey(day)) throw new Error(`Invalid day: ${day}`)
  const fileName = dailyFileName(day)
  const session = sessionRecords.findByProjectAndNotebookPath(DAILY_PROJECT_ID, fileName)
  if (session) await sessionService.delete(session.id)
  const path = join(getDefaultDailyDir(), fileName)
  if (!isRegularFile(path)) return { deleted: false, sessionId: session?.id ?? null }
  unlinkSync(path)
  appEventBus.publish({ type: 'daily.changed' })
  return { deleted: true, sessionId: session?.id ?? null }
}
