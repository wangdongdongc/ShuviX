/**
 * P2-12（docs/pi-durable/p2-12-test-design.md）—— 桌面跨功能整合之一：子会话跨崩溃，跑在**真 SessionHost +
 * 真 SQLite + 真桌面 ToolHost**（父会话的 `session` 工具是 toolRegistry 里那个真 SessionTool，经真包装器）上，
 * 每个「进程」一张新的模块图（`support/desktopRig.ts`，PIN-01）；「崩溃」= 限时 closeAll（PIN-02）。
 * P = 父会话，C = 子会话，R(t) = `subsession:P:<工具任务 id>`。
 *
 *   K1  继续的级联 P → C 跨崩溃
 *       K1-01 主线（前台）   K1-02 进程 2 里 C 没开着（经 peek 够到、只打开一次）   K1-03 两次崩溃
 *       K1-04 用户先继续 C（P2-10 PIN-14 裁决）   K1-05 wait 两个子会话跨崩溃
 *       K1-06 嵌套：被等着的子会话里还有一个派生 agent
 *   K2  新消息发进被中断的子会话（abort-then-send，R5）
 *       K2-01 子会话自己的一轮被中断   K2-02 P 自己的后台一轮被顶掉（P2-10 PIN-19）
 *       K2-03 被中断的子会话里有活着的派生 agent
 *       （K2-04 只在 P2-10 把 -46 挪过来时才跑 —— 没挪：P2-10 的 subSessionDurable 仍有 -46，这里不重复）
 *   K3  后台完成跨重启补报（driven 标记 → 恰一条通知）
 *       K3-01 C 落定时 P 关着   K3-02 自动续跑关掉   K3-03 用户停掉被中断的子会话
 *       K3-04 两个补报的子会话一起落定   K3-05 C 落定之前 P 被删
 *   K6  删除的级联
 *       K6-01 什么都在跑的父会话   K6-02 删 P 前台等着的子会话   K6-03 崩溃后删父会话（子会话带着标记）
 *       K6-04 用户删一条在跑的后台子会话（PIN-06）
 *
 * 不断言 agent_start / agent_end / message_* 事件（phase 3）；观察面是网关与 continue 的结果、durable 转写与
 * 存储扫描、runState / agentLocked 镜像、taskRegistry，以及路由与 permissionReview 自己的广播。
 */
import {
  DEFAULT_TITLE,
  bootProcess,
  broadcastsOf,
  conversationTranscript,
  conversationsOf,
  crash,
  insert,
  lastUserText,
  liveTasksOf,
  logLines,
  noticesIn,
  proc,
  rig,
  role,
  sessionOf,
  settingsOf,
  setupRig,
  sleep,
  storageIds,
  submissionOf,
  tasksOf,
  teardownRig,
  transcriptOf,
  unhandled,
  userTexts,
  type Proc
} from './support/desktopRig'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { answer, callTool, held, stalled, waitFor, withTimeout } from './support/realHost'
import { callTools } from '../../../../../../packages/agent-runtime/src/durable/__tests__/support/faux'

const T = 40000

beforeEach(async () => {
  await setupRig()
  await bootProcess()
})

afterEach(async () => {
  await teardownRig()
})

// ─── 小工具 ──────────────────────────────────────────────────────────────

const promptChild = (
  child: string,
  message: string,
  id: string,
  background = false
): ReturnType<typeof callTool> =>
  callTool(
    'session',
    {
      action: 'prompt-sub-session',
      sub_session_id: child,
      message,
      ...(background ? { run_in_background: true } : {})
    },
    id
  )

const dispatch = (name: string, prompt: string, id = 'call-agent'): ReturnType<typeof callTool> =>
  callTool('agent', { name, prompt, description: 'look' }, id)

/** 某个对话里 pi.tool、callId 为 `callId` 的任务 id */
async function toolTask(sessionId: string, callId: string): Promise<number> {
  const tasks = (await tasksOf(sessionId)).filter(
    (task) => task.kind === 'pi.tool' && (task.input as { callId?: string }).callId === callId
  )
  if (tasks.length !== 1) throw new Error(`expected one pi.tool task for ${callId}, got ${tasks.length}`)
  return tasks[0]!.id as number
}

/** P 里的 session 工具结果（带 `<sub-session` 围栏的 pi.tool-result） */
async function sessionToolResults(sessionId: string): Promise<string[]> {
  return (await transcriptOf(sessionId)).filter(
    (e) => e.startsWith('pi.tool-result:') && e.includes('<sub-session')
  )
}

const REPLY = (text: string): string => `<reply>\n${text}\n</reply>`

async function markerOf(sessionId: string): Promise<unknown> {
  return (await sessionOf(sessionId))?.drivenRun
}

/** 关掉进程再起一个，按 C → P 打开（K2-02 / K3-01 / K3-04 的「进程 3 什么都不多」） */
async function reopenAddsNothing(order: string[]): Promise<void> {
  const before: Record<string, string[]> = {}
  for (const id of order) before[id] = await transcriptOf(id)
  const p3 = await crash()
  for (const id of order) await p3.sessionService.ensureAgentSession(id)
  await sleep(300)
  for (const id of order) expect(await transcriptOf(id)).toEqual(before[id])
  expect(p3.kit.callCount).toBe(0)
}

/**
 * 进程 1：P 的模型前台 prompt-sub-session 进 C（'C-task'），C 的请求卡住 → 崩溃。交回 R(t) 与 C 那条提交的 id。
 */
async function crashInForegroundPrompt(
  options: { cTitle?: string } = {}
): Promise<{ requestId: string; submissionId: number }> {
  const p1 = proc()
  insert('P')
  insert('C', { parentId: 'P', ...(options.cTitle ? { title: options.cTitle } : {}) })
  const stall = stalled()
  p1.router.on('P', role('chat', 'start'), promptChild('C', 'C-task', 'call-prompt'))
  p1.router.on('C', role('chat', 'C-task'), stall.step)
  void p1.track(p1.chatGateway.prompt('P', 'start'))
  await withTimeout(stall.reached, 10000, 'C request')
  await waitFor(() => settingsOf('C').runState === 'busy', 5000, 'C busy marker')
  const requestId = `subsession:P:${await toolTask('P', 'call-prompt')}`
  const submission = await submissionOf('C', requestId)
  if (!submission) throw new Error('C has no submission for R(t)')
  await crash()
  return { requestId, submissionId: submission.id }
}

/** 进程 1：P 后台 prompt 进 C（'bg'）、P 的这一轮答 ok；C 卡住 → 崩溃。交回 R */
async function crashInBackgroundPrompt(): Promise<{ requestId: string }> {
  const p1 = proc()
  insert('P')
  insert('C', { parentId: 'P' })
  const stall = stalled()
  p1.router.on('P', role('chat', 'start'), promptChild('C', 'bg', 'call-bg', true), answer('ok'))
  p1.router.on('C', role('chat', 'bg'), stall.step)
  expect(await withTimeout(p1.chatGateway.prompt('P', 'start'), 15000, 'P prompt')).toEqual({})
  await withTimeout(stall.reached, 10000, 'C request')
  const requestId = `subsession:P:${await toolTask('P', 'call-bg')}`
  await crash()
  return { requestId }
}

/** 记下送达父会话的完成通知（sessionService.deliverSubSessionNotice 的第三个参数 = 通知的 requestId） */
function spyNotices(p: Proc): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(p.sessionService, 'deliverSubSessionNotice')
}

// ─── K1 继续的级联 ───────────────────────────────────────────────────────

describe('K1 continue cascade P → C across a crash', () => {
  it('K1-01 主线：continue 等两边都答完才 {}；C 的转写恰 [C-task, C-done]、R(t) 提交 id 不变且 done；P 的结果带答复、不是「可能已部分执行」；两次请求 C → P；没有通知；镜像 idle；没被钉住；只有 P、C 两个存储', async () => {
    const { requestId, submissionId } = await crashInForegroundPrompt()
    const p2 = proc()
    const parent = await p2.sessionService.ensureAgentSession('P')
    expect(settingsOf('P').runState).toBe('interrupted')
    // C 没开着：镜像还是崩溃留下的 busy —— 没开着的会话不可能真在跑，按 interrupted 报（P2-10 PIN-09）
    expect(settingsOf('C').runState).toBe('busy')

    p2.router.on('C', role('chat', 'C-task'), answer('C-done'))
    p2.router.on('P', role('chat', 'start'), answer('P-final'))
    expect(await withTimeout(parent!.continue(), 15000, 'P.continue')).toEqual({})
    expect(p2.router.served).toEqual(['C', 'P'])

    expect(await transcriptOf('C')).toEqual(['pi.user:C-task', 'pi.assistant:C-done'])
    expect(await submissionOf('C', requestId)).toMatchObject({ id: submissionId, status: 'done' })
    const results = await sessionToolResults('P')
    expect(results).toHaveLength(1)
    expect(results[0]).toContain(REPLY('C-done'))
    expect(results[0]).not.toMatch(/may have partially run/)
    expect((await transcriptOf('P')).at(-1)).toBe('pi.assistant:P-final')
    expect(noticesIn(await transcriptOf('P'))).toEqual([])
    await waitFor(() => settingsOf('P').runState === 'idle', 5000, 'P idle')
    await waitFor(() => settingsOf('C').runState === 'idle', 5000, 'C idle')
    expect(p2.taskRegistry.runningCount('P')).toBe(0)
    expect(storageIds()).toEqual(['C', 'P'])
  }, T)

  it('K1-02 进程 2 里 C 没开着：list 报 interrupted；continue 时经 peek 够到 C、存储只打开一次且一直在；别的 id 从不建存储；结果同 K1-01', async () => {
    const opened: string[] = []
    await crashInForegroundPrompt()
    const p2 = await crash({ onOpenStorage: (id) => opened.push(id) })
    const listed = p2.runner.list('P')
    if ('error' in listed) throw new Error(listed.error)
    expect(listed.subSessions.map((s) => [s.id, s.status])).toEqual([['C', 'interrupted']])
    expect(p2.host.get('C')).toBeUndefined()

    const peek = vi.spyOn(p2.host, 'peek')
    const cFile = join(rig.sessionsDir, 'C.sqlite')
    let cMissing = false
    const watch = setInterval(() => {
      if (!existsSync(cFile)) cMissing = true
    }, 5)
    try {
      p2.router.on('C', role('chat', 'C-task'), answer('C-done'))
      p2.router.on('P', role('chat', 'start'), answer('P-final'))
      const parent = await p2.sessionService.ensureAgentSession('P')
      expect(await withTimeout(parent!.continue(), 15000, 'P.continue')).toEqual({})
    } finally {
      clearInterval(watch)
    }
    expect(cMissing).toBe(false)
    expect(peek.mock.calls.some(([id]) => id === 'C')).toBe(true)
    expect(opened.filter((id) => id === 'C')).toHaveLength(1)
    expect([...new Set(opened)].sort()).toEqual(['C', 'P'])
    expect(storageIds()).toEqual(['C', 'P'])
    expect(await transcriptOf('C')).toEqual(['pi.user:C-task', 'pi.assistant:C-done'])
    expect((await sessionToolResults('P'))[0]).toContain(REPLY('C-done'))
    expect(noticesIn(await transcriptOf('P'))).toEqual([])
  }, T)

  it('K1-03 两次崩溃：进程 2 里 C 又卡住、再崩；进程 3 continue → C 仍只有一条 pi.user、R(t) done；P 那次调用恰一条结果带答复；没有通知；镜像 idle', async () => {
    const { requestId } = await crashInForegroundPrompt()
    const p2 = proc()
    const stall = stalled()
    p2.router.on('C', role('chat', 'C-task'), stall.step)
    const parent2 = await p2.sessionService.ensureAgentSession('P')
    void p2.track(parent2!.continue())
    await withTimeout(stall.reached, 10000, 'C request in process 2')

    const p3 = await crash()
    p3.router.on('C', role('chat', 'C-task'), answer('C-done'))
    p3.router.on('P', role('chat', 'start'), answer('P-final'))
    const parent3 = await p3.sessionService.ensureAgentSession('P')
    expect(await withTimeout(parent3!.continue(), 15000, 'P.continue')).toEqual({})
    expect((await transcriptOf('C')).filter((e) => e.startsWith('pi.user:'))).toEqual(['pi.user:C-task'])
    expect(await submissionOf('C', requestId)).toMatchObject({ status: 'done' })
    const results = await sessionToolResults('P')
    expect(results).toHaveLength(1)
    expect(results[0]).toContain(REPLY('C-done'))
    expect(noticesIn(await transcriptOf('P'))).toEqual([])
    await waitFor(() => settingsOf('P').runState === 'idle', 5000, 'P idle')
    await waitFor(() => settingsOf('C').runState === 'idle', 5000, 'C idle')
  }, T)

  it('K1-04 用户先继续 C（PIN-14 裁决）：C 答完、idle；之后 P.continue 不再请求 C、R(t) 早已 settled；P 拿到答复；P 自始至终没有通知（任务 t 还活着）；C 的标记清掉', async () => {
    const { requestId } = await crashInForegroundPrompt()
    const p2 = proc()
    p2.router.on('C', role('chat', 'C-task'), answer('C-done'))
    const child = await p2.sessionService.ensureAgentSession('C')
    expect(await withTimeout(child!.continue(), 15000, 'C.continue')).toEqual({})
    await waitFor(() => settingsOf('C').runState === 'idle', 5000, 'C idle')
    await sleep(300)
    expect(noticesIn(await transcriptOf('P'))).toEqual([])
    expect(await p2.host.get('C')!.requestState(requestId)).toBe('settled')

    p2.router.on('P', role('chat', 'start'), answer('P-final'))
    const parent = await p2.sessionService.ensureAgentSession('P')
    expect(await withTimeout(parent!.continue(), 15000, 'P.continue')).toEqual({})
    expect(p2.router.served).toEqual(['C', 'P'])
    expect((await sessionToolResults('P'))[0]).toContain(REPLY('C-done'))
    await sleep(200)
    expect(noticesIn(await transcriptOf('P'))).toEqual([])
    await waitFor(async () => (await markerOf('C')) === undefined, 5000, 'C marker cleared')
  }, T)

  it('K1-05 wait 两个子会话跨崩溃：每个子会话恰续上一次、各一条 pi.user；P 的 wait 结果 settled、两条答复；没有通知；镜像都 idle', async () => {
    const p1 = proc()
    insert('P')
    insert('C1', { parentId: 'P' })
    insert('C2', { parentId: 'P' })
    const s1 = stalled()
    const s2 = stalled()
    p1.router.on(
      'P',
      role('chat', 'start'),
      promptChild('C1', 'one-task', 'call-p1', true),
      promptChild('C2', 'two-task', 'call-p2', true),
      callTool('session', { action: 'wait-for-sub-sessions' }, 'call-wait')
    )
    p1.router.on('C1', role('chat', 'one-task'), s1.step)
    p1.router.on('C2', role('chat', 'two-task'), s2.step)
    void p1.track(p1.chatGateway.prompt('P', 'start'))
    await withTimeout(Promise.all([s1.reached, s2.reached]), 10000, 'children requests')
    await waitFor(() => p1.router.left('P') === 0, 10000, 'P called wait')
    // wait 已经挂住（memo 写下了要等的那两条）
    await sleep(300)

    const p2 = await crash()
    p2.router.on('C1', role('chat', 'one-task'), answer('one'))
    p2.router.on('C2', role('chat', 'two-task'), answer('two'))
    p2.router.on('P', role('chat', 'start'), answer('done'))
    const parent = await p2.sessionService.ensureAgentSession('P')
    expect(await withTimeout(parent!.continue(), 15000, 'P.continue')).toEqual({})
    expect(p2.router.served.filter((r) => r === 'C1')).toHaveLength(1)
    expect(p2.router.served.filter((r) => r === 'C2')).toHaveLength(1)
    expect((await transcriptOf('C1')).filter((e) => e.startsWith('pi.user:'))).toHaveLength(1)
    expect((await transcriptOf('C2')).filter((e) => e.startsWith('pi.user:'))).toHaveLength(1)
    const wait = (await transcriptOf('P')).find((e) => e.includes('<sub-sessions status='))!
    expect(wait).toContain('<sub-sessions status="settled">')
    expect(wait).toContain(REPLY('one'))
    expect(wait).toContain(REPLY('two'))
    await sleep(200)
    expect(noticesIn(await transcriptOf('P'))).toEqual([])
    for (const id of ['P', 'C1', 'C2']) {
      await waitFor(() => settingsOf(id).runState === 'idle', 5000, `${id} idle`)
    }
  }, T)

  it('K1-06 嵌套：C 里派生的 explore 卡住、崩溃 → 三次请求 explore、C、P；explore 在 C 的存储里只有一条 pi.user、记录 tool / 父对话 1 / depth 1；C 的派发结果 found；进程 2 的路由注册 / 结束各一条（父、根都是 C）；P 拿到答复；没有在跑的任务；P 的存储里没有派生对话', async () => {
    const p1 = proc()
    insert('P')
    insert('C', { parentId: 'P' })
    const stall = stalled()
    p1.router.on('P', role('chat', 'start'), promptChild('C', 'C-task', 'call-prompt'))
    p1.router.on('C', role('chat', 'C-task'), dispatch('explore', 'look'))
    p1.router.on('explore', role('explore'), stall.step)
    void p1.track(p1.chatGateway.prompt('P', 'start'))
    await withTimeout(stall.reached, 10000, 'explore request')
    const agentId = broadcastsOf('sub_session_register')[0]!.sessionId as string

    // 进程 1 关停时路由照常为被中止的等待报一条 end：那是上一个进程的，清掉之后才看进程 2 的
    const p2 = await crash()
    rig.broadcasts.length = 0
    p2.router.on('explore', role('explore'), answer('found'))
    p2.router.on('C', role('chat', 'C-task'), answer('C-done'))
    p2.router.on('P', role('chat', 'start'), answer('P-final'))
    const parent = await p2.sessionService.ensureAgentSession('P')
    expect(await withTimeout(parent!.continue(), 15000, 'P.continue')).toEqual({})
    expect(p2.router.served).toEqual(['explore', 'C', 'P'])

    const spawned = (await conversationsOf('C')).filter((c) => c.record?.dispatch === 'tool')
    expect(spawned).toHaveLength(1)
    const explore = spawned[0]!
    const cRoot = (await (await sessionOf('C'))!.currentConversation()).id
    expect(explore.record).toMatchObject({ dispatch: 'tool', parentConversationId: cRoot, depth: 1, agentId })
    expect(
      (await conversationTranscript('C', explore.id)).filter((e) => e.startsWith('pi.user:'))
    ).toEqual(['pi.user:look'])
    expect((await transcriptOf('C')).find((e) => e.startsWith('pi.tool-result:'))).toBe(
      'pi.tool-result:found'
    )
    const registers = broadcastsOf('sub_session_register').filter((e) => e.sessionId === agentId)
    expect(registers).toHaveLength(1)
    expect(registers[0]).toMatchObject({ parentSessionId: 'C', rootSessionId: 'C' })
    const ends = broadcastsOf('sub_session_end').filter((e) => e.sessionId === agentId)
    expect(ends).toEqual([expect.objectContaining({ isError: false })])
    expect((await sessionToolResults('P'))[0]).toContain(REPLY('C-done'))
    expect(p2.taskRegistry.runningCount('P')).toBe(0)
    expect(p2.taskRegistry.runningCount('C')).toBe(0)
    expect((await conversationsOf('P')).filter((c) => c.record !== undefined)).toEqual([])
  }, T)
})

// ─── K2 新消息发进被中断的子会话 ─────────────────────────────────────────

describe('K2 a fresh prompt into an interrupted child (abort-then-send)', () => {
  it('K2-01 C 自己的一轮被中断：old 没答（中止前 seam 恰一次）；C 恰一次请求、最后一条用户消息是 new；C 的转写以 [new, fresh] 收尾；P 拿到 fresh；没有通知；C 的镜像 idle', async () => {
    const p1 = proc()
    insert('P')
    insert('C', { parentId: 'P' })
    const stall = stalled()
    p1.router.on('C', role('chat', 'old'), stall.step)
    void p1.track(p1.chatGateway.prompt('C', 'old'))
    await withTimeout(stall.reached, 10000, 'C request')
    await waitFor(() => settingsOf('C').runState === 'busy', 5000, 'C busy')

    const p2 = await crash()
    p2.router.on('P', role('chat', 'start'), promptChild('C', 'new', 'call-prompt'), answer('ok'))
    p2.router.on('C', role('chat', 'old'), answer('fresh'))
    expect(await withTimeout(p2.chatGateway.prompt('P', 'start'), 15000, 'P prompt')).toEqual({})
    expect(p2.aborts.filter((id) => id === 'C')).toHaveLength(1)
    const cRequests = p2.router.requests('C')
    expect(cRequests).toHaveLength(1)
    expect(lastUserText(cRequests[0]!)).toBe('new')
    expect(await transcriptOf('C')).toEqual(['pi.user:old', 'pi.user:new', 'pi.assistant:fresh'])
    expect((await sessionToolResults('P'))[0]).toContain(REPLY('fresh'))
    expect(noticesIn(await transcriptOf('P'))).toEqual([])
    await waitFor(() => settingsOf('C').runState === 'idle', 5000, 'C idle')
  }, T)

  it('K2-02 P 自己的后台一轮被顶掉（PIN-19）：R(1) aborted 落定、P 没有通知；P 拿到 redone；C 的标记最后清掉；进程 3 先开 C 再开 P 什么都不多', async () => {
    const { requestId: r1 } = await crashInBackgroundPrompt()
    const p2 = proc()
    p2.router.on('P', role('chat', 'start'), promptChild('C', 'redo', 'call-redo'), answer('fine'))
    p2.router.on('C', role('chat', 'bg'), answer('redone'))
    expect(await withTimeout(p2.chatGateway.prompt('P', 'again'), 15000, 'P prompt')).toEqual({})
    expect(await submissionOf('C', r1)).toMatchObject({ status: 'unanswered' })
    expect((await sessionToolResults('P')).at(-1)).toContain(REPLY('redone'))
    await waitFor(async () => (await markerOf('C')) === undefined, 5000, 'C marker cleared')
    await sleep(300)
    expect(noticesIn(await transcriptOf('P'))).toEqual([])
    expect(p2.router.unmatched).toEqual([])
    await reopenAddsNothing(['C', 'P'])
  }, T)

  it('K2-03 被中断的 C 里有活着的派生 agent：explore 的任务全部终结、进程 2 没有请求；新消息照跑（C 一次、然后 P）；进程 2 的路由不为 explore 广播；C 没有在跑的；C 的镜像 idle', async () => {
    const p1 = proc()
    insert('P')
    insert('C', { parentId: 'P' })
    const stall = stalled()
    p1.router.on('C', role('chat', 'old'), dispatch('explore', 'look'))
    p1.router.on('explore', role('explore'), stall.step)
    void p1.track(p1.chatGateway.prompt('C', 'old'))
    await withTimeout(stall.reached, 10000, 'explore request')
    const agentId = broadcastsOf('sub_session_register')[0]!.sessionId as string

    const p2 = await crash()
    rig.broadcasts.length = 0
    p2.router.on('P', role('chat', 'start'), promptChild('C', 'new', 'call-prompt'), answer('ok'))
    p2.router.on('C', role('chat', 'old'), answer('fresh'))
    expect(await withTimeout(p2.chatGateway.prompt('P', 'start'), 15000, 'P prompt')).toEqual({})
    expect(p2.router.served).toEqual(['P', 'C', 'P'])
    const [explore] = (await conversationsOf('C')).filter((c) => c.record?.dispatch === 'tool')
    await waitFor(async () => (await liveTasksOf('C')).length === 0, 5000, 'C tasks terminal')
    expect(
      (await tasksOf('C')).filter((t) => t.conversationId === explore!.id).every((t) => t.state.status === 'terminal')
    ).toBe(true)
    expect(
      rig.broadcasts.filter(
        (e) => (e.type === 'sub_session_register' || e.type === 'sub_session_end') && e.sessionId === agentId
      )
    ).toEqual([])
    expect(p2.taskRegistry.runningCount('C')).toBe(0)
    await waitFor(() => settingsOf('C').runState === 'idle', 5000, 'C idle')
  }, T)
})

// ─── K3 后台完成跨重启补报 ───────────────────────────────────────────────

describe('K3 background completion re-arm across a restart', () => {
  it('K3-01 C 落定时 P 关着：P 经 peek 够到（从不 open）；P 恰多出 [通知, ack]；恰一个 subsession-done:C:<n> 提交；自动续跑的最后一条用户消息就是通知；C 的标记清掉；进程 3 什么都不多', async () => {
    await crashInBackgroundPrompt()
    const p2 = proc()
    const before = await (async () => {
      const session = await sessionOf('P')
      const { transcript } = await import('./support/realHost')
      return transcript(await session!.currentConversation())
    })()
    await p2.host.close('P')
    const open = vi.spyOn(p2.host, 'open')
    const deliver = spyNotices(p2)
    p2.router.on('C', role('chat', 'bg'), answer('done'))
    p2.router.on('P', role('chat', 'start'), answer('ack'))
    const child = await p2.sessionService.ensureAgentSession('C')
    expect(await withTimeout(child!.continue(), 15000, 'C.continue')).toEqual({})
    await waitFor(() => p2.router.left('P') === 0, 10000, 'P auto-resumed')
    await waitFor(() => settingsOf('P').runState === 'idle', 10000, 'P idle')

    expect(open.mock.calls.filter(([id]) => id === 'P')).toEqual([])
    const after = await transcriptOf('P')
    const added = after.slice(before.length)
    expect(added).toHaveLength(2)
    expect(added[0]).toMatch(/^pi\.user:/)
    expect(added[0]).toContain('id="C"')
    expect(added[0]).toContain('wait-for-sub-sessions')
    expect(added[0]).not.toContain('done')
    expect(added[1]).toBe('pi.assistant:ack')
    const noticeIds = [...new Set(deliver.mock.calls.map((call) => call[2] as string))]
    expect(noticeIds).toHaveLength(1)
    expect(noticeIds[0]).toMatch(/^subsession-done:C:\d+$/)
    expect(await submissionOf('P', noticeIds[0]!)).toBeDefined()
    expect(lastUserText(p2.router.requests('P')[0]!)).toBe(added[0]!.slice('pi.user:'.length))
    await waitFor(async () => (await markerOf('C')) === undefined, 5000, 'C marker cleared')
    await reopenAddsNothing(['C', 'P'])
  }, T)

  it('K3-02 自动续跑关掉：C 落定后 500ms 内 P 没有请求；下一条 prompt 恰一次请求、用户消息里通知恰一次且在 hi 之前；再一条不再重复', async () => {
    await crashInBackgroundPrompt()
    const p2 = proc()
    rig.settings.set('session.autoResume', 'false')
    p2.router.on('C', role('chat', 'bg'), answer('done'))
    const child = await p2.sessionService.ensureAgentSession('C')
    expect(await withTimeout(child!.continue(), 15000, 'C.continue')).toEqual({})
    await waitFor(async () => noticesIn(await transcriptOf('P')).length === 1, 10000, 'notice written')
    await sleep(500)
    expect(p2.router.requests('P')).toHaveLength(0)

    p2.router.on('P', role('chat', 'start'), answer('h1'), answer('h2'))
    expect(await withTimeout(p2.chatGateway.prompt('P', 'hi'), 15000, 'hi')).toEqual({})
    const [first] = p2.router.requests('P')
    const users = userTexts(first!)
    const noticeAt = users.findIndex((u) => u.includes('<sub-session id="C"'))
    expect(users.filter((u) => u.includes('<sub-session id="C"'))).toHaveLength(1)
    expect(noticeAt).toBeGreaterThanOrEqual(0)
    expect(noticeAt).toBeLessThan(users.indexOf('hi'))
    expect(p2.router.requests('P')).toHaveLength(1)

    expect(await withTimeout(p2.chatGateway.prompt('P', 'again'), 15000, 'again')).toEqual({})
    const second = p2.router.requests('P')[1]!
    expect(userTexts(second).filter((u) => u.includes('<sub-session id="C"'))).toHaveLength(1)
  }, T)

  it('K3-03 用户停掉被中断的子会话：R aborted、C 镜像 idle；P 恰一条带「被用户停掉」的通知、自动续跑一次；C 没有请求', async () => {
    const { requestId } = await crashInBackgroundPrompt()
    const p2 = proc()
    p2.router.on('P', role('chat', 'start'), answer('ack'))
    // 用户在 C 里点停止：那时 C 开着（网关的 abort 只作用于打开着的会话 —— 没开着的什么都不做）
    await p2.sessionService.ensureAgentSession('C')
    await withTimeout(p2.chatGateway.abort('C'), 10000, 'abort C')
    await waitFor(async () => noticesIn(await transcriptOf('P')).length === 1, 10000, 'notice in P')
    expect(await submissionOf('C', requestId)).toMatchObject({ status: 'unanswered' })
    await waitFor(() => settingsOf('C').runState === 'idle', 5000, 'C idle')
    expect(noticesIn(await transcriptOf('P'))[0]).toContain('stopped by the user')
    await waitFor(() => p2.router.left('P') === 0, 10000, 'P auto-resumed')
    await sleep(200)
    expect(p2.router.requests('P')).toHaveLength(1)
    expect(p2.router.requests('C')).toHaveLength(0)
    expect(noticesIn(await transcriptOf('P'))).toHaveLength(1)
  }, T)

  it('K3-04 两个补报的子会话一起落定：P 恰一次自动续跑、最后一条用户消息里 C1 与 C2 两块都在；没有哪条通知送两次；合并的 requestId（PIN-10）；两个标记都清掉；进程 3 什么都不多', async () => {
    const p1 = proc()
    insert('P')
    insert('C1', { parentId: 'P' })
    insert('C2', { parentId: 'P' })
    const s1 = stalled()
    const s2 = stalled()
    p1.router.on(
      'P',
      role('chat', 'start'),
      promptChild('C1', 'one-task', 'call-p1', true),
      promptChild('C2', 'two-task', 'call-p2', true),
      answer('ok')
    )
    p1.router.on('C1', role('chat', 'one-task'), s1.step)
    p1.router.on('C2', role('chat', 'two-task'), s2.step)
    expect(await withTimeout(p1.chatGateway.prompt('P', 'start'), 15000, 'P prompt')).toEqual({})
    await withTimeout(Promise.all([s1.reached, s2.reached]), 10000, 'children requests')

    const p2 = await crash()
    const deliver = spyNotices(p2)
    p2.router.on('C1', role('chat', 'one-task'), answer('one'))
    p2.router.on('C2', role('chat', 'two-task'), answer('two'))
    p2.router.on('P', role('chat', 'start'), answer('ack'), answer('ack2'))
    const [c1, c2] = await Promise.all([
      p2.sessionService.ensureAgentSession('C1'),
      p2.sessionService.ensureAgentSession('C2')
    ])
    const results = await withTimeout(Promise.all([c1!.continue(), c2!.continue()]), 15000, 'continues')
    expect(results).toEqual([{}, {}])
    await waitFor(() => p2.router.requests('P').length >= 1, 10000, 'P auto-resumed')
    await sleep(800)
    await waitFor(() => settingsOf('P').runState === 'idle', 10000, 'P idle')

    const noticeIds = deliver.mock.calls.map((call) => call[2] as string)
    expect(new Set(noticeIds).size).toBe(2)
    const pUsers = (await transcriptOf('P')).filter((e) => e.startsWith('pi.user:'))
    for (const id of noticeIds) {
      const child = id.split(':')[1]
      expect(pUsers.filter((e) => e.includes(`<sub-session id="${child}"`))).toHaveLength(1)
    }
    const autoResumes = p2.router.requests('P')
    if (autoResumes.length === 1) {
      const last = lastUserText(autoResumes[0]!)
      expect(last).toContain('id="C1"')
      expect(last).toContain('id="C2"')
      const combined = `notices:${[...noticeIds].sort().join(',')}`
      expect(await submissionOf('P', combined)).toBeDefined()
    } else {
      // PIN-09：运行时把两次落定拆进了两个窗口 —— 照记：两轮自动续跑，每条通知仍只出现一次
      expect(autoResumes).toHaveLength(2)
    }
    await waitFor(async () => (await markerOf('C1')) === undefined, 5000, 'C1 marker cleared')
    await waitFor(async () => (await markerOf('C2')) === undefined, 5000, 'C2 marker cleared')
    await reopenAddsNothing(['C1', 'C2', 'P'])
  }, T)

  it('K3-05 C 落定之前 P 被删（级联也删 C，所以先驱动 C）：删除落定；200ms 内没有 P.sqlite 冒出来；没有未处理的拒绝', async () => {
    await crashInBackgroundPrompt()
    const p2 = proc()
    const hold = held(answer('late'))
    p2.router.on('C', role('chat', 'bg'), hold.step)
    const child = await p2.sessionService.ensureAgentSession('C')
    const continuing = p2.track(child!.continue())
    await withTimeout(hold.reached, 10000, 'C request')
    await withTimeout(p2.sessionService.delete('P'), 10000, 'delete P')
    await withTimeout(continuing, 10000, 'continue settles').catch(() => undefined)
    await sleep(200)
    expect(existsSync(join(rig.sessionsDir, 'P.sqlite'))).toBe(false)
    expect(storageIds()).toEqual([])
    expect(p2.sessionRecords.findById('P')).toBeUndefined()
    expect(p2.sessionRecords.findById('C')).toBeUndefined()
    expect(unhandled).toEqual([])
  }, T)

  it('K3-05 变体：只删 P 的行（行 + host.delete），再继续 C → 通知处理器落定、P.sqlite 不再出现、C 的标记清掉、没有未处理的拒绝', async () => {
    await crashInBackgroundPrompt()
    const p2 = proc()
    const settled = vi.spyOn(p2.runner, 'onDrivenSettled')
    p2.sessionRecords.deleteById('P')
    await withTimeout(p2.host.delete('P'), 10000, 'host.delete P')
    expect(existsSync(join(rig.sessionsDir, 'P.sqlite'))).toBe(false)
    p2.router.on('C', role('chat', 'bg'), answer('done'))
    const child = await p2.sessionService.ensureAgentSession('C')
    expect(await withTimeout(child!.continue(), 15000, 'C.continue')).toEqual({})
    await waitFor(() => settled.mock.calls.length === 1, 5000, 'handler called')
    await expect(settled.mock.results[0]!.value).resolves.toBeUndefined()
    await waitFor(async () => (await markerOf('C')) === undefined, 5000, 'C marker cleared')
    await sleep(200)
    expect(existsSync(join(rig.sessionsDir, 'P.sqlite'))).toBe(false)
    expect(unhandled).toEqual([])
  }, T)
})

// ─── K6 删除的级联 ───────────────────────────────────────────────────────

describe('K6 deletion cascades', () => {
  it('K6-01 什么都在跑的父会话：P、C1、C2 的行都没了、目录空；P 在途的发送落定；explore 一条 end、hook 日志 aborted；没有在跑的；continueTask 拒绝 not found 且不建存储；删后 50ms 没有镜像写回；没有未处理的拒绝', async () => {
    const p = proc()
    insert('P', { title: DEFAULT_TITLE })
    insert('C1', { parentId: 'P' })
    insert('C2', { parentId: 'P' })
    p.router.on('C1', role('chat', 'c1'), answer('c1-done'))
    expect(await withTimeout(p.chatGateway.prompt('C1', 'c1'), 15000, 'C1 prompt')).toEqual({})
    await p.host.close('C1')

    const c2 = held(answer('never'))
    const explore = held(answer('never'))
    const titler = held(answer('never'))
    p.router.on(
      'P',
      role('chat', 'start'),
      callTools([
        ['session', { action: 'prompt-sub-session', sub_session_id: 'C2', message: 'C2-task' }, 'call-prompt'],
        ['agent', { name: 'explore', prompt: 'look', description: 'd' }, 'call-agent']
      ])
    )
    p.router.on('C2', role('chat', 'C2-task'), c2.step)
    p.router.on('explore', role('explore'), explore.step)
    p.router.on('titler', role('titler'), titler.step)
    const pending = p.track(p.chatGateway.prompt('P', 'start'))
    await withTimeout(Promise.all([c2.reached, explore.reached, titler.reached]), 10000, 'all held')
    const exploreId = broadcastsOf('sub_session_register').find((e) => e.subAgentName === 'explore')!
      .sessionId as string

    await withTimeout(p.sessionService.delete('P'), 10000, 'delete P')
    for (const id of ['P', 'C1', 'C2']) expect(p.sessionRecords.findById(id)).toBeUndefined()
    expect(storageIds()).toEqual([])
    const result = await withTimeout(pending, 5000, 'pending prompt')
    expect(result.error === undefined || result.code === 'closed').toBe(true)
    await waitFor(
      () => broadcastsOf('sub_session_end').filter((e) => e.sessionId === exploreId).length === 1,
      5000,
      'explore end'
    )
    expect(logLines().some((l) => /hook "auto-title" .*aborted/.test(l))).toBe(true)
    for (const id of ['P', 'C1', 'C2']) expect(p.taskRegistry.runningCount(id)).toBe(0)
    await expect(
      p.agentManager.continueTask({ subSessionId: exploreId, text: 'more' })
    ).rejects.toThrow(/not found/i)
    expect(storageIds()).toEqual([])
    const db = rig.db as import('node:sqlite').DatabaseSync
    await sleep(50)
    expect(db.prepare('SELECT id FROM sessions').all()).toEqual([])
    expect(unhandled).toEqual([])
  }, T)

  it('K6-02 删 P 前台等着的子会话：P 的工具交回错误 / 关闭的围栏而不是挂住；P 这一轮以 k 收尾；没有通知；P 镜像 idle、存储完好', async () => {
    const p = proc()
    insert('P')
    insert('C', { parentId: 'P' })
    const hold = held(answer('never'))
    p.router.on('P', role('chat', 'start'), promptChild('C', 'C-task', 'call-prompt'), answer('k'))
    p.router.on('C', role('chat', 'C-task'), hold.step)
    const pending = p.track(p.chatGateway.prompt('P', 'start'))
    await withTimeout(hold.reached, 10000, 'C request')
    await withTimeout(p.sessionService.delete('C'), 10000, 'delete C')
    expect(await withTimeout(pending, 15000, 'P turn')).toEqual({})
    const entries = await transcriptOf('P')
    const toolResult = entries.find((e) => e.startsWith('pi.tool-result:'))!
    expect(toolResult).toBeDefined()
    expect(toolResult).not.toContain(REPLY('never'))
    expect(entries.at(-1)).toBe('pi.assistant:k')
    await sleep(200)
    expect(noticesIn(entries)).toEqual([])
    expect(noticesIn(await transcriptOf('P'))).toEqual([])
    await waitFor(() => settingsOf('P').runState === 'idle', 5000, 'P idle')
    expect(storageIds()).toEqual(['P'])
  }, T)

  it('K6-03 崩溃后删父会话（子会话带着标记、被中断）：先删子会话；两个 .sqlite 都没了（200ms 内也没回来）；没有未处理的拒绝；两行都没了', async () => {
    await crashInBackgroundPrompt()
    const p2 = proc()
    const order: string[] = []
    const original = p2.host.delete.bind(p2.host)
    const destroy = vi.spyOn(p2.host, 'delete').mockImplementation(async (id: string) => {
      order.push(id)
      return original(id)
    })
    await withTimeout(p2.sessionService.delete('P'), 10000, 'delete P')
    destroy.mockRestore()
    expect(order).toEqual(['C', 'P'])
    expect(existsSync(join(rig.sessionsDir, 'P.sqlite'))).toBe(false)
    expect(existsSync(join(rig.sessionsDir, 'C.sqlite'))).toBe(false)
    await sleep(200)
    expect(storageIds()).toEqual([])
    expect(unhandled).toEqual([])
    expect(p2.sessionRecords.findById('P')).toBeUndefined()
    expect(p2.sessionRecords.findById('C')).toBeUndefined()
  }, T)

  it('K6-04 用户删一条在跑的后台子会话（PIN-06）：P 恰一条「被用户停掉」的通知；之后 P 读 C → 未知 id 的错误，列出 P 现有的子会话', async () => {
    const p = proc()
    insert('P')
    insert('C', { parentId: 'P' })
    insert('C9', { parentId: 'P', title: 'other-child' })
    const hold = held(answer('never'))
    p.router.on('P', role('chat', 'start'), promptChild('C', 'bg', 'call-bg', true), answer('ok'))
    p.router.on('C', role('chat', 'bg'), hold.step)
    expect(await withTimeout(p.chatGateway.prompt('P', 'start'), 15000, 'P prompt')).toEqual({})
    await withTimeout(hold.reached, 10000, 'C request')

    p.router.push(
      'P',
      callTool('session', { action: 'read-sub-session', sub_session_id: 'C' }, 'call-read'),
      answer('k')
    )
    await withTimeout(p.sessionService.delete('C'), 10000, 'delete C')
    await waitFor(async () => noticesIn(await transcriptOf('P')).length === 1, 10000, 'notice in P')
    expect(noticesIn(await transcriptOf('P'))[0]).toContain('stopped by the user')
    await waitFor(() => p.router.left('P') === 0, 10000, 'P auto-resumed and read')
    await waitFor(() => settingsOf('P').runState === 'idle', 10000, 'P idle')
    const read = (await transcriptOf('P')).filter((e) => e.startsWith('pi.tool-result:')).at(-1)!
    expect(read).toContain('"C" is not a sub-session of this session')
    expect(read).toContain('C9')
    expect(noticesIn(await transcriptOf('P'))).toHaveLength(1)
  }, T)
})
