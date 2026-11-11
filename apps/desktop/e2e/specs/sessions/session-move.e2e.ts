/**
 * 搬会话（2026-11-11，docs/project-split-design.md §4）—— `session` 工具的 `move-session` 把别的项目的会话搬进发起调用的
 * 会话所在的项目，整条链路在真实实例里跑一遍：
 *
 *   模型调 `session` 工具（`move-session` + `session_ids`）→ services/sessionMove 逐条判定 → 安全模块的会话客体、
 *   action `move` → 出厂的 ask-on-session-access 第三条规则每次都问 → **一张**卡（「Move sessions into this project」，
 *   列出这次要搬的全部会话；没有「允许并记住」）→ 用户答 → 根会话连同子会话换项目。内置 auto-review 开着，但它跳过
 *   会话客体：这张卡只有人答。
 *
 *   MV-E1  一次点名两条（其中一条带一个子会话）→ 恰一张卡：command 是第一条的 `Session(move, <id>)`，preview 列出两条
 *          与目标项目；界面上的卡片两行、写明换目录、只有 Allow once / Deny → 允许 → 三条会话（两条根 + 一条子会话）都在
 *          新项目里，没点名的原地不动；工具结果逐条列出；决策日志里两条 move 都落在规则 #2 上；审查员不出场
 *   MV-E2  再搬一条，用户拒绝 → 工具结果是「User denied moving session …」，那条会话原地不动
 *   MV-E3  点名一条已经在本项目的、一条子会话 → 不出卡；结果说「已经在了」并给出子会话没搬的原因
 *
 * 模型侧是脚本化的假提供商：调用方的请求里恒有它第一条消息的标记。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import type { AskInputRequest } from '@shuvix/chat-protocol/types/inputRequest'
import { until } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import { startFakeProvider, type FakeProvider, type FakeRequest } from '../../harness/fakeProvider'
import {
  asksRaisedIn,
  createProject,
  eventRecorder,
  isReviewerRequest,
  securityDecisions,
  seedFakeProvider,
  waitRendererReady,
  type EventRecorder,
  type SecurityDecisionEntry
} from '../../harness/seed'
import { syncProbe, type SyncProbe } from '../../harness/sync'
import { chatPane, sidebarPane, type ChatPane, type SidebarPane } from '../../harness/pages'

const MODEL = 'e2e-model'
const FLOW_TIMEOUT = 120_000
const CALLER_TITLE = 'Auth caller'
const MARK = 'MVE-CALLER-MARK'

let app: E2EApp
let provider: FakeProvider
let probe: SyncProbe
let events: EventRecorder
let chat: ChatPane
let sidebar: SidebarPane
let bigId = ''
let authId = ''
let authDir = ''
let caller = ''
let login = ''
let loginChild = ''
let token = ''
let release = ''
let untouched = ''

const isCaller = (r: FakeRequest): boolean => !isReviewerRequest(r) && r.raw.includes(MARK)
const step =
  (text: string) =>
  (r: FakeRequest): boolean =>
    isCaller(r) && r.lastUserText === text

const sessionCall = (
  id: string,
  args: Record<string, unknown>
): { id: string; name: string; args: string } => ({
  id,
  name: 'session',
  args: JSON.stringify(args)
})

const createSession = (opts: {
  title: string
  projectId?: string
  parentId?: string
}): Promise<string> =>
  app.main.eval<string>(`window.api.session.create(${JSON.stringify(opts)}).then((s) => s.id)`)

const projectOf = async (sid: string): Promise<string | null> =>
  (
    await app.main.eval<Array<{ id: string; projectId: string | null }>>(
      `window.api.session.list().then((ss) => ss.map((s) => ({ id: s.id, projectId: s.projectId })))`
    )
  ).find((s) => s.id === sid)?.projectId ?? null

const sendPrompt = (sid: string, text: string): Promise<unknown> =>
  app.main.eval(
    `(() => {
      window.api.agent
        .prompt({ sessionId: ${JSON.stringify(sid)}, text: ${JSON.stringify(text)} })
        .catch(() => undefined)
      return true
    })()`
  )

const waitAssistant = (sid: string, text: string): Promise<unknown> =>
  probe.waitView(
    sid,
    (v) =>
      v.run.state !== 'busy' &&
      v.messages.some((m) => m.role === 'assistant' && m.content.includes(text)),
    60_000,
    `"${text}" in ${sid}`
  )

interface MoveCardShot {
  title: string
  count: string
  project: string
  rows: Array<{ id: string; lines: string[] }>
  folder: string
  policy: string
  buttons: string[]
  rememberSession: boolean
  singleSessionBox: boolean
}

/** 界面上那张搬动的卡（待处理面板里） */
const moveCard = (): Promise<MoveCardShot | null> =>
  app.main.eval<MoveCardShot | null>(`(() => {
    const box = document.querySelector('[data-pending-inputs] [data-ask-session-move]')
    if (!box) return null
    const card = box.closest('[data-ask-card]')
    return {
      title: (card?.querySelector('[data-ask-title]')?.textContent ?? '').trim(),
      count: box.getAttribute('data-ask-session-move') ?? '',
      project: (box.querySelector('[data-ask-session-move-project]')?.textContent ?? '').trim(),
      rows: [...box.querySelectorAll('[data-ask-session-move-row]')].map((row) => ({
        id: row.getAttribute('data-ask-session-move-row') ?? '',
        lines: [...row.children].map((c) => (c.textContent ?? '').trim())
      })),
      folder: (box.querySelector('[data-ask-session-move-folder]')?.textContent ?? '').trim(),
      policy: (card?.querySelector('[data-ask-policy]')?.textContent ?? '').trim(),
      buttons: [...(card?.querySelectorAll('[data-ask-option]') ?? [])].map((row) =>
        (row.querySelector('[data-option-label]')?.textContent ?? '').trim()
      ),
      rememberSession: !!card?.querySelector('[data-remember-session]'),
      singleSessionBox: !!card?.querySelector('[data-ask-session]')
    }
  })()`)

const pickOption = async (id: 'allow' | 'deny'): Promise<void> => {
  const ok = await app.main.eval<boolean>(`(() => {
    const btn = document
      .querySelector('[data-pending-inputs] [data-ask-session-move]')
      ?.closest('[data-ask-card]')
      ?.querySelector('[data-ask-option="${id}"]')
    if (!btn) return false
    btn.click()
    return true
  })()`)
  if (!ok) throw new Error(`move card: no "${id}" option`)
}

const moveDecisions = (): SecurityDecisionEntry[] =>
  securityDecisions(app).filter(
    (d) => d.sessionId === caller && d.objectKind === 'session' && d.action === 'move'
  )

beforeAll(async () => {
  // 内置 auto-review 开着（产品缺省）：搬动的询问要证明它不出场
  app = await launchApp({ autoReview: true })
  provider = await startFakeProvider()
  await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  await waitRendererReady(app.main)
  await app.main.eval(`window.api.settings.set({ key: 'general.language', value: 'en' })`)

  const bigDir = join(app.home, 'proj-move-big')
  authDir = join(app.home, 'proj-move-auth')
  for (const dir of [bigDir, authDir]) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'README.md'), '# move\n')
  }
  bigId = (await createProject(app.main, { name: 'BigProj', path: bigDir })).id
  authId = (await createProject(app.main, { name: 'AuthProj', path: authDir })).id

  login = await createSession({ title: 'Login work', projectId: bigId })
  loginChild = await createSession({ title: 'Login child', projectId: bigId, parentId: login })
  token = await createSession({ title: 'Token work', projectId: bigId })
  release = await createSession({ title: 'Release work', projectId: bigId })
  untouched = await createSession({ title: 'Stays behind', projectId: bigId })
  caller = await createSession({ title: CALLER_TITLE, projectId: authId })

  chat = chatPane(app.main)
  sidebar = sidebarPane(app.main)
  events = eventRecorder(app.main)
  await events.install()
  probe = syncProbe(app.main)
  await probe.install()

  await until(
    async () => (await sidebar.titles()).includes(CALLER_TITLE),
    `sidebar lists "${CALLER_TITLE}"`
  )
  await until(
    async () => (await sidebar.openSession(CALLER_TITLE)) || null,
    `"${CALLER_TITLE}" opened`
  )
  await chat.ready()
}, 60_000)

afterAll(async () => {
  await provider?.close()
  await app?.stop()
})

describe('session move', () => {
  it(
    'MV-E1 move-session with two ids → one card listing both, no "allow and remember" → Allow once → both sessions and the sub-session are in the caller\'s project; the reviewer never runs',
    async () => {
      const M1 = `${MARK} bring the login and token sessions over`
      provider.reset()
      await events.clear()
      provider.script(
        {
          toolCalls: [
            sessionCall('call_mv1', { action: 'move-session', session_ids: [login, token] })
          ],
          when: step(M1)
        },
        { text: 'MVE1-DONE', when: step(M1) }
      )
      await sendPrompt(caller, M1)

      // 1. 询问：会话客体、action move；一张卡带着整批
      const ask = (await probe.nextAsk(caller)) as AskInputRequest
      expect(ask.kind).toBe('ask')
      expect(ask.toolName).toBe('session')
      expect(ask.command).toBe(`Session(move, ${login})`)
      expect(ask.session).toEqual({
        sessionId: login,
        title: 'Login work',
        access: 'move',
        operation: 'move-session'
      })
      expect(ask.preview).toEqual({
        kind: 'session-move',
        project: { name: 'AuthProj', path: authDir },
        sessions: [
          {
            id: login,
            title: 'Login work',
            fromProject: 'BigProj',
            fromPath: join(app.home, 'proj-move-big'),
            subSessions: 1
          },
          {
            id: token,
            title: 'Token work',
            fromProject: 'BigProj',
            fromPath: join(app.home, 'proj-move-big'),
            subSessions: 0
          }
        ]
      })
      expect(ask.policyPrompt?.text).toContain('moves another session')

      // 2. 界面上的卡片
      const card = await until(() => moveCard(), 'move card on screen')
      expect(card).toEqual({
        title: en.toolCall.sessionAskMove,
        count: '2',
        project: 'Into project “AuthProj”',
        rows: [
          { id: login, lines: ['Login work', 'from “BigProj” · +1 sub-session'] },
          { id: token, lines: ['Token work', 'from “BigProj”'] }
        ],
        folder: `Sessions that come from another folder will work in ${authDir} from now on, and their system prompts are rebuilt.`,
        policy: 'Ask Before Using Another Session',
        buttons: [en.toolCall.askAllowOnce, en.toolCall.deny],
        rememberSession: false,
        singleSessionBox: false
      })
      // 审查员不出场；卡片还开着，一条都没搬
      expect(provider.requests().filter(isReviewerRequest)).toEqual([])
      expect(await projectOf(login)).toBe(bigId)

      // 3. 允许 → 整批搬过来，只问过这一次
      await pickOption('allow')
      await probe.waitAskGone(caller, ask.id)
      await waitAssistant(caller, 'MVE1-DONE')
      const result = await probe.waitToolResult(caller, 'call_mv1', 60_000)
      expect(result.isError).toBe(false)
      expect(result.result).toContain('Moved into project "AuthProj":')
      expect(result.result).toContain(
        `<session id="${login}" title="Login work" from-project="BigProj" sub-sessions="1"/>`
      )
      expect(result.result).toContain(
        `<session id="${token}" title="Token work" from-project="BigProj" sub-sessions="0"/>`
      )
      expect(result.result).toContain(`the working folder is now ${authDir}.`)

      expect(await projectOf(login)).toBe(authId)
      expect(await projectOf(loginChild)).toBe(authId)
      expect(await projectOf(token)).toBe(authId)
      expect(await projectOf(untouched)).toBe(bigId)
      expect(await projectOf(release)).toBe(bigId)
      expect(await asksRaisedIn(events, caller)).toBe(1)

      // 4. 决策日志：两条会话各一笔 move，都落在第三条规则上，都是人答的
      const decisions = await until(
        () => (moveDecisions().length >= 2 ? moveDecisions() : null),
        'two move decisions logged'
      )
      expect(decisions.map((d) => [d.objectSummary, d.winning, d.userResponse])).toEqual([
        [`session ${login}`, 'ask-on-session-access#2', 'allowed'],
        [`session ${token}`, 'ask-on-session-access#2', 'allowed']
      ])
      expect(decisions.every((d) => d.review === undefined)).toBe(true)
      expect(provider.requests().filter(isReviewerRequest)).toEqual([])
    },
    FLOW_TIMEOUT
  )

  it(
    'MV-E2 the user denies → "User denied moving session …", the session stays where it was',
    async () => {
      const M2 = `${MARK} and the release one`
      provider.reset()
      provider.script(
        {
          toolCalls: [sessionCall('call_mv2', { action: 'move-session', session_ids: [release] })],
          when: step(M2)
        },
        { text: 'MVE2-DONE', when: step(M2) }
      )
      await sendPrompt(caller, M2)
      const ask = (await probe.nextAsk(caller)) as AskInputRequest
      expect(ask.command).toBe(`Session(move, ${release})`)
      await until(() => moveCard(), 'move card on screen')
      await pickOption('deny')
      await probe.waitAskGone(caller, ask.id)
      await waitAssistant(caller, 'MVE2-DONE')
      const result = await probe.waitToolResult(caller, 'call_mv2', 60_000)
      expect(result.isError).toBe(true)
      expect(result.result).toContain(`User denied moving session "Release work" (${release})`)
      expect(await projectOf(release)).toBe(bigId)
    },
    FLOW_TIMEOUT
  )

  it(
    'MV-E3 a session already here and a sub-session → no card; the result says which is already here and why the other was not moved',
    async () => {
      const M3 = `${MARK} move these two as well`
      provider.reset()
      await events.clear()
      provider.script(
        {
          toolCalls: [
            sessionCall('call_mv3', { action: 'move-session', session_ids: [token, loginChild] })
          ],
          when: step(M3)
        },
        { text: 'MVE3-DONE', when: step(M3) }
      )
      await sendPrompt(caller, M3)
      await waitAssistant(caller, 'MVE3-DONE')
      const result = await probe.waitToolResult(caller, 'call_mv3', 60_000)
      expect(result.isError).toBe(false)
      expect(result.result).toContain(`Already in this project: "Token work" (${token}).`)
      expect(result.result).toContain('Not moved:')
      expect(result.result).toContain(
        `- "Login child" (${loginChild}): It is a sub-session of "Login work" (${login}).`
      )
      expect(await asksRaisedIn(events, caller)).toBe(0)
    },
    FLOW_TIMEOUT
  )
})
