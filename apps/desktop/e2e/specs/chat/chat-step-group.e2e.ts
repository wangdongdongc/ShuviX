/**
 * 步骤合并行（StepGroup）与后台完成通知行（SystemNoticeRow）—— 对话区「过程」的收纳形态。
 *
 * 合并行是原先「相邻同名工具调用合并」的推广：相邻的思考 + 已完成的工具调用（不限同名）
 * 并成一行 + 计数，单层，没有再往上套的折叠头。chat-tools 钉的是同名两次与出错切段；
 * 这里钉推广出来的部分与它们的边界：
 *   - 思考 + 工具（异类）并成一行；被 steer 截断、没有终答的卡也同样合并，重开一致；
 *   - 中间文本切段：文本前的单个思考仍是自己那一行，文本后的连续调用另成一组；
 *   - 等审批（未落定）的调用不进组、把段切开，放行落定后才与前一步并成一行；
 *   - 后台任务跑完 → 自动续跑那一轮的「用户消息」经真实生产链路画成通知行，实时与重开一致。
 *
 * 前置：会话都绑同一个项目，`read` 落在 projDir 内不询问；`write` 撞内置 ask-on-write，
 * 正是 E-2 要的中间态 —— 所以本文件的自动放行**只对 bash 那条后台命令**生效（`only`）。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sleep, until } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import { startFakeProvider, type FakeProvider } from '../../harness/fakeProvider'
import {
  createProject,
  eventRecorder,
  installAutoAllow,
  seedFakeProvider,
  waitRendererReady,
  type EventRecorder,
  type RecordedEvent
} from '../../harness/seed'
import { chatPane, sidebarPane, type ChatPane, type SidebarPane } from '../../harness/pages'

const MODEL = 'e2e-model'
/** E-3 的后台命令：sleep 要长过 bgTaskService 的预热窗口（2s），窗口内退出的按前台形态回话 */
const BG_COMMAND = 'sleep 3; echo done'

interface ListedMessage {
  id: string
  role: string
  type: string
  content: string
  blocks?: Array<{ type: string }>
  metadata?: { isSystemNotice?: boolean } | null
}

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

const readCall = (id: string, file: string): { id: string; name: string; args: string } => ({
  id,
  name: 'read',
  args: JSON.stringify({ path: join(projDir, file) })
})

/** 切走再切回，让对话区按投影重建（重开路径） */
const reopen = async (title: string): Promise<void> => {
  expect(await sidebar.openSession('F-scratch')).toBe(true)
  expect(await sidebar.openSession(title)).toBe(true)
}

beforeAll(async () => {
  app = await launchApp()
  provider = await startFakeProvider()
  await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  await waitRendererReady(app.main)

  projDir = join(app.home, 'proj-fold')
  mkdirSync(projDir, { recursive: true })
  writeFileSync(join(projDir, 'alpha.txt'), 'ALPHA CONTENT\n')
  const project = await createProject(app.main, { name: 'FoldProj', path: projDir })

  sids.steer = await createSession('F-steer', project.id)
  sids.split = await createSession('F-split', project.id)
  sids.ask = await createSession('F-ask', project.id)
  sids.bg = await createSession('F-bg', project.id)
  sids.scratch = await createSession('F-scratch', project.id)

  chat = chatPane(app.main)
  sidebar = sidebarPane(app.main)
  await sidebar.clickNewChat()
  await until(async () => (await sidebar.titles()).includes('F-steer'), 'sidebar list refreshed')

  events = eventRecorder(app.main)
  await events.install()
  // 只放行 E-3 的后台命令：E-2 要的正是 write 停在 ask-on-write 上的中间态
  await installAutoAllow(app.main, { only: (command) => command.includes('sleep 3; echo done') })
})

afterAll(async () => {
  await provider.close()
  await app.stop()
})

describe('思考与工具并成一行', () => {
  it('E-1 steer 截断的那张卡：思考 + read 合并为一行（计数 2），展开后两行都在，重开一致', async () => {
    provider.reset()
    await events.clear()
    provider.script(
      {
        thinking: 'thinking hard',
        toolCalls: [readCall('call_fold_steer', 'alpha.txt')],
        holdMs: 10_000,
        usage: { prompt: 90, completion: 6 }
      },
      { text: 'steered answer', usage: { prompt: 120, completion: 4 } }
    )

    expect(await sidebar.openSession('F-steer')).toBe(true)
    await chat.ready()
    await chat.typeAndSend('original ask')
    await events.waitFor('agent_start', { sessionId: sids.steer })
    await until(() => chat.isBusy(), 'streaming started')

    // 运行中回车 = steer（同 chat-interrupt）：这张卡到此没有终答
    await chat.type('STEER please pivot')
    await chat.pressEnter()
    await sleep(300)
    provider.release()

    await events.waitFor('agent_end', { sessionId: sids.steer })
    await chat.waitIdle()

    // 契约核对：被截断的那轮是一条真实 entry，思考 + 工具同处一卡
    const listed = await listMessages(sids.steer)
    expect(listed.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(listed[1].blocks?.map((b) => b.type)).toEqual(['thinking', 'tool'])

    // 思考 + read 两个落定步骤 → 一行合并行（异类：标签位是步骤序列）；终答那张卡没有过程
    const live = await chat.stepGroups()
    expect(live).toMatchObject([{ state: 'collapsed', size: 2 }])
    // 折叠态里思考行与工具行都收着
    expect(await chat.thinkingBlocks()).toBe(0)
    expect(await chat.toolRows()).toHaveLength(0)
    expect(await chat.groupBadges()).toEqual(['2'])
    await chat.expandGroups()
    expect(await chat.thinkingBlocks()).toBe(1)
    expect(await chat.toolRows()).toEqual([{ name: 'read', status: 'done' }])

    // 重开：分组是纯投影的函数，与实时一致
    await reopen('F-steer')
    await until(async () => (await chat.stepGroups()).length === 1, 'step group reprojected')
    expect((await chat.stepGroups())[0]).toMatchObject({ state: 'collapsed', size: 2 })
  })

  it('E-4 中间文本切段：文本前的单个思考自成一行，文本后的连续 read 另成一组', async () => {
    provider.reset()
    await events.clear()
    provider.script(
      {
        thinking: 'plan first',
        text: 'I will check the file twice.',
        toolCalls: [readCall('call_split_a', 'alpha.txt')],
        usage: { prompt: 90, completion: 6 }
      },
      {
        toolCalls: [readCall('call_split_b', 'alpha.txt'), readCall('call_split_c', 'alpha.txt')],
        usage: { prompt: 100, completion: 6 }
      },
      { text: 'checked', usage: { prompt: 130, completion: 4 } }
    )

    expect(await sidebar.openSession('F-split')).toBe(true)
    await chat.ready()
    await chat.typeAndSend('check twice')
    await events.waitFor('agent_end', { sessionId: sids.split })
    await chat.waitIdle()

    // 过程块：思考 · 文本 · read · read · read（跨两条 entry）→ 思考单行 / 文本 / read ×3 一组
    const groups = await chat.stepGroups()
    expect(groups).toMatchObject([{ state: 'collapsed', size: 3 }])
    // 文本切开了段：思考没被并进组里，仍是自己那一行
    expect(await chat.thinkingBlocks()).toBe(1)
    expect(await chat.groupBadges()).toEqual(['3'])
    expect(await chat.toolRows()).toHaveLength(0)
    await chat.expandGroups()
    expect((await chat.toolRows()).map((r) => r.status)).toEqual(['done', 'done', 'done'])

    await reopen('F-split')
    await until(async () => (await chat.stepGroups()).length === 1, 'step group reprojected')
    expect((await chat.stepGroups())[0]).toMatchObject({ state: 'collapsed', size: 3 })
    expect(await chat.thinkingBlocks()).toBe(1)
  })
})

describe('未落定的调用不进组', () => {
  it('E-2 等审批的 write 把段切开：放行前两行独立可见，落定后才与 read 并成一行', async () => {
    provider.reset()
    await events.clear()
    const target = join(projDir, 'x.txt')
    provider.script(
      {
        toolCalls: [
          readCall('call_fold_read', 'alpha.txt'),
          {
            id: 'call_fold_write',
            name: 'write',
            args: JSON.stringify({ path: target, content: 'X1' })
          }
        ],
        usage: { prompt: 95, completion: 8 }
      },
      { text: 'read and written', usage: { prompt: 130, completion: 5 } }
    )

    expect(await sidebar.openSession('F-ask')).toBe(true)
    await chat.ready()
    await chat.typeAndSend('read alpha then write x')

    const request = await events.waitFor<RecordedEvent & { request: { id: string } }>(
      'input_request',
      { sessionId: sids.ask }
    )

    // 等审批的 write 未落定 → 不进组、把段切开：read 与 write 都是独立可见的行，没有合并行。
    // read 的 tool_end 与 input_request 谁先到不赌，等它收敛
    const rows = await until(async () => {
      const r = await chat.toolRows()
      return r.length === 2 && r[0].status === 'done' ? r : null
    }, 'read settled, write awaiting approval')
    expect(rows).toEqual([
      { name: 'read', status: 'done' },
      { name: 'write', status: 'running' }
    ])
    expect(await chat.stepGroups()).toEqual([])

    // 放行 → write 落定 → 两个异名的落定步骤并成一行（推广点：同名不再是条件）
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
    expect(readFileSync(target, 'utf8')).toContain('X1')

    expect(await chat.stepGroups()).toMatchObject([{ state: 'collapsed', size: 2 }])
    expect(await chat.toolRows()).toHaveLength(0)
    expect(await chat.groupBadges()).toEqual(['2'])
    await chat.expandGroups()
    expect(await chat.toolRows()).toEqual([
      { name: 'read', status: 'done' },
      { name: 'write', status: 'done' }
    ])

    await reopen('F-ask')
    await until(async () => (await chat.stepGroups()).length === 1, 'step group reprojected')
    expect((await chat.stepGroups())[0]).toMatchObject({ state: 'collapsed', size: 2 })
  })
})

describe('后台完成通知', () => {
  it('E-3 后台任务跑完 → 自动续跑那一轮的输入画成通知行，实时与重开一致', async () => {
    provider.reset()
    await events.clear()
    provider.script(
      {
        toolCalls: [
          {
            id: 'call_fold_bg',
            name: 'bash',
            args: JSON.stringify({
              command: BG_COMMAND,
              description: 'e2e background probe',
              run_in_background: true
            })
          }
        ],
        usage: { prompt: 90, completion: 6 }
      },
      { text: 'started', usage: { prompt: 110, completion: 4 } },
      // 自动续跑那一轮：请求里的末条 user 消息就是主进程写的 <background-task …> 通知
      {
        when: (r) => r.lastUserText.includes('<background-task'),
        text: 'collected',
        usage: { prompt: 140, completion: 4 }
      }
    )

    expect(await sidebar.openSession('F-bg')).toBe(true)
    await chat.ready()
    await chat.typeAndSend('run something in the background')
    await events.waitFor('agent_end', { sessionId: sids.bg })
    await chat.waitIdle()
    expect((await chat.settledItems()).at(-1)?.text).toBe('started')
    expect(await chat.systemNotices()).toEqual([])

    // 进程退出（≈3s）→ bgTaskService 通知 → AgentSession.notify 空闲即 resume →
    // user_message 广播带 isSystemNotice → 通知行上屏（实时路径，不等重开）
    const notice = await until(async () => {
      const rows = await chat.systemNotices()
      return rows.length === 1 ? rows[0] : null
    }, 'background notice row')
    expect(notice.kind).toBe('background')
    expect(notice.state).toBe('collapsed')
    expect(notice.text).toContain(BG_COMMAND)
    expect(notice.text).toContain('exited with code 0')

    // 续跑那一轮跑完（游标语义：等的是下一条 agent_end）
    await events.waitFor('agent_end', { sessionId: sids.bg })
    await chat.waitIdle()

    // 展开：正文是写给模型看的原文（带标签）
    expect(await chat.toggleSystemNotice(0)).toContain('<background-task pid=')

    const listed = await listMessages(sids.bg)
    expect(listed.filter((m) => m.metadata?.isSystemNotice)).toHaveLength(1)
    // 通知确实到了模型手里：认领它的那个 turn 被消费
    expect(listed.at(-1)?.content).toBe('collected')

    // 重开：投影按侧车还原，仍是一条通知行
    await reopen('F-bg')
    await until(async () => (await chat.systemNotices()).length === 1, 'notice row reprojected')
    expect((await chat.systemNotices())[0]).toMatchObject({
      kind: 'background',
      state: 'collapsed'
    })
    expect(listed.filter((m) => m.role === 'user')).toHaveLength(2)
  })
})
