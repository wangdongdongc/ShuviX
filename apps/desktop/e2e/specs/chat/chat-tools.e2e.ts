/**
 * 对话区的工具卡片 —— 单次调用的完整生命周期、并行 batch 的预展示去重与合并行、
 * 出错行的独立呈现、以及询问卡片（工具停在等待 → 应答 → 继续）。
 *
 * 前置：所有会话绑同一个项目，`read`/`write` 的目标一律落在 projDir 内 ——
 * `ask-on-read` 只对工作区外的路径询问，故读文件不会挂在等人应答上；
 * 而 `ask-on-write` 对任何路径都 ask，正是询问用例（C-10）的被测对象。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { until } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import { startFakeProvider, type FakeProvider } from '../../harness/fakeProvider'
import {
  createProject,
  eventRecorder,
  seedFakeProvider,
  waitRendererReady,
  writePng,
  type EventRecorder,
  type RecordedEvent
} from '../../harness/seed'
import { chatPane, sidebarPane, type ChatPane, type SidebarPane } from '../../harness/pages'

const MODEL = 'e2e-model'

interface ListedMessage {
  id: string
  role: string
  type: string
  content: string
  blocks?: Array<{
    type: string
    toolCallId?: string
    toolName?: string
    result?: string
    isError?: boolean
    details?: {
      type?: string
      format?: string
      /** 模型收到的那张图在磁盘上的落点（read 到图片时） */
      image?: { path: string; width?: number; height?: number; bytes?: number }
    }
  }>
}

/** 会话里所有助手卡片的工具块，按出现顺序摊平 */
const toolBlocksOf = (msgs: ListedMessage[]): NonNullable<ListedMessage['blocks']> =>
  msgs.flatMap((m) => (m.blocks ?? []).filter((b) => b.type === 'tool'))

let app: E2EApp
let provider: FakeProvider
let events: EventRecorder
let chat: ChatPane
let sidebar: SidebarPane
let projDir = ''
const sids: Record<string, string> = {}

const createSession = async (title: string, projectId: string): Promise<string> =>
  app.main.eval<string>(
    `window.api.session.create(${JSON.stringify({ title, projectId })}).then((s) => s.id)`
  )

const listMessages = (sid: string): Promise<ListedMessage[]> =>
  app.main.eval<ListedMessage[]>(`window.api.message.list(${JSON.stringify(sid)})`)

const sessionEvents = async (sid: string): Promise<RecordedEvent[]> =>
  (await events.all()).filter((e) => e.sessionId === sid)

const readCall = (id: string, file: string): { id: string; name: string; args: string } => ({
  id,
  name: 'read',
  args: JSON.stringify({ path: join(projDir, file) })
})

beforeAll(async () => {
  app = await launchApp()
  provider = await startFakeProvider()
  await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  await waitRendererReady(app.main)

  projDir = join(app.home, 'proj-tools')
  mkdirSync(projDir, { recursive: true })
  writeFileSync(join(projDir, 'alpha.txt'), 'ALPHA CONTENT\n')
  writeFileSync(join(projDir, 'beta.txt'), 'BETA CONTENT\n')
  // 图片种子：一张够小（直出原文件）、一张够大（走缩放重编码 + 派生图落盘）
  writePng(join(projDir, 'small.png'), { width: 40, height: 24 })
  writePng(join(projDir, 'big.png'), { width: 1400, height: 1000, incompressible: true })
  const project = await createProject(app.main, { name: 'ToolsProj', path: projDir })

  sids.single = await createSession('T-single', project.id)
  sids.batch = await createSession('T-batch', project.id)
  sids.error = await createSession('T-error', project.id)
  sids.ask = await createSession('T-ask', project.id)
  sids.scratch = await createSession('T-scratch', project.id)
  sids.img = await createSession('T-img', project.id)
  sids.imgBig = await createSession('T-img-big', project.id)
  sids.imgGone = await createSession('T-img-gone', project.id)
  sids.imgText = await createSession('T-img-text', project.id)

  chat = chatPane(app.main)
  sidebar = sidebarPane(app.main)
  await sidebar.clickNewChat()
  await until(async () => (await sidebar.titles()).includes('T-single'), 'sidebar list refreshed')

  events = eventRecorder(app.main)
  await events.install()
})

afterAll(async () => {
  await provider.close()
  await app.stop()
})

describe('单次工具调用', () => {
  it('事件走完 生成中 → 执行中 → 完成，结构化 details 落进消息并在重开后仍在', async () => {
    provider.reset()
    await events.clear()
    provider.script(
      { toolCalls: [readCall('call_1', 'alpha.txt')], usage: { prompt: 90, completion: 6 } },
      { text: 'done', usage: { prompt: 110, completion: 4 } }
    )

    expect(await sidebar.openSession('T-single')).toBe(true)
    await chat.ready()
    await chat.typeAndSend('read alpha')
    await events.waitFor('agent_end', { sessionId: sids.single })
    await chat.waitIdle()

    const all = await sessionEvents(sids.single)
    const types = all.map((e) => e.type)
    expect(types.filter((t) => t === 'toolcall_generating').length).toBeGreaterThan(0)
    expect(types.indexOf('tool_start')).toBeGreaterThan(types.indexOf('toolcall_generating'))
    expect(types.indexOf('tool_end')).toBeGreaterThan(types.indexOf('tool_start'))

    const start = all.find((e) => e.type === 'tool_start')!
    const end = all.find((e) => e.type === 'tool_end')!
    expect(start.toolCallId).toBe('call_1')
    expect(start.toolName).toBe('read')
    expect(end.toolCallId).toBe('call_1')
    expect(String(end.result)).toContain('ALPHA CONTENT')
    expect(end.details).toMatchObject({ type: 'read' })
    // messageId 指向承载这次调用的那张卡（= assistant entry id）
    const listed = await listMessages(sids.single)
    const card = listed.find((m) => m.id === start.messageId)!
    expect(card.role).toBe('assistant')

    // 投影契约：工具调用是卡内的块，按 toolCallId 认；结果回填在块上
    const tools = toolBlocksOf(listed)
    expect(tools).toHaveLength(1)
    expect(tools[0].toolCallId).toBe('call_1')
    expect(tools[0].toolName).toBe('read')
    expect(tools[0].result).toContain('ALPHA CONTENT')
    expect(tools[0].details?.type).toBe('read')

    const rows = await chat.toolRows()
    expect(rows).toEqual([{ name: 'read', status: 'done' }])
    expect(await chat.expandToolRow(0)).toContain('ALPHA CONTENT')

    // 重开：details / 结果文本随投影还原
    expect(await sidebar.openSession('T-scratch')).toBe(true)
    expect(await sidebar.openSession('T-single')).toBe(true)
    await until(async () => (await chat.toolRows()).length === 1, 'tool row reprojected')
    expect(await chat.toolRows()).toEqual([{ name: 'read', status: 'done' }])
    const reopened = toolBlocksOf(await listMessages(sids.single))
    expect(reopened.find((b) => b.toolCallId === 'call_1')?.details?.type).toBe('read')
  })
})

describe('一条消息里的多个同名调用', () => {
  it('batch 预展示不重复落条目，相邻同名成功调用合并为一行 + 计数', async () => {
    provider.reset()
    await events.clear()
    provider.script(
      {
        toolCalls: [readCall('call_a', 'alpha.txt'), readCall('call_b', 'beta.txt')],
        usage: { prompt: 95, completion: 8 }
      },
      { text: 'both read', usage: { prompt: 130, completion: 5 } }
    )

    expect(await sidebar.openSession('T-batch')).toBe(true)
    await chat.ready()
    await chat.typeAndSend('read both')
    await events.waitFor('agent_end', { sessionId: sids.batch })
    await chat.waitIdle()

    // 预展示（≥2 个调用）与 tool_execution_start 靠 preEmittedToolCalls 去重：各只发一次
    const all = await sessionEvents(sids.batch)
    const starts = all.filter((e) => e.type === 'tool_start')
    expect(starts.map((e) => e.toolCallId).sort()).toEqual(['call_a', 'call_b'])

    // 两次调用同处一条 assistant entry —— 一张卡两个工具块，顺序即模型输出顺序
    const listed = await listMessages(sids.batch)
    const cards = listed.filter(
      (m) => m.role === 'assistant' && m.blocks?.some((b) => b.type === 'tool')
    )
    expect(cards).toHaveLength(1)
    expect(toolBlocksOf(listed).map((b) => b.toolCallId)).toEqual(['call_a', 'call_b'])

    // 合并行：折叠态只有一行计数徽章，展开后才逐条列出
    expect(await chat.groupBadges()).toEqual(['2'])
    expect(await chat.toolRows()).toHaveLength(0)
    await chat.expandGroups()
    expect(await chat.toolRows()).toEqual([
      { name: 'read', status: 'done' },
      { name: 'read', status: 'done' }
    ])
  })
})

describe('工具报错', () => {
  it('错误行独立呈现、不参与同名合并，重开一致', async () => {
    provider.reset()
    await events.clear()
    provider.script(
      {
        toolCalls: [readCall('call_ok', 'alpha.txt'), readCall('call_bad', 'nope-missing.txt')],
        usage: { prompt: 95, completion: 8 }
      },
      { text: 'partially failed', usage: { prompt: 130, completion: 5 } }
    )

    expect(await sidebar.openSession('T-error')).toBe(true)
    await chat.ready()
    await chat.typeAndSend('read one good one bad')
    await events.waitFor('agent_end', { sessionId: sids.error })
    await chat.waitIdle()

    const all = await sessionEvents(sids.error)
    const bad = all.find((e) => e.type === 'tool_end' && e.toolCallId === 'call_bad')!
    expect(bad.isError).toBe(true)

    const blocks = toolBlocksOf(await listMessages(sids.error))
    expect(blocks.find((b) => b.toolCallId === 'call_bad')?.isError).toBe(true)
    expect(blocks.find((b) => b.toolCallId === 'call_ok')?.isError).toBeUndefined()

    // 出错的那条被 completedToolCall 排除 → 两行都保持独立，无合并徽章
    expect(await chat.groupBadges()).toEqual([])
    const rows = await chat.toolRows()
    expect(rows.map((r) => r.status).sort()).toEqual(['done', 'error'])

    expect(await sidebar.openSession('T-scratch')).toBe(true)
    expect(await sidebar.openSession('T-error')).toBe(true)
    await until(async () => (await chat.toolRows()).length === 2, 'error rows reprojected')
    expect((await chat.toolRows()).map((r) => r.status).sort()).toEqual(['done', 'error'])
    expect(await chat.groupBadges()).toEqual([])
  })
})

describe('询问卡片', () => {
  it('write 撞 ask-on-write：工具停在等待，卡片顶格在输入卡片内，应答后继续执行', async () => {
    provider.reset()
    await events.clear()
    const target = join(projDir, 'written.txt')
    provider.script(
      {
        toolCalls: [
          { id: 'call_write', name: 'write', args: JSON.stringify({ path: target, content: 'W1' }) }
        ],
        usage: { prompt: 90, completion: 6 }
      },
      { text: 'written', usage: { prompt: 120, completion: 4 } }
    )

    expect(await sidebar.openSession('T-ask')).toBe(true)
    await chat.ready()
    await chat.typeAndSend('write a file')

    const request = await events.waitFor<RecordedEvent & { request: { id: string } }>(
      'input_request',
      { sessionId: sids.ask }
    )
    expect(await chat.pendingPanel()).toEqual({ open: true, firstInCard: true })

    await app.main.eval(
      `window.api.agent.respondToInput(${JSON.stringify({
        sessionId: sids.ask,
        requestId: request.request.id,
        response: { kind: 'ask', allowed: true }
      })})`
    )

    await events.waitFor('input_request_resolved', { sessionId: sids.ask })
    await events.waitFor('agent_end', { sessionId: sids.ask })
    await chat.waitIdle()

    const all = await sessionEvents(sids.ask)
    const end = all.find((e) => e.type === 'tool_end' && e.toolCallId === 'call_write')!
    expect(end.isError).toBeFalsy()
    expect(readFileSync(target, 'utf8')).toContain('W1')

    await until(async () => !(await chat.pendingPanel()).open, 'pending panel dismissed')
    expect((await chat.toolRows()).map((r) => r.name)).toContain('write')
  })
})

/**
 * 工具卡片内联显示「模型收到的那张图」。
 *
 * 链路：read 读到图片 → `details.image` 留下**模型实际收到的那一份**的磁盘路径
 * （≤1MB 指原文件、>1MB 指落盘的派生 JPEG）→ 随 toolResult 进会话树 → 投影回填到
 * 工具块 → 渲染端只在展开态经 mediaUrl seam 取图（零 base64 进渲染进程）。
 */
describe('模型收到的那张图', () => {
  const smallPng = (): string => join(projDir, 'small.png')
  const bigPng = (): string => join(projDir, 'big.png')

  /** 脚本化一次 read 调用并等它跑完（本组用例的固定开场） */
  const runRead = async (title: string, sid: string, file: string, id: string): Promise<void> => {
    provider.reset()
    await events.clear()
    provider.script(
      { toolCalls: [readCall(id, file)], usage: { prompt: 90, completion: 6 } },
      { text: 'seen', usage: { prompt: 110, completion: 4 } }
    )
    expect(await sidebar.openSession(title)).toBe(true)
    await chat.ready()
    await chat.typeAndSend(`read ${file}`)
    await events.waitFor('agent_end', { sessionId: sid })
    await chat.waitIdle()
  }

  /** 会话里第一个工具块 */
  const firstToolBlock = async (sid: string): Promise<NonNullable<ListedMessage['blocks']>[0]> =>
    toolBlocksOf(await listMessages(sid))[0]

  describe('未超限：直出原文件', () => {
    // 一次对话喂五条断言 —— 事件流、消息树、DOM 挂载、点击信号、重开还原
    // 都是同一次 read 的产物，重跑一遍只会多出第二行工具卡片扰乱索引
    beforeAll(async () => {
      await runRead('T-img', sids.img, 'small.png', 'call_img')
    })

    it('缩略图只在展开态挂载', async () => {
      await chat.setToolRowExpanded(0, false)
      expect(await chat.toolImages()).toHaveLength(0)
      await chat.setToolRowExpanded(0, true)
      expect(await chat.waitToolImages(1)).toHaveLength(1)
      await chat.setToolRowExpanded(0, false)
      expect(await chat.toolImages()).toHaveLength(0)
    })

    it('details.image 指原文件，展开后 <img> 按原尺寸解码', async () => {
      const end = (await sessionEvents(sids.img)).find((e) => e.type === 'tool_end')!
      const eventImage = (end.details as { image?: { path: string } }).image
      expect(eventImage?.path).toBe(smallPng())

      const block = await firstToolBlock(sids.img)
      expect(block.details?.image).toMatchObject({ path: smallPng(), width: 40, height: 24 })

      await chat.setToolRowExpanded(0, true)
      const [shot] = await chat.waitToolImages(1)
      expect(shot.path).toBe(smallPng())
      expect([shot.naturalWidth, shot.naturalHeight]).toEqual([40, 24])
      expect(shot.complete).toBe(true)
    })

    it('base64 不进渲染进程：事件与消息里都只有占位文本', async () => {
      const head = readFileSync(smallPng()).toString('base64').slice(0, 200)

      const end = (await sessionEvents(sids.img)).find((e) => e.type === 'tool_end')!
      expect(String(end.result)).toContain('[image (image/png)')
      expect(JSON.stringify(end)).not.toContain(head)

      // 投影是另一套代码（textOf 直接丢掉图片块），与广播管线各钉一次
      const block = await firstToolBlock(sids.img)
      expect(block.result).toContain('Image: ')
      expect(block.result ?? '').not.toContain(head)
    })

    it('点缩略图：同一路径在工具子树之外打开（既有的预览信号）', async () => {
      await chat.setToolRowExpanded(0, true)
      await chat.waitToolImages(1)
      await chat.clickToolImage(0)
      const outside = await until(async () => {
        const imgs = await chat.previewPanelImages()
        return imgs.some((i) => i.path === smallPng()) ? imgs : null
      }, 'preview outside the tool subtree')
      expect(outside.some((i) => i.path === smallPng())).toBe(true)
    })

    it('活过关闭再打开：重投影后仍是同一 path，展开仍能解码', async () => {
      expect(await sidebar.openSession('T-scratch')).toBe(true)
      expect(await sidebar.openSession('T-img')).toBe(true)
      await until(async () => (await chat.toolRows()).length === 1, 'tool row reprojected')

      expect((await firstToolBlock(sids.img)).details?.image?.path).toBe(smallPng())
      await chat.setToolRowExpanded(0, true)
      const [shot] = await chat.waitToolImages(1)
      expect(shot.path).toBe(smallPng())
      expect(shot.naturalWidth).toBe(40)
    })
  })

  it('超限：details.image 指落盘的派生 JPEG，展开后按压缩后的宽度解码', async () => {
    expect(statSync(bigPng()).size).toBeGreaterThan(1024 * 1024)
    await runRead('T-img-big', sids.imgBig, 'big.png', 'call_img_big')

    const block = await firstToolBlock(sids.imgBig)
    expect(block.details?.format).toBe('JPEG')
    const image = block.details!.image!
    expect(image.path).not.toBe(bigPng())
    expect(image.path).toContain(join('tool_results', sids.imgBig))
    expect(image.path.endsWith('.jpg')).toBe(true)
    expect(existsSync(image.path)).toBe(true)
    expect(statSync(image.path).size).toBe(image.bytes)
    expect(statSync(image.path).size).toBeLessThanOrEqual(1024 * 1024)

    await chat.setToolRowExpanded(0, true)
    const [shot] = await chat.waitToolImages(1)
    expect(shot.path).toBe(image.path)
    expect(shot.naturalWidth).toBe(image.width)
  })

  it('派生图文件没了：不留破图，给一句降级文案', async () => {
    await runRead('T-img-gone', sids.imgGone, 'big.png', 'call_img_gone')
    const image = (await firstToolBlock(sids.imgGone)).details!.image!
    expect(existsSync(image.path)).toBe(true)
    rmSync(image.path)

    // 重开会话让工具行重投影（路径还在消息树里，文件已经不在了）
    expect(await sidebar.openSession('T-scratch')).toBe(true)
    expect(await sidebar.openSession('T-img-gone')).toBe(true)
    await until(async () => (await chat.toolRows()).length === 1, 'tool row reprojected')

    await chat.setToolRowExpanded(0, true)
    const fallbacks = await until(async () => {
      const texts = await chat.toolImageFallbacks()
      return texts.length > 0 ? texts : null
    }, 'image fallback text')
    expect(fallbacks[0].length).toBeGreaterThan(0)
    expect(await chat.toolImages()).toHaveLength(0)
  })

  it('读文本文件：没有图片位，也没有降级文案', async () => {
    await runRead('T-img-text', sids.imgText, 'alpha.txt', 'call_img_text')
    expect((await firstToolBlock(sids.imgText)).details?.image).toBeUndefined()
    await chat.setToolRowExpanded(0, true)
    expect(await chat.toolImages()).toHaveLength(0)
    expect(await chat.toolImageFallbacks()).toEqual([])
  })
})
