/**
 * 给用户看图（`show_image` 工具与带图提议，2026-11-01，设计稿 docs/show-image-design.md）—— 单测各管一段
 * （shownImages / showImageTool / suggestTool / customProtocols / previewWindowService / sessionFork /
 * sessionServiceForkWorkspace / shownImagesBlock.dom / suggestionCards.dom …），这里只走它们都替身掉的那几段：
 * 真的工具注册表与 `presentImages` 写进隔离的 userData、真的发回给模型的是什么、渲染端经主进程的协议处理器
 * 取 `shuvix-preview://…path=shown:<文件名>`、主进程的 `files.open` 解 `shown:`、提议卡片的真实排版、分支与删除在
 * 磁盘上的样子。
 *
 *   E-1 第一轮：read ×2 + show_image（chart.png，带说明）→ 终答。会话里那块的 details 是一张快照（文件名 =
 *       chart.png 内容的 sha256、尺寸、来源的真实路径），快照字节与原图相同、快照目录里只有它；下一次请求里
 *       show_image 的工具结果是那句确认（带尺寸），整个请求里没有任何图片内容块、没有图的 base64；屏上恰好
 *       一张图（地址是 shuvix-preview://、解码出原图尺寸、说明在 figcaption），不在步骤合并行里 —— 两次 read
 *       合成计数 2 的一行，图片块排在它之后、终答之前
 *   E-2 第二轮：show_image [chart.png, chart-copy.png]（内容相同）→ 两张快照文件名都等于 E-1 那张，快照目录里
 *       仍只有一个文件；屏上那一块画出两张（同名两格、都解码、并排在一行），都不在步骤合并行里
 *   E-3 点 E-1 那张图 → 按快照的真实路径开出预览窗口，窗口里解码出原图尺寸
 *   E-4 第三轮：suggest 两条各带一张图 → details 是两张快照（文件都在），下一次请求里每条都标着
 *       「(with image)」；以文字为主、每条一行（2026-11-01 用户裁决）：宽栏（CDP 模拟 1600 宽的视口）下也是上下两行、
 *       同一个 left；每行文字右边一个 96 宽的缩略图位，两行的缩略图位与文字列逐行对齐、图在文字之后、都解码；文字短的那行
 *       高 64（30×300 的竖长图也撑不高它），文字多的那行缩略图位和图的框都随文字列变高，下方不留白；点第二张卡的图 → 开出那张快照的预览窗口，500ms 后没有新请求、
 *       没有新的用户消息、组还开着、第二张卡的采纳按钮仍可点
 *   E-5 分支整个会话 → 快照目录按同样的文件名、同样的字节拷给 fork；在侧栏打开 fork，E-1 的图与提议卡的图都
 *       解码，地址里的 session 是 fork
 *   E-6 删掉源会话 → 它的快照目录没了、fork 的还在；切到别的会话再切回 fork（列表重挂），图照样解码、
 *       地址里的 session 仍是 fork
 *
 * 夹具：项目目录在 fake HOME 里（= 工作目录，读不问）；源会话与切换用的会话都有非默认标题（自动标题不来抢请求，
 * fork 的「· fork」标题也不是默认标题），脚本一律按用户消息认领。主进程界面语言写成 en（fork 标题按 en 的
 * `agent.forkTitle` 比）。选择器全部走 `harness/pages.ts`（`shownImagesPane` / `suggestionsPane`）。
 */
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import en from '../../../../../packages/chat-protocol/src/i18n/locales/en.json'
import { sleep, until } from '../../harness/cdp'
import {
  startFakeProvider,
  toolTextsOf,
  type FakeProvider,
  type FakeRequest,
  type FakeTurn
} from '../../harness/fakeProvider'
import { launchApp, type E2EApp } from '../../harness/launch'
import {
  chatPane,
  filePreviewWindowImages,
  shownImagesPane,
  sidebarPane,
  suggestionsPane,
  type ChatPane,
  type ShownFigureShot,
  type ShownImagesPane,
  type SidebarPane,
  type SuggestionsPane
} from '../../harness/pages'
import {
  createProject,
  eventRecorder,
  seedFakeProvider,
  waitRendererReady,
  writePng,
  type EventRecorder
} from '../../harness/seed'

const MODEL = 'e2e-model'
const TITLE = 'ShowImage source'
const SCRATCH = 'ShowImage scratch'
const FORK_TITLE = en.agent.forkTitle.replace('{{title}}', TITLE)
const CAPTION = 'Revenue by month'

const Q = { t1: 'show me the chart', t2: 'and both versions', t3: 'what next?' } as const
const A = { t1: 'Here it is.', t2: 'Both versions above.', t3: 'Pick one.' } as const

const SUGGESTIONS = [
  { title: 'Layout A', message: 'Go with layout A', image: 'layout-a.png' },
  {
    title: 'Layout B',
    detail:
      'Keeps the sidebar and the list on one screen, at the cost of a narrower column. '.repeat(3),
    message: 'Go with layout B',
    image: 'layout-b.png'
  }
]

interface ShownImageDetail {
  file: string
  original?: string
  source: string
  mimeType: string
  width?: number
  height?: number
  bytes: number
}

interface ListedBlock {
  type: string
  toolName?: string
  toolCallId?: string
  result?: string
  isError?: boolean
  details?: { type?: string; images?: Array<ShownImageDetail | null> }
}

interface ListedMessage {
  id: string
  role: string
  content: string
  blocks?: ListedBlock[]
}

type ForkResult = { success: true; sessionId: string } | { success: false; reason: string }

let app: E2EApp
let provider: FakeProvider
let events: EventRecorder
let chat: ChatPane
let sidebar: SidebarPane
let shown: ShownImagesPane
let cards: SuggestionsPane
let projDir = ''
let sid = ''
let forkId = ''

/** 项目目录里的一个文件 */
const fixture = (name: string): string => join(projDir, name)
/** 一条会话的快照目录 */
const shownDirOf = (id: string): string => join(app.userData, 'shown', id)
/** 内容寻址的快照文件名（与宿主同一个算法：sha256 + 扩展名） */
const snapshotNameOf = (path: string): string =>
  `${createHash('sha256').update(readFileSync(path)).digest('hex')}.png`
const sortedDir = (dir: string): string[] => [...readdirSync(dir)].sort()

const listMessages = (id = sid): Promise<ListedMessage[]> =>
  app.main.eval<ListedMessage[]>(`window.api.message.list(${JSON.stringify(id)})`)

/** 会话里某次工具调用的块 */
const toolBlockOf = (msgs: ListedMessage[], toolCallId: string): ListedBlock | undefined =>
  msgs.flatMap((m) => m.blocks ?? []).find((b) => b.type === 'tool' && b.toolCallId === toolCallId)

/** 这一轮的终答消息（卡片的锚点 = 这一轮最后那条消息）的 id */
const answerIdOf = (msgs: ListedMessage[], text: string): string =>
  msgs.find((m) => m.role === 'assistant' && m.content === text)?.id ?? ''

/** 最后一条用户消息是 `text` 的请求（按发出顺序） */
const requestsFor = (text: string): FakeRequest[] =>
  provider.requests().filter((r) => r.lastUserText === text)

/** 一次请求里有没有任何图片内容块（OpenAI 形状的 `image_url`，或别的 image 类型） */
const imagePartsOf = (req: FakeRequest): unknown[] =>
  (req.body.messages ?? []).flatMap((m) =>
    Array.isArray(m.content)
      ? (m.content as Array<{ type?: string }>).filter((p) => /image/i.test(p?.type ?? ''))
      : []
  )

const showCall = (
  id: string,
  images: Array<{ path: string; caption?: string }>
): { id: string; name: string; args: string } => ({
  id,
  name: 'show_image',
  args: JSON.stringify({ images })
})

const readCall = (id: string, file: string): { id: string; name: string; args: string } => ({
  id,
  name: 'read',
  args: JSON.stringify({ path: fixture(file) })
})

/** 在当前会话里打一轮：脚本按用户消息认领，等这一轮落定 */
const runTurn = async (text: string, ...turns: FakeTurn[]): Promise<void> => {
  provider.script(
    ...turns.map((t) => ({ ...t, when: (r: FakeRequest) => r.lastUserText === text }))
  )
  const since = await events.mark()
  await chat.typeAndSend(text)
  await events.waitFor('agent_end', { sessionId: sid, since, timeoutMs: 60_000 })
  await chat.waitIdle()
}

/** 两个视口坐标算不算同一行（并排） */
const sameRow = (a: { top: number }, b: { top: number }): boolean => Math.abs(a.top - b.top) <= 1

beforeAll(async () => {
  provider = await startFakeProvider()
  app = await launchApp()
  await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  await waitRendererReady(app.main)
  await app.main.eval(`window.api.settings.set({ key: 'general.language', value: 'en' })`)

  projDir = join(app.home, 'proj-show-image')
  mkdirSync(projDir, { recursive: true })
  writePng(fixture('chart.png'), { width: 40, height: 24 })
  copyFileSync(fixture('chart.png'), fixture('chart-copy.png'))
  writePng(fixture('layout-a.png'), { width: 30, height: 300 })
  writePng(fixture('layout-b.png'), { width: 32, height: 20 })
  writeFileSync(fixture('notes.txt'), 'NOTES CONTENT\n')
  writeFileSync(fixture('todo.txt'), 'TODO CONTENT\n')
  const project = await createProject(app.main, { name: 'ShowImageProj', path: projDir })

  const create = (title: string): Promise<string> =>
    app.main.eval<string>(
      `window.api.session.create(${JSON.stringify({ title, projectId: project.id })}).then((s) => s.id)`
    )
  await create(SCRATCH)
  sid = await create(TITLE)

  chat = chatPane(app.main)
  sidebar = sidebarPane(app.main)
  shown = shownImagesPane(app.main)
  cards = suggestionsPane(app.main)
  // IPC 建的会话：点一次「新对话」让侧栏拉全量列表
  await sidebar.clickNewChat()
  await until(async () => {
    const titles = await sidebar.titles()
    return titles.includes(TITLE) && titles.includes(SCRATCH)
  }, 'sidebar lists both sessions')

  events = eventRecorder(app.main)
  await events.install()

  expect(await sidebar.openSession(TITLE)).toBe(true)
  await chat.ready()
}, 120_000)

afterAll(async () => {
  await provider?.close()
  await app?.stop()
})

describe('show_image：摆给用户看的图', () => {
  let chartFile = ''
  let a1Id = ''
  let a2Id = ''
  let layoutFiles: string[] = []

  it('E-1 快照落进会话目录、模型只收到一句确认、图在调用的位置（步骤合并行之后、终答之前）', async () => {
    chartFile = snapshotNameOf(fixture('chart.png'))
    await runTurn(
      Q.t1,
      {
        toolCalls: [
          readCall('call_read_notes', 'notes.txt'),
          readCall('call_read_todo', 'todo.txt'),
          showCall('call_show_1', [{ path: 'chart.png', caption: CAPTION }])
        ],
        usage: { prompt: 90, completion: 10 }
      },
      { text: A.t1, usage: { prompt: 120, completion: 5 } }
    )

    // IPC：块落定、details 是一张快照
    const msgs = await listMessages()
    const block = toolBlockOf(msgs, 'call_show_1')
    expect(block, 'show_image block').toBeDefined()
    expect(typeof block!.result).toBe('string')
    expect(block!.isError).toBeFalsy()
    const chartBytes = readFileSync(fixture('chart.png'))
    expect(block!.details).toStrictEqual({
      type: 'show_image',
      images: [
        {
          file: chartFile,
          source: realpathSync(fixture('chart.png')),
          mimeType: 'image/png',
          width: 40,
          height: 24,
          bytes: chartBytes.length
        }
      ]
    })
    // 磁盘：快照在 <userData>/shown/<sid>/，字节与原图相同，目录里只有它
    const snapshot = join(shownDirOf(sid), chartFile)
    expect(existsSync(snapshot)).toBe(true)
    expect(readFileSync(snapshot).equals(chartBytes)).toBe(true)
    expect(sortedDir(shownDirOf(sid))).toStrictEqual([chartFile])

    // 模型那边：工具结果是一句确认，请求里没有图
    const reqs = requestsFor(Q.t1)
    expect(reqs).toHaveLength(2)
    const after = reqs[1]!
    const confirmation = toolTextsOf(after).find((t) => t.startsWith('Shown 1 image to the user:'))
    expect(confirmation).toBe('Shown 1 image to the user:\n1. chart.png (40×24)')
    expect(imagePartsOf(after)).toStrictEqual([])
    expect(after.raw.includes(chartBytes.toString('base64').slice(0, 200))).toBe(false)

    // 屏上：恰好一张图，解码出原图尺寸，说明在 figcaption，不在步骤合并行里
    a1Id = answerIdOf(msgs, A.t1)
    expect(a1Id).not.toBe('')
    await shown.scrollConversation('bottom')
    const figures = await shown.waitLoaded(1)
    expect(figures).toHaveLength(1)
    const [fig] = figures as [ShownFigureShot]
    expect(fig.file).toBe(chartFile)
    expect(fig.src.startsWith('shuvix-preview://')).toBe(true)
    expect(fig.session).toBe(sid)
    expect([fig.naturalWidth, fig.naturalHeight]).toStrictEqual([40, 24])
    expect(fig.caption).toBe(CAPTION)
    expect(fig.missing).toBe(false)
    expect(fig.inStepGroup).toBe(false)
    expect(fig.inSuggestion).toBe(false)
    expect(fig.msgId).toBe(a1Id)

    // 两次 read 合成计数 2 的一行；图片块排在它之后、终答之前
    const groups = await chat.stepGroupShots()
    expect(groups.map((g) => g.count)).toStrictEqual([2])
    expect(await shown.cardRows(a1Id)).toStrictEqual({
      rows: ['stepGroup', 'shownImages'],
      answerAfter: true
    })
    expect(fig.blockIndex).toBe(1)
  }, 120_000)

  it('E-2 同一份内容摆两次：两格同名、都解码、并排；快照目录里仍只有一个文件', async () => {
    await runTurn(
      Q.t2,
      {
        toolCalls: [showCall('call_show_2', [{ path: 'chart.png' }, { path: 'chart-copy.png' }])],
        usage: { prompt: 140, completion: 10 }
      },
      { text: A.t2, usage: { prompt: 160, completion: 5 } }
    )

    const msgs = await listMessages()
    const block = toolBlockOf(msgs, 'call_show_2')
    expect(block?.isError).toBeFalsy()
    expect(block?.details?.type).toBe('show_image')
    const images = block!.details!.images as ShownImageDetail[]
    expect(images.map((i) => i.file)).toStrictEqual([chartFile, chartFile])
    expect(images.map((i) => i.source)).toStrictEqual([
      realpathSync(fixture('chart.png')),
      realpathSync(fixture('chart-copy.png'))
    ])
    // 按内容去重：两次调用、三张图，磁盘上一个文件
    expect(sortedDir(shownDirOf(sid))).toStrictEqual([chartFile])

    const reqs = requestsFor(Q.t2)
    expect(reqs).toHaveLength(2)
    expect(toolTextsOf(reqs[1]!).at(-1)).toBe(
      'Shown 2 images to the user:\n1. chart.png (40×24)\n2. chart-copy.png (40×24)'
    )

    a2Id = answerIdOf(msgs, A.t2)
    expect(a2Id).not.toBe('')
    await shown.scrollConversation('bottom')
    const all = await shown.waitLoaded(2, (f) => f.msgId === a2Id)
    const pair = all.filter((f) => f.msgId === a2Id)
    expect(pair).toHaveLength(2)
    expect(pair.map((f) => f.file)).toStrictEqual([chartFile, chartFile])
    expect(pair.every((f) => f.complete && f.naturalWidth === 40)).toBe(true)
    expect(pair.some((f) => f.inStepGroup)).toBe(false)
    expect(pair.map((f) => f.caption)).toStrictEqual([null, null])
    // 网格：两格在同一行、左右分开
    expect(sameRow(pair[0]!.rect, pair[1]!.rect), JSON.stringify(pair.map((f) => f.rect))).toBe(
      true
    )
    expect(pair[1]!.rect.left).toBeGreaterThan(pair[0]!.rect.left)
    expect(await shown.cardRows(a2Id)).toStrictEqual({ rows: ['shownImages'], answerAfter: true })
  }, 120_000)

  it('E-3 点 E-1 那张图 → 按快照的真实路径开出预览窗口，解码出原图尺寸', async () => {
    await shown.scrollConversation('top')
    const figures = await shown.waitLoaded(1, (f) => f.msgId === a1Id)
    const index = figures.findIndex((f) => f.msgId === a1Id)
    expect(index).toBeGreaterThanOrEqual(0)
    expect(await shown.click(index)).toBe(true)

    const real = realpathSync(join(shownDirOf(sid), chartFile))
    const win = await until(() => app.connectFilePreviewWindow(real), 'file preview window')
    try {
      const imgs = await until(async () => {
        const list = await filePreviewWindowImages(win)
        return list.some((i) => i.path === real && i.naturalWidth === 40) ? list : null
      }, 'snapshot decoded in the preview window')
      expect(imgs.find((i) => i.path === real)?.naturalHeight).toBe(24)
    } finally {
      await win.eval('window.close()').catch(() => undefined)
      win.close()
    }
  }, 60_000)

  it('E-4 带图的提议：快照、模型看到「(with image)」、每条一行、缩略图位逐行对齐并随行高；点图只是看图', async () => {
    layoutFiles = SUGGESTIONS.map((s) => snapshotNameOf(fixture(s.image)))
    await runTurn(
      Q.t3,
      {
        toolCalls: [
          {
            id: 'call_suggest',
            name: 'suggest',
            args: JSON.stringify({ suggestions: SUGGESTIONS })
          }
        ],
        usage: { prompt: 180, completion: 10 }
      },
      { text: A.t3, usage: { prompt: 200, completion: 5 } }
    )

    // IPC：details 与参数按下标对应，两张快照都在
    const msgs = await listMessages()
    const block = toolBlockOf(msgs, 'call_suggest')
    expect(block?.isError).toBeFalsy()
    expect(block?.details).toStrictEqual({
      type: 'suggest',
      images: SUGGESTIONS.map((s, i) => ({
        file: layoutFiles[i],
        source: realpathSync(fixture(s.image)),
        mimeType: 'image/png',
        width: i === 0 ? 30 : 32,
        height: i === 0 ? 300 : 20,
        bytes: readFileSync(fixture(s.image)).length
      }))
    })
    for (const file of layoutFiles) expect(existsSync(join(shownDirOf(sid), file))).toBe(true)
    expect(sortedDir(shownDirOf(sid))).toStrictEqual([chartFile, ...layoutFiles].sort())

    // 模型那边：每条都标着带图
    const reqs = requestsFor(Q.t3)
    expect(reqs).toHaveLength(2)
    const suggestText = toolTextsOf(reqs[1]!).at(-1) ?? ''
    expect(suggestText).toContain('1. Layout A (with image)')
    expect(suggestText).toContain('2. Layout B (with image)')
    expect(imagePartsOf(reqs[1]!)).toStrictEqual([])

    // 屏上：一组两张、都开着，图都解码
    await shown.scrollConversation('bottom')
    await until(async () => {
      const groups = await cards.groups()
      const c = groups[0]?.cards ?? []
      return groups.length === 1 &&
        c.length === 2 &&
        c.every((card) => card.image?.complete && card.image.naturalWidth > 0)
        ? groups
        : null
    }, 'suggestion cards with decoded images')

    // 宽栏下也每条一行：模拟一个宽视口（从前宽栏会并排；结果不该取决于跑测试的那块屏幕），finally 里撤掉
    await app.main.send('Emulation.setDeviceMetricsOverride', {
      width: 1600,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false
    })
    try {
      await shown.scrollConversation('bottom')
      const [group] = await until(async () => {
        const groups = await cards.groups()
        const g = groups[0]
        return g && g.cards.length === 2 && g.cards.every((c) => c.slot !== null) ? groups : null
      }, 'suggestion cards with thumbnail slots')
      expect(group!.state).toBe('open')
      const [c0, c1] = group!.cards
      // 上下两行、同一个 left
      expect(c1!.rect.top).toBeGreaterThanOrEqual(c0!.rect.top + c0!.rect.height - 1)
      expect(c1!.rect.left).toBe(c0!.rect.left)
      // 缩略图位定宽 96、逐行对齐；图铺满这个位置
      for (const c of [c0!, c1!]) {
        expect(Math.round(c.slot!.width)).toBe(96)
        // 图在文字之后
        expect(c.slot!.left).toBeGreaterThanOrEqual(c.text.left + c.text.width - 1)
        expect(c.image!.box).toStrictEqual(c.slot)
      }
      // 文字短的那行：最矮 64，竖长的图撑不高它
      expect(Math.round(c0!.slot!.height)).toBe(64)
      // 文字多的那行：缩略图位随文字列变高，下方不留白
      expect(c1!.text.height).toBeGreaterThan(64)
      expect(c1!.slot!.top).toBe(c1!.text.top)
      expect(Math.round(c1!.slot!.height)).toBe(Math.round(c1!.text.height))
      expect(c1!.slot!.left).toBe(c0!.slot!.left)
      expect(c1!.text.left).toBe(c0!.text.left)
      expect(c1!.text.width).toBe(c0!.text.width)
      expect(group!.cards.map((c) => [c.index, c.image?.file, c.acceptable])).toStrictEqual([
        [0, layoutFiles[0], true],
        [1, layoutFiles[1], true]
      ])
      expect(group!.cards.every((c) => c.image!.complete && c.image!.naturalWidth > 0)).toBe(true)
    } finally {
      await app.main.send('Emulation.clearDeviceMetricsOverride')
    }

    // 点第二张卡的图：开出那张快照的预览窗口，什么都不发
    const requestsBefore = provider.chatRequestCount()
    const userCountBefore = msgs.filter((m) => m.role === 'user').length
    await shown.scrollConversation('bottom')
    expect(await cards.clickImage(1)).toBe(true)
    const real = realpathSync(join(shownDirOf(sid), layoutFiles[1]!))
    const win = await until(() => app.connectFilePreviewWindow(real), 'preview window for layout B')
    try {
      await until(async () => {
        const list = await filePreviewWindowImages(win)
        return list.some((i) => i.path === real && i.naturalWidth === 32) ? list : null
      }, 'layout B snapshot decoded in the preview window')
    } finally {
      await win.eval('window.close()').catch(() => undefined)
      win.close()
    }
    await sleep(500)
    expect(provider.chatRequestCount()).toBe(requestsBefore)
    expect((await listMessages()).filter((m) => m.role === 'user')).toHaveLength(userCountBefore)
    const [still] = await cards.groups()
    expect(still?.state).toBe('open')
    expect(still?.cards.find((c) => c.index === 1)?.acceptable).toBe(true)
  }, 180_000)

  it('E-5 分支整个会话：快照目录原样拷给 fork，打开 fork 图都解码、地址里是 fork', async () => {
    const result = await app.main.eval<ForkResult>(
      `window.api.session.fork(${JSON.stringify({ sessionId: sid })})`
    )
    expect(result.success, JSON.stringify(result)).toBe(true)
    forkId = (result as { success: true; sessionId: string }).sessionId
    expect(forkId).not.toBe(sid)

    const names = sortedDir(shownDirOf(sid))
    expect(names).toStrictEqual([chartFile, ...layoutFiles].sort())
    expect(sortedDir(shownDirOf(forkId))).toStrictEqual(names)
    for (const name of names) {
      expect(
        readFileSync(join(shownDirOf(forkId), name)).equals(
          readFileSync(join(shownDirOf(sid), name))
        ),
        name
      ).toBe(true)
    }

    await until(async () => (await sidebar.titles()).includes(FORK_TITLE), 'sidebar lists the fork')
    expect(await sidebar.openSession(FORK_TITLE)).toBe(true)
    await chat.ready()
    await expectForkImagesLoad()
  }, 120_000)

  it('E-6 删掉源会话：它的快照没了、fork 的还在；重新打开 fork 图照样解码', async () => {
    const forkNames = sortedDir(shownDirOf(forkId))
    await app.main.eval(`window.api.session.delete(${JSON.stringify(sid)})`)
    await until(async () => !existsSync(shownDirOf(sid)), 'source snapshots removed')
    expect(sortedDir(shownDirOf(forkId))).toStrictEqual(forkNames)

    expect(await sidebar.openSession(SCRATCH)).toBe(true)
    await chat.ready()
    expect(await sidebar.openSession(FORK_TITLE)).toBe(true)
    await chat.ready()
    await expectForkImagesLoad()
  }, 120_000)

  /** fork 里 E-1 的图与提议卡的两张图都解码，地址里的 session 是 fork */
  async function expectForkImagesLoad(): Promise<void> {
    await shown.scrollConversation('top')
    const top = await shown.waitLoaded(1, (f) => f.msgId === a1Id && f.session === forkId)
    const first = top.find((f) => f.msgId === a1Id)!
    expect(first.file).toBe(chartFile)
    expect(first.session).toBe(forkId)
    expect(first.naturalWidth).toBe(40)

    await shown.scrollConversation('bottom')
    const bottom = await shown.waitLoaded(2, (f) => f.inSuggestion && f.session === forkId)
    const suggestionFigures = bottom.filter((f) => f.inSuggestion)
    expect(suggestionFigures.map((f) => f.file)).toStrictEqual(layoutFiles)
    expect(suggestionFigures.every((f) => f.session === forkId && f.naturalWidth > 0)).toBe(true)
  }
})
