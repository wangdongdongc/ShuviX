/**
 * 组件的 API，一条真的链路（2026-10-27，docs/widget-tool-design.md §2 / §4 / §5 / §7 / §20）—— 一个 API，两个调用方：
 *
 *   会话 A 的 agent 经 `widget` 工具造一个组件（create → write api.ts / schema.sql / index.tsx → build → sql 建表）；
 *   组件开在 Widget 面板里（界面经 `shuvix/widget` 的 `api.use` / `api.call` 调自己的 API，调用方是用户）；会话 B 的 agent
 *   调同一个写操作 → 出厂的 ask-on-widget-access 弹「更改组件」卡 → 用户点「允许，并记住」→ 权限表一行 `kind:'widget'`
 *   → 写提交后服务端在 SSE 上推 `data`，开着的界面不重载就重取；用户在界面里经同一个操作写的那一条，B 的 agent 调读操作读得到；
 *   B 的会话设置里「组件访问」卡列着它；预览的页面按发起预览的那条会话的授权判（不是用户的身份）。
 *
 *   WA-E1 A 造组件：create（不问；A 得到读写，来源 widget）→ 写进组件目录的三个文件不问（读写授权派生出目录的写）→ build
 *         （三个操作、提交）→ sql 建表 → list 里 access="read-write"、写着纯界面的那个 → dry_run 的 addNote 交回那一行、
 *         回滚（之后 listNotes 是 []）；整轮一张卡都没有
 *   WA-E2 组件开在 Widget 面板里（空列表）；B 的 agent 调 addNote → 「更改组件」卡（组件名 / id / 操作，三行：允许一次 /
 *         允许并记住读写 / 拒绝；策略角标）→ 审查员不出场 → 卡还开着时一行都没写 → 用户点「允许，并记住」→ 权限表恰一行
 *         widget / write / user → 工具结果是新那一行（added_by 是 B 的 agent）→ 面板里的页面没重载就显示出它
 *   WA-E3 用户在组件页面里点「添加」（同一个 addNote，调用方是用户）→ 页面显示它 → B 的 agent 调读操作 listNotes 不问
 *         （读写包含读）→ 结果里有 B 那一条与用户那一条（added_by user）
 *   WA-E4 B 的会话设置「组件访问」卡：一行（名字、id、读写选中）；A 的那张卡也有它（造它的会话）；B 切到只读 → 权限表跟着变
 *   WA-E5 预览的页面按发起预览的会话判（只判不问）：A（读写）预览 → 页面的读与纯界面的写都成；B（只读）预览 → 不问、页面读得到，
 *         写被拒（not_authorized）
 *
 * 模型侧是脚本化的假提供商，每个回合按「这一轮的提示词」认领（工具结果里的图另起的那条用户消息不算）；内置 auto-review 开着
 * （产品缺省）—— 组件询问它不答，所以一次都不该被派出。A / B 都在一个项目里（根档案 work：有 widget 工具、也有 widget 技能）。
 * 组件页面在 Widget 面板的跨源 iframe 里，自己有一个 CDP target（`iframe`）：页面里的点击与读数经它。
 *
 * 不在这里的：界面经 `api.call` 遇到的失败形状（单测）、远程浏览器里的 `/w/` 转发（network/web-fallbacks）、
 * 子会话 / 分支复制授权（单测）、拒绝那一行（与会话访问同一条路径，session-access 覆盖）。
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import type { AskInputRequest } from '@shuvix/chat-protocol/types/inputRequest'
import { connect, listTargets, until, type CdpClient } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import {
  startFakeProvider,
  userTextsOf,
  type FakeProvider,
  type FakeRequest,
  type FakeTurn
} from '../../harness/fakeProvider'
import {
  asksRaisedIn,
  createProject,
  eventRecorder,
  isReviewerRequest,
  securityDecisions,
  seedFakeProvider,
  sqlLit,
  sqliteJson,
  waitRendererReady,
  type EventRecorder,
  type SecurityDecisionEntry
} from '../../harness/seed'
import { syncProbe, type SyncProbe, type ToolResult } from '../../harness/sync'
import {
  chatPane,
  rightPanelPane,
  sessionConfigPane,
  sidebarPane,
  widgetAccessPane,
  widgetAskPane,
  widgetPanelPane,
  type ChatPane,
  type SessionConfigPane,
  type SidebarPane,
  type WidgetAccessPane,
  type WidgetAskPane,
  type WidgetPanelPane
} from '../../harness/pages'

const MODEL = 'e2e-model'
const USAGE = { prompt: 120, completion: 8 }
const FLOW_TIMEOUT = 150_000

const A_TITLE = 'Widget builder A'
const B_TITLE = 'Widget user B'
/** A / B 第一条消息里的标记：它们之后的每个请求里都有（历史），另一条会话的请求里永远没有 */
const A_MARK = 'WAE-ALPHA-BUILDER'
const B_MARK = 'WAE-BRAVO-USER'
/** 出厂 ask-on-widget-access 的英文显示名（md 的 shuvix-displayName）—— 卡片上的策略角标 */
const POLICY_DISPLAY_NAME = 'Ask Before Using a Widget'
/** pi-ai 把工具结果里的图另起一条用户消息发给模型，开头是这一句（它不是用户说的话） */
const ATTACHED = 'Attached image(s) from tool result:'

const WIDGET = 'wa-notes'
const NAME = 'WA Notes'
const DESCRIPTION = 'Short notes kept for the widget API e2e.'
const B_NOTE = 'WA-NOTE-FROM-AGENT-B'
const USER_NOTE = 'WA-NOTE-FROM-USER'

// ─── 组件的源码（由 A 的 agent 写进组件目录） ───────────────────

const API_TS = `import { defineApi, op, z } from 'shuvix/widget-api'

const Note = z.object({ id: z.number(), text: z.string(), addedBy: z.string() })

export default defineApi({
  listNotes: op.read({
    description: 'List the notes, oldest first.',
    input: z.object({}),
    output: z.array(Note),
    handler: (_args, ctx) =>
      ctx.db.sql\`SELECT id, text, added_by AS addedBy FROM notes ORDER BY id\`
  }),
  addNote: op.write({
    description: 'Add a note. Returns the note.',
    input: z.object({ text: z.string().min(1) }),
    output: Note,
    async handler({ text }, ctx) {
      const [row] = await ctx.db.sql\`
        INSERT INTO notes (text, added_by) VALUES (\${text}, \${ctx.caller.label})
        RETURNING id, text, added_by AS addedBy\`
      return row
    }
  }),
  noteVisit: op.write({
    agent: false,
    description: 'Count one visit of the screen.',
    input: z.object({}),
    handler: (_args, ctx) => ctx.db.run\`INSERT INTO visits (who) VALUES (\${ctx.caller.label})\`
  })
})
`

const SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY,
  text TEXT NOT NULL,
  added_by TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS visits (
  id INTEGER PRIMARY KEY,
  who TEXT NOT NULL
);
`

/**
 * 界面：`api.use` 列出笔记（写入提交后自己重取）、「添加」按钮经 `api.call` 写一条；挂上时调一次纯界面的写操作。
 * console.error 的两行（WA-VISIT / WA-LIST）是给预览带回 errors 用的：预览只收页面的错误输出
 */
const SCREEN_TSX = `import { createRoot } from 'react-dom/client'
import { useEffect, useState } from 'react'
import { createClient, WidgetError } from 'shuvix/widget'
import type Api from './api'

const api = createClient<typeof Api>()

const codeOf = (e: unknown): string => (e instanceof WidgetError ? e.code : String(e))

function Notes() {
  const { data } = api.use('listNotes', {})
  const [status, setStatus] = useState('')
  useEffect(() => {
    api.call('noteVisit', {}).then(
      () => console.error('WA-VISIT ok'),
      (e: unknown) => console.error('WA-VISIT ' + codeOf(e))
    )
  }, [])
  useEffect(() => {
    if (data) console.error('WA-LIST ' + data.map((n) => n.text).join('|'))
  }, [data])
  const add = () => {
    api.call('addNote', { text: ${JSON.stringify(USER_NOTE)} }).then(
      () => setStatus('added'),
      (e: unknown) => setStatus('failed ' + codeOf(e))
    )
  }
  return (
    <div style={{ padding: 8 }}>
      <ul data-notes="">
        {(data ?? []).map((n) => (
          <li key={n.id} data-note={n.text} data-by={n.addedBy}>
            {n.text}
          </li>
        ))}
      </ul>
      <button data-add="" onClick={add}>
        Add
      </button>
      <span data-status="">{status}</span>
    </div>
  )
}

const root = document.getElementById('root')
if (root) createRoot(root).render(<Notes />)
`

interface AclRow {
  kind: string
  target: string
  access: string
  source: string
  sourceKey: string
}

interface NoteRow {
  id: number
  text: string
  addedBy: string
}

let app: E2EApp
let provider: FakeProvider
let probe: SyncProbe
let events: EventRecorder
let chat: ChatPane
let sidebar: SidebarPane
let config: SessionConfigPane
let access: WidgetAccessPane
let widgetAsk: WidgetAskPane
let panel: WidgetPanelPane
let frame: CdpClient | null = null
let projectId = ''
let aSid = ''
let bSid = ''

// ─── 小助手 ──────────────────────────────────────

const notReviewer = (r: FakeRequest): boolean => !isReviewerRequest(r)
/** 这次请求属于哪一轮：最后一条真正的用户消息（工具结果里的图另起的那条不算） */
const lastPrompt = (r: FakeRequest): string =>
  userTextsOf(r)
    .filter((t) => !t.startsWith(ATTACHED))
    .at(-1) ?? ''
/** 某条会话的某一轮（工具结果回来之后的那些请求同样认它） */
const stepOf =
  (mark: string) =>
  (prompt: string) =>
  (r: FakeRequest): boolean =>
    notReviewer(r) && r.raw.includes(mark) && lastPrompt(r) === prompt
const stepA = stepOf(A_MARK)
const stepB = stepOf(B_MARK)

const reviewerRequests = (): FakeRequest[] => provider.requests().filter(isReviewerRequest)

const widgetCall = (
  id: string,
  args: Record<string, unknown>
): { id: string; name: string; args: string } => ({
  id,
  name: 'widget',
  args: JSON.stringify(args)
})

const widgetDir = (): string => join(app.home, '.shuvix', 'widgets', WIDGET)

/** 发一条用户消息、不等它（这一轮可能停在卡片上） */
const sendPrompt = (sid: string, text: string): Promise<unknown> =>
  app.main.eval(
    `(() => {
      window.api.agent
        .prompt({ sessionId: ${JSON.stringify(sid)}, text: ${JSON.stringify(text)} })
        .catch(() => undefined)
      return true
    })()`
  )

/** 等这条会话的转写里出现某段助手正文、且这一轮落定 */
const waitAssistant = (sid: string, text: string): Promise<unknown> =>
  probe.waitView(
    sid,
    (v) =>
      v.run.state !== 'busy' &&
      v.messages.some((m) => m.role === 'assistant' && m.content.includes(text)),
    90_000,
    `"${text}" in ${sid}`
  )

const resultOf = (sid: string, callId: string): Promise<ToolResult> =>
  probe.waitToolResult(sid, callId, 60_000)

/** 一个成功的工具结果的正文 */
const okText = async (sid: string, callId: string): Promise<string> => {
  const r = await resultOf(sid, callId)
  expect(r.isError, `${callId}: ${r.result}`).toBe(false)
  return r.result
}

/** 调用的结果正文里的 JSON（`call` 把返回值按 JSON 给出，可能后面跟着说明行） */
const jsonOf = <T>(text: string): T => {
  const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'))
  return JSON.parse(text.slice(0, end + 1)) as T
}

/** 调用方权限表里组件种类的行（直接读库：「允许并记住」写下的就是这里） */
const widgetRows = (sid: string): AclRow[] =>
  sqliteJson<AclRow>(
    app.home,
    `SELECT kind, target, access, source, sourceKey FROM session_acl WHERE sessionId = ${sqlLit(sid)} AND kind = 'widget'`
  )

const decisionsOf = (sid: string): SecurityDecisionEntry[] =>
  securityDecisions(app).filter((d) => d.sessionId === sid && d.objectKind === 'widget')

/** 下一张询问卡（会话视图里的询问；组件询问恒是 ask） */
const nextAsk = async (sid: string): Promise<AskInputRequest> => {
  const req = await probe.nextAsk(sid, 60_000)
  expect(req.kind).toBe('ask')
  return req as AskInputRequest
}

const openInUi = async (title: string): Promise<void> => {
  await until(async () => (await sidebar.titles()).includes(title), `sidebar lists "${title}"`)
  await until(async () => (await sidebar.openSession(title)) || null, `"${title}" opened`)
  await chat.ready()
}

/** 打开某条会话的设置弹窗做一段事，**总是**关上 */
const withConfig = async (title: string, body: () => Promise<void>): Promise<void> => {
  await sidebar.pickRowMenu(title, 'session-config')
  await config.waitOpen()
  try {
    await body()
  } finally {
    await config.close()
  }
}

const createSession = (title: string): Promise<string> =>
  app.main.eval<string>(
    `window.api.session.create(${JSON.stringify({ title, projectId })}).then((s) => s.id)`
  )

// ─── 组件页面（Widget 面板里的 iframe，自己的 CDP target） ─────────

/** 组件页面里的笔记（DOM 序） */
const pageNotes = (): Promise<Array<{ text: string; by: string }>> =>
  frame!.eval<Array<{ text: string; by: string }>>(
    `[...document.querySelectorAll('[data-note]')].map((li) => ({
      text: li.getAttribute('data-note') ?? '',
      by: li.getAttribute('data-by') ?? ''
    }))`
  )

const pageStatus = (): Promise<string> =>
  frame!.eval<string>(`document.querySelector('[data-status]')?.textContent ?? ''`)

/** 页面里那个只在 spec 里设的记号还在 = 同一个文档，没有重载 */
const pageNotReloaded = (): Promise<boolean> => frame!.eval<boolean>(`window.__waMark === 'kept'`)

beforeAll(async () => {
  // 内置 auto-review 开着（产品缺省）：组件询问要证明它不出场
  app = await launchApp({ autoReview: true })
  provider = await startFakeProvider()
  await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  await waitRendererReady(app.main)
  await app.main.eval(`window.api.settings.set({ key: 'general.language', value: 'en' })`)

  const projDir = join(app.home, 'proj-widget-api')
  mkdirSync(projDir, { recursive: true })
  projectId = (await createProject(app.main, { name: 'WidgetApiProj', path: projDir })).id
  bSid = await createSession(B_TITLE)
  aSid = await createSession(A_TITLE)

  chat = chatPane(app.main)
  sidebar = sidebarPane(app.main)
  config = sessionConfigPane(app.main)
  access = widgetAccessPane(app.main)
  widgetAsk = widgetAskPane(app.main)
  panel = widgetPanelPane(app.main)
  events = eventRecorder(app.main)
  await events.install()
  probe = syncProbe(app.main)
  await probe.install()
}, 90_000)

afterAll(async () => {
  frame?.close()
  await provider?.close()
  await app?.stop()
})

describe('widget API: one API, two callers', () => {
  it(
    'WA-E1 A builds the widget through the tool: create, write its files, build, create its tables, list, a dry run that rolls back — no card at all',
    async () => {
      provider.reset()
      await events.clear()
      const A1 = `${A_MARK} build me a notes widget`
      const dir = widgetDir()
      const step = stepA(A1)
      const write = (id: string, file: string, content: string): FakeTurn => ({
        toolCalls: [
          { id, name: 'write', args: JSON.stringify({ path: join(dir, file), content }) }
        ],
        when: step,
        usage: USAGE
      })
      provider.script(
        {
          toolCalls: [
            widgetCall('call_a_create', {
              action: 'create',
              widget: WIDGET,
              name: NAME,
              description: DESCRIPTION
            })
          ],
          when: step,
          usage: USAGE
        },
        write('call_a_api', 'api.ts', API_TS),
        write('call_a_schema', 'schema.sql', SCHEMA_SQL),
        write('call_a_screen', 'index.tsx', SCREEN_TSX),
        {
          toolCalls: [
            widgetCall('call_a_build', { action: 'build', widget: WIDGET, message: 'feat: notes' })
          ],
          when: step,
          usage: USAGE
        },
        {
          toolCalls: [widgetCall('call_a_sql', { action: 'sql', widget: WIDGET, sql: SCHEMA_SQL })],
          when: step,
          usage: USAGE
        },
        { toolCalls: [widgetCall('call_a_list', { action: 'list' })], when: step, usage: USAGE },
        {
          toolCalls: [
            widgetCall('call_a_dry', {
              action: 'call',
              widget: WIDGET,
              op: 'addNote',
              args: { text: 'WA-DRY-RUN' },
              dry_run: true
            })
          ],
          when: step,
          usage: USAGE
        },
        {
          toolCalls: [
            widgetCall('call_a_read', { action: 'call', widget: WIDGET, op: 'listNotes' })
          ],
          when: step,
          usage: USAGE
        },
        { text: 'WA-A1-DONE', when: step, usage: USAGE }
      )
      const mark = await events.mark()
      await sendPrompt(aSid, A1)
      await waitAssistant(aSid, 'WA-A1-DONE')

      // create：A 得到读写（来源 widget），组件目录
      expect(await okText(aSid, 'call_a_create')).toContain(`Created widget "${WIDGET}" in ${dir}.`)
      expect(widgetRows(aSid)).toEqual([
        { kind: 'widget', target: WIDGET, access: 'write', source: 'widget', sourceKey: WIDGET }
      ])
      // 三个文件写进组件目录：读写授权派生出目录的写，没问
      for (const id of ['call_a_api', 'call_a_schema', 'call_a_screen']) {
        expect(await okText(aSid, id)).toMatch(/^Wrote \d+ bytes to /)
      }
      // build：三个操作生效、提交了
      const built = await okText(aSid, 'call_a_build')
      expect(built).toMatch(new RegExp(`^Built "${WIDGET}"\\. Committed [0-9a-f]{7}\\.`))
      expect(built).toContain('addNote (write)')
      expect(built).toContain('listNotes (read)')
      expect(built).toContain('noteVisit (write, screen only)')
      // sql 建表
      await okText(aSid, 'call_a_sql')
      // list：读写、纯界面的那个写着（造组件的 agent 看得到）
      const listed = await okText(aSid, 'call_a_list')
      expect(listed).toContain(`<widget id="${WIDGET}" name="${NAME}" access="read-write"`)
      expect(listed).toContain('- listNotes (read): List the notes, oldest first.')
      expect(listed).toContain('- addNote (write): Add a note.')
      expect(listed).toContain('- noteVisit (write, screen only): Count one visit of the screen.')
      // dry run：交回那一行，写的都回滚了
      const dry = await okText(aSid, 'call_a_dry')
      expect(jsonOf<NoteRow>(dry)).toMatchObject({ text: 'WA-DRY-RUN' })
      expect(dry).toContain('(dry run: everything it wrote was rolled back)')
      expect(jsonOf<NoteRow[]>(await okText(aSid, 'call_a_read'))).toEqual([])

      // 整轮一张卡都没有，审查员也没出场
      expect(await asksRaisedIn(events, aSid, mark)).toBe(0)
      expect(reviewerRequests()).toEqual([])
    },
    FLOW_TIMEOUT
  )

  it(
    'WA-E2 B calls the write operation → the "Change a widget" card (only the user answers) → Allow and remember → one widget row; the page open in the Widget panel shows the new note without a reload',
    async () => {
      provider.reset()
      await events.clear()
      // 1. 组件开在 Widget 面板里：空列表
      await openInUi(B_TITLE)
      await until(
        () => app.main.eval<boolean>(`!!document.querySelector('button[data-side="right"]')`),
        'the right panel toggle'
      )
      const right = rightPanelPane(app.main)
      await right.open()
      await right.activateWidgetTab()
      await panel.reload()
      await until(async () => (await panel.cardIds()).includes(WIDGET) || null, 'the widget card')
      await panel.clickCard(WIDGET)
      await until(async () => (await panel.foregroundApp()) === WIDGET || null, 'opened in panel')
      await until(() => panel.frameReady(WIDGET), 'the widget iframe')
      const stamp = await panel.frameStamp(WIDGET)
      const target = await until(
        async () =>
          (await listTargets(app.port)).find(
            (t) => t.type === 'iframe' && t.url.includes(`/w/${WIDGET}/`)
          ),
        'the widget iframe target',
        30_000
      )
      frame = await connect(target.webSocketDebuggerUrl)
      await until(
        () => frame!.eval<boolean>(`!!document.querySelector('[data-notes]')`),
        'the widget screen mounted',
        30_000
      )
      expect(await pageNotes()).toEqual([])
      await frame.eval(`(window.__waMark = 'kept', true)`)

      // 2. B 的 agent 调写操作 → 卡
      const B1 = `${B_MARK} add a note to the notes widget`
      provider.script(
        {
          toolCalls: [
            widgetCall('call_b_add', {
              action: 'call',
              widget: WIDGET,
              op: 'addNote',
              args: { text: B_NOTE }
            })
          ],
          when: stepB(B1),
          usage: USAGE
        },
        { text: 'WA-B1-DONE', when: stepB(B1), usage: USAGE }
      )
      await sendPrompt(bSid, B1)
      const ask = await nextAsk(bSid)
      expect(ask.command).toBe(`Widget(write, ${WIDGET})`)
      expect(ask.widget).toEqual({
        widgetId: WIDGET,
        name: NAME,
        access: 'write',
        operation: 'addNote'
      })
      const card = await until(() => widgetAsk.shot(), 'widget ask card on screen')
      expect(card).toEqual({
        title: en.toolCall.widgetAskWrite,
        widgetId: WIDGET,
        name: NAME,
        idText: WIDGET,
        operation: 'addNote',
        policy: POLICY_DISPLAY_NAME,
        options: [
          { id: 'allow', label: en.toolCall.askAllowOnce, remember: null },
          { id: 'remember-widget', label: en.toolCall.askRememberWidgetWrite, remember: 'write' },
          { id: 'deny', label: en.toolCall.deny, remember: null }
        ]
      })
      // 审查员不出场：组件询问只有人答；卡还开着时什么都没写
      expect(reviewerRequests()).toEqual([])
      expect(widgetRows(bSid)).toEqual([])
      expect(await pageNotes()).toEqual([])

      // 3. 允许并记住 → 权限表恰一行
      await widgetAsk.pick('remember-widget')
      await probe.waitAskGone(bSid, ask.id)
      expect(widgetRows(bSid)).toEqual([
        { kind: 'widget', target: WIDGET, access: 'write', source: 'user', sourceKey: '' }
      ])
      await waitAssistant(bSid, 'WA-B1-DONE')
      const added = jsonOf<NoteRow>(await okText(bSid, 'call_b_add'))
      expect(added).toMatchObject({ text: B_NOTE })
      expect(added.addedBy).toMatch(/^shuvix-work\//)

      // 决策日志：出厂组件策略的写那一条问了，人答「允许并记住」，没有审查结论
      const decisions = await until(
        () => (decisionsOf(bSid).some((d) => d.userResponse) ? decisionsOf(bSid) : null),
        'widget decision logged'
      )
      const asked = decisions.find((d) => d.effect === 'ask')
      expect(asked).toMatchObject({
        action: 'write',
        objectKind: 'widget',
        winning: 'ask-on-widget-access#1',
        userResponse: 'allowed_remember'
      })
      expect(asked?.review).toBeUndefined()

      // 4. 开着的页面没重载就重取出了它（SSE 的 data）
      await until(
        async () => (await pageNotes()).some((n) => n.text === B_NOTE) || null,
        'the open page shows the agent’s note',
        30_000
      )
      expect(await pageNotes()).toEqual([{ text: B_NOTE, by: added.addedBy }])
      expect(await pageNotReloaded()).toBe(true)
      expect(await panel.frameStamp(WIDGET)).toBe(stamp)
      expect(reviewerRequests()).toEqual([])
    },
    FLOW_TIMEOUT
  )

  it(
    'WA-E3 the user adds a note in the widget page through the same operation; B’s agent reads it with the read operation, without asking',
    async () => {
      provider.reset()
      // 1. 用户在页面里点「添加」：调用方是用户
      await frame!.eval(`(document.querySelector('[data-add]').click(), true)`)
      await until(async () => (await pageStatus()) === 'added' || null, 'the page says added')
      await until(
        async () => (await pageNotes()).some((n) => n.text === USER_NOTE) || null,
        'the page lists the user’s note'
      )
      expect((await pageNotes()).find((n) => n.text === USER_NOTE)?.by).toBe('user')
      expect(await pageNotReloaded()).toBe(true)

      // 2. B 的 agent 调读操作：读写包含读，不问
      const B2 = 'WA-B2 what notes are there?'
      provider.script(
        {
          toolCalls: [
            widgetCall('call_b_list', { action: 'call', widget: WIDGET, op: 'listNotes' })
          ],
          when: stepB(B2),
          usage: USAGE
        },
        { text: 'WA-B2-DONE', when: stepB(B2), usage: USAGE }
      )
      const mark = await events.mark()
      const decided = decisionsOf(bSid).length
      await sendPrompt(bSid, B2)
      await waitAssistant(bSid, 'WA-B2-DONE')
      expect(await asksRaisedIn(events, bSid, mark)).toBe(0)
      const notes = jsonOf<NoteRow[]>(await okText(bSid, 'call_b_list'))
      expect(notes.map((n) => n.text)).toEqual([B_NOTE, USER_NOTE])
      expect(notes[0].addedBy).toMatch(/^shuvix-work\//)
      expect(notes[1].addedBy).toBe('user')
      // 门照样过了一次，按权限表放行、没有人的回答
      const allowed = await until(
        () => decisionsOf(bSid).slice(decided)[0] ?? null,
        'the read decision logged'
      )
      expect(allowed).toMatchObject({ action: 'read', objectKind: 'widget', effect: 'allow' })
      expect(allowed.userResponse).toBeUndefined()
    },
    FLOW_TIMEOUT
  )

  it(
    'WA-E4 Session settings → Widget access lists the widget for B (read & write) and for A, its creator; B switched to read-only reaches the permission table',
    async () => {
      await withConfig(B_TITLE, async () => {
        await until(() => access.present(bSid), 'Widget access section for B')
        expect(await access.sectionTitle(bSid)).toBe(en.sessionAcl.widgetsTitle)
        expect(await access.rows(bSid)).toEqual([
          expect.objectContaining({
            target: WIDGET,
            title: NAME,
            idText: WIDGET,
            access: 'write',
            selectedLabel: en.sessionAcl.widgetWrite
          })
        ])
        await access.setAccess(bSid, WIDGET, 'read')
        await until(
          async () => (await access.rows(bSid))[0]?.access === 'read' || null,
          'B’s row shows read'
        )
        expect((await access.rows(bSid))[0].selectedLabel).toBe(en.sessionAcl.widgetRead)
      })
      await until(
        () => widgetRows(bSid)[0]?.access === 'read' || null,
        'B’s row is read-only in the permission table'
      )
      expect(widgetRows(bSid)).toEqual([
        { kind: 'widget', target: WIDGET, access: 'read', source: 'user', sourceKey: '' }
      ])

      await withConfig(A_TITLE, async () => {
        await until(() => access.present(aSid), 'Widget access section for A')
        expect(await access.rows(aSid)).toEqual([
          expect.objectContaining({ target: WIDGET, title: NAME, access: 'write' })
        ])
      })
    },
    FLOW_TIMEOUT
  )

  it(
    'WA-E5 a preview page runs as the previewing session: A (read & write) — its read and its screen-only write both work; B (read only) — not asked, reads, the write is refused',
    async () => {
      provider.reset()
      await events.clear()
      const previewTurn = (
        step: (prompt: string) => (r: FakeRequest) => boolean,
        prompt: string,
        callId: string,
        done: string
      ): void =>
        provider.script(
          {
            toolCalls: [
              widgetCall(callId, { action: 'preview', widget: WIDGET, sizes: ['panel'] })
            ],
            when: step(prompt),
            usage: USAGE
          },
          { text: done, when: step(prompt), usage: USAGE }
        )
      const errorsOf = (text: string): string[] => {
        const m = /<errors>\n([\s\S]*?)\n<\/errors>/.exec(text)
        return m ? m[1].split('\n') : []
      }
      const list = `[panel] WA-LIST ${B_NOTE}|${USER_NOTE}`

      // A：读写 —— 页面的读与纯界面的写都成
      const A2 = 'WA-A2 preview the widget'
      previewTurn(stepA, A2, 'call_a_preview', 'WA-A2-DONE')
      await sendPrompt(aSid, A2)
      await waitAssistant(aSid, 'WA-A2-DONE')
      const aText = await okText(aSid, 'call_a_preview')
      expect(aText).toContain('panel (380×760, app theme):')
      expect(errorsOf(aText)).toContain('[panel] WA-VISIT ok')
      expect(errorsOf(aText)).toContain(list)

      // B：只读 —— 预览不问，页面读得到，写被拒
      const mark = await events.mark()
      const B3 = 'WA-B3 preview the widget'
      previewTurn(stepB, B3, 'call_b_preview', 'WA-B3-DONE')
      await sendPrompt(bSid, B3)
      await waitAssistant(bSid, 'WA-B3-DONE')
      expect(await asksRaisedIn(events, bSid, mark)).toBe(0)
      const bText = await okText(bSid, 'call_b_preview')
      expect(bText).toContain('panel (380×760, app theme):')
      expect(errorsOf(bText)).toContain('[panel] WA-VISIT not_authorized')
      expect(errorsOf(bText)).toContain(list)
      expect(errorsOf(bText)).not.toContain('[panel] WA-VISIT ok')
      expect(reviewerRequests()).toEqual([])
    },
    FLOW_TIMEOUT
  )
})
