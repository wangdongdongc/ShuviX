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
 *   FLE-5 删掉 C → 它的关联没了，P2 那件的元数据与文件都在，N 与笔记的关联不受影响
 *
 * 夹具：项目目录在 fake HOME 里（工作目录，读不问）；笔记本会话 N（绝对 notebookPath，标题 = 文件名）与普通会话 C
 * （非默认标题：自动标题不来抢假提供商的请求），都在这个项目里。脚本一律按这一步的用户消息认领（`promptOf`：
 * 工具结果里的图会被 pi-ai 另放进一条「Attached image(s) from tool result:」用户消息，那条不算）。auto-review 关着
 * （缺省），询问由 `installAutoAllow(only)` 或用例自己回答。界面语言 en。选择器全部走 `harness/pages.ts`
 * （`notebookEditorPane` 的 docText / caretToEnd / insertAtCaret / pasteFiles / attachPlaceholders）。
 *
 * 决策日志里没有 `linked` 这个字段（`SecurityDecisionRecord` 只记客体种类与摘要）：「有关联」由 allow + 没命中
 * `ask-on-library-access#0` + 关联表里那一行 `attached` / `sent` 合起来证明。
 */
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
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
  notebookEditorPane,
  sidebarPane,
  type NotebookEditorPane,
  type PasteFileSeed
} from '../../harness/pages'

const MODEL = 'e2e-model'
const USAGE = { prompt: 120, completion: 12 }
const TURN_TIMEOUT = 60_000

const NOTE_FILE = 'lib-note.md'
const NOTE = '# Lib note\n\nend.\n'
const CHAT_TITLE = 'Library chat'

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

  const project = await createProject(app.main, { name: 'LibraryProj', path: projDir })
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
})
