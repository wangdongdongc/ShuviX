/**
 * 组件的 API，一条真的链路（docs/widget-tool-design.md）。一个 API，两个调用方；2026-11-04 起 agent 不再经 `widget` 工具调操作：
 * 每个有 API 的组件是一台 MCP 服务器 `widget-<id>`，操作是工具 `mcp__widget-<id>__<op>`，`widget` 工具只管造。
 *
 *   造
 *   WA-E1 A 造组件：create（不问；A 得到读写）→ 写三个文件不问 → build → sql 建表 → list → test（写操作与纯界面操作都试得了，
 *         全部回滚）；旧的 `call` 动作被拒；整轮一张卡都没有；A 的工具表里没有这个组件的操作（造的人也没开启它）
 *   开启与同意
 *   WA-E2 组件开在 Widget 面板里；B 的提示词只有名字；B 的 tool_search 按显示名找到 → 卡（名字、标识名、「能读，要改还会再问」、
 *         策略角标，审查员不出场）→ 允许 → 下一次请求有 listNotes / addNote、没有纯界面的 noteVisit；system 不变、agent 不重建；
 *         勾选写下，权限表没有行；批准之前没有一次请求带着组件说明或操作说明
 *   WA-E3 读：不问（勾选就是同意）；决策日志是放行；不记行
 *   WA-E4 写：「更改组件」卡（只有人答）；卡开着时什么都没写；允许一次 → 写了、开着的页面不重载就显示；下一次写照问；
 *         允许并记住 → 一行 widget / write；再下一次不问
 *   WA-E5 用户在页面里写（同一个操作）→ B 的读操作读得到
 *   WA-E6 B 的会话设置「组件访问」卡；切到只读 → 权限表跟着变（A 那张也有）
 *   WA-E7 预览的页面按发起预览的会话判：A（读写）页面读写都成；B（只读）不问、读成、写被拒
 *   勾选放开的只是服务器上的读
 *   WA-E8 C 从项目保存的扩展继承：读不问（没有 tool_search）；preview / test 照问；放行一次预览，页面自己的读写照样被拒
 *   WA-E9 D（不在项目里）在选择器里勾上：读不问；勾选之前选择器里它是没勾的
 *   变化
 *   WA-E10 绿色构建加了操作：开着它的 B 下一次调用照常（连接换了），工具表不变（锁里的声明）；重建 agent 之后有新操作（重新列过）；
 *          test 看得到新操作；新会话的工具表有它
 *   WA-E11 builtin:widget 停用：新会话没有 `widget` 工具，tool_search 和开着的组件操作都在
 *   WA-E12 归档：调用报没连上、不问；勾选留着；tool_search 找不到。恢复：读照常、不问
 *   WA-E13 删除：所有勾选（会话、项目）与权限行抹掉；开着的界面不把旧的写回来（选择器再勾别的，勾选里没有它）；
 *          B 的 agent 不再有它的工具。同 id 新造一个：什么都没继承（项目的新会话没有它），tool_search 要重新问，
 *          回答是新组件现在的操作
 *
 * 模型侧是脚本化的假提供商，每个回合按「这一轮的提示词」认领；内置 auto-review 开着（产品缺省）—— 组件和开启扩展的询问它不答，
 * 所以一次都不该被派出。A / B / C 都在一个项目里（根档案 work）。组件页面在 Widget 面板的跨源 iframe 里，自己有一个 CDP target。
 *
 * 不在这里的：界面经 `api.call` 遇到的失败形状（单测）、远程浏览器里的 `/w/` 转发（network/web-fallbacks）、子会话 / 分支复制
 * 授权与勾选（单测）、声明不合格的老快照和退役时在途的调用（widgetMcpServer.test / mcpManager.test）。
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import type { AskInputRequest } from '@shuvix/chat-protocol/types/inputRequest'
import { connect, listTargets, until, type CdpClient } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import {
  messageTextsOf,
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
  requestToolNames,
  securityDecisions,
  seedFakeProvider,
  sqlLit,
  sqliteJson,
  waitRendererReady,
  type EventRecorder,
  type RecordedEvent,
  type SecurityDecisionEntry
} from '../../harness/seed'
import { syncProbe, type SyncProbe, type ToolResult } from '../../harness/sync'
import {
  chatPane,
  extensionAskPane,
  rightPanelPane,
  sessionConfigPane,
  sidebarPane,
  toolPickerPane,
  widgetAccessPane,
  widgetAskPane,
  widgetPanelPane,
  type ChatPane,
  type ExtensionAskPane,
  type SessionConfigPane,
  type SidebarPane,
  type ToolPickerPane,
  type WidgetAccessPane,
  type WidgetAskPane,
  type WidgetPanelPane
} from '../../harness/pages'

const MODEL = 'e2e-model'
const USAGE = { prompt: 120, completion: 8 }
const FLOW_TIMEOUT = 150_000

const A_TITLE = 'Widget builder A'
const B_TITLE = 'Widget user B'
const C_TITLE = 'Widget project session C'
const D_TITLE = 'Widget ticked session D'
/** 第一条消息里的记号：之后这条会话的每个请求里都有（历史），别的会话的请求里永远没有 */
const A_MARK = 'WAE-ALPHA-BUILDER'
const B_MARK = 'WAE-BRAVO-USER'
const C_MARK = 'WAE-CHARLIE-PROJECT'
const D_MARK = 'WAE-DELTA-TICKED'
/** 出厂 ask-on-widget-access 的英文显示名（md 的 shuvix-displayName）—— 卡片上的策略角标 */
const POLICY_DISPLAY_NAME = 'Ask Before Using a Widget'
const EXTENSION_POLICY_DISPLAY_NAME = 'Ask Before Enabling an Extension'
/** pi-ai 把工具结果里的图另起一条用户消息发给模型，开头是这一句（它不是用户说的话） */
const ATTACHED = 'Attached image(s) from tool result:'

const WIDGET = 'wa-notes'
const SERVER = `widget-${WIDGET}`
const ENTRY = `mcp:${SERVER}`
const NAME = 'WA Notes'
const DESCRIPTION = 'Short notes kept for the widget API e2e.'
const LIST_DESCRIPTION = 'List the notes, oldest first.'
const ADD_DESCRIPTION = 'Add a note. Returns the note.'
const tool = (op: string): string => `mcp__${SERVER}__${op}`

const NOTE_ONCE = 'WA-NOTE-ALLOWED-ONCE'
const NOTE_REMEMBER = 'WA-NOTE-REMEMBERED'
const NOTE_FREE = 'WA-NOTE-NO-CARD'
const USER_NOTE = 'WA-NOTE-FROM-USER'

// ─── 组件的源码（由 A 的 agent 写进组件目录） ───────────────────

const API_TS = `import { defineApi, op, z } from 'shuvix/widget-api'

const Note = z.object({ id: z.number(), text: z.string(), addedBy: z.string() })

export default defineApi({
  listNotes: op.read({
    description: ${JSON.stringify(LIST_DESCRIPTION)},
    input: z.object({}),
    output: z.array(Note),
    handler: (_args, ctx) =>
      ctx.db.sql\`SELECT id, text, added_by AS addedBy FROM notes ORDER BY id\`
  }),
  addNote: op.write({
    description: ${JSON.stringify(ADD_DESCRIPTION)},
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

/** 第二版：多一个读操作 */
const API_TS_V2 = API_TS.replace(
  '  noteVisit: op.write({',
  `  countNotes: op.read({
    description: 'How many notes there are.',
    input: z.object({}),
    handler: async (_args, ctx) => {
      const [row] = await ctx.db.sql\`SELECT count(*) AS n FROM notes\`
      return row
    }
  }),
  noteVisit: op.write({`
)

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
 * console.error 的几行（WA-VISIT / WA-LIST / WA-LIST-FAILED）是给预览带回 errors 用的：预览只收页面的错误输出
 */
const SCREEN_TSX = `import { createRoot } from 'react-dom/client'
import { useEffect, useState } from 'react'
import { createClient, WidgetError } from 'shuvix/widget'
import type Api from './api'

const api = createClient<typeof Api>()

const codeOf = (e: unknown): string => (e instanceof WidgetError ? e.code : String(e))

function Notes() {
  const { data, error } = api.use('listNotes', {})
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
  useEffect(() => {
    if (error) console.error('WA-LIST-FAILED ' + codeOf(error))
  }, [error])
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
let extensionAsk: ExtensionAskPane
let picker: ToolPickerPane
let panel: WidgetPanelPane
let frame: CdpClient | null = null
let projectId = ''
let aSid = ''
let bSid = ''
let cSid = ''
let dSid = ''

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
const stepC = stepOf(C_MARK)
const stepD = stepOf(D_MARK)

const reviewerRequests = (): FakeRequest[] => provider.requests().filter(isReviewerRequest)

/** 这一轮发出去的请求（按先后） */
const requestsOf = (step: (r: FakeRequest) => boolean): FakeRequest[] =>
  provider.requests().filter(step)

const systemTexts = (req: FakeRequest): string[] =>
  messageTextsOf(req)
    .filter((m) => m.role === 'system' || m.role === 'developer')
    .map((m) => m.text)

const widgetTools = (req: FakeRequest): string[] =>
  requestToolNames(req).filter((name) => name.startsWith(`mcp__${SERVER}__`))

const widgetCall = (
  id: string,
  args: Record<string, unknown>
): { id: string; name: string; args: string } => ({
  id,
  name: 'widget',
  args: JSON.stringify(args)
})

/** 调组件的操作（MCP 工具） */
const opCall = (
  id: string,
  op: string,
  args: Record<string, unknown> = {}
): { id: string; name: string; args: string } => ({
  id,
  name: tool(op),
  args: JSON.stringify(args)
})

const searchCall = (id: string, query: string): { id: string; name: string; args: string } => ({
  id,
  name: 'tool_search',
  args: JSON.stringify({ query })
})

/** 一轮：依次调这些工具，最后回一句 done */
const script = (
  step: (r: FakeRequest) => boolean,
  calls: Array<{ id: string; name: string; args: string }>,
  done: string
): void =>
  provider.script(
    ...calls.map((call): FakeTurn => ({ toolCalls: [call], when: step, usage: USAGE })),
    { text: done, when: step, usage: USAGE }
  )

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

/** 一个失败的工具结果的正文 */
const failedText = async (sid: string, callId: string): Promise<string> => {
  const r = await resultOf(sid, callId)
  expect(r.isError, `${callId}: ${r.result}`).toBe(true)
  return r.result
}

/** 结果正文里的 JSON（返回值按 JSON 给出，可能后面跟着说明行） */
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

/** 下一张询问卡（会话视图里的询问） */
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

const createSession = (title: string, inProject = true): Promise<string> =>
  app.main.eval<string>(
    `window.api.session.create(${JSON.stringify(inProject ? { title, projectId } : { title })}).then((s) => s.id)`
  )

const enabledTools = (sid: string): Promise<string[]> =>
  app.main.eval<string[]>(
    `window.api.session.getById(${JSON.stringify(sid)}).then((s) => (s && s.settings && s.settings.enabledTools) || [])`
  )

const projectTools = (): Promise<string[]> =>
  app.main.eval<string[]>(
    `window.api.project.getById(${JSON.stringify(projectId)}).then((p) => (p && p.settings && p.settings.enabledTools) || [])`
  )

/** A 造（或再造）这个组件：create 可选，写三个文件，build，sql 建表 */
const buildScript = (
  prefix: string,
  options: { create: boolean; api: string }
): Array<{ id: string; name: string; args: string }> => {
  const dir = widgetDir()
  const write = (
    id: string,
    file: string,
    content: string
  ): {
    id: string
    name: string
    args: string
  } => ({ id, name: 'write', args: JSON.stringify({ path: join(dir, file), content }) })
  return [
    ...(options.create
      ? [
          widgetCall(`${prefix}_create`, {
            action: 'create',
            widget: WIDGET,
            name: NAME,
            description: DESCRIPTION
          })
        ]
      : []),
    write(`${prefix}_api`, 'api.ts', options.api),
    write(`${prefix}_schema`, 'schema.sql', SCHEMA_SQL),
    write(`${prefix}_screen`, 'index.tsx', SCREEN_TSX),
    widgetCall(`${prefix}_build`, { action: 'build', widget: WIDGET, message: 'feat: notes' }),
    widgetCall(`${prefix}_sql`, { action: 'sql', widget: WIDGET, sql: SCHEMA_SQL })
  ]
}

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

const errorsOf = (text: string): string[] => {
  const m = /<errors>\n([\s\S]*?)\n<\/errors>/.exec(text)
  return m ? m[1].split('\n') : []
}

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
  extensionAsk = extensionAskPane(app.main)
  picker = toolPickerPane(app.main)
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

describe('widget API: built with the tool, used as an MCP server', () => {
  it(
    'WA-E1 A builds the widget through the tool: create, write its files, build, create its tables, list, test (rolled back, screen-only too) — no card at all; the old `call` action is gone',
    async () => {
      provider.reset()
      await events.clear()
      const A1 = `${A_MARK} build me a notes widget`
      const dir = widgetDir()
      const step = stepA(A1)
      script(
        step,
        [
          ...buildScript('call_a', { create: true, api: API_TS }),
          widgetCall('call_a_list', { action: 'list' }),
          widgetCall('call_a_test', {
            action: 'test',
            widget: WIDGET,
            op: 'addNote',
            args: { text: 'WA-DRY-RUN' }
          }),
          widgetCall('call_a_test_ui', { action: 'test', widget: WIDGET, op: 'noteVisit' }),
          widgetCall('call_a_test_read', { action: 'test', widget: WIDGET, op: 'listNotes' }),
          widgetCall('call_a_old', { action: 'call', widget: WIDGET, op: 'listNotes' })
        ],
        'WA-A1-DONE'
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
      // list：读写、纯界面的那个写着
      const listed = await okText(aSid, 'call_a_list')
      expect(listed).toContain(`<widget id="${WIDGET}" name="${NAME}" access="read-write"`)
      expect(listed).toContain(`- listNotes (read): ${LIST_DESCRIPTION}`)
      expect(listed).toContain('- addNote (write): Add a note.')
      expect(listed).toContain('- noteVisit (write, screen only): Count one visit of the screen.')
      // test：交回那一行，写的都回滚了；纯界面的也试得了
      const tested = await okText(aSid, 'call_a_test')
      expect(jsonOf<NoteRow>(tested)).toMatchObject({ text: 'WA-DRY-RUN' })
      expect(tested).toContain('(dry run: everything it wrote was rolled back)')
      expect(await okText(aSid, 'call_a_test_ui')).toContain('rolled back')
      expect(jsonOf<NoteRow[]>(await okText(aSid, 'call_a_test_read'))).toEqual([])
      // 旧的动作没有了
      await failedText(aSid, 'call_a_old')

      // 造的人也没开启它：工具表里没有它的操作
      const requests = requestsOf(step)
      expect(requestToolNames(requests[0])).toContain('widget')
      expect(requests.every((req) => widgetTools(req).length === 0)).toBe(true)
      expect(await enabledTools(aSid)).not.toContain(ENTRY)

      // 整轮一张卡都没有，审查员也没出场
      expect(await asksRaisedIn(events, aSid, mark)).toBe(0)
      expect(reviewerRequests()).toEqual([])
    },
    FLOW_TIMEOUT
  )

  it(
    'WA-E2 B finds it with tool_search → the card says what it is and what turning it on means → allowed: its tools are there from the next request; nothing about it reached the model before that but its name',
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
      // 用过它的会话所在的项目（A 在 WA-E1 经 widget 工具用过它）：卡片上恰一个标签，没有 +N
      const projectTags = await until(async () => {
        const shot = await panel.projects(WIDGET)
        return shot && shot.tags.length > 0 ? shot : null
      }, 'the project tag on the widget card')
      expect(projectTags).toEqual({
        tags: [{ id: projectId, name: 'WidgetApiProj' }],
        more: null,
        title: en.widgets.usedInProjects.replace('{{names}}', 'WidgetApiProj')
      })
      await panel.clickCard(WIDGET)
      await until(async () => (await panel.foregroundApp()) === WIDGET || null, 'opened in panel')
      await until(() => panel.frameReady(WIDGET), 'the widget iframe')
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

      // 2. B 的 agent 按显示名搜 → 卡
      const B1 = `${B_MARK} I keep notes in that notes widget`
      const step = stepB(B1)
      script(step, [searchCall('call_b_search', NAME)], 'WA-B1-DONE')
      const mark = await events.mark()
      await sendPrompt(bSid, B1)
      const ask = await nextAsk(bSid)
      expect(ask.command).toBe(`Extension(${SERVER})`)
      expect(ask.preview).toMatchObject({
        kind: 'extension',
        server: SERVER,
        source: { type: 'widget', name: NAME }
      })
      const card = await until(() => extensionAsk.shot(), 'extension ask card on screen')
      expect(card.server).toBe(SERVER)
      expect(card.text).toContain(NAME)
      expect(card.text).toContain(SERVER)
      expect(card.widgetLine).toBe(en.toolCall.extensionAskWidget)
      expect(card.sourceLine).toBeNull()
      expect(card.policy).toBe(EXTENSION_POLICY_DISPLAY_NAME)
      // 审查员不出场；卡开着时什么都没写
      expect(reviewerRequests()).toEqual([])
      expect(await enabledTools(bSid)).not.toContain(ENTRY)

      const before = requestsOf(step)
      expect(requestToolNames(before[0])).toContain('tool_search')
      expect(widgetTools(before[0])).toEqual([])
      // 提示词列出它（名字），不带说明；批准之前任何请求里都没有组件说明和操作说明
      expect(systemTexts(before[0]).join('\n')).toContain(SERVER)
      expect(systemTexts(before[0]).join('\n')).toContain(NAME)
      for (const req of before) {
        for (const secret of [DESCRIPTION, LIST_DESCRIPTION, ADD_DESCRIPTION]) {
          expect(req.raw, secret).not.toContain(secret)
        }
      }

      // 3. 允许
      await chat.answerPendingAsk('allow')
      await probe.waitAskGone(bSid, ask.id)
      await waitAssistant(bSid, 'WA-B1-DONE')

      const loaded = await okText(bSid, 'call_b_search')
      expect(loaded).toContain('Loaded 2 tools.')
      expect(loaded).toContain(`- ${tool('listNotes')}: ${LIST_DESCRIPTION}`)
      expect(loaded).toContain(`- ${tool('addNote')}: Add a note.`)

      const after = requestsOf(step).at(-1)!
      expect(widgetTools(after).sort()).toEqual([tool('addNote'), tool('listNotes')])
      // 只改工具：system 一字不变，agent 没重建
      expect(systemTexts(after)).toEqual(systemTexts(before[0]))
      const lifecycle = (await events.allSince<RecordedEvent>(mark))
        .filter((event) => event.sessionId === bSid)
        .map((event) => event.type)
      expect(lifecycle).not.toContain('agent_closing')
      expect(lifecycle.filter((type) => type === 'agent_created').length).toBeLessThanOrEqual(1)

      expect(await enabledTools(bSid)).toContain(ENTRY)
      expect(widgetRows(bSid)).toEqual([])
      expect(reviewerRequests()).toEqual([])
    },
    FLOW_TIMEOUT
  )

  it(
    'WA-E3 reading through the server does not ask: the tick is the consent; no row is written',
    async () => {
      provider.reset()
      const B2 = 'WA-B2 what notes are there?'
      script(stepB(B2), [opCall('call_b_list', 'listNotes')], 'WA-B2-DONE')
      const mark = await events.mark()
      const decided = decisionsOf(bSid).length

      await sendPrompt(bSid, B2)
      await waitAssistant(bSid, 'WA-B2-DONE')

      expect(jsonOf<NoteRow[]>(await okText(bSid, 'call_b_list'))).toEqual([])
      expect(await asksRaisedIn(events, bSid, mark)).toBe(0)
      expect(widgetRows(bSid)).toEqual([])
      // 门照样过了一次，放行、没有人的回答
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
    'WA-E4 writing asks: the "Change a widget" card; allow once writes and the open page refetches without a reload; the next write asks again; allow and remember writes a row; the one after does not ask',
    async () => {
      provider.reset()
      await events.clear()
      const stamp = await panel.frameStamp(WIDGET)

      // 1. 第一次写 → 卡
      const B3 = 'WA-B3 add a note'
      script(stepB(B3), [opCall('call_b_add1', 'addNote', { text: NOTE_ONCE })], 'WA-B3-DONE')
      await sendPrompt(bSid, B3)
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
      expect(await pageNotes()).toEqual([])

      // 2. 允许一次：写了，不记行
      await widgetAsk.pick('allow')
      await probe.waitAskGone(bSid, ask.id)
      await waitAssistant(bSid, 'WA-B3-DONE')
      const added = jsonOf<NoteRow>(await okText(bSid, 'call_b_add1'))
      expect(added).toMatchObject({ text: NOTE_ONCE })
      expect(added.addedBy).toMatch(/^shuvix-work\//)
      expect(widgetRows(bSid)).toEqual([])

      // 3. 开着的页面没重载就重取出了它（SSE 的 data）
      await until(
        async () => (await pageNotes()).some((n) => n.text === NOTE_ONCE) || null,
        'the open page shows the agent’s note',
        30_000
      )
      expect(await pageNotes()).toEqual([{ text: NOTE_ONCE, by: added.addedBy }])
      expect(await pageNotReloaded()).toBe(true)
      expect(await panel.frameStamp(WIDGET)).toBe(stamp)

      // 4. 下一次写照问；这回允许并记住
      const B4 = 'WA-B4 add another'
      script(stepB(B4), [opCall('call_b_add2', 'addNote', { text: NOTE_REMEMBER })], 'WA-B4-DONE')
      await sendPrompt(bSid, B4)
      const again = await nextAsk(bSid)
      expect(again.command).toBe(`Widget(write, ${WIDGET})`)
      await until(() => widgetAsk.shot(), 'second widget ask card')
      await widgetAsk.pick('remember-widget')
      await probe.waitAskGone(bSid, again.id)
      await waitAssistant(bSid, 'WA-B4-DONE')
      await okText(bSid, 'call_b_add2')
      expect(widgetRows(bSid)).toEqual([
        { kind: 'widget', target: WIDGET, access: 'write', source: 'user', sourceKey: '' }
      ])

      // 决策日志：写那一条问了，人答「允许并记住」，没有审查结论
      const decisions = await until(
        () =>
          decisionsOf(bSid).some((d) => d.userResponse === 'allowed_remember')
            ? decisionsOf(bSid)
            : null,
        'widget decision logged'
      )
      const remembered = decisions.find((d) => d.userResponse === 'allowed_remember')
      expect(remembered).toMatchObject({
        action: 'write',
        objectKind: 'widget',
        winning: 'ask-on-widget-access#1'
      })
      expect(remembered?.review).toBeUndefined()

      // 5. 再写不问
      const B5 = 'WA-B5 one more'
      script(stepB(B5), [opCall('call_b_add3', 'addNote', { text: NOTE_FREE })], 'WA-B5-DONE')
      const mark = await events.mark()
      await sendPrompt(bSid, B5)
      await waitAssistant(bSid, 'WA-B5-DONE')
      await okText(bSid, 'call_b_add3')
      expect(await asksRaisedIn(events, bSid, mark)).toBe(0)
      expect(reviewerRequests()).toEqual([])
      // B 也在同一个项目里：标签还是那一个
      expect((await panel.projects(WIDGET))?.tags).toEqual([
        { id: projectId, name: 'WidgetApiProj' }
      ])
    },
    FLOW_TIMEOUT
  )

  it(
    'WA-E5 the user adds a note in the widget page through the same operation; B’s agent reads it',
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

      // 2. B 的 agent 调读操作
      const B6 = 'WA-B6 what notes are there now?'
      script(stepB(B6), [opCall('call_b_list2', 'listNotes')], 'WA-B6-DONE')
      const mark = await events.mark()
      await sendPrompt(bSid, B6)
      await waitAssistant(bSid, 'WA-B6-DONE')
      expect(await asksRaisedIn(events, bSid, mark)).toBe(0)
      const notes = jsonOf<NoteRow[]>(await okText(bSid, 'call_b_list2'))
      expect(notes.map((n) => n.text)).toEqual([NOTE_ONCE, NOTE_REMEMBER, NOTE_FREE, USER_NOTE])
      expect(notes[0].addedBy).toMatch(/^shuvix-work\//)
      expect(notes[3].addedBy).toBe('user')
    },
    FLOW_TIMEOUT
  )

  it(
    'WA-E6 Session settings → Widget access lists the widget for B (read & write) and for A, its creator; B switched to read-only reaches the permission table',
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
    'WA-E7 a preview page runs as the previewing session: A (read & write) — its read and its screen-only write both work; B (read only) — not asked, reads, the write is refused',
    async () => {
      provider.reset()
      await events.clear()
      const previewTurn = (
        step: (prompt: string) => (r: FakeRequest) => boolean,
        prompt: string,
        callId: string,
        done: string
      ): void =>
        script(
          step(prompt),
          [widgetCall(callId, { action: 'preview', widget: WIDGET, sizes: ['panel'] })],
          done
        )
      const list = `[panel] WA-LIST ${[NOTE_ONCE, NOTE_REMEMBER, NOTE_FREE, USER_NOTE].join('|')}`

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
      const B7 = 'WA-B7 preview the widget'
      previewTurn(stepB, B7, 'call_b_preview', 'WA-B7-DONE')
      await sendPrompt(bSid, B7)
      await waitAssistant(bSid, 'WA-B7-DONE')
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

  it(
    'WA-E8 a session inherits the tick from its project: reads through the server do not ask, but preview, test and the preview page’s own calls are not freed by it',
    async () => {
      provider.reset()
      await events.clear()
      const updated = await app.main.eval<{ success: boolean }>(
        `window.api.project.update(${JSON.stringify({ id: projectId, enabledTools: [ENTRY] })})`
      )
      expect(updated.success).toBe(true)
      cSid = await createSession(C_TITLE)
      expect(await enabledTools(cSid)).toEqual([ENTRY])
      await openInUi(C_TITLE)

      // 1. 读：第一次请求就有这些工具，没有 tool_search 这一步，不问
      const C1 = `${C_MARK} read the notes`
      script(stepC(C1), [opCall('call_c_list', 'listNotes')], 'WA-C1-DONE')
      const mark = await events.mark()
      await sendPrompt(cSid, C1)
      await waitAssistant(cSid, 'WA-C1-DONE')
      expect(widgetTools(requestsOf(stepC(C1))[0]).sort()).toEqual([
        tool('addNote'),
        tool('listNotes')
      ])
      expect(jsonOf<NoteRow[]>(await okText(cSid, 'call_c_list'))).toHaveLength(4)
      expect(await asksRaisedIn(events, cSid, mark)).toBe(0)
      expect(widgetRows(cSid)).toEqual([])

      // 2. preview 照问；放行一次 → 截了图，但页面自己的读写都被拒（勾选和这一次放行都不算授权）
      const C2 = 'WA-C2 preview it'
      script(
        stepC(C2),
        [widgetCall('call_c_preview', { action: 'preview', widget: WIDGET, sizes: ['panel'] })],
        'WA-C2-DONE'
      )
      await sendPrompt(cSid, C2)
      const previewAsk = await nextAsk(cSid)
      expect(previewAsk.command).toBe(`Widget(read, ${WIDGET})`)
      expect(previewAsk.widget?.operation).toBe('preview')
      await until(() => widgetAsk.shot(), 'preview ask card')
      await widgetAsk.pick('allow')
      await probe.waitAskGone(cSid, previewAsk.id)
      await waitAssistant(cSid, 'WA-C2-DONE')
      const cText = await okText(cSid, 'call_c_preview')
      expect(errorsOf(cText)).toContain('[panel] WA-VISIT not_authorized')
      expect(errorsOf(cText)).toContain('[panel] WA-LIST-FAILED not_authorized')
      expect(errorsOf(cText).some((line) => line.includes('WA-LIST '))).toBe(false)

      // 3. test 照问；拒绝 → 失败结果，不跑
      const C3 = 'WA-C3 try the read operation'
      script(
        stepC(C3),
        [widgetCall('call_c_test', { action: 'test', widget: WIDGET, op: 'listNotes' })],
        'WA-C3-DONE'
      )
      await sendPrompt(cSid, C3)
      const testAsk = await nextAsk(cSid)
      expect(testAsk.widget?.operation).toBe('listNotes')
      await until(() => widgetAsk.shot(), 'test ask card')
      await widgetAsk.pick('deny')
      await probe.waitAskGone(cSid, testAsk.id)
      await waitAssistant(cSid, 'WA-C3-DONE')
      await failedText(cSid, 'call_c_test')
      expect(widgetRows(cSid)).toEqual([])
      expect(reviewerRequests()).toEqual([])
    },
    FLOW_TIMEOUT
  )

  it(
    'WA-E9 ticking it in the extensions picker: listed with its name and unticked until then; reads then do not ask',
    async () => {
      provider.reset()
      await events.clear()
      dSid = await createSession(D_TITLE, false)
      await openInUi(D_TITLE)
      await picker.open()
      const row = await until(
        async () => (await picker.items()).find((item) => item.name === ENTRY) ?? null,
        'the widget in the picker'
      )
      expect(row.checked).toBe(false)
      expect(row.declared).toBe(false)
      await picker.toggle(ENTRY)
      await picker.close()
      await until(async () => (await enabledTools(dSid)).includes(ENTRY) || null, 'tick stored')

      const D1 = `${D_MARK} read the notes`
      script(stepD(D1), [opCall('call_d_list', 'listNotes')], 'WA-D1-DONE')
      const mark = await events.mark()
      await sendPrompt(dSid, D1)
      await waitAssistant(dSid, 'WA-D1-DONE')
      expect(jsonOf<NoteRow[]>(await okText(dSid, 'call_d_list'))).toHaveLength(4)
      expect(await asksRaisedIn(events, dSid, mark)).toBe(0)
    },
    FLOW_TIMEOUT
  )

  it(
    'WA-E10 a green build that adds an operation: B’s next call works over a new connection and its tools do not change; test sees the new one; a new session has it',
    async () => {
      provider.reset()
      const A3 = 'WA-A3 add a count operation'
      script(
        stepA(A3),
        [
          ...buildScript('call_a3', { create: false, api: API_TS_V2 }),
          widgetCall('call_a3_test', { action: 'test', widget: WIDGET, op: 'countNotes' })
        ],
        'WA-A3-DONE'
      )
      await sendPrompt(aSid, A3)
      await waitAssistant(aSid, 'WA-A3-DONE')
      expect(await okText(aSid, 'call_a3_build')).toContain('countNotes (read)')
      expect(jsonOf<{ n: number }>(await okText(aSid, 'call_a3_test'))).toEqual({ n: 4 })

      // B：开着它，连接已经退役：下一次调用照常（重连），工具表还是当初的
      const B8 = 'WA-B8 read again'
      script(stepB(B8), [opCall('call_b_list3', 'listNotes')], 'WA-B8-DONE')
      await sendPrompt(bSid, B8)
      await waitAssistant(bSid, 'WA-B8-DONE')
      expect(jsonOf<NoteRow[]>(await okText(bSid, 'call_b_list3'))).toHaveLength(4)
      for (const req of requestsOf(stepB(B8))) {
        expect(widgetTools(req)).not.toContain(tool('countNotes'))
      }

      // 把 agent 重建（芯片上的 X）：连接是退役之后新开的，工具重新列过，新操作就在了
      await app.main.eval(`window.api.agent.destroy(${JSON.stringify(bSid)})`)
      const B8B = 'WA-B8B after the rebuild'
      script(stepB(B8B), [], 'WA-B8B-DONE')
      await sendPrompt(bSid, B8B)
      await waitAssistant(bSid, 'WA-B8B-DONE')
      expect(widgetTools(requestsOf(stepB(B8B))[0])).toContain(tool('countNotes'))

      // 新会话（从项目继承）：有新操作
      const sid = await createSession('Widget fresh session')
      const FRESH = 'WA-E10 a fresh session'
      provider.script({ text: 'WA-FRESH-DONE', when: (r) => lastPrompt(r) === FRESH, usage: USAGE })
      await sendPrompt(sid, FRESH)
      await waitAssistant(sid, 'WA-FRESH-DONE')
      const first = provider.requests().find((r) => lastPrompt(r) === FRESH)!
      expect(widgetTools(first)).toContain(tool('countNotes'))
    },
    FLOW_TIMEOUT
  )

  it(
    'WA-E11 with builtin:widget switched off, a new agent has no `widget` tool but keeps tool_search and the widget’s operations',
    async () => {
      provider.reset()
      await app.main.eval(`window.api.skill.update({ name: 'builtin:widget', isEnabled: false })`)
      try {
        const sid = await createSession('Widget no skill session')
        const TEXT = 'WA-E11 no widget skill'
        provider.script({
          text: 'WA-NOSKILL-DONE',
          when: (r) => lastPrompt(r) === TEXT,
          usage: USAGE
        })
        await sendPrompt(sid, TEXT)
        await waitAssistant(sid, 'WA-NOSKILL-DONE')
        const names = requestToolNames(provider.requests().find((r) => lastPrompt(r) === TEXT)!)
        expect(names).not.toContain('widget')
        expect(names).toContain('tool_search')
        expect(names).toContain(tool('listNotes'))
      } finally {
        await app.main.eval(`window.api.skill.update({ name: 'builtin:widget', isEnabled: true })`)
      }
    },
    FLOW_TIMEOUT
  )

  it(
    'WA-E12 archived: its tools stop working without a card and the tick stays; tool_search does not find it. Restored: reads work again without asking',
    async () => {
      provider.reset()
      await events.clear()
      const archived = await app.main.eval<{ success: boolean }>(
        `window.api.widget.setArchived(${JSON.stringify({ id: WIDGET, archived: true })})`
      )
      expect(archived.success).toBe(true)

      const B9 = 'WA-B9 read while it is archived'
      script(
        stepB(B9),
        [opCall('call_b_arch', 'listNotes'), searchCall('call_b_arch_search', WIDGET)],
        'WA-B9-DONE'
      )
      const mark = await events.mark()
      await sendPrompt(bSid, B9)
      await waitAssistant(bSid, 'WA-B9-DONE')
      expect(await failedText(bSid, 'call_b_arch')).toContain('is not connected')
      expect(await okText(bSid, 'call_b_arch_search')).toBe('No matching tools found.')
      expect(await asksRaisedIn(events, bSid, mark)).toBe(0)
      expect(await enabledTools(bSid)).toContain(ENTRY)

      const restored = await app.main.eval<{ success: boolean }>(
        `window.api.widget.setArchived(${JSON.stringify({ id: WIDGET, archived: false })})`
      )
      expect(restored.success).toBe(true)
      const B10 = 'WA-B10 read after the restore'
      script(stepB(B10), [opCall('call_b_back', 'listNotes')], 'WA-B10-DONE')
      await sendPrompt(bSid, B10)
      await waitAssistant(bSid, 'WA-B10-DONE')
      expect(jsonOf<NoteRow[]>(await okText(bSid, 'call_b_back'))).toHaveLength(4)
      expect(await asksRaisedIn(events, bSid, mark)).toBe(0)
    },
    FLOW_TIMEOUT
  )

  it(
    'WA-E13 deleted: every selection and permission row forgets it, an open window does not write it back, B’s agent loses its tools; a new widget with the same id inherits nothing',
    async () => {
      provider.reset()
      await events.clear()
      // 一条开着界面、勾着它、还没有 agent 的会话（E 不发消息）：整份写回的那条路
      const eSid = await createSession('Widget ticked no agent', false)
      await openInUi('Widget ticked no agent')
      await picker.open()
      await until(
        async () => (await picker.items()).find((item) => item.name === ENTRY) ?? null,
        'the widget in the picker'
      )
      await picker.toggle(ENTRY)
      await picker.close()
      await until(async () => (await enabledTools(eSid)).includes(ENTRY) || null, 'E ticked it')

      const deleted = await app.main.eval<{ success: boolean }>(
        `window.api.widget.delete(${JSON.stringify(WIDGET)})`
      )
      expect(deleted.success).toBe(true)

      // 勾选（会话、项目）与权限行都没了
      for (const sid of [bSid, cSid, dSid, eSid]) {
        await until(async () => !(await enabledTools(sid)).includes(ENTRY) || null, `${sid} forgot`)
      }
      await until(async () => !(await projectTools()).includes(ENTRY) || null, 'project forgot')
      for (const sid of [aSid, bSid, cSid, dSid]) expect(widgetRows(sid), sid).toEqual([])

      // 开着的界面没把旧的写回来：在选择器里再勾别的，整份写回里没有它
      await picker.open()
      expect((await picker.items()).some((item) => item.name === ENTRY)).toBe(false)
      await picker.toggle('mcp:ssh')
      await picker.close()
      await until(
        async () => (await enabledTools(eSid)).includes('mcp:ssh') || null,
        'E ticked another server'
      )
      expect(await enabledTools(eSid)).toEqual(['mcp:ssh'])

      // B 的 agent 不再有它的工具
      const B11 = 'WA-B11 after the delete'
      script(stepB(B11), [], 'WA-B11-DONE')
      await sendPrompt(bSid, B11)
      await waitAssistant(bSid, 'WA-B11-DONE')
      expect(widgetTools(requestsOf(stepB(B11))[0])).toEqual([])

      // 同一个 id 新造一个
      const A4 = 'WA-A4 build it again'
      script(stepA(A4), buildScript('call_a4', { create: true, api: API_TS }), 'WA-A4-DONE')
      await sendPrompt(aSid, A4)
      await waitAssistant(aSid, 'WA-A4-DONE')
      await okText(aSid, 'call_a4_build')

      // 项目的新会话什么都没继承
      const fresh = await createSession('Widget after recreate')
      expect(await enabledTools(fresh)).toEqual([])
      const FRESH = 'WA-E13 a fresh session'
      provider.script({
        text: 'WA-FRESH2-DONE',
        when: (r) => lastPrompt(r) === FRESH,
        usage: USAGE
      })
      await sendPrompt(fresh, FRESH)
      await waitAssistant(fresh, 'WA-FRESH2-DONE')
      const first = provider.requests().find((r) => lastPrompt(r) === FRESH)!
      expect(widgetTools(first)).toEqual([])

      // B 要重新问；回答的是新组件现在的操作（第一版，没有 countNotes）
      await openInUi(B_TITLE)
      const B12 = 'WA-B12 search it again'
      script(stepB(B12), [searchCall('call_b_again', WIDGET)], 'WA-B12-DONE')
      await sendPrompt(bSid, B12)
      const ask = await nextAsk(bSid)
      expect(ask.command).toBe(`Extension(${SERVER})`)
      await until(() => extensionAsk.shot(), 'extension card for the new widget')
      await chat.answerPendingAsk('allow')
      await probe.waitAskGone(bSid, ask.id)
      await waitAssistant(bSid, 'WA-B12-DONE')
      const loaded = await okText(bSid, 'call_b_again')
      expect(loaded).toContain(tool('listNotes'))
      expect(loaded).not.toContain('countNotes')
      expect(reviewerRequests()).toEqual([])
    },
    FLOW_TIMEOUT
  )
})
