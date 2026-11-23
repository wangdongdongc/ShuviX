/**
 * 文件库 L1（设计稿 docs/file-library-design.md，用例稿 docs/file-library-l1-tests.md §12）—— 单测各管一段
 * （fileLibrary / libraryHandlers / attachments / libraryEditor / fileToolSuite / 策略 …），这里把它们替身掉的那几段
 * 在真实实例里串起来：笔记里粘贴 → `library.add` → 库目录与元数据表 → 编辑器经 `shuvix-preview://…path=library%3A<id>`
 * 解出图 → 自动保存写盘 → 笔记的派生关联；对话里发图进库；agent 的 `read` 打开 `shuvix://file/<id>` 时
 * `ask-on-library-access` 按「会话关联」决定问不问；删会话只删关联。
 *
 *   FLE-1 笔记 N 末尾粘贴截图 P1（40×24，没有文字）→ 正文恰一条 `![](shuvix://file/<id>/pasted-YYYYMMDD-HHMMSS.png)`
 *         （alt 空、id 是 UUID、没有「Adding…」）；编辑器里那张图解码出 40 宽，地址是 shuvix-preview:// 带
 *         `library%3A<id>`；盘上那一份与 P1 逐字节相同；元数据一行（note-paste / image / 40×24 / managed / 不在回收站 /
 *         sha256(P1)）；N 有一条 `attached` 会话关联；自动保存后 lib-note.md 里有这条链接、笔记有一条 `embedded` 关联
 *   FLE-2 再贴一次 P1 → 同一个 id、库里仍一行一个目录；再贴 sample.pdf → `[sample.pdf](shuvix://file/<id2>/sample.pdf)`；
 *         真鼠标点它 → 预览窗口开的是库目录里那份文件
 *   FLE-3 对话 C 里经 `agent.prompt` 发 P2（32×32）→ 库里多一行 chat-image（`image-YYYYMMDD-HHMMSS.png`，字节同 P2）、
 *         C 有一条 `sent` 关联（context 的 entryId = 那条用户消息）；发给模型的请求里仍有这张图
 *   FLE-4 agent 读库：N 读 P1 不问（有 `attached` 关联；决策 library / allow）、拿到图；C 读 P1 恰问一次
 *         （卡片 `Read library file "pasted-….png" (<id>)`，winning `ask-on-library-access#0`），放行后拿到图；
 *         C 读自己发过的 P2 不问；N 换成库目录里的**绝对路径**读 P1 → 走路径门，问 `ask-on-external-path#0`
 *   FLE-5 删掉 C → 它的关联没了，P2 那件的元数据与文件都在，N 与笔记的关联不受影响（文件留在时间线上，
 *         当天那一行不再带会话名：TLE-2 用另一条会话钉这件事）
 *
 * 文件时间线（右侧面板的文件标签；用例稿 docs/file-library-timeline-tests.md §13），接在 FLE-5 后面、同一个实例：
 *   TLE-1 对话 D 发 P3（24×24）→ `library.timeline()` 里 P3 在 D 名下（sent，标题与项目名齐）；文件标签里 D 名下
 *         恰有这一行（`data-relation="sent"`、不 missing、第二行写 D 的标题与大小），N 名下有 P1 的一行（attached）；
 *         点这一行 → 看图层，再开预览窗口开的是库里那份；点行里的会话名 → 活动会话变成 D
 *   TLE-2 删掉 D（标签一直开着：`library.changed` → 重取）→ D 名下没有行了，P3 在同一天剩一行、不带会话名；
 *         timeline 里 sessionId 为 null、sessions 里没有 D；元数据与字节都在
 *   TLE-3 对话 E 里脚本 agent 用 `artifact` 工具建 `Timeline chart` → 库里一行 artifact / linked（externalPath 在
 *         `~/.shuvix/artifacts/<E>/`，库目录里没有它），E 名下 `produced`；删掉 E → 变 managed（externalPath 空、
 *         sha256 = 产物字节），字节在库目录里，产物目录没了，时间线上那一行不带会话名、不 missing
 *
 * 夹具：项目目录在 fake HOME 里（工作目录，读不问）；笔记本会话 N（绝对 notebookPath，标题 = 文件名）与普通会话 C
 * （非默认标题：自动标题不来抢假提供商的请求），都在这个项目里。脚本一律按这一步的用户消息认领（`promptOf`：
 * 工具结果里的图会被 pi-ai 另放进一条「Attached image(s) from tool result:」用户消息，那条不算）。auto-review 关着
 * （缺省），询问由 `installAutoAllow(only)` 或用例自己回答。界面语言 en。选择器全部走 `harness/pages.ts`
 * （`notebookEditorPane` 的 docText / caretToEnd / insertAtCaret / pasteFiles / attachPlaceholders）。
 *
 * 决策日志里没有 `linked` 这个字段（`SecurityDecisionRecord` 只记客体种类与摘要）：「有关联」由 allow + 没命中
 * `ask-on-library-access#0` + 关联表里那一行 `attached` / `sent` 合起来证明。
 *         TLE-6（并在 TLE-3 末尾）会话删掉之后行菜单没有「打开所属会话」；`library.locate` 给库里那份（managed）；
 *         把盘上那份删掉 → missing、「在文件夹中显示」置灰、「复制路径」还在
 *   TLE-4 行菜单（docs/file-library-open-reveal-tests.md §5）：对话 F 的产物（linked）与笔记里的 P1（managed）都是
 *         open, openSession | copyPath, reveal；`library.locate` 各给各的位置；选「复制路径」→ 剪贴板记录器里是产物的
 *         真实路径（= 库里那行的 externalPath = artifact.read 的 path）。「在文件夹中显示」只看在不在，不点
 *   TLE-5 留在原位置的 md 产物点开是协作编辑的 md 窗口（有编辑器与输入卡片、正文是产物的内容）；托管的 md 点开是
 *         只读预览窗口（库目录里那份）
 */
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { InputRequest } from '@shuvix/chat-protocol/types/inputRequest'
import { until } from '../../harness/cdp'
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
  autoAllowed,
  createProject,
  eventRecorder,
  installAutoAllow,
  securityDecisions,
  seedFakeProvider,
  sqlLit,
  sqliteJson,
  waitRendererReady,
  writePng,
  type EventRecorder,
  type SecurityDecisionEntry
} from '../../harness/seed'
import { syncProbe, type SyncProbe } from '../../harness/sync'
import {
  imageViewerPane,
  libraryTimelinePane,
  markdownWindowPane,
  notebookEditorPane,
  sidebarPane,
  type LibraryTimelineRowShot,
  type LibraryTimelinePane,
  type MenuItemShot,
  type NotebookEditorPane,
  type PasteFileSeed
} from '../../harness/pages'

const MODEL = 'e2e-model'
const USAGE = { prompt: 120, completion: 12 }
const TURN_TIMEOUT = 60_000

const NOTE_FILE = 'lib-note.md'
const NOTE = '# Lib note\n\nend.\n'
const CHAT_TITLE = 'Library chat'
const D_TITLE = 'Timeline chat D'
const E_TITLE = 'Timeline chat E'
const F_TITLE = 'Timeline chat F'
const ARTIFACT_TITLE = 'Timeline chart'
const ARTIFACT_SVG =
  '<svg viewBox="0 0 40 20" aria-label="Timeline chart" xmlns="http://www.w3.org/2000/svg">' +
  '<rect width="10" height="20" fill="var(--viz-1)"/></svg>'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const PASTED_NAME_RE = /^pasted-\d{8}-\d{6}\.png$/
const SENT_NAME_RE = /^image-\d{8}-\d{6}\.png$/
/** pi-ai（openai-completions）把工具结果里的图另放进这样开头的一条用户消息 */
const TOOL_IMAGE_NOTE = 'Attached image(s) from tool result:'

/** 一页的最小 PDF：预览按扩展名分类，内容只要像个 PDF */
const PDF = Buffer.from(
  [
    '%PDF-1.4',
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj',
    'trailer<</Root 1 0 R>>',
    '%%EOF',
    ''
  ].join('\n')
)

interface ItemRow {
  id: string
  name: string
  kind: string
  source: string
  storage: string
  deletedAt: number | null
  sha256: string
  fileName: string
  mime: string
  width: number | null
  height: number | null
}

interface LinkRow {
  itemId: string
  targetType: string
  targetId: string
  relation: string
  origin: string
  context: string | null
}

interface ListedMessage {
  id: string
  role: string
  content: string
}

/** 请求体里的一条消息（`tool_call_id` 是 OpenAI 形状的工具结果消息才有的） */
interface WireMessage {
  role?: string
  content?: unknown
  tool_call_id?: string
}

/** 正文里的一条库链接 */
interface LibraryLinkShot {
  image: boolean
  label: string
  id: string
  name: string
}

let app: E2EApp
let provider: FakeProvider
let events: EventRecorder
let probe: SyncProbe
let editor: NotebookEditorPane
let notePath = ''
let nSid = ''
let cSid = ''
let p1: Buffer
let p2: Buffer
let p1Id = ''
let p1Name = ''
let pdfId = ''
let p2Id = ''
let p2Name = ''
// 时间线用例（TLE-*）
let timeline: LibraryTimelinePane
let projectId = ''
let dSid = ''
let fSid = ''
let p3: Buffer
let p3Id = ''
let p3Name = ''

// ─── 小助手 ──────────────────────────────────────

const b64 = (buf: Buffer): string => buf.toString('base64')
const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex')

const libraryDir = (): string => join(app.home, '.shuvix', 'library', 'files')
const itemFileOf = (id: string, name: string): string =>
  join(libraryDir(), id.slice(0, 2), id, name)
/** 盘上库目录里的每一件（`<前两位>/<id>` 的 id），排好序 */
const itemDirsOnDisk = (): string[] =>
  existsSync(libraryDir())
    ? readdirSync(libraryDir())
        .flatMap((prefix) => readdirSync(join(libraryDir(), prefix)))
        .sort()
    : []

/** 每件连同它的当前版本，按进库先后 */
const itemRows = (): ItemRow[] =>
  sqliteJson<ItemRow>(
    app.home,
    `SELECT i.id, i.name, i.kind, i.source, i.storage, i.deletedAt,
            v.sha256, v.fileName, v.mime, v.width, v.height
       FROM library_items i
       JOIN library_versions v ON v.itemId = i.id AND v.version = i.currentVersion
      ORDER BY i.createdAt, i.id`
  )

const linkRows = (where: string): LinkRow[] =>
  sqliteJson<LinkRow>(
    app.home,
    `SELECT itemId, targetType, targetId, relation, origin, context
       FROM library_links WHERE ${where} ORDER BY itemId, targetType, targetId, relation`
  )
const sessionLinks = (sid: string): LinkRow[] =>
  linkRows(`targetType = 'session' AND targetId = ${sqlLit(sid)}`)
const noteLinks = (): LinkRow[] => linkRows(`targetType = 'note'`)

const LINK_RE = /(!?)\[([^\]]*)\]\(shuvix:\/\/file\/([0-9a-f-]{36})\/([^)\s]+)\)/g
const libraryLinksIn = (text: string): LibraryLinkShot[] =>
  [...text.matchAll(LINK_RE)].map((m) => ({
    image: m[1] === '!',
    label: m[2],
    id: m[3],
    name: m[4]
  }))

const listMessages = (sid: string): Promise<ListedMessage[]> =>
  app.main.eval<ListedMessage[]>(`window.api.message.list(${JSON.stringify(sid)})`)

/** 这一步的用户消息（最后一条不是「工具结果里的图」的用户消息） */
const promptOf = (r: FakeRequest): string =>
  userTextsOf(r)
    .filter((t) => !t.startsWith(TOOL_IMAGE_NOTE))
    .pop() ?? ''

const wireMessages = (r: FakeRequest): WireMessage[] => (r.body.messages ?? []) as WireMessage[]

/** 一条消息内容里的图片地址（`image_url` 块） */
const imageUrlsOf = (content: unknown): string[] =>
  Array.isArray(content)
    ? (content as Array<{ type?: string; image_url?: { url?: string } }>)
        .filter((p) => p?.type === 'image_url')
        .map((p) => p.image_url?.url ?? '')
    : []

/** 第一次带着这个工具结果的请求（= 工具调用之后模型收到的那一次） */
const requestWithResult = (callId: string): FakeRequest | undefined =>
  provider
    .requests()
    .find((r) => wireMessages(r).some((m) => m.role === 'tool' && m.tool_call_id === callId))

/** 紧跟在这个工具结果之后的那条用户消息里的图（工具结果里的图被 pi-ai 放在这里） */
const imagesAfterResult = (r: FakeRequest | undefined, callId: string): string[] => {
  if (!r) return []
  const msgs = wireMessages(r)
  const at = msgs.findIndex((m) => m.role === 'tool' && m.tool_call_id === callId)
  if (at < 0) return []
  const next = msgs.slice(at + 1).find((m) => m.role === 'user')
  return imageUrlsOf(next?.content)
}

const readCall = (id: string, path: string): { id: string; name: string; args: string } => ({
  id,
  name: 'read',
  args: JSON.stringify({ path })
})

/**
 * 发一条用户消息、不等它（这一轮可能停在询问上），回发之前的事件序号。脚本按这一步的用户消息认领
 */
const send = async (
  sid: string,
  text: string,
  turns: FakeTurn[],
  images?: Array<{ type: 'image'; data: string; mimeType: string }>
): Promise<number> => {
  provider.script(
    ...turns.map((t) => ({
      usage: USAGE,
      ...t,
      when: (r: FakeRequest) => promptOf(r).includes(text)
    }))
  )
  const since = await events.mark()
  await app.main.eval(
    `(() => {
      window.api.agent
        .prompt(${JSON.stringify({ sessionId: sid, text, ...(images ? { images } : {}) })})
        .catch(() => undefined)
      return true
    })()`
  )
  return since
}

const ended = async (sid: string, since: number): Promise<void> => {
  await events.waitFor('agent_end', { sessionId: sid, since, timeoutMs: TURN_TIMEOUT })
}

/** 这次工具调用在库客体上的那条决策（放行也记） */
const libraryDecisionOf = (callId: string): SecurityDecisionEntry | undefined =>
  securityDecisions(app).find((d) => d.toolCallId === callId && d.objectKind === 'library')

/** 用户在卡片上点「允许一次」/「拒绝」（与 installAutoAllow 同一条 IPC） */
const answer = (sid: string, req: InputRequest, allowed: boolean): Promise<unknown> =>
  app.main.eval(
    `window.api.agent.respondToInput(${JSON.stringify({
      sessionId: sid,
      requestId: req.id,
      response: { kind: req.kind, allowed, selections: [] }
    })})`
  )

/** 粘贴文件并等它们的链接都写进正文、占位都消失 */
const pasteAndWait = async (
  files: PasteFileSeed[],
  linkCount: number,
  what: string
): Promise<{ doc: string; links: LibraryLinkShot[] }> => {
  expect(await editor.pasteFiles(files)).toBe(true)
  return until(async () => {
    const doc = await editor.docText()
    const links = libraryLinksIn(doc)
    if (links.length < linkCount) return null
    if ((await editor.attachPlaceholders()).length > 0) return null
    return { doc, links }
  }, what)
}

/** 光标放到文末再起一个新行（下一次粘贴落在单独一行） */
const newLineAtEnd = async (): Promise<void> => {
  await editor.caretToEnd()
  const before = await editor.docText()
  await editor.insertAtCaret('\n')
  // Chromium 的 insertText 把换行当分段：落下的可能是一个也可能是两个换行，只要文末多出来的全是换行
  await until(async () => {
    const doc = await editor.docText()
    return (doc.startsWith(before) && /^\n+$/.test(doc.slice(before.length))) || null
  }, 'new line at the end of the note')
  await editor.caretToEnd()
}

// ─── 文件时间线（TLE-*）──────────────────────────

interface TimelineEntryShot {
  item: { id: string; name: string; storage: string; source: string }
  sessionId: string | null
  relation: string | null
  at: number
  missing?: boolean
}

interface TimelineShot {
  entries: TimelineEntryShot[]
  sessions: Record<string, { title: string; projectName?: string; notebook?: boolean }>
}

/** 产物那一件在元数据表里的样子（linked 的件没有库里的版本文件，所以不走 itemRows 的 JOIN 口径） */
interface ArtifactItemRow {
  id: string
  name: string
  source: string
  storage: string
  externalPath: string | null
  deletedAt: number | null
}

const timelineOf = (): Promise<TimelineShot> =>
  app.main.eval<TimelineShot>(`window.api.library.timeline()`)

const artifactItems = (): ArtifactItemRow[] =>
  sqliteJson<ArtifactItemRow>(
    app.home,
    `SELECT id, name, source, storage, externalPath, deletedAt
       FROM library_items WHERE source = 'artifact' ORDER BY createdAt, id`
  )

const artifactsDirOf = (sid: string): string => join(app.home, '.shuvix', 'artifacts', sid)

const createChat = (title: string): Promise<string> =>
  app.main.eval<string>(
    `window.api.session.create(${JSON.stringify({ title, projectId })}).then((s) => s.id)`
  )

/** 面板里这一件在这条会话名下的那一行（'' = 不带会话；等它出现） */
const rowOf = (fileId: string, sessionId: string, what: string): Promise<LibraryTimelineRowShot> =>
  until(
    async () =>
      (await timeline.rows()).find((r) => r.sessionId === sessionId && r.id === fileId) ?? null,
    what
  )

/** 菜单项的 id 序列，分隔线写成 `|` */
const menuShape = (items: MenuItemShot[]): string[] =>
  items.map((i) => (i.type === 'separator' ? '|' : (i.id ?? '?')))

interface LocationShot {
  path: string
  storage: string
  missing?: boolean
}
const locate = (id: string): Promise<LocationShot | null> =>
  app.main.eval<LocationShot | null>(`window.api.library.locate(${JSON.stringify(id)})`)

/** 让脚本 agent 在这条会话里建一件产物，回它在产物目录里的绝对路径与库里的那一行 */
const makeArtifact = async (
  sid: string,
  marker: string,
  callId: string,
  spec: { title: string; ext: string; content: string }
): Promise<{ path: string; item: ArtifactItemRow }> => {
  const since = await send(sid, marker, [
    {
      toolCalls: [
        { id: callId, name: 'artifact', args: JSON.stringify({ action: 'create', ...spec }) }
      ]
    },
    { text: `${marker}-DONE` }
  ])
  await ended(sid, since)
  expect((await probe.waitToolResult(sid, callId, TURN_TIMEOUT)).isError).toBe(false)
  // 库里那一行的名字取自内容里的标题（svg 的 aria-label、md 的首个 #），所以按它所在的产物目录与扩展名找
  const dir = artifactsDirOf(sid)
  const files = readdirSync(dir).filter((f) => f.endsWith(`.${spec.ext}`))
  expect(files).toHaveLength(1)
  const path = join(dir, files[0])
  const item = await until(
    () =>
      artifactItems().find(
        (r) =>
          !!r.externalPath &&
          existsSync(r.externalPath) &&
          realpathSync(r.externalPath) === realpathSync(path)
      ) ?? null,
    `artifact "${spec.title}" registered in the library`
  )
  return { path, item }
}

beforeAll(async () => {
  provider = await startFakeProvider()
  app = await launchApp()
  await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  await waitRendererReady(app.main)
  await app.main.eval(`window.api.settings.set({ key: 'general.language', value: 'en' })`)

  const projDir = join(app.home, 'proj-library')
  mkdirSync(projDir, { recursive: true })
  writeFileSync(join(projDir, NOTE_FILE), NOTE)
  // 笔记的关联按跟过链接的绝对路径记
  notePath = realpathSync(join(projDir, NOTE_FILE))
  // 夹具图放在项目外：只在 node 这边读它们的字节
  const fixtures = join(app.home, 'fixtures')
  mkdirSync(fixtures, { recursive: true })
  p1 = readFileSync(writePng(join(fixtures, 'p1.png'), { width: 40, height: 24 }))
  p2 = readFileSync(writePng(join(fixtures, 'p2.png'), { width: 32, height: 32 }))

  p3 = readFileSync(writePng(join(fixtures, 'p3.png'), { width: 24, height: 24 }))

  const project = await createProject(app.main, { name: 'LibraryProj', path: projDir })
  projectId = project.id
  nSid = await app.main.eval<string>(
    `window.api.session.create(${JSON.stringify({
      projectId: project.id,
      notebookPath: join(projDir, NOTE_FILE)
    })}).then((s) => s.id)`
  )
  cSid = await app.main.eval<string>(
    `window.api.session.create(${JSON.stringify({
      title: CHAT_TITLE,
      projectId: project.id
    })}).then((s) => s.id)`
  )

  events = eventRecorder(app.main)
  await events.install()
  probe = syncProbe(app.main)
  await probe.install()

  // 经 IPC 建的会话要等渲染端把列表拉回来，行才存在
  const sidebar = sidebarPane(app.main)
  await until(
    () => sidebar.titles().then((titles) => titles.includes(NOTE_FILE)),
    `sidebar row "${NOTE_FILE}"`
  )
  expect(await sidebar.openSession(NOTE_FILE)).toBe(true)
  editor = notebookEditorPane(app.main)
  await until(async () => (await editor.docText()) === NOTE || null, 'lib-note.md in the editor')
}, 120_000)

afterAll(async () => {
  await provider?.close()
  await app?.stop()
})

describe('file library L1', () => {
  it('FLE-1 pasting a screenshot into the note shows it and stores it in the library', async () => {
    await editor.caretToEnd()
    const { doc, links } = await pasteAndWait(
      [{ name: 'image.png', type: 'image/png', base64: b64(p1) }],
      1,
      'pasted image link in the note'
    )

    // 正文：恰一条图片链接，alt 空，id 是 UUID，名字是 pasted-<时间>.png；占位从没进过文档
    expect(links).toHaveLength(1)
    const [link] = links
    expect(link.image).toBe(true)
    expect(link.label).toBe('')
    expect(link.id).toMatch(UUID_RE)
    expect(link.name).toMatch(PASTED_NAME_RE)
    p1Id = link.id
    p1Name = link.name
    expect(doc).toBe(`${NOTE}![](shuvix://file/${p1Id}/${p1Name})`)
    expect(doc).not.toContain('Adding')

    // 编辑器里那张图：经预览协议按 `library:<id>` 解出来，解码出 40 宽
    await editor.caretToStart()
    const image = await until(
      async () => (await editor.images()).find((i) => i.complete && i.naturalWidth > 0) ?? null,
      'library image decoded in the note'
    )
    expect(image.naturalWidth).toBe(40)
    expect(image.src.startsWith('shuvix-preview://')).toBe(true)
    expect(image.src).toContain(`library%3A${p1Id}`)
    expect(image.src).not.toContain('shuvix://file')
    expect(image.path).toBe(`library:${p1Id}`)

    // 盘上：<库>/<id 前两位>/<id>/<文件名>，与 P1 逐字节相同
    expect(readFileSync(itemFileOf(p1Id, p1Name)).equals(p1)).toBe(true)

    // 元数据
    expect(itemRows()).toEqual([
      {
        id: p1Id,
        name: p1Name,
        kind: 'image',
        source: 'note-paste',
        storage: 'managed',
        deletedAt: null,
        sha256: sha256(p1),
        fileName: p1Name,
        mime: 'image/png',
        width: 40,
        height: 24
      }
    ])
    // 用户把它放进了 N 的笔记：N 一条 `attached` 会话关联（agent 读它不用问的依据）
    expect(sessionLinks(nSid)).toEqual([
      {
        itemId: p1Id,
        targetType: 'session',
        targetId: nSid,
        relation: 'attached',
        origin: 'derived',
        context: JSON.stringify({ source: 'note-paste' })
      }
    ])

    // 自动保存落盘后：文件里有这条链接，笔记一条 `embedded` 派生关联
    await until(
      () => readFileSync(notePath, 'utf8').includes(`shuvix://file/${p1Id}/${p1Name}`) || null,
      'autosave wrote the library link into lib-note.md'
    )
    const embedded = await until(
      () => (noteLinks().length > 0 ? noteLinks() : null),
      'note embedded link recorded'
    )
    expect(embedded).toEqual([
      {
        itemId: p1Id,
        targetType: 'note',
        targetId: notePath,
        relation: 'embedded',
        origin: 'derived',
        context: null
      }
    ])
  })

  it('FLE-2 the same image pasted again is stored once; clicking the file chip opens a preview', async () => {
    // 同一张图再贴一次：同一个 id（也是同一个文件名），库里不多一行、不多一个目录
    await newLineAtEnd()
    const second = await pasteAndWait(
      [{ name: 'image.png', type: 'image/png', base64: b64(p1) }],
      2,
      'second image link in the note'
    )
    expect(second.links[1]).toEqual({ image: true, label: '', id: p1Id, name: p1Name })
    expect(itemRows().filter((r) => r.sha256 === sha256(p1))).toHaveLength(1)
    expect(itemDirsOnDisk()).toEqual([p1Id])
    expect(readdirSync(dirname(itemFileOf(p1Id, p1Name)))).toEqual([p1Name])

    // PDF：写成文件链接
    await newLineAtEnd()
    const third = await pasteAndWait(
      [{ name: 'sample.pdf', type: 'application/pdf', base64: b64(PDF) }],
      3,
      'pdf link in the note'
    )
    const pdfLink = third.links[2]
    pdfId = pdfLink.id
    expect(pdfId).toMatch(UUID_RE)
    expect(pdfId).not.toBe(p1Id)
    expect(pdfLink).toEqual({ image: false, label: 'sample.pdf', id: pdfId, name: 'sample.pdf' })
    expect(third.doc).toContain(`[sample.pdf](shuvix://file/${pdfId}/sample.pdf)`)
    expect(itemRows().map((r) => [r.id, r.source, r.kind])).toEqual([
      [p1Id, 'note-paste', 'image'],
      [pdfId, 'note-paste', 'pdf']
    ])
    expect(itemDirsOnDisk()).toEqual([p1Id, pdfId].sort())
    expect(readFileSync(itemFileOf(pdfId, 'sample.pdf')).equals(PDF)).toBe(true)

    // 自动保存之后笔记引用两件（同一件写两次只算一条）
    await until(
      () =>
        noteLinks()
          .map((l) => l.itemId)
          .sort()
          .join() === [p1Id, pdfId].sort().join() || null,
      'note embedded links follow the saved note'
    )

    // 真鼠标点 `sample.pdf` → 预览窗口开的是库目录里那份
    await editor.caretToStart()
    await until(async () => {
      try {
        await editor.clickLink('sample.pdf')
        return true
      } catch {
        return null
      }
    }, 'sample.pdf link clickable in the note')
    const win = await until(
      () => app.connectFilePreviewWindow(`${pdfId}/sample.pdf`),
      'preview window for the library pdf'
    )
    try {
      const target = (await app.filePreviewWindows()).find((w) => w.path.includes(pdfId))
      expect(target?.path).toBe(realpathSync(itemFileOf(pdfId, 'sample.pdf')))
      expect(target?.path.startsWith(`${realpathSync(libraryDir())}/`)).toBe(true)
    } finally {
      await win.eval('window.close()').catch(() => undefined)
      win.close()
      await until(
        async () => !(await app.filePreviewWindows()).some((w) => w.path.includes(pdfId)) || null,
        'pdf preview window closed'
      )
    }
  })

  it(
    'FLE-3 an image sent in a chat is kept in the library with a sent link to its user message',
    async () => {
      provider.reset()
      await events.clear()
      const since = await send(
        cSid,
        'look',
        [{ text: 'ok' }],
        [{ type: 'image', data: b64(p2), mimeType: 'image/png' }]
      )
      await ended(cSid, since)

      const row = await until(
        () => itemRows().find((r) => r.source === 'chat-image') ?? null,
        'sent image kept in the library'
      )
      expect(row.name).toMatch(SENT_NAME_RE)
      expect(row).toMatchObject({
        kind: 'image',
        storage: 'managed',
        deletedAt: null,
        sha256: sha256(p2),
        mime: 'image/png',
        width: 32,
        height: 32
      })
      p2Id = row.id
      p2Name = row.fileName
      expect(readFileSync(itemFileOf(p2Id, p2Name)).equals(p2)).toBe(true)

      // `sent` 关联挂在那条用户消息（条目 id）上
      const user = (await listMessages(cSid)).find((m) => m.role === 'user')
      expect(user).toBeDefined()
      const sent = await until(
        () => (sessionLinks(cSid).length > 0 ? sessionLinks(cSid) : null),
        'sent link recorded for C'
      )
      expect(sent).toEqual([
        {
          itemId: p2Id,
          targetType: 'session',
          targetId: cSid,
          relation: 'sent',
          origin: 'derived',
          context: JSON.stringify({ entryId: Number(user!.id) })
        }
      ])

      // 模型照常看图：那次请求里仍有这张图的图片内容块
      const req = provider.requests().find((r) => promptOf(r).includes('look'))
      expect(req).toBeDefined()
      expect(wireMessages(req!).flatMap((m) => imageUrlsOf(m.content))).toContain(
        `data:image/png;base64,${b64(p2)}`
      )
    },
    TURN_TIMEOUT
  )

  describe('FLE-4 the agent reading library files', () => {
    it(
      'FLE-4.1 in N, reading the pasted image (attached to N) does not ask and returns the image',
      async () => {
        provider.reset()
        const text = 'FLE41 check the pasted screenshot'
        const callId = 'call_fle41_n_lib'
        const since = await send(nSid, text, [
          { toolCalls: [readCall(callId, `shuvix://file/${p1Id}/${p1Name}`)] },
          { text: 'FLE41-DONE' }
        ])
        await ended(nSid, since)

        expect(await asksRaisedIn(events, nSid, since)).toBe(0)
        const decision = libraryDecisionOf(callId)
        expect(decision).toMatchObject({
          sessionId: nSid,
          toolName: 'read',
          action: 'read',
          objectKind: 'library',
          objectSummary: `library ${p1Id}`,
          effect: 'allow'
        })
        expect(decision?.matched).not.toContain('ask-on-library-access#0')
        expect(decision?.userResponse).toBeUndefined()
        // 「有关联」来自用户的粘贴（attached），不是笔记正文
        expect(sessionLinks(nSid).some((l) => l.itemId === p1Id && l.relation === 'attached')).toBe(
          true
        )

        const result = await probe.waitToolResult(nSid, callId, TURN_TIMEOUT)
        expect(result.isError).toBe(false)
        expect(imagesAfterResult(requestWithResult(callId), callId)).toEqual([
          `data:image/png;base64,${b64(p1)}`
        ])
      },
      TURN_TIMEOUT
    )

    it(
      'FLE-4.2 in C, reading the same image (no link to C) asks exactly once; allowed, it returns the image',
      async () => {
        provider.reset()
        await installAutoAllow(app.main, {
          only: (command) => command.startsWith('Read library file')
        })
        expect(await autoAllowed(app.main)).toEqual([])
        const text = 'FLE42 open the screenshot from the note'
        const callId = 'call_fle42_c_lib'
        const since = await send(cSid, text, [
          { toolCalls: [readCall(callId, `shuvix://file/${p1Id}/${p1Name}`)] },
          { text: 'FLE42-DONE' }
        ])
        await ended(cSid, since)

        expect(await asksRaisedIn(events, cSid, since)).toBe(1)
        expect(await autoAllowed(app.main)).toEqual([`Read library file "${p1Name}" (${p1Id})`])
        const decision = libraryDecisionOf(callId)
        expect(decision).toMatchObject({
          sessionId: cSid,
          objectKind: 'library',
          objectSummary: `library ${p1Id}`,
          effect: 'ask',
          winning: 'ask-on-library-access#0',
          userResponse: 'allowed'
        })

        const result = await probe.waitToolResult(cSid, callId, TURN_TIMEOUT)
        expect(result.isError).toBe(false)
        expect(imagesAfterResult(requestWithResult(callId), callId)).toEqual([
          `data:image/png;base64,${b64(p1)}`
        ])
      },
      TURN_TIMEOUT
    )

    it(
      'FLE-4.3 in C, reading the image C sent itself does not ask',
      async () => {
        provider.reset()
        const allowedBefore = await autoAllowed(app.main)
        const text = 'FLE43 open the image I sent'
        const callId = 'call_fle43_c_sent'
        const since = await send(cSid, text, [
          { toolCalls: [readCall(callId, `shuvix://file/${p2Id}/${p2Name}`)] },
          { text: 'FLE43-DONE' }
        ])
        await ended(cSid, since)

        expect(await asksRaisedIn(events, cSid, since)).toBe(0)
        expect(await autoAllowed(app.main)).toEqual(allowedBefore)
        const decision = libraryDecisionOf(callId)
        expect(decision).toMatchObject({
          sessionId: cSid,
          objectKind: 'library',
          objectSummary: `library ${p2Id}`,
          effect: 'allow'
        })
        expect(decision?.matched).not.toContain('ask-on-library-access#0')
        const result = await probe.waitToolResult(cSid, callId, TURN_TIMEOUT)
        expect(result.isError).toBe(false)
        expect(imagesAfterResult(requestWithResult(callId), callId)).toEqual([
          `data:image/png;base64,${b64(p2)}`
        ])
      },
      TURN_TIMEOUT
    )

    it(
      'FLE-4.4 in N, reading the library file by its absolute path goes through the path gate and asks',
      async () => {
        provider.reset()
        const abs = itemFileOf(p1Id, p1Name)
        const text = 'FLE44 read the stored file directly'
        const callId = 'call_fle44_n_abs'
        const since = await send(nSid, text, [
          { toolCalls: [readCall(callId, abs)] },
          { text: 'FLE44-DONE' }
        ])
        const ask = await probe.nextAsk(nSid, TURN_TIMEOUT)
        // 用户拒绝：路径门挡住了这条路，库目录不在会话权限表里
        await answer(nSid, ask, false)
        await ended(nSid, since)

        expect(await asksRaisedIn(events, nSid, since)).toBe(1)
        const decisions = securityDecisions(app).filter((d) => d.toolCallId === callId)
        expect(decisions.some((d) => d.objectKind === 'library')).toBe(false)
        expect(decisions.find((d) => d.effect === 'ask')).toMatchObject({
          sessionId: nSid,
          action: 'read',
          objectKind: 'path',
          winning: 'ask-on-external-path#0',
          userResponse: 'denied'
        })
        const result = await probe.waitToolResult(nSid, callId, TURN_TIMEOUT)
        expect(result.isError).toBe(true)
        expect(imagesAfterResult(requestWithResult(callId), callId)).toEqual([])
      },
      TURN_TIMEOUT
    )
  })

  it('FLE-5 deleting a session removes only its links; the files stay in the library', async () => {
    const nBefore = sessionLinks(nSid)
    const notesBefore = noteLinks()
    expect(sessionLinks(cSid).length).toBeGreaterThan(0)

    await app.main.eval(`window.api.session.delete(${JSON.stringify(cSid)})`)
    await until(() => sessionLinks(cSid).length === 0 || null, "C's library links removed")

    expect(itemRows().find((r) => r.id === p2Id)).toMatchObject({ deletedAt: null })
    expect(readFileSync(itemFileOf(p2Id, p2Name)).equals(p2)).toBe(true)
    expect(itemDirsOnDisk()).toEqual([p1Id, pdfId, p2Id].sort())
    expect(sessionLinks(nSid)).toEqual(nBefore)
    expect(noteLinks()).toEqual(notesBefore)
  })
  it(
    'TLE-1 a sent image is listed under its session on the Files tab and opens the preview',
    async () => {
      provider.reset()
      dSid = await createChat(D_TITLE)
      const since = await send(
        dSid,
        'TLE1 look at this',
        [{ text: 'ok' }],
        [{ type: 'image', data: b64(p3), mimeType: 'image/png' }]
      )
      await ended(dSid, since)
      const row = await until(
        () => itemRows().find((r) => r.source === 'chat-image' && r.sha256 === sha256(p3)) ?? null,
        'P3 kept in the library'
      )
      p3Id = row.id
      p3Name = row.fileName
      await until(
        () => sessionLinks(dSid).some((l) => l.itemId === p3Id && l.relation === 'sent') || null,
        'sent link recorded for D'
      )

      // IPC：P3 在 D 名下，会话的标题与项目名都带回来
      const shot = await timelineOf()
      const entry = shot.entries.find((e) => e.item.id === p3Id && e.sessionId === dSid)
      expect(entry).toMatchObject({ sessionId: dSid, relation: 'sent' })
      expect(entry?.missing).toBeFalsy()
      expect(shot.sessions[dSid]).toMatchObject({ title: D_TITLE, projectName: 'LibraryProj' })
      expect(shot.entries.filter((e) => e.item.id === p3Id)).toHaveLength(1)
      expect(shot.entries.find((e) => e.item.id === p1Id && e.sessionId === nSid)?.relation).toBe(
        'attached'
      )
      expect(shot.sessions[nSid]?.notebook).toBe(true)

      // 界面：文件标签里 D 名下恰有这一行，N 名下有 P1 的一行
      timeline = libraryTimelinePane(app.main)
      await timeline.open()
      const dRow = await rowOf(p3Id, dSid, "D's row with P3 on the Files tab")
      expect(dRow).toMatchObject({
        sessionTitle: D_TITLE,
        canOpenSession: true,
        relation: 'sent',
        missing: false
      })
      expect(dRow.name).not.toBe('')
      expect(dRow.meta).toMatch(/^\d+(\.\d)? (B|KB|MB)$/)
      expect((await timeline.rows()).filter((r) => r.sessionId === dSid).map((r) => r.id)).toEqual([
        p3Id
      ])
      const nRow = await rowOf(p1Id, nSid, "N's row with P1 on the Files tab")
      expect(nRow).toMatchObject({ relation: 'attached', missing: false })
      expect(nRow.sessionTitle).not.toBe('')
      expect(await timeline.empty()).toBe(false)

      // 点图 → 当前窗口的看图层（库引用，不开窗）；顶栏「在独立窗口打开」→ 预览窗口开的是库目录里那份
      await timeline.clickFile(p3Id)
      const viewer = imageViewerPane(app.main)
      const viewed = await viewer.waitLoaded(undefined, 'library image in the viewer')
      expect(decodeURIComponent(viewed.src)).toContain(`library:${p3Id}`)
      expect(await app.filePreviewWindows()).toEqual([])
      await viewer.action('open')
      await viewer.waitClosed()
      const win = await until(
        () => app.connectFilePreviewWindow(p3Id),
        'preview window for the library image'
      )
      try {
        const target = (await app.filePreviewWindows()).find((w) => w.path.includes(p3Id))
        expect(target?.path).toBe(realpathSync(itemFileOf(p3Id, p3Name)))
      } finally {
        await win.eval('window.close()').catch(() => undefined)
        win.close()
        await until(
          async () => !(await app.filePreviewWindows()).some((w) => w.path.includes(p3Id)) || null,
          'image preview window closed'
        )
      }

      // 点行里的会话名 → 活动会话变成 D（此前开着的是笔记 N），不开看图层也不开预览窗口
      const sidebar = sidebarPane(app.main)
      expect(await sidebar.activeTitle()).not.toBe(D_TITLE)
      await timeline.clickSession(dSid)
      await until(
        async () => (await sidebar.activeTitle()) === D_TITLE || null,
        'D became the active session'
      )
      expect(await viewer.shot()).toBeNull()
      expect(await app.filePreviewWindows()).toEqual([])
    },
    TURN_TIMEOUT
  )

  it('TLE-2 deleting the session keeps its file on the timeline, without a session name', async () => {
    const dayBefore = (await rowOf(p3Id, dSid, "D's row before the delete")).day
    expect(await timeline.active()).toBe(true)

    await app.main.eval(`window.api.session.delete(${JSON.stringify(dSid)})`)

    // 标签一直开着、没碰过：靠 library.changed 重取
    await until(
      async () => !(await timeline.rows()).some((r) => r.sessionId === dSid) || null,
      "D's rows gone from the Files tab"
    )
    const orphan = await rowOf(p3Id, '', 'P3 on a row without a session')
    expect(orphan).toMatchObject({
      day: dayBefore,
      sessionTitle: '',
      canOpenSession: false,
      relation: '',
      missing: false
    })
    expect((await timeline.rows()).filter((r) => r.id === p3Id)).toHaveLength(1)

    const shot = await timelineOf()
    const mine = shot.entries.filter((e) => e.item.id === p3Id)
    expect(mine).toHaveLength(1)
    expect(mine[0].sessionId).toBeNull()
    expect(mine[0].missing).toBeFalsy()
    expect(Object.keys(shot.sessions)).not.toContain(dSid)

    expect(sessionLinks(dSid)).toEqual([])
    expect(itemRows().find((r) => r.id === p3Id)).toMatchObject({
      deletedAt: null,
      storage: 'managed'
    })
    expect(readFileSync(itemFileOf(p3Id, p3Name)).equals(p3)).toBe(true)
  })

  it(
    'TLE-3 an artifact is listed as made by the agent and survives its session as a managed file',
    async () => {
      provider.reset()
      const eSid = await createChat(E_TITLE)
      const dirsBefore = itemDirsOnDisk()
      const callId = 'call_tle3_artifact'
      const since = await send(eSid, 'TLE3 draw the timeline chart', [
        {
          toolCalls: [
            {
              id: callId,
              name: 'artifact',
              args: JSON.stringify({
                action: 'create',
                title: ARTIFACT_TITLE,
                ext: 'svg',
                content: ARTIFACT_SVG
              })
            }
          ]
        },
        { text: 'TLE3-DONE' }
      ])
      await ended(eSid, since)
      expect(await asksRaisedIn(events, eSid, since)).toBe(0)
      expect((await probe.waitToolResult(eSid, callId, TURN_TIMEOUT)).isError).toBe(false)

      // 产物在会话的产物目录里，库里只登记一行 linked（库目录里没有它）
      const artifactsDir = artifactsDirOf(eSid)
      const files = readdirSync(artifactsDir).filter((f) => f.endsWith('.svg'))
      expect(files).toHaveLength(1)
      const artifactBytes = readFileSync(join(artifactsDir, files[0]))
      const linked = await until(
        () => (artifactItems().length > 0 ? artifactItems() : null),
        'artifact registered in the library'
      )
      expect(linked).toHaveLength(1)
      const artId = linked[0].id
      expect(linked[0]).toMatchObject({
        name: ARTIFACT_TITLE,
        source: 'artifact',
        storage: 'linked',
        deletedAt: null
      })
      expect(realpathSync(linked[0].externalPath ?? '')).toBe(
        realpathSync(join(artifactsDir, files[0]))
      )
      expect(sessionLinks(eSid).map((l) => [l.itemId, l.relation])).toEqual([[artId, 'produced']])
      expect(itemDirsOnDisk()).toEqual(dirsBefore)

      const before = await timelineOf()
      expect(before.entries.find((e) => e.item.id === artId && e.sessionId === eSid)).toMatchObject(
        { relation: 'produced', item: { storage: 'linked', source: 'artifact' } }
      )
      const eRow = await rowOf(artId, eSid, "E's row with the artifact")
      expect(eRow).toMatchObject({
        sessionTitle: E_TITLE,
        canOpenSession: true,
        relation: 'produced',
        missing: false,
        name: ARTIFACT_TITLE
      })
      expect((await timeline.rows()).filter((r) => r.sessionId === eSid).map((r) => r.id)).toEqual([
        artId
      ])

      // 删掉 E：产物目录要没了，这一件先被拷进库里变成 managed
      await app.main.eval(`window.api.session.delete(${JSON.stringify(eSid)})`)
      await until(() => !existsSync(artifactsDir) || null, "E's artifacts folder removed")
      const [after] = await until(
        () => (artifactItems()[0]?.storage === 'managed' ? artifactItems() : null),
        'artifact item became managed'
      )
      expect(after).toMatchObject({
        id: artId,
        storage: 'managed',
        externalPath: null,
        deletedAt: null
      })
      const managed = itemRows().find((r) => r.id === artId)
      expect(managed).toMatchObject({ storage: 'managed', sha256: sha256(artifactBytes) })
      const stored = itemFileOf(artId, managed!.fileName)
      expect(stored.startsWith(`${join(app.home, '.shuvix', 'library', 'files')}/`)).toBe(true)
      expect(readFileSync(stored).equals(artifactBytes)).toBe(true)
      expect(itemDirsOnDisk()).toEqual([...dirsBefore, artId].sort())
      expect(sessionLinks(eSid)).toEqual([])

      // 时间线：还在，那一行不再带会话名，不是 missing
      await until(
        async () => !(await timeline.rows()).some((r) => r.sessionId === eSid) || null,
        "E's rows gone from the Files tab"
      )
      const orphan = await rowOf(artId, '', 'artifact on a row without a session')
      expect(orphan).toMatchObject({
        sessionTitle: '',
        canOpenSession: false,
        relation: '',
        missing: false
      })
      expect((await timeline.rows()).filter((r) => r.id === artId)).toHaveLength(1)
      const shot = await timelineOf()
      const mine = shot.entries.filter((e) => e.item.id === artId)
      expect(mine).toHaveLength(1)
      expect(mine[0]).toMatchObject({ sessionId: null, item: { storage: 'managed' } })
      expect(mine[0].missing).toBeFalsy()
      expect(Object.keys(shot.sessions)).not.toContain(eSid)

      // TLE-6 行菜单：会话没了就没有「打开所属会话」；路径现在是库里那份
      expect(menuShape(await timeline.rowMenu(artId, null))).toEqual([
        'open',
        '|',
        'copyPath',
        'reveal'
      ])
      const location = await locate(artId)
      expect(location).toEqual({ path: stored, storage: 'managed' })
      // 盘上那份被删掉：「在文件夹中显示」置灰，「复制路径」还在
      rmSync(stored)
      expect(await locate(artId)).toEqual({ path: stored, storage: 'managed', missing: true })
      const afterLoss = await timeline.rowMenu(artId, null)
      expect(menuShape(afterLoss)).toEqual(['open', '|', 'copyPath', 'reveal'])
      expect(afterLoss.find((i) => i.id === 'reveal')?.enabled).toBe(false)
      expect(afterLoss.find((i) => i.id === 'copyPath')?.enabled).not.toBe(false)
    },
    TURN_TIMEOUT
  )

  it(
    'TLE-4 row menus: a linked artifact and a managed image offer the same items; Copy path gives the real path',
    async () => {
      provider.reset()
      if (!(await timeline.active())) await timeline.open()
      fSid = await createChat(F_TITLE)
      const made = await makeArtifact(fSid, 'TLE4 draw it', 'call_tle4_artifact', {
        title: 'Menu chart',
        ext: 'svg',
        content: ARTIFACT_SVG.replace(ARTIFACT_TITLE, 'Menu chart')
      })
      expect(made.item.name).toBe('Menu chart')
      const artId = made.item.id
      expect(made.item.storage).toBe('linked')
      await rowOf(artId, fSid, "F's row with the artifact")
      // 托管的那一件：贴进笔记的 P1，挂在笔记会话 N 名下
      await rowOf(p1Id, nSid, "N's row with P1")

      const FULL = ['open', 'openSession', '|', 'copyPath', 'reveal']
      const artMenu = await timeline.rowMenu(artId, null)
      expect(menuShape(artMenu)).toEqual(FULL)
      expect(artMenu.find((i) => i.id === 'reveal')?.enabled).not.toBe(false)
      expect(artMenu.filter((i) => i.id).map((i) => i.label)).toEqual([
        'Open',
        'Open chat',
        'Copy path',
        'Show in folder'
      ])
      const imageMenu = await timeline.rowMenu(p1Id, null)
      expect(menuShape(imageMenu)).toEqual(FULL)
      expect(imageMenu.find((i) => i.id === 'reveal')?.enabled).not.toBe(false)

      // 路径：产物在会话的产物目录里（留在原位置），图在库目录里（托管）；都不是 missing
      const artLocation = await locate(artId)
      expect(artLocation).toEqual({ path: made.item.externalPath, storage: 'linked' })
      expect(realpathSync(artLocation!.path)).toBe(realpathSync(made.path))
      expect(
        realpathSync(artLocation!.path).startsWith(`${realpathSync(artifactsDirOf(fSid))}/`)
      ).toBe(true)
      expect(await locate(p1Id)).toEqual({ path: itemFileOf(p1Id, p1Name), storage: 'managed' })

      // 复制路径：剪贴板（记录器）里恰是产物的真实路径，与 artifact.read 给的一致
      await timeline.stubClipboard()
      await timeline.rowMenu(artId, 'copyPath')
      await until(
        async () => (await timeline.clipboardWrites()).length > 0 || null,
        'Copy path wrote to the clipboard'
      )
      expect(await timeline.clipboardWrites()).toEqual([made.item.externalPath])
      const read = await app.main.eval<{ path?: string } | null>(
        `window.api.artifact.read(${JSON.stringify({ sessionId: fSid, name: 'Menu chart' })})`
      )
      expect(read?.path).toBe(made.item.externalPath)
      // 只选了复制：没有开预览窗口、看图层或 md 窗口
      expect(await app.filePreviewWindows()).toEqual([])
      expect(await app.markdownWindows()).toEqual([])
      expect(await imageViewerPane(app.main).shot()).toBeNull()
    },
    TURN_TIMEOUT
  )

  it(
    'TLE-5 a linked Markdown artifact opens the markdown window; a managed md opens the read-only preview',
    async () => {
      provider.reset()
      expect(await app.markdownWindows()).toEqual([])
      expect(await app.filePreviewWindows()).toEqual([])
      const made = await makeArtifact(fSid, 'TLE5 write notes', 'call_tle5_artifact', {
        title: 'Menu notes',
        ext: 'md',
        content: '# Menu notes\n\nTLE5-BODY\n'
      })
      const mdName = made.path.slice(made.path.lastIndexOf('/') + 1)
      await rowOf(made.item.id, fSid, "F's row with the md artifact")

      // 留在原位置的 md：与文件面板同样进协作编辑的 md 窗口（有编辑器、有输入卡片），不开预览窗口
      await timeline.clickFile(made.item.id)
      const mdWin = await until(
        () => app.connectMarkdownWindow(mdName),
        'markdown window for the md artifact'
      )
      try {
        const windows = await app.markdownWindows()
        expect(windows).toHaveLength(1)
        expect(windows[0].path.endsWith(`/${mdName}`)).toBe(true)
        expect(realpathSync(windows[0].path)).toBe(realpathSync(made.path))
        const pane = markdownWindowPane(mdWin)
        await pane.ready()
        await until(
          async () => (await pane.docText()).includes('TLE5-BODY') || null,
          'the artifact text in the markdown window'
        )
        expect(await app.filePreviewWindows()).toEqual([])
      } finally {
        await mdWin.eval('window.close()').catch(() => undefined)
        mdWin.close()
        await until(
          async () => (await app.markdownWindows()).length === 0 || null,
          'markdown window closed'
        )
      }

      // 托管的 md（字节进库、挂在 F 名下）：只读预览窗口，开的是库目录里那份；不进 md 窗口
      const NOTE_BYTES = Buffer.from('# Managed note\n\nTLE5-MANAGED\n')
      const added = await app.main.eval<{ ok: boolean; item?: { id: string; fileName: string } }>(
        `window.api.library.add(${JSON.stringify({
          item: {
            kind: 'bytes',
            name: 'note.md',
            mimeType: 'text/markdown',
            dataBase64: b64(NOTE_BYTES)
          },
          source: 'note-drop',
          sessionId: fSid
        })})`
      )
      expect(added.ok).toBe(true)
      const noteId = added.item!.id
      expect(await locate(noteId)).toEqual({
        path: itemFileOf(noteId, added.item!.fileName),
        storage: 'managed'
      })
      await rowOf(noteId, fSid, "F's row with the managed note")
      await timeline.clickFile(noteId)
      const previewWin = await until(
        () => app.connectFilePreviewWindow(noteId),
        'preview window for the managed md'
      )
      try {
        const previews = await app.filePreviewWindows()
        expect(previews).toHaveLength(1)
        expect(previews[0].path).toBe(realpathSync(itemFileOf(noteId, added.item!.fileName)))
        expect(await app.markdownWindows()).toEqual([])
      } finally {
        await previewWin.eval('window.close()').catch(() => undefined)
        previewWin.close()
        await until(
          async () => (await app.filePreviewWindows()).length === 0 || null,
          'managed md preview window closed'
        )
      }
    },
    TURN_TIMEOUT
  )
})
