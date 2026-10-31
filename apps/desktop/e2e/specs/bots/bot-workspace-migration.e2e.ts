/**
 * 迁移 v38（E-4）：升级时把挂在项目里的 bot 会话挪成引用、标出触发器开的运行会话（无 LLM）。
 *
 * 2026-10-31 起 bot 会话只归属 bot。之前在项目组里开的 bot 会话（连同它下面的子会话）是项目的**成员**
 * （`projectId` = 项目），升级后：`projectId` 清空、项目记进 `settings.workProject`、项目路径记进
 * `settings.workingDirectory`（项目删了就退回这里）。触发器开的运行会话（第一条非 'created' 的
 * `session_day_prompts.origin` 是 'trigger'）打上 `settings.triggerRun`，侧栏把它们折进 bot 组的「定时运行」。
 * 普通的项目会话与第一条是人打的 bot 会话不动。
 *
 * 做法同 browser-migration / database-migration：「停机 → 改库 → 用同一个 HOME 再起」（`launchApp({ home })` /
 * `stop({ keepHome: true })`），库用系统 sqlite3 CLI 只在停机时写。种子会话先经 IPC 按今天的规则建好，再在停机时
 * 改回 v37 的形状（挂进项目、去掉今天才有的键、`user_version = 37`）。
 */
import { mkdirSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { until } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import { createProject, sqlite, sqlLit, waitRendererReady, writeBotMd } from '../../harness/seed'
import { botsPane, sidebarPane } from '../../harness/pages'

const PROJECT = 'MIG-Proj'
const MIGRATION_LINE = 'Running migration v38'

interface SessionShot {
  id: string
  title: string
  projectId: string | null
  parentId: string | null
  workingDirectory?: string | null
  settings: { bot?: string; workProject?: string; workingDirectory?: string; triggerRun?: boolean }
}

let app: E2EApp | undefined
let home = ''
let projectId = ''
let projectDir = ''
/** 在项目里开的 bot 会话（根）与它的子会话 */
let rootSid = ''
let childSid = ''
/** 触发器开的运行会话 */
let runSid = ''
/** 同一个 bot、第一条是人打的会话（不该被标成运行） */
let ownSid = ''
/** 普通的项目会话（不是 bot 会话：留在项目里） */
let memberSid = ''

const getSession = (sid: string): Promise<SessionShot | null> =>
  app!.main.eval<SessionShot | null>(`window.api.session.getById(${JSON.stringify(sid)})`)
const createSession = (params: Record<string, unknown>): Promise<string> =>
  app!.main.eval<string>(`window.api.session.create(${JSON.stringify(params)}).then((s) => s.id)`)
const real = (p: string): string => realpathSync(p)

beforeAll(async () => {
  app = await launchApp()
  home = app.home
  await waitRendererReady(app.main)

  projectDir = join(home, 'proj-mig')
  mkdirSync(projectDir, { recursive: true })
  projectId = (await createProject(app.main, { name: PROJECT, path: projectDir })).id
  writeBotMd(app, 'migbot', { displayName: 'Mig Bot' })
  writeBotMd(app, 'runbot', { displayName: 'Run Bot' })

  rootSid = await createSession({ title: 'MIG-root', bot: 'migbot' })
  childSid = await createSession({ title: 'MIG-child', parentId: rootSid })
  runSid = await createSession({ title: 'MIG-run', bot: 'runbot' })
  ownSid = await createSession({ title: 'MIG-own', bot: 'runbot' })
  memberSid = await createSession({ title: 'MIG-member', projectId })

  // 停机，把库改回 v37 的形状
  await app.stop({ keepHome: true })
  app = undefined
  const ids = (xs: string[]): string => xs.map(sqlLit).join(', ')
  sqlite(
    home,
    [
      // 在项目里开的 bot 会话与它的子会话：项目成员，设置里没有今天才有的引用 / 路径快照
      `UPDATE sessions SET projectId = ${sqlLit(projectId)},
         settings = json_remove(settings, '$.workProject', '$.workingDirectory')
       WHERE id IN (${ids([rootSid, childSid])});`,
      // 运行会话：第一条用户条目是触发器发的（会话建成那一行 entryId 'created' 不算）
      `INSERT INTO session_day_prompts (sessionId, entryId, day, timestamp, origin)
         VALUES (${sqlLit(runSid)}, 'mig-run-1', '2026-10-30', 1000, 'trigger'),
                (${sqlLit(runSid)}, 'mig-run-2', '2026-10-30', 2000, 'local'),
                (${sqlLit(ownSid)}, 'mig-own-1', '2026-10-30', 1000, 'local'),
                (${sqlLit(ownSid)}, 'mig-own-2', '2026-10-30', 2000, 'trigger');`,
      `UPDATE sessions SET settings = json_remove(settings, '$.triggerRun') WHERE id IN (${ids([runSid, ownSid])});`,
      'PRAGMA user_version = 37;'
    ].join('\n')
  )
  // 前提：改库真的落下了
  expect(sqlite(home, `SELECT projectId FROM sessions WHERE id = ${sqlLit(rootSid)}`).trim()).toBe(
    projectId
  )

  app = await launchApp({ home })
  await waitRendererReady(app.main)
}, 180_000)

afterAll(async () => {
  if (app) await app.stop()
  else if (home) rmSync(home, { recursive: true, force: true })
})

describe('迁移 v38', () => {
  it('E-4a 升级那次跑了 v38（主进程日志跨启动累加：全新安装一次 + 从 37 升级一次），库版本至少 38', () => {
    expect(app!.mainLog().split(MIGRATION_LINE).length - 1).toBe(2)
    expect(Number(sqlite(home, 'PRAGMA user_version').trim())).toBeGreaterThanOrEqual(38)
  })

  it('E-4b 项目里的 bot 会话与它的子会话：不再是成员，项目记成引用、项目路径记成快照；普通项目会话不动', async () => {
    for (const sid of [rootSid, childSid]) {
      const s = (await getSession(sid))!
      expect(s, sid).not.toBeNull()
      expect(s.projectId, sid).toBeNull()
      expect(s.settings.workProject, sid).toBe(projectId)
      expect(real(s.settings.workingDirectory!), sid).toBe(real(projectDir))
      expect(real(s.workingDirectory!), sid).toBe(real(projectDir))
    }
    expect((await getSession(childSid))!.parentId).toBe(rootSid)
    expect((await getSession(rootSid))!.settings.bot).toBe('migbot')

    const member = (await getSession(memberSid))!
    expect(member.projectId).toBe(projectId)
    expect(member.settings.workProject).toBeUndefined()
  })

  it('E-4c 第一条非 created 条目是触发器发的 → triggerRun；第一条是人打的（后面才有触发）→ 不标', async () => {
    expect((await getSession(runSid))!.settings.triggerRun).toBe(true)
    expect((await getSession(ownSid))!.settings.triggerRun).toBeUndefined()
  })

  it('E-4d 侧栏：迁过来的根会话在 migbot 组里、行尾标项目名，子会话在它下面；运行会话折进 runbot 的「定时运行」，人打的那条在外面；项目组里只剩成员', async () => {
    const bots = botsPane(app!.main)
    const sidebar = sidebarPane(app!.main)
    await bots.waitGroup('migbot')
    await bots.waitGroup('runbot')

    const mig = await until(async () => {
      const rows = await bots.groupSessions('migbot')
      return rows.length === 2 ? rows : null
    }, 'migbot rows')
    expect(mig).toEqual([
      { title: 'MIG-root', location: PROJECT, active: false, sub: false },
      { title: 'MIG-child', location: '', active: false, sub: true }
    ])

    const runs = await bots.runs('runbot')
    expect(runs).not.toBeNull()
    expect(runs!.state).toBe('collapsed')
    expect(runs!.count).toBe(1)
    expect(runs!.rows.map((r) => r.title)).toEqual(['MIG-run'])
    expect((await bots.groupSessions('runbot')).map((r) => r.title)).toEqual(['MIG-own'])

    await sidebar.setGroupExpanded({ project: PROJECT }, true)
    expect((await sidebar.groupRows({ project: PROJECT })).map((r) => r.title)).toEqual([
      'MIG-member'
    ])
  })
})
