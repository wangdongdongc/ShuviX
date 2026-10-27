/**
 * 会话访问（2026-10-20）—— `session` 工具与一条**不是自己子会话**的会话交互，整条链路在真实实例里跑一遍：
 *
 *   用户在输入框里 @ 一条会话（「Sessions」源，`[session: id <id> — "<title>"]` 进模型的消息）→ 模型调
 *   `session` 工具点名那个 id → 运行器落定目标（relation other）→ 工具的授权回调 → 安全模块的会话客体
 *   `{type:'session', sessionId, title, ownTurn}` → 出厂的 ask-on-session-access 询问（查看 = read、对话 = write）→
 *   卡片（「Read / Talk to another session」，对话类摆出要发进去的那段话）→ 用户答：允许一次 / 拒绝 /
 *   「允许并记住」（`extra.remember: true` → 调用方权限表里一行 `kind:'session'`）→ 会话设置「Session access」卡
 *   在查看与对话之间切换、删掉。内置 auto-review 开着，但它跳过会话客体：这种卡只有人答（审查员一次都不被派出）。
 *
 *   XS-E1  @ 一条会话 → 消息里带它的 id 与标题 → prompt-session 弹「对话」卡（目标 + 消息原文）→ 审查员不出场 →
 *          「允许并记住」→ 权限表恰一行（session / B / write / user）→ 设置里「Session access」一行、选中 Talk →
 *          B 的转写里那条消息是用户消息 → 这一轮结束之后再发一次，不再问、照样送达
 *   XS-E2  另一条调用方 A2：inspect 弹「查看」卡（没有消息块），允许一次不留行；read 再问，拒绝 → 工具结果是
 *          「User denied reading session …」；read + 允许并记住 → 一行 read；prompt 照旧问「对话」（查看不含对话）；
 *          设置里切到 Talk → 下一次 prompt 不问；删掉那一行 → 下一次 read 又问
 *   XS-E3  记住了「对话」的 A 往 B 里派活（B 的那一轮挂住）→ A 的任务页那一行读「Session · Running」→ 放行 →
 *          A 恰收到一条完成通知，指向 `wait-for-sessions` with `session_id "<B>"` → 照做交回 settled + B 的答复 →
 *          删掉 B → 指向它的行没了、A 的「Session access」卡消失、list-sessions 不再列出它
 *
 * 模型侧是脚本化的假提供商，每个回合**按内容认领**：A 的请求里恒有它第一条消息的标记 `A_MARK`（A2 同理），B 的
 * 请求两者都没有、且最后一条用户消息恰为发进去的那段话；审查员按工具表认（harness `isReviewerRequest`）。
 * B 的那一轮挂在具名 hold 槽 `target` 里，A 那一轮先收尾再放（完成通知是自动续跑一轮还是插进当前轮全凭时序）。
 *
 * 「这一轮是不是调用方自己发起的」（ownTurn）按目标会话里最近一条有人说的用户消息的来源判：A 往 B 发过之后，A 读 B
 * 不再问。所以 XS-E2 用另一条调用方 A2；它自己往 B 发过之后，要验证「删掉那一行又问」得先让用户在 B 里说一句。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import type { AskInputRequest } from '@shuvix/chat-protocol/types/inputRequest'
import { sleep, until } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import { startFakeProvider, type FakeProvider, type FakeRequest } from '../../harness/fakeProvider'
import {
  asksRaisedIn,
  createProject,
  eventRecorder,
  isReviewerRequest,
  securityDecisions,
  seedFakeProvider,
  sqlLit,
  sqliteJson,
  waitRendererReady,
  type EventRecorder,
  type SecurityDecisionEntry
} from '../../harness/seed'
import { syncProbe, type SyncProbe, type ToolResult } from '../../harness/sync'
import {
  atPopoverPane,
  chatPane,
  sessionAccessPane,
  sessionAskPane,
  sessionConfigPane,
  sidebarPane,
  tasksPanelPane,
  type AtPopoverPane,
  type ChatPane,
  type SessionAccessPane,
  type SessionAskPane,
  type SessionConfigPane,
  type SidebarPane
} from '../../harness/pages'

const MODEL = 'e2e-model'
/** 一轮挂在 hold 里的上限：远长于用例要它挂着的时间，放行靠 `release(key)` */
const HOLD_MS = 30_000
/** 一条流程的用例上限（几轮调用方 + 目标 + 通知的合并窗口） */
const FLOW_TIMEOUT = 120_000

const A_TITLE = 'Caller A'
const A2_TITLE = 'Caller A2'
const B_TITLE = 'Target B'
/** A / A2 第一条消息里的标记：它们之后的每个请求里都有（历史），B 的请求里永远没有 */
/** 出厂 ask-on-session-access 的英文显示名（md 的 shuvix-displayName）—— 卡片左端的策略角标 */
const POLICY_DISPLAY_NAME = 'Ask Before Using Another Session'
const A_MARK = 'XSE-ALPHA-CALLER'
const A2_MARK = 'XSE-BRAVO-CALLER'

interface ListedMessage {
  id: string
  role: string
  content: string
  metadata?: { isSystemNotice?: boolean } | null
}

interface AclRow {
  kind: string
  target: string
  access: string
  source: string
  sourceKey: string
}

let app: E2EApp
let provider: FakeProvider
let probe: SyncProbe
let events: EventRecorder
let chat: ChatPane
let sidebar: SidebarPane
let popover: AtPopoverPane
let config: SessionConfigPane
let access: SessionAccessPane
let sessionAsk: SessionAskPane
let projectId = ''
let aSid = ''
let a2Sid = ''
let bSid = ''

// ─── 小助手 ──────────────────────────────────────

const notReviewer = (r: FakeRequest): boolean => !isReviewerRequest(r)
const isA = (r: FakeRequest): boolean => notReviewer(r) && r.raw.includes(A_MARK)
const isA2 = (r: FakeRequest): boolean => notReviewer(r) && r.raw.includes(A2_MARK)
/** A 的某一步：最后一条用户消息恰为这段（工具结果回来之后的那个请求同样认它） */
const stepA =
  (text: string) =>
  (r: FakeRequest): boolean =>
    isA(r) && r.lastUserText === text
const stepA2 =
  (text: string) =>
  (r: FakeRequest): boolean =>
    isA2(r) && r.lastUserText === text
/** B 的一轮：不是 A / A2，最后一条用户消息恰为发进去的那段话 */
const turnB =
  (text: string) =>
  (r: FakeRequest): boolean =>
    notReviewer(r) && !r.raw.includes(A_MARK) && !r.raw.includes(A2_MARK) && r.lastUserText === text
/** 被 B 的完成通知叫醒的那一轮（末条用户消息就是那条通知） */
const wokenBy =
  (caller: (r: FakeRequest) => boolean) =>
  (r: FakeRequest): boolean =>
    caller(r) &&
    r.lastUserText.includes(`<session id="${bSid}"`) &&
    r.lastUserText.includes('has finished')

const reviewerRequests = (): FakeRequest[] => provider.requests().filter(isReviewerRequest)

const sessionCall = (
  id: string,
  args: Record<string, unknown>
): { id: string; name: string; args: string } => ({
  id,
  name: 'session',
  args: JSON.stringify(args)
})

const listMessages = (sid: string): Promise<ListedMessage[]> =>
  app.main.eval<ListedMessage[]>(`window.api.message.list(${JSON.stringify(sid)})`)

const systemNotices = (msgs: ListedMessage[]): ListedMessage[] =>
  msgs.filter((m) => m.role === 'user' && m.metadata?.isSystemNotice === true)

/** 不是系统通知的用户消息正文 */
const userMessages = (msgs: ListedMessage[]): string[] =>
  msgs.filter((m) => m.role === 'user' && !m.metadata?.isSystemNotice).map((m) => m.content)

/** 发一条用户消息、不等它（这一轮要停在卡片上） */
const sendPrompt = (sid: string, text: string): Promise<unknown> =>
  app.main.eval(
    `(() => {
      window.api.agent
        .prompt({ sessionId: ${JSON.stringify(sid)}, text: ${JSON.stringify(text)} })
        .catch(() => undefined)
      return true
    })()`
  )

/** 发一条用户消息并等这一轮落定 */
const promptSession = (sid: string, text: string): Promise<unknown> =>
  app.main.eval(
    `window.api.agent.prompt({ sessionId: ${JSON.stringify(sid)}, text: ${JSON.stringify(text)} })`
  )

/** 等这条会话的转写里出现某段助手正文、且这一轮落定 */
const waitAssistant = (sid: string, text: string): Promise<unknown> =>
  probe.waitView(
    sid,
    (v) =>
      v.run.state !== 'busy' &&
      v.messages.some((m) => m.role === 'assistant' && m.content.includes(text)),
    60_000,
    `"${text}" in ${sid}`
  )

const resultOf = (sid: string, callId: string): Promise<ToolResult> =>
  probe.waitToolResult(sid, callId, 60_000)

/** 下一张询问卡（会话视图里的询问；会话询问恒是 ask） */
const nextAsk = async (sid: string): Promise<AskInputRequest> => {
  const req = await probe.nextAsk(sid)
  expect(req.kind).toBe('ask')
  return req as AskInputRequest
}

/** 卡片上屏（待处理面板里的会话块） */
const waitSessionCard = (): ReturnType<SessionAskPane['shot']> =>
  until(() => sessionAsk.shot(), 'session ask card on screen')

/** 等 B 的那一轮挂进 `target` 槽（它收到的用户消息恰为 text） */
const targetHeld = (text: string): Promise<unknown> =>
  until(
    () => provider.heldRequest('target')?.lastUserText === text || null,
    `target turn "${text}" held`
  )

/** 调用方权限表里会话种类的行（直接读库：「允许并记住」写下的就是这里） */
const sessionRows = (sid: string): AclRow[] =>
  sqliteJson<AclRow>(
    app.home,
    `SELECT kind, target, access, source, sourceKey FROM session_acl WHERE sessionId = ${sqlLit(sid)} AND kind = 'session'`
  )

const decisionsOf = (sid: string): SecurityDecisionEntry[] =>
  securityDecisions(app).filter((d) => d.sessionId === sid && d.objectKind === 'session')

const openInUi = async (title: string): Promise<void> => {
  await until(async () => (await sidebar.titles()).includes(title), `sidebar lists "${title}"`)
  await until(async () => (await sidebar.openSession(title)) || null, `"${title}" opened`)
  await chat.ready()
}

/**
 * 打开某条会话的设置弹窗（侧栏行菜单 → session-config）做一段事，**总是**关上 —— 断言失败时开着的弹窗会把后面的
 * 用例全带歪（行菜单点不到、读到的是旧弹窗里的表）
 */
const withConfig = async (title: string, body: () => Promise<void>): Promise<void> => {
  await sidebar.pickRowMenu(title, 'session-config')
  await config.waitOpen()
  try {
    await body()
  } finally {
    await config.close()
  }
}

const createSession = (title: string): Promise<string> =>
  app.main.eval<string>(
    `window.api.session.create(${JSON.stringify({ title, projectId })}).then((s) => s.id)`
  )

beforeAll(async () => {
  // 内置 auto-review 开着（产品缺省）：会话询问要证明它不出场
  app = await launchApp({ autoReview: true })
  provider = await startFakeProvider()
  await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  await waitRendererReady(app.main)
  await app.main.eval(`window.api.settings.set({ key: 'general.language', value: 'en' })`)

  const projDir = join(app.home, 'proj-session-access')
  mkdirSync(projDir, { recursive: true })
  // 有一个文件：裸 @ 才是「文件 + 会话」多源并出、带段头
  writeFileSync(join(projDir, 'README.md'), '# session access\n')
  projectId = (await createProject(app.main, { name: 'AccessProj', path: projDir })).id
  bSid = await createSession(B_TITLE)
  a2Sid = await createSession(A2_TITLE)
  aSid = await createSession(A_TITLE)

  chat = chatPane(app.main)
  sidebar = sidebarPane(app.main)
  popover = atPopoverPane(app.main)
  config = sessionConfigPane(app.main)
  access = sessionAccessPane(app.main)
  sessionAsk = sessionAskPane(app.main)
  events = eventRecorder(app.main)
  await events.install()
  probe = syncProbe(app.main)
  await probe.install()
}, 60_000)

afterAll(async () => {
  await provider?.close()
  await app?.stop()
})

describe('session access', () => {
  const M1 = 'XSE1-M1 summarise the release notes for me'
  const M2 = 'XSE1-M2 and now the changelog'
  const AGAIN = 'XSE1-AGAIN send it the changelog too'

  it(
    'XS-E1 @ a session → prompt-session asks "Talk to another session" (target + message, no reviewer) → Allow and remember writes one session row, shown in Session access as Talk; the message lands in B; the next prompt is not asked',
    async () => {
      provider.reset()
      await events.clear()
      const first = (r: FakeRequest): boolean => isA(r) && r.lastUserText.includes(A_MARK)
      provider.script(
        {
          toolCalls: [
            sessionCall('call_e1_prompt', {
              action: 'prompt-session',
              session_id: bSid,
              message: M1
            })
          ],
          when: first
        },
        { text: 'XSE1-B-REPLY-1', when: turnB(M1), holdMs: HOLD_MS, holdKey: 'target' },
        { text: 'XSE1-A-DISPATCHED', when: first },
        { text: 'XSE1-A-NOTED', when: wokenBy(isA) }
      )

      // 1. @ 弹层：裸 @ 时「Sessions」一段，行锚点 session:<B>
      await openInUi(A_TITLE)
      await chat.type('@')
      await until(
        async () => (await popover.rows()).some((r) => r.key === `session:${bSid}`) || null,
        'session row in the @ popover'
      )
      expect(await popover.sections()).toContain('session')
      expect(
        await app.main.eval<string>(
          `(document.querySelector('[data-at-section="session"]')?.textContent ?? '').trim()`
        )
      ).toBe(en.input.atSectionSessions)
      // 调用方自己不在候选里
      expect((await popover.rows()).some((r) => r.key === `session:${aSid}`)).toBe(false)
      const row = (await popover.rows()).find((r) => r.key === `session:${bSid}`)
      expect(row?.label).toBe(B_TITLE)
      expect(await popover.select(`session:${bSid}`)).toBe(true)
      expect(await chat.inputValue()).toBe(`@session:${B_TITLE} `)
      await chat.type(`@session:${B_TITLE} ${A_MARK} ask it to summarise the release notes`)
      await chat.pressEnter()

      // 2. 模型看到的是 id 与标题（@ 本身不是授权）
      const ask = await nextAsk(aSid)
      const sent = provider.requests().find(first)
      expect(sent?.lastUserText).toContain(`[session: id ${bSid} — "${B_TITLE}"]`)
      expect(sent?.lastUserText).not.toContain(`@session:${B_TITLE}`)

      // 3. 卡片：对话类，目标会话 + 要发进去的那段话
      expect(ask.command).toBe(`Session(write, ${bSid})`)
      expect(ask.session).toEqual({
        sessionId: bSid,
        title: B_TITLE,
        access: 'write',
        operation: 'prompt-session'
      })
      expect(ask.preview).toEqual({ kind: 'message', text: M1 })
      const card = await waitSessionCard()
      expect(card).toEqual({
        title: en.toolCall.sessionAskWrite,
        sessionId: bSid,
        targetTitle: B_TITLE,
        targetId: bSid,
        message: { label: en.toolCall.sessionAskMessage, text: M1 },
        // 预览下面的角标是命中的出厂策略（显示名取自它的 md）
        policy: POLICY_DISPLAY_NAME,
        buttons: [en.toolCall.askAllowOnce, en.toolCall.askRememberSession, en.toolCall.deny],
        rememberSession: true,
        pathRemember: false
      })
      // 审查员不出场：会话询问只有人答
      expect(reviewerRequests()).toEqual([])
      // 卡片还开着，B 一个字都没收到
      expect(userMessages(await listMessages(bSid))).toEqual([])

      // 4. 允许并记住 → 权限表恰一行
      await sessionAsk.rememberSession()
      await probe.waitAskGone(aSid, ask.id)
      expect(sessionRows(aSid)).toEqual([
        { kind: 'session', target: bSid, access: 'write', source: 'user', sourceKey: '' }
      ])

      // 5. 回执只说在跑；B 的那一轮挂着，A 先收尾
      await targetHeld(M1)
      await waitAssistant(aSid, 'XSE1-A-DISPATCHED')
      const receipt = await resultOf(aSid, 'call_e1_prompt')
      expect(receipt.isError).toBe(false)
      expect(receipt.result).toContain(`<session id="${bSid}" status="running"/>`)
      expect(receipt.result).toContain('Started in the background')

      // 决策日志：出厂会话策略的对话那一条问了，人答「允许并记住」，没有审查结论
      const decisions = await until(
        () => (decisionsOf(aSid).some((d) => d.userResponse) ? decisionsOf(aSid) : null),
        'session decision logged'
      )
      const asked = decisions.find((d) => d.effect === 'ask')
      expect(asked).toMatchObject({
        action: 'write',
        objectKind: 'session',
        objectSummary: `session ${bSid}`,
        winning: 'ask-on-session-access#1',
        userResponse: 'allowed_remember'
      })
      expect(asked?.review).toBeUndefined()

      // 6. 放 B 跑完：那段话在 B 里是一条用户消息，B 答了；A 被完成通知叫醒
      provider.release('target')
      await waitAssistant(aSid, 'XSE1-A-NOTED')
      const bMsgs = await listMessages(bSid)
      expect(userMessages(bMsgs)).toEqual([M1])
      expect(
        bMsgs.some((m) => m.role === 'assistant' && m.content.includes('XSE1-B-REPLY-1'))
      ).toBe(true)

      // 7. 设置弹窗：「Session access」卡里一行，Talk 选中
      await withConfig(A_TITLE, async () => {
        await until(() => access.present(aSid), 'Session access section')
        expect(await access.sectionTitle(aSid)).toBe(en.sessionAcl.sessionsTitle)
        expect(await access.rows(aSid)).toEqual([
          expect.objectContaining({
            target: bSid,
            title: B_TITLE,
            idText: bSid,
            access: 'write',
            selectedLabel: en.sessionAcl.sessionWrite
          })
        ])
      })

      // 8. 这一轮结束之后再派一次：不问，照样送达
      provider.script(
        {
          toolCalls: [
            sessionCall('call_e1_again', {
              action: 'prompt-session',
              session_id: bSid,
              message: M2
            })
          ],
          when: stepA(AGAIN)
        },
        { text: 'XSE1-B-REPLY-2', when: turnB(M2), holdMs: HOLD_MS, holdKey: 'target' },
        { text: 'XSE1-A-AGAIN-DONE', when: stepA(AGAIN) },
        { text: 'XSE1-A-NOTED-2', when: wokenBy(isA) }
      )
      const mark = await events.mark()
      const decided = decisionsOf(aSid).length
      await sendPrompt(aSid, AGAIN)
      await targetHeld(M2)
      await waitAssistant(aSid, 'XSE1-A-AGAIN-DONE')
      expect(await asksRaisedIn(events, aSid, mark)).toBe(0)
      expect((await probe.viewOf(aSid))?.asks ?? []).toEqual([])
      const again = await resultOf(aSid, 'call_e1_again')
      expect(again.isError).toBe(false)
      expect(again.result).toContain(`<session id="${bSid}" status="running"/>`)
      // 门照样过了一次（放行也记），按权限表放行、没有人的回答
      const allowed = await until(
        () => decisionsOf(aSid).slice(decided)[0] ?? null,
        'second session decision logged'
      )
      expect(allowed).toMatchObject({ action: 'write', objectKind: 'session', effect: 'allow' })
      expect(allowed.userResponse).toBeUndefined()

      provider.release('target')
      await waitAssistant(aSid, 'XSE1-A-NOTED-2')
      expect(userMessages(await listMessages(bSid))).toEqual([M1, M2])
      expect(reviewerRequests()).toEqual([])
      // 权限表没有多出一行
      expect(sessionRows(aSid)).toHaveLength(1)
    },
    FLOW_TIMEOUT
  )

  it(
    'XS-E2 read and talk are asked separately: inspect allowed once leaves no row; read denied → tool error; read remembered → read row, prompt still asks; switched to Talk → prompt not asked; row removed → read asks again',
    async () => {
      provider.reset()
      await events.clear()
      const S1 = `${A2_MARK} step 1: look inside Target B`
      const S2 = 'XSE2-S2 read its answer'
      const S3 = 'XSE2-S3 read its answer again'
      const S4 = 'XSE2-S4 ask it something'
      const S6 = 'XSE2-S6 ask it something now'
      const S9 = 'XSE2-S9 read it once more'
      const M3 = 'XSE2-M3 should never arrive'
      const M4 = 'XSE2-M4 please list the open issues'
      const HUMAN = 'XSE2-HUMAN-IN-B what is left to do?'
      provider.script(
        // S1：inspect → 「查看」卡，允许一次
        {
          toolCalls: [
            sessionCall('call_e2_inspect', { action: 'inspect-session', session_id: bSid })
          ],
          when: stepA2(S1)
        },
        { text: 'XSE2-S1-DONE', when: stepA2(S1) },
        // S2：read → 拒绝
        {
          toolCalls: [
            sessionCall('call_e2_read_denied', { action: 'read-session', session_id: bSid })
          ],
          when: stepA2(S2)
        },
        { text: 'XSE2-S2-DONE', when: stepA2(S2) },
        // S3：read → 允许并记住
        {
          toolCalls: [
            sessionCall('call_e2_read_kept', { action: 'read-session', session_id: bSid })
          ],
          when: stepA2(S3)
        },
        { text: 'XSE2-S3-DONE', when: stepA2(S3) },
        // S4：prompt → 仍然问「对话」，拒绝
        {
          toolCalls: [
            sessionCall('call_e2_prompt_denied', {
              action: 'prompt-session',
              session_id: bSid,
              message: M3
            })
          ],
          when: stepA2(S4)
        },
        { text: 'XSE2-S4-DONE', when: stepA2(S4) }
      )
      await openInUi(A2_TITLE)

      // S1 inspect：查看类的卡，没有消息块；允许一次 → 大纲交回，表里不留行
      await sendPrompt(a2Sid, S1)
      const inspectAsk = await nextAsk(a2Sid)
      expect(inspectAsk.command).toBe(`Session(read, ${bSid})`)
      expect(inspectAsk.session).toEqual({
        sessionId: bSid,
        title: B_TITLE,
        access: 'read',
        operation: 'inspect-session'
      })
      expect(inspectAsk.preview).toBeUndefined()
      const readCard = await waitSessionCard()
      expect(readCard).toMatchObject({
        title: en.toolCall.sessionAskRead,
        sessionId: bSid,
        targetTitle: B_TITLE,
        targetId: bSid,
        message: null,
        policy: POLICY_DISPLAY_NAME,
        buttons: [en.toolCall.askAllowOnce, en.toolCall.askRememberSession, en.toolCall.deny],
        rememberSession: true,
        pathRemember: false
      })
      await chat.answerPendingAsk('allow')
      await waitAssistant(a2Sid, 'XSE2-S1-DONE')
      const outline = await resultOf(a2Sid, 'call_e2_inspect')
      expect(outline.isError).toBe(false)
      // B 里的那两条消息是 A 发的：从 A2 看是「另一条会话」说的
      expect(outline.result).toContain('[other session]')
      expect(outline.result).toContain('XSE1-M2')
      expect(sessionRows(a2Sid)).toEqual([])

      // S2 read：又问（允许一次不记）→ 拒绝 → 工具结果是拒绝原文
      await sendPrompt(a2Sid, S2)
      const readAsk = await nextAsk(a2Sid)
      expect(readAsk.session).toMatchObject({ access: 'read', operation: 'read-session' })
      await waitSessionCard()
      await chat.answerPendingAsk('deny')
      await waitAssistant(a2Sid, 'XSE2-S2-DONE')
      const denied = await resultOf(a2Sid, 'call_e2_read_denied')
      expect(denied.isError).toBe(true)
      expect(denied.result).toContain(`User denied reading session "${B_TITLE}" (${bSid})`)
      expect(denied.result).not.toContain('XSE1-B-REPLY-2')
      expect(sessionRows(a2Sid)).toEqual([])

      // S3 read + 允许并记住 → 交回答复，表里一行 read
      await sendPrompt(a2Sid, S3)
      const keptAsk = await nextAsk(a2Sid)
      expect(keptAsk.session).toMatchObject({ access: 'read', operation: 'read-session' })
      await waitSessionCard()
      await sessionAsk.rememberSession()
      await waitAssistant(a2Sid, 'XSE2-S3-DONE')
      const kept = await resultOf(a2Sid, 'call_e2_read_kept')
      expect(kept.isError).toBe(false)
      expect(kept.result).toContain('<reply>\nXSE1-B-REPLY-2\n</reply>')
      expect(sessionRows(a2Sid)).toEqual([
        { kind: 'session', target: bSid, access: 'read', source: 'user', sourceKey: '' }
      ])

      // S4 prompt：查看不含对话 → 照旧问「对话」→ 拒绝，B 什么都没收到
      await sendPrompt(a2Sid, S4)
      const talkAsk = await nextAsk(a2Sid)
      expect(talkAsk.session).toMatchObject({ access: 'write', operation: 'prompt-session' })
      expect(talkAsk.preview).toEqual({ kind: 'message', text: M3 })
      const talkCard = await waitSessionCard()
      expect(talkCard?.title).toBe(en.toolCall.sessionAskWrite)
      await chat.answerPendingAsk('deny')
      await waitAssistant(a2Sid, 'XSE2-S4-DONE')
      const talkDenied = await resultOf(a2Sid, 'call_e2_prompt_denied')
      expect(talkDenied.isError).toBe(true)
      expect(talkDenied.result).toContain(`User denied talking to session "${B_TITLE}" (${bSid})`)
      expect(userMessages(await listMessages(bSid))).not.toContain(M3)

      // S5 设置：那一行是 Read；切到 Talk → 库里跟着变
      await withConfig(A2_TITLE, async () => {
        await until(() => access.present(a2Sid), 'Session access section')
        expect(await access.rows(a2Sid)).toEqual([
          expect.objectContaining({
            target: bSid,
            title: B_TITLE,
            idText: bSid,
            access: 'read',
            selectedLabel: en.sessionAcl.sessionRead
          })
        ])
        await access.setAccess(a2Sid, bSid, 'write')
        await until(
          () => sessionRows(a2Sid)[0]?.access === 'write' || null,
          'row switched to write'
        )
        await until(
          async () =>
            (await access.rows(a2Sid))[0]?.selectedLabel === en.sessionAcl.sessionWrite || null,
          'Talk selected'
        )
      })

      // S6 prompt：不问，送达
      provider.script(
        {
          toolCalls: [
            sessionCall('call_e2_prompt_free', {
              action: 'prompt-session',
              session_id: bSid,
              message: M4
            })
          ],
          when: stepA2(S6)
        },
        { text: 'XSE2-B-REPLY-4', when: turnB(M4), holdMs: HOLD_MS, holdKey: 'target' },
        { text: 'XSE2-S6-DONE', when: stepA2(S6) },
        { text: 'XSE2-S6-NOTED', when: wokenBy(isA2) }
      )
      const mark = await events.mark()
      await sendPrompt(a2Sid, S6)
      await targetHeld(M4)
      await waitAssistant(a2Sid, 'XSE2-S6-DONE')
      expect(await asksRaisedIn(events, a2Sid, mark)).toBe(0)
      expect((await resultOf(a2Sid, 'call_e2_prompt_free')).isError).toBe(false)
      provider.release('target')
      await waitAssistant(a2Sid, 'XSE2-S6-NOTED')
      expect(userMessages(await listMessages(bSid))).toContain(M4)

      // S7 设置：删掉那一行 → 库里没了，卡跟着消失
      await withConfig(A2_TITLE, async () => {
        await until(() => access.present(a2Sid), 'Session access section')
        await access.remove(a2Sid, bSid)
        await until(() => sessionRows(a2Sid).length === 0 || null, 'row removed')
        await until(async () => !(await access.present(a2Sid)) || null, 'section gone')
      })

      // S8 用户自己在 B 里说一句：B 最近的一轮不再是 A2 发起的（否则读自己那一轮的答复本来就不问）
      provider.script({ text: 'XSE2-B-HUMAN-REPLY', when: turnB(HUMAN) })
      await promptSession(bSid, HUMAN)
      await waitAssistant(bSid, 'XSE2-B-HUMAN-REPLY')

      // S9 read：又问了
      provider.script(
        {
          toolCalls: [
            sessionCall('call_e2_read_again', { action: 'read-session', session_id: bSid })
          ],
          when: stepA2(S9)
        },
        { text: 'XSE2-S9-DONE', when: stepA2(S9) }
      )
      await sendPrompt(a2Sid, S9)
      const againAsk = await nextAsk(a2Sid)
      expect(againAsk.command).toBe(`Session(read, ${bSid})`)
      expect(againAsk.session).toMatchObject({ access: 'read', operation: 'read-session' })
      expect((await waitSessionCard())?.title).toBe(en.toolCall.sessionAskRead)
      await chat.answerPendingAsk('deny')
      await waitAssistant(a2Sid, 'XSE2-S9-DONE')
      expect((await resultOf(a2Sid, 'call_e2_read_again')).isError).toBe(true)
      expect(sessionRows(a2Sid)).toEqual([])

      // 五张会话卡，一个审查员都没派出
      expect(reviewerRequests()).toEqual([])
      const asked = await until(() => {
        const rows = decisionsOf(a2Sid).filter((d) => d.effect === 'ask')
        return rows.length >= 5 ? rows : null
      }, 'five session asks logged')
      expect(asked.map((d) => d.winning)).toEqual([
        'ask-on-session-access#0',
        'ask-on-session-access#0',
        'ask-on-session-access#0',
        'ask-on-session-access#1',
        'ask-on-session-access#0'
      ])
      expect(asked.every((d) => d.review === undefined)).toBe(true)
    },
    FLOW_TIMEOUT
  )

  it(
    'XS-E3 a remembered Talk grant: the task row reads "Session · Running"; exactly one completion notice names wait-for-sessions with session_id; the wait hands back the reply; deleting B drops the row, the Session access section and its list entry',
    async () => {
      provider.reset()
      await events.clear()
      const GO = 'XSE3-GO one more pass please'
      const M5 = 'XSE3-M5 one more pass over the notes'
      const LIST_BEFORE = 'XSE3-LIST-BEFORE'
      const LIST_AFTER = 'XSE3-LIST-AFTER'
      provider.script(
        {
          toolCalls: [
            sessionCall('call_e3_prompt', {
              action: 'prompt-session',
              session_id: bSid,
              message: M5
            })
          ],
          when: stepA(GO)
        },
        { text: 'XSE3-B-REPLY-5', when: turnB(M5), holdMs: HOLD_MS, holdKey: 'target' },
        { text: 'XSE3-A-DISPATCHED', when: stepA(GO) },
        // 照通知说的收：点名 B
        {
          toolCalls: [
            sessionCall('call_e3_wait', { action: 'wait-for-sessions', session_id: bSid })
          ],
          when: wokenBy(isA)
        },
        { text: 'XSE3-A-COLLECTED', when: wokenBy(isA) }
      )
      await openInUi(A_TITLE)
      const noticesBefore = systemNotices(await listMessages(aSid)).length
      const mark = await events.mark()
      await sendPrompt(aSid, GO)
      await targetHeld(M5)
      await waitAssistant(aSid, 'XSE3-A-DISPATCHED')
      expect(await asksRaisedIn(events, aSid, mark)).toBe(0)

      // 任务页：驱动别的会话的那一轮写「Session」，不是「Sub-session」
      const tasks = tasksPanelPane(app.main)
      await tasks.open()
      const row = await until(
        async () =>
          (await tasks.rows()).find(
            (r) => r.kind === 'sub-session' && r.title === B_TITLE && r.status === 'running'
          ) ?? null,
        'running session task row'
      )
      expect(
        row.meta.startsWith(`${en.panel.tasksKindSession} · ${en.panel.tasksStatusRunning}`)
      ).toBe(true)
      expect(row.meta).not.toContain(en.panel.tasksKindSubSession)

      // 放行 → 恰一条完成通知，点名 B；照做的 wait 交回答复
      provider.release('target')
      await waitAssistant(aSid, 'XSE3-A-COLLECTED')
      const notices = systemNotices(await listMessages(aSid)).slice(noticesBefore)
      expect(notices).toHaveLength(1)
      expect(notices[0].content).toContain(`<session id="${bSid}"`)
      expect(notices[0].content).toContain('has finished')
      expect(notices[0].content).toContain(
        `Collect it with the session tool: action "wait-for-sessions" with session_id "${bSid}".`
      )
      expect(notices[0].content).not.toContain('XSE3-B-REPLY-5')
      const collected = await resultOf(aSid, 'call_e3_wait')
      expect(collected.isError).toBe(false)
      expect(collected.result).toContain('<sessions status="settled">')
      expect(collected.result).toContain(`<session id="${bSid}"`)
      expect(collected.result).toContain('<reply>\nXSE3-B-REPLY-5\n</reply>')
      await until(
        async () =>
          (await tasks.rows()).some(
            (r) => r.kind === 'sub-session' && r.title === B_TITLE && r.status === 'done'
          ) || null,
        'session task row done'
      )

      // 删 B 之前：list-sessions 带着权限表那一行列出它
      provider.script(
        {
          toolCalls: [sessionCall('call_e3_list_before', { action: 'list-sessions' })],
          when: stepA(LIST_BEFORE)
        },
        { text: 'XSE3-LISTED-BEFORE', when: stepA(LIST_BEFORE) }
      )
      await promptSession(aSid, LIST_BEFORE)
      const before = await resultOf(aSid, 'call_e3_list_before')
      expect(before.result).toContain(`<session id="${bSid}" title="${B_TITLE}"`)
      expect(before.result).toContain('relation="other" access="write"/>')

      // 删 B：所有表里指向它的行一并删掉
      await app.main.eval(`window.api.session.delete(${JSON.stringify(bSid)})`)
      await until(
        async () =>
          !(await app.main.eval<Array<{ id: string }>>(`window.api.session.list()`)).some(
            (s) => s.id === bSid
          ) || null,
        'B deleted'
      )
      expect(
        sqliteJson(
          app.home,
          `SELECT sessionId FROM session_acl WHERE kind = 'session' AND target = ${sqlLit(bSid)}`
        )
      ).toEqual([])
      expect(sessionRows(aSid)).toEqual([])

      // A 的设置弹窗：「Session access」卡不在了（重新打开时现取）
      await withConfig(A_TITLE, async () => {
        // 文件访问那张卡先上屏，再断「会话访问」不在
        await until(
          () =>
            app.main.eval<boolean>(
              `!![...document.querySelectorAll('.dialog-panel')].find((p) => p.querySelector('input'))?.querySelector(${JSON.stringify(`[data-session-acl="${aSid}"]`)})`
            ),
          'File access section'
        )
        await sleep(300)
        expect(await access.present(aSid)).toBe(false)
      })

      // list-sessions 不再列出它
      provider.script(
        {
          toolCalls: [sessionCall('call_e3_list_after', { action: 'list-sessions' })],
          when: stepA(LIST_AFTER)
        },
        { text: 'XSE3-LISTED-AFTER', when: stepA(LIST_AFTER) }
      )
      await promptSession(aSid, LIST_AFTER)
      const after = await resultOf(aSid, 'call_e3_list_after')
      expect(after.isError).toBe(false)
      expect(after.result).not.toContain(bSid)
      expect(reviewerRequests()).toEqual([])
    },
    FLOW_TIMEOUT
  )
})
