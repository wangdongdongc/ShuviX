/**
 * 任务列表（内置工具 `update_plan`，docs/task-list-design.md §3、§9）—— 单测各管一段（taskList.test.ts 的折叠、
 * taskListReader / taskListParity 的工具侧读者、registry.test.ts 的档案名单、taskListPanel / assistantBubbleTaskList
 * 的界面），这里只走一遍它们都替身掉的那条链：work 档案默认带着它 → 模型真调 `update_plan` → 桌面注册的工具从
 * 开着的会话里读已提交的条目、折叠出上一次的列表 → 结果行回给模型 → 渲染端把列表钉在对话流末尾，每次调用在卡片里
 * 照普通工具行显示。2026-11-14 之前它是实验的内置 MCP（`plan` server 的 `mcp__plan__update`，要逐会话勾选）。
 *
 *   TLE-1 `mcp.list()` 没有 `plan` 行（v42 删掉了 v37 种的那一行）；`tools.list` 里 `update_plan` 是内置工具、
 *         按会话档案缺省开启；设置 → MCP 没有 plan 那一行，内置行都不带「实验」标签
 *   TLE-2 什么扩展都没勾的会话：选择器里没有 `mcp:plan`；发一条消息，请求里带着 `update_plan`，模型不调它列表就不出现
 *   TLE-3 同一种会话，三轮脚本（列表与第一次真调用同一条消息 → 推进 → 终答）：
 *         a 第二轮挂着时列表在跑、各步状态（列表只有步骤行，没有标题行、不折叠）；列表在对话的滚动区里，不在输入框卡片里；
 *         b 同一时刻卡片里：第一轮的列表调用和 ls 并成一个合并行（摘要里有第一步），第二轮正在流式生成的
 *           那次是一条 generating 的列表行；
 *         c 两次调用的结果是 `Plan shown (3 steps).` / `Plan updated: step 2 of 3 is in progress.` —— 后一句
 *           证明读者接上了（没接上就是「这个请求里还没有列表」）；第三轮的请求里带着这两句；
 *         d 跑完：完成，每一步都是完成；
 *         e 卡片里三步（列表、ls、推进）并成一个合并行，展开后两条列表行一条 ls 行
 *   TLE-4 同一会话发新请求、第一轮只推进：新请求的消息一出现旧列表就让位；推进失败成一条红行，结果是
 *         「这个请求里还没有列表」，列表一直不出现
 *   TLE-5 中止（S1）：发过列表、终答流到一半被中止 → 最后一张卡带 `stopped`，列表是「已停止」、状态照实，
 *         进行中那一步是暂停图标
 *
 * 选择器全部走 `harness/pages.ts`（`taskListPane` / `toolPickerPane` / `mcpSettingsPane` / `chatPane`）。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { until, type CdpClient } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import { startFakeProvider, type FakeProvider, type FakeRequest } from '../../harness/fakeProvider'
import {
  createProject,
  eventRecorder,
  seedFakeProvider,
  waitRendererReady,
  type EventRecorder
} from '../../harness/seed'
import {
  chatPane,
  mcpSettingsPane,
  sidebarPane,
  taskListPane,
  toolPickerPane,
  type ChatPane,
  type SidebarPane,
  type TaskListPane,
  type ToolPickerPane
} from '../../harness/pages'

const MODEL = 'e2e-model'
const PLAN = 'update_plan'
const STEPS = ['Read the code', 'Fix the bug', 'Run the tests']
const ITEMS = STEPS.map((content, i) => ({
  content,
  status: i === 0 ? 'in_progress' : 'pending'
}))
const TITLES = { off: 'TL-off', on: 'TL-on', stop: 'TL-stop' }

interface McpRow {
  id: string
  name: string
  type: string
  isBuiltin: number
  isEnabled: number
}

interface ListedTool {
  name: string
  group?: string
  isBuiltin?: boolean
  defaultEnabled?: boolean
  declaredBy?: string
}

interface ListedBlock {
  type: string
  toolName?: string
  toolCallId?: string
  result?: unknown
  isError?: boolean
}

interface ListedMessage {
  id: string
  role: string
  type: string
  content: string
  blocks?: ListedBlock[]
  metadata?: { stopped?: boolean } | null
}

let app: E2EApp
let settings: CdpClient
let provider: FakeProvider
let events: EventRecorder
let chat: ChatPane
let sidebar: SidebarPane
let picker: ToolPickerPane
let list: TaskListPane
let projDir = ''
const sids: Record<keyof typeof TITLES, string> = { off: '', on: '', stop: '' }

// ─── IPC 助手 ───

const createSession = (title: string, projectId: string): Promise<string> =>
  app.main.eval<string>(
    `window.api.session.create(${JSON.stringify({ title, projectId })}).then((s) => s.id)`
  )
const storedTools = (sid: string): Promise<unknown> =>
  app.main.eval(
    `window.api.session.getById(${JSON.stringify(sid)}).then((s) => (s && s.settings ? s.settings.enabledTools : undefined))`
  )
const listMessages = (sid: string): Promise<ListedMessage[]> =>
  app.main.eval<ListedMessage[]>(`window.api.message.list(${JSON.stringify(sid)})`)

/** 这次请求带给模型的工具名 */
const requestToolNames = (req: FakeRequest): string[] =>
  ((req.body.tools ?? []) as Array<{ function?: { name?: string } }>).map(
    (t) => t.function?.name ?? ''
  )

/** 会话里所有列表调用那几块（消息序、块序） */
const planBlocks = (messages: ListedMessage[]): ListedBlock[] =>
  messages.flatMap((m) => (m.blocks ?? []).filter((b) => b.type === 'tool' && b.toolName === PLAN))

const resultText = (block: ListedBlock | undefined): string =>
  typeof block?.result === 'string' ? block.result : JSON.stringify(block?.result ?? null)

/** 打开某条会话并等输入卡片就绪 */
const openSession = async (key: keyof typeof TITLES): Promise<void> => {
  expect(await sidebar.openSession(TITLES[key])).toBe(true)
  await chat.ready()
}

beforeAll(async () => {
  app = await launchApp()
  provider = await startFakeProvider()
  await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  await waitRendererReady(app.main)

  projDir = join(app.home, 'proj-task-list')
  mkdirSync(projDir, { recursive: true })
  writeFileSync(join(projDir, 'alpha.txt'), 'ALPHA\n')
  const project = await createProject(app.main, { name: 'TaskListProj', path: projDir })
  // 标题都不是缺省标题：自动标题不跑，不会吃掉脚本队列里的轮次
  sids.off = await createSession(TITLES.off, project.id)
  sids.on = await createSession(TITLES.on, project.id)
  sids.stop = await createSession(TITLES.stop, project.id)
  // 什么都不勾：项目会话的基座 work 名单里写着 update_plan，agent 建出来时就带着它

  chat = chatPane(app.main)
  sidebar = sidebarPane(app.main)
  picker = toolPickerPane(app.main)
  list = taskListPane(app.main)
  // IPC 建的会话没有广播：点一次「新对话」让侧栏拉全量列表
  await sidebar.clickNewChat()
  await until(async () => (await sidebar.titles()).includes(TITLES.stop), 'sidebar lists sessions')

  events = eventRecorder(app.main)
  await events.install()
}, 120_000)

afterAll(async () => {
  await provider?.close()
  await app?.stop()
})

describe('内置工具，不是 MCP', () => {
  it('TLE-1 没有 plan 行（v42 删了 v37 种的那一行）；update_plan 是内置工具、按档案缺省开启；设置 → MCP 没有 plan 行、内置行都不带「实验」标签', async () => {
    const rows = await app.main.eval<McpRow[]>(`window.api.mcp.list()`)
    expect(rows.filter((r) => r.name === 'plan')).toEqual([])
    expect(rows.filter((r) => r.id === 'builtin-mcp-plan')).toEqual([])

    const listed = await app.main.eval<ListedTool[]>(
      `window.api.tools.list(${JSON.stringify(sids.on)})`
    )
    expect(listed.find((t) => t.name === PLAN)).toMatchObject({
      group: 'general',
      defaultEnabled: true
    })
    expect(listed.some((t) => t.name === 'mcp:plan')).toBe(false)

    settings = await app.openSettings('mcp')
    const mcp = mcpSettingsPane(settings)
    expect((await mcp.waitRow('browser')).experimental).toBeNull()
    const shots = await mcp.rows()
    expect(shots.map((r) => r.name)).not.toContain('plan')
    expect(shots.filter((r) => r.builtinBadge && r.experimental !== null)).toEqual([])
  }, 120_000)
})

describe('不用勾', () => {
  it('TLE-2 什么扩展都没勾的会话：选择器里没有 mcp:plan；请求里带着 update_plan，不调就没有列表', async () => {
    provider.reset()
    await events.clear()

    expect(((await storedTools(sids.off)) as string[] | undefined) ?? []).toEqual([])

    await openSession('off')
    await picker.open()
    const items = await until(async () => {
      const all = await picker.items()
      return all.some((i) => i.name === 'mcp:browser') ? all : null
    }, 'tool picker lists its MCP rows')
    expect(items.some((i) => i.name === 'mcp:plan')).toBe(false)
    expect(items.filter((i) => i.experimental !== null)).toEqual([])
    await picker.close()

    provider.script({ text: 'Hello there.', usage: { prompt: 80, completion: 5 } })
    await chat.typeAndSend('hello')
    await events.waitFor('agent_end', { sessionId: sids.off })
    await chat.waitIdle()

    expect(provider.chatRequestCount()).toBe(1)
    const tools = requestToolNames(provider.requests()[0]!)
    expect(tools).toContain(PLAN)
    expect(tools).not.toContain('mcp__plan__update')
    expect(await list.present()).toBe(false)
  }, 120_000)
})

describe('列表的一生', () => {
  it('TLE-3 列表随第一次真调用发出、推进一步、终答收尾：对话末尾的列表，卡片里照常有它的行，结果行出自真读者', async () => {
    provider.reset()
    await events.clear()
    provider.script(
      {
        toolCalls: [
          { id: 'p1', name: PLAN, args: JSON.stringify({ items: ITEMS }) },
          { id: 'l1', name: 'ls', args: JSON.stringify({ path: projDir }) }
        ],
        usage: { prompt: 90, completion: 10 }
      },
      {
        toolCalls: [{ id: 'p2', name: PLAN, args: JSON.stringify({ advance: true }) }],
        usage: { prompt: 110, completion: 5 },
        holdMs: 20_000
      },
      { text: 'All done.', usage: { prompt: 130, completion: 5 } }
    )

    await openSession('on')
    await chat.typeAndSend('fix the bug')
    await until(() => provider.holding(), 'second turn held', 30_000)

    // 第一轮的请求里有列表工具（档案名单里写着，agent 建出来时就带着）
    expect(requestToolNames(provider.requests()[0]!)).toContain(PLAN)

    // TLE-3a 第二轮挂着：第一轮的列表在跑
    await until(async () => (await list.phase()) === 'running', 'task list running')
    // 列表在对话流末尾（滚动区里），不在输入框卡片里
    expect(await list.where()).toBe('conversation')
    expect((await list.steps()).map((s) => [s.n, s.status, s.text])).toEqual([
      [1, 'in_progress', STEPS[0]],
      [2, 'pending', STEPS[1]],
      [3, 'pending', STEPS[2]]
    ])

    // TLE-3b 同一时刻：第一轮成功的列表调用和 ls 并成一个合并行（摘要里有列表那时进行中的一步），
    // 第二轮正在生成的那次是一条 generating 的列表行
    const heldGroup = await until(async () => {
      const groups = await chat.stepGroupShots()
      return groups.find((g) => g.size === 2) ?? null
    }, 'first-turn step group on screen')
    expect(heldGroup).toMatchObject({ state: 'collapsed', count: 2 })
    expect(heldGroup.detail).toContain(STEPS[0])
    const generating = await until(async () => {
      const rows = (await chat.toolRows()).filter((r) => r.name === PLAN)
      return rows.length > 0 ? rows : null
    }, 'second-turn plan call on screen')
    expect(generating).toEqual([{ name: PLAN, status: 'generating' }])

    provider.release()
    await events.waitFor('agent_end', { sessionId: sids.on })
    await chat.waitIdle()

    // TLE-3c 两次调用的结果；第二句只有读者接上了才算得出来
    const messages = await listMessages(sids.on)
    const blocks = planBlocks(messages)
    expect(blocks.map((b) => [b.toolCallId, resultText(b), !!b.isError])).toEqual([
      ['p1', 'Plan shown (3 steps).', false],
      ['p2', 'Plan updated: step 2 of 3 is in progress.', false]
    ])
    expect(provider.chatRequestCount()).toBe(3)
    const third = provider.requests()[2]!.raw
    expect(third).toContain('Plan shown (3 steps).')
    expect(third).toContain('Plan updated: step 2 of 3 is in progress.')

    // TLE-3d 跑完：以终答收尾 → 完成、全部算完成
    await until(async () => (await list.phase()) === 'done', 'task list done')
    expect((await list.steps()).map((s) => [s.n, s.status, s.text])).toEqual([
      [1, 'completed', STEPS[0]],
      [2, 'completed', STEPS[1]],
      [3, 'completed', STEPS[2]]
    ])

    // TLE-3e 卡片里三步（列表、ls、推进）并成一个合并行；展开后各是一行
    const groups = await chat.stepGroupShots()
    expect(groups.map((g) => [g.state, g.size, g.count])).toEqual([['collapsed', 3, 3]])
    expect(groups[0].detail).toContain(STEPS[0])
    await chat.expandGroups()
    expect(await chat.toolRows()).toEqual([
      { name: PLAN, status: 'done' },
      { name: 'ls', status: 'done' },
      { name: PLAN, status: 'done' }
    ])
  }, 120_000)

  it('TLE-4 新请求：旧列表让位；只推进的调用失败成红行（这个请求里还没有列表），列表不出现', async () => {
    provider.reset()
    await events.clear()
    provider.script(
      {
        toolCalls: [{ id: 'p3', name: PLAN, args: JSON.stringify({ advance: true }) }],
        usage: { prompt: 150, completion: 5 },
        holdMs: 20_000
      },
      { text: 'ok', usage: { prompt: 170, completion: 5 } }
    )

    expect(await list.present()).toBe(true)
    await chat.typeAndSend('now something else')
    // 新请求的消息（乐观占位，或已落库的那条）一上屏，旧请求的列表就让位
    await until(async () => !(await list.present()), 'previous task list gone')
    await until(() => provider.holding(), 'first turn of the new request held', 30_000)
    expect(await list.present()).toBe(false)

    provider.release()
    await events.waitFor('agent_end', { sessionId: sids.on })
    await chat.waitIdle()

    const failed = planBlocks(await listMessages(sids.on)).find((b) => b.toolCallId === 'p3')
    expect(failed?.isError).toBe(true)
    expect(resultText(failed)).toContain('No task list in this request yet')

    // 上一个请求展开过的合并行里还有两条成功的列表行，这里只数红行
    const failedRows = await until(async () => {
      const rows = (await chat.toolRows()).filter((r) => r.name === PLAN && r.status === 'error')
      return rows.length > 0 ? rows : null
    }, 'failed plan row rendered')
    expect(failedRows).toHaveLength(1)
    expect(await list.present()).toBe(false)
  }, 120_000)

  it('TLE-5 终答流到一半被中止：最后一张卡带 stopped，列表是「已停止」、状态照实、进行中那一步是暂停', async () => {
    provider.reset()
    await events.clear()
    const items = ITEMS.slice(0, 2)
    provider.script(
      {
        toolCalls: [{ id: 'p5', name: PLAN, args: JSON.stringify({ items }) }],
        usage: { prompt: 90, completion: 10 }
      },
      {
        text: ['partial ', 'reply'],
        chunkDelayMs: 30,
        usage: { prompt: 110, completion: 5 },
        holdMs: 20_000
      }
    )

    await openSession('stop')
    await chat.typeAndSend('start and then stop')
    await until(() => provider.holding(), 'answer turn held', 30_000)
    await until(async () => (await list.phase()) === 'running', 'task list running')

    await app.main.eval(`window.api.agent.abort(${JSON.stringify(sids.stop)})`)
    await events.waitFor('agent_end', { sessionId: sids.stop })
    await chat.waitIdle()

    // 被截断的正文落成一张普通卡（不是错误行），带 stopped
    const messages = await listMessages(sids.stop)
    const last = messages.at(-1)!
    expect(last).toMatchObject({ role: 'assistant', type: 'message' })
    expect(last.content).toContain('partial')
    expect(last.metadata?.stopped).toBe(true)

    await until(async () => (await list.phase()) === 'stopped', 'task list stopped')
    const steps = await list.steps()
    expect(steps.map((s) => [s.n, s.status, s.text])).toEqual([
      [1, 'in_progress', STEPS[0]],
      [2, 'pending', STEPS[1]]
    ])
    expect(steps[0]!.icon).toBe('lucide-circle-pause')
  }, 120_000)
})
