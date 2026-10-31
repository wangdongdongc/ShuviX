/**
 * 任务列表（内置能力服务器 `plan`，docs/task-list-design.md §3，实验）—— 单测各管一段（taskList.test.ts 的折叠、
 * taskListReader / taskListParity 的 server 侧读者、planServer.test.ts 的工具、migrationV37.test.ts 的种子行、
 * taskListPanel / assistantBubbleTaskList 的界面），这里只走一遍它们都替身掉的那条链：v37 在真库上种下内置行 →
 * 会话默认不勾 → 勾上后模型真调 `mcp__plan__update` → main 启动时注册的读者（`setBuiltinMcpTaskListReader`）
 * 从已提交的条目折叠出上一次的列表 → 结果行回给模型 → 渲染端把列表钉在输入框上方、卡片里不出行。
 *
 *   TLE-1 `mcp.list()` 有内置的 `plan` 行（inproc、启用）；设置 → MCP 那一行带内置徽章与「实验」标签
 *   TLE-2 没勾的会话：`tools.list` 列出 `mcp:plan`（内置、没有档案声明、不在勾选里），选择器那一行带「实验」标签、
 *         没勾；发一条消息，请求里没有 `mcp__plan__update`
 *   TLE-3 勾上的会话，三轮脚本（列表与第一次真调用同一条消息 → 推进 → 终答）：
 *         a 第二轮挂着时列表在跑、0/3、摘要是第一步、展开、各步状态；
 *         b 同一时刻卡片里没有列表调用那一行（正在流式生成的那一次也没有）；
 *         c 两次调用的结果是 `Plan shown (3 steps).` / `Plan updated: step 2 of 3 is in progress.` —— 后一句
 *           证明读者接上了（没接上就是「这个请求里还没有列表」）；第三轮的请求里带着这两句；
 *         d 跑完：完成、3/3、默认折叠，展开后每一步都是完成；
 *         e 卡片里的工具行只有 `ls`，没有合并行
 *   TLE-4 同一会话发新请求、第一轮只推进：新请求的消息一出现旧列表就让位；推进失败成一条红行，结果是
 *         「这个请求里还没有列表」，列表一直不出现
 *   TLE-5 中止（S1）：发过列表、终答流到一半被中止 → 最后一张卡带 `stopped`，列表是「已停止」、计数照实，
 *         展开后进行中那一步是暂停图标
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
const PLAN = 'mcp__plan__update'
const PLAN_ID = 'builtin-mcp-plan'
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
  isBuiltin?: boolean
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
const writeTools = (sid: string, enabledTools: string[]): Promise<{ success: boolean }> =>
  app.main.eval(
    `window.api.session.updateEnabledTools(${JSON.stringify({ id: sid, enabledTools })})`
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
  // 第一条消息之前勾上：agent 建出来时就带着 plan 的工具
  expect((await writeTools(sids.on, ['mcp:plan'])).success).toBe(true)
  expect((await writeTools(sids.stop, ['mcp:plan'])).success).toBe(true)

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

describe('种子行与设置', () => {
  it('TLE-1 迁移 v37 种下的内置 plan 行：inproc、启用；设置 → MCP 那一行带内置徽章与「实验」标签', async () => {
    const rows = await app.main.eval<McpRow[]>(`window.api.mcp.list()`)
    const plans = rows.filter((r) => r.name === 'plan')
    expect(plans).toHaveLength(1)
    expect(plans[0]).toMatchObject({
      id: PLAN_ID,
      name: 'plan',
      type: 'inproc',
      isBuiltin: 1,
      isEnabled: 1
    })

    settings = await app.openSettings('mcp')
    const mcp = mcpSettingsPane(settings)
    const row = await mcp.waitRow('plan')
    expect(row).toMatchObject({ builtinBadge: true, typeBadge: 'inproc', experimental: 'taskList' })
    // 对照：别的内置行没有这枚标签
    expect((await mcp.waitRow('browser')).experimental).toBeNull()
  }, 120_000)
})

describe('默认不勾', () => {
  it('TLE-2 没勾的会话：列得出 mcp:plan（内置、带「实验」标签、没勾），请求里没有列表工具', async () => {
    provider.reset()
    await events.clear()

    const listed = await app.main.eval<ListedTool[]>(
      `window.api.tools.list(${JSON.stringify(sids.off)})`
    )
    const item = listed.find((t) => t.name === 'mcp:plan')
    expect(item).toMatchObject({ isBuiltin: true })
    // 没有哪个基座档案声明它：要用户自己勾
    expect(item?.declaredBy).toBeUndefined()
    expect(((await storedTools(sids.off)) as string[] | undefined) ?? []).not.toContain('mcp:plan')

    await openSession('off')
    await picker.open()
    const items = await until(async () => {
      const all = await picker.items()
      return all.some((i) => i.name === 'mcp:plan') ? all : null
    }, 'tool picker lists mcp:plan')
    expect(items.find((i) => i.name === 'mcp:plan')).toMatchObject({
      checked: false,
      declared: false,
      experimental: 'taskList'
    })
    expect(items.find((i) => i.name === 'mcp:browser')?.experimental).toBeNull()
    await picker.close()

    provider.script({ text: 'Hello there.', usage: { prompt: 80, completion: 5 } })
    await chat.typeAndSend('hello')
    await events.waitFor('agent_end', { sessionId: sids.off })
    await chat.waitIdle()

    expect(provider.chatRequestCount()).toBe(1)
    const tools = requestToolNames(provider.requests()[0]!)
    expect(tools.length).toBeGreaterThan(0)
    expect(tools).not.toContain(PLAN)
    expect(await list.present()).toBe(false)
  }, 120_000)
})

describe('勾上之后', () => {
  it('TLE-3 列表随第一次真调用发出、推进一步、终答收尾：输入框上方的列表，卡片里没有它的行，结果行出自真读者', async () => {
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

    // 第一轮的请求里有列表工具（勾上的会话，agent 建出来时就带着）
    expect(requestToolNames(provider.requests()[0]!)).toContain(PLAN)

    // TLE-3a 第二轮挂着：第一轮的列表在跑
    await until(async () => (await list.phase()) === 'running', 'task list running')
    expect(await list.count()).toBe('0/3')
    expect(await list.summary()).toBe(STEPS[0])
    expect(await list.expanded()).toBe(true)
    expect((await list.steps()).map((s) => [s.n, s.status, s.text])).toEqual([
      [1, 'in_progress', STEPS[0]],
      [2, 'pending', STEPS[1]],
      [3, 'pending', STEPS[2]]
    ])

    // TLE-3b 同一时刻：卡片里没有列表调用那一行 —— 第一轮成功的那次、第二轮正在生成的那次都没有
    const heldRows = await until(async () => {
      const rows = await chat.toolRows()
      return rows.some((r) => r.name === 'ls') ? rows : null
    }, 'first-turn card on screen')
    expect(heldRows.filter((r) => r.name === PLAN)).toEqual([])

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

    // TLE-3d 跑完：以终答收尾 → 完成、全部算完成、默认折叠
    await until(async () => (await list.phase()) === 'done', 'task list done')
    expect(await list.count()).toBe('3/3')
    expect(await list.expanded()).toBe(false)
    expect(await list.steps()).toEqual([])
    await list.toggle()
    expect(await list.expanded()).toBe(true)
    expect((await list.steps()).map((s) => [s.n, s.status, s.text])).toEqual([
      [1, 'completed', STEPS[0]],
      [2, 'completed', STEPS[1]],
      [3, 'completed', STEPS[2]]
    ])

    // TLE-3e 卡片里只有 ls 一行：列表调用既不出行，也不把相邻的步骤凑成合并行
    expect(await chat.toolRows()).toEqual([{ name: 'ls', status: 'done' }])
    expect(await chat.stepGroupShots()).toEqual([])
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

    const planRows = await until(async () => {
      const rows = (await chat.toolRows()).filter((r) => r.name === PLAN)
      return rows.length > 0 ? rows : null
    }, 'failed plan row rendered')
    expect(planRows).toEqual([{ name: PLAN, status: 'error' }])
    expect(await list.present()).toBe(false)
  }, 120_000)

  it('TLE-5 终答流到一半被中止：最后一张卡带 stopped，列表是「已停止」、计数照实、进行中那一步是暂停', async () => {
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
    expect(await list.count()).toBe('0/2')
    expect(await list.expanded()).toBe(false)
    await list.toggle()
    const steps = await list.steps()
    expect(steps.map((s) => [s.n, s.status, s.text])).toEqual([
      [1, 'in_progress', STEPS[0]],
      [2, 'pending', STEPS[1]]
    ])
    expect(steps[0]!.icon).toBe('lucide-circle-pause')
  }, 120_000)
})
