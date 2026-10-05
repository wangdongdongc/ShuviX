/**
 * P2-12（docs/pi-durable/p2-12-test-design.md）—— 桌面跨功能整合之二：host 派发的 agent（titler / 审查员）
 * 与派生 agent，跑在**真 SessionHost + 真 SQLite + 真桌面 ToolHost**（`createDesktopToolHost`）上，hookService
 * 用真的（内置 auto-title / auto-review 两份 md），permissionReview 经 `setPermissionReviewer` 接上，内置 MCP
 * 的调用方解析器经 `setBuiltinMcpAgentResolver` 接上（与 main/index.ts 同一条启动接线）。夹具：
 * `support/desktopRig.ts`（每个「进程」一张新的模块图；faux 按 `ROLE:<档案>` 路由）。
 *
 *   K4  titler / 审查员留在所属会话的存储里，从不被续跑
 *       K4-01 titler 落在哪   K4-02 titler 崩溃时被扣住   K4-03 审查员崩溃时被扣住（继续 / abort-then-send）
 *       K4-04 子会话里的审查员（Q16）   K4-05 重新挂上不触发 hook（P2-10 PIN-03）
 *   K5  派生 agent 经真桌面 ToolHost（P2-04）与派发工具（P2-05）；身份（P2-06 / P2-07）
 *       K5-01 派发主线   K5-02 每次调用的身份（安全主体 + 内置 MCP 解析器）   K5-03 策略看见派生身份、审查员归
 *       子 agent 的那次调用   K5-04 子 agent 中途崩溃 → 桌面重建   K5-05 子 agent 跑着时 Esc
 *       K5-06 派生的 coding agent 开子会话：挂在根会话下（PIN-10 裁决）
 *   P2-08 交过来的桌面整合用例（p2-08-test-design.md）
 *       -16 标题经 session 工具落下   -17 第二轮 refine   -19 titler 跑着时删会话
 *       -34 真记录上的防递归   -35 hook 对话不进审查员的输入、也不进 titler 的事实
 *
 * 不断言 agent_start / agent_end / message_* 事件（phase 3）。
 */
import {
  DEFAULT_TITLE,
  askOpCalls,
  bootProcess,
  broadcastsOf,
  conversationTranscript,
  conversationsOf,
  crash,
  insert,
  liveTasksOf,
  logLines,
  noticesIn,
  probeCalls,
  proc,
  rig,
  role,
  sessionOf,
  settingsOf,
  setUserPolicy,
  setupRig,
  sleep,
  storageIds,
  submissionOf,
  tasksOf,
  teardownRig,
  transcriptOf,
  unhandled,
  type ConversationView
} from './support/desktopRig'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { answer, callTool, held, stalled, waitFor, withTimeout } from './support/realHost'

const T = 30000

beforeEach(async () => {
  await setupRig()
  await bootProcess()
})

afterEach(async () => {
  await teardownRig()
})

// ─── 小工具 ──────────────────────────────────────────────────────────────

const ANCHOR = 'shuvix.spawn.anchor'

function verdict(decision: 'allow' | 'deny' | 'ask' = 'allow'): Record<string, string> {
  return { decision, risk: 'low', summary: `${decision} it`, reason: `because ${decision}` }
}

/** 审查员交卷：一次 `next` */
const next = (decision: 'allow' | 'deny' | 'ask' = 'allow'): ReturnType<typeof callTool> =>
  callTool('next', { ...verdict(decision) }, 'call-next')

const dispatch = (name: string, prompt: string, id = 'call-agent'): ReturnType<typeof callTool> =>
  callTool('agent', { name, prompt, description: 'look' }, id)

/** 某个 hook 的对话（按记录里的 hook 名） */
async function hookConversations(sessionId: string, hook: string): Promise<ConversationView[]> {
  return (await conversationsOf(sessionId)).filter((c) => c.record?.hook === hook)
}

/** 派发出来的对话（dispatch 'tool'） */
async function spawnedConversations(sessionId: string): Promise<ConversationView[]> {
  return (await conversationsOf(sessionId)).filter((c) => c.record?.dispatch === 'tool')
}

/** 某个会话的根（当前）对话 id */
async function rootConversation(sessionId: string): Promise<number> {
  const session = await sessionOf(sessionId)
  return (await session!.currentConversation()).id
}

/** 某个对话里 kind 为 pi.tool、callId 为 `callId` 的任务 id */
async function toolTask(
  sessionId: string,
  callId: string,
  conversationId?: number
): Promise<number> {
  const tasks = (await tasksOf(sessionId)).filter(
    (task) =>
      task.kind === 'pi.tool' &&
      (task.input as { callId?: string }).callId === callId &&
      (conversationId === undefined || task.conversationId === conversationId)
  )
  if (tasks.length !== 1)
    throw new Error(`expected one pi.tool task for ${callId}, got ${tasks.length}`)
  return tasks[0]!.id as number
}

/** 一个任务的终结结果 */
async function outcomeOf(sessionId: string, taskId: number): Promise<string | undefined> {
  const task = (await tasksOf(sessionId)).find((t) => t.id === taskId)
  return task?.state.status === 'terminal' ? task.state.outcome.status : undefined
}

const titleOf = (id: string): string | undefined => proc().sessionRecords.findById(id)?.title

/** 「中断，可能已部分执行」 */
const PARTIAL = /interrupted.*may have partially run/is

// ─── K4 titler / 审查员 ─────────────────────────────────────────────────

/** 默认标题的 s1 + 真 auto-title：根答 a，titler 改标题再交卷（K4-01 与 -16 共用） */
async function titledTurn(): Promise<void> {
  const p = proc()
  insert('s1', { title: DEFAULT_TITLE })
  // 先打开：打开那一刻报一次 idle（打开时的对账），之后的报告才是这一轮的
  await p.sessionService.ensureAgentSession('s1')
  expect(p.states.get('s1')).toEqual(['idle'])
  p.router.on('root', role('chat'), answer('a'))
  p.router.on(
    'titler',
    role('titler'),
    callTool('session', { action: 'set-title', title: 'Hooked title' }, 'call-title'),
    answer('Hooked title')
  )
  expect(await withTimeout(p.chatGateway.prompt('s1', 'hello'), 15000, 'prompt')).toEqual({})
  await waitFor(() => titleOf('s1') === 'Hooked title', 10000, 'title applied')
  await waitFor(async () => (await liveTasksOf('s1')).length === 0, 10000, 'titler finished')
}

describe('K4 titler and reviewer stay in the owning session and are never resumed', () => {
  it(
    'K4-01 titler 落在 s1 的存储里：只有 s1.sqlite；两个对话（根 + 锚任务拥有的 T，记录 hook/auto-title/titler）；锚 completed；标题 auto；s1 的运行状态只有根的 busy → idle',
    async () => {
      await titledTurn()
      const p = proc()
      expect(storageIds()).toEqual(['s1'])
      const root = await rootConversation('s1')
      const conversations = await conversationsOf('s1')
      expect(conversations).toHaveLength(2)
      const t = conversations.find((c) => c.id !== root)!
      expect(t.record).toMatchObject({
        dispatch: 'hook',
        hook: 'auto-title',
        profileName: 'titler'
      })
      expect(t.owner?.conversationId).toBe(root)
      const anchor = (await tasksOf('s1')).find((task) => task.id === t.owner?.taskId)!
      expect(anchor.kind).toBe(ANCHOR)
      expect(await outcomeOf('s1', anchor.id as number)).toBe('completed')
      // titler 的 agentId 没有自己的存储
      expect(storageIds()).not.toContain(t.record!.agentId)
      expect(proc().sessionRecords.findById('s1')).toMatchObject({ title: 'Hooked title' })
      expect(settingsOf('s1').titleOrigin).toBe('auto')
      // 打开时的对账之后，只有根的 busy → idle（titler 与锚任务不算）
      expect(p.states.get('s1')).toEqual(['idle', 'busy', 'idle'])
    },
    T
  )

  it(
    'K4-02 titler 卡住时崩溃：进程 2 打开 → 镜像 idle、不算被中断、300ms 内没有请求；再发一条只有根的一次请求，旧 titler 与锚任务终结；这一条的 fire 另起一个 titler 对话，两个里恰一个跑过',
    async () => {
      const p1 = proc()
      insert('s1', { title: DEFAULT_TITLE })
      const stall = stalled()
      p1.router.on('root', role('chat'), answer('a'))
      p1.router.on('titler', role('titler'), stall.step)
      expect(await withTimeout(p1.chatGateway.prompt('s1', 'hello'), 15000, 'prompt')).toEqual({})
      await withTimeout(stall.reached, 10000, 'titler request')

      const p2 = await crash()
      const session = await p2.sessionService.ensureAgentSession('s1')
      expect(settingsOf('s1').runState).toBe('idle')
      expect(session!.isInterrupted).toBe(false)
      expect(p2.sessionService.getAgentSession('s1')!.isStreaming).toBe(false)
      await sleep(300)
      expect(p2.kit.callCount).toBe(0)

      p2.router.on('root', role('chat'), answer('b'))
      p2.router.on('titler', role('titler'), answer('T2'))
      expect(await withTimeout(p2.chatGateway.prompt('s1', 'hi'), 15000, 'prompt hi')).toEqual({})
      await waitFor(async () => (await liveTasksOf('s1')).length === 0, 10000, 'no live tasks')
      expect(p2.router.served.filter((r) => r === 'root')).toHaveLength(1)
      const titlers = await hookConversations('s1', 'auto-title')
      expect(titlers).toHaveLength(2)
      const ran: number[] = []
      for (const c of titlers) {
        const entries = await conversationTranscript('s1', c.id)
        if (entries.some((e) => e.startsWith('pi.assistant:'))) ran.push(c.id)
      }
      expect(ran).toHaveLength(1)
      // 旧的那一个（进程 1 的）终结了，它的锚任务也是
      const old = titlers[0]!
      expect(await outcomeOf('s1', old.owner!.taskId)).toBeDefined()
      expect(
        (await tasksOf('s1'))
          .filter((t) => t.conversationId === old.id)
          .every((t) => t.state.status === 'terminal')
      ).toBe(true)
    },
    T
  )

  describe('K4-03 审查员卡住时崩溃', () => {
    async function crashInReview(): Promise<{ askTask: number }> {
      const p1 = proc()
      setUserPolicy('ask-askop', "tool.name == 'askOp'")
      insert('s1')
      const stall = stalled()
      p1.router.on('root', role('chat'), callTool('askOp', {}, 'call-ask'))
      p1.router.on('reviewer', role('permission-reviewer'), stall.step)
      void p1.track(p1.chatGateway.prompt('s1', 'do it'))
      await withTimeout(stall.reached, 10000, 'reviewer request')
      const askTask = await toolTask('s1', 'call-ask')
      await crash()
      return { askTask }
    }

    it(
      'K4-03 进程 2：镜像 interrupted、审查员的任务带中止标记；(a) continue → askOp 结果「中断，可能已部分执行」，审查员没有请求，askOp 任务拥有的对话恰是 [R]',
      async () => {
        const { askTask } = await crashInReview()
        const p2 = proc()
        expect(settingsOf('s1').runState).toBe('busy')
        const facade = await p2.sessionService.ensureAgentSession('s1')
        expect(settingsOf('s1').runState).toBe('interrupted')
        const [r] = await hookConversations('s1', 'auto-review')
        expect(r).toBeDefined()
        expect(r!.owner?.taskId).toBe(askTask)
        const reviewerTasks = (await tasksOf('s1')).filter((t) => t.conversationId === r!.id)
        expect(reviewerTasks.length).toBeGreaterThan(0)
        expect(
          reviewerTasks.filter((t) => t.state.status !== 'terminal').every((t) => t.abortRequested)
        ).toBe(true)

        p2.router.on('root', role('chat'), answer('r'))
        expect(await withTimeout(facade!.continue(), 15000, 'continue')).toEqual({})
        const entries = await transcriptOf('s1')
        const askResult = entries.find((e) => e.startsWith('pi.tool-result:'))!
        expect(askResult).toMatch(PARTIAL)
        expect(p2.router.served).toEqual(['root'])
        expect(
          (await conversationsOf('s1')).filter((c) => c.owner?.taskId === askTask).map((c) => c.id)
        ).toEqual([r!.id])
        expect(askOpCalls).toHaveLength(0)
      },
      T
    )

    it(
      "K4-03 (b) abort-then-send：chatGateway.prompt('s1','new') → 根的工具任务被中止，审查员没有请求，new 照常答",
      async () => {
        const { askTask } = await crashInReview()
        const p2 = proc()
        p2.router.on('root', role('chat'), answer('n'))
        expect(await withTimeout(p2.chatGateway.prompt('s1', 'new'), 15000, 'prompt new')).toEqual(
          {}
        )
        expect(await outcomeOf('s1', askTask)).toMatch(/aborted|failed/)
        expect(p2.router.served).toEqual(['root'])
        const entries = await transcriptOf('s1')
        expect(entries.slice(-2)).toEqual(['pi.user:new', 'pi.assistant:n'])
      },
      T
    )
  })

  it(
    'K4-04 子会话里的审查员（Q16）：R 在 C 的存储里、归 C 的 askOp 工具任务；P 的存储里没有 hook 对话；C 的工具照常执行；tool_review 广播带 C 与 C 的 taskId',
    async () => {
      const p = proc()
      setUserPolicy('ask-askop', "tool.name == 'askOp'")
      insert('P')
      insert('C', { parentId: 'P' })
      p.router.on('P', role('chat', 'hi'), answer('hello'))
      expect(await withTimeout(p.chatGateway.prompt('P', 'hi'), 15000, 'P prompt')).toEqual({})
      p.router.on('C', role('chat', 'do it'), callTool('askOp', {}, 'call-ask'), answer('ok'))
      p.router.on('reviewer', role('permission-reviewer'), next('allow'))
      expect(await withTimeout(p.chatGateway.prompt('C', 'do it'), 15000, 'C prompt')).toEqual({})

      const askTask = await toolTask('C', 'call-ask')
      const reviewers = await hookConversations('C', 'auto-review')
      expect(reviewers).toHaveLength(1)
      expect(reviewers[0]!.owner?.taskId).toBe(askTask)
      expect((await conversationsOf('P')).filter((c) => c.record !== undefined)).toEqual([])
      expect(askOpCalls).toEqual([expect.objectContaining({ sessionId: 'C', taskId: askTask })])
      expect((await transcriptOf('C')).find((e) => e.startsWith('pi.tool-result:'))).toBe(
        'pi.tool-result:askOp done'
      )
      const reviews = broadcastsOf('tool_review')
      expect(reviews.map((e) => [e.sessionId, e.taskId, e.reviewing])).toEqual([
        ['C', askTask, true],
        ['C', askTask, false]
      ])
      expect(rig.asks).toEqual([])
    },
    T
  )

  it(
    'K4-05 重新挂上不触发 hook（P2-10 PIN-03）：进程 1 后 C 恰一个 titler 对话；崩溃、P.continue() 之后仍是一个，进程 2 没有 titler 请求，也没有 refine',
    async () => {
      const p1 = proc()
      insert('P')
      insert('C', { parentId: 'P', title: DEFAULT_TITLE })
      const stall = stalled()
      p1.router.on(
        'P',
        role('chat', 'start'),
        callTool(
          'session',
          { action: 'prompt-sub-session', sub_session_id: 'C', message: 'C-task' },
          'call-prompt'
        )
      )
      p1.router.on('C', role('chat', 'C-task'), stall.step)
      p1.router.on('titler', role('titler'), answer('T'))
      void p1.track(p1.chatGateway.prompt('P', 'start'))
      await withTimeout(stall.reached, 10000, 'C request')
      await waitFor(
        async () => (await hookConversations('C', 'auto-title')).length === 1,
        10000,
        'titler ran'
      )
      await waitFor(() => p1.router.left('titler') === 0, 10000, 'titler answered')
      await waitFor(() => settingsOf('C').runState === 'busy', 5000, 'C busy')

      const p2 = await crash()
      p2.router.on('C', role('chat', 'C-task'), answer('C-done'))
      p2.router.on('P', role('chat', 'start'), answer('P-final'))
      const parent = await p2.sessionService.ensureAgentSession('P')
      expect(await withTimeout(parent!.continue(), 15000, 'P.continue')).toEqual({})
      await sleep(300)
      expect(p2.router.served).toEqual(['C', 'P'])
      expect(p2.router.unmatched).toEqual([])
      expect(await hookConversations('C', 'auto-title')).toHaveLength(1)
    },
    T
  )
})

// ─── K5 派生 agent ───────────────────────────────────────────────────────

describe('K5 spawned agents through the real desktop ToolHost', () => {
  it(
    'K5-01 派发主线：{}；explore 的请求恰 [probe]；结果 found；register / end 各一条；taskRegistry 条目 done；probe 的会话是 s1；没有按 agentId 的落盘目录；只有 s1.sqlite',
    async () => {
      const p = proc()
      insert('s1')
      p.router.on('explore', role('explore'), callTool('probe', {}, 'call-probe'), answer('found'))
      p.router.on('root', role('chat'), dispatch('explore', 'find'), answer('done'))
      expect(await withTimeout(p.chatGateway.prompt('s1', 'go'), 15000, 'prompt')).toEqual({})

      const exploreRequests = p.router.requests('explore')
      expect(exploreRequests).toHaveLength(2)
      for (const request of exploreRequests)
        expect(request.tools.map((t) => t.name)).toEqual(['probe'])
      expect(await transcriptOf('s1')).toEqual([
        'pi.user:go',
        'pi.assistant:[tool:agent]',
        'pi.tool-result:found',
        'pi.assistant:done'
      ])
      const registers = broadcastsOf('sub_session_register')
      expect(registers).toHaveLength(1)
      expect(registers[0]).toMatchObject({
        parentSessionId: 's1',
        subAgentName: 'explore',
        depth: 1,
        rootSessionId: 's1'
      })
      const agentId = registers[0]!.sessionId as string
      expect(agentId).toMatch(/^sub-/)
      const ends = broadcastsOf('sub_session_end')
      expect(ends).toEqual([
        expect.objectContaining({ sessionId: agentId, result: 'found', isError: false })
      ])
      expect(p.taskRegistry.get(agentId)?.status).toBe('done')
      expect(p.taskRegistry.runningCount('s1')).toBe(0)
      expect(probeCalls.map((c) => c.sessionId)).toEqual(['s1'])
      expect(existsSync(join(rig.toolResults, agentId))).toBe(false)
      expect(storageIds()).toEqual(['s1'])
    },
    T
  )

  it(
    'K5-02 每次调用的身份：根 {root, chat}、解析器 root 无 callerId；子 agent {spawned, explore}、解析器 callerId = agentId；关掉 s1 之后解析器交回 undefined，且从不 open',
    async () => {
      const p = proc()
      insert('s1')
      p.router.on('explore', role('explore'), callTool('probe', {}, 'call-probe'), answer('found'))
      p.router.on(
        'root',
        role('chat'),
        callTool('probe', {}, 'call-root-probe'),
        dispatch('explore', 'find'),
        answer('done')
      )
      expect(await withTimeout(p.chatGateway.prompt('s1', 'go'), 15000, 'prompt')).toEqual({})
      const agentId = broadcastsOf('sub_session_register')[0]!.sessionId as string
      expect(probeCalls).toHaveLength(2)
      const [root, child] = probeCalls
      expect(root!.subject).toMatchObject({ kind: 'root', profileName: 'chat' })
      expect(root!.subject).not.toHaveProperty('callerId')
      expect(root!.resolved).toMatchObject({ kind: 'root' })
      expect(root!.resolved).not.toHaveProperty('callerId')
      expect(child!.subject).toMatchObject({ kind: 'spawned', profileName: 'explore' })
      expect(child!.resolved).toMatchObject({ kind: 'spawned', callerId: agentId })
      expect(agentId).toMatch(/^sub-/)

      const open = vi.spyOn(p.host, 'open')
      await p.host.close('s1')
      expect(rig.builtinResolver!('s1', child!.conversationId)).toBeUndefined()
      expect(rig.builtinResolver!('s1', root!.conversationId)).toBeUndefined()
      expect(open).not.toHaveBeenCalled()
    },
    T
  )

  it(
    'K5-03 策略看见派生身份：根的 probe 不问；子 agent 的 probe 恰一次判定（agent = explore / spawned）；R 在 s1 里、归子 agent 的 probe 任务（父对话 = 子对话、depth 1）；probe 照常执行、从不问人',
    async () => {
      const p = proc()
      setUserPolicy('ask-spawned-probe', "tool.name == 'probe' && subject.agentKind == 'spawned'")
      insert('s1')
      const decide = vi.spyOn(p.hookService, 'decide')
      p.router.on('explore', role('explore'), callTool('probe', {}, 'call-probe'), answer('found'))
      p.router.on('reviewer', role('permission-reviewer'), next('allow'))
      p.router.on(
        'root',
        role('chat'),
        callTool('probe', {}, 'call-root-probe'),
        dispatch('explore', 'find'),
        answer('done')
      )
      expect(await withTimeout(p.chatGateway.prompt('s1', 'go'), 15000, 'prompt')).toEqual({})
      expect(probeCalls).toHaveLength(2)
      expect(decide).toHaveBeenCalledTimes(1)
      expect(decide.mock.calls[0]![1]).toMatchObject({
        agent: { profile: 'explore', kind: 'spawned' }
      })
      expect(rig.asks).toEqual([])

      const [explore] = await spawnedConversations('s1')
      const childProbeTask = probeCalls[1]!.taskId
      const [r] = await hookConversations('s1', 'auto-review')
      expect(r!.owner).toEqual({ conversationId: explore!.id, taskId: childProbeTask })
      expect(r!.record).toMatchObject({ parentConversationId: explore!.id, depth: 1 })
      expect(storageIds()).toEqual(['s1'])
    },
    T
  )

  it(
    'K5-04 子 agent 中途崩溃：进程 2 打开时真桌面 rebuildAgentTools 为派生记录调一次（sessionId s1），不连 MCP；continue → {}；explore 的工具仍 [probe]、只有一条 pi.user、提交 id 不变；结果 found；路由只注册一次、同一个 agentId',
    async () => {
      const p1 = proc()
      insert('s1')
      const stall = stalled()
      p1.router.on('explore', role('explore'), stall.step)
      p1.router.on('root', role('chat'), dispatch('explore', 'find'))
      void p1.track(p1.chatGateway.prompt('s1', 'go'))
      await withTimeout(stall.reached, 10000, 'explore request')
      const agentId = broadcastsOf('sub_session_register')[0]!.sessionId as string
      const [explore] = await spawnedConversations('s1')
      const dispatchTask = explore!.owner!.taskId
      const before = await submissionOf('s1', `agent:${dispatchTask}`, explore!.id)
      expect(before).toBeDefined()

      const p2 = await crash({ spyToolHost: true })
      rig.broadcasts.length = 0
      const facade = await p2.sessionService.ensureAgentSession('s1')
      const spawnedRebuilds = p2.toolHostCalls.rebuild.filter((c) => c.record.kind === 'spawned')
      expect(spawnedRebuilds).toHaveLength(1)
      expect(spawnedRebuilds[0]!.context).toMatchObject({ sessionId: 's1' })
      expect(spawnedRebuilds[0]!.record.agentId).toBe(agentId)
      expect(rig.ensureServerByName).toEqual([])

      p2.router.on('explore', role('explore'), answer('found'))
      p2.router.on('root', role('chat'), answer('done'))
      expect(await withTimeout(facade!.continue(), 15000, 'continue')).toEqual({})
      expect(p2.router.served).toEqual(['explore', 'root'])
      expect(p2.router.requests('explore')[0]!.tools.map((t) => t.name)).toEqual(['probe'])
      const exploreEntries = await conversationTranscript('s1', explore!.id)
      expect(exploreEntries.filter((e) => e.startsWith('pi.user:'))).toEqual(['pi.user:find'])
      expect((await submissionOf('s1', `agent:${dispatchTask}`, explore!.id))?.id).toBe(before!.id)
      expect((await transcriptOf('s1')).find((e) => e.startsWith('pi.tool-result:'))).toBe(
        'pi.tool-result:found'
      )
      expect(broadcastsOf('sub_session_register').map((e) => e.sessionId)).toEqual([agentId])
    },
    T
  )

  it(
    'K5-05 子 agent 跑着时 Esc：explore 终结 aborted、sub_session_end isError；taskRegistry 条目 killed、没有在跑的；镜像 idle；maxIdleOpen 1 时开第二条会话后 s1 能被 LRU 关掉',
    async () => {
      await teardownRig()
      await setupRig()
      const p = await bootProcess({ deps: { maxIdleOpen: 1 } })
      insert('s1')
      insert('s2')
      const hold = held(answer('never'))
      p.router.on('explore', role('explore'), hold.step)
      p.router.on('root', role('chat', 'go'), dispatch('explore', 'find'), answer('stopped?'))
      const pending = p.track(p.chatGateway.prompt('s1', 'go'))
      await withTimeout(hold.reached, 10000, 'explore request')
      const agentId = broadcastsOf('sub_session_register')[0]!.sessionId as string

      await withTimeout(p.chatGateway.abort('s1'), 10000, 'abort')
      await withTimeout(pending, 10000, 'prompt settles')
      await waitFor(() => broadcastsOf('sub_session_end').length === 1, 5000, 'end broadcast')
      expect(broadcastsOf('sub_session_end')[0]).toMatchObject({
        sessionId: agentId,
        isError: true
      })
      const [explore] = await spawnedConversations('s1')
      await waitFor(async () => (await liveTasksOf('s1')).length === 0, 5000, 'all terminal')
      const exploreTasks = (await tasksOf('s1')).filter((t) => t.conversationId === explore!.id)
      expect(
        exploreTasks.some(
          (t) => t.state.status === 'terminal' && t.state.outcome.status === 'aborted'
        )
      ).toBe(true)
      expect(p.taskRegistry.get(agentId)?.status).toBe('killed')
      expect(p.taskRegistry.runningCount('s1')).toBe(0)
      await waitFor(() => settingsOf('s1').runState === 'idle', 5000, 'idle mirror')

      p.router.on('s2', role('chat', 'other'), answer('o'))
      expect(await withTimeout(p.chatGateway.prompt('s2', 'other'), 15000, 's2 prompt')).toEqual({})
      await waitFor(() => p.host.get('s1') === undefined, 5000, 's1 LRU-closed')
    },
    T
  )

  it(
    'K5-06 派生的 coding agent 开子会话（PIN-10 裁决）：子会话挂在根 s1 下、list(s1) 列出它；requestId = subsession:s1:<coding 那次 session 调用的任务>；完成通知送到 s1',
    async () => {
      const p = proc()
      insert('s1')
      const hold = held(answer('sub-done'))
      p.router.on(
        'coding',
        role('coding'),
        callTool('session', { action: 'create-sub-session', title: 'worker' }, 'call-create'),
        callTool(
          'session',
          { action: 'prompt-sub-session', message: 'sub-task', run_in_background: true },
          'call-prompt'
        ),
        answer('dispatched')
      )
      p.router.on('sub', role('chat', 'sub-task'), hold.step)
      p.router.on('root', role('chat', 'go'), dispatch('coding', 'delegate'), answer('done'))
      expect(await withTimeout(p.chatGateway.prompt('s1', 'go'), 15000, 'prompt')).toEqual({})
      await withTimeout(hold.reached, 10000, 'sub-session request')

      const children = p.sessionRecords.findChildren('s1')
      expect(children).toHaveLength(1)
      const childId = children[0]!.id
      expect(children[0]!.parentId).toBe('s1')
      const listed = p.runner.list('s1')
      if ('error' in listed) throw new Error(listed.error)
      expect(listed.subSessions.map((s) => s.id)).toEqual([childId])

      const [coding] = await spawnedConversations('s1')
      const promptTask = await toolTask('s1', 'call-prompt', coding!.id)
      const requestId = `subsession:s1:${promptTask}`
      expect(await submissionOf(childId, requestId)).toBeDefined()
      expect(p.sessionHostModule.getSessionHost().get(childId)?.drivenRun).toMatchObject({
        requestId,
        parentId: 's1'
      })

      p.router.on('root', role('chat', 'go'), answer('ack'))
      hold.release()
      await waitFor(
        async () => noticesIn(await transcriptOf('s1')).length === 1,
        10000,
        'notice in s1'
      )
      expect(noticesIn(await transcriptOf('s1'))[0]).toContain(`id="${childId}"`)
      await waitFor(() => p.router.left('root') === 0, 10000, 's1 auto-resumed')
      expect(noticesIn(await transcriptOf(childId))).toEqual([])
    },
    T
  )
})

// ─── P2-08 交过来的桌面整合用例 ─────────────────────────────────────────

describe('P2-08 desktop integration cases', () => {
  it(
    'P2-08-16 标题经 session 工具落下：titler 的请求恰 [session]；行标题 Hooked title / auto；titleChanged 一次；日志 start / ok、没有 PhasePendingError；根的摘要没有 titler 的字；turn-completed 事实 {1, 2}',
    async () => {
      await titledTurn()
      const p = proc()
      const titlerRequests = p.router.requests('titler')
      expect(titlerRequests).toHaveLength(2)
      for (const request of titlerRequests)
        expect(request.tools.map((t) => t.name)).toEqual(['session'])
      expect(broadcastsOf('titleChanged')).toEqual([
        { type: 'titleChanged', sessionId: 's1', title: 'Hooked title' }
      ])
      expect(settingsOf('s1').titleOrigin).toBe('auto')
      const lines = logLines()
      expect(lines.some((l) => /hook "auto-title" run=\S+ start/.test(l))).toBe(true)
      expect(lines.some((l) => /hook "auto-title" run=\S+ ok/.test(l))).toBe(true)
      expect(lines.some((l) => l.includes('PhasePendingError'))).toBe(false)
      const digest = await p.transcriptSource.readSessionTranscript('s1')
      const texts = JSON.stringify(digest)
      expect(texts).not.toContain('Hooked title')
      expect(texts).not.toContain('hook_event')
      expect(await p.sessionTriggerFacts.buildTurnCompletedFacts('s1')).toMatchObject({
        turnCount: 1,
        textMessageCount: 2
      })
    },
    T
  )

  it(
    'P2-08-17 第二轮 refine：第二条之后恰一次 refine 派发、落在第二个 titler 对话；第三条不再派发',
    async () => {
      await titledTurn()
      const p = proc()
      p.router.on('root', role('chat'), answer('b'))
      p.router.push(
        'titler',
        callTool('session', { action: 'set-title', title: 'Refined title' }, 'call-title'),
        answer('Refined title')
      )
      expect(await withTimeout(p.chatGateway.prompt('s1', 'second'), 15000, 'prompt 2')).toEqual({})
      await waitFor(() => titleOf('s1') === 'Refined title', 10000, 'refined')
      await waitFor(async () => (await liveTasksOf('s1')).length === 0, 10000, 'refine finished')
      expect(await hookConversations('s1', 'auto-title')).toHaveLength(2)
      const refine = p.router.requests('titler')[2]!
      expect(JSON.stringify(refine.messages)).toContain('session.turn-completed')

      p.router.on('root', role('chat'), answer('c'))
      expect(await withTimeout(p.chatGateway.prompt('s1', 'third'), 15000, 'prompt 3')).toEqual({})
      await sleep(300)
      expect(await hookConversations('s1', 'auto-title')).toHaveLength(2)
      expect(p.router.requests('titler')).toHaveLength(4)
      expect(p.router.unmatched).toEqual([])
    },
    T
  )

  it(
    'P2-08-19 titler 跑着时删会话：日志 aborted；一条 sub_session_end；host.delete 落定；.sqlite 与 -wal / -shm 都没了；没有未处理的拒绝',
    async () => {
      const p = proc()
      insert('s1', { title: DEFAULT_TITLE })
      const hold = held(answer('late'))
      p.router.on('root', role('chat'), answer('a'))
      p.router.on('titler', role('titler'), hold.step)
      expect(await withTimeout(p.chatGateway.prompt('s1', 'hello'), 15000, 'prompt')).toEqual({})
      await withTimeout(hold.reached, 10000, 'titler request')

      await withTimeout(p.agentSessionModule.destroySessionRuntime('s1'), 10000, 'destroy')
      await waitFor(() => broadcastsOf('sub_session_end').length === 1, 5000, 'end broadcast')
      expect(logLines().some((l) => /hook "auto-title" .*aborted/.test(l))).toBe(true)
      expect(storageIds()).toEqual([])
      await sleep(100)
      expect(unhandled).toEqual([])
    },
    T
  )

  it(
    'P2-08-34 真记录上的防递归：审查员自己的被设门操作 → 不再审查（判定只有根那一次）、问人的卡片没有 review、主体是真记录的 spawned / permission-reviewer；对照：titler 的被设门操作照常进判定',
    async () => {
      const p = proc()
      setUserPolicy('ask-askop', "tool.name == 'askOp'")
      // 用户覆盖的审查员：多一个被设门的工具（设计里是 write；这里用同一道 invocation 门上的 askOp）
      rig.profiles['permission-reviewer'] = {
        ...rig.profiles['permission-reviewer'],
        tools: ['askOp']
      }
      insert('s1')
      const decide = vi.spyOn(p.hookService, 'decide')
      p.router.on('root', role('chat'), callTool('askOp', {}, 'call-ask'), answer('done'))
      p.router.on(
        'reviewer',
        role('permission-reviewer'),
        callTool('askOp', {}, 'call-reviewer-ask'),
        next('allow')
      )
      expect(await withTimeout(p.chatGateway.prompt('s1', 'go'), 15000, 'prompt')).toEqual({})
      expect(decide).toHaveBeenCalledTimes(1)
      expect(rig.asks).toHaveLength(1)
      const card = rig.asks[0]!.request as { kind: string; review?: unknown }
      expect(card.kind).toBe('ask')
      expect(card.review).toBeUndefined()
      const [r] = await hookConversations('s1', 'auto-review')
      expect(askOpCalls.map((c) => c.conversationId)).toEqual([r!.id, await rootConversation('s1')])
      expect(p.host.get('s1')!.agentIdentity(r!.id)).toMatchObject({
        kind: 'spawned',
        profileName: 'permission-reviewer'
      })

      // 对照：titler 的被设门操作照常进判定
      rig.profiles.titler = { ...rig.profiles.titler, tools: ['session', 'askOp'] }
      insert('s2', { title: DEFAULT_TITLE })
      p.router.on('root2', role('chat', 'hello'), answer('hi'))
      p.router.on('titler', role('titler'), callTool('askOp', {}, 'call-titler-ask'), answer('T'))
      p.router.push('reviewer', next('allow'))
      expect(await withTimeout(p.chatGateway.prompt('s2', 'hello'), 15000, 'prompt s2')).toEqual({})
      await waitFor(() => decide.mock.calls.length === 2, 10000, 'titler decide')
      expect(decide.mock.calls[1]![1]).toMatchObject({
        agent: { profile: 'titler', kind: 'spawned' }
      })
    },
    T
  )

  it(
    'P2-08-35 hook 对话不进审查员的输入、也不进 titler 的事实：titler 跑过、审查过一次之后，s1 的 userMessages 只有根的人话，turn-completed 事实不变',
    async () => {
      const p = proc()
      setUserPolicy('ask-askop', "tool.name == 'askOp'")
      insert('s1', { title: DEFAULT_TITLE })
      p.router.on('root', role('chat'), callTool('askOp', {}, 'call-ask'), answer('done'))
      p.router.on(
        'titler',
        role('titler'),
        callTool('session', { action: 'set-title', title: 'Hooked title' }, 'call-title'),
        answer('Hooked title')
      )
      p.router.on('reviewer', role('permission-reviewer'), next('allow'))
      const factsBefore = await p.sessionTriggerFacts.buildTurnCompletedFacts('s1')
      expect(
        await withTimeout(p.chatGateway.prompt('s1', 'clean the build'), 15000, 'prompt')
      ).toEqual({})
      await waitFor(async () => (await liveTasksOf('s1')).length === 0, 10000, 'hooks finished')
      expect(await hookConversations('s1', 'auto-title')).toHaveLength(1)
      expect(await hookConversations('s1', 'auto-review')).toHaveLength(1)
      void factsBefore

      const event = {
        request: {
          subject: { kind: 'agent', sessionId: 's1', agentKind: 'root', profileName: 'chat' },
          tool: { name: 'askOp' },
          action: 'execute',
          object: { type: 'invocation' },
          environment: { platform: process.platform, workspaceDir: '/w' }
        },
        decision: { winning: 'ask-askop#1' },
        command: 'askOp',
        toolCallId: 'call-x'
      }
      const payload = await p.permissionReview.buildPermissionRequestPayload(event as never)
      expect(payload.userMessages).toEqual(['clean the build'])
      const facts = await p.sessionTriggerFacts.buildTurnCompletedFacts('s1')
      expect(facts).toMatchObject({ turnCount: 1, textMessageCount: 2 })
      expect(facts!.recentText).not.toContain('hook_event')
      expect(facts!.recentText).not.toContain('decision')
    },
    T
  )
})
