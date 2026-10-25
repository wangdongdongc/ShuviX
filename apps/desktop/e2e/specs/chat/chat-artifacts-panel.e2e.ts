/**
 * 会话产物的版本与会话面板的「产物」页 —— 单测（history / listing / artifactList / sessionArtifacts /
 * ArtifactsPanel / sessionPanelArtifacts）够不着的那一段，全在真主进程 + 真窗口里走一遍：
 * 工具调用 → 包装器的执行钩子 → 产物目录里的 git 提交 → `artifacts.changed` 一路到渲染端 → 工具栏与面板跟着变。
 *
 *   E-1 第一轮：`artifact` create 一张 svg → `~/.shuvix/artifacts/<sid>/.git` 在、`artifact.list` 一行 v1；
 *       工具栏长出 `[data-session-tool="artifacts"]`（这一轮之前没有），打开产物页那一行写着 v1
 *   E-2 第二轮：`edit` 按绝对路径改它 → 面板开着、**不重开**，那一行自己变成 v2（事件驱动的重拉）；
 *       `artifact.list` 也是 v2，目录里两次提交；点开那一行 → 预览里是那张内联 svg（改过之后的）
 *   E-3 没有产物的会话：工具栏没有 artifacts 按钮
 *   E-4 引用钉版本：两轮的终答都带一个闭合的 ```artifact\nbar-chart.svg\n``` —— 第一条回复里的图仍是 1 根柱子
 *       并标「已有新版」，第二条是 2 根、不标；`artifact.read({ messageId: 第一条 })` 是 pinned / 不是 latest；
 *       收起面板，点第一条的「已有新版」→ 面板展开到产物页，那一行展开、预览是 2 根柱子的最新版
 *   E-4b 切到别的会话再切回来：第一条回复照旧是钉住的那一版
 *
 * 一次 launchApp，每条用例一个会话（E-1 / E-2 / E-4 共用一个）。设了 `ARTIFACTS_E2E_SHOTS=<目录>` 时，E-2 末尾
 * 存两张截图（工具栏 + 面板、整个窗口），E-4 再存三张（两条回复都在的对话、揭示之后的面板与整个窗口），给人看
 * 样子用；不设就不截。选择器全部走 `harness/pages.ts` 的 `artifactsPanelPane` / `artifactRefsPane` / `sessionToolKeys`。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ArtifactRefContent, SessionArtifact } from '@shuvix/chat-protocol/artifacts'
import { sleep, until } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import { startFakeProvider, type FakeProvider } from '../../harness/fakeProvider'
import {
  autoAllowed,
  createProject,
  installAutoAllow,
  seedFakeProvider,
  waitRendererReady
} from '../../harness/seed'
import {
  artifactRefsPane,
  artifactsPanelPane,
  chatPane,
  sessionToolKeys,
  sidebarPane,
  type ArtifactRefsPane,
  type ArtifactsPanelPane,
  type ChatPane,
  type SidebarPane
} from '../../harness/pages'

const MODEL = 'e2e-model'
const SESSIONS = ['artifacts-E1', 'artifacts-E3']
const USAGE = { prompt: 90, completion: 20 }

const SVG =
  '<svg viewBox="0 0 40 20" aria-label="Bar chart" xmlns="http://www.w3.org/2000/svg">' +
  '<rect width="10" height="20" fill="var(--viz-1)"/></svg>'
const FILE_NAME = 'bar-chart.svg'
/** 两轮终答里都有的那一个引用（闭合的围栏） */
const REF = '\n\n```artifact\nbar-chart.svg\n```'

interface ListedMessage {
  id: string
  role: string
  content: string
}

let app: E2EApp
let provider: FakeProvider
let chat: ChatPane
let sidebar: SidebarPane
let panel: ArtifactsPanelPane
let refs: ArtifactRefsPane
const sids = new Map<string, string>()

const artifactsDir = (sid: string): string => join(app.home, '.shuvix', 'artifacts', sid)
const listArtifacts = (sid: string): Promise<SessionArtifact[]> =>
  app.main.eval<SessionArtifact[]>(
    `window.api.artifact.list(${JSON.stringify({ sessionId: sid })})`
  )
const listMessages = (sid: string): Promise<ListedMessage[]> =>
  app.main.eval<ListedMessage[]>(`window.api.message.list(${JSON.stringify(sid)})`)
/** 正文里带这个记号的那条助手消息的 id（= 它那张卡的 `data-msg-id`） */
async function replyId(sid: string, mark: string): Promise<string> {
  const found = (await listMessages(sid)).find(
    (m) => m.role === 'assistant' && m.content.includes(mark)
  )
  expect(found, `assistant reply ${mark}`).toBeDefined()
  return found!.id
}
const readRef = (params: {
  sessionId: string
  name: string
  messageId?: string
}): Promise<ArtifactRefContent | null> =>
  app.main.eval<ArtifactRefContent | null>(`window.api.artifact.read(${JSON.stringify(params)})`)

/** 产物目录里的提交标题（新的在前）—— 用系统 git 读，不经被测实现 */
const commitSubjects = (sid: string): string[] =>
  execFileSync('git', ['-C', artifactsDir(sid), 'log', '--format=%s'], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)

async function shot(name: string, whole = false): Promise<void> {
  const dir = process.env.ARTIFACTS_E2E_SHOTS
  if (!dir) return
  mkdirSync(dir, { recursive: true })
  const clip = whole ? null : await panel.shotRect()
  const res = await app.main.send<{ data: string }>('Page.captureScreenshot', {
    format: 'png',
    ...(clip ? { clip: { ...clip, scale: 2 } } : {})
  })
  writeFileSync(join(dir, `${name}.png`), Buffer.from(res.data, 'base64'))
}

beforeAll(async () => {
  app = await launchApp()
  provider = await startFakeProvider()
  await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  await waitRendererReady(app.main)

  const project = await createProject(app.main, { name: 'ArtifactsProj', path: app.home })
  for (const title of SESSIONS) {
    const sid = await app.main.eval<string>(
      `window.api.session.create(${JSON.stringify({ title, projectId: project.id })}).then((s) => s.id)`
    )
    sids.set(title, sid)
  }
  // 安全网：本会话的产物目录在会话权限表里，不该问；万一问了，这里点「允许一次」，E-2 末尾断言它一次没点
  await installAutoAllow(app.main)

  chat = chatPane(app.main)
  sidebar = sidebarPane(app.main)
  panel = artifactsPanelPane(app.main)
  refs = artifactRefsPane(app.main)
  // IPC 建的会话没有广播：点一次「新对话」让侧栏拉全量列表
  await sidebar.clickNewChat()
  await until(async () => {
    const titles = await sidebar.titles()
    return SESSIONS.every((t) => titles.includes(t))
  }, 'sidebar lists the artifacts sessions')
}, 120_000)

afterAll(async () => {
  await provider?.close()
  await app?.stop()
})

const openSession = async (title: string): Promise<void> => {
  expect(await sidebar.openSession(title)).toBe(true)
  await chat.ready()
}

describe('会话产物：版本 + 会话面板的产物页', () => {
  it('E-1 artifact create → 目录成了仓库、清单一行 v1、工具栏长出 artifacts 按钮', async () => {
    const sid = sids.get('artifacts-E1')!
    await openSession('artifacts-E1')
    await until(
      async () => (await sessionToolKeys(app.main)).includes('files'),
      'session toolbar mounted'
    )
    expect(await sessionToolKeys(app.main)).not.toContain('artifacts')

    provider.reset()
    provider.script(
      {
        toolCalls: [
          {
            id: 'call_create_e1',
            name: 'artifact',
            args: JSON.stringify({ action: 'create', title: 'Bar chart', ext: 'svg', content: SVG })
          }
        ],
        usage: USAGE
      },
      { text: `MARK-E1 made a bar chart.${REF}`, usage: USAGE }
    )
    await chat.typeAndSend('draw a bar chart E1')
    await chat.waitIdle()

    expect(provider.chatRequests().at(-1)?.raw ?? '').toContain(FILE_NAME)
    const file = join(artifactsDir(sid), FILE_NAME)
    expect(readFileSync(file, 'utf8')).toBe(SVG)
    expect(existsSync(join(artifactsDir(sid), '.git'))).toBe(true)
    expect(commitSubjects(sid)).toEqual([`artifact: ${FILE_NAME}`])

    const rows = await listArtifacts(sid)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      sessionId: sid,
      name: FILE_NAME,
      title: 'Bar chart',
      path: file,
      versions: 1
    })
    expect(rows[0].updatedAt).toBeGreaterThan(0)

    await until(
      async () => (await sessionToolKeys(app.main)).includes('artifacts'),
      'artifacts toolbar button'
    )
    await panel.open()
    const [row] = await panel.rows()
    expect(row.name).toBe(FILE_NAME)
    expect(row.title).toBe('Bar chart')
    expect(row.meta).toMatch(new RegExp(`^${FILE_NAME.replace('.', '\\.')} · v1( · |$)`))
    expect(row.expanded).toBe(false)
  }, 120_000)

  it('E-2 edit 改它 → 开着的面板自己变成 v2；清单 v2、两次提交；点开 → 预览是改过的内联 svg', async () => {
    const sid = sids.get('artifacts-E1')!
    const file = join(artifactsDir(sid), FILE_NAME)
    provider.reset()
    provider.script(
      {
        toolCalls: [
          {
            id: 'call_edit_e2',
            name: 'edit',
            args: JSON.stringify({
              path: file,
              oldText: '<rect width="10" height="20" fill="var(--viz-1)"/>',
              newText:
                '<rect width="10" height="20" fill="var(--viz-1)"/><rect x="15" width="10" height="12" fill="var(--viz-2)"/>'
            })
          }
        ],
        usage: USAGE
      },
      { text: `MARK-E2 added a second bar.${REF}`, usage: USAGE }
    )
    await chat.typeAndSend('add a second bar E2')
    await chat.waitIdle()

    expect(readFileSync(file, 'utf8')).toContain('x="15"')
    expect(commitSubjects(sid)).toEqual([`edit: ${FILE_NAME}`, `artifact: ${FILE_NAME}`])
    // 面板一直开着、没重开：那一行跟着 artifacts.changed 自己变成 v2
    await until(async () => {
      const [row] = await panel.rows()
      return !!row && / · v2( · |$)/.test(row.meta)
    }, 'artifact row shows v2 without reopening')
    const rows = await listArtifacts(sid)
    expect(rows.map((r) => [r.name, r.versions])).toEqual([[FILE_NAME, 2]])

    await panel.open()
    await panel.expand(FILE_NAME)
    await until(async () => !!(await panel.rows())[0]?.previewSvg, 'inline svg preview')
    const [row] = await panel.rows()
    expect(row.expanded).toBe(true)
    expect(row.meta).toContain('v2')
    expect(row.previewSvg).toEqual({ ariaLabel: 'Bar chart', rects: 2 })

    expect(await autoAllowed(app.main)).toEqual([])
    await shot('artifacts-panel')
    await shot('artifacts-window', true)
  }, 120_000)

  it('E-4 引用钉版本：第一条回复仍是 1 根柱子 + 已有新版；第二条 2 根不标；点「已有新版」→ 面板里亮出最新版', async () => {
    const sid = sids.get('artifacts-E1')!
    const r1 = await replyId(sid, 'MARK-E1')
    const r2 = await replyId(sid, 'MARK-E2')
    expect(r1).toMatch(/^\d+$/)
    expect(r2).toMatch(/^\d+$/)

    // 钉在回复落定之后才写下、渲染端随 artifacts.changed 重取：等两张卡都换成钉住的那一版
    await until(async () => {
      const [a, b] = [await refs.inMessage(r1), await refs.inMessage(r2)]
      return a.svgs[0]?.rects === 1 && a.newer !== null && b.svgs[0]?.rects === 2
    }, 'reply 1 pinned to the 1-bar version with a newer mark, reply 2 at 2 bars')
    const first = await refs.inMessage(r1)
    expect(first).toMatchObject({ present: true, unpinned: null })
    expect(first.svgs).toEqual([{ ariaLabel: 'Bar chart', rects: 1 }])
    expect(first.newer).toBeTruthy()
    expect(await refs.inMessage(r2)).toEqual({
      present: true,
      svgs: [{ ariaLabel: 'Bar chart', rects: 2 }],
      newer: null,
      unpinned: null
    })

    // IPC：第一条钉着改之前的那一版，第二条钉着现在的
    expect(await readRef({ sessionId: sid, name: FILE_NAME, messageId: r1 })).toEqual({
      sessionId: sid,
      name: FILE_NAME,
      title: 'Bar chart',
      content: SVG,
      pinned: true,
      latest: false
    })
    const second = await readRef({ sessionId: sid, name: FILE_NAME, messageId: r2 })
    expect(second).toMatchObject({ sessionId: sid, name: FILE_NAME, pinned: true, latest: true })
    expect(second!.content).toContain('x="15"')
    // 不带 messageId：当前内容
    expect(await readRef({ sessionId: sid, name: FILE_NAME })).toMatchObject({
      pinned: false,
      latest: true,
      content: second!.content
    })

    // 收起面板，看两条回复都在的对话（截图时把第一条的引用块滚到顶上：它的「已有新版」与第二条都在屏）
    await panel.close()
    expect(await panel.shown()).toBe(false)
    if (process.env.ARTIFACTS_E2E_SHOTS) {
      expect(await refs.scrollTo(r1)).toBe(true)
      await sleep(300)
      await shot('artifacts-chat-pinned', true)
    }

    // 点第一条的「已有新版」→ 面板展开到产物页、那一行展开、预览是最新版（2 根）
    expect(await refs.clickNewer(r1)).toBe(true)
    await until(async () => {
      if (!(await panel.shown())) return false
      const [row] = await panel.rows()
      return !!row && row.expanded && row.previewSvg?.rects === 2
    }, 'reveal opens the artifacts tab with the row expanded at the latest version')
    expect(await sessionToolKeys(app.main)).toContain('artifacts')
    const [row] = await panel.rows()
    expect(row).toMatchObject({ name: FILE_NAME, expanded: true })
    expect(row.previewSvg).toEqual({ ariaLabel: 'Bar chart', rects: 2 })
    expect(await autoAllowed(app.main)).toEqual([])
    await shot('artifacts-reveal')
    await shot('artifacts-reveal-window', true)
  }, 120_000)

  it('E-4b 切到别的会话再切回来：第一条回复照旧是钉住的那一版', async () => {
    const sid = sids.get('artifacts-E1')!
    const r1 = await replyId(sid, 'MARK-E1')
    const r2 = await replyId(sid, 'MARK-E2')
    await openSession('artifacts-E3')
    await until(async () => !(await refs.inMessage(r1)).present, 'E1 cards unmounted')
    await openSession('artifacts-E1')
    await until(async () => {
      const [a, b] = [await refs.inMessage(r1), await refs.inMessage(r2)]
      return a.svgs.length > 0 && b.svgs.length > 0 && a.newer !== null
    }, 'E1 reopened with its artifact refs')
    const first = await refs.inMessage(r1)
    expect(first.svgs).toEqual([{ ariaLabel: 'Bar chart', rects: 1 }])
    expect(first.newer).toBeTruthy()
    expect(first.unpinned).toBeNull()
    const second = await refs.inMessage(r2)
    expect(second.svgs).toEqual([{ ariaLabel: 'Bar chart', rects: 2 }])
    expect(second.newer).toBeNull()
  }, 60_000)

  it('E-3 没有产物的会话：工具栏没有 artifacts 按钮', async () => {
    const sid = sids.get('artifacts-E3')!
    await openSession('artifacts-E3')
    expect(await listArtifacts(sid)).toEqual([])
    // 切过来那一刻工具栏还可能是上一场会话的：等它换成这一场的，再给清单请求一点时间落地，看它仍然没有
    await until(async () => {
      const keys = await sessionToolKeys(app.main)
      return keys.includes('files') && !keys.includes('artifacts')
    }, 'session toolbar without artifacts')
    await sleep(800)
    expect(await sessionToolKeys(app.main)).not.toContain('artifacts')
    expect(existsSync(artifactsDir(sid))).toBe(false)
  }, 60_000)
})
