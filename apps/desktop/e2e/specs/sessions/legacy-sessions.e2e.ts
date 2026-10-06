/**
 * 旧格式会话（`harness-v3-jsonl`，pi-durable 切换之前建的）在真实应用里的样子 —— P4-04。
 *
 * 种法一律是**重启模式**：先起一个实例，经 IPC 建好各种形态的会话（这样行就是产品自己建的），
 * `stop({ keepHome: true })` 停机，在停着的库上把它们改成旧格式（系统 sqlite3 直改 `storageKind`，
 * 再按 pi 0.80 harness 的 v3 形状写 `sessions/<id>.jsonl` —— `seedLegacySteps`），然后
 * `launchApp({ home })` 用同一个 HOME 重开。重开这一下就是升级后的第一次启动：启动切换
 * （services/legacySwitchover，在 IPC 注册之后、任何窗口之前 await）真的在跑，而不是被单测模拟。
 * 假提供商活在 vitest 进程里，跨几次启动不变。界面语言写成 en，文案按 chat-protocol 的 en 语言包逐字比。
 *
 * 第一组（一对实例 + 末尾再重启一次）：
 *   L-1  旧格式行画出冻结投影：工具块、压缩摘要卡、错误行
 *   L-2  横幅在、输入框禁用（placeholder 为空串）；硬发 `agent.prompt` 拿到 legacySessionReadOnly；
 *        横幅的 [新建对话] 在这一行的项目里建一条会话并选中它
 *   L-3  没有回退 / 重新生成 / 编辑控件；硬调 `message.rollback` 也回 false
 *   L-4  删除（侧栏 ⋮ → 删除 → 确认）带走行和 `.jsonl`
 *   L-5  清空（`message.clear`）：开着的横幅当场消失，行换成新格式，`.jsonl` 没了，发一条成功
 *   L-6  新格式父会话的旧格式子会话：session 工具 `read-sub-session` 读得到它的末条答复，
 *        `prompt-sub-session` 被干净地拒绝（工具结果是错误、子会话一个字都没动）
 *   L-7  注册表 / 知识库 / 项目笔记本三种绑着文件的旧格式行重启后是新格式：id 不变、只有 storageKind 与
 *        updatedAt 动了（lastActiveAt 不动 → 侧栏顺序不变）、`.jsonl` 逐字节还在、第一次打开之前没有
 *        `.sqlite`、按 (项目, 文件) 找会话还是这一行、笔记本对话打开是空的且发得出去；它的旧格式子会话
 *        （自己没有 notebookPath）照旧只读，自己有 notebookPath 的照样重置
 *   L-8  合法绑定的旧格式标签页会话在启动时经真的 `sessionService.delete` 删掉 —— 它的子会话、临时工作区、
 *        `.jsonl` 一起；绑定不合法（`tabId: -1`）的不删，照旧是一条只读旧格式行
 *   L-10 监视器的列表与自动标题都碰不到旧格式行
 *   L-7（重启两次）再重启一次是空操作：行（含 updatedAt）与会话目录逐字节不变，
 *        `LegacySwitchover` 那一行写 `reset=0 deleted=0 failed=0`
 *
 * 第二组（L-9）：库被拨回 v29（`sessions` 去掉 storageKind 列、`user_version=29`）。重启后 v30 重跑、
 * 列回来了、每一行先落成旧格式，切换随即生效 —— 带 notebookPath 的翻回新格式（之前就是新格式的那条
 * 重新打开自己的 `.sqlite`、先前的轮次都在、镜像键原样）；合法绑定的标签页会话被删；**之前是新格式、
 * 没有 notebookPath 的普通对话停在旧格式、只读** —— 这是预期（裁决 PIN-14：拨回的库里只有绑着文件的
 * 行会被翻回来；它的 `.sqlite` 还在盘上，只是不再被打开）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import en from '../../../../../packages/chat-protocol/src/i18n/locales/en.json'
import { sleep, until, type CdpClient } from '../../harness/cdp'
import { startFakeProvider, type FakeProvider, type FakeRequest } from '../../harness/fakeProvider'
import { launchApp, type E2EApp } from '../../harness/launch'
import {
  chatPane,
  confirmPane,
  sidebarPane,
  type ChatPane,
  type SidebarPane
} from '../../harness/pages'
import {
  createProject,
  durableStoragePathOf,
  eventRecorder,
  legacySwitchoverRuns,
  legacyTranscriptPathOf,
  newSessionsAfter,
  openRegistryNote,
  rewindSessionsToV29,
  seedFakeProvider,
  seedKnowledgeBase,
  seedLegacySteps,
  sqlite,
  sqliteJson,
  sqlLit,
  waitRendererReady,
  writeAgentMd,
  type EventRecorder,
  type LegacyStep,
  type RecordedEvent
} from '../../harness/seed'
import { syncProbe, type SyncProbe } from '../../harness/sync'

const MODEL = 'e2e-model'
const LEGACY = 'harness-v3-jsonl'
const DURABLE = 'durable-sqlite-1'
const READ_ONLY = en.chat.legacySessionReadOnly
/** 内置 auto-title 的任务正文开头（各语言副本都是这段英文） */
const TITLER_BODY = 'Derive one concise title'

interface SessionRow {
  id: string
  title: string
  projectId: string | null
  parentId: string | null
  settings: string
  createdAt: number
  updatedAt: number
  lastActiveAt: number
  storageKind: string
}

interface ListedMessage {
  id: string
  role: string
  type: string
  content: string
  metadata?: Record<string, unknown> | null
  blocks?: Array<{
    type: string
    toolName?: string
    result?: string
    isError?: boolean
  }>
}

interface ListedSession {
  id: string
  title: string
  projectId: string | null
  settings: Record<string, unknown>
}

const ROW_COLUMNS =
  'id, title, projectId, parentId, settings, createdAt, updatedAt, lastActiveAt, storageKind'

function rowsOf(home: string, ids: string[]): Map<string, SessionRow> {
  const rows = sqliteJson<SessionRow>(
    home,
    `SELECT ${ROW_COLUMNS} FROM sessions WHERE id IN (${ids.map(sqlLit).join(', ')})`
  )
  return new Map(rows.map((r) => [r.id, r]))
}

function rowOf(home: string, id: string): SessionRow | undefined {
  return rowsOf(home, [id]).get(id)
}

const bytesOf = (file: string): string => readFileSync(file).toString('base64')

const listMessages = (main: CdpClient, sid: string): Promise<ListedMessage[]> =>
  main.eval<ListedMessage[]>(`window.api.message.list(${JSON.stringify(sid)})`)

const listSessions = (main: CdpClient): Promise<ListedSession[]> =>
  main.eval<ListedSession[]>(`window.api.session.list()`)

/**
 * 发一轮并等它落定（durable 的 submitUser 等这一轮落定才答）。IPC `agent:prompt` 恒回
 * `{ success: true }` —— 发不出去的原因走 ChatEvent `error`（见 `forcedPrompt`）。
 */
const prompt = (main: CdpClient, sid: string, text: string): Promise<unknown> =>
  main.eval(`window.api.agent.prompt(${JSON.stringify({ sessionId: sid, text })})`)

/**
 * 硬发一条（绕过禁用的输入框，与用户在别的前端敲同一条 IPC），回界面收到的拒绝文案：网关打不开会话时
 * 广播一条该会话的 ChatEvent `error`（DefaultChatGateway.unavailableSessionError），IPC 本身照样回 success
 */
async function forcedPrompt(
  main: CdpClient,
  events: EventRecorder,
  sid: string,
  text: string
): Promise<string> {
  const since = await events.mark()
  await prompt(main, sid, text)
  const ev = await events.waitFor<RecordedEvent & { error?: string }>('error', {
    sessionId: sid,
    since,
    timeoutMs: 10_000
  })
  return ev.error ?? ''
}

const createSession = (main: CdpClient, params: Record<string, unknown>): Promise<string> =>
  main.eval<string>(`window.api.session.create(${JSON.stringify(params)}).then((s) => s.id)`)

const byUserText =
  (text: string) =>
  (r: FakeRequest): boolean =>
    r.lastUserText === text

/** session 工具在父会话转写里的那几块（按出现次序） */
const sessionToolBlocks = (msgs: ListedMessage[]): Array<{ result: string; isError: boolean }> =>
  msgs.flatMap((m) =>
    (m.blocks ?? [])
      .filter((b) => b.toolName === 'session')
      .map((b) => ({ result: b.result ?? '', isError: b.isError === true }))
  )

/** 会话目录的快照：文件名 → 内容（base64）。`-wal` / `-shm` 也算 —— 重启是不是空操作就看它 */
function sessionsDirSnapshot(home: string): Record<string, string> {
  const dir = join(home, 'userdata', 'data', 'sessions')
  if (!existsSync(dir)) return {}
  return Object.fromEntries(
    readdirSync(dir)
      .sort()
      .map((name) => [name, bytesOf(join(dir, name))])
  )
}

// ─────────────────────────────────────────────────────────────────────────
// 第一组：L-1 … L-8、L-10，以及 L-7 的「重启两次」

describe('legacy sessions after the boot switchover', () => {
  let provider: FakeProvider
  let first: E2EApp | undefined
  let app: E2EApp
  let home = ''
  let chat: ChatPane
  let sidebar: SidebarPane
  let probe: SyncProbe
  let events: EventRecorder
  let projectId = ''
  /** L-2 的 [新建对话] 建出来的那条（L-10 往里发一条，证明自动标题真的在跑） */
  let newChatSid = ''

  const T = {
    chat: 'L1 legacy chat',
    del: 'L4 legacy to delete',
    clear: 'L5 legacy to clear',
    parent: 'L6 durable parent',
    child: 'L6 legacy child',
    nb: 'L7 legacy notebook',
    nbChild: 'L7 legacy child of the notebook',
    nbChildNb: 'L7 legacy child with its own notebook',
    tab: 'L8 legacy tab',
    tabChild: 'L8 legacy tab child',
    tabBad: 'L8 legacy malformed tab',
    // 标题仍是默认值：自动标题若碰得到它，首条 prompt 就会派 titler（L-10）
    l10: en.agent.defaultTitle
  } as const
  type Key = keyof typeof T | 'registry' | 'knowledge'
  const ids = {} as Record<Key, string>

  /** 启动切换之前（停着的库，种完之后）每一行的样子 */
  let beforeBoot = new Map<string, SessionRow>()
  /** 重开之后、任何用例动手之前每一行的样子 */
  let afterBoot = new Map<string, SessionRow>()
  /** 重开之后、任何用例动手之前各条绑着文件的会话有没有 `.sqlite` */
  const sqliteAtBoot: Record<string, boolean> = {}
  /** 种下的 `.jsonl` 的字节（base64） */
  const jsonlBytes: Record<string, string> = {}
  /** 重开之后第一刻的 `session.list` 顺序（只留种下的行） */
  let listOrderAtBoot: string[] = []
  /** 种的时候排好的 lastActiveAt 降序 */
  let expectedOrder: string[] = []
  /** 临时工作区里的标记文件（L-8） */
  let tabWorkspace = ''

  const L1_STEPS: LegacyStep[] = [
    { kind: 'user', text: 'L1 first question' },
    {
      kind: 'calls',
      calls: [
        {
          id: 'call_l1_read',
          name: 'read',
          arguments: { path: 'notes/a.md' },
          result: 'L1 READ RESULT'
        }
      ]
    },
    { kind: 'text', text: 'L1 FIRST ANSWER' },
    { kind: 'user', text: 'L1 second question' },
    { kind: 'error', message: 'L1 Connection error. (socket closed)' },
    { kind: 'compaction', summary: 'L1 SUMMARY OF THE EARLIER TURNS' },
    { kind: 'user', text: 'L1 third question' },
    { kind: 'text', text: 'L1 FINAL ANSWER' }
  ]
  const simpleSteps = (tag: string): LegacyStep[] => [
    { kind: 'user', text: `${tag} old question` },
    { kind: 'text', text: `${tag} OLD ANSWER` }
  ]

  /** 种下的旧格式行（「是不是被碰过」按这一组断） */
  const legacyKeys: Key[] = [
    'chat',
    'del',
    'clear',
    'child',
    'nb',
    'nbChild',
    'nbChildNb',
    'registry',
    'knowledge',
    'tab',
    'tabChild',
    'tabBad',
    'l10'
  ]
  const fileBoundKeys: Key[] = ['nb', 'registry', 'knowledge', 'nbChildNb']

  beforeAll(async () => {
    provider = await startFakeProvider()
    first = await launchApp()
    home = first.home
    await seedFakeProvider(first.main, { baseUrl: provider.baseUrl, modelId: MODEL })
    await waitRendererReady(first.main)
    await first.main.eval(`window.api.settings.set({ key: 'general.language', value: 'en' })`)

    const projDir = join(home, 'proj-legacy')
    mkdirSync(join(projDir, 'notes'), { recursive: true })
    writeFileSync(join(projDir, 'notes', 'a.md'), '# A\n')
    writeFileSync(join(projDir, 'notes', 'child.md'), '# child\n')
    projectId = (await createProject(first.main, { name: 'LegacyProj', path: projDir })).id

    const m = first.main
    ids.chat = await createSession(m, { title: T.chat, projectId })
    ids.del = await createSession(m, { title: T.del, projectId })
    ids.clear = await createSession(m, { title: T.clear, projectId })
    ids.parent = await createSession(m, { title: T.parent, projectId })
    ids.child = await createSession(m, { title: T.child, parentId: ids.parent })
    ids.nb = await createSession(m, { title: T.nb, projectId, notebookPath: 'notes/a.md' })
    ids.nbChild = await createSession(m, { title: T.nbChild, parentId: ids.nb })
    ids.nbChildNb = await createSession(m, { title: T.nbChildNb, parentId: ids.nb })
    writeAgentMd(first, 'legacy-agent', { description: 'legacy registry note' })
    const reg = await openRegistryNote(m, 'agent', 'legacy-agent.md')
    if (!reg.ok) throw new Error(`registry note: ${reg.error}`)
    ids.registry = reg.id
    seedKnowledgeBase(first, 'legacy-kb', [{ path: 'entry.md', title: 'Legacy KB entry' }])
    ids.knowledge = await m.eval<string>(
      `window.api.knowledge.openNote({ path: 'knowledge/legacy-kb/entry.md' }).then((s) => s.id)`
    )
    ids.tab = await createSession(m, { title: T.tab })
    ids.tabChild = await createSession(m, { title: T.tabChild, parentId: ids.tab })
    ids.tabBad = await createSession(m, { title: T.tabBad })
    ids.l10 = await createSession(m, { title: T.l10, projectId })

    await first.stop({ keepHome: true })
    first = undefined

    // ── 停着的库：旧版本留下的样子 ──
    const steps: Partial<Record<Key, LegacyStep[]>> = {
      chat: L1_STEPS,
      del: simpleSteps('L4'),
      clear: simpleSteps('L5'),
      child: [
        { kind: 'user', text: 'L6 child question' },
        { kind: 'text', text: 'L6 LEGACY CHILD ANSWER' }
      ]
    }
    for (const key of legacyKeys) {
      const file = seedLegacySteps({ home }, ids[key], steps[key] ?? simpleSteps(key))
      jsonlBytes[key] = bytesOf(file)
    }
    // 子会话自己也绑着一份文件（PIN-15）；标签页会话：一条合法绑定、一条 tabId -1（PIN-06）
    sqlite(
      home,
      `UPDATE sessions SET settings = json_set(settings, '$.notebookPath', 'notes/child.md') WHERE id = ${sqlLit(ids.nbChildNb)};
       UPDATE sessions SET settings = json_set(settings, '$.chromeTab', json('{"installId":"e2e-install","runId":"e2e-run","tabId":7}')) WHERE id = ${sqlLit(ids.tab)};
       UPDATE sessions SET settings = json_set(settings, '$.chromeTab', json('{"installId":"e2e-install","runId":"e2e-run","tabId":-1}')) WHERE id = ${sqlLit(ids.tabBad)};`
    )
    // 旧版本给没有项目的标签页会话建过临时工作区
    tabWorkspace = join(home, 'userdata', 'temp_workspace', ids.tab)
    mkdirSync(tabWorkspace, { recursive: true })
    writeFileSync(join(tabWorkspace, 'scratch.txt'), 'left by the old app\n')
    // lastActiveAt 各不相同（用户在不同时刻动过手）—— 侧栏顺序因此是确定的，「切换不 bump 它」才断得出来
    const allKeys = Object.keys(ids) as Key[]
    const base = Date.parse('2026-09-01T00:00:00.000Z')
    sqlite(
      home,
      allKeys
        .map(
          (key, i) =>
            `UPDATE sessions SET lastActiveAt = ${base + i * 60_000} WHERE id = ${sqlLit(ids[key])};`
        )
        .join('\n')
    )
    expectedOrder = [...allKeys].reverse().map((key) => ids[key])
    beforeBoot = rowsOf(home, Object.values(ids))

    // ── 升级后的第一次启动 ──
    app = await launchApp({ home })
    for (const key of fileBoundKeys) {
      sqliteAtBoot[key] = existsSync(durableStoragePathOf(home, ids[key]))
    }
    afterBoot = rowsOf(home, Object.values(ids))
    await waitRendererReady(app.main)
    const listed = (await listSessions(app.main)).map((s) => s.id)
    listOrderAtBoot = listed.filter((id) => Object.values(ids).includes(id))
    chat = chatPane(app.main)
    sidebar = sidebarPane(app.main)
    probe = syncProbe(app.main)
    events = eventRecorder(app.main)
    await events.install()
    await until(
      async () => (await sidebar.titles()).includes(T.chat),
      'sidebar rows after relaunch'
    )
  }, 240_000)

  afterAll(async () => {
    await first?.stop()
    await app?.stop()
    await provider?.close()
  })

  it('L-1 a legacy row renders its frozen projection: a tool block, a compaction summary card and an error row', async () => {
    const msgs = await listMessages(app.main, ids.chat)
    // 压缩摘要在最前（firstKept = 第一条消息：之前的都留在上下文里）
    expect(msgs[0]).toMatchObject({
      role: 'assistant',
      content: 'L1 SUMMARY OF THE EARLIER TURNS',
      metadata: { isCompactionSummary: true }
    })
    const toolBlocks = msgs.flatMap((m) => (m.blocks ?? []).filter((b) => b.type === 'tool'))
    expect(toolBlocks).toEqual([
      expect.objectContaining({ toolName: 'read', result: 'L1 READ RESULT' })
    ])
    const errors = msgs.filter((m) => m.type === 'error_event')
    expect(errors.map((e) => e.content)).toEqual(['L1 Connection error. (socket closed)'])
    expect(msgs.filter((m) => m.role === 'user').map((m) => m.content)).toEqual([
      'L1 first question',
      'L1 second question',
      'L1 third question'
    ])

    const view = await probe.viewOf(ids.chat)
    expect(view?.source).toBe('legacy')
    expect(view?.capabilities).toEqual({ send: false, rollback: false, continue: false })

    expect(await sidebar.openSession(T.chat)).toBe(true)
    await until(
      async () => (await chat.settledItems()).some((i) => i.text.includes('L1 FINAL ANSWER')),
      'legacy transcript painted'
    )
    const notices = await until(async () => {
      const n = await chat.systemNotices()
      return n.length > 0 ? n : null
    }, 'compaction summary card')
    expect(notices.map((n) => n.kind)).toEqual(['compaction'])
    const expanded = await chat.toggleSystemNotice(0)
    expect(expanded).toContain('L1 SUMMARY OF THE EARLIER TURNS')
    expect(await chat.toolRows()).toEqual([{ name: 'read', status: 'done' }])
    expect(await chat.errorRows()).toBe(1)
    const items = await chat.settledItems()
    expect(items.find((i) => i.type === 'error_event')?.text).toBe(
      'L1 Connection error. (socket closed)'
    )
  })

  it('L-2 the banner is shown, the composer is disabled with an empty placeholder, a forced agent.prompt gets legacySessionReadOnly, and [New chat] opens a session in the same project', async () => {
    const banner = await until(() => chat.legacyBanner(), 'legacy banner')
    expect(banner).toEqual({
      text: READ_ONLY,
      newChatLabel: en.sidebar.newChat,
      newChatDisabled: false
    })
    expect(await chat.interruptedBanner()).toBeNull()
    expect(await chat.composer()).toEqual({ present: true, disabled: true, placeholder: '' })
    expect(await chat.sendDisabled()).toBe(true)

    const before = await listMessages(app.main, ids.chat)
    const requestsBefore = provider.requests().length
    expect(await forcedPrompt(app.main, events, ids.chat, 'L2 forced prompt')).toBe(READ_ONLY)
    expect(await listMessages(app.main, ids.chat)).toEqual(before)
    expect(
      provider
        .requests()
        .slice(requestsBefore)
        .map((r) => r.lastUserText)
    ).not.toContain('L2 forced prompt')
    expect(bytesOf(legacyTranscriptPathOf(home, ids.chat))).toBe(jsonlBytes.chat)
    expect(existsSync(durableStoragePathOf(home, ids.chat))).toBe(false)
    expect(rowOf(home, ids.chat)?.storageKind).toBe(LEGACY)

    const [created] = await newSessionsAfter(app.main, async () => {
      expect(await chat.clickLegacyNewChat()).toBe(true)
    })
    const fresh = await app.main.eval<ListedSession & { title: string }>(
      `window.api.session.getById(${JSON.stringify(created)})`
    )
    expect(fresh.projectId).toBe(projectId)
    newChatSid = created
    await until(async () => (await sidebar.activeTitle()) === fresh.title, 'new chat selected')
    await until(async () => (await chat.legacyBanner()) === null, 'banner gone on the new chat')
    expect((await chat.composer()).disabled).toBe(false)
    expect(rowOf(home, created)?.storageKind).toBe(DURABLE)
  })

  it('L-3 a legacy view offers no rollback, regenerate or edit controls, and a forced rollback is refused', async () => {
    expect(await sidebar.openSession(T.chat)).toBe(true)
    await until(async () => (await chat.legacyBanner()) !== null, 'legacy banner back')
    await until(
      async () => (await chat.settledItems()).some((i) => i.text.includes('L1 FINAL ANSWER')),
      'legacy transcript painted'
    )
    expect(await chat.historyControls()).toEqual({ rollback: 0, regenerate: 0, edit: 0 })
    const msgs = await listMessages(app.main, ids.chat)
    for (const user of msgs.filter((m) => m.role === 'user')) {
      expect(await chat.rollbackVisible(user.id)).toBe(false)
    }
    const target = msgs.find((m) => m.role === 'user')!
    const rolled = await app.main.eval<{ success: boolean }>(
      `window.api.message.rollback(${JSON.stringify({ sessionId: ids.chat, messageId: target.id })})`
    )
    expect(rolled.success).toBe(false)
    expect(await listMessages(app.main, ids.chat)).toEqual(msgs)
    expect(bytesOf(legacyTranscriptPathOf(home, ids.chat))).toBe(jsonlBytes.chat)
  })

  it('L-4 deleting a legacy row (row menu → delete → confirm) removes the row and its .jsonl', async () => {
    expect(existsSync(legacyTranscriptPathOf(home, ids.del))).toBe(true)
    await sidebar.pickRowMenu(T.del, 'delete-session')
    const confirm = confirmPane(app.main)
    await confirm.waitOpen()
    await confirm.confirm()
    await until(async () => !rowOf(home, ids.del), 'legacy row deleted')
    expect(
      await app.main.eval(`window.api.session.getById(${JSON.stringify(ids.del)})`)
    ).toBeFalsy()
    expect(existsSync(legacyTranscriptPathOf(home, ids.del))).toBe(false)
    expect(existsSync(durableStoragePathOf(home, ids.del))).toBe(false)
    await until(async () => !(await sidebar.titles()).includes(T.del), 'row gone from the sidebar')
  })

  it('L-5 clearing a legacy row makes it durable while it is open: the banner goes, the .jsonl is gone, and a send succeeds', async () => {
    expect(await sidebar.openSession(T.clear)).toBe(true)
    await until(() => chat.legacyBanner(), 'legacy banner before the clear')

    await app.main.eval(`window.api.message.clear(${JSON.stringify(ids.clear)})`)
    expect(rowOf(home, ids.clear)?.storageKind).toBe(DURABLE)
    expect(existsSync(legacyTranscriptPathOf(home, ids.clear))).toBe(false)
    await until(async () => (await chat.legacyBanner()) === null, 'banner gone after the clear')
    await until(async () => !(await chat.composer()).disabled, 'composer enabled after the clear')
    expect(await listMessages(app.main, ids.clear)).toEqual([])

    provider.script({ text: 'L5 REPLY', when: byUserText('L5 after the clear') })
    await chat.typeAndSend('L5 after the clear')
    await until(async () => {
      const msgs = await listMessages(app.main, ids.clear)
      return msgs.some((m) => m.role === 'assistant' && m.content.includes('L5 REPLY'))
    }, 'reply landed in the cleared session')
    const msgs = await listMessages(app.main, ids.clear)
    expect(msgs.map((m) => `${m.role}:${m.content}`)).toEqual([
      'user:L5 after the clear',
      'assistant:L5 REPLY'
    ])
    expect(existsSync(durableStoragePathOf(home, ids.clear))).toBe(true)
    expect(existsSync(legacyTranscriptPathOf(home, ids.clear))).toBe(false)
    // 新格式之后回退 / 重新生成就回来了 —— 也证明 L-3 数的那两种图标认法是对的（不是恒为 0）
    await until(async () => {
      const c = await chat.historyControls()
      return c.rollback >= 1 && c.regenerate >= 1
    }, 'rollback / regenerate controls on the cleared session')
  })

  it('L-6 a durable parent reads its legacy child through the session tool, and a prompt to it is refused cleanly', async () => {
    const P6 = 'L6 check the legacy child'
    const childBefore = await listMessages(app.main, ids.child)
    provider.script(
      {
        toolCalls: [
          {
            id: 'call_l6_read',
            name: 'session',
            args: JSON.stringify({ action: 'read-sub-session', sub_session_id: ids.child })
          }
        ],
        when: byUserText(P6)
      },
      {
        toolCalls: [
          {
            id: 'call_l6_prompt',
            name: 'session',
            args: JSON.stringify({
              action: 'prompt-sub-session',
              sub_session_id: ids.child,
              message: 'L6 try to continue'
            })
          }
        ],
        when: byUserText(P6)
      },
      { text: 'L6 DONE', when: byUserText(P6) }
    )
    await prompt(app.main, ids.parent, P6)

    const blocks = sessionToolBlocks(await listMessages(app.main, ids.parent))
    expect(blocks).toHaveLength(2)
    expect(blocks[0].isError).toBe(false)
    expect(blocks[0].result).toContain('L6 LEGACY CHILD ANSWER')
    expect(blocks[1].isError).toBe(true)
    expect(blocks[1].result).toContain(READ_ONLY)
    expect(blocks[1].result).toContain('NOT delivered')

    // 子会话一个字都没动：没有请求、转写不变、还是旧格式、没有 .sqlite
    expect(provider.requests().map((r) => r.lastUserText)).not.toContain('L6 try to continue')
    expect(await listMessages(app.main, ids.child)).toEqual(childBefore)
    expect(bytesOf(legacyTranscriptPathOf(home, ids.child))).toBe(jsonlBytes.child)
    expect(rowOf(home, ids.child)?.storageKind).toBe(LEGACY)
    expect(existsSync(durableStoragePathOf(home, ids.child))).toBe(false)
  })

  it('L-7 file-bound legacy rows are durable after the restart: same id, only storageKind and updatedAt moved, .jsonl kept, no .sqlite before the first open', () => {
    for (const key of fileBoundKeys) {
      const was = beforeBoot.get(ids[key])!
      const now = afterBoot.get(ids[key])!
      expect(was.storageKind, key).toBe(LEGACY)
      expect(now.storageKind, key).toBe(DURABLE)
      // 只动了这两列：标题、项目、父子、settings 原文、建立时间、lastActiveAt 都是原样
      const { updatedAt: wasUpdated, storageKind: _wasKind, ...wasRest } = was
      const { updatedAt: nowUpdated, storageKind: _nowKind, ...nowRest } = now
      expect(nowRest, key).toEqual(wasRest)
      expect(nowUpdated, key).toBeGreaterThan(wasUpdated)
      expect(sqliteAtBoot[key], `${key}: .sqlite before the first open`).toBe(false)
      expect(bytesOf(legacyTranscriptPathOf(home, ids[key])), `${key}: .jsonl bytes`).toBe(
        jsonlBytes[key]
      )
    }
    // 其余旧格式行（含笔记本那条自己没有 notebookPath 的子会话）一列都没动
    for (const key of legacyKeys.filter(
      (k) => !fileBoundKeys.includes(k) && !['tab', 'tabChild'].includes(k)
    )) {
      expect(afterBoot.get(ids[key]), key).toEqual(beforeBoot.get(ids[key]))
    }
  })

  it('L-7 the session list of the first boot keeps the order seeded before it (lastActiveAt was not bumped)', () => {
    // 标签页会话已删；其余种下的行全在、顺序与 lastActiveAt 降序一致
    const visible = expectedOrder.filter((id) => id !== ids.tab && id !== ids.tabChild)
    expect(listOrderAtBoot).toEqual(visible)
  })

  it('L-7 find-or-create still returns the flipped rows, and a legacy child without its own notebookPath stays read-only', async () => {
    const reg = await openRegistryNote(app.main, 'agent', 'legacy-agent.md')
    expect(reg).toMatchObject({ ok: true, id: ids.registry })
    const kb = await app.main.eval<string>(
      `window.api.knowledge.openNote({ path: 'knowledge/legacy-kb/entry.md' }).then((s) => s.id)`
    )
    expect(kb).toBe(ids.knowledge)

    expect(rowOf(home, ids.nbChild)?.storageKind).toBe(LEGACY)
    expect(await forcedPrompt(app.main, events, ids.nbChild, 'L7 forced child prompt')).toBe(
      READ_ONLY
    )
    expect((await probe.viewOf(ids.nbChild))?.source).toBe('legacy')
    expect((await listMessages(app.main, ids.nbChild)).map((m) => m.content)).toEqual([
      'nbChild old question',
      'nbChild OLD ANSWER'
    ])
    expect(rowOf(home, ids.nbChildNb)?.storageKind).toBe(DURABLE)
  })

  it('L-7 the notebook chats of the flipped rows open empty and can send', async () => {
    for (const key of ['nb', 'registry', 'knowledge'] as const) {
      const sid = ids[key]
      // 没打开过的新格式会话：还没有存储（'none'），能发、是空的 —— 不再是旧格式视图
      const view = await probe.viewOf(sid)
      expect(view?.source, key).toBe('none')
      expect(view?.capabilities.send, key).toBe(true)
      expect(view?.messages, key).toEqual([])
      expect(await listMessages(app.main, sid), key).toEqual([])

      const text = `L7 ${key} first message`
      provider.script({ text: `L7 ${key.toUpperCase()} REPLY`, when: byUserText(text) })
      await prompt(app.main, sid, text)
      expect(
        (await listMessages(app.main, sid)).map((m) => `${m.role}:${m.content}`),
        key
      ).toEqual([`user:${text}`, `assistant:L7 ${key.toUpperCase()} REPLY`])
      expect(existsSync(durableStoragePathOf(home, sid)), key).toBe(true)
      await probe.waitView(sid, (v) => v.source === 'durable' && v.messages.length === 2)
      // 打开、发消息都不读也不删旧转写
      expect(bytesOf(legacyTranscriptPathOf(home, sid)), key).toBe(jsonlBytes[key])
    }
  })

  it('L-8 the legacy tab row is deleted at boot with its child, temp workspace and .jsonl; a malformed binding stays a read-only legacy row', async () => {
    expect(beforeBoot.get(ids.tab)?.storageKind).toBe(LEGACY)
    expect(afterBoot.has(ids.tab)).toBe(false)
    expect(afterBoot.has(ids.tabChild)).toBe(false)
    expect(existsSync(legacyTranscriptPathOf(home, ids.tab))).toBe(false)
    expect(existsSync(legacyTranscriptPathOf(home, ids.tabChild))).toBe(false)
    expect(existsSync(tabWorkspace)).toBe(false)

    const bad = afterBoot.get(ids.tabBad)
    expect(bad).toEqual(beforeBoot.get(ids.tabBad))
    expect(bad?.storageKind).toBe(LEGACY)
    expect(bytesOf(legacyTranscriptPathOf(home, ids.tabBad))).toBe(jsonlBytes.tabBad)
    expect((await listMessages(app.main, ids.tabBad)).map((m) => m.content)).toEqual([
      'tabBad old question',
      'tabBad OLD ANSWER'
    ])
    expect(await forcedPrompt(app.main, events, ids.tabBad, 'L8 forced prompt')).toBe(READ_ONLY)

    // 这次启动的汇总：四条绑着文件的行重置、一条标签页会话删掉（子会话随级联走，不单独计）
    const runs = legacySwitchoverRuns(app)
    expect(runs.at(-1)).toMatchObject({ reset: 4, deleted: 1, failed: 0 })
  })

  it('L-10 the monitor list and auto-title never touch legacy rows', async () => {
    const legacyIds = [ids.chat, ids.child, ids.nbChild, ids.tabBad, ids.l10]
    // 一条默认标题的新格式会话（L-2 的 [新建对话]）发首条：自动标题真的在跑，派了 titler
    provider.script({ text: 'L10 REPLY', when: byUserText('L10 hello') })
    await prompt(app.main, newChatSid, 'L10 hello')
    const titlerTargets = (): Set<string> =>
      new Set(
        provider
          .requests()
          .filter((r) => r.lastUserText.startsWith(TITLER_BODY))
          .flatMap((r) => [...r.lastUserText.matchAll(/sessionId: (\S+)/g)].map((x) => x[1]))
      )
    await until(() => titlerTargets().has(newChatSid), 'titler dispatched for the new chat')
    // 同样是默认标题的旧格式行：硬发一条被拒，titler 从没为它派过
    expect(await forcedPrompt(app.main, events, ids.l10, 'L10 forced prompt')).toBe(READ_ONLY)
    await sleep(1500)
    const titled = titlerTargets()
    for (const id of legacyIds) expect(titled.has(id), id).toBe(false)
    // 旧格式行的标题与标题来源原样（打开过、硬发过 prompt 都没让它们变）
    const now = rowsOf(home, legacyIds)
    for (const id of legacyIds) {
      expect(now.get(id)?.title, id).toBe(beforeBoot.get(id)?.title)
      expect(JSON.parse(now.get(id)!.settings).titleOrigin, id).toBe(
        JSON.parse(beforeBoot.get(id)!.settings).titleOrigin
      )
    }

    // 监视器只列打开着的新格式会话：父会话、发过消息的笔记本都在，旧格式行（打开过、读过、硬发过）一条都没有
    const monitor = await app.main.eval<Array<{ rootSessionId: string }>>(
      'window.api.agent.monitorList()'
    )
    const roots = new Set(monitor.map((e) => e.rootSessionId))
    expect(roots.has(ids.parent)).toBe(true)
    expect(roots.has(newChatSid)).toBe(true)
    for (const id of legacyIds) expect(roots.has(id), id).toBe(false)
  })

  it('L-7 restarting again is a no-op: rows (incl. updatedAt) and the sessions dir are unchanged, and the log reads reset=0 deleted=0 failed=0', async () => {
    await app.stop({ keepHome: true })
    const rowsBefore = sqliteJson(home, `SELECT ${ROW_COLUMNS} FROM sessions ORDER BY id`)
    const dirBefore = sessionsDirSnapshot(home)

    app = await launchApp({ home })
    const rowsAfter = sqliteJson(home, `SELECT ${ROW_COLUMNS} FROM sessions ORDER BY id`)
    expect(rowsAfter).toEqual(rowsBefore)
    expect(sessionsDirSnapshot(home)).toEqual(dirBefore)

    const runs = legacySwitchoverRuns(app)
    // 三次启动各恰一行：全新的那次、升级后第一次、这一次
    expect(runs.map(({ reset, deleted, failed }) => ({ reset, deleted, failed }))).toEqual([
      { reset: 0, deleted: 0, failed: 0 },
      { reset: 4, deleted: 1, failed: 0 },
      { reset: 0, deleted: 0, failed: 0 }
    ])
    // 新格式的笔记本对话照旧在
    await waitRendererReady(app.main)
    expect((await listMessages(app.main, ids.nb)).map((m) => m.role)).toEqual(['user', 'assistant'])
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 第二组：L-9 —— 库被拨回 v29

describe('L-9 a DB rewound to v29', () => {
  let provider: FakeProvider
  let first: E2EApp | undefined
  let app: E2EApp
  let home = ''
  const ids = { nb: '', legacyNb: '', chat: '', tab: '' }
  let nbRowBefore: SessionRow | undefined
  let chatRowBefore: SessionRow | undefined
  let nbMessagesBefore: string[] = []
  let legacyNbJsonl = ''

  beforeAll(async () => {
    provider = await startFakeProvider()
    first = await launchApp()
    home = first.home
    await seedFakeProvider(first.main, { baseUrl: provider.baseUrl, modelId: MODEL })
    await waitRendererReady(first.main)
    await first.main.eval(`window.api.settings.set({ key: 'general.language', value: 'en' })`)
    const projDir = join(home, 'proj-rewind')
    mkdirSync(join(projDir, 'notes'), { recursive: true })
    writeFileSync(join(projDir, 'notes', 'r.md'), '# R\n')
    writeFileSync(join(projDir, 'notes', 'l.md'), '# L\n')
    const projectId = (await createProject(first.main, { name: 'RewindProj', path: projDir })).id

    const m = first.main
    ids.nb = await createSession(m, {
      title: 'L9 durable notebook',
      projectId,
      notebookPath: 'notes/r.md'
    })
    ids.legacyNb = await createSession(m, {
      title: 'L9 legacy notebook',
      projectId,
      notebookPath: 'notes/l.md'
    })
    ids.chat = await createSession(m, { title: 'L9 durable chat', projectId })
    ids.tab = await createSession(m, { title: 'L9 durable tab' })
    provider.script(
      { text: 'L9 EARLIER ANSWER', when: byUserText('L9 earlier turn') },
      { text: 'L9 CHAT ANSWER', when: byUserText('L9 chat turn') }
    )
    await prompt(m, ids.nb, 'L9 earlier turn')
    await prompt(m, ids.chat, 'L9 chat turn')
    nbMessagesBefore = (await listMessages(m, ids.nb)).map((x) => `${x.role}:${x.content}`)
    expect(nbMessagesBefore).toEqual(['user:L9 earlier turn', 'assistant:L9 EARLIER ANSWER'])

    await first.stop({ keepHome: true })
    first = undefined

    sqlite(
      home,
      `UPDATE sessions SET settings = json_set(settings, '$.chromeTab', json('{"installId":"e2e-install","runId":"e2e-run","tabId":3}')) WHERE id = ${sqlLit(ids.tab)}`
    )
    legacyNbJsonl = bytesOf(
      seedLegacySteps({ home }, ids.legacyNb, [
        { kind: 'user', text: 'L9 genuine legacy question' },
        { kind: 'text', text: 'L9 GENUINE LEGACY ANSWER' }
      ])
    )
    nbRowBefore = rowOf(home, ids.nb)
    chatRowBefore = rowOf(home, ids.chat)
    // 之前是新格式：带镜像键（agent 锁 / 运行状态），`.sqlite` 在盘上
    expect(nbRowBefore?.storageKind).toBe(DURABLE)
    expect(JSON.parse(nbRowBefore!.settings)).toHaveProperty('runState')
    expect(existsSync(durableStoragePathOf(home, ids.nb))).toBe(true)
    expect(existsSync(durableStoragePathOf(home, ids.chat))).toBe(true)

    rewindSessionsToV29(home)

    app = await launchApp({ home })
    await waitRendererReady(app.main)
  }, 240_000)

  afterAll(async () => {
    await first?.stop()
    await app?.stop()
    await provider?.close()
  })

  it('L-9 v30 re-ran: the column is back, user_version is 30, and the switchover ran on the all-legacy rows', () => {
    const columns = sqliteJson<{ name: string; dflt_value: string }>(
      home,
      'PRAGMA table_info(sessions)'
    )
    expect(columns.find((c) => c.name === 'storageKind')?.dflt_value).toBe(`'${LEGACY}'`)
    expect(sqlite(home, 'PRAGMA user_version').trim()).toBe('30')
    const runs = legacySwitchoverRuns(app)
    expect(runs.at(-1)).toMatchObject({ reset: 2, deleted: 1, failed: 0 })
  })

  it('L-9 a row that was durable before reopens its own .sqlite with its earlier turns, and its mirror keys are untouched', async () => {
    const now = rowOf(home, ids.nb)!
    expect(now.storageKind).toBe(DURABLE)
    expect(now.settings).toBe(nbRowBefore!.settings)
    expect(now.lastActiveAt).toBe(nbRowBefore!.lastActiveAt)
    expect((await listMessages(app.main, ids.nb)).map((x) => `${x.role}:${x.content}`)).toEqual(
      nbMessagesBefore
    )
  })

  it('L-9 a genuine legacy notebook row flips back to a fresh durable session and keeps its .jsonl', async () => {
    expect(rowOf(home, ids.legacyNb)?.storageKind).toBe(DURABLE)
    expect(await listMessages(app.main, ids.legacyNb)).toEqual([])
    expect(bytesOf(legacyTranscriptPathOf(home, ids.legacyNb))).toBe(legacyNbJsonl)
  })

  it('L-9 the rewound tab row is deleted', () => {
    expect(rowOf(home, ids.tab)).toBeUndefined()
  })

  it('L-9 a durable chat without notebookPath stays legacy and read-only (expected: only file-bound rows are flipped back)', async () => {
    const now = rowOf(home, ids.chat)!
    expect(now.storageKind).toBe(LEGACY)
    expect(now.updatedAt).toBe(chatRowBefore!.updatedAt)
    // 没有 .jsonl：旧格式视图是空的；它自己的 .sqlite 还在盘上，只是不再被打开
    expect(await listMessages(app.main, ids.chat)).toEqual([])
    expect(existsSync(durableStoragePathOf(home, ids.chat))).toBe(true)
    const events = eventRecorder(app.main)
    await events.install()
    expect(await forcedPrompt(app.main, events, ids.chat, 'L9 forced prompt')).toBe(READ_ONLY)
    const probe = syncProbe(app.main)
    expect((await probe.viewOf(ids.chat))?.source).toBe('legacy')
  })
})
