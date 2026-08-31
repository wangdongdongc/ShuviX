/**
 * 笔记归纳的端到端（M9′）—— **只放穿透进程边界的那几件事**。
 *
 * 门槛算术、材料组装、成功判定、脚本分支、策略判定表都是确定性纯逻辑，各自在单测里跑真
 * md、真投影，一轮几毫秒（`bot/__tests__/botNotesScheduler.test.ts`、
 * `services/__tests__/botServiceNotes.test.ts`、`workflow/__tests__/botChatTask.test.ts`、
 * `security/__tests__/builtinPolicies.test.ts`）。搬到这里只会让每条断言先付一次真实例
 * 加真 LLM 往返的代价，还换不来新信息。
 *
 * 留在这里的是**只有跨了进程才成立**的九件事：
 *   1. 一次归纳真的把这份 md 改了 —— 派发、工具解析、就地编辑、检查点落盘一条不缺；
 *   2. 写盘真的撞到那张询问卡，而且免询问开着也照撞（策略、PEP、bot 路径的合流）；
 *   3. 整个过程在会话里一个字都不冒出来；
 *   3b. **一次 edit 都没调仍然算跑成了** —— 「什么都不改是常态」在机制上的对位；
 *   3c. **分界线以上写得动** —— 「人设归用户」是提示词里的纪律，不是权限墙；
 *   4. 没跑成的那一轮不推进检查点（材料留给下一轮）；
 *   5. 状态文件不被注册表当成一份 bot；
 *   6. 改一次名，三处引用跟着走，而历史署名不跟着改；
 *   7. 删会话连它的检查点一起忘掉；
 *   8. 丢更新守卫在真 IPC 上成立。
 *
 * **关键便利**：全新 bot 的 `lastRunAt` 是 0，时间腿天然成立 —— 三条「值得记的事」就能
 * 触发一次真归纳，不必等半小时。每条用例各起一个新 bot 名，状态因此互不干扰。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchApp, type E2EApp } from '../../harness/launch'
import { startFakeProvider, type FakeProvider, type FakeRequest } from '../../harness/fakeProvider'
import { sleep, until } from '../../harness/cdp'
import {
  createBotSession,
  eventRecorder,
  seedFakeProvider,
  waitRendererReady,
  writeBotMd,
  type EventRecorder
} from '../../harness/seed'

let app: E2EApp
let events: EventRecorder
let provider: FakeProvider

const MODEL = 'e2e-model'

/** 笔记区的分界线（bot md 的正文一分为二：以上是人设，以下是笔记） */
const MARKER = '<!-- shuvix:bot-notes -->'
/** 分界线以下、等着被改的那一行 */
const NOTE_LINE = '- nothing recorded yet'
/** 分界线以上、属于用户的那一行 */
const PERSONA_LINE = 'You are a scout. Answer briefly.'

const botBody = (): string =>
  [PERSONA_LINE, '', MARKER, '', '## Preferences', '', NOTE_LINE].join('\n')

// ── 请求归属：提示词开头那句是最稳的判据 ──────────────────────────────

const isGate = (r: FakeRequest): boolean =>
  !r.isTitle && r.raw.includes('A message has just arrived in a chat session')
const isNotes = (r: FakeRequest): boolean =>
  !r.isTitle && r.raw.includes("You keep a ShuviX chat bot's own markdown file current")

const READ_CALL = 'call_notes_read'
const EDIT_CALL = 'call_notes_edit'

/** 门控段：一句话答完，并把这条标成「值得记」 */
const gateTurn = (): Parameters<FakeProvider['script']>[0] => ({
  toolCalls: [
    {
      id: 'call_next',
      name: 'next',
      args: JSON.stringify({
        decision: 'reply',
        relevance: 5,
        reason: 'small talk with a durable preference',
        reply: 'noted.',
        memorable: true
      })
    }
  ],
  usage: { prompt: 200, completion: 20 },
  when: isGate
})

/** 笔记段第一发：读那份 md */
const notesRead = (file: string): Parameters<FakeProvider['script']>[0] => ({
  toolCalls: [{ id: READ_CALL, name: 'read', args: JSON.stringify({ path: file }) }],
  usage: { prompt: 300, completion: 10 },
  when: (r) => isNotes(r) && !r.raw.includes(READ_CALL)
})

/** 笔记段第二发：就地改一行 */
const notesEdit = (
  file: string,
  oldText: string,
  newText: string
): Parameters<FakeProvider['script']>[0] => ({
  toolCalls: [
    { id: EDIT_CALL, name: 'edit', args: JSON.stringify({ path: file, oldText, newText }) }
  ],
  usage: { prompt: 320, completion: 12 },
  when: (r) => isNotes(r) && r.raw.includes(READ_CALL) && !r.raw.includes(EDIT_CALL)
})

/** 笔记段收尾：一句散文（笔记场合没有结果契约，散文就是它的结束方式） */
const notesDone = (after: string): Parameters<FakeProvider['script']>[0] => ({
  text: 'notes updated.',
  usage: { prompt: 340, completion: 6 },
  when: (r) => isNotes(r) && r.raw.includes(after)
})

// ── 观测面 ────────────────────────────────────────────────────────────

const botFile = (name: string): string => join(app.botsDir, `${name}.md`)
const readBot = (name: string): string => readFileSync(botFile(name), 'utf-8')

const stateFile = (): string => join(app.botsDir, '.notes-state.json')
function checkpoints(botName: string): Record<string, string> | undefined {
  if (!existsSync(stateFile())) return undefined
  const raw = JSON.parse(readFileSync(stateFile(), 'utf-8')) as Record<
    string,
    { sessions?: Record<string, string> }
  >
  return raw[botName]?.sessions
}

const runsDir = (botName: string): string => join(app.home, '.shuvix', 'bots', '.runs', botName)

/**
 * 管线 run journal 里的全部 log 行。
 *
 * 笔记场合的 run **不落到 bot 自己那个目录**：journal 的重定向按 ticket 认领，而 ticket
 * 只有消息场合才有（`notes:<bot>` 这个 label 不在其中）。所以它躺在 workflow 的默认落点
 */
function workflowLogs(): string[] {
  const dir = join(app.home, '.shuvix', 'workflows', '.runs', 'bot-chat')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .flatMap((f) => readFileSync(join(dir, f), 'utf-8').split('\n'))
    .filter(Boolean)
}

interface Msg {
  id: string
  role?: string
  content?: unknown
  metadata?: { sender?: { kind: string; name: string; displayName: string } } | null
}

const listMessages = (sid: string): Promise<Msg[]> =>
  app.main.eval(`window.api.message.list(${JSON.stringify(sid)})`)

const prompt = (sid: string, text: string): Promise<void> =>
  app.main.eval(
    `window.api.agent.prompt({ sessionId: ${JSON.stringify(sid)}, text: ${JSON.stringify(text)} }).catch(() => undefined)`
  )

const settingsOf = (sid: string): Promise<{ bots?: string[] } | null> =>
  app.main.eval(`window.api.session.getById(${JSON.stringify(sid)}).then((s) => s && s.settings)`)

/**
 * 在渲染进程里装一个**自动放行**的询问应答器。
 *
 * 笔记归纳一定会撞询问卡（读在工作区之外、写落在 bots 目录里），而这条链路上没有人在
 * 等着点「允许」—— 测试自己就是那个人。装在渲染侧而不是轮询，是因为一次归纳里两张卡
 * 之间只隔一个工具回合，往返轮询很容易慢到让笔记段先超时。
 *
 * 顺带把每张卡的归因（`policyPrompt.policies`）记下来，E-2 据此断言到底是哪一道门。
 */
async function installAutoAsk(): Promise<void> {
  await app.main.eval(
    `(() => {
      if (window.__autoAsk) return true
      window.__autoAsk = { on: false, cards: [] }
      window.api.agent.onEvent((e) => {
        if (e.type !== 'input_request' || !window.__autoAsk.on) return
        window.__autoAsk.cards.push({
          sessionId: e.sessionId,
          policies: (e.request.policyPrompt && e.request.policyPrompt.policies) || [],
          command: (e.request.ask && e.request.ask.command) || ''
        })
        window.api.agent.respondToInput({
          sessionId: e.sessionId,
          requestId: e.request.id,
          response: { kind: 'ask', allowed: true }
        })
      })
      return true
    })()`
  )
}

const autoAsk = {
  reset: (): Promise<unknown> =>
    app.main.eval(`(window.__autoAsk.on = true, window.__autoAsk.cards.length = 0, true)`),
  off: (): Promise<unknown> => app.main.eval(`(window.__autoAsk.on = false, true)`),
  cards: (sid?: string): Promise<Array<{ sessionId: string; policies: string[] }>> =>
    app.main.eval(
      sid
        ? `window.__autoAsk.cards.filter((c) => c.sessionId === ${JSON.stringify(sid)})`
        : `window.__autoAsk.cards`
    )
}

/** 某份内置策略的显示名（询问卡的署名用它，不硬编码文案） */
const policyDisplayName = (name: string): Promise<string> =>
  app.main.eval(
    `window.api.policy.list().then((ps) => (ps.find((p) => p.name === ${JSON.stringify(name)}) || {}).displayName)`
  )

/** 攒够门槛：三条「值得记的事」 */
async function accumulate(sid: string): Promise<void> {
  for (let i = 0; i < 3; i++) await prompt(sid, `message ${i}`)
}

/** 等到这个 bot 的笔记段真的被派发出去（提示词认得出来） */
const untilNotesDispatched = (n = 1): Promise<FakeRequest[]> =>
  until(async () => {
    const hits = provider.requests().filter(isNotes)
    return hits.length >= n ? hits : undefined
  }, `notes stage dispatched (${n})`)

beforeAll(async () => {
  app = await launchApp()
  provider = await startFakeProvider()
  await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  await waitRendererReady(app.main)
  events = eventRecorder(app.main)
  await events.install()
  await installAutoAsk()
}, 120_000)

afterAll(async () => {
  await app?.stop()
  await provider?.close()
})

describe('bot 笔记归纳', () => {
  it('E-1 三条值得记的事之后跑一次真归纳：md 被就地改写，检查点落盘', async () => {
    const BOT = 'n-basic'
    writeBotMd(app, BOT, { displayName: 'Scout', body: botBody() })
    provider.reset()
    await autoAsk.reset()
    provider.script(
      gateTurn(),
      gateTurn(),
      gateTurn(),
      notesRead(botFile(BOT)),
      notesEdit(botFile(BOT), NOTE_LINE, '- prefers pnpm in this repo'),
      notesDone(EDIT_CALL)
    )

    const sid = await createBotSession(app.main, { bots: [BOT], title: 'E-1' })
    await accumulate(sid)

    // 归纳是离线的：`maybeRun` 脱手跑，所以这里等的是**结果**而不是某个返回值
    await until(
      async () => (readBot(BOT).includes('prefers pnpm') ? true : undefined),
      'notes written into the bot md'
    )
    // 分界线与人设一个字没动 —— 改的只是那一行
    const after = readBot(BOT)
    expect(after).toContain(MARKER)
    expect(after).toContain(PERSONA_LINE)
    expect(after).not.toContain(NOTE_LINE)

    // 材料确实进了提示词，文件路径也点名了
    const [notesReq] = await untilNotesDispatched()
    expect(notesReq.raw).toContain(botFile(BOT))
    expect(notesReq.raw).toContain('The conversations')

    // 检查点前进到这条会话投影的最后一条 entry
    await until(async () => (checkpoints(BOT)?.[sid] ? true : undefined), 'checkpoint persisted')
    const msgs = await listMessages(sid)
    expect(checkpoints(BOT)?.[sid]).toBe(msgs[msgs.length - 1].id)
  }, 120_000)

  it('E-2 写盘撞的是 protect-bot-notes，而且免询问开着也照撞', async () => {
    // 设计 §8.2 明确接受这个代价。它同时是这份内置策略唯一一条**跨进程**才成立的断言：
    // 策略判定表在单测里已经摆开（BP-B*），但「bot 的笔记段真的走到了那个 PEP」
    // 只有把整条链路跑起来才看得见
    const BOT = 'n-ask'
    writeBotMd(app, BOT, { displayName: 'Asker', body: botBody() })
    provider.reset()
    await autoAsk.reset()
    provider.script(
      gateTurn(),
      gateTurn(),
      gateTurn(),
      notesRead(botFile(BOT)),
      notesEdit(botFile(BOT), NOTE_LINE, '- asked first'),
      notesDone(EDIT_CALL)
    )

    const sid = await createBotSession(app.main, { bots: [BOT], title: 'E-2' })
    // **免询问打开**：普通的区外读会被它免掉，而写 bots 目录那一道是 force-ask，免不掉
    await app.main.eval(
      `window.api.session.updateAutoAllow(${JSON.stringify({ id: sid, autoAllow: true })})`
    )
    await accumulate(sid)
    await until(
      async () => (readBot(BOT).includes('asked first') ? true : undefined),
      'notes written'
    )

    const cards = await autoAsk.cards(sid)
    expect(cards.length).toBeGreaterThan(0)
    const guard = await policyDisplayName('protect-bot-notes')
    expect(cards.some((c) => c.policies.includes(guard))).toBe(true)
    // 读那一张被免询问免掉了：剩下的每一张都是这道门开的
    expect(cards.every((c) => c.policies.includes(guard))).toBe(true)
  }, 120_000)

  it('E-3 整轮归纳在会话里一个字都不冒出来', async () => {
    // 笔记跑在关键路径之外，没人在等；它若往会话里说话，用户看到的是一条无缘无故的消息。
    // 观测面取「这条会话上的 assistant 消息数在归纳前后不变」—— 门控段答的那三句除外
    const BOT = 'n-silent'
    writeBotMd(app, BOT, { displayName: 'Silent', body: botBody() })
    provider.reset()
    await autoAsk.reset()
    provider.script(
      gateTurn(),
      gateTurn(),
      gateTurn(),
      notesRead(botFile(BOT)),
      notesEdit(botFile(BOT), NOTE_LINE, '- quiet update'),
      notesDone(EDIT_CALL)
    )

    const sid = await createBotSession(app.main, { bots: [BOT], title: 'E-3' })
    await accumulate(sid)
    const before = (await listMessages(sid)).filter((m) => m.role === 'assistant').length

    await until(
      async () => (readBot(BOT).includes('quiet update') ? true : undefined),
      'notes written'
    )
    await sleep(300) // 让归纳彻底收尾（它若要说话，此刻已经说了）

    const after = (await listMessages(sid)).filter((m) => m.role === 'assistant')
    expect(after).toHaveLength(before)
    expect(after.map((m) => String(m.content ?? '')).join('\n')).not.toContain('notes updated')
  }, 120_000)

  it('E-3b 一次 edit 都没调仍然算跑成了 —— 检查点照常前进', async () => {
    // 「什么都不改是常态」写在笔记段的提示词与 agent md 里（OC-1g / BA-10）。那是对模型说
    // 的话，测不了它是否真的克制；**能测的是宿主对这种结局的反应** —— 一次只读不改的归纳
    // 必须算成功。若把它算成失败，同一批材料会被下一轮、下下轮反复重读，
    // 而每一轮都要再付一张询问卡
    const BOT = 'n-noop'
    writeBotMd(app, BOT, { displayName: 'NoOp', body: botBody() })
    provider.reset()
    await autoAsk.reset()
    provider.script(
      gateTurn(),
      gateTurn(),
      gateTurn(),
      notesRead(botFile(BOT)),
      // 读完直接收工，一次 edit 都不调
      notesDone(READ_CALL)
    )

    const sid = await createBotSession(app.main, { bots: [BOT], title: 'E-3b' })
    await accumulate(sid)
    await untilNotesDispatched()

    await until(async () => (checkpoints(BOT)?.[sid] ? true : undefined), 'checkpoint advanced')
    // 文件一个字节都没变
    expect(readBot(BOT)).toContain(NOTE_LINE)
  }, 120_000)

  it('E-3c 分界线以上写得动 —— 「人设归用户」是纪律，不是权限墙', async () => {
    // botNotes 裁决 ③：分界线是**组织性**的。机制上笔记段拿的就是普通 `edit`，改得动
    // 这份 md 的每一行 —— 所以「别顺手动人设」只能是提示词里的一句话（BA-10 钉的就是
    // 那句话在不在）。这条用例钉的是另一半：机制这边确实没有墙。
    //
    // 两半必须一起在场。只钉提示词，会让人误以为有墙；只钉机制，那句纪律哪天被删掉也没人知道
    const BOT = 'n-persona'
    writeBotMd(app, BOT, { displayName: 'Persona', body: botBody() })
    provider.reset()
    await autoAsk.reset()
    provider.script(
      gateTurn(),
      gateTurn(),
      gateTurn(),
      notesRead(botFile(BOT)),
      notesEdit(botFile(BOT), PERSONA_LINE, 'You are a scout. Answer in Japanese.'),
      notesDone(EDIT_CALL)
    )

    const sid = await createBotSession(app.main, { bots: [BOT], title: 'E-3c' })
    await accumulate(sid)
    await until(
      async () => (readBot(BOT).includes('Answer in Japanese') ? true : undefined),
      'persona line rewritten'
    )
    expect(readBot(BOT)).not.toContain(PERSONA_LINE)
    // 分界线以下没被牵连
    expect(readBot(BOT)).toContain(NOTE_LINE)
  }, 120_000)

  it('E-4 没跑成的那一轮不推进检查点（材料留给下一轮）', async () => {
    // 用「笔记段的 agent 解析不出来」制造失败：它是唯一一种不依赖计时器的确定性 run 失败。
    // 检查点若在这时前进，这批 entry 就永远不会被任何一轮看见了 —— 而失败连一句话都不会说
    const BOT = 'n-fail'
    writeBotMd(app, BOT, {
      displayName: 'Failing',
      body: botBody(),
      agents: { notes: 'no-such-stage-agent' }
    })
    provider.reset()
    await autoAsk.reset()
    provider.script(gateTurn(), gateTurn(), gateTurn())

    const sid = await createBotSession(app.main, { bots: [BOT], title: 'E-4' })
    await accumulate(sid)

    // **先确认它真的跑过一轮并失败了** —— 否则「没有检查点」这条断言会因为「压根没触发」
    // 而恒真。判据取脚本自己写进 run journal 的那行 log
    await until(
      async () => (workflowLogs().some((l) => l.includes('notes failed')) ? true : undefined),
      'notes pass ran and logged its failure'
    )
    // 状态文件是存在的（别的用例写过），所以这条断言说的是「这个 bot 没前进」。
    // 空串而不是缺键：会话在第一次记账时就被登记进来了（值 `''` = 「见过，但一条都还没
    // 归纳」）—— 没前进的形态正是它保持空串，而不是这个键不存在
    expect(existsSync(stateFile())).toBe(true)
    expect(checkpoints(BOT)?.[sid] ?? '').toBe('')
    // 失败连一句话都不会说：会话里没有多出三条门控回复之外的任何东西
    const assistants = (await listMessages(sid)).filter((m) => m.role === 'assistant')
    expect(assistants).toHaveLength(3)
  }, 120_000)

  it('E-5 状态文件不进注册表 —— 点号开头的它不是一份 bot', async () => {
    const BOT = 'n-registry'
    writeBotMd(app, BOT, { displayName: 'Reg', body: botBody() })
    provider.reset()
    await autoAsk.reset()
    provider.script(
      gateTurn(),
      gateTurn(),
      gateTurn(),
      notesRead(botFile(BOT)),
      notesEdit(botFile(BOT), NOTE_LINE, '- registry stays clean'),
      notesDone(EDIT_CALL)
    )

    const sid = await createBotSession(app.main, { bots: [BOT], title: 'E-5' })
    await accumulate(sid)
    await until(async () => (checkpoints(BOT)?.[sid] ? true : undefined), 'state file written')

    const names = await app.main.eval<string[]>(
      `window.api.bot.list().then((bs) => bs.map((b) => b.name))`
    )
    expect(names).toContain(BOT)
    expect(names.some((n) => n.startsWith('.'))).toBe(false)
    const invalid = await app.main.eval<Array<{ fileName: string }>>(`window.api.bot.listInvalid()`)
    expect(invalid.map((f) => f.fileName)).not.toContain('.notes-state.json')
  }, 120_000)

  it('E-6 改一次名，三处引用跟着走；历史署名不跟着改', async () => {
    // 不迁的话，改一次名等于把这个 bot 从所有会话里删掉（L0 门会把它当成「成员 md 不存在」），
    // 而用户看到的是「我只是改了个名字」。反过来，署名**刻意不迁**：历史不该因为今天的
    // 一次改名而被改写
    const BOT = 'n-rename'
    const RENAMED = 'n-renamed'
    writeBotMd(app, BOT, { displayName: 'Before', body: botBody() })
    provider.reset()
    await autoAsk.reset()
    provider.script(
      gateTurn(),
      gateTurn(),
      gateTurn(),
      notesRead(botFile(BOT)),
      notesEdit(botFile(BOT), NOTE_LINE, '- about to be renamed'),
      notesDone(EDIT_CALL)
    )

    const sid = await createBotSession(app.main, { bots: [BOT], title: 'E-6' })
    await accumulate(sid)
    await until(
      async () => (checkpoints(BOT)?.[sid] ? true : undefined),
      'checkpoint before rename'
    )
    expect(existsSync(runsDir(BOT))).toBe(true)

    const source = await app.main.eval<{ text: string }>(
      `window.api.bot.getSource(${JSON.stringify({ name: BOT })})`
    )
    const renamedText = source.text.replace(`name: ${BOT}`, `name: ${RENAMED}`)
    const saved = await app.main.eval<{ success: boolean; error?: string }>(
      `window.api.bot.save(${JSON.stringify({ originalName: BOT, text: renamedText })})`
    )
    expect(saved.success, saved.error).toBe(true)

    // ① 会话成员名单
    expect((await settingsOf(sid))?.bots).toEqual([RENAMED])
    // ② 决策记录与 run journal 的目录
    expect(existsSync(runsDir(RENAMED))).toBe(true)
    expect(existsSync(runsDir(BOT))).toBe(false)
    // ③ 笔记检查点
    expect(checkpoints(RENAMED)?.[sid]).toBeTruthy()
    expect(checkpoints(BOT)).toBeUndefined()

    // 历史署名留在原地：侧车带的是落树当时的身份
    const assistants = (await listMessages(sid)).filter((m) => m.role === 'assistant')
    expect(assistants.length).toBeGreaterThan(0)
    expect(assistants.every((m) => m.metadata?.sender?.name === BOT)).toBe(true)
    expect(assistants.every((m) => m.metadata?.sender?.displayName === 'Before')).toBe(true)
  }, 120_000)

  it('E-7 删掉会话，它的检查点跟着没', async () => {
    // 留着只会让状态文件无限长，而那条 sessionId 已经指不到任何东西了
    const BOT = 'n-forget'
    writeBotMd(app, BOT, { displayName: 'Forget', body: botBody() })
    provider.reset()
    await autoAsk.reset()
    provider.script(
      gateTurn(),
      gateTurn(),
      gateTurn(),
      notesRead(botFile(BOT)),
      notesEdit(botFile(BOT), NOTE_LINE, '- will be forgotten'),
      notesDone(EDIT_CALL)
    )

    const sid = await createBotSession(app.main, { bots: [BOT], title: 'E-7' })
    await accumulate(sid)
    await until(async () => (checkpoints(BOT)?.[sid] ? true : undefined), 'checkpoint persisted')

    await app.main.eval(`window.api.session.delete(${JSON.stringify(sid)})`)
    expect(checkpoints(BOT)?.[sid]).toBeUndefined()
  }, 120_000)

  it('E-8 丢更新守卫：编辑器打开之后被笔记段改过，保存被拦并交回盘上的那一份', async () => {
    // 这是 bot md 独有的问题 —— 它是唯一一份**会被两个人改**的契约文件。守卫在单测里
    // 摆过表（SG-A*），这里要的是它在真 IPC 上成立：`bot.getSource` 给的指纹，
    // 真被一次真归纳作废掉
    const BOT = 'n-guard'
    writeBotMd(app, BOT, { displayName: 'Guard', body: botBody() })
    provider.reset()
    await autoAsk.reset()
    provider.script(
      gateTurn(),
      gateTurn(),
      gateTurn(),
      notesRead(botFile(BOT)),
      notesEdit(botFile(BOT), NOTE_LINE, '- written by the notes pass'),
      notesDone(EDIT_CALL)
    )

    // T0：用户打开编辑器
    const opened = await app.main.eval<{ text: string; revision: string }>(
      `window.api.bot.getSource(${JSON.stringify({ name: BOT })})`
    )
    expect(opened.revision).toMatch(/^[0-9a-f]{16}$/)

    // T1：笔记段在后台把这份文件改了
    const sid = await createBotSession(app.main, { bots: [BOT], title: 'E-8' })
    await accumulate(sid)
    await until(
      async () => (readBot(BOT).includes('written by the notes pass') ? true : undefined),
      'notes pass wrote the file'
    )

    // T2：用户按保存 —— 拿的是 T0 那枚指纹
    const conflicted = await app.main.eval<{
      success: boolean
      conflict?: { current: string }
    }>(
      `window.api.bot.save(${JSON.stringify({
        originalName: BOT,
        text: `${opened.text}\n- typed by the user`,
        revision: opened.revision
      })})`
    )
    expect(conflicted.success).toBe(false)
    // 交回的是盘上此刻的原始字节，UI 拿它做三方合并
    expect(conflicted.conflict?.current).toBe(readBot(BOT))
    expect(conflicted.conflict?.current).toContain('written by the notes pass')

    // 重新取一次指纹就能存进去 —— 守卫拦的是「不知情的覆盖」，不是保存本身
    const fresh = await app.main.eval<{ text: string; revision: string }>(
      `window.api.bot.getSource(${JSON.stringify({ name: BOT })})`
    )
    const ok = await app.main.eval<{ success: boolean; revision?: string }>(
      `window.api.bot.save(${JSON.stringify({
        originalName: BOT,
        text: `${fresh.text}\n- typed by the user`,
        revision: fresh.revision
      })})`
    )
    expect(ok.success).toBe(true)
    expect(ok.revision).toBeTruthy()
    expect(readBot(BOT)).toContain('- typed by the user')
  }, 120_000)
})
