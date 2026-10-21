/**
 * 询问点的自动审查（设计稿 docs/permission-review-design.md）—— 整条链路在真实实例里跑一遍：
 *
 *   策略判出 ask（不含 force-ask）→ 安全模块的 onPermissionRequest 接缝 → 判定型埋点
 *   `permission.request` → 内置 hook `auto-review` → 内置 agent `permission-reviewer`（会话当前
 *   模型上的一次派生运行，工具恰为档案的 `read` 与结果契约工具 `next`）→ 判决 allow / ask / deny
 *   落回安全模块。审查员可以先 `read` 被运行的脚本；它的读取从不问人（会询问的一律拒绝，E2E-R12）。
 *
 * 模型侧是假提供商：主 agent 与审查员的请求交错到达，所以**每个脚本回合都按内容认领** ——
 * 主 agent 用 `!isReviewerRequest`，审查员用 `isReviewerRequest`（工具表恰为 `read` + `next`，见
 * harness/seed.ts）。命令一律 `touch <marker>`：「命令到底跑没跑」看 marker 文件在不在，
 * 不信工具自己的报告。
 *
 * 观测面：审查员的全部输入是它任务文本里 `<hook_event trigger="permission.request">` 围栏的 YAML
 * （`reviewEventOf`）；执行结果看会话视图里的询问（`view.asks[].review`）、工具块（`message.list`
 * 投影出的 details 保留键 `shuvixReview`）、决策日志（主日志的 `security_decision` 行，`review`
 * 字段）与 ChatEvent `tool_review`；DOM 只在 R1（「已审查」盾牌）/ R3（卡片上的审查意见）/
 * R8（「审查中」）读一眼，且经 pages.ts。
 *
 * 前提：`launchApp({ autoReview: true })`（harness 缺省用内置 hook 的停用开关关掉审查），
 * 沙箱关掉（沙箱里的命令不问，也就轮不到审查）；每条用例一条新会话、自定义标题（默认标题会触发
 * auto-title，又是一路请求）。
 *
 * R3 顺手把询问卡片截一张图（给人看的证据，不是断言）：写到环境变量 `SHUVIX_E2E_SHOTS` 指的
 * 目录；没设就写进实例的 fake HOME，随实例一起清掉。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest'
import { sleep, until } from '../../harness/cdp'
import { startFakeProvider, type FakeProvider, type FakeRequest } from '../../harness/fakeProvider'
import { launchApp, type E2EApp } from '../../harness/launch'
import { chatPane, sidebarPane, type ChatPane, type SidebarPane } from '../../harness/pages'
import { syncProbe } from '../../harness/sync'
import {
  REVIEW_EVENT_OPEN,
  createProject,
  asksRaisedIn,
  eventRecorder,
  isReviewerRequest,
  removeRetiredPolicy,
  requestSystemText,
  requestToolNames,
  reviewEventOf,
  reviewerTurn,
  securityDecisions,
  seedFakeProvider,
  seedRetiredPolicy,
  setSandboxEnabled,
  waitRendererReady,
  type EventRecorder,
  type PermissionRequestPayload,
  type RecordedEvent,
  type SecurityDecisionEntry
} from '../../harness/seed'

const MODEL = 'e2e-model'
/** 项目 CLAUDE.md 里的特征串：主 agent 的系统提示词里有（指令文件注入），审查员的没有 */
const PROJECT_RULE = 'PROJECT-RULE-MARKER'
/** 审查员的来源（内置 hook 名）—— 决策日志 review.source */
const REVIEW_SOURCE = 'auto-review'
/** 审查拒绝时工具错误里那句固定的「别绕过」 */
const NO_EVASION = 'Do not rephrase'
/** 子会话用例里一轮挂在 hold 里的上限：远长于要它挂着的时间，放行靠 `release(key)` */
const HOLD_MS = 30_000
/**
 * 父会话的 `wait` 在视图里已经在跑之后，再留给它登记成「握着这条子会话」的余量（中间只隔两次 memo 读写）：
 * 子会话停下来问 / 跑完时看「有没有 wait 握着」决定交回还是通知，所以放它往下走之前先过这一段
 */
const WAIT_ARMED_MS = 300

interface AskEvent extends RecordedEvent {
  request: {
    id: string
    kind: string
    command: string
    policyPrompt?: { text: string; policies: string[] } | null
    review?: { risk: string; summary: string; reason: string }
  }
}

interface ToolReviewEvent extends RecordedEvent {
  toolCallId: string
  reviewing: boolean
}

interface ToolBlock {
  type: string
  toolCallId?: string
  toolName?: string
  result?: string
  isError?: boolean
  details?: Record<string, unknown> | null
}

interface ListedMessage {
  id: string
  role: string
  content: string
  blocks?: ToolBlock[]
}

interface SessionRow {
  id: string
  title: string
  parentId: string | null
}

interface PolicyRow {
  name: string
  displayName: string
  source: 'builtin' | 'user'
}

let app: E2EApp
let provider: FakeProvider
let events: EventRecorder
let chat: ChatPane
let sidebar: SidebarPane
let projDir = ''
let projectId = ''
let markersDir = ''

/** 审查请求：任务文本里带 permission.request 的事件围栏（与认领用的工具表判据各自独立） */
const isReview = (r: FakeRequest): boolean => r.lastUserText.includes(REVIEW_EVENT_OPEN)
const reviewRequests = (): FakeRequest[] => provider.requests().filter(isReview)
const mainRequests = (): FakeRequest[] => provider.requests().filter((r) => !isReview(r))
/** 主 agent 的回合：不是审查请求 */
const notReviewer = (r: FakeRequest): boolean => !isReviewerRequest(r)

const newSession = (title: string): Promise<string> =>
  app.main.eval<string>(
    `window.api.session.create(${JSON.stringify({ title, projectId })}).then((s) => s.id)`
  )

/** 在主窗口里打开这条会话（列表由 session.listChanged 广播驱动，IPC 建的会话也会出现） */
const openInUi = async (title: string): Promise<void> => {
  await until(async () => (await sidebar.titles()).includes(title), `sidebar lists "${title}"`)
  expect(await sidebar.openSession(title)).toBe(true)
  await chat.ready()
}

/** 发 prompt 但不等它跑完 —— 询问 / 停止的用例里这一轮会停在半路 */
const sendPrompt = (sid: string, text: string): Promise<unknown> =>
  app.main.eval(
    `(() => {
      window.api.agent.prompt({ sessionId: ${JSON.stringify(sid)}, text: ${JSON.stringify(text)} })
        .catch(() => undefined)
      return true
    })()`
  )

const respond = (sid: string, requestId: string, allowed: boolean): Promise<unknown> =>
  app.main.eval(
    `window.api.agent.respondToInput(${JSON.stringify({
      sessionId: sid,
      requestId,
      response: { kind: 'ask', allowed }
    })})`
  )

const listMessages = (sid: string): Promise<ListedMessage[]> =>
  app.main.eval<ListedMessage[]>(`window.api.message.list(${JSON.stringify(sid)})`)

/** 该 toolCallId 的工具块（工具调用是助手卡片内的块） */
const toolBlock = async (sid: string, toolCallId: string): Promise<ToolBlock> => {
  const found = (await listMessages(sid))
    .flatMap((m) => m.blocks ?? [])
    .find((b) => b.type === 'tool' && b.toolCallId === toolCallId)
  expect(found, `tool block ${toolCallId} not in message.list`).toBeDefined()
  return found!
}

/** 这条会话（recorder 缓冲里）挂起过几条询问 —— `input_request` 不再上前端的线（Q-P3-04），数 `ask_count` */
const asksRaised = (sid: string): Promise<number> => asksRaisedIn(events, sid)

/** 下一张询问卡（从视图读；形状沿用旧事件，好让下面的断言不动） */
const waitAsk = async (sid: string): Promise<AskEvent> =>
  ({
    type: 'input_request',
    sessionId: sid,
    request: await syncProbe(app.main).nextAsk(sid)
  }) as unknown as AskEvent

/** 这次调用的 tool_review 事件序列（true = 审查中，false = 落定） */
const reviewingTrace = async (toolCallId: string): Promise<boolean[]> =>
  (await events.all())
    .filter(
      (e): e is ToolReviewEvent =>
        e.type === 'tool_review' && (e as ToolReviewEvent).toolCallId === toolCallId
    )
    .map((e) => e.reviewing)

const decisionsOf = (sid: string): SecurityDecisionEntry[] =>
  securityDecisions(app).filter((d) => d.sessionId === sid)

/**
 * 等本会话的决策日志攒够 n 条，再隔一小段重读一次 —— 「恰好 n 条」要排除一条迟到的
 * （日志文件是异步落盘的）
 */
const settledDecisions = async (sid: string, n: number): Promise<SecurityDecisionEntry[]> => {
  await until(() => decisionsOf(sid).length >= n, `${n} security decision(s) logged for ${sid}`)
  await sleep(300)
  return decisionsOf(sid)
}

const markerPath = (name: string): string => join(markersDir, `${name}.marker`)

const touchCall = (
  id: string,
  marker: string,
  description = 'Create an empty marker file'
): { id: string; name: string; args: string } => ({
  id,
  name: 'bash',
  args: JSON.stringify({ command: `touch ${marker}`, description })
})

const writeCall = (
  id: string,
  path: string,
  content: string
): { id: string; name: string; args: string } => ({
  id,
  name: 'write',
  args: JSON.stringify({ path, content })
})

const listPolicies = (): Promise<PolicyRow[]> =>
  app.main.eval<PolicyRow[]>(
    `window.api.policy.list().then((ps) => ps.map((p) => ({ name: p.name, displayName: p.displayName, source: p.source })))`
  )

/** 截图目录：设了 SHUVIX_E2E_SHOTS 就留在那里，没设就进 fake HOME（随实例清掉） */
const shotDir = (): string => process.env.SHUVIX_E2E_SHOTS || join(app.home, 'e2e-shots')

beforeAll(async () => {
  app = await launchApp({ autoReview: true })
  // 沙箱里的命令不问，也就轮不到审查；生效单位是会话运行时 —— 任何会话起运行时之前关掉
  await setSandboxEnabled(app.main, false)
  provider = await startFakeProvider()
  await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  await waitRendererReady(app.main)

  projDir = join(app.home, 'proj-review')
  markersDir = join(projDir, 'markers')
  mkdirSync(markersDir, { recursive: true })
  mkdirSync(join(projDir, 'src'), { recursive: true })
  // work 档案声明读 AGENTS.md, CLAUDE.md —— 主 agent 的系统提示词里会有它，审查员的不该有
  writeFileSync(join(projDir, 'CLAUDE.md'), `# Project rules\n\n${PROJECT_RULE}: keep it tidy.\n`)
  projectId = (await createProject(app.main, { name: 'ReviewProj', path: projDir })).id

  chat = chatPane(app.main)
  sidebar = sidebarPane(app.main)
  events = eventRecorder(app.main)
  await events.install()
})

afterAll(async () => {
  await provider?.close()
  await app?.stop()
})

describe('审查员的三种判决', () => {
  it('E2E-R1 [P0] allow → 不弹卡直接执行；审查员只看得到人写的话与操作本身', async () => {
    const title = 'R1-allow'
    const sid = await newSession(title)
    await openInUi(title)
    const marker = markerPath('r1')
    const command = `touch ${marker}`
    const summary = 'SUMMARY-R1 creates an empty marker file in the project'
    provider.reset()
    await events.clear()
    provider.script(
      {
        text: 'AGENT-PROSE-R1 I will create the marker now.',
        toolCalls: [touchCall('call_r1', marker, 'AGENT-RATIONALE-R1')],
        when: notReviewer
      },
      { text: 'R1 done.', when: notReviewer },
      reviewerTurn({
        decision: 'allow',
        risk: 'low',
        summary,
        reason: 'REASON-R1 ordinary work the user asked for'
      })
    )

    await chat.typeAndSend('Please create the marker file. USER-INTENT-R1')
    await events.waitFor('agent_end', { sessionId: sid })

    // 命令真的跑了，没有卡片
    expect(existsSync(marker)).toBe(true)
    expect(await asksRaised(sid)).toBe(0)

    // 审查请求恰一次（主 agent 收尾之后数），工具恰为档案的 read + 结果契约的 next
    const reviews = reviewRequests()
    expect(reviews).toHaveLength(1)
    const review = reviews[0]
    expect(requestToolNames(review)).toEqual(['read', 'next'])
    expect(review.lastUserText).toContain('<result_contract>')
    // 系统提示词是审查员自己的 md 正文：项目指令文件不注入（对照：主 agent 的请求里有）
    expect(requestSystemText(review)).not.toContain(PROJECT_RULE)
    const mains = mainRequests()
    expect(mains.length).toBeGreaterThan(0)
    expect(requestSystemText(mains[0])).toContain(PROJECT_RULE)
    // reasoning-blind：命令的 description 参数与 agent 的正文都不进审查员的输入
    expect(review.raw).not.toContain('AGENT-RATIONALE-R1')
    expect(review.raw).not.toContain('AGENT-PROSE-R1')

    // 事件围栏里的 payload —— 审查员的全部输入
    const payload: PermissionRequestPayload = reviewEventOf(review)
    expect(payload.sessionId).toBe(sid)
    expect(payload.agent).toEqual({ profile: 'work', kind: 'root' })
    expect(payload.operation.tool).toBe('bash')
    expect(payload.operation.action).toBe('execute')
    expect(payload.operation.objectType).toBe('command')
    expect(payload.operation.target).toBe(command)
    expect(payload.operation.facts.unconfinedReason).toBe(
      process.platform === 'darwin' ? 'disabled' : 'unsupported'
    )
    expect(payload.operation.facts.sandboxed).toBe(false)
    expect(payload.userMessages.some((m) => m.includes('USER-INTENT-R1'))).toBe(true)
    expect(payload.delegatedTasks).toEqual([])

    // 决策日志：一条，ask-on-command 胜出，审查放行，没有人的回答
    const decisions = await settledDecisions(sid, 1)
    expect(decisions).toHaveLength(1)
    const [decision] = decisions
    expect(decision.winning).toBe('ask-on-command#0')
    expect(decision.effect).toBe('ask')
    expect(decision.userResponse).toBeUndefined()
    expect(decision.review).toMatchObject({ decision: 'allow', risk: 'low', source: REVIEW_SOURCE })
    expect(typeof decision.review?.ms).toBe('number')
    expect(decision.subject).toMatchObject({
      kind: 'agent',
      profileName: 'work',
      agentKind: 'root'
    })

    // 工具卡的「审查中」：开始与落定各一次
    expect(await reviewingTrace('call_r1')).toEqual([true, false])

    // 「已审查」标记随工具结果落进会话树：message.list 投影出来的就是它
    const block = await toolBlock(sid, 'call_r1')
    expect(block.isError).toBeFalsy()
    expect(block.details?.shuvixReview).toEqual({ risk: 'low', summary })

    // DOM：那一行行尾挂着风险为 low 的盾牌
    const row = await until(
      async () =>
        (await chat.toolReviewMarks()).find((m) => m.name === 'bash' && m.reviewed !== null),
      'bash row with a reviewed mark'
    )
    expect(row.reviewed).toBe('low')
    expect(row.status).toBe('done')
    expect(row.reviewing).toBe(false)
  })

  it('E2E-R2 [P0] deny → 红行带审查员的理由，命令没跑、没有卡片，理由回到 agent 的下一次请求', async () => {
    const sid = await newSession('R2-deny')
    const marker = markerPath('r2')
    provider.reset()
    await events.clear()
    provider.script(
      { toolCalls: [touchCall('call_r2', marker)], when: notReviewer },
      { text: 'R2 understood.', when: notReviewer },
      reviewerTurn({
        decision: 'deny',
        risk: 'high',
        summary: 'SUMMARY-R2',
        reason: 'REVIEW-REASON-R2'
      })
    )

    await sendPrompt(sid, 'Create the R2 marker. USER-INTENT-R2')
    await events.waitFor('agent_end', { sessionId: sid })

    const block = await toolBlock(sid, 'call_r2')
    expect(block.isError).toBe(true)
    expect(block.result?.startsWith('Blocked by the reviewer: REVIEW-REASON-R2')).toBe(true)
    expect(block.result).toContain(NO_EVASION)
    // 拒绝不挂「已审查」标记：红行的文字就是审查员的理由
    expect(block.details?.shuvixReview).toBeUndefined()

    expect(existsSync(marker)).toBe(false)
    expect(await asksRaised(sid)).toBe(0)
    expect(reviewRequests()).toHaveLength(1)

    // 主 agent 的下一次请求带着这段理由（工具结果）
    const mains = mainRequests()
    expect(mains).toHaveLength(2)
    expect(mains[1].raw).toContain('Blocked by the reviewer: REVIEW-REASON-R2')

    const [decision] = await settledDecisions(sid, 1)
    expect(decision.review).toMatchObject({ decision: 'deny', risk: 'high', source: REVIEW_SOURCE })
    expect(decision.userResponse).toBeUndefined()
  })

  it('E2E-R3 [P0] ask → 照旧弹卡，卡片附上审查意见；人允许后执行，不挂「已审查」', async () => {
    const title = 'R3-ask'
    const sid = await newSession(title)
    await openInUi(title)
    const marker = markerPath('r3')
    const askOnCommand = (await listPolicies()).find(
      (p) => p.name === 'ask-on-command' && p.source === 'builtin'
    )!
    provider.reset()
    await events.clear()
    provider.script(
      { toolCalls: [touchCall('call_r3', marker)], when: notReviewer },
      { text: 'R3 done.', when: notReviewer },
      reviewerTurn({ decision: 'ask', risk: 'high', summary: 'SUMMARY-R3', reason: 'REASON-R3' })
    )

    await chat.typeAndSend('Create the R3 marker. USER-INTENT-R3')
    const ask = await waitAsk(sid)
    // 审查意见逐字送到渲染端（只带写给人看的三项，不带 decision）
    expect(ask.request.review).toStrictEqual({
      risk: 'high',
      summary: 'SUMMARY-R3',
      reason: 'REASON-R3'
    })
    // 策略的提示语照旧在
    expect(ask.request.policyPrompt?.text).toBeTruthy()
    expect(ask.request.policyPrompt?.policies).toContain(askOnCommand.displayName)

    // DOM：审查意见块在卡片上，风险 high，一句话与理由都在
    const shown = await until(() => chat.pendingAskReview(), 'review opinion on the ask card')
    expect(shown.risk).toBe('high')
    expect(shown.summary).toBe('SUMMARY-R3')
    expect(shown.reason).toBe('REASON-R3')
    expect(shown.text).toContain('SUMMARY-R3')
    expect(shown.text).toContain('REASON-R3')
    // 给人看的证据
    await chat.screenshotPendingAsk(join(shotDir(), 'ask-card-review.png'))

    await respond(sid, ask.request.id, true)
    await events.waitFor('agent_end', { sessionId: sid })

    expect(existsSync(marker)).toBe(true)
    // 审查只一次：交给人之后不会再审
    expect(reviewRequests()).toHaveLength(1)

    const [decision] = await settledDecisions(sid, 1)
    expect(decision.review).toMatchObject({ decision: 'ask', risk: 'high', source: REVIEW_SOURCE })
    expect(decision.userResponse).toBe('allowed')

    // 人拍板的那次不挂「已审查」标记
    const block = await toolBlock(sid, 'call_r3')
    expect(block.isError).toBeFalsy()
    expect(block.details?.shuvixReview).toBeUndefined()
  })
})

describe('只问人的门', () => {
  it('E2E-R5 [P0] 用户写的 force-ask 只问人、不经审查（照抄退役的 protect-shuvix-config）；[P1] 撤掉它，写 ~/.shuvix/agents 就是普通的 ask-on-external-path，先经审查', async () => {
    const target = join(app.home, '.shuvix', 'agents', 'e2e-probe.md')
    const content = '---\nshuvix: agent v1\nname: e2e-probe\n---\n\nPROBE BODY.\n'

    // 出厂不再有 force-ask（2026-10-01 删了 protect-shuvix-config）：把它原样装成用户策略
    await seedRetiredPolicy(app, 'protect-shuvix-config')
    try {
      const sid = await newSession('R5-config')
      provider.reset()
      await events.clear()
      provider.script(
        { toolCalls: [writeCall('call_r5', target, content)], when: notReviewer },
        { text: 'R5-config done.', when: notReviewer }
      )
      await sendPrompt(sid, 'Add an agent file for me. USER-INTENT-R5')

      const ask = await waitAsk(sid)
      // force-ask 只问人：卡片上没有审查意见，也没有审查请求、没有「审查中」
      expect(ask.request.review).toBeUndefined()
      await respond(sid, ask.request.id, false)
      await events.waitFor('agent_end', { sessionId: sid })

      expect(existsSync(target)).toBe(false)
      expect(reviewRequests()).toHaveLength(0)
      expect(await reviewingTrace('call_r5')).toEqual([])
      const [decision] = await settledDecisions(sid, 1)
      expect(decision.winning).toBe('protect-shuvix-config#0')
      expect(decision.review).toBeUndefined()
      expect(decision.userResponse).toBe('denied')
    } finally {
      await removeRetiredPolicy(app, 'protect-shuvix-config')
    }

    // P1：出厂行为 —— 会话目录之外的一次普通写入，ask-on-external-path 的写规则问，先交给审查员（这里审查员拒）
    const sid = await newSession('R5-config-default')
    provider.reset()
    await events.clear()
    provider.script(
      { toolCalls: [writeCall('call_r5_default', target, content)], when: notReviewer },
      { text: 'R5-config-default done.', when: notReviewer },
      reviewerTurn({
        decision: 'deny',
        risk: 'high',
        summary: 'SUMMARY-R5',
        reason: 'REASON-R5 changes an agent definition'
      })
    )
    await sendPrompt(sid, 'Add an agent file for me. USER-INTENT-R5')
    await events.waitFor('agent_end', { sessionId: sid })

    expect(existsSync(target)).toBe(false)
    expect(await asksRaised(sid)).toBe(0)
    expect(reviewRequests()).toHaveLength(1)
    expect(reviewEventOf(reviewRequests()[0]).operation.facts.path).toBe(target)
    const [decision] = await settledDecisions(sid, 1)
    expect(decision.winning).toBe('ask-on-external-path#1')
    expect(decision.review).toMatchObject({ decision: 'deny', source: REVIEW_SOURCE })
  })

  it('E2E-R7 [P1] 沙箱关着时会话目录照样免询问：工作区里的普通文件与 .git/hooks 直接写；会话目录以外的一次写入经审查放行后落盘', async () => {
    const sid = await newSession('R7-workspace')
    const plain = join(projDir, 'src', 'r7.txt')
    const hook = join(projDir, '.git', 'hooks', 'r7')
    const outside = join(app.home, 'outside-review', 'r7.txt')
    const outsideContent = 'R7-OUTSIDE-CONTENT\n'
    provider.reset()
    await events.clear()
    provider.script(
      { toolCalls: [writeCall('call_r7a', plain, 'R7-PLAIN-CONTENT\n')], when: notReviewer },
      { toolCalls: [writeCall('call_r7b', hook, '# R7-HOOK\n')], when: notReviewer },
      { toolCalls: [writeCall('call_r7c', outside, outsideContent)], when: notReviewer },
      { text: 'R7 done.', when: notReviewer },
      reviewerTurn({
        decision: 'allow',
        risk: 'medium',
        summary: 'SUMMARY-R7 writes a file outside the project',
        reason: 'REASON-R7'
      })
    )
    await sendPrompt(sid, 'Write the three files. USER-INTENT-R7')
    await events.waitFor('agent_end', { sessionId: sid })

    expect(readFileSync(plain, 'utf8')).toBe('R7-PLAIN-CONTENT\n')
    expect(readFileSync(hook, 'utf8')).toBe('# R7-HOOK\n')
    expect(readFileSync(outside, 'utf8')).toBe(outsideContent)
    expect(await asksRaised(sid)).toBe(0)

    // 工作区里（.git/hooks 不再受保护）：没人问、没审查；会话目录以外：审查一次
    const reviews = reviewRequests()
    expect(reviews).toHaveLength(1)
    const payload = reviewEventOf(reviews[0])
    expect(payload.operation.tool).toBe('write')
    expect(payload.operation.objectType).toBe('path')
    expect(payload.operation.action).toBe('write')
    expect(payload.operation.facts.path).toBe(outside)
    expect(String(payload.operation.facts.diff)).toContain('R7-OUTSIDE-CONTENT')
    expect(payload.operation.facts.isNewFile).toBe(true)

    const decisions = await settledDecisions(sid, 3)
    expect(decisions).toHaveLength(3)
    for (const path of [plain, hook]) {
      const d = decisions.find((x) => x.objectSummary === path)
      expect(d, path).toMatchObject({ winning: 'default:path', effect: 'allow' })
      expect(d?.review, path).toBeUndefined()
    }
    const outsideDecision = decisions.find((d) => d.objectSummary === outside)
    expect(outsideDecision).toMatchObject({ winning: 'ask-on-external-path#1', effect: 'ask' })
    expect(outsideDecision?.review).toMatchObject({ decision: 'allow', risk: 'medium' })
    expect(await reviewingTrace('call_r7a')).toEqual([])
    expect(await reviewingTrace('call_r7b')).toEqual([])
    expect(await reviewingTrace('call_r7c')).toEqual([true, false])
  })
})

describe('审查的生命周期', () => {
  it('E2E-R8 [P1] 审查途中停止会话 → 审查当场中止（不等它 20 秒），命令没跑、没有卡片', async () => {
    const title = 'R8-stop'
    const sid = await newSession(title)
    await openInUi(title)
    const marker = markerPath('r8')
    provider.reset()
    await events.clear()
    provider.script(
      { toolCalls: [touchCall('call_r8', marker)], when: notReviewer },
      { text: 'R8 should not get here.', when: notReviewer },
      reviewerTurn(
        { decision: 'allow', risk: 'low', summary: 'SUMMARY-R8', reason: 'REASON-R8' },
        { holdMs: 20_000 }
      )
    )
    await sendPrompt(sid, 'Create the R8 marker. USER-INTENT-R8')

    const review = await until(() => {
      const reviews = reviewRequests()
      return reviews.length === 1 && provider.holding() ? reviews[0] : null
    }, 'review request arrived and is being held')
    // 审查进行中：工具卡状态槽是「审查中」（tool_review → 渲染端），不是一个转着的运行态
    await until(
      async () => (await chat.toolReviewMarks()).some((m) => m.name === 'bash' && m.reviewing),
      'bash row shows the reviewing state'
    )
    const t0 = Date.now()
    await app.main.eval(`window.api.agent.abort(${JSON.stringify(sid)})`)
    await until(() => review.aborted, 'review request aborted', 5_000)
    expect(Date.now() - t0).toBeLessThan(5_000)
    await events.waitFor('agent_end', { sessionId: sid })
    await until(
      async () => !(await chat.toolReviewMarks()).some((m) => m.reviewing),
      'reviewing state cleared after the stop'
    )

    expect(existsSync(marker)).toBe(false)
    expect(await asksRaised(sid)).toBe(0)
    const [decision] = await settledDecisions(sid, 1)
    expect(decision.userResponse).toBe('cancel')
    expect(decision.review).toBeUndefined()
    await until(
      async () => (await reviewingTrace('call_r8')).join() === 'true,false',
      'tool_review settled after the stop'
    )
  })

  it('E2E-R9 [P2] 同一会话被连续拒绝 3 次之后，第 4 条命令直接问人、卡片不带审查意见', async () => {
    const sid = await newSession('R9-streak')
    const markers = [1, 2, 3, 4].map((i) => markerPath(`r9-${i}`))
    provider.reset()
    await events.clear()
    provider.script(
      ...markers.map((m, i) => ({
        toolCalls: [touchCall(`call_r9_${i + 1}`, m)],
        when: notReviewer
      })),
      { text: 'R9 done.', when: notReviewer },
      ...[1, 2, 3].map((i) =>
        reviewerTurn({
          decision: 'deny',
          risk: 'high',
          summary: `SUMMARY-R9-${i}`,
          reason: `REASON-R9-${i}`
        })
      )
    )
    await sendPrompt(sid, 'Create the four R9 markers. USER-INTENT-R9')

    const ask = await waitAsk(sid)
    expect(ask.request.command).toContain('r9-4')
    expect(ask.request.review).toBeUndefined()
    await respond(sid, ask.request.id, true)
    await events.waitFor('agent_end', { sessionId: sid })

    expect(reviewRequests()).toHaveLength(3)
    expect(markers.map((m) => existsSync(m))).toEqual([false, false, false, true])
    for (const i of [1, 2, 3]) {
      const block = await toolBlock(sid, `call_r9_${i}`)
      expect(block.isError).toBe(true)
      expect(block.result).toContain(`Blocked by the reviewer: REASON-R9-${i}`)
    }
    const decisions = await settledDecisions(sid, 4)
    expect(decisions.map((d) => d.review?.decision ?? null)).toEqual(['deny', 'deny', 'deny', null])
    expect(decisions[3].userResponse).toBe('allowed')
  })
})

describe('子会话', () => {
  it('E2E-R10 [P2] 开子会话本身经审查；子会话里的命令被审查时，人写的话取父会话、派进来的任务单列', async () => {
    const parentTitle = 'R10-parent'
    const childTitle = 'R10-child'
    const askCreate = 'USER-INTENT-R10 open a helper session for me'
    const askDelegate = 'USER-INTENT-R10-B now hand it the marker task'
    const delegated = 'DELEGATED-TASK-R10 create the marker file'
    const parentSid = await newSession(parentTitle)
    const byText =
      (text: string) =>
      (r: FakeRequest): boolean =>
        notReviewer(r) && r.lastUserText === text

    // ① 父 agent 开子会话：出厂不问（2026-10-01 删了 ask-on-sub-session）—— 把它原样装成用户
    //    策略，开子会话就要问 → 先交给审查员。② 的 prompt-sub-session 不在它的范围里
    await seedRetiredPolicy(app, 'ask-on-sub-session')
    onTestFinished(() => removeRetiredPolicy(app, 'ask-on-sub-session'))
    provider.reset()
    await events.clear()
    provider.script(
      {
        toolCalls: [
          {
            id: 'call_r10_create',
            name: 'session',
            args: JSON.stringify({ action: 'create-sub-session', title: childTitle })
          }
        ],
        when: byText(askCreate)
      },
      { text: 'created.', when: byText(askCreate) },
      reviewerTurn({
        decision: 'allow',
        risk: 'low',
        summary: 'SUMMARY-R10-create',
        reason: 'REASON-R10-create'
      })
    )
    await sendPrompt(parentSid, askCreate)
    await events.waitFor('agent_end', { sessionId: parentSid })

    const createReviews = reviewRequests()
    expect(createReviews).toHaveLength(1)
    const createPayload = reviewEventOf(createReviews[0])
    expect(createPayload.operation.tool).toBe('session: create-sub-session')
    expect(createPayload.operation.objectType).toBe('invocation')
    expect(createPayload.sessionId).toBe(parentSid)
    expect(await asksRaised(parentSid)).toBe(0)

    const child = (await app.main.eval<SessionRow[]>(`window.api.session.list()`)).find(
      (s) => s.parentId === parentSid && s.title === childTitle
    )
    expect(child, 'sub-session created after the review allowed it').toBeDefined()
    const childSid = child!.id

    // ② 父 agent 把任务派进去（只回执，§20）：子会话里的 bash 同样经审查；子会话跑完由完成通知叫醒父会话
    const marker = markerPath('r10')
    const wokenByCompletion = (r: FakeRequest): boolean =>
      notReviewer(r) &&
      r.lastUserText.includes(`<session id="${childSid}"`) &&
      r.lastUserText.includes('has finished')
    provider.reset()
    await events.clear()
    provider.script(
      {
        toolCalls: [
          {
            id: 'call_r10_prompt',
            name: 'session',
            args: JSON.stringify({
              action: 'prompt-session',
              session_id: childSid,
              message: delegated
            })
          }
        ],
        when: byText(askDelegate)
      },
      { toolCalls: [touchCall('call_r10_child', marker)], when: byText(delegated) },
      { text: 'CHILD DONE R10.', when: byText(delegated) },
      { text: 'parent done.', when: byText(askDelegate) },
      // 被完成通知叫醒的那一轮（空闲的父会话自动续跑）
      { text: 'parent collected R10.', when: wokenByCompletion },
      reviewerTurn({
        decision: 'allow',
        risk: 'low',
        summary: 'SUMMARY-R10-child',
        reason: 'REASON-R10-child'
      })
    )
    await sendPrompt(parentSid, askDelegate)
    // 父会话那一轮拿到回执就收尾了：要等的是子会话那一轮跑完、被它叫醒的父会话那一轮也落定
    await events.waitFor('agent_end', { sessionId: childSid, timeoutMs: 60_000 })
    await syncProbe(app.main).waitView(
      parentSid,
      (v) =>
        v.run.state !== 'busy' &&
        v.messages.some(
          (m) => m.role === 'assistant' && m.content.includes('parent collected R10.')
        ),
      60_000,
      'parent woken by the completion notice and settled'
    )

    expect(existsSync(marker)).toBe(true)
    const childReviews = reviewRequests()
    expect(childReviews).toHaveLength(1)
    const payload = reviewEventOf(childReviews[0])
    expect(payload.sessionId).toBe(childSid)
    expect(payload.operation.target).toBe(`touch ${marker}`)
    // 人说的话取顶层会话：父会话里人发的两条都在，派进来的任务不算人写的
    expect(payload.userMessages.some((m) => m.includes(askCreate))).toBe(true)
    expect(payload.userMessages.some((m) => m.includes(askDelegate))).toBe(true)
    expect(payload.userMessages.some((m) => m.includes('DELEGATED-TASK-R10'))).toBe(false)
    // 子会话自己的「用户消息」是父 agent 写的任务，单列
    expect(payload.delegatedTasks).toEqual([delegated])
    expect(await asksRaised(childSid)).toBe(0)
  })

  it('E2E-R13 [P0] 代答不算授权：父会话代答「删掉」之后子会话跑命令，审查员的载荷把代答列进 delegatedTasks，人写的话里没有它', async () => {
    const intent = 'USER-INTENT-R13'
    const delegated = 'DELEGATED-TASK-R13'
    const yes = 'OPT-R13-YES'
    const parentSid = await newSession('R13-parent')
    // 子会话 IPC 直建（parentId；项目随父会话），不经 create-sub-session —— 这里测的是代答，不是开子会话
    const childSid = await app.main.eval<string>(
      `window.api.session.create(${JSON.stringify({ parentId: parentSid, title: 'R13-child' })}).then((s) => s.id)`
    )
    const marker = markerPath('r13')
    // 审查员的任务文本里有父会话的人话：两边的回合都先排除审查请求
    const parentTurn = (r: FakeRequest): boolean => notReviewer(r) && r.lastUserText === intent
    const childTurn = (r: FakeRequest): boolean => notReviewer(r) && r.lastUserText === delegated

    const probe = syncProbe(app.main)
    /** 等某个 hold 槽里挂着的恰好是子会话的那一步 */
    const childHeld = (key: string): Promise<unknown> =>
      until(() => {
        const held = provider.heldRequest(key)
        return held && childTurn(held) ? held : null
      }, `child step held in "${key}"`)
    /** 等父会话的某次 wait 真的挂上了（视图里在跑 + 登记余量） */
    const waitArmed = async (callId: string): Promise<void> => {
      await probe.waitView(
        parentSid,
        (v) => v.toolRuns[callId]?.status === 'running',
        30_000,
        `${callId} running`
      )
      await sleep(WAIT_ARMED_MS)
    }

    provider.reset()
    await events.clear()
    provider.script(
      // 派活只回执（§20）；子会话的每一步都挂着，等父会话的 wait 握着它再放 —— 询问与答复都由 wait 在这一轮里
      // 交回（不经通知、不靠计时）
      {
        toolCalls: [
          {
            id: 'call_r13_prompt',
            name: 'session',
            args: JSON.stringify({
              action: 'prompt-session',
              session_id: childSid,
              message: delegated
            })
          }
        ],
        when: parentTurn
      },
      {
        toolCalls: [
          {
            id: 'call_r13_ask',
            name: 'ask',
            args: JSON.stringify({
              question: 'Q-R13 clean the marker?',
              options: [
                { label: yes, description: '' },
                { label: 'OPT-R13-NO', description: '' }
              ]
            })
          }
        ],
        when: childTurn,
        holdMs: HOLD_MS,
        holdKey: 'child'
      },
      {
        toolCalls: [
          {
            id: 'call_r13_wait1',
            name: 'session',
            args: JSON.stringify({ action: 'wait-for-sessions', session_id: childSid })
          }
        ],
        when: parentTurn
      },
      // 父会话代用户答「是」（只回执）
      {
        toolCalls: [
          {
            id: 'call_r13_answer',
            name: 'session',
            args: JSON.stringify({ action: 'answer-session', selections: [yes] })
          }
        ],
        when: parentTurn
      },
      { toolCalls: [touchCall('call_r13_touch', marker)], when: childTurn },
      reviewerTurn({
        decision: 'allow',
        risk: 'low',
        summary: 'SUMMARY-R13',
        reason: 'REASON-R13'
      }),
      { text: 'CHILD DONE R13.', when: childTurn, holdMs: HOLD_MS, holdKey: 'child2' },
      {
        toolCalls: [
          {
            id: 'call_r13_wait2',
            name: 'session',
            args: JSON.stringify({ action: 'wait-for-sessions', session_id: childSid })
          }
        ],
        when: parentTurn
      },
      { text: 'parent done.', when: parentTurn }
    )
    await sendPrompt(parentSid, intent)
    await childHeld('child')
    await waitArmed('call_r13_wait1')
    provider.release('child')
    await childHeld('child2')
    await waitArmed('call_r13_wait2')
    provider.release('child2')
    await events.waitFor('agent_end', { sessionId: parentSid, timeoutMs: 60_000 })

    // 父会话那一轮里：询问由 wait 交回；代答只回执；子会话的答复由下一次 wait 交回
    const asking = await toolBlock(parentSid, 'call_r13_wait1')
    expect(asking.result).toContain('<sessions status="asking">')
    expect(asking.result).toContain('Q-R13 clean the marker?')
    const answered = await toolBlock(parentSid, 'call_r13_answer')
    expect(answered.isError).toBeFalsy()
    expect(answered.result).toContain('Answered; it carries on in the background.')
    expect(answered.result).not.toContain('CHILD DONE R13.')
    const collected = await toolBlock(parentSid, 'call_r13_wait2')
    expect(collected.isError).toBeFalsy()
    expect(collected.result).toContain('<reply>\nCHILD DONE R13.\n</reply>')

    // 1. 恰好一次审查：子会话里那条命令；放行之后真的跑了
    expect(existsSync(marker)).toBe(true)
    const reviews = reviewRequests()
    expect(reviews).toHaveLength(1)
    const payload = reviewEventOf(reviews[0])
    expect(payload.sessionId).toBe(childSid)
    expect(payload.operation.target).toBe(`touch ${marker}`)

    // 2. 人写的话取父会话里人发的那条，代答不在其中 —— 否则「对，删掉」就成了用户的同意
    expect(payload.userMessages.some((m) => m.includes(intent))).toBe(true)
    expect(payload.userMessages.some((m) => m.includes(yes))).toBe(false)

    // 3. 代答与派进来的任务一样，只是声明：列进 delegatedTasks
    expect(payload.delegatedTasks.some((t) => t.includes(delegated))).toBe(true)
    expect(
      payload.delegatedTasks.some(
        (t) => t.includes('the parent session answered') && t.includes(yes)
      )
    ).toBe(true)
  }, 90_000)
})

describe('停用开关', () => {
  it('E2E-R11 [P2] 停用内置 auto-review（md 扩展元数据的停用开关）→ 询问直接到卡片：没有审查请求、卡片不带审查意见；重新启用 → 审查请求回来', async () => {
    const setReview = (enabled: boolean): Promise<{ success: boolean }> =>
      app.main.eval(
        `window.api.mdMeta.setEnabled(${JSON.stringify({ objectId: 'hook:builtin:auto-review', enabled })})`
      )
    const reviewHook = async (): Promise<{ disabled?: boolean } | undefined> =>
      (
        await app.main.eval<Array<{ name: string; source: string; disabled?: boolean }>>(
          'window.api.hook.list()'
        )
      ).find((h) => h.name === REVIEW_SOURCE && h.source === 'builtin')
    onTestFinished(async () => {
      await setReview(true)
    })

    expect(await setReview(false)).toEqual({ success: true })
    expect((await reviewHook())?.disabled).toBe(true)

    // ① 停用：命令照旧问，但问的是人 —— 审查员一次都没被派出去
    const offSid = await newSession('R11-review-off')
    const offMarker = markerPath('r11-off')
    provider.reset()
    await events.clear()
    provider.script(
      { toolCalls: [touchCall('call_r11_off', offMarker)], when: notReviewer },
      { text: 'R11 off done.', when: notReviewer }
    )
    await sendPrompt(offSid, 'Create the R11 marker while the review is off.')
    const ask = await waitAsk(offSid)
    expect(ask.request.review).toBeUndefined()
    expect(provider.requests().filter(isReviewerRequest)).toEqual([])
    expect(reviewRequests()).toEqual([])
    await respond(offSid, ask.request.id, true)
    await events.waitFor('agent_end', { sessionId: offSid })
    expect(existsSync(offMarker)).toBe(true)
    expect(provider.requests().filter(isReviewerRequest)).toEqual([])
    const [offDecision] = await settledDecisions(offSid, 1)
    expect(offDecision.review).toBeUndefined()
    expect(offDecision.userResponse).toBe('allowed')

    // ② 重新启用：同样的命令先交给审查员，放行后不弹卡
    expect(await setReview(true)).toEqual({ success: true })
    expect((await reviewHook())?.disabled).toBeUndefined()
    const onSid = await newSession('R11-review-on')
    const onMarker = markerPath('r11-on')
    provider.reset()
    await events.clear()
    provider.script(
      { toolCalls: [touchCall('call_r11_on', onMarker)], when: notReviewer },
      { text: 'R11 on done.', when: notReviewer },
      reviewerTurn({
        decision: 'allow',
        risk: 'low',
        summary: 'SUMMARY-R11',
        reason: 'REASON-R11'
      })
    )
    await sendPrompt(onSid, 'Create the R11 marker with the review back on.')
    await events.waitFor('agent_end', { sessionId: onSid })
    expect(existsSync(onMarker)).toBe(true)
    expect(await asksRaised(onSid)).toBe(0)
    const reviews = provider.requests().filter(isReviewerRequest)
    expect(reviews).toHaveLength(1)
    expect(requestToolNames(reviews[0])).toEqual(['read', 'next'])
  })
})

describe('审查员读文件', () => {
  it('E2E-R12 [P1] 审查员先 read 被运行的脚本再交卷：工作区里的脚本读得到，家目录里会话目录外的文件被拒（不弹卡）；它的读取不进之后的 recentOperations', async () => {
    const title = 'R12-reviewer-reads'
    const sid = await newSession(title)
    const marker = markerPath('r12')
    const marker2 = markerPath('r12-second')
    // 被运行的脚本在工作区（项目目录 = 会话目录）里；那句特征串只在脚本里，审查员读过才看得到
    const scriptRel = 'scripts/build-r12.sh'
    const scriptAbs = join(projDir, scriptRel)
    mkdirSync(join(projDir, 'scripts'), { recursive: true })
    writeFileSync(scriptAbs, `#!/bin/sh\n# SCRIPT-BODY-R12\ntouch ${marker}\n`)
    // 家目录里、会话目录外：被审的 agent 读它要问，审查员读它就被拒
    const outside = join(app.home, 'r12-outside.txt')
    writeFileSync(outside, 'OUTSIDE-SECRET-R12\n')
    const readCall = (id: string, path: string): { id: string; name: string; args: string } => ({
      id,
      name: 'read',
      args: JSON.stringify({ path })
    })

    provider.reset()
    await events.clear()
    provider.script(
      {
        toolCalls: [
          {
            id: 'call_r12',
            name: 'bash',
            args: JSON.stringify({ command: `bash ${scriptRel}`, description: 'Run the build' })
          }
        ],
        when: notReviewer
      },
      { text: 'R12 done.', when: notReviewer },
      // 审查员第一轮：同一批里读脚本与那份家目录里的文件
      {
        toolCalls: [
          readCall('call_r12_read_script', scriptAbs),
          readCall('call_r12_read_out', outside)
        ],
        when: (req) => isReviewerRequest(req) && !req.raw.includes('SCRIPT-BODY-R12'),
        usage: { prompt: 60, completion: 8 }
      },
      // 第二轮：读过脚本了，放行
      reviewerTurn(
        {
          decision: 'allow',
          risk: 'low',
          summary: 'SUMMARY-R12 runs the project build script',
          reason: 'REASON-R12 the script only touches a marker in the project'
        },
        { when: (req) => req.raw.includes('SCRIPT-BODY-R12') }
      )
    )

    await sendPrompt(sid, 'Run the project build script.')
    await events.waitFor('agent_end', { sessionId: sid })

    // 命令真的跑了，从头到尾没有卡片（审查员那次被拒的读取也没有）
    expect(existsSync(marker)).toBe(true)
    expect(await asksRaised(sid)).toBe(0)

    // 审查员的两次请求：第二次带着脚本原文与那次拒绝，不带家目录里那份文件的内容
    const reviews = provider.requests().filter(isReviewerRequest)
    expect(reviews).toHaveLength(2)
    expect(reviews[0].raw).not.toContain('SCRIPT-BODY-R12')
    expect(reviews[1].raw).toContain('SCRIPT-BODY-R12')
    expect(reviews[1].raw).toContain('no way to ask')
    expect(reviews[1].raw).not.toContain('OUTSIDE-SECRET-R12')
    expect(reviews.every((r) => !r.raw.includes('OUTSIDE-SECRET-R12'))).toBe(true)

    // 决策日志：审查员的两次读（主体是派生的 permission-reviewer）+ 那条命令（审查放行）
    const decisions = await settledDecisions(sid, 3)
    expect(decisions).toHaveLength(3)
    const reads = decisions.filter((d) => d.toolName === 'read')
    expect(reads).toHaveLength(2)
    for (const read of reads) {
      expect(read.subject).toMatchObject({
        kind: 'agent',
        profileName: 'permission-reviewer',
        agentKind: 'spawned'
      })
      expect(read.review).toBeUndefined()
      expect(read.userResponse).toBeUndefined()
    }
    const scriptRead = reads.find((d) => d.toolCallId === 'call_r12_read_script')
    expect(scriptRead?.effect).toBe('allow')
    const outsideRead = reads.find((d) => d.toolCallId === 'call_r12_read_out')
    expect(outsideRead).toMatchObject({ effect: 'ask', winning: 'ask-on-external-path#0' })
    const command = decisions.find((d) => d.toolCallId === 'call_r12')
    expect(command).toMatchObject({ effect: 'ask', winning: 'ask-on-command#0' })
    expect(command?.subject).toMatchObject({ profileName: 'work', agentKind: 'root' })
    expect(command?.review).toMatchObject({ decision: 'allow', source: REVIEW_SOURCE })

    // 同一会话的下一条命令再审一次：recentOperations 里有上一条命令，没有审查员的读取
    provider.reset()
    await events.clear()
    provider.script(
      { toolCalls: [touchCall('call_r12_second', marker2)], when: notReviewer },
      { text: 'R12 second done.', when: notReviewer },
      reviewerTurn({
        decision: 'allow',
        risk: 'low',
        summary: 'SUMMARY-R12b',
        reason: 'REASON-R12b'
      })
    )
    await sendPrompt(sid, 'Create the second R12 marker.')
    await events.waitFor('agent_end', { sessionId: sid })
    expect(existsSync(marker2)).toBe(true)
    const [second] = provider.requests().filter(isReviewerRequest)
    expect(second).toBeDefined()
    const ops = reviewEventOf(second).recentOperations
    expect(ops.map((op) => op.target)).toContain(`bash: bash ${scriptRel}`)
    expect(ops.filter((op) => op.target.startsWith('read:'))).toEqual([])
  })
})
